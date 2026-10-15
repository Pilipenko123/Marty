/**
 * pkg3-56: «Морской бой» — проверки движка и разбора партии.
 * Запуск: node test/seabattle.mjs
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const SBMOD = require('../public/seabattle-engine.js');
const { createSeabattle, SB } = SBMOD;

let n = 0, bad = 0;
const ok = (cond, name) => {
  n++;
  if (cond) console.log('  ✓ ' + name);
  else { bad++; console.log('  ✗ ' + name); }
};
const sha = t => createHash('sha256').update(t).digest('hex');

console.log('── морской бой: расстановка ──');
{
  const f = [];
  ok(SB.canPlace(f, 0, 0, 4, true), 'линкор у левого края помещается');
  f.push({ x: 0, y: 0, len: 4, horiz: true });
  ok(!SB.canPlace(f, 0, 1, 1, false), 'вплотную под линкором ставить нельзя');
  ok(!SB.canPlace(f, 4, 0, 1, false), 'справа вплотную нельзя');
  ok(!SB.canPlace(f, 4, 1, 1, false), 'углом касаться нельзя');
  ok(SB.canPlace(f, 5, 2, 1, false), 'через клетку — можно');
  ok(!SB.canPlace(f, 8, 0, 4, true), 'за краем поля — нельзя');
  ok(!SB.canPlace(f, 0, 9, 2, false), 'вниз за край — нельзя');
}
{
  let good = 0;
  for (let i = 0; i < 300; i++) {
    const f = SB.randomFleet();
    const cells = SB.fleetCells(f);
    const lens = f.map(s => s.len).sort().join(',');
    if (f.length === 10 && cells.size === 20 && lens === '1,1,1,1,2,2,2,3,3,4') good++;
  }
  ok(good === 300, 'случайная расстановка всегда полна и без касаний (300 попыток)');
}
{
  const a = [{ x: 3, y: 3, len: 2, horiz: true }, { x: 0, y: 0, len: 4, horiz: false }];
  const b = [{ x: 0, y: 0, len: 4, horiz: false }, { x: 3, y: 3, len: 2, horiz: true }];
  ok(SB.canon(a, 's1') === SB.canon(b, 's1'), 'печать не зависит от порядка кораблей');
  ok(SB.canon(a, 's1') !== SB.canon(a, 's2'), 'соль меняет печать');
}

console.log('── морской бой: разбор партии ──');
const fleetW = SB.randomFleet();
const fleetB = SB.randomFleet();
const saltW = 'w-salt', saltB = 'b-salt';
const commitW = sha(SB.canon(fleetW, saltW));
const commitB = sha(SB.canon(fleetB, saltB));

function play() {
  const eng = createSeabattle();
  const send = (p, side) => eng.apply(p, side);
  send({ k: 'sb-commit', commit: commitW }, 'w');
  send({ k: 'sb-commit', commit: commitB }, 'b');
  return { eng, send };
}
{
  const e1 = createSeabattle();
  e1.apply({ k: 'sb-commit', commit: commitW }, 'w');
  ok(e1.status() === 'placing', 'до обеих печатей — расстановка');
  const e2 = createSeabattle();
  e2.apply({ k: 'sb-commit', commit: commitW }, 'w');
  e2.apply({ k: 'sb-shot', x: 0, y: 0 }, 'w');
  ok(e2._state().shots.length === 0 && e2.status() === 'placing', 'выстрел до готовности обоих не принимается');
}
{
  // промах передаёт ход, попадание оставляет выстрел
  const { eng, send } = play();
  // найдём клетку вне флота b и клетку внутри
  const inB = SB.fleetCells(fleetB);
  let missCell = null, hitCell = null;
  for (let y = 0; y < 10 && (!missCell || !hitCell); y++) for (let x = 0; x < 10; x++) {
    if (inB.has(SB.ck(x, y))) { if (!hitCell) hitCell = { x, y }; }
    else if (!missCell) missCell = { x, y };
  }
  ok(eng.turn() === 'w', 'первым стреляет «белый»');
  send({ k: 'sb-shot', x: missCell.x, y: missCell.y }, 'w');
  ok(eng.pendingShot() !== null, 'выстрел висит до ответа');
  send({ k: 'sb-shot', x: 1, y: 1 }, 'w');
  ok(eng.pendingShot().x === missCell.x, 'второй выстрел подряд не принимается');
  send({ k: 'sb-reply', x: missCell.x, y: missCell.y, r: 'miss' }, 'b');
  ok(eng.turn() === 'b', 'после промаха ход перешёл');
  send({ k: 'sb-shot', x: hitCell.x, y: hitCell.y }, 'b');   // b стреляет по полю w
  send({ k: 'sb-reply', x: hitCell.x, y: hitCell.y, r: 'miss' }, 'w');
  ok(eng.turn() === 'w', 'ответ «мимо» вернул ход белому');
  send({ k: 'sb-shot', x: hitCell.x, y: hitCell.y }, 'w');
  send({ k: 'sb-reply', x: hitCell.x, y: hitCell.y, r: 'hit' }, 'b');
  ok(eng.turn() === 'w', 'после «ранил» стреляет тот же игрок');
  ok(eng.viewOf('b').hits === 1, 'попадание учтено на поле соперника');
  ok(eng.viewOf('b').grid[hitCell.y * 10 + hitCell.x] === 'hit', 'клетка помечена попаданием');
  ok(eng.viewOf('b').grid[missCell.y * 10 + missCell.x] === 'miss', 'промах помечен точкой');
}
{
  // потопление: ореол становится промахами, победа после 20 попаданий
  const { eng, send } = play();
  const ships = fleetB.slice().sort((a, b) => a.len - b.len);
  let shots = 0;
  for (const s of ships) {
    const cells = SB.shipCells(s);
    for (const c of cells) {
      send({ k: 'sb-shot', x: c.x, y: c.y }, 'w');
      shots++;
      const last = c === cells[cells.length - 1];
      send({ k: 'sb-reply', x: c.x, y: c.y, r: last ? 'sunk' : 'hit', cells: cells.map(k => SB.ck(k.x, k.y)), aura: SB.auraOf(s) }, 'b');
    }
  }
  ok(shots === 20, 'на полный флот ушло ровно 20 попаданий');
  ok(eng.status() === 'over' && eng.winner() === 'w', 'все корабли потоплены — белый победил');
  const v = eng.viewOf('b');
  ok(v.sunk.length === 10, 'десять потопленных кораблей в разборе');
  const auraMarks = v.grid.filter(g => g === 'miss').length;
  ok(auraMarks > 0, 'ореол вокруг потопленных помечен точками');
  send({ k: 'sb-reveal', fleet: fleetB, salt: saltB }, 'b');
  send({ k: 'sb-reveal', fleet: fleetW, salt: saltW }, 'w');
  const okB = SB.checkReveal(eng.revealOf('b'), eng.commitOf('b'), sha(SB.canon(fleetB, saltB)), eng._state().shots.filter(s => s.side === 'w' && s.r));
  ok(okB === true, 'вскрытие совпало с печатью и с попаданиями');
  const lie = SB.checkReveal({ fleet: fleetW, salt: 'чужая-соль' }, eng.commitOf('b'), sha(SB.canon(fleetW, 'чужая-соль')), []);
  ok(lie === false, 'чужой флот под своей печатью не проходит');
}
{
  // повторный выстрел в ту же клетку игнорируется (у каждого игрока своё поле обстрела)
  const { eng, send } = play();
  send({ k: 'sb-shot', x: 5, y: 5 }, 'w');
  send({ k: 'sb-reply', x: 5, y: 5, r: 'miss' }, 'b');
  send({ k: 'sb-shot', x: 4, y: 4 }, 'b');
  send({ k: 'sb-reply', x: 4, y: 4, r: 'miss' }, 'w');
  send({ k: 'sb-shot', x: 5, y: 5 }, 'w');   // сюда белый уже стрелял
  ok(eng._state().shots.length === 2, 'повторный выстрел в клетку не принимается');
  ok(eng.viewOf('w').hits === 0 && eng.viewOf('b').hits === 0, 'лишних попаданий не появилось');
}
{
  // ответ не от того игрока и не на тот выстрел игнорируется
  const { eng, send } = play();
  send({ k: 'sb-shot', x: 2, y: 2 }, 'w');
  send({ k: 'sb-reply', x: 2, y: 2, r: 'miss' }, 'w');   // сам себе ответить нельзя
  ok(eng.pendingShot() !== null && eng.turn() === 'w', 'сам себе ответить нельзя');
  send({ k: 'sb-reply', x: 3, y: 3, r: 'miss' }, 'b');   // не на ту клетку
  ok(eng.pendingShot() !== null, 'ответ не на ту клетку игнорируется');
  send({ k: 'sb-reply', x: 2, y: 2, r: 'miss' }, 'b');
  ok(eng.pendingShot() === null && eng.turn() === 'b', 'верный ответ закрывает выстрел');
}
{
  // список ходов: строки приходят на ответах
  const { eng, send } = play();
  send({ k: 'sb-shot', x: 9, y: 9 }, 'w');
  const l1 = send({ k: 'sb-reply', x: 9, y: 9, r: 'miss' }, 'b');
  ok(l1 === 'w|к10 — мимо', 'строка списка: промах');
  const inB = [...SB.fleetCells(fleetB)][0].split(',').map(Number);
  send({ k: 'sb-shot', x: inB[0], y: inB[1] }, 'b');
  const l2 = send({ k: 'sb-reply', x: inB[0], y: inB[1], r: 'hit' }, 'w');
  ok(/^b\|.+— ранил! выстрел ещё раз$/.test(l2 || ''), 'строка списка: попадание');
}

console.log('── морской бой: открытый режим (pkg3-58) ──');
function playOpen(fw = fleetW, fb = fleetB) {
  const eng = createSeabattle();
  const send = (p, side) => eng.apply(p, side);
  send({ k: 'sb-commit', commit: sha(SB.canon(fw, saltW)), fleet: fw, salt: saltW }, 'w');
  send({ k: 'sb-commit', commit: sha(SB.canon(fb, saltB)), fleet: fb, salt: saltB }, 'b');
  return { eng, send };
}
{
  const { eng } = playOpen();
  ok(eng.openMode() === true, 'печати с флотами включают открытый режим');
  ok(!!eng.fleetOf('w') && eng.fleetOf('w').fleet.length === 10, 'флот стороны w известен движку');
  ok(eng.fleetOf('w').salt === saltW, 'соль печати сохранена вместе с флотом');
}
{
  // мгновенный разбор: ответ без письма sb-reply
  const { eng, send } = playOpen();
  const v0 = eng.viewOf('b');
  let miss = null;
  for (let y = 0; y < 10 && !miss; y++) for (let x = 0; x < 10; x++) if (!v0.grid[y * 10 + x] && !SB.shipAt(fleetB, x, y)) { miss = { x, y }; break; }
  const l1 = send({ k: 'sb-shot', x: miss.x, y: miss.y }, 'w');
  ok(eng.pendingShot() === null && l1 !== null, 'выстрел решён мгновенно: строка списка есть, ожидания ответа нет');
  ok(eng.turn() === 'b', 'промах в открытом режиме передаёт ход');
  // теперь стреляет b — по флоту w; клетка берётся из флота w (ранение)
  const cell = SB.shipCells(fleetW[0])[0];
  const l2 = send({ k: 'sb-shot', x: cell.x, y: cell.y }, 'b');
  ok(/— ранил! выстрел ещё раз$/.test(l2 || '') && eng.turn() === 'b', 'ранил — стрелявший ходит ещё раз (без письма-ответа)');
}
{
  // потопление: клетки и ореол появляются из разбора, а не из письма
  const { eng, send } = playOpen();
  const ship = fleetB.find(s => s.len === 1) || fleetB[fleetB.length - 1];
  const cells = SB.shipCells(ship);
  const l = send({ k: 'sb-shot', x: cells[0].x, y: cells[0].y }, 'w');
  ok(/— потопил!$/.test(l || ''), 'однопалубник потоплен одним выстрелом (строка сразу)');
  const v = eng.viewOf('b');
  ok(v.grid[cells[0].y * 10 + cells[0].x] === 'sunk', 'клетка потопленного помечена');
  const aura = SB.auraOf(ship);
  ok(aura.every(k => { const [x, y] = k.split(',').map(Number); return v.grid[y * 10 + x] === 'miss'; }), 'ореол вокруг потопленного проставился сам');
  const st = eng._state().shots[0];
  ok(Array.isArray(st.cells) && st.cells.length === cells.length && Array.isArray(st.aura), 'в записи выстрела есть клетки корабля и ореол');
}
{
  // победа в открытом режиме: топим весь флот b одними выстрелами w
  const { eng, send } = playOpen();
  const order = [];
  for (const s of fleetB) for (const c of SB.shipCells(s)) order.push(c);
  let last = null;
  for (const c of order) {
    if (eng.winner()) break;
    last = send({ k: 'sb-shot', x: c.x, y: c.y }, 'w');
    // после промаха ход перешёл бы к b — в этом флоте промахов нет (стреляем по клеткам)
  }
  ok(eng.status() === 'over' && eng.winner() === 'w', 'победа за 20 попаданий без единого письма-ответа');
  ok(eng.hitsOn('b') === 20, 'все 20 клеток флота b учтены');
  const after = send({ k: 'sb-shot', x: 0, y: 0 }, 'w');
  ok(after === null, 'после победы выстрелы не принимаются');
}
{
  // смешанная партия: одна печать старая (без флота) — прежний протокол
  const eng = createSeabattle();
  eng.apply({ k: 'sb-commit', commit: commitW }, 'w');                       // старый клиент
  eng.apply({ k: 'sb-commit', commit: commitB, fleet: fleetB, salt: saltB }, 'b');
  ok(eng.openMode() === false, 'если хоть одна печать без флота — режим прежний');
  eng.apply({ k: 'sb-shot', x: 1, y: 1 }, 'w');
  ok(eng.pendingShot() !== null, 'выстрел ждёт письма-ответа, как раньше');
  eng.apply({ k: 'sb-reply', x: 1, y: 1, r: SB.shipAt(fleetB, 1, 1) ? 'hit' : 'miss' }, 'b');
  ok(eng.pendingShot() === null, 'ответ закрыл выстрел');
}
{
  // мусорный флот в печати игнорируется
  const eng = createSeabattle();
  eng.apply({ k: 'sb-commit', commit: 'x', fleet: [{ x: 0, y: 0, len: 9, horiz: true }], salt: 's' }, 'w');
  const eng2 = createSeabattle();
  eng2.apply({ k: 'sb-commit', commit: 'x', fleet: fleetW.slice(0, 9), salt: 's' }, 'w');   // девять кораблей
  const eng3 = createSeabattle();
  const touch = fleetW.slice(); touch[9] = { x: touch[0].x, y: touch[0].y + 1, len: 1, horiz: true };  // вплотную к линкору
  eng3.apply({ k: 'sb-commit', commit: 'x', fleet: touch, salt: 's' }, 'w');
  ok(eng.fleetOf('w') === null && eng2.fleetOf('w') === null && eng3.fleetOf('w') === null,
    'неполный, несуществующий и касающийся флот в печати игнорируются (остаются ответы)');
}
{
  // лишний sb-reply в открытом режиме игнорируется (старое устройство могло дослать)
  const { eng, send } = playOpen();
  const v0 = eng.viewOf('b');
  let miss = null;
  for (let y = 0; y < 10 && !miss; y++) for (let x = 0; x < 10; x++) if (!v0.grid[y * 10 + x] && !SB.shipAt(fleetB, x, y)) { miss = { x, y }; break; }
  send({ k: 'sb-shot', x: miss.x, y: miss.y }, 'w');
  const dup = send({ k: 'sb-reply', x: miss.x, y: miss.y, r: 'sunk', cells: ['0,0', '1,0', '2,0', '3,0'], aura: [] }, 'b');
  ok(dup === null && eng._state().shots.length === 1 && eng._state().shots[0].r === 'miss',
    'поздний ответ с враньём («потопил») в открытом режиме игнорируется');
}
{
  // идентичность режимов: одна и та же партия в открытом и прежнем режиме
  const seq = [];
  const v0 = eng => eng.viewOf('b');
  {
    const eng = createSeabattle();
    eng.apply({ k: 'sb-commit', commit: commitW, fleet: fleetW, salt: saltW }, 'w');
    eng.apply({ k: 'sb-commit', commit: commitB, fleet: fleetB, salt: saltB }, 'b');
    let side = 'w';
    for (let i = 0; i < 60 && !eng.winner(); i++) {
      const def = SB.other(side);
      const fleet = def === 'b' ? fleetB : fleetW;
      const v = eng.viewOf(def);
      let cell = null;
      for (let y = 0; y < 10 && !cell; y++) for (let x = 0; x < 10; x++) if (!v.grid[y * 10 + x]) { cell = { x, y }; break; }
      if (!cell) break;
      eng.apply({ k: 'sb-shot', x: cell.x, y: cell.y }, side);
      seq.push([side, cell.x, cell.y]);
      if (eng.turn() !== side) side = eng.turn();
      if (eng.winner()) { var openLog = eng.log().join('\n'), openWinner = eng.winner(); break; }
    }
    if (!openLog) { openLog = eng.log().join('\n'); openWinner = eng.winner(); }
  }
  {
    // та же последовательность через прежний протокол (выстрел + ответ устройства)
    const eng = createSeabattle();
    eng.apply({ k: 'sb-commit', commit: commitW }, 'w');
    eng.apply({ k: 'sb-commit', commit: commitB }, 'b');
    for (const [side, x, y] of seq) {
      eng.apply({ k: 'sb-shot', x, y }, side);
      const def = SB.other(side);
      const fleet = def === 'b' ? fleetB : fleetW;
      const ship = SB.shipAt(fleet, x, y);
      let r = 'miss', cells = null, aura = null;
      if (ship) {
        const v = eng.viewOf(def);
        const hits = new Set();
        for (let i = 0; i < 100; i++) if (v.grid[i] === 'hit' || v.grid[i] === 'sunk') hits.add(i % 10 + ',' + Math.floor(i / 10));
        hits.add(x + ',' + y);
        if (SB.isSunk(ship, hits)) { r = 'sunk'; cells = SB.shipCells(ship).map(c => c.x + ',' + c.y); aura = SB.auraOf(ship); }
        else r = 'hit';
      }
      eng.apply({ k: 'sb-reply', x, y, r, cells, aura }, def);
    }
    ok(eng.log().join('\n') === openLog, 'открытый и прежний режимы дают одинаковый список ходов');
    ok(eng.winner() === openWinner, 'победитель в обоих режимах один и тот же');
  }
}
{
  // значок честности без письма вскрытия: флот из печати сверяется с хэшем
  const { eng } = playOpen();
  const rev = eng.fleetOf('b');
  const shots = eng._state().shots.filter(s => s.side === 'w' && s.r);
  ok(SB.checkReveal(rev, eng.commitOf('b'), sha(SB.canon(rev.fleet, rev.salt)), shots) === true,
    'флот из печати проходит сверку честности (checkReveal) без sb-reveal');
}

console.log('');
console.log(bad ? `ПРОВАЛ: ${bad} из ${n}` : `все проверки пройдены: ${n}`);
process.exit(bad ? 1 : 0);
