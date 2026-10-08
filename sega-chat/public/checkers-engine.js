'use strict';
/**
 * SEGA-CHAT · движок русских шашек (pkg3-41). Полные правила, ноль зависимостей.
 *
 * Позиция — массив из 64 клеток (0 = a1 … 63 = h8), играбельны «тёмные» клетки:
 * (файл + ранг) — нечётное число. Фигуры: 'w' — белая шашка, 'W' — белая дамка,
 * 'b' — чёрная шашка, 'B' — чёрная дамка; пусто — null. Белые ходят «вверх» (ранг +1).
 * Ход: { from: 'c3', to: 'd4' } — тихий; взятие: { from, to, path: ['c3','e5','g3'] },
 * где path — все клетки посадки цепочки по порядку (первая — откуда, последняя — to).
 *
 * Правила (русские шашки):
 *  • простая шашка ходит на одну клетку по диагонали вперёд, бьёт вперёд и назад;
 *  • взятие обязательно: есть хоть одно взятие — тихих ходов нет;
 *  • цепочка взятий делается одним ходом; сбитые шашки снимаются только после
 *    окончания хода — перепрыгнуть их повторно или встать на их клетку нельзя;
 *  • дойдя до последнего ряда, шашка становится дамкой; если это случилось
 *    посреди цепочки и дамкой можно бить дальше — цепочка продолжается;
 *  • дамка ходит и бьёт на любое расстояние по диагонали («летающая»):
 *    бьёт стоящую вдалеке шашку, садится на любую пустую клетку за ней
 *    и может продолжить цепочку;
 *  • выбирать можно любую цепочку (правила «бить максимум» в русских шашках нет);
 *  • нет ходов или нет шашек — поражение. Патовой ничьей нет.
 *
 * Корректность доказывается тестами (test/checkers.mjs).
 */
