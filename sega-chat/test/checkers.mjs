/**
 * pkg3-41: движок русских шашек и русская запись шахматных ходов.
 * Запуск: node test/checkers.mjs
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const CK = require('../public/checkers-engine.js');
const CH = require('../public/chess-engine.js');
const { createCheckers, startPos, sqParse, playable } = CK;
const { rusSan, PIECE_RUS } = CH;

let bad = 0, good = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ПРОВАЛ: ') + m); if (c) good++; else bad++; };

console.log('\n══════════════════════════════════════════════════');
console.log('  Шашки (русские): правила и запись ходов');
console.log('══════════════════════════════════════════════════');

/** Позиция из списка «клетка: фигура». 'w'/'b' — шашки, 'W'/'B' — дамки. */
function pos(map, turn) {
  const board = new Array(64).fill(null);
  for (const k of Object.keys(map)) board[sqParse(k)] = map[k];
  return { board, turn: turn || 'w' };
}
const sans = eng => eng.legalMoves().map(m => m.san).sort();

// ── начальная расстановка
{
  const c = createCheckers();
  const b = c.board();
  ok(b.filter(p => p === 'w').length === 12, 'начальная позиция: 12 белых шашек');
  ok(b.filter(p => p === 'b').length === 12, 'начальная позиция: 12 чёрных шашек');
  ok(b.every(p => !p || p === 'w' || p === 'b'), 'дамк в начале нет');
  ok(b.every((p, i) => !p || playable(i)), 'шашки стоят только на «тёмных» клетках');
  ok(c.legalMoves().length === 7, 'первый ход белых: ровно 7 вариантов');
  ok(c.turn() === 'w' && c.status() === 'playing', 'партия начинается: ход белых, статус playing');
  ok(startPos().board[0] === null, 'угловая клетка a1 пустая (не игровая)');
}

// ── тихий ход и запись
{
  const c = createCheckers();
  ok(c.apply({ from: 'd3', to: 'c4' }) === 'd3-c4', 'тихий ход d3-c4 принят и так записан');
  ok(c.turn() === 'b', 'после хода белых очередь чёрных');
  ok(c.board()[sqParse('d3')] === null && c.board()[sqParse('c4')] === 'w', 'шашка переехала с d3 на c4');
  ok(c.apply({ from: 'd3', to: 'c4' }) === null, 'повторить тот же ход нельзя (шашки там уже нет)');
  ok(c.apply({ from: 'g6', to: 'f5' }) === 'g6-f5', 'чёрные отвечают g6-f5');
  const lm = c.lastMove();
  ok(lm && lm.from === 'g6' && lm.to === 'f5' && lm.path.join(',') === 'g6,f5',
    'lastMove помнит последний ход и путь (подсветка на доске)');
  ok(c.legalMoves().every(m => !m.promo), 'в середине доски шашка не становится дамкой');
}

// ── простая шашка: ходит только вперёд, бьёт в обе стороны
{
  const c = createCheckers(pos({ d3: 'w' }));
  ok(sans(c).join(',') === 'd3-c4,d3-e4', 'простая шашка ходит только вперёд (d3-c4, d3-e4)');
  const f = createCheckers(pos({ d3: 'w', e4: 'b' }));
  ok(sans(f).join(',') === 'd3:f5', 'есть взятие — тихие ходы запрещены: только d3:f5');
  ok(f.apply({ from: 'd3', to: 'c2' }) === null, 'простая шашка назад не ходит');
  ok(f.apply({ from: 'd3', to: 'e4' }) === null, 'на занятую клетку ходить нельзя');
  const back = createCheckers(pos({ f5: 'w', e4: 'b' }));
  ok(sans(back).includes('f5:d3'), 'простая шашка бьёт назад');
}

// ── взятие обязательно, когда оно есть
{
  const c = createCheckers(pos({ c2: 'w', e2: 'w', b3: 'b', d3: 'b' }));
  const list = sans(c);
  ok(list.length === 3 && list.every(s => s.includes(':')), 'все легальные ходы — взятия (тихих нет)');
  const c2 = createCheckers(pos({ d3: 'w', g6: 'b' }));
  ok(sans(c2).length > 0 && sans(c2).every(s => !s.includes(':')), 'взятий нет — доступны обычные ходы');
}

// ── цепочка взятий одним ходом, прервать нельзя
{
  const c = createCheckers(pos({ b1: 'w', c2: 'b', e4: 'b', g6: 'b' }));
  const list = sans(c);
  ok(list.length === 1 && list[0] === 'b1:d3:f5:h7', 'цепочка из трёх взятий пишется одним ходом');
  const san = c.apply({ from: 'b1', to: 'h7', path: ['b1', 'd3', 'f5', 'h7'] });
  ok(san === 'b1:d3:f5:h7', 'цепочка принята с точным путём');
  const b = c.board();
  ok(b.filter(p => p === 'b').length === 0, 'все три чёрные шашки сняты');
  ok(b.filter(p => p === 'w' || p === 'W').length === 1, 'белая шашка осталась одна');
  const c2 = createCheckers(pos({ b1: 'w', c2: 'b', e4: 'b', g6: 'b' }));
  ok(c2.apply({ from: 'b1', to: 'd3' }) === null, 'прервать цепочку на середине нельзя');
}

