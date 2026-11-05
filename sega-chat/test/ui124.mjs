// test/ui124.mjs — pkg3-124: «Мои диски».
//
// Просьба владельца: любой участник подключает СВОЙ диск; диск живёт отдельным
// разделом «☁ Мои диски» в самом низу списка чатов (а не спрятан в «Плейлисты ▾»
// окна музыки); подключение — из меню «+»; с файлами можно работать: слушать,
// смотреть фото и видео, скачивать, открывать доступ участникам чата и
// отправлять ссылку в чат.
//
// Здесь проверяется серверная часть (на живом сервере с игрушечным Яндексом) и
// разметка/оформление клиента. Вид глазами проверяет владелец — браузера в
// песочнице нет.
import { BUILD } from './build.mjs';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let good = 0, bad = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ПРОВАЛ: ') + m); if (c) good++; else bad++; };
const hex = (n = 16) => crypto.randomBytes(n).toString('hex');
const wait = ms => new Promise(r => setTimeout(r, ms));

console.log('\n══════════════════════════════════════════════════');
console.log('  pkg3-124: «Мои диски» — раздел, проводник,');
console.log('            доступ к файлам для участников чата');
console.log('══════════════════════════════════════════════════\n');

// ─────────────── игрушечный Яндекс.Диск ───────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sega-m124-'));
const keysPath = path.join(dir, 'yandex-oauth.json');
fs.writeFileSync(keysPath, JSON.stringify({ client_id: 'ID124', client_secret: 'SECRET124' }));

const ROOT_ITEMS = [
  { name: 'Музыка', path: 'disk:/Музыка', type: 'dir' },
  { name: 'Фото', path: 'disk:/Фото', type: 'dir' },
  { name: 'song.mp3', path: 'disk:/song.mp3', type: 'file', size: 3145728, mime_type: 'audio/mpeg', media_type: 'audio' },
  { name: 'beach.jpg', path: 'disk:/beach.jpg', type: 'file', size: 204800, mime_type: 'image/jpeg', media_type: 'image' },
  { name: 'clip.mp4', path: 'disk:/clip.mp4', type: 'file', size: 9437184, mime_type: 'video/mp4', media_type: 'video' },
  { name: 'договор.pdf', path: 'disk:/договор.pdf', type: 'file', size: 120000, mime_type: 'application/pdf', media_type: 'document' }
];

const mock = http.createServer((rq, rs) => {
  const u = new URL(rq.url, 'http://mock');
  const jsend = (code, obj) => { rs.writeHead(code, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify(obj)); };
  if (rq.method === 'GET' && u.pathname === '/v1/disk/resources/files') {
    // используется для проверки токена (listAudio)
    return jsend(200, { items: ROOT_ITEMS.filter(x => x.media_type === 'audio') });
  }
  if (rq.method === 'GET' && u.pathname === '/v1/disk/resources') {
    const p = String(u.searchParams.get('path') || 'disk:/');
    const items = p === 'disk:/'
      ? ROOT_ITEMS
      : p === 'disk:/Фото'
        ? [{ name: 'beach.jpg', path: 'disk:/Фото/beach.jpg', type: 'file', size: 204800, mime_type: 'image/jpeg', media_type: 'image' }]
        : [];
    return jsend(200, { path: p, type: 'dir', _embedded: { items, total: items.length } });
  }
  if (rq.method === 'GET' && u.pathname === '/v1/disk/resources/download') {
    const p = String(u.searchParams.get('path') || '');
    return jsend(200, { href: 'https://mock-cdn.yandex.net/get/' + encodeURIComponent(p) + '?sig=124', ttl: '1800' });
  }
  jsend(404, {});
});
await new Promise(r => mock.listen(0, '127.0.0.1', r));
const mockBase = 'http://127.0.0.1:' + mock.address().port;

