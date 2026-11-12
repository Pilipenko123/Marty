import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readSrc } from './build.mjs';
const dom = new JSDOM(readSrc('public/index.html'), { url:'https://chat.example/', runScripts:'outside-only', pretendToBeVisual:true });
const w = dom.window;
w.matchMedia = () => ({ matches:false, addEventListener(){}, removeEventListener(){}, addListener(){}, removeListener(){} });
w.scrollTo = () => {};
const cards = [
 {id:'yandex',kind:'yandex',slot:1,title:'Диск Y1',connected:true,shared:2},
 {id:'yandex2',kind:'yandex',slot:2,title:'Диск Y2',connected:false,placeholder:true},
 {id:'google',kind:'google',slot:1,title:'Диск G1',connected:true,canWrite:false},
 {id:'google2',kind:'google',slot:2,title:'Диск G2',connected:false,placeholder:true,needsKeys:true,keysHint:'Настройте Google'}
];
const calls=[];
w.fetch=async (url,opts={}) => {
 const u=String(url); calls.push({u,body:opts.body});
 if (u.includes('/api/drives/rename')) {const b=JSON.parse(opts.body); cards.find(x=>x.id===b.id).title=b.title;}
 const data=u.endsWith('/api/drives')?{drives:cards}: {ok:true};
 return {ok:true,status:200,headers:{get:()=> 'application/json'},json:async()=>data,text:async()=>JSON.stringify(data)};
};
w.eval(readSrc('public/app.js')+'\n;window.t={S,driveConnectAsk,drivesRailRows,diskCrumbsHtml};');
w.t.S.me={id:'me'};
await w.t.driveConnectAsk();
const q=s=>w.document.querySelector(s);
const tick=()=>new Promise(resolve=>setTimeout(resolve,30));
assert.match(q('#modal-body').textContent,/Мои Yandex диски/);
assert.match(q('#modal-body').textContent,/Мои Google диски/);
assert.match(q('#modal-body').textContent,/Настройте Google/);
// Раздел пока только информационный: никакой запрос на подключение не уходит.
const local=q('[aria-labelledby="local-disk-title"]');
assert(local);assert.match(local.textContent,/Пока недоступно/);
const request=local.querySelector('button');assert.equal(request.disabled,true);
assert.match(request.textContent,/Запросить подключение моей папки/);
assert.equal(request.getAttribute('aria-describedby'),'local-disk-unavailable');
const info=local.querySelector('details');assert(info);assert.match(info.querySelector('summary').textContent,/Узнать подробнее/);
info.open=true;assert.match(info.textContent,/Одобрение не выбирает папку/);
assert.match(info.textContent,/включаться отдельно/);assert.match(info.textContent,/Установщика и отправки запросов сейчас нет/);
const priorCalls=calls.length;request.click();await tick();assert.equal(calls.length,priorCalls);

assert.equal(q('[data-drv-token]').getAttribute('data-drv-token'),'2');
assert.equal(q('[data-gd-login]').getAttribute('data-gd-login'),'2');
assert(q('[data-gd-more="1"]'));
assert(!w.t.drivesRailRows().includes('открыто:'));
assert(!w.t.drivesRailRows().includes('файлы лежат'));
q('[data-drv-info]').click();
assert.match(q('.ask-ovl').textContent,/только если вы сами дадите им такое право/);
q('[data-drv-info-close]').click();
assert(!q('.ask-ovl')); assert.match(q('#modal-title').textContent,/Подключить диск/);
q('[data-drv-token]').click(); assert(q('.yd-tok-card')); q('[data-yd-tok2=""]').click();
assert(!q('.yd-tok-card')); assert.match(q('#modal-title').textContent,/Подключить диск/);
w.prompt=()=> '  Рабочий  '; q('[data-drv-rename="yandex"]').click(); await tick(); await tick();
assert(calls.some(c=>c.u.includes('/api/drives/rename') && JSON.parse(c.body).title==='Рабочий'));
assert.match(q('[data-drive-open="yandex"]').textContent,/Рабочий/);
assert(w.t.drivesRailRows().includes('Рабочий'));
// Имена дисков вводит пользователь: в строке пути они не должны стать HTML.
cards[0].title='<img src=x onerror=alert(1)>';
w.t.S.disk={drive:'yandex',of:'',path:'disk:/'};
const crumb = w.t.diskCrumbsHtml('disk:/','disk:/');
assert(!crumb.includes('<img')); assert(crumb.includes('&lt;img'));
cards[2].title='<img src=x onerror=alert(1)>';
w.t.S.disk={drive:'google',of:'',path:'google:/root'};
const gc = w.t.diskCrumbsHtml('google:/root','google:/root');
assert(!gc.includes('<img')); assert(gc.includes('&lt;img'));
dom.window.close();
console.log('  pkg3-153: компактное окно, подсказка, слоты и переименование проверены');
