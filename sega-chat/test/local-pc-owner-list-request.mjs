// Проверки в памяти: список не гарантирует полноту и не является синхронизацией.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import vm from 'node:vm';
const {createOwnerListRequest}=createRequire(import.meta.url)('../local-pc/owner-list-request.js');
const entry={name:'папка',dir:true,size:0,modified:'2026-01-01'};let prepared=0,sends=[],receives=0,sendLost=true,receiveLost=true;
const transport={async prepareList(path){prepared++;return {path};},async submit(job){sends.push(job);if(sendLost){sendLost=false;throw Error('lost');}},
  async receive(){receives++;if(receiveLost){receiveLost=false;throw Error('lost');}if(receives===2)return null;return {ok:true,items:[entry]};}};
const list=createOwnerListRequest({transport,timeoutMs:1000,pollMs:1});
const result=await list.list('');assert.deepEqual(result,[entry]);assert.equal(prepared,1);assert.strictEqual(sends[0],sends[1]);assert.equal(receives,3);
result[0].name='изменено';assert.equal(entry.name,'папка');
await assert.rejects(list.list('../x'));assert.equal(prepared,1);
assert.throws(()=>createOwnerListRequest({transport,timeoutMs:1}));assert.throws(()=>createOwnerListRequest({transport,maxAttempts:0}));
for(const value of [{ok:false},{ok:true,items:new Array(5001).fill(entry)},{}]){
  const x=createOwnerListRequest({transport:{...transport,async receive(){return value;}},timeoutMs:500,pollMs:1});await assert.rejects(x.list(''));
}
let start,release;const ready=new Promise(r=>{start=r;});
const waiting=createOwnerListRequest({transport:{async prepareList(){return {};},async submit(){start();await new Promise(r=>{release=r;});},async receive(){throw Error('must not run');}},timeoutMs:1000,pollMs:1});
const ac=new AbortController(),pending=waiting.list('',ac.signal);await ready;await assert.rejects(waiting.list(''),/уже выполняется/);ac.abort();
await assert.rejects(pending,e=>e.name==='AbortError');release();
const hanging=createOwnerListRequest({transport:{async prepareList(){return {};},async submit(){},async receive(){return new Promise(()=>{});}},timeoutMs:100,pollMs:1});
const before=Date.now();await assert.rejects(hanging.list(''),/Время ожидания/);assert(Date.now()-before<2000);
const ctx=vm.createContext({AbortController,setTimeout,clearTimeout});
for(const f of ['path-rules.js','owner-list-request.js'])vm.runInContext(fs.readFileSync(new URL('../local-pc/'+f,import.meta.url),'utf8'),ctx);
const vmList=ctx.SegaLocalOwnerListRequest.createOwnerListRequest({transport,timeoutMs:1000,pollMs:1});assert.equal((await vmList.list(''))[0].name,'папка');
console.log('local-pc-owner-list-request: повторы, ожидание и отмена проверены на заглушках; полнота папки не доказана');
