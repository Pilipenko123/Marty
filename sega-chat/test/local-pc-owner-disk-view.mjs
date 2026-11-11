// Неподключённый DOM с поддельным источником, не настоящий браузер или Windows.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createOwnerDiskView,disposeOwnerDiskView}=require('../local-pc/owner-disk-view.js');
const {createOwnerListRequest}=require('../local-pc/owner-list-request.js');
const {createOwnerSnapshotTransfer}=require('../local-pc/owner-snapshot-transfer.js');
const {createOwnerReadTransport}=require('../local-pc/owner-read-transport.js');
const {createSnapshotSession}=require('../local-pc/snapshot-session.js');
const {createReadService}=require('../local-pc/read-service.js');
const {createRelay,digest}=require('../local-pc/relay.js');
const secure=require('../local-pc/secure-channel.js');
const dom=new JSDOM('<!doctype html><body></body>'),doc=dom.window.document;
const dev='1'.repeat(32),token='2'.repeat(64),secret=Uint8Array.from(crypto.randomBytes(32)),version='a'.repeat(64),modified='2026-01-01';
const bytes=Buffer.from('Пробный текст'),hash=crypto.createHash('sha256').update(bytes).digest('hex');
const tree={'':[{name:'Папка',dir:true,size:0,modified},{name:'A & B.txt',dir:false,size:bytes.length,modified}],
  'Папка':[{name:'тест.txt',dir:false,size:bytes.length,modified}]};
let sourceLists=0,captures=0,disposals=0,requests=[],prompts=[],answer=false,closes=0;
const session=createSnapshotSession({enabled:true,capture:async path=>{
  captures++;assert(['A & B.txt','Папка/тест.txt'].includes(path));const copy=Buffer.from(bytes);
  return {info:()=>({size:copy.length,hash,version,modified}),read:async(offset,length)=>({data:Buffer.from(copy.subarray(offset,offset+length)),size:copy.length,version,modified}),dispose(){disposals++;copy.fill(0);}};
}});
const folder={async list(path){sourceLists++;return tree[path]||[];},async read(){throw Error('not used');}};
const agent=createReadService({folder,secret,deviceId:dev,snapshotSession:session}),relay=createRelay();relay.register('owner',dev,digest(token));
const transport=createOwnerReadTransport({secret,deviceId:dev,
  async sendRequest({requestId,packet}){const data=await secure.open(secret,packet,{channel:dev,direction:'request',request:requestId});requests.push(JSON.parse(new TextDecoder().decode(data)).op);
    relay.request('owner',dev,requestId,packet);const job=relay.next(dev,token);const response=await agent.handle(job.requestId,job.packet);relay.reply(dev,token,requestId,job.claim,response);return {ok:true};},
  async getResult({requestId}){return relay.result('owner',dev,requestId);},async acknowledge({requestId}){relay.acknowledge('owner',dev,requestId);return {ok:true};}
});
const lister=createOwnerListRequest({transport,pollMs:1,timeoutMs:3000}),transfer=createOwnerSnapshotTransfer({transport,pollMs:1,timeoutMs:3000,cleanupTimeoutMs:500,chunkSize:6});
const view=createOwnerDiskView(doc,{listDirectory:lister.list,transfer,confirmDownload:q=>{prompts.push(q);return answer;},onClose:()=>{closes++;}});
doc.body.appendChild(view);const status=()=>view.querySelector('[role=status]').textContent;
const btn=action=>view.querySelector(`[data-action="${action}"]`),tick=()=>new Promise(r=>setTimeout(r,10));
async function until(fn){for(let i=0;i<100;i++){if(fn())return;await tick();}assert.fail('Окно не завершило действие: '+status());}
assert.match(view.textContent,/Черновик/);assert.equal(sourceLists,0);assert.equal(captures,0);assert.equal(btn('back').disabled,true);
btn('open').click();await until(()=>sourceLists===1 && !!btn('directory'));assert.deepEqual(requests,['list']);
assert.equal(view.querySelectorAll('[data-action=file]')[0].textContent.includes('A & B.txt'),true);
assert(view.innerHTML.includes('A &amp; B.txt'));assert.equal(view.querySelector('img'),null);
btn('file').click();await until(()=>status()==='Скачивание отменено.');assert.deepEqual(prompts,['Скачать файл на устройство?']);assert.equal(captures,0);
btn('directory').click();await until(()=>sourceLists===2 && view.textContent.includes('тест.txt'));assert.equal(btn('back').disabled,false);
answer=true;btn('file').click();await until(()=>status()==='Файл проверен. Скачивание пока не подключено.');
assert.equal(captures,1);assert.equal(disposals,1);assert.equal(requests.at(-1),'snapshotClose');assert(view.textContent.includes('Папка'));
btn('back').click();await until(()=>sourceLists===3 && view.textContent.includes('A & B.txt'));assert.equal(btn('back').disabled,true);
btn('close').click();await tick();assert.equal(closes,1);assert([...view.querySelectorAll('button')].every(b=>b.disabled));

