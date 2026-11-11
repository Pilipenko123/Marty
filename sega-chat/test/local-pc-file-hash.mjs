// Только фиктивные источники и память; безопасного доступа к Windows пока нет.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createFileHashCandidate,MAX_FILE,CHUNK}=require('../local-pc/file-hash-candidate.js');
const {checkOwnerFile}=require('../local-pc/owner-file-check.js');
const {createReadService}=require('../local-pc/read-service.js');
const {createOwnerReadClient}=require('../local-pc/owner-read-client.js');
const {createOwnerReadTransport}=require('../local-pc/owner-read-transport.js');
const {createRelay,digest}=require('../local-pc/relay.js');
const channel=require('../local-pc/secure-channel.js');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const version='a'.repeat(64),modified='2026-11-05T00:00:00.000Z';
let bytes=Buffer.alloc(CHUNK+42,7), calls=0;
const read=async (p,offset,length,expected)=>{calls++;assert.equal(p,'файл.bin');assert(expected===null || expected===version);
  return {data:bytes.subarray(offset,offset+length),size:bytes.length,version,modified};};
assert.throws(()=>createFileHashCandidate({read}));assert.throws(()=>createFileHashCandidate({enabled:true}));
const candidate=createFileHashCandidate({enabled:true,read});
const manifest=await candidate.hashFile('файл.bin');assert.deepEqual(manifest,{size:bytes.length,version,modified,hash:hash(bytes)});assert.equal(calls,2);
bytes=Buffer.alloc(0);calls=0;const empty=await candidate.hashFile('файл.bin');assert.equal(empty.hash,hash(bytes));assert.equal(calls,1);
bytes=Buffer.alloc(MAX_FILE,3);calls=0;assert.equal((await candidate.hashFile('файл.bin')).hash,hash(bytes));assert.equal(calls,MAX_FILE/CHUNK);
for(const p of ['','../foo','C:/foo','aux','/foo'])await assert.rejects(candidate.hashFile(p));
const before=calls;await assert.rejects(candidate.hashFile('файл.bin',{}),/сигнал/);assert.equal(calls,before);
const invalid=[
 p=>({...p,size:MAX_FILE+1}),p=>({...p,data:p.data.subarray(1)}),p=>({...p,version:'bad'}),
 p=>({...p,modified:''}),p=>({...p,data:new Uint8Array(p.data)}),
 p=>({...p,version:'b'.repeat(64)}),p=>({...p,modified:'новая дата'}),p=>({...p,size:p.size+1})
];
bytes=Buffer.alloc(CHUNK+42,7);
for(const transform of invalid){let n=0;const c=createFileHashCandidate({enabled:true,read:async (...args)=>{const p=await read(...args);n++;return n===2?transform(p):p;}});
  await assert.rejects(c.hashFile('файл.bin'));assert.equal(n,2);
}
// Источник может обмануть неизменной меткой: ни двойной обход, ни хеш в одиночку
// не доказывают атомарный снимок. Этот тест намеренно демонстрирует ограничение.
const a=Buffer.alloc(CHUNK+42,1),b=Buffer.alloc(CHUNK+42,2), mixed=Buffer.concat([a.subarray(0,CHUNK),b.subarray(CHUNK)]);
const deceptive=createFileHashCandidate({enabled:true,read:async (_p,off,len)=>({data:(off===0?a:b).subarray(off,off+len),size:a.length,version,modified})});
const mixture=await deceptive.hashFile('файл.bin');assert.equal(mixture.hash,hash(mixed));assert.notEqual(mixture.hash,hash(a));assert.notEqual(mixture.hash,hash(b));
// Блокировка сохраняется, пока игнорирующая отмену зависимость не завершилась.
let begin,release;const ready=new Promise(r=>{begin=r;});
const slow=createFileHashCandidate({enabled:true,read:async()=>{begin();await new Promise(r=>{release=r;});return {data:Buffer.alloc(0),size:0,version,modified};}});
const ac=new AbortController(),pending=slow.hashFile('файл.bin',ac.signal);await ready;ac.abort();
await assert.rejects(slow.hashFile('файл.bin'),/выполняется/);release();await assert.rejects(pending,e=>e.name==='AbortError');
// После освобождения предыдущая остановка не блокирует следующий запуск.
const stopped=new AbortController();stopped.abort();await assert.rejects(candidate.hashFile('файл.bin',stopped.signal),e=>e.name==='AbortError');

