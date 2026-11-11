// Только тестовый relay и данные в памяти. Диск, скачивание и Windows не задействованы.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createOwnerReadTransport}=require('../local-pc/owner-read-transport.js');
const {createReadService}=require('../local-pc/read-service.js');
const {createRelay,digest}=require('../local-pc/relay.js');
const channel=require('../local-pc/secure-channel.js');
const dev='a'.repeat(32),token='b'.repeat(64),secret=new Uint8Array(crypto.randomBytes(32));
const version='1'.repeat(64), modified='2026-01-01T00:00:00.000Z', data=Buffer.from('Тестовый файл');
let now=3_000_000, reads=0, lists=0, sends=0, gets=0, acks=0, sendLost=true, ackLost=true;
const folder={async list(){lists++;return [{name:'тест.txt',dir:false,size:data.length,modified}]},
  async read(_p,offset,length){reads++;return {data:data.subarray(offset,offset+length),size:data.length,modified,version}}};
const relay=createRelay({clock:()=>now});relay.register('owner',dev,digest(token));
const agent=createReadService({folder,secret,deviceId:dev,clock:()=>now});
const sent=[];
const adapter={
  async sendRequest({deviceId,requestId,packet}){sends++;sent.push({requestId,packet});relay.request('owner',deviceId,requestId,packet);if(sendLost){sendLost=false;throw new Error('потерян ответ');}return {ok:true}},
  async getResult({deviceId,requestId}){gets++;return relay.result('owner',deviceId,requestId)},
  async acknowledge({deviceId,requestId}){acks++;relay.acknowledge('owner',deviceId,requestId);if(ackLost){ackLost=false;throw new Error('потерян ответ');}return {ok:true}}
};
const transport=createOwnerReadTransport({secret,deviceId:dev,clock:()=>now,...adapter});
const job=await transport.prepareRead('тест.txt',0,4);
assert.equal(transport.download,undefined);assert.equal(sends,0);assert.equal(reads,0);
await assert.rejects(transport.receive(job),/не отправлен/);
await assert.rejects(transport.submit({...job}),/Неизвестный/);
await assert.rejects(transport.submit(job),/связаться/); // запрос принят, ответ потерялся
assert.equal(sends,1);await assert.rejects(transport.receive(job),/не отправлен/);
await transport.submit(job);assert.equal(sends,2);assert.deepEqual(sent[0],sent[1]);
await transport.submit(job);assert.equal(sends,2); // подтверждённый запрос повторно не отправляется
assert.equal(await transport.receive(job),null);assert.equal(acks,0);
const leased=relay.next(dev,token), response=await agent.handle(leased.requestId,leased.packet);
relay.reply(dev,token,leased.requestId,leased.claim,response);assert.equal(reads,1);
await assert.rejects(transport.receive(job),/связаться/);assert.equal(acks,1);
// Подтверждение дошло, но ответ потерялся. Повторяем именно ack, а не чтение.
const getCount=gets, result=await transport.receive(job);assert.equal(acks,2);assert.equal(gets,getCount);assert.equal(reads,1);
assert.deepEqual(Buffer.from(result.data),data.subarray(0,4));result.data.fill(0);
assert.deepEqual(Buffer.from((await transport.receive(job)).data),data.subarray(0,4));assert.equal(acks,2);

// Повреждённый ответ и некорректный формат сервера никогда не подтверждаются.
let malicious='', maliciousAcks=0, replyFormat;
const bad=createOwnerReadTransport({secret,deviceId:dev,clock:()=>now,sendRequest:async()=>({ok:true}),
  getResult:async()=>replyFormat || {ready:true,packet:malicious},acknowledge:async()=>{maliciousAcks++;return {ok:true}}});
const badJob=await bad.prepareList('');await bad.submit(badJob);
replyFormat={ready:true,packet:'bad',extra:1};await assert.rejects(bad.receive(badJob),/Неверный ответ/);assert.equal(maliciousAcks,0);
replyFormat=null;
malicious=await channel.seal(secret,dev,'response','f'.repeat(32),badJob.expires,new TextEncoder().encode('{"ok":true,"items":[]}'));
await assert.rejects(bad.receive(badJob));assert.equal(maliciousAcks,0);
malicious=await channel.seal(secret,dev,'response',badJob.requestId,badJob.expires,new TextEncoder().encode('{"ok":true,"items":[{"name":"../bad","dir":false,"size":0,"modified":"x"}]}'));
await assert.rejects(bad.receive(badJob));assert.equal(maliciousAcks,0);
malicious=await channel.seal(new Uint8Array(32),dev,'response',badJob.requestId,badJob.expires,new TextEncoder().encode('{"ok":true,"items":[]}'));
await assert.rejects(bad.receive(badJob));assert.equal(maliciousAcks,0);
malicious=await channel.seal(secret,dev,'response',badJob.requestId,badJob.expires,new TextEncoder().encode('{"ok":true,"items":[]}'));
assert.deepEqual(await bad.receive(badJob),{ok:true,items:[]});assert.equal(maliciousAcks,1);
// Серверная подтверждённая ошибка тоже проверяется, детали источника не выдаём.
const errJob=await bad.prepareList('');await bad.submit(errJob);
malicious=await channel.seal(secret,dev,'response',errJob.requestId,errJob.expires,new TextEncoder().encode('{"ok":false,"error":"секретный путь"}'));
assert.deepEqual(await bad.receive(errJob),{ok:false,error:'Не удалось открыть файл или папку'});assert.equal(maliciousAcks,2);

