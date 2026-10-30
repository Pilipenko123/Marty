// test/music100.mjs — pkg3-100: Jamendo шестым источником.
// Живой сервер против игрушечного Jamendo: без ключа — честный отказ,
// с ключом — находки с исполнителем, прямой ссылкой и обложкой.
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
console.log('  pkg3-100: Jamendo — шестой источник с официальным API');
console.log('══════════════════════════════════════════════════\n');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sega-m100-'));
const keysPath = path.join(dir, 'jamendo.json');   // файл создадим ПОСЛЕ первого поиска
const mock = http.createServer((rq, rs) => {
  const u = new URL(rq.url, 'http://mock');
  const jsend = (code, obj) => { rs.writeHead(code, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify(obj)); };
  if (u.pathname === '/v3.0/tracks/') {
    const cid = u.searchParams.get('client_id');
    if (!cid) return jsend(400, { error: 'no client_id' });
    if (cid !== 'TESTID') return jsend(401, { error: 'bad client_id' });
    return jsend(200, { results: [
      { id: 1, name: 'Midnight Drive', artist_name: 'Neon Cats', album_name: 'City Lights',
        audio: 'https://mock-cdn.example/jam/stream/1/mp32/', image: 'https://mock-cdn.example/jam/cover100.jpg' },
      { id: 2, name: 'Slow Rain', artist_name: 'Neon Cats', album_name: 'City Lights',
        audio: 'not-a-url', image: '' }   // кривая ссылка — пропускаем
    ] });
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
    MUSSEARCH_CACHE_MS: '200',
    JAMENDO_KEYS: keysPath, MUSSEARCH_JAMENDO_BASE: mockBase
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
r = await call('/api/state');
ok(r.status === 200 && r.d.build === 'pkg3-106', 'сервер помечен pkg3-106');

console.log('\n  1. Без ключа — честный отказ, с ключом — находки');
r = await call('/api/mussearch?q=neon+cats&sites=jamendo', {}, admin);
ok(r.status === 200 && (r.d.sites || [])[0] && r.d.sites[0].ok === false && /ключи Jamendo не положены/.test(r.d.sites[0].error || ''),
  'ключа нет — фишка честно говорит «ключи не положены», маршрут не падает');
r = await call('/api/state');
ok(r.status === 200 && r.d.jamendo === false, 'без ключа /api/state честно говорит jamendo:false — клиенты прячут фишку');
fs.writeFileSync(keysPath, JSON.stringify({ client_id: 'TESTID' }));
r = await call('/api/state');
ok(r.status === 200 && r.d.jamendo === true, 'положили ключ — /api/state без перезапуска говорит jamendo:true');
r = await call('/api/mussearch?q=neon+cats+two&sites=jamendo', {}, admin);
const res = (r.d.results || []);
ok(r.status === 200 && res.length === 1, 'ключ положили БЕЗ перезапуска — поиск сразу заработал и отбросил кривую ссылку');
ok(res[0] && res[0].title === 'Neon Cats — Midnight Drive', 'название с исполнителем: «Neon Cats — Midnight Drive»');
ok(res[0] && res[0].url === 'https://mock-cdn.example/jam/stream/1/mp32/', 'прямая ссылка на поток взята из поля audio');
ok(res[0] && res[0].cover === 'https://mock-cdn.example/jam/cover100.jpg', 'обложка альбома подтянута');
ok((r.d.sites || [])[0] && r.d.sites[0].ok === true, 'сайт отчитался успехом');

console.log('\n  2. Метки выпуска в дереве');
const appJs = read('public/app.js');
const apiJs = read('lib/api.js');
const ms = read('lib/mussearch.js');
const sw = read('public/sw.js');
const css2 = () => read('public/styles.css');
const pkg = read('package.json');
const readme = read('README.md');
ok(ms.includes("id: 'jamendo'") && ms.includes('function searchJamendo('), 'шестой источник Jamendo с официальным API');
ok(ms.includes('/opt/sega/keys/jamendo.json') && ms.includes('function loadJamKeys('), 'client_id в файле ключей, читается на каждый поиск');
ok(ms.includes("conf.jamendo + '/v3.0/tracks/?'") && ms.includes('imagesize'), 'запрос к API v3.0 с обложками и полями исполнителя');
ok(appJs.includes("jamendo: 'Jamendo CC'") && appJs.includes('jamendo: S.jamendoOn !== false'), 'фишка Jamendo в панели поиска отмечена по умолчанию, когда источник включён');
ok(appJs.includes('S.jamendoOn = st.jamendo !== false;') && css2().includes('.mus-site-chip.off{'),
  'pkg3-100: пока ключа нет, фишка у всех участников тихая и неактивная — без служебных надписей');
ok(appJs.includes('Этот источник музыки включает владелец сервера'),
  'pkg3-100: не-админу клик по тихой фишке объясняет по-человечески, админу — подсказывает файл ключа');
ok(sw.includes("const STATIC_CACHE = 'sega-static-v99';"), 'кэш статики поднят до v93');
ok(appJs.includes("const BUILD = 'pkg3-106';") && apiJs.includes("const BUILD = 'pkg3-106';"), 'BUILD pkg3-106 совпадает в клиенте и на сервере');
ok(pkg.includes('node test/music100.mjs'), 'тест music100 включён в цепочку npm test');
ok(readme.includes('| pkg3-100 |'), 'в журнале README есть строка выпуска pkg3-100');
const deps = JSON.parse(pkg).dependencies;
ok(Object.keys(deps).length === 1 && deps['web-push'], 'зависимость по-прежнему одна: web-push');
ok(ms.includes("id: 'ccmixter'") && apiJs.includes("throttle('mussearch-' + me.id, 120)"),
  'механики 97–99 (пять сайтов, дроссель, отдых) не пострадали');

console.log('\n  pkg3-100: ' + good + ' ✓' + (bad ? ', ' + bad + ' ПРОВАЛОВ' : ', провалов нет'));
process.exit(bad ? 1 : 0);
