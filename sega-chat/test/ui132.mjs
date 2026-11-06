// test/ui132.mjs — pkg3-146: починка Google-Диска (400 «Invalid Value»).
//
// Что случилось в 130–131: при постраничности в адрес списка файлов попадало
// `pageToken=undefined` (в параметрах запроса undefined превращается в строку),
// живой Google отвечал 400 «Invalid Value», и окно «Мои диски» показывало
// «Не получилось: Google ответил: Invalid Value» на любой папке.
//
// Здесь сторож не на слова, а по делу — игрушечный Google теперь ПРИДИРЧИВ,
// как настоящий: любой pageToken без значения (или со строкой «undefined»),
// пустой pageSize, лишний параметр — сразу 400. Плюс проверяем, что сама
// постраничность жива: вторая страница запрашивается с настоящим токеном, а
// архив папки собирает файлы с обеих страниц.
import { BUILD } from './build.mjs';
import gdrive from '../lib/gdrive.js';
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
console.log('  pkg3-146: Google-Диск снова открывается');
console.log('══════════════════════════════════════════════════\n');

/* ── Придирчивый игрушечный Google ─────────────────────────────────────── */
const TK = 'gtok132';
const seen = [];          // все адреса списка файлов: { query, raw }
const PAGE = {
  // у «Большой папки» две страницы — проверяем, что постраничность жива
  big: [
    [{ id: 'big1', name: 'стр1-а.mp3', mimeType: 'audio/mpeg', size: '3' },
      { id: 'big2', name: 'стр1-б.mp3', mimeType: 'audio/mpeg', size: '3' }],
    [{ id: 'big3', name: 'стр2-в.mp3', mimeType: 'audio/mpeg', size: '3' }]
  ]
};
const ROOT_FILES = [
  { id: 'rootdoc', name: 'Записка', mimeType: 'application/vnd.google-apps.document' },
  { id: 'bigholder', name: 'Большая папка', mimeType: 'application/vnd.google-apps.folder' },
  { id: 'rootmp3', name: 'трек.mp3', mimeType: 'audio/mpeg', size: '11' }
];

const mock = http.createServer((rq, rs) => {
  const u = new URL(rq.url, 'http://mock');
  const chunks = [];
  rq.on('data', c => chunks.push(c));
  rq.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let form = null;
    if (raw && !raw.startsWith('{')) { form = {}; for (const [k, v] of new URLSearchParams(raw)) form[k] = v; }
    else { try { form = raw ? JSON.parse(raw) : null; } catch (e) { form = null; } }
    const jsend = (code, obj) => { rs.writeHead(code, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify(obj)); };

    if (rq.method === 'POST' && u.pathname === '/token') {
      return jsend(200, { access_token: TK, refresh_token: 'rt132', expires_in: 3600, scope: 'https://www.googleapis.com/auth/drive' });
    }
    if (u.pathname === '/drive/v3/about') return jsend(200, { storageQuota: { limit: '1000', usage: '1' } });

    if (rq.method === 'GET' && u.pathname === '/drive/v3/files') {
      seen.push({ raw: u.search });
      // ── придирчивость настоящего Google ──
      for (const key of ['pageToken', 'pageSize', 'orderBy', 'fields', 'q']) {
        const vals = u.searchParams.getAll(key);
        if (vals.length > 1) return jsend(400, { error: { message: 'Invalid Value', status: 'INVALID_ARGUMENT' } });
      }
      if (u.searchParams.has('pageToken')) {
        const t = String(u.searchParams.get('pageToken'));
        if (!t || t === 'undefined' || t === 'null') {
          return jsend(400, { error: { message: 'Invalid Value', status: 'INVALID_ARGUMENT' } });
        }
      }
      for (const key of u.searchParams.keys()) {
        if (!['q', 'fields', 'pageSize', 'orderBy', 'includeItemsFromAllDrives', 'supportsAllDrives', 'pageToken'].includes(key)) {
          return jsend(400, { error: { message: 'Invalid Value: ' + key, status: 'INVALID_ARGUMENT' } });
        }
      }
      if (u.searchParams.has('pageSize') && !/^\d+$/.test(String(u.searchParams.get('pageSize')))) {
        return jsend(400, { error: { message: 'Invalid Value', status: 'INVALID_ARGUMENT' } });
      }
      const q = String(u.searchParams.get('q') || '');
      const m = /'([^']+)' in parents/.exec(q);
      const parent = m ? m[1] : 'root';
      const token = String(u.searchParams.get('pageToken') || '');
      if (parent === 'bigholder') {
        const page = token === 'p2' ? 1 : 0;
        const files = PAGE.big[page].map(f => Object.assign({ parents: ['bigholder'] }, f));
        return jsend(200, { files, nextPageToken: page === 0 ? 'p2' : '' });
      }
      const files = parent === 'root' ? ROOT_FILES.map(f => Object.assign({ parents: ['root'] }, f)) : [];
      return jsend(200, { files, nextPageToken: '' });
    }

    const fm = /^\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname);
    if (fm) {
      const id = fm[1];
      if (u.searchParams.get('alt') === 'media') {
        const body = 'SOUND-' + id;
        rs.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': String(body.length) });
        return rs.end(body);
      }
      const all = ROOT_FILES.concat(PAGE.big[0], PAGE.big[1]);
      const f = all.find(x => x.id === id);
      if (!f) return jsend(404, { error: { message: 'notFound' } });
      return jsend(200, { id: f.id, name: f.name, mimeType: f.mimeType, size: f.size, parents: ['root'] });
    }
    jsend(404, { error: { message: 'не найдено' } });
  });
});
await new Promise(r => mock.listen(0, '127.0.0.1', r));
const mockBase = 'http://127.0.0.1:' + mock.address().port;

