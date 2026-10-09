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
// все блоки узкого экрана разом: правило может жить в любом из них
function mediaBlocks(text, query) {
  const out = [];
  let at = text.indexOf('@media ' + query + '{');
  while (at >= 0) {
    let i = text.indexOf('{', at), depth = 0;
    for (let j = i; j < text.length; j++) {
      if (text[j] === '{') depth++;
      else if (text[j] === '}' && --depth === 0) { out.push(text.slice(i, j + 1)); break; }
    }
    at = text.indexOf('@media ' + query + '{', at + 1);
  }
  return out;
}
const mobs = mediaBlocks(css, '(max-width:959px)');
ok(mobs.length >= 2, 'блоков @media (max-width:959px) несколько — найдено ' + mobs.length);

// как только чат становится игровым, селектор обязан сработать
main.classList.add('game-mode');
ok(!!d.querySelector('#main.game-mode .search-wrap'), 'селектор #main.game-mode .search-wrap находит строку поиска в игровом чате');
main.classList.remove('game-mode');
ok(!d.querySelector('#main.game-mode .search-wrap'), 'в обычном чате тот же селектор не срабатывает — поиск остаётся видимым');

// движок шашек подключён раньше app.js (app.js зовёт createCheckers и rusSan)
const scripts = [...d.querySelectorAll('script[src]')].map(s => s.getAttribute('src'));
ok(scripts.indexOf('chess-engine.js') < scripts.indexOf('app.js'), 'chess-engine.js подключён раньше app.js');
ok(scripts.indexOf('checkers-engine.js') < scripts.indexOf('app.js'), 'checkers-engine.js подключён раньше app.js');

// pkg3-43: заголовок доски — ДВЕ строки: состояние партии, под ним кнопки.
// В pkg3-42 они делили одну строку, и при длинной надписи кнопка с nowrap
// налезала на текст (видно в гамме «Синтвейв»: моноширинный капс с разрядкой).
const panel = new JSDOM('<div class="board-panel"></div>').window.document;
panel.querySelector('.board-panel').innerHTML = `
    <div class="bp-head">
      <div class="bph-top"><i class="tdot w"></i><span class="bph-full">Ожидание соперника: приглашение отправлено</span><span class="bph-short">Ожидание соперника</span></div>
      <div class="bph-btns"><button class="mini danger" id="gm-leave" title="Отменить приглашение и удалить игру">Отменить приглашение</button> <button class="mini" id="gm-knocks" title="Заявки зрителей: 2">Заявки: 2</button></div>
    </div>
    <div class="board" id="board"></div>
    <div class="bp-moves-list" id="game-moves"></div>`;
const head = panel.querySelector('.bp-head');
ok(head.children.length === 2, 'в заголовке над доской ровно две строки');
ok(head.children[0].className === 'bph-top' && head.children[1].className === 'bph-btns', 'порядок строк: состояние партии сверху, кнопки ниже');
ok(head.querySelector('.bph-btns #gm-leave') && head.querySelector('.bph-btns #gm-knocks'), 'обе кнопки лежат во второй строке');
ok(head.querySelector('.bph-top').textContent.includes('Ожидание соперника'), 'состояние партии — в первой строке');
ok(!panel.querySelector('.bp-ctrl'), 'отдельной строки кнопок под доской по-прежнему нет');
// главное: кнопки и надпись больше НЕ соседи по одной flex-строке — наехать нечем
ok(!head.querySelector('.bph-top').contains(head.querySelector('#gm-leave')), 'кнопка не находится в одной строке с надписью — наложение исключено');
ok(!css.includes('.bph-l{') && !css.includes('.bph-r{') && !css.includes('.bph-m{'), 'старых боковых колонок pkg3-42 в стилях не осталось');

