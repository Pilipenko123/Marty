'use strict';
/**
 * SEGA-CHAT · движок «coins» — «Золотая лихорадка» (pkg3-78, pkg3-80).
 * Золотая лихорадка с туманом войны:
 * поле 13×26 поверх карты-картинки, монеты одного достоинства, стены-лабиринт,
 * бонусы (компас, фонарь, песочные часы). Карт в комплекте ШЕСТЬ (img/
 * coins-map1..6.jpg) — порядок карт в забеге случайный, но одинаковый у всех: он,
 * как и раскладки, рождается из зерна (seed). Поэтому максимум раундов = 6.
 *
 * Раунды: каждый игрок стартует сам, когда удобно; таймер (по умолчанию
 * 3 минуты) идёт с личного старта. Кончилось время — раунд заканчивается
 * показом всей карты: несобранные монеты и артефакты видны, а дальше кнопка
 * «Далее» открывает следующий раунд (pkg3-80). Результат улетает
 * зашифрованным письмом coins-result. Другие устройства
 * перепроигрывают путь по той же карте (simulate) и сверяют счёт, финиш и
 * лимит времени — мухлевать нельзя. Раунд закрыт, когда результаты собрались
 * у всех НЕ сдавшихся игроков (или вышел срок ожидания CE.GRACE_MS).
 * Когда закрыт последний раунд — монеты суммируются, объявляется победитель.
 *
 * Письма игры:
 *   coins-result    { run, round, seedUsed, score, moves, end, hg, startedAt, finishedAt }
 *   coins-surrender { run, round }                 — «сдался» (освобождает раунды от ожидания)
 *   coins-record    { run, total }                 — соло: игрок побил свой рекорд забега
 * Движение по сети не летит вовсе: поиск идёт офлайн, сервер видит только шифроблобы.
 *
 * Соло (players = 1): забегов (run) может быть несколько — кнопка «начать снова»
 * открывает новый забег с новым зерном; результаты всех забегов сравниваются
 * в таблице, лучший помечается рекордом.
 */
