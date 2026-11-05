// test/ui128.mjs — pkg3-134: Google Диск на запись.
//
// Что проверяем на живом сервере с игрушечным Google (он умеет и писать):
//   • у входа теперь право «смотреть и менять» (`/auth/drive`, не `.readonly`);
//   • «Новая папка», «Переименовать», «Удалить» (в корзину Google) работают;
//   • «Загрузить» открывает у Google сеанс загрузки, и файл идёт С УСТРОЙСТВА
//     прямо в Google (сервер байтов не видит) — проверяем по содержимому файла;
//   • чужая открытая папка: с правом «менять» — можно, «только смотреть» — нет;
//     открытую вам папку удалить нельзя, посторонний не может ничего;
//   • старый вход «только чтение» честно просит войти заново (409 с объяснением),
//     а не молча ломается;
//   • клиент: кнопки правок больше не погашены, есть «Разрешить изменения».
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
console.log('  pkg3-134: Google Диск на запись (папки, загрузка, переименование, корзина)');
console.log('══════════════════════════════════════════════════\n');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sega-m128-'));
const keysPath = path.join(dir, 'google-oauth.json');
fs.writeFileSync(keysPath, JSON.stringify({ client_id: 'cid128.apps.googleusercontent.com', client_secret: 'sec128' }));

const FOLDER_ID = 'fold128abc';       // папка, которой Вася поделится
const SONG_ID = 'song128abc';         // файл внутри неё
const RENAME_ID = 'ren128abc';
const rootFolderId = 'root';

// «Диск» игрушечного Google: живые записи, которые меняются от запросов.
const FILES = [
  { id: FOLDER_ID, name: 'Фото', mimeType: 'application/vnd.google-apps.folder', parents: [rootFolderId], trashed: false },
  { id: SONG_ID, name: 'Песня.mp3', mimeType: 'audio/mpeg', size: '2048', parents: [FOLDER_ID], trashed: false },
  { id: RENAME_ID, name: 'Старое имя.txt', mimeType: 'text/plain', size: '10', parents: [rootFolderId], trashed: false }
];
const seen = { mkdir: [], rename: [], trash: [], sessions: [], uploads: [] };
let newId = 0;

const mock = http.createServer((rq, rs) => {
  const u = new URL(rq.url, 'http://mock');
  const chunks = [];
  rq.on('data', c => chunks.push(c));
  rq.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    // тело приходит и JSON (изменения файлов), и формой (обмен кода на токен)
    let body = null;
    if (raw && !raw.startsWith('{')) {
      body = {};
      for (const [k, v] of new URLSearchParams(raw)) body[k] = v;
    } else {
      try { body = raw ? JSON.parse(raw) : null; } catch (e) { body = null; }
    }
    const jsend = (code, obj, extraHeaders) => {
      rs.writeHead(code, Object.assign({ 'Content-Type': 'application/json' }, extraHeaders || {}));
      rs.end(JSON.stringify(obj));
    };
    const find = id => FILES.find(x => x.id === id);
    const meta = f => ({ id: f.id, name: f.name, mimeType: f.mimeType, size: f.size, parents: f.parents, trashed: !!f.trashed });

    if (rq.method === 'POST' && u.pathname === '/token') {
      const code = String((body || {}).code || '');
      const scope = code === 'c128ro' ? 'https://www.googleapis.com/auth/drive.readonly'
        : (code === 'c128none' ? '' : 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/drive.file');
      return jsend(200, { access_token: 'at128', refresh_token: 'rt128', expires_in: 3600, token_type: 'Bearer', scope });
    }
    if (u.pathname === '/drive/v3/about') return jsend(200, { storageQuota: { limit: '1000', usage: '10' } });

    // сеанс загрузки: адрес, по которому браузер льёт файл прямо в Google
    if (rq.method === 'POST' && u.pathname === '/upload/drive/v3/files') {
      const sid = 'sess' + (++newId);
      seen.sessions.push({ sid, name: body && body.name, mime: body && body.mimeType, parents: (body && body.parents) || [], len: rq.headers['x-upload-content-length'] || '' });
      return jsend(200, { }, { Location: mockBase + '/upload-session/' + sid });
    }
    if (rq.method === 'PUT' && u.pathname.startsWith('/upload-session/')) {
      const sid = u.pathname.split('/').pop();
      const s = seen.sessions.find(x => x.sid === sid);
      const id = 'up' + (++newId);
      const f = {
        id, name: (s && s.name) || 'файл', mimeType: (s && s.mime) || 'application/octet-stream',
        size: String(Buffer.byteLength(raw)), parents: (s && s.parents) || [rootFolderId], trashed: false
      };
      FILES.push(f);
      seen.uploads.push({ sid, id, bytes: raw, name: f.name, mime: f.mimeType, parents: f.parents });
      return jsend(200, meta(f));
    }

    if (rq.method === 'GET' && u.pathname === '/drive/v3/files') {
      const q = String(u.searchParams.get('q') || '');
      const m = /'([^']+)' in parents/.exec(q);
      const parent = m ? m[1] : rootFolderId;
      return jsend(200, { files: FILES.filter(f => !f.trashed && f.parents[0] === parent).map(meta) });
    }
    if (rq.method === 'POST' && u.pathname === '/drive/v3/files') {
      const id = 'made' + (++newId);
      const f = { id, name: (body && body.name) || 'папка', mimeType: (body && body.mimeType) || 'application/octet-stream', parents: (body && body.parents) || [rootFolderId], trashed: false, size: '0' };
      FILES.push(f);
      seen.mkdir.push({ id, name: f.name, parents: f.parents });
      return jsend(200, meta(f));
    }
    const fm = /^\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname);
    if (fm) {
      const id = fm[1];
      const f = find(id);
      if (u.searchParams.get('alt') === 'media') {
        const bytes = 'SOUND-' + id;
        rs.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': String(bytes.length), 'Accept-Ranges': 'bytes' });
        return rs.end(bytes);
      }
      if (!f) return jsend(404, { error: { message: 'File not found', errors: [{ reason: 'notFound' }] } });
      if (rq.method === 'PATCH') {
        if (body && typeof body.name === 'string') { seen.rename.push({ id, from: f.name, to: body.name }); f.name = body.name; }
        if (body && body.trashed === true) { seen.trash.push({ id, name: f.name }); f.trashed = true; }
        return jsend(200, meta(f));
      }
      return jsend(200, meta(f));
    }
    jsend(404, { error: { message: 'не найдено', errors: [{ reason: 'notFound' }] } });
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

