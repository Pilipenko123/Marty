'use strict';
/**
 * SEGA-CHAT · движок «Морского боя» (pkg3-56). Классика с листочка в клеточку:
 * поле 10×10, флот из десяти кораблей (1×4, 2×3, 3×2, 4×1), корабли не касаются
 * друг друга даже углами. Попал — стреляешь ещё раз, промах — ход переходит.
 * Вокруг потопленного корабля клетки помечаются промахами автоматически
 * (как в бумажной игре обводят карандашом).
 *
 * Сервер правил не понимает (переписка сквозная), поэтому партия разбирается
 * здесь, из зашифрованных писем чата-игры:
 *   sb-commit  { commit }                  — флот расставлен и «запечатан» хэшем;
 *   sb-shot    { x, y }                    — выстрел по чужому полю;
 *   sb-reply   { x, y, r, cells, aura }    — автоматический ответ устройства,
 *                                            которое хранит флот: мимо / ранил /
 *                                            потопил (+ клетки корабля и ореол);
 *   sb-reveal  { fleet, salt }             — вскрытие флота в конце: сверяем с
 *                                            хэшем sb-commit (мухлевать нельзя).
 * Сам флот по сети до конца партии не ходит — живёт на устройстве, где его
 * расставили (как листочек в клеточку: свой листик носишь с собой).
 */
