/**
 * pkg3-78: «Монеты» — золотая лихорадка с туманом войны.
 *   • движок CE: раскладки из зерна детерминированы, порядок карт — перестановка,
 *     монеты достижимы, simulate/verify ловят подделку счёта, финиша и времени;
 *   • план забега: раунд закрывается, когда результаты у всех НЕ сдавшихся,
 *     сдавшийся не блокирует, опоздавший на сутки — «не играл» и ноль очков;
 *   • соло: у каждого забега своё зерно, письмо забега №2 не смешивается с №1;
 *   • сервер: создание (соло и до троих гостей), лимиты (4 игрока, 6 раундов,
 *     30 минут, живые партии), accept/decline/leave без удаления чужого забега.
 * Запуск: node test/coins.mjs
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const CE = require(path.join(ROOT, 'public', 'coins-engine.js'));

let good = 0, bad = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ПРОВАЛ: ') + m); if (c) good++; else bad++; };
const hex = (n = 16) => crypto.randomBytes(n).toString('hex');
const wait = ms => new Promise(r => setTimeout(r, ms));

console.log('\n══════════════════════════════════════════════════');
console.log('  «Монеты» — движок · pkg3-79');
console.log('══════════════════════════════════════════════════\n');

// ─────────────────────────── движок: раскладки из зерна ───────────────────────────
const SEED = 'c0ffee00feed1234';
{
  const a = CE.genRound(SEED, 1, 1), b = CE.genRound(SEED, 1, 1);
  ok(Buffer.from(a.walls).equals(Buffer.from(b.walls)) && JSON.stringify(a.coins) === JSON.stringify(b.coins)
    && a.mapIdx === b.mapIdx, 'одно зерно — одна раскладка: стены и монеты совпадают байт в байт');
  const c = CE.genRound(SEED, 2, 1);
  ok(JSON.stringify(c.coins) !== JSON.stringify(a.coins), 'у следующего раунда своя раскладка монет');
  ok(a.w === CE.W && a.h === CE.H && a.walls.length === CE.W * CE.H, 'поле 13×26, стены — по числу клеток');
  ok(a.coins.length === CE.COINS, 'на карте ровно ' + CE.COINS + ' монет одного достоинства');
  ok(a.bonuses.length === 6 && a.bonuses.filter(x => x.t === 'compass').length === 2
    && a.bonuses.filter(x => x.t === 'lantern').length === 2
    && a.bonuses.filter(x => x.t === 'hourglass').length === 2, 'бонусы: по два компаса, фонаря и песочных часов');
  ok(!CE.isWall(a, a.start.x, a.start.y), 'старт открыт');
  ok(a.coins.every(p => !CE.isWall(a, p.x, p.y)), 'монеты не замурованы в стены');
  ok(!a.coins.some(p => p.x === a.start.x && p.y === a.start.y), 'на стартовой клетке монеты нет');
  ok(!a.bonuses.some(b2 => a.coins.some(cn => cn.x === b2.x && cn.y === b2.y)), 'бонусы не стоят на монетах');
  // достижимость всего: из старта есть путь к каждой монете и каждому бонусу
  const seen = new Uint8Array(CE.W * CE.H);
  const q = [a.start]; seen[CE.idx(a.start.x, a.start.y)] = 1;
  while (q.length) {
    const p = q.pop();
    for (const d of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = p.x + d[0], ny = p.y + d[1];
      if (CE.inB(nx, ny) && !a.walls[CE.idx(nx, ny)] && !seen[CE.idx(nx, ny)]) { seen[CE.idx(nx, ny)] = 1; q.push({ x: nx, y: ny }); }
    }
  }
  ok(a.coins.every(p => seen[CE.idx(p.x, p.y)]) && a.bonuses.every(p => seen[CE.idx(p.x, p.y)]),
    'тупиков-островов нет: каждая монета и каждый бонус достижимы из старта');
}
{
  const order1 = CE.mapsOrder(SEED, 1);
  const order1b = CE.mapsOrder(SEED, 1);
  ok(JSON.stringify(order1) === JSON.stringify(order1b), 'порядок карт из зерна воспроизводится точно');
  ok(order1.length === CE.MAPS && [...order1].sort((x, y) => x - y).join() === '0,1,2,3,4,5',
    'порядок карт — перестановка всех шести карт');
  const order2 = CE.mapsOrder(CE.runSeed(SEED, 2), 2);
  ok(JSON.stringify(order1) !== JSON.stringify(order2), 'у соло-забега №2 свой порядок карт');
  ok(CE.runSeed(SEED, 1) === String(SEED) && CE.runSeed(SEED, 2) !== String(SEED), 'первый забег — на исходном зерне, следующие — на производных');
  const seenMaps = new Set();
  for (let rr = 1; rr <= 6; rr++) seenMaps.add(CE.genRound(SEED, rr, 1).mapIdx);
  ok(seenMaps.size === 6, 'шесть раундов — шесть разных карт (каждая ровно раз)');
  ok(CE.MAX_PLAYERS === 4 && CE.MAX_ROUNDS === 6, 'правила: максимум 4 игрока, 6 раундов');
}

// ─────────────────────────── движок: путь, счёт и проверка ───────────────────────────
/** Короткий путь от старта до клетки (BFS по открытым клеткам), строкой UDLR. */
function pathTo(gen, target) {
  const key = p => p.x + ',' + p.y;
  const prev = new Map([[key(gen.start), null]]);
  const q = [gen.start];
  while (q.length) {
    const p = q.shift();
    if (p.x === target.x && p.y === target.y) break;
    for (const [ch, d] of Object.entries(CE.STEP)) {
      const nx = p.x + d[0], ny = p.y + d[1];
      if (CE.inB(nx, ny) && !gen.walls[CE.idx(nx, ny)] && !prev.has(nx + ',' + ny)) { prev.set(nx + ',' + ny, ch); q.push({ x: nx, y: ny }); }
    }
  }
  let moves = '', cur = { x: target.x, y: target.y };
  while (prev.get(key(cur))) {
    const ch = prev.get(key(cur));
    moves = ch + moves;
    const d = CE.STEP[ch];
    cur = { x: cur.x - d[0], y: cur.y - d[1] };
  }
  return moves;
}
{
  const gen = CE.genRound(SEED, 1, 1);
  const s0 = CE.simulate(gen, '');
  ok(s0.score === 0 && s0.end[0] === gen.start.x && s0.end[1] === gen.start.y, 'без шагов — ноль монет, стоим на старте');
  const junk = CE.simulate(gen, 'ЪЫЬX123');
  ok(junk.end[0] === gen.start.x && junk.end[1] === gen.start.y, 'мусор вместо направлений просто игнорируется');
  let wallDir = null;
  for (const [ch, d] of Object.entries(CE.STEP)) {
    if (CE.isWall(gen, gen.start.x + d[0], gen.start.y + d[1])) { wallDir = ch; break; }
  }
  if (wallDir) {
    const sw = CE.simulate(gen, wallDir);
    ok(sw.end[0] === gen.start.x && sw.end[1] === gen.start.y && sw.steps === 0, 'шаг в камень — стоим на месте');
  } else ok(true, 'шаг в камень — стоим на месте (стен у старта не оказалось, правило то же)');
  const target = gen.coins[0];
  const moves = pathTo(gen, target);
  const s1 = CE.simulate(gen, moves);
  ok(s1.score >= 1 && s1.end[0] === target.x && s1.end[1] === target.y, 'путь к монете найден и засчитан (счёт ≥ 1, стоим на цели)');
  const res = { score: s1.score, end: s1.end, hg: s1.hg, moves, startedAt: 1000000, finishedAt: 1000000 + 60000 };
  ok(CE.verify(gen, res, 3) === true, 'честный результат проходит проверку');
  ok(CE.verify(gen, Object.assign({}, res, { score: res.score + 5 }), 3) === false, 'приписанные монеты проверка ловит');
  ok(CE.verify(gen, Object.assign({}, res, { end: [0, 0] }), 3) === false, 'чужой финиш проверка ловит');
  ok(CE.verify(gen, Object.assign({}, res, { hg: res.hg + 1 }), 3) === false, 'приписанные песочные часы проверка ловит');
  ok(CE.verify(gen, Object.assign({}, res, { finishedAt: res.startedAt + 5 * 60 * 1000 }), 3) === false, 'результат вне лимита времени проверка ловит');
  ok(CE.verify(gen, null, 3) === false && CE.verify(gen, {}, 3) === false, 'пустышка вместо результата не проходит');
  // песочные часы удлиняют лимит ровно на 10 секунд за каждый заход на клетку
  const hgCell = gen.bonuses.find(b => b.t === 'hourglass');
  ok(!!hgCell, 'песочные часы на карте есть');
  const mv = pathTo(gen, hgCell);
  const back = CE.simulate(gen, mv);
  ok(back.hg >= 1, 'шаг на песочные часы добавляет время (hg ≥ 1)');
  const limitMs = (3 * 60 + back.hg * 10) * 1000;
  const okRes = { score: back.score, end: back.end, hg: back.hg, moves: mv, startedAt: 0, finishedAt: limitMs + 2999 };
  const badRes = { score: back.score, end: back.end, hg: 0, moves: mv, startedAt: 0, finishedAt: limitMs + 2999 };
  ok(CE.verify(gen, okRes, 3) === true, 'с часами лимит честно длиннее — результат проходит');
  ok(CE.verify(gen, badRes, 3) === false, 'заниженное число часов результат не спасает');
}

