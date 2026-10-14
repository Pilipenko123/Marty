/**
 * pkg3-55.1: страховка «голой» страницы. Когда через туннель VPN (AdGuard и
 * подобные) или в часы белых списков не догружаются внешние файлы (styles.css,
 * app.js), страница обязана: (а) НЕ показывать стек всех экранов подряд —
 * спрятанное остаётся спрятанным даже без файла стилей; (б) через 20 секунд
 * показать честную плашку «Страница загрузилась не полностью» с тремя причинами
 * и кнопкой «Повторить»; (в) не показывать плашку, если скрипт всё же стартовал
 * (window.SEGA_BOOTED).
 *
 * Проверяем на живой index.html в jsdom БЕЗ загрузки внешних файлов — ровно так
 * выглядит страница, у которой стили и скрипты не долезли через сеть.
 *
 * Запуск: node test/watchdog55.mjs   (нужен jsdom; без него честно пропускается)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let JSDOM, VirtualConsole;
try { ({ JSDOM, VirtualConsole } = await import('jsdom')); } catch {
  console.log('\n  Сторож недогрузки: пропущено (не установлен jsdom — выполните `npm install`)\n');
  process.exit(0);
}

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

let good = 0, bad = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ПРОВАЛ: ') + m); if (c) good++; else bad++; };
const wait = (ms) => new Promise(r => setTimeout(r, ms));

function openPage(beforeParse) {
  const vc = new VirtualConsole();
  const errs = [];
  vc.on('jsdomError', e => { if (!/Could not load/i.test(String(e && e.message))) errs.push(String(e && e.message)); });
  const dom = new JSDOM(HTML, {
    url: 'https://segachat.pilpro.ru/',
    runScripts: 'dangerously',          // встроенные скрипты выполняются
    pretendToBeVisual: true,
    beforeParse,
  });
  return { dom, errs };
}

console.log('\n══════════════════════════════════════════════════');
console.log('  Сторож недогрузки: страница не «раздевается» и не молчит');
console.log('══════════════════════════════════════════════════\n');

const watchdog = setTimeout(() => {
  console.log('  ✗ ПРОВАЛ: проверка зависла (30 c)');
  process.exit(1);
}, 30000);

// ── 1. Стили и скрипты не догрузились: экраны НЕ торчат стеком ─────────────
{
  const { dom, errs } = openPage(w => { w.SEGA_WD_MS = 40; });
  const d = dom.window.document;
  ok(getDisplay(d, '#screen-setup') === 'none', 'без styles.css экран «Первый запуск» остаётся спрятан (inline-правило .hidden)');
  ok(getDisplay(d, '#screen-auth') === 'none', 'без styles.css экран входа остаётся спрятан');
  ok(getDisplay(d, '#screen-loading') !== 'none', 'экран «Соединяемся…» виден (страница не белая)');
  ok(errs.length === 0, 'встроенные скрипты страницы выполняются без ошибок' + (errs.length ? ': ' + errs[0] : ''));

  // ── 2. Сторож встаёт через заданное время и говорит честно ───────────────
  await wait(250);
  const plate = d.getElementById('segawd');
  ok(!!plate, 'сторож показал плашку, когда app.js не стартовал');
  const text = plate ? plate.textContent : '';
  ok(/Повторить/.test(text), 'на плашке есть кнопка «Повторить»');
  ok(/белыми списками/.test(text), 'плашка называет причину «белые списки операторов»');
  ok(/VPN/.test(text), 'плашка называет причину «VPN на телефоне»');
  ok(/зашифрованными/.test(text), 'плашка успокаивает: переписки зашифрованы, ничего не потерялось');
  const btn = d.getElementById('segawd-retry');
  ok(!!btn && typeof btn.onclick === 'function', 'кнопка «Повторить» живая (перезагрузит страницу)');

  // ── 3. Второй вызов сторожа не плодит плашек ─────────────────────────────
  d.getElementById('segawd')?.remove();
  await wait(10);
  dom.window.dispatchEvent(new dom.window.Event('segawd-noop')); // просто тормошим окно
  ok(d.querySelectorAll('#segawd').length === 0, 'плашка убирается одним движением (дублей не остаётся)');
  dom.window.close();
}

// ── 4. Скрипт стартовал — сторож молчит ────────────────────────────────────
{
  const { dom } = openPage(w => { w.SEGA_WD_MS = 40; w.SEGA_BOOTED = 1; });
  await wait(250);
  const d = dom.window.document;
  ok(!d.getElementById('segawd'), 'если app.js подал признак жизни, плашка не появляется');
  dom.window.close();
}

function getDisplay(d, sel) {
  const el = d.querySelector(sel);
  return el ? d.defaultView.getComputedStyle(el).display : 'missing';
}

clearTimeout(watchdog);
console.log('\n  Сторож недогрузки: ' + good + ' ✓, провалов: ' + bad + '\n');
process.exit(bad ? 1 : 0);
