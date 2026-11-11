// Используется только тестом: имитированные окна jsdom и локальный HTTPS.
// Сертификат тестовый; пользовательские токены передаются лишь по IPC.
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createAccessHttp}=require('../../local-pc/access-http');
const {createAccessRequestView,disposeAccessRequestView}=require('../../local-pc/access-request-view');
const {createAdminAccessView,disposeAdminAccessView}=require('../../local-pc/admin-access-view');
const {createAdminRequestMonitor}=require('../../local-pc/admin-request-monitor');
const {createAdminRequestIndicator}=require('../../local-pc/admin-request-indicator');
const message=()=>new Promise(r=>process.once('message',r));
const tick=()=>new Promise(r=>setTimeout(r,10));
async function until(f){for(let n=0;n<200;n++){if(f())return;await tick();}throw Error('Окно не обновилось');}
try{
  const {base,admin,alice,bob,untrusted}=await message();globalThis.location=new URL(base);
  const nativeFetch=globalThis.fetch;globalThis.fetch=(url,opts)=>nativeFetch(new URL(url,base),opts);
  const make=token=>createAccessHttp({getToken:()=>token,timeoutMs:3000});
  if(untrusted){await assert.rejects(make(alice).getStatus());process.send({step:'done'});process.disconnect();}
  else{
    const ah=make(alice),bh=make(bob),mh=make(admin);
    await assert.rejects(ah.listRequests());
    let pollsFinished=0,decisions=0,manage,openCount=0;
    const redirect=createAccessHttp({getToken:()=>alice,prefix:'/redirect',timeoutMs:1000});await assert.rejects(redirect.getStatus());
    const dom=new JSDOM('<!doctype html><body></body>'),doc=dom.window.document;
    const nonAdmin=createAdminRequestIndicator(doc,{createMonitor:createAdminRequestMonitor,listRequests:ah.listRequests,onOpen(){}});
    nonAdmin.start();await until(()=>nonAdmin.root.textContent.includes('Количество неизвестно'));nonAdmin.dispose();
    const indicator=createAdminRequestIndicator(doc,{createMonitor:createAdminRequestMonitor,
      listRequests:async s=>{try{return await mh.listRequests(s);}finally{pollsFinished++;}},
      onOpen:()=>{openCount++;manage=createAdminAccessView(doc,{...mh,decide:async(...args)=>{decisions++;return mh.decide(...args);},onClose(){}});doc.body.appendChild(manage);}});
    const own=createAccessRequestView(doc,{...ah,onClose(){}});doc.body.append(own,indicator.root);
    assert.equal(pollsFinished,0);indicator.start();await until(()=>indicator.root.textContent.includes('Ожидают решения по последней проверке: 0.'));
    indicator.root.querySelector('[data-action=open]').click();await until(()=>manage && !own.querySelector('[data-action=request]').disabled && manage.textContent.includes('Нет ожидающих заявок'));
    assert.equal(openCount,1);
    own.querySelector('[data-action=request]').click();await until(()=>own.textContent.includes('Ожидаем решения'));
    assert(indicator.refresh());await until(()=>indicator.root.textContent.includes('Ожидают решения по последней проверке: 1.'));
    assert(indicator.refresh());await until(()=>pollsFinished===3);await tick();assert(indicator.root.textContent.includes('Ожидают решения по последней проверке: 1.'));
    manage.querySelector('[data-action=refresh]').click();await until(()=>manage.textContent.includes('Алиса') && !!manage.querySelector('[data-decision=approve]'));
    // Сервер принял первое решение, но намеренно оборвал ответ. Окно не
    // повторяет запрос и предлагает проверить список.
    manage.querySelector('[data-decision=approve]').click();await until(()=>manage.textContent.includes('Не удалось подтвердить состояние'));
    assert.equal(decisions,1);assert.equal(manage.querySelector('[data-decision]'),null);
    manage.querySelector('[data-action=refresh]').click();await until(()=>manage.querySelector('[aria-label="Разрешено"]').textContent.includes('Алиса'));
    assert(indicator.refresh());await until(()=>indicator.root.textContent.includes('Ожидают решения по последней проверке: 0.'));
    own.querySelector('[data-action=refresh]').click();await until(()=>own.textContent.includes('Администратор разрешил функцию'));
    const ownBob=createAccessRequestView(doc,{...bh,onClose(){}});doc.body.appendChild(ownBob);
    await until(()=>!ownBob.querySelector('[data-action=request]').disabled);ownBob.querySelector('[data-action=request]').click();await until(()=>ownBob.textContent.includes('Ожидаем решения'));
    manage.querySelector('[data-action=refresh]').click();await until(()=>manage.textContent.includes('Борис') && !!manage.querySelector('[data-decision=deny]'));
    manage.querySelector('[data-decision=deny]').click();await until(()=>manage.textContent.includes('Решение принято. Список обновлён.'));
    ownBob.querySelector('[data-action=refresh]').click();await until(()=>ownBob.textContent.includes('Администратор отклонил запрос'));
    assert.equal(decisions,2);indicator.dispose();disposeAccessRequestView(own);disposeAccessRequestView(ownBob);disposeAdminAccessView(manage);dom.window.close();
    process.send({step:'done'});process.disconnect();
  }
}catch(e){console.error(e);process.exitCode=1;process.disconnect();}