// Отказ, неоднозначные ответы и позднее «да» после закрытия никогда не запускают передачу.
for(const value of [false,undefined,null,1,'да',{}]){
 let got=0,asked='';const v=createOwnerDiskView(doc,{listDirectory:async()=>[tree[''][1]],transfer:{async transfer(){got++;}},confirmDownload:q=>{asked=q;return value;},onClose(){}});
 doc.body.appendChild(v);v.querySelector('[data-action=open]').click();await until(()=>!!v.querySelector('[data-action=file]'));
 v.querySelector('[data-action=file]').click();await until(()=>v.querySelector('[role=status]').textContent==='Скачивание отменено.');
 assert.equal(got,0);assert.equal(asked,'Скачать файл на устройство?');disposeOwnerDiskView(v);v.remove();
}
let resolvePrompt,got=0,shown=0;
const pending=createOwnerDiskView(doc,{listDirectory:async()=>[tree[''][1]],transfer:{async transfer(){got++;}},
  confirmDownload(){shown++;return new Promise(r=>{resolvePrompt=r;});},onClose(){closes++;}});
doc.body.appendChild(pending);pending.querySelector('[data-action=open]').click();await until(()=>!!pending.querySelector('[data-action=file]'));
pending.querySelector('[data-action=file]').click();pending.querySelector('[data-action=file]').click();assert.equal(shown,1);
pending.querySelector('[data-action=close]').click();resolvePrompt(true);await tick();assert.equal(got,0);
// Внешнее удаление окна также отменяет запрос, даже если источник игнорирует сигнал.
let releaseList,signalSeen;const late=createOwnerDiskView(doc,{listDirectory:(_p,signal)=>{signalSeen=signal;return new Promise(r=>{releaseList=r;});},
  transfer:{async transfer(){}},confirmDownload:()=>true,onClose(){}});
doc.body.appendChild(late);late.querySelector('[data-action=open]').click();assert.equal(signalSeen.aborted,false);disposeOwnerDiskView(late);disposeOwnerDiskView(late);late.remove();
assert.equal(signalSeen.aborted,true);releaseList(tree['']);await tick();assert.equal(late.querySelectorAll('[data-action=file]').length,0);
// Поздние данные после закрытия не выводятся и собственный возвращённый буфер очищается.
let releaseFile,readSignal;const lateBytes=Uint8Array.from([4,5,6]);
const lateResult=createOwnerDiskView(doc,{listDirectory:async()=>[tree[''][1]],confirmDownload:()=>true,onClose(){},
  transfer:{transfer({signal}){readSignal=signal;return new Promise(r=>{releaseFile=r;});}}});
