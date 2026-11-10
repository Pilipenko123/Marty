// Проверяет только протокол на поддельных источнике и временной области.
// Не проверяет файловую систему, Windows, сеть, корзину или публикацию.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
const {transferToStage,MAX_CHUNK}=createRequire(import.meta.url)('../local-pc/verified-transfer.js');
const sum=b=>crypto.createHash('sha256').update(b).digest('hex');
const version='a'.repeat(64);
function fixture(input,extra={}) {
  const data=Buffer.from(input), writes=[], calls=[];
  let aborted=0, verified=0;
  const stage={
    async write(b) {writes.push(Buffer.from(b));},
    async verify() {verified++;const actual=Buffer.concat(writes);return {size:actual.length,hash:sum(actual)};},
    async abort(){aborted++;writes.length=0;}
  };
  async function read(offset,length,v,signal) {
    calls.push({offset,length,version:v,signal});
    return {data:Buffer.from(data.subarray(offset,offset+length)),size:data.length,version};
  }
  return {data,writes,calls,stage,read,stats:()=>({aborted,verified}),
    options:{allowed:true,size:data.length,hash:sum(data),read,stage,chunkSize:4,...extra}};
}
let f=fixture('проверка файла');
let result=await transferToStage(f.options);
assert.deepEqual(result,{size:f.data.length,hash:sum(f.data),version});
assert.deepEqual(Buffer.concat(f.writes),f.data);
assert.deepEqual(f.calls.map(x=>x.offset),[0,4,8,12,16,20,24]);
assert.equal(f.calls[0].version,null);assert(f.calls.slice(1).every(c=>c.version===version));
assert.deepEqual(f.stats(),{aborted:0,verified:1});
f=fixture('');result=await transferToStage(f.options);
assert.equal(result.size,0);assert.equal(f.calls.length,1);assert.equal(f.calls[0].length,1);assert.equal(f.writes.length,0);
f=fixture(Buffer.alloc(MAX_CHUNK*18+7,23),{chunkSize:MAX_CHUNK});
result=await transferToStage(f.options);
assert.equal(f.calls.length,19);assert(f.calls.every(c=>c.length<=MAX_CHUNK));
assert.deepEqual(Buffer.concat(f.writes),f.data);assert.equal(result.hash,sum(f.data));

// Без разрешения не обращаемся ни к источнику, ни к временной области.
f=fixture('secret',{allowed:false});
await assert.rejects(transferToStage(f.options),/не разрешена/);
assert.equal(f.calls.length,0);assert.deepEqual(f.stats(),{aborted:0,verified:0});
for(const overrides of [{size:-1},{size:1.5},{hash:'x'},{chunkSize:MAX_CHUNK+1},{chunkSize:0},{stage:null}]) {
  f=fixture('abc',overrides);await assert.rejects(transferToStage(f.options));assert.equal(f.calls.length,0);
}

// Любое изменение версии, пропуск или порча куска — отказ и очистка.
for(const mutate of [
  (p,i)=>i===1?{...p,version:'b'.repeat(64)}:p,
  (p,i)=>i===1?{...p,size:p.size+1}:p,
  (p,i)=>i===1?{...p,data:p.data.subarray(1)}:p,
  (p,i)=>i===1?{...p,data:Buffer.from('0000')}:p,
  (p,i)=>i===0?{...p,version:'bad'}:p,
  (p,i)=>i===0?{...p,data:'текст'}:p
]) {
  f=fixture('abcdefghij'); let i=0; const original=f.read;
  f.options.read=async(...a)=>mutate(await original(...a),i++);
  await assert.rejects(transferToStage(f.options));
  assert.equal(f.stats().aborted,1);assert.equal(f.writes.length,0);
}
// Неполное или повреждённое содержимое временной области тоже не принимается.
f=fixture('abcdefgh');f.stage.write=async b=>f.writes.push(Buffer.from(b).fill(0));
await assert.rejects(transferToStage(f.options),/Временная копия/);
assert.equal(f.stats().aborted,1);assert.equal(f.writes.length,0);
f=fixture('abcdefgh');f.stage.write=async()=>{throw new Error('диск недоступен');};
await assert.rejects(transferToStage(f.options),/диск недоступен/);assert.equal(f.stats().aborted,1);
f=fixture('abcdefgh');f.stage.verify=async()=>{throw new Error('проверка не удалась');};
await assert.rejects(transferToStage(f.options),/проверка не удалась/);assert.equal(f.stats().aborted,1);
f=fixture('abcdefgh');f.stage.write=async()=>{throw new Error('ошибка записи');};
f.stage.abort=async()=>{throw new Error('ошибка очистки');};
await assert.rejects(transferToStage(f.options),e=>e instanceof AggregateError && e.errors.length===2);

// Отмена до начала и во время передачи не позволяет принять копию.
f=fixture('abcdefgh');let ac=new AbortController();ac.abort();f.options.signal=ac.signal;
await assert.rejects(transferToStage(f.options),e=>e.name==='AbortError');assert.equal(f.calls.length,0);assert.equal(f.stats().aborted,1);
f=fixture('abcdefgh');ac=new AbortController();f.options.signal=ac.signal;
const originalWrite=f.stage.write;f.stage.write=async b=>{await originalWrite(b);ac.abort();};
await assert.rejects(transferToStage(f.options),e=>e.name==='AbortError');assert.equal(f.stats().aborted,1);assert.equal(f.stats().verified,0);
console.log('local-pc-verified-transfer: проверка временной копии, повреждений и остановки на заглушках; настоящие файлы не затронуты');
