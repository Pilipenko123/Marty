// test/ui126.mjs — pkg3-139: Google Диск как второй диск.
//
// Проверяем по-настоящему, на живом сервере с игрушечным Google:
//   • без ключей приложения — честное «нужны ключи», а не пустое окно;
//   • вход через Google (код → токен), диск появляется в «Моих дисках»;
//   • папки и файлы с превью, свободное место из about;
//   • файл идёт через сервер по подписанному пропуску, Range проходит;
//   • папку с Google можно «Поделиться» — участник только смотрит;
//   • менять в Google нельзя (409), и это сказано словами.
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
console.log('  pkg3-139: Google Диск — второй диск, вход и права');
console.log('══════════════════════════════════════════════════\n');

// ─────────────── игрушечный Google ───────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sega-m126-'));
const keysPath = path.join(dir, 'google-oauth.json');
fs.writeFileSync(keysPath, JSON.stringify({ client_id: 'cid126.apps.googleusercontent.com', client_secret: 'sec126' }));

const ROOT_ID = 'root123';
const FOLDER_ID = 'fold126abc';
const PHOTO_ID = 'photo126abc';
const SONG_ID = 'song126abc';
const DOC_ID = 'doc126abc';

const ROOT_FILES = [
  { id: FOLDER_ID, name: 'Фото', mimeType: 'application/vnd.google-apps.folder', modifiedTime: '2026-11-01T10:00:00Z' },
  { id: PHOTO_ID, name: 'beach.jpg', mimeType: 'image/jpeg', size: '204800', thumbnailLink: 'https://lh3.googleusercontent.com/thumb/photo126=s256', modifiedTime: '2026-11-01T10:00:00Z' },
  { id: SONG_ID, name: 'song.mp3', mimeType: 'audio/mpeg', size: '3145728', modifiedTime: '2026-11-01T10:00:00Z' },
  { id: DOC_ID, name: 'заметка', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-11-01T10:00:00Z' }
];
const FOLDER_FILES = [ROOT_FILES[1]];

let tokenCalls = 0;
let rangeSeen = '';

const mock = http.createServer((rq, rs) => {
  const u = new URL(rq.url, 'http://mock');
  const jsend = (code, obj) => { rs.writeHead(code, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify(obj)); };
  if (rq.method === 'POST' && u.pathname === '/token') {
    tokenCalls++;
    return jsend(200, { access_token: 'at-' + tokenCalls, refresh_token: 'rt-1', expires_in: 3600, token_type: 'Bearer' });
  }
  if (u.pathname === '/drive/v3/about') {
    return jsend(200, { storageQuota: { limit: '16106127360', usage: '5368709120' } });
  }
  if (rq.method === 'GET' && u.pathname === '/drive/v3/files') {
    const m = /'([^']+)' in parents/.exec(String(u.searchParams.get('q') || ''));
    const parent = m ? m[1] : 'root';
    return jsend(200, { files: parent === 'root' || parent === ROOT_ID ? ROOT_FILES : FOLDER_FILES });
  }
  const fm = /^\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname);
  if (fm) {
    const id = fm[1];
    if (u.searchParams.get('alt') === 'media') {
      const body = 'BYTES-' + id;
      const range = String(rq.headers.range || '');
      if (range) {
        rangeSeen = range;
        rs.writeHead(206, { 'Content-Type': 'application/octet-stream', 'Content-Range': 'bytes 0-3/' + body.length, 'Content-Length': '4', 'Accept-Ranges': 'bytes' });
        return rs.end(body.slice(0, 4));
      }
      rs.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.length), 'Accept-Ranges': 'bytes' });
      return rs.end(body);
    }
    const all = ROOT_FILES.concat([{ id: ROOT_ID, name: 'Мой диск', mimeType: 'application/vnd.google-apps.folder' }]);
    const f = all.find(x => x.id === id) || { id, name: 'файл', mimeType: 'application/octet-stream', size: '10' };
    const parents = id === FOLDER_ID ? [ROOT_ID] : id === ROOT_ID ? [] : [FOLDER_ID];
    return jsend(200, { id: f.id, name: f.name, mimeType: f.mimeType, size: f.size, thumbnailLink: f.thumbnailLink, parents });
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