// ─────────────────────────── движок: план забега и таблица ───────────────────────────
{
  const T0 = 1700000000000;
  const game = { players: ['A', 'B'], rounds: 2, minutes: 3, createdAt: T0, seed: SEED };
  const res = (author, round, ts, score) => ({ k: 'coins-result', author, round, run: 1, ts, score: score || 0, moves: '', end: [6, 12], hg: 0, startedAt: ts - 60000, finishedAt: ts });
  let plan = CE.roundPlan(game, [], T0 + 1000, 1);
  ok(plan.round === 1 && !plan.complete && plan.missing.join() === 'A,B', 'чистый старт: раунд 1, ждём обоих');
  plan = CE.roundPlan(game, [res('A', 1, T0 + 60000)], T0 + 70000, 1);
  ok(plan.round === 1 && !plan.complete && plan.missing.join() === 'B', 'результат одного получен — ждём второго');
  const both = [res('A', 1, T0 + 60000), res('B', 1, T0 + 90000)];
  plan = CE.roundPlan(game, both, T0 + 100000, 1);
  ok(plan.round === 2 && !plan.complete && !plan.final, 'оба результата в доме — открыт раунд 2 (он ещё не закрыт)');
  const all4 = both.concat([res('A', 2, T0 + 200000), res('B', 2, T0 + 210000)]);
  plan = CE.roundPlan(game, all4, T0 + 220000, 1);
  ok(plan.final === true, 'последний раунд закрыт — забег финализирован');
  const t = CE.table(game, all4, T0 + 220000, 1);
  ok(t.length === 2 && t.every(r2 => r2.per.length === 2), 'таблица: строка на игрока, по клетке на раунд');
  const win = CE.winnerOf(game, [res('A', 1, T0 + 60000, 5), res('B', 1, T0 + 70000, 3),
    res('A', 2, T0 + 200000, 3), res('B', 2, T0 + 210000, 4)], T0 + 300000, 1);
  ok(win && win.ids.join() === 'A' && win.total === 8, 'победитель — по сумме монет за раунды');
  const tie = CE.winnerOf(game, [res('A', 1, T0 + 60000, 4), res('B', 1, T0 + 70000, 4),
    res('A', 2, T0 + 200000, 1), res('B', 2, T0 + 210000, 1)], T0 + 300000, 1);
  ok(tie && tie.ids.length === 2, 'равные итоги — ничья (победителей двое)');
  ok(CE.winnerOf(game, [res('A', 1, T0 + 60000, 0), res('B', 1, T0 + 70000, 0)], T0 + 300000, 1) === null,
    'нули у всех — победителя нет');
  // сдавшийся не блокирует раунды
  const surrB = { k: 'coins-surrender', author: 'B', round: 1, run: 1, ts: T0 + 30000 };
  plan = CE.roundPlan(game, [res('A', 1, T0 + 60000), surrB], T0 + 70000, 1);
  ok(plan.round === 2, 'соперник сдался — раунд закрыт без его результата');
  const tS = CE.table(game, [res('A', 1, T0 + 60000, 9), surrB], T0 + 70000, 1);
  const rowB = tS.find(x => x.id === 'B');
  ok(rowB.surrenderedAt === 1 && rowB.per[0].surrendered === true, 'в таблице сдавшийся помечен по всем раундам');
  // сдались все — забег завершён, победителя нет
  const surrAll = [surrB, { k: 'coins-surrender', author: 'A', round: 1, run: 1, ts: T0 + 31000 }];
  plan = CE.roundPlan(game, surrAll, T0 + 90000, 1);
  ok(plan.final === true, 'сдались все — забег завершён');
  ok(CE.winnerOf(game, surrAll, T0 + 90000, 1) === null, 'победителя у всеобщей сдачи нет');
  // опоздавший: сутки — и раунд закрывается сам, прогульщик с нулём
  plan = CE.roundPlan(game, [res('A', 1, T0 + 60000)], T0 + CE.GRACE_MS + 61000, 1);
  ok(plan.round === 2, 'сутки без результата — раунд 1 закрыт и открыт раунд 2');
  ok(CE.absentOf(game, [res('A', 1, T0 + 60000)], 1, 1, T0 + CE.GRACE_MS + 61000).join() === 'B',
    'прогульщик раунда 1 помечен «не играл»');
  const tA = CE.table(game, [res('A', 1, T0 + 60000, 4)], T0 + CE.GRACE_MS + 61000, 1);
  const rowB2 = tA.find(x => x.id === 'B');
  ok(rowB2.per[0].absent === true && rowB2.per[0].score === 0, '«не играл» — ноль очков в таблице');
  // pkg3-79: соло — ждать некого, суток и «не играл» нет; старый забег не «завершается» сам
  const soloG = Object.assign({}, game, { players: ['A'] });
  const soloPlan = CE.roundPlan(soloG, [], T0 + CE.GRACE_MS + 61000, 1);
  ok(!soloPlan.final && soloPlan.absent.length === 0 && soloPlan.missing.join() === 'A',
    'соло: сутки спустя раунд открыт, «не играл» не ставится, забег не «завершён»');
  ok(CE.absentOf(soloG, [], 1, 1, T0 + CE.GRACE_MS + 61000).length === 0, 'соло: absentOf пуст');
  const tSolo = CE.table(soloG, [], T0 + CE.GRACE_MS + 61000, 1);
  ok(tSolo.length === 1 && tSolo[0].per[0].score === null, 'соло: несостоявшийся раунд — прочерк, а не ноль');
  const soloSurr = [{ k: 'coins-surrender', author: 'A', round: 1, run: 1, ts: T0 + 31000 }];
  ok(CE.roundPlan(soloG, soloSurr, T0 + 90000, 1).final === true, 'соло: сдался — забег завершён, как прежде');
  // соло-забеги: письма забега №2 не смешиваются с забегом №1
  const lRun2 = Object.assign(res('A', 1, T0 + 60000, 7), { run: 2 });
  const t2 = CE.table(game, [res('A', 1, T0 + 60000, 2), lRun2], T0 + 90000, 2);
  ok(t2.find(x => x.id === 'A').per[0].score === 7, 'письма забега №2 считаются отдельно от забега №1');
  // чужие письма (не игрока) в зачёт не идут
  const tGhost = CE.table(game, [Object.assign(res('GHOST', 1, T0 + 60000, 40))], T0 + 90000, 1);
  ok(tGhost.every(x => x.total === 0), 'письмо не-игрока в таблицу не попадает');
}

