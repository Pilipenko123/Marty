// test/ui127.mjs — pkg3-146: Google Диск внутри «Моей музыки».
//
// Что проверяем на живом сервере с игрушечным Google:
//   • «🅖 Google Диск» — такой же список треков, как у Яндекса
//     (`GET /api/yadisk/files?drive=google`);
//   • трек с Google запускается по нашему пропуску (`/api/yadisk/href`);
//   • трек в плейлисте играет и потом: `kind: 'disk'` + путь `google:/<id>`;
//   • трек с ЧУЖОГО Google играет только из открытого файла или открытой папки;
//   • синхрон: якорь `google:/…` больше не отбрасывается, а `/api/music/follow-href`
//     выдаёт догоняющему свежий пропуск;
//   • клиент: пункт «🅖 Google Диск», переключатель дисков, значок 🅖 у трека.
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
console.log('  pkg3-146: Google Диск в «Моей музыке»');
console.log('══════════════════════════════════════════════════\n');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sega-m127-'));
const keysPath = path.join(dir, 'google-oauth.json');
fs.writeFileSync(keysPath, JSON.stringify({ client_id: 'cid127.apps.googleusercontent.com', client_secret: 'sec127' }));

const FOLDER_ID = 'fold127abc';
const SONG_ID = 'song127abc';
const SONG2_ID = 'song127xyz';
const PHOTO_ID = 'photo127abc';
const FILES = [
  { id: FOLDER_ID, name: 'Музыка', mimeType: 'application/vnd.google-apps.folder', parents: ['root'] },
  { id: SONG_ID, name: 'В дороге.mp3', mimeType: 'audio/mpeg', size: '3145728', parents: [FOLDER_ID] },
  { id: SONG2_ID, name: 'Второй трек.mp3', mimeType: 'audio/mpeg', size: '1048576', parents: [FOLDER_ID] },
  { id: PHOTO_ID, name: 'beach.jpg', mimeType: 'image/jpeg', size: '204800', parents: [FOLDER_ID] }
];

const mock = http.createServer((rq, rs) => {
  const u = new URL(rq.url, 'http://mock');
  const jsend = (code, obj) => { rs.writeHead(code, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify(obj)); };
  if (rq.method === 'POST' && u.pathname === '/token') {
    return jsend(200, { access_token: 'at127', refresh_token: 'rt127', expires_in: 3600, token_type: 'Bearer' });
  }
  if (u.pathname === '/drive/v3/about') return jsend(200, { storageQuota: { limit: '1000', usage: '10' } });
  if (rq.method === 'GET' && u.pathname === '/drive/v3/files') {
    const q = String(u.searchParams.get('q') || '');
    if (q.includes("mimeType contains 'audio/'")) return jsend(200, { files: FILES.filter(f => f.mimeType.startsWith('audio/')) });
    const m = /'([^']+)' in parents/.exec(q);
    const parent = m ? m[1] : 'root';
    return jsend(200, { files: FILES.filter(f => f.parents[0] === parent) });
  }
  const fm = /^\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname);
  if (fm) {
    const id = fm[1];
    if (u.searchParams.get('alt') === 'media') {
      const body = 'SOUND-' + id;
      rs.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': String(body.length), 'Accept-Ranges': 'bytes' });
      return rs.end(body);
    }
    const f = FILES.find(x => x.id === id) || { id, name: 'файл', mimeType: 'application/octet-stream', size: '10', parents: ['root'] };
    return jsend(200, { id: f.id, name: f.name, mimeType: f.mimeType, size: f.size, parents: f.parents });
  }
  jsend(404, { error: { message: 'не найдено' } });
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
const base = 'http://127.0.0.1:' + port;
const proc = spawn(process.execPath, ['server.js'], {
  cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
  env: Object.assign({}, process.env, {
    STORE: 'file', DATA_DIR: path.join(dir, 'data'), HOST: '127.0.0.1', HTTPS: '', PRESENCE_EVERY: '0',
    NEW_INVITE_DELAY: '0', INVITE_COOLDOWN_MS: '0', PORT: String(port),
    GDRIVE_AUTH_BASE: mockBase, GDRIVE_TOKEN_BASE: mockBase, GDRIVE_API_BASE: mockBase,
    GDRIVE_KEYS: keysPath, GDRIVE_REDIRECT: base + '/api/gdrive/callback'
  })
});
procs.push(proc);
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
const admin = r.d.token;
const join = async (name) => {
  const secret = hex(24);
  const sha = crypto.createHash('sha256').update(secret).digest('hex');
  const ir = await call('/api/invites', { method: 'POST', body: { invSalt: hex(), wrappedRoomKey: 'k:' + hex(), secretHash: sha } }, admin);
  const rr = await call('/api/register', { method: 'POST', body: Object.assign({}, creds(name), { inviteToken: ir.d.invite.id + '.' + secret }) });
  return { token: rr.d.token, id: rr.d.user.id };
};
const A = await join('Вася');
const K = await join('Клава');
const G = await join('Гость');
await call('/api/dm', { method: 'POST', body: { peer: K.id } }, A.token);