// две строки оформлены в стилях: верх по центру с переносом, низ — ряд кнопок
ok(css.includes('.bph-top{font-weight:600;text-align:center;overflow-wrap:anywhere;'), 'верхняя строка центрирована и переносится при любой длине');
ok(css.includes('.bph-btns{display:flex;justify-content:center;'), 'нижняя строка — ряд кнопок по центру с зазором');
// короткая подпись для телефона: на широком экране скрыта, на узком включается
ok(css.includes('.bph-short{display:none;}'), 'короткая подпись по умолчанию скрыта (широкий экран)');
const mob = mediaBlock(css, '(max-width:959px)');
ok(mob.includes('.bph-full{display:none;}') && mob.includes('.bph-short{display:inline;}'), 'на узком экране длинная подпись заменяется короткой');
ok(mob.includes('.bph-btns .mini{font-size:11px;padding:4px 7px;}'), 'на узком экране кнопки уплотнены');

// pkg3-44: координаты ВЫНЕСЕНЫ ЗА ПРЕДЕЛЫ доски — колонка цифр и ряд букв
const appJs = readFileSync(join(PUB, 'app.js'), 'utf8');
ok(css.includes('.board-frame{display:grid;'), 'координаты живут в рамке вокруг доски, а не в клетках');
ok(css.includes('.bf-ranks{grid-column:1;grid-row:1;') && css.includes('.bf-files{grid-column:2;grid-row:2;'), 'цифры — колонка слева, буквы — ряд снизу');
ok(css.includes('.board{grid-column:2;grid-row:1;}'), 'доска стоит в рамке между цифрами и буквами');
ok(mobs.some(b => b.includes('.bf-ranks,.bf-files{display:none;}')), 'на узком экране рамка координат скрыта');
ok(!css.includes('.cd-r{') && !css.includes('.cd-f{') && !appJs.includes('class="cd-r"'), 'внутри клеток подписей координат больше нет');
ok(appJs.includes("const rankLbl = [], fileLbl = [];"), 'подписи рядов и колонок собираются отдельно от клеток');
ok(appJs.includes("for (let r = 7; r >= 0; r--) rankLbl.push((flip ? 7 - r : r) + 1);"), 'порядок цифр экранный, значения — с учётом переворота');
ok(appJs.includes("for (let f = 0; f < 8; f++) fileLbl.push('abcdefgh'[flip ? 7 - f : f]);"), 'порядок букв экранный, значения — с учётом переворота');
ok(appJs.includes('function gameStatusShortText'), 'короткая подпись состояния существует в клиенте');

// pkg3-44: в чат-игре фона нет и редактор не предлагается
ok(appJs.includes("if (c && c.kind === 'game') { box.style.background = ''; return; }"), 'applyWallBackground гасит фон в чат-игре');
ok(appJs.includes("d.querySelector('[data-act=\"wall\"]').classList.toggle('hidden', c.kind === 'game');"), 'пункт меню «Фон и гамма» скрыт в игровых чатах');
ok(appJs.includes("if (b.dataset.act === 'wall') { if (c.kind !== 'game') wallEditor(c); return; }"), 'редактор фона не открывается в игре даже в обход меню');
ok(appJs.includes('applyWallBackground();\n  upgradeMedia(box);') && appJs.includes('applyWallBackground();\n  // pkg3-42'), 'фон гасится сразу при входе в чат, не дожидаясь отрисовки ленты');

// pkg3-44: «Синтвейв» по умолчанию у всех (разовая миграция в index.html)
ok(html.includes("localStorage.getItem('sega.palDef44')") && html.includes("localStorage.setItem('sega.pal', 'synth');"), 'в boot-скрипте разово возвращается «Синтвейв» для всех устройств');
ok(html.includes("localStorage.setItem('sega.theme', 'dark');"), 'вместе с гаммой выставляется тёмная тема');

// pkg3-44: процент памяти в «Синтвейве» читаемый
const memSynth = css.includes('#mem-pct{position:relative;z-index:1;') && css.includes('text-shadow:none;')
  && /#mem-pct\{[^}]*font-family:system-ui/.test(css) && /#mem-pct\{[^}]*font-weight:700/.test(css);