/** Поднять сервер: своя папка данных, свои ключи (или их отсутствие). */
async function boot(dataDir, keys) {
  const p = await freePort();
  const env = Object.assign({}, process.env, {
    STORE: 'file', DATA_DIR: dataDir, HOST: '127.0.0.1', HTTPS: '', PRESENCE_EVERY: '0',
    NEW_INVITE_DELAY: '0', INVITE_COOLDOWN_MS: '0', PORT: String(p),
    GDRIVE_AUTH_BASE: mockBase, GDRIVE_TOKEN_BASE: mockBase, GDRIVE_API_BASE: mockBase,
    GDRIVE_KEYS: keys, GDRIVE_REDIRECT: 'http://127.0.0.1:' + p + '/api/gdrive/callback'
  });
  const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'], env });
  procs.push(proc);
  const base = 'http://127.0.0.1:' + p;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/api/state')).ok) break; } catch (err) {} await wait(200); }
  return { base, proc };
}

async function call(base, p, opts = {}, token) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { ...opts, headers: h, body: opts.body ? JSON.stringify(opts.body) : undefined });
  let d = null;
  try { d = await r.json(); } catch (e) {}
  return { status: r.status, d };
}
const creds = name => ({ name, saltAuth: hex(), authKey: hex(32), saltWrap: hex(), wrappedKeyByPass: 'w:' + hex(), pub: 'pub:' + hex(), wrappedPriv: 'priv:' + hex() });

/** Настроить чат и завести участников на конкретном сервере. */
async function seed(base, names) {
  const r = await call(base, '/api/setup', { method: 'POST', body: Object.assign({}, creds('Владелец'), { codeProofSalt: hex(), codeProof: hex(32), codeSalt: hex(), wrappedKeyByCode: 'k:' + hex() }) });
  const admin = r.d.token;
  const out = {};
  for (const name of names) {
    const secret = hex(24);
    const sha = crypto.createHash('sha256').update(secret).digest('hex');
    const ir = await call(base, '/api/invites', { method: 'POST', body: { invSalt: hex(), wrappedRoomKey: 'k:' + hex(), secretHash: sha } }, admin);
    const rr = await call(base, '/api/register', { method: 'POST', body: Object.assign({}, creds(name), { inviteToken: ir.d.invite.id + '.' + secret }) });
    out[name] = { token: rr.d.token, id: rr.d.user.id };
  }
  return out;
}

// ─────────── 1. Сначала без ключей: честное объяснение ───────────
console.log('\n  1. Ключей нет — сервер честно говорит, что нужно');
const noKeys = await boot(path.join(dir, 'data0'), path.join(dir, 'нет-такого-файла.json'));
const N = await seed(noKeys.base, ['Вася']);
let r = await call(noKeys.base, '/api/drives', {}, N['Вася'].token);
let gd0 = (r.d.drives || []).find(x => x.id === 'google') || {};
ok(r.status === 200 && !!gd0.id, 'Google Диск есть в списке дисков (а не «скоро»)');
ok(gd0.connected === false && gd0.needsKeys === true, 'без ключей диск не подключён, и это видно');
ok(typeof gd0.keysHint === 'string' && gd0.keysHint.includes('google-oauth.json'), 'окно объясняет, куда положить client_id и secret');
r = await call(noKeys.base, '/api/gdrive/auth', {}, N['Вася'].token);
ok(r.status === 409 && String(r.d.error || '').includes('Google Cloud'), 'вход не начинается без ключей — с понятным текстом');
r = await call(noKeys.base, '/api/yadisk/list?path=' + encodeURIComponent('google:/root'), {}, N['Вася'].token);
ok(r.status === 409 && String(r.d.error || '').includes('Google'), 'и папку Google без подключения не читает');
noKeys.proc.kill('SIGKILL');
await wait(300);

