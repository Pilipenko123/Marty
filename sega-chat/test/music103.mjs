// test/music103.mjs — pkg3-103: «Аудиокниги (ru)» и «Подкасты (RSS)».
// Игрушечные Интернет-архив (advancedsearch + metadata) и RSS-ленты: главы книг
// по-русски, enclosure типа audio, кривые и мёртвые ленты не валят поиск,
// флаг podcasts в /api/state живёт: лента по умолчанию в коде, файл владельца главный.
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
console.log('  pkg3-103: аудиокниги по-русски и подкасты из RSS');
console.log('══════════════════════════════════════════════════\n');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sega-m103-'));
const feedsPath = path.join(dir, 'podcasts.json');   // создадим ПОСЛЕ первого поиска

/** Игрушечный Интернет-архив + игрушечные RSS-ленты на одном порту. */
const mock = http.createServer((rq, rs) => {
  const u = new URL(rq.url, 'http://mock');
  if (u.pathname === '/advancedsearch.php') {
    const q = u.searchParams.get('q') || '';
    if (!/language:\(rus\)/.test(q) || !/librivoxaudio/.test(q) || !/subject:\(аудиокниг\*\)/.test(q) || !/\*\)/.test(q)) {
      return rs.end(JSON.stringify({ response: { docs: [] } }));   // прицел по языку, коллекциям и метке «аудиокнига» + поиск префиксом обязателен
    }
    return rs.end(JSON.stringify({ response: { docs: [ { identifier: 'ru-book1', title: 'Чехов рассказы начитка' } ] } }));
  }
  if (u.pathname === '/metadata/ru-book1') {
    return rs.end(JSON.stringify({ files: [
      { name: 'chekhov_01.mp3', size: '100' },
      { name: 'chekhov_02.ogg', size: '200' },
      { name: 'notes.txt', size: '5' }
    ] }));
  }
  if (u.pathname === '/feed.xml') {
    rs.writeHead(200, { 'Content-Type': 'application/rss+xml' });
    return rs.end(`<?xml version="1.0"?><rss><channel><title>Тест-радио</title>
<item><title><![CDATA[Интервью с котом учёного]]></title><enclosure url="https://pod-cdn.example/ep1.mp3" type="audio/mpeg" length="1"/></item>
<item><title>Картинка вместо выпуска</title><enclosure url="https://pod-cdn.example/pic.jpg" type="image/jpeg"/></item>
<item><title>Кривой выпуск</title><enclosure url="http-плохой" type="audio/mpeg"/></item>
</channel></rss>`);
  }
  rs.writeHead(404, { 'Content-Type': 'text/plain' }); rs.end('nope');   // мёртвая лента
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

const port = await freePort();
const proc = spawn(process.execPath, ['server.js'], {
  cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
  env: Object.assign({}, process.env, {
    STORE: 'file', DATA_DIR: path.join(dir, 'data'), HOST: '127.0.0.1', HTTPS: '', PRESENCE_EVERY: '0',
    NEW_INVITE_DELAY: '0', INVITE_COOLDOWN_MS: '0', PORT: String(port),
    MUSSEARCH_CACHE_MS: '200',
    MUSSEARCH_ARCHIVE_BASE: mockBase,
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
r = await call('/api/state');
ok(r.status === 200 && r.d.build === 'pkg3-106', 'сервер помечен pkg3-106');

console.log('\n  1. Аудиокниги (ru): главы книг с прицелом по языку и коллекциям');
r = await call('/api/mussearch?q=' + encodeURIComponent('чехов рассказы') + '&sites=audiobooks', {}, admin);
const ab = r.d.results || [];
ok(r.status === 200 && ab.length === 2, 'найдены две дорожки-главы (txt-файл набора отброшен)');
ok(ab[0] && ab[0].site === 'audiobooks' && /Чехов рассказы начитка — chekhov_01/.test(ab[0].title), 'название главы: «Книга — глава»');
ok(ab[0] && ab[0].url.includes('/download/ru-book1/chekhov_01.mp3'), 'прямая ссылка на файл главы на archive.org');
ok(ab[0] && ab[0].cover.includes('__ia_thumb.jpg'), 'обложка-миниатюра набора подтянута');
ok((r.d.sites || [])[0] && r.d.sites[0].ok === true, 'источник отчитался успехом');

console.log('\n  2. Подкасты: лента по умолчанию в коде, файл владельца всегда главный');
r = await call('/api/state');
ok(r.status === 200 && r.d.podcasts === true, 'без файла /api/state говорит podcasts:true — работает проверенная лента по умолчанию (вариант В)');
const feedsBody = JSON.stringify({ feeds: [
  { title: 'Тест-радио', url: mockBase + '/feed.xml' },
  { title: 'Мёртвая лента', url: mockBase + '/nope.xml' }
] });
fs.writeFileSync(feedsPath, feedsBody);   // файл владельца перекрывает ленту по умолчанию
r = await call('/api/state');
ok(r.status === 200 && r.d.podcasts === true, 'положили ленты — /api/state без перезапуска говорит podcasts:true');
await wait(400);   // кэш поиска (200 мс в тесте) должен отпустить прежний пустой ответ
r = await call('/api/mussearch?q=интервью&sites=podcasts', {}, admin);
const pc = r.d.results || [];
ok(r.status === 200 && pc.length === 1 && pc[0].title === 'Тест-радио — Интервью с котом учёного',
  'выпуск с enclosure audio найден, CDATA-название раскрыто, лента-источник в начале названия');
ok(pc[0] && pc[0].url === 'https://pod-cdn.example/ep1.mp3', 'ссылка на выпуск взята из enclosure url');
ok((r.d.sites || [])[0] && r.d.sites[0].ok === true, 'мёртвая лента не свалила поиск: источник отчитался успехом');
r = await call('/api/mussearch?q=кот&sites=podcasts', {}, admin);
ok((r.d.results || []).length === 0 || (r.d.results || []).every(x => /кот/i.test(x.title)), 'нерелевантные выпуски отфильтрованы по названию');
fs.writeFileSync(feedsPath, JSON.stringify({ feeds: [] }));   // владелец выключил подкасты вовсе
r = await call('/api/state');
ok(r.status === 200 && r.d.podcasts === false, 'пустой файл лент: подкасты выключены выбором владельца, фишка тихая');
fs.writeFileSync(feedsPath, feedsBody);   // вернём ленты остальным проверкам

console.log('\n  3. Вход и метки выпуска');
r = await call('/api/mussearch?q=чехов&sites=audiobooks', {}, null);
ok(r.status === 401, 'поиск без входа закрыт (401)');
const appJs = read('public/app.js');
const apiJs = read('lib/api.js');
const ms = read('lib/mussearch.js');
const sw = read('public/sw.js');
const pkg = read('package.json');
const readme = read('README.md');
ok(ms.includes("id: 'audiobooks'") && ms.includes('function searchAudiobooks('), 'адаптер аудиокниг на официальном API архива');
ok(ms.includes('collection:(librivoxaudio OR audio_bookspoetry) AND language:(rus)') && ms.includes('subject:(аудиокниг*)') && !/q: '[^']*librivoxaudiobooks/.test(ms), 'прицел: настоящие коллекции начиток + метка «аудиокнига», русский язык');
ok(/title:\(' \+ v \+ '\*\)/.test(ms) && /creator:\(' \+ v \+ '\*\)/.test(ms), 'поиск префиксом со звёздочкой по названию и автору');
ok(ms.includes('TRANSLIT') && ms.includes('translitVariants('), 'транслит: запрос кириллицей находит латинского автора');
ok(ms.includes("why: 'tag'"), 'находки по автору не отсекает релевант-фильтр (why:tag, как у ccMixter)');
ok(ms.includes("id: 'podcasts'") && ms.includes('function searchPodcasts('), 'адаптер подкастов из RSS');
ok(ms.includes('/opt/sega/keys/podcasts.json') && ms.includes('function loadPodFeeds('), 'список лент — файл владельца, читается на каждый поиск');
ok(ms.includes('<enclosure') && ms.includes('AUDIO_RE.test(tag)'), 'из RSS берём только звуковые enclosure');
ok(apiJs.includes('podcasts: mussearch.hasFeeds()'), '/api/state несёт метку podcasts для тихой фишки');
ok(appJs.includes("audiobooks: 'аудиокниги (ru)'") && appJs.includes("podcasts: 'подкасты (RSS)'"), 'фишки новых источников в панели поиска');
ok(appJs.includes('function musSourceOff(') && appJs.includes('MUS_SOURCE_KEYFILE'), 'тихие фишки источников с файлом-ключом обобщены (Jamendo и подкасты)');
ok(appJs.includes('let modalDownInside = false;') && appJs.includes('if (modalDownInside) return;'),
  'pkg3-103: выделение текста не сворачивает окно — сворачиваем только если нажатие началось мимо');
ok(sw.includes("const STATIC_CACHE = 'sega-static-v99';"), 'кэш статики поднят до v96');
ok(appJs.includes("const BUILD = 'pkg3-106';") && apiJs.includes("const BUILD = 'pkg3-106';"), 'BUILD pkg3-106 совпадает в клиенте и на сервере');
ok(pkg.includes('node test/music103.mjs'), 'тест music103 включён в цепочку npm test');
ok(readme.includes('| pkg3-103 |'), 'в журнале README есть строка выпуска pkg3-103');
const deps = JSON.parse(pkg).dependencies;
ok(Object.keys(deps).length === 1 && deps['web-push'], 'зависимость по-прежнему одна: web-push');

console.log('\n  pkg3-103: ' + good + ' ✓' + (bad ? ', ' + bad + ' ПРОВАЛОВ' : ', провалов нет'));
process.exit(bad ? 1 : 0);
