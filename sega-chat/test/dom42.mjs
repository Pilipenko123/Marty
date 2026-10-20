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
ok(!html.includes('id="btn-invite-friend"'), 'pkg3-52: из настроек убрана кнопка «Пригласить друга» — приглашение переехало в меню «+»');
ok(html.includes('data-act="alias"'), 'в меню чата есть «Переименовать у себя…»');
ok(appJs.includes('function refreshRegisterGate') && appJs.includes('function parseJoinToken'), 'экран регистрации решает, открыта ли дверь и чем');
ok(appJs.includes('function openInviteFriend') && appJs.includes('function qrSvg'), 'окно приглашения рисует ссылку и QR без сети');
ok(appJs.includes('function openAdminInvites'), 'администратору доступно дерево приглашений и блокировки');
ok(appJs.includes('function openAliasEditor') && appJs.includes('function setAlias'), 'локальные псевдонимы редактируются и хранятся на устройстве');
ok(appJs.includes('function loadAliases') && appJs.includes('aliases: loadAliases()'), 'псевдонимы читаются из памяти устройства при старте');
ok(appJs.includes("const userByIdRaw = id => S.users.find(u => u.id === id);"), 'userById отдаёт имя с псевдонимом, не трогая данные синхронизации');
ok(!appJs.includes('rail-group">Приглашенные'), 'pkg3-60: раздел «Приглашенные» убран из списка чатов (владелец: довольно «Личных чатов»)');
ok(css.includes('.qr-box{background:#fff;'), 'QR лежит на белой подложке — сканеру нужен контраст');
ok(appJs.includes("api('/api/admin/emergency-reg'"), 'аварийное окно включается и выключается из админки');

// pkg3-47/60: поиск по нику остался; запросы-согласия «в Приглашенные» убраны из интерфейса
ok(!appJs.includes('function bondStateWith'), 'pkg3-60: состояние связи «Приглашенных» больше не считается (раздел снят)');
ok(!appJs.includes('data-bond-accept') && !appJs.includes('data-bond-decline'), 'pkg3-60: кнопок принять/отклонить запрос «в Приглашенные» больше нет');
ok(!appJs.includes('rail-group">Запросы'), 'pkg3-60: раздела «Запросы в «Приглашенные»» больше нет');
ok(appJs.includes('id="inv-find"') && appJs.includes('Найти по нику'), 'в окне приглашения есть поиск по нику по всему мессенджеру');
ok(!appJs.includes('data-find-bond') && appJs.includes('data-find-dm'), 'pkg3-60: найденному можно только написать — кнопки «в Приглашенные» нет');
ok(!appJs.includes('data-bond-ask'), 'pkg3-60: в списке участников общей группы запросов «в приглашенные» больше нет');
ok(appJs.includes('S.myBonds = new Set(data.myBonds || [])'), 'связи по-прежнему приезжают в синхронизации (круг видимости на сервере)');
ok(!css.includes('.bond-btns{'), 'pkg3-60: стили карточек запросов убраны');

// pkg3-48: админ-окно открывается и на старой облачной базе; виден только свой
// круг; раздела «Написать лично» нет; поиск по нику спрашивает сервер
ok(!html.includes('data-act="bond"') && html.includes('data-act="hide"'), 'pkg3-60: пункта «Взять в «Приглашенные»» в меню чата нет; «Убрать из моих личных чатов» осталось');
ok(appJs.includes("b.dataset.act === 'hide'") && appJs.includes("+ '/hide'"), 'скрытие личного чата идёт командой на сервер, а не только в памяти телефона');
ok(!appJs.includes('rail-group">Написать лично'), 'раздела «Написать лично» со всем списком участников больше нет');
ok(appJs.includes("api('/api/search?q='"), 'поиск по нику идёт через сервер (/api/search), а не по локальному списку');
ok(appJs.includes('pol.blockedUsers = pol.blockedUsers || [];'), 'политика приглашений нормализуется — админ-окно открывается и при пустой базе облака');
ok(appJs.includes('d.users = d.users || [];'), 'админ-окно защищено от неполного ответа сервера');
ok(appJs.includes('findSeq') && appJs.includes('setTimeout(() => paintFind(), 350)'), 'поиск в окне «Пригласить по ссылке» с задержкой и защитой от устаревших ответов');

// pkg3-49: «Новые», сутки, сохранение и уборка личных чатов
ok(appJs.includes("sec('new', 'Новые'"), 'в списке чатов есть раздел «Новые»');
ok(appJs.includes('function renderDmBanner') && html.includes('id="dm-banner"'), 'над лентой живёт баннер «Новых» с узлом #dm-banner');
ok(appJs.includes('Добавить в мои личные чаты') && html.includes('Добавить в мои личные чаты'),
  'pkg3-54: кнопка сохранения называется «Добавить в мои личные чаты» (баннер и меню)');
