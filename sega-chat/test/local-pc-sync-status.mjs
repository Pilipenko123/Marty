// Модель подписей не подключена к интерфейсу и не доказывает работу сети.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { syncStatus } = createRequire(import.meta.url)('../local-pc/sync-status.js');
const state = (items, changes={}) => syncStatus({online:true,peerOnline:true,scanned:true,scanVerified:true,items,...changes});
const verified = {state:'synced',verified:true};
assert.equal(syncStatus().state,'offline');
assert.equal(state([verified],{online:false}).force,'Нет соединения');
assert.equal(state([verified],{peerOnline:false}).state,'peer-offline');
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
assert.equal(state([{state:'pending'}]).canForce,true);
console.log('local-pc-sync-status: зелёная галочка только при подтверждении, связь и ошибки проверены');
