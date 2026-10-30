// test/music106.mjs — pkg3-106: светомузыка в квадрате обложки.
// Ритм читает Web Audio, а браузер даёт читать байты звука ТОЛЬКО при CORS
// разрешении источника. Большинство каталогов его не шлёт — шлёт наша труба:
// проверяем заголовок на ответе прокси и клиентскую проводку переключателя.
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
console.log('  pkg3-106: светомузыка — труба открывает браузеру байты (CORS)');
console.log('══════════════════════════════════════════════════\n');

const SONG = Buffer.alloc(300, 7);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sega-m106-'));
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
    MUSSTREAM_EXTRA_HOSTS: mockHost
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

console.log('\n  1. Труба шлёт браузеру разрешение читать звук (CORS)');
r = await call('/api/musstream-ticket', { method: 'POST', body: { url: song } }, admin);
ok(r.status === 200 && !!r.d.t, 'пропуск на игрушечный источник выдан');
const g = await fetch(base + '/api/musstream?t=' + r.d.t);   // как плеер: БЕЗ Authorization
ok(g.status === 200, 'поток по пропуску открыт без заголовков');
ok(g.headers.get('access-control-allow-origin') === '*', 'на ответе трубы стоит Access-Control-Allow-Origin: * — Web Audio прочитает спектр');
ok(String(g.headers.get('content-type') || '').includes('audio/mpeg'), 'тип звука пронесён через трубу');
const body = Buffer.from(await g.arrayBuffer());
ok(body.length === SONG.length, 'байты трека дошли целиком');
const g2 = await fetch(base + '/api/musstream?t=' + hex(24));
ok(g2.status === 403, 'без пропуска труба по-прежнему закрыта (403)');

console.log('\n  2. Клиент: переключатель на квадрате обложки и аудиграф');
const appJs = read('public/app.js'), css = read('public/styles.css');
ok(appJs.includes('function musVizGet()') && appJs.includes("localStorage.getItem('sega.musViz.v1')"), 'состояние светомузыки живёт на устройстве');
ok(appJs.includes('createMediaElementSource') && appJs.includes('createAnalyser'), 'аудиграф: элемент → анализатор спектра → колонки');
ok(appJs.includes('id="mus-viz-c"') && appJs.includes('id="mus-viz-btn"'), 'на квадрате обложки: канвас и кнопка одного нажатия');
ok(appJs.includes('const vizWant = musVizGet() && (musProxyOk(url) || !!(opts && opts.pod));'), 'со светомузыкой звук идёт через трубу — только там есть CORS');
ok(appJs.includes("a.crossOrigin = 'anonymous'"), 'плееру ставится crossOrigin только на пути через трубу');
ok(appJs.includes('источник не открыл байты') && appJs.includes('светомузыка в такт звуку'), 'без спектра — честное «дыхание» с подписью, а не выдуманный ритм');
ok(css.includes('.mus-vizbtn{') && css.includes('.mus-vizc{'), 'стили канваса и кнопки на месте');

console.log('\n──────────────────────────────────────────────────');
console.log('  pkg3-106: ' + good + ' ✓, ' + bad + ' ПРОВАЛОВ');
console.log('──────────────────────────────────────────────────\n');
process.exit(bad ? 1 : 0);
