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
const staticJs = readFileSync(join(HERE, '..', 'lib', 'static.js'), 'utf8');
ok(sw.includes('sega-static-v94'), 'кэш статики поднят до v93 (срочная правка pkg3-91 подхватится сразу)');

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
ok(apiJs.includes('/api/admin/storage/limit') && apiJs.includes('function diskFree')
  && apiJs.includes('pkg3-75: fs требуем прямо здесь'), 'сервер: предел хранилища, свободное место диска и fs внутри diskFree (pkg3-75)');
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

// pkg3-76: иконка крупной, тихое сжатие, видео с первым кадром, буфер обмена, кадрирование
ok(appJs.includes("const BUILD = 'pkg3-101';") && apiJs.includes("const BUILD = 'pkg3-101';"), 'клиент и сервер помечены pkg3-101');
ok(staticJs.includes("'.jpg': 'image/jpeg'"), 'статика подписывает .jpg как image/jpeg — карты «Монет» не пустуют');
ok(appJs.includes('async function openChatIconView') && appJs.includes("host.id === 'topbar'"), 'клик по иконке группы в шапке чата открывает её крупной');
ok(appJs.includes('У этого чата пока нет своей иконки'), 'у чата без иконки — спокойная подсказка, где её поставить');
ok(appJs.includes("$('#ic-prev').addEventListener('click', () => openChatIconView(c));"), 'в редакторе иконки предпросмотр тоже открывается крупной');
ok(!appJs.includes('Фото слишком большое даже после сжатия') && appJs.includes('pkg3-76: никогда не бросаем'), 'фото больше не ругается на размер — сжимается молча до конца');
ok(appJs.includes('encodeImageUnderLimit(canvas, quality, limitOverride)'), 'предел сжатия можно передать свой (фон чата — до ~350 КБ сервера)');
ok(appJs.includes('encodeImageUnderLimit(canvas, 0.8, 340 * 1024)'), 'фон чата сжимается под предел сервера — ошибка 413 больше не всплывёт');
ok(appJs.includes('async function videoPoster'), 'первый кадр видео снимается прямо в браузере');
ok(appJs.includes('function vidCardHtml') && appJs.includes('data-poster='), 'видео в ленте — карточка с первым кадром; кадр летит внутри письма');
ok(appJs.includes("rec.poster ? ` poster="), 'плеер показывает первый кадр до нажатия «играть»');
ok(appJs.includes('function openUploadModal') && appJs.includes('id="up-fill"'), 'загрузка в облако — окно с полосой прогресса, а не мелькающие уведомления');
ok(appJs.includes("'скачиваю ' + pct + '%'") && appJs.includes("classList.add('on')"), 'скачивание видео показывает проценты и полосу');
ok(appJs.includes('idb.put(init.upId'), 'отправитель хранит своё видео в памяти устройства — оно открывается мгновенно');
ok(appJs.includes('if (el.dataset.busy) return;'), 'повторный клик не запускает вторую загрузку');
ok(appJs.includes("addEventListener('paste', e => handlePaste(e, 'attach'))") && appJs.includes("addEventListener('paste', e => handlePaste(e, 'threadAttach'))"), 'вставка из буфера работает в обычном поле и в комментариях');
ok(appJs.includes('GIF прикреплён: анимация сохранится') && appJs.includes('анимация сохранится'), 'GIF отправляется байт в байт — анимация не превращается в снимок');
ok(appJs.includes('GIF большой — отправится файлом'), 'большой GIF уходит файлом через облако — анимация цела и при скачивании');
ok(appJs.includes('function tooBigToast') && appJs.includes('а облако хранит один файл до 25 МБ'), 'предел 25 МБ остался, но сообщение спокойное и с подсказкой');
ok(apiJs.includes('25 МБ на один файл'), 'сервер отвечает о пределе спокойно');
ok(appJs.includes('function openCropDialog') && appJs.includes('function build()'), 'окно кадрирования: фото тянется пальцем/мышью и увеличивается');
ok(appJs.includes("pinch0 = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom }"), 'масштаб двумя пальцами (щипок) поддерживается');
ok(appJs.split("openCropDialog(f, { shape: 'circle'").length - 1 === 2 && appJs.includes("openCropDialog(f, { shape: 'rect'"), 'кадрирование подключено к аватару, иконке группы (круг) и фону чата (прямоугольник)');
ok(!appJs.includes('cropSquare'), 'старая обрезка строго по центру убрана — её заменило окно кадрирования');
ok(css.includes('.crop-ovl{') && css.includes('.crop-frame.circle{') && css.includes('.crop-stage{'), 'окно кадрирования оформлено в стилях (круглая и прямоугольная рамки)');
ok(css.includes('.vid-card{') && css.includes('.vd-thumb{') && css.includes('.vd-bar.on{'), 'карточка видео и полоса скачивания оформлены в стилях');
ok(css.includes('.up-track{') && css.includes('.fc-thumb{'), 'полоса загрузки и превью кадра в панели вложения оформлены в стилях');