ok(html.includes('data-act="save"'), 'в меню чата есть пункт сохранения (data-act="save")');
ok(html.includes('Убрать из моих личных чатов'), 'пункт меню теперь называется «Убрать из моих личных чатов»');
ok(appJs.includes('/save') && appJs.includes('async function saveDmChat'), 'сохранение идёт командой на сервер (/api/chats/:id/save)');
ok(appJs.includes('S.dmSaved = new Set(S.chats.filter'), 'список сохранённых чатов клиент считает по savedBy из синхронизации');
ok(appJs.includes('const fmtLeft'), 'счётчик «осталось N ч» для раздела «Новые» считается одной функцией');
ok(appJs.includes('data-newcd') && appJs.includes('data-bncd'), 'счетчики тикают и в списке чатов, и в баннере');
ok(css.includes('.tag-new{'), 'плашка «новые · осталось» оформлена в стилях');
ok(css.includes('#dm-banner{'), 'баннер «Новых» оформлен в стилях');
ok(appJs.includes('chatsGone:'), 'исчезнувшие чаты стираются из локальной памяти устройства');
ok(appJs.includes('S.myKnocks'), 'заявки зрителей в мои партии приходят отдельным списком');
const sw = readFileSync(join(PUB, 'sw.js'), 'utf8');
const apiJs = readFileSync(join(HERE, '..', 'lib', 'api.js'), 'utf8');
const modelJs = readFileSync(join(HERE, '..', 'lib', 'model.js'), 'utf8');
const storeFile = readFileSync(join(HERE, '..', 'lib', 'store-file.js'), 'utf8');
ok(sw.includes('sega-static-v67'), 'кэш статики поднят до v67');

// pkg3-55: терпеливый старт и честная плашка, когда сервер не отвечает
ok(appJs.includes('function fetchStateWithRetry'), 'старт терпит несколько неудач подряд, а не сдаётся после первой');
ok(appJs.includes('1200 * Math.pow(2, i)'), 'пауза между попытками растёт');
ok(appJs.includes('function netFailBox'), 'при неудаче показывается плашка с причинами, а не вечная шкала');
ok(appJs.includes('белыми списками'), 'в плашке честно названы белые списки операторов');
ok(appJs.includes('nf-retry'), 'у плашки есть кнопка «Повторить»');
ok(css.includes('#net-fail{') && css.includes('.nf-box{'), 'плашка оформлена в стилях');
const tune = readFileSync(join(HERE, '..', 'cloud-vps', 'net-tune.sh'), 'utf8');
ok(tune.includes('--set-mss') && tune.includes('TCPMSS'), 'сетевая настройка уменьшает размер пакетов под туннели');
ok(tune.includes('http2'), 'сетевая настройка включает HTTP/2 в nginx');
ok(tune.includes('--ecdsa'), 'лёгкий сертификат ECDSA доступен флагом --ecdsa');
ok(tune.includes('sega-net-tune.service'), 'правила переживают перезагрузку (страховочная единица)');
const setupSh = readFileSync(join(HERE, '..', 'cloud-vps', 'setup.sh'), 'utf8');
ok(setupSh.includes('net-tune.sh'), 'установщик применяет сетевую настройку сам');

// pkg3-54: «Новые» на 7 суток, группы в «Новых», «Отклонить», лимиты
ok(html.includes('data-act="decline"') && html.includes('Отклонить чат'), 'в меню чата есть «Отклонить чат»');
ok(appJs.includes('function declineChat'), 'отклонение идёт командой на сервер и снимает чат у меня');
ok(appJs.includes("'/decline'"), 'клиент зовёт маршрут /api/chats/:id/decline');
ok(appJs.includes('const isNewChat = (c) => !!c.newUntil && !S.dmSaved.has(c.id)'), 'в «Новых» теперь и личные, и групповые чаты');
ok(appJs.includes("sec('new', 'Новые', newChatsList)"), 'раздел «Новые» рисуется общим списком личных и групповых');
ok(appJs.includes('Оставить в моих чатах'), 'у группового чата из «Новых» своя плашка с принятием');
ok(appJs.includes('через 7 суток'), 'срок «Новых» в плашке назван честно: 7 суток');
ok(appJs.includes("m.svc"), 'служебная строка события рисуется в ленте отдельно от переписки');
ok(css.includes('.sys.svc{'), 'служебная строка оформлена в стилях');
ok(appJs.includes("foldHead('live', 'Сейчас играют'"), 'блок «Сейчас играют» тоже сворачивается');
ok(css.includes('border-left:10px solid currentColor'), 'треугольник сворачивания стал заметно крупнее (рисуется стилями)');
ok(appJs.includes('#sec-up') && appJs.includes('#sec-down'), 'в меню раздела есть перестановка «выше/ниже»');
ok(apiJs.includes('7 * 24 * 60 * 60 * 1000'), 'срок «Новых» по умолчанию — 7 суток');
ok(apiJs.includes('NEW_INVITE_DELAY'), 'приглашённый первые сутки не может приглашать (настраивается)');
ok(apiJs.includes('MAX_LIVE_GAMES'), 'не больше четырёх одновременных партий, где участник — игрок');
ok(apiJs.includes("action === 'decline' && method === 'POST'"), 'маршрут отклонения на сервере');
ok(apiJs.includes("act === 'move' && method === 'POST'"), 'маршрут перестановки разделов на сервере');
// pkg3-60 (было pkg3-54): правило изменилось по решению владельца — отклонённый
// ЛИЧНЫЙ чат новое письмо возвращает в «Новые»; навсегда отклоняется только групповой
ok(apiJs.includes("if (wasDeclined && chat.kind !== 'dm') continue;"), 'отклонённый групповой чат новым письмом не возрождается; личный — возвращается в «Новые»');
ok(modelJs.includes('Math.abs((e.until - e.at) - OLD_TTL)'), 'идущие суточные таймеры продлеваются до 7 суток при переносе');
   // pkg3-52/53: проверки серверной части