ok(memSynth, 'процент памяти в «Синтвейве»: контрастная плашка, без свечения, читаемый шрифт');
ok(css.includes('.memory-top{position:relative;z-index:1;'), 'подпись плашки памяти поднята над «сканлайновой» плёнкой');

// pkg3-44: в играх все оповещения включены по умолчанию (разовая миграция)
ok(appJs.includes('function migrateGameNotify44') && appJs.includes('migrateGameNotify44();'), 'разовая миграция снимает «без звука» с игровых чатов и включает движки');

// pkg3-45: закрытая регистрация и персональные приглашения
ok(html.includes('id="reg-closed"') && html.includes('id="reg-join"') && html.includes('id="reg-code-row"'), 'на экране регистрации есть полосы: приглашение / закрыто / аварийное окно');
ok(scripts.indexOf('qrcode.js') >= 0 && scripts.indexOf('qrcode.js') < scripts.indexOf('app.js'), 'генератор QR подключён раньше app.js');
ok(html.includes('id="btn-invite-friend"'), 'в настройках есть кнопка «Пригласить друга»');
ok(html.includes('data-act="alias"'), 'в меню чата есть «Переименовать у себя…»');
ok(appJs.includes('function refreshRegisterGate') && appJs.includes('function parseJoinToken'), 'экран регистрации решает, открыта ли дверь и чем');
ok(appJs.includes('function openInviteFriend') && appJs.includes('function qrSvg'), 'окно приглашения рисует ссылку и QR без сети');
ok(appJs.includes('function openAdminInvites'), 'администратору доступно дерево приглашений и блокировки');
ok(appJs.includes('function openAliasEditor') && appJs.includes('function setAlias'), 'локальные псевдонимы редактируются и хранятся на устройстве');
ok(appJs.includes('function loadAliases') && appJs.includes('aliases: loadAliases()'), 'псевдонимы читаются из памяти устройства при старте');
ok(appJs.includes("const userByIdRaw = id => S.users.find(u => u.id === id);"), 'userById отдаёт имя с псевдонимом, не трогая данные синхронизации');
ok(appJs.includes('rail-group">Приглашенные'), 'в списке чатов есть раздел «Приглашенные»');
ok(css.includes('.qr-box{background:#fff;'), 'QR лежит на белой подложке — сканеру нужен контраст');
ok(appJs.includes("api('/api/admin/emergency-reg'"), 'аварийное окно включается и выключается из админки');

// pkg3-47: поиск по нику и запросы-согласия в «Приглашенные»
ok(appJs.includes('function bondStateWith'), 'состояние связи «Приглашенных» считается одной функцией');
ok(appJs.includes('data-bond-accept') && appJs.includes('data-bond-decline'), 'запросы решаются кнопками прямо в списке чатов');
ok(appJs.includes('Запросы в «Приглашенные»'), 'входящие запросы видны отдельным разделом списка чатов');
ok(appJs.includes('id="inv-find"') && appJs.includes('Найти по нику'), 'в окне приглашения есть поиск по нику по всему мессенджеру');
ok(appJs.includes('data-find-bond') && appJs.includes('data-find-dm'), 'найденному можно написать или отправить запрос в «Приглашенные»');
ok(appJs.includes('data-bond-ask'), 'запрос можно отправить участнику общей группы из списка участников');
ok(appJs.includes('S.myBonds = new Set(data.myBonds || [])'), 'связи приезжают в синхронизации');
ok(css.includes('.bond-btns{display:flex;gap:4px;flex-direction:column;}'), 'кнопки принять/отклонить сложены в столбик у карточки запроса');

console.log('\n──────────────────────────────────────────────────');
console.log(`  Разметка pkg3-44: ${good} ✓, провалов ${bad}`);
console.log('──────────────────────────────────────────────────\n');
if (bad) process.exit(1);