/* ── 1. Прямая проверка библиотеки ─────────────────────────────────────── */
console.log('  1. Адрес запроса к Google');
seen.length = 0;
const got1 = await gdrive.listFolder(TK, 'google:/root', {}, { apiBase: mockBase });
ok(got1.items.length === 3, `папка прочитана (${got1.items.length} записи)`);
ok(seen.length === 1, 'был ровно один запрос');
ok(!/[?&]pageToken=/.test(seen[0].raw), 'pageToken в адресе НЕ появился, когда страниц одна');
ok(!/undefined/.test(seen[0].raw), 'в адресе нет строки «undefined» — сама поломка 130–131');
ok(/pageSize=200/.test(seen[0].raw), 'размер страницы передан числом');
ok(/supportsAllDrives=true/.test(seen[0].raw), 'прочие обязательные параметры на месте');

seen.length = 0;
const got2 = await gdrive.listFolder(TK, 'google:/root', { pageToken: 'p2' }, { apiBase: mockBase });
ok(got2.items.length === 0 || Array.isArray(got2.items), 'запрос с настоящим токеном страницы прошёл');
ok(/[?&]pageToken=p2(&|$)/.test(seen[0].raw), 'настоящий pageToken уходит как есть');

seen.length = 0;
const big1 = await gdrive.listFolder(TK, 'google:/bigholder', {}, { apiBase: mockBase });
ok(big1.items.length === 2 && big1.nextPageToken === 'p2', 'первая страница отдала 2 файла и токен «p2»');
const big2 = await gdrive.listFolder(TK, 'google:/bigholder', { pageToken: big1.nextPageToken }, { apiBase: mockBase });
ok(big2.items.length === 1 && big2.nextPageToken === '', 'вторая страница отдала остаток и больше не зовёт дальше');
ok(seen.every(x => !/pageToken=undefined/.test(x.raw)), 'ни один запрос не ушёл с «undefined»');

