// Только поддельные списки и байты в памяти; реальная полнота не проверяется.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {snapshotCandidate,CHUNK,MAX_BYTES}=require('../local-pc/snapshot-candidate.js');
const {planSync}=require('../local-pc/sync-plan.js');
const sha=data=>crypto.createHash('sha256').update(data).digest('hex');
const v='a'.repeat(64), w='b'.repeat(64), clone=value=>JSON.parse(JSON.stringify(value));
function fixture() {
  const file=Buffer.from('содержимое'), empty=Buffer.alloc(0), calls=[];
  const pages={
    '':{complete:true,revision:v,entries:[{name:'папка',type:'dir'},{name:'пусто',type:'file',size:0,revision:v}]},
    'папка':{complete:true,revision:w,entries:[{name:'файл.txt',type:'file',size:file.length,revision:v}]}
  };
  const data={'пусто':empty,'папка/файл.txt':file};
  const list=async(path,signal)=>{calls.push(['list',path,signal]);return clone(pages[path]);};
  const read=async(path,offset,length,version,signal)=>{calls.push(['read',path,offset,length,version,signal]);return {data:Buffer.from(data[path].subarray(offset,offset+length)),size:data[path].length,version:v};};
  return {pages,data,calls,options:{enabled:true,list,read}};
}
let f=fixture(), result=await snapshotCandidate(f.options);
assert.deepEqual(result,[{path:'папка',type:'dir'},{path:'папка/файл.txt',type:'file',size:f.data['папка/файл.txt'].length,hash:sha(f.data['папка/файл.txt'])},{path:'пусто',type:'file',size:0,hash:sha(Buffer.alloc(0))}]);
assert.equal(f.calls.filter(x=>x[0]==='list').length,4);
assert.equal(f.calls.filter(x=>x[0]==='read' && x[1]==='пусто').length,1);
// Полученный формат подходит планировщику, но только тест сам передаёт флаги:
// кандидат не является доказательством полноты и не делает исполнение безопасным.
assert.deepEqual(planSync({enabled:true,online:true,peerOnline:true,baseConfirmed:true,leftComplete:true,rightComplete:true,base:result,left:result,right:result}),[]);
const old=clone(result); f.data['папка/файл.txt'].fill(0);assert.deepEqual(result,old);
f=fixture();await assert.rejects(snapshotCandidate({...f.options,enabled:false}),/не включена/);assert.equal(f.calls.length,0);
for(const override of [{maxItems:-1},{maxBytes:MAX_BYTES+1},{maxBytes:-1},{list:null},{read:null},{signal:{aborted:false}}]) {
  f=fixture();await assert.rejects(snapshotCandidate({...f.options,...override}));assert.equal(f.calls.length,0);
}
f=fixture();await assert.rejects(snapshotCandidate({...f.options,maxItems:2}),/много элементов/);
f=fixture();await assert.rejects(snapshotCandidate({...f.options,maxBytes:1}),/размер/);
for(const modify of [
  p=>delete p.complete,
  p=>{p.complete=false},
  p=>{p.revision='bad'},
  p=>{p.entries=null},
  p=>p.entries.push({name:'../secret',type:'file',size:0,revision:v}),
  p=>p.entries.push({name:'ПАПКА',type:'dir'}),
  p=>p.entries.push({name:'неизвестно',type:'link'}),
  p=>p.entries.push({name:'x',type:'file',size:-1,revision:v}),
  p=>p.entries.push({name:'x',type:'file',size:0,revision:'bad'})
]) {f=fixture();modify(f.pages['']);await assert.rejects(snapshotCandidate(f.options));}
f=fixture();f.options.list=async()=>{throw new Error('нет доступа')};
await assert.rejects(snapshotCandidate(f.options),/нет доступа/);
// Исчезнувший файл и прерванное повторное перечисление не возвращают частичный
// снимок, в том числе если предыдущие файлы уже успели прочитаться.
f=fixture();const originalReadLost=f.options.read;
f.options.read=async(...args)=>{if(args[0]==='пусто')throw Error('файл исчез');return originalReadLost(...args);};
await assert.rejects(snapshotCandidate(f.options),/файл исчез/);assert.equal(f.calls.filter(x=>x[0]==='list').length,2);
f=fixture();const originalListLost=f.options.list;let rootChecks=0;
f.options.list=async(...args)=>{if(args[0]==='' && ++rootChecks===2)throw Error('повторный список оборван');return originalListLost(...args);};
await assert.rejects(snapshotCandidate(f.options),/список оборван/);assert.equal(f.calls.filter(x=>x[0]==='read').length,2);
// Короткий кусок, изменение метки, размера или типа данных отменяет весь результат.
for(const modify of [p=>({...p,data:p.data.subarray(1)}),p=>({...p,version:w}),p=>({...p,size:p.size+1}),p=>({...p,data:'не байты'})]) {
  f=fixture();const read=f.options.read;f.options.read=async(...args)=>modify(await read(...args));
  await assert.rejects(snapshotCandidate(f.options),/не полностью/);
}
// Любое изменение повторного перечисления или метки каталога отвергается.
for(const modify of [
  p=>{p.entries.pop()},
  p=>{p.entries.push({name:'новый',type:'dir'})},
  p=>{p.entries[0].name='другая'},
  p=>{p.revision=w},
  p=>{p.complete=false}
]) {
  f=fixture();const list=f.options.list;let rootCalls=0;
  f.options.list=async(...args)=>{const p=await list(...args);if(args[0]==='' && ++rootCalls===2)modify(p);return p};
  await assert.rejects(snapshotCandidate(f.options));
}
// Источник может скрыть изменение: две сверки не заменяют атомарный снимок.
// Демонстрация известного ограничения, а не разрешение удалять файлы.
f=fixture();const beforeHash=sha(f.data['папка/файл.txt']);const uncheckedList=f.options.list;let rootCalls=0;
f.options.list=async(...args)=>{if(args[0]==='' && ++rootCalls===2)f.data['папка/файл.txt'].fill(0);return uncheckedList(...args)};
result=await snapshotCandidate(f.options);assert.equal(result[1].hash,beforeHash);
assert.notEqual(result[1].hash,sha(f.data['папка/файл.txt']));
f=fixture();const large=Buffer.alloc(CHUNK*2+3,42);f.data['папка/файл.txt']=large;f.pages['папка'].entries[0].size=large.length;
result=await snapshotCandidate(f.options);assert.equal(result[1].hash,sha(large));
assert.deepEqual(f.calls.filter(x=>x[0]==='read' && x[1]==='папка/файл.txt').map(x=>[x[2],x[3]]),[[0,CHUNK],[CHUNK,CHUNK],[CHUNK*2,3]]);
f=fixture();f.data['папка/файл.txt']=large;f.pages['папка'].entries[0].size=large.length;
const largeRead=f.options.read;f.options.read=async(...args)=>{const p=await largeRead(...args);return args[1]===CHUNK?{...p,version:w}:p};
await assert.rejects(snapshotCandidate(f.options),/не полностью/);
let ac=new AbortController();ac.abort();f=fixture();await assert.rejects(snapshotCandidate({...f.options,signal:ac.signal}),e=>e.name==='AbortError');assert.equal(f.calls.length,0);
f=fixture();ac=new AbortController();const read=f.options.read;
f.options.read=async(...args)=>{const r=await read(...args);ac.abort();return r};
await assert.rejects(snapshotCandidate({...f.options,signal:ac.signal}),e=>e.name==='AbortError');
assert.equal(f.calls.filter(x=>x[0]==='list').length,2);

