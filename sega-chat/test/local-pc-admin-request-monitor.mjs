// Лабораторный индикатор: фальшивое время и заглушки, не Web Push и не VPS.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const code=fs.readFileSync(new URL('../local-pc/admin-request-monitor.js',import.meta.url),'utf8');
let sequence=0;const timers=new Map();
const ctx=vm.createContext({AbortController,setTimeout:(fn,ms)=>{const id=++sequence;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id)});
vm.runInContext(code,ctx);const {createAdminRequestMonitor,MAX_ITEMS}=ctx.SegaLocalAdminRequestMonitor;
const flush=()=>new Promise(r=>setImmediate(r));
const nextTimer=()=>{assert.equal(timers.size,1);const [id,t]=timers.entries().next().value;timers.delete(id);return t;};
const item=(user,n)=>({userId:user,requestId:n.repeat(32)});
let pending=[item('alice','a')],updates=[],calls=0;
const monitor=createAdminRequestMonitor({listRequests:async()=>{calls++;return {requests:pending};},onUpdate:s=>updates.push({...s})});
assert.throws(()=>createAdminRequestMonitor({listRequests(){},onUpdate(){},intervalMs:1}));assert.throws(()=>createAdminRequestMonitor({}));
assert.equal(monitor.refresh(),false);monitor.start();monitor.start();await flush();assert.equal(calls,1);
assert.deepEqual(updates,[{state:'ready',count:1,newlySeen:0}]);assert.equal(nextTimer().ms,60000);
// Ручное обновление с теми же заявками не выдаёт повторных уведомлений.
assert.equal(monitor.refresh(),true);await flush();assert.equal(calls,2);assert.equal(updates.length,1);assert.equal(nextTimer().ms,60000);
pending=[...pending,item('bob','b')];assert.equal(monitor.refresh(),true);await flush();assert.deepEqual(updates.at(-1),{state:'ready',count:2,newlySeen:1});assert.equal(nextTimer().ms,60000);
pending=[item('bob','b')];assert.equal(monitor.refresh(),true);await flush();assert.deepEqual(updates.at(-1),{state:'ready',count:1,newlySeen:0});assert.equal(nextTimer().ms,60000);
// Устаревшая заявка заменена новой даже при неизменном общем количестве.
pending=[item('alice','c')];assert.equal(monitor.refresh(),true);await flush();assert.deepEqual(updates.at(-1),{state:'ready',count:1,newlySeen:1});nextTimer();
monitor.stop();assert.equal(monitor.refresh(),false);

// Ошибка не превращается в «нет заявок», повторные ошибки не спамят, интервалы
// растут; при восстановлении выдаётся актуальное количество.
let attempt=0,states=[];
const broken=createAdminRequestMonitor({listRequests:async()=>{attempt++;if(attempt<=2)throw Error('offline');return {requests:[item('a','d')]};},onUpdate:s=>states.push({...s})});
broken.start();await flush();assert.deepEqual(states,[{state:'unavailable',count:null,newlySeen:0}]);
let timer=nextTimer();assert.equal(timer.ms,120000);timer.fn();await flush();assert.equal(states.length,1);timer=nextTimer();assert.equal(timer.ms,240000);timer.fn();await flush();
assert.deepEqual(states.at(-1),{state:'ready',count:1,newlySeen:0});assert.equal(nextTimer().ms,60000);broken.stop();
// Некорректные или повторяющиеся записи не выставляют счётчик.
for(const requests of [[item('a','a'),item('a','b')],[item('a','a'),item('b','a')],[{userId:'a',requestId:'wrong'}],Array(MAX_ITEMS+1).fill(item('a','a'))]){
  const reports=[];const m=createAdminRequestMonitor({listRequests:async()=>({requests}),onUpdate:v=>reports.push({...v})});m.start();await flush();
  assert.deepEqual(reports,[{state:'unavailable',count:null,newlySeen:0}]);m.stop();assert.equal(timers.size,0);
}
// Остановка не может отменить зависимость, игнорирующую AbortSignal. Повторный
// start не запускает параллельный опрос, поздний ответ не выдаёт событие.
let resolveOld,observed,started=0,maximum=0,simultaneous=0,events=[];
const slow=createAdminRequestMonitor({listRequests:signal=>{started++;simultaneous++;maximum=Math.max(maximum,simultaneous);observed=signal;
  return new Promise(r=>{resolveOld=v=>{simultaneous--;r(v);};});},onUpdate:v=>events.push({...v})});
slow.start();await flush();assert.equal(started,1);assert.equal(slow.refresh(),false);slow.stop();assert(observed.aborted);slow.start();await flush();assert.equal(started,1);
resolveOld({requests:[item('z','e')]});await flush();assert.equal(events.length,0);timer=nextTimer();assert.equal(timer.ms,0);timer.fn();await flush();assert.equal(started,2);assert.equal(maximum,1);
resolveOld({requests:[]});await flush();assert.deepEqual(events,[{state:'ready',count:0,newlySeen:0}]);slow.stop();assert.equal(timers.size,0);
// Если остановить до микрозадачи, внешний обработчик не вызывается.
let never=0;const immediate=createAdminRequestMonitor({listRequests(){never++;},onUpdate(){}});immediate.start();immediate.stop();await flush();assert.equal(never,0);
console.log('local-pc-admin-request-monitor: индикатор, дедупликация, отмена и ошибки проверены в VM; push и рабочие уведомления отсутствуют');
