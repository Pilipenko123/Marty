// test/ui129.mjs — pkg3-139: несколько дисков у одного человека.
//
// Что проверяем на живом сервере с игрушечными Яндексом и Google:
//   • можно подключить ВТОРОЙ Яндекс-Диск (и второй Google) — до трёх каждого;
//   • у каждого диска своё начало пути: `disk:/…` и `disk2:/…`, `google:` и
//     `google2:` — списки и токены не путаются (игрушечный диск отвечает по
//     своему токену, поэтому подмену видно сразу);
//   • права, «Поделиться» и ссылки работают отдельно для каждого диска;
//   • старые записи базы (`u.yadisk` / `u.gdrive` по одной) переносятся сами:
//     диск остаётся подключённым и читается после перезапуска;
//   • клиент: корни, значки, «ещё один диск», передача номера в музыку.
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
console.log('  pkg3-139: несколько дисков у одного человека');
console.log('══════════════════════════════════════════════════\n');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sega-m129-'));
const dataDir = path.join(dir, 'data');
const keysPath = path.join(dir, 'google-oauth.json');
fs.writeFileSync(keysPath, JSON.stringify({ client_id: 'cid129.apps.googleusercontent.com', client_secret: 'sec129' }));

// Два «аккаунта» Яндекса и два Google: каждый отвечает своим набором файлов.
const TOK1 = 'y0_AgAAAAB129token-first_disk';
const TOK2 = 'y0_AgAAAAB129token-second-disk';
const YD_FILES = {
  [TOK1]: [{ name: 'first.mp3', path: 'disk:/first.mp3', type: 'file', size: 11 }, { name: 'Папка-1', path: 'disk:/Папка-1', type: 'dir' }],
  [TOK2]: [{ name: 'second.mp3', path: 'disk:/second.mp3', type: 'file', size: 22 }, { name: 'Папка-2', path: 'disk:/Папка-2', type: 'dir' }]
};
const created = [];      // что просили создать у Яндекса: { token, path }
const googleSeen = [];   // какие токены Google дёргали: { path, token }
const G_FILES = { g1tok: [{ id: 'gf1aaa', name: 'g-one.mp3', mimeType: 'audio/mpeg', size: '5' }], g2tok: [{ id: 'gf2bbb', name: 'g-two.mp3', mimeType: 'audio/mpeg', size: '6' }] };

const ydItem = (x, base) => ({
  name: x.name, path: x.path, type: x.type,
  size: x.type === 'dir' ? 0 : x.size,
  mime_type: x.type === 'dir' ? 'application/vnd.yandex-folders' : 'audio/mpeg',
  media_type: x.type === 'dir' ? undefined : 'audio',
  modified: '2026-11-05T00:00:00Z',
  preview: '', md5: 'x', resource_id: 'r'
});

