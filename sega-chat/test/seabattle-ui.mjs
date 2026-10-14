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

console.log('\n──────────────────────────────────────────────────');
console.log(`  Морской бой (интерфейс): ${good} ✓, провалов ${bad}`);
console.log('──────────────────────────────────────────────────\n');
dom.window.close();
srv.kill('SIGTERM');
clearTimeout(watchdog);
process.exit(bad ? 1 : 0);