// ── одну и ту же шашку нельзя перепрыгнуть дважды
{
  const c = createCheckers(pos({ d3: 'w', e4: 'b' }));
  ok(sans(c).join(',') === 'd3:f5', 'нет хода «по кругу» через уже сбитую шашку (только d3:f5)');
}

// ── любую цепочку можно выбрать: правила «бить максимум» нет
{
  const c = createCheckers(pos({ d3: 'w', c2: 'b', e4: 'b', g6: 'b' }));
  const list = sans(c);
  ok(list.length === 2 && list.includes('d3:b1') && list.includes('d3:f5:h7'),
    'одиночное и двойное взятие на выбор — оба законны');
}

// ── дамка: ход и взятие на любое расстояние
{
  const c = createCheckers(pos({ b1: 'W' }));
  ok(c.legalMoves().length === 7, 'дамка на пустой доске ходит на 7 клеток по диагонали');
  const d = createCheckers(pos({ b1: 'W', e4: 'b' }));
  const list = sans(d);
  ok(list.length === 3 && list.includes('b1:f5') && list.includes('b1:g6') && list.includes('b1:h7'),
    'дамка бьёт стоящую вдалеке шашку и садится за ней куда хочет (f5/g6/h7)');
  const blocked = createCheckers(pos({ b1: 'W', d3: 'b', e4: 'b' }));
  ok(sans(blocked).every(s => !s.includes(':')), 'две шашки подряд дамка перепрыгнуть не может');
}

// ── превращение в дамку
{
  const c = createCheckers(pos({ d7: 'w' }));
  const list = c.legalMoves();
  ok(list.length === 2 && list.every(m => m.promo), 'ход в последний ряд помечен как превращение');
  ok(c.apply({ from: 'd7', to: 'c8' }) === 'd7-c8', 'ход в дамки принят');
  ok(c.board()[sqParse('c8')] === 'W', 'белая шашка в последнем ряду стала дамкой');
  const e = createCheckers(pos({ c2: 'b' }, 'b'));
  e.apply({ from: 'c2', to: 'b1' });
  ok(e.board()[sqParse('b1')] === 'B', 'чёрная шашка в первом ряду стала чёрной дамкой');
}

// ── дамка из взятия и цепочка с превращением посреди хода
{
  const c = createCheckers(pos({ e6: 'w', f7: 'b' }));
  ok(sans(c).join(',') === 'e6:g8', 'шашка бьёт в последний ряд — единственное e6:g8');
  c.apply({ from: 'e6', to: 'g8' });
  ok(c.board()[sqParse('g8')] === 'W', 'после взятия в последнем ряду — дамка');
  const e = createCheckers(pos({ e6: 'w', d7: 'b', b7: 'b' }));
  ok(sans(e).join(',') === 'e6:c8:a6', 'стала дамкой посреди цепочки и добила дальше (e6:c8:a6)');
  e.apply({ from: 'e6', to: 'a6', path: ['e6', 'c8', 'a6'] });
  ok(e.board()[sqParse('a6')] === 'W' && e.board()[sqParse('c8')] === null, 'дамка остановилась на a6, промежуточная c8 пуста');
  ok(e.board().filter(p => p === 'b').length === 0, 'обе чёрные шашки сняты');
}

// ── дамка бьёт простую шашку, простая бьёт дамку
{
  const c = createCheckers(pos({ c2: 'W', d3: 'b' }));
  ok(sans(c).includes('c2:e4'), 'дамка бьёт простую шашку');
  const d = createCheckers(pos({ c2: 'w', d3: 'B' }));
  ok(sans(d).includes('c2:e4'), 'простая шашка бьёт дамку');
}

// ── конец партии: нет шашек или нет ходов
{
  const c = createCheckers(pos({ d3: 'w' }, 'b'));
  ok(c.status() === 'over', 'у чёрных нет шашек — партия решена');
  const d = createCheckers(pos({ c2: 'b', b1: 'W', d1: 'W' }, 'b'));
  ok(d.status() === 'over', 'чёрные заперты — ходов нет, партия решена (пата в шашках нет)');
  const e = createCheckers(pos({ d3: 'w', g6: 'b' }));
  ok(e.status() === 'playing', 'есть и шашки, и ходы — партия идёт');
}