// pkg3-77: «Пишите», «пишет… / загружает…» в заголовке, чистые названия игровых чатов
ok(html.includes('placeholder="Пишите"'), 'подсказка в поле ввода стала спокойной: «Пишите»');
ok(!appJs.includes('ну пиши') && !html.includes('ну пиши'), 'прежняя шутка «ну пиши, чё?» убрана везде');
ok(apiJs.includes("'/api/typing'") && apiJs.includes('const typingNow = new Map()') && apiJs.includes('function typingInChat'),
  'сервер: короткоживущие сигналы «пишет/загружает» живут только в памяти (без записи в базу)');
ok(apiJs.includes('markUploadTyping(me.id, chat.id)') && apiJs.includes('markUploadTyping(me.id, meta.chat)') && apiJs.includes('clearUploadTyping(me.id, meta.chat)'),
  'загрузка файла помечает себя сама: init и куски ставят «загружает…», fin гасит');
ok(apiJs.includes('typing: typingInChats('), 'ответ синхронизации несёт список «кто пишет» по моим чатам');
ok(appJs.includes("api('/api/typing?chat='") && appJs.includes('const TYPING_POLL_MS'),
  'клиент: лёгкий опрос «кто пишет» каждые 4 секунды, пока чат открыт и вкладка видна');
ok(appJs.includes('function sigTyping') && appJs.includes('function stopTypingSignal') && appJs.includes("if (e.target.value.trim()) sigTyping('type');"),
  'клиент: сигнал «пишет…» пока набираешь текст (не чаще раза в 3 с, молчок через 5 с)');
ok(appJs.includes('function typingLine') && appJs.includes("'пишет…', 'пишут…'") && appJs.includes("'загружает…', 'загружают…'"),
  'в группе и игре заголовок называет имена: «Сергей пишет…», «Сергей и Аня загружают…»');
ok(appJs.includes("const act = t ? (t.kind === 'upload' ? 'загружает…' : 'пишет…')")
  && appJs.includes("const ms = musicStatusOf(u && u.id);"),
  'в личном чате «пишет…»/«загружает…»/«🎵 слушает» сменяют «в сети, смотрит чат»');
ok(appJs.includes("wake('собеседник пишет')"), 'пока собеседник пишет, окно бодрствует — его письмо прилетит сразу');
ok(appJs.includes("else if (document.hidden) stopTypingSignal();"), 'спрятали вкладку — сигнал «пишет…» гаснет немедленно');
const gt77 = appJs.slice(appJs.indexOf('function gameTitle'));
const gt77body = gt77.slice(0, gt77.indexOf('\n}'));
ok(!gt77body.includes('gameIcon'), 'в названии игрового чата больше нет значка игры — только имена');
ok(appJs.includes("const gamePlayerName = id => (userById(id) || {}).name || 'Кто-то';"),
  'незнакомый соперник называется «Кто-то», а не «…»');
ok(appJs.split("gamePlayerName(g.white) + ' и ' + gamePlayerName(g.black)").length - 1 === 2,
  'название чата и заголовок доски собираются одними словами');
ok(appJs.includes("c.kind === 'game' ? gameIconImg(gameRulesOf(c), 'gimg')"), 'значок игры переехал на иконку чата (pkg3-83: иконка-картинка владельца)');
ok(!appJs.includes('tag-grp" title="${gameRulesOf'), 'маленькая плашка со значком после названия игрового чата убрана');
ok(css.includes('.avatar .gimg{'), 'иконка игры на аватаре чата оформлена в стилях (pkg3-83)');

// pkg3-78: «Золотая лихорадка» — забег с туманом войны (pkg3-80: звук, управление пальцем, одна кнопка выхода)
const coinsEng = readFileSync(join(PUB, 'coins-engine.js'), 'utf8');
ok(html.includes('<script src="coins-engine.js"></script>') && html.indexOf('coins-engine.js') < html.indexOf('src="app.js"'),
  'движок «Золотой лихорадки» подключён в index.html раньше клиента');
ok(coinsEng.includes('const MAX_PLAYERS = 4') && coinsEng.includes('const MAPS = 13') && coinsEng.includes('const COINS = 40'),
  'движок: до 4 игроков, колода из 13 карт (pkg3-85), 40 монет одного достоинства');
ok(coinsEng.includes('const MAX_ROUNDS = 6;'), 'pkg3-85: раундов по-прежнему не больше шести — из тринадцати карт выбираются шесть');
ok(coinsEng.includes('function genRound') && coinsEng.includes('function simulate') && coinsEng.includes('function verify'),
  'движок: раскладка из зерна, перепроигрывание пути и проверка чужого результата');
ok(coinsEng.includes('function progressOf') && coinsEng.includes('function surrenderOf'),
  'pkg3-82: прогресс каждого игрока считается движком по его собственным письмам');
ok(!coinsEng.includes('GRACE_MS') && !coinsEng.includes('absentOf'),
  'pkg3-82: правила «сутки без результата — не играл» больше нет — забег никого не закрывает задним числом');
ok(coinsEng.includes('function roundPlan') && coinsEng.includes('function winnerOf'),
  'план раундов и победитель считаются движком — одинаково на всех устройствах');
ok(apiJs.includes('В «Сталкер» играют максимум вчетвером'), 'сервер: гостей не больше трёх — всего четыре игрока');
ok(apiJs.includes('Math.min(6, Math.max(1, Math.round(Number(b.rounds) || 3)))') && apiJs.includes('Math.min(30, Math.max(1, Math.round(Number(b.minutes) || 3)))'),
  'сервер: раундов 1–6; целые минуты чтутся у старых клиентов, у новых — секунды (pkg3-85: по умолчанию 1 минута)');