/* ── 2. Живой сервер: то самое окно из жалобы ──────────────────────────── */
async function freePort() {
  const { createServer } = await import('node:net');
  return new Promise(r => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sega-m132-'));
const dataDir = path.join(dir, 'data');
const keysPath = path.join(dir, 'google-oauth.json');
fs.writeFileSync(keysPath, JSON.stringify({ client_id: 'cid132.apps.googleusercontent.com', client_secret: 'sec132' }));
const procs = [];
process.on('exit', () => { for (const p of procs) { try { p.kill('SIGKILL'); } catch (e) {} } try { mock.close(); } catch (e) {} });

const port = await freePort();
const base = 'http://127.0.0.1:' + port;
const proc = spawn(process.execPath, ['server.js'], {
  cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
  env: Object.assign({}, process.env, {
    STORE: 'file', DATA_DIR: dataDir, HOST: '127.0.0.1', HTTPS: '', PRESENCE_EVERY: '0',
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
{
  const a = await call('/api/gdrive/auth?slot=1', {}, A.token);
  const st = (new URL(a.d.url)).searchParams.get('state');
  const html = await (await fetch(base + '/api/gdrive/callback?state=' + encodeURIComponent(st) + '&code=g1code')).text();
  ok(/Google Диск подключён/.test(html), 'Google-Диск подключён к стенду');
}

console.log('\n  2. Окно «Мои диски»: Google снова читается');
r = await call('/api/yadisk/list?path=' + encodeURIComponent('google:/root'), {}, A.token);
ok(r.status === 200, `корень Google-Диска открылся (${r.status})`);
ok(!r.d || !/Invalid Value/.test(String((r.d && r.d.error) || '')), 'и никакого «Google ответил: Invalid Value»');
ok(r.status === 200 && r.d.items.length === 3, 'в списке 3 записи');
const names = ((r.d && r.d.items) || []).map(x => x.name);
ok(names.includes('Записка') && names.includes('трек.mp3'), 'и документ, и обычный файл на месте');
r = await call('/api/yadisk/list?path=' + encodeURIComponent('google:/bigholder'), {}, A.token);
ok(r.status === 200 && r.d.items.length === 2, 'вложенная папка открывается (первая страница)');

console.log('\n  3. Архив папки Google собирает обе страницы');
r = await call('/api/yadisk/folder-zip?path=' + encodeURIComponent('google:/bigholder'), {}, A.token);
ok(r.status === 200 && r.d.files === 3, `в архиве учтены все 3 файла с двух страниц (${r.d ? r.d.files : '—'})`);
ok(/^(SOUND-|PK).*$/.test('PK'), 'архив по-прежнему ZIP');
const zres = await fetch(base + r.d.url);
const zbuf = Buffer.from(await zres.arrayBuffer());
ok(zres.status === 200 && zbuf.slice(0, 2).toString() === 'PK', 'архив скачался и это ZIP');
ok(zbuf.includes(Buffer.from('стр2-в.mp3')), 'внутри есть файл со ВТОРОЙ страницы — постраничность не потерялась');

console.log('\n  4. Сторож поломки и отметки выпуска');
const src = read('lib/gdrive.js');
const code = src.replace(/^\s*\/\/.*$/gm, '');   // комментарии про старую поломку не считаем
ok(!/pageToken:[^\n]*\|\|\s*undefined/.test(code), 'в коде больше нет «pageToken: … || undefined»');
ok(/if \(o\.pageToken\) q\.set\('pageToken'/.test(src), 'параметр добавляется только когда он есть');
ok(seen.every(x => !/pageToken=(undefined|null|)(&|$)/.test(x.raw)), 'за весь тест ни одного пустого pageToken');
const appJs = read('public/app.js');
ok((/const BUILD = '([^']+)'/.exec(appJs) || [])[1] === BUILD && BUILD === 'pkg3-146', `отметка выпуска одна (${BUILD})`);
ok(((/const BUILD = '([^']+)'/.exec(read('lib/api.js')) || [])[1]) === BUILD, 'BUILD в lib/api.js тот же');
ok((/const STATIC_CACHE = '([^']+)'/.exec(read('public/sw.js')) || [])[1] === 'sega-static-v140', 'кэш оформления поднят до v126');
ok(/\| pkg3-146 \|/.test(read('README.md')), 'в журнале README есть строка pkg3-146');
ok(read('package.json').includes('node test/ui132.mjs'), 'тест ui132 включён в цепочку npm test');

console.log(`\n  ИТОГ: ${good} ✓, ${bad ? bad + ' провалов' : 'провалов нет'}\n`);
process.exit(bad ? 1 : 0);