// вход в Google за Васю
r = await call('/api/gdrive/auth', {}, A.token);
const state = (new URL(r.d.url)).searchParams.get('state');
const cb = await fetch(base + '/api/gdrive/callback?state=' + encodeURIComponent(state) + '&code=c127');
const cbBody = await cb.text();
ok(/Google Диск подключён!/.test(cbBody), 'Google подключён у Васи (для проверки музыки)');

console.log('\n  1. Список треков Google для «Моей музыки»');
r = await call('/api/yadisk/files?drive=google&limit=200', {}, A.token);
ok(r.status === 200 && Array.isArray(r.d.items), 'список аудиофайлов Google отдаётся');
ok(r.d.items.length === 2, 'в списке только музыка (два трека), папки и фото не попали');
ok(r.d.items.every(x => String(x.path).startsWith('google:/')), 'пути треков — google:/<id>');
ok(r.d.items.every(x => x.media === 'audio'), 'все записи помечены как музыка');
r = await call('/api/yadisk/files?drive=google&limit=200', {}, K.token);
ok(r.status === 409, 'у кого Google не подключён — честный отказ, а не пустой список');

console.log('\n  2. Трек с Google играет и живёт в плейлисте');
r = await call('/api/yadisk/href?path=' + encodeURIComponent('google:/' + SONG_ID), {}, A.token);
ok(r.status === 200 && String(r.d.href || '').startsWith('/api/gdrive/stream?t='), 'запуск трека даёт наш пропуск (как в проводнике)');
const up = await fetch(base + r.d.href);
const body = await up.text();
ok(up.status === 200 && body === 'SOUND-' + SONG_ID, 'по пропуску приходят настоящие байты файла');
ok(!String(r.d.href).includes('access_token'), 'токен Google в адрес не попадает');
r = await call('/api/yadisk/href?path=' + encodeURIComponent('google:/НЕТ'), {}, A.token);
ok(r.status === 400, 'кривой путь Google — понятный отказ');
r = await call('/api/yadisk/href?path=' + encodeURIComponent('google:/' + SONG_ID), {}, K.token);
ok(r.status === 409, 'без своего Google трек не запустить');

console.log('\n  3. Чужой Google: только по открытому');
r = await call('/api/yadisk/shared-href?of=' + A.id + '&path=' + encodeURIComponent('google:/' + SONG_ID), {}, K.token);
ok(r.status === 404, 'закрытый файл чужого Google не играет');
r = await call('/api/yadisk/share-file', { method: 'POST', body: { path: 'google:/' + FOLDER_ID, name: 'Музыка', kind: 'folder' } }, A.token);
ok(r.status === 200, 'Вася открыл папку «Музыка» участникам чата');
r = await call('/api/yadisk/shared-href?of=' + A.id + '&path=' + encodeURIComponent('google:/' + SONG_ID), {}, K.token);
ok(r.status === 200 && String(r.d.href || '').includes('/api/gdrive/stream'), 'трек внутри открытой папки играет у Клавы');
r = await call('/api/yadisk/shared-href?of=' + A.id + '&path=' + encodeURIComponent('google:/' + SONG_ID), {}, G.token);
ok(r.status === 404, 'посторонний (не из чата) не играет');