doc.body.appendChild(lateResult);lateResult.querySelector('[data-action=open]').click();await until(()=>!!lateResult.querySelector('[data-action=file]'));
lateResult.querySelector('[data-action=file]').click();await until(()=>!!releaseFile);lateResult.querySelector('[data-action=close]').click();assert.equal(readSignal.aborted,true);
releaseFile({data:lateBytes,size:3});await tick();assert.deepEqual([...lateBytes],[0,0,0]);assert(!lateResult.textContent.includes('Файл проверен. Скачивание'));
// Возврат во время медленного перехода отменяет прежний запрос. Его поздний
// результат не заменяет открытую родительскую папку.
let slowResolve,slowSignal;
const stale=createOwnerDiskView(doc,{listDirectory:(p,s)=>{
  if(p==='')return Promise.resolve([{name:'Уровень',dir:true,size:0,modified}]);
  if(p==='Уровень')return Promise.resolve([{name:'Вложенная',dir:true,size:0,modified}]);
  slowSignal=s;return new Promise(r=>{slowResolve=r;});
},transfer:{async transfer(){}},confirmDownload:()=>false,onClose(){}});
doc.body.appendChild(stale);stale.querySelector('[data-action=open]').click();await until(()=>!!stale.querySelector('[data-action=directory]'));
stale.querySelector('[data-action=directory]').click();await until(()=>stale.textContent.includes('Вложенная'));
stale.querySelector('[data-action=directory]').click();await until(()=>!!slowResolve);stale.querySelector('[data-action=back]').click();
await until(()=>stale.textContent.includes('Уровень') && !stale.textContent.includes('Вложенная'));assert.equal(slowSignal.aborted,true);
slowResolve([{name:'устарело.txt',dir:false,size:0,modified}]);await tick();assert(!stale.textContent.includes('устарело.txt'));disposeOwnerDiskView(stale);
// Плохой список не выводится и техническая ошибка не раскрывается.
let invalid=[{name:'../секрет',dir:false,size:1,modified}];let online=true;
const bad=createOwnerDiskView(doc,{listDirectory:async()=>invalid,transfer:{async transfer(){}},confirmDownload:()=>true,onClose(){},isOnline:()=>online});doc.body.appendChild(bad);
bad.querySelector('[data-action=open]').click();await until(()=>bad.querySelector('[role=status]').textContent.startsWith('Не удалось'));
assert.equal(bad.querySelectorAll('[data-action=file]').length,0);assert(!bad.textContent.includes('../секрет'));
invalid=[{name:'x',dir:false,size:0,modified},{name:'X',dir:false,size:0,modified}];online=false;
bad.querySelector('[data-action=open]').click();await until(()=>bad.querySelector('[role=status]').textContent==='Нет соединения');
disposeOwnerDiskView(bad);
// При подтверждённом отсутствии связи окно останавливает ожидание и не
// отправляет новые запросы. При возвращении связи нужен ручной повтор.
let connected=true,offlineSignal,offlineRelease,offlineCalls=0;
const connection=createOwnerDiskView(doc,{isOnline:()=>connected,listDirectory:(_p,s)=>{offlineCalls++;offlineSignal=s;return new Promise(r=>{offlineRelease=r;});},
  transfer:{async transfer(){}},confirmDownload:()=>true,onClose(){}});
doc.body.appendChild(connection);connection.querySelector('[data-action=open]').click();assert.equal(offlineCalls,1);
connected=false;dom.window.dispatchEvent(new dom.window.Event('offline'));assert.equal(offlineSignal.aborted,true);
assert.equal(connection.querySelector('[role=status]').textContent,'Нет соединения');
connection.querySelector('[data-action=open]').click();assert.equal(offlineCalls,1);
offlineRelease(tree['']);await tick();assert.equal(connection.querySelectorAll('[data-action=file]').length,0);
connected=true;dom.window.dispatchEvent(new dom.window.Event('online'));
assert.match(connection.querySelector('[role=status]').textContent,/Соединение восстановлено/);assert.equal(offlineCalls,1);disposeOwnerDiskView(connection);
assert.throws(()=>createOwnerDiskView(doc,{}));
// Проверка разметки, мобильного заполнения экрана и выполнения как браузерного скрипта.
const css=fs.readFileSync(new URL('../local-pc/owner-disk-view.css',import.meta.url),'utf8');assert.match(css,/position:\s*fixed/);assert.match(css,/inset:\s*0/);assert.match(css,/@media/);
const ctx=vm.createContext({AbortController,Uint8Array});
for(const f of ['path-rules.js','owner-disk-view.js'])vm.runInContext(fs.readFileSync(new URL('../local-pc/'+f,import.meta.url),'utf8'),ctx);
const vmView=ctx.SegaLocalOwnerDiskView.createOwnerDiskView(doc,{listDirectory:async()=>[],transfer:{async transfer(){}},confirmDownload:()=>false,onClose(){}});
assert.equal(vmView.getAttribute('role'),'dialog');ctx.SegaLocalOwnerDiskView.disposeOwnerDiskView(vmView);
dom.window.close();
console.log('local-pc-owner-disk-view: папки, согласие, остановка и пробное чтение проверены в DOM; настоящего скачивания и Windows нет');