const mock = http.createServer((rq, rs) => {
  const u = new URL(rq.url, 'http://mock');
  const chunks = [];
  rq.on('data', c => chunks.push(c));
  rq.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let form = null;
    if (raw && !raw.startsWith('{')) {
      form = {};
      for (const [k, v] of new URLSearchParams(raw)) form[k] = v;
    } else {
      try { form = raw ? JSON.parse(raw) : null; } catch (e) { form = null; }
    }
    const jsend = (code, obj) => { rs.writeHead(code, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify(obj)); };
    const auth = String(rq.headers.authorization || '');
    const token = auth.replace(/^(OAuth|Bearer)\s+/i, '');

    // ── Яндекс ─────────────────────────────────────────────
    if (u.pathname === '/v1/disk/resources' && rq.method === 'PUT') {
      const p = String(u.searchParams.get('path') || '');
      if (!YD_FILES[token]) return jsend(401, { message: 'нет токена' });
      created.push({ token, path: p });
      YD_FILES[token].push({ name: p.split('/').pop(), path: p, type: 'dir', size: 0 });
      return jsend(201, { name: '', path: p });
    }
    if (u.pathname === '/v1/disk/resources' && rq.method === 'GET') {
      if (!YD_FILES[token]) return jsend(401, { message: 'нет токена' });
      const p = String(u.searchParams.get('path') || 'disk:/');
      const restOf = x => x.path.slice('disk:/'.length);
      const list = p === 'disk:/'
        ? YD_FILES[token].filter(x => restOf(x).indexOf('/') === -1)
        : YD_FILES[token].filter(x => x.path.startsWith(p + '/'));
      return jsend(200, {
        name: 'Диск', path: p, type: 'dir',
        _embedded: { path: p, items: list.map(x => ydItem(x)), limit: 100, offset: 0, total: list.length }
      });
    }
    if (u.pathname === '/v1/disk/resources/download') {
      if (!YD_FILES[token]) return jsend(401, { message: 'нет токена' });
      const p = String(u.searchParams.get('path') || '');
      if (!YD_FILES[token].some(x => x.path === p)) return jsend(404, { message: 'не найдено', error: 'DiskNotFoundError' });
      return jsend(200, { href: 'https://downloader.disk.yandex.ru/' + encodeURIComponent(token + '|' + p), method: 'GET', ttl: 300 });
    }
    if (u.pathname === '/v1/disk' || u.pathname === '/v1/disk/') {
      if (!YD_FILES[token]) return jsend(401, { message: 'нет токена' });
      return jsend(200, { total_space: 1000, used_space: token === TOK1 ? 100 : 250, trash_size: 0 });
    }
    if (u.pathname === '/v1/disk/resources/files') {
      if (!YD_FILES[token]) return jsend(401, { message: 'нет токена' });
      const files = YD_FILES[token].filter(x => x.type === 'file').map(x => ydItem(x));
      return jsend(200, { items: files, limit: 200, offset: 0 });
    }

    // ── Google ────────────────────────────────────────────
    if (rq.method === 'POST' && u.pathname === '/token') {
      const code = String((form && form.code) || '');
      const at = code === 'g2code' ? 'g2tok' : 'g1tok';
      return jsend(200, { access_token: at, refresh_token: 'rt' + at, expires_in: 3600, scope: 'https://www.googleapis.com/auth/drive' });
    }
    if (u.pathname === '/drive/v3/about') return jsend(200, { storageQuota: { limit: '1000', usage: '10' } });
    if (rq.method === 'GET' && u.pathname === '/drive/v3/files') {
      const q = String(u.searchParams.get('q') || '');
      const m = /'([^']+)' in parents/.exec(q);
      const list = G_FILES[token] || [];
      const items = q.includes("mimeType contains 'audio/'") ? list : (m ? list : list);
      return jsend(200, { files: items.map(f => Object.assign({}, f, { parents: m ? [m[1]] : ['root'] })) });
    }
    const fm = /^\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname);
    if (fm) {
      const id = fm[1];
      googleSeen.push({ path: u.pathname, token });
      if (u.searchParams.get('alt') === 'media') {
        const body = 'SOUND-' + token + '-' + id;
        rs.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': String(body.length) });
        return rs.end(body);
      }
      const f = (G_FILES[token] || []).find(x => x.id === id) || { id, name: 'файл', mimeType: 'audio/mpeg', size: '5' };
      return jsend(200, { id: f.id, name: f.name, mimeType: f.mimeType, size: f.size, parents: ['root'] });
    }
    jsend(404, { error: { message: 'не найдено' } });
  });
});
await new Promise(r => mock.listen(0, '127.0.0.1', r));
const mockBase = 'http://127.0.0.1:' + mock.address().port;

async function freePort() {
  const { createServer } = await import('node:net');
  return new Promise(r => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
}
const procs = [];
process.on('exit', () => { for (const p of procs) { try { p.kill('SIGKILL'); } catch (e) {} } try { mock.close(); } catch (e) {} });

let port = await freePort();
let base = 'http://127.0.0.1:' + port;
let proc = null;
async function boot() {
  port = await freePort();
  base = 'http://127.0.0.1:' + port;
  proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
    env: Object.assign({}, process.env, {
      STORE: 'file', DATA_DIR: dataDir, HOST: '127.0.0.1', HTTPS: '', PRESENCE_EVERY: '0',
      NEW_INVITE_DELAY: '0', INVITE_COOLDOWN_MS: '0', PORT: String(port),
      GDRIVE_AUTH_BASE: mockBase, GDRIVE_TOKEN_BASE: mockBase, GDRIVE_API_BASE: mockBase,
      GDRIVE_KEYS: keysPath, GDRIVE_REDIRECT: base + '/api/gdrive/callback',
      YADISK_OAUTH_BASE: mockBase, YADISK_API_BASE: mockBase
    })
  });
  procs.push(proc);
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/api/state')).ok) break; } catch (e) {} await wait(200); }
  return proc;
}
await boot();

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
await call('/api/dm', { method: 'POST', body: { peer: K.id } }, A.token);

