// Окно не подключено к мессенджеру; тест проверяет только инструкции и согласие.
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createRequire} from 'node:module';
const {createSetupView}=createRequire(import.meta.url)('../local-pc/setup-view.js');
const dom=new JSDOM('<!doctype html><body></body>');
let created=0, downloaded=0, closed=0, answer=false, question='';
const root=createSetupView(dom.window.document,{
  onCreateCode:()=>{created++}, onDownload:()=>{downloaded++}, onClose:()=>{closed++},
  confirmDownload:q=>{question=q; return answer}
});
dom.window.document.body.appendChild(root);
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
assert.throws(()=>createSetupView(dom.window.document,{}));
dom.window.close();
console.log('local-pc-setup-view: инструкция в окне и подтверждение скачивания проверены; окно ещё не подключено');
