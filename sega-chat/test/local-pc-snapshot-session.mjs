// Исключительно лабораторная память и поддельный источник; Windows и UI отсутствуют.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createSnapshotSession}=require('../local-pc/snapshot-session.js');
const {createReadService}=require('../local-pc/read-service.js');
const {createOwnerReadTransport}=require('../local-pc/owner-read-transport.js');
const {createOwnerReadClient}=require('../local-pc/owner-read-client.js');
const {checkOwnerFile}=require('../local-pc/owner-file-check.js');
const {createRelay,digest}=require('../local-pc/relay.js');
const secure=require('../local-pc/secure-channel.js');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const version='a'.repeat(64),modified='2026-11-05T00:00:00.000Z';
let source=Buffer.from('Исходное содержимое файла'),created=0,disposed=0;
async function capture(path){
  assert.equal(path,'файл.txt');created++;const copy=Buffer.from(source),info={hash:hash(copy),size:copy.length,version,modified};let closed=false;
  return {info:()=>({...info}),async read(offset,length){if(closed)throw new Error('closed');return {data:Buffer.from(copy.subarray(offset,offset+length)),size:copy.length,version,modified};},
    dispose(){if(!closed){closed=true;copy.fill(0);disposed++;}}};
}
assert.throws(()=>createSnapshotSession({capture}));assert.throws(()=>createSnapshotSession({enabled:true,capture,ttlMs:99}));
const session=createSnapshotSession({enabled:true,capture,ttlMs:5000});
await assert.rejects(session.open('../x'));assert.equal(created,0);
const open=await session.open('файл.txt');assert.match(open.snapshotId,/^[a-f0-9]{32}$/);assert.equal(open.hash,hash(source));
await assert.rejects(session.open('файл.txt'));await assert.rejects(session.read('f'.repeat(32),0,4));
await assert.rejects(session.read(open.snapshotId,-1,1));await assert.rejects(session.read(open.snapshotId,0,131073));
const before=Buffer.from(source);source=Buffer.from('изменено');let piece=await session.read(open.snapshotId,0,4);
assert.deepEqual(piece.data,before.subarray(0,4));piece.data.fill(0);assert.deepEqual((await session.read(open.snapshotId,0,4)).data,before.subarray(0,4));
session.close(open.snapshotId);session.close(open.snapshotId);assert.equal(disposed,1);await assert.rejects(session.read(open.snapshotId,0,1));
const next=await session.open('файл.txt');session.close(open.snapshotId);assert.equal((await session.read(next.snapshotId,0,1)).data[0],source[0]);session.close(next.snapshotId);
assert.throws(()=>session.close('f'.repeat(32)));session.disposeAll();
// Автоматическое закрытие и отказ после истечения срока.
const expires=createSnapshotSession({enabled:true,capture,ttlMs:100});const old=await expires.open('файл.txt');const priorDispose=disposed;
await new Promise(r=>setTimeout(r,150));assert.equal(disposed,priorDispose+1);await assert.rejects(expires.read(old.snapshotId,0,1));expires.close(old.snapshotId);
// Отмена во время внешнего открытия: поздняя копия уничтожается, пока ждём,
// одновременно другую открыть нельзя. Сама зависимость может продолжать работу.
let started,release;const ready=new Promise(r=>{started=r;});
const slow=createSnapshotSession({enabled:true,capture:async p=>{started();await new Promise(r=>{release=r;});return capture(p);}});
const stop=new AbortController(),opening=slow.open('файл.txt',stop.signal);await ready;stop.abort();await assert.rejects(slow.open('файл.txt'));
const pre=disposed;release();await assert.rejects(opening,e=>e.name==='AbortError');assert.equal(disposed,pre+1);
// Повреждённый результат чтения закрывает копию; неудачная очистка блокирует экземпляр.
const broken=createSnapshotSession({enabled:true,capture:async()=>({info:()=>({hash:'b'.repeat(64),size:3,version,modified}),
  read:async()=>({data:Buffer.from([1]),size:3,version,modified}),dispose(){}})});
const damaged=await broken.open('файл.txt');await assert.rejects(broken.read(damaged.snapshotId,0,3));await assert.rejects(broken.read(damaged.snapshotId,0,1));
const poison=createSnapshotSession({enabled:true,capture:async()=>({info:()=>({hash:'b'.repeat(64),size:3,version,modified}),
  read:async()=>({data:Buffer.from([1,2,3]),size:3,version,modified}),dispose(){throw Error('secret')}})});