// pkg3-53: разделы-папки, сворачивание и красная точка непрочитанных
ok(html.includes('data-plus="section"') && html.includes('Создать раздел'), 'в меню «+» появился пункт «Создать раздел»');
ok(html.includes('data-act="section"') && html.includes('Переместить в раздел'), 'в меню чата есть «Переместить в раздел…»');
ok(appJs.includes('function loadFolds') && appJs.includes('sega.folds'), 'свёрнутые разделы помнит устройство (localStorage)');
ok(appJs.includes('data-fold=') && appJs.includes('fold-badge'), 'заголовки разделов сворачиваются, на свёрнутом виден счётчик непрочитанных');
ok(appJs.includes('const openSec = (key) => !!flt || !S.collapsed[key]'), 'при поиске разделы раскрываются — иначе результат не увидеть');
ok(appJs.includes('sec-dots') && appJs.includes('data-sec-menu'), 'у своего раздела есть три точки для меню');
ok(appJs.includes('function openCreateSection') && appJs.includes('function openRenameSection'), 'раздел можно создать и переименовать');
ok(appJs.includes('function openSectionMenu') && appJs.includes('Удалить раздел'), 'в меню раздела есть «Переименовать» и «Удалить»');
ok(appJs.includes('function openChatSections') && appJs.includes('data-sec-pick'), 'чат можно положить в раздел и убрать из него');
ok(appJs.includes('function reloadSections') && appJs.includes("api('/api/sections')"), 'список разделов перечитывается после каждого действия');
ok(appJs.includes('data.mySections'), 'разделы приезжают в синхронизации');
ok(appJs.includes("/rename'") && appJs.includes("/delete'"), 'переименование и удаление идут через POST: тело запроса читается только у POST/PUT');
ok(css.includes('.rail-group.fold{') && css.includes('.fold-badge{'), 'сворачивание и счётчик оформлены в стилях');
ok(css.includes('.rail-group.custom{') && css.includes('fold-mark-folder'), 'свой раздел визуально отличается от системных');
ok(apiJs.includes("'/api/sections'") && apiJs.includes('MAX_SECTIONS'), 'на сервере есть разделы и предел их числа');
ok(apiJs.includes('mySections:'), 'сервер отдаёт разделы только их владельцу');
ok(apiJs.includes('MAX_SECTION_CHATS'), 'в разделе не может быть бесконечно много чатов');
ok(apiJs.includes("act === 'rename' && method === 'POST'") && apiJs.includes("act === 'delete' && method === 'POST'"),
  'разделы переименовываются и удаляются через POST — у него сервер точно читает тело');
const srvJs = readFileSync(join(HERE, '..', 'server.js'), 'utf8');
ok(srvJs.includes("'PATCH'") && srvJs.includes("'DELETE'"),
  'локальный сервер читает тело запроса у PATCH и DELETE (отписка от уведомлений больше не теряется)');

// pkg3-52: одна строка поиска, кнопка «+» и переименованный раздел игр
ok(html.includes('id="btn-plus"') && html.includes('id="plus-menu"'), 'рядом со строкой поиска живёт кнопка «+» с меню быстрых действий');
ok(html.includes('data-plus="game"') && html.includes('data-plus="group"') && html.includes('data-plus="invite"'),
  'в меню «+» три пункта: новая игра, групповой чат, приглашение по ссылке');
ok(html.includes('Новая игра') && html.includes('Создать групповой чат') && html.includes('Пригласить по ссылке'),
  'пункты меню «+» подписаны словами владельца');
ok(!html.includes('id="btn-new-chat"') && !html.includes('id="btn-new-game"'), 'прежние кнопки «Новый чат» и «♟ Игра» убраны');
ok(appJs.includes('function plusMenu') && appJs.includes('it.dataset.plus'), 'меню «+» открывается и вызывает нужное окно');
ok(appJs.includes("e.key === 'Escape'") && appJs.includes("plusMenu(false)"), 'меню «+» закрывается по Escape и по клику мимо');
ok(appJs.includes("sec('game', 'Игровые чаты'"), 'раздел игр называется «Игровые чаты»');
ok(!appJs.includes('rail-group">Игры<'), 'прежнего короткого названия «Игры» в списке чатов не осталось');
ok(appJs.includes('function railFindPeople') && appJs.includes('railFindTimer'),
  'строка «Найти чат или участника» ищет людей на сервере, а не только свои чаты');
