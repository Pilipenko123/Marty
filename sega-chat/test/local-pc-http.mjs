// Реальный HTTP только на 127.0.0.1 и изолированная база. Обычный сервер этот
// лабораторный API не включает. Здесь НЕТ Windows, установщика или UI.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {createFileStore} = require('../lib/store-file.js');
const {createApi} = require('../lib/api.js');
const {createFolder} = require('../local-pc/folder.js');
const {createReadService} = require('../local-pc/read-service.js');
const {createOwnerReadClient} = require('../local-pc/owner-read-client.js');
const {createOwnerReadTransport} = require('../local-pc/owner-read-transport.js');
const {createSnapshotSession} = require('../local-pc/snapshot-session.js');
const {createAgentClient} = require('../local-pc/agent-client.js');
const {createCoordinator,anchorFolder} = require('../local-pc/agent-coordinator.js');
const {digest} = require('../local-pc/relay.js');
const secure = require('../local-pc/secure-channel.js');
const pairing = require('../local-pc/pairing.js');
// Эксперимент не допускает фоновую запись: её отставание может ложным образом
// подтвердить привязку или отзыв. Обычный режим сюда не меняется.
const previousBackground=process.env.FILE_FLUSH_BG;
try {
  process.env.FILE_FLUSH_BG='1';
  assert.throws(()=>createApi({name:'file'},{localPcExperimental:true}),/фоновым сохранением/);
} finally {
  if(previousBackground===undefined)delete process.env.FILE_FLUSH_BG;else process.env.FILE_FLUSH_BG=previousBackground;
}
const tmp = await fs.mkdtemp(path.join(os.tmpdir(),'sega-local-http-'));
const hex = (n=16) => crypto.randomBytes(n).toString('hex');
let server, tlsServer, store;
try {
  const folderPath=path.join(tmp,'selected'); await fs.mkdir(folderPath);
  await fs.writeFile(path.join(folderPath,'своё.txt'),'Личные данные');
  store=createFileStore({dataDir:path.join(tmp,'data')}); await store.open();
  let app=createApi(store); // по умолчанию лабораторные маршруты выключены
  const handler=async (req,res)=>{
    const chunks=[]; for await (const c of req) chunks.push(c);
    let body={}; try { if(chunks.length) body=JSON.parse(Buffer.concat(chunks).toString()); } catch (_) {}
    const u=new URL(req.url,'http://test');
    try {
      const out=await app.handle({method:req.method,path:u.pathname,query:u.searchParams,body,headers:req.headers,ip:'127.0.0.1'});
      res.writeHead(out.status||200,{'Content-Type':'application/json'}); res.end(JSON.stringify(out.json||{}));
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({error:e.message})); }
  };
  server=http.createServer(handler);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  // Фиктивный общедоступный сертификат используется только этим тестом.
  const cert=await fs.readFile(new URL('./fixtures/local-test-only-cert.pem',import.meta.url));
  const tlsKey=await fs.readFile(new URL('./fixtures/local-test-only-key.pem',import.meta.url));
  tlsServer=https.createServer({key:tlsKey,cert},handler);
  await new Promise(resolve=>tlsServer.listen(0,'127.0.0.1',resolve));
  const tlsBase=`https://127.0.0.1:${tlsServer.address().port}`;

  async function call(p, {method='GET',body,auth}={}) {
    const headers={'Content-Type':'application/json'}; if (auth) headers.Authorization=auth;
    const res=await fetch(base+p,{method,headers,body:body ? JSON.stringify(body) : undefined});
    return {status:res.status,data:await res.json()};
  }
  const creds=name=>({name,saltAuth:hex(),authKey:hex(32),saltWrap:hex(),wrappedKeyByPass:'w:'+hex(),pub:'pub:'+hex(),wrappedPriv:'priv:'+hex()});
  let a=await call('/api/setup',{method:'POST',body:{...creds('Основатель'),codeProofSalt:hex(),codeProof:hex(32),codeSalt:hex(),wrappedKeyByCode:'k:'+hex()}});
  assert.equal(a.status,200); const owner='Bearer '+a.data.token, userId=a.data.user.id;
  assert.equal((await call('/api/pc-lab/devices',{auth:owner})).status,404);
  app=createApi(store,{localPcExperimental:true});
  const secretInvite=hex(24), secretHash=crypto.createHash('sha256').update(secretInvite).digest('hex');
  a=await call('/api/invites',{auth:owner,method:'POST',body:{invSalt:hex(),wrappedRoomKey:'k:'+hex(),secretHash}});
  assert.equal(a.status,200);
  const invited=await call('/api/register',{method:'POST',body:{...creds('Другой'),inviteToken:a.data.invite.id+'.'+secretInvite}});
  assert.equal(invited.status,200); const other='Bearer '+invited.data.token;
  const keys=await crypto.webcrypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
  const prepared=await pairing.create({url:tlsBase,userId,privateKey:keys.privateKey,publicKey:keys.publicKey});
  const setup=pairing.parse(prepared.code,tlsBase), id=setup.deviceId, setupToken=setup.token, key=setup.secret, token=hex(32);
  const register={...prepared.registration,title:'Мой ПК'};
  const recovered=await pairing.recover({userId,deviceId:id,wrappedKey:register.wrappedKey,privateKey:keys.privateKey,publicKey:keys.publicKey});
  assert(Buffer.from(recovered).equals(Buffer.from(key)));
  assert.equal((await call('/api/pc-lab/devices',{method:'POST',body:register})).status,401);
  assert.equal((await call('/api/pc-lab/devices',{auth:owner,method:'POST',body:register})).status,200);
  assert.equal((await call('/api/pc-lab/devices',{auth:other,method:'POST',body:register})).status,409);
  assert.equal((await call('/api/pc-lab/devices',{auth:other})).data.devices.length,0);
  let list=await call('/api/pc-lab/devices',{auth:owner}); assert.equal(list.data.devices[0].online,false);
  assert.equal(list.data.devices[0].wrappedKey,register.wrappedKey); assert.equal(list.data.devices[0].tokenHash,undefined);
  const agentAuth=`Local ${id}:${token}`, setupAuth=`Local ${id}:${setupToken}`, pathAgent='/api/pc-lab/agent/poll';
  assert.equal(list.data.devices[0].state,'pending');
  assert.equal((await call(pathAgent,{method:'POST',auth:`Local ${id}:${hex(32)}`})).status,401);
  assert.equal((await call(pathAgent,{method:'POST',auth:setupAuth})).status,401);
  const claimPath='/api/pc-lab/agent/claim';
  assert.equal((await call(claimPath,{method:'POST',auth:setupAuth,body:{tokenHash:digest(token)}})).status,200);
  assert.equal((await call(claimPath,{method:'POST',auth:setupAuth,body:{tokenHash:digest(token)}})).status,200); // повтор после сбоя
  assert.equal((await call(claimPath,{method:'POST',auth:setupAuth,body:{tokenHash:digest(hex(32))}})).status,401);
  assert.equal((await call(pathAgent,{method:'POST',auth:setupAuth})).status,401);
  assert.equal((await call(pathAgent,{method:'POST',auth:agentAuth})).data.job,null);
  list=await call('/api/pc-lab/devices',{auth:owner}); assert.equal(list.data.devices[0].online,true);
  const requestId=hex(), exp=Date.now()+30000;
  const packet=await secure.seal(key,id,'request',requestId,exp,new TextEncoder().encode(JSON.stringify({op:'list',path:''})));
  const requestUrl=`/api/pc-lab/devices/${id}/request`, resultUrl=`/api/pc-lab/devices/${id}/result?requestId=${requestId}`;
  assert.equal((await call(requestUrl,{auth:other,method:'POST',body:{requestId,packet}})).status,404);
  assert.equal((await call(requestUrl,{auth:owner,method:'POST',body:{requestId,packet:'plain'}})).status,400);
  assert.equal((await call(requestUrl,{auth:owner,method:'POST',body:{requestId,packet}})).status,200);
  const ackUrl=`/api/pc-lab/devices/${id}/ack`;
  assert.equal((await call(ackUrl,{auth:owner,method:'POST',body:{requestId}})).status,409);
  assert.equal((await call(ackUrl,{auth:other,method:'POST',body:{requestId}})).status,404);
  assert.equal((await call(ackUrl,{auth:owner,method:'POST',body:{requestId:'bad'}})).status,400);
  assert.equal((await call(resultUrl,{auth:other})).status,404);
  const task=(await call(pathAgent,{method:'POST',auth:agentAuth})).data.job;
  assert.equal(task.packet,packet);
  const service=createReadService({folder:await createFolder(folderPath),secret:key,deviceId:id});
  const response=await service.handle(task.requestId,task.packet);
  const reply={requestId,claim:task.claim,packet:response};
  assert.equal((await call('/api/pc-lab/agent/reply',{method:'POST',auth:`Local ${id}:${hex(32)}`,body:reply})).status,401);
  assert.equal((await call('/api/pc-lab/agent/reply',{method:'POST',auth:agentAuth,body:reply})).status,200);
  const result=await call(resultUrl,{auth:owner}); assert.equal(result.data.ready,true);
  assert(!result.data.packet.includes('своё.txt'));
  const plain=await secure.open(key,result.data.packet,{channel:id,direction:'response',request:requestId,expires:exp});
  assert.equal(JSON.parse(new TextDecoder().decode(plain)).items[0].name,'своё.txt');
  assert.equal((await call(ackUrl,{auth:owner,method:'POST',body:{requestId}})).status,200);
  assert.equal((await call(ackUrl,{auth:owner,method:'POST',body:{requestId}})).status,200);
  assert.equal((await call(resultUrl,{auth:owner})).status,409);
  assert.equal((await call(requestUrl,{auth:owner,method:'POST',body:{requestId,packet}})).status,409);
  // Реальное TLS-соединение агента с тестовым сервером.
  assert.throws(()=>createAgentClient({baseUrl:base,deviceId:id,token,service}));
  assert.throws(()=>createAgentClient({baseUrl:'https://user:pass@example.org',deviceId:id,token,service}));
  await assert.rejects(createAgentClient({baseUrl:tlsBase,deviceId:id,token,service}).step()); // сертификат по умолчанию не доверен
  const setupClient=createAgentClient({baseUrl:tlsBase,deviceId:id,token:setupToken,service,ca:cert});
  await setupClient.claim(digest(token));
  await assert.rejects(setupClient.claim(digest(hex(32))));
  const agent=createAgentClient({baseUrl:tlsBase,deviceId:id,token,service,ca:cert});
  const rid2=hex(), exp2=Date.now()+30000;
  const packet2=await secure.seal(key,id,'request',rid2,exp2,new TextEncoder().encode(JSON.stringify({op:'read',path:'своё.txt',offset:0,length:100})));
  assert.equal((await call(requestUrl,{auth:owner,method:'POST',body:{requestId:rid2,packet:packet2}})).status,200);
  assert.equal(await agent.step(),true);
  const res2=await call(`/api/pc-lab/devices/${id}/result?requestId=${rid2}`,{auth:owner});
  const plain2=await secure.open(key,res2.data.packet,{channel:id,direction:'response',request:rid2,expires:exp2});
  assert.equal(Buffer.from(JSON.parse(new TextDecoder().decode(plain2)).data,'base64').toString(),'Личные данные');
  assert.equal(await agent.step(),false);
  // Клиент владельца проверяет шифрованный ответ до подтверждения. Ничего не
  // записывается на устройство; тест использует только локальный сервер.
  const ownerReader=createOwnerReadClient({secret:key,deviceId:id});
  const ownerJob=await ownerReader.list('');
  assert.equal((await call(requestUrl,{auth:owner,method:'POST',body:{requestId:ownerJob.requestId,packet:ownerJob.packet}})).status,200);
  assert.equal(await agent.step(),true);
  const ownerResult=await call(`/api/pc-lab/devices/${id}/result?requestId=${ownerJob.requestId}`,{auth:owner});
  const checked=await ownerReader.accept(ownerJob,ownerResult.data.packet);
  assert.equal(checked.ok,true);assert.equal(checked.items[0].name,'своё.txt');
  assert.equal((await call(ackUrl,{auth:owner,method:'POST',body:{requestId:ownerJob.requestId}})).status,200);
  // Транспорт с тестовыми HTTP-обработчиками: ответа двух запросов как будто
  // не дошли до владельца, хотя сервер уже выполнил действия.
  let lostSend=true,lostAck=true, httpGets=0;
  async function checkedCall(url,options) {
    const r=await call(url,{...options,auth:owner});
    if(r.status!==200)throw new Error('HTTP error');return r.data;
  }
  const ownerTransport=createOwnerReadTransport({secret:key,deviceId:id,
    sendRequest:async ({requestId,packet})=>{
      const result=await checkedCall(requestUrl,{method:'POST',body:{requestId,packet}});
      if(lostSend){lostSend=false;throw new Error('lost');}return result;
    },
    getResult:async ({requestId})=>{httpGets++;return checkedCall(`/api/pc-lab/devices/${id}/result?requestId=${requestId}`);},
    acknowledge:async ({requestId})=>{
      const result=await checkedCall(ackUrl,{method:'POST',body:{requestId}});
      if(lostAck){lostAck=false;throw new Error('lost');}return result;
    }
  });
  const transportJob=await ownerTransport.prepareRead('своё.txt',0,100);
  await assert.rejects(ownerTransport.submit(transportJob),/связаться/);
  await ownerTransport.submit(transportJob);assert.equal(await agent.step(),true);
  await assert.rejects(ownerTransport.receive(transportJob),/связаться/);
  const beforeRetry=httpGets,transportResult=await ownerTransport.receive(transportJob);
  assert.equal(httpGets,beforeRetry);assert.equal(Buffer.from(transportResult.data).toString(),'Личные данные');
  // Браузерный HTTP-черновик говорит с настоящим лабораторным API по TLS.
  // Подпроцесс дополнительно доверяет общедоступному тестовому сертификату, а его
  // обёртка адресов имитирует относительный fetch (это не настоящий браузер).
  const worker=fork(fileURLToPath(new URL('./fixtures/local-pc-owner-http-worker.mjs',import.meta.url)),[],{
    env:{...process.env,NODE_EXTRA_CA_CERTS:fileURLToPath(new URL('./fixtures/local-test-only-cert.pem',import.meta.url))},
    stdio:['ignore','pipe','pipe','ipc']});
  let workerError='';worker.stderr.on('data',x=>{workerError+=x;});
  const workerDone=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{worker.kill();reject(new Error('Тестовый клиент завис'));},10000);
    let done=false;
    worker.on('message',async msg=>{
      try {
        if(msg.step==='submitted'){assert.equal(await agent.step(),true);worker.send({step:'processed'});}
        if(msg.step==='done')done=true;
      } catch(e){worker.kill();reject(e);}
    });
    worker.on('error',reject);
    worker.on('exit',code=>{clearTimeout(timer);if(code===0 && done)resolve();else reject(new Error('Тестовый клиент: '+workerError));});
  });
  worker.send({base:tlsBase,token:owner.slice(7),deviceId:id,secret:Array.from(key)});
  await workerDone;
  // Сквозное HTTPS испытание последовательности с подтверждением, зашифрованной
  // копией и закрытием. Источник здесь только фиктивные данные в памяти.
  let snapshotDisposals=0,snapshotRequests=0;
  const fakeBytes=Buffer.from('Личные данные'),fakeVersion='a'.repeat(64),fakeModified='2026-01-01';
  const snapshots=createSnapshotSession({enabled:true,capture:async relative=>{
    assert.equal(relative,'своё.txt');const copy=Buffer.from(fakeBytes);
    return {info:()=>({size:copy.length,hash:crypto.createHash('sha256').update(copy).digest('hex'),version:fakeVersion,modified:fakeModified}),
      read:async(offset,length)=>({data:Buffer.from(copy.subarray(offset,offset+length)),size:copy.length,version:fakeVersion,modified:fakeModified}),
      dispose(){snapshotDisposals++;copy.fill(0);}};
  }});
  const snapshotService=createReadService({folder:await createFolder(folderPath),secret:key,deviceId:id,snapshotSession:snapshots});
  const snapshotAgent=createAgentClient({baseUrl:tlsBase,deviceId:id,token,service:snapshotService,ca:cert});
  const snapshotWorker=fork(fileURLToPath(new URL('./fixtures/local-pc-snapshot-worker.mjs',import.meta.url)),[],{
    env:{...process.env,NODE_EXTRA_CA_CERTS:fileURLToPath(new URL('./fixtures/local-test-only-cert.pem',import.meta.url))},
    stdio:['ignore','pipe','pipe','ipc']});
  let snapshotError='';snapshotWorker.stderr.on('data',x=>{snapshotError+=x;});
  const snapshotDone=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{snapshotWorker.kill();reject(new Error('Тестовая передача зависла'));},15000);let done=false;
    snapshotWorker.on('message',async msg=>{
      try {
        if(msg.step==='poll'){snapshotRequests++;assert.equal(await snapshotAgent.step(),true);snapshotWorker.send({step:'processed'});}
        if(msg.step==='done')done=true;
      } catch(e){snapshotWorker.kill();reject(e);}
    });
    snapshotWorker.on('error',reject);
    snapshotWorker.on('exit',code=>{clearTimeout(timer);if(code===0 && done)resolve();else reject(new Error('Тестовая передача: '+snapshotError));});
  });
  snapshotWorker.send({base:tlsBase,token:owner.slice(7),deviceId:id,secret:Array.from(key)});
  await snapshotDone;assert.equal(snapshotRequests,3);assert.equal(snapshotDisposals,1);
  await assert.rejects(createAgentClient({baseUrl:tlsBase,deviceId:id,token:hex(32),service,ca:cert}).step());
  const dbRaw=await fs.readFile(path.join(tmp,'data','db.json'),'utf8');
  assert(!dbRaw.includes(token)); assert(!dbRaw.includes(setupToken)); assert(!dbRaw.includes('своё.txt')); assert(dbRaw.includes(digest(token)));
  // Новый экземпляр: привязка сохраняется, очередь и статус нет.
  await store.close(); store=createFileStore({dataDir:path.join(tmp,'data')}); await store.open(); app=createApi(store,{localPcExperimental:true});
  list=await call('/api/pc-lab/devices',{auth:owner}); assert.equal(list.data.devices[0].online,false);
  assert.equal((await call(pathAgent,{method:'POST',auth:agentAuth})).status,200);
  assert.equal((await call(resultUrl,{auth:owner})).status,409);
  assert.equal((await call(`/api/pc-lab/devices/${id}/revoke`,{auth:other,method:'POST'})).status,404);
  assert.equal((await call(`/api/pc-lab/devices/${id}/revoke`,{auth:owner,method:'POST'})).status,200);
  assert.equal((await call(pathAgent,{method:'POST',auth:agentAuth})).status,401);
  assert.equal((await call(claimPath,{method:'POST',auth:setupAuth,body:{tokenHash:digest(token)}})).status,401);
  assert.equal((await call('/api/pc-lab/devices',{auth:owner})).data.devices.length,0);
  assert.equal((await call(requestUrl,{auth:owner,method:'POST',body:{requestId,packet}})).status,404);
  // Случайная повторная регистрация старого кода не оживляет отозванный ПК,
  // в том числе после штатного закрытия и открытия тестового хранилища.
  assert.equal((await call('/api/pc-lab/devices',{auth:owner,method:'POST',body:register})).status,409);
  assert.equal((await call('/api/pc-lab/devices',{auth:other,method:'POST',body:register})).status,409);
  let savedUser=(await store.load()).users.find(u=>u.id===userId);
  assert.deepEqual(savedUser.localPcDevices.find(d=>d.id===id),{id,state:'revoked'});
  await store.close();store=createFileStore({dataDir:path.join(tmp,'data')});await store.open();app=createApi(store,{localPcExperimental:true});
  assert.equal((await call('/api/pc-lab/devices',{auth:owner})).data.devices.length,0);
  assert.equal((await call('/api/pc-lab/devices',{auth:owner,method:'POST',body:register})).status,409);
  assert.equal((await call(pathAgent,{method:'POST',auth:agentAuth})).status,401);
  assert.equal((await call(claimPath,{method:'POST',auth:setupAuth,body:{tokenHash:digest(token)}})).status,401);
  savedUser=(await store.load()).users.find(u=>u.id===userId);
  assert.deepEqual(savedUser.localPcDevices.find(d=>d.id===id),{id,state:'revoked'});
  // Полный лабораторный сценарий помощника: код, сохранение, claim, TLS, файл.
  const pair2=await pairing.create({url:tlsBase,userId,privateKey:keys.privateKey,publicKey:keys.publicKey});
  const parsed2=pairing.parse(pair2.code,tlsBase);
  assert.equal((await call('/api/pc-lab/devices',{auth:owner,method:'POST',body:{...pair2.registration,title:'Тест ПК'}})).status,200);
  let vaultData=null;
  const vault={async load(){return vaultData&&{...vaultData}},async save(x){vaultData={...x}}}; // имитация, не DPAPI
  const helper=createCoordinator({vault,anchor:anchorFolder,folderFactory:createFolder,trustedUrl:tlsBase,transportFactory:opts=>createAgentClient({...opts,ca:cert})});
  await helper.prepare(pair2.code,folderPath,tlsBase);
  assert.equal(vaultData.state,'pending');
  await helper.tick();
  assert.equal(vaultData.state,'active'); assert.equal(vaultData.setupToken,undefined);
  const req3=hex(), exp3=Date.now()+30000;
  const packet3=await secure.seal(parsed2.secret,parsed2.deviceId,'request',req3,exp3,new TextEncoder().encode(JSON.stringify({op:'read',path:'своё.txt',offset:0,length:100})));
  assert.equal((await call(`/api/pc-lab/devices/${parsed2.deviceId}/request`,{auth:owner,method:'POST',body:{requestId:req3,packet:packet3}})).status,200);
  assert.equal(await helper.tick(),true);
  const res3=await call(`/api/pc-lab/devices/${parsed2.deviceId}/result?requestId=${req3}`,{auth:owner});
  const plain3=await secure.open(parsed2.secret,res3.data.packet,{channel:parsed2.deviceId,direction:'response',request:req3,expires:exp3});
  assert.equal(Buffer.from(JSON.parse(new TextDecoder().decode(plain3)).data,'base64').toString(),'Личные данные');
  assert.equal((await call(`/api/pc-lab/devices/${parsed2.deviceId}/revoke`,{auth:owner,method:'POST'})).status,200);
  await assert.rejects(helper.tick());
  // Просроченный код не активируется и может быть отменён владельцем.
  const id2=hex(), t2=hex(32), new2=hex(32);
  assert.equal((await call('/api/pc-lab/devices',{auth:owner,method:'POST',body:{id:id2,tokenHash:digest(t2),wrappedKey:'A'.repeat(60),title:'Второй ПК'}})).status,200);
  const db=await store.load(); db.users.find(u=>u.localPcDevices?.some(x=>x.id===id2)).localPcDevices.find(x=>x.id===id2).claimUntil=Date.now()-1;
  const expired=await call('/api/pc-lab/devices',{auth:owner}); assert.equal(expired.data.devices[0].state,'expired');
  assert.equal((await call('/api/pc-lab/agent/claim',{auth:`Local ${id2}:${t2}`,method:'POST',body:{tokenHash:digest(new2)}})).status,401);
  assert.equal((await call(`/api/pc-lab/devices/${id2}/revoke`,{auth:owner,method:'POST'})).status,200);
  assert.equal((await call('/api/pc-lab/devices',{auth:owner})).data.devices.length,0);
  // Сбой записи в тестовой базе: память уже изменена, но на диске ещё старое
  // состояние. Повтор должен заново записать его до ответа, даже если сам
  // запрос выглядит как повтор уже совершённого действия.
  const id3=hex(), old3=hex(32), token3=hex(32), reg3={id:id3,tokenHash:digest(old3),wrappedKey:'A'.repeat(60),title:'Проверка сбоя'};
  let failNext=false;const actualFlush=store.flush.bind(store);
  store.flush=async(...args)=>{if(failNext){failNext=false;throw new Error('секретный текст ошибки');}return actualFlush(...args)};
  const onDisk=async()=>JSON.parse(await fs.readFile(path.join(tmp,'data','db.json'),'utf8')).users.find(u=>u.id===userId).localPcDevices.find(d=>d.id===id3);
  failNext=true;let failed=await call('/api/pc-lab/devices',{auth:owner,method:'POST',body:reg3});
  assert.equal(failed.status,503);assert(!failed.data.error.includes('секретный'));assert.equal(await onDisk(),undefined);
  // Повтор регистрации не выдаёт успех за новое устройство; его результат
  // фиксирует оставшееся в памяти состояние, если новая запись удалась.
  assert.equal((await call('/api/pc-lab/devices',{auth:owner,method:'POST',body:reg3})).status,409);
  assert.equal((await onDisk()).state,'pending');
  const auth3=`Local ${id3}:${old3}`, newAuth3=`Local ${id3}:${token3}`;
  failNext=true;failed=await call(claimPath,{auth:auth3,method:'POST',body:{tokenHash:digest(token3)}});
  assert.equal(failed.status,503);assert.equal((await onDisk()).state,'pending');
  assert.equal((await call(claimPath,{auth:auth3,method:'POST',body:{tokenHash:digest(token3)}})).status,200);
  assert.equal((await onDisk()).state,'active');assert.equal((await onDisk()).tokenHash,digest(token3));
  failNext=true;failed=await call(`/api/pc-lab/devices/${id3}/revoke`,{auth:owner,method:'POST'});
  assert.equal(failed.status,503);assert.equal((await onDisk()).state,'active');
  assert.equal((await call(`/api/pc-lab/devices/${id3}/revoke`,{auth:owner,method:'POST'})).status,404);
  assert.deepEqual(await onDisk(),{id:id3,state:'revoked'});
  await store.close();store=createFileStore({dataDir:path.join(tmp,'data')});await store.open();app=createApi(store,{localPcExperimental:true});
  assert.equal((await call(pathAgent,{auth:newAuth3,method:'POST'})).status,401);
  assert.equal((await call('/api/pc-lab/devices',{auth:owner,method:'POST',body:reg3})).status,409);
  console.log('local-pc-http: лабораторные HTTP и TLS, привязка, сессии, чтение, перезапуск и отзыв проверены; режим выключен по умолчанию');
} finally {
  if(tlsServer) await new Promise(resolve=>tlsServer.close(resolve));
  if(server) await new Promise(resolve=>server.close(resolve));
  if(store) await store.close();
  await fs.rm(tmp,{recursive:true,force:true});
}