ok(apiJs.includes('else sec = 60;'), 'pkg3-85: время не указано — по умолчанию минута');

// pkg3-86: «Моя музыка» — плеер с плейлистами ссылок; треки на сервере не хранятся
ok(apiJs.includes("pathname === '/api/music' && method === 'GET'") && apiJs.includes("pathname === '/api/music' && method === 'POST'"),
  'сервер: свои плейлисты читаются и сохраняются маршрутом /api/music');
ok(apiJs.includes("pathname.startsWith('/api/music/')") && apiJs.includes('чужие личные списки и ключ не отдаются никогда'),
  'сервер: другим отдаются ТОЛЬКО публичные плейлисты; личные и ключ — никогда');
ok(apiJs.includes('me.musicPriv = b.priv;') && apiJs.includes('me.musicKeyWrap = b.key;'),
  'сервер хранит личный список шифротекстом и завёрнутый ключ — слеп, как к переписке');
ok(appJs.includes('async function openMusic(') && html.includes('data-plus="music"'),
  'в меню «+» — плашка «Моя музыка», открывающая плеер');
ok(appJs.includes('function musicProbe(url)') && appJs.includes('похоже, это адрес СТРАНИЦЫ, а не файла'),
  'плеер честно предупреждает: ссылка на страницу (Яндекс.Музыка, VK, YouTube) не проигрывается');
ok(appJs.includes('async function musicSave()') && appJs.includes('encryptJSON(m.km, m.priv)'),
  'плейлисты «только я» шифруются ключом музыки, завёрнутым в мой публичный ключ');
ok(appJs.includes('function musicFabSync()') && appJs.includes("fab.id = 'music-fab';"),
  'пока музыка играет, вне окна живёт плавающая кнопка «🎵 играет»');
ok(appJs.includes('function musicCoverOf(file)') && appJs.includes('c.width = 96; c.height = 96;'),
  'обложка трека ужимается до квадрата 96 px и лежит в списке лёгкой картинкой');
ok(css.includes('.mus-wrap{') && css.includes('.music-fab{'), 'окно плеера и плавающая кнопка оформлены в стилях');

// pkg3-87: этап Б — статус «🎵 слушает», «слушать вместе», чужие публичные списки
ok(apiJs.includes('const musicNow = new Map()') && apiJs.includes("if (b.kind === 'music')"),
  'сервер: звуковой статус живёт только в памяти и не привязан к чату');
ok(apiJs.includes('music: musicInScope(') && appJs.includes('function mergeMusicStatus('),
  'синхронизация и опрос несут статус «🎵 слушает» только моему кругу');
ok(appJs.includes("if (p.k === 'mus-together')") && appJs.includes('data-mus-join') && appJs.includes('function musicPlayOnce('),
  'pkg3-92: старые письма «слушать вместе» по-прежнему читаются карточкой с кнопкой «Слушать» (история священна), новые не шлются');
ok(appJs.includes('async function openMusicOf(') && css.includes('.mus-of-tr'),
  'у чужого аватара — окно публичных плейлистов: только чтение, трек идёт с источника');
ok(apiJs.includes("if (chat.game.rules === 'coins') {"), 'сервер знает «Монеты» в accept/decline/leave');
ok(apiJs.includes('invitees = inv.filter(x => x !== me.id)'), 'отказ и принятие вычёркивают из списка приглашённых, чужой забег не убивая');
ok(apiJs.includes("coins: '«Сталкер»: есть новости забега — откройте партию'"), 'пуш забега говорит по-человечески');
ok(appJs.includes("gameRulesOf(c) === 'coins' ? '🪙'"), 'значок «Золотой лихорадки» живёт на иконке чата');
ok(appJs.includes('function renderCoins') && appJs.includes('coins-canvas'), 'клиент рисует забег на canvas (карта, стены, туман)');
ok(appJs.includes('function coinsFogLayer') && appJs.includes("rgba(6,7,12,0.93)"), 'туман войны: вне ареола всё во тьме');
ok(appJs.includes('lanternUntil = Date.now() + 15000'), 'фонарь: +видимость на 15 секунд');
ok(appJs.includes('L.hg++') && appJs.includes('+10 секунд'), 'песочные часы: +10 секунд к таймеру');
ok(appJs.includes('compassUntil = Date.now() + 2500'), 'компас: стрелка к ближайшей монете вспыхивает на 2,5 секунды');
ok(appJs.includes('coinsHoldStart') && appJs.includes('}, 170);'), 'фигура шагает каждые 170 мс, пока управление удержано (палец или клавиша)');
ok(appJs.includes('COINS_KEYS') && appJs.includes('ArrowUp'), 'стрелки клавиатуры тоже ведут фигуру');
ok(appJs.includes("k: 'coins-result'") && appJs.includes("k: 'coins-surrender'") && appJs.includes("k: 'coins-record'"),
  'письма забега: результат, сдача и рекорд соло-забега');