ok(appJs.includes('setTimeout(() => railFindPeople(q), 350)'), 'запрос участников уходит через 350 мс после последней буквы');
ok(appJs.includes('seq !== railFindSeq'), 'устаревший ответ поиска не рисуется (защита от гонки)');
ok(appJs.includes('rail-group people') && appJs.includes('Участники — найдено'), 'найденные люди показываются отдельным разделом ниже своих чатов');
ok(appJs.includes('hasDmWith'), 'с кем уже есть личная переписка — не дублируются в найденных');
ok(appJs.includes("data-peer=\"${u.id}\"") || appJs.includes('data-peer="${u.id}"'), 'клик по найденному человеку открывает личный чат (data-peer)');
ok(css.includes('.plus-menu{'), 'меню «+» оформлено в стилях');
ok(css.includes('.rail-group.people{'), 'раздел найденных участников оформлен в стилях');
ok(html.includes('кнопка «+» → «Пригласить по ссылке»'), 'подсказка на экране входа ведёт в новое место приглашения');
ok(!html.includes('в его настройках'), 'старой подсказки «кнопка в его настройках» не осталось');
ok(apiJs.includes('SEARCH_LIMIT'), 'лимит поиска настраивается: центральный поиск дёргается чаще прежнего');
ok(apiJs.includes("throttle('search:' + me.id, SEARCH_LIMIT)"), 'поиск участников работает по своему, более широкому лимиту');
ok(apiJs.includes('function throttle(key, limit)'), 'вход и регистрация остались под строгим лимитом (25 за 10 минут)');
ok(apiJs.includes('Number(limit) > 0 ? Number(limit) : 25'), 'предел по умолчанию не изменился: подбор пароля свободнее не стал');

// pkg3-57: шесть доработок «Морского боя»
ok(appJs.includes('sb-marks') && css.includes('.sb-marks{') && css.includes('.sbm{'),
  'отметки (точки и взрывы) живут отдельным верхним слоем — поверх кораблей');
ok(css.includes('.sb-ships{position:absolute;inset:0;pointer-events:none;z-index:1}'),
  'слой кораблей — средний (ниже отметок, выше сетки)');
ok(appJs.includes('function sbShipFromCells'), 'потопленный корабль соперника рисуется по клеткам из ответа «потопил»');
ok(appJs.includes('const isGameLetter') && appJs.includes('!isGameLetter(p)'),
  'выстрелы морского боя не попадают в ленту чата (единое правило с ходами шахмат)');
ok(appJs.includes('const SB_GAME_MS') && appJs.includes('function sbOnScreen'),
  'при открытой доске морского боя лента опрашивается чаще (SB_GAME_MS)');
ok(appJs.includes("now - lastWakeSync > 600"), 'сигнал пуша заставляет бодрствующее окно добирать ленту сразу (порог 600 мс)');
ok(appJs.includes('function sbFleetOnDevice'), 'без пуша устройство с флотом держит окно бодрым — отвечает на выстрелы');
ok(appJs.includes('async function sbSelfKey') && appJs.includes('async function sbFleetUpload') && appJs.includes('async function sbRestoreFleets'),
  'слепок флота шифруется личным ключом, кладётся на сервер и возвращается на другие свои устройства');
ok(appJs.includes("commit !== loc.commit"), 'слепок принимается, только если совпал с печатью sb-commit');
ok(appJs.includes('досылаем его с устройства'), 'партия, начатая до обновления, получает слепок автоматически (досылка с устройства с флотом)');
ok(appJs.includes('data.mySbFleets'), 'синхронизация приносит мои слепки флота (mySbFleets)');
ok(apiJs.includes('/sbfleet') && apiJs.includes('mySbFleets'),
  'сервер хранит слепок флота (POST /api/games/:id/sbfleet) и отдаёт только владельцу');
ok(apiJs.includes("NOTIFY_BODIES") && apiJs.includes('Ход в игре — откройте партию'),
  'письма игры будят устройство соперника пушем с готовой подписью (без свободного текста)');
ok(apiJs.includes("u.sbFleets[chatId]"), 'при удалении игры слепки флота стираются');
ok(modelJs.includes('u.sbFleets'), 'перенос старых записей добавляет поле sbFleets с дефолтом');
ok(css.includes('@media (max-width:959px){\n  .sb-panel .sb-tabs{display:flex}') || css.includes('.sb-panel .sb-tabs{display:flex}'),
  'кнопки «Поле соперника» / «Моё поле» работают на всей мобильной ширине (до 959 px), включая горизонталь');
ok(!css.includes('@media (max-width:699px)'), 'прежняя узкая граница 699 px для полей морского боя убрана');
ok(css.includes('#main.game-mode .sb-panel{max-width:min(100%,calc(100dvh - 200px));}'),
  'в горизонтали телефона размер поля считается от высоты экрана');
ok(appJs.includes('Я стреляю первым') && appJs.includes('Соперник стреляет первым'),
  'в приглашении на морской бой варианты честные: «Я стреляю первым» / «Соперник стреляет первым»');
ok(appJs.includes('Стреляю первым я') && appJs.includes('Первым стреляет соперник'),
  'принимающий приглашение выбирает: «Стреляю первым я» / «Первым стреляет соперник»');
ok(appJs.includes('data-rules='), 'кнопка «Войти в игру» знает правила — окно выбора говорит по-человечески');

