// Модель подписей не подключена к интерфейсу и не доказывает работу сети.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { syncStatus, syncItemStatus } = createRequire(import.meta.url)('../local-pc/sync-status.js');
const itemState = (item, changes={}) => syncItemStatus({online:true,peerOnline:true,enabled:true,scanned:true,scanVerified:true,item:item && {type:'file',...item},...changes});
const state = (items, changes={}) => syncStatus({online:true,peerOnline:true,enabled:true,scanned:true,scanVerified:true,items,...changes});
const verified = {state:'synced',verified:true};
assert.equal(syncStatus().state,'offline');
assert.equal(state([verified],{online:false}).force,'Нет соединения');
assert.equal(state([verified],{peerOnline:false}).state,'peer-offline');
assert.equal(state([verified],{enabled:false}).state,'disabled');
assert.equal(state([{state:'pending'}],{enabled:undefined}).canForce,false);
assert.equal(state([verified],{enabled:false,online:false}).force,'Нет соединения');
assert.equal(state([],{scanned:false}).state,'checking');
assert.equal(state(null).state,'checking');
assert.equal(state([{state:'synced'}]).state,'checking');
assert.equal(state([{state:'mystery'}]).state,'checking');
assert.equal(state([],{scanVerified:false}).state,'checking');
assert.equal(state([],{scanVerified:undefined}).state,'checking');
assert.equal(state([verified],{scanVerified:false}).state,'checking');
assert.equal(state([]).state,'synced'); // полный проверенный пустой список
assert.equal(state([verified]).icon,'check');
assert.equal(state([verified,{state:'pending'}]).state,'pending');
assert.equal(state([{state:'running'}]).label,'Идёт синхронизация');
assert.equal(state([{state:'running'}]).canForce,false);
assert.equal(state([{state:'error'}]).state,'error');
assert.equal(state([{state:'conflict'}]).state,'conflict');
assert.equal(state([{state:'conflict'},{state:'running'}]).icon,'warning');
assert.equal(state([{state:'conflict'},{state:'running'}]).canForce,false);
assert.equal(state([{state:'error'},{state:'running'}]).canForce,false);
assert.equal(state([{state:'pending'}]).canForce,true);
// Для всего окна используется только предоставленный измеренный общий прогресс;
// произвольно выводить его из неполных данных отдельных строк нельзя.
const active={state:'running',progress:{done:25,total:100}};
assert.equal(state([active]).label,'Идёт синхронизация');
assert.equal(state([active],{progress:{done:1,total:3}}).percent,33);
assert.match(state([active],{progress:{done:1,total:3}}).label,/передано 33%/);
assert.equal(state([active],{progress:{done:2,total:2}}).state,'running'); // 100% — не подтверждение результата
assert.match(state([active],{progress:{done:2,total:2}}).label,/передано 100%/);
assert.equal(state([active],{progress:{done:Number.MAX_SAFE_INTEGER-1,total:Number.MAX_SAFE_INTEGER}}).percent,99);
for(const progress of [null,{}, {done:-1,total:2},{done:3,total:2},{done:1,total:0},{done:1.1,total:2},{done:Infinity,total:5},{done:'1',total:2}]) {
  const s=state([active],{progress});assert.equal(s.label,'Идёт синхронизация');assert.equal(s.percent,undefined);
}
assert.equal(state([active],{progress:{done:50,total:100},online:false}).force,'Нет соединения');
assert.equal(state([{state:'pending'}],{progress:{done:50,total:100}}).percent,undefined);
assert.equal(state([verified],{progress:{done:100,total:100},scanVerified:false}).state,'checking');
// Отдельная строка сохраняет собственное состояние и свою кнопку.
assert.equal(itemState(active).percent,25);
assert.equal(itemState({state:'pending'}).canForce,true);
assert.equal(itemState({state:'running'}).canForce,false);
assert.equal(itemState(verified).icon,'check');
assert.equal(itemState(verified,{scanVerified:false}).state,'checking');
assert.equal(itemState(active,{enabled:false}).state,'disabled');
assert.equal(itemState({state:'pending'},{enabled:false}).canForce,false);
assert.equal(itemState(active,{online:false}).label,'Нет соединения');
assert.equal(itemState(active,{peerOnline:false}).state,'peer-offline');
assert.equal(itemState(null).state,'checking');
assert.equal(itemState({state:'conflict'}).state,'conflict');
assert.equal(itemState({...verified,type:'dir'}).state,'checking'); // нет дерева потомков
assert.equal(itemState({...verified,type:'dir',subtreeVerified:true}).state,'checking');
assert.equal(itemState({type:'dir',state:'pending'}).state,'pending');
assert.equal(itemState({...verified,type:'unknown'}).state,'checking');
console.log('local-pc-sync-status: модель строк, общего хода, связи и проверенной галочки; к интерфейсу не подключена');
