// Только изолированный HTTPS на loopback и фиктивные ключи. Не Windows и не сеть пользователя.
import assert from 'node:assert/strict';
import https from 'node:https';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
const {createAgentClient}=createRequire(import.meta.url)('../local-pc/agent-client.js');
const cert=await fs.readFile(new URL('./fixtures/local-test-only-cert.pem',import.meta.url));
const key=await fs.readFile(new URL('./fixtures/local-test-only-key.pem',import.meta.url));
const deviceId='a'.repeat(32),token='b'.repeat(64),requestId='c'.repeat(32),claim='d'.repeat(32);
let mode='idle', spyHits=0, polls=0, replies=0, serviceCalls=0;
const spy=https.createServer({key,cert},(req,res)=>{spyHits++;res.end('{}');});
await new Promise(resolve=>spy.listen(0,'127.0.0.1',resolve));
const spyUrl=`https://127.0.0.1:${spy.address().port}`;
const server=https.createServer({key,cert},(req,res)=>{
  const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{
    assert.equal(req.headers.authorization,`Local ${deviceId}:${token}`);
    if(req.url.endsWith('/poll'))polls++;
    if(req.url.endsWith('/reply'))replies++;
    if(mode==='redirect' || (mode==='replyredirect' && req.url.endsWith('/reply'))){res.writeHead(302,{Location:spyUrl});res.end();return;}
    if(mode==='unauthorized'){res.writeHead(401);res.end();return;}
    if(mode==='hang')return;
    if(mode==='trickle') {
      res.writeHead(200,{'Content-Type':'application/json'});res.write('{');
      const interval=setInterval(()=>res.write(' '),25);
      res.on('close',()=>clearInterval(interval));return;
    }
    if(mode==='large'){res.writeHead(200);res.end('x'.repeat(512*1024+1));return;}
    if(mode==='broken'){res.writeHead(200);res.end('{');return;}
    if(req.url.endsWith('/claim')) {res.end(JSON.stringify({ok:mode!=='badclaim'}));return;}
    if(req.url.endsWith('/poll')) {res.end(JSON.stringify({job:mode==='idle'?null:{requestId,claim,packet:'request'}}));return;}
    if(req.url.endsWith('/reply')) {
      const body=JSON.parse(Buffer.concat(chunks).toString());assert.equal(body.packet,'answer');
      res.end(JSON.stringify({ok:mode!=='badreply'}));return;
    }
    res.writeHead(404);res.end();
  });
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const baseUrl=`https://127.0.0.1:${server.address().port}`;
const service={async handle(id,packet){serviceCalls++;assert.equal(id,requestId);assert.equal(packet,'request');return 'answer';}};
const client=createAgentClient({baseUrl,deviceId,token,service,ca:cert,timeoutMs:500});
try {
  assert.equal(await client.step(),false);
  mode='normal';assert.equal(await client.step(),true);assert.equal(serviceCalls,1);assert.equal(replies,1);
  mode='badreply';await assert.rejects(client.step(),/не подтвердил/);
  mode='replyredirect';await assert.rejects(client.step(),e=>e.status===302);assert.equal(spyHits,0);
  mode='normal';const countBefore=replies;
  const invalid=createAgentClient({baseUrl,deviceId,token,service:{async handle(){return null;}},ca:cert,timeoutMs:500});
  await assert.rejects(invalid.step(),/Неверный ответ помощника/);assert.equal(replies,countBefore);
  mode='badclaim';await assert.rejects(client.claim('1'.repeat(64)),/не получилось/i);
  mode='unauthorized';await assert.rejects(client.step(),e=>e.status===401 && !e.message.includes(token));
  mode='redirect';await assert.rejects(client.step(),e=>e.status===302);assert.equal(spyHits,0);
  mode='broken';await assert.rejects(client.step(),/Неверный ответ/);
  mode='large';await assert.rejects(client.step(),/слишком большой/);
  mode='trickle';
  const before=Date.now();await assert.rejects(client.step(),/Нет ответа сервера/);
  assert(Date.now()-before<2000,'общий срок запроса не ограничен');
  mode='hang';await assert.rejects(client.step(),/Нет ответа сервера/);
  const ac=new AbortController();const cancelled=client.step(ac.signal);
  setTimeout(()=>ac.abort(),30);await assert.rejects(cancelled,e=>e.name==='AbortError');
  const stopped=new AbortController();stopped.abort();
  const priorCalls=serviceCalls;await assert.rejects(client.step(stopped.signal),e=>e.name==='AbortError');
  assert.equal(serviceCalls,priorCalls);assert(polls>=8);
  console.log('local-pc-agent-client: сроки, обрывы, подтверждение и запрет перенаправлений проверены на локальном HTTPS');
} finally {
  server.closeAllConnections?.();spy.closeAllConnections?.();
  await Promise.all([new Promise(resolve=>server.close(resolve)),new Promise(resolve=>spy.close(resolve))]);
}
