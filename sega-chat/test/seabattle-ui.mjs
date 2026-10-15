/**
 * pkg3-56: дымовой тест ИНТЕРФЕЙСА морского боя в браузерной среде (jsdom).
 * Гоняет настоящие функции страницы (renderBoard, onSbCell, sbRandom…) на
 * подставном состоянии: расстановка, бой, конец партии со вскрытием флота.
 * Запуск: node test/seabattle-ui.mjs   (без jsdom честно пропускается)
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { webcrypto } from 'node:crypto';

let JSDOM, VirtualConsole;
try { ({ JSDOM, VirtualConsole } = await import('jsdom')); } catch {
  console.log('\n  Морской бой (интерфейс): пропущено (не установлен jsdom — выполните `npm install`)\n');
  process.exit(0);
}
const watchdog = setTimeout(() => { console.log('  ✗ ПРОВАЛ: завис дымовой тест морского боя'); process.exit(1); }, 90000);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9331 + Math.floor(Math.random() * 300);
const dir = mkdtempSync(join(tmpdir(), 'sega-sbui-'));
const srv = spawn(process.execPath, ['server.js'], {
  cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
  env: Object.assign({}, process.env, { PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dir, STORE: 'file', HTTPS: '' })
});
await new Promise(r => setTimeout(r, 1500));

let bad = 0, good = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ПРОВАЛ: ') + m); if (c) good++; else bad++; };
const sha = t => createHash('sha256').update(t).digest('hex');

console.log('\n══════════════════════════════════════════════════');
console.log('  Морской бой: интерфейс (jsdom)');
console.log('══════════════════════════════════════════════════');

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => errors.push('jsdomError: ' + ((e && e.message) || e)));
const dom = await JSDOM.fromURL('http://127.0.0.1:' + PORT + '/', {
  runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc,
  beforeParse(w) {
    w.addEventListener('error', e => errors.push('window.onerror: ' + (e.message || e)));
    try { Object.defineProperty(w, 'crypto', { value: webcrypto, configurable: true }); } catch (e) {}
    // jsdom не даёт matchMedia, а шторка чата его спрашивает при каждом renderBoard
    w.matchMedia = w.matchMedia || (q => ({ matches: false, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
  }
});
await new Promise(r => setTimeout(r, 2500));
const w = dom.window;
const ev = code => w.eval(code);

ok(errors.length === 0, 'страница с seabattle-engine.js не падает' + (errors[0] ? ' → ' + String(errors[0]).split('\n')[0] : ''));
ok(typeof w.createSeabattle === 'function' && !!w.SB, 'движок морского боя доступен странице');

// подставное состояние: я (me) и соперник (opp), партия морского боя
ev(`(function(){
  S.me = { id: 'me', name: 'Я' };
  S.users = [{ id: 'me', name: 'Я' }, { id: 'opp', name: 'Соперник' }];
  S.chats = [{ id: 'sb1', kind: 'game', ownerId: 'me', createdAt: Date.now(), members: ['me','opp'],
    roles: { me: 'player' }, keys: {}, knocks: [],
    game: { rules: 'seabattle', status: 'playing', invitee: null, white: 'me', black: 'opp', result: null } }];
  S.messages = []; S.plain = new Map(); S.view = 'sb1';
  S.histReady = true; S.warm = true; S.boardSig = '';
})()`);

// ── расстановка ──
ev('renderBoard()');
let doc = w.document;
ok(!!doc.querySelector('.sb-board.placing'), 'панель расстановки: поле 10×10 на месте');
ok(doc.querySelectorAll('.sb-board.placing .sbc').length === 100, 'в поле расстановки сто клеток');
ok(/В бой!/.test(doc.querySelector('.sb-panel').innerHTML), 'кнопка «В бой!» есть');
ok(/Повернуть: горизонтально/.test(doc.querySelector('.sb-panel').innerHTML), 'кнопка поворота с подписью стороны');

await ev(`onSbCell({ dataset: { sbcell: '0,0', sbboard: 'w' } })`);
ok(ev('sbPlace(S.chats[0]).fleet.length') === 1, 'касание клетки ставит линкор (первый в порядке)');
ok(ev('sbPlace(S.chats[0]).fleet[0].len') === 4, 'первым ставится четырёхпалубный линкор');
await ev(`onSbCell({ dataset: { sbcell: '1,1', sbboard: 'w' } })`);
ok(ev('sbPlace(S.chats[0]).fleet.length') === 1, 'вплотную к линкору корабль не встал');
await ev(`onSbCell({ dataset: { sbcell: '0,0', sbboard: 'w' } })`);
ok(ev('sbPlace(S.chats[0]).fleet.length') === 0, 'касание своего корабля возвращает его в запас');
ev('sbRandom(); ');
ok(ev('sbPlace(S.chats[0]).fleet.length') === 10, '«Случайно» расставляет все десять кораблей');
ev('S.boardSig=""; renderBoard();');
doc = w.document;
ok(doc.querySelectorAll('.sb-ship').length === 10, 'десять кораблей нарисованы спрайтами');
ok(!doc.querySelector('#sb-go').disabled, 'кнопка «В бой!» ожила после полной расстановки');

// ── бой: обе печати есть, ход мой ──
const fleetW = ev('sbPlace(S.chats[0]).fleet');
const fleetB = ev('SB.randomFleet()');
const commitW = sha(ev('SB.canon')(fleetW, 'sw'));
const commitB = sha(ev('SB.canon')(fleetB, 'sb'));
ev(`(function(){
  localStorage.setItem('sega.sb.sb1', JSON.stringify({ fleet: ${JSON.stringify(fleetW)}, salt: 'sw', commit: ${JSON.stringify(commitW)} }));
  delete S.sbPlace['sb1'];
  const msgs = [
    { id: 'm1', seq: 1, uid: 'me', ts: 1, chat: 'sb1', parent: null },
    { id: 'm2', seq: 2, uid: 'opp', ts: 2, chat: 'sb1', parent: null }
  ];
  S.plain.set('m1', { k: 'sb-commit', commit: ${JSON.stringify(commitW)} });
  S.plain.set('m2', { k: 'sb-commit', commit: ${JSON.stringify(commitB)} });
  S.messages = msgs; S.boardSig = '';
  renderBoard();
})()`);
doc = w.document;
ok(doc.querySelectorAll('.sbc.can').length === 100, 'в бою сто клеток соперника доступны для выстрела');
ok(/Ваш выстрел/.test(doc.querySelector('.bph-full').textContent), 'подпись состояния: «Ваш выстрел…»');
ok(/Поле соперника · Соперник/.test(doc.querySelector('.sb-panel').innerHTML), 'подпись чужого поля с именем соперника');

// выстрел и ответ «мимо» — точка на чужом поле
ev(`(function(){
  S.messages.push({ id: 'm3', seq: 3, uid: 'me', ts: 3, chat: 'sb1', parent: null });
  S.plain.set('m3', { k: 'sb-shot', x: 0, y: 0 });
  S.messages.push({ id: 'm4', seq: 4, uid: 'opp', ts: 4, chat: 'sb1', parent: null });
  S.plain.set('m4', { k: 'sb-reply', x: 0, y: 0, r: 'miss' });
  S.boardSig = ''; renderBoard();
})()`);
doc = w.document;
ok(doc.querySelectorAll('.sb-field .sb-dot').length >= 1, 'промах отмечен точкой');
ok(/к10 — мимо|а1 — мимо/.test(doc.querySelector('#game-moves').textContent), 'список ходов показывает выстрел и результат');

// ── pkg3-57: слои поля — взрывы поверх кораблей, потопленный чужой корабль виден ──
ok(ev(`(function(){
  let all = true;
  for (const b of document.querySelectorAll('.sb-board')) {
    if (b.lastElementChild.className !== 'sb-marks') all = false;
    const kids = [...b.children].map(x => x.className);
    if (kids.indexOf('sb-ships') > kids.lastIndexOf('sb-marks')) all = false;
  }
  return document.querySelectorAll('.sb-board').length === 2 && all;
})()`), 'слой отметок — последний: точки и взрывы рисуются поверх кораблей');

// соперник стреляет по моему полю: ранение — на МОЁМ поле виден корабль и взрыв поверх
const hitShip = ev(`(function(){
  const loc = JSON.parse(localStorage.getItem('sega.sb.sb1'));
  const s = loc.fleet.find(sh => !(sh.x === 0 && sh.y === 0));
  return SB.shipCells(s)[0];
})()`);
// моя пустая клетка для ответного промаха соперника
const missCell = ev(`(function(){
  const loc = JSON.parse(localStorage.getItem('sega.sb.sb1'));
  const busy = new Set();
  for (const sh of loc.fleet) for (const c of SB.shipCells(sh)) busy.add(c.x + ',' + c.y);
  for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) {
    const k = x + ',' + y;
    if (!busy.has(k) && !(x === ${hitShip.x} && y === ${hitShip.y})) return { x, y };
  }
  return null;
})()`);
// корабль соперника, который я топлю (не в клетке 0,0 — туда уже стреляли)
const sunkShip = ev(`(function(){
  const fleetB = ${JSON.stringify(fleetB)};
  const s = fleetB.find(sh => !SB.shipCells(sh).some(c => c.x === 0 && c.y === 0));
  return SB.shipCells(s).map(c => c.x + ',' + c.y);
})()`);
ev(`(function(){
  let seq = 4;
  const add = (uid, p) => { const id = 'b' + (++seq); S.messages.push({ id, seq, uid, ts: seq, chat: 'sb1', parent: null }); S.plain.set(id, p); };
  // соперник ранил мой корабль
  add('opp', { k: 'sb-shot', x: ${hitShip.x}, y: ${hitShip.y} });
  add('me', { k: 'sb-reply', x: ${hitShip.x}, y: ${hitShip.y}, r: 'hit' });
  // соперник промахнулся мимо — ход снова мой
  add('opp', { k: 'sb-shot', x: ${missCell.x}, y: ${missCell.y} });
  add('me', { k: 'sb-reply', x: ${missCell.x}, y: ${missCell.y}, r: 'miss' });
  // я топлю корабль соперника: все палубы подряд
  const cells = ${JSON.stringify(sunkShip)};
  for (let i = 0; i < cells.length; i++) {
    const [x, y] = cells[i].split(',').map(Number);
    const last = i === cells.length - 1;
    add('me', { k: 'sb-shot', x, y });
    add('opp', last
      ? { k: 'sb-reply', x, y, r: 'sunk', cells: cells, aura: [] }
      : { k: 'sb-reply', x, y, r: 'hit' });
  }
  S.boardSig = ''; renderBoard();
})()`);
doc = w.document;
{
  const fields = doc.querySelectorAll('.sb-field');
  const enemyF = fields[0], mineF = fields[1];
  ok(enemyF.querySelectorAll('.sb-ship').length === 1,
    'на чужом поле потопленный корабль нарисован спрайтом (до вскрытия флота)');
  ok(enemyF.querySelectorAll('.sb-marks .sb-boom').length === sunkShip.length,
    'взрывы по всему потопленному кораблю — поверх спрайта');
  ok(mineF.querySelectorAll('.sb-ship').length === 10, 'на моём поле видны все мои корабли');
  ok(mineF.querySelectorAll('.sb-marks .sb-boom').length === 1,
    'ранение моего корабля отмечено взрывом поверх спрайта');
  ok(doc.querySelectorAll('.sb-ship').length === 11, 'раненый, но не потопленный чужой корабль НЕ показан (11 = 10 моих + 1 потопленный чужой)');
}

// ── pkg3-57: выстрелы не живут в ленте чата ──
ok(ev(`(function(){
  const sb = { id: 'zz1', seq: 901, uid: 'opp', ts: 5, chat: 'sb1', parent: null };
  S.plain.set('zz1', { k: 'sb-shot', x: 1, y: 1 });
  const ev0 = { id: 'zz2', seq: 902, uid: 'opp', ts: 6, chat: 'sb1', parent: null };
  S.plain.set('zz2', { k: 'game-event', text: 'Партия началась' });
  const visShot = feedVisible(sb), visEvt = feedVisible(ev0);
  S.plain.delete('zz1'); S.plain.delete('zz2');
  return visShot === false && visEvt === true;
})()`), 'письмо выстрела скрыто из ленты, событие партии осталось видимым');
ok(ev(`unreadIn('sb1').total`) === 0, 'выстрелы соперника не считаются непрочитанными сообщениями');

// ── pkg3-57: быстрый опрос при открытой доске морского боя ──
ok(ev('SB_GAME_MS') === 2500, 'интервал опроса у доски морского боя — 2,5 с');
ok(ev('pollDelay()') === ev('SB_GAME_MS'), 'пока партия идёт и доска открыта, опрос частый (pollDelay = SB_GAME_MS)');

// ── конец партии: вскрытие и значок честности ──
ev(`(function(){
  // лента конца партии: выстрелы мои, ответы и вскрытие — соперника и мои
  S.messages = []; S.plain = new Map();
  let seq = 1;
  const add = (uid, p) => { const id = 'f' + (seq++); S.messages.push({ id, seq, uid, ts: seq, chat: 'sb1', parent: null }); S.plain.set(id, p); };
  add('me', { k: 'sb-commit', commit: ${JSON.stringify(commitW)} });
  add('opp', { k: 'sb-commit', commit: ${JSON.stringify(commitB)} });
  const fleetB = ${JSON.stringify(fleetB)};
  const ships = fleetB.slice().sort((a, b) => a.len - b.len);
  for (const s of ships) {
    const cells = SB.shipCells(s);
    for (let i = 0; i < cells.length; i++) {
      const last = i === cells.length - 1;
      add('me', { k: 'sb-shot', x: cells[i].x, y: cells[i].y });
      add('opp', { k: 'sb-reply', x: cells[i].x, y: cells[i].y, r: last ? 'sunk' : 'hit',
        cells: cells.map(k => k.x + ',' + k.y), aura: SB.auraOf(s) });
    }
  }
  add('opp', { k: 'sb-reveal', fleet: fleetB, salt: 'sb' });
  add('me', { k: 'sb-reveal', fleet: ${JSON.stringify(fleetW)}, salt: 'sw' });
  S.boardSig = ''; renderBoard();
})()`);
doc = w.document;
ok(/Победил Я/.test(doc.querySelector('.bph-full').textContent), 'в конце панели — «Победил Я»');
ok(doc.querySelectorAll('.sb-boom').length >= 20, 'попадания и потопления нарисованы взрывами');
await new Promise(r => setTimeout(r, 300));
ev('S.boardSig=""; renderBoard();');
doc = w.document;
ok(/флот соперника честен/.test(doc.querySelector('.sb-panel').innerHTML), 'вскрытый флот сверен с печатью: значок честности');
ok(/флот не совпал/.test(doc.querySelector('.sb-panel').innerHTML) === false, 'ложной тревоги о мухлеже нет');
ok(ev('S.sbPlaying') === false, 'после победы частый опрос выключен (S.sbPlaying = false)');
ok(ev('pollDelay()') !== ev('SB_GAME_MS'), 'на завершённой партии опрос снова обычный');

// ── pkg3-57: честные подписи «я / соперник» вместо «белые / чёрные» ──
ev('openNewGame()');
doc = w.document;
ok(!!doc.querySelector('#ng-rules'), 'окно «Новая игра» открылось');
ev(`(function(){ const s = $('#ng-rules'); s.value = 'seabattle'; s.dispatchEvent(new Event('change')); })()`);
{
  const lbl = ev(`$('#ng-color').parentElement.firstChild.nodeValue`);
  const opts = ev(`[...$('#ng-color').options].map(o => o.value + ':' + o.textContent).join('|')`);
  ok(lbl === 'Кто стреляет первым', 'у морского боя подпись вопроса — «Кто стреляет первым»');
  ok(opts.includes('white:Я стреляю первым') && opts.includes('black:Соперник стреляет первым'),
    'варианты ответа: «Я стреляю первым» / «Соперник стреляет первым» — без «белых» и «чёрных»');
  ok(opts.includes('choice:Пусть решит соперник'), 'вариант «Пусть решит соперник» на месте');
}
ev(`(function(){ const s = $('#ng-rules'); s.value = 'chess'; s.dispatchEvent(new Event('change')); })()`);
{
  const lbl = ev(`$('#ng-color').parentElement.firstChild.nodeValue`);
  const opts = ev(`[...$('#ng-color').options].map(o => o.value + ':' + o.textContent).join('|')`);
  ok(lbl === 'Ваш цвет' && opts.includes('white:Белые') && opts.includes('black:Чёрные'),
    'у шахмат подписи прежние: «Ваш цвет», «Белые», «Чёрные»');
}
ev("hide($('#modal'))");
{
  const card = ev(`(function(){
    S.invites = [{ id: 'g9', owner: 'opp', colorChoice: 'choice', createdAt: 1 }];
    return gamePayloadHtml({ k: 'game-invite', game: 'g9', to: 'me', colorChoice: 'choice', rules: 'seabattle', note: 'x' }, null);
  })()`);
  ok(/data-rules="seabattle"/.test(card), 'кнопка «Войти в игру» знает правила игры (data-rules)');
}

// ── pkg3-57: слепок флота возвращается на другое своё устройство ──
await ev(`(async function(){
  S.privRaw = new Uint8Array(32).fill(7);
  localStorage.removeItem('sega.sb.sb2');
  const loc = { fleet: SB.randomFleet(), salt: 'salt2' };
  loc.commit = await sbSha(SB.canon(loc.fleet, loc.salt));
  const key = await sbSelfKey();
  S.sbFleets = { sb2: await aesEncryptBytes(key, enc.encode(JSON.stringify(loc))) };
  await sbRestoreFleets();
})()`);
{
  const restored = ev(`JSON.parse(localStorage.getItem('sega.sb.sb2') || 'null')`);
  ok(!!restored && Array.isArray(restored.fleet) && restored.fleet.length === 10 && !!restored.commit,
    'флот из серверного слепка восстановлен на «другом устройстве» (10 кораблей + печать)');
}
await ev(`(async function(){
  localStorage.removeItem('sega.sb.sb3');
  const loc = { fleet: SB.randomFleet(), salt: 'salt3', commit: 'подделка' };
  const key = await sbSelfKey();
  S.sbFleets = Object.assign({}, S.sbFleets, { sb3: await aesEncryptBytes(key, enc.encode(JSON.stringify(loc))) });
  await sbRestoreFleets();
})()`);
ok(ev(`localStorage.getItem('sega.sb.sb3')`) === null, 'слепок, не совпавший с печатью, на устройство не попадает');

console.log('\n──────────────────────────────────────────────────');
console.log(`  Морской бой (интерфейс): ${good} ✓, провалов ${bad}`);
console.log('──────────────────────────────────────────────────\n');
dom.window.close();
srv.kill('SIGTERM');
clearTimeout(watchdog);
process.exit(bad ? 1 : 0);