console.log('\n  1. Два Яндекс-Диска у одного человека');
r = await call('/api/yadisk/token', { method: 'POST', body: { token: TOK1, slot: 1 } }, A.token);
ok(r.status === 200 && r.d.slot === 1, 'первый Яндекс-Диск подключён (номер 1)');
r = await call('/api/yadisk/token', { method: 'POST', body: { token: TOK2, slot: 2 } }, A.token);
ok(r.status === 200 && r.d.slot === 2, 'второй Яндекс-Диск подключён (номер 2)');
r = await call('/api/drives', {}, A.token);
let rows = r.d.drives || [];
const row = id => rows.find(x => x.id === id) || {};
ok(row('yandex').connected === true && row('yandex').manual === true, 'первый диск в списке, подключён токеном');
ok(row('yandex2').connected === true && row('yandex2').slot === 2, 'второй диск — отдельной строкой');
ok(row('yandex').prefix === 'disk:' && row('yandex2').prefix === 'disk2:', 'у дисков разные начала пути (disk: и disk2:)');
ok(!!row('google') && row('google').connected === false, 'Google-строки тоже на месте');
ok(r.d.canAdd && r.d.canAdd.yandex === true, 'видно, что можно добавить третий диск');

console.log('\n  2. Пути и токены не путаются');
r = await call('/api/yadisk/list?path=' + encodeURIComponent('disk:/'), {}, A.token);
ok(r.status === 200 && (r.d.items || []).some(x => x.name === 'first.mp3'), 'корень первого диска — его файлы');
ok(!(r.d.items || []).some(x => x.name === 'second.mp3'), 'файлов со второго диска там нет');
r = await call('/api/yadisk/list?path=' + encodeURIComponent('disk2:/'), {}, A.token);
ok(r.status === 200 && (r.d.items || []).some(x => x.name === 'second.mp3'), 'корень второго диска — его файлы');
ok(!(r.d.items || []).some(x => x.name === 'first.mp3'), 'и наоборот: первый диск туда не просочился');
ok((r.d.items || []).some(x => x.path === 'disk2:/second.mp3'), 'путь файла второго диска начинается с disk2:');
r = await call('/api/yadisk/href?path=' + encodeURIComponent('disk2:/second.mp3'), {}, A.token);
ok(r.status === 200 && String(r.d.href || '').includes(encodeURIComponent(TOK2)), 'ссылка на файл взята токеном ВТОРОГО диска');
r = await call('/api/yadisk/href?path=' + encodeURIComponent('disk:/first.mp3'), {}, A.token);
ok(r.status === 200 && String(r.d.href || '').includes(encodeURIComponent(TOK1)), 'а у первого диска — своим токеном');

console.log('\n  3. Изменения идут в свой диск');
r = await call('/api/yadisk/op', { method: 'POST', body: { op: 'mkdir', path: 'disk2:/Новая' } }, A.token);
ok(r.status === 200, 'папка создаётся на втором диске');
ok(created.length === 1 && created[0].token === TOK2 && created[0].path === 'disk:/Новая', 'у Яндекса запрос с токеном второго диска и обычным путём disk:/…');
r = await call('/api/yadisk/op', { method: 'POST', body: { op: 'mkdir', path: 'disk:/Ещё' } }, A.token);
ok(created.length === 2 && created[1].token === TOK1, 'первый диск по-прежнему ходит своим токеном');
r = await call('/api/yadisk/op', { method: 'POST', body: { op: 'mkdir', path: 'disk2:/' } }, A.token);
ok(r.status === 400, 'корень второго диска удалить/переименовать нельзя так же, как первого');

console.log('\n  4. Права и ссылки — у каждого диска свои');
r = await call('/api/yadisk/share-file', { method: 'POST', body: { path: 'disk2:/Папка-2', name: 'Папка-2', kind: 'folder', perm: 'read' } }, A.token);
ok(r.status === 200, 'папку второго диска можно открыть участнику чата');
r = await call('/api/yadisk/share-file', { method: 'POST', body: { path: 'disk2:/second.mp3', name: 'second.mp3', media: 'audio', kind: 'file' } }, A.token);
ok(r.status === 200, 'и отдельный файл второго диска');
r = await call('/api/yadisk/shared-list?of=' + A.id + '&path=' + encodeURIComponent('disk2:/Папка-2'), {}, K.token);
ok(r.status === 200 && r.d.root === 'disk2:/Папка-2', 'Клава открывает папку второго диска, и путь остаётся вторым');
r = await call('/api/yadisk/file?of=' + A.id + '&path=' + encodeURIComponent('disk2:/second.mp3'), {}, K.token);
ok(r.status === 200 && String(r.d.href || '').includes(encodeURIComponent(TOK2)), 'файл отдаётся токеном второго диска');
r = await call('/api/yadisk/file?of=' + A.id + '&path=' + encodeURIComponent('disk:/first.mp3'), {}, K.token);
ok(r.status === 404, 'первый диск Клаве не открывали — отказано');
r = await call('/api/yadisk/space?slot=2', {}, A.token);
ok(r.status === 200 && !!r.d.total, 'место показывается для выбранного диска');

