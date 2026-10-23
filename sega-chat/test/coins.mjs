/**
 * pkg3-78: «Монеты» — золотая лихорадка с туманом войны.
 *   • движок CE: раскладки из зерна детерминированы, порядок карт — перестановка,
 *     монеты достижимы, simulate/verify ловят подделку счёта, финиша и времени;
 *   • план забега (pkg3-82 — личный темп): каждый игрок проходит раунды сам,
 *     никого не дожидаясь; забег завершается, когда ВСЕ не сдавшиеся прошли
 *     ВСЕ раунды; сдавшийся не блокирует; правила «сутки — не играл» больше
 *     нет (старый нетронутый забег не закрывается задним числом);
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
console.log('  «Золотая лихорадка» — движок · pkg3-80');
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
  ok(order1.length === CE.MAPS && [...order1].sort((x, y) => x - y).join() === Array.from({ length: CE.MAPS }, (_, i) => i).join(),
    'порядок карт — перестановка всей колоды из ' + CE.MAPS + ' карт');
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
  // песочные часы удлиняют лимит ровно на 10 секунд — и подбираются ОДИН раз
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
  // pkg3-85: дробные минуты (секунды с шагом 10 с) честно меняют лимит
  const mv70 = pathTo(gen, gen.coins[0]);
  const s70 = CE.simulate(gen, mv70);
  const res70 = { score: s70.score, end: s70.end, hg: s70.hg, moves: mv70, startedAt: 0, finishedAt: 65 * 1000 };
  ok(CE.verify(gen, res70, 70 / 60) === true, 'pkg3-85: 65 секунд укладываются в лимит «1:10»');
  ok(CE.verify(gen, res70, 1) === false, 'pkg3-85: тот же результат не влезает в прежний лимит «1 мин» — лимит считается из секунд');
}

// ─────────────────── pkg3-80: бонус одноразовый — как монета ───────────────────
{
  const gen = CE.genRound(SEED, 1, 1);
  const hgi = gen.bonuses.findIndex(b => b.t === 'hourglass');
  ok(hgi >= 0 && typeof CE.bonusIdxAt === 'function', 'движок знает индекс бонуса на клетке (bonusIdxAt)');
  const hgc = gen.bonuses[hgi];
  // соседняя открытая клетка БЕЗ бонуса — чтобы «шаг прочь» ничего не подобрал
  const OPP = { U: 'D', D: 'U', L: 'R', R: 'L' };
  let nbDir = null;
  for (const [ch, d] of Object.entries(CE.STEP)) {
    const nx = hgc.x + d[0], ny = hgc.y + d[1];
    if (CE.inB(nx, ny) && !CE.isWall(gen, nx, ny) && CE.bonusIdxAt(gen, nx, ny) < 0) { nbDir = ch; break; }
  }
  ok(!!nbDir, 'рядом с часами есть открытая клетка, куда можно шагнуть прочь');
  const base = pathTo(gen, hgc);
  const s1 = CE.simulate(gen, base);
  const s2 = CE.simulate(gen, base + nbDir + OPP[nbDir]);   // подобрал → шаг прочь → вернулся
  ok(s2.hg === s1.hg, 'повторный заход на собранную клетку время не увеличивает — часы нельзя «фармить»');
  ok(Array.isArray(s2.bgot) || s2.bgot instanceof Uint8Array, 'перепроигрывание возвращает подобранные бонусы (bgot) — клиент прячет их с карты');
  ok(!!s2.bgot[hgi], 'подобранный бонус отмечен в bgot');
  const res2 = { score: s2.score, end: s2.end, hg: s2.hg, moves: base + nbDir + OPP[nbDir], startedAt: 0, finishedAt: 1000 };
  ok(CE.verify(gen, res2, 3) === true, 'честный результат «подобрал — отошёл — вернулся» проходит проверку');
  ok(CE.verify(gen, Object.assign({}, res2, { hg: res2.hg + 1 }), 3) === false, 'попытка зачесть часы дважды проверкой ловится');
}

// ─────────────── движок: план забега и таблица (pkg3-82 — личный темп) ───────────────
{
  const T0 = 1700000000000;
  const game = { players: ['A', 'B'], rounds: 2, minutes: 3, createdAt: T0, seed: SEED };
  const res = (author, round, ts, score) => ({ k: 'coins-result', author, round, run: 1, ts, score: score || 0, moves: '', end: [6, 12], hg: 0, startedAt: ts - 60000, finishedAt: ts });
  let plan = CE.roundPlan(game, [], T0 + 1000, 1);
  ok(plan.final === false && plan.waiting.join() === 'A,B' && plan.per.A.next === 1 && plan.per.B.next === 1,
    'чистый старт: забег не завершён, оба игрока на раунде 1 — каждый видит «Начать раунд»');
  plan = CE.roundPlan(game, [res('A', 1, T0 + 60000)], T0 + 70000, 1);
  ok(plan.per.A.next === 2 && plan.per.B.next === 1 && !plan.final,
    'pkg3-82 (правка 1): A закончил раунд 1 и уже на раунде 2 — соперника B он не ждёт');
  const aDone = [res('A', 1, T0 + 60000, 5), res('A', 2, T0 + 120000, 7)];
  plan = CE.roundPlan(game, aDone, T0 + 130000, 1);
  ok(plan.per.A.finished === true && plan.per.A.next === null && !plan.final && plan.waiting.join() === 'B',
    'A прошёл все раунды — забег ждёт только B (правки 1 и 3)');
  const all = aDone.concat([res('B', 1, T0 + 200000, 3), res('B', 2, T0 + 260000, 9)]);
  plan = CE.roundPlan(game, all, T0 + 270000, 1);
  ok(plan.final === true && plan.lastDone === 2,
    'правка 3: все прошли все раунды — забег завершён, таблица у всех появится автоматически');
  const t = CE.table(game, all, T0 + 270000, 1);
  ok(t.length === 2 && t.every(r2 => r2.per.length === 2), 'таблица: строка на игрока, по клетке на раунд');
  const win = CE.winnerOf(game, [res('A', 1, T0 + 60000, 5), res('B', 1, T0 + 70000, 3),
    res('A', 2, T0 + 200000, 3), res('B', 2, T0 + 210000, 4)], T0 + 300000, 1);
  ok(win && win.ids.join() === 'A' && win.total === 8, 'победитель — по сумме монет за раунды');
  const tie = CE.winnerOf(game, [res('A', 1, T0 + 60000, 4), res('B', 1, T0 + 70000, 4),
    res('A', 2, T0 + 200000, 1), res('B', 2, T0 + 210000, 1)], T0 + 300000, 1);
  ok(tie && tie.ids.length === 2, 'равные итоги — ничья (победителей двое)');
  ok(CE.winnerOf(game, [res('A', 1, T0 + 60000, 0), res('B', 1, T0 + 70000, 0)], T0 + 300000, 1) === null,
    'нули у всех — победителя нет');
  // сдавшийся не блокирует забег
  const surrB = { k: 'coins-surrender', author: 'B', round: 1, run: 1, ts: T0 + 30000 };
  plan = CE.roundPlan(game, aDone.concat([surrB]), T0 + 130000, 1);
  ok(plan.final === true && plan.per.B.surrenderedAt === 1,
    'соперник сдался — забег завершается без него, оставшиеся играют до конца');
  const tS = CE.table(game, [res('A', 1, T0 + 60000, 9), surrB], T0 + 70000, 1);
  const rowB = tS.find(x => x.id === 'B');
  ok(rowB.surrenderedAt === 1 && rowB.per[0].surrendered === true && rowB.per[1].surrendered === true,
    'в таблице сдавшийся помечен по всем раундам со сдачи');
  // сдались все — забег завершён, победителя нет
  const surrAll = [surrB, { k: 'coins-surrender', author: 'A', round: 1, run: 1, ts: T0 + 31000 }];
  plan = CE.roundPlan(game, surrAll, T0 + 90000, 1);
  ok(plan.final === true, 'сдались все — забег завершён');
  ok(CE.winnerOf(game, surrAll, T0 + 90000, 1) === null, 'победителя у всеобщей сдачи нет');
  // pkg3-82 (правка 1): правила «сутки — не играл» больше нет: старый нетронутый
  // забег НЕ закрывается задним числом — болезнь «нулевого счёта» вылечена
  const old = Object.assign({}, game, { createdAt: T0 - 10 * 86400000 });
  plan = CE.roundPlan(old, [], T0, 1);
  ok(plan.final === false && plan.per.A.next === 1 && plan.per.B.next === 1,
    'забег, которого не касались 10 суток, жив: оба игрока снова видят «Начать раунд», а не нули');
  ok(!CE.absentOf && CE.GRACE_MS === undefined,
    'в движке нет ни «не играл», ни суточного срока — игра честно ждёт игроков');
  const late = CE.table(game, [res('A', 1, T0 + 10 * 86400000, 6)], T0 + 11 * 86400000, 1);
  ok(late.find(x => x.id === 'A').per[0].score === 6, 'результат, сданный хоть через неделю, засчитывается — срока у раунда нет');
  // соло: ждать некого; спустя сутки забег сам не «завершается»
  const soloG = Object.assign({}, game, { players: ['A'] });
  const soloPlan = CE.roundPlan(soloG, [], T0 + 10 * 86400000, 1);
  ok(!soloPlan.final && soloPlan.waiting.join() === 'A' && soloPlan.per.A.next === 1,
    'соло: спустя сутки раунд открыт — забег не «завершается» сам');
  const tSolo = CE.table(soloG, [], T0 + 10 * 86400000, 1);
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

// ── pkg3-85: время раунда в секундах с градацией 10 с, по умолчанию 1 минута
r = await call(base, '/api/games', { method: 'POST', body: { rules: 'coins', players: [], sec: 75, rounds: 2, seed: 'abc123', keys: keysOf([P.a.id]) } }, P.a.token);
ok(r.status === 200 && r.d.chat.game.sec === 80 && Math.abs(r.d.chat.game.minutes - 80 / 60) < 1e-9,
  'pkg3-85: 75 секунд округлились до 80 по шагу 10 с; минуты хранятся дробно (старые клиенты читают и их)');
r = await call(base, '/api/games', { method: 'POST', body: { rules: 'coins', players: [], rounds: 2, seed: 'abc123', keys: keysOf([P.a.id]) } }, P.a.token);
ok(r.status === 200 && r.d.chat.game.sec === 60, 'pkg3-85: время не указано — по умолчанию 1 минута');
r = await call(base, '/api/games', { method: 'POST', body: { rules: 'coins', players: [], sec: 5, rounds: 2, seed: 'abc123', keys: keysOf([P.e.id]) } }, P.e.token);
ok(r.status === 200 && r.d.chat.game.sec === 10, 'pkg3-85: меньше 10 секунд не бывает — нижняя граница шага');
r = await call(base, '/api/games', { method: 'POST', body: { rules: 'coins', players: [], sec: 99999, rounds: 2, seed: 'abc123', keys: keysOf([P.e.id]) } }, P.e.token);
ok(r.status === 200 && r.d.chat.game.sec === 1800, 'pkg3-85: больше 30 минут не бывает — верхняя граница');

// ── забег на четверых: создатель играет сразу, трое — в приглашённых; зерно чистится
r = await call(base, '/api/games', { method: 'POST', body: { rules: 'coins', players: [P.a.id, P.c.id, P.d.id], seed: 'QQ-deadBEEF-77', keys: keysOf([P.b.id, P.a.id, P.c.id, P.d.id]) } }, P.b.token);
ok(r.status === 200 && r.d.chat.game.seed === 'deadBEEF77', 'зерно карты очищено от мусора (остались только шестнадцатеричные знаки)');
const gameId = r.d.chat.id;
ok(r.d.chat.game.players.length === 1 && r.d.chat.game.invitees.length === 3 && r.d.chat.game.status === 'playing'
  && r.d.chat.game.sec === 60 && r.d.chat.game.minutes === 1 && r.d.chat.game.rounds === 3,
'забег на четверых: создатель играет сразу, трое приглашены, 3 раунда по 1 минуте (pkg3-85: новый дефолт)');

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

// ── справочник «Сейчас играют» (pkg3-82, правка 5): забег виден знакомым не
// сразу, а как только хотя бы ДВОЕ игроков сдали результаты раундов
await call(base, '/api/dm', { method: 'POST', body: { peer: P.b.id } }, P.e.token);
r = await call(base, '/api/sync?since=999999999&rsince=0', {}, P.e.token);
ok(!(r.d.games || []).some(x => x.id === gameId),
  'pkg3-82: игроков уже двое, но результатов ещё нет — в чужом «Сейчас играют» забега нет');
await call(base, '/api/messages', { method: 'POST', body: { chat: gameId, blob: 'enc:' + hex(), notify: 1, mark: 'coins-result' } }, P.a.token);
r = await call(base, '/api/sync?since=999999999&rsince=0', {}, P.e.token);
ok(!(r.d.games || []).some(x => x.id === gameId), 'pkg3-82: результат сдал один игрок — забег по-прежнему не светится');
await call(base, '/api/messages', { method: 'POST', body: { chat: gameId, blob: 'enc:' + hex(), notify: 1, mark: 'coins-result' } }, P.b.token);
r = await call(base, '/api/sync?since=999999999&rsince=0', {}, P.e.token);
const live = (r.d.games || []).find(x => x.id === gameId);
ok(!!live && live.rules === 'coins' && Array.isArray(live.players) && live.players.includes(P.a.id) && live.players.includes(P.b.id),
  'pkg3-82: результаты сдали двое — забег попал в «Сейчас играют» к знакомому: правила и список игроков на месте');

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
console.log(`  «Золотая лихорадка» pkg3-80: ${good} ✓, провалов ${bad}`);
console.log('──────────────────────────────────────────────────\n');
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
proc.kill('SIGTERM');
process.exit(bad ? 1 : 0);