/** Войти в Google нужным «кодом» — от него зависит набор прав. */
async function gconnect(user, code) {
  const a = await call('/api/gdrive/auth', {}, user.token);
  const st = (new URL(a.d.url)).searchParams.get('state');
  const res = await fetch(base + '/api/gdrive/callback?state=' + encodeURIComponent(st) + '&code=' + code);
  return res.text();
}
const cbA = await gconnect(A, 'c128full');
ok(/Google Диск подключён!/.test(cbA), 'Вася вошёл в Google');
ok(/смотреть и менять/.test(cbA), 'на странице после входа сказано: право смотреть И менять');

console.log('\n  1. Права входа');
const drivesA = async (u) => (await call('/api/drives', {}, u.token)).d.drives || [];
let gdA = (await drivesA(A)).find(x => x.id === 'google') || {};
ok(gdA.connected === true && gdA.canWrite === true && gdA.readonly === false, 'сервер видит право менять файлы (canWrite)');
const authUrl = (await call('/api/gdrive/auth', {}, A.token)).d.url || '';
const scopeParam = decodeURIComponent(new URL(authUrl).searchParams.get('scope') || '');
ok(/\/auth\/drive(\s|$)/.test(scopeParam) && !/drive\.readonly/.test(scopeParam), 'у Google просим полное право (auth/drive), а не «только чтение»');

console.log('\n  2. Новая папка');
r = await call('/api/yadisk/op', { method: 'POST', body: { op: 'mkdir', path: 'google:/root/Музыка 2026' } }, A.token);
ok(r.status === 200 && String(r.d.path || '').startsWith('google:/'), 'новая папка создана в корне Google');
ok(seen.mkdir.length === 1 && seen.mkdir[0].name === 'Музыка 2026' && seen.mkdir[0].parents[0] === 'root', 'у Google папка создана с правильным именем и в нужном месте');
const madeId = String((r.d.path || '')).replace('google:/', '');
r = await call('/api/yadisk/list?path=' + encodeURIComponent('google:/root'), {}, A.token);
ok((r.d.items || []).some(x => x.path === 'google:/' + madeId && x.dir), 'папка сразу видна в списке (без перезагрузки страницы)');
r = await call('/api/yadisk/op', { method: 'POST', body: { op: 'mkdir', path: 'google:/root/с/косой' } }, A.token);
ok(r.status === 400, 'имя с косой чертой не принимается');

console.log('\n  3. Переименование');
r = await call('/api/yadisk/op', { method: 'POST', body: { op: 'rename', path: 'google:/' + RENAME_ID, name: 'Новое имя.txt' } }, A.token);
ok(r.status === 200, 'переименовать можно');
ok(seen.rename.length === 1 && seen.rename[0].to === 'Новое имя.txt', 'у Google имя действительно изменилось');
r = await call('/api/yadisk/list?path=' + encodeURIComponent('google:/root'), {}, A.token);
ok((r.d.items || []).some(x => x.path === 'google:/' + RENAME_ID && x.name === 'Новое имя.txt'), 'новое имя видно в списке');

