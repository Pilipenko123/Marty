// Только jsdom и поддельные обработчики: реального уведомления и авторизации нет.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
import {createRequire} from 'node:module';
const {createAdminAccessView,disposeAdminAccessView}=createRequire(import.meta.url)('../local-pc/admin-access-view');
const dom=new JSDOM('<!doctype html><body></body>'),doc=dom.window.document;
const tick=()=>new Promise(r=>setTimeout(r,0));
async function until(f){for(let i=0;i<100;i++){if(f())return;await tick();}assert.fail('Не дождались окна');}
const record=(userId,name,id)=>({userId,name,requestId:id.repeat(32),requestedAt:1});
const a=record('alice','Алиса <img src=x onerror=alert(1)>','a'),b=record('bob','Боб\u202eобман','b'),c=record('carol','Алиса','c');
let data={requests:[a,b],approved:[c]},calls=[],closes=0,reads=0;
const view=createAdminAccessView(doc,{listRequests:async()=>{reads++;return data;},decide:async(item)=>{
  calls.push(item);data={requests:data.requests.filter(x=>x.userId!==item.userId),approved:item.decision==='approve'?[...data.approved,a]:data.approved};
  return {state:item.decision==='approve'?'approved':'denied'};
},onClose(){closes++;}});doc.body.appendChild(view);
assert.match(view.textContent,/Черновик/);assert.match(view.textContent,/не включает синхронизацию/);
await until(()=>view.querySelectorAll('[data-decision]').length===4);assert.equal(reads,1);
assert.equal(view.querySelector('img'),null);assert(view.textContent.includes('Алиса <img src=x onerror=alert(1)>'));assert(!view.textContent.includes('\u202e'));
assert(view.textContent.includes('ID: alice'));assert(view.textContent.includes('ID: carol'));
assert.equal(view.querySelectorAll('ul[aria-label="Разрешено"] [data-decision]').length,0); // нет незапрошенного отзыва
const staleButton=view.querySelector('[data-decision=approve]');view.querySelector('[data-action=refresh]').click();await until(()=>reads===2 && view.querySelector('[data-decision=approve]')!==staleButton);
staleButton.click();await tick();assert.equal(calls.length,0); // удалённая из DOM кнопка не запускает старое решение
const approve=view.querySelector('[data-decision=approve]');assert.match(approve.getAttribute('aria-label'),/alice/);
approve.click();approve.click();await until(()=>calls.length===1 && view.querySelectorAll('[data-decision]').length===2);
assert.deepEqual(calls[0],{userId:'alice',requestId:a.requestId,decision:'approve'});assert.equal(reads,3);
view.querySelector('[data-decision=deny]').click();await until(()=>calls.length===2 && view.textContent.includes('Нет ожидающих заявок'));
assert.deepEqual(calls[1],{userId:'bob',requestId:b.requestId,decision:'deny'});
view.querySelector('[data-action=close]').click();assert.equal(closes,1);assert([...view.querySelectorAll('button')].every(x=>x.disabled));
view.querySelector('[data-action=close]').click();assert.equal(closes,1);

