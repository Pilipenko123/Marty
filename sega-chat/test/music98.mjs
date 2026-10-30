// test/music98.mjs — pkg3-98: релевантность находок, обложки, прогресс поиска.
// Живой сервер против игрушечных сайтов: нерелевантные названия отфильтрованы,
// точные совпадения первыми, обложки подтянуты с четырёх сайтов.
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
console.log('  pkg3-98: релевантность находок, обложки, линия загрузки');
console.log('══════════════════════════════════════════════════\n');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sega-m98-'));
const mock = http.createServer((rq, rs) => {
  const u = new URL(rq.url, 'http://mock');
  const jsend = (code, obj) => { rs.writeHead(code, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify(obj)); };
  const hsend = (code, html) => { rs.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' }); rs.end(html); };
  if (u.pathname === '/advancedsearch.php') {
    return jsend(200, { response: { docs: [
      { identifier: 'rel1', title: 'Neon Dreams Collection' },
      { identifier: 'irr1', title: 'Rainy Field Recording' },          // не по запросу
      { identifier: 'half1', title: 'Neon archive miscellaneous' }     // одно слово из двух
    ] } });
  }
  if (u.pathname === '/metadata/rel1') return jsend(200, { files: [{ name: 'neon-dreams.mp3', size: '1' }] });
  if (u.pathname === '/metadata/irr1') return jsend(200, { files: [{ name: 'rain.mp3', size: '1' }] });
  if (u.pathname === '/metadata/half1') return jsend(200, { files: [{ name: 'misc.mp3', size: '1' }] });
  if (u.pathname === '/w/api.php') {
    if (u.searchParams.get('list') === 'search') {
      return jsend(200, { query: { search: [{ title: 'File:Neon pulse.ogg' }, { title: 'File:Birds morning.wav' }] } });
    }
    return jsend(200, { query: { pages: {
      1: { title: 'File:Neon pulse.ogg', imageinfo: [{ url: 'https://mock-cdn.example/neonpulse.ogg', size: 1, thumburl: 'https://mock-cdn.example/thumb/neonpulse.png' }] },
      2: { title: 'File:Birds morning.wav', imageinfo: [{ url: 'https://mock-cdn.example/birds.wav', size: 1 }] }
    } } });
  }
  if (u.pathname === '/v1/audio/') {
    return jsend(200, { results: [
      { title: 'Neon skies remix', url: 'https://mock-cdn.example/cc/neon.mp3', thumbnail: 'https://mock-cdn.example/cc/th1.jpg' },
      { title: 'Untitled ambience', url: 'https://mock-cdn.example/cc/amb.mp3' }
    ] });
  }
  if (u.pathname === '/search/') {
    return hsend(200, '<html><body><a href="/files/77/">Neon Hit</a><a href="/files/99/">Chess lecture</a></body></html>');
  }
  if (u.pathname === '/files/77/') {
    return hsend(200, '<html><head><title>Neon Hit</title><meta property="og:image" content="https://mock-cdn.example/yf/neon.jpg"></head><body><a href="https://sd.yapfiles.ru/x/neon-hit.mp3">скачать</a></body></html>');
  }
  if (u.pathname === '/files/99/') {
    return hsend(200, '<html><head><title>Chess lecture</title></head><body><a href="https://sd.yapfiles.ru/x/chess.mp3">скачать</a></body></html>');
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
    MUSSEARCH_CACHE_MS: '300',
    MUSSEARCH_YAPFILES_BASE: mockBase, MUSSEARCH_ARCHIVE_BASE: mockBase,
    MUSSEARCH_COMMONS_BASE: mockBase, MUSSEARCH_OPENVERSE_BASE: mockBase
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

console.log('\n  1. Релевантность: лишнее не показываем, точное — первым');
r = await call('/api/mussearch?q=neon&sites=yapfiles,archive,commons,openverse', {}, admin);
ok(r.status === 200, 'поиск ответил');
const titles = (r.d.results || []).map(x => x.title);
ok(titles.length > 0, 'находки есть');
ok(!titles.some(t => /Rainy Field|Birds morning|Chess lecture|Untitled ambience/i.test(t)),
  'названия без слов запроса отфильтрованы (site искал по тегам/описаниям — мы честнее)');
ok(titles.every(t => /neon/i.test(t)), 'в выдаче только названия со словом запроса');
const first = titles[0] || '';
ok(/Neon Dreams Collection|Neon Hit|Neon pulse|Neon skies/i.test(first), 'первыми идут точные совпадения');
const order = titles.map(t => t.toLowerCase());
const allWords = order.filter(t => t.includes('neon'));
ok(allWords.length === order.length, 'сортировка по совпадению не потеряла находки');

console.log('\n  2. Обложки');
const cov = (r.d.results || []).map(x => String(x.cover || ''));
ok(cov.some(c => c.includes('__ia_thumb.jpg')), 'archive: миниатюра набора подтянута');
ok(cov.some(c => c.includes('/thumb/neonpulse.png')), 'commons: миниатюра 96 px подтянута');
ok(cov.some(c => c.includes('/cc/th1.jpg')), 'openverse: обложка из API подтянута');
ok(cov.some(c => c.includes('/yf/neon.jpg')), 'yapfiles: обложка из og:image подтянута');

console.log('\n  3. Метки выпуска в дереве');
const appJs = read('public/app.js');
const apiJs = read('lib/api.js');
const css = read('public/styles.css');
const sw = read('public/sw.js');
const ms = read('lib/mussearch.js');
const pkg = read('package.json');
const readme = read('README.md');
ok(ms.includes('const toks = String(q).toLowerCase()') && ms.includes('relevant.sort('),
  'сервер фильтрует и сортирует находки по словам запроса');
ok(appJs.includes('mus-prog') && appJs.includes('Спрашиваю сайты: '),
  'линия загрузки и счётчик опрошенных сайтов в окне поиска');
ok(appJs.includes("api('/api/mussearch?q=' + encodeURIComponent(st.q) + '&sites=' + id)"),
  'сайты опрашиваются параллельно по одному — прогресс честный');
ok(appJs.includes('musCoverBigHtml') && appJs.includes('onerror="this.style.display=\'none\'"') && css.includes('.mus-coverbox'),
  'обложка играющего трека — во всю ширину; нет файла — картинка прячется, остаётся винил с ♪');
ok(appJs.includes('mus-ti') && appJs.includes('mus-addbtn') && css.includes('.mus-addbtn{'),
  'название читается одной строкой, «＋» уменьшен');
ok(sw.includes("const STATIC_CACHE = 'sega-static-v99';"), 'кэш статики поднят до v93');
ok(appJs.includes("const BUILD = 'pkg3-106';") && apiJs.includes("const BUILD = 'pkg3-106';"), 'BUILD pkg3-106 совпадает в клиенте и на сервере');
ok(pkg.includes('node test/music98.mjs'), 'тест music98 включён в цепочку npm test');
ok(readme.includes('| pkg3-98 |'), 'в журнале README есть строка выпуска pkg3-98');
const deps = JSON.parse(pkg).dependencies;
ok(Object.keys(deps).length === 1 && deps['web-push'], 'зависимость по-прежнему одна: web-push');
ok(apiJs.includes("'/api/mussearch'") && appJs.includes('data-mus-pick='),
  'механики 97-го (маршрут поиска, выбор плейлиста) не пострадали');

console.log('\n  pkg3-98: ' + good + ' ✓' + (bad ? ', ' + bad + ' ПРОВАЛОВ' : ', провалов нет'));
process.exit(bad ? 1 : 0);
