// test/music99.mjs — pkg3-99: поиск не «умирает»: потолок дросселя поднят,
// сайты спрашиваются по очереди, сайт с 429/403 уходит «на отдых», пятый
// источник ccMixter. Живой сервер против игрушечных сайтов.
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
console.log('  pkg3-99: поиск не умирает от ограничителей; ccMixter пятый');
console.log('══════════════════════════════════════════════════\n');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sega-m99-'));
const mock = http.createServer((rq, rs) => {
  const u = new URL(rq.url, 'http://mock');
  const jsend = (code, obj) => { rs.writeHead(code, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify(obj)); };
  if (u.pathname === '/advancedsearch.php') {
    return jsend(200, { response: { docs: [{ identifier: 'n1', title: 'Neon Wave' }] } });
  }
  if (u.pathname === '/metadata/n1') return jsend(200, { files: [{ name: 'neon-wave.mp3', size: '1' }] });
  if (u.pathname === '/v1/audio/') {
    // игрушечный openverse просит подождать, если в запросе wait
    if (String(u.searchParams.get('q') || '').includes('wait')) { rs.writeHead(429, { 'Content-Type': 'application/json' }); return rs.end(JSON.stringify({ error: 'rate' })); }
    return jsend(200, { results: [{ title: 'Neon CC', url: 'https://mock-cdn.example/cc/n.mp3', thumbnail: '' }] });
  }
  if (u.pathname === '/api/query') {
    return jsend(200, [
      { upload_name: 'Parting Gift', user_name: 'Jeff', files: [{ download_url: 'https://mock-cdn.example/cm/parting.mp3', file_rawsize: 4726464 }] },
      { upload_name: 'No files item', user_name: 'X', files: [] }
    ]);
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
    MUSSEARCH_CACHE_MS: '200', MUSSEARCH_REST_MS: '60000',
    MUSSEARCH_YAPFILES_BASE: mockBase, MUSSEARCH_ARCHIVE_BASE: mockBase,
    MUSSEARCH_COMMONS_BASE: mockBase, MUSSEARCH_OPENVERSE_BASE: mockBase,
    MUSSEARCH_CCMIXTER_BASE: mockBase
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
ok(r.status === 200 && r.d.build === 'pkg3-104', 'сервер помечен pkg3-104');

console.log('\n  1. Пятый источник и прежние работают');
r = await call('/api/mussearch?q=neon&sites=ccmixter', {}, admin);
ok(r.status === 200 && (r.d.results || [])[0] && r.d.results[0].url === 'https://mock-cdn.example/cm/parting.mp3',
  'ccMixter: прямая download_url добыта');
ok((r.d.results || [])[0] && /Parting Gift — Jeff/.test(r.d.results[0].title),
  'ccMixter: название с именем автора');
ok((r.d.results || []).length === 1, 'ccMixter: элемент без файлов пропущен');
r = await call('/api/mussearch?q=neon&sites=archive', {}, admin);
ok(r.status === 200 && (r.d.results || []).length === 1, 'archive по-прежнему работает');

console.log('\n  2. Сайт попросил подождать — поиск ставит его на отдых');
r = await call('/api/mussearch?q=wait+neon&sites=openverse', {}, admin);
ok(r.status === 200 && (r.d.sites || [])[0] && r.d.sites[0].ok === false && /подождать/.test(r.d.sites[0].error || ''),
  '429 от сайта превратился в честное «сайт попросил подождать»');
r = await call('/api/mussearch?q=wait+neon+two&sites=openverse', {}, admin);
ok(r.status === 200 && (r.d.sites || [])[0] && /отдыхает/.test(r.d.sites[0].error || ''),
  'повторно сайт не дёргаем: статус «отдыхает» без нового запроса к нему');

console.log('\n  3. Дроссель маршрута больше не захлопывается после пяти поисков');
let all429 = 0;
for (let i = 0; i < 12; i++) {
  const x = await call('/api/mussearch?q=neon' + i + '&sites=archive', {}, admin);
  if (x.status === 429) all429++;
}
ok(all429 === 0, 'двенадцать поисков подряд прошли без 429 (потолок 120 за 10 минут)');

console.log('\n  4. Метки выпуска в дереве');
const appJs = read('public/app.js');
const apiJs = read('lib/api.js');
const ms = read('lib/mussearch.js');
const sw = read('public/sw.js');
const pkg = read('package.json');
const readme = read('README.md');
ok(apiJs.includes("throttle('mussearch-' + me.id, 120)"), 'потолок поисков поднят до 120 за 10 минут');
ok(appJs.includes('for (const id of sites) {'), 'клиент спрашивает сайты по очереди, без залпа');
ok(ms.includes('const siteRest = new Map()') && ms.includes('REST_MS'), '«отдых» сайта после 429/403 на 5 минут');
ok(ms.includes("id: 'ccmixter'") && appJs.includes("ccmixter: 'ccMixter CC'"), 'пятый сайт в списке и фишке');
ok(sw.includes("const STATIC_CACHE = 'sega-static-v97';"), 'кэш статики поднят до v93');
ok(appJs.includes("const BUILD = 'pkg3-104';") && apiJs.includes("const BUILD = 'pkg3-104';"), 'BUILD pkg3-104 совпадает в клиенте и на сервере');
ok(pkg.includes('node test/music99.mjs'), 'тест music99 включён в цепочку npm test');
ok(readme.includes('| pkg3-99 |'), 'в журнале README есть строка выпуска pkg3-99');
const deps = JSON.parse(pkg).dependencies;
ok(Object.keys(deps).length === 1 && deps['web-push'], 'зависимость по-прежнему одна: web-push');

console.log('\n  pkg3-99: ' + good + ' ✓' + (bad ? ', ' + bad + ' ПРОВАЛОВ' : ', провалов нет'));
process.exit(bad ? 1 : 0);