(function (glob) {
  const SIZE = 10;
  const COLS = ['а', 'б', 'в', 'г', 'д', 'е', 'ж', 'з', 'и', 'к'];
  const FLEET = [4, 3, 3, 2, 2, 2, 1, 1, 1, 1];
  const TOTAL_CELLS = 20;               // 4+3+3+2+2+2+1+1+1+1
  const SHIP_NAMES = { 1: 'шлюпка', 2: 'катер', 3: 'эсминец', 4: 'линкор' };

  const ck = (x, y) => x + ',' + y;
  const cellName = (x, y) => COLS[x] + (y + 1);
  const parseCell = s => ({ x: COLS.indexOf(String(s)[0]), y: Number(String(s).slice(1)) - 1 });
  const other = side => (side === 'w' ? 'b' : 'w');

  /** Клеты, занятые кораблём. */
  function shipCells(s) {
    const out = [];
    for (let i = 0; i < s.len; i++) out.push(s.horiz ? { x: s.x + i, y: s.y } : { x: s.x, y: s.y + i });
    return out;
  }
  function fleetCells(fleet) {
    const set = new Set();
    for (const s of fleet || []) for (const c of shipCells(s)) set.add(ck(c.x, c.y));
    return set;
  }
  /** Классика: корабль нельзя ставить вплотную к другому, даже углом. */
  function canPlace(fleet, x, y, len, horiz) {
    const cells = shipCells({ x, y, len, horiz });
    for (const c of cells) if (c.x < 0 || c.y < 0 || c.x >= SIZE || c.y >= SIZE) return false;
    const busy = fleetCells(fleet);
    for (const c of cells) {
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        if (busy.has(ck(c.x + dx, c.y + dy))) return false;
      }
    }
    return true;
  }
  /** Случайная расстановка полного флота (жадно: сначала крупные). */
  function randomFleet(rand) {
    const rnd = rand || Math.random;
    for (let attempt = 0; attempt < 200; attempt++) {
      const fleet = [];
      let ok = true;
      for (const len of FLEET.slice().sort((a, b) => b - a)) {
        let placed = false;
        for (let t = 0; t < 400 && !placed; t++) {
          const horiz = rnd() < 0.5;
          const x = Math.floor(rnd() * SIZE), y = Math.floor(rnd() * SIZE);
          if (canPlace(fleet, x, y, len, horiz)) { fleet.push({ x, y, len, horiz }); placed = true; }
        }
        if (!placed) { ok = false; break; }
      }
      if (ok) return fleet.sort((a, b) => (b.len - a.len) || (a.y - b.y) || (a.x - b.x));
    }
    return null;   // теоретически недостижимо
  }
  /** Каноническая строка флота для хэша-печати: порядок кораблей не важен. */
  function canon(fleet, salt) {
    const f = (fleet || []).map(s => [s.len, s.x, s.y, s.horiz ? 1 : 0])
      .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    return JSON.stringify({ f, s: String(salt || '') });
  }
  function shipAt(fleet, x, y) {
    for (const s of fleet || []) if (shipCells(s).some(c => c.x === x && c.y === y)) return s;
    return null;
  }
  /** Ореол вокруг корабля (соседи по сторонам и углам) — автопромахи при потоплении. */
  function auraOf(ship) {
    const out = new Set();
    const own = new Set(shipCells(ship).map(c => ck(c.x, c.y)));
    for (const c of shipCells(ship)) {
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const nx = c.x + dx, ny = c.y + dy;
        if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) continue;
        const k = ck(nx, ny);
        if (!own.has(k)) out.add(k);
      }
    }
    return [...out];
  }
  /** Полна ли уже пробоина: все клетки корабля под огнём. */
  function isSunk(ship, hitSet) {
    return shipCells(ship).every(c => hitSet.has(ck(c.x, c.y)));
  }

  /**
   * Разбор партии из ленты писем. apply(письмо, сторона-автор) возвращает строку
   * для списка ходов или null. Стороны: 'w' — стреляет первым, 'b' — вторым.
   *
   * pkg3-58: «открытый» режим. Печать sb-commit может нести сам флот
   * ({commit, fleet, salt}) — письмо зашифровано ключом чата, сервер его не
   * читает, а устройство соперника с этого момента считает ответы на выстрелы
   * САМО, мгновенно, не дожидаясь письма-ответа. Если хотя бы одна печать
   * пришла без флота (старая версия клиента), партия идёт прежним путём:
   * выстрел ждёт ответа sb-reply от устройства, где лежит флот. Оба режима
   * дают одинаковые результаты: ответ считается из одного и того же флота.
   */
  function createSeabattle() {
    const st = {
      commit: { w: null, b: null },
      fleet: { w: null, b: null },      // pkg3-58: { fleet, salt } из печати, если клиент новый
      reveal: { w: null, b: null },     // { fleet, salt }
      shots: [],                        // { side, x, y, r: null|'miss'|'hit'|'sunk', cells, aura }
      turn: 'w',
      winner: null,
      log: []
    };
    const boardOf = side => st.shots.filter(s => s.side === other(side) && s.r);  // выстрелы ПО стороне side
    const parseKey = k => { const [x, y] = String(k).split(',').map(Number); return { x, y }; };

    function viewOf(side) {
      // что известно о флоте стороны side: промахи, попадания, потопленные, ореолы
      const grid = new Array(SIZE * SIZE).fill(null);
      const sunk = [];
      for (const s of boardOf(side)) {
        if (s.r === 'miss') { if (!grid[s.y * SIZE + s.x]) grid[s.y * SIZE + s.x] = 'miss'; continue; }
        if (s.r === 'hit') { grid[s.y * SIZE + s.x] = 'hit'; continue; }
        if (s.r === 'sunk') {
          for (const k of (s.aura || [])) {
            const p = parseKey(k);
            if (!grid[p.y * SIZE + p.x]) grid[p.y * SIZE + p.x] = 'miss';
          }
          const cells = (s.cells || []).map(parseKey);
          for (const c of cells) grid[c.y * SIZE + c.x] = 'sunk';
          sunk.push({ cells, aura: (s.aura || []).map(parseKey) });
        }
      }
      // попадания считаем по РАЗНЫМ клеткам: клетки корабля до потопления
      // помечены 'hit', после — 'sunk', и дважды не считаются
      const hits = grid.reduce((n, g) => n + (g === 'hit' || g === 'sunk' ? 1 : 0), 0);
      return { grid, sunk, hits };
    }
    const hitsOn = side => viewOf(side).hits;

    function line(side, text) { const s = side + '|' + text; st.log.push(s); return s; }

    /** pkg3-58: флот из письма пригоден для мгновенных ответов только если он
     *  собран строго по правилам (иначе устройство отвечало бы «на глаз»). */
    function validFleet(fleet) {
      if (!Array.isArray(fleet) || fleet.length !== FLEET.length) return false;
      const want = FLEET.slice().sort((a, b) => a - b);
      const got = fleet.map(s => (s && Number.isInteger(s.len)) ? s.len : NaN).sort((a, b) => a - b);
      for (let i = 0; i < want.length; i++) if (got[i] !== want[i]) return false;
      const placed = [];
      for (const s of fleet) {
        if (!Number.isInteger(s.x) || !Number.isInteger(s.y) || typeof s.horiz !== 'boolean') return false;
        if (!canPlace(placed, s.x, s.y, s.len, s.horiz)) return false;
        placed.push({ x: s.x, y: s.y, len: s.len, horiz: s.horiz });
      }
      return true;
    }
    /** pkg3-58: мгновенный разбор выстрела по известному флоту обороняющегося.
     *  Тот же алгоритм, что на устройстве с флотом (sbAutoRespond), — поэтому
     *  «открытый» и прежний режимы всегда дают одинаковый ответ. */
    function resolveShot(shot, fleet) {
      const defSide = other(shot.side);
      const v = viewOf(defSide);
      const ship = shipAt(fleet, shot.x, shot.y);
      let r = 'miss';
      if (ship) {
        const hits = new Set();
        for (let i = 0; i < SIZE * SIZE; i++) {
          if (v.grid[i] === 'hit' || v.grid[i] === 'sunk') hits.add(ck(i % SIZE, Math.floor(i / SIZE)));
        }
        hits.add(ck(shot.x, shot.y));
        if (isSunk(ship, hits)) {
          r = 'sunk';
          shot.cells = shipCells(ship).map(c => ck(c.x, c.y));
          shot.aura = auraOf(ship);
        } else r = 'hit';
      }
      shot.r = r;
      if (r === 'miss') st.turn = defSide; else st.turn = shot.side;
      if (hitsOn(defSide) >= TOTAL_CELLS) st.winner = shot.side;
      const cn = cellName(shot.x, shot.y);
      return line(shot.side, r === 'miss' ? cn + ' — мимо'
        : r === 'hit' ? cn + ' — ранил! выстрел ещё раз'
          : cn + ' — потопил!');
    }
    /** pkg3-58: «открытый» режим — оба флота приехали с печатями. */
    const openMode = () => !!(st.fleet.w && st.fleet.b);

    function apply(p, side) {
      if (!p || typeof p !== 'object' || !p.k || !side) return null;
      if (p.k === 'sb-commit') {
        if (st.commit[side] || st.winner) return null;
        st.commit[side] = String(p.commit || '');
        // pkg3-58: печать нового клиента несёт сам флот — проверяем его по
        // правилам и запоминаем; мусорный флот игнорируется (партия остаётся
        // в прежнем режиме «выстрел — ответ»)
        if (Array.isArray(p.fleet) && validFleet(p.fleet)) {
          st.fleet[side] = {
            fleet: p.fleet.map(s => ({ x: s.x, y: s.y, len: s.len, horiz: !!s.horiz })),
            salt: String(p.salt || '')
          };
        }
        return line(side, 'флот расставлен и запечатан');
      }
      if (p.k === 'sb-shot') {
        if (status() !== 'playing' || st.turn !== side || st.winner) return null;
        const x = Number(p.x), y = Number(p.y);
        if (!(x >= 0 && y >= 0 && x < SIZE && y < SIZE)) return null;
        if (st.shots.some(s => s.side === side && s.x === x && s.y === y)) return null;  // туда уже стреляли
        if (st.shots.some(s => s.r === null)) return null;                              // предыдущий выстрел ещё без ответа
        const shot = { side, x, y, r: null, cells: null, aura: null };
        st.shots.push(shot);
        // pkg3-58: оба флота известны — устройство отвечает само, мгновенно
        if (openMode()) return resolveShot(shot, st.fleet[other(side)].fleet);
        return null;   // прежний режим: строка в списке появится вместе с ответом
      }
      if (p.k === 'sb-reply') {
        const pen = st.shots.find(s => s.r === null && s.side === other(side));
        if (!pen || pen.x !== Number(p.x) || pen.y !== Number(p.y)) return null;
        const r = p.r === 'hit' ? 'hit' : p.r === 'sunk' ? 'sunk' : 'miss';
        pen.r = r;
        pen.cells = Array.isArray(p.cells) ? p.cells.map(String) : null;
        pen.aura = Array.isArray(p.aura) ? p.aura.map(String) : null;
        if (r === 'miss') st.turn = side; else st.turn = other(side);
        if (hitsOn(side) >= TOTAL_CELLS) st.winner = other(side);
        const cn = cellName(pen.x, pen.y);
        return line(pen.side, r === 'miss' ? cn + ' — мимо'
          : r === 'hit' ? cn + ' — ранил! выстрел ещё раз'
            : cn + ' — потопил!');
      }
      if (p.k === 'sb-reveal') {
        if (st.reveal[side]) return null;
        st.reveal[side] = { fleet: Array.isArray(p.fleet) ? p.fleet : null, salt: String(p.salt || '') };
        return line(side, 'флот открыт для проверки');
      }
      return null;
    }

    const committed = side => !!st.commit[side];
    function status() {
      if (st.winner) return 'over';
      return (st.commit.w && st.commit.b) ? 'playing' : 'placing';
    }
    return {
      apply,
      status,
      turn: () => st.turn,
      winner: () => st.winner,
      committed,
      commits: () => ({ w: st.commit.w, b: st.commit.b }),
      commitOf: side => st.commit[side],
      fleetOf: side => st.fleet[side],        // pkg3-58: флот из печати (открытый режим)
      openMode,                               // pkg3-58: оба флота известны устройствам
      revealOf: side => st.reveal[side],
      viewOf,
      hitsOn,
      pendingShot: () => st.shots.find(s => s.r === null) || null,
      lastShot: () => { for (let i = st.shots.length - 1; i >= 0; i--) if (st.shots[i].r) return st.shots[i]; return null; },
      shotCount: side => st.shots.filter(s => s.side === side).length,
      legalShots() {
        if (status() !== 'playing' || st.winner || st.shots.some(s => s.r === null)) return [];
        const v = viewOf(other(st.turn));
        const out = [];
        for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) if (!v.grid[y * SIZE + x]) out.push({ x, y });
        return out;
      },
      log: () => st.log.slice(),
      board: () => new Array(64).fill(null),   // заглушка: общий код игр не падает
      lastMove: () => null,
      _state: () => st
    };
  }

  /** Сверка вскрытого флота с печатью и с тем, что настреляли по нему в партии. */
  function checkReveal(reveal, commit, hashHex, shotsAtFleet) {
    if (!reveal || !Array.isArray(reveal.fleet) || !commit) return false;
    if (hashHex !== commit) return false;
    const cells = fleetCells(reveal.fleet);
    if (cells.size !== TOTAL_CELLS) return false;
    for (const s of shotsAtFleet || []) {
      const k = ck(s.x, s.y);
      const inFleet = cells.has(k);
      if (s.r === 'miss' && inFleet) return false;
      if ((s.r === 'hit' || s.r === 'sunk') && !inFleet) return false;
      if (s.r === 'sunk') {
        const ship = shipAt(reveal.fleet, s.x, s.y);
        if (!ship) return false;
        const sc = shipCells(ship).map(c => ck(c.x, c.y)).sort().join(';');
        const pc = (s.cells || []).slice().sort().join(';');
        if (sc !== pc) return false;
      }
    }
    return true;
  }

  const SB = {
    SIZE, COLS, FLEET, TOTAL_CELLS, SHIP_NAMES,
    ck, cellName, parseCell, other,
    shipCells, fleetCells, canPlace, randomFleet, canon, shipAt, auraOf, isSunk, checkReveal
  };
  glob.createSeabattle = createSeabattle;
  glob.SB = SB;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Object.assign({ createSeabattle, SB }, SB);
  }
})(typeof window !== 'undefined' ? window : globalThis);