(function (glob) {
  const W = 13, H = 26;          // клеток (карты-картинки примерно 1:2)
  const COINS = 40;              // монет на карте, все одного достоинства
  const MAPS = 6;                // картин-карт в комплекте
  const MAX_ROUNDS = MAPS;       // раундов не больше, чем карт
  const MAX_PLAYERS = 4;         // игроков в партии (соло — это 1)
  const GRACE_MS = 24 * 3600 * 1000;   // сутки ждём результат раунда, потом «не играл»
  const WALL_P = 0.20;           // базовая доля стен до carve-прохода
  const BONUS_PLAN = ['compass', 'compass', 'lantern', 'lantern', 'hourglass', 'hourglass'];

  /** fnv1a: строка → 32 бита. */
  function fnv(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h >>> 0;
  }
  /** mulberry32: детерминированный генератор. */
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const idx = (x, y) => y * W + x;
  const inB = (x, y) => x >= 0 && y >= 0 && x < W && y < H;

  /** Порядок карт забега: перемешанная перестановка 0..MAPS-1 (одинакова у всех). */
  function mapsOrder(seed, run) {
    const r = rng(fnv(String(seed) + ':order:' + (run || 1)));
    const a = [];
    for (let i = 0; i < MAPS; i++) a.push(i);
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }
  /** Зерно соло-забега: у каждого нового забега своя последовательность карт. */
  const runSeed = (seed, run) => (run || 1) <= 1 ? String(seed) : fnv(String(seed) + ':run:' + run).toString(16) + String(run);

  /**
   * Раскладка раунда: карта берётся по порядку забега, стены/монеты/бонусы —
   * из зерна раунда. Стены: случайные + «гряды»; всё недостижимое из старта
   * становится камнем, поэтому тупиков-островов нет, а короткий путь не прямой.
   */
  function genRound(seed, round, run) {
    const sd = runSeed(seed, run);
    const order = mapsOrder(sd, run || 1);
    const mapIdx = order[((round - 1) % MAPS + MAPS) % MAPS];
    const r = rng(fnv(sd + ':' + round));
    const walls = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) walls[idx(x, y)] = r() < WALL_P ? 1 : 0;
    for (let k = 0; k < 16; k++) {                       // каменные гряды — лабиринт
      let x = Math.floor(r() * W), y = Math.floor(r() * H);
      const dx = r() < 0.5 ? 1 : 0, dy = dx ? 0 : 1;
      const len = 2 + Math.floor(r() * 4);
      for (let i = 0; i < len; i++) { if (inB(x, y)) walls[idx(x, y)] = 1; x += dx; y += dy; }
    }
    const start = { x: (W - 1) >> 1, y: (H - 1) >> 1 };
    for (let y = start.y - 1; y <= start.y + 1; y++)     // поляна старта всегда открыта
      for (let x = start.x - 1; x <= start.x + 1; x++) if (inB(x, y)) walls[idx(x, y)] = 0;
    const seen = new Uint8Array(W * H);
    const q = [start]; seen[idx(start.x, start.y)] = 1;
    const reach = [];
    while (q.length) {
      const p = q.pop(); reach.push(p);
      const nb = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      for (const d of nb) {
        const nx = p.x + d[0], ny = p.y + d[1];
        if (inB(nx, ny) && !walls[idx(nx, ny)] && !seen[idx(nx, ny)]) { seen[idx(nx, ny)] = 1; q.push({ x: nx, y: ny }); }
      }
    }
    for (let i = 0; i < W * H; i++) if (!walls[i] && !seen[i]) walls[i] = 1;
    const open = reach.filter(p => !(p.x === start.x && p.y === start.y));
    for (let i = open.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); const t = open[i]; open[i] = open[j]; open[j] = t; }
    const coins = open.slice(0, Math.min(COINS, open.length)).map(p => ({ x: p.x, y: p.y }));
    const rest = open.slice(coins.length);
    const bonuses = [];
    for (const t of BONUS_PLAN) { const p = rest.pop(); if (p) bonuses.push({ x: p.x, y: p.y, t }); }
    return { w: W, h: H, mapIdx, walls, coins, bonuses, start };
  }

  const coinAt = (gen, x, y) => gen.coins.findIndex(c => c.x === x && c.y === y);
  const bonusAt = (gen, x, y) => gen.bonuses.find(b => b.x === x && b.y === y) || null;
  const bonusIdxAt = (gen, x, y) => gen.bonuses.findIndex(b => b.x === x && b.y === y);
  const isWall = (gen, x, y) => !inB(x, y) || !!gen.walls[idx(x, y)];
  const STEP = { U: [0, -1], D: [0, 1], L: [-1, 0], R: [1, 0] };

  /** Перепроигрывание пути (проверка чужого результата и подсчёт своего).
   * pkg3-80: бонус подбирается ОДИН раз — как монета. Часы, компас и фонарь
   * больше не «фармятся» повторными заходами на ту же клетку: повторный шаг
   * на собранный бонус ничего не даёт, а собранные бонусы исчезают с карты. */
  function simulate(gen, moves) {
    const got = new Uint8Array(gen.coins.length);
    const bgot = new Uint8Array(gen.bonuses.length);
    let x = gen.start.x, y = gen.start.y, score = 0, hg = 0, steps = 0;
    const s0 = coinAt(gen, x, y); if (s0 >= 0) { got[s0] = 1; score++; }
    const b0 = bonusIdxAt(gen, x, y);
    if (b0 >= 0) { bgot[b0] = 1; if (gen.bonuses[b0].t === 'hourglass') hg++; }
    for (const ch of String(moves || '')) {
      const d = STEP[ch]; if (!d) continue;
      const nx = x + d[0], ny = y + d[1];
      if (isWall(gen, nx, ny)) continue;
      x = nx; y = ny; steps++;
      const ci = coinAt(gen, x, y);
      if (ci >= 0 && !got[ci]) { got[ci] = 1; score++; }
      const bi = bonusIdxAt(gen, x, y);
      if (bi >= 0 && !bgot[bi]) {
        bgot[bi] = 1;
        if (gen.bonuses[bi].t === 'hourglass') hg++;
      }
    }
    return { score, end: [x, y], hg, got, bgot, steps };
  }

  /** Сверка результата: счёт, финиш, часы и уложился ли в лимит времени. */
  function verify(gen, res, minutes) {
    if (!res || typeof res !== 'object') return false;
    const sim = simulate(gen, res.moves);
    if (sim.score !== (res.score | 0)) return false;
    if (!Array.isArray(res.end) || sim.end[0] !== res.end[0] || sim.end[1] !== res.end[1]) return false;
    if (sim.hg !== (res.hg | 0)) return false;
    const limit = (Number(minutes) * 60 + sim.hg * 10) * 1000 + 3000;
    const dt = Number(res.finishedAt) - Number(res.startedAt);
    if (!(dt >= 0) || dt > limit) return false;
    return true;
  }

  // ───────────────────────────────────────── письма забега ─────────────
  const isResult = l => l && l.k === 'coins-result';
  const isSurr = l => l && l.k === 'coins-surrender';

  /** Результаты раунда r забега run: по одному письму на игрока (раннее по ts). */
  function resultsOf(game, letters, r, run) {
    const players = game.players || [];
    const list = (letters || []).filter(x => isResult(x) && x.round === r && (x.run || 1) === (run || 1)
      && players.includes(x.author));
    const by = {};
    for (const x of list) if (!by[x.author] || x.ts < by[x.author].ts) by[x.author] = x;
    return by;
  }
  /**
   * Сдавшиеся к раунду r: письмо «сдался», пришедшее не позже окна игры раунда
   * (открытие + лимит минут + запас 90 с). Сдавший не блокирует раунды и не
   * претендует на очки; в таблице он помечен.
   */
  function surrenderedOf(game, letters, r, run) {
    const players = game.players || [];
    const win = (Number(game.minutes) * 60 + 90) * 1000;
    const out = [];
    for (const p of players) {
      const s = (letters || []).filter(x => isSurr(x) && x.author === p && (x.run || 1) === (run || 1))
        .sort((a, b) => a.ts - b.ts)[0];
      if (!s) continue;
      const roundAtSurr = Math.min(game.rounds | 0, Math.max(1, r));   // письмо относится к своему раунду
      if (s.round <= r && s.ts <= openTsOf(game, letters, s.round, run) + win) out.push(p);
      void roundAtSurr;
    }
    return out;
  }
  function openTsOf(game, letters, r, run) {
    if (r <= 1) return Number(game.createdAt) || 0;
    const prev = Object.values(resultsOf(game, letters, r - 1, run));
    const surr = surrenderedOfRaw(game, letters, r - 1, run);
    if (!prev.length && !surr.length) return openTsOf(game, letters, r - 1, run);
    const ts = prev.map(x => Number(x.ts) || 0).concat(surr.map(x => Number(x.ts) || 0));
    return Math.max.apply(null, ts);
  }
  function surrenderedOfRaw(game, letters, r, run) {
    const players = game.players || [];
    return (letters || []).filter(x => isSurr(x) && x.round === r && (x.run || 1) === (run || 1) && players.includes(x.author));
  }
  /** Живые игроки раунда: все, кроме сдавшихся к нему. */
  function activeOf(game, letters, r, run) {
    const surr = surrenderedOf(game, letters, r, run);
    return (game.players || []).filter(p => !surr.includes(p));
  }
  function closeTs(game, letters, r, run) {
    const active = activeOf(game, letters, r, run);
    const by = resultsOf(game, letters, r, run);
    const have = active.filter(p => by[p]);
    const o = openTsOf(game, letters, r, run);
    if (active.length && have.length === active.length) return Math.max.apply(null, active.map(p => Number(by[p].ts) || 0));
    return o + GRACE_MS;
  }
  /**
   * Не сыграли раунд (срок вышел): «не играл» и ноль очков.
   * pkg3-79: в соло («Золотая лихорадка» в одиночку) ждать некого — суток нет и «не играл»
   * не ставится; иначе забег, созданный давно, мгновенно «завершался» пустым.
   */
  function absentOf(game, letters, r, run, now) {
    if ((game.players || []).length <= 1) return [];
    const active = activeOf(game, letters, r, run);
    const by = resultsOf(game, letters, r, run);
    const missing = active.filter(p => !by[p]);
    if (!missing.length) return [];
    return (Number(now) >= closeTs(game, letters, r, run)) ? missing : [];
  }
  /**
   * План забега: какой раунд играем, закрыт ли он, кого ждём; final — последний
   * раунд закрыт, можно объявлять победителя. Считается одинаково на всех
   * устройствах по одному набору писем.
   */
  function roundPlan(game, letters, now, run) {
    const rounds = Math.max(1, Math.min(MAX_ROUNDS, game.rounds | 0));
    for (let r = 1; r <= rounds; r++) {
      const active = activeOf(game, letters, r, run);
      const by = resultsOf(game, letters, r, run);
      const absent = absentOf(game, letters, r, run, now);
      // сдались ВСЕ — играть некому: забег завершён (победителя не будет)
      if (!active.length) {
        return { round: r, missing: [], absent: [], complete: true, final: true, openTs: openTsOf(game, letters, r, run), closeTs: closeTs(game, letters, r, run) };
      }
      const missing = active.filter(p => !by[p] && !absent.includes(p));
      const complete = !missing.length && active.length > 0;
      const base = { round: r, missing, absent, openTs: openTsOf(game, letters, r, run), closeTs: closeTs(game, letters, r, run) };
      if (!complete) return Object.assign(base, { complete: false, final: false });
      if (r === rounds) return Object.assign(base, { complete: true, final: true });
    }
    return { round: rounds, missing: [], absent: [], complete: true, final: true, openTs: 0, closeTs: 0 };
  }
  /** Таблица забега: очки по раундам, итог, метки (сдался / не играл / не проверено). */
  function table(game, letters, now, run) {
    const rounds = Math.max(1, Math.min(MAX_ROUNDS, game.rounds | 0));
    const players = game.players || [];
    const surrAll = {};
    for (const p of players) {
      const s = (letters || []).filter(x => isSurr(x) && x.author === p && (x.run || 1) === (run || 1)).sort((a, b) => a.ts - b.ts)[0];
      surrAll[p] = s ? s.round : null;
    }
    const rows = players.map(p => {
      const per = [];
      let total = 0;
      for (let r = 1; r <= rounds; r++) {
        const by = resultsOf(game, letters, r, run);
        const res = by[p];
        const surr = surrAll[p] !== null && surrAll[p] <= r;
        if (res && Number(res.ts) <= closeTs(game, letters, r, run)) {
          per.push({ r, score: res.score | 0, bad: res.bad === true });
          if (!surr || Number(res.ts) <= closeTs(game, letters, r, run)) total += res.score | 0;
        } else if (surr) per.push({ r, score: 0, surrendered: true });
        else if (absentOf(game, letters, r, run, now).includes(p)) per.push({ r, score: 0, absent: true });
        else per.push({ r, score: null });
      }
      return { id: p, per, total, surrenderedAt: surrAll[p] };
    });
    rows.sort((a, b) => b.total - a.total);
    return rows;
  }
  /** Победитель забега (никогда — при единственном игроке: там рекорды свои). */
  function winnerOf(game, letters, now, run) {
    const t = table(game, letters, now, run);
    if (!t.length || t[0].total <= 0) return null;
    const top = t.filter(x => x.total === t[0].total).map(x => x.id);
    return { ids: top, total: t[0].total };
  }

  const CE = {
    W, H, COINS, MAPS, MAX_ROUNDS, MAX_PLAYERS, GRACE_MS, WALL_P,
    fnv, rng, idx, inB, mapsOrder, runSeed, genRound, simulate, verify,
    coinAt, bonusAt, bonusIdxAt, isWall, STEP,
    isResult, isSurr, resultsOf, surrenderedOf, activeOf, openTs: openTsOf, closeTs, absentOf, roundPlan, table, winnerOf
  };
  glob.CE = CE;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = CE;
  }
})(typeof window !== 'undefined' ? window : globalThis);
