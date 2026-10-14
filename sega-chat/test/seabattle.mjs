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

console.log('');
console.log(bad ? `ПРОВАЛ: ${bad} из ${n}` : `все проверки пройдены: ${n}`);
process.exit(bad ? 1 : 0);
