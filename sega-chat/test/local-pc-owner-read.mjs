// Проверка клиентского чтения в памяти и браузерном контексте, без скачивания.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const channel=require('../local-pc/secure-channel.js');
const {createReadService,MAX_READ:SERVER_MAX}=require('../local-pc/read-service.js');
const {createRelay,digest}=require('../local-pc/relay.js');
const {createOwnerReadClient,MAX_READ,MAX_ITEMS}=require('../local-pc/owner-read-client.js');
const {partsOf}=require('../local-pc/folder.js');
assert.equal(MAX_READ,SERVER_MAX);assert.equal(MAX_ITEMS,5000);
let now=3_000_000, count=0;
const dev='a'.repeat(32), token='b'.repeat(64), secret=new Uint8Array(crypto.randomBytes(32));
const text=Buffer.from('Привет мир'), version='1'.repeat(64), modified='2026-01-01T00:00:00.000Z';
const folder={async list(p){count++;assert.equal(p,'');return [{name:'письмо.txt',dir:false,size:text.length,modified},{name:'папка',dir:true,size:0,modified}]},
  async read(p,offset,length,expected){count++;assert.equal(p,'письмо.txt');assert(expected===null || expected===version);return {data:text.subarray(offset,offset+length),size:text.length,modified,version}}};
