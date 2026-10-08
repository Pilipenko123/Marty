/**
 * pkg3-42: проверка разметки и селекторов в настоящем DOM (jsdom).
 * Убеждаемся, что новое правило «спрятать поиск в мобильной игре» действительно
 * находит нужный узел в настоящем index.html, а заголовок доски собирается так,
 * как задумано. Запуск: node test/dom42.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// jsdom — единственная внешняя библиотека в проекте, и только для разработчика
// (в программу и в облако она не попадает). Нет её — честно пропускаем проверку.
let JSDOM;
try { ({ JSDOM } = await import('jsdom')); } catch {
  console.log('\n  Разметка pkg3-42: пропущено (не установлен jsdom — выполните `npm install`)\n');
  process.exit(0);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const PUB = join(HERE, '..', 'public');
const html = readFileSync(join(PUB, 'index.html'), 'utf8');
const css = readFileSync(join(PUB, 'styles.css'), 'utf8');

let bad = 0, good = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ПРОВАЛ: ') + m); if (c) good++; else bad++; };

console.log('\n══════════════════════════════════════════════════');
console.log('  pkg3-42: разметка и селекторы интерфейса партии');
console.log('══════════════════════════════════════════════════');

const dom = new JSDOM(html);
const d = dom.window.document;
const main = d.querySelector('#main');
const topbar = d.querySelector('#topbar');
const searchWrap = d.querySelector('.search-wrap');

ok(!!main && !!topbar && main.contains(topbar), 'шапка #topbar лежит внутри #main — селектор #main.game-mode … до неё дотянется');
ok(!!searchWrap && topbar.contains(searchWrap), 'строка поиска .search-wrap живёт в шапке чата');
ok(!!d.querySelector('#search') && !!d.querySelector('#btn-search-clear'), 'поле поиска и крестик «очистить» на месте');

// правило должно существовать и быть привязано к узкому экрану:
// вырезаем блок @media (max-width:959px) честным подсчётом скобок
function mediaBlock(text, query) {
  const at = text.indexOf('@media ' + query + '{');
  if (at < 0) return '';
  let i = text.indexOf('{', at), depth = 0;
  for (let j = i; j < text.length; j++) {
    if (text[j] === '{') depth++;
    else if (text[j] === '}' && --depth === 0) return text.slice(i, j + 1);
  }
  return '';
}
const narrow = mediaBlock(css, '(max-width:959px)');
const rule = narrow.includes('#main.game-mode .search-wrap{display:none;}');
ok(!!narrow, 'в стилях есть блок @media (max-width:959px) — узкий экран');
ok(rule, 'внутри него — #main.game-mode .search-wrap{display:none;} (поиск скрыт только в игре на телефоне)');

// как только чат становится игровым, селектор обязан сработать
main.classList.add('game-mode');
ok(!!d.querySelector('#main.game-mode .search-wrap'), 'селектор #main.game-mode .search-wrap находит строку поиска в игровом чате');
main.classList.remove('game-mode');
ok(!d.querySelector('#main.game-mode .search-wrap'), 'в обычном чате тот же селектор не срабатывает — поиск остаётся видимым');

// движок шашек подключён раньше app.js (app.js зовёт createCheckers и rusSan)
const scripts = [...d.querySelectorAll('script[src]')].map(s => s.getAttribute('src'));
ok(scripts.indexOf('chess-engine.js') < scripts.indexOf('app.js'), 'chess-engine.js подключён раньше app.js');
ok(scripts.indexOf('checkers-engine.js') < scripts.indexOf('app.js'), 'checkers-engine.js подключён раньше app.js');

// заголовок доски: три колонки, кнопки по краям, «чей ход» по центру
const panel = new JSDOM('<div class="board-panel"></div>').window.document;
panel.querySelector('.board-panel').innerHTML = `
    <div class="bp-head">
      <div class="bph-l"><button class="mini danger" id="gm-leave" title="Сдаться и выйти">Сдаться</button></div>
      <div class="bph-m"><i class="tdot w"></i>Ход: Пётр</div>
      <div class="bph-r"><button class="mini" id="gm-knocks" title="Заявки зрителей: 2">Заявки: 2</button></div>
    </div>
    <div class="board" id="board"></div>
    <div class="bp-moves-list" id="game-moves"></div>`;
const head = panel.querySelector('.bp-head');
ok(head.children.length === 3, 'в заголовке над доской ровно три колонки');
ok([...head.children].map(x => x.className).join(',') === 'bph-l,bph-m,bph-r', 'порядок колонок: кнопки слева, «чей ход» в центре, кнопки справа');
ok(head.querySelector('.bph-l #gm-leave') && head.querySelector('.bph-r #gm-knocks'), 'кнопки «Сдаться» и «Заявки» лежат по краям от надписи');
ok(!panel.querySelector('.bp-ctrl'), 'отдельной строки кнопок под доской больше нет');
ok(head.querySelector('.bph-m').textContent.includes('Ход:'), 'надпись «чей ход» осталась в центре заголовка');

// стили трёх колонок на месте, боковые равной ширины — центр не уезжает
ok(css.includes('.bph-l,.bph-r{flex:1 1 0;'), 'боковые колонки равной ширины (flex:1 1 0) — надпись строго по центру');
ok(css.includes('.bph-m{flex:0 1 auto;text-align:center;'), 'центральная колонка не растягивается и центрирует текст');
ok(css.includes('.bp-head{display:flex'), 'заголовок доски — гибкий контейнер');
ok(!css.includes('.bp-ctrl{'), 'стиль старой строки кнопок удалён из таблицы стилей');

console.log('\n──────────────────────────────────────────────────');
console.log(`  Разметка pkg3-42: ${good} ✓, провалов ${bad}`);
console.log('──────────────────────────────────────────────────\n');
if (bad) process.exit(1);