(function (glob) {
  const FILES = 'abcdefgh';
  const idx = (f, r) => r * 8 + f;
  const fileOf = i => i & 7;
  const rankOf = i => i >> 3;
  const sqName = i => FILES[fileOf(i)] + (rankOf(i) + 1);
  const sqParse = s => idx(FILES.indexOf(String(s)[0]), Number(String(s)[1]) - 1);
  const playable = i => ((fileOf(i) + rankOf(i)) % 2) === 1;   // «тёмные» клетки
  const DIAGS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  const colorOf = p => (p === 'w' || p === 'W') ? 'w' : 'b';
  const isKing = p => !!p && p === p.toUpperCase();
  const kingOf = c => (c === 'w' ? 'W' : 'B');
  const inB = (f, r) => f >= 0 && f < 8 && r >= 0 && r < 8;

  /** Начальная расстановка: 12 белых внизу (ранги 1–3), 12 чёрных вверху (6–8). */
  function startPos() {
    const board = new Array(64).fill(null);
    for (let r = 0; r < 3; r++) for (let f = 0; f < 8; f++) { const i = idx(f, r); if (playable(i)) board[i] = 'w'; }
    for (let r = 5; r < 8; r++) for (let f = 0; f < 8; f++) { const i = idx(f, r); if (playable(i)) board[i] = 'b'; }
    return { board, turn: 'w', last: null };
  }

  /** Все цепочки взятий фигуры на sq (перебор в глубину). Сбитые шашки до конца
   * цепочки остаются на доске (в списке captured) — на них нельзя встать,
   * и их нельзя перепрыгнуть ещё раз. */
  function captureChains(board, sq, white) {
    const out = [];
    const foe = white ? 'b' : 'w';
    const rec = (from, piece, b, captured, path) => {
      let cont = false;
      if (isKing(piece)) {
        for (const [df, dr] of DIAGS) {
          let f = fileOf(from) + df, r = rankOf(from) + dr, cap = -1;
          while (inB(f, r)) {
            const t = idx(f, r);
            if (b[t]) {
              // вторая фигура на луче, своя или уже сбитая этой цепочкой — стоп
              if (cap >= 0 || colorOf(b[t]) !== foe || captured.includes(t)) break;
              cap = t;
            } else if (cap >= 0) {
              // пустая клетка за сбитой — сюда можно сесть и попробовать продолжить
              cont = true;
              const nb = b.slice();
              nb[from] = null; nb[t] = piece;   // сбитую НЕ снимаем — она ещё на доске
              rec(t, piece, nb, captured.concat([cap]), path.concat([t]));
            }
            f += df; r += dr;
          }
        }
      } else {
        const lastRank = white ? 7 : 0;
        for (const [df, dr] of DIAGS) {
          const mf = fileOf(from) + df, mr = rankOf(from) + dr;
          const lf = fileOf(from) + 2 * df, lr = rankOf(from) + 2 * dr;
          if (!inB(mf, mr) || !inB(lf, lr)) continue;
          const mid = idx(mf, mr), land = idx(lf, lr);
          if (!b[mid] || colorOf(b[mid]) !== foe || captured.includes(mid)) continue;
          if (b[land]) continue;   // клетка посадки занята (в т.ч. «условно сбитой»)
          cont = true;
          const nb = b.slice();
          nb[from] = null;
          const np = lr === lastRank ? kingOf(colorOf(piece)) : piece;   // дамка — и посреди цепочки
          nb[land] = np;
          rec(land, np, nb, captured.concat([mid]), path.concat([land]));
        }
      }
      if (!cont && path.length > 1) out.push({ path, captured, board: b });
    };
    rec(sq, board[sq], board.slice(), [], [sq]);
    return out;
  }

  /** Легальные ходы позиции: если есть взятия — только они (взятие обязательно). */
  function legalMoves(st) {
    const b = st.board;
    const list = [];
    for (let i = 0; i < 64; i++) {
      const p = b[i];
      if (!p || colorOf(p) !== st.turn || !playable(i)) continue;
      for (const ch of captureChains(b, i, st.turn === 'w')) {
        list.push({ from: i, to: ch.path[ch.path.length - 1], path: ch.path, captured: ch.captured, board: ch.board });
      }
    }
    if (!list.length) {
      const white = st.turn === 'w';
      for (let i = 0; i < 64; i++) {
        const p = b[i];
        if (!p || colorOf(p) !== st.turn || !playable(i)) continue;
        if (isKing(p)) {
          for (const [df, dr] of DIAGS) {
            let f = fileOf(i) + df, r = rankOf(i) + dr;
            while (inB(f, r)) {
              const t = idx(f, r);
              if (b[t]) break;
              list.push({ from: i, to: t, path: [i, t], captured: [], board: null });
              f += df; r += dr;
            }
          }
        } else {
          const dr = white ? 1 : -1;
          for (const df of [-1, 1]) {
            const f = fileOf(i) + df, r = rankOf(i) + dr;
            if (!inB(f, r)) continue;
            const t = idx(f, r);
            if (!b[t]) list.push({ from: i, to: t, path: [i, t], captured: [], board: null });
          }
        }
      }
    }
    for (const m of list) {
      m.san = m.path.map(sqName).join(m.captured.length ? ':' : '-');
      m.promo = !m.captured.length && !isKing(b[m.from]) && rankOf(m.to) === (st.turn === 'w' ? 7 : 0);
    }
    return list;
  }

  function applyMove(st, m) {
    const b = m.board ? m.board.slice() : st.board.slice();
    if (m.captured.length) { for (const ci of m.captured) b[ci] = null; return { board: b, turn: st.turn === 'w' ? 'b' : 'w', last: { from: m.from, to: m.to, path: m.path.slice() } }; }
    const p = b[m.from];
    b[m.from] = null;
    const lastRank = st.turn === 'w' ? 7 : 0;
    b[m.to] = (!isKing(p) && rankOf(m.to) === lastRank) ? kingOf(st.turn) : p;
    return { board: b, turn: st.turn === 'w' ? 'b' : 'w', last: { from: m.from, to: m.to, path: m.path.slice() } };
  }

  /** 'playing' — партия идёт; 'over' — у стороны, чей ход, нет ходов (проигрыш). */
  function status(st) {
    return legalMoves(st).length ? 'playing' : 'over';
  }

  function createCheckers(setup) {
    let st = setup
      ? { board: setup.board.slice(), turn: setup.turn === 'b' ? 'b' : 'w', last: setup.last || null }
      : startPos();
    return {
      turn: () => st.turn,
      board: () => st.board.slice(),
      lastMove: () => (st.last
        ? { from: sqName(st.last.from), to: sqName(st.last.to), path: (st.last.path || [st.last.from, st.last.to]).map(sqName) }
        : null),
      status: () => status(st),
      legalMoves: () => legalMoves(st).map(m => ({
        from: sqName(m.from), to: sqName(m.to), path: m.path.map(sqName), san: m.san, promo: !!m.promo
      })),
      apply(move) {
        const ms = legalMoves(st);
        const want = (move && move.path && move.path.length > 1) ? move.path.map(sqParse) : null;
        const m = ms.find(x => x.from === sqParse(move.from) && x.to === sqParse(move.to)
          && (!want || (x.path.length === want.length && x.path.every((s, k) => s === want[k]))));
        if (!m) return null;
        const san = m.san;
        st = applyMove(st, m);
        return san;
      },
      _state: () => st
    };
  }

  glob.createCheckers = createCheckers;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { createCheckers, startPos, legalMoves, applyMove, status, captureChains, sqName, sqParse, playable, colorOf, isKing };
  }
})(typeof window !== 'undefined' ? window : globalThis);
