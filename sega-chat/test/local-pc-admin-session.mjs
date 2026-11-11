// Изолированный jsdom и поддельный сервер. Реальная сессия, браузер и push не проверены.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createAdminSession}=require('../local-pc/admin-session');
const {createAdminRequestIndicator}=require('../local-pc/admin-request-indicator');
const {createAdminRequestMonitor}=require('../local-pc/admin-request-monitor');
const {createAdminAccessView,disposeAdminAccessView}=require('../local-pc/admin-access-view');
const dom=new JSDOM('<!doctype html><body></body>'),doc=dom.window.document;
const tick=()=>new Promise(r=>setTimeout(r,0));
async function until(f){for(let i=0;i<100;i++){if(f())return;await tick();}assert.fail('Сессия не обновилась');}
const A='a'.repeat(48),B='b'.repeat(48),entry={userId:'alice',name:'Алиса',requestId:'c'.repeat(32),requestedAt:1};
let token=A,reads=0,decisions=0,releaseDecision,decisionSignal;
const deps={getToken:()=>token,createMonitor:createAdminRequestMonitor,createIndicator:createAdminRequestIndicator,createAdminView:createAdminAccessView,disposeAdminView:disposeAdminAccessView,
  createAccessHttp:({getToken})=>({listRequests:async()=>{assert.equal(getToken(),A);reads++;return {requests:[entry],approved:[]};},decide:(_v,s)=>{assert.equal(getToken(),A);decisions++;decisionSignal=s;return new Promise(r=>{releaseDecision=r;});}})};
const session=createAdminSession(doc,deps);doc.body.append(session.root);
assert.equal(reads,0);assert.equal(session.start(),true);assert.equal(session.start(),false);
await until(()=>session.root.textContent.includes('Ожидают решения по последней проверке: 1.'));
const open=session.root.querySelector('[data-action=open]');open.click();await until(()=>!!session.root.querySelector('[data-decision=approve]'));
let dialog=session.root.querySelector('[role=dialog]');assert(dialog.textContent.includes('Алиса'));
open.click();await tick();assert.equal(session.root.querySelectorAll('[role=dialog]').length,1);
const oldDialog=dialog;dialog.querySelector('[data-action=close]').click();await until(()=>!session.root.querySelector('[role=dialog]'));assert.equal(oldDialog.textContent,'');
open.click();await until(()=>!!session.root.querySelector('[data-decision=approve]'));dialog=session.root.querySelector('[role=dialog]');
const approve=dialog.querySelector('[data-decision=approve]');approve.click();await until(()=>!!releaseDecision);assert.equal(decisions,1);
// Выход должен немедленно очистить DOM и сигнализировать об отмене. Сервер
// может уже принять решение: позднее завершение не считается откатом.
session.dispose();assert(decisionSignal.aborted);assert.equal(session.root.textContent,'');assert.equal(dialog.textContent,'');assert(approve.disabled);assert(!session.checkSession());assert(!session.refresh());
releaseDecision({state:'approved'});await tick();approve.click();open.click();await tick();assert.equal(decisions,1);assert.equal(session.root.children.length,0);assert(!session.start());
// Смена токена выявляется явным checkSession: старое окно не остаётся видимым.
const swapped=createAdminSession(doc,{...deps,createAccessHttp:()=>({listRequests:async()=>({requests:[entry],approved:[]}),decide:async()=>({state:'approved'})})});
assert(swapped.start());swapped.root.querySelector('[data-action=open]').click();await until(()=>swapped.root.textContent.includes('Алиса'));token=B;assert(!swapped.checkSession());assert.equal(swapped.root.textContent,'');assert(!swapped.start());
// Даже без checkSession попытка принять решение после смены токена должна
// закрыть старый интерфейс, не отправляя решение от нового пользователя.
token=A;let sent=0;const guarded=createAdminSession(doc,{...deps,createAccessHttp:()=>({listRequests:async()=>({requests:[entry],approved:[]}),decide:async()=>{sent++;return {state:'approved'};}})});
assert(guarded.start());guarded.root.querySelector('[data-action=open]').click();await until(()=>!!guarded.root.querySelector('[data-decision=approve]'));token=B;
guarded.root.querySelector('[data-decision=approve]').click();await until(()=>guarded.root.children.length===0);assert.equal(sent,0);
// Поздний ответ, не поддерживающий abort, после выхода не выводит данные.
token=A;let resolveList,readSignal;
const delayed=createAdminSession(doc,{...deps,createAccessHttp:()=>({listRequests:s=>{readSignal=s;return new Promise(r=>{resolveList=r;});},decide(){throw Error('не вызывать');}})});
assert(delayed.start());await until(()=>!!resolveList);token=B;delayed.dispose();assert(readSignal.aborted);resolveList({requests:[entry],approved:[]});await tick();assert.equal(delayed.root.textContent,'');
// Смена токена между запросом и ответом также закрывает старую сессию, даже
// если хост забыл вызвать checkSession, когда результат вернулся.
token=A;let resolveAgain;const midflight=createAdminSession(doc,{...deps,createAccessHttp:()=>({listRequests:()=>new Promise(r=>{resolveAgain=r;}),decide(){}})});
assert(midflight.start());await until(()=>!!resolveAgain);token=B;resolveAgain({requests:[entry],approved:[]});await until(()=>midflight.root.children.length===0);assert(!midflight.checkSession());
// Самовольный повтор с другой сессией запрещён; новый объект нужно создавать.
const bad=createAdminSession(doc,{...deps,getToken:()=>null});assert(!bad.start());assert(!bad.start());assert.equal(bad.root.children.length,0);
const throws=createAdminSession(doc,{...deps,getToken:()=>{throw Error('секрет');}});assert(!throws.start());assert.equal(throws.root.children.length,0);
assert.throws(()=>createAdminSession(doc,{}));
const ctx=vm.createContext({});vm.runInContext(fs.readFileSync(new URL('../local-pc/admin-session.js',import.meta.url),'utf8'),ctx);
token=A;const browser=ctx.SegaLocalAdminSession.createAdminSession(doc,{...deps,createAccessHttp:()=>({listRequests:async()=>({requests:[],approved:[]}),decide(){}})});
assert(browser.start());await until(()=>browser.root.textContent.includes('Ожидают решения по последней проверке: 0.'));browser.dispose();
dom.window.close();console.log('local-pc-admin-session: выход, смена токена, отмена и поздние ответы проверены в jsdom; реальной интеграции нет');
