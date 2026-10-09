// pkg3-46: проверка ЗАГРУЗКИ страницы в браузерной среде (jsdom + настоящий сервер).
// Ловит падения app.js на верхнем уровне: из-за них экран «Соединяемся…» висит
// вечно, сервер при этом здоров и тесты API зелёные — ровно так сломался pkg3-45.
// Запуск: node test/boot.mjs   (нужен jsdom; без него честно пропускается)
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let JSDOM, VirtualConsole;
try { ({ JSDOM, VirtualConsole } = await import('jsdom')); } catch {
  console.log('\n  Загрузка страницы: пропущено (не установлен jsdom — выполните `npm install`)\n');
  process.exit(0);
}

// страховка: probe не имеет права висеть — зависание считаем провалом
const watchdog = setTimeout(() => {
  console.log('  ✗ ПРОВАЛ: probe загрузки завис (60 c) — страница не догрузилась');
  process.exit(1);
}, 60000);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8931 + Math.floor(Math.random() * 300);
const dir = mkdtempSync(join(tmpdir(), 'sega-boot-'));
const srv = spawn(process.execPath, ['server.js'], {
  cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
  env: Object.assign({}, process.env, { PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dir, STORE: 'file', HTTPS: '' })
});
await new Promise(r => setTimeout(r, 1500));

let bad = 0, good = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ПРОВАЛ: ') + m); if (c) good++; else bad++; };

console.log('\n══════════════════════════════════════════════════');
console.log('  Загрузка страницы: экран не должен зависать');
console.log('══════════════════════════════════════════════════');

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => errors.push('jsdomError: ' + ((e && e.message) || e)));
const dom = await JSDOM.fromURL('http://127.0.0.1:' + PORT + '/', {
  runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc,
  beforeParse(w) { w.addEventListener('error', e => errors.push('window.onerror: ' + (e.message || e))); }
});
await new Promise(r => setTimeout(r, 3000));
const d = dom.window.document;
const visible = id => { const el = d.getElementById(id); return !!el && !el.classList.contains('hidden'); };

ok(errors.length === 0, 'app.js не падает на верхнем уровне' + (errors[0] ? ' → ' + String(errors[0]).split('\n')[0] : ''));
ok(!visible('screen-loading'), 'экран «Соединяемся…» ушёл, а не висит вечно');
ok(visible('screen-setup'), 'на пустой базе показан экран создания мессенджера');
ok(typeof dom.window.qrcode === 'function', 'генератор QR доступен странице как window.qrcode');

console.log('\n──────────────────────────────────────────────────');
console.log(`  Загрузка страницы: ${good} ✓, провалов ${bad}`);
console.log('──────────────────────────────────────────────────\n');
dom.window.close();
srv.kill('SIGTERM');
clearTimeout(watchdog);
process.exit(bad ? 1 : 0);