// Зашифрованный запрос отметки -> несколько запросов частей -> итоговый хеш.
const deviceId='c'.repeat(32),token='d'.repeat(64),secret=Uint8Array.from(crypto.randomBytes(32));
const relay=createRelay();relay.register('owner',deviceId,digest(token));
const folder={list:async()=>[],read};const service=createReadService({folder,secret,deviceId,hashFile:candidate.hashFile});
let readsAfterHash=0, ack=0;
const transport=createOwnerReadTransport({secret,deviceId,
  async sendRequest({requestId,packet}){
    relay.request('owner',deviceId,requestId,packet);const job=relay.next(deviceId,token);
    const answer=await service.handle(job.requestId,job.packet);relay.reply(deviceId,token,requestId,job.claim,answer);return {ok:true};
  },
  async getResult({requestId}){return relay.result('owner',deviceId,requestId);},
  async acknowledge({requestId}){ack++;relay.acknowledge('owner',deviceId,requestId);return {ok:true};}
});
async function getHash(){const j=await transport.prepareFileHash('файл.bin');await transport.submit(j);return transport.receive(j);}
async function getRead({offset,length,version}){readsAfterHash++;const j=await transport.prepareRead('файл.bin',offset,length,version);await transport.submit(j);return transport.receive(j);}
const info=await getHash();assert.equal(info.hash,hash(bytes));assert.equal(info.size,bytes.length);assert.equal(info.version,version);
const complete=await checkOwnerFile({allowed:true,size:info.size,expectedHash:info.hash,expectedVersion:info.version,expectedModified:info.modified,read:getRead});
assert.deepEqual(Buffer.from(complete.data),bytes);assert.equal(readsAfterHash,2);assert.equal(ack,3);
// Изменение без смены метаданных не обходит контроль полного хеша.
bytes=Buffer.alloc(CHUNK+42,8);await assert.rejects(checkOwnerFile({allowed:true,size:info.size,expectedHash:info.hash,expectedVersion:info.version,expectedModified:info.modified,read:getRead}),/не совпадает/);
// Проверяется и версия первой части, даже если её содержимое совпадает.
bytes=Buffer.alloc(CHUNK+42,7);
await assert.rejects(checkOwnerFile({allowed:true,size:info.size,expectedHash:info.hash,expectedVersion:'b'.repeat(64),expectedModified:info.modified,read:getRead}));
await assert.rejects(checkOwnerFile({allowed:true,size:info.size,expectedHash:info.hash,expectedVersion:info.version,expectedModified:'other',read:getRead}),/изменился/);
// По умолчанию действие не включено; ответ не раскрывает внутренние ошибки.
const defaultAgent=createReadService({folder,secret,deviceId});const client=createOwnerReadClient({secret,deviceId});
const job=await client.fileHash('файл.bin');const failure=await defaultAgent.handle(job.requestId,job.packet);
assert.deepEqual(await client.accept(job,failure),{ok:false,error:'Не удалось открыть файл или папку'});
// Корректно зашифрованный, но структурно неверный результат не принимается.
const pendingHash=await client.fileHash('файл.bin');
for(const bad of [
  {ok:true,size:1,version,modified,hash:'wrong'}, {ok:true,size:MAX_FILE+1,version,modified,hash:hash(bytes)},
  {ok:true,size:1,version,modified,hash:hash(bytes),extra:1},{ok:true,size:1,version:'bad',modified,hash:hash(bytes)}
]){
 const packet=await channel.seal(secret,deviceId,'response',pendingHash.requestId,pendingHash.expires,new TextEncoder().encode(JSON.stringify(bad)));
 await assert.rejects(client.accept(pendingHash,packet));
}
await assert.rejects(client.fileHash(''));await assert.rejects(client.fileHash('../bad'));
// Подделанный запрос пути не доходит до обработчика хеширования.
let badCalls=0;const strictAgent=createReadService({folder,secret,deviceId,hashFile:async()=>{badCalls++;return info;}});
for(const payload of [{op:'hash',path:'../x'},{op:'hash',path:''},{op:'hash',path:'файл.bin',extra:true}]) {
  const rid=crypto.randomBytes(16).toString('hex'),expires=Date.now()+60000;
  const packet=await channel.seal(secret,deviceId,'request',rid,expires,new TextEncoder().encode(JSON.stringify(payload)));
  const response=await strictAgent.handle(rid,packet);
  const plain=await channel.open(secret,response,{channel:deviceId,direction:'response',request:rid,expires});
  assert.equal(JSON.parse(new TextDecoder().decode(plain)).ok,false);
}
assert.equal(badCalls,0);
// Повреждённая отметка не подтверждается даже при правильном шифровании.
let badAck=0,badPacket;
const badTransport=createOwnerReadTransport({secret,deviceId,sendRequest:async()=>({ok:true}),
  getResult:async()=>({ready:true,packet:badPacket}),acknowledge:async()=>{badAck++;return {ok:true};}});
const badJob=await badTransport.prepareFileHash('файл.bin');await badTransport.submit(badJob);
badPacket=await channel.seal(secret,deviceId,'response',badJob.requestId,badJob.expires,new TextEncoder().encode(JSON.stringify({ok:true,size:0,version,modified,hash:'bad'})));
await assert.rejects(badTransport.receive(badJob));assert.equal(badAck,0);
console.log('local-pc-file-hash: отметка и сборка через зашифрованные сообщения на заглушках; неизменность Windows не доказана');
