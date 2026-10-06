/**
 * Перф-тесты шахматного движка: эталонные количества ходов-узлов.
 * Запуск: node test/chess-perft.mjs
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createChess } = require('../public/chess-engine.js');

let bad = 0, good = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ПРОВАЛ: ') + m); if (c) good++; else bad++; };

console.log('\n══════════════════════════════════════════════════');
console.log('  Шахматный движок: перф-тесты и правила');
console.log('══════════════════════════════════════════════════');

// ── начальная позиция
{
  const c = createChess();
  const expect = [20, 400, 8902, 197281];
  for (let d = 1; d <= 4; d++) {
    const n = c.perft(d);
    ok(n === expect[d - 1], `perft(${d}) начальной позиции: ${n} (эталон ${expect[d - 1]})`);
  }
}

// ── Kiwipete: рокировки, взятия, превращения-ish, богатая тактика
{
  const c = createChess('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1');
  const expect = [48, 2039, 97862];   // эталоны Grand Chess Tree (2025)
  for (let d = 1; d <= 3; d++) {
    const n = c.perft(d);
    ok(n === expect[d - 1], `perft(${d}) Kiwipete: ${n} (эталон ${expect[d - 1]})`);
  }
}

// ── пешечная позиция: взятие на проходе и превращения
{
  const c = createChess('8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1');
  const n = c.perft(4);
  ok(n === 43238, `perft(4) пешечной позиции: ${n} (эталон 43238)`);
}
{
  // позиция 5 из канонического набора: связи, взятия, рокировка под давлением
  const c = createChess('rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8');
  const expect = [44, 1486, 62379];
  for (let d = 1; d <= 3; d++) {
    const n = c.perft(d);
    ok(n === expect[d - 1], `perft(${d}) позиции 5: ${n} (эталон ${expect[d - 1]})`);
  }
}

// ── мат, пат, шах
{
  const c = createChess();
  for (const [f, t] of [['e2', 'e4'], ['e7', 'e5'], ['d1', 'h5'], ['b8', 'c6'], ['f1', 'c4'], ['g8', 'f6'], ['h5', 'f7']]) {
    ok(c.apply({ from: f, to: t }) !== null, `ход ${f}-${t} принят`);
  }
  ok(c.status() === 'checkmate', 'детский мат распознан как мат');
}
{
  const c = createChess('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
  ok(c.status() === 'stalemate', 'пат распознан');
}
{
  const c = createChess('rnbqkbnr/ppp2ppp/8/3pp3/4P3/5Q2/PPPP1PPP/RNB1KBNR w KQkq - 0 3');
  ok(c.status() === 'playing', 'обычная позиция — игра продолжается');
}

// ── рокировка под шахом и через битое поле запрещены
{
  const c = createChess('r3k2r/8/8/8/8/5q2/8/R3K2R w KQkq - 0 1');
  const ms = c.legalMoves();
  ok(!ms.some(m => m.from === 'e1' && (m.to === 'g1' || m.to === 'c1')), 'рокировка под боем запрещена');
}
{
  const c = createChess('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  const ms = c.legalMoves();
  ok(ms.some(m => m.from === 'e1' && m.to === 'g1') && ms.some(m => m.from === 'e1' && m.to === 'c1'),
    'рокировки в спокойной позиции доступны');
}

// ── взятие на проходе
{
  const c = createChess('4k3/8/8/8/1p6/8/2P5/4K3 w - - 0 1');
  ok(c.apply({ from: 'c2', to: 'c4' }) !== null, 'двойной шаг пешки');
  ok(c.apply({ from: 'b4', to: 'c3' }) !== null, 'взятие на проходе принято');
  ok(c.board()[c.board().indexOf('P')] === undefined || !c.board().includes('P'), 'срубленная на проходе пешка исчезла');
}

// ── превращение: четыре варианта
{
  const c = createChess('8/P6k/8/8/8/8/8/K7 w - - 0 1');
  const ms = c.legalMoves().filter(m => m.from === 'a7');
  ok(ms.filter(m => m.promo).length === 4, 'превращение предлагает четыре фигуры');
  ok(c.apply({ from: 'a7', to: 'a8', promo: 'q' }) !== null, 'превращение в ферзя применено');
  ok(c.board().includes('Q'), 'ферзь появился на доске');
}

// ── SAN
{
  const c = createChess();
  ok(c.apply({ from: 'g1', to: 'f3' }) === 'Nf3', 'SAN коня: Nf3');
  ok(c.apply({ from: 'd7', to: 'd5' }) === 'd5', 'SAN пешки: d5');
}

console.log('\n──────────────────────────────────────────────────');
console.log(`  Шахматный движок: ${good} ✓, провалов ${bad}`);
console.log('──────────────────────────────────────────────────\n');
process.exit(bad ? 1 : 0);
