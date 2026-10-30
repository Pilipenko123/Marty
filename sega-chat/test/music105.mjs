// test/music105.mjs — pkg3-105: звук подкастов идёт через сервер.
// Сеть владельца может держать подкаст-хостинг закрытым (как однажды Jamendo),
// поэтому у подкаст-треков запасной путь разрешён всегда, НО сервер не открытый
// прокси: труба пускает лишь хозяев, которых сам увидел в <enclosure> прочитанных
// лент. Проверяем ворота пропуска до поиска, после поиска и для чужого хозяина.
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
console.log('  pkg3-105: звук подкастов через сервер — только хозяева из лент');
console.log('══════════════════════════════════════════════════\n');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sega-m105-'));
const feedsPath = path.join(dir, 'podcasts.json');

/** Игрушечная RSS-лента: звук лежит на «закрытом» для владельца хозяине. */
const mock = http.createServer((rq, rs) => {
  const u = new URL(rq.url, 'http://mock');
  if (u.pathname === '/feed.xml') {
    rs.writeHead(200, { 'Content-Type': 'application/rss+xml' });
    return rs.end(`<?xml version="1.0"?><rss><channel><title>Тест-радио</title>
<item><title>Интервью с котом учёного</title><enclosure url="https://pod-cdn.example/ep1.mp3" type="audio/mpeg" length="1"/></item>
</channel></rss>`);
  }
  rs.writeHead(404, { 'Content-Type': 'text/plain' }); rs.end('nope');
});
await new Promise(r => mock.listen(0, '127.0.0.1', r));
const mockPort = mock.address().port;
// файл лент СОЗДАЁМ НЕ ВРУЧНУЮ, а запросом /api/podfeeds — так проверяется и маршрут

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
    PODCAST_FEEDS: feedsPath
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

console.log('\n  1. Ворота пропуска: до поиска подкаст-хостинг не пропускается');
r = await call('/api/musstream-ticket', { method: 'POST', body: { url: 'https://pod-cdn.example/ep1.mp3' } }, admin);
ok(r.status === 403, 'без прочитанной ленты пропуск на подкаст-хост не выдаётся (403)');

console.log('\n  2. Ленты: по умолчанию в коде, владелец правит из «⋯» (файл сервера)');
r = await call('/api/state');
ok(r.status === 200 && r.d.podcasts === true, 'файла нет: работает проверенная лента по умолчанию (вариант В)');
r = await call('/api/podfeeds', {}, admin);
ok(r.status === 200 && r.d.source === 'default' && (r.d.feeds || [])[0] && /radio-t/.test(r.d.feeds[0].url), 'владелец в «⋯» видит: лента по умолчанию');
r = await call('/api/podfeeds', {}, null);
ok(r.status === 401, 'список лент без входа не отдаётся');
r = await call('/api/podfeeds', { method: 'POST', body: { feeds: [
  { title: 'Тест-радио', url: 'http://127.0.0.1:' + mockPort + '/feed.xml' },
  { title: 'Кривая', url: 'ftp://bad.example/f' }
] } }, admin);
ok(r.status === 200 && r.d.source === 'file' && (r.d.feeds || []).length === 1, 'владелец добавил ленты из «⋯»: сервер записал файл, кривую (не http/s) отбросил');
await wait(400);

console.log('\n  3. Поиск читает ленту — и труба узнаёт хозяина звука');
r = await call('/api/mussearch?q=' + encodeURIComponent('кот') + '&sites=podcasts', {}, admin);
const pd = (r.d.results || []).filter(x => x.site === 'podcasts');
ok(r.status === 200 && pd.length === 1 && pd[0].url === 'https://pod-cdn.example/ep1.mp3', 'находка подкаста с прямой ссылкой на выпуск');
await wait(400);   // кэш поиска: следующий запрос обязан быть свежим
r = await call('/api/musstream-ticket', { method: 'POST', body: { url: 'https://pod-cdn.example/ep1.mp3' } }, admin);
ok(r.status === 200 && !!r.d.t, 'после поиска пропуск на хозяина из ленты выдаётся');
r = await call('/api/musstream-ticket', { method: 'POST', body: { url: 'https://not-in-feeds.example/a.mp3' } }, admin);
ok(r.status === 403, 'чужой хозяин ссылкой не «заказывается» — по-прежнему 403');
r = await call('/api/musstream-ticket', { method: 'POST', body: { url: 'https://archive.org/download/x/y.mp3' } }, admin);
ok(r.status === 200 && !!r.d.t, 'белый список источников работает как прежде (archive.org)');
r = await call('/api/podfeeds', { method: 'POST', body: { feeds: [] } }, admin);
ok(r.status === 200 && (r.d.feeds || []).length === 0, 'владелец убрал все ленты — файл пустой');
r = await call('/api/state');
ok(r.status === 200 && r.d.podcasts === false, 'пустой файл: подкасты выключены выбором владельца, фишка тихая');

