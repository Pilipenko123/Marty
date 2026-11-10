import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {createAgentRunner}=createRequire(import.meta.url)('../local-pc/agent-runner.js');
let count=0, statuses=[];
const runner=createAgentRunner({idleMs:3,maxRetryMs:12,onStatus:s=>statuses.push(s),coordinator:{async tick(signal){
  assert(signal instanceof AbortSignal);count++;
  if(count===1)throw new Error('offline');
  return false;
}}});
const done=runner.start();
assert.throws(()=>runner.start());
await new Promise(r=>setTimeout(r,30));
await runner.stop();await done;
assert(statuses.includes('offline'));assert(statuses.includes('online'));assert.equal(statuses.at(-1),'stopped');
const stoppedAt=count;await new Promise(r=>setTimeout(r,15));assert.equal(count,stoppedAt);
const next=[];
const revoked=createAgentRunner({idleMs:2,maxRetryMs:4,onStatus:s=>next.push(s),coordinator:{async tick(){const e=new Error();e.status=401;throw e}}});
await revoked.start();assert.deepEqual(next,['connecting','revoked','stopped']);
const changed=[];
await createAgentRunner({idleMs:2,maxRetryMs:4,onStatus:s=>changed.push(s),coordinator:{async tick(){const e=new Error();e.code='LOCAL_FOLDER_CHANGED';throw e}}}).start();
assert.deepEqual(changed,['connecting','folder-changed','stopped']);
// Синхронная ошибка не должна оставлять цикл в состоянии «запущен».
const sync=createAgentRunner({idleMs:2,maxRetryMs:4,coordinator:{tick(){const e=new Error();e.status=401;throw e}}});
await sync.start(); await sync.start();
let aborted=false;
const cancellable=createAgentRunner({idleMs:2,maxRetryMs:4,coordinator:{tick(signal){return new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>{aborted=true;reject(new Error('aborted'))},{once:true})})}}});
const waiting=cancellable.start();await Promise.resolve();await cancellable.stop();await waiting;assert(aborted);
let neverStarted=0;const immediate=createAgentRunner({idleMs:2,maxRetryMs:4,coordinator:{async tick(){neverStarted++}}});const run=immediate.start();await immediate.stop();await run;assert.equal(neverStarted,0);
// Неверный ответ не считается успешно завершённым опросом и не даёт online.
let offlineNotice;const offlineWait=new Promise(r=>{offlineNotice=r}), invalidStatuses=[];
const invalid=createAgentRunner({idleMs:3,maxRetryMs:6,onStatus:s=>{invalidStatuses.push(s);if(s==='offline')offlineNotice()},coordinator:{async tick(){return undefined}}});
const invalidRun=invalid.start();await offlineWait;await invalid.stop();await invalidRun;
assert.deepEqual(invalidStatuses,['connecting','offline','stopped']);
for(const maxRetryMs of [2147483648,Infinity,NaN]) assert.throws(()=>createAgentRunner({idleMs:1,maxRetryMs,coordinator:{tick(){}}}),/настройки/);
// Если зависимость игнорирует остановку, новый цикл нельзя запускать до её
// завершения. Поздний ответ не должен показывать успешное соединение.
let entered,release, ticks=0;const enteredPromise=new Promise(r=>{entered=r});
const statusesSlow=[];
const slow=createAgentRunner({idleMs:2,maxRetryMs:4,onStatus:s=>statusesSlow.push(s),coordinator:{tick(){ticks++;entered();return new Promise(r=>{release=r})}}});
const slowRun=slow.start();await enteredPromise;
let stopFinished=false;const stopping=slow.stop().then(()=>{stopFinished=true});
await Promise.resolve();assert.equal(stopFinished,false);assert.throws(()=>slow.start(),/уже работает/);
release(true);await stopping;await slowRun;assert.deepEqual(statusesSlow,['connecting','stopped']);assert.equal(ticks,1);
const newRun=slow.start();await slow.stop();await newRun;assert.equal(ticks,1);
console.log('local-pc-runner: восстановление связи, остановка и отзыв проверены без автозапуска');
