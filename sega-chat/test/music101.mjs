// test/music101.mjs — pkg3-101/102: запасной путь звука — прослушивание через
// сервер. Живой сервер против игрушечного стрим-хоста: труба байтов, перемотка
// (Range), переходы с перепроверкой домена, «страница вместо звука», потолок
// потоков. С 102-го звук закрыт РАЗОВЫМ ПРОПУСКОМ (плеер не умеет заголовки):
// пропуск берётся входным запросом, плеер предъявляет только его.
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
console.log('  pkg3-101: звук через сервер, когда источник закрыт');
console.log('══════════════════════════════════════════════════\n');

const SONG = Buffer.alloc(2000); for (let i = 0; i < SONG.length; i++) SONG[i] = (i * 7) & 0xff;   // «мп3»
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sega-m101-'));

/** Игрушечный стрим-хост: отдаёт звук, умеет Range, переходы и «страницу». */
const mock = http.createServer((rq, rs) => {
  const u = new URL(rq.url, 'http://mock');
  if (u.pathname === '/audio/ok.mp3') {
    const rng = rq.headers.range;
    if (rng && /^bytes=\d+-\d*$/.test(rng)) {
      const [a, b] = rng.slice(6).split('-');
      const s = Number(a), e = b ? Math.min(Number(b), SONG.length - 1) : SONG.length - 1;
      rs.writeHead(206, {
        'Content-Type': 'audio/mpeg', 'Content-Range': `bytes ${s}-${e}/${SONG.length}`,
        'Content-Length': String(e - s + 1), 'Accept-Ranges': 'bytes'
      });
      return rs.end(SONG.subarray(s, e + 1));
    }
    rs.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': String(SONG.length), 'Accept-Ranges': 'bytes' });
    return rs.end(SONG);
  }
  if (u.pathname === '/audio/redirect') { rs.writeHead(302, { Location: '/audio/ok.mp3' }); return rs.end(); }
  if (u.pathname === '/audio/redirect-bad') { rs.writeHead(302, { Location: 'http://evil.example/x.mp3' }); return rs.end(); }
  if (u.pathname === '/audio/page.html') { rs.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return rs.end('<html>это страница</html>'); }
  if (u.pathname === '/audio/slow.mp3') {
    rs.writeHead(200, { 'Content-Type': 'audio/mpeg' });
    let n = 0;
    const t = setInterval(() => {
      n++;
      if (n > 60) { clearInterval(t); return rs.end(); }
      if (!rs.write(SONG.subarray(0, 10))) return;   // по капле — поток жив, пока его слушают
    }, 50);
    rq.on('close', () => clearInterval(t));
    return;
  }
  rs.writeHead(404, { 'Content-Type': 'text/plain' }); rs.end('nope');
});
await new Promise(r => mock.listen(0, '127.0.0.1', r));
const mockPort = mock.address().port;
const mockHost = '127.0.0.1:' + mockPort;

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
    MUSSTREAM_EXTRA_HOSTS: mockHost          // тестовая добавка белого списка
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

const song = 'http://' + mockHost + '/audio/ok.mp3';
/** Путь плеера: пропуск входным запросом → звук БЕЗ заголовков (как <audio>). */
async function grab(url, headers) {
  const tr = await call('/api/musstream-ticket', { method: 'POST', body: { url: url } }, admin);
  if (tr.status !== 200) return { status: tr.status, d: tr.d, headers: { get: () => null }, buf: Buffer.alloc(0) };
  const rr = await fetch(base + '/api/musstream?t=' + tr.d.t, { headers: headers || {} });
  if (rr.status >= 400) {
    let d = null; try { d = await rr.json(); } catch (e) {}
    return { status: rr.status, d, headers: rr.headers, buf: Buffer.alloc(0) };
  }
  return { status: rr.status, d: null, headers: rr.headers, buf: Buffer.from(await rr.arrayBuffer()) };
}

console.log('\n  1. Труба байтов: звук идёт через сервер как есть');
r = await call('/api/musstream-ticket', { method: 'POST', body: { url: song } }, null);
ok(r.status === 401, 'без входа пропуск не выдать (401)');
r = await call('/api/musstream?t=deadbeef', {}, null);
ok(r.status === 403, 'без пропуска звук закрыт (403)');
const g = await grab(song);
ok(g.status === 200 && g.headers.get('content-type') === 'audio/mpeg', 'по пропуску сервер отдаёт звук и тип источника БЕЗ заголовка входа');
ok(g.buf.equals(SONG), 'байты дошли БЕЗ изменений (все 2000 байт «мп3»)');

console.log('\n  2. Перемотка: Range уходит источнику, 206 возвращается как есть');
const rg = await grab(song, { Range: 'bytes=100-199' });
ok(rg.status === 206 && rg.buf.length === 100 && rg.buf.equals(SONG.subarray(100, 200)), 'кусок 100–199 пришёл байт в байт');
ok((rg.headers.get('content-range') || '') === 'bytes 100-199/2000', 'Content-Range источника передан слушателю');