async function freePort() {
  const { createServer } = await import('node:net');
  return new Promise(r => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
}
const procs = [];
process.on('exit', () => { for (const p of procs) { try { p.kill('SIGKILL'); } catch (e) {} } try { mock.close(); } catch (e) {} });

const port = await freePort();
const proc = spawn(process.execPath, ['server.js'], {
  cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
  env: Object.assign({}, process.env, {
    STORE: 'file', DATA_DIR: path.join(dir, 'data'), HOST: '127.0.0.1', HTTPS: '', PRESENCE_EVERY: '0',
    NEW_INVITE_DELAY: '0', INVITE_COOLDOWN_MS: '0', PORT: String(port),
    YADISK_OAUTH_BASE: mockBase, YADISK_API_BASE: mockBase,
    YADISK_KEYS: keysPath, YADISK_REDIRECT: 'http://127.0.0.1:' + port + '/api/yadisk/callback'
  })
});
procs.push(proc);
const base = 'http://127.0.0.1:' + port;
for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/api/state')).ok) break; } catch (e) {} await wait(200); }

async function call(p, opts = {}, token) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { ...opts, headers: h, body: opts.body ? JSON.stringify(opts.body) : undefined });
  let d = null;
  try { d = await r.json(); } catch (e) {}
  return { status: r.status, d };
}
const creds = name => ({ name, saltAuth: hex(), authKey: hex(32), saltWrap: hex(), wrappedKeyByPass: 'w:' + hex(), pub: 'pub:' + hex(), wrappedPriv: 'priv:' + hex() });

let r = await call('/api/setup', { method: 'POST', body: Object.assign({}, creds('Владелец'), { codeProofSalt: hex(), codeProof: hex(32), codeSalt: hex(), wrappedKeyByCode: 'k:' + hex() }) });
ok(r.status === 200, 'мессенджер настроен');
const admin = r.d.token;
const join = async (name) => {
  const secret = hex(24);
  const sha = crypto.createHash('sha256').update(secret).digest('hex');
  const ir = await call('/api/invites', { method: 'POST', body: { invSalt: hex(), wrappedRoomKey: 'k:' + hex(), secretHash: sha } }, admin);
  const rr = await call('/api/register', { method: 'POST', body: Object.assign({}, creds(name), { inviteToken: ir.d.invite.id + '.' + secret }) });
  return { token: rr.d.token, id: rr.d.user.id };
};
const A = await join('Вася');    // у него свой Диск
const B = await join('Клава');   // в общем чате с Васей
const C = await join('Гость');   // посторонний
r = await call('/api/dm', { method: 'POST', body: { peer: B.id } }, A.token);
ok(r.status === 200, 'личный чат Вася↔Клава создан');

console.log('\n  1. Подключение и список «Мои диски»');
const TOK = 'y0_AgAAAAB124token-with-dots_and-dashes';
r = await call('/api/yadisk/token', { method: 'POST', body: { token: TOK } }, A.token);
ok(r.status === 200 && r.d.connected === true, 'Диск подключён вставленным токеном (без модерации Яндекса)');
r = await call('/api/drives', {}, A.token);
ok(r.status === 200 && Array.isArray(r.d.drives) && r.d.drives.length >= 1, '«Мои диски» отдают список (а не один флаг) — второй диск лёг сюда же в 126-м');
ok(r.d.drives[0].id === 'yandex' && r.d.drives[0].connected === true, 'яндекс-диск в списке и подключён');
ok(r.d.drives[0].manual === true, 'видно, что подключён токеном');
ok(Array.isArray(r.d.drives) && r.d.drives.some(x => x.id === 'google'), 'Google стал вторым диском списка (в 126-м; раньше был «скоро»)');
r = await call('/api/drives', {}, B.token);
ok(r.d.drives[0].connected === false, 'у Клавы свой диск ещё не подключён — и это видно честно');

console.log('\n  2. Проводник: папки и файлы любых типов');
r = await call('/api/yadisk/list?path=' + encodeURIComponent('disk:/'), {}, A.token);
ok(r.status === 200 && Array.isArray(r.d.items) && r.d.items.length === 6, 'корень Диска прочитан (6 записей)');
ok(r.d.items[0].dir === true && r.d.items[1].dir === true, 'папки идут первыми (как в проводнике)');
const byName = n => r.d.items.find(x => x.name === n) || {};
ok(byName('song.mp3').media === 'audio', 'музыка распознана (media=audio)');
ok(byName('beach.jpg').media === 'image', 'фото распознано (media=image)');
ok(byName('clip.mp4').media === 'video', 'видео распознано (media=video)');
ok(byName('договор.pdf').media === 'doc', 'документ распознан (media=doc)');
r = await call('/api/yadisk/list?path=' + encodeURIComponent('disk:/Фото'), {}, A.token);
ok(r.status === 200 && r.d.items.length === 1 && r.d.items[0].path === 'disk:/Фото/beach.jpg', 'вложенная папка открывается');
r = await call('/api/yadisk/list?path=' + encodeURIComponent('disk:/a/../b'), {}, A.token);
ok(r.status === 400, 'путь с «..» отбрасывается');
r = await call('/api/yadisk/list?path=' + encodeURIComponent('disk:/'), {}, B.token);
ok(r.status === 409, 'чужой Диск целиком не читается — только поштучно и только открытое');