console.log('\n  4. Синхрон с трека Google');
r = await call('/api/typing', { method: 'POST', body: { kind: 'music', note: 'Слушаю Google', sync: { kind: 'disk', path: 'google:/' + SONG_ID, title: 'В дороге.mp3', pos: 12, at: Date.now(), playing: true } } }, A.token);
ok(r.status === 200, 'сервер принимает якорь синхрона с Google (раньше отбрасывал)');
r = await call('/api/music/status?of=' + A.id, {}, K.token);
ok(r.status === 200 && r.d.sync && r.d.sync.kind === 'disk' && r.d.sync.path === 'google:/' + SONG_ID, 'Клава видит, что Вася слушает трек с Google');
r = await call('/api/music/follow-href?owner=' + A.id + '&path=' + encodeURIComponent('google:/' + SONG_ID), {}, K.token);
ok(r.status === 200 && String(r.d.href || '').includes('/api/gdrive/stream'), 'догоняющий получает свежий пропуск на трек Google');
const up2 = await fetch(base + r.d.href);
ok((await up2.text()) === 'SOUND-' + SONG_ID, 'и этот пропуск тоже отдаёт звук');
r = await call('/api/music/follow-href?owner=' + A.id + '&path=' + encodeURIComponent('google:/' + SONG_ID), {}, G.token);
ok(r.status === 404, 'посторонний синхрон не подсматривает');
r = await call('/api/typing', { method: 'POST', body: { kind: 'music', note: '', sync: { kind: 'disk', path: 'google:/../../etc', pos: 0 } } }, A.token);
r = await call('/api/music/status?of=' + A.id, {}, K.token);
ok(r.status === 200 && !r.d.sync, 'путь с «..» в якорь не проходит (защита на месте)');

console.log('\n  5. Клиент: пункт в «Моей музыке»');
const appJs = read('public/app.js');
ok(/const MUS_GDISK = 'gdisk'/.test(appJs), 'у Google свой «псевдоплейлист» в «Моей музыке»');
ok(/data-mus-pl="gdisk"/.test(appJs) && /🅖 Google Диск/.test(appJs), 'в «Плейлисты ▾» появился пункт «🅖 Google Диск»');
ok(/drive=google/.test(appJs) && /\/api\/yadisk\/files\?limit=200&offset=/.test(appJs), 'список треков просится с нужного диска');
ok(/mus-gdisk-sw/.test(appJs) && /mus-gdisk-go/.test(appJs), 'между Яндексом и Google можно переключаться прямо в окне');
ok(/Google Диск не подключён\./.test(appJs) && /mus-gdisk-go/.test(appJs), 'если не подключён — окно говорит, что нажать');
ok(/🅖 диск/.test(appJs), 'в строке трека видно, что он с Google, а не с Яндекса');

console.log('\n  6. Отметки выпуска');
const b2 = (/const BUILD = '([^']+)'/.exec(appJs) || [])[1];
const cache = (/const STATIC_CACHE = '([^']+)'/.exec(read('public/sw.js')) || [])[1];
ok(b2 === BUILD && /^pkg3-1\d\d$/.test(BUILD), `отметка выпуска в клиенте и в тестах одна (${BUILD})`);
ok(((/const BUILD = '([^']+)'/.exec(read('lib/api.js')) || [])[1]) === BUILD, 'BUILD в lib/api.js тот же');
ok(/\| pkg3-146 \|/.test(read('README.md')), `в журнале README есть строка ${BUILD}`);
ok(cache === 'sega-static-v142', `кэш оформления поднят (${cache}) — устройства получат новые окна`);
ok(read('package.json').includes('node test/ui127.mjs'), 'тест ui127 включён в цепочку npm test');

console.log(`\n  ИТОГ: ${good} ✓, ${bad ? bad + ' провалов' : 'провалов нет'}\n`);
process.exit(bad ? 1 : 0);