// ─────────── 2. Ключи есть: вход через Google ───────────
console.log('\n  2. Вход через Google и «Мои диски»');
const srv = await boot(path.join(dir, 'data'), keysPath);
const B = srv.base;
const U = await seed(B, ['Вася', 'Клава', 'Гость']);
const A = U['Вася'], K = U['Клава'], G = U['Гость'];
await call(B, '/api/dm', { method: 'POST', body: { peer: K.id } }, A.token);

r = await call(B, '/api/gdrive/auth', {}, A.token);
ok(r.status === 200 && String(r.d.url || '').includes('/o/oauth2/v2/auth'), 'сервер отдаёт адрес страницы согласия Google');
// pkg3-139: право расширено до полного — сервер получил и запись (папки, загрузка)
ok(/\/auth\/drive(\s|$)/.test(decodeURIComponent(new URL(r.d.url).searchParams.get('scope') || '')), 'просим право на Диск (auth/drive) — смотреть и менять');
ok(String(r.d.url || '').includes('access_type=offline'), 'просим «долгий» доступ — чтобы не входить каждый час');
const state = (new URL(r.d.url)).searchParams.get('state');
const cb = await fetch(B + '/api/gdrive/callback?state=' + encodeURIComponent(state) + '&code=code126');
const cbBody = await cb.text();
ok(cb.status === 200 && /Google Диск подключён/.test(cbBody), 'токен получен и сохранён (код обменян на сервере)');
ok(/смотреть и менять/.test(cbBody), 'пользователю прямо сказано, какие права получил сервер');
const again = await (await fetch(B + '/api/gdrive/callback?state=' + encodeURIComponent(state) + '&code=code126')).text();
ok(/устарела/.test(again), 'повторный возврат по той же ссылке не подключает дважды (state одноразовый)');
r = await call(B, '/api/drives', {}, A.token);
const gd1 = (r.d.drives || []).find(x => x.id === 'google') || {};
ok(gd1.connected === true, 'после входа Google Диск отмечен подключённым');
ok(gd1.readonly === false && gd1.canWrite === true, 'в списке дисков видно, что сервер может менять файлы');
r = await call(B, '/api/drives', {}, K.token);
ok((r.d.drives || []).find(x => x.id === 'google').connected === false, 'у Клавы свой Google не подключён');
r = await call(B, '/api/login', { method: 'POST', body: { authKey: 'что-то' } });
ok(r.status >= 400, 'токен Google в базе лежит зашифрованным, а не открытым (вход по нему не пройти)');

// ─────────── 3. Чтение папок, превью, место ───────────
console.log('\n  3. Папки, файлы, превью и место');
r = await call(B, '/api/yadisk/list?path=' + encodeURIComponent('google:/root'), {}, A.token);
ok(r.status === 200 && Array.isArray(r.d.items), 'корень Google Диска читается');
ok(r.d.items.length === 4, 'в корне четыре записи (папка, фото, музыка, документ)');
ok(r.d.items[0].dir === true && r.d.items[0].path === 'google:/' + FOLDER_ID, 'папка идёт первой и путь — google:/<id>');
const photo = r.d.items.find(x => x.name === 'beach.jpg') || {};
ok(photo.media === 'image' && String(photo.preview).startsWith('https://lh3.googleusercontent.com/'), 'у фото есть превью Google');
ok(String(photo.preview).includes('googleusercontent'), 'превью только с домена Google');
const song = r.d.items.find(x => x.name === 'song.mp3') || {};
ok(song.media === 'audio', 'музыка распознана');
const doc = r.d.items.find(x => x.name === 'заметка') || {};
ok(doc.media === 'doc', 'документ Google распознан');
ok(r.d.space && r.d.space.total === 16106127360, 'свободное место приходит из about (15 ГБ)');
r = await call(B, '/api/yadisk/space?drive=google', {}, A.token);
ok(r.status === 200 && r.d.free === r.d.total - r.d.used, 'место можно спросить отдельно — «свободно» посчитано');
r = await call(B, '/api/yadisk/list?path=' + encodeURIComponent('google:/' + FOLDER_ID), {}, A.token);
ok(r.status === 200 && String(r.d.parent || '').includes('google:/'), 'у папки известен родитель — кнопка «↑» работает');
ok(r.d.name === 'Фото', 'и имя папки для хлебных крошек (идентификаторы человеку не показываем)');