console.log('\n  3. Свой файл: временная ссылка и скачивание');
r = await call('/api/yadisk/file?path=' + encodeURIComponent('disk:/beach.jpg'), {}, A.token);
ok(r.status === 200 && String(r.d.href).startsWith('https://mock-cdn.yandex.net/'), 'своя ссылка выдана');
ok(r.d.media === '' || typeof r.d.media === 'string', 'в ответе есть поле media (клиент решает, как открывать)');

console.log('\n  4. «В чат»: доступ участникам и запреты');
r = await call('/api/yadisk/file?of=' + A.id + '&path=' + encodeURIComponent('disk:/beach.jpg'), {}, B.token);
ok(r.status === 404, 'пока файл не открыт — участник ссылку не получает');
r = await call('/api/yadisk/share-file', { method: 'POST', body: { path: 'disk:/beach.jpg', name: 'beach.jpg', media: 'image', size: 204800 } }, A.token);
ok(r.status === 200 && r.d.shared === 1, 'владелец открыл файл участникам («В чат»)');
r = await call('/api/yadisk/file?of=' + A.id + '&path=' + encodeURIComponent('disk:/beach.jpg'), {}, B.token);
ok(r.status === 200 && String(r.d.href).includes('beach.jpg'), 'участник общего чата получает свежую ссылку');
ok(r.d.name === 'beach.jpg' && r.d.media === 'image', 'в карточке есть имя и тип файла');
r = await call('/api/yadisk/file?of=' + A.id + '&path=' + encodeURIComponent('disk:/beach.jpg'), {}, C.token);
ok(r.status === 404, 'посторонний (нет общего чата) доступа не получает');
r = await call('/api/yadisk/file?of=' + A.id + '&path=' + encodeURIComponent('disk:/song.mp3'), {}, B.token);
ok(r.status === 404, 'остальные файлы Диска закрыты (не открывали — не отдаём)');
r = await call('/api/yadisk/file?of=' + A.id + '&path=' + encodeURIComponent('disk:/a/../b'), {}, B.token);
ok(r.status === 400, 'кривой путь отбрасывается и здесь');
r = await call('/api/yadisk/unshare-file', { method: 'POST', body: { path: 'disk:/beach.jpg' } }, A.token);
ok(r.status === 200 && r.d.shared === 0, 'доступ к файлу закрывается');
r = await call('/api/yadisk/file?of=' + A.id + '&path=' + encodeURIComponent('disk:/beach.jpg'), {}, B.token);
ok(r.status === 404, 'после закрытия участник ссылку не получает');
await call('/api/yadisk/share-file', { method: 'POST', body: { path: 'disk:/beach.jpg', name: 'beach.jpg', media: 'image' } }, A.token);

console.log('\n  5. Общий тумблер «другие видят мой Диск»');
r = await call('/api/yadisk/share', { method: 'POST', body: { share: false } }, A.token);
ok(r.status === 200 && r.d.share === false, 'тумблер выключен');
r = await call('/api/yadisk/file?of=' + A.id + '&path=' + encodeURIComponent('disk:/beach.jpg'), {}, B.token);
ok(r.status === 403, 'при выключенном тумблере доступа нет даже к открытому файлу');
r = await call('/api/yadisk/file?of=' + A.id + '&path=' + encodeURIComponent('disk:/beach.jpg'), {}, A.token);
ok(r.status === 200, 'сам владелец свой файл получает всегда');
await call('/api/yadisk/share', { method: 'POST', body: { share: true } }, A.token);

console.log('\n  6. Клиент: раздел, меню «+», окно диска, карточка в чате');
const appJs = read('public/app.js');
const css = read('public/styles.css');
const html = read('public/index.html');
ok(/data-plus="disk"/.test(html) && /Подключить диск/.test(html), 'в меню «+» есть пункт «Подключить диск»');
ok(/if \(act === 'disk'\) return driveConnectAsk\(\);/.test(appJs), 'пункт меню открывает окно подключения');
ok(/foldHead\('drives', '☁ Мои диски', \[\]\)/.test(appJs), 'раздел «☁ Мои диски» объявлен в списке чатов');
ok(/drivesRailRows\(\)/.test(appJs) && /data-drive-add="1"/.test(appJs), 'в разделе есть строки дисков и «Подключить»');
ok(/function drivesRailRows[\s\S]{0,600}drive-item/.test(appJs), 'строки оформлены как элементы списка чатов');
ok(appJs.indexOf("html += foldHead('drives'") > appJs.indexOf("for (const sn of (S.sections || []))"),
  'раздел стоит НИЖЕ всех чатов и своих разделов (в самом низу)');
