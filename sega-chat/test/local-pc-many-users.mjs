// Лабораторная проверка лимитов с поддельной базой. Это не тест VPS, сети,
// реальных компьютеров, облачных дисков или групповой синхронизации.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createExperimentalApi,MAX_ACTIVE_DEVICES}=require('../local-pc/experimental-api');
const {digest,MAX_DEVICES}=require('../local-pc/relay');
const api=createExperimentalApi(),token='b'.repeat(64),id=n=>n.toString(16).padStart(32,'0');
const approved={id:'a'.repeat(32),state:'approved',requestedAt:1,decidedAt:2,by:'admin'};
const people=Array.from({length:26},(_,i)=>({id:'u'+i,localPcAccess:{...approved},localPcDevices:[]}));
const db={users:people},req=(path,method='GET',body={})=>({path,method,body,headers:{},query:new URLSearchParams(),ip:'local-test'});
let saves=0;const save=()=>{saves++};
assert(MAX_ACTIVE_DEVICES>=4);assert.equal(MAX_DEVICES,100);
for(let i=0;i<people.length;i++)for(let n=0;n<4;n++){
  people[i].localPcDevices.push({id:id(i*4+n+1),state:'active',tokenHash:digest(token),title:`ПК ${n}`,wrappedKey:'A'.repeat(60)});
}
const poll=n=>api.agent({...req('/api/pc-lab/agent/poll','POST'),headers:{authorization:`Local ${id(n)}:${token}`}},db,save);
for(let i=1;i<=MAX_DEVICES;i++)assert.equal(poll(i).status,200);
assert.equal(poll(MAX_DEVICES+1).status,409); // общий лимит, несмотря на корректное разрешение
const owner=(person,path,method='GET')=>api.owner(req(path,method),db,person,save);
const route=n=>`/api/pc-lab/devices/${id(n)}/revoke`;
assert.equal(owner(people[1],route(1),'POST').status,404);
assert.equal(owner(people[0],route(1),'POST').status,200);
assert.equal(poll(1).status,401);assert.equal(poll(MAX_DEVICES+1).status,200);
assert.equal(poll(2).status,200);assert.equal(poll(MAX_DEVICES).status,200);
assert.equal(poll(MAX_DEVICES+2).status,409);
assert.equal(owner(people[25],'/api/pc-lab/devices').status,503); // часть нельзя загрузить в реле
assert(saves>=1);
console.log('local-pc-many-users: общий лимит реле, изоляция владельцев и освобождение слота проверены на поддельной базе; ёмкость VPS не измерена');
