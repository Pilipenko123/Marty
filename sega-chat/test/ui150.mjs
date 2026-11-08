// pkg3-150: выбор дисков, папки как очередь, единое добавление в плейлист.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readSrc } from './build.mjs';
const dom = new JSDOM(readSrc('public/index.html'), { url: 'https://chat.example/', runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window;
w.scrollTo = () => {};
w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
const calls = [];
const cards = [
  {id:'yandex', kind:'yandex', slot:1, title:'Диск Y1', connected:true},
  {id:'yandex2', kind:'yandex', slot:2, title:'Диск Y2', connected:true},
  {id:'google', kind:'google', slot:1, title:'Диск G1', connected:true},
  {id:'google2', kind:'google', slot:2, title:'Диск G2', connected:true}
];
const response = data => ({ ok:true, status:200, headers:{ get:()=> 'application/json' }, json:async()=>data, text:async()=>JSON.stringify(data) });
w.fetch = async (url, opts={}) => {
  const u = String(url); calls.push({u, body:opts.body});
  if (u.includes('/api/drives')) return response({drives:cards, soon:[]});
  if (u.includes('/api/yadisk/state')) return response({keys:true, connected:true, share:true});
  if (u.includes('/api/yadisk/share')) return response({share:JSON.parse(opts.body).share});
  if (u.includes('/api/yadisk/files')) return response({items:[{name:'Файл.mp3',path:u.includes('drive=google')?'google2:/f1':'disk2:/f1',size:100}]});
  if (u.includes('/api/yadisk/href') || u.includes('/api/yadisk/shared-href')) return response({href:'https://audio.yandex.net/song'});
  if (u.includes('/api/yadisk/list')) {
    const q = new URL(u, 'https://chat.example').searchParams;
    if (q.get('pageToken')) return response({items:[{name:'Второй.mp3',path:'google2:/song2',media:'audio'}],nextPageToken:''});
    return response({items:[{name:'Первый.mp3',path:'google2:/song1',media:'audio'}],nextPageToken:'page2',name:'Музыка'});
  }
  return response({ok:true});
};
w.eval(readSrc('public/app.js') + '\n;window.x={S,MUS,ydState,openMusic,diskBrowse,diskPlayFile,musicStep,musAskPlaylist,drvIcon,diskCrumbsHtml};');
const { S, MUS, ydState, openMusic, diskBrowse, diskPlayFile, musicStep, drvIcon, diskCrumbsHtml } = w.x;
S.me={id:'me'}; S.music={pub:[{id:'existing',name:'Старый',vis:'pub',tracks:[]}],priv:[]};
S.drives={list:cards,soon:[],loaded:true};
MUS.a={src:'',paused:true,ended:false,currentTime:0,duration:20,volume:1,pause(){this.paused=true},load(){},play(){this.paused=false;return Promise.resolve()},addEventListener(){},removeEventListener(){}};
const tick = () => new Promise(r=>setTimeout(r,25));
await openMusic('existing');
const groups = [...w.document.querySelectorAll('.mus-drive-group')];
assert.equal(groups.length,2);
assert.match(groups[0].textContent,/Yandex\.диск/);
assert.match(groups[1].textContent,/Google\.диск/);
assert.deepEqual([...w.document.querySelectorAll('[data-mus-drive]')].map(x=>x.textContent.trim()),['☁ Диск Y1','☁ Диск Y2','☁ Диск G1','☁ Диск G2']);
assert.equal(drvIcon('google2'),'☁');
w.document.querySelector('[data-mus-drive="google"][data-mus-slot="2"]').click(); await tick(); await tick();
assert.match(w.document.querySelector('#mus-pl-name').textContent,/Диск G2/);
assert(calls.some(x=>x.u.includes('drive=google') && x.u.includes('slot=2')));
const bar=w.document.querySelector('#mus-disk-bar');
assert(bar.querySelector('#mus-disk-share').checked);
assert.match(bar.textContent,/Обновить список/);
assert.doesNotMatch(bar.textContent,/подключён|токен|Отключить|Файлы остаются|Яндекс/);
assert(!bar.querySelector('select'));
const share = bar.querySelector('#mus-disk-share'); share.checked = false; share.dispatchEvent(new w.Event('change')); await tick();
assert(calls.some(x => x.u.includes('/api/yadisk/share') && JSON.parse(x.body).share === false));
assert(w.document.querySelector('[data-mus-disk-add="0"]'));
// Можно создать плейлист даже если старых нет; трек сохраняется в новый.
S.music.pub=[]; S.music.priv=[];
w.document.querySelector('[data-mus-disk-add="0"]').click(); await tick();
assert(w.document.querySelector('[data-mus-create]'));
w.prompt=()=> 'Новый'; w.confirm=()=>true;
w.document.querySelector('[data-mus-create]').click(); await tick();
assert.equal(S.music.pub.length,1);
assert.equal(S.music.pub[0].name,'Новый');
assert.equal(S.music.pub[0].tracks[0].path,'google2:/f1');
assert.equal(S.music.pub[0].tracks[0].diskOf,'me');
// Открытие большой папки загружает и вторую страницу, а затем воспроизводит
// нажатый трек и строит очередь по сортировке проводника.
S.disk={drive:'google2',of:'',path:'google2:/folder',items:[],sel:-1,sort:{key:'name',dir:1}};
await diskBrowse('google2:/folder');
assert.equal(S.disk.items.length,2);
assert(calls.some(x=>x.u.includes('pageToken=page2')));
const first=S.disk.items[0];
await diskPlayFile(first,''); await tick();
assert.equal(MUS.plId,'disk-folder'); assert.equal(MUS.idx,1);
assert.equal(MUS.list[MUS.idx].path,'google2:/song1');
assert.equal(MUS.list[0].path,'google2:/song2');
assert.match(w.document.querySelector('#mus-now-title').textContent,/Первый.mp3/);
assert.equal(w.document.querySelectorAll('[data-pl="disk-folder"] .mus-tr').length,2);
assert(w.document.querySelector('[data-mus-folder-add="0"]'));
w.document.querySelector('[data-mus-folder-add="0"]').click(); await tick();
assert.match(w.document.querySelector('.ask-list').textContent, /Новый/);
w.document.querySelector('[data-mus-pick]').click(); await tick();
assert.equal(S.music.pub[0].tracks.length, 2);
assert.equal(S.music.pub[0].tracks[1].path, 'google2:/song2');
musicStep(-1,false); await tick();
assert.equal(MUS.list[MUS.idx].path,'google2:/song2');
assert(w.document.querySelector('[data-pl="disk-folder"] .mus-tr').classList.contains('cur'));
musicStep(1, true); await tick();
assert.equal(MUS.list[MUS.idx].path, 'google2:/song1');
// Крошки второго Яндекс.Диска сохраняют номер.
S.disk.drive='yandex2'; S.disk.of='';
assert.match(diskCrumbsHtml('disk2:/А/Б','disk2:/'),/data-disk-go="disk2:\/А"/);
dom.window.close();
console.log('  pkg3-150: меню дисков, страницы папки, очередь и создание плейлиста проверены');