ok(/async function diskBrowse\(path, of\)/.test(appJs) && /api\/yadisk\/list\?path=/.test(appJs), 'окно-проводник читает папки через новый маршрут');
ok(/data-disk-go="disk:\/"/.test(appJs) && /diskCrumbsHtml/.test(appJs), 'есть хлебные крошки и возврат в корень');
ok(/data-disk-play/.test(appJs) && /data-disk-view/.test(appJs) && /data-disk-dl/.test(appJs), 'у файлов есть «Слушать», «Смотреть», «Скачать»');
ok(/data-disk-send/.test(appJs) && /diskSendAsk/.test(appJs) && /data-dsk-act="share"/.test(appJs) && /Поделиться/.test(appJs), 'у файла есть кнопка «Поделиться» (бывшее «В чат»)');
ok(/async function diskSendToChat\(/.test(appJs) && /api\/yadisk\/share-file/.test(appJs), 'перед отправкой сервер открывает доступ именно к этому файлу');
ok(/async function quickSend\(/.test(appJs) && /encryptJSON\(k\.key, payload\)/.test(appJs), 'письмо со ссылкой шифруется ключом чата, как обычное');
ok(/sega-disk:\/\//.test(appJs) && /function diskLinkParse/.test(appJs), 'ссылка на файл — свой формат, сервер её не читает');
ok(/function diskEmbedHtml[\s\S]{0,1600}data-disk-act="open"/.test(appJs) && /data-disk-act="save"/.test(appJs), 'в переписке ссылка превращается в карточку «Открыть / Скачать»');
ok(/\$\{ymEmbedHtml\(p\.text\)\}\$\{diskEmbedHtml\(p\.text\)\}/.test(appJs), 'карточка рисуется и в ленте, и в открытом письме');
ok(/if \(S\.eco\) return ''/.test(appJs), 'в экономном режиме карточка не рисуется (текст со ссылкой остаётся)');
ok(/function diskToPlaylist\(/.test(appJs) && /musAskPlaylist\(\{ kind: 'disk'/.test(appJs), 'файл можно положить в свой плейлист');
ok(/video class="disk-prev"/.test(appJs) && /img class="disk-prev"/.test(appJs), 'фото и видео открываются в окне, а не только скачиваются');
ok(/DriveConnectAsk|driveTokenAsk/.test(appJs) && /function driveTokenAsk/.test(appJs), 'подключение по токену доступно прямо из раздела');
ok(/drivesLoad\(\)\.catch/.test(appJs), 'список дисков читается при входе');
ok(/\.disk-row\{/.test(css) && /\.disk-embed\{/.test(css) && /\.drive-ic\{/.test(css), 'оформление раздела, проводника и карточки на месте');
ok(/@media \(max-width:900px\)\{[\s\S]{0,300}\.disk-list\{max-height:44vh\}/.test(css), 'на телефоне у проводника своя высота');
ok(read('lib/yadisk.js').includes('async function listFolder('), 'сервер: listFolder читает папку любого типа');
ok(read('lib/api.js').includes("'/api/yadisk/list'") && read('lib/api.js').includes("'/api/yadisk/file'")
  && read('lib/api.js').includes("'/api/yadisk/share-file'") && read('lib/api.js').includes("'/api/drives'"),
  'сервер: все четыре новых маршрута на месте');

console.log('\n  7. Отметки выпуска');
const b2 = (/const BUILD = '([^']+)'/.exec(appJs) || [])[1];
const cache = (/const STATIC_CACHE = '([^']+)'/.exec(read('public/sw.js')) || [])[1];
ok(b2 === BUILD, `отметка выпуска в клиенте и в тестах одна (${BUILD})`);
ok(((/const BUILD = '([^']+)'/.exec(read('lib/api.js')) || [])[1]) === BUILD, 'BUILD в lib/api.js тот же');
ok(new RegExp('\\| ' + BUILD + ' \\|').test(read('README.md')), `в журнале README есть строка ${BUILD}`);
ok(cache === 'sega-static-v122', `кэш оформления поднят (${cache}) — устройства получат новые окна`);
ok(read('package.json').includes('node test/ui124.mjs'), 'тест ui124 включён в цепочку npm test');

console.log(`\n  ИТОГ: ${good} ✓, ${bad ? bad + ' провалов' : 'провалов нет'}\n`);
process.exit(bad ? 1 : 0);   // тест держит живой сервер и игрушечный Яндекс — выходим сами