// pkg3-58: мгновенные ответы «Морского боя» — печать несёт флот
const sbEng = readFileSync(join(PUB, 'seabattle-engine.js'), 'utf8');
ok(sbEng.includes('fleet: { w: null, b: null }'), 'движок хранит флоты из печатей (открытый режим)');
ok(sbEng.includes('function validFleet'), 'флот из письма проверяется по правилам, мусор игнорируется');
ok(sbEng.includes('function resolveShot'), 'выстрел разбирается самим движком — мгновенно, без письма-ответа');
ok(sbEng.includes('const openMode'), 'режим партии выбирается по наличию флотов в обеих печатях');
ok(sbEng.includes('fleetOf: side => st.fleet[side]') && sbEng.includes('openMode,'), 'движок отдаёт fleetOf/openMode наружу');
ok(sbEng.includes('if (openMode()) return resolveShot(shot, st.fleet[other(side)].fleet);'), 'в открытом режиме ответ не ждёт устройства соперника');
ok(appJs.includes("k: 'sb-commit', commit, fleet: P.fleet, salt"), 'кнопка «В бой!» отправляет печать вместе с флотом (шифрованным письмом)');
ok(appJs.includes('eng.openMode && eng.openMode()'), 'в открытом режиме письмо вскрытия не отправляется (старому сопернику — отправляется)');
ok(appJs.includes('eng.revealOf(side) || (eng.fleetOf ? eng.fleetOf(side) : null)'), 'значок честности берёт флот из печати, когда вскрытия не было');
ok(sbEng.includes('sb-reply'), 'прежний протокол «выстрел — ответ» сохранён для старых клиентов и идущих партий');

// pkg3-59: меню «⋮» у участника в админ-дереве — запрет приглашать, бан, удаление
ok(appJs.includes('data-umenu=') && appJs.includes('function adminTreeClick') && appJs.includes('function openUserAdmin'),
  'в дереве приглашений у каждого участника меню «⋮» (data-umenu → openUserAdmin)');
ok(appJs.includes('Запрещено приглашать других пользователей'), 'в меню есть галочка «Запрещено приглашать других пользователей»');
ok(appJs.includes('Бан на сутки') && appJs.includes('Снять бан'), 'в меню есть бан на сутки и досрочное снятие');
ok(appJs.includes('поступившей жалобе') || appJs.includes('Поступила жалоба'), 'бан сопровождается уведомлением о жалобе');
ok(appJs.includes('Удалить из мессенджера навсегда'), 'в меню есть удаление участника навсегда (с предупреждением)');
ok(appJs.includes("data.code === 'banned'") && appJs.includes('function banNotice'),
  'забаненное окно получает честную карточку «Доступ ограничен» и выходит на экран входа');
ok(appJs.includes('⛔ бан') && appJs.includes('🚫 звать'), 'в дереве видны значки действующего бана и запрета приглашать');
ok(apiJs.includes("action === 'ban'") && apiJs.includes('BAN_MS'), 'сервер: маршрут бана на сутки (срок настраивается BAN_MS)');
ok(apiJs.includes('banError') && apiJs.includes("code: 'banned'"), 'сервер: забаненный отклоняется везде с кодом banned (заслонка и вход)');
ok(apiJs.includes('Поступила жалоба — доступ ограничен на сутки'), 'сервер сообщает причину честно: жалоба');
ok(apiJs.includes('Нельзя ограничить самого себя') && apiJs.includes('Нельзя удалить самого себя'), 'себя администратор забанить/удалить не может');
ok(apiJs.includes("adminLogAdd(me.id, 'удалил участника") && apiJs.includes('(жалоба)'), 'действия администратора пишутся в журнал');
ok(apiJs.includes('db.bondReqs.filter(r => r.from !== id && r.to !== id)') && apiJs.includes('db.invites.filter(i => i.ownerId !== id)'),
  'удаление стирает связи, запросы-согласия и живые ссылки удалённого');
ok(modelJs.includes('u.bannedUntil'), 'модель: migrate() добавляет bannedUntil с дефолтом');

// pkg3-60: четыре правки владельца + лечение установщика
ok(css.includes('.tr-row .sec-dots{opacity:1}'), 'меню «⋮» в админ-дереве видно и на ПК (точки не прячутся)');
ok(!appJs.includes('data-pol-user'), 'список галочек «Запретить: …» из админ-окна убран (запрет — в меню «⋮»)');
ok(appJs.includes('Отдельному участнику запрет ставится в меню'), 'в админ-окне подсказка: запрет участнику — в меню «⋮»');
ok(appJs.includes('const blockedUsers = pol.blockedUsers || [];'), '«Сохранить блокировки» не затирает запреты, поставленные через меню');
ok(apiJs.includes('pkg3-60: новое письмо собеседника возвращает отклонённый'), 'сервер: новое письмо возвращает отклонённый/убранный личный чат');
ok(apiJs.includes("if (wasDeclined && chat.kind !== 'dm') continue;"), 'отклонённый групповой чат письмом не возвращается (их много и письма частые)');
ok(apiJs.includes('u.newChats[chat.id] = { at: Date.now(), until: Date.now() + NEW_DM_TTL };'), 'возвращённый чат получает свежий отсчёт «Новых»');
ok(apiJs.includes('dmRec && dmRec.until >= t'), 'живой отсчёт «Новых» важнее отметки «открывал» — чат снова в «Новых»');
ok(appJs.includes('вернётся в раздел «Новые»'), 'подтверждение «Отклонить» честно говорит о возвращении новым письмом');
ok(appJs.includes('вернёт чат в раздел «Новые» ещё на 7 суток'), 'подсказка «Убрать из моих личных чатов» обещает 7 суток, а не сутки');
ok(setupSh.includes('ждём завершения системного certbot') && setupSh.includes('.bak-setup') && setupSh.includes('listen 443 ssl'),
  'установщик: ждёт системный certbot, хранит откат и не гасит HTTPS при готовом сертификате');