const unsafe=await poison.open('файл.txt');assert.throws(()=>poison.close(unsafe.snapshotId),/очистить/);await assert.rejects(poison.open('файл.txt'),/очистить/);
// Некорректная метка не выдаётся наружу; асинхронную очистку нельзя считать
// выполненной синхронно, экземпляр останется заблокированным.
let badDisposed=0;
const badInfo=createSnapshotSession({enabled:true,capture:async()=>({info:()=>({hash:'bad',size:3,version,modified}),read:async()=>{},dispose(){badDisposed++;}})});
await assert.rejects(badInfo.open('файл.txt'));assert.equal(badDisposed,1);
const asyncDispose=createSnapshotSession({enabled:true,capture:async()=>({info:()=>({hash:'b'.repeat(64),size:3,version,modified}),read:async()=>{},dispose(){return Promise.reject(Error('late'));}})});
const asyncOpen=await asyncDispose.open('файл.txt');assert.throws(()=>asyncDispose.close(asyncOpen.snapshotId),/очистить/);await assert.rejects(asyncDispose.open('файл.txt'),/очистить/);
// Истечение во время чтения не возвращает запоздавшие данные.
let readStart,readRelease;const readReady=new Promise(r=>{readStart=r;});let expiredDisposed=0;
const slowRead=createSnapshotSession({enabled:true,ttlMs:100,capture:async()=>({info:()=>({hash:'b'.repeat(64),size:3,version,modified}),
  async read(){readStart();await new Promise(r=>{readRelease=r;});return {data:Buffer.from([1,2,3]),size:3,version,modified};},dispose(){expiredDisposed++;}})});
const sr=await slowRead.open('файл.txt'),late=slowRead.read(sr.snapshotId,0,3);await readReady;
assert.throws(()=>slowRead.close(sr.snapshotId),/занята/);
await new Promise(r=>setTimeout(r,150));assert.equal(expiredDisposed,1);readRelease();await assert.rejects(late,/истёк/);

// Полный шифрованный сценарий: потеря ответа на отправку открытия и на ack,
// неизменная копия передаётся частями, затем удаляется из памяти.
source=Buffer.from('Небольшой файл для теста');const original=Buffer.from(source),deviceId='1'.repeat(32),token='2'.repeat(64),secret=Uint8Array.from(crypto.randomBytes(32));
const activeSession=createSnapshotSession({enabled:true,capture,ttlMs:5000});
const folder={async list(){return [];},async read(){throw Error('обычное чтение не используется');}};
const agent=createReadService({folder,secret,deviceId,snapshotSession:activeSession}),relay=createRelay();relay.register('owner',deviceId,digest(token));
let lostSend=true,lostAck=true,sends=[],acks=0,gets=0;
const owner=createOwnerReadTransport({secret,deviceId,
  async sendRequest({requestId,packet}){
    sends.push({requestId,packet});relay.request('owner',deviceId,requestId,packet);const job=relay.next(deviceId,token);
    if(job){const reply=await agent.handle(job.requestId,job.packet);relay.reply(deviceId,token,requestId,job.claim,reply);}
    if(lostSend){lostSend=false;throw Error('lost');}return {ok:true};
  },
  async getResult({requestId}){gets++;return relay.result('owner',deviceId,requestId);},
  async acknowledge({requestId}){acks++;relay.acknowledge('owner',deviceId,requestId);if(lostAck){lostAck=false;throw Error('lost');}return {ok:true};}
});
const job=await owner.prepareSnapshotOpen('файл.txt');const count=created;
await assert.rejects(owner.submit(job));await owner.submit(job);assert.deepEqual(sends[0],sends[1]);assert.equal(created,count+1);
await assert.rejects(owner.receive(job));const priorGets=gets,info=await owner.receive(job);assert.equal(gets,priorGets);assert.equal(acks,2);
source=Buffer.from('теперь другое');
// Ответ агента на тот же номер может жить в памяти до истечения пакета. Закрытие
// копии не отзывается уже выданным получателям и не удаляет ответ из очереди.
const replayJob=await owner.prepareSnapshotRead(info.snapshotId,0,4,info.version);await owner.submit(replayJob);const replayAnswer=await agent.handle(replayJob.requestId,replayJob.packet);
assert.equal((await owner.receive(replayJob)).ok,true);
const assembled=await checkOwnerFile({allowed:true,size:info.size,expectedHash:info.hash,expectedVersion:info.version,expectedModified:info.modified,chunkSize:4,
  async read({offset,length,version}){
    const j=await owner.prepareSnapshotRead(info.snapshotId,offset,length,version);await owner.submit(j);const r=await owner.receive(j);
    if(!r.ok)throw Error('Источник недоступен');const {data,size,modified,version:v}=r;return {ok:true,data,size,modified,version:v};
  }});