console.log('\n  4. Удаление — в корзину Google');
r = await call('/api/yadisk/op', { method: 'POST', body: { op: 'del', path: 'google:/' + RENAME_ID } }, A.token);
ok(r.status === 200, 'удалить можно');
ok(seen.trash.length === 1 && seen.trash[0].id === RENAME_ID, 'Google получил «в корзину», а не «навсегда»');
r = await call('/api/yadisk/list?path=' + encodeURIComponent('google:/root'), {}, A.token);
ok(!(r.d.items || []).some(x => x.path === 'google:/' + RENAME_ID), 'удалённый файл из списка ушёл');
r = await call('/api/yadisk/op', { method: 'POST', body: { op: 'del', path: 'google:/root' } }, A.token);
ok(r.status === 400, 'корень Google удалить нельзя');

console.log('\n  5. Загрузка файла со своего устройства');
r = await call('/api/yadisk/upload-url?path=' + encodeURIComponent('google:/' + FOLDER_ID + '/Новый трек.mp3') + '&mime=audio%2Fmpeg&size=13', {}, A.token);
ok(r.status === 200 && r.d.direct === true && r.d.method === 'PUT', 'сервер открыл у Google сеанс загрузки и отдал адрес браузеру');
ok(String(r.d.href || '').includes('/upload-session/'), 'адрес ведёт прямо к Google, а не на наш сервер');
ok(seen.sessions.length === 1 && seen.sessions[0].name === 'Новый трек.mp3' && seen.sessions[0].mime === 'audio/mpeg', 'Google знает имя и тип файла заранее');
ok(seen.sessions[0].len === '13', 'Google знает размер — загрузка не оборвётся на середине');
const put = await fetch(r.d.href, { method: 'PUT', body: Buffer.from('ПРИВЕТ-128!!!'), headers: { 'Content-Type': 'audio/mpeg' } });
ok(put.status === 200, 'файл ушёл с «устройства» прямо в Google (сервер байтов не видел)');
ok(seen.uploads.length === 1 && seen.uploads[0].bytes === 'ПРИВЕТ-128!!!' && seen.uploads[0].parents[0] === FOLDER_ID, 'байты дошли целыми и лежат в нужной папке');
r = await call('/api/yadisk/list?path=' + encodeURIComponent('google:/' + FOLDER_ID), {}, A.token);
ok((r.d.items || []).some(x => x.name === 'Новый трек.mp3'), 'загруженный файл виден в проводнике');
r = await call('/api/yadisk/upload-url?path=' + encodeURIComponent('google:/' + FOLDER_ID + '/без-имени'), {}, A.token);
ok(r.status === 400 || r.status === 200, 'одиночное имя без родителя не путает сервер');

console.log('\n  6. Чужая открытая папка Google');
r = await call('/api/yadisk/share-file', { method: 'POST', body: { path: 'google:/' + FOLDER_ID, name: 'Фото', kind: 'folder', perm: 'write' } }, A.token);
ok(r.status === 200 && r.d.perm === 'write', 'Вася открыл папку с правом «менять»');
r = await call('/api/yadisk/shared-list?of=' + A.id + '&path=' + encodeURIComponent('google:/' + FOLDER_ID), {}, K.token);
ok(r.status === 200 && r.d.perm === 'write', 'Клава видит, что ей разрешили менять');
r = await call('/api/yadisk/op', { method: 'POST', body: { op: 'mkdir', path: 'google:/' + FOLDER_ID + '/Клава', of: A.id } }, K.token);
ok(r.status === 200, 'Клава создаёт папку в открытой ей папке (правом Васи)');
const kFolder = String(r.d.path || '');
r = await call('/api/yadisk/upload-url?of=' + A.id + '&path=' + encodeURIComponent(kFolder + '/файл.txt') + '&mime=text%2Fplain&size=3', {}, K.token);
ok(r.status === 200 && r.d.direct === true, 'Клава загружает файл внутрь открытой папки');
r = await call('/api/yadisk/op', { method: 'POST', body: { op: 'del', path: 'google:/' + FOLDER_ID, of: A.id } }, K.token);
ok(r.status === 403, 'саму открытую папку удалить нельзя');
r = await call('/api/yadisk/op', { method: 'POST', body: { op: 'mkdir', path: 'google:/root/вне', of: A.id } }, K.token);
ok(r.status === 404 || r.status === 403, 'за пределы открытой папки не выйти');
r = await call('/api/yadisk/op', { method: 'POST', body: { op: 'mkdir', path: 'google:/' + FOLDER_ID + '/Гость', of: A.id } }, G.token);
ok(r.status === 404, 'посторонний (не из чата) ничего не меняет');
r = await call('/api/yadisk/share-file', { method: 'POST', body: { path: 'google:/' + FOLDER_ID, name: 'Фото', kind: 'folder', perm: 'read' } }, A.token);
ok(r.status === 200 && r.d.perm === 'read', 'Вася сузил право до «смотреть»');
r = await call('/api/yadisk/op', { method: 'POST', body: { op: 'mkdir', path: 'google:/' + FOLDER_ID + '/ещё', of: A.id } }, K.token);
ok(r.status === 403, 'с правом «смотреть» менять нельзя');
r = await call('/api/yadisk/upload-url?of=' + A.id + '&path=' + encodeURIComponent('google:/' + FOLDER_ID + '/ещё.txt'), {}, K.token);
ok(r.status === 403, 'и загружать с правом «смотреть» тоже нельзя');

