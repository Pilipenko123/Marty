// Сквозная проверка двух неподключённых окон и лабораторного API в памяти.
// Это не рабочие уведомления, настоящие роли пользователя или Windows.
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createAccessRequestView,disposeAccessRequestView}=require('../local-pc/access-request-view');
const {createAdminAccessView,disposeAdminAccessView}=require('../local-pc/admin-access-view');
const {createExperimentalApi}=require('../local-pc/experimental-api');
const alice={id:'alice',name:'Алиса'},admin={id:'admin',name:'Админ',isAdmin:true},db={users:[alice,admin]};
const lab=createExperimentalApi(),save=()=>{};
function call(me,path,method='GET',body={}){
  const r=lab.owner({path,method,body,headers:{},query:new URLSearchParams(),ip:'test'},db,me,save);
  if(r.status!==200)throw Error('API '+r.status);
  return r.json;
}
const dom=new JSDOM('<!doctype html><body></body>'),doc=dom.window.document;
const tick=()=>new Promise(r=>setTimeout(r,0));
async function until(f){for(let i=0;i<100;i++){if(f())return;await tick();}assert.fail('Не дождались обновления');}
const own=createAccessRequestView(doc,{getStatus:async()=>call(alice,'/api/pc-lab/access'),requestAccess:async()=>call(alice,'/api/pc-lab/access/request','POST'),onClose(){}});
const manager=createAdminAccessView(doc,{listRequests:async()=>call(admin,'/api/pc-lab/access/admin'),decide:async body=>call(admin,'/api/pc-lab/access/decision','POST',body),onClose(){}});
doc.body.append(own,manager);await until(()=>!own.querySelector('[data-action=request]').disabled && manager.textContent.includes('Нет ожидающих заявок'));
assert.throws(()=>call(alice,'/api/pc-lab/access/admin'));
own.querySelector('[data-action=request]').click();await until(()=>own.textContent.includes('Ожидаем решения'));
manager.querySelector('[data-action=refresh]').click();await until(()=>!!manager.querySelector('[data-decision=approve]'));
const stale=alice.localPcAccess.id;
// Другой процесс уже отклонил запрос, а пользователь отправил новый. Старое
// окно не может одобрить новую заявку по старому номеру.
assert.equal(call(admin,'/api/pc-lab/access/decision','POST',{userId:'alice',requestId:stale,decision:'deny'}).state,'denied');
assert.equal(call(alice,'/api/pc-lab/access/request','POST').state,'pending');assert.notEqual(alice.localPcAccess.id,stale);
manager.querySelector('[data-decision=approve]').click();await until(()=>manager.textContent.includes('Не удалось подтвердить состояние'));
assert.equal(alice.localPcAccess.state,'pending');assert.equal(manager.querySelector('[data-decision]'),null);
manager.querySelector('[data-action=refresh]').click();await until(()=>!!manager.querySelector('[data-decision=approve]'));
manager.querySelector('[data-decision=approve]').click();await until(()=>manager.textContent.includes('Решение принято. Список обновлён.'));
assert.equal(alice.localPcAccess.state,'approved');assert(manager.querySelector('[aria-label="Разрешено"]').textContent.includes('Алиса'));
own.querySelector('[data-action=refresh]').click();await until(()=>own.textContent.includes('Администратор разрешил функцию'));
assert(own.textContent.includes('Подключение пока не готово'));assert(own.querySelector('[data-action=request]').disabled);
disposeAccessRequestView(own);disposeAdminAccessView(manager);dom.window.close();
console.log('local-pc-access-views-flow: запрос, устаревшее решение и одобрение испытаны с лабораторным API в памяти; реальных уведомлений нет');
