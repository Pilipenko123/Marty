/**
 * pkg3-55: что видит человек, когда сервер не отвечает (ограничение мобильной
 * сети по белым спискам, VPN-туннель, перезапуск сервера).
 *
 * Поднимается ЗАГЛУШКА-сервер, которая отдаёт статику, но на все /api отвечает
 * ошибкой — ровно так выглядит для телефона «сеть есть, сервера нет». Проверки:
 *   • вместо вечной шкалы «Соединяемся с облаком…» появляются повторные попытки;
 *   • после них — плашка с тремя честными причинами (белые списки, VPN, перезапуск)
 *     и кнопкой «Повторить»;
 *   • кнопка «Повторить» убирает плашку и запускает попытки заново.
 *
 * Запуск: node test/boot-fail.mjs   (нужен jsdom; без него честно пропускается)
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

let JSDOM, VirtualConsole;
try { ({ JSDOM, VirtualConsole } = await import('jsdom')); } catch {
  console.log('\n  Старт без сервера: пропущено (не установлен jsdom — выполните `npm install`)\n');
  process.exit(0);
}

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

// заглушка: статика есть, а «сервера» нет — как в ограниченной мобильной сети
const srv = http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end('{"error":"сервер недоступен (заглушка проверки)"}');
    return;
  }
  const rel = req.url.split('?')[0].replace(/^\/+/, '') || 'index.html';
  const file = path.join(PUB, rel);
  if (!file.startsWith(PUB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('нет'); return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const PORT = srv.address().port;

let good = 0, bad = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ПРОВАЛ: ') + m); if (c) good++; else bad++; };
const wait = (ms) => new Promise(r => setTimeout(r, ms));

console.log('\n══════════════════════════════════════════════════');
console.log('  Старт без сервера: честная плашка вместо вечной шкалы');
console.log('══════════════════════════════════════════════════\n');

const watchdog = setTimeout(() => {
  console.log('  ✗ ПРОВАЛ: проверка зависла (60 c)');
  process.exit(1);
}, 60000);

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => errors.push('jsdomError: ' + ((e && e.message) || e)));
const dom = await JSDOM.fromURL(`http://127.0.0.1:${PORT}/`, {
  runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc,
  beforeParse(w) {
    w.addEventListener('error', e => errors.push('window.onerror: ' + (e.message || e)));
    // jsdom не даёт ни WebCrypto, ни fetch: без них загрузка не доходит до сети
    // и проверка превращается в пустышку — подставляем узловые реализации
    try {
      const nodeCrypto = createRequire(import.meta.url)('node:crypto');
      Object.defineProperty(w, 'crypto', { value: nodeCrypto.webcrypto, configurable: true });
    } catch (e) { errors.push('не удалось подставить crypto: ' + e.message); }
    w.fetch = (u, o) => fetch(String(u).startsWith('http') ? u : new URL(u, w.location.href).href, o);
  }
});
const d = dom.window.document;

// жём плашку: 4 попытки с паузами 1.2+2.4+4.8 ≈ 8.4 c + запас
let box = null;
for (let i = 0; i < 40; i++) {
  box = d.getElementById('net-fail');
  if (box) break;
  await wait(500);
}
ok(!!box, 'после неудачных попыток появилась плашка «Сервер не отвечает»');
if (box) {
  const txt = box.textContent || '';
  ok(/белыми списками/.test(txt), 'в плашке названа причина «белые списки операторов»');
  ok(/VPN/.test(txt), 'в плашке названа причина «VPN мешает соединению»');
  ok(/перезапускается/.test(txt), 'в плашке названа причина «сервер перезапускается»');
  ok(!!d.getElementById('nf-retry'), 'есть кнопка «Повторить»');
  ok(!/Соединяемся с облаком/.test((d.getElementById('lu-stage') || {}).textContent || ''),
    'вечная шкала «Соединяемся с облаком…» не осталась на экране');
  // повтор: плашка уходит, попытки начинаются заново
  d.getElementById('nf-retry').click();
  await wait(300);
  ok(!d.getElementById('net-fail'), 'по кнопке «Повторить» плашка убирается');
  let stage = '';
  for (let i = 0; i < 10; i++) {
    stage = (d.getElementById('lu-stage') || {}).textContent || '';
    if (/попытка/.test(stage)) break;
    await wait(400);
  }
  ok(/попытка/.test(stage), 'после повтора снова идут попытки («' + stage.trim() + '»)');
}
ok(errors.length === 0, 'app.js не падает на старте без сервера' + (errors[0] ? ' → ' + String(errors[0]).split('\n')[0] : ''));

console.log('\n──────────────────────────────────────────────────');
console.log(`  Старт без сервера: ${good} ✓, провалов ${bad}`);
console.log('──────────────────────────────────────────────────\n');

dom.window.close();
srv.close();
clearTimeout(watchdog);
process.exit(bad ? 1 : 0);
