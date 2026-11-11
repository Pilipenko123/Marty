// Тесты только на данных в памяти. Реальная загрузка и настоящая папка Windows отсутствуют.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {checkOwnerFile,MAX_FILE,MAX_CHUNK}=require('../local-pc/owner-file-check.js');
const {createOwnerReadTransport}=require('../local-pc/owner-read-transport.js');
const {createReadService}=require('../local-pc/read-service.js');
const {createRelay,digest}=require('../local-pc/relay.js');
const hash=data=>crypto.createHash('sha256').update(data).digest('hex');
const version='a'.repeat(64),modified='2026-11-05T00:00:00.000Z',bytes=Buffer.from('Пример содержимого файла');
let calls=[];
function source(data=bytes){return async ({offset,length,version:expected})=>{
  calls.push({offset,length,expected});return {ok:true,data:Uint8Array.from(data.subarray(offset,offset+length)),size:data.length,version,modified};
};}
let result=await checkOwnerFile({allowed:true,size:bytes.length,expectedHash:hash(bytes),read:source(),chunkSize:7});
assert.deepEqual(Buffer.from(result.data),bytes);assert.equal(result.version,version);assert.equal(result.modified,modified);
assert.equal(calls.length,Math.ceil(bytes.length/7));assert.equal(calls[0].expected,null);assert(calls.slice(1).every(c=>c.expected===version));
// Позднее изменение буфера источника не меняет уже скопированную часть.
let earlier;
const aliasResult=await checkOwnerFile({allowed:true,size:bytes.length,expectedHash:hash(bytes),chunkSize:7,read:async q=>{
  if(earlier)earlier.fill(0);
  const part=await source()(q);earlier=part.data;return part;
}});
assert.deepEqual(Buffer.from(aliasResult.data),bytes);
calls=[];result=await checkOwnerFile({allowed:true,size:0,expectedHash:hash(Buffer.alloc(0)),read:source(Buffer.alloc(0))});
assert.equal(result.data.length,0);assert.equal(calls.length,1);assert.equal(calls[0].length,1);
// Предел памяти проверяется непосредственно на граничном размере.
const maxData=Buffer.alloc(MAX_FILE,0x61);calls=[];
const maxResult=await checkOwnerFile({allowed:true,size:MAX_FILE,expectedHash:hash(maxData),read:source(maxData)});
assert.equal(maxResult.data.length,MAX_FILE);assert.equal(calls.length,MAX_FILE/MAX_CHUNK);
let attempts=0;const never=async()=>{attempts++;throw new Error('should not read')};
for(const allowed of [undefined,false,1,'yes'])await assert.rejects(checkOwnerFile({allowed,size:bytes.length,expectedHash:hash(bytes),read:never}),/не разрешена/);
for(const size of [-1,MAX_FILE+1,1.5,Number.MAX_SAFE_INTEGER])await assert.rejects(checkOwnerFile({allowed:true,size,expectedHash:hash(bytes),read:never}),/Неверные/);
for(const chunkSize of [0,MAX_CHUNK+1,1.5])await assert.rejects(checkOwnerFile({allowed:true,size:bytes.length,expectedHash:hash(bytes),read:never,chunkSize}),/Неверные/);
await assert.rejects(checkOwnerFile({allowed:true,size:bytes.length,expectedHash:'wrong',read:never}));assert.equal(attempts,0);
await assert.rejects(checkOwnerFile({allowed:true,size:bytes.length,expectedHash:'f'.repeat(64),read:source(),chunkSize:7}),/не совпадает/);
const variants=[
  x=>({...x,data:x.data.subarray(1)}),x=>({...x,size:x.size+1}),x=>({...x,version:'bad'}),
  x=>({...x,version:'b'.repeat(64)}),x=>({...x,modified:'другая дата'}),
  x=>({...x,data:'bad'}),x=>({...x,extra:true}),x=>({ok:false,error:'secret'})
];
for(const change of variants){
  let n=0;const base=source();
  await assert.rejects(checkOwnerFile({allowed:true,size:bytes.length,expectedHash:hash(bytes),chunkSize:7,
    read:async q=>{const part=await base(q);return ++n===2?change(part):part;}}));
  assert.equal(n,2);
}
// Перестановка байтов при неизменной метке версии ловится только полным хешем.
await assert.rejects(checkOwnerFile({allowed:true,size:bytes.length,expectedHash:hash(bytes),chunkSize:7,
  read:async q=>{const part=await source()(q);if(q.offset===7)part.data.reverse();return part;}}),/не совпадает/);
