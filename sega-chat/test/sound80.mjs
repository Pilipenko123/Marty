/**
 * pkg3-80: звук игр, синтезированный кодом (Web Audio), и правки забега.
 *   • движок GS: мелодии карт рождаются из зерна (детерминированы), сигналы
 *     спокойные (громкость ≤ 0.12, только синус/треугольник), в Node звуковая
 *     часть безопасно молчит;
 *   • письмо игры → сигнал (letterSound) — чистая функция;
 *   • клиент: тумблер «Звук в играх», музыка карты с кнопкой «выключить»,
 *     мгновенный выход из законченной игры, «Далее» после раунда, одна кнопка
 *     «Выйти», управление пальцем по карте, таблица результатов окном,
 *     «Золотая лихорадка» вместо «Монет», тишина в открытом чате.
 * Запуск: node test/sound80.mjs
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PUB = join(ROOT, 'public');
const require = createRequire(import.meta.url);
const GS = require(join(PUB, 'game-sound.js'));

let good = 0, bad = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ПРОВАЛ: ') + m); if (c) good++; else bad++; };

console.log('\n══════════════════════════════════════════════════');
console.log('  pkg3-80: звук игр и правки «Золотой лихорадки»');
console.log('══════════════════════════════════════════════════\n');

// ─────────────────────────── мелодии карт ───────────────────────────
{
  const a = GS.melodyFor(0), b = GS.melodyFor(0);
  ok(JSON.stringify(a) === JSON.stringify(b), 'мелодия карты рождается из зерна — два вызова дают одни и те же ноты');
  const set = new Set();
  for (let i = 0; i < 13; i++) set.add(JSON.stringify(GS.melodyFor(i)));
  ok(set.size === 13, 'у всех тринадцати карт — тринадцать разных мелодий');
  ok(GS.melodyFor(13).map === 0 && GS.melodyFor(-1).map === 12, 'номер карты заворачивается в диапазон 0..12');
  ok(GS.ROOTS.length === 13, 'у тринадцати карт — тринадцать своих тональностей');
  let calm = true, ranged = true, bassOk = true;
  for (let i = 0; i < 6; i++) {
    const m = GS.melodyFor(i);
    if (!(m.bpm >= 54 && m.bpm <= 90)) calm = false;                 // темп не чаще сердцебиения
    if (!(m.root > 100 && m.root < 500)) calm = false;
    if (!m.notes.length || m.notes.length > m.beats) ranged = false;
    for (const n of m.notes) {
      if (!(n.b >= 0 && n.b < m.beats && n.d > 0 && n.b + n.d <= m.beats)) ranged = false;
      if (!GS.PENT.includes(n.n % 12)) ranged = false;               // только пентатоника — фальши не бывает
      const hz = GS.noteHz(m, n.n, false);
      if (!(hz > 80 && hz < 2400)) ranged = false;
    }
    if (m.bass.length !== m.beats / 4) bassOk = false;               // бас — раз в такт
    for (const n of m.bass) if (!(n.n === 0 || n.n === 7)) bassOk = false;  // тоника или квинта
  }
  ok(calm, 'музыка спокойная: темп 54–90, корень в певческом диапазоне');
  ok(ranged, 'ноты лежат внутри цикла и в минорной пентатонике (лад без фальшивых ступеней)');
  ok(bassOk, 'бас идёт раз в такт — тоника или квинта, октавой ниже');
}

// ─────────────────────────── таблица сигналов ───────────────────────────
{
  const names = ['step', 'coin', 'lantern', 'compass', 'hourglass', 'wall', 'warn',
    'roundstart', 'roundend', 'victory', 'move', 'capture', 'check', 'mate', 'win',
    'lose', 'draw', 'shot', 'incoming', 'miss', 'hit', 'sunk', 'seal', 'reveal',
    'start', 'invite', 'event', 'end'];
  ok(names.every(n => Array.isArray(GS.SFX[n]) && GS.SFX[n].length), 'в таблице есть все сигналы, которые использует клиент');
  let soft = true, sane = true;
  for (const n of Object.keys(GS.SFX)) {
    for (const v of GS.SFX[n]) {
      if (v.vol > 0.12) soft = false;                                 // спокойный звук: тихо
      if (v.type !== 'sine' && v.type !== 'triangle') soft = false;   // мягкие тембры (как PSG Sega)
      if (!(v.f0 > 20 && v.f0 < 5000 && v.dur > 0.02 && v.dur <= 1.2)) sane = false;
      if (!(v.f1 > 0)) sane = false;
    }
  }
  ok(soft, 'все сигналы спокойные: громкость ≤ 0.12, тембр — синус или треугольник');
  ok(sane, 'частоты и длительности сигналов в разумных пределах');
}

// ─────────────────────────── письмо → сигнал ───────────────────────────
{
  ok(GS.letterSound({ k: 'move', san: 'Nf3' }, true) === 'move', 'спокойный ход — сигнал «ход»');
  ok(GS.letterSound({ k: 'move', san: 'exd5' }, false) === 'capture', 'взятие узнаётся по «x»');
  ok(GS.letterSound({ k: 'move', san: 'Лad1' }, true) === 'move', 'русская запись хода без взятия — «ход»');
  ok(GS.letterSound({ k: 'move', san: 'Qh5+' }, false) === 'check', 'шах звучит своим сигналом');
  ok(GS.letterSound({ k: 'move', san: 'Qxf7#' }, false) === 'mate', 'мат — финальный сигнал');
  ok(GS.letterSound({ k: 'sb-shot', x: 3, y: 4 }, true) === 'shot', 'мой выстрел — «выстрел»');
  ok(GS.letterSound({ k: 'sb-shot', x: 3, y: 4 }, false) === 'incoming', 'чужой выстрел — «прилёт»');
  ok(GS.letterSound({ k: 'sb-reply', r: 'miss' }, false) === 'miss', 'мимо — тихий низкий сигнал');
  ok(GS.letterSound({ k: 'sb-reply', r: 'hit' }, false) === 'hit', 'ранил — свой сигнал');
  ok(GS.letterSound({ k: 'sb-reply', r: 'sunk' }, false) === 'sunk', 'потопил — нисходящий сигнал');
  ok(GS.letterSound({ k: 'sb-commit' }, true) === 'seal', 'печать флота — «запечатано»');
  ok(GS.letterSound({ k: 'sb-reveal' }, false) === 'reveal', 'вскрытие флота — «раскрытие»');
  ok(GS.letterSound({ k: 'game-invite' }, false) === 'invite', 'приглашение в игру звучит');
  ok(GS.letterSound({ k: 'game-event', text: 'Партия началась: Пётр стреляет первым.' }, false) === 'start', 'событие «началась» — стартовый сигнал');
  ok(GS.letterSound({ k: 'game-event', text: 'Победил Пётр' }, false) === 'end', 'событие «победил» — финальный сигнал');
  ok(GS.letterSound({ k: 'coins-result', round: 2, score: 7 }, false) === 'roundend', 'чужой результат раунда — спокойная кода раунда');
  ok(GS.letterSound({ k: 'coins-record', total: 100 }, false) === 'victory', 'рекорд забега — победный сигнал');
  ok(GS.letterSound(null, true) === null && GS.letterSound({ k: 'unknown-thing' }, true) === null, 'неписьмо и неизвестное письмо молчат');
}

// ─────────────────────────── Node: звук безопасно молчит ───────────────────────────
{
  let quiet = true;
  try {
    GS.setEnabled(true);
    GS.play('move'); GS.play('coin');
    if (GS.startMusic(2) !== false) quiet = false;   // без AudioContext музыка не стартует
    GS.stopMusic();
    GS.setEnabled(false);
    GS.play('win');
    GS.setEnabled(true);
    GS.toggleMusicPref(); GS.toggleMusicPref();
  } catch (e) { quiet = false; }
  ok(quiet, 'в Node (без браузера) движок не падает: сигналы молчат, музыка не стартует');
  ok(typeof GS.ensure === 'function' && typeof GS.stopMusic === 'function', 'API движка на месте: ensure, play, startMusic, stopMusic');
}

// ─────────────────────────── клиент: разметка и логика ───────────────────────────
const appJs = readFileSync(join(PUB, 'app.js'), 'utf8');
const html = readFileSync(join(PUB, 'index.html'), 'utf8');
const css = readFileSync(join(PUB, 'styles.css'), 'utf8');
const sw = readFileSync(join(PUB, 'sw.js'), 'utf8');
const apiJs = readFileSync(join(ROOT, 'lib', 'api.js'), 'utf8');
const engJs = readFileSync(join(PUB, 'coins-engine.js'), 'utf8');

ok(appJs.includes('const GS = (typeof window !== \'undefined\' && window.GS)'), 'клиент берёт звуковой движок из окна и имеет тихую заглушку');
ok(appJs.includes("GS.setEnabled(S.notify.gamesound !== false)"), 'тумблер «Звук в играх» управляет движком (настройка личная, сервер о ней не знает)');
ok(appJs.includes("$('#game-sound').addEventListener('change'"), 'тумблер звука игр живёт в настройках рядом со звуком сообщений');
ok(appJs.includes('GS.ensure();') && appJs.includes('primeNotifySound(); GS.ensure();'), 'первое касание отпирает звук игр (браузер разрешает звук только после жеста)');

// музыка карт: старт в поиске, стоп везде, кнопка «выключить музыку»
ok(appJs.includes('GS.startMusic(S.coinsLive.gen.mapIdx)') && appJs.includes('GS.stopMusic()'),
  'музыка стартует в поиске по номеру карты и замолкает вне забега');
ok(appJs.includes('id="coins-music"') && appJs.includes('GS.toggleMusicPref()'),
  'в панели забега — кнопка «выключить музыку»; выбор запоминается на устройстве');
ok(appJs.includes('if (gameRulesOf(c) !== \'coins\') GS.stopMusic();'), 'ушёл из забега в другую игру — музыка замолкает');

// письмо игры → сигнал у клиента
ok(appJs.includes('function playGameSounds') && appJs.includes('GS.letterSound(p, false)'),
  'озвучка чужих писем партии: ход, выстрел, попадание — только когда доска открыта');
ok(appJs.includes('playGameSounds(freshAll); notifyNewMessages(freshAll);'),
  'озвучка писем вызывается из синхронизации рядом с уведомлениями');
ok(appJs.includes('GS.play(GS.letterSound(payload, true));'), 'мой ход и мой выстрел звучат сразу, не дожидаясь сервера');

// пункт 10: открытый чат не сигналит
ok(appJs.includes('m.chat !== openId') && appJs.includes('const openId = document.hidden ? null : S.view;'),
  'морской бой под рукой: письма открытого чата не дают ни звука, ни плашки — смотрю на карту, не отвлекают');

// сигнал конца партии — один раз
ok(appJs.includes('function gameEndSound') && appJs.includes('S.sndEnd'),
  'финал партии (победа/поражение/ничья) звучит один раз на устройство');
ok(appJs.includes('function boardEndKey'), 'ключ конца партии считается честно: статус, мат, «весь флот потоплен»');

// пункт 1: бонус одноразовый
ok(engJs.includes('function simulate') && engJs.includes('bgot') && engJs.includes('bonusIdxAt'),
  'движок: бонус подбирается один раз — часы нельзя «фармить» повторными заходами');
ok(appJs.includes('CE.bonusIdxAt(L.gen, nx, ny)') && appJs.includes('L.bgot.push(bi)'),
  'клиент: подобранный бонус отмечается и больше не срабатывает');
ok(appJs.includes('if (bgot && !L.reveal) return;'), 'подобранная иконка исчезает с карты — как собранная монета');
ok(appJs.includes('bgot ? 0.22 : 0.8'), 'на раскрытии подобранные артефакты еле видны, неподообранные — отчётливо');

// пункт 3: мгновенный выход
ok(appJs.includes('function leaveGameNow') && appJs.includes("const LEAVE_Q = 'sega.leaving80'"),
  'выход из законченной игры мгновенный: чат уходит с устройства сразу');
ok(appJs.includes('async function fireLeaveGame') && appJs.includes('function retryLeavingGames'),
  'сервер стирает игру следом в спокойном режиме; не долетевший запрос досылается');
ok(appJs.includes('const leavingNow = leavingGet();') && appJs.includes('S.chats = S.chats.filter(x => !leavingNow.includes(x.id))'),
  'пока сервер не подтвердил выход, игра не всплывает обратно в списке');
ok(appJs.includes('if (kind === \'close\' || kind === \'viewer\') { leaveGameNow(c); return; }'),
  'законченная партия и место зрителя покидаются без ожидания ответа сервера');

// пункт 4: конец раунда — вся карта и «Следующий раунд» (pkg3-82: свой темп)
ok(appJs.includes('id="coins-next"') && appJs.includes('Следующий раунд'),
  'после раунда — кнопка «Следующий раунд», включающая следующий раунд лично у игрока (pkg3-82)');
ok(appJs.includes('class="coins-miss"') && appJs.includes('Не собрано:'),
  'на раскрытой карте честно посчитаны несобранные монеты и артефакты');
ok(css.includes('.coins-miss{') && css.includes('.coins-waitall{'), 'плашки «не собрано» и «ждём остальных» оформлены');

// пункт 2: первый финишировавший ждёт остальных
ok(appJs.includes('Вы закончили все раунды') && appJs.includes('Остальные игроки ещё ищут'),
  'закончил раньше всех — видна отметка, что остальные ещё играют (pkg3-82: темп у каждого личный)');
ok(appJs.includes('Новый забег компанией можно начать только через «+»'),
  'новая игра компанией — только через «+» (никакой кнопки «начать снова» у компании)');
ok(appJs.includes("if (phase === 'final' && cs.solo) acts") && appJs.includes("if (phase === 'final' && !cs.solo) acts"),
  '«начать снова» остаётся только в соло-забеге');

// пункт 7: финал — автоматически таблица вместо карты
ok(appJs.includes('coins-final-table') && appJs.includes('Итоги забега'),
  'когда все закончили, вместо карты автоматически появляется таблица итогов');
ok(appJs.includes('const showStage = phase !== \'out\' && (phase !== \'final\' || !!(cs.solo && S.coinsLive));'),
  'в финале компании карта не рисуется — только итоги и победитель; pkg3-82: соло-финал открывается картой последнего раунда');
ok(!appJs.includes('Карта последнего раунда'), 'pkg3-79 «карта последнего раунда» в финале заменена таблицей (пункт 7)');

// пункт 8: управление пальцем по карте, крестовина убрана
ok(appJs.includes('function coinsDragBind') && appJs.includes('const TH = 14;'),
  'палец в любое место карты и в сторону — фигура идёт, пока палец не отпущен');
ok(!appJs.includes('class="coins-pad"') && !css.includes('.coins-pad{'),
  'нарисованных кнопок «влево/вправо/вверх/вниз» больше нет ни в разметке, ни в стилях');
ok(appJs.includes('COINS_KEYS') && appJs.includes('ArrowUp'), 'на ПК управление с клавиатуры: стрелки и WASD');

// пункт 9: название
ok(appJs.includes("coins: 'Сталкер'") && !appJs.includes("'Монеты · соло'"),
  'pkg3-83: игра зовётся «Сталкер» — внутренности прежние (id coins, письма coins-*), старые чаты живы');
ok(appJs.includes('data-ng-rules="${r}"') && appJs.includes("gameIconImg(r, 'gimg-ng')"),
  'pkg3-83: в окне «Новая игра» — плитки игр с иконками владельца');
ok(apiJs.includes('«Сталкер»: есть новости забега'), 'pkg3-83: пуш сервера говорит «Сталкер»');

// инварианты выпуска
ok(appJs.includes("const BUILD = 'pkg3-92';") && apiJs.includes("const BUILD = 'pkg3-92';"),
  'BUILD pkg3-92 совпадает в клиенте и на сервере');
ok(sw.includes("const STATIC_CACHE = 'sega-static-v85';"), 'кэш статики поднят до v85');
ok(html.includes('<script src="game-sound.js"></script>'), 'game-sound.js подключён в index.html');
ok(appJs.split("gamePlayerName(g.white) + ' и ' + gamePlayerName(g.black)").length - 1 === 2,
  'инвариант run-all: союз «и» в заголовках партий встречается ровно дважды');

console.log('\n──────────────────────────────────────────────────');
console.log(`  sound80: ${good} ✓, провалов ${bad}`);
console.log('──────────────────────────────────────────────────\n');
if (bad) { console.log('ЕСТЬ ПРОВАЛЫ'); process.exit(1); }