console.log('\n  3. Белый список: чужие домены и переходы на чужой сайт не пускаем');
r = await call('/api/musstream-ticket', { method: 'POST', body: { url: 'https://evil.example/x.mp3' } }, admin);
ok(r.status === 403, 'пропуск на чужой домен не выдать — сервер не открытый прокси');
r = await call('/api/musstream-ticket', { method: 'POST', body: { url: 'http://127.0.0.2:' + mockPort + '/audio/ok.mp3' } }, admin);
ok(r.status === 403, 'хост вне белого списка (даже соседний адрес) — пропуск не выдать');
const rb2 = await grab('http://' + mockHost + '/audio/redirect-bad');
ok(rb2.status === 403, 'переход 302 на чужой домен пойман и отклонён');
r = await call('/api/musstream-ticket', { method: 'POST', body: { url: 'not-a-url' } }, admin);
ok(r.status === 400 || r.status === 403, 'кривая ссылка отклонена без падения маршрута');

console.log('\n  4. Переходы внутри белого списка и честные отказы');
const rd = await grab('http://' + mockHost + '/audio/redirect');
ok(rd.status === 200 && rd.buf.equals(SONG), 'переход 302 на тот же хост дошёл до звука');
r = await grab('http://' + mockHost + '/audio/page.html');
ok(r.status === 502 && /страницу вместо звука/.test((r.d && r.d.error) || ''), 'страница вместо звука — по-человечески: «отдал страницу вместо звука»');
r = await grab('http://' + mockHost + '/audio/nope.mp3');
ok(r.status === 502 && /ошибкой 404/.test((r.d && r.d.error) || ''), 'ошибка источника 404 видна в подсказке');

console.log('\n  5. Потолок одновременных потоков бережёт VPS');
const hold = [];
for (let i = 0; i < 6; i++) {
  const tr = await call('/api/musstream-ticket', { method: 'POST', body: { url: 'http://' + mockHost + '/audio/slow.mp3' } }, admin);
  hold.push(fetch(base + '/api/musstream?t=' + tr.d.t));
}
await wait(400);
r = await grab(song);
ok(r.status === 503 && /слишком много людей/.test((r.d && r.d.error) || ''), 'седьмому потоку честно сказано подождать (503)');
for (const h of hold) { try { const x = await h; await x.arrayBuffer().catch(() => {}); } catch (e) {} }
await wait(200);
r = await grab(song);
ok(r.status === 200, 'потоки освободились — следующий слушатель снова в строю');

console.log('\n  6. Метки выпуска, стили «＋» и запасной путь в клиенте');
const appJs = read('public/app.js');
const apiJs = read('lib/api.js');
const sw = read('public/sw.js');
const css = read('public/styles.css');
const srv = read('server.js');
const mst = read('lib/musstream.js');
const pkg = read('package.json');
const readme = read('README.md');
ok(appJs.includes("const BUILD = 'pkg3-104';") && apiJs.includes("const BUILD = 'pkg3-104';"), 'BUILD pkg3-104 совпадает в клиенте и на сервере');
ok(sw.includes("const STATIC_CACHE = 'sega-static-v97';"), 'кэш статики поднят до v95');
ok(css.includes('button.mini.mus-add-sm{width:auto;min-width:34px;margin-top:0'), 'у «＋» в находках явная маленькая ширина — глобальное правило его больше не растягивает');
ok(!/button\.mini\.mus-add-sm\{[^}]*width:100%/.test(css), 'и ширина 100% у него не осталась');
ok(appJs.includes('MUS_PROXY_HOSTS') && appJs.includes("'/api/musstream?t='"), 'клиент знает запасной путь и адрес с пропуском');
ok(appJs.includes('function musStartStream(') && appJs.includes('sega.musProxyHosts.v1'), 'тихий переход на поток через сервер и память отказавших хостов');
ok(appJs.includes('musstream-ticket') && apiJs.includes('musTickets'), 'пропуск: клиент просит входным запросом, сервер держит в памяти');
ok(!appJs.includes('/api/musstream?url='), 'старый адрес прокси без пропуска ушёл из клиента (урок 101-го: 401 без заголовка)');
ok(appJs.includes('musStartStream(musicAudio(), url, () => {})'), 'догоняющий трек «Слушаю с …» тоже с запасным путём');
ok(mst.includes("'jamendo.com'") && mst.includes('MAX_STREAMS'), 'белый список источников и потолок потоков на сервере');
ok(srv.includes('out.pipe') && srv.includes('stream.pipe(res)'), 'server.js передаёт поток трубой, без накопления в памяти');
ok(apiJs.includes("throttle('musstream-t-' + me.id, 90)"), 'выдача пропусков под дросселем, как и поиск');
ok(pkg.includes('node test/music101.mjs'), 'тест music101 включён в цепочку npm test');
ok(readme.includes('| pkg3-101 |'), 'в журнале README есть строка выпуска pkg3-101');
const deps = JSON.parse(pkg).dependencies;
ok(Object.keys(deps).length === 1 && deps['web-push'], 'зависимость по-прежнему одна: web-push');

console.log('\n  pkg3-101: ' + good + ' ✓' + (bad ? ', ' + bad + ' ПРОВАЛОВ' : ', провалов нет'));
process.exit(bad ? 1 : 0);