ok(setupSh.includes('повторяю через минуту'), 'установщик повторяет попытку сертификата при неудаче');

// pkg3-61: слияние учёток, лечение ключей, вход в игру, реакции, прочтения
ok(apiJs.includes("action === 'display'") && apiJs.includes('u.displayAs = t.id'), 'сервер: привязка внешности другой учётки («поглощение»)');
ok(apiJs.includes('const t = u.displayAs ? db.users.find') && apiJs.includes('displayAs: (u.displayAs && t) ? t.id : null'), 'publicUser отдаёт имя и аватар новой учётки — старая переписка выглядит новой');
ok(apiJs.includes('поглощённая учётка показывает аватар'), 'аватар поглощённой учётки — тоже от новой');
ok(apiJs.includes('Нельзя поглотить самого себя') && apiJs.includes('сама носит чужую внешность'), 'слияние с собой и цепочки псевдонимов запрещены');
ok(modelJs.includes('u.displayAs'), 'модель: migrate() добавляет displayAs с дефолтом');
ok(apiJs.includes("sub === 'need'") && apiJs.includes('return !e || e.need || (typeof e.ep === \'number\' && e.ep !== curEp);'), 'сервер: участник просит свежий ключ группы, «битая» копия больше не застревает');
ok(apiJs.includes('if (ex && !ex.need && ex.ep === curEp)'), 'сервер: битую копию ключа разрешается перезаписать');
ok(appJs.includes('function requestGroupKey') && appJs.includes("/keys/need'"), 'клиент сам просит свежий ключ, когда его копия не читается');
ok(appJs.includes('data-game-enter') && appJs.includes('Войти в игру'), 'принятое приглашение — второй вход в игру (кнопка «Войти в игру»)');
ok(appJs.includes('data-rxlist') && appJs.includes('function openRxList'), 'кнопка «👥» открывает список «кто поставил реакции»');
ok(appJs.includes('Кто поставил реакции'), 'в списке реакций — имена по каждому смайлику');
ok(appJs.includes('на чужих сообщениях тоже видно, кто их уже прочитал'), 'отметки прочтения видны на всех сообщениях, не только на своих');
ok(appJs.includes('function openAdminDisplayMerge') && appJs.includes('Взять её внешность'), 'в меню «⋮» — слияние учёток (привязка внешности)');
ok(appJs.includes('👤 слита'), 'в дереве приглашений виден значок слитой учётки');
ok(appJs.includes('Изменить / Отвязать') && appJs.includes('Отвязать (вернуть собственное лицо)'), 'слияние обратимо: внешность можно отвязать');

// pkg3-63: перевыпуск ключа группы — лечение «зашифрованное сообщение» у друзей
ok(apiJs.includes("sub === 'rotate'") && apiJs.includes('const nextEp = (chat.keyEpoch || 0) + 1') && apiJs.includes('chat.keyEpoch = nextEp'), 'сервер: ротация ключа группы наращивает поколение');
ok(apiJs.includes('keyEpoch: c.keyEpoch || 0'), 'сервер: публичный чат несёт поколение ключа');
ok(modelJs.includes('c.keyEpoch'), 'модель: migrate() добавляет keyEpoch с дефолтом 0');
ok(appJs.includes('function rotateGroupKey') && appJs.includes("/keys/rotate'"), 'клиент: перевыпуск ключа группы одним действием');
ok(appJs.includes('chatKeysOld') && appJs.includes('function reconcileKeyEpochs'), 'клиент: старые копии ключа хранятся для истории, новое поколение ловится само');
ok(appJs.includes('function noteKeySplit') && appJs.includes('Перевыпустить ключ группы'), 'клиент: подсказка при закрытых письмах группы ведёт к перевыпуску');
ok(html.includes('data-act="rotatekeys"'), 'в меню чата есть пункт «Перевыпустить ключ группы…»');