// Ошибочный ответ на подтверждение не превращается в успех; повторяется только ack.
let ackTry=0,ackGets=0,ackPacket;
const ackBad=createOwnerReadTransport({secret,deviceId:dev,clock:()=>now,sendRequest:async()=>({ok:true}),
  getResult:async()=>{ackGets++;return {ready:true,packet:ackPacket}},
  acknowledge:async()=>++ackTry===1?{ok:true,extra:'bad'}:{ok:true}});
const ackJob=await ackBad.prepareList('');await ackBad.submit(ackJob);
ackPacket=await channel.seal(secret,dev,'response',ackJob.requestId,ackJob.expires,new TextEncoder().encode('{"ok":true,"items":[]}'));
await assert.rejects(ackBad.receive(ackJob),/не подтверждён/);assert.deepEqual(await ackBad.receive(ackJob),{ok:true,items:[]});assert.equal(ackTry,2);assert.equal(ackGets,1);

// Одновременно два действия одного запроса не запускаются; отмена после
// задержанного результата не начинает ack. Зависимость может продолжать работу.
let entered,release;const enteredPromise=new Promise(r=>{entered=r});
let delayedAcks=0,latePacket;
const slow=createOwnerReadTransport({secret,deviceId:dev,clock:()=>now,sendRequest:async()=>({ok:true}),
  getResult:async()=>{entered();await new Promise(r=>{release=r});return {ready:true,packet:latePacket}},
  acknowledge:async()=>{delayedAcks++;return {ok:true}}});
const slowJob=await slow.prepareList('');latePacket=await channel.seal(secret,dev,'response',slowJob.requestId,slowJob.expires,new TextEncoder().encode('{"ok":true,"items":[]}'));
await slow.submit(slowJob);const stop=new AbortController(), waiting=slow.receive(slowJob,stop.signal);await enteredPromise;
await assert.rejects(slow.receive(slowJob),/уже обрабатывается/);stop.abort();release();
await assert.rejects(waiting,e=>e.name==='AbortError');assert.equal(delayedAcks,0);
// Неверный/уже остановленный сигнал не вызывает сетевой обработчик.
let emptyCalls=0;const empty=createOwnerReadTransport({secret,deviceId:dev,clock:()=>now,
  sendRequest:async()=>{emptyCalls++;return {ok:true}},getResult:async()=>({ready:false}),acknowledge:async()=>({ok:true})});
const emptyJob=await empty.prepareList('');const stopped=new AbortController();stopped.abort();
await assert.rejects(empty.submit(emptyJob,stopped.signal),e=>e.name==='AbortError');
await assert.rejects(empty.submit(emptyJob,{aborted:false}),/сигнал/);assert.equal(emptyCalls,0);
now=emptyJob.expires+channel.CLOCK_SKEW+1;await assert.rejects(empty.submit(emptyJob),/истёк/);assert.equal(emptyCalls,0);now=3_000_000;
// Код выполняется в браузерном контексте без require и Buffer.
const context=vm.createContext({crypto:crypto.webcrypto,TextEncoder,TextDecoder,Uint8Array,atob,btoa});
for(const name of ['path-rules.js','secure-channel.js','owner-read-client.js','owner-read-transport.js'])vm.runInContext(fs.readFileSync(new URL('../local-pc/'+name,import.meta.url),'utf8'),context);
const browser=context.SegaLocalOwnerTransport.createOwnerReadTransport({secret,deviceId:dev,clock:()=>now,...adapter});
const browserJob=await browser.prepareList('');await browser.submit(browserJob);
const bj=relay.next(dev,token), bp=await agent.handle(bj.requestId,bj.packet);relay.reply(dev,token,bj.requestId,bj.claim,bp);
const out=await browser.receive(browserJob);assert.equal(out.items[0].name,'тест.txt');assert.equal(lists,1);
console.log('local-pc-owner-transport: повторы запроса и подтверждения, остановка и браузерный контекст проверены на заглушках');
