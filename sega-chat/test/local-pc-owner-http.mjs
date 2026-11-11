// Лабораторный HTTPS, общедоступный тестовый сертификат и поддельная папка.
// Node fetch с обёрткой относительных адресов — не настоящий браузер и не Windows.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import https from 'node:https';
import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import vm from 'node:vm';
const require=createRequire(import.meta.url);
const {createOwnerHttp,MAX_RESPONSE}=require('../local-pc/owner-http.js');
const {createOwnerReadTransport}=require('../local-pc/owner-read-transport.js');
const {createRelay,digest}=require('../local-pc/relay.js');
const {createReadService}=require('../local-pc/read-service.js');
const dev='a'.repeat(32),token='b'.repeat(48),agentToken='c'.repeat(64),requestId='d'.repeat(32),secret=new Uint8Array(32).fill(42);
if(process.argv[2]==='child') {
  const base=process.argv[3];globalThis.location=new URL(base);
  const nativeFetch=globalThis.fetch;
  globalThis.fetch=(url,options)=>nativeFetch(new URL(url,base),options);
  if(process.argv[4]==='untrusted'){
    await assert.rejects(createOwnerHttp({deviceId:dev,getToken:()=>token,prefix:'/ok'}).getResult({deviceId:dev,requestId}));
    process.exit(0);
  }
  const make=(prefix='',timeoutMs=600)=>createOwnerHttp({deviceId:dev,getToken:()=>token,prefix,timeoutMs});
  const opts={deviceId:dev,requestId,packet:'encrypted'};
  const normal=make('/ok');assert.deepEqual(await normal.getResult(opts),{ready:false});
  for(const prefix of ['https://evil.example','//evil','/../x','/x?y','/x%2f','/x/','/x\\evil'])assert.throws(()=>make(prefix));
  const origLoc=globalThis.location;globalThis.location=new URL('http://example.org');assert.throws(()=>make());globalThis.location=origLoc;
  assert.throws(()=>createOwnerHttp({deviceId:dev,getToken:()=>token,timeoutMs:1}));
  assert.throws(()=>normal.getResult({...opts,deviceId:'x'}));
  await assert.rejects(normal.getResult({...opts,requestId:'x'}));
  await assert.rejects(normal.sendRequest({...opts,packet:'x'.repeat(360001)}));
  await assert.rejects(createOwnerHttp({deviceId:dev,getToken:()=>token+'\r\n',prefix:'/ok'}).getResult(opts),/сессии/);
  for(const mode of ['/redirect','/status','/badtype','/badjson','/utf8','/large','/streamlarge','/truncated'])
    await assert.rejects(make(mode).getResult(opts),undefined,mode);
  let start=Date.now();await assert.rejects(make('/trickle',150).getResult(opts),/Нет ответа/);assert(Date.now()-start<2000);
  start=Date.now();await assert.rejects(make('/hang',150).getResult(opts),/Нет ответа/);assert(Date.now()-start<2000);
  const stop=new AbortController(),pending=make('/hang',1000).getResult({...opts,signal:stop.signal});setTimeout(()=>stop.abort(),50);
  await assert.rejects(pending,e=>e.name==='AbortError');
  const stopped=new AbortController();stopped.abort();await assert.rejects(normal.getResult({...opts,signal:stopped.signal}),e=>e.name==='AbortError');
  // Реальный TLS к тестовому relay, потеря сетевых ответов после выполнения.
  const http=make('/lost'), transport=createOwnerReadTransport({secret,deviceId:dev,...http});
  const job=await transport.prepareRead('file.txt',0,4);
  await assert.rejects(transport.submit(job),/связаться/);await transport.submit(job);
  await assert.rejects(transport.receive(job),/связаться/);
  const result=await transport.receive(job);assert.equal(Buffer.from(result.data).toString(),'test');
  assert.equal(Buffer.from((await transport.receive(job)).data).toString(),'test');
  console.log('owner-http child: HTTPS and faults passed');
} else {
  const certPath=fileURLToPath(new URL('./fixtures/local-test-only-cert.pem',import.meta.url));
  const cert=await fs.readFile(certPath),key=await fs.readFile(new URL('./fixtures/local-test-only-key.pem',import.meta.url));
  let spyHits=0,readCount=0,sendCount=0,ackCount=0,getCount=0,lostSend=true,lostAck=true;
  const relay=createRelay();relay.register('owner',dev,digest(agentToken));
  const service=createReadService({secret,deviceId:dev,folder:{async list(){return [];},async read(){readCount++;return {data:Buffer.from('test'),size:4,modified:'2026-01-01',version:'f'.repeat(64)};}}});
  const spy=https.createServer({key,cert},(_req,res)=>{spyHits++;res.end('{}');});
  await new Promise(r=>spy.listen(0,'127.0.0.1',r));
  const spyUrl=`https://127.0.0.1:${spy.address().port}/`;
  const server=https.createServer({key,cert},(req,res)=>{
    const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',async()=>{
      try {
        assert.equal(req.headers.authorization,'Bearer '+token);
        const url=new URL(req.url,'https://test'),mode=url.pathname.split('/')[1], action=url.pathname.split('/').pop();
        const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{};
        if(mode==='redirect'){res.writeHead(302,{Location:spyUrl});return res.end();}
        if(mode==='status'){res.writeHead(401);return res.end('secret error');}
        if(mode==='hang')return;
        if(mode==='trickle'){res.writeHead(200,{'Content-Type':'application/json'});res.write('{');const t=setInterval(()=>res.write(' '),20);res.on('close',()=>clearInterval(t));return;}
        if(mode==='badtype'){res.writeHead(200,{'Content-Type':'text/html'});return res.end('{}');}
        if(mode==='badjson'){res.writeHead(200,{'Content-Type':'application/json'});return res.end('{');}
        if(mode==='utf8'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(Buffer.from([0xff]));}
        if(mode==='large'){res.writeHead(200,{'Content-Type':'application/json','Content-Length':MAX_RESPONSE+1});return res.end('x');}
        if(mode==='streamlarge'){res.writeHead(200,{'Content-Type':'application/json'});return res.end('x'.repeat(MAX_RESPONSE+1));}
        if(mode==='truncated'){res.writeHead(200,{'Content-Type':'application/json','Content-Length':100});res.write('{}');return res.destroy();}
        let data={ready:false};
        if(mode==='lost' && action==='request'){
          sendCount++;relay.request('owner',dev,body.requestId,body.packet);
          if(lostSend){lostSend=false;return res.destroy();}
          const job=relay.next(dev,agentToken);const packet=await service.handle(job.requestId,job.packet);
          relay.reply(dev,agentToken,job.requestId,job.claim,packet);data={ok:true};
        }
        if(mode==='lost' && action==='result'){getCount++;data=relay.result('owner',dev,url.searchParams.get('requestId'));}
        if(mode==='lost' && action==='ack'){ackCount++;relay.acknowledge('owner',dev,body.requestId);if(lostAck){lostAck=false;return res.destroy();}data={ok:true};}
        res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(data));
      } catch(e){console.error(e);res.destroy();}
    });
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`https://127.0.0.1:${server.address().port}`;
  try {
    // Файл загружается также как браузерный скрипт; эта среда не является
    // настоящим браузером и не проверяет его политики безопасности.
    let seen;
    const ctx=vm.createContext({location:new URL(base),URL,AbortController,TextDecoder,Uint8Array,setTimeout,clearTimeout,
      fetch:async(url,options)=>{seen={url,options};return new Response('{"ready":false}',{status:200,headers:{'content-type':'application/json'}});}});
    vm.runInContext(await fs.readFile(new URL('../local-pc/owner-http.js',import.meta.url),'utf8'),ctx);
    const vmHttp=ctx.SegaLocalOwnerHttp.createOwnerHttp({deviceId:dev,getToken:()=>token,prefix:'/ok'});
    assert.equal((await vmHttp.getResult({deviceId:dev,requestId})).ready,false);
    assert.equal(seen.url,`${base}/ok/api/pc-lab/devices/${dev}/result?requestId=${requestId}`);
    assert.equal(seen.options.redirect,'error');assert.equal(seen.options.credentials,'omit');assert.equal(seen.options.mode,'same-origin');
    // Ответ предыдущего пользователя не выдаётся после смены сессии. Сервер
    // всё равно мог выполнить запрос; код выхода должен отдельно отменять его.
    let currentToken=token,release,startFetch,fetchCount=0;
    const started=new Promise(r=>{startFetch=r;});
    ctx.fetch=async()=>{fetchCount++;startFetch();await new Promise(r=>{release=r;});return new Response('{"ready":false}',{headers:{'content-type':'application/json'}});};
    const sessionHttp=ctx.SegaLocalOwnerHttp.createOwnerHttp({deviceId:dev,getToken:()=>currentToken,prefix:'/ok'});
    const pendingSession=sessionHttp.getResult({deviceId:dev,requestId});await started;currentToken='c'.repeat(48);release();
    await assert.rejects(pendingSession,/Сессия изменилась/);
    await assert.rejects(sessionHttp.getResult({deviceId:dev,requestId}),/Сессия изменилась/);assert.equal(fetchCount,1);
    const untrusted=spawn(process.execPath,[fileURLToPath(import.meta.url),'child',base,'untrusted'],{env:{...process.env,NODE_EXTRA_CA_CERTS:''},stdio:'pipe'});
    let untrustedErr='';untrusted.stderr.on('data',x=>{untrustedErr+=x;});
    const untrustedCode=await new Promise((resolve,reject)=>{untrusted.on('error',reject);untrusted.on('close',resolve);});assert.equal(untrustedCode,0,untrustedErr);
    const child=spawn(process.execPath,[fileURLToPath(import.meta.url),'child',base],{env:{...process.env,NODE_EXTRA_CA_CERTS:certPath},stdio:['ignore','pipe','pipe']});
    let out='',err='';child.stdout.on('data',x=>{out+=x;});child.stderr.on('data',x=>{err+=x;});
    const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
    assert.equal(code,0,`${out}\n${err}`);assert.equal(spyHits,0);assert.equal(sendCount,2);assert.equal(ackCount,2);assert.equal(getCount,1);assert.equal(readCount,1);
    console.log('local-pc-owner-http: TLS, размеры, сроки, отмена, подмены, повтор и запрет перенаправлений проверены; браузер и Windows не проверены');
  } finally {
    server.closeAllConnections?.();spy.closeAllConnections?.();
    await Promise.all([new Promise(r=>server.close(r)),new Promise(r=>spy.close(r))]);
  }
}