// ─────────────────────────── сервер: создание, лимиты, accept/decline/leave ───────────────────────────
console.log('\n──────────────────────────────────────────────────');
console.log('  «Монеты» — сервер · pkg3-78');
console.log('──────────────────────────────────────────────────\n');

async function call(base, p, opts = {}, token) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { ...opts, headers: h, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const ct = r.headers.get('content-type') || '';
  const buf = Buffer.from(await r.arrayBuffer());
  if (ct.includes('json')) { try { return { status: r.status, d: JSON.parse(buf.toString('utf8')) }; } catch (e) {} }
  return { status: r.status, d: buf.toString('utf8') };
}
async function waitReady(base) {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/api/state')).ok) return; } catch (e) {}
    await wait(200);
  }
  throw new Error('не поднялся ' + base);
}
async function freePort() {
  const { createServer } = await import('node:net');
  return new Promise(r => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
}
const procs = [];
process.on('exit', () => { for (const p of procs) { try { p.kill('SIGKILL'); } catch (e) {} } });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sega-coins-'));
const port = await freePort();
const proc = spawn(process.execPath, ['server.js'], {
  cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
  env: Object.assign({}, process.env, {
    STORE: 'file', DATA_DIR: dir, HOST: '127.0.0.1', HTTPS: '', PRESENCE_EVERY: '0', NEW_INVITE_DELAY: '0',
    INVITE_COOLDOWN_MS: '0', PORT: String(port)
  })
});
procs.push(proc);
const base = `http://127.0.0.1:${port}`;
await waitReady(base);

const creds = name => ({ name, saltAuth: hex(), authKey: hex(32), saltWrap: hex(), wrappedKeyByPass: 'w:' + hex(), pub: 'pub:' + hex(), wrappedPriv: 'priv:' + hex() });
let r = await call(base, '/api/setup', { method: 'POST', body: Object.assign({}, creds('Мартин'), { codeProofSalt: hex(), codeProof: hex(32), codeSalt: hex(), wrappedKeyByCode: 'k:' + hex() }) });
ok(r.status === 200, 'мессенджер настроен');
const admin = r.d.token;
async function register(c, inviter) {
  const secret = hex(24);
  const sha = crypto.createHash('sha256').update(secret).digest('hex');
  const ir = await call(base, '/api/invites', { method: 'POST', body: { invSalt: hex(), wrappedRoomKey: 'k:' + hex(), secretHash: sha } }, inviter);
  if (!ir.d || !ir.d.invite) throw new Error('приглашение не создано: ' + ir.status);
  return call(base, '/api/register', { method: 'POST', body: Object.assign({}, c, { inviteToken: ir.d.invite.id + '.' + secret }) });
}
const P = {};
for (const [nick, name] of [['a', 'Поля'], ['b', 'Гоша'], ['c', 'Вася'], ['d', 'Даша'], ['e', 'Женя']]) {
  r = await register(creds(name), admin);
  P[nick] = { token: r.d.token, id: r.d.user.id };
}
ok(!!P.e.token, 'пять участников готовы');

const keysOf = ids => Object.fromEntries(ids.map(id => [id, { blob: 'w-' + id.slice(0, 6) }]));

// ── соло-забег: соперник не обязателен, статус сразу «играем»
r = await call(base, '/api/games', { method: 'POST', body: { rules: 'coins', players: [], minutes: 3, rounds: 3, seed: 'abc123', keys: keysOf([P.a.id]) } }, P.a.token);
ok(r.status === 200 && r.d.chat.game.rules === 'coins' && r.d.chat.game.status === 'playing'
  && r.d.chat.game.players.length === 1 && r.d.chat.game.invitees.length === 0,
'соло-забег создан: статус сразу «играем», игрок один');
const soloId = r.d.chat.id;

// ── гостей не больше трёх (всего четыре игрока)
r = await call(base, '/api/games', { method: 'POST', body: { rules: 'coins', players: [P.a.id, P.c.id, P.d.id, P.e.id], keys: keysOf([P.b.id, P.a.id, P.c.id, P.d.id, P.e.id]) } }, P.b.token);
ok(r.status === 400 && /максимум вчетвером/.test(r.d.error || ''), 'четверо гостей — отказ: «В монеты играют максимум вчетвером»');

// ── раундов не больше шести, минут не больше тридцати
r = await call(base, '/api/games', { method: 'POST', body: { rules: 'coins', players: [P.d.id], minutes: 99, rounds: 99, keys: keysOf([P.c.id, P.d.id]) } }, P.c.token);
ok(r.status === 200 && r.d.chat.game.minutes === 30 && r.d.chat.game.rounds === 6, '99 минут стали 30, 99 раундов — 6 (карт в комплекте шесть)');

// ── забег на четверых: создатель играет сразу, трое — в приглашённых; зерно чистится
r = await call(base, '/api/games', { method: 'POST', body: { rules: 'coins', players: [P.a.id, P.c.id, P.d.id], seed: 'QQ-deadBEEF-77', keys: keysOf([P.b.id, P.a.id, P.c.id, P.d.id]) } }, P.b.token);
ok(r.status === 200 && r.d.chat.game.seed === 'deadBEEF77', 'зерно карты очищено от мусора (остались только шестнадцатеричные знаки)');
const gameId = r.d.chat.id;
ok(r.d.chat.game.players.length === 1 && r.d.chat.game.invitees.length === 3 && r.d.chat.game.status === 'playing'
  && r.d.chat.game.minutes === 3 && r.d.chat.game.rounds === 3,
'забег на четверых: создатель играет сразу, трое приглашены, 3 раунда по 3 минуты');

// ── ключ чата обязателен для каждого участника
r = await call(base, '/api/games', { method: 'POST', body: { rules: 'coins', players: [P.a.id], keys: keysOf([P.e.id]) } }, P.e.token);
ok(r.status === 400 && /ключа чата/.test(r.d.error || ''), 'без ключа чата одного из участников забег не создаётся');

// ── лимит одновременных партий (MAX_LIVE_GAMES = 4)
r = await call(base, '/api/games', { method: 'POST', body: { rules: 'coins', players: [], keys: keysOf([P.c.id]) } }, P.c.token);
ok(r.status === 200, 'вторая живая партия создаётся');
r = await call(base, '/api/games', { method: 'POST', body: { rules: 'coins', players: [], keys: keysOf([P.c.id]) } }, P.c.token);
ok(r.status === 200, 'третья живая партия создаётся');
r = await call(base, '/api/games', { method: 'POST', body: { rules: 'coins', players: [], keys: keysOf([P.c.id]) } }, P.c.token);
ok(r.status === 200, 'четвёртая живая партия создаётся');
r = await call(base, '/api/games', { method: 'POST', body: { rules: 'coins', players: [], keys: keysOf([P.c.id]) } }, P.c.token);
ok(r.status === 400 && /одновременные партии/.test(r.d.error || ''), 'пятая живая партия сверх лимита не создаётся');

// ── приглашение видно адресату и только ему
r = await call(base, '/api/sync?since=999999999&rsince=0', {}, P.a.token);
ok(r.status === 200 && (r.d.invites || []).some(x => x.id === gameId && x.rules === 'coins'), 'Поля видит приглашение в «Монеты» (с правилами)');
r = await call(base, '/api/sync?since=999999999&rsince=0', {}, P.e.token);
ok(!(r.d.invites || []).some(x => x.id === gameId), 'Женя не приглашён — приглашения не видит');

// ── чужое приглашение принять нельзя, своё — дважды тоже
r = await call(base, `/api/games/${gameId}/accept`, { method: 'POST', body: {} }, P.e.token);
ok(r.status === 403, 'неприглашённый принять приглашение не может');
r = await call(base, `/api/games/${gameId}/accept`, { method: 'POST', body: {} }, P.a.token);
ok(r.status === 200 && r.d.chat.game.players.includes(P.a.id) && !r.d.chat.game.invitees.includes(P.a.id)
  && r.d.chat.members.includes(P.a.id), 'Поля приняла: стала игроком и участником чата, из приглашённых вычеркнута');
r = await call(base, `/api/games/${gameId}/accept`, { method: 'POST', body: {} }, P.a.token);
ok(r.status === 403, 'дважды принять одно приглашение нельзя');

// ── отказ: чужой забег не умирает
r = await call(base, `/api/games/${gameId}/decline`, { method: 'POST', body: {} }, P.c.token);
ok(r.status === 200, 'Вася отклонил приглашение');
r = await call(base, '/api/sync?since=999999999&rsince=0', {}, P.c.token);
ok(!(r.d.invites || []).some(x => x.id === gameId), 'после отказа приглашение у Васи исчезло');
r = await call(base, '/api/sync?since=999999999&rsince=0', {}, P.d.token);
ok((r.d.invites || []).some(x => x.id === gameId), 'забег жив: Даша своё приглашение по-прежнему видит');
r = await call(base, `/api/games/${gameId}/decline`, { method: 'POST', body: {} }, P.c.token);
ok(r.status === 403, 'отклонить дважды нельзя');

// ── справочник «Сейчас играют»: забег виден знакомым, игроки — в карточке
await call(base, '/api/dm', { method: 'POST', body: { peer: P.b.id } }, P.e.token);
r = await call(base, '/api/sync?since=999999999&rsince=0', {}, P.e.token);
const live = (r.d.games || []).find(x => x.id === gameId);
ok(!!live && live.rules === 'coins' && Array.isArray(live.players) && live.players.includes(P.a.id) && live.players.includes(P.b.id),
'забег попал в «Сейчас играют» к знакомому: правила и список игроков на месте');

// ── выход из забега: остальные продолжают, с последним игра стирается
r = await call(base, `/api/games/${gameId}/accept`, { method: 'POST', body: {} }, P.d.token);
ok(r.status === 200 && r.d.chat.game.invitees.length === 0, 'Даша приняла — приглашённых не осталось');
r = await call(base, `/api/games/${gameId}/leave`, { method: 'POST', body: {} }, P.d.token);
ok(r.status === 200 && r.d.wiped === false, 'Даша вышла — забег не стёрт');
r = await call(base, `/api/games/${gameId}/leave`, { method: 'POST', body: {} }, P.a.token);
ok(r.status === 200 && r.d.wiped === false && r.d.resigned === false, 'Поля вышла — остался создатель; «поражения» в монетах нет');
r = await call(base, `/api/games/${gameId}/leave`, { method: 'POST', body: {} }, P.b.token);
ok(r.status === 200 && r.d.wiped === true, 'создатель вышел последним — игра стёрта');
r = await call(base, `/api/games/${gameId}/leave`, { method: 'POST', body: {} }, P.b.token);
ok(r.status === 404, 'стёртую игру не покинуть дважды (её больше нет)');

// ── письма забега ходят через обычный чат игры (сервер их не читает)
r = await call(base, '/api/messages', { method: 'POST', body: { chat: soloId, blob: 'enc:' + hex() } }, P.a.token);
ok(r.status === 200, 'письмо забега (шифроблоб) легло в чат игры как обычное сообщение');
r = await call(base, '/api/messages', { method: 'POST', body: { chat: soloId, blob: 'enc:' + hex() } }, P.b.token);
ok(r.status === 403, 'чужое письмо в забег не пустить — Гоша не участник соло-забега Поли');

console.log('\n──────────────────────────────────────────────────');
console.log(`  «Монеты» pkg3-79: ${good} ✓, провалов ${bad}`);
console.log('──────────────────────────────────────────────────\n');
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
proc.kill('SIGTERM');
process.exit(bad ? 1 : 0);
