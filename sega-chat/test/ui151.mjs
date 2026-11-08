// pkg3-151: одинаковые строки музыки с диска и закреплённый источник.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readSrc } from './build.mjs';
const dom = new JSDOM(readSrc('public/index.html'), { url:'https://chat.example/', runScripts:'outside-only', pretendToBeVisual:true });
const w = dom.window;
w.scrollTo = () => {};
w.matchMedia = () => ({matches:false,addEventListener(){},removeEventListener(){},addListener(){},removeListener(){}});
const cards = [{id:'yandex',kind:'yandex',slot:1,title:'Диск Y1',connected:true}, {id:'yandex2',kind:'yandex',slot:2,title:'Диск Y2',connected:true}, {id:'google2',kind:'google',slot:2,title:'Диск G2',connected:true}];
const long = 'Очень длинное название трека для проверки бегущей строки туда и обратно.mp3';
const response = d => ({ok:true,status:200,headers:{get:()=> 'application/json'},json:async()=>d,text:async()=>JSON.stringify(d)});
w.fetch = async url => {
  const u=String(url);
  if(u.includes('/api/drives')) return response({drives:cards,soon:[]});
  if(u.includes('/api/yadisk/state')) return response({keys:true,connected:true,share:true});
  if(u.includes('/api/yadisk/files')) {
    const head=u.includes('drive=google')?'google2:':(u.includes('slot=1') ? 'disk:' : 'disk2:');
    return response({items:[{name:long,path:head+'/one.mp3'},{name:'Второй.mp3',path:head+'/two.mp3'}],nextPageToken:''});
  }
  if(u.includes('/api/yadisk/href')) return response({href:'https://audio.yandex.net/song.mp3'});
  return response({ok:true});
};
w.eval(readSrc('public/app.js')+'\n;window.x={S,MUS,openMusic,musicAudio,musicTickUi,musicStep,musMqFit,ydRenderOn};');
const {S,MUS,openMusic,musicTickUi,musicStep,musMqFit,ydRenderOn}=w.x;
S.me={id:'me'};
S.drives={list:cards,soon:[],loaded:true};
S.music={pub:[{id:'p1',name:'Плейлист',vis:'pub',tracks:[
  {id:'a',title:long,url:'https://audio.jamendo.com/song',site:'jamendo'},
  {id:'b',kind:'disk',title:long,path:'google2:/song.mp3'},
  {id:'c',kind:'widget',title:long,url:'https://music.yandex.ru/iframe/track/1',what:'track'},
  {id:'d',title:long,url:'https://unusuallylongmusicdomain.example/song'}
]}],priv:[]};
const events = new w.EventTarget();
MUS.a={src:'',paused:true,ended:false,currentTime:0,duration:90,volume:1,load(){},
  pause(){this.paused=true;events.dispatchEvent(new w.Event('pause'));},
  play(){this.paused=false;this.ended=false;events.dispatchEvent(new w.Event('play'));return Promise.resolve();},
  addEventListener:(...args)=>events.addEventListener(...args),removeEventListener:(...args)=>events.removeEventListener(...args)};
events.addEventListener('play',musicTickUi); events.addEventListener('pause',musicTickUi);
const tick=()=>new Promise(r=>setTimeout(r,30));
await openMusic('yadisk',2); await tick(); await tick();
let box=w.document.querySelector('#mus-disk-files');
assert.equal(box.getAttribute('data-pl'),'yadisk');
let rows=box.querySelectorAll('.mus-tr');
assert.equal(rows.length,2);
assert(rows[0].querySelector('.mus-ti > .mq'));
assert(rows[0].querySelector('[data-mus-disk-add]'));
assert(rows[0].querySelector('.mus-source').nextElementSibling.matches('[data-mus-disk-add]'));
rows[0].querySelector('[data-mus-disk-play]').click(); await tick();
assert.equal(rows[0].querySelector('[data-mus-disk-play]').textContent,'❚❚');
assert(rows[0].classList.contains('cur'));
const mq=rows[0].querySelector('.mq'), ti=rows[0].querySelector('.mus-ti');
Object.defineProperty(mq,'scrollWidth',{value:400,configurable:true});
Object.defineProperty(ti,'clientWidth',{value:100,configurable:true});
musMqFit(rows[0]);
assert.equal(mq.style.getPropertyValue('--mq-shift'),'-300px');
assert(!mq.classList.contains('mq-s'));
rows[0].querySelector('[data-mus-disk-play]').click();
assert(MUS.a.paused);
assert.equal(rows[0].querySelector('[data-mus-disk-play]').textContent,'▶');
assert(rows[0].classList.contains('paused'));
rows[0].querySelector('[data-mus-disk-play]').click(); await tick();
assert(!MUS.a.paused);
assert.equal(rows[0].querySelector('[data-mus-disk-play]').textContent,'❚❚');
assert(!rows[0].classList.contains('paused'));
musicStep(1,true); await tick();
assert.equal(rows[1].querySelector('[data-mus-disk-play]').textContent,'❚❚');
assert.equal(rows[0].querySelector('[data-mus-disk-play]').textContent,'▶');
assert(rows[1].classList.contains('cur') && !rows[0].classList.contains('cur'));
ydRenderOn(); box=w.document.querySelector('#mus-disk-files'); rows=box.querySelectorAll('.mus-tr');
assert.equal(rows[1].querySelector('[data-mus-disk-play]').textContent,'❚❚');
await openMusic('yadisk',1); await tick(); await tick();
assert.equal(w.document.querySelectorAll('#mus-disk-files .mus-tr.cur').length,0); // другой номер того же типа
await openMusic('gdisk',2); await tick(); await tick();
box=w.document.querySelector('#mus-disk-files'); rows=box.querySelectorAll('.mus-tr');
assert.equal(box.getAttribute('data-pl'),'gdisk');
assert.equal(box.querySelectorAll('.mus-tr.cur').length,0); // играет трек с другого диска
rows[0].querySelector('[data-mus-disk-play]').click(); await tick();
assert.equal(rows[0].querySelector('[data-mus-disk-play]').textContent,'❚❚');
assert.match(rows[0].querySelector('.mus-source').textContent,/Диск G2/);
await openMusic('p1'); await tick();
rows=w.document.querySelectorAll('[data-pl="p1"] .mus-tr');
assert.equal(rows.length,4);
for (const row of rows) {
  const title=row.querySelector('.mus-ti'), badge=row.querySelector('.mus-source'), edit=row.querySelector('[data-mus-edit]');
  assert(badge && edit && badge.nextElementSibling===edit);
  assert(!title.contains(badge));
  assert(title.querySelector('.mq'));
}
assert.match(rows[0].querySelector('.mus-source').textContent,/Jamendo/i);
assert.match(rows[1].querySelector('.mus-source').textContent,/Диск G2/);
assert.match(rows[2].querySelector('.mus-source').textContent,/Яндекс.Музыка/);
assert.match(rows[3].querySelector('.mus-source').textContent,/unusuallylongmusicdomain/);
const css=readSrc('public/styles.css');
assert.match(css,/\.mus-v105 \.mus-tr \.mus-source\{[^}]*flex:0 0 auto[^}]*overflow-wrap:anywhere/);
assert.match(css,/\.mus-v105 \.mus-trs:not\(#mus-sres\) \.mus-tr \.mq:not\(\.mq-s\)\{animation:mus-mq/);
assert.match(css,/\.mus-tr\.cur\.paused \.mq\{animation-play-state:paused/);
dom.window.close();
console.log('  pkg3-151: строки дисков, пауза, смена треков, бегущая строка и источник проверены');