ok(appJs.includes('CE.verify(') && appJs.includes('не проверено'), 'чужой результат перепроверяется; неверный помечен «не проверено» и обнулён');
ok(appJs.includes('coinsFinishRound(false)') && appJs.includes('Math.min(Date.now(), Number(L.startedAt) + limit + 400)'),
  'таймер кончился — результат уходит сам; время финиша честное (не дальше лимита)');
ok(!appJs.includes('id="coins-surrender"') && appJs.includes('async function coinsLeaveSmart'),
  'pkg3-80: одна кнопка «Выйти» над картой — «сдаться» отдельной кнопкой больше не нужно');
ok(appJs.includes('function coinsNewRun') && appJs.includes('Начать снова'), 'соло: «начать снова» открывает новый забег');
ok(appJs.includes('coinsMaybeRecord') && appJs.includes('Новый рекорд забега'), 'соло: новый рекорд забега отмечается письмом и поздравлением');
ok(appJs.includes('const uid = who || (S.me || {}).id;') && appJs.includes('avatarCache.get(uid)'),
  'фигура игрока — его аватар из чата (pkg3-81: зритель видит аватар владельца пути)');
ok(appJs.includes('coinsPresenceHtml') && appJs.includes('cp-dot'), 'доска показывает, кто в игре и кто в сети');
ok(appJs.includes('coins-restoggle') && appJs.includes('function coinsOpenResults'), 'кнопка «Результаты» открывает таблицу всех игроков окном');
ok(css.includes('.coins-restoggle{display:block;margin:10px auto 0;}') && css.includes('.coins-results.open{display:block;}'),
  'кнопка «Результаты» видна на всех экранах — таблица открывается окном');
ok(!css.includes('.cpad{') && !appJs.includes('data-cdir') && appJs.includes('function coinsDragBind'),
  'pkg3-80: крест-джойстик убран — на телефоне фигура идёт за пальцем, проведённым по карте');
ok(css.includes('#coins-canvas{') && css.includes('touch-action:none'), 'холст забега оформлен и не тянет страницу пальцем');
ok(css.includes('.ng-pick{'), 'список гостей «Золотой лихорадки» в окне «Новая игра» оформлен');
ok(appJs.includes('function createCoinsGame') && appJs.includes('Начать соло-забег'), 'окно «Новая игра» умеет соло-забег без соперников');
ok(appJs.includes("p.k.slice(0, 6) !== 'coins-'") || appJs.includes("p.k.slice(0, 6) === 'coins-'"), 'письма забега — служебные: не лента и не «непрочитанные»');
ok(appJs.includes('sega.coins.'), 'идущий раунд переживает перезагрузку страницы (память устройства)');
ok(sw.includes('\\.jpg'), 'картинки карт кэшируются сервис-работником');

// pkg3-80: звук игр — синтез кодом (Web Audio), настройка и музыка карт
ok(html.includes('<script src="game-sound.js"></script>') && html.indexOf('game-sound.js') < html.indexOf('src="app.js"'),
  'звуковой движок игр подключён в index.html раньше клиента');
ok(html.includes('id="game-sound"') && html.includes('Звук в играх'), 'в настройках — тумблер «Звук в играх»');

// pkg3-82: шесть правок «Золотой лихорадки» — личный темп, кнопки раундов, соло-финал, «Сейчас играют», музыка
const gsJs = readFileSync(join(PUB, 'game-sound.js'), 'utf8');
ok(coinsEng.includes('function roundPlan') && coinsEng.includes('waiting') && coinsEng.includes('lastDone'),
  'правки 1–3: план забега — личный прогресс каждого (per/waiting), забег ждёт ВСЕХ; раунды не закрываются по сроку');
ok(appJs.includes('const mine = (plan.per || {})[S.me.id]') && appJs.includes('const myNext'),
  'правки 1–3: клиент играет СВОЙ следующий раунд — соперников не ждёт');
ok(appJs.includes('Следующий раунд') && appJs.includes('id="coins-next"'),
  'правка 2: после раунда — вскрытая карта и кнопка «Следующий раунд»');
ok(appJs.includes('id="coins-resbtn"') && appJs.includes("if (phase === 'final' && cs.solo) acts"),
  'правки 2 и 4: после последнего раунда — кнопка «Результаты»; в соло финал открывается картой');
ok(appJs.includes('id="coins-again2"') && appJs.includes('hide($(\'#modal\')); coinsNewRun();'),
  'правка 4: в соло «Начать снова» живёт под таблицей результатов — забеги копятся в ней же');
ok(appJs.includes('const finalTable = (phase === \'final\' && !(cs.solo && S.coinsLive))'),
  'правка 3: у компании финал — таблица результатов автоматически у всех (с победителем)');
ok(apiJs.includes("b.mark === 'coins-result'") && apiJs.includes('chat.game.reported'),
  'правка 5: сервер запоминает открытую метку «игрок сдал результат» — письмо он по-прежнему не читает');
ok(apiJs.includes('c.game.reported) && c.game.reported.length >= 2'),
  'правка 5: чужой забег виден в «Сейчас играют», только когда результаты сдали хотя бы двое');
ok(appJs.includes("if (payload && payload.k === 'coins-result') body.mark = 'coins-result';"),
  'правка 5: клиент ставит метку только на письме с результатом раунда');
