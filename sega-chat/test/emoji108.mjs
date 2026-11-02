// test/emoji108.mjs — pkg3-108: смайлы всегда загружаются (картинку отдаёт НАШ сервер).
//
// Повод (владелец): «когда хочешь поставить реакцию, некоторые эмодзи не
// загружаются». Причин было две: в наборах реакций стояли ПУСТЫЕ строки (пустые
// кнопки), и картинки шли напрямую с чужого CDN, который в чужой сети может быть
// закрыт. Здесь проверяем вторую половину — маршрут /api/emoji/<код>.svg:
//   • открытый (картинка не может приложить заголовок входа);
//   • отдаёт только файлы смайлов по строгому образцу кода (ни путей, ни чужих адресов);
//   • копия живёт в памяти: повторная просьба НЕ идёт в сеть;
//   • отказ источника, страница-обманка вместо картинки и слишком большой файл —
//     честный 404 (клиент покажет системный значок), а не пустая кнопка;
//   • источников два: если первый молчит — берём второй.
//
// Игрушечный сайт-источник поднимается на 127.0.0.1, адрес подставляется
// переменной EMOJI_CDN_BASE.

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
console.log('  pkg3-108: смайлы через наш сервер (копия в памяти)');
console.log('══════════════════════════════════════════════════\n');

const BUILD = /const BUILD = '([^']+)'/.exec(read('lib/api.js'))[1];
const SVG = n => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36"><text>${n}</text></svg>`);

