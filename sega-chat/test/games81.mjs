/**
 * pkg3-81: одиннадцать правок владельца — серверная часть и метки клиента.
 *   • пункт 8: вышел из игры — она исчезает у тебя совсем (leftBy): её нет ни
 *     в «Игровых чатах», ни в «Сейчас играют», постучаться нельзя; когда
 *     игроков не осталось — игра стирается с сервера;
 *   • пункт 9: приглашение не принято — игры нет в «Сейчас играют» у
 *     приглашённого; соло-забег «Золотой лихорадки» в справочнике не светится;
 *     отклонённая партия удаляется; отказавший видит забег, если игроков ≥ 2;
 *   • пункт 11: пока игровой чат открыт на экране (клиент шлёт лёгкий опрос
 *     /api/typing), пуш «ход в игре» этому человеку не уходит — runNotify
 *     считает смотрящих и пропускает их в notifyPush;
 *   • метки клиента: счёт без дубля («200 монет», не «200200»), карта ждёт
 *     «Далее», находка растворяется на карте, зритель видит карту, звук
 *     просыпается после сна, цифры настроек контрастные, карта не выделяется.
 * Запуск: node test/games81.mjs
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
console.log('  pkg3-81: игры — выход, приглашения, пуш у доски');
console.log('══════════════════════════════════════════════════\n');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sega-g81-'));
const port = await freePort();
const proc = spawn(process.execPath, ['server.js'], {
  cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
  env: Object.assign({}, process.env, {
    STORE: 'file', DATA_DIR: dir, HOST: '127.0.0.1', HTTPS: '', PRESENCE_EVERY: '0', NEW_INVITE_DELAY: '0',
    INVITE_COOLDOWN_MS: '0', PORT: String(port),
    WATCH_TTL_MS: '700'   // сигнал «смотрю на доску» живёт совсем недолго — тест не ждёт 12 секунд
  })
});
procs.push(proc);
const base = `http://127.0.0.1:${port}`;
await waitReady(base);

const creds = name => ({ name, saltAuth: hex(), authKey: hex(32), saltWrap: hex(), wrappedKeyByPass: 'w:' + hex(), pub: 'pub:' + hex(), wrappedPriv: 'priv:' + hex() });
let r = await call(base, '/api/setup', { method: 'POST', body: Object.assign({}, creds('Мартин'), { codeProofSalt: hex(), codeProof: hex(32), codeSalt: hex(), wrappedKeyByCode: 'k:' + hex() }) });
ok(r.status === 200, 'мессенджер настроен');
const admin = r.d.token, adminId = r.d.user.id;
r = await call(base, '/api/state');
ok(r.status === 200 && r.d.build === 'pkg3-87', 'сервер помечен pkg3-87');
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
ok(!!g2 && !!v1, 'участники готовы');
// круг видимости: Вася переписывается с Полей — её партии ему видны
r = await call(base, '/api/dm', { method: 'POST', body: { peer: g1Id } }, v1);
ok(r.status === 200, 'личный чат Вася↔Поля открыт (круг видимости)');

const st = async (tok) => (await call(base, '/api/sync?since=999999999&rsince=0', {}, tok)).d;
const keysOf = ids => Object.fromEntries(ids.map(id => [id, { blob: 'w-' + id }]));

// ── пункт 9: приглашённый не видит игру в «Сейчас играют», пока не ответил
r = await call(base, '/api/games', { method: 'POST', body: { rules: 'coins', players: [g2Id, v1Id], minutes: 3, rounds: 3, seed: hex(), keys: keysOf([g1Id, g2Id, v1Id]) } }, g1);
const run1 = r.d.chat.id;
ok(r.status === 200, '«Золотая лихорадка» создана: Поля зовёт Гошу и Васю');
let sv = await st(v1), sg = await st(g2);
ok(!sv.games.some(g => g.id === run1) && !sg.games.some(g => g.id === run1),
  'пункт 9: пока приглашение не принято, игры нет в «Сейчас играют» ни у Гоши, ни у Васи');
ok(sv.invites.some(x => x.id === run1) && sg.invites.some(x => x.id === run1),
  'пункт 9: приглашение ждёт ответа в личном чате (invites)');

// Гоша принял — вошёл в игру и видит её в своих чатах
r = await call(base, `/api/games/${run1}/accept`, { method: 'POST', body: {} }, g2);
ok(r.status === 200, 'Гоша принял приглашение');
sg = await st(g2);
ok(sg.chats.some(c => c.id === run1 && (c.roles || {})[g2Id] === 'player'),
  'пункт 9: принял — игра появилась в «Игровых чатах» с ролью игрока');
ok(!sg.games.some(g => g.id === run1), 'своя игра в «Сейчас играют» не дублируется');

// Вася отклонил — игроков осталось двое, но pkg3-82 (правка 5): забег виден
// знакомым, только когда хотя бы ДВОЕ сдали результаты раундов
r = await call(base, `/api/games/${run1}/decline`, { method: 'POST', body: {} }, v1);
ok(r.status === 200, 'Вася отклонил приглашение');
sv = await st(v1);
ok(!sv.games.some(g => g.id === run1),
  'пункт 9 + правка 5 (pkg3-82): результатов ещё нет — забег у Васи не светится (зрителю нечего смотреть)');
await call(base, '/api/messages', { method: 'POST', body: { chat: run1, blob: 'enc:' + hex(), notify: 1, mark: 'coins-result' } }, g1);
sv = await st(v1);
ok(!sv.games.some(g => g.id === run1), 'правка 5 (pkg3-82): результат сдал один — другим забег по-прежнему не виден');
await call(base, '/api/messages', { method: 'POST', body: { chat: run1, blob: 'enc:' + hex(), notify: 1, mark: 'coins-result' } }, g2);
sv = await st(v1);
ok(sv.games.some(g => g.id === run1),
  'правка 5 (pkg3-82): результаты сдали двое — забег появился в «Сейчас играют» (можно постучаться в зрители)');

// ── пункт 8: вышел — игра исчезает у тебя совсем
r = await call(base, `/api/games/${run1}/leave`, { method: 'POST', body: {} }, g1);
ok(r.status === 200 && r.d.wiped === false, 'Поля вышла из забега — остальные продолжают');
let sg1 = await st(g1);
ok(!sg1.games.some(g => g.id === run1) && !sg1.chats.some(c => c.id === run1),
  'пункт 8: у вышедшего игры нет ни в «Игровых чатах», ни в «Сейчас играют» — даже пока соперник внутри');
r = await call(base, `/api/games/${run1}/knock`, { method: 'POST', body: {} }, g1);
ok(r.status === 403, 'пункт 8: постучаться в игру, из которой вышел, нельзя (403)');
r = await call(base, `/api/games/${run1}/leave`, { method: 'POST', body: {} }, g2);
ok(r.status === 200 && r.d.wiped === true, 'последний игрок вышел — игра стёрта с сервера');
sg = await st(g2); sv = await st(v1);
ok(!sg.chats.some(c => c.id === run1) && !sv.games.some(g => g.id === run1),
  'пункт 8: вышли все — игры больше нет ни у кого');
ok(!fs.readFileSync(path.join(dir, 'db.json'), 'utf8').includes(run1),
  'пункт 8: в базе данных игры не осталось — стёрта со следами');

// ── пункт 9: соло-забег в «Сейчас играют» не светится
r = await call(base, '/api/games', { method: 'POST', body: { rules: 'coins', players: [], minutes: 2, rounds: 2, seed: hex(), keys: keysOf([g1Id]) } }, g1);
const solo = r.d.chat.id;
ok(r.status === 200, 'соло-забег создан');
sv = await st(v1);
ok(!sv.games.some(g => g.id === solo), 'пункт 9: чужой соло-забег в «Сейчас играют» не показывается');
r = await call(base, `/api/games/${solo}/leave`, { method: 'POST', body: {} }, g1);
ok(r.status === 200 && r.d.wiped === true, 'соло-забег вышел — стёрт с сервера');

// ── пункт 9: парная игра до принятия не светится, отказ её удаляет
r = await call(base, '/api/games', { method: 'POST', body: { opponent: g2Id, color: 'white', rules: 'chess', keys: keysOf([g1Id, g2Id]) } }, g1);
const chess1 = r.d.chat.id;
ok(r.status === 200, 'шахматное приглашение создано');
sg = await st(g2);
ok(!sg.games.some(g => g.id === chess1) && sg.invites.some(x => x.id === chess1),
  'пункт 9: парная игра ждёт ответа — в «Сейчас играют» её нет');
r = await call(base, `/api/games/${chess1}/decline`, { method: 'POST', body: {} }, g2);
ok(r.status === 200 && r.d.wiped === true, 'Гоша отклонил — парная игра удалена');
sg1 = await st(g1);
ok(!sg1.chats.some(c => c.id === chess1), 'пункт 9: у пригласившего удалённой игры больше нет');

// ── пункт 11: пуш «ход в игре» не уходит тому, кто смотрит на доску
r = await call(base, '/api/games', { method: 'POST', body: { rules: 'coins', players: [g2Id], minutes: 3, rounds: 3, seed: hex(), keys: keysOf([g1Id, g2Id]) } }, g1);
const run2 = r.d.chat.id;
await call(base, `/api/games/${run2}/accept`, { method: 'POST', body: {} }, g2);
r = await call(base, `/api/games/${run2}/knock`, { method: 'POST', body: {} }, v1);
ok(r.status === 200, 'Вася постучался в идущий забег (заявка принята к рассмотрению)');
// Гоша «открыл доску»: клиент шлёт лёгкий опрос /api/typing — сервер помнит 12 с
r = await call(base, '/api/typing?chat=' + run2, {}, g2);
ok(r.status === 200, 'Гоша смотрит на доску (опрос /api/typing)');
r = await call(base, '/api/messages', { method: 'POST', body: { chat: run2, blob: 'enc:' + hex(), notify: 1 } }, g1);
const mid1 = r.d.message.id;
r = await call(base, '/api/notify', { method: 'POST', body: { kind: 'msg', chat: run2, mid: mid1, body: 'game' } }, g1);
ok(r.status === 200 && r.d.watched === 1,
  'пункт 11: сервер насчитал одного смотрящего — пуш «ход в игре» ему не уйдёт');
r = await call(base, '/api/messages', { method: 'POST', body: { chat: run2, blob: 'enc:' + hex(), notify: 1 } }, g1);
r = await call(base, '/api/notify', { method: 'POST', body: { kind: 'msg', chat: run2, mid: r.d.message.id } }, g1);
ok(r.status === 200 && r.d.watched === 0,
  'пункт 11: обычное сообщение (не ход игры) считается как раньше — watched=0');
await wait(900);   // WATCH_TTL_MS=700 — сигнал «смотрю» истёк
r = await call(base, '/api/messages', { method: 'POST', body: { chat: run2, blob: 'enc:' + hex(), notify: 1 } }, g1);
r = await call(base, '/api/notify', { method: 'POST', body: { kind: 'msg', chat: run2, mid: r.d.message.id, body: 'coins' } }, g1);
ok(r.status === 200 && r.d.watched === 0,
  'пункт 11: доску закрыли (сигнал истёк) — пуш снова считается всем');
// смотрящий на ДРУГОЙ чат не глушит пуш этой игры
r = await call(base, '/api/dm', { method: 'POST', body: { peer: g1Id } }, g2);
const dm2 = r.d.chat.id;
await call(base, '/api/typing?chat=' + dm2, {}, g2);
r = await call(base, '/api/messages', { method: 'POST', body: { chat: run2, blob: 'enc:' + hex(), notify: 1 } }, g1);
r = await call(base, '/api/notify', { method: 'POST', body: { kind: 'msg', chat: run2, mid: r.d.message.id, body: 'game' } }, g1);
ok(r.status === 200 && r.d.watched === 0,
  'пункт 11: открыт другой чат — пуш игры не глушится');

// ── метки клиента: одиннадцать правок видны в исходниках
const appJs = readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const css = readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
const gs = readFileSync(path.join(ROOT, 'public', 'game-sound.js'), 'utf8');
const apiJs = readFileSync(path.join(ROOT, 'lib', 'api.js'), 'utf8');
const sw = readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');

// пункт 1: карта не выделяется пальцем
ok(css.includes('user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;') && css.includes('#coins-canvas'),
  'пункт 1: выделение текста и перетаскивание у карты запрещены стилями');
ok(appJs.includes("cv.addEventListener('selectstart', ev => ev.preventDefault());") && appJs.includes('sel.removeAllRanges()'),
  'пункт 1: JavaScript гасит уже возникшее выделение и не начинает новое');
// пункт 2: вскрытая карта ждёт кнопку (pkg3-82: «Следующий раунд» / «Результаты»)
ok(appJs.includes("phase = by[S.me.id] ? 'reveal' : 'sending';"),
  'пункт 2 (pkg3-82): след законченного раунда не стирается сам — карта стоит до своей кнопки');
ok(appJs.includes('id="coins-next"') && appJs.includes('Следующий раунд'),
  'пункт 2 (pkg3-82): кнопка «Следующий раунд» открывает следующий раунд в личном темпе');
// пункт 3: находка подписана на карте и растворяется за 2 секунды
ok(appJs.includes('function coinsFlash(L, text)') && appJs.includes('until: Date.now() + 2000, total: 2000'),
  'пункт 3: подпись находки живёт 2 секунды');
ok(appJs.includes('const ty = sy > ch / 2 ? ch * 0.14 : ch * 0.86;'),
  'пункт 3: надпись рисуется на карте в стороне от аватара');
ok(!appJs.includes('chips.push(L.flash.text)'), 'пункт 3: из шапки над картой длинные подписи убраны');
ok(css.includes('.coins-hud{display:flex;gap:8px;align-items:center;justify-content:center;flex-wrap:nowrap;'),
  'пункт 3: строка над картой не переносится — кнопка музыки не прыгает, карта не съезжает');
// пункт 4: звук просыпается после сна телефона
ok(gs.includes('function wake()') && gs.includes("if (ctx && ctx.state === 'closed') ctx = null;") && gs.includes("glob.addEventListener('pageshow', wake);"),
  'пункт 4: движок звука будит контекст после сна (закрыт — создать новый, уснул — разбудить)');
ok(appJs.includes('function coinsWakeAudio()') && appJs.includes('GS.wake()'),
  'пункт 4: приложение при возврате на вкладку будит звук и возобновляет мелодию карты');
// пункт 5: все монеты собраны — досрочный финиш
ok(appJs.includes('if (L.hunt && L.got.length >= L.gen.coins.length) {') && appJs.includes('coinsFinishRound(true)'),
  'пункт 5: собрал все монеты — раунд заканчивается сразу, не дожидаясь таймера');
ok(appJs.includes("GS.play(early ? 'victory' : 'roundend');") && appJs.includes('Все монеты собраны! Раунд завершён досрочно'),
  'пункт 5: досрочный финиш звучит победно и подписан');
// пункт 6: цифры настроек контрастные
ok(css.includes('input[type=text],input[type=password],input[type=search],input[type=number],textarea{') && css.includes('color:#17222b;'),
  'пункт 6: числовые окошки — тёмные цифры на светлом поле');
ok(css.includes(':root[data-theme="dark"] input[type=number],'),
  'пункт 6: в тёмной теме цифры светлые на тёмном');
// пункт 7: счёт победителя без дубля
ok(appJs.includes("' — ' + plural(w.total, 'монета', 'монеты', 'монет')") && !appJs.includes("w.total + plural(w.total"),
  'пункт 7: «Победил Серёга — 200 монет» без превращения в «200200»');
ok(!appJs.includes('${missC} ${plural(missC'), 'пункт 7: «Не собрано» тоже без двойных чисел');
// пункт 8/9: сервер помнит вышедших и не светит приглашения
ok(apiJs.includes('chat.game.leftBy = Array.from(new Set([...(chat.game.leftBy || []), me.id]));'),
  'пункт 8: сервер записывает вышедшего — игра у него больше не всплывает');
ok(apiJs.includes('c.game.invitee !== uid') && apiJs.includes('c.game.invitees.includes(uid)'),
  'пункт 9: справочник «Сейчас играют» не показывает игры с непринятым приглашением');
ok(apiJs.includes('c.game.reported) && c.game.reported.length >= 2'),
  'пункт 9 + правка 5 (pkg3-82): соло не светится; компания — только после результатов двоих игроков');
// пункт 9: письмо отказа
ok(appJs.includes("k: 'game-decline'") && appJs.includes('отклонил(а) приглашение в'),
  'пункт 9: отказавший шлёт пригласившему шифрованное письмо — тот видит, кто отказался');
// пункт 10: зритель видит карту
ok(appJs.includes("} else if (phase === 'viewer') {") && appJs.includes('const vres = cs.letters.filter(l => CE.isResult(l)'),
  'пункт 10: зрителю открывается карта последнего законченного раунда с путём игрока');
ok(appJs.includes('who: res.author || null') && appJs.includes('coinsDrawMe(ctx, sx, sy, cell, L.who)'),
  'пункт 10: на карте зрителя — аватар того игрока, чей путь открыт');
// пункт 11: серверная кухня
ok(apiJs.includes('const watchNow = new Map();') && apiJs.includes('function isWatchingGame(userId, chatId, now)'),
  'пункт 11: сервер хранит короткий сигнал «смотрю на доску»');
ok(apiJs.includes('if (skipWatchers && isWatchingGame(u.id, chat.id)) continue;'),
  'пункт 11: notifyPush пропускает смотрящих');
// инварианты выпуска
ok(appJs.includes("const BUILD = 'pkg3-87';") && apiJs.includes("const BUILD = 'pkg3-87';"),
  'BUILD pkg3-86 совпадает в клиенте и на сервере');
ok(sw.includes("const STATIC_CACHE = 'sega-static-v80';"), 'кэш статики поднят до v79');
ok(gs.includes("version: 'pkg3-85'"), 'звуковой движок помечен pkg3-85');
ok(appJs.split("gamePlayerName(g.white) + ' и ' + gamePlayerName(g.black)").length - 1 === 2,
  'инвариант run-all: союз «и» в заголовках партий встречается ровно дважды');

console.log('\n──────────────────────────────────────────────────');
console.log(`  pkg3-81 игры/пуш: ${good} ✓, провалов ${bad}`);
console.log('──────────────────────────────────────────────────\n');
proc.kill('SIGTERM');
process.exit(bad ? 1 : 0);
