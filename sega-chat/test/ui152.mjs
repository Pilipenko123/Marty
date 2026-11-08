// pkg3-152: бегущая строка только у текущего трека, пауза её останавливает.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readSrc } from './build.mjs';

const dom = new JSDOM(readSrc('public/index.html'), { url:'https://chat.example/', runScripts:'outside-only', pretendToBeVisual:true });
const w = dom.window;
w.scrollTo = () => {};
w.matchMedia = () => ({matches:false,addEventListener(){},removeEventListener(){},addListener(){},removeListener(){}});
const css = w.document.createElement('style');
css.textContent = readSrc('public/styles.css');
w.document.head.appendChild(css);
const cards = [{id:'yandex',kind:'yandex',slot:1,title:'Диск Y1',connected:true}];
const response = data => ({ok:true,status:200,headers:{get:()=> 'application/json'},json:async()=>data,text:async()=>JSON.stringify(data)});
w.fetch = async url => {
  const u=String(url);
  if (u.includes('/api/drives')) return response({drives:cards,soon:[]});
  if (u.includes('/api/yadisk/state')) return response({keys:true,connected:true,share:true});
  if (u.includes('/api/yadisk/files')) return response({items:[{name:'Очень длинное название первого трека.mp3',path:'disk:/one.mp3'},{name:'Очень длинное название второго трека.mp3',path:'disk:/two.mp3'}]});
  if (u.includes('/api/yadisk/href')) return response({href:'https://audio.yandex.net/song.mp3'});
  return response({ok:true});
};
w.eval(readSrc('public/app.js')+'\n;window.x={S,MUS,openMusic,musicTickUi,musicStep,musMqFit};');
const {S,MUS,openMusic,musicTickUi,musicStep,musMqFit} = w.x;
S.me={id:'me'};
S.drives={list:cards,soon:[],loaded:true};
S.music={pub:[{id:'p1',name:'Плейлист',vis:'pub',tracks:[
  {id:'one',kind:'disk',title:'Очень длинное название первого трека.mp3',path:'disk:/one.mp3'},
  {id:'two',kind:'disk',title:'Очень длинное название второго трека.mp3',path:'disk:/two.mp3'}
]}],priv:[]};
const events = new w.EventTarget();
MUS.a={src:'',paused:true,ended:false,currentTime:0,duration:90,volume:1,load(){},
  pause(){this.paused=true;events.dispatchEvent(new w.Event('pause'));},
  play(){this.paused=false;this.ended=false;events.dispatchEvent(new w.Event('play'));return Promise.resolve();},
  addEventListener:(...args)=>events.addEventListener(...args),removeEventListener:(...args)=>events.removeEventListener(...args)};
events.addEventListener('play',musicTickUi);
events.addEventListener('pause',musicTickUi);
const wait=()=>new Promise(r=>setTimeout(r,30));
function rows(selector) { return [...w.document.querySelectorAll(selector+' .mus-tr')]; }
function fitLong(row) {
  const mq=row.querySelector('.mq'), ti=row.querySelector('.mus-ti');
  // jsdom не выполняет раскладку: подставляем реальные размеры длинной строки.
  Object.defineProperty(mq,'scrollWidth',{value:400,configurable:true});
  Object.defineProperty(ti,'clientWidth',{value:100,configurable:true});
  musMqFit(row);
  assert(!mq.classList.contains('mq-s'));
  return mq;
}
function running(mq) {
  const style=w.getComputedStyle(mq);
  return style.animation.includes('mus-mq') && style.animationPlayState !== 'paused';
}
function checkOnly(list, index) {
  const mqs=list.map(fitLong);
  for (let i=0;i<mqs.length;i++) assert.equal(running(mqs[i]),i===index,'двигается только текущая строка: '+i);
  return mqs;
}

// Обычный плейлист: выбор, следующий трек, пауза и продолжение.
await openMusic('p1');
let list=rows('[data-pl="p1"]');
checkOnly(list,-1);
list[0].querySelector('[data-mus-play]').click(); await wait();
list=rows('[data-pl="p1"]');
checkOnly(list,0);
musicStep(1,true); await wait();
list=rows('[data-pl="p1"]');
let mqs=checkOnly(list,1);
list[1].querySelector('[data-mus-play]').click(); await wait();
assert(MUS.a.paused);
assert.equal(running(mqs[0]),false);
assert.equal(running(mqs[1]),false);
assert.equal(w.getComputedStyle(mqs[1]).animationPlayState,'paused');
list[1].querySelector('[data-mus-play]').click(); await wait();
checkOnly(list,1);
// Короткое название не двигается даже у играющего трека.
mqs[1].classList.add('mq-s');
assert.equal(running(mqs[1]),false);

// Музыка со всего Диска: кнопки и выбор строк ведут себя так же.
await openMusic('yadisk',1); await wait(); await wait();
list=rows('#mus-disk-files');
checkOnly(list,-1);
list[0].querySelector('[data-mus-disk-play]').click(); await wait();
checkOnly(list,0);
musicStep(1,true); await wait();
checkOnly(list,1);
list[1].querySelector('[data-mus-disk-play]').click(); await wait();
assert.equal(running(fitLong(list[0])),false);
assert.equal(running(fitLong(list[1])),false);
list[1].querySelector('[data-mus-disk-play]').click(); await wait();
checkOnly(list,1);

// Правило действует и для результатов поиска; другие длинные строки стоят.
const search=w.document.createElement('div');
search.innerHTML='<div class="mus-v105"><div id="mus-sres" class="mus-trs"><div class="mus-tr cur"><span class="mq">длинный текущий</span></div><div class="mus-tr"><span class="mq">длинный другой</span></div></div></div>';
w.document.body.appendChild(search);
const searchMqs=search.querySelectorAll('.mq');
assert(running(searchMqs[0]));
assert(!running(searchMqs[1]));
searchMqs[0].parentNode.classList.add('paused');
assert(!running(searchMqs[0]));

dom.window.close();
console.log('  pkg3-152: анимация только у играющего трека, пауза и переход проверены');
