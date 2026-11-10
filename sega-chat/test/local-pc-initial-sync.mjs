// Только расчёт первого объединения; реальные файлы или Windows не затрагиваются.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {planInitialSync,isInitialPlanActionCurrent,confirmSyncBase}=createRequire(import.meta.url)('../local-pc/sync-plan.js');
const flags={newPairing:true,noPreviousBase:true,enabled:true,online:true,peerOnline:true,leftComplete:true,rightComplete:true};
const file=(path,n)=>({path,type:'file',hash:String(n).repeat(64),size:n});
const dir=path=>({path,type:'dir'});
const plan=(left,right,options={})=>planInitialSync({...flags,left,right,...options});
const current=(action,left,right,options={})=>isInitialPlanActionCurrent({...flags,left,right,...options,action});
const a=file('a',1), b=file('b',2), a2=file('a',2), d=dir('d'), x=file('d/x',1), y=file('d/y',2);
assert.deepEqual(plan([],[]),[]);
assert.deepEqual(plan([a],[a]),[]);
let actions=plan([a],[b]);
assert.deepEqual(actions.map(o=>[o.type,o.path,o.from,o.to]),[['copy','a','left','right'],['copy','b','right','left']]);
assert(actions.every(o=>o.target===null && o.replaceToTrash===false));
assert.equal(current(actions[0],[a],[b]),true);
assert.equal(current(actions[0],[a2],[b]),false);
assert.equal(current(actions[0],[a],[a,b]),false);
assert.equal(current(actions[0],[a],[a2,b]),false);
assert.equal(current({...actions[0],replaceToTrash:true},[a],[b]),false);
assert.equal(current({type:'trash',side:'left',path:'a'},[a],[b]),false);
assert.equal(current(null,[a],[b]),false);
assert.deepEqual(plan([a],[a2]).map(o=>[o.type,o.path]),[['conflict','a']]);
assert.equal(current(plan([a],[a2])[0],[a],[a2]),false);
actions=plan([d,x],[d,y]);
assert.deepEqual(actions.map(o=>[o.type,o.path,o.from]),[['copy','d/x','left'],['copy','d/y','right']]);
actions=plan([d,x],[]);
assert.deepEqual(actions.map(o=>[o.type,o.path]),[['mkdir','d'],['copy','d/x']]);
assert.equal(current(actions[0],[d,x],[]),true);
assert.equal(current(actions[0],[d,x],[d]),false);
actions=plan([file('d',1)],[d,x]);
assert.deepEqual(actions.map(o=>[o.type,o.path]),[['conflict','d']]); // нельзя трогать вложения спорной папки
actions=plan([d,x,a],[d,file('d/x',2),b]);
assert.deepEqual(actions.map(o=>[o.type,o.path]),[['copy','a'],['copy','b'],['conflict','d/x']]);
assert.equal(current(actions[0],[d,x,a],[d,file('d/x',2),b]),true);
for(const key of Object.keys(flags)) {
  for(const value of [false,undefined,'true']) assert.throws(()=>plan([a],[],{[key]:value}),/не подтвержден/);
}
assert.throws(()=>plan([a],[],{base:[]}),/Начальная/); // пустая база не равна отсутствию истории
assert.throws(()=>plan([a],[],{base:null}),/Начальная/);
assert.throws(()=>current(actions[0],[a],[],{peerOnline:false}),/не подтвержден/);
assert.throws(()=>plan([a],null),/Неполный/);
assert.throws(()=>plan([x],[]),/Неполный список папок/);
assert.throws(()=>plan([file('X',1)],[file('x',1)]),/регистром/);
// Ошибку потери старой истории нельзя автоматически превращать в первый запуск:
// решать это и достоверно хранить её должен ещё не существующий исполнитель.
assert.throws(()=>plan([a],[],{newPairing:false,noPreviousBase:true}),/Начальная/);
assert.throws(()=>plan([a],[],{newPairing:true,noPreviousBase:false}),/Начальная/);

// Проверяем все пары вариантов отдельных имён и обе стороны. На первом запуске
// даже при одинаковых/разных файлах не должно быть удаления или замены.
const choices=[null,file('q',1),file('q',2),dir('q')];
for(const left of choices)for(const right of choices) {
  const l=left?[left]:[],r=right?[right]:[];
  const out=plan(l,r);
  assert(out.every(o=>['copy','mkdir','conflict'].includes(o.type)));
  assert(out.filter(o=>o.type==='copy').every(o=>o.target===null && o.replaceToTrash===false));
  if(left && right && JSON.stringify(left)!==JSON.stringify(right)) assert.equal(out[0].type,'conflict');
}
// Разные версии не превращаются в общую базу; совпадающие снимки могут лишь
// предложить её кандидата при отдельном подтверждении завершения всех действий.
const complete={enabled:true,online:true,peerOnline:true,leftComplete:true,rightComplete:true,operationsComplete:true};
assert.throws(()=>confirmSyncBase({...complete,left:[a],right:[a2]}),/различаются/);
assert.throws(()=>confirmSyncBase({...complete,operationsComplete:false,left:[a],right:[a]}),/не подтверждено/);
assert.deepEqual(confirmSyncBase({...complete,left:[a],right:[a]}),[a]);
console.log('local-pc-initial-sync: первый план без удаления и замены, конфликты и флаги проверены в памяти');