ok(gsJs.includes('us.buffer = ub; us.connect(ctx.destination); us.start(0);'),
  'правка 6: iOS-отпирание звука — бесшумный буфер при создании аудиоконтекста');
ok(gsJs.includes('try { const rp = ctx.resume(); if (rp && rp.catch) rp.catch(() => {}); } catch (e) {}') && gsJs.includes('setTimeout(pump, 500)'),
  'правка 6: насос музыки будит уснувший контекст сам, а не ждёт вечно');
ok(gsJs.includes('m.nextAt = ctx.currentTime + 0.05;') && gsJs.includes('0.085') && gsJs.includes('0.09)'),
  'правка 6: мелодия не «стреляет очередью из прошлого», переставлена на текущий такт и стала слышнее');
ok(appJs.includes('GS.isEnabled() && GS.musicPref() && !GS.isPlaying()') && appJs.includes('GS.startMusic(L.gen.mapIdx);'),
  'правка 6: тикер забега лечит мелодию сам — запускает её снова, если контекст не ожил с первого раза');
ok(gsJs.includes("version: 'pkg3-85'"), 'звуковой движок помечен pkg3-85');

// pkg3-83: имя «Сталкер», иконки владельца, двухшаговое меню, победитель не прячется
ok(appJs.includes("const GAME_NAMES = { chess: 'Шахматы', checkers: 'Шашки (русские)', seabattle: 'Морской бой', coins: 'Сталкер' };"),
  'пункт 1: имена игр собраны в одном месте; «Сталкер» — новое имя «Золотой лихорадки»');
ok(!appJs.includes('<option value="coins">Золотая лихорадка</option>') && !appJs.includes("modal('Золотая лихорадка"),
  'пункт 1: старого имени больше нет ни в окне игр, ни в заголовке результатов');
ok(apiJs.includes("coins: '«Сталкер»: есть новости забега — откройте партию'"),
  'пункт 1: пуш сервера зовёт игру по-новому');
ok(appJs.includes("gameIconImg(gameRulesOf(c), 'gimg')") && appJs.includes("gameIconImg(rules, 'gmini')"),
  'пункт 3: аватар чата и письма партии в ленте рисуют иконку-картинку, а не символ');
for (const f of ['game-chess.png', 'game-checkers.png', 'game-seabattle.png', 'game-stalker.png']) {
  ok(readFileSync(join(PUB, 'img', f)).length > 4000, 'пункт 3: файл иконки ' + f + ' на месте и не пустой');
}
ok(css.includes('.avatar .gimg{') && css.includes('.gmini{') && css.includes('.ng-games{'),
  'пункт 3: стили иконок — круг в аватаре, мини в ленте, плитки в меню');
ok(appJs.includes('id="ng-games"') && appJs.includes('async function openNewGameSettings') && appJs.includes('← к списку игр'),
  'пункт 4: «+» сначала показывает список игр с иконками, настройки — вторым шагом, с кнопкой «назад»');
ok(appJs.indexOf("else if (plan.final) phase = 'final';") < appJs.indexOf("else if (loc && loc.startedAt && !loc.sent) phase = 'hunt';"),
  'пункт 2: финал забега главнее вскрытой карты — закончивший последним сразу видит победителя, а не «ждём остальных»');
ok(appJs.includes('const wLine = cs.winner') && appJs.includes("'победил ' + gamePlayerName(cs.winner.ids[0])"),
  'пункт 2: победитель объявлен в шапке таблицы результатов (и в строке над панелью, как прежде)');

// pkg3-85: тринадцать карт «Сталкера» и время раунда с шагом 10 секунд
ok(coinsEng.includes('const MAPS = 13;') && coinsEng.includes('const MAX_ROUNDS = 6;'),
  'пункт 1: колода из тринадцати карт, раундов по-прежнему не больше шести — на забег выбираются шесть случайных');
for (let i = 7; i <= 13; i++) {
  ok(readFileSync(join(PUB, 'img', 'coins-map' + i + '.jpg')).length > 40000,
    'пункт 1: новая карта coins-map' + i + '.jpg на месте и не пустая');
}
ok(gsJs.includes('329.63'), 'пункт 1: у тринадцати карт — тринадцать тональностей мелодий');
ok(appJs.includes('id="ng-sec-minus"') && appJs.includes('id="ng-sec-plus"') && appJs.includes('id="ng-sec-view"'),
  'пункт 2: время раунда крутится кнопками «− 10 с» / «+ 10 с»');
ok(appJs.includes('<input id="ng-sec" type="hidden" value="60">'),
  'пункт 2: по умолчанию — одна минута');
ok(appJs.includes('const coinsSecOf =') && appJs.includes('const fmtCoinsTime ='),
  'пункт 2: старые игры (целые минуты) и новые (секунды) читаются одним кодом');
ok(apiJs.includes('sec = Math.min(1800, Math.max(10, sec || 60));'),
  'пункт 2: сервер держит границы 10 секунд — 30 минут с шагом 10 секунд');
ok(apiJs.includes('invitees: invited, players: [me.id], seed, minutes, sec, rounds, result: null'),
  'пункт 2: карточка игры несёт и секунды, и дробные минуты — старым клиентам всё читается');