// ── партия целиком: запись ходов и реплей из истории (как в чате)
{
  // Живая партия с настоящим взятием и цепочкой из двух прыжков (h5:f7:d5).
  // Пути цепочек берём из самих ходов — так же их присылает история чата.
  const line = [
    ['f3', 'g4'], ['c6', 'b5'], ['e2', 'f3'], ['b5', 'a4'],
    ['d1', 'e2'], ['a6', 'b5'], ['g4', 'f5'], ['e6', 'g4'],
    ['f3', 'h5'], ['f7', 'e6'], ['h5', 'd5'], ['b5', 'c4']
  ];
  const c = createCheckers();
  const played = [], usedPaths = [];
  for (const [f, t] of line) {
    const m = c.legalMoves().find(x => x.from === f && x.to === t);
    if (!m) break;
    usedPaths.push(m.path);
    played.push(c.apply({ from: f, to: t, path: m.path }));
  }
  ok(played.length === 12, 'двенадцать ходов живой партии легли без отказа');
  ok(played[7] === 'e6:g4' && played[8] === 'f3:h5', 'обмен взятиями: e6:g4 и f3:h5');
  ok(played[10] === 'h5:f7:d5', 'цепочка из двух взятий записана одним ходом: h5:f7:d5');
  // реплей: те же ходы приезжают «из истории чата» строками записи
  const replay = createCheckers();
  const again = [];
  for (const s of played) {
    const path = s.split(s.includes(':') ? ':' : '-');
    again.push(replay.apply({ from: path[0], to: path[path.length - 1], path }));
  }
  ok(again.every(Boolean) && again.join('|') === played.join('|'), 'реплей по записи даёт ту же партию');
  ok(replay.board().join(',') === c.board().join(','), 'позиции после реплея совпадают клетка в клетку');
  ok(usedPaths.every((p, i) => p[0] === line[i][0] && p[p.length - 1] === line[i][1]),
    'путь каждого хода начинается и кончается там, куда шли');
}

console.log('\n══════════════════════════════════════════════════');
console.log('  Шахматы: русские названия фигур в записи ходов');
console.log('══════════════════════════════════════════════════');

ok(PIECE_RUS.K === 'Король' && PIECE_RUS.Q === 'Ферзь' && PIECE_RUS.R === 'Ладья'
  && PIECE_RUS.B === 'Слон' && PIECE_RUS.N === 'Конь',
  'полные русские названия: Король, Ферзь, Ладья, Слон, Конь');
ok(rusSan('Nf3') === 'Конь f3', 'Nf3 → Конь f3');
ok(rusSan('Bxe5') === 'Слон : e5', 'Bxe5 → Слон : e5');
ok(rusSan('Rxd8') === 'Ладья : d8', 'Rxd8 → Ладья : d8');
ok(rusSan('Qh5') === 'Ферзь h5', 'Qh5 → Ферзь h5');
ok(rusSan('Kc1') === 'Король c1', 'Kc1 → Король c1');
ok(rusSan('e4') === 'e4', 'пешечный ход остаётся коротким: e4');
ok(rusSan('ed5') === 'e : d5', 'взятие пешкой: ed5 → e : d5');
ok(rusSan('e8=Q') === 'e8 = Ферзь', 'превращение: e8=Q → e8 = Ферзь');
ok(rusSan('de8=Q') === 'd : e8 = Ферзь', 'взятие с превращением: de8=Q → d : e8 = Ферзь');
ok(rusSan('O-O') === 'Короткая рокировка', 'O-O → Короткая рокировка');
ok(rusSan('O-O-O') === 'Длинная рокировка', 'O-O-O → Длинная рокировка');
ok(rusSan('Nf3+') === 'Конь f3 +', 'шах остаётся знаком «+»');
ok(rusSan('Qh5#') === 'Ферзь h5 #', 'мат остаётся знаком «#»');
ok(rusSan('O-O-O#') === 'Длинная рокировка #', 'рокировка с матом');
ok(rusSan('Rad1') === 'Ладья a d1', 'уточнение линией: Rad1 → Ладья a d1');
ok(rusSan('N1f3') === 'Конь 1 f3', 'уточнение рангом: N1f3 → Конь 1 f3');
ok(rusSan('Qh4e1') === 'Ферзь h4 e1', 'уточнение клеткой: Qh4e1 → Ферзь h4 e1');
ok(rusSan('c3-d4') === 'c3-d4', 'шашечная запись проходит без изменений');
ok(rusSan('a1:c3:e5') === 'a1:c3:e5', 'шашечная цепочка проходит без изменений');
ok(rusSan('') === '', 'пустая запись не ломается');

// ── шахматный движок не пострадал: та же партия, что и в прошлых выпусках
{
  const { createChess } = CH;
  const c = createChess();
  const line = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'O-O', 'Nf6', 'd3', 'd6', 'Bg5', 'Bg4'];
  const got = line.map(s => {
    const m = c.legalMoves().find(x => x.san === s);
    return m ? c.apply({ from: m.from, to: m.to, promo: m.promo }) : null;
  });
  ok(got.every(Boolean) && got.join('|') === line.join('|'), 'старые шахматы играют ту же партию, что и раньше');
  ok(rusSan(got[6]) === 'Короткая рокировка', 'рокировка в списке ходов покажется по-русски');
  ok(c.perft(1) > 0, 'перфт шахматного движка живой');
}

console.log(bad ? '\nПРОВАЛОВ: ' + bad : '\n  Шашки и русские названия: все ' + good + ' проверок пройдены');
process.exit(bad ? 1 : 0);