const agent=createReadService({folder,secret,deviceId:dev,clock:()=>now}), relay=createRelay({clock:()=>now});relay.register('owner',dev,digest(token));
const client=createOwnerReadClient({secret,deviceId:dev,clock:()=>now});
assert.equal(client.download,undefined);assert.equal(client.ack,undefined);
async function processJob(job){
  relay.request('owner',dev,job.requestId,job.packet);
  const leased=relay.next(dev,token);assert.equal(leased.requestId,job.requestId);
  const packet=await agent.handle(leased.requestId,leased.packet);
  relay.reply(dev,token,job.requestId,leased.claim,packet);return relay.result('owner',dev,job.requestId).packet;
}
const list=await client.list('');assert(!list.packet.includes('письмо'));
let reply=await processJob(list), data=await client.accept(list,reply);
assert.deepEqual(data.items,await folder.list(''));assert.equal(relay.result('owner',dev,list.requestId).ready,true);
relay.acknowledge('owner',dev,list.requestId); // только внешняя сторона после проверки
const first=await client.read('письмо.txt',0,4);reply=await processJob(first);data=await client.accept(first,reply);
assert.deepEqual(Buffer.from(data.data),text.subarray(0,4));assert.equal(data.version,version);relay.acknowledge('owner',dev,first.requestId);
const rest=await client.read('письмо.txt',4,MAX_READ,version);reply=await processJob(rest);data=await client.accept(rest,reply);
assert.deepEqual(Buffer.from(data.data),text.subarray(4));relay.acknowledge('owner',dev,rest.requestId);
const eof=await client.read('письмо.txt',999,1,version);data=await client.accept(eof,await processJob(eof));assert.equal(data.data.length,0);relay.acknowledge('owner',dev,eof.requestId);
for(const p of ['../x','/x','C:/x','a\\b','aux.txt','x:secret']) {
  assert.throws(()=>partsOf(p));await assert.rejects(client.list(p));await assert.rejects(client.read(p));
}
for(const args of [['',0,1],['file',-1,1],['file',0,MAX_READ+1],['file',1,1],['file',0,1,'bad']])await assert.rejects(client.read(...args));
assert.throws(()=>createOwnerReadClient({secret:new Uint8Array(1),deviceId:dev}));
assert.throws(()=>createOwnerReadClient({secret,deviceId:'x'}));
const signed=async(job,payload,opts={})=>channel.seal(opts.key||secret,opts.dev||dev,opts.direction||'response',opts.id||job.requestId,opts.expiry||job.expires,new TextEncoder().encode(typeof payload==='string'?payload:JSON.stringify(payload)));
const pending=await client.read('письмо.txt',0,4);
await assert.rejects(client.accept({...pending},await signed(pending,{})),/Неизвестный/);
await assert.rejects(client.accept(pending,await signed(pending,{}, {key:new Uint8Array(32)})));
await assert.rejects(client.accept(pending,await signed(pending,{}, {id:'f'.repeat(32)})));
await assert.rejects(client.accept(pending,await signed(pending,{}, {direction:'request'})));
await assert.rejects(client.accept(pending,await signed(pending,{}, {expiry:pending.expires+1})));
await assert.rejects(client.accept(pending,await signed(pending,'не json')));
const correct={ok:true,data:text.subarray(0,4).toString('base64'),size:text.length,modified,version};
for(const bad of [
  {...correct,data:'!!!!'}, {...correct,data:'YR=='}, {...correct,data:'YQ=='}, {...correct,size:1},
  {...correct,version:'bad'}, {...correct,modified:''}, {...correct,extra:1}, {...correct,ok:'true'}
])await assert.rejects(client.accept(pending,await signed(pending,bad)));
const valid=await signed(pending,correct);assert.deepEqual(Buffer.from((await client.accept(pending,valid)).data),text.subarray(0,4));
assert.deepEqual(Buffer.from((await client.accept(pending,valid)).data),text.subarray(0,4));
await assert.rejects(client.accept(pending,await signed(pending,correct)),/уже проверен/); // другое шифрование — другой ответ
const part=await client.read('письмо.txt',4,4,version);
await assert.rejects(client.accept(part,await signed(part,{...correct,version:'2'.repeat(64)})));
const listed=await client.list('');
for(const items of [
  [{name:'../x',dir:false,size:1,modified}],
  [{name:'a',dir:false,size:1,modified},{name:'A',dir:false,size:1,modified}],
  [{name:'папка',dir:true,size:3,modified}],
  [{name:'x',dir:false,size:1,modified,other:1}],
  new Array(MAX_ITEMS+1).fill({name:'x',dir:false,size:0,modified:'x'})
])await assert.rejects(client.accept(listed,await signed(listed,{ok:true,items})));
const failure=await client.list('');const privateFailure=await signed(failure,{ok:false,error:'секретный путь C:\\'});
assert.deepEqual(await client.accept(failure,privateFailure),{ok:false,error:'Не удалось открыть файл или папку'});
const stale=await client.list('');const staleReply=await signed(stale,{ok:true,items:[]});now=stale.expires+channel.CLOCK_SKEW+1;
await assert.rejects(client.accept(stale,staleReply),/просрочен/);now=3_000_000;
// Два корректно подписанных, но разных ответа не могут оба быть приняты.
const race=await client.list(''), one=await signed(race,{ok:true,items:[]}), two=await signed(race,{ok:true,items:[{name:'x',dir:false,size:1,modified}]});
const done=await Promise.allSettled([client.accept(race,one),client.accept(race,two)]);
assert.equal(done.filter(x=>x.status==='fulfilled').length,1);assert.equal(done.filter(x=>x.status==='rejected').length,1);
// Тот же исходник работает без require/Buffer в отдельном браузерном контексте.
const context=vm.createContext({crypto:crypto.webcrypto,TextEncoder,TextDecoder,Uint8Array,atob,btoa});
for(const file of ['path-rules.js','secure-channel.js','owner-read-client.js'])vm.runInContext(fs.readFileSync(new URL('../local-pc/'+file,import.meta.url),'utf8'),context);
const browser=context.SegaLocalOwnerRead.createOwnerReadClient({secret,deviceId:dev,clock:()=>now});
const browserHashJob=await browser.fileHash('письмо.txt');
const browserHash=await signed(browserHashJob,{ok:true,size:text.length,version,modified,hash:'a'.repeat(64)});
assert.equal((await browser.accept(browserHashJob,browserHash)).hash,'a'.repeat(64));
const browserJob=await browser.read('письмо.txt',0,4);const browserReply=await processJob(browserJob);
assert.deepEqual(Buffer.from((await browser.accept(browserJob,browserReply)).data),text.subarray(0,4));
assert(count>0);
console.log('local-pc-owner-read: проверка запросов и ответов в памяти и браузерном контексте; загрузки и UI нет');