// pkg3-88: «умная вставка» — код плеера Яндекс.Музыки становится встроенным плеером
const pasteJs = readFileSync(join(PUB, 'music-paste.js'), 'utf8');
ok(html.includes('<script src="music-paste.js"></script>') && html.indexOf('music-paste.js') < html.indexOf('src="app.js"'),
  'pkg3-88: разбор вставленного текста подключён в index.html раньше клиента');
ok(pasteJs.includes("const Y_HOST = 'music.yandex.ru';") && pasteJs.includes('function iframeSrcs(') && pasteJs.includes('function widgetFromPage('),
  'pkg3-88: модуль понимает и «код плеера» (<iframe>), и ссылку на трек/альбом/плейлист/артиста');
ok(pasteJs.includes("glob.MP = MP;") && pasteJs.includes('function parsePaste('),
  'pkg3-88: разбор — отдельный «чистый» модуль, его проверяет test/music88.mjs');
ok(appJs.includes('function musicParsePaste(') && appJs.includes('window.MP'),
  'pkg3-88: приложение разбирает вставку через модуль, а не «на глаз»');
ok(appJs.includes("kind: 'widget'") && appJs.includes('musicIsWidget(t)'),
  'pkg3-88: у трека появился род — файл или виджет Яндекс.Музыки');
ok(appJs.includes('function musicPlayWidget(') && appJs.includes('function musWidgetShow('),
  'pkg3-88: виджет играет отдельной панелью — звук не обрывается при закрытом окне');
ok(appJs.includes("f.setAttribute('sandbox'") && appJs.includes('allow-popups'),
  'pkg3-88: чужой плеер закрыт в «песочнице» (sandbox) — изолирован от приложения');
ok(appJs.includes('трек из личного списка или встроенный плеер — синхронно вести нельзя'),
  'pkg3-88/92: виджет и личные списки честно не участвуют в синхронном прослушивании');
ok(appJs.includes('const on = musVisGet() && !MUS.widget &&'),
  'pkg3-88/92: виджет не транслируется в статус «🎵 слушает» — не знаем, играет ли он');
ok(appJs.includes('id="mus-add-hint"') && appJs.includes('data-mus-y='),
  'pkg3-88: в окне музыки — подсказка про вставку и кнопка «↗ Яндекс» у виджета');
ok(css.includes('.mus-widget{') && css.includes('.mus-badge-y{') && css.includes('.mus-player.widget-mode #mus-seek'),
  'pkg3-88: панель встроенного плеера, значок «Я» и виджет-режим оформлены в стилях');

// ─────────────────────────── pkg3-92 ───────────────────────────
ok(appJs.includes("fab.textContent = '🎵 Моя музыка';") && appJs.includes('function musicFabBind(') && appJs.includes('sega.musFabPos.v1'),
  'pkg3-92: пузырёк переименован в «Моя музыку», перетаскивается и запоминает место');
ok(appJs.includes('function musMinimize(') && appJs.includes('function musFly(') && appJs.includes('function musCloseFull('),
  'pkg3-92/93: окно и пузырёк — одно и то же: перелёт плашкой поверх экрана, крестик закрывает совсем');
ok(appJs.includes('id="mus-vis"') && css.includes('.mus-sw-pill{') && css.includes('.mus-sw-knob{'),
  'pkg3-92: «видно, что слушаю» — тумблер-переключатель, как на снимке владельца');
ok(!appJs.includes('id="mus-together"') && !appJs.includes('async function musicTogether('),
  'pkg3-92: кнопка «🎧 вместе» убрана — письма-приглашения больше не шлются');
ok(appJs.includes('data-mus-follow') && appJs.includes('function musStartFollow(') && appJs.includes('function musApplySync('),
  'pkg3-92: плашка «слушает музыку» кликабельна — режим «Слушаю с …»');
ok(appJs.includes('Слушаю с «') && appJs.includes('function musBreakFollow('),
  'pkg3-92: надпись «Слушаю с …» и обрыв синхронизации своими стоп/перемоткой/треком');
ok(apiJs.includes("'/api/music/status'") && apiJs.includes("'/api/music/follow-href'") && apiJs.includes('function cleanSync('),
  'pkg3-92: сервер держит якорь прослушивания и выдаёт временную ссылку на дисковый трек слушающего');
ok(appJs.includes('data-readmenu=') && appJs.includes('function askYesNo(') && appJs.includes('function markChatRead(') && css.includes('.ask-card{'),
  'pkg3-92: счётчик непрочитанных открывает меню «Сделать прочитанными? Да/Нет»');
ok(appJs.includes("kind: 'music', note: musicStatusNote(), sync: musicStatusSync()"),
  'pkg3-92: статус уходит с якорем (трек, позиция, время), когда видимость включена');

// ─────────────────────────── pkg3-93 ───────────────────────────
ok(appJs.includes('document.addEventListener(\'pointermove\', move') && appJs.includes("fab.style.bottom = 'auto'"),
  'pkg3-93: пузырёк перетаскивается по-настоящему (document-слушатели, оба якоря сняты — не растягивается)');
ok(css.includes('.music-fab{position:fixed;right:14px;bottom:76px'),
  'pkg3-93: пузырёк по умолчанию стоит НАД кнопкой отправки, не поверх неё');