console.log('\n  5. Второй Google-Диск');
async function gconnect(user, code, slot) {
  const a = await call('/api/gdrive/auth?slot=' + slot, {}, user.token);
  const st = (new URL(a.d.url)).searchParams.get('state');
  const res = await fetch(base + '/api/gdrive/callback?state=' + encodeURIComponent(st) + '&code=' + code);
  return res.text();
}
ok(/Google Диск подключён/.test(await gconnect(A, 'g1code', 1)), 'первый Google-Диск подключён');
ok(/Google Диск подключён/.test(await gconnect(A, 'g2code', 2)), 'второй Google-Диск подключён');
r = await call('/api/drives', {}, A.token);
rows = r.d.drives || [];
const row2 = id => rows.find(x => x.id === id) || {};
ok(row2('google').connected === true && row2('google2').connected === true, 'оба Google-диска в списке');
ok(row2('google2').prefix === 'google2:', 'у второго Google-диска своё начало пути');
r = await call('/api/yadisk/list?path=' + encodeURIComponent('google2:/root'), {}, A.token);
ok(r.status === 200 && (r.d.items || []).some(x => x.name === 'g-two.mp3'), 'список второго Google-диска — его файлы');
ok(!(r.d.items || []).some(x => x.name === 'g-one.mp3'), 'файлов первого Google-диска там нет');
r = await call('/api/yadisk/list?path=' + encodeURIComponent('google:/root'), {}, A.token);
ok((r.d.items || []).some(x => x.name === 'g-one.mp3'), 'и наоборот — первый диск показывает своё');
r = await call('/api/yadisk/files?limit=50&drive=google&slot=2', {}, A.token);
ok(r.status === 200 && (r.d.items || []).every(x => String(x.path).startsWith('google2:/')), '«Моя музыка» просит второй Google-диск — пути google2:/…');
r = await call('/api/yadisk/href?path=' + encodeURIComponent('google2:/gf2bbb'), {}, A.token);
ok(r.status === 200 && String(r.d.href || '').startsWith('/api/gdrive/stream?t='), 'файл второго Google играет по нашему пропуску');
const up2 = await fetch(base + r.d.href);
const bytes = await up2.text();
ok(bytes === 'SOUND-g2tok-gf2bbb', 'пропуск правда берёт токен ВТОРОГО Google-диска');
r = await call('/api/yadisk/href?path=' + encodeURIComponent('google:/gf1aaa'), {}, A.token);
ok((await (await fetch(base + r.d.href)).text()) === 'SOUND-g1tok-gf1aaa', 'первый Google-диск остаётся на своём токене');
r = await call('/api/yadisk/op', { method: 'POST', body: { op: 'mkdir', path: 'google2:/root/Второй' } }, A.token);
ok(r.status !== 500, 'правки второго Google не путают сервер (ответ — не «ошибка сервера»)');

console.log('\n  6. Ограничения');
r = await call('/api/yadisk/token', { method: 'POST', body: { token: TOK1, slot: 4 } }, A.token);
ok(r.status === 400 && /не больше трёх/i.test(String(r.d.error || '')), 'четвёртый номер отклоняется, а не затирает первый диск');
r = await call('/api/yadisk/state?slot=3', {}, A.token);
ok(r.status === 200 && r.d.connected === false, 'третий диск — не подключён, и это видно');
r = await call('/api/yadisk/token', { method: 'POST', body: { token: TOK1, slot: 3 } }, A.token);
ok(r.status === 200, 'третий диск подключается — предел три, и он честный');
r = await call('/api/drives', {}, A.token);
rows = r.d.drives || [];
ok(!rows.some(x => x.kind === 'yandex' && x.placeholder), 'свободных Яндекс-строк больше нет — четвёртую не предлагаем');

