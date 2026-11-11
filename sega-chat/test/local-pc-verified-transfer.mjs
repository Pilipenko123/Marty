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
for(const overrides of [{size:-1},{size:1.5},{hash:'x'},{chunkSize:MAX_CHUNK+1},{chunkSize:0},{stage:null},{signal:null},{signal:{aborted:false}}]) {
  f=fixture('abc',overrides);await assert.rejects(transferToStage(f.options));assert.equal(f.calls.length,0);assert.equal(f.stats().aborted,0);
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
await assert.rejects(transferToStage(f.options),/уже использована/); // очистка не удалась: повтор той же области запрещён

// Отмена до начала и во время передачи не позволяет принять копию.
f=fixture('abcdefgh');let ac=new AbortController();ac.abort();f.options.signal=ac.signal;
await assert.rejects(transferToStage(f.options),e=>e.name==='AbortError');assert.equal(f.calls.length,0);assert.equal(f.stats().aborted,1);
f=fixture('abcdefgh');ac=new AbortController();f.options.signal=ac.signal;
const originalWrite=f.stage.write;f.stage.write=async b=>{await originalWrite(b);ac.abort();};
await assert.rejects(transferToStage(f.options),e=>e.name==='AbortError');assert.equal(f.stats().aborted,1);assert.equal(f.stats().verified,0);
// Отмена до микрозадачи чтения не вызывает источник и очищает новую область.
f=fixture('abcdefgh');ac=new AbortController();f.options.signal=ac.signal;const early=transferToStage(f.options);ac.abort();
await assert.rejects(early,e=>e.name==='AbortError');assert.equal(f.calls.length,0);assert.equal(f.stats().aborted,1);
// После первого куска источник может зависнуть и игнорировать сигнал. Его
// поздний ответ/ошибка не записывается в область, ожидание и очистка завершаются.
for(const lateError of [false,true]){
  f=fixture('abcdefgh');ac=new AbortController();f.options.signal=ac.signal;
  let enteredRead,finishRead,failRead;const ready=new Promise(r=>{enteredRead=r;}),originalRead=f.read;
  f.options.read=(offset,...rest)=>offset===4?new Promise((resolve,reject)=>{finishRead=resolve;failRead=reject;enteredRead();}):originalRead(offset,...rest);
  const activeRead=transferToStage(f.options);await ready;assert.equal(f.writes.length,1);ac.abort();
  let timer;try{await assert.rejects(Promise.race([activeRead,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Ожидание зависло')),1000);})]),e=>e.name==='AbortError');}finally{clearTimeout(timer);}
  assert.equal(f.stats().aborted,1);assert.equal(f.writes.length,0);
  if(lateError)failRead(Error('поздняя ошибка'));else finishRead({data:Buffer.from('efgh'),size:8,version});
  await new Promise(r=>setImmediate(r));assert.equal(f.writes.length,0);assert.equal(f.stats().aborted,1);
  await assert.rejects(transferToStage(f.options),/уже использована/);
}
// Нельзя очищать область одновременно с ещё выполняющейся записью ИЛИ её
// проверкой: внешний код может продолжить её использовать после отмены.
f=fixture('abcdefgh');ac=new AbortController();f.options.signal=ac.signal;
let verifyStarted,finishVerify;const verifying=new Promise(r=>{verifyStarted=r;});
f.stage.verify=()=>new Promise(r=>{finishVerify=r;verifyStarted();});
const duringVerify=transferToStage(f.options);await verifying;ac.abort();await new Promise(r=>setImmediate(r));assert.equal(f.stats().aborted,0);
finishVerify({size:f.data.length,hash:sum(f.data)});await assert.rejects(duringVerify,e=>e.name==='AbortError');assert.equal(f.stats().aborted,1);

// Готовую временную копию нельзя уничтожить вторым использованием того же
// объекта. Новый объект также обязан означать НОВУЮ изолированную область —
// такую гарантию данный код по одной идентичности объекта не проверяет.
f=fixture('сохранить');result=await transferToStage(f.options);const retained=Buffer.concat(f.writes);
await assert.rejects(transferToStage(f.options),/уже использована/);
assert.deepEqual(Buffer.concat(f.writes),retained);assert.equal(f.stats().aborted,0);
const fresh=fixture('сохранить');assert.equal((await transferToStage(fresh.options)).hash,result.hash);
// Одна область занята, пока ожидаем запись или очистку. Повтор не должен ни
// писать, ни вызывать abort у уже выполняющейся попытки.
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}};
f=fixture('abcdefgh');ac=new AbortController();f.options.signal=ac.signal;
const entered=deferred(), release=deferred(), write=f.stage.write;
f.stage.write=async bytes=>{entered.resolve();await release.promise;await write(bytes)};
const active=transferToStage(f.options);await entered.promise;
await assert.rejects(transferToStage(f.options),/уже использована/);assert.equal(f.stats().aborted,0);
const independent=fixture('другая область');await transferToStage(independent.options);
assert.deepEqual(Buffer.concat(independent.writes),independent.data);assert.equal(f.stats().aborted,0);
ac.abort();await assert.rejects(transferToStage(f.options),/уже использована/);assert.equal(f.stats().aborted,0);
release.resolve();await assert.rejects(active,e=>e.name==='AbortError');assert.equal(f.stats().aborted,1);
await assert.rejects(transferToStage(f.options),/уже использована/);assert.equal(f.stats().aborted,1);
// Зависший abort также не даёт другой попытке использовать тот же объект.
f=fixture('abcdef');const cleaning=deferred(), finishCleaning=deferred();let cleans=0;
f.options.read=async()=>{throw new Error('обрыв')};f.stage.abort=async()=>{cleans++;cleaning.resolve();await finishCleaning.promise};
const failing=transferToStage(f.options);await cleaning.promise;
await assert.rejects(transferToStage(f.options),/уже использована/);assert.equal(cleans,1);
finishCleaning.resolve();await assert.rejects(failing,/обрыв/);
await assert.rejects(transferToStage(f.options),/уже использована/);assert.equal(cleans,1);
console.log('local-pc-verified-transfer: проверка временной копии, повреждений и остановки на заглушках; настоящие файлы не затронуты');
