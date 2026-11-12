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
const {createAdminSession}=require('../../local-pc/admin-session');
const message=()=>new Promise(r=>process.once('message',r));
const tick=()=>new Promise(r=>setTimeout(r,10));
async function until(f){for(let n=0;n<200;n++){if(f())return;await tick();}throw Error('Окно не обновилось');}
try{
  const {base,admin,alice,bob,aliceId,untrusted}=await message();globalThis.location=new URL(base);
  const nativeFetch=globalThis.fetch;globalThis.fetch=(url,opts)=>nativeFetch(new URL(url,base),opts);
  const make=token=>createAccessHttp({getToken:()=>token,timeoutMs:3000});
  if(untrusted){await assert.rejects(make(alice).getStatus());process.send({step:'done'});process.disconnect();}
  else{
    const ah=make(alice),bh=make(bob),mh=make(admin);
    await assert.rejects(ah.listRequests());
    let pollsFinished=0,decisions=0,sessionToken=admin;
    const redirect=createAccessHttp({getToken:()=>alice,prefix:'/redirect',timeoutMs:1000});await assert.rejects(redirect.getStatus());
    const dom=new JSDOM('<!doctype html><body></body>'),doc=dom.window.document;
    const deps={getToken:()=>sessionToken,createMonitor:createAdminRequestMonitor,createIndicator:createAdminRequestIndicator,
      createAdminView:createAdminAccessView,disposeAdminView:disposeAdminAccessView,
      createAccessHttp:opts=>{const http=createAccessHttp({...opts,timeoutMs:3000});return {...http,
        listRequests:async s=>{try{return await http.listRequests(s);}finally{pollsFinished++;}},
        decide:async(...args)=>{decisions++;return http.decide(...args);}};}};
    const session=createAdminSession(doc,deps);
    const own=createAccessRequestView(doc,{...ah,onClose(){}});doc.body.append(own,session.root);
    assert.equal(pollsFinished,0);assert(session.start());await until(()=>session.root.textContent.includes('Ожидают решения по последней проверке: 0.'));
    session.root.querySelector('[data-action=open]').click();await until(()=>session.root.querySelector('[role=dialog]') && !own.querySelector('[data-action=request]').disabled && session.root.textContent.includes('Нет ожидающих заявок'));
    const manage=session.root.querySelector('[role=dialog]');assert.equal(session.root.querySelectorAll('[role=dialog]').length,1);
    own.querySelector('[data-action=request]').click();await until(()=>own.textContent.includes('Ожидаем решения'));
    assert(session.refresh());await until(()=>session.root.textContent.includes('Ожидают решения по последней проверке: 1.'));
    assert(session.refresh());await until(()=>pollsFinished===3);await tick();assert(session.root.textContent.includes('Ожидают решения по последней проверке: 1.'));
    manage.querySelector('[data-action=refresh]').click();await until(()=>manage.textContent.includes('Алиса') && !!manage.querySelector('[data-decision=approve]'));
    // Сервер принял первое решение, но намеренно оборвал ответ. Окно не
    // повторяет запрос и предлагает проверить список.
    manage.querySelector('[data-decision=approve]').click();await until(()=>manage.textContent.includes('Не удалось подтвердить состояние'));
    assert.equal(decisions,1);assert.equal(manage.querySelector('[data-decision]'),null);
    manage.querySelector('[data-action=refresh]').click();await until(()=>manage.querySelector('[aria-label="Разрешено"]').textContent.includes('Алиса'));
    assert(session.refresh());await until(()=>session.root.textContent.includes('Ожидают решения по последней проверке: 0.'));
    own.querySelector('[data-action=refresh]').click();await until(()=>own.textContent.includes('Администратор разрешил функцию'));
    const ownBob=createAccessRequestView(doc,{...bh,onClose(){}});doc.body.appendChild(ownBob);
    await until(()=>!ownBob.querySelector('[data-action=request]').disabled);ownBob.querySelector('[data-action=request]').click();await until(()=>ownBob.textContent.includes('Ожидаем решения'));
    manage.querySelector('[data-action=refresh]').click();await until(()=>manage.textContent.includes('Борис') && !!manage.querySelector('[data-decision=deny]'));
    manage.querySelector('[data-decision=deny]').click();await until(()=>manage.textContent.includes('Решение принято. Список обновлён.'));
    ownBob.querySelector('[data-action=refresh]').click();await until(()=>ownBob.textContent.includes('Администратор отклонил запрос'));
    assert.equal(decisions,2);
    // Смена учётной записи не передаёт новый токен старому окну.
    const oldClose=manage.querySelector('[data-action=close]');sessionToken=alice;assert(!session.checkSession());
    assert.equal(session.root.textContent,'');assert.equal(manage.textContent,'');assert(oldClose.disabled);oldClose.click();
    // Другой администратор отзывает роль при том же токене: проверяем
    // настоящий тестовый API, а не только имитацию ошибки в jsdom.
    async function setAdmin(value){
      const response=await nativeFetch(base+'/api/admin/users/'+encodeURIComponent(aliceId)+'/admin',{method:'POST',headers:{Authorization:'Bearer '+admin,'Content-Type':'application/json'},body:JSON.stringify({value})});
      assert.equal(response.status,200);
    }
    await setAdmin(true);
    const demoted=createAdminSession(doc,deps);doc.body.appendChild(demoted.root);assert(demoted.start());
    await until(()=>demoted.root.textContent.includes('последней проверке: 0.'));
    demoted.root.querySelector('[data-action=open]').click();await until(()=>demoted.root.textContent.includes('Алиса'));
    const stale=demoted.root.querySelector('[role=dialog]');await setAdmin(false);
    assert(demoted.refresh());await until(()=>demoted.root.children.length===0);
    assert.equal(stale.textContent,'');assert(!demoted.checkSession());
    const nonAdmin=createAdminSession(doc,deps);doc.body.appendChild(nonAdmin.root);assert(nonAdmin.start());
    // 403 от настоящего лабораторного API закрывает административную
    // сессию, не показывая устаревший список пользователю без роли.
    await until(()=>nonAdmin.root.children.length===0);assert(!nonAdmin.checkSession());
    assert(!nonAdmin.root.querySelector('[data-action=open]'));nonAdmin.dispose();
    disposeAccessRequestView(own);disposeAccessRequestView(ownBob);dom.window.close();
    process.send({step:'done'});process.disconnect();
  }
}catch(e){console.error(e);process.exitCode=1;process.disconnect();}