// ─────────── 4. Файл идёт через сервер по пропуску ───────────
console.log('\n  4. Файл с Google: короткий пропуск, Range');
r = await call(B, '/api/yadisk/file?path=' + encodeURIComponent('google:/' + SONG_ID), {}, A.token);
ok(r.status === 200 && String(r.d.href || '').startsWith('/api/gdrive/stream?t='), 'вместо ссылки Google — наш подписанный пропуск');
ok(!String(r.d.href || '').includes('access_token'), 'токен Google в адрес не попадает');
ok(r.d.media === 'audio' && r.d.size === 3145728, 'тип и размер файла известны');
const streamUrl = r.d.href;
let up = await fetch(B + streamUrl);
const bytes = await up.text();
ok(up.status === 200 && bytes === 'BYTES-' + SONG_ID, 'сервер отдаёт байты файла из Google');
up = await fetch(B + streamUrl, { headers: { Range: 'bytes=0-3' } });
const part = await up.text();
ok(up.status === 206 && part === 'BYTE', 'перемотка (Range) проходит — можно слушать с середины');
ok(rangeSeen.includes('bytes=0-3'), 'Range доходит до Google, а не режется на сервере');
up = await fetch(B + '/api/gdrive/stream?t=подделка');
ok(up.status === 403, 'чужой или испорченный пропуск не пускает');
up = await fetch(B + '/api/gdrive/stream?t=' + encodeURIComponent(streamUrl.split('t=')[1].replace(/^./, 'X')));
ok(up.status === 403, 'подделанный пропуск (одна буква) тоже не пускает');

// ─────────── 5. Папку с Google — в чат, только чтение ───────────
console.log('\n  5. «Поделиться» папкой с Google — только смотреть');
r = await call(B, '/api/yadisk/share-file', { method: 'POST', body: { path: 'google:/' + FOLDER_ID, name: 'Фото', kind: 'folder', perm: 'write' } }, A.token);
ok(r.status === 200, 'папку с Google можно открыть участнику чата');
r = await call(B, '/api/yadisk/shared-list?of=' + A.id + '&path=' + encodeURIComponent('google:/' + FOLDER_ID), {}, K.token);
ok(r.status === 200 && r.d.drive === 'google' && r.d.perm === 'write', 'Клава смотрит папку Google — с тем правом, что дал владелец');
r = await call(B, '/api/yadisk/shared-list?of=' + A.id + '&path=' + encodeURIComponent('google:/' + FOLDER_ID), {}, G.token);
ok(r.status === 404, 'посторонний (не из чата) папку не видит');
r = await call(B, '/api/yadisk/file?of=' + A.id + '&path=' + encodeURIComponent('google:/' + PHOTO_ID), {}, K.token);
ok(r.status === 200 && String(r.d.href || '').includes('/api/gdrive/stream'), 'файл внутри открытой папки тоже открывается');
r = await call(B, '/api/yadisk/file?path=' + encodeURIComponent('google:/' + FOLDER_ID), {}, A.token);
ok(r.status === 200 && r.d.dir === true, 'папка отдаётся как папка, а не как файл');
// pkg3-139: запрет «в Google только чтение» снят — этим занимается test/ui128.mjs
r = await call(B, '/api/yadisk/op', { method: 'POST', body: { op: 'mkdir', path: 'google:/' + FOLDER_ID + '/Новая' } }, A.token);
ok(!(r.status === 409 && /только чтение/.test(String(r.d.error || ''))), 'создание папки в Google больше не отказывается заранее (выпуск 128)');
r = await call(B, '/api/yadisk/upload-url?path=' + encodeURIComponent('google:/' + FOLDER_ID + '/new.jpg'), {}, A.token);
ok(r.status !== 409 || !/только чтение/.test(String(r.d.error || '')), 'и загрузка в Google тоже больше не запрещена на входе');
r = await call(B, '/api/gdrive/disconnect', { method: 'POST', body: {} }, A.token);
ok(r.status === 200, 'Google можно отключить одной кнопкой');
r = await call(B, '/api/drives', {}, A.token);
ok((r.d.drives || []).find(x => x.id === 'google').connected === false, 'после отключения диск снова не подключён');

