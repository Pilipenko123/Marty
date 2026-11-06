// test/ui121.mjs — pkg3-121: четыре просьбы владельца к 120-му.
//
//   1) бегущая строка названия — В СТРОКАХ СПИСКА («Моя музыка»), там же и
//      источник трека; у результатов поиска так же;
//   2) справа от обложки название читается ПЕРЕНОСОМ, подпись источника остаётся;
//   3) музыка с Яндекс.Диска владельца доступна другим: слушать и забирать в
//      свой плейлист;
//   4) новый (тестовый) аккаунт получил от Яндекса «400 · Неизвестно приложение
//      с таким client_id» — теперь приложение проверяет это САМО и говорит
//      по-русски, что править.
//
// Серверные сценарии — на живом сервере с игрушечным Яндексом; вид проверяет
// владелец (браузера в песочнице нет).
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
console.log('  pkg3-121: бегущая строка в списках, перенос в окне,');
console.log('            чужой Диск и проверка приложения Яндекса');
console.log('══════════════════════════════════════════════════\n');

// ─────────────── игрушечный Яндекс (диск + страница согласия) ───────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sega-m121-'));
const keysPath = path.join(dir, 'yandex-oauth.json');
fs.writeFileSync(keysPath, JSON.stringify({ client_id: 'ID121', client_secret: 'SECRET121' }));
let mockMode = 'ok';   // 'bad' — Яндекс «не знает» приложение
const mock = http.createServer((rq, rs) => {
  const u = new URL(rq.url, 'http://mock');
  const jsend = (code, obj) => { rs.writeHead(code, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify(obj)); };
  if (rq.method === 'GET' && u.pathname === '/authorize') {
    if (mockMode === 'bad') {
      rs.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      rs.end('<html><body><h1>400</h1><p>Неизвестно приложение с таким client_id</p></body></html>');
      return;
    }
    rs.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    rs.end('<html><body>Войдите в Яндекс, чтобы разрешить доступ</body></html>');
    return;
  }
  if (rq.method === 'POST' && u.pathname === '/token') {
    let b = '';
    rq.on('data', c => { b += c; });
    rq.on('end', () => jsend(200, { access_token: 'AT-121', refresh_token: 'RT-121', expires_in: 3600, token_type: 'bearer' }));
    return;
  }
  if (rq.method === 'GET' && u.pathname === '/v1/disk/resources/download') {
    const p = String(u.searchParams.get('path') || '');
    return jsend(200, { href: 'https://mock-cdn.yandex.net/get/' + encodeURIComponent(p) + '?sig=121', method: 'GET', ttl: '1800' });
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
const adminId = r.d.user.id;
const join = async (name) => {
  const secret = hex(24);
  const sha = crypto.createHash('sha256').update(secret).digest('hex');
  const ir = await call('/api/invites', { method: 'POST', body: { invSalt: hex(), wrappedRoomKey: 'k:' + hex(), secretHash: sha } }, admin);
  const rr = await call('/api/register', { method: 'POST', body: Object.assign({}, creds(name), { inviteToken: ir.d.invite.id + '.' + secret }) });
  return { token: rr.d.token, id: rr.d.user.id };
};
const A = await join('Вася');     // у него свой Диск
const B = await join('Клава');    // друг: с Васей в общем чате
const C = await join('Гость');    // посторонний: общих чатов нет
ok(!!A.token && !!B.token && !!C.token, 'три участника готовы');
r = await call('/api/dm', { method: 'POST', body: { peer: B.id } }, A.token);
ok(r.status === 200, 'личный чат Вася↔Клава создан');

console.log('\n  1. Свой Диск: подключение и открытый плейлист');
r = await call('/api/yadisk/auth-url', {}, A.token);
ok(r.status === 200 && r.d.url, 'ссылка согласия получена');
const st = String(r.d.url).split('state=')[1];
r = await fetch(base + '/api/yadisk/callback?code=GOODCODE&state=' + st);
ok(r.status === 200, 'обратный ход Яндекса принят (Диск подключён)');
r = await call('/api/yadisk/state', {}, A.token);
ok(r.status === 200 && r.d.connected === true, 'Диск числится подключённым');
ok(r.d.share === true, 'по умолчанию владелец поделился Диском (просьба владельца)');
r = await call('/api/music', { method: 'POST', body: { pub: [{ id: 'p1', name: 'Открытый', vis: 'pub', tracks: [{ id: 't1', kind: 'disk', path: 'disk:/pub.mp3', diskOf: A.id, title: 'Открытый трек' }] }] } }, A.token);
ok(r.status === 200, 'в открытый плейлист лёг трек с Диска (с пометкой, чей он)');

console.log('\n  2. Друг слушает трек с чужого Диска');
r = await call('/api/yadisk/shared-href?of=' + A.id + '&path=' + encodeURIComponent('disk:/pub.mp3'), {}, B.token);
ok(r.status === 200 && String(r.d.href).startsWith('https://mock-cdn.yandex.net/'), 'друг получил свежую временную ссылку на трек владельца');
ok(String(r.d.href).includes('pub.mp3'), 'ссылка — именно на этот файл');
r = await call('/api/yadisk/shared-href?of=' + A.id + '&path=' + encodeURIComponent('disk:/secret.mp3'), {}, B.token);
ok(r.status === 404, 'файл вне открытых плейлистов не отдаётся (по чужому Диску нельзя гулять)');
r = await call('/api/yadisk/shared-href?of=' + A.id + '&path=' + encodeURIComponent('disk:/pub.mp3'), {}, C.token);
ok(r.status === 404, 'посторонний (нет общего чата) ссылку не получает');
r = await call('/api/yadisk/shared-href?of=' + A.id + '&path=' + encodeURIComponent('disk:/a/../b'), {}, B.token);
ok(r.status === 400, 'путь с «..» отбрасывается');
r = await call('/api/music/' + encodeURIComponent(A.id), {}, B.token);
ok(r.status === 200 && r.d.pub[0].tracks[0].diskOf === A.id, 'друг видит открытый плейлист и пометку, чей Диск');
ok(JSON.stringify(r.d).indexOf('musicPriv') < 0 && r.d.priv === undefined, 'личные списки по-прежнему не отдаются');

console.log('\n  3. Владелец может закрыть доступ');
r = await call('/api/yadisk/share', { method: 'POST', body: { share: false } }, A.token);
ok(r.status === 200 && r.d.share === false, 'тумблер «другие могут слушать» выключен');
r = await call('/api/yadisk/shared-href?of=' + A.id + '&path=' + encodeURIComponent('disk:/pub.mp3'), {}, B.token);
ok(r.status === 403, 'после выключения друг ссылку не получает');
r = await call('/api/yadisk/shared-href?of=' + A.id + '&path=' + encodeURIComponent('disk:/pub.mp3'), {}, A.token);
ok(r.status === 200, 'сам владелец свой трек по-прежнему играет');
await call('/api/yadisk/share', { method: 'POST', body: { share: true } }, A.token);
r = await call('/api/yadisk/state', {}, A.token);
ok(r.d.share === true, 'тумблер включается обратно');

console.log('\n  4. Проверка приложения Яндекса (ошибка 400 у второго аккаунта)');
mockMode = 'ok';
r = await call('/api/yadisk/diag', {}, B.token);
ok(r.status === 200 && r.d.keys === true, 'проверка видит файл ключей');
ok(r.d.ok === true && r.d.reason === '', 'живое приложение: проверка проходит');
ok(r.d.clientId === 'D121', 'в ответе только хвост client_id (' + r.d.clientId + '), целого в браузер не отдаём');
mockMode = 'bad';
r = await call('/api/yadisk/diag', {}, B.token);
ok(r.d.ok === false && r.d.reason === 'unknown-app', 'удалённое/чужое приложение распознано: reason=unknown-app');
mockMode = 'ok';
const appJs = read('public/app.js');
ok(appJs.includes('async function ydDiag(') && appJs.includes('function ydDiagHelp('), 'клиент: своя проверка и понятное окно «что делать»');
ok(/const chk = await ydDiag\(false\);/.test(appJs) && /ydDiagHelp\(chk\.text\)/.test(appJs),
  'перед открытием Яндекса приложение проверяет ключи и не уводит на чужую страницу с 400');
ok(appJs.includes('Неизвестно приложение'), 'в подсказке прямо названа эта ошибка Яндекса');
ok(appJs.includes('Если это ваш второй (тестовый) аккаунт'), 'и объяснено про тестовый аккаунт');
ok(read('lib/yadisk.js').includes('async function probeAuth('), 'сервер: probeAuth спрашивает у Яндекса страницу по своему client_id');

console.log('\n  5. Метки клиента и оформления');
const css = read('public/styles.css');
const sw = read('public/sw.js');
ok(/<span class="mq">\$\{escapeHtml\(t\.title/.test(appJs), 'строка плейлиста: название — бегущая строка');
ok(/<span class="mq">\$\{escapeHtml\(t\.title\)\}/.test(appJs), 'результаты поиска: тоже бегущая строка');
ok(/mus-badge" title="Источник, откуда взят трек"/.test(appJs), 'и там же — бейдж источника трека');
ok(/function musMarqueeSync\(\)[\s\S]{0,400}querySelectorAll\('#modal \.mus-trs'\)/.test(appJs), 'замер обходит все списки окна музыки');
ok(/<div class="mus-nowt" id="mus-now-title">/.test(appJs), 'справа от обложки — обычное название (перенос), не бегущая строка');
ok(/\.mus-v105 \.mus-nowt\{\n  display:-webkit-box/.test(css) && /-webkit-line-clamp:6/.test(css), 'оно переносится и ограничено шестью строками');
ok(!/\.mus-v105 \.mus-nowt \.mq\{/.test(css), 'правила «едет название в окне» больше нет');
ok(/id="mus-now-src"/.test(appJs), 'подпись источника в окне осталась');
ok(/diskOf: \(S\.me && S\.me\.id\) \|\| ''/.test(appJs), 'свой дисковый трек помнит, чей он');
ok(/api\/yadisk\/shared-href\?of=/.test(appJs), 'клиент просит ссылку на чужой Диск отдельным маршрутом');
ok(appJs.includes('data-musof-disk') && appJs.includes('data-musof-add'), 'в чужом плейлисте трек можно слушать и забрать себе');
ok(appJs.includes('function musAskPlaylist('), '«＋» спрашивает, в какой плейлист положить');
ok(/id="mus-disk-share"/.test(appJs), 'в панели Диска есть тумблер «другие могут слушать»');
ok(read('lib/api.js').includes("'/api/yadisk/shared-href'") && read('lib/api.js').includes("'/api/yadisk/share'") && read('lib/api.js').includes("'/api/yadisk/diag'"),
  'сервер: все три маршрута на месте');
ok(/\.mus-of-row\{display:flex/.test(css) && /\.mus-of-row \.mus-of-add\{/.test(css), 'оформление строки чужого плейлиста — в тон панелям');

console.log('\n  6. Отметки выпуска');
const b2 = (/const BUILD = '([^']+)'/.exec(appJs) || [])[1];
const cache = (/const STATIC_CACHE = '([^']+)'/.exec(sw) || [])[1];
ok(b2 === BUILD, `отметка выпуска в клиенте и в тестах одна (${BUILD})`);
ok(((/const BUILD = '([^']+)'/.exec(read('lib/api.js')) || [])[1]) === BUILD, 'BUILD в lib/api.js тот же');
ok(new RegExp('\\| ' + BUILD + ' \\|').test(read('README.md')), `в журнале README есть строка ${BUILD}`);
ok(cache === 'sega-static-v136', `кэш оформления поднят (${cache}) — устройства получат правки`);
ok(read('package.json').includes('node test/ui121.mjs'), 'тест ui121 включён в цепочку npm test');

console.log(`\n  ИТОГ: ${good} ✓, ${bad ? bad + ' провалов' : 'провалов нет'}\n`);
process.exit(bad ? 1 : 0);   // тест держит живой сервер и игрушечный Яндекс — выходим сами
