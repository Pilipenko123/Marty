/**
 * pkg3-90: Яндекс.Диск — облачное хранилище «Моей музыки» (вариант А).
 *
 * Что проверяем и почему именно так:
 *   1) lib/yadisk.js как чистый модуль: разбор файла ключей (без него сервер
 *      честно говорит «ключей нет»), печать/распечатка токена (AES-256-GCM),
 *      отбраковка кривых путей, сборка ссылки согласия ТОЛЬКО на своём домене.
 *   2) Живой сервер + ИГРУШЕЧНЫЙ Яндекс (локальный HTTP-стенд вместо
 *      oauth.yandex.ru и cloud-api.yandex.net): полный путь подключения —
 *      «state» одноразовый, код меняется на токен, токен ложится в базу
 *      ЗАШИФРОВАННЫМ (в db.json нет plaintext-токена), список аудиофайлов,
 *      временная ссылка на трек, подозрительная ссылка НЕ отдаётся браузеру,
 *      чужой участник чужой Диск не видит, отключение стирает связь,
 *      просроченный токен продлевается сам (refresh_token).
 *   3) Метки выпуска: BUILD pkg3-90 в двух файлах, кэш v83, клиентские и
 *      серверные следы Диска, единственная зависимость web-push.
 *
 * Запуск: node test/music90.mjs
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const yadisk = require(path.join(ROOT, 'lib', 'yadisk.js'));
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let good = 0, bad = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ПРОВАЛ: ') + m); if (c) good++; else bad++; };
const hex = (n = 16) => crypto.randomBytes(n).toString('hex');
const wait = ms => new Promise(r => setTimeout(r, ms));

console.log('\n══════════════════════════════════════════════════');
console.log('  pkg3-90: Яндекс.Диск — облако для «Моей музыки»');
console.log('══════════════════════════════════════════════════\n');

// ─────────────────────────── 1. чистый модуль ───────────────────────────
console.log('  lib/yadisk.js — модуль без сети');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sega-m90-'));
const keysPath = path.join(dir, 'yandex-oauth.json');
ok(yadisk.loadKeys(keysPath) === null, 'нет файла ключей — loadKeys() честно даёт null (сервер скажет «ключей нет»)');
fs.writeFileSync(keysPath, JSON.stringify({ client_id: 'ID1', client_secret: 'SECRET1' }));
let k = yadisk.loadKeys(keysPath);
ok(k && k.clientId === 'ID1' && k.clientSecret === 'SECRET1', 'файл ключей читается: client_id/client_secret на месте');
fs.writeFileSync(keysPath, JSON.stringify({ clientId: 'ID2', secret: 'SECRET2' }));
k = yadisk.loadKeys(keysPath);
ok(k && k.clientId === 'ID2' && k.clientSecret === 'SECRET2', '«человеческие» имена полей (clientId/secret) тоже понимаются');
fs.writeFileSync(keysPath, 'это не json{');
ok(yadisk.loadKeys(keysPath) === null, 'кривой файл ключей — null, сервер не падает');

const tk = yadisk.tokenKey('SECRET1');
const sealed = yadisk.sealToken(tk, { access_token: 'AT-X', refresh_token: 'RT-X', expires_at: 123 });
ok(typeof sealed === 'string' && sealed.startsWith('v1.') && !sealed.includes('AT-X'), 'токен запечатан: в строке базы нет открытого access_token');
const opened = yadisk.openToken(tk, sealed);
ok(opened && opened.access_token === 'AT-X' && opened.refresh_token === 'RT-X', 'своим ключом токен распечатывается обратно');
ok(yadisk.openToken(yadisk.tokenKey('ДРУГОЙ-СЕКРЕТ'), sealed) === null, 'чужим ключом (сменили пароль приложения) токен НЕ открывается — null');
ok(yadisk.openToken(tk, 'мусор') === null && yadisk.openToken(tk, '') === null, 'битая строка токена — null, без исключений');
ok(Buffer.compare(tk, yadisk.tokenKey('SECRET1')) === 0 && Buffer.compare(tk, yadisk.tokenKey('SECRET2')) !== 0, 'ключ печати устойчив и зависит от пароля приложения');

ok(yadisk.safePath('disk:/Музыка/т.mp3') === 'disk:/Музыка/т.mp3', 'путь disk:/… проходит');
ok(yadisk.safePath('/Музыка/т.mp3') === 'disk:/Музыка/т.mp3', 'путь с «/» приводится к disk:/');
ok(yadisk.safePath('http://evil/x.mp3') === null, 'чужая схема (http:) отброшена');
ok(yadisk.safePath('disk:/a/../b') === null, 'путь с «..» отброшен');
ok(yadisk.safePath('') === null && yadisk.safePath(null) === null, 'пустой путь отброшен');
ok(yadisk.safePath('x'.repeat(5000)) === null, 'слишком длинный путь отброшен');

const cfgFix = { oauthBase: 'https://oauth.yandex.ru', apiBase: 'https://cloud-api.yandex.net', keysPath: '/nonexistent', redirect: 'https://segachat.pilpro.ru/api/yadisk/callback' };
const au = yadisk.buildAuthUrl({ clientId: 'ID1', clientSecret: 'S' }, 'STATE1', cfgFix);
ok(au.startsWith('https://oauth.yandex.ru/authorize?') && au.includes('client_id=ID1') && au.includes('state=STATE1') && au.includes('response_type=code'),
  'ссылка согласия собирается на oauth.yandex.ru с client_id, state и response_type=code');
ok(!au.includes('client_secret') && !au.includes('TESTSECRET'), 'пароль приложения в ссылку НЕ попадает');
ok(au.includes(encodeURIComponent('https://segachat.pilpro.ru/api/yadisk/callback')), 'обратный адрес передаётся Яндексу закодированным');

// ─────────────────── 2. игрушечный Яндекс + живой сервер ───────────────────
console.log('\n  живой сервер против игрушечного Яндекса');

const calls = [];
let atN = 0, rfN = 0;
const mock = http.createServer((rq, rs) => {
  const u = new URL(rq.url, 'http://mock');
  const jsend = (code, obj) => { rs.writeHead(code, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify(obj)); };
  if (rq.method === 'POST' && u.pathname === '/token') {
    let b = '';
    rq.on('data', c => { b += c; });
    rq.on('end', () => {
      const f = new URLSearchParams(b);
      calls.push({ t: 'token', grant: f.get('grant_type'), code: f.get('code'), rt: f.get('refresh_token'), cid: f.get('client_id'), csec: f.get('client_secret') });
      if (f.get('grant_type') === 'authorization_code' && (f.get('code') === 'GOODCODE' || f.get('code') === 'SHORTLIFE')) {
        atN++;
        return jsend(200, { access_token: 'AT-' + atN, refresh_token: 'RT-' + atN, expires_in: f.get('code') === 'SHORTLIFE' ? 60 : 3600, token_type: 'bearer', scope: 'cloud_api:disk.read' });
      }
      if (f.get('grant_type') === 'refresh_token' && f.get('refresh_token')) {
        rfN++;
        return jsend(200, { access_token: 'AT-R' + rfN, refresh_token: 'RT-R' + rfN, expires_in: 3600, token_type: 'bearer' });
      }
      return jsend(400, { error: 'invalid_grant', error_description: 'Неверный код' });
    });
    return;
  }
  if (rq.method === 'GET' && u.pathname === '/v1/disk/resources/files') {
    const auth = String(rq.headers.authorization || '');
    calls.push({ t: 'files', auth, media: u.searchParams.get('media_type'), limit: u.searchParams.get('limit') });
    if (!/^OAuth AT-/.test(auth)) return jsend(401, { message: 'Unauthorized', description: 'token' });
    return jsend(200, {
      items: [
        { path: 'disk:/Музыка/трек1.mp3', name: 'трек1.mp3', size: 5000000, mime_type: 'audio/mpeg', modified: '2026-10-01T10:00:00+03:00' },
        { path: 'disk:/Загрузки/трек2.ogg', name: 'трек2.ogg', size: 3000000, mime_type: 'audio/ogg', modified: '2026-10-02T10:00:00+03:00' }
      ],
      limit: Number(u.searchParams.get('limit')) || 200,
      offset: Number(u.searchParams.get('offset')) || 0
    });
  }
  if (rq.method === 'GET' && u.pathname === '/v1/disk/resources/download') {
    const auth = String(rq.headers.authorization || '');
    const p = String(u.searchParams.get('path') || '');
    calls.push({ t: 'download', auth, p });
    if (!/^OAuth AT-/.test(auth)) return jsend(401, { message: 'Unauthorized' });
    if (p === 'disk:/Музыка/трек1.mp3') return jsend(200, { href: 'https://mock-cdn.yandex.net/get/track1?sig=xyz', method: 'GET', ttl: '1800' });
    if (p === 'disk:/evil.mp3') return jsend(200, { href: 'https://evil.example.com/steal.mp3', method: 'GET' });
    return jsend(404, { message: 'Resource not found', description: 'disk' });
  }
  jsend(404, {});
});
await new Promise(r => mock.listen(0, '127.0.0.1', r));
const mockPort = mock.address().port;
const mockBase = 'http://127.0.0.1:' + mockPort;

async function freePort() {
  const { createServer } = await import('node:net');
  return new Promise(r => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
}
const procs = [];
process.on('exit', () => { for (const p of procs) { try { p.kill('SIGKILL'); } catch (e) {} } try { mock.close(); } catch (e) {} });

const dataDir = path.join(dir, 'data');
const port = await freePort();
const proc = spawn(process.execPath, ['server.js'], {
  cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
  env: Object.assign({}, process.env, {
    STORE: 'file', DATA_DIR: dataDir, HOST: '127.0.0.1', HTTPS: '', PRESENCE_EVERY: '0', NEW_INVITE_DELAY: '0',
    INVITE_COOLDOWN_MS: '0', PORT: String(port),
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
  const r = await fetch(base + p, { ...opts, headers: h, body: opts.body ? JSON.stringify(opts.body) : undefined, redirect: 'manual' });
  const ct = r.headers.get('content-type') || '';
  const txt = await r.text();
  if (ct.includes('json')) { try { return { status: r.status, d: JSON.parse(txt), txt }; } catch (e) {} }
  return { status: r.status, d: txt, txt };
}

const creds = name => ({ name, saltAuth: hex(), authKey: hex(32), saltWrap: hex(), wrappedKeyByPass: 'w:' + hex(), pub: 'pub:' + hex(), wrappedPriv: 'priv:' + hex() });
let r = await call('/api/setup', { method: 'POST', body: Object.assign({}, creds('Мартин'), { codeProofSalt: hex(), codeProof: hex(32), codeSalt: hex(), wrappedKeyByCode: 'k:' + hex() }) });
ok(r.status === 200, 'мессенджер настроен');
const admin = r.d.token;
r = await call('/api/state');
ok(r.status === 200 && r.d.build === 'pkg3-90', 'сервер помечен pkg3-90');
const secret = hex(24);
const sha = crypto.createHash('sha256').update(secret).digest('hex');
const ir = await call('/api/invites', { method: 'POST', body: { invSalt: hex(), wrappedRoomKey: 'k:' + hex(), secretHash: sha } }, admin);
r = await call('/api/register', { method: 'POST', body: Object.assign({}, creds('Вася'), { inviteToken: ir.d.invite.id + '.' + secret }) });
const v1 = r.d.token;
ok(!!v1, 'второй участник готов');

// ключей пока нет (файл испорчен шагом модульных тестов) — честные отказы
r = await call('/api/yadisk/state', {}, admin);
ok(r.status === 200 && r.d.keys === false && r.d.connected === false, 'нет ключей: state честно отвечает keys:false');
r = await call('/api/yadisk/auth-url', {}, admin);
ok(r.status === 409, 'нет ключей: подключение не даётся (409)');
r = await call('/api/yadisk/files', {}, admin);
ok(r.status === 409 && /ключей/.test(String(r.d.error || '')), 'нет ключей: список файлов честно объясняет, чего не хватает');

// кладём ключи — сервер подхватывает их БЕЗ перезапуска (файл читается на каждый запрос)
fs.writeFileSync(keysPath, JSON.stringify({ client_id: 'TESTID', client_secret: 'TESTSECRET' }));
r = await call('/api/yadisk/state', {}, admin);
ok(r.status === 200 && r.d.keys === true && r.d.connected === false, 'ключи появились: keys:true без перезапуска сервера');

r = await call('/api/yadisk/auth-url', {}, admin);
const authUrl = r.d && r.d.url;
ok(r.status === 200 && authUrl && authUrl.startsWith(mockBase + '/authorize?'), 'auth-url собран на «Яндексе» (в тесте — стенд)');
const st1 = new URL(authUrl).searchParams.get('state');
ok(authUrl.includes('client_id=TESTID') && st1 && st1.length === 32, 'в ссылке client_id и одноразовый state (32 знака)');
ok(!authUrl.includes('TESTSECRET'), 'пароль приложения в ссылку для браузера НЕ попал');

r = await call('/api/yadisk/callback?code=GOODCODE&state=' + hex(16));
ok(r.status === 200 && /устарела/i.test(r.txt), 'callback с чужим state — «ссылка устарела», токен не создаётся');
r = await call('/api/yadisk/callback?error=access_denied&state=' + st1);
ok(r.status === 200 && /Разрешение не выдано/.test(r.txt), 'отказ на странице Яндекса — человеческая страница «Разрешение не выдано»');
r = await call('/api/yadisk/callback?code=GOODCODE&state=' + st1);
ok(r.status === 200 && /устарела/i.test(r.txt), 'state ОДНОРАЗОВЫЙ: повторно тот же state не работает');

r = await call('/api/yadisk/auth-url', {}, admin);
const st2 = new URL(r.d.url).searchParams.get('state');
r = await call('/api/yadisk/callback?code=BADCODE&state=' + st2);
ok(r.status === 200 && /Не получилось/.test(r.txt), 'Яндекс отверг код — страница «Не получилось подключить»');
r = await call('/api/yadisk/state', {}, admin);
ok(r.d.connected === false, 'после плохого кода подключения нет');

r = await call('/api/yadisk/auth-url', {}, admin);
const st3 = new URL(r.d.url).searchParams.get('state');
r = await call('/api/yadisk/callback?code=GOODCODE&state=' + st3);
ok(r.status === 200 && /Диск подключён/.test(r.txt), 'верный код — страница «Диск подключён!»');
r = await call('/api/yadisk/state', {}, admin);
ok(r.d.connected === true, 'state: Диск подключён');
const tokCall = calls.filter(c => c.t === 'token' && c.grant === 'authorization_code').pop();
ok(tokCall && tokCall.cid === 'TESTID' && tokCall.csec === 'TESTSECRET', 'код менялся на токен НА СЕРВЕРЕ: client_secret ушёл только в «Яндекс», не в браузер');

// в базе лежит печать, а не открытый токен
let dbTxt = fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8');
ok(!/AT-\d/.test(dbTxt) && !/RT-\d/.test(dbTxt), 'в db.json НЕТ открытых токенов Яндекса');
ok(/"yadisk":\{"blob":"v1\./.test(dbTxt), 'в db.json токен лежит запечатанным (blob «v1.…»)');

r = await call('/api/yadisk/files?limit=200&offset=0', {}, admin);
ok(r.status === 200 && Array.isArray(r.d.items) && r.d.items.length === 2 && r.d.items[0].path === 'disk:/Музыка/трек1.mp3', 'список аудиофайлов Диска получен');
const filesCall = calls.filter(c => c.t === 'files').pop();
ok(filesCall && filesCall.media === 'audio' && /^OAuth AT-/.test(filesCall.auth), 'у Яндекса спрошен ровно аудио-список (media_type=audio) с токеном владельца');

r = await call('/api/yadisk/href?path=' + encodeURIComponent('disk:/Музыка/трек1.mp3'), {}, admin);
ok(r.status === 200 && /^https:\/\/mock-cdn\.yandex\.net\//.test(r.d.href || ''), 'временная ссылка на трек выдана');
r = await call('/api/yadisk/href?path=' + encodeURIComponent('disk:/evil.mp3'), {}, admin);
ok(r.status === 502 && !/evil\.example\.com/.test(r.txt), 'подозрительная ссылка (не домен Яндекса) браузеру НЕ отдаётся — 502');
r = await call('/api/yadisk/href?path=' + encodeURIComponent('disk:/нет-такого.mp3'), {}, admin);
ok(r.status === 404, 'ссылка на отсутствующий файл — честный 404');
r = await call('/api/yadisk/href?path=../etc/passwd', {}, admin);
ok(r.status === 400, 'путь с «..» отброшен — 400');
r = await call('/api/yadisk/href?path=', {}, admin);
ok(r.status === 400, 'пустой путь отброшен — 400');
r = await call('/api/yadisk/href?path=' + encodeURIComponent('https://evil/x.mp3'), {}, admin);
ok(r.status === 400, 'чужая схема вместо пути Диска отброшена — 400');

// чужой участник: мой Диск — только мой
r = await call('/api/yadisk/state', {}, v1);
ok(r.status === 200 && r.d.connected === false, 'у второго участника Диск НЕ подключён (токены не общие)');
r = await call('/api/yadisk/files', {}, v1);
ok(r.status === 409, 'второй участник список МОЕГО Диска получить не может (409)');
r = await call('/api/yadisk/href?path=' + encodeURIComponent('disk:/Музыка/трек1.mp3'), {}, v1);
ok(r.status === 409, 'и временную ссылку на мой файл — тоже не может');
r = await call('/api/yadisk/files');
ok(r.status === 401, 'без входа маршруты Диска закрыты (401)');

// отключение
r = await call('/api/yadisk/disconnect', { method: 'POST' }, admin);
ok(r.status === 200 && r.d.ok === true, 'отключение принято');
r = await call('/api/yadisk/state', {}, admin);
ok(r.d.connected === false, 'после отключения Диск не подключён');
r = await call('/api/yadisk/files', {}, admin);
ok(r.status === 409, 'список после отключения не отдаётся');
dbTxt = fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8');
ok(!/"yadisk":\{"blob"/.test(dbTxt), 'печать токена стёрта из базы при отключении');

// короткоживущий токен продлевается сам (refresh_token)
r = await call('/api/yadisk/auth-url', {}, admin);
const st4 = new URL(r.d.url).searchParams.get('state');
r = await call('/api/yadisk/callback?code=SHORTLIFE&state=' + st4);
ok(r.status === 200 && /Диск подключён/.test(r.txt), 'подключение с «коротким» токеном состоялось');
const beforeFiles = calls.filter(c => c.t === 'files').length;
r = await call('/api/yadisk/files', {}, admin);
ok(r.status === 200 && r.d.items.length === 2, 'список получен и с почти истёкшим токеном');
const refCall = calls.filter(c => c.t === 'token' && c.grant === 'refresh_token').pop();
ok(!!refCall && refCall.rt, 'сервер САМ продлил токен (grant_type=refresh_token)');
const lastFiles = calls.filter(c => c.t === 'files').pop();
ok(calls.filter(c => c.t === 'files').length === beforeFiles + 1 && /^OAuth AT-R/.test(lastFiles.auth), 'список запрошен уже продлённым токеном');

// ─────────────────────────── 3. метки выпуска ───────────────────────────
console.log('\n  метки pkg3-90 в дереве');

const appJs = read('public/app.js');
const apiJs = read('lib/api.js');
const sw = read('public/sw.js');
const css = read('public/styles.css');
const pkg = read('package.json');
const readme = read('README.md');
const dom42 = read('test/dom42.mjs');
const sound80 = read('test/sound80.mjs');
const games81 = read('test/games81.mjs');

ok(appJs.includes("const BUILD = 'pkg3-90';") && apiJs.includes("const BUILD = 'pkg3-90';"), 'BUILD pkg3-90 совпадает в клиенте и на сервере');
ok(sw.includes("const STATIC_CACHE = 'sega-static-v83';"), 'кэш статики поднят до v83');
ok(dom42.includes('sega-static-v83') && sound80.includes('sega-static-v83') && games81.includes('sega-static-v83'), 'три набора тестов ждут именно v83');
for (const s of ['MUS_DISK', 'musicIsDisk', 'musicStartDiskTrack', '/api/yadisk/files', '/api/yadisk/href', '/api/yadisk/state', 'data-mus-disk-play', 'data-mus-disk-add', 'mus-pl-disk', '☁ Яндекс.Диск']) {
  ok(appJs.includes(s), 'клиент содержит «' + s + '»');
}
for (const s of ['/api/yadisk/callback', '/api/yadisk/disconnect', 'ydFreshToken', 'sealToken', 'ydStates']) {
  ok(apiJs.includes(s), 'сервер содержит «' + s + '»');
}
ok(css.includes('.mus-badge-d') && css.includes('.mus-pl-disk') && css.includes('.mus-disk-bar'), 'стили панели Диска на месте');
ok(pkg.includes('node test/music90.mjs'), 'тест pkg3-90 включён в цепочку npm test');
const deps = JSON.parse(pkg).dependencies;
ok(Object.keys(deps).length === 1 && deps['web-push'], 'зависимость по-прежнему одна: web-push (Диск работает без новых библиотек)');
ok(readme.includes('| pkg3-90 |'), 'в журнале README есть строка выпуска pkg3-90');
ok(/for\s*\(\s*(?:const|let|var)\s+[\w$]+\s+of\s+\$\(/.test(appJs) === false, 'сторож pkg3-89: сломанных циклов «of $(» по-прежнему нет');

console.log('\n  pkg3-90: ' + good + ' ✓' + (bad ? ', ' + bad + ' ПРОВАЛОВ' : ', провалов нет'));
process.exit(bad ? 1 : 0);