// Потеря ответа или устаревший запрос — не повторять решение и скрыть старые
// кнопки. Ручное обновление обязательно до следующей попытки.
let attempts=0,refreshes=0,failDecision=true;
const uncertain=createAdminAccessView(doc,{listRequests:async()=>{refreshes++;return {requests:[b],approved:[]};},decide:async()=>{attempts++;if(failDecision)throw Error('неизвестно');return {state:'denied'};},onClose(){}});doc.body.appendChild(uncertain);
await until(()=>!!uncertain.querySelector('[data-decision=deny]'));uncertain.querySelector('[data-decision=deny]').click();await until(()=>uncertain.textContent.includes('Не удалось подтвердить состояние'));
assert.equal(attempts,1);assert.equal(uncertain.querySelector('[data-decision]'),null);assert.equal(refreshes,1);
failDecision=false;uncertain.querySelector('[data-action=refresh]').click();await until(()=>!!uncertain.querySelector('[data-decision=deny]'));assert.equal(refreshes,2);disposeAdminAccessView(uncertain);
// Ответ решения, не подтверждающий ожидаемое состояние, также не считается успехом.
const badResult=createAdminAccessView(doc,{listRequests:async()=>({requests:[a],approved:[]}),decide:async()=>({state:'pending'}),onClose(){}});doc.body.appendChild(badResult);
await until(()=>!!badResult.querySelector('[data-decision=approve]'));badResult.querySelector('[data-decision=approve]').click();await until(()=>badResult.textContent.includes('Не удалось подтвердить состояние'));
assert.equal(badResult.querySelector('[data-decision]'),null);disposeAdminAccessView(badResult);
// Ответ мог подтвердить решение, а повторный список — не загрузиться.
let lists=0;const failRefresh=createAdminAccessView(doc,{listRequests:async()=>{if(++lists>1)throw Error('обрыв');return {requests:[a],approved:[]};},decide:async()=>({state:'approved'}),onClose(){}});
doc.body.appendChild(failRefresh);await until(()=>!!failRefresh.querySelector('[data-decision]'));failRefresh.querySelector('[data-decision=approve]').click();await until(()=>failRefresh.textContent.includes('Не удалось подтвердить состояние'));
assert.equal(failRefresh.querySelector('[data-decision]'),null);disposeAdminAccessView(failRefresh);
// Дубликаты и некорректный список не должны оставлять кнопки решения.
for(const invalid of [{requests:[a,a],approved:[]},{requests:[a],approved:[{...a,userId:'other'}]}, {requests:[{...a,requestId:'x'}],approved:[]},
  {requests:[{...a,userId:'a\u202eb'}],approved:[]},{requests:[a],approved:null}]){
  const bad=createAdminAccessView(doc,{listRequests:async()=>invalid,decide(){throw Error('не должно вызываться');},onClose(){}});doc.body.appendChild(bad);
  await until(()=>bad.textContent.includes('Не удалось получить список'));assert.equal(bad.querySelector('[data-decision]'),null);disposeAdminAccessView(bad);bad.remove();
}
// Окно закрыто до разрешения списка — отменяем сигнал и поздний результат.
let lateSignal,releaseList,lateCalls=0;
const late=createAdminAccessView(doc,{listRequests:signal=>{lateSignal=signal;return new Promise(r=>{releaseList=r;});},decide(){lateCalls++;},onClose(){}});
doc.body.appendChild(late);await until(()=>!!releaseList);disposeAdminAccessView(late);assert(lateSignal.aborted);releaseList({requests:[a],approved:[]});await tick();assert.equal(late.querySelector('[data-decision]'),null);assert.equal(lateCalls,0);
// Окно закрыто во время решения: обработчик может продолжиться, но окно не
// открывает новую страницу, не повторяет решение и не обновляет список.
let releaseDecision,decisionSignal,lateReads=0,lateDecides=0;
const closing=createAdminAccessView(doc,{listRequests:async()=>{lateReads++;return {requests:[a],approved:[]};},decide:(_d,signal)=>{decisionSignal=signal;lateDecides++;return new Promise(r=>{releaseDecision=r;});},onClose(){}});
doc.body.appendChild(closing);await until(()=>!!closing.querySelector('[data-decision]'));closing.querySelector('[data-decision=approve]').click();
closing.querySelector('[data-action=close]').click();assert(decisionSignal.aborted);releaseDecision({state:'approved'});await tick();assert.equal(lateDecides,1);assert.equal(lateReads,1);assert([...closing.querySelectorAll('button')].every(x=>x.disabled));
// До первой микрозадачи закрытие не запускает внешний запрос.
let notCalled=0;const immediate=createAdminAccessView(doc,{listRequests(){notCalled++;},decide(){},onClose(){}});disposeAdminAccessView(immediate);await tick();assert.equal(notCalled,0);
assert.throws(()=>createAdminAccessView(doc,{}));
const css=fs.readFileSync(new URL('../local-pc/admin-access-view.css',import.meta.url),'utf8');assert.match(css,/position:\s*fixed/);assert.match(css,/@media/);
const sandbox=vm.createContext({AbortController});vm.runInContext(fs.readFileSync(new URL('../local-pc/admin-access-view.js',import.meta.url),'utf8'),sandbox);
const browser=sandbox.SegaLocalAdminAccessView.createAdminAccessView(doc,{listRequests:async()=>({requests:[],approved:[]}),decide(){},onClose(){}});
doc.body.appendChild(browser);await until(()=>browser.textContent.includes('Нет ожидающих заявок'));sandbox.SegaLocalAdminAccessView.disposeAdminAccessView(browser);
dom.window.close();
console.log('local-pc-admin-access-view: списки, решения, повторы, ошибки и закрытие проверены в jsdom; реального UI и уведомлений нет');
