/**
 * pkg3-79: отдача статики знает картинки-карты.
 *   Без строки '.jpg' сервер подписывал карту как «application/octet-stream»,
 *   а при запрете распознавания типа браузер отказывался показывать её —
 *   поле «Золотой лихорадки» оставалось пустым. Здесь проверяем подписи типов.
 * Запуск: node test/static79.mjs
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { serveStatic } = require('../lib/static.js');

let good = 0, bad = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ПРОВАЛ: ') + m); if (c) good++; else bad++; };
const ct = p => (serveStatic(p, '').headers || {})['Content-Type'] || '';

console.log('\n══════════════════════════════════════════════════');
console.log('  Статика: типы файлов · pkg3-79');
console.log('══════════════════════════════════════════════════\n');

ok(ct('/img/coins-map1.jpg') === 'image/jpeg', 'карта «Золотой лихорадки» .jpg отдаётся как image/jpeg');
ok(ct('/img/coins-coin.png') === 'image/png', 'иконка .png отдаётся как image/png');
ok(ct('/coins-engine.js') === 'text/javascript; charset=utf-8', 'движок «Золотой лихорадки» .js отдаётся как text/javascript');
ok(ct('/game-sound.js') === 'text/javascript; charset=utf-8', 'звуковой движок игр .js отдаётся как text/javascript');
ok(ct('/app.js') === 'text/javascript; charset=utf-8', 'app.js отдаётся как text/javascript');
ok(ct('/sw.js') === 'text/javascript; charset=utf-8', 'sw.js отдаётся как text/javascript');
ok(ct('/styles.css') === 'text/css; charset=utf-8', 'styles.css отдаётся как text/css');
ok(ct('/index.html') === 'text/html; charset=utf-8', 'страница отдаётся как text/html');
ok(ct('/img/coins-map4.jpg') === 'image/jpeg', 'вторая карта .jpg тоже image/jpeg');

console.log('\n  static79: ' + good + ' ✓, провалов: ' + bad + '\n');
if (bad) { console.log('ЕСТЬ ПРОВАЛЫ'); process.exit(1); }
