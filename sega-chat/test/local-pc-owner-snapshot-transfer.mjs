// Лабораторный поток в памяти; никакого скачивания, настоящего UI или Windows.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createOwnerSnapshotTransfer}=require('../local-pc/owner-snapshot-transfer.js');
const {createOwnerReadTransport}=require('../local-pc/owner-read-transport.js');
const {createSnapshotSession}=require('../local-pc/snapshot-session.js');
const {createReadService}=require('../local-pc/read-service.js');
const {createRelay,digest}=require('../local-pc/relay.js');
const secure=require('../local-pc/secure-channel.js');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const version='a'.repeat(64),modified='2026-11-05T00:00:00Z',deviceId='c'.repeat(32),token='d'.repeat(64);
function harness({bytes=Buffer.from('Пробный файл'),loseSend=false,loseAck=false,corrupt=false,closeAckFail=false,delayFirst=false,hangRead=false,tamperOpen=false,ttlMs=5000,onResult}={}) {
  const secret=Uint8Array.from(crypto.randomBytes(32)),relay=createRelay();relay.register('owner',deviceId,digest(token));
  let source=Buffer.from(bytes),captures=0,disposals=0,requests=[],sends=[],ackCount=0,resultCount=0,releaseHang=null;
  const session=createSnapshotSession({enabled:true,ttlMs,capture:async()=>{
    captures++;const copy=Buffer.from(source);let closed=false;
    return {info:()=>({size:copy.length,hash:hash(copy),version,modified}),
      async read(offset,length){const data=Buffer.from(copy.subarray(offset,offset+length));if(corrupt && data.length)data[0]^=1;return {data,size:copy.length,version,modified};},
      dispose(){if(!closed){closed=true;copy.fill(0);disposals++;}}};
  }});
  const folder={async list(){return [];},async read(){throw Error('не используется');}};
  const agent=createReadService({folder,secret,deviceId,snapshotSession:session}),opByRequest=new Map(),waited=new Set();
  const transport=createOwnerReadTransport({secret,deviceId,
    async sendRequest({requestId,packet}){
      sends.push({requestId,packet});relay.request('owner',deviceId,requestId,packet);
      const task=relay.next(deviceId,token);
      if(task){
        const req=JSON.parse(new TextDecoder().decode(await secure.open(secret,packet,{channel:deviceId,direction:'request',request:requestId})));
        requests.push(req.op);opByRequest.set(requestId,req.op);
        const answer=await agent.handle(task.requestId,task.packet);relay.reply(deviceId,token,task.requestId,task.claim,answer);
      }
      if(loseSend){loseSend=false;throw Error('lost');}return {ok:true};
    },
    async getResult({requestId}){
      resultCount++;const op=opByRequest.get(requestId);if(onResult)onResult(op);
      if(hangRead && op==='snapshotRead'){await new Promise(r=>{releaseHang=r;});}
      if(delayFirst && !waited.has(requestId)){waited.add(requestId);return {ready:false};}
      const result=relay.result('owner',deviceId,requestId);
      if(tamperOpen && op==='snapshotOpen' && result.ready)return {...result,packet:result.packet+'x'};
      return result;
    },
    async acknowledge({requestId}){
      ackCount++;relay.acknowledge('owner',deviceId,requestId);
      if(loseAck){loseAck=false;throw Error('lost');}
      if(closeAckFail && opByRequest.get(requestId)==='snapshotClose')throw Error('lost');return {ok:true};
    }
  });
  return {transport,get stats(){return {captures,disposals,requests,sends,ackCount,resultCount};},change(x){source=Buffer.from(x);},release(){if(releaseHang)releaseHang();}};
}
function create(h,options={}){return createOwnerSnapshotTransfer({transport:h.transport,timeoutMs:4000,cleanupTimeoutMs:500,pollMs:1,chunkSize:5,...options});}
assert.throws(()=>createOwnerSnapshotTransfer({}));assert.throws(()=>create(harness(),{maxAttempts:0}));
// Только буквальное согласие: без него нет ни одного запроса, даже на открытие.
const h0=harness(),x0=create(h0);
for(const value of [false,undefined,'да',1,null])assert.equal(await x0.transfer({path:'файл.txt',confirmDownload:()=>value}),null);
assert.equal(h0.stats.sends.length,0);await assert.rejects(x0.transfer({path:'../x',confirmDownload:()=>true}));assert.equal(h0.stats.sends.length,0);
// Незапущенное подтверждение можно отменить, его позднее завершение не запустит обмен.
let confirmReady,confirmRelease;const ready=new Promise(r=>{confirmReady=r;});const stopper=new AbortController();
const pending=x0.transfer({path:'файл.txt',signal:stopper.signal,confirmDownload:()=>{confirmReady();return new Promise(r=>{confirmRelease=r;});}});
await ready;await assert.rejects(x0.transfer({path:'файл.txt',confirmDownload:()=>true}),/уже выполняется/);stopper.abort();
await assert.rejects(pending,e=>e.name==='AbortError');confirmRelease(true);await new Promise(r=>setTimeout(r,10));assert.equal(h0.stats.sends.length,0);
// Полный шифрованный путь: каждый повтор содержит тот же запрос, а подтверждение
// повторяется только после проверки. Ничего не сохраняется на устройство.
const original=Buffer.from('Пробный файл и части'),h=harness({bytes:original,loseSend:true,loseAck:true,delayFirst:true}),progress=[];
const transfer=create(h);let confirmed=0;
const result=await transfer.transfer({path:'файл.txt',confirmDownload:()=>{confirmed++;assert.equal(h.stats.sends.length,0);return true;},
  onProgress(x){progress.push(x);if(x.received>0)h.change(Buffer.from('Другая версия'));}});