assert.deepEqual(Buffer.from(assembled.data),original);
const close=await owner.prepareSnapshotClose(info.snapshotId);await owner.submit(close);assert.deepEqual(await owner.receive(close),{ok:true,snapshotId:info.snapshotId});
const again=await owner.prepareSnapshotClose(info.snapshotId);await owner.submit(again);assert.equal((await owner.receive(again)).ok,true);
assert.equal(await agent.handle(replayJob.requestId,replayJob.packet),replayAnswer); // кэш шифртекста не очищается закрытием
const afterClose=await owner.prepareSnapshotRead(info.snapshotId,0,1,info.version);await owner.submit(afterClose);assert.equal((await owner.receive(afterClose)).ok,false);
// Пустой файл и максимальная часть проходят тот же шифрованный путь.
for(const content of [Buffer.alloc(0),crypto.randomBytes(128*1024+37)]){
  source=content;const openJob=await owner.prepareSnapshotOpen('файл.txt');await owner.submit(openJob);const meta=await owner.receive(openJob);
  const file=await checkOwnerFile({allowed:true,size:meta.size,expectedHash:meta.hash,expectedVersion:meta.version,expectedModified:meta.modified,
    async read({offset,length,version}){const job=await owner.prepareSnapshotRead(meta.snapshotId,offset,length,version);await owner.submit(job);const part=await owner.receive(job);
      const {data,size,modified,version:v}=part;return {ok:true,data,size,modified,version:v};}});
  assert.deepEqual(Buffer.from(file.data),content);
  const closeJob=await owner.prepareSnapshotClose(meta.snapshotId);await owner.submit(closeJob);assert.equal((await owner.receive(closeJob)).ok,true);
}
// Операции отключены по умолчанию.
const defaultAgent=createReadService({folder,secret,deviceId}),client=createOwnerReadClient({secret,deviceId}),disabled=await client.snapshotOpen('файл.txt');
assert.equal((await client.accept(disabled,await defaultAgent.handle(disabled.requestId,disabled.packet))).ok,false);
// Неверный id в зашифрованном ответе не подтверждается.
let invalidPacket,acksBad=0;
const bad=createOwnerReadTransport({secret,deviceId,sendRequest:async()=>({ok:true}),getResult:async()=>({ready:true,packet:invalidPacket}),acknowledge:async()=>{acksBad++;return {ok:true};}});
const badJob=await bad.prepareSnapshotRead(info.snapshotId,0,1,version);await bad.submit(badJob);
invalidPacket=await secure.seal(secret,deviceId,'response',badJob.requestId,badJob.expires,new TextEncoder().encode(JSON.stringify({ok:true,snapshotId:'f'.repeat(32),data:'YQ==',size:1,version,modified})));
await assert.rejects(bad.receive(badJob));assert.equal(acksBad,0);
// Браузерный контекст: код формирует и проверяет сообщение, без реального браузера.
const ctx=vm.createContext({crypto:crypto.webcrypto,TextEncoder,TextDecoder,Uint8Array,atob,btoa});
for(const file of ['path-rules.js','secure-channel.js','owner-read-client.js'])vm.runInContext(fs.readFileSync(new URL('../local-pc/'+file,import.meta.url),'utf8'),ctx);
const web=ctx.SegaLocalOwnerRead.createOwnerReadClient({secret,deviceId}),webJob=await web.snapshotOpen('файл.txt');
const webPacket=await secure.seal(secret,deviceId,'response',webJob.requestId,webJob.expires,new TextEncoder().encode(JSON.stringify({ok:true,...info})));
assert.equal((await web.accept(webJob,webPacket)).snapshotId,info.snapshotId);
console.log('local-pc-snapshot-session: шифрованные части одной копии, обрывы, срок и очистка проверены на заглушках; Windows не проверена');
