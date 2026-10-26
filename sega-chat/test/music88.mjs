/**
 * pkg3-88: «Моя музыка» — умная вставка (код плеера и ссылки Яндекс.Музыки).
 *   • разбор вставленного текста живёт в отдельном «чистом» модуле
 *     public/music-paste.js: ни сети, ни DOM, ни ключей — только строка;
 *   • из «кода плеера» (<iframe src="https://music.yandex.ru/iframe/#track/…">)
 *     и из ссылки на трек/альбом/плейлист/артиста Яндекса собирается ОДИН
 *     разрешённый адрес встроенного плеера: только https, только домен
 *     music.yandex.ru, только путь /iframe/ — всё прочее отбрасывается;
 *   • прямая ссылка на аудиофайл по-прежнему становится обычным треком;
 *   • адрес страницы (VK, YouTube, my.mail.ru, 101.ru…) треком не становится:
 *     человек получает объяснение простыми словами;
 *   • сервер хранит плейлисты как прежде (виджет — обычная запись списка),
 *     личные списки остаются шифротекстом: слепота не нарушена.
 * Запуск: node test/music88.mjs
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const MP = require(path.join(ROOT, 'public', 'music-paste.js'));

let good = 0, bad = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ПРОВАЛ: ') + m); if (c) good++; else bad++; };
const hex = (n = 16) => crypto.randomBytes(n).toString('hex');
const wait = ms => new Promise(r => setTimeout(r, ms));

async function call(base, p, opts = {}, token) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { ...opts, headers: h, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const ct = r.headers.get('content-type') || '';
  const buf = Buffer.from(await r.arrayBuffer());
  if (ct.includes('json')) { try { return { status: r.status, d: JSON.parse(buf.toString('utf8')) }; } catch (e) {} }
  return { status: r.status, d: buf.toString('utf8') };
}
async function waitReady(base) {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/api/state')).ok) return; } catch (e) {}
    await wait(200);
  }
  throw new Error('не поднялся ' + base);
}
async function freePort() {
  const { createServer } = await import('node:net');
  return new Promise(r => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
}
const procs = [];
process.on('exit', () => { for (const p of procs) { try { p.kill('SIGKILL'); } catch (e) {} } });

console.log('\n══════════════════════════════════════════════════');
console.log('  pkg3-88: умная вставка — код плеера и ссылки Яндекс.Музыки');
console.log('══════════════════════════════════════════════════\n');

// ────────────────────────── 1. Разбор «кода плеера» ──────────────────────────
const CODE = '<iframe frameborder="0" style="border:none;width:300px;height:180px;" width="300" height="180" '
  + 'src="https://music.yandex.ru/iframe/#track/67063213/"></iframe>';
let r = MP.parsePaste(CODE);
ok(r.kind === 'widget' && r.what === 'track' && r.url === 'https://music.yandex.ru/iframe/#track/67063213/',
  '«код плеера» от Яндекс.Музыки распознан: трек, адрес встроенного плеера собран');
ok(r.from === 'iframe' && r.h === 180 && /Яндекс\.Музыка · трек/.test(r.title || ''),
  'виджет помечен как «из кода», высота плеера и подпись по умолчанию подобраны');
r = MP.parsePaste(CODE.replace(/&/g, '&amp;').replace('<iframe', 'Вот код:\n<iframe'));
ok(r.kind === 'widget', 'код с HTML-экранированием (&amp;) и текстом вокруг тоже распознаётся');
r = MP.parsePaste('<iframe src="https://music.yandex.ru/iframe/#playlist/sasha.pilipenko/1016/light/"></iframe>');
ok(r.kind === 'widget' && r.what === 'playlist' && r.light === true
  && r.url === 'https://music.yandex.ru/iframe/#playlist/sasha.pilipenko/1016/light/',
  'плейлист в «светлом» оформлении: владелец и номер сохранены, light не потерялся');
r = MP.parsePaste('<iframe src="https://music.yandex.ru/iframe/#album/5736287/"></iframe>');
ok(r.kind === 'widget' && r.what === 'album' && r.h > 200, 'альбом распознан, рамка под него выше');
r = MP.parsePaste('<iframe src="https://www.youtube.com/embed/abc123"></iframe>');
ok(r.kind === 'page' && /другого сайта/.test(r.hint),
  'чужой плеер (YouTube) треком не становится — объясняем, что умеем только Яндекс');

// ────────────────────────── 2. Разбор ссылок ──────────────────────────
r = MP.parsePaste('https://music.yandex.ru/album/5736287/track/67063213');
ok(r.kind === 'widget' && r.what === 'track' && r.from === 'page'
  && r.url === 'https://music.yandex.ru/iframe/#track/67063213/'
  && r.orig === 'https://music.yandex.ru/album/5736287/track/67063213',
  'ссылка на трек Яндекса превращается в playable-виджет, исходная страница запомнена («↗ Яндекс»)');
r = MP.parsePaste('https://music.yandex.ru/album/5736287');
ok(r.kind === 'widget' && r.what === 'album', 'ссылка на альбом → встроенный плеер альбома');
r = MP.parsePaste('смотри https://music.yandex.ru/playlist/martin/7 !');
ok(r.kind === 'widget' && r.what === 'playlist' && r.ids.join('/') === 'martin/7',
  'ссылка на плейлист в тексте с восклицанием: лишнее отрезано, владелец и номер на месте');
r = MP.parsePaste('https://music.yandex.ru/artist/12345');
ok(r.kind === 'widget' && r.what === 'artist', 'ссылка на артиста → встроенный плеер артиста');
r = MP.parsePaste('HTTPS://MUSIC.YANDEX.RU/iframe/#track/5/');
ok(r.kind === 'widget' && r.url === 'https://music.yandex.ru/iframe/#track/5/',
  'регистр букв в адресе не мешает: ссылка приводится к каноническому https-виду');
r = MP.parsePaste('https://example.com/song.mp3');
ok(r.kind === 'file' && r.url === 'https://example.com/song.mp3', 'прямая ссылка на mp3 — обычный трек-файл');
r = MP.parsePaste('https://cdn.example.org/a/b/t.ogg?token=xyz');
ok(r.kind === 'file', 'файл .ogg с параметрами остаётся файлом');
r = MP.parsePaste('https://example.com/track.m4a#t=10');
ok(r.kind === 'file', 'файл .m4a с якорем остаётся файлом');

// ────────────────────────── 3. Страницы и мусор: честный отказ ──────────────────────────
for (const u of ['https://my.mail.ru/music/songs/aaa/bbb', 'https://vk.com/audio-123_456',
  'https://ru.hitmoz.org/song/123', 'https://skysound.org/song/1', 'https://101.ru/track/5']) {
  const x = MP.parsePaste(u);
  ok(x.kind === 'page' && /СТРАНИЦЫ/.test(x.hint) && /mp3/.test(x.hint),
    'адрес страницы (' + u.replace(/^https:\/\//, '').split('/')[0] + ') не становится треком — объяснение с подсказкой');
}
r = MP.parsePaste('https://skysound.org/a https://101.ru/b https://zvuки.com/c');
ok(r.kind === 'page', 'склейка из нескольких «нерабочих» ссылок разбирается без падения');
r = MP.parsePaste('https://music.yandex.ru/search?text=кино');
ok(r.kind === 'page' && /Код плеера/.test(r.hint),
  'страница Яндекса, из которой плеер не собирается (поиск), объясняет, где взять «код плеера»');
r = MP.parsePaste('http://example.com/song.mp3');
ok(r.kind === 'page' && /http:\/\//.test(r.hint), 'небезопасный http:// отклоняется с подсказкой');
r = MP.parsePaste('');
ok(r.kind === 'none' && r.hint.length > 5, 'пустое поле — подсказка, а не ошибка');
r = MP.parsePaste('привет, как дела?');
ok(r.kind === 'none', 'текст без ссылок распознаётся как «ничего»');
r = MP.parsePaste(null);
ok(r.kind === 'none', 'null вместо текста не роняет разбор');

// ────────────────────────── 4. Белый список: чужое не проходит ──────────────────────────
for (const evil of ['https://music.yandex.ru.evil.com/iframe/#track/1/',
  'https://evil.com/iframe/#track/1/', 'https://music.yandex.ru@evil.com/iframe/#track/1/',
  'javascript:alert(1)', 'data:text/html,<script>alert(1)</script>',
  'https://music.yandex.ru/iframe/../../etc/passwd']) {
  const x = MP.parsePaste(evil);
  ok(x.kind !== 'widget' && !(x.url || '').startsWith('javascript:'),
    'подмена не проходит как виджет: ' + evil.slice(0, 46));
}
ok(MP.widgetUrl('track', ['123'], false) === 'https://music.yandex.ru/iframe/#track/123/',
  'сборка адреса виджета всегда даёт https://music.yandex.ru/iframe/#…');
ok(MP.widgetUrl('track', ['12" onload="alert(1)'], false) === null
  && MP.widgetUrl('track', [''], false) === null && MP.widgetUrl('hack', ['1'], false) === null,
  'мусор в номере трека и неизвестный тип плеера отбрасываются (в разметку не попадут)');
ok(MP.parsePaste('<iframe src="' + 'https://music.yandex.ru/iframe/#track/1/'.replace('music.yandex.ru', 'music.yandex.ru%00.evil') + '"></iframe>').kind !== 'widget',
  'вставка нулевого байта в домен не превращается в виджет');

// ────────────────────────── 5. Сервер: плейлисты с виджетами ──────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sega-m88-'));
const port = await freePort();
const proc = spawn(process.execPath, ['server.js'], {
  cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
  env: Object.assign({}, process.env, {
    STORE: 'file', DATA_DIR: dir, HOST: '127.0.0.1', HTTPS: '', PRESENCE_EVERY: '0', NEW_INVITE_DELAY: '0',
    INVITE_COOLDOWN_MS: '0', PORT: String(port)
  })
});
procs.push(proc);
const base = `http://127.0.0.1:${port}`;
await waitReady(base);

const creds = name => ({ name, saltAuth: hex(), authKey: hex(32), saltWrap: hex(), wrappedKeyByPass: 'w:' + hex(), pub: 'pub:' + hex(), wrappedPriv: 'priv:' + hex() });
r = await call(base, '/api/setup', { method: 'POST', body: Object.assign({}, creds('Мартин'), { codeProofSalt: hex(), codeProof: hex(32), codeSalt: hex(), wrappedKeyByCode: 'k:' + hex() }) });
ok(r.status === 200, 'мессенджер настроен');
const admin = r.d.token, adminId = r.d.user.id;
r = await call(base, '/api/state');
ok(r.status === 200 && r.d.build === 'pkg3-88', 'сервер помечен pkg3-88');

const widgetTrack = {
  id: 't-w1', kind: 'widget', what: 'track',
  url: 'https://music.yandex.ru/iframe/#track/67063213/',
  page: 'https://music.yandex.ru/album/5736287/track/67063213',
  h: 180, title: 'Группа крови', cover: ''
};
const fileTrack = { id: 't-f1', url: 'https://example.com/a.mp3', title: 'Файл', cover: '' };
r = await call(base, '/api/music', { method: 'POST', body: { pub: [{ id: 'p1', name: 'Пуб', vis: 'pub', tracks: [widgetTrack, fileTrack] }], priv: 'ENC-ШИФРОТЕКСТ', key: 'KEY-WRAP' } }, admin);
ok(r.status === 200 && r.d.ok, 'список с виджетом и файлом сохранён');
r = await call(base, '/api/music', {}, admin);
ok(r.status === 200 && r.d.pub[0].tracks[0].kind === 'widget' && r.d.pub[0].tracks[0].what === 'track'
  && r.d.pub[0].tracks[0].h === 180 && r.d.pub[0].tracks[1].kind === undefined,
  'виджет переживает сохранение целиком (род, тип, высота), старый трек-файл не меняется');
ok(r.d.priv === 'ENC-ШИФРОТЕКСТ' && r.d.key === 'KEY-WRAP',
  'личный список по-прежнему лежит шифротекстом, ключ — обёрнутым: сервер слеп');

// второй участник: видит чужой публичный список с виджетом, личного — не видит
const secret = hex(24);
const sha = crypto.createHash('sha256').update(secret).digest('hex');
let ir = await call(base, '/api/invites', { method: 'POST', body: { invSalt: hex(), wrappedRoomKey: 'k:' + hex(), secretHash: sha } }, admin);
r = await call(base, '/api/register', { method: 'POST', body: Object.assign({}, creds('Вася'), { inviteToken: ir.d.invite.id + '.' + secret }) });
ok(r.status === 200 && r.d.token, 'второй участник готов');
const v1 = r.d.token;
r = await call(base, '/api/music/' + adminId, {}, v1);
ok(r.status === 200 && r.d.pub.length === 1 && r.d.pub[0].tracks[0].kind === 'widget' && r.d.priv === undefined && r.d.key === undefined,
  'у чужого аватара виджет виден (публичный список), личный список и ключ — нет');
r = await call(base, '/api/music/' + 'нет-такого', {}, v1);
ok(r.status === 404, 'запрос музыки несуществующего участника отдаёт 404, а не чужое');

// ────────────────────────── 6. Метки клиента ──────────────────────────
const appJs = readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const indexHtml = readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const css = readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
const sw = readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
ok(indexHtml.includes('<script src="music-paste.js"></script>')
  && indexHtml.indexOf('music-paste.js') < indexHtml.indexOf('src="app.js"'),
  'модуль разбора подключён в index.html раньше клиента');
ok(appJs.includes('function musicParsePaste(') && appJs.includes('r.kind === \'widget\''),
  'добавление трека идёт через разбор: виджет, файл или объяснение');
ok(appJs.includes('function musicPlayWidget(') && appJs.includes('function musWidgetShow(')
  && appJs.includes('function musWidgetStop('),
  'виджет играет отдельной панелью с кнопкой «■ стоп»');
ok(appJs.includes("f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-forms allow-popups-to-escape-sandbox')"),
  'чужой плеер закрыт в «песочнице»: свой код приложения он тронуть не может');
ok(appJs.includes('const on = !MUS.widget && !!'), 'статус «🎵 слушает» виджет не транслирует');
ok(appJs.includes('Это встроенный плеер Яндекс.Музыки: запустить его у собеседника с той же секунды нельзя'),
  '«🎧 вместе» для виджета объясняет отказ простыми словами');
ok(appJs.includes('data-musof-kind') && appJs.includes('musicPlayOnce(b.getAttribute(\'data-musof-url\'), b.getAttribute(\'data-musof-title\'), 0, b.getAttribute(\'data-musof-kind\'))'),
  'чужой публичный трек-виджет включается тем же встроенным плеером');
ok(appJs.includes('mus-badge-y') && appJs.includes('↗ Яндекс'),
  'в списке треков виджет помечен значком «Я» и ссылкой «↗ Яндекс»');
ok(appJs.includes('MUS.plId = null; musWidgetHide(); musicFabSync();')
  && appJs.includes('if (musicIsWidget(gone) && MUS.widget && MUS.widget.id === gone.id) musWidgetStop();'),
  'удаление плейлиста или звучащего виджета гасит панель — чужой плеер не играет «без хозяина»');
ok(appJs.includes('id="mus-add-hint"') && appJs.includes('Вставьте: код плеера Яндекс.Музыки'),
  'поле добавления подсказывает, что можно вставить');
ok(css.includes('.mus-widget{') && css.includes('.mus-badge-y{') && css.includes('.mus-player.widget-mode #mus-seek'),
  'панель, значок и виджет-режим плеера оформлены в стилях');
ok(sw.includes("const STATIC_CACHE = 'sega-static-v81';"), 'кэш статики поднят до v81 — друзья получат новый клиент');
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
ok(pkg.scripts.test.includes('test/music88.mjs'), 'тест pkg3-88 включён в общую цепочку проверки');

console.log('\n  итог: ' + good + ' ✓, ' + bad + ' провалов');
process.exit(bad ? 1 : 0);