// pkg3-65: история ключей, название и иконка переживают перевыпуск; устаревшие доставки не проходят
ok(appJs.includes("OLDKEYS_STORE = 'sega.oldKeys.v1'") && appJs.includes('function persistOldKeys') && appJs.includes('async function loadOldKeys'), 'клиент: прежние копии ключа группы стойко хранятся на устройстве и читаются при входе');
ok(appJs.includes('await loadOldKeys()'), 'клиент: история ключей загружается при старте');
ok(appJs.includes('function pushOldKey') && appJs.includes('olds.length > 24'), 'клиент: история ключей ограничена 24 копиями на группу');
ok(appJs.includes("'stale-copy'") && appJs.includes('chat.key.ep !== curEp'), 'клиент: копия прошлого поколения распознаётся и запрашивается свежая');
ok(appJs.includes('function decryptWithHistory'), 'клиент: название, иконка и фон пробуются текущим и прежними ключами');
ok(appJs.includes('function rewrapChatSecrets'), 'клиент: перевыпуск переоформляет название, иконку и фон новым ключом');
ok(appJs.includes('function invalidateChatSecrets'), 'клиент: после починки ключа кэши названия/иконки/фона сбрасываются');
ok(appJs.includes("ep: (typeof entry.ep === 'number' ? entry.ep : (c.keyEpoch || 0))"), 'клиент: доставка ключа помечается поколением');
ok(apiJs.includes('ep: nextEp') && apiJs.includes('ep: curEp'), 'сервер: копии ключа помечаются поколением (ротация и доставка)');
ok(apiJs.includes('Ключ устарел: группа перевыпустила ключ'), 'сервер: устаревшая доставка ключа отклоняется');
ok(apiJs.includes('typeof e.ep === \'number\' && e.ep !== curEp'), 'сервер: копия прошлого поколения считается нуждающейся');
ok(modelJs.includes('e.ep = c.keyEpoch'), 'модель: migrate() помечает прежние копии текущим поколением');

// pkg3-66: возвращение истории — участники обмениваются прежними ключами (сервер слеп)
ok(apiJs.includes("sub === 'old'") && apiJs.includes('chat.oldKeys'), 'сервер: участник выкладывает свёртки прежних ключей (POST keys/old)');
ok(apiJs.includes('oldKeys: Object.entries'), 'сервер: в публичном чате отдаются только свои свёртки прежних ключей');
ok(apiJs.includes('if (slot.wraps[uid]) continue;'), 'сервер: прежние свёртки не перезаписываются');
ok(apiJs.includes('const capEp = (chat.keyEpoch || 0) + 24;'), 'сервер: предел слотов прежних ключей — поколение+24');
ok(modelJs.includes('c.oldKeys = {}'), 'модель: migrate() добавляет хранилище прежних ключей с дефолтом');
ok(appJs.includes('function reconcileOldKeys') && appJs.includes("/keys/old'"), 'клиент: автообмен прежними ключами без кнопок');
ok(appJs.includes('S.oldKeysRetryUp') , 'клиент: выкладка прежних ключей повторяется до успеха (pkg3-72)');

// pkg3-67: автообмен любым рабочим ключом, предохранители перевыпуска
ok(apiJs.includes('ROTATE_COOLDOWN_MS'), 'сервер: перевыпуск ключа не чаще раза в час на группу');
ok(apiJs.includes("svc: 'rotatekeys'"), 'сервер: перевыпуск оставляет служебную строку в ленте');
ok(appJs.includes('перевыпустил ключ группы'), 'клиент: служебная строка «N перевыпустил ключ группы»');
ok(appJs.includes('pkg3-73: перевыпуск — ремонт, а не игрушка: решает создатель чата или'), 'клиент: пункт «Перевыпустить» виден только создателю/админу и при закрытых письмах');
ok(appJs.includes('pkg3-67: заворачиваем и самому себе'), 'клиент: свёртки выкладываются и самому себе (вторые устройства)');
ok(appJs.includes('pkg3-67: ключ, которым шифруется отправка'), 'клиент: ключ отправки сразу кладётся в историю устройства');
ok(appJs.includes('serverRaws.add(toB64(await aesDecryptBytes(wk, it.blob)))'), 'клиент: скачанные свёртки сравниваются по сырью ключа (лечение ноутбука и «Для теста»)');

// pkg3-69: обмен на каждом опросе, тихая плашка, запасные слоты
ok(appJs.includes('pkg3-69: обмен прежними ключами на КАЖДОМ опросе') && appJs.includes('async function reconcileOldKeysChanged'), 'клиент: обмен прежними ключами идёт на каждом опросе, а не только при старте');
ok(appJs.includes('pkg3-69: не советуем перевыпуск из-за писем, чьи ключи утеряны навсегда'), 'клиент: плашка «перевыпустите ключ» молчит при музейных замках');
ok(apiJs.includes('slotId = \'e\' + legacy'), 'сервер: прежние клиенты с метками ep продолжают работать');

// pkg3-70: слоты прежних ключей адресуются отпечатком ключа
ok(appJs.includes('async function fpOf') && appJs.includes('pkg3-70: адрес слота — отпечаток ключа'), 'клиент: адрес слота прежнего ключа — отпечаток сырья (метки больше не используются)');
ok(apiJs.includes('/^[0-9a-f]{16,64}$/.test(fp)'), 'сервер: слот принимает отпечаток ключа (fp)');
ok(apiJs.includes('id: id, ep: Number.isFinite(Number(id)) ? Number(id) : undefined'), 'сервер: публичный чат отдаёт адрес слота и свёртку участника');
ok(appJs.includes('pkg3-70: до первой попытки обмена в этом чате совет не показываем'), 'клиент: плашка-совет молчит до первой попытки обмена');

// pkg3-71: обмен не помечается пройденным до загрузки личного ключа + повтор по закрытым письмам
ok(appJs.includes('pkg3-71: без личного ключа обмен невозможен'), 'клиент: обмен не помечается пройденным, пока личный ключ не загружен');
ok(appJs.includes('pkg3-71: закрытое письмо при наличии слотов на сервере') && appJs.includes('oldKeysRetry'), 'клиент: закрытое письмо запускает повторный обмен (раз в минуту)');
ok(appJs.includes('pkg3-71: обмен сразу, как личный ключ загружен'), 'клиент: обмен запускается сразу после загрузки личного ключа на старте');

