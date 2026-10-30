/**
 * pkg3-82: шесть правок «Золотой лихорадки» — серверная часть и метки клиента.
 *   • правка 5: забег виден в чужом «Сейчас играют», только когда результаты
 *     раундов сдали хотя бы ДВОЕ игроков (открытая метка mark:'coins-result'
 *     на письме; сервер письмо не читает, считает только сдавших, без дублей);
 *     метка не-игрока (зритель) и не-«лихорадки» (шахматы) игнорируется;
 *     соло не светится никогда;
 *   • правки 1–4 (метки клиента): личный темп раундов, «Следующий раунд»,
 *     «Результаты» после последнего раунда, соло-финал — карта + таблица
 *     с «Начать снова» под ней, зрительская заглушка;
 *   • правка 6 (метки): iOS-отпирание звука, насос будит контекст сам,
 *     мелодия плотнее и слышнее.
 * Запуск: node test/games82.mjs
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let good = 0, bad = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ПРОВАЛ: ') + m); if (c) good++; else bad++; };
const hex = (n = 16) => crypto.randomBytes(n).toString('hex');
const wait = ms => new Promise(r => setTimeout(r, ms));

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

console.log('\n══════════════════════════════════════════════════');
console.log('  pkg3-82: «Золотая лихорадка» — темп, видимость, музыка');
console.log('══════════════════════════════════════════════════\n');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sega-g82-'));
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
r = await call(base, '/api/state');
ok(r.status === 200 && r.d.build === 'pkg3-103', 'сервер помечен pkg3-103');
async function register(c, inviter) {
  const secret = hex(24);
  const sha = crypto.createHash('sha256').update(secret).digest('hex');
  const ir = await call(base, '/api/invites', { method: 'POST', body: { invSalt: hex(), wrappedRoomKey: 'k:' + hex(), secretHash: sha } }, inviter);
  return call(base, '/api/register', { method: 'POST', body: Object.assign({}, c, { inviteToken: ir.d.invite.id + '.' + secret }) });
}
r = await register(creds('Поля'), admin);
const g1 = r.d.token, g1Id = r.d.user.id;
r = await register(creds('Гоша'), g1);
const g2 = r.d.token, g2Id = r.d.user.id;
r = await register(creds('Вася'), admin);
const v1 = r.d.token, v1Id = r.d.user.id;
r = await register(creds('Женя'), admin);
const s1 = r.d.token, s1Id = r.d.user.id;
ok(!!s1, 'участники готовы');
// круг видимости: Женя переписывается с Полей — её партии ей видны
r = await call(base, '/api/dm', { method: 'POST', body: { peer: g1Id } }, s1);
ok(r.status === 200, 'личный чат Женя↔Поля открыт (круг видимости)');

const st = async (tok) => (await call(base, '/api/sync?since=999999999&rsince=0', {}, tok)).d;
const keysOf = ids => Object.fromEntries(ids.map(id => [id, { blob: 'w-' + id }]));
const dbGame = id => {
  const db = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'));
  const chat = (db.chats || []).find(c => c.id === id);
  return chat ? chat.game : null;
};
const mark = (tok, chatId) => call(base, '/api/messages', { method: 'POST', body: { chat: chatId, blob: 'enc:' + hex(), notify: 1, mark: 'coins-result' } }, tok);

// ── правка 5: забег светится другим, только когда результаты сдали двое
r = await call(base, '/api/games', { method: 'POST', body: { rules: 'coins', players: [g2Id], minutes: 3, rounds: 3, seed: hex(), keys: keysOf([g1Id, g2Id]) } }, g1);
const run1 = r.d.chat.id;
ok(r.status === 200, '«Золотая лихорадка» создана: Поля зовёт Гошу');
let ss = await st(s1);
ok(!ss.games.some(g => g.id === run1), 'приглашение не принято — забега нет в чужом «Сейчас играют» (пункт 9, pkg3-81)');
r = await call(base, `/api/games/${run1}/accept`, { method: 'POST', body: {} }, g2);
ok(r.status === 200, 'Гоша принял приглашение — игроков двое');
ss = await st(s1);
ok(!ss.games.some(g => g.id === run1), 'правка 5: игроков двое, но результатов нет — знакомые забег не видят (зрителю нечего смотреть)');
ok(!dbGame(run1).reported, 'правка 5: меток «сдал результат» в карточке игры ещё нет');
r = await mark(g1, run1);
ok(r.status === 200, 'Поля сдала результат раунда (письмо с открытой меткой)');
let rep = dbGame(run1).reported || [];
ok(rep.length === 1 && rep[0] === g1Id, 'правка 5: сервер запомнил ОДНОГО сдавшего — письмо он по-прежнему не читает');
ss = await st(s1);
ok(!ss.games.some(g => g.id === run1), 'правка 5: сдал один — забег знакомым по-прежнему не виден');
r = await mark(g2, run1);
ok(r.status === 200, 'Гоша сдал результат раунда');
rep = dbGame(run1).reported || [];
ok(rep.length === 2 && rep.includes(g1Id) && rep.includes(g2Id), 'правка 5: сдали двое — метки на месте');
ss = await st(s1);
const live = (ss.games || []).find(g => g.id === run1);
ok(!!live && live.rules === 'coins' && live.players.includes(g1Id) && live.players.includes(g2Id),
  'правка 5: результаты хотя бы одного раунда от двоих — забег появился в «Сейчас играют» у знакомой');
await mark(g1, run1);
rep = dbGame(run1).reported || [];
ok(rep.length === 2, 'правка 5: повторная метка того же игрока не двоится');

// ── зритель (не игрок) метку поставить не может; посторонний — тем более
r = await call(base, `/api/games/${run1}/knock`, { method: 'POST', body: {} }, v1);
ok(r.status === 200, 'Вася постучался в забег');
r = await call(base, `/api/games/${run1}/knock/approve`, { method: 'POST', body: { uid: v1Id, blob: 'w-' + hex() } }, g1);
ok(r.status === 200, 'Поля пустила Васю зрителем');
r = await mark(v1, run1);
ok(r.status === 200, 'зритель может писать в чат забега');
rep = dbGame(run1).reported || [];
ok(rep.length === 2 && !rep.includes(v1Id), 'правка 5: метка зрителя не считается — он не игрок');
r = await mark(s1, run1);
ok(r.status === 403, 'правка 5: посторонний не может ни написать в забег, ни поставить метку (403)');

// ── соло: сколько меток ни ставь — в «Сейчас играют» не светится
r = await call(base, '/api/games', { method: 'POST', body: { rules: 'coins', players: [], minutes: 2, rounds: 2, seed: hex(), keys: keysOf([g1Id]) } }, g1);
const solo = r.d.chat.id;
ok(r.status === 200, 'соло-забег создан');
await mark(g1, solo);
ss = await st(s1);
ok(!ss.games.some(g => g.id === solo), 'правка 5: соло-забег не виден никому, даже с меткой результата (игрок один)');

// ── шахматы: открытая метка забега им не прилипает, видимость прежняя
r = await call(base, '/api/games', { method: 'POST', body: { opponent: g2Id, color: 'white', rules: 'chess', keys: keysOf([g1Id, g2Id]) } }, g1);
const chess1 = r.d.chat.id;
r = await call(base, `/api/games/${chess1}/accept`, { method: 'POST', body: {} }, g2);
ok(r.status === 200, 'шахматная партия принята');
r = await mark(g1, chess1);
ok(r.status === 200 && !dbGame(chess1).reported, 'правка 5: на шахматах метка забега игнорируется (reported не появляется)');
ss = await st(s1);
ok(ss.games.some(g => g.id === chess1), 'шахматы видны в «Сейчас играют» как прежде — новое правило касается только «лихорадки»');

// ── правки 1–4: метки клиента (личный темп и кнопки)
const appJs = readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const engJs = readFileSync(path.join(ROOT, 'public', 'coins-engine.js'), 'utf8');
const gsJs = readFileSync(path.join(ROOT, 'public', 'game-sound.js'), 'utf8');
const apiJs = readFileSync(path.join(ROOT, 'lib', 'api.js'), 'utf8');

ok(engJs.includes('const waiting = active.filter(p => !per[p].finished);') && engJs.includes('const final = !waiting.length;'),
  'правки 1 и 3: забег завершён, когда все НЕ сдавшиеся прошли все раунды — движок считает это одинаково на всех устройствах');
ok(engJs.includes('let next = null;') && engJs.includes('per[p] = {'),
  'правка 1: у каждого игрока свой следующий раунд (per.next) — по его собственным письмам');
ok(appJs.includes('const myNext = (isPlayer && !mySurr && !mine.finished) ? (mine.next || null) : null;'),
  'правка 1: клиент играет СВОЙ следующий раунд, не оглядываясь на соперников');
ok(appJs.includes('if (!mine || mine.finished || mine.surrenderedAt !== null || !mine.next) return;'),
  'правка 1: «Начать раунд» стартует личный раунд; все свои раунды пройдены — кнопка не запускает лишний поиск');
ok(appJs.includes('Каждый игрок проходит раунды в своём темпе — ждать соперников не нужно.'),
  'правка 1: окно старта честно говорит, что ждать соперников не нужно');
ok(appJs.includes('Следующий раунд: ${myNext} из ${cs.rounds} →'),
  'правка 2: после каждого раунда — вскрытая карта и кнопка «Следующий раунд»');
ok(appJs.includes('id="coins-resbtn"') && appJs.includes("b7.addEventListener('click', coinsOpenResults)"),
  'правки 2 и 4: после последнего раунда — кнопка «Результаты»');
ok(appJs.includes('Вы прошли все раунды — ждём остальных игроков'),
  'правка 3: закончил раньше всех — честная отметка, что забег ещё идёт');
ok(appJs.includes('Как только все закончат, таблица результатов появится автоматически'),
  'правка 3: таблица финала появляется у всех автоматически — обновлять ничего не нужно');
ok(appJs.includes('id="coins-again2"') && appJs.includes("hide($('#modal')); coinsNewRun();"),
  'правка 4: в соло «Начать снова» — под таблицей результатов; забеги копятся в той же таблице');
ok(appJs.includes('таблица всех забегов этого устройства'),
  'правка 4: соло-финал открывается картой последнего раунда, результаты — за кнопкой');
ok(appJs.includes('все раунды ✓') && appJs.includes('ещё не начал'),
  'правки 1–3: присутствие показывает личный прогресс каждого игрока');
ok(appJs.includes('Ещё в пути:') && appJs.includes('Каждый проходит раунды в своём темпе'),
  'правка 3: окно результатов объясняет, кого ждём и почему');
ok(appJs.includes('Забег начался: идёт поиск'),
  'правка 5 (в связке с пунктом 10 pkg3-81): зритель видит честную заглушку, пока нет чужих финишей');
ok(appJs.includes("if (payload && payload.k === 'coins-result') body.mark = 'coins-result';"),
  'правка 5: метка ставится только на письме с результатом раунда');
ok(apiJs.includes('chat.game.reported = Array.from(new Set([...(chat.game.reported || []), me.id]));'),
  'правка 5: сервер хранит список сдавших без дублей (открытые данные, как leftBy)');
ok(appJs.includes('ваш раунд ') && appJs.includes('закрыто раундов: '),
  'правки 1–3: в списке чатов — свой раунд; у зрителя — сколько раундов закрыто');

// ── правка 6: музыка карты (метки звукового движка)
ok(gsJs.includes('us.buffer = ub; us.connect(ctx.destination); us.start(0);'),
  'правка 6: iOS-отпирание — бесшумный буфер при создании контекста (иначе мелодия не зазвучит)');
ok(gsJs.includes('try { const rp = ctx.resume(); if (rp && rp.catch) rp.catch(() => {}); } catch (e) {}'),
  'правка 6: насос музыки будит уснувший контекст сам, каждые полсекунды');
ok(gsJs.includes("if (ctx.state === 'closed') { ctx = null; return; }"),
  'правка 6: закрытый системой контекст не держит мелодию в заложниках — музыка переставится на новый');
ok(gsJs.includes('if (!(m.nextAt > ctx.currentTime)) m.nextAt = ctx.currentTime + 0.05;'),
  'правка 6: после сна мелодия продолжается с текущего такта, а не «стреляет очередью из прошлого»');
ok(gsJs.includes('const rest = r() < 0.15;'),
  'правка 6: пауз меньше — мелодия слышнее (она и прежде рождалась из зерна карты)');
ok(gsJs.includes('n.d * spb * 0.9, 0.085)') && gsJs.includes('n.d * spb * 0.85, 0.09)'),
  'правка 6: громкость мелодии поднята до слышимой, но осталась спокойной (≤ 0.12)');
ok(appJs.includes('if (GS.isEnabled() && GS.musicPref() && !GS.isPlaying()) GS.startMusic(L.gen.mapIdx);'),
  'правка 6: тикер забега лечит мелодию сам — запускает снова, если контекст не ожил с первого раза');

console.log('\n──────────────────────────────────────────────────');
console.log(`  pkg3-82 лихорадка: ${good} ✓, провалов ${bad}`);
console.log('──────────────────────────────────────────────────\n');
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
proc.kill('SIGTERM');
process.exit(bad ? 1 : 0);