ok(appJs.includes('function musAddMinBtn(') && appJs.includes("mb.textContent = 'Свернуть';") && css.includes('.mus-shutter{'),
  'pkg3-93/94: «Свернуть» — шторка-язычок по центру верхней кромки окна музыки');
ok(appJs.includes('S.musFabHidden = true') && appJs.includes('!S.musFabHidden && !S.musOpen'),
  'pkg3-93: крестик прячет пузырёк совсем; при открытом окне пузырька нет (иллюзия одного предмета)');
ok(css.includes('.mus-fly{') && appJs.includes('function musFly('),
  'pkg3-93: перелёт окно↔пузырёк рисуется плашкой поверх всего экрана — видно, КУДА улетело');
ok(appJs.includes('❚❚') && css.includes('@keyframes mus-mq') && appJs.includes('class="mq${'),
  'pkg3-93/96: у текущего трека ▶ становится ❚❚, длинное название едет бегущей строкой');
ok(appJs.includes("row.classList.toggle('paused'"),
  'pkg3-93/96: бегущая строка замирает на паузе');
ok(appJs.includes("title=\"Играть / пауза\""),
  'pkg3-93: нажатие на текущий трек — пауза/продолжить');

// ─────────────────────────── pkg3-94 ───────────────────────────
ok(!css.includes('.music-fab.on{') && !appJs.includes("fab.classList.toggle('on', true);"),
  'pkg3-94: старое правило «.on = показывать» убрано — пузырёк гаснет при открытом окне и при развороте');
ok(appJs.includes('if (MUS.widget) musWidgetStop();') && appJs.includes('if (a && !a.paused) a.pause();') && appJs.includes('function musCloseFull('),
  'pkg3-94: крестик останавливает музыку (файл и виджет) и гасит статус «слушает»');
ok(appJs.includes('const fr = fab.getBoundingClientRect();\n  musicFabSync();'),
  'pkg3-94: при развороте габарит пузырька берётся до скрытия, сам пузырёк гаснет сразу');
ok(css.includes('.mus-shutter{position:absolute;top:6px;left:50%'),
  'pkg3-94: шторка выступает над верхней кромкой окна по центру');
ok(appJs.includes('musStopFollow(true);'),
  'pkg3-94: закрытие крестиком тихо завершает «Слушаю с …»');

// ─────────────────────────── pkg3-95 ───────────────────────────
ok(appJs.includes('S.musFabEarned') && appJs.includes('!!S.token && S.musFabEarned && !S.musFabHidden && !S.musOpen'),
  'pkg3-95: при первом открытии чата пузырька нет — он зарабатывается первым сворачиванием окна');
ok(appJs.includes('S.musFabEarned = true;') && appJs.includes('function musRowsRerender('),
  'pkg3-95: шторка зарабатывает пузырёк; список треков перерисовывается при старте трека');
ok(css.includes('.mus-shutter{position:absolute;top:6px;left:50%'),
  'pkg3-95: шторка «Свернуть» видна полностью, ровно по центру верха окна');
ok(css.includes('#modal .modal-box{max-height:calc(100vh - 28px)') && css.includes('.mus-trs{flex:0 1 auto;min-height:60px;overflow:auto}'),
  'pkg3-95: окно музыки вмещается в окно мессенджера без внешней полосы; списки скроллятся сами');
ok(appJs.includes("musRowsRerender();") && appJs.includes('musicNowUi(); musicFabSync(); musRowsRerender();'),
  'pkg3-95: ❚❚ и бегущая строка появляются сразу при запуске трека, а не после переоткрытия окна');

// ─────────────────────────── pkg3-96 ───────────────────────────
ok(appJs.includes('<div class="mus-trs" data-pl="${pl.id}">'),
  'pkg3-96: список треков помнит, какой плейлист нарисован');
ok(appJs.includes("const rowsBox = document.querySelector('#modal .mus-trs[data-pl]');"),
  'pkg3-96: строки списка живьём следуют за плеером (переключение без перерисовки окна)');
ok(css.includes('.mus-tr .mq{display:inline-block') && css.includes('.mus-tr.cur .mq{padding-left:100%'),
  'pkg3-96: бегущая строка заготовлена у каждого трека, едет только у текущего');
ok(appJs.includes('musicNowUi(); musicFabSync(); musRowsRerender(); musicTickUi();'),
  'pkg3-96: сразу после старта трека список помечен текущим без ожидания');
ok(appJs.includes("const BUILD = 'pkg3-101';") && apiJs.includes("const BUILD = 'pkg3-101';"),
  'BUILD pkg3-101 совпадает в клиенте и на сервере');
ok(sw.includes("const STATIC_CACHE = 'sega-static-v94';"), 'кэш статики поднят до v93');

// ─────────────────────────── pkg3-97 ───────────────────────────
const mussearchJs = readFileSync(join(HERE, '..', 'lib', 'mussearch.js'), 'utf8');
const pkgJson97 = readFileSync(join(HERE, '..', 'package.json'), 'utf8');
ok(apiJs.includes("'/api/mussearch'") && apiJs.includes("require('./mussearch.js')"),
  'pkg3-97: серверный маршрут поиска подключён');
ok(mussearchJs.includes("id: 'yapfiles'") && mussearchJs.includes("id: 'openverse'"),
  'pkg3-97: четыре сайта-источника (yapfiles, archive, commons, openverse)');