// Даже если внешний обработчик игнорирует отмену, следующие части не запрашиваются.
let release,started,delayedCalls=0;const ready=new Promise(r=>{started=r;});const controller=new AbortController();
const delayed=checkOwnerFile({allowed:true,size:bytes.length,expectedHash:hash(bytes),chunkSize:7,signal:controller.signal,
  read:async q=>{delayedCalls++;started();await new Promise(r=>{release=r;});return source()(q);}});
await ready;controller.abort();await assert.rejects(delayed,e=>e.name==='AbortError');release();await new Promise(r=>setTimeout(r,10));assert.equal(delayedCalls,1);
const stopped=new AbortController();stopped.abort();await assert.rejects(checkOwnerFile({allowed:true,size:0,expectedHash:hash(Buffer.alloc(0)),read:never,signal:stopped.signal}),e=>e.name==='AbortError');assert.equal(attempts,0);

// Несколько отдельных шифрованных запросов, настоящие relay и проверка ответов,
// но папка — заглушка. Ack освобождает часть, целый файл проверяется в конце.
const dev='c'.repeat(32),token='d'.repeat(64),secret=Uint8Array.from(crypto.randomBytes(32));
const relay=createRelay();relay.register('owner',dev,digest(token));let reads=0,acks=0;
const service=createReadService({deviceId:dev,secret,folder:{async list(){return [];},async read(_path,offset,length,expected){
  reads++;assert(expected===null || expected===version);return {data:bytes.subarray(offset,offset+length),size:bytes.length,version,modified};
}}});
const transport=createOwnerReadTransport({deviceId:dev,secret,
  async sendRequest({requestId,packet}){relay.request('owner',dev,requestId,packet);return {ok:true};},
  async getResult({requestId}){return relay.result('owner',dev,requestId);},
  async acknowledge({requestId}){acks++;relay.acknowledge('owner',dev,requestId);return {ok:true};}
});
const checked=await checkOwnerFile({allowed:true,size:bytes.length,expectedHash:hash(bytes),chunkSize:7,read:async ({offset,length,version})=>{
  const job=await transport.prepareRead('file.txt',offset,length,version);await transport.submit(job);
  const pending=relay.next(dev,token);const response=await service.handle(pending.requestId,pending.packet);
  relay.reply(dev,token,pending.requestId,pending.claim,response);return transport.receive(job);
}});
assert.deepEqual(Buffer.from(checked.data),bytes);assert.equal(reads,Math.ceil(bytes.length/7));assert.equal(acks,reads);
// Запуск того же кода в браузерном VM без require/Buffer.
const ctx=vm.createContext({crypto:crypto.webcrypto,Uint8Array});
vm.runInContext(fs.readFileSync(new URL('../local-pc/owner-file-check.js',import.meta.url),'utf8'),ctx);
const vmResult=await ctx.SegaLocalOwnerFileCheck.checkOwnerFile({allowed:true,size:bytes.length,expectedHash:hash(bytes),read:source(),chunkSize:7});
assert.deepEqual(Buffer.from(vmResult.data),bytes);
// Отмена во время медленного вычисления хеша также не возвращает результат.
let digestStarted,finishDigest;const digestReady=new Promise(r=>{digestStarted=r;});
const slowCtx=vm.createContext({crypto:{subtle:{digest(){digestStarted();return new Promise(r=>{finishDigest=r;});}}},Uint8Array});
vm.runInContext(fs.readFileSync(new URL('../local-pc/owner-file-check.js',import.meta.url),'utf8'),slowCtx);
const duringDigest=new AbortController();
const digestWork=slowCtx.SegaLocalOwnerFileCheck.checkOwnerFile({allowed:true,size:0,expectedHash:hash(Buffer.alloc(0)),read:source(Buffer.alloc(0)),signal:duringDigest.signal});
await digestReady;duringDigest.abort();await assert.rejects(digestWork,e=>e.name==='AbortError');finishDigest(new Uint8Array(32).buffer);
console.log('local-pc-owner-file-check: сбор в памяти, полный хеш, части, ошибки и отмена проверены на заглушках; скачивания и Windows нет');