console.log('\n  7. Перенос старых записей базы');
// останавливаем сервер, возвращаем базу к виду 128-го (u.yadisk / u.gdrive), поднимаем снова
proc.kill('SIGKILL');
await wait(400);
const dbFile = path.join(dataDir, 'db.json');
const dbJson = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
const uA = dbJson.users.find(x => x.id === A.id);
const yandexOne = (uA.drives || []).find(d => d.kind === 'yandex' && d.slot === 1);
const googleOne = (uA.drives || []).find(d => d.kind === 'google' && d.slot === 1);
uA.yadisk = { blob: yandexOne.blob, at: Date.now(), manual: true };
uA.gdrive = { blob: googleOne.blob, at: Date.now() };
uA.drives = (uA.drives || []).filter(d => !(d.kind === 'yandex' && d.slot === 1) && !(d.kind === 'google' && d.slot === 1));
fs.writeFileSync(dbFile, JSON.stringify(dbJson));
await boot();
// сессия живёт в базе — токен входа остался, спрашиваем по нему
r = await call('/api/drives', {}, A.token);
ok(r.status === 200, 'после переноса базы вход не сломался');
rows = r.d.drives || [];
const row3 = id => rows.find(x => x.id === id) || {};
ok(row3('yandex').connected === true && row3('yandex').manual === true, 'старый Яндекс-Диск остался подключённым (перенесён в общий список)');
ok(row3('google').connected === true, 'старый Google-Диск тоже остался подключённым');
r = await call('/api/yadisk/list?path=' + encodeURIComponent('disk:/'), {}, A.token);
ok(r.status === 200 && (r.d.items || []).some(x => x.name === 'first.mp3'), 'и файлы старого диска читаются как раньше');
const dbAfter = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
const uAfter = dbAfter.users.find(x => x.id === A.id);
ok(Array.isArray(uAfter.drives) && !uAfter.yadisk && !uAfter.gdrive, 'в базе теперь только новый список — старых полей не осталось');

console.log('\n  8. Клиент: несколько дисков');
const appJs = read('public/app.js');
const grab = (src, name) => {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) return '';
  let d = 0, j = i;
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (!d) break; } }
  return src.slice(i, j + 1);
};
const fnSrc = ['drvKindOf', 'drvSlotOf', 'drvDriveId', 'dkNorm', 'dkIsGoogle', 'dkSlotOfPath', 'dkDriveOfPath', 'dkRoot', 'dkParent', 'dkJoin']
  .map(n => grab(appJs, n)).filter(Boolean).join('\n');
let fns = null;
try { fns = new Function(fnSrc + '; return {dkNorm, dkRoot, dkParent, dkJoin, dkDriveOfPath, dkIsGoogle, drvDriveId};')(); } catch (e) { fns = null; }
ok(!!fns, 'правила пути в клиенте читаются');
ok(!!fns && fns.dkRoot('yandex') === 'disk:/' && fns.dkRoot('yandex2') === 'disk2:/', 'у первого и второго Яндекс-диска разные корни');
ok(!!fns && fns.dkRoot('google2') === 'google2:/root', 'у второго Google-диска свой корень');
ok(!!fns && fns.dkNorm('disk2:') === 'disk2:/' && fns.dkNorm('google2:') === 'google2:/root', 'недописанный путь приводится к корню нужного диска');
ok(!!fns && fns.dkDriveOfPath('disk3:/x') === 'yandex3' && fns.dkDriveOfPath('google2:/abc') === 'google2', 'по пути видно, чей это диск');
ok(!!fns && fns.dkParent('disk2:/a/b') === 'disk2:/a', 'родитель остаётся на том же диске');
ok(!!fns && fns.dkIsGoogle('google2:/x') === true, 'второй Google узнаётся как Google');
ok(/data-drv-token="\$\{slot\}"/.test(appJs) && /data-drv-oauth="\$\{slot\}"/.test(appJs), 'в окне подключения можно добавить «ещё один» диск');
ok(/data-gd-login="\$\{slot\}"/.test(appJs), 'и «ещё один» Google');
ok(/&slot=' \+ encodeURIComponent/.test(appJs), 'музыка передаёт номер диска');
ok(/да трёх дисков каждого вида/.test(appJs) || /до трёх дисков/.test(appJs), 'в окне сказано про предел три');

console.log('\n  9. Отметки выпуска');
const b2 = (/const BUILD = '([^']+)'/.exec(appJs) || [])[1];
const cache = (/const STATIC_CACHE = '([^']+)'/.exec(read('public/sw.js')) || [])[1];
ok(b2 === BUILD && BUILD === 'pkg3-139', `отметка выпуска в клиенте и в тестах одна (${BUILD})`);
ok(((/const BUILD = '([^']+)'/.exec(read('lib/api.js')) || [])[1]) === BUILD, 'BUILD в lib/api.js тот же');
ok(/\| pkg3-139 \|/.test(read('README.md')), `в журнале README есть строка ${BUILD}`);
ok(cache === 'sega-static-v133', `кэш оформления поднят (${cache}) — устройства получат новые окна`);
ok(read('package.json').includes('node test/ui129.mjs'), 'тест ui129 включён в цепочку npm test');

console.log(`\n  ИТОГ: ${good} ✓, ${bad ? bad + ' провалов' : 'провалов нет'}\n`);
process.exit(bad ? 1 : 0);
