// Отдельный тестовый HTTPS, jsdom и локальная файловая БД; настоящие пользователи,
// Windows, браузер, уведомления и потеря питания не проверяются.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{createFileStore}=require('../lib/store-file'),{createApi}=require('../lib/api');
const previousCooldown=process.env.INVITE_COOLDOWN_MS;process.env.INVITE_COOLDOWN_MS='0';
const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'sega-access-flow-'));
const hex=(n=16)=>crypto.randomBytes(n).toString('hex');let server,tlsServer,spy,store;
try{
  store=createFileStore({dataDir:path.join(tmp,'data')});await store.open();let app=createApi(store);
  let spyHits=0,decisionHits=0,dropFirst=true;
  spy=http.createServer((_req,res)=>{spyHits++;res.writeHead(200);res.end('{}');});await new Promise(r=>spy.listen(0,'127.0.0.1',r));
  const spyUrl=`http://127.0.0.1:${spy.address().port}/`;
  const handler=async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);let body={};try{if(chunks.length)body=JSON.parse(Buffer.concat(chunks).toString());}catch(_){}
    const u=new URL(req.url,'https://test');
    if(u.pathname.startsWith('/redirect/')){res.writeHead(302,{Location:spyUrl});res.end();return;}
    try{
      const out=await app.handle({method:req.method,path:u.pathname,query:u.searchParams,body,headers:req.headers,ip:'127.0.0.1'});
      if(u.pathname==='/api/pc-lab/access/decision' && req.method==='POST' && out.status===200){decisionHits++;if(dropFirst){dropFirst=false;res.destroy();return;}}
      res.writeHead(out.status||200,{'Content-Type':'application/json'});res.end(JSON.stringify(out.json||{}));
    }catch(e){res.writeHead(500);res.end(JSON.stringify({error:'ошибка теста'}));}
  };
  server=http.createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const certPath=fileURLToPath(new URL('./fixtures/local-test-only-cert.pem',import.meta.url));
  const cert=await fs.readFile(certPath),key=await fs.readFile(new URL('./fixtures/local-test-only-key.pem',import.meta.url));
  tlsServer=https.createServer({key,cert},handler);await new Promise(r=>tlsServer.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`,tlsBase=`https://127.0.0.1:${tlsServer.address().port}`;
  async function call(url,{method='GET',body,token}={}){
    const headers={'Content-Type':'application/json'};if(token)headers.Authorization='Bearer '+token;
    const r=await fetch(base+url,{method,headers,body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()};
  }
  const creds=name=>({name,saltAuth:hex(),authKey:hex(32),saltWrap:hex(),wrappedKeyByPass:'w:'+hex(),pub:'pub:'+hex(),wrappedPriv:'priv:'+hex()});
  let setup=await call('/api/setup',{method:'POST',body:{...creds('Администратор'),codeProofSalt:hex(),codeProof:hex(32),codeSalt:hex(),wrappedKeyByCode:'k:'+hex()}});
  assert.equal(setup.status,200);const admin=setup.data.token;
  async function invite(name){
    const secret=hex(24),secretHash=crypto.createHash('sha256').update(secret).digest('hex');
    const inv=await call('/api/invites',{method:'POST',token:admin,body:{invSalt:hex(),wrappedRoomKey:'k:'+hex(),secretHash}});assert.equal(inv.status,200);
    const user=await call('/api/register',{method:'POST',body:{...creds(name),inviteToken:inv.data.invite.id+'.'+secret}});assert.equal(user.status,200);return user.data.token;
  }
  const alice=await invite('Алиса'),bob=await invite('Борис');
  assert.equal((await call('/api/pc-lab/access',{token:alice})).status,404); // обычный сервер не включает API
  app=createApi(store,{localPcExperimental:true});
  async function worker(untrusted){
    const child=fork(fileURLToPath(new URL('./fixtures/local-pc-access-worker.mjs',import.meta.url)),[],{
      env:{...process.env,NODE_EXTRA_CA_CERTS:untrusted?'':certPath},stdio:['ignore','pipe','pipe','ipc']});
    let err='',done=false;child.stderr.on('data',v=>{err+=v;});child.on('message',m=>{if(m.step==='done')done=true;});
    const exited=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{child.kill();reject(Error('Тестовый клиент завис'));},15000);
      child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('exit',code=>{clearTimeout(timer);if(code===0&&done)resolve();else reject(Error('Тестовый клиент: '+err));});
    });
    child.send({base:tlsBase,admin,alice,bob,untrusted});await exited;
  }
  await worker(true);await worker(false);assert.equal(spyHits,0);assert.equal(decisionHits,2);
  assert.equal((await call('/api/pc-lab/access',{token:alice})).data.state,'approved');assert.equal((await call('/api/pc-lab/access',{token:bob})).data.state,'denied');
  await store.close();store=createFileStore({dataDir:path.join(tmp,'data')});await store.open();app=createApi(store,{localPcExperimental:true});
  assert.equal((await call('/api/pc-lab/access',{token:alice})).data.state,'approved');assert.equal((await call('/api/pc-lab/access',{token:bob})).data.state,'denied');
  console.log('local-pc-access-http-flow: окна и разрешения через локальный TLS, обрыв, запрет перенаправления и перезапуск проверены; настоящих уведомлений нет');
}finally{
  for(const s of [server,tlsServer,spy])if(s){s.closeAllConnections?.();await new Promise(r=>s.close(r));}
  if(store)await store.close();await fs.rm(tmp,{recursive:true,force:true});
  if(previousCooldown===undefined)delete process.env.INVITE_COOLDOWN_MS;else process.env.INVITE_COOLDOWN_MS=previousCooldown;
}