// Даже когда источник игнорирует signal и продолжает работу, отменённое
// ожидание должно завершаться без результата; это НЕ останавливает источник.
const tick=()=>new Promise(r=>setImmediate(r));
async function abortPromptly(p,controller){
  controller.abort();let timer;
  try{await assert.rejects(Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Отмена зависла')),1000);})]),e=>e.name==='AbortError');}
  finally{clearTimeout(timer);}
}
for(const stage of ['first-list','read','second-list']){
  f=fixture();ac=new AbortController();let calls=0,release,rejectLate;
  const originalList=f.options.list,originalRead=f.options.read;
  const deferred=()=>new Promise((resolve,reject)=>{release=resolve;rejectLate=reject;});
  f.options.list=async(...args)=>{calls++;if(stage==='first-list' && calls===1 || stage==='second-list' && args[0]==='' && calls===3)return deferred();return originalList(...args);};
  f.options.read=async(...args)=>stage==='read'?deferred():originalRead(...args);
  const resultPromise=snapshotCandidate({...f.options,signal:ac.signal});
  for(let n=0;n<30 && !release;n++)await tick();assert(release,'ожидаем зависший источник '+stage);
  const count=f.calls.length;await abortPromptly(resultPromise,ac);
  if(stage==='read')rejectLate(Error('поздняя ошибка'));else release({complete:true,revision:v,entries:[]});
  await tick();assert.equal(f.calls.length,count,'после отмены новые обращения недопустимы');
}
// Отмена, возникшая внутри синхронного обработчика до возврата Promise,
// также завершает сбор, даже если сам обработчик не завершился.
f=fixture();ac=new AbortController();let releaseSync;
f.options.list=()=>{ac.abort();return new Promise(r=>{releaseSync=r;});};
await assert.rejects(snapshotCandidate({...f.options,signal:ac.signal}),e=>e.name==='AbortError');releaseSync({});await tick();
f=fixture();ac=new AbortController();f.options.list=()=>{ac.abort();throw Error('ошибка после отмены');};
await assert.rejects(snapshotCandidate({...f.options,signal:ac.signal}),e=>e.name==='AbortError');
f=fixture();ac=new AbortController();const early=snapshotCandidate({...f.options,signal:ac.signal});ac.abort();
await assert.rejects(early,e=>e.name==='AbortError');await tick();assert.equal(f.calls.length,0);
// Слушатели отмены удаляются на успехе, ошибке и отмене, в том числе после
// двух обходов и чтения нескольких файлов.
for(const outcome of ['ok','error','abort']){
  f=fixture();ac=new AbortController();let listeners=0;
  const signal={get aborted(){return ac.signal.aborted;},addEventListener(...args){listeners++;ac.signal.addEventListener(...args);},removeEventListener(...args){listeners--;ac.signal.removeEventListener(...args);}};
  if(outcome==='error')f.options.list=async()=>{throw Error('список недоступен');};
  if(outcome==='abort')f.options.list=()=>new Promise(()=>{});
  const operation=snapshotCandidate({...f.options,signal});
  if(outcome==='abort')await abortPromptly(operation,ac);
  else if(outcome==='error')await assert.rejects(operation,/список недоступен/);
  else await operation;
  assert.equal(listeners,0,outcome);
}
console.log('local-pc-snapshot-candidate: двойная проверка, хеширование и отмена ожидания на заглушках; полнота и Windows не проверены');