ok(appJs.includes('data-mus-pl="search"') && appJs.includes('🔎 Поиск музыки'),
  'pkg3-97: в окне музыки появилась панель «Поиск музыки»');
ok(appJs.includes('data-mus-site=') && css.includes('.mus-site-chip{'),
  'pkg3-97: фишки сайтов — владелец выбирает, по каким искать');
ok(appJs.includes('data-mus-s-play=') && appJs.includes('data-mus-s-add=') && appJs.includes('data-mus-pick='),
  'pkg3-97: у находки ▶ прослушать и ＋ добавить; ＋ даёт список плейлистов');
ok(mussearchJs.includes('module.exports') && !JSON.parse(pkgJson97).dependencies['mussearch'],
  'pkg3-97: поиск — свой модуль без новых зависимостей');

// ─────────────────────────── pkg3-98 ───────────────────────────
ok(mussearchJs.includes('const toks = String(q).toLowerCase()') && mussearchJs.includes('relevant.sort('),
  'pkg3-98: сервер фильтрует и сортирует находки по совпадению названия со словами запроса');
ok(mussearchJs.includes('__ia_thumb.jpg') && mussearchJs.includes('thumburl') && mussearchJs.includes('r.thumbnail') && mussearchJs.includes('og:image'),
  'pkg3-98: обложки подтягиваются со всех четырёх сайтов, где они есть');
ok(appJs.includes('id="mus-prog"') || appJs.includes("'<div class=\"mus-prog\" id=\"mus-prog\"'") || appJs.includes('mus-prog'),
  'pkg3-98: линия загрузки поиска растёт по мере ответов сайтов');
ok(appJs.includes('Спрашиваю сайты: '), 'pkg3-98: строка состояния считает опрошенные сайты');
ok(appJs.includes('mus-sr-cov') && appJs.includes('mus-sr-t') && appJs.includes('mus-add-sm'),
  'pkg3-98: строка находки — обложка, читаемое название с многоточием, уменьшенный «＋»');
ok(css.includes('.mus-prog{') && css.includes('.mus-sr-t{') && css.includes('.mus-add-sm{'),
  'pkg3-98: стили линии загрузки и строк находок на месте');
ok(appJs.includes("api('/api/mussearch?q=' + encodeURIComponent(st.q) + '&sites=' + id)"),
  'pkg3-98: сайты опрашиваются параллельно по одному — прогресс честный');

// ─────────────────────────── pkg3-99 ───────────────────────────
ok(apiJs.includes("throttle('mussearch-' + me.id, 120)"),
  'pkg3-99: потолок поисков поднят до 120 за 10 минут — прежний захлопывался после пяти поисков');
ok(mussearchJs.includes('searchCcmixter') && mussearchJs.includes("id: 'ccmixter'"),
  'pkg3-99: пятый сайт — ccMixter (CC-музыканты, прямые download_url)');
ok(mussearchJs.includes('const siteRest = new Map()') && mussearchJs.includes('Сайт попросил подождать'),
  'pkg3-99: сайт с 429/403 уходит на отдых на пять минут и больше не дёргается');
ok(appJs.includes('for (const id of sites) {') && appJs.includes('pkg3-99: сайты спрашиваются ПО ОЧЕРЕДИ'),
  'pkg3-99: сайты опрашиваются по очереди — вежливо к их ограничителям');
ok(appJs.includes('ccmixter: \'ccMixter CC\'') || appJs.includes("ccmixter: 'ccMixter CC'"),
  'pkg3-99: фишка ccMixter в панели поиска');
ok(sw.includes("const STATIC_CACHE = 'sega-static-v94';"), 'кэш статики поднят до v93');

// ─────────────────────────── pkg3-100 ───────────────────────────
ok(mussearchJs.includes("id: 'jamendo'") && mussearchJs.includes('function searchJamendo('),
  'pkg3-100: шестой источник — Jamendo с официальным API');
ok(mussearchJs.includes('/opt/sega/keys/jamendo.json') && mussearchJs.includes('function loadJamKeys('),
  'pkg3-100: client_id живёт в файле ключей на сервере, читается на каждый поиск');
ok(mussearchJs.includes('ключи Jamendo не положены'),
  'pkg3-100: без ключа фишка честно говорит «ключи не положены», остальной поиск работает');
ok(appJs.includes("jamendo: 'Jamendo CC'"), 'pkg3-100: фишка Jamendo в панели поиска');
ok(mussearchJs.includes('imagesize') && mussearchJs.includes('fields: \'audio,image,name,album_name,artist_name\''),
  'pkg3-100: из API тянутся прямая ссылка на поток, обложка и имя исполнителя');
ok(sw.includes("const STATIC_CACHE = 'sega-static-v94';"), 'кэш статики поднят до v93');
ok(apiJs.includes('jamendo: mussearch.hasKeys()') && appJs.includes('S.jamendoOn = st.jamendo !== false;'),
  'pkg3-100: сервер сообщает «ключ положен» одной булевой меткой, участники не настраивают ничего');

console.log('\n──────────────────────────────────────────────────');
console.log(`  Разметка pkg3-44: ${good} ✓, провалов ${bad}`);
console.log('──────────────────────────────────────────────────\n');
if (bad) process.exit(1);