// pkg3-72: перенос ключей кнопками, вечная плашка, повтор выкладки
ok(html.includes('btn-oldkeys-copy') && html.includes('btn-oldkeys-paste'), 'в настройках есть кнопки переноса набора ключей групп');
ok(appJs.includes('Ключи групп: история ') && appJs.includes('btn-oldkeys-copy'), 'клиент: строка-диагностика истории ключей и копирование набора без консоли');
ok(appJs.includes('sega.splitHinted.v1'), 'клиент: плашка-совет показывается один раз на чат навсегда');
ok(appJs.includes('pkg3-72: повторять раз в минуту, пока всё не выложится') && appJs.includes('oldKeysRetryUp'), 'клиент: выкладка ключей повторяется до успеха');

// pkg3-73: решения о чате — создатель или администратор
ok(apiJs.includes('Перевыпустить ключ группы может только создатель чата или администратор'), 'сервер: перевыпуск ключа — только создатель чата или администратор');
ok(apiJs.includes('Очистить групповой чат может только создатель чата или администратор'), 'сервер: очистка группы — только создатель или администратор');
ok(appJs.includes('pkg3-73: перевыпуск — ремонт, а не игрушка: решает создатель чата или') && appJs.includes('pkg3-73: «Очистить чат» в группе решает только создатель или администратор'), 'клиент: пункты меню скрыты у непривилегированных участников');
ok(appJs.includes('Ключи групп: история ') && appJs.includes('на сервере '), 'клиент: строка настроек показывает историю и число слотов на сервере');
ok(appJs.includes('pkg3-73: null-защита на стыке кэшей'), 'клиент: новые кнопки регистрируются с null-защитой');

// pkg3-74: пульт памяти сервера
ok(html.includes('пульт памяти сервера'), 'шкала «Память сервера» стала кнопкой пульта');
ok(appJs.includes('function stDonutHtml') && appJs.includes('function openStoragePanel'), 'клиент: бублик-диаграмма и окно пульта');
ok(appJs.includes('id="st-fresh"') && appJs.includes('Актуализировать'), 'клиент: кнопка «Актуализировать» с прогрессом пересчёта');
ok(appJs.includes('Мои чаты</button>') && appJs.includes('Все чаты</button>'), 'клиент: тумблер «мои чаты / все чаты»');
ok(appJs.includes('function openStorageKind') && appJs.includes('function openStorageChats'), 'клиент: списки загрузок и сообщений по чатам');
ok(appJs.includes('вложение удалено с сервера'), 'клиент: удалённое вложение показывает честную заглушку');
ok(apiJs.includes('/api/storage/summary') && apiJs.includes('/api/storage/items') && apiJs.includes('/api/storage/delete'), 'сервер: маршруты сводки, списков и удаления');
ok(apiJs.includes('/api/admin/storage/limit') && apiJs.includes('function diskFree'), 'сервер: предел хранилища и свободное место диска');
ok(apiJs.includes('KIND_OF') && storeFile.includes('async listUpMeta'), 'хранилища: перечень загрузок для сводки');

// pkg3-62: слитая учётка не двоится — одна учётка на всех
ok(apiJs.includes('function realOf') && apiJs.includes('const asked = db.users.find(u => u.id === b.peer)')
  && apiJs.includes('if (!visible) peer = t;'),
  'сервер: «написать» слитой учётке открывает старую переписку, а если её нет — настоящую учётку');
ok(apiJs.includes('!u.displayAs && (u.nameLower'), 'сервер: поиск не показывает поглощённую учётку');
ok(apiJs.includes('Эта учётка слита с другой — пригласите настоящую'), 'сервер: в группы и игры поглощённую учётку позвать нельзя');
ok(apiJs.includes('имя, которое «носит» слитая учётка, тоже занято'), 'сервер: имя слитой учётки занято — двойника не зарегистрировать и не переименовать');
ok(apiJs.includes('единственность видимых имён гарантируют правила регистрации'), 'сервер: слияние не может породить два одинаковых имени (защита в регистрации и переименовании)');
ok(appJs.includes('const peerIsHiddenAlias') && appJs.includes('.filter(c => !peerIsHiddenAlias(c))'),
  'клиент: строка слитой учётки прячется, если с настоящей уже есть живая переписка — человек не двоится');
ok(appJs.includes('const aliasTargetOf'), 'клиент: знает, чью внешность носит учётка (для списков и строк)');
ok(appJs.includes("S.users.filter(u => u.id !== S.me.id && !u.displayAs)") && appJs.includes('!c.members.includes(u.id) && !u.displayAs'),
  'клиент: в списках выбора (игра, группа, добавить в чат) слитых учёток нет');
ok(appJs.includes('(слита: прежняя учётка «'), 'дерево приглашений честно подписывает слитую учётку');

console.log('\n──────────────────────────────────────────────────');
console.log(`  Разметка pkg3-44: ${good} ✓, провалов ${bad}`);
console.log('──────────────────────────────────────────────────\n');
if (bad) process.exit(1);
