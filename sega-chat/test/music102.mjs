// test/music102.mjs — pkg3-102: разовый пропуск запасного пути звука.
// Урок 101-го: плеер (<audio>) не шлёт заголовок входа, сервер отвечал 401 и
// звучало как «источник не отдал звук». Теперь пропуск живёт в памяти сервера:
// выдаётся входным запросом, предъявляется без заголовков, привязан к ссылке,
// 20 минут скользящих (в тесте — доли секунды), старый адрес без пропуска закрыт.
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
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ПРОВАЛ: ') + m); if (c) good++; else bad++; }
const hex = (n = 16) => crypto.randomBytes(n).toString('hex');
const wait = ms => new Promise(r => setTimeout(r, ms));

console.log('\n══════════════════════════════════════════════════');
console.log('  pkg3-102: пропуск для звука через сервер');
console.log('══════════════════════════════════════════════════\n');

const SONG = Buffer.alloc(300, 7);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sega-m102-'));
const mock = http.createServer((rq, rs) => {
  rs.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': String(SONG.length) });
  rs.end(SONG);
});
await new Promise(r => mock.listen(0, '127.0.0.1', r));
const mockHost = '127.0.0.1:' + mock.address().port;
const song = 'http://' + mockHost + '/audio/ok.mp3';

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
    MUSSTREAM_EXTRA_HOSTS: mockHost,
    MUS_TICKET_TTL: '700'                    // доли секунды вместо 20 минут — проверяем жизнь пропуска
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

let r = await call('/api/setup', { method: 'POST', body: Object.assign({}, creds('Мартин'), { codeProofSalt: hex(), codeProof: hex(32), codeSalt: hex(), wrappedKeyByCode: 'k:' + hex() }) });
ok(r.status === 200, 'мессенджер настроен');
const admin = r.d.token;

console.log('\n  1. Без пропуска звук закрыт, старый адрес 101-го не работает');
r = await call('/api/musstream', {}, null);
ok(r.status === 403, 'GET /api/musstream без пропуска — 403');
r = await call('/api/musstream?t=' + hex(24), {}, null);
ok(r.status === 403 && /просрочен или отсутствует/.test((r.d && r.d.error) || ''), 'чужой пропуск — 403 с человеческой подсказкой');
r = await call('/api/musstream?url=' + encodeURIComponent(song), {}, admin);
ok(r.status === 403, 'старый адрес 101-го (?url=) закрыт даже вошедшему — дыры нет');

console.log('\n  2. Пропуск: выдан входным, работает БЕЗ заголовков, привязан к ссылке');
r = await call('/api/musstream-ticket', { method: 'POST', body: {} }, admin);
ok(r.status === 400, 'пропуск без ссылки — честный 400');
r = await call('/api/musstream-ticket', { method: 'POST', body: { url: song } }, admin);
ok(r.status === 200 && typeof r.d.t === 'string' && r.d.t.length === 48, 'пропуск выдан: 48 знаков случайного hex');
const t1 = r.d.t;
const pl = await fetch(base + '/api/musstream?t=' + t1);   // как плеер: БЕЗ Authorization
ok(pl.status === 200 && (Buffer.from(await pl.arrayBuffer())).equals(SONG), 'плеерный запрос без заголовков получил звук');

console.log('\n  3. Жизнь пропуска: срок и скользящее продление');
await wait(900);
r = await call('/api/musstream?t=' + t1, {}, null);
ok(r.status === 403, 'пропуск без деятельности истёк (TTL) и убран');
r = await call('/api/musstream-ticket', { method: 'POST', body: { url: song } }, admin);
const t2 = r.d.t;
await wait(500);
let g = await fetch(base + '/api/musstream?t=' + t2);
ok(g.status === 200, 'первое обращение продлило пропуск (скользящий срок)');
await wait(500);
g = await fetch(base + '/api/musstream?t=' + t2);
ok(g.status === 200, 'второе обращение снова продлило — перемотка длинного трека не оборвётся');
await wait(900);
g = await fetch(base + '/api/musstream?t=' + t2);
ok(g.status === 403, 'без деятельности пропуск гаснет и после продлений');

console.log('\n  4. Дроссель выдачи пропусков');
let last = 0;
for (let i = 0; i < 95; i++) { const x = await call('/api/musstream-ticket', { method: 'POST', body: { url: song } }, admin); last = x.status; if (x.status === 429) break; }
ok(last === 429, 'после 90 пропусков за 10 минут дроссель говорит «подождите»');

console.log('\n  5. Метки выпуска');
const appJs = read('public/app.js');
const apiJs = read('lib/api.js');
const sw = read('public/sw.js');
const pkg = read('package.json');
const readme = read('README.md');
ok(appJs.includes("const BUILD = 'pkg3-105';") && apiJs.includes("const BUILD = 'pkg3-105';"), 'BUILD pkg3-105 совпадает в клиенте и на сервере');
ok(sw.includes("const STATIC_CACHE = 'sega-static-v98';"), 'кэш статики поднят до v95');
ok(apiJs.includes('MUS_TICKET_TTL') && apiJs.includes('musTicketIssue('), 'пропуски в памяти сервера, срок из env (тестам — доли секунды)');
ok(apiJs.includes("pathname === '/api/musstream-ticket' && method === 'POST'"), 'выдача пропуска — входной маршрут');
ok(appJs.includes('function musProxyOk(') && appJs.includes('startProxy'), 'клиент: белый список отдельно, тихий переход с пропуском отдельно');
ok(pkg.includes('node test/music102.mjs'), 'тест music102 включён в цепочку npm test');
ok(readme.includes('| pkg3-102 |'), 'в журнале README есть строка выпуска pkg3-102');

console.log('\n  pkg3-102: ' + good + ' ✓' + (bad ? ', ' + bad + ' ПРОВАЛОВ' : ', провалов нет'));
process.exit(bad ? 1 : 0);