// ─────────── 6. Клиент: Google в проводнике и в окне подключения ───────────
console.log('\n  6. Клиент: Google в проводнике и в окне подключения');
const appJs = read('public/app.js');
// pkg3-139: у дисков теперь несколько номеров — кнопки различаются data-атрибутами
ok(/data-gd-login="\$\{slot\}"/.test(appJs) && /\/api\/gdrive\/auth\?slot=/.test(appJs), 'в окне подключения есть «Войти через Google»');
ok(/\/api\/gdrive\/disconnect/.test(appJs) && /data-drv-off="\$\{escapeHtml\(x\.id\)\}"/.test(appJs), 'и «Отключить» для любого диска');
ok(/keysHint/.test(appJs), 'если ключей нет — показываем подсказку, а не пустую кнопку');
ok(/const writable = mine \? gWrite : \(st\.perm === 'write'\)/.test(appJs) && /Google разрешил SEGA-CHAT только смотреть файлы/.test(appJs), 'право на правки считается по правам входа, и это написано словами');
ok(/function dkRoot\(drive\)/.test(appJs) && /'google:\/root'/.test(appJs), 'у каждого диска свой корень пути');
ok(/gd-more/.test(appJs) && /Разрешить изменения/.test(appJs), 'если вход был «только смотреть» — есть кнопка «Разрешить изменения»');
const normSrc = (/function dkNorm\(p\) \{[\s\S]*?\n\}/.exec(appJs) || [''])[0];
let dkNorm = null;
try { dkNorm = new Function(normSrc + '; return dkNorm;')(); } catch (e) { dkNorm = null; }
ok(!!dkNorm && dkNorm('google:') === 'google:/root' && dkNorm('google:/abc') === 'google:/abc', 'путь Google приводится к одному виду');
ok(!!dkNorm && dkNorm('disk:/') === 'disk:/', 'и Яндекс не сломан тем же правилом');
ok(/☁ Google Диск/.test(appJs) && /У Google путь — это идентификаторы файлов/.test(appJs), 'крошки Google показывают имя папки, а не её код');

console.log('\n  7. Отметки выпуска');
const b2 = (/const BUILD = '([^']+)'/.exec(appJs) || [])[1];
const cache = (/const STATIC_CACHE = '([^']+)'/.exec(read('public/sw.js')) || [])[1];
ok(b2 === BUILD && BUILD === 'pkg3-139', `отметка выпуска в клиенте и в тестах одна (${BUILD})`);
ok(((/const BUILD = '([^']+)'/.exec(read('lib/api.js')) || [])[1]) === BUILD, 'BUILD в lib/api.js тот же');
ok(/\| pkg3-139 \|/.test(read('README.md')), `в журнале README есть строка ${BUILD}`);
ok(cache === 'sega-static-v133', `кэш оформления поднят (${cache}) — устройства получат новые окна`);
ok(read('package.json').includes('node test/ui126.mjs'), 'тест ui126 включён в цепочку npm test');
ok(!/require\('googleapis'\)/.test(read('lib/gdrive.js')), 'новых зависимостей npm нет — только встроенные модули');

console.log(`\n  ИТОГ: ${good} ✓, ${bad ? bad + ' провалов' : 'провалов нет'}\n`);
process.exit(bad ? 1 : 0);
