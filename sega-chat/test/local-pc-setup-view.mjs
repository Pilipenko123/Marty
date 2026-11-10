// Окно не подключено к мессенджеру; тест проверяет только инструкции и согласие.
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createRequire} from 'node:module';
const {createSetupView,disposeSetupView}=createRequire(import.meta.url)('../local-pc/setup-view.js');
const dom=new JSDOM('<!doctype html><body></body>');
let created=0, downloaded=0, closed=0, answer=false, question='';
const root=createSetupView(dom.window.document,{
  onCreateCode:()=>{created++}, onDownload:()=>{downloaded++}, onClose:()=>{closed++},
  confirmDownload:q=>{question=q; return answer}
});
dom.window.document.body.appendChild(root);
assert.match(root.textContent,/черновик инструкции/);
assert.match(root.textContent,/ещё не готовы/);
assert.match(root.textContent,/только с вашего разрешения/);
assert.match(root.textContent,/попадать в корзину/);
assert.match(root.textContent,/разные версии файлов — сохраняться/);
assert.match(root.textContent,/Windows 10/);
assert.match(root.textContent,/когда компьютер включён и подключён к интернету/);
assert.match(root.textContent,/код даёт доступ к папке/);
assert.match(root.textContent,/нужно включить отдельно/);
assert.equal(downloaded,0); assert.equal(created,0);
const [create,download,close]=root.querySelectorAll('button');
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
create.click(); await tick(); assert.equal(created,1); assert.equal(downloaded,0);
download.click(); await tick(); assert.equal(question,'Скачать файл на устройство?'); assert.equal(downloaded,0);
answer=true; download.click(); await tick(); assert.equal(downloaded,1);
close.click(); await tick(); assert.equal(closed,1);
assert([...root.querySelectorAll('button')].every(b=>b.disabled));
close.click(); download.click(); await tick(); assert.equal(closed,1);assert.equal(downloaded,1);

// Только буквальное «да», а не непустая строка или произвольный объект.
for(const value of [false,undefined,null,1,'да',{}]) {
  let count=0;
  const view=createSetupView(dom.window.document,{onCreateCode(){},onDownload(){count++},onClose(){},confirmDownload(){return value}});
  dom.window.document.body.appendChild(view);
  view.querySelectorAll('button')[1].click();await tick();assert.equal(count,0);
  disposeSetupView(view);view.remove();
}
// Два нажатия не создают двух подтверждений или загрузок.
let resolvePrompt, prompts=0, downloads=0, closes=0, createdAgain=0;
const options={onCreateCode(){createdAgain++},onDownload(){downloads++},onClose(){closes++},
  confirmDownload(){prompts++;return new Promise(resolve=>{resolvePrompt=resolve})}};
const pending=createSetupView(dom.window.document,options);dom.window.document.body.appendChild(pending);
const [pc,pd,px]=pending.querySelectorAll('button');
pd.click();pd.click();assert.equal(prompts,1);resolvePrompt(true);await tick();assert.equal(downloads,1);
// Закрытие побеждает ещё не завершённое подтверждение, даже если оно затем «да».
pd.click();assert.equal(prompts,2);px.click();assert.equal(closes,1);resolvePrompt(true);await tick();
assert.equal(downloads,1);assert([...pending.querySelectorAll('button')].every(b=>b.disabled));
pc.click();await tick();assert.equal(createdAgain,0);
// Внешний контейнер должен явно уничтожить состояние перед удалением окна.
const external=createSetupView(dom.window.document,options);dom.window.document.body.appendChild(external);
external.querySelectorAll('button')[1].click();assert.equal(prompts,3);
disposeSetupView(external);disposeSetupView(external);external.remove();resolvePrompt(true);await tick();assert.equal(downloads,1);
// Ошибка подтверждения не запускает скачивание и позволяет попробовать снова.
let errors=0;
const broken=createSetupView(dom.window.document,{...options,confirmDownload(){throw new Error('ошибка')},onError(){errors++}});
dom.window.document.body.appendChild(broken);const brokenDownload=broken.querySelectorAll('button')[1];
brokenDownload.click();await tick();assert.equal(errors,1);assert.equal(downloads,1);assert.equal(brokenDownload.disabled,false);
brokenDownload.click();await tick();assert.equal(errors,2);
disposeSetupView(broken);
// Запоздавшая ошибка закрытого окна не показывается в следующем окне.
let rejectPrompt,lateErrors=0;
const late=createSetupView(dom.window.document,{...options,confirmDownload(){return new Promise((_,reject)=>{rejectPrompt=reject})},onError(){lateErrors++}});
dom.window.document.body.appendChild(late);late.querySelectorAll('button')[1].click();
late.querySelectorAll('button')[2].click();rejectPrompt(new Error('поздно'));await tick();assert.equal(lateErrors,0);
// Ошибку самого закрытия сообщаем, но окно не оживляем.
const badClose=createSetupView(dom.window.document,{...options,onClose(){throw new Error('закрытие')},onError(){lateErrors++}});
dom.window.document.body.appendChild(badClose);badClose.querySelectorAll('button')[2].click();await tick();
assert.equal(lateErrors,1);assert([...badClose.querySelectorAll('button')].every(b=>b.disabled));
assert.throws(()=>createSetupView(dom.window.document,{}));
dom.window.close();
console.log('local-pc-setup-view: инструкция в окне и подтверждение скачивания проверены; окно ещё не подключено');
