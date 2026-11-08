// pkg3-149: настоящая отрисовка списков и поведение плеера при отказе.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
import { readSrc, ROOT } from './build.mjs';
const require = createRequire(import.meta.url);
const { serveStatic } = require(ROOT + '/lib/static.js');
const stream = require(ROOT + '/lib/musstream.js');
const csp = serveStatic('/index.html', '').headers['Content-Security-Policy'];
assert.match(csp, /media-src 'self' data: blob: https:/);
assert.match(csp, /connect-src 'self'/);
assert(stream.hostOk(new URL('https://downloader.disk.yandex.ru/file')));
assert(stream.hostOk(new URL('https://foo.yandex.net/file')));
assert(!stream.hostOk(new URL('https://yandex.ru.evil.example/file')));
assert(!stream.hostOk(new URL('http://foo.yandex.net/file')));
assert(!stream.hostOk(new URL('https://foo.yandex.net:8443/file')));

const dom = new JSDOM(readSrc('public/index.html'), { url: 'https://chat.example/', runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window;
w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
w.eval(readSrc('public/app.js') + '\n;window.x={S,MUS,ydState,ydRenderOn,ydLoadFiles,musicStartDiskTrack};');
const { S, MUS, ydState, ydRenderOn, ydLoadFiles, musicStartDiskTrack } = w.x;
S.music = { pub: [{ id: 'pl', name: 'Мой список', tracks: [] }], priv: [] };
S.me = { id: 'me' };
w.document.body.insertAdjacentHTML('beforeend', '<div id="mus-disk-bar"></div><div id="mus-disk-addline" class="hidden"></div><div id="mus-disk-files"></div>');
const y = ydState();
y.drive = 'google'; y.slot = 1; y.paneSeq = 1;
y.cards = [{ slot: 1, title: 'Google Диск' }, { slot: 2, title: 'Google Диск 2' }];
y.files = [{ name: 'Первый.mp3', path: 'google:/song1', size: 1024 }];
y.more = true;
ydRenderOn();
assert.match(w.document.getElementById('mus-disk-files').textContent, /Первый.mp3/);
assert(w.document.querySelector('[data-mus-disk-play="0"]'));
assert(w.document.querySelector('[data-mus-disk-add="0"]'));
assert(!w.document.querySelector('#mus-disk-slot')); // выбор диска теперь в «Плейлисты и источники»
assert(w.document.querySelector('#mus-disk-share'));
assert(w.document.querySelector('#mus-disk-more'));

const requests = [];
const response = data => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => data, text: async () => JSON.stringify(data) });
w.fetch = async url => { requests.push(String(url)); return response({ items: [{ name: 'Второй.mp3', path: 'google:/song2' }], nextPageToken: '' }); };
y.pageToken = 'next-page';
await ydLoadFiles(false);
assert(requests[0].includes('pageToken=next-page'));
assert.match(w.document.getElementById('mus-disk-files').textContent, /Первый.mp3/);
assert.match(w.document.getElementById('mus-disk-files').textContent, /Второй.mp3/);
assert.equal(y.more, false);

// Поздний ответ прежнего диска не должен заменять новый список.
let finishOld;
w.fetch = url => String(url).includes('drive=google')
  ? new Promise(resolve => { finishOld = () => resolve(response({ items: [{ name: 'Старый Google', path: 'google:/old' }] })); })
  : Promise.resolve(response({ items: [{ name: 'Новый Яндекс', path: 'disk:/new' }] }));
const old = ydLoadFiles(true);
y.paneSeq++; y.drive = 'yandex'; y.cards = []; y.slot = 1;
await ydLoadFiles(true);
finishOld(); await old;
assert.match(w.document.getElementById('mus-disk-files').textContent, /Новый Яндекс/);
assert.doesNotMatch(w.document.getElementById('mus-disk-files').textContent, /Старый Google/);

// Не отправляем в аудиоплеер JSON; отказ в получении ссылки честно останавливает.
let off = false;
MUS.a = { src: '', paused: true, pause() {}, load() {}, play() { return Promise.resolve(); }, __musOff() { off = true; }, addEventListener() {}, removeEventListener() {}, currentTime: 0 };
const track = { kind: 'disk', path: 'disk:/file.mp3', title: 'файл' };
MUS.list = [track]; MUS.idx = 0; MUS.fails = 0;
w.fetch = async () => ({ ok: false, status: 409, headers: { get: () => 'application/json' }, json: async () => ({ error: 'нет доступа' }), text: async () => '' });
await musicStartDiskTrack(track);
assert(off);
assert(!MUS.a.src.includes('/api/yadisk/file'));
assert.equal(MUS.idx, -1);
dom.window.close();
console.log('  pkg3-149: список Google, страницы, переключение, воспроизведение и ограничения: проверено');