assert.equal(confirmed,1);assert.deepEqual(Buffer.from(result.data),original);assert.equal(result.size,original.length);
assert.deepEqual(h.stats.sends[0],h.stats.sends[1]);assert.equal(h.stats.captures,1);assert.equal(h.stats.disposals,1);
assert.deepEqual(h.stats.requests[0],'snapshotOpen');assert.equal(h.stats.requests.at(-1),'snapshotClose');
assert(progress.length>=3);assert.equal(progress[0].received,0);assert.equal(progress.at(-1).verified,true);
assert(progress.slice(0,-1).every(p=>p.verified===false && p.received<=p.total));
// Пустой и большая часть не пропускают проверку или закрытие.
for(const bytes of [Buffer.alloc(0),crypto.randomBytes(128*1024+1)]){
  const h1=harness({bytes}),out=await create(h1,{chunkSize:128*1024}).transfer({path:'файл.txt',confirmDownload:()=>true});
  assert.deepEqual(Buffer.from(out.data),bytes);assert.equal(h1.stats.disposals,1);
}
// Повреждение, отмена во время передачи и неисправный callback не дают файл,
// но известную копию пытаются закрыть отдельным сроком.
const bad=harness({corrupt:true}),badProgress=[];
await assert.rejects(create(bad).transfer({path:'файл.txt',confirmDownload:()=>true,onProgress:p=>badProgress.push(p)}),/не совпадает/);
assert.equal(bad.stats.disposals,1);assert(badProgress.every(p=>!p.verified));
const aborted=harness(),ac=new AbortController();
await assert.rejects(create(aborted).transfer({path:'файл.txt',confirmDownload:()=>true,signal:ac.signal,onProgress:p=>{if(p.received>0)ac.abort();}}),e=>e.name==='AbortError');
assert.equal(aborted.stats.disposals,1);assert.equal(aborted.stats.requests.at(-1),'snapshotClose');
const broken=harness();await assert.rejects(create(broken).transfer({path:'файл.txt',confirmDownload:()=>true,onProgress:()=>{throw Error('stop');}}),/stop/);assert.equal(broken.stats.disposals,1);
const noClose=harness({closeAckFail:true});await assert.rejects(create(noClose).transfer({path:'файл.txt',confirmDownload:()=>true}),/Не удалось закрыть/);assert.equal(noClose.stats.disposals,1);
// Если ответ об открытии не пришёл, номер копии неизвестен и закрыть её нельзя;
// она остаётся до срока. Проверка намеренно показывает это ограничение.
const cancelOpen=new AbortController(),unknown=harness({ttlMs:100,onResult:op=>{if(op==='snapshotOpen')cancelOpen.abort();}});
await assert.rejects(create(unknown).transfer({path:'файл.txt',signal:cancelOpen.signal,confirmDownload:()=>true}),e=>e.name==='AbortError');
assert.equal(unknown.stats.captures,1);assert(!unknown.stats.requests.includes('snapshotClose'));
await new Promise(r=>setTimeout(r,150));assert.equal(unknown.stats.disposals,1);
// Повреждённое зашифрованное открытие не подтверждается, номер неизвестен;
// повторов ограниченное число и копия затем истекает по сроку.
const forged=harness({tamperOpen:true,ttlMs:100});
await assert.rejects(create(forged).transfer({path:'файл.txt',confirmDownload:()=>true}),/Не удалось получить ответ/);
assert.equal(forged.stats.ackCount,0);assert.equal(forged.stats.resultCount,3);
await new Promise(r=>setTimeout(r,150));assert.equal(forged.stats.disposals,1);
// Зависший внешний обработчик может не остановиться, но срок ограничивает
// ожидание, дальнейшие части не начинаются и выполняется попытка закрытия.
const stuck=harness({hangRead:true});const start=Date.now();
await assert.rejects(create(stuck,{timeoutMs:100}).transfer({path:'файл.txt',confirmDownload:()=>true}),/Время ожидания/);
assert(Date.now()-start<2000);assert.equal(stuck.stats.requests.filter(x=>x==='snapshotRead').length,1);assert.equal(stuck.stats.disposals,1);stuck.release();
// Исходники исполняются и как обычные браузерные скрипты в VM.
const ctx=vm.createContext({crypto:crypto.webcrypto,TextEncoder,TextDecoder,Uint8Array,atob,btoa,AbortController,setTimeout,clearTimeout});
for(const f of ['path-rules.js','secure-channel.js','owner-read-client.js','owner-read-transport.js','owner-file-check.js','owner-snapshot-transfer.js'])vm.runInContext(fs.readFileSync(new URL('../local-pc/'+f,import.meta.url),'utf8'),ctx);
const browserHarness=harness(),browser=ctx.SegaLocalOwnerSnapshotTransfer.createOwnerSnapshotTransfer({transport:browserHarness.transport,timeoutMs:4000,cleanupTimeoutMs:500,pollMs:1});
assert.deepEqual(Buffer.from((await browser.transfer({path:'файл.txt',confirmDownload:()=>true})).data),Buffer.from('Пробный файл'));
console.log('local-pc-owner-snapshot-transfer: согласие, шифрованный обмен, повторы, контроль, отмена и закрытие проверены на заглушках; сохранения нет');
