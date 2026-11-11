// Лабораторный API на фиктивной базе, без реальной папки или уведомлений.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {createExperimentalApi}=createRequire(import.meta.url)('../local-pc/experimental-api');
const {digest}=createRequire(import.meta.url)('../local-pc/relay');
const api=createExperimentalApi(),admin={id:'admin',name:'Админ',isAdmin:true},alice={id:'alice',name:'Алиса'},bob={id:'bob',name:'Боб'},db={users:[admin,alice,bob]};
let saves=0;const save=()=>{saves++};
const req=(path,method='GET',body={})=>({path,method,body,query:new URLSearchParams(),headers:{},ip:'test'});
const act=(who,path,method='GET',body={})=>api.owner(req(path,method,body),db,who,save);
const status=who=>act(who,'/api/pc-lab/access');
const request=who=>act(who,'/api/pc-lab/access/request','POST');
const adminList=who=>act(who,'/api/pc-lab/access/admin');
const decide=(who,userId,requestId,decision)=>act(who,'/api/pc-lab/access/decision','POST',{userId,requestId,decision});
const devices='/api/pc-lab/devices',devId='a'.repeat(32),token='b'.repeat(64);
const registration={id:devId,tokenHash:digest(token),wrappedKey:'A'.repeat(60),title:'ПК'};
assert.equal(status(alice).json.state,'none');assert.equal(act(alice,devices,'POST',registration).status,403);
assert.equal(adminList(alice).status,403);assert.equal(decide(alice,'alice','a'.repeat(32),'approve').status,403);
// Даже администратор должен запросить разрешение на свою учётную запись.
assert.equal(act(admin,devices).status,403);assert.equal(request(alice).json.state,'pending');const first=alice.localPcAccess.id;
assert.equal(request(alice).json.state,'pending');assert.equal(alice.localPcAccess.id,first);
assert.equal(act(alice,devices).status,403);assert.equal(decide(bob,'alice',first,'approve').status,403);
assert.deepEqual(adminList(admin).json.requests.map(x=>x.userId),['alice']);assert.equal(decide(admin,'alice',first,'deny').json.state,'denied');
assert.equal(status(alice).json.state,'denied');assert.equal(act(alice,devices).status,403);
assert.equal(request(alice).json.state,'pending');const second=alice.localPcAccess.id;assert.notEqual(second,first);
assert.equal(decide(admin,'alice',first,'approve').status,409);assert.equal(status(alice).json.state,'pending');
assert.equal(decide(admin,'bob',second,'approve').status,409);assert.equal(decide(admin,'alice',second,'approve').json.state,'approved');
assert.equal(decide(admin,'alice',second,'deny').status,409);assert.equal(request(alice).json.state,'approved');
assert.deepEqual(adminList(admin).json.requests,[]);assert.deepEqual(adminList(admin).json.approved.map(x=>x.userId),['alice']);
assert.equal(act(alice,devices,'POST',registration).status,200);
const agent=(path,body={})=>api.agent({...req(path,'POST',body),headers:{authorization:`Local ${devId}:${token}`}},db,save);
assert.equal(agent('/api/pc-lab/agent/claim',{tokenHash:digest('c'.repeat(64))}).status,200);
assert.equal(agent('/api/pc-lab/agent/poll').status,401); // после claim первоначальный токен больше не действует
const token2='c'.repeat(64),agent2=()=>api.agent({...req('/api/pc-lab/agent/poll','POST'),headers:{authorization:`Local ${devId}:${token2}`}},db,save);
assert.equal(agent2().status,200);
assert.equal(decide(bob,'alice',second,'revoke').status,403);assert.equal(agent2().status,200);
assert.equal(decide(admin,'alice',second,'revoke').json.state,'revoked');
assert.equal(agent2().status,401);assert.equal(act(alice,devices).status,403);assert.deepEqual(alice.localPcDevices,[{id:devId,state:'revoked'}]);
assert.equal(decide(admin,'alice',second,'revoke').status,409);
assert.equal(request(alice).json.state,'pending');const third=alice.localPcAccess.id;
assert.equal(decide(admin,'alice',second,'approve').status,409);assert.equal(decide(admin,'alice',third,'approve').status,200);
assert.equal(agent2().status,401);assert.equal(act(alice,devices,'POST',registration).status,409);
// Повреждённая запись не выдаёт право и не перезаписывается автоматически.
bob.localPcAccess={state:'approved'};assert.equal(status(bob).status,503);assert.equal(act(bob,devices).status,403);assert.equal(request(bob).status,503);
assert(!JSON.stringify(adminList(admin).json).includes(token2));assert(saves>=6);
console.log('local-pc-access-approval: запрос, отказ, новое рассмотрение и отзыв проверены только в лабораторной модели');