// ── игрушечный источник картинок ────────────────────────────────────────────
const hits = new Map();                       // сколько раз просили каждый файл
const mock = http.createServer((rq, rs) => {
  const name = (rq.url || '/').replace(/^\//, '');
  hits.set(name, (hits.get(name) || 0) + 1);
  if (name === '1f61a.svg') { rs.writeHead(500, { 'Content-Type': 'text/html' }); rs.end('<h1>нет</h1>'); return; }
  if (name === '1f61b.svg') { rs.writeHead(200, { 'Content-Type': 'text/html' }); rs.end('<html>это не картинка</html>'); return; }
  if (name === '1f619.svg') { rs.writeHead(200, { 'Content-Type': 'image/svg+xml' }); rs.end(Buffer.alloc(40 * 1024, 65)); return; }
  if (name === '1f617.svg') { rs.writeHead(302, { Location: '/1f971.svg' }); rs.end(); return; }
  rs.writeHead(200, { 'Content-Type': 'image/svg+xml' });
  rs.end(SVG(name));
});
await new Promise(r => mock.listen(0, '127.0.0.1', r));
const mockBase = 'http://127.0.0.1:' + mock.address().port + '/';

async function freePort() {
  const { createServer } = await import('node:net');
  return new Promise(r => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
}
const procs = [];
process.on('exit', () => { for (const p of procs) { try { p.kill('SIGKILL'); } catch (e) {} } try { mock.close(); } catch (e) {} });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sega-e108-'));
const port = await freePort();
const proc = spawn(process.execPath, ['server.js'], {
  cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
  env: Object.assign({}, process.env, {
    STORE: 'file', DATA_DIR: path.join(dir, 'data'), HOST: '127.0.0.1', HTTPS: '', PRESENCE_EVERY: '0',
    NEW_INVITE_DELAY: '0', INVITE_COOLDOWN_MS: '0', PORT: String(port),
    // первый источник — заведомо мёртвый порт: проверяем переход ко второму
    EMOJI_CDN_BASE: 'http://127.0.0.1:1/' + ',' + mockBase
  })
});
procs.push(proc);
const base = 'http://127.0.0.1:' + port;
for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/api/state')).ok) break; } catch (e) {} await wait(200); }

const img = async p => {
  const r = await fetch(base + p);
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, type: r.headers.get('content-type') || '', cache: r.headers.get('cache-control') || '', body: buf.toString('utf8'), len: buf.length };
};

console.log('\n  1. Маршрут открытый и отдаёт настоящую картинку (БЕЗ входа)');
let r = await img('/api/emoji/1f600.svg');
ok(r.status === 200, 'GET /api/emoji/1f600.svg без заголовка входа — 200 (картинка не умеет входить)');
ok(/image\/svg\+xml/.test(r.type), 'тип ответа — image/svg+xml');
ok(/<svg/.test(r.body), 'в ответе настоящая картинка, а не страница-обманка');
ok(/immutable/.test(r.cache) && /max-age=\d{6,}/.test(r.cache), 'кэш браузера вечный (immutable) — повторно не просим');
const packed600 = fs.readFileSync(path.join(ROOT, 'public', 'img', 'emoji', '1f600.svg'), 'utf8');
ok(r.body === packed600, 'отдан ИМЕННО запрошенный смайл — байт в байт из папки программы');

console.log('\n  2. Смайлы меню и реакций ЛЕЖАТ ВНУТРИ ПРОГРАММЫ (сеть не нужна вовсе)');
const emojiMod = await import('file://' + path.join(ROOT, 'lib', 'emoji.js'));
const packed = fs.readdirSync(path.join(ROOT, 'public', 'img', 'emoji')).filter(f => f.endsWith('.svg'));
ok(packed.length >= 40, `внутри программы ${packed.length} файлов смайлов (public/img/emoji)`);
ok(!!emojiMod.fromBundle('1f600') && !!emojiMod.fromBundle('2615') && !!emojiMod.fromBundle('2764'),
  'картинки обычных смайлов и «сердца» (2764 — без невидимого уточнителя) лежат внутри');
ok(!(hits.get('1f600.svg')), 'за смайлом из папки программы сервер в сеть НЕ ходил');
ok(!emojiMod.fromBundle('1f971'), 'редкого смайла (1f971) внутри программы нет — его берём у источника');
const before = hits.get('1f971.svg') || 0;
for (let i = 0; i < 3; i++) await img('/api/emoji/1f971.svg');
ok((hits.get('1f971.svg') || 0) === before + 1, `источник просили один раз, повторы из памяти (было ${before})`);

console.log('\n  3. Первый источник мёртв — берём второй');
r = await img('/api/emoji/1f972.svg');
ok(r.status === 200 && /<svg/.test(r.body), 'смайл, которого нет внутри (1f972), получен со ВТОРОГО источника');
r = await img('/api/emoji/1f61c.svg');   // 1f61c (😜) внутри есть — путь «из папки»
ok(r.status === 200 && !(hits.get('1f61c.svg')), 'а известный смайл снова отдан из папки программы, без сети');

console.log('\n  4. Чужие адреса и выдуманные имена закрыты');
for (const p of ['/api/emoji/..%2f..%2fserver.js', '/api/emoji/%2e%2e%2fpackage.json', '/api/emoji/1f600.png',
                 '/api/emoji/ZZZ.svg', '/api/emoji/1f600-!!!.svg', '/api/emoji/.svg']) {
  r = await img(p);
  ok(r.status === 404, `${p} → 404 (ни путей, ни чужих файлов, ни другого расширения)`);
}

console.log('\n  5. Плохой источник — честный 404, а не пустая кнопка');
r = await img('/api/emoji/1f61a.svg');
ok(r.status === 404, 'источник ответил 500 — сервер отвечает 404');
ok(/системный значок/.test(r.body), 'человеческая подсказка: «покажем системный значок»');
r = await img('/api/emoji/1f61b.svg');
ok(r.status === 404, 'вместо картинки пришла страница — не берём (404)');
r = await img('/api/emoji/1f619.svg');
ok(r.status === 404, 'источник отдал 40 КБ вместо смайла — не берём (потолок памяти)');

console.log('\n  6. Переходы (301/302) источника уважаются');
r = await img('/api/emoji/1f617.svg');
ok(r.status === 200 && /<svg/.test(r.body), 'по 302 сервер дошёл до настоящего файла');

console.log('\n  7. Отметки выпуска и границы модуля');
r = await img('/api/state');
const state = JSON.parse(r.body);
ok(state.build === BUILD, `/api/state отдаёт build=${state.build} (как в lib/api.js)`);
const api = read('lib/api.js');
ok(api.indexOf("pathname.startsWith('/api/emoji/')") > 0, 'маршрут смайлов есть в lib/api.js');
ok(api.indexOf("pathname.startsWith('/api/emoji/')") < api.indexOf('дальше только с токеном'),
  'маршрут стоит в ОТКРЫТОЙ зоне — до проверки входа');
const emoji = await import(path.join('file://' + ROOT, 'lib/emoji.js'));
ok(emoji.isValidCode('1f600') && emoji.isValidCode('2764') && emoji.isValidCode('1f468-200d-2764-fe0f-200d-1f468'),
  'правильные коды смайлов принимаются (в том числе склейки через дефис)');
ok(!emoji.isValidCode('../x') && !emoji.isValidCode('1f600.png') && !emoji.isValidCode('') && !emoji.isValidCode('a'.repeat(80)),
  'пути, точки и слишком длинные коды отклоняются');
ok(emoji.CACHE_MAX > 0 && emoji.CACHE_MAX <= 2000, `потолок памяти задан (${emoji.CACHE_MAX} картинок)`);

console.log(`\n  ИТОГ: ${good} ✓, ${bad ? bad + ' провалов' : 'провалов нет'}\n`);
process.exit(bad ? 1 : 0);