console.log('\n  4. Метки выпуска в коде');
const appJs = read('public/app.js'), msJs = read('lib/musstream.js'), mseJs = read('lib/mussearch.js'), apiJs = read('lib/api.js');
ok(appJs.includes('const proxyOn = musProxyOk(url) || !!(opts && opts.pod);'), 'клиент: подкаст-треку запасной путь разрешён всегда');
ok(appJs.includes("{ pod: t.site === 'podcasts' }") && appJs.includes("{ pod: site === 'podcasts' }"), 'клиент: оба запуска плеера знают источник трека');
ok(appJs.includes('musicPlayOnce(url, title, offset, kind, site)') && appJs.includes('musicPlayOnce(r.url, r.title, 0, \'\', r.site)'), 'клиент: источник находки доезжает до плеера');
ok(appJs.includes('site: res.site || \'\''), 'клиент: трек в плейлисте помнит свой источник');
ok(msJs.includes('mussearch.podHostOk(h)'), 'сервер: труба пускает хозяев из прочитанных лент');
ok(mseJs.includes('rememberPodHost(url);') && mseJs.includes('const POD_HOST_TTL = 72 * 3600 * 1000;'), 'сервер: хозяин запоминается при чтении ленты, запись живёт 72 часа');
ok(mseJs.includes('hasFeeds, podHostOk,'), 'сервер: проверка хозяина выдана трубе наружу');

console.log('\n  5. Новое окно «Моя музыка» по согласованной болванке');
const css = read('public/styles.css');
ok(appJs.includes('mus-v105') && css.includes('#modal-body .mus-wrap.mus-v105{display:block'), 'окно стало одноколоночным (болванка согласована)');
ok(appJs.includes('id="mus-sq"') && appJs.includes('id="mus-sq-go"') && appJs.includes('id="mus-dots-btn"'), 'строка поиска сверху: поле, «Найти» и «⋯»');
ok(appJs.includes('mus-coverbox') && appJs.includes('musCoverBigHtml') && appJs.includes('t.cover || t.coverSite'), 'обложка во всю ширину: ручная важнее обложки сайта, нет — винил с ♪');
ok(appJs.includes('id="mus-prev"') && appJs.includes('id="mus-toggle"') && appJs.includes('id="mus-next"') && appJs.includes('mus-three'), 'три большие кнопки: предыдущий трек, играть/пауза, следующий');
ok(!/currentTime \+ 10|currentTime - 10/.test(appJs), 'перемотки ±10 секунд нет (согласовано): только полоса прогресса');
ok(appJs.includes('id="mus-vol"') && appJs.includes('транслировать в статус'), 'внизу громкость и тумблер «транслировать в статус»');
ok(appJs.includes('data-mus-plren') && appJs.includes('data-mus-plvis') && appJs.includes('data-mus-pldel') && appJs.includes('id="mus-add-pl"'), 'управление плейлистами — в оверлее «Плейлисты ▾»');
ok(appJs.includes('data-tm="cov"') && appJs.includes('musicCoverOf(f, 600)') && appJs.includes('musicCoverOf(cf, 600)'), 'обложка крепится любому треку и уменьшается до ~600px');
ok(appJs.includes('while (out.length > 400000 && q > 0.4)'), 'встроенная обложка держится легче ~300 КБ');
ok(appJs.includes('musShowSearchView()') && appJs.includes('Результаты поиска: '), 'результаты поиска падают в общий список с шапкой');
ok(css.includes('.mus-v105 .mus-ovl.show{display:flex}') && appJs.includes('id="mus-dots-ovl"'), 'параметры поиска и умная вставка живут за «⋯»');
ok(mseJs.includes('DEFAULT_POD_FEEDS') && mseJs.includes('function savePodFeeds('), 'сервер: лента по умолчанию и запись файла лент');
ok(apiJs.includes("pathname === '/api/podfeeds'") && appJs.includes('mus-pod-add') && appJs.includes('musPodFeedsLoad('), 'лентами подкастов владелец управляет из «⋯»');

console.log('\n──────────────────────────────────────────────────');
console.log('  pkg3-105: ' + good + ' ✓, ' + bad + ' ПРОВАЛОВ');
console.log('──────────────────────────────────────────────────\n');
process.exit(bad ? 1 : 0);
