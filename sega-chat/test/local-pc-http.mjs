// Реальный HTTP только на 127.0.0.1 и изолированная база. Обычный сервер этот
// лабораторный API не включает. Здесь НЕТ Windows, установщика или UI.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {createFileStore} = require('../lib/store-file.js');
const {createApi} = require('../lib/api.js');
const {createFolder} = require('../local-pc/folder.js');
const {createReadService} = require('../local-pc/read-service.js');
const {createAgentClient} = require('../local-pc/agent-client.js');
const {createCoordinator,anchorFolder} = require('../local-pc/agent-coordinator.js');
const {digest} = require('../local-pc/relay.js');
const secure = require('../local-pc/secure-channel.js');
const pairing = require('../local-pc/pairing.js');
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
  assert.equal((await call('/api/pc-lab/devices',{auth:owner})).data.devices.length,0);
  // Полный лабораторный сценарий помощника: код, сохранение, claim, TLS, файл.
  const pair2=await pairing.create({url:tlsBase,userId,privateKey:keys.privateKey,publicKey:keys.publicKey});
  const parsed2=pairing.parse(pair2.code,tlsBase);
  assert.equal((await call('/api/pc-lab/devices',{auth:owner,method:'POST',body:{...pair2.registration,title:'Тест ПК'}})).status,200);
  let vaultData=null;
  const vault={async load(){return vaultData&&{...vaultData}},async save(x){vaultData={...x}}}; // имитация, не DPAPI
  const helper=createCoordinator({vault,anchor:anchorFolder,folderFactory:createFolder,transportFactory:opts=>createAgentClient({...opts,ca:cert})});
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
  console.log('local-pc-http: лабораторные HTTP и TLS, привязка, сессии, чтение, перезапуск и отзыв проверены; режим выключен по умолчанию');
} finally {
  if(tlsServer) await new Promise(resolve=>tlsServer.close(resolve));
  if(server) await new Promise(resolve=>server.close(resolve));
  if(store) await store.close();
  await fs.rm(tmp,{recursive:true,force:true});
}
