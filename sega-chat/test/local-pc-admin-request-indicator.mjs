// jsdom и локальные заглушки, не настоящий интерфейс, push или Windows.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createAdminRequestIndicator}=require('../local-pc/admin-request-indicator');
const {createAdminRequestMonitor}=require('../local-pc/admin-request-monitor');
const dom=new JSDOM('<!doctype html><body></body>'),doc=dom.window.document;
const tick=()=>new Promise(r=>setTimeout(r,0));
async function until(f){for(let i=0;i<100;i++){if(f())return;await tick();}assert.fail('Индикатор не обновился');}
const item=(user,id)=>({userId:user,requestId:id.repeat(32)});
let requests=[],fail=false,reads=0,opens=0,signal,releaseOpen;
const indicator=createAdminRequestIndicator(doc,{createMonitor:createAdminRequestMonitor,listRequests:async()=>{reads++;if(fail)throw Error('secret');return {requests};},onOpen:s=>{opens++;signal=s;return new Promise(r=>{releaseOpen=r;});}});
const root=indicator.root;doc.body.append(root);
const open=root.querySelector('[data-action=open]'),refresh=root.querySelector('[data-action=refresh]');
assert.equal(root.querySelector('[role=status]').getAttribute('aria-live'),'polite');assert.match(root.textContent,/Наблюдение остановлено/);
assert(open.disabled && refresh.disabled);assert.equal(reads,0);assert.equal(indicator.refresh(),false);
indicator.start();indicator.start();await until(()=>root.textContent.includes('Ожидают решения по последней проверке: 0.'));assert.equal(reads,1);
requests=[item('alice','a')];refresh.click();await until(()=>root.textContent.includes('Ожидают решения по последней проверке: 1.'));
open.click();open.click();await until(()=>opens===1);assert(open.disabled);releaseOpen();await until(()=>!open.disabled);
fail=true;refresh.click();await until(()=>root.textContent.includes('Количество неизвестно'));assert(!root.textContent.includes('Ожидают решения по последней проверке: 0'));assert(!root.textContent.includes('secret'));assert(!open.disabled);
fail=false;requests=[];refresh.click();await until(()=>root.textContent.includes('Ожидают решения по последней проверке: 0.'));
open.click();await until(()=>opens===2);indicator.stop();assert(signal.aborted);assert(open.disabled && refresh.disabled);assert(!root.textContent.includes('Ожидают решения по последней проверке: 0'));
// Позднее завершение старого открытия не меняет новый сеанс.
indicator.start();await until(()=>root.textContent.includes('Ожидают решения по последней проверке: 0.'));releaseOpen();await tick();assert(!open.disabled);
indicator.dispose();indicator.dispose();indicator.start();assert(open.disabled && refresh.disabled);assert.equal(indicator.refresh(),false);
// Не вызываем внешний обработчик, если остановились до микрозадачи.
let called=0;const immediate=createAdminRequestIndicator(doc,{createMonitor:createAdminRequestMonitor,listRequests:async()=>({requests:[]}),onOpen(){called++;}});
immediate.start();immediate.root.querySelector('[data-action=open]').click();immediate.stop();await tick();assert.equal(called,0);immediate.dispose();
// Поздний ответ опроса после смены сессии не восстанавливает старый счётчик.
let releaseRead,readSignal;const delayed=createAdminRequestIndicator(doc,{createMonitor:createAdminRequestMonitor,listRequests:s=>{readSignal=s;return new Promise(r=>{releaseRead=r;});},onOpen(){}});
delayed.start();await until(()=>!!releaseRead);delayed.stop();assert(readSignal.aborted);releaseRead({requests:[item('old','b')]});await tick();assert.match(delayed.root.textContent,/Наблюдение остановлено/);assert(!delayed.root.textContent.includes('Ожидают решения по последней проверке: 1'));delayed.dispose();
// Ошибка открытия не выдаёт текст исключения и допускает новую попытку.
const broken=createAdminRequestIndicator(doc,{createMonitor:createAdminRequestMonitor,listRequests:async()=>({requests:[]}),onOpen(){throw Error('secret');}});
broken.start();broken.root.querySelector('[data-action=open]').click();await until(()=>broken.root.textContent.includes('Не удалось открыть список'));assert(!broken.root.textContent.includes('secret'));assert(!broken.root.querySelector('[data-action=open]').disabled);broken.dispose();
assert.throws(()=>createAdminRequestIndicator(doc,{}));assert.throws(()=>createAdminRequestIndicator(doc,{createMonitor:()=>({}),listRequests(){},onOpen(){}}));
const css=fs.readFileSync(new URL('../local-pc/admin-request-indicator.css',import.meta.url),'utf8');assert.match(css,/:focus-visible/);assert.match(css,/min-height:\s*44px/);
const ctx=vm.createContext({AbortController});vm.runInContext(fs.readFileSync(new URL('../local-pc/admin-request-indicator.js',import.meta.url),'utf8'),ctx);
const browser=ctx.SegaLocalAdminRequestIndicator.createAdminRequestIndicator(doc,{createMonitor:createAdminRequestMonitor,listRequests:async()=>({requests:[]}),onOpen(){}});browser.start();await until(()=>browser.root.textContent.includes('Ожидают решения по последней проверке: 0.'));browser.dispose();
dom.window.close();console.log('local-pc-admin-request-indicator: счётчик, ошибки, открытие и остановка проверены в jsdom; рабочего UI и push нет');
