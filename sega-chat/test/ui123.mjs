// test/ui123.mjs — pkg3-123: Диск можно подключить ВСТАВЛЕННЫМ токеном.
//
// Зачем: пока OAuth-приложение сервера не опубликовано, страница согласия
// Яндекса пускает только аккаунт владельца, и у друзей выходит
// «400 · Неизвестно приложение с таким client_id». Токен, который выдаёт сам
// Яндекс (полигон Диска), работает без публикации приложения.
//
// Проверяем на живом сервере с игрушечным Яндексом: приём токена, проверка его
// живости у Яндекса, отказ на мусор, работу списка файлов, независимость от
// файла ключей OAuth-приложения, шифрование токена в базе.
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
console.log('  pkg3-123: Диск по токену — без публикации приложения');
console.log('══════════════════════════════════════════════════\n');

const GOOD = 'y0_' + 'A'.repeat(40);   // «живой» токен в игрушечном Яндексе

// ─────────────── игрушечный Яндекс (список аудиофайлов) ───────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sega-m123-'));
const keysPath = path.join(dir, 'yandex-oauth.json');
fs.writeFileSync(keysPath, JSON.stringify({ client_id: 'ID123', client_secret: 'SECRET123' }));
const mock = http.createServer((rq, rs) => {
  const u = new URL(rq.url, 'http://mock');
  const jsend = (code, obj) => { rs.writeHead(code, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify(obj)); };
  if (rq.method === 'GET' && u.pathname === '/v1/disk/resources/files') {
    const auth = String(rq.headers.authorization || '');
    if (auth !== 'OAuth ' + GOOD) return jsend(401, { message: 'Не авторизован', description: 'Unauthorized' });
    return jsend(200, { items: [{ path: 'disk:/Музыка/трек.mp3', name: 'трек.mp3', size: 1024, mime_type: 'audio/mpeg' }], limit: 200, offset: 0 });
  }
  if (rq.method === 'POST' && u.pathname === '/token') return jsend(200, { access_token: 'AT-123', refresh_token: 'RT-123', expires_in: 3600 });
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

/** Поднять отдельный сервер: свой каталог данных, свой файл ключей (или без него). */
async function bootServer(tag, keys) {
  const dataDir = path.join(dir, 'data-' + tag);
  const port = await freePort();
  const env = Object.assign({}, process.env, {
    STORE: 'file', DATA_DIR: dataDir, HOST: '127.0.0.1', HTTPS: '', PRESENCE_EVERY: '0',
    NEW_INVITE_DELAY: '0', INVITE_COOLDOWN_MS: '0', PORT: String(port),
    YADISK_OAUTH_BASE: mockBase, YADISK_API_BASE: mockBase,
    YADISK_KEYS: keys, YADISK_REDIRECT: 'http://127.0.0.1:' + port + '/api/yadisk/callback'
  });
  const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'], env });
  procs.push(proc);
  const base = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/api/state')).ok) break; } catch (e) {} await wait(200); }
  const call = async (p, opts = {}, token) => {
    const h = { 'Content-Type': 'application/json' };
    if (token) h.Authorization = 'Bearer ' + token;
    const r = await fetch(base + p, { ...opts, headers: h, body: opts.body ? JSON.stringify(opts.body) : undefined });
    let d = null; try { d = await r.json(); } catch (e) {}
    return { status: r.status, d };
  };
  const creds = name => ({ name, saltAuth: hex(), authKey: hex(32), saltWrap: hex(), wrappedKeyByPass: 'w:' + hex(), pub: 'pub:' + hex(), wrappedPriv: 'priv:' + hex() });
  const setup = await call('/api/setup', { method: 'POST', body: Object.assign({}, creds('Владелец' + tag), { codeProofSalt: hex(), codeProof: hex(32), codeSalt: hex(), wrappedKeyByCode: 'k:' + hex() }) });
  return { call, token: setup.d.token, dataDir };
}

console.log('  1. Сервер с ключами приложения: токен принимается');
const s1 = await bootServer('withkeys', keysPath);
if (!s1.token) ok(false, 'сервер с ключами поднялся');
let r = await s1.call('/api/yadisk/state', {}, s1.token);
ok(r.status === 200 && r.d.connected === false, 'до подключения Диск не подключён');
r = await s1.call('/api/yadisk/token', { method: 'POST', body: { token: 'короткий' } }, s1.token);
ok(r.status === 400, 'мусор вместо токена не принимается');
r = await s1.call('/api/yadisk/token', { method: 'POST', body: { token: 'y0_' + 'B'.repeat(40) } }, s1.token);
ok(r.status === 400 && /не принял этот токен/.test(String(r.d.error || r.d.message || '')), 'токен, который Яндекс не знает, тоже отклонён (сверяемся с Яндексом)');
r = await s1.call('/api/yadisk/token', { method: 'POST', body: { token: GOOD } }, s1.token);
ok(r.status === 200 && r.d.connected === true && r.d.manual === true, 'живой токен принят, Диск подключён «вручную»');
r = await s1.call('/api/yadisk/state', {}, s1.token);
ok(r.status === 200 && r.d.connected === true && r.d.manual === true, 'состояние: подключён, способ — токен');
r = await s1.call('/api/yadisk/files?limit=200', {}, s1.token);
ok(r.status === 200 && Array.isArray(r.d.items) && r.d.items.length === 1, 'список аудиофайлов читается этим токеном');
const dbRaw = fs.readFileSync(path.join(s1.dataDir, 'db.json'), 'utf8');
ok(dbRaw.indexOf(GOOD) < 0, 'токена в базе НЕТ в открытом виде — только шифротекст');
ok(/"manual":\s*true/.test(dbRaw), 'в базе помечено, что подключение ручное');
r = await s1.call('/api/yadisk/disconnect', { method: 'POST' }, s1.token);
ok(r.status === 200, 'отключение работает');
r = await s1.call('/api/yadisk/state', {}, s1.token);
ok(r.d.connected === false, 'после отключения Диск снова не подключён');

console.log('\n  2. Сервер БЕЗ ключей приложения: токен всё равно работает');
const s2 = await bootServer('nokeys', path.join(dir, 'no-such-oauth.json'));
r = await s2.call('/api/yadisk/state', {}, s2.token);
ok(r.status === 200 && r.d.keys === false && r.d.connected === false, 'ключей приложения нет — и это честно видно');
r = await s2.call('/api/yadisk/token', { method: 'POST', body: { token: GOOD } }, s2.token);
ok(r.status === 200 && r.d.connected === true, 'токен принимается даже без файла ключей OAuth-приложения');
r = await s2.call('/api/yadisk/files?limit=200', {}, s2.token);
ok(r.status === 200 && r.d.items.length === 1, 'и музыка с Диска играет — публикация приложения для этого не нужна');

console.log('\n  3. Метки клиента');
const appJs = read('public/app.js');
const apiJs = read('lib/api.js');
const css = read('public/styles.css');
ok(apiJs.includes("'/api/yadisk/token'"), 'сервер: маршрут подключения токеном');
ok(/rec\.manual[\s\S]{0,240}yd-manual/.test(apiJs), 'ручной токен шифруется ключом из серверного секрета');
ok(/if \(rec\.manual\) return tok;/.test(apiJs), 'и не пытается «обновиться» — у него нет refresh');
ok(appJs.includes('function ydTokenAsk('), 'клиент: окно ввода токена');
ok(/id="mus-disk-token"/.test(appJs), 'в панели Диска есть кнопка «Вставить токен»');
ok(appJs.includes('https://yandex.ru/dev/disk/poligon/'), 'и ссылка, где взять токен');
ok(/type="password"/.test(appJs), 'поле скрытое — токен не светится на экране');
ok(/api\('\/api\/yadisk\/token', \{ method: 'POST', body: \{ token \} \}\)/.test(appJs), 'токен уходит на сервер одним запросом');
ok(appJs.includes('по токену'), 'подключение токеном видно в панели');
ok(/\.yd-tok-card\{max-width:400px\}/.test(css), 'оформление окна ввода — в тон панелям');

console.log('\n  4. Отметки выпуска');
const b2 = (/const BUILD = '([^']+)'/.exec(appJs) || [])[1];
const cache = (/const STATIC_CACHE = '([^']+)'/.exec(read('public/sw.js')) || [])[1];
ok(b2 === BUILD, `отметка выпуска в клиенте и в тестах одна (${BUILD})`);
ok(((/const BUILD = '([^']+)'/.exec(apiJs) || [])[1]) === BUILD, 'BUILD в lib/api.js тот же');
ok(new RegExp('\\| ' + BUILD + ' \\|').test(read('README.md')), `в журнале README есть строка ${BUILD}`);
ok(cache === 'sega-static-v146', `кэш оформления поднят (${cache}) — устройства получат правки`);
ok(read('package.json').includes('node test/ui123.mjs'), 'тест ui123 включён в цепочку npm test');

console.log(`\n  ИТОГ: ${good} ✓, ${bad ? bad + ' провалов' : 'провалов нет'}\n`);
process.exit(bad ? 1 : 0);
