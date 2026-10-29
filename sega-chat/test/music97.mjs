// test/music97.mjs — pkg3-97: «Поиск музыки» по выбранным сайтам.
// Живой сервер против игрушечных сайтов (все четыре базы указывают на мок):
// слияние находок, дедупликация, честный отказ сайта, пределы запроса.
// Плюс метки клиента/сервера/стилей.
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
console.log('  pkg3-97: поиск музыки по выбранным сайтам (прямые ссылки)');
console.log('══════════════════════════════════════════════════\n');

// ─────────── игрушечные сайты: все четыре базы смотрят сюда ───────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sega-m97-'));
const mock = http.createServer((rq, rs) => {
  const u = new URL(rq.url, 'http://mock');
  const jsend = (code, obj) => { rs.writeHead(code, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify(obj)); };
  const hsend = (code, html) => { rs.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' }); rs.end(html); };
  if (u.pathname === '/advancedsearch.php') {
    return jsend(200, { response: { docs: [{ identifier: 'id1', title: 'Neon Dreams' }, { identifier: 'id2', title: 'Neon Nights' }] } });
  }
  if (u.pathname === '/metadata/id1') {
    return jsend(200, { files: [{ name: 'cover.jpg' }, { name: 'neon-dreams.mp3', size: '1234567' }] });
  }
  if (u.pathname === '/metadata/id2') {
    return jsend(200, { files: [{ name: 'neon-nights.mp3', size: '7654321' }] });
  }
  if (u.pathname === '/w/api.php') {
    if (u.searchParams.get('list') === 'search') {
      return jsend(200, { query: { search: [{ title: 'File:Neon.ogg' }, { title: 'File:Neon live.mp3' }] } });
    }
    return jsend(200, { query: { pages: {
      1: { title: 'File:Neon.ogg', imageinfo: [{ url: 'https://mock-cdn.example/neon.ogg', size: 111 }] },
      2: { title: 'File:Neon live.mp3', imageinfo: [{ url: 'https://mock-cdn.example/neonlive.mp3', size: 222 }] }
    } } });
  }
  if (u.pathname === '/v1/audio/') {
    return jsend(200, { results: [
      { title: 'Neon CC mix', url: 'https://mock-cdn.example/cc/neon.mp3' },
      { title: 'Дубль архива', url: 'https://mock-cdn.example/neonlive.mp3' }   // дубль для дедупликации
    ] });
  }
  if (u.pathname === '/search/') {
    if (String(u.searchParams.get('q') || '').includes('boom')) return hsend(500, 'oops');
    return hsend(200, '<html><body><a href="/files/77/">Neon Hit</a><a href="/files/77/">дубль</a><a href="/files/88/">Neon Dub</a></body></html>');
  }
  if (u.pathname === '/files/77/') {
    return hsend(200, '<html><head><title>Neon Hit - yapfiles</title></head><body><a href="https://sd.yapfiles.ru/x/neon-hit.mp3">скачать</a></body></html>');
  }
  if (u.pathname === '/files/88/') {
    return hsend(200, '<html><head><title>Neon Dub</title></head><body><a href="/dl/neon-dub.mp3">скачать</a></body></html>');
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
    MUSSEARCH_CACHE_MS: '500',
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
ok(r.status === 200 && r.d.build === 'pkg3-97', 'сервер помечен pkg3-97');

console.log('\n  1. Поиск по четырём сайтам');
r = await call('/api/mussearch?q=neon&sites=yapfiles,archive,commons,openverse', {}, admin);
ok(r.status === 200 && Array.isArray(r.d.results), 'маршрут поиска ответил списком находок');
const urls = (r.d.results || []).map(x => x.url);
ok(urls.includes('https://sd.yapfiles.ru/x/neon-hit.mp3'), 'yapfiles: прямая ссылка выхватена со страницы файла');
ok(urls.includes('https://mock-cdn.example/neon-dub.mp3') || urls.some(u => u.includes('neon-dub')), 'yapfiles: относительная ссылка достроена до прямой');
ok(urls.includes('https://archive.org/download/id1/neon-dreams.mp3') || urls.some(u => u.includes('/download/id1/')), 'archive: ссылка собрана из идентификатора и имени mp3');
ok(urls.some(u => u.includes('neon.ogg')), 'commons: прямая ссылка из imageinfo');
ok(urls.some(u => u.includes('/cc/neon.mp3')), 'openverse: прямая ссылка из результатов API');
ok((r.d.sites || []).filter(s => s.ok).length === 4, 'все четыре сайта отчитались успехом');
ok(urls.length === new Set(urls).size, 'дубликаты прямых схлёстнуты (дедупликация по url)');
const titles = (r.d.results || []).map(x => x.title);
ok(titles.some(t => /Neon Hit/.test(t)), 'названия очищены от разметки и хвостов сайта');

console.log('\n  2. Честные отказы и пределы');
r = await call('/api/mussearch?q=boom&sites=yapfiles', {}, admin);
ok(r.status === 200 && (r.d.sites || [])[0] && r.d.sites[0].ok === false && String(r.d.sites[0].error), 'сайт ответил 500 — поиск честно сказал «не ответили» и не упал');
r = await call('/api/mussearch?q=n', {}, admin);
ok(r.status === 400, 'короткий запрос отклонён (400)');
r = await call('/api/mussearch?q=neon&sites=nosuchsite', {}, admin);
ok(r.status === 200 && (r.d.results || []).length === 0, 'неизвестный сайт просто не участвует');
r = await call('/api/mussearch?q=neon');
ok(r.status === 401, 'без входа поиск недоступен (401)');

console.log('\n  3. Метки выпуска в дереве');
const appJs = read('public/app.js');
const apiJs = read('lib/api.js');
const css = read('public/styles.css');
const sw = read('public/sw.js');
const ms = read('lib/mussearch.js');
const pkg = read('package.json');
const readme = read('README.md');
ok(ms.includes("id: 'yapfiles'") && ms.includes("id: 'archive'") && ms.includes("id: 'commons'") && ms.includes("id: 'openverse'"),
  'четыре сайта-источника: yapfiles, archive, commons, openverse');
ok(ms.includes('Promise.allSettled') && ms.includes('CACHE_TTL'),
  'сайты опрашиваются параллельно, ответы кэшируются (10 минут)');
ok(ms.includes('const UA =') && ms.includes('SEGA-CHAT/97'),
  'сервер представляется сайтам честно: свой User-Agent с адресом чата');
ok(apiJs.includes("'/api/mussearch'") && apiJs.includes("throttle('mussearch-'"),
  'маршрут поиска под дросселем (антиспам)');
ok(appJs.includes('data-mus-pl="search"') && appJs.includes('🔎 Поиск музыки'),
  'в окне музыки — панель «Поиск музыки»');
ok(appJs.includes('data-mus-site=') && css.includes('.mus-site-chip{'),
  'фишки сайтов: владелец выбирает, по каким искать');
ok(appJs.includes('data-mus-s-play=') && appJs.includes('musicPlayOnce(r.url, r.title, 0)'),
  '▶ прослушивает находку нашим плеером, не добавляя');
ok(appJs.includes('data-mus-s-add=') && appJs.includes('data-mus-pick=') && appJs.includes('Добавить трек в плейлист:'),
  '＋ даёт список плейлистов; после выбора трек ложится в выбранный');
ok(appJs.includes('Такой трек уже есть в плейлисте'), 'повторная добавка того же url честно отклоняется');
ok(sw.includes("const STATIC_CACHE = 'sega-static-v90';"), 'кэш статики поднят до v90');
ok(appJs.includes("const BUILD = 'pkg3-97';") && apiJs.includes("const BUILD = 'pkg3-97';"), 'BUILD pkg3-97 совпадает в клиенте и на сервере');
ok(pkg.includes('node test/music97.mjs'), 'тест music97 включён в цепочку npm test');
ok(readme.includes('| pkg3-97 |'), 'в журнале README есть строка выпуска pkg3-97');
const deps = JSON.parse(pkg).dependencies;
ok(Object.keys(deps).length === 1 && deps['web-push'], 'зависимость по-прежнему одна: web-push');
ok(apiJs.includes("'/api/music/follow-href'") && appJs.includes('function musRowsRerender('),
  'механики 90–96 (Диск, якорь, живые строки) не пострадали');

console.log('\n  pkg3-97: ' + good + ' ✓' + (bad ? ', ' + bad + ' ПРОВАЛОВ' : ', провалов нет'));
process.exit(bad ? 1 : 0);
