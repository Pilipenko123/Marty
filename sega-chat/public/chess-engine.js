'use strict';
/**
 * SEGA-CHAT · шахматный движок (pkg3-20). Полные правила, ноль зависимостей.
 *
 * Позиция — массив из 64 клеток (0 = a1 … 63 = h8), фигуры — буквы:
 * белые P N B R Q K, чёрные в нижнем регистре; пусто — null.
 * Ход: { from: 'e2', to: 'e4', promo: 'q'|'r'|'b'|'n'|null }.
 *
 * Корректность доказывается перф-тестами (test/chess-perft.mjs):
 * эталонные количества узлов из начальной позиции и тестовых позиций.
 */
(function (glob) {
  const FILES = 'abcdefgh';
  const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const idx = (f, r) => r * 8 + f;
  const fileOf = (i) => i & 7;
  const rankOf = (i) => i >> 3;
  const sqName = (i) => FILES[fileOf(i)] + (rankOf(i) + 1);
  const sqParse = (s) => idx(FILES.indexOf(s[0]), Number(s[1]) - 1);
  const isWhite = (p) => p === p.toUpperCase();

  function parseFen(fen) {
    const p = String(fen || START_FEN).trim().split(/\s+/);
    const board = new Array(64).fill(null);
    let r = 7, f = 0;
    for (const ch of p[0]) {
      if (ch === '/') { r--; f = 0; continue; }
      if (ch >= '1' && ch <= '8') { f += Number(ch); continue; }
      board[idx(f, r)] = ch; f++;
    }
    const cq = p[2] || '-';
    return {
      board,
      turn: p[1] === 'b' ? 'b' : 'w',
      cast: { wK: cq.includes('K'), wQ: cq.includes('Q'), bK: cq.includes('k'), bQ: cq.includes('q') },
      ep: p[3] && p[3] !== '-' ? sqParse(p[3]) : -1,
      half: Number(p[4] || 0),
      full: Number(p[5] || 1)
    };
  }

  function toFen(st) {
    let out = '';
    for (let r = 7; r >= 0; r--) {
      let empty = 0;
      for (let f = 0; f < 8; f++) {
        const p = st.board[idx(f, r)];
        if (!p) { empty++; continue; }
        if (empty) { out += empty; empty = 0; }
        out += p;
      }
      if (empty) out += empty;
      if (r) out += '/';
    }
    const cq = (st.cast.wK ? 'K' : '') + (st.cast.wQ ? 'Q' : '') + (st.cast.bK ? 'k' : '') + (st.cast.bQ ? 'q' : '');
    return [out, st.turn, cq || '-', st.ep >= 0 ? sqName(st.ep) : '-', st.half, st.full].join(' ');
  }

  const KNIGHT_D = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
  const KING_D = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  const ROOK_D = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const BISH_D = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

  /** Бьётся ли клетка sq стороной by ('w'|'b'). */
  function isAttacked(board, sq, by) {
    const pawn = by === 'w' ? 'P' : 'p';
    const dr = by === 'w' ? -1 : 1;                 // пешки бьют «вверх» по своему направлению
    for (const df of [-1, 1]) {
      const f = fileOf(sq) + df, r = rankOf(sq) + dr;
      if (f >= 0 && f < 8 && r >= 0 && r < 8 && board[idx(f, r)] === pawn) return true;
    }
    const kn = by === 'w' ? 'N' : 'n', kg = by === 'w' ? 'K' : 'k';
    for (const [df, dr2] of KNIGHT_D) {
      const f = fileOf(sq) + df, r = rankOf(sq) + dr2;
      if (f >= 0 && f < 8 && r >= 0 && r < 8 && board[idx(f, r)] === kn) return true;
    }
    for (const [df, dr2] of KING_D) {
      const f = fileOf(sq) + df, r = rankOf(sq) + dr2;
      if (f >= 0 && f < 8 && r >= 0 && r < 8 && board[idx(f, r)] === kg) return true;
    }
    const ray = (dirs, chars) => {
      for (const [df, dr2] of dirs) {
        let f = fileOf(sq) + df, r = rankOf(sq) + dr2;
        while (f >= 0 && f < 8 && r >= 0 && r < 8) {
          const p = board[idx(f, r)];
          if (p) {
            if (isWhite(p) === (by === 'w') && chars.includes(p.toUpperCase())) return true;
            break;
          }
          f += df; r += dr2;
        }
      }
      return false;
    };
    return ray(ROOK_D, 'RQ') || ray(BISH_D, 'BQ');
  }

  function kingSq(board, color) {
    const k = color === 'w' ? 'K' : 'k';
    return board.indexOf(k);
  }

  function pseudoMoves(st) {
    const out = [];
    const white = st.turn === 'w';
    const push = (from, to, extra) => out.push(Object.assign({ from, to, promo: null }, extra || {}));
    for (let i = 0; i < 64; i++) {
      const p = st.board[i];
      if (!p || isWhite(p) !== white) continue;
      const f = fileOf(i), r = rankOf(i);
      const U = p.toUpperCase();
      if (U === 'P') {
        const dr = white ? 1 : -1;
        const start = white ? 1 : 6, last = white ? 7 : 0;
        const one = idx(f, r + dr);
        if (r + dr >= 0 && r + dr < 8 && !st.board[one]) {
          if (r + dr === last) for (const pr of ['q', 'r', 'b', 'n']) push(i, one, { promo: pr });
          else {
            push(i, one);
            const two = idx(f, r + 2 * dr);
            if (r === start && !st.board[two]) push(i, two, { double: true });
          }
        }
        for (const df of [-1, 1]) {
          const nf = f + df, nr = r + dr;
          if (nf < 0 || nf > 7 || nr < 0 || nr > 7) continue;
          const t = idx(nf, nr);
          const victim = st.board[t];
          if (victim && isWhite(victim) !== white) {
            if (nr === last) for (const pr of ['q', 'r', 'b', 'n']) push(i, t, { promo: pr });
            else push(i, t);
          } else if (t === st.ep && !victim) {
            push(i, t, { ep: true });
          }
        }
      } else if (U === 'N' || U === 'K') {
        for (const [df, dr] of (U === 'N' ? KNIGHT_D : KING_D)) {
          const nf = f + df, nr = r + dr;
          if (nf < 0 || nf > 7 || nr < 0 || nr > 7) continue;
          const t = idx(nf, nr);
          if (st.board[t] && isWhite(st.board[t]) === white) continue;
          push(i, t);
        }
        if (U === 'K') {
          const home = white ? 0 : 56;
          if (i === home + 4) {
            const rights = st.cast;
            const opp = white ? 'b' : 'w';
            if (rights[white ? 'wK' : 'bK'] && !st.board[home + 5] && !st.board[home + 6]
              && st.board[home + 7] === (white ? 'R' : 'r')
              && !isAttacked(st.board, home + 4, opp) && !isAttacked(st.board, home + 5, opp) && !isAttacked(st.board, home + 6, opp)) {
              push(i, home + 6, { castle: 'K' });
            }
            if (rights[white ? 'wQ' : 'bQ'] && !st.board[home + 3] && !st.board[home + 2] && !st.board[home + 1]
              && st.board[home] === (white ? 'R' : 'r')
              && !isAttacked(st.board, home + 4, opp) && !isAttacked(st.board, home + 3, opp) && !isAttacked(st.board, home + 2, opp)) {
              push(i, home + 2, { castle: 'Q' });
            }
          }
        }
      } else {
        const dirs = U === 'R' ? ROOK_D : U === 'B' ? BISH_D : ROOK_D.concat(BISH_D);
        for (const [df, dr] of dirs) {
          let nf = f + df, nr = r + dr;
          while (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) {
            const t = idx(nf, nr);
            if (st.board[t]) {
              if (isWhite(st.board[t]) !== white) push(i, t);
              break;
            }
            push(i, t);
            nf += df; nr += dr;
          }
        }
      }
    }
    return out;
  }

  function applyMove(st, m) {
    const b = st.board.slice();
    const p = b[m.from];
    const white = isWhite(p);
    const captured = m.ep ? b[m.to + (white ? -8 : 8)] : b[m.to];
    if (m.ep) b[m.to + (white ? -8 : 8)] = null;
    b[m.to] = m.promo ? (white ? m.promo.toUpperCase() : m.promo) : p;
    b[m.from] = null;
    if (m.castle) {
      const home = white ? 0 : 56;
      if (m.castle === 'K') { b[home + 5] = b[home + 7]; b[home + 7] = null; }
      else { b[home + 3] = b[home]; b[home] = null; }
    }
    const cast = Object.assign({}, st.cast);
    if (p === 'K') { cast.wK = false; cast.wQ = false; }
    if (p === 'k') { cast.bK = false; cast.bQ = false; }
    for (const [sq, key] of [[0, 'wQ'], [7, 'wK'], [56, 'bQ'], [63, 'bK']]) {
      if (m.from === sq || m.to === sq) cast[key] = false;
    }
    return {
      board: b,
      turn: st.turn === 'w' ? 'b' : 'w',
      cast,
      ep: m.double ? (m.from + m.to) / 2 : -1,
      half: (p.toUpperCase() === 'P' || captured) ? 0 : st.half + 1,
      full: st.turn === 'b' ? st.full + 1 : st.full,
      last: { from: m.from, to: m.to }
    };
  }

  /** Легальные ходы без SAN — для перфта, статусов и внутренних проверок. */
  function legalMovesRaw(st) {
    const me = st.turn, opp = me === 'w' ? 'b' : 'w';
    const out = [];
    for (const m of pseudoMoves(st)) {
      const next = applyMove(st, m);
      if (!isAttacked(next.board, kingSq(next.board, me), opp)) out.push(m);
    }
    return out;
  }

  function legalMoves(st) {
    const out = legalMovesRaw(st);
    for (const m of out) m.san = toSan(st, out, m);   // SAN для отображения в чате
    return out;
  }

  function toSan(st, legal, m) {
    if (m.castle) return m.castle === 'K' ? 'O-O' : 'O-O-O';
    const p = st.board[m.from];
    const U = p.toUpperCase();
    const capture = !!st.board[m.to] || !!m.ep;
    let s = '';
    if (U === 'P') {
      if (capture) s += FILES[fileOf(m.from)];
      s += sqName(m.to);
      if (m.promo) s += '=' + m.promo.toUpperCase();
    } else {
      s += U;
      const twins = legal.filter(x => x !== m && st.board[x.from] === p && x.to === m.to);
      if (twins.length) {
        const sameFile = twins.some(x => fileOf(x.from) === fileOf(m.from));
        const sameRank = twins.some(x => rankOf(x.from) === rankOf(m.from));
        if (!sameFile) s += FILES[fileOf(m.from)];
        else if (!sameRank) s += String(rankOf(m.from) + 1);
        else s += sqName(m.from);
      }
      if (capture) s += 'x';
      s += sqName(m.to);
    }
    const next = applyMove(st, m);
    const oppMoves = legalMovesRaw(next);
    const inCheck = isAttacked(next.board, kingSq(next.board, next.turn), st.turn);
    if (inCheck) s += oppMoves.length ? '+' : '#';
    return s;
  }

  function status(st) {
    const moves = legalMovesRaw(st);
    const check = isAttacked(st.board, kingSq(st.board, st.turn), st.turn === 'w' ? 'b' : 'w');
    if (!moves.length) return check ? 'checkmate' : 'stalemate';
    if (st.half >= 100) return 'draw50';
    return check ? 'check' : 'playing';
  }

  function perft(st, depth) {
    if (depth === 0) return 1;
    const moves = legalMovesRaw(st);
    if (depth === 1) return moves.length;
    let n = 0;
    for (const m of moves) n += perft(applyMove(st, m), depth - 1);
    return n;
  }

  function createChess(fen) {
    let st = parseFen(fen);
    return {
      fen: () => toFen(st),
      turn: () => st.turn,
      board: () => st.board.slice(),
      lastMove: () => (st.last ? { from: sqName(st.last.from), to: sqName(st.last.to) } : null),
      isCheck: () => isAttacked(st.board, kingSq(st.board, st.turn), st.turn === 'w' ? 'b' : 'w'),
      status: () => status(st),
      legalMoves: () => legalMoves(st).map(m => ({ from: sqName(m.from), to: sqName(m.to), promo: m.promo, san: m.san })),
      apply(move) {
        const ms = legalMoves(st);
        const m = ms.find(x => sqName(x.from) === move.from && sqName(x.to) === move.to
          && (x.promo || null) === (move.promo || null));
        if (!m) return null;
        const san = m.san;
        st = applyMove(st, m);
        return san;
      },
      perft: (d) => perft(st, d),
      _state: () => st
    };
  }

  glob.createChess = createChess;
  glob.CHESS_START_FEN = START_FEN;
  if (typeof module !== 'undefined' && module.exports) module.exports = { createChess, START_FEN, parseFen, toFen, perft, legalMoves, applyMove, isAttacked, kingSq, sqName, sqParse };
})(typeof window !== 'undefined' ? window : globalThis);