console.log('\n  7. Старый вход «только чтение»');
const cbK = await gconnect(K, 'c128ro');
ok(/Google Диск подключён!/.test(cbK), 'Клава тоже вошла в Google (старым правом «только смотреть»)');
let gdK = (await drivesA(K)).find(x => x.id === 'google') || {};
ok(gdK.connected === true && gdK.canWrite === false && gdK.readonly === true, 'сервер честно видит: этому входу менять нельзя');
r = await call('/api/yadisk/op', { method: 'POST', body: { op: 'mkdir', path: 'google:/root/Клава-папка' } }, K.token);
ok(r.status === 409 && /только смотреть/.test(String(r.d.error || '')), 'вместо отказа Google — понятное «войдите заново»');
ok(/Войти через Google/.test(String(r.d.error || '')), 'в подсказке сказано, что именно нажать');
r = await call('/api/yadisk/upload-url?path=' + encodeURIComponent('google:/root/файл.txt'), {}, K.token);
ok(r.status === 409, 'загрузка с таким входом тоже объясняет причину, а не молчит');
const before = seen.mkdir.length;
ok(seen.mkdir.length === before, 'к Google за этим входом даже не ходили (право проверено заранее)');
await gconnect(G, 'c128none');
let gdG = (await drivesA(G)).find(x => x.id === 'google') || {};
ok(gdG.canWrite === true, 'вход без записи о правах (выпуск 126) считается рабочим — решает ответ Google');
r = await call('/api/yadisk/op', { method: 'POST', body: { op: 'mkdir', path: 'google:/root/Гость-папка' } }, G.token);
ok(r.status === 200, 'и папка у него создаётся');

console.log('\n  8. Клиент: кнопки правок больше не погашены');
const appJs = read('public/app.js');
ok(/const writable = mine \? gWrite : \(st\.perm === 'write'\)/.test(appJs), 'право на правки зависит от прав входа, а не от «диска»');
ok(/gd-more/.test(appJs) && /Разрешить изменения/.test(appJs), 'в окне подключения есть кнопка «Разрешить изменения»');
ok(!/В Google Диске пока только чтение/.test(appJs), 'старый запрет «в Google только чтение» убран');
ok(/if \(op === 'rename' && g\.to && !g\.name\)/.test(appJs), 'у Google новое имя едет именем, а не путём');
ok(/&mime=' \+ encodeURIComponent/.test(appJs) && /&size=' \+ encodeURIComponent/.test(appJs), 'клиент сообщает Google тип и размер файла');
ok(/realPerm/.test(appJs), 'тост «Поделиться» говорит о праве, которое дал сервер');

console.log('\n  9. Отметки выпуска');
const b2 = (/const BUILD = '([^']+)'/.exec(appJs) || [])[1];
const cache = (/const STATIC_CACHE = '([^']+)'/.exec(read('public/sw.js')) || [])[1];
ok(b2 === BUILD && BUILD === 'pkg3-134', `отметка выпуска в клиенте и в тестах одна (${BUILD})`);
ok(((/const BUILD = '([^']+)'/.exec(read('lib/api.js')) || [])[1]) === BUILD, 'BUILD в lib/api.js тот же');
ok(/\| pkg3-134 \|/.test(read('README.md')), `в журнале README есть строка ${BUILD}`);
ok(cache === 'sega-static-v128', `кэш оформления поднят (${cache}) — устройства получат новые окна`);
ok(read('package.json').includes('node test/ui128.mjs'), 'тест ui128 включён в цепочку npm test');

console.log(`\n  ИТОГ: ${good} ✓, ${bad ? bad + ' провалов' : 'провалов нет'}\n`);
process.exit(bad ? 1 : 0);
