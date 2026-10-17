/**
 * pkg3-59/61: админ-меню участника — запрет приглашать, бан на сутки, удаление навсегда;
 * pkg3-61: лечение ключа группы (need → missing → перезапись) и слияние учёток (внешность).
 *
 * Что проверяется:
 *   • перенос старых записей: у участника без `bannedUntil` появляется ноль (migrate);
 *   • права: не-администратор не может ни банить, ни удалять;
 *   • бан: все запросы забаненного отклоняются 403 с кодом `banned` и сроком,
 *     вход по паролю сообщает о жалобе, чужих бан не задевает, снятие возвращает
 *     доступ БЕЗ перелогина (сессия жива), срок истекает сам (BAN_MS в окружении),
 *     себя администратор забанить не может;
 *   • запрет приглашать: галочка политики мгновенно закрывает POST /api/invites
 *     с внятной причиной и снимается обратно;
 *   • удаление навсегда: участник, его сессии, личный чат с ним и его живые
 *     ссылки-приглашения стираются; действие попадает в журнал администратора;
 *     себя удалить нельзя.
 *
 * Запуск: node test/admin-mod.mjs
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { migrate, emptyDb } = require(path.join(ROOT, 'lib', 'model.js'));

let good = 0, bad = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ПРОВАЛ: ') + m); if (c) good++; else bad++; };
const hex = (n = 16) => crypto.randomBytes(n).toString('hex');
const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function call(base, p, opts = {}, token) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { ...opts, headers: h, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const ct = r.headers.get('content-type') || '';
  const buf = Buffer.from(await r.arrayBuffer());
  if (ct.includes('json')) { try { return { status: r.status, d: JSON.parse(buf.toString('utf8')), raw: buf }; } catch (e) {} }
  return { status: r.status, d: buf.toString('utf8'), raw: buf };
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
function up(port, env) {
  const p = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
    env: Object.assign({}, process.env, env, { PORT: String(port) })
  });
  procs.push(p);
  return { base: `http://127.0.0.1:${port}`, proc: p };
}

console.log('\n══════════════════════════════════════════════════');
console.log('  Админ-меню участника (запрет/бан/удаление) — pkg3-59');
console.log('══════════════════════════════════════════════════\n');

// ══════════════════════════════ 1. перенос старых записей (migrate)
console.log('  1. Старые записи базы');
{
  const db = emptyDb();
  db.users.push({ id: 'u1', name: 'Старый', nameLower: 'старый', createdAt: 1 });
  db.users.push({ id: 'u2', name: 'Мусор', nameLower: 'мусор', createdAt: 1, bannedUntil: 'вчера' });
  migrate(db);
  ok(db.users[0].bannedUntil === 0, 'у участника без отметки бана появился ноль (не забанен)');
  ok(db.users[1].bannedUntil === 0, 'мусор в отметке бана приведён к нулю');
  migrate(db);
  ok(db.users[0].bannedUntil === 0, 'перенос идемпотентен');
}

// ══════════════════════════════ 2. живой сервер
console.log('\n  2. Сервер: права, бан, запрет приглашать');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sega-adm-'));
const BAN_MS = 1500;
const env = { STORE: 'file', DATA_DIR: dir, HOST: '127.0.0.1', HTTPS: '', PRESENCE_EVERY: '0', NEW_INVITE_DELAY: '0', BAN_MS: String(BAN_MS) };
const A = up(await freePort(), env);
await waitReady(A.base);

const creds = (name) => ({
  name, saltAuth: hex(), authKey: hex(32), saltWrap: hex(),
  wrappedKeyByPass: 'w:' + hex(), pub: 'pub:' + hex(), wrappedPriv: 'priv:' + hex()
});
const adminC = creds('Мартин');
let r = await call(A.base, '/api/setup', {
  method: 'POST', body: Object.assign({}, adminC, {
    codeProofSalt: hex(), codeProof: hex(32), codeSalt: hex(), wrappedKeyByCode: 'k:' + hex()
  })
});
ok(r.status === 200, 'мессенджер настроен, администратор вошёл');
const admin = r.d.token, adminId = r.d.user.id;

const g1C = creds('Поля'), g2C = creds('Гоша');
// ЛОВУШКА (известная по newchats): у одного участника одна ссылка в сутки —
// второго гостя приглашает ПЕРВЫЙ гость, а не администратор
async function register(c, inviter) {
  const secret = hex(24);
  const sha = crypto.createHash('sha256').update(secret).digest('hex');
  const ir = await call(A.base, '/api/invites', { method: 'POST', body: { invSalt: hex(), wrappedRoomKey: 'k:' + hex(), secretHash: sha } }, inviter);
  if (!ir.d.invite) throw new Error('приглашение не создано: ' + JSON.stringify(ir.d));
  return call(A.base, '/api/register', { method: 'POST', body: Object.assign({}, c, { inviteToken: ir.d.invite.id + '.' + secret }) });
}
r = await register(g1C, admin);
ok(r.status === 200, 'первый участник зарегистрировался');
const g1 = r.d.token, g1Id = r.d.user.id;
r = await register(g2C, g1);
ok(r.status === 200, 'второй участник зарегистрировался');
const g2 = r.d.token, g2Id = r.d.user.id;

// права: не-администратору закрыто
r = await call(A.base, '/api/admin/users/' + g2Id + '/ban', { method: 'POST', body: { on: true } }, g1);
ok(r.status === 403, 'не-администратор не может банить');
r = await call(A.base, '/api/admin/users/' + g2Id, { method: 'DELETE' }, g1);
ok(r.status === 403, 'не-администратор не может удалять');

// себя администратор не трогает
r = await call(A.base, '/api/admin/users/' + adminId + '/ban', { method: 'POST', body: { on: true } }, admin);
ok(r.status === 400, 'себя забанить нельзя');

// ── бан на сутки ──
r = await call(A.base, '/api/admin/users/' + g1Id + '/ban', { method: 'POST', body: { on: true } }, admin);
ok(r.status === 200 && r.d.bannedUntil > Date.now(), 'бан поставлен: срок в будущем');
r = await call(A.base, '/api/sync?since=0', {}, g1);
ok(r.status === 403 && r.d.code === 'banned' && r.d.until > Date.now(),
  'забаненный отклоняется везде: 403 с кодом banned и сроком');
r = await call(A.base, '/api/login', { method: 'POST', body: { name: 'Поля', authKey: g1C.authKey } });
ok(r.status === 403 && /жалоба/i.test(r.d.error || ''), 'вход по паролю честно сообщает о жалобе');
r = await call(A.base, '/api/sync?since=0', {}, g2);
ok(r.status === 200, 'чужих участников бан не задевает');
r = await call(A.base, '/api/admin/invites', {}, admin);
ok(r.status === 200 && r.d.users.find(u => u.id === g1Id).bannedUntil > Date.now(),
  'в админ-окне видна отметка действующего бана');

// снятие бана — доступ возвращается БЕЗ перелогина
r = await call(A.base, '/api/admin/users/' + g1Id + '/ban', { method: 'POST', body: { on: false } }, admin);
ok(r.status === 200 && r.d.bannedUntil === 0, 'бан снят досрочно');
r = await call(A.base, '/api/sync?since=0', {}, g1);
ok(r.status === 200, 'после снятия прежняя сессия снова работает (перелогин не нужен)');

// срок истекает сам
await call(A.base, '/api/admin/users/' + g2Id + '/ban', { method: 'POST', body: { on: true } }, admin);
r = await call(A.base, '/api/sync?since=0', {}, g2);
ok(r.status === 403, 'сразу после бана доступа нет');
await wait(BAN_MS + 400);
r = await call(A.base, '/api/sync?since=0', {}, g2);
ok(r.status === 200, 'по истечении срока доступ вернулся сам');

// ── запрет приглашать (галочка политики) ──
// (проверяем на ВТОРОМ участнике: первый уже истратил «одну ссылку в сутки»,
// когда приглашал второго — лимит считался бы вместо политики)
r = await call(A.base, '/api/admin/invite-policy', { method: 'POST', body: { globalOff: false, blockedUsers: [g2Id], blockedChats: [] } }, admin);
ok(r.status === 200, 'галочка «запрещено приглашать» сохранена');
r = await call(A.base, '/api/invites', { method: 'POST', body: { invSalt: hex(), wrappedRoomKey: 'k:' + hex(), secretHash: hex(32) } }, g2);
ok(r.status === 403 && /запрещено/i.test(r.d.error || ''), 'запрет мгновенно закрывает создание приглашений (внятная причина)');
r = await call(A.base, '/api/admin/invite-policy', { method: 'POST', body: { globalOff: false, blockedUsers: [], blockedChats: [] } }, admin);
r = await call(A.base, '/api/invites', { method: 'POST', body: { invSalt: hex(), wrappedRoomKey: 'k:' + hex(), secretHash: hex(32) } }, g2);
ok(r.status === 200, 'после снятия галочки приглашения снова создаются');

// ══════════════════════════════ 3. удаление навсегда
console.log('\n  3. Удаление участника навсегда');
r = await call(A.base, '/api/dm', { method: 'POST', body: { peer: g1Id } }, admin);
ok(r.status === 200, 'личный чат с участником создан');
const dmId = r.d.chat.id;
r = await call(A.base, '/api/admin/users/' + adminId, { method: 'DELETE' }, admin);
ok(r.status === 400, 'себя удалить нельзя');
r = await call(A.base, '/api/admin/users/' + g1Id, { method: 'DELETE' }, admin);
ok(r.status === 200, 'участник удалён');
r = await call(A.base, '/api/sync?since=0', {}, g1);
ok(r.status === 401, 'сессия удалённого погашена (401)');
r = await call(A.base, '/api/sync?since=0', {}, admin);
ok(r.status === 200 && !r.d.users.some(u => u.id === g1Id), 'удалённого больше нет в списке участников');
ok(!r.d.chats.some(c => c.id === dmId), 'личный чат с удалённым стёрт');
r = await call(A.base, '/api/admin/invites', {}, admin);
ok(!r.d.invites.some(i => i.ownerId === g1Id), 'живые ссылки-приглашения удалённого погашены');
ok(!r.d.bonds.some(b => b.owner === g1Id || b.member === g1Id)
  && !r.d.bondReqs.some(x => x.from === g1Id || x.to === g1Id), 'связи и запросы-согласия с удалённым стёрты');
ok(r.d.log.some(e => /удалил участника «Поля» навсегда/.test(e.what)), 'удаление записано в журнал администратора');
r = await call(A.base, '/api/admin/users/' + g2Id + '/ban', { method: 'POST', body: { on: true } }, admin);
ok(r.status === 200 && r.d.log === undefined, 'бан работает и после удалений');
r = await call(A.base, '/api/admin/invites', {}, admin);
ok(r.d.log.some(e => /ограничил доступ «Гоша» на сутки \(жалоба\)/.test(e.what)), 'бан записан в журнал администратора');

// ══════════════════════════════ 4. pkg3-61: лечение ключа группы и слияние учёток
console.log('\n  4. Лечение ключа группы и слияние учёток (pkg3-61)');
await call(A.base, '/api/admin/users/' + g2Id + '/ban', { method: 'POST', body: { on: false } }, admin);
r = await call(A.base, '/api/chats', {
  method: 'POST',
  body: { titleBlob: 'enc:' + hex(), members: [g2Id], keys: { [adminId]: { blob: 'k-admin' }, [g2Id]: { blob: 'k-g2-битая' } } }
}, admin);
ok(r.status === 200, 'групповой чат для опыта создан');
const grp = r.d.chat.id;
r = await call(A.base, '/api/chats/' + grp + '/keys/missing', {}, admin);
ok(r.status === 200 && (r.d.missing || []).length === 0, 'пока все копии ключа на месте — нуждающихся нет');
r = await call(A.base, '/api/chats/' + grp + '/keys/need', { method: 'POST', body: {} }, g2);
ok(r.status === 200, 'участник с нечитаемой копией попросил свежий ключ (keys/need)');
r = await call(A.base, '/api/chats/' + grp + '/keys/missing', {}, admin);
ok(r.status === 200 && (r.d.missing || []).some(x => x.id === g2Id), 'его заявка видна остальным в keys/missing');
r = await call(A.base, '/api/chats/' + grp + '/keys', { method: 'POST', body: { userId: g2Id, blob: 'k-g2-свежая' } }, admin);
ok(r.status === 200, 'свежая копия ключа доставлена поверх битой (перезапись разрешена)');
r = await call(A.base, '/api/chats/' + grp + '/keys', { method: 'POST', body: { userId: g2Id, blob: 'k-ещё' } }, admin);
ok(r.status === 409, 'без заявки нужды чужой ключ перезаписать нельзя (409)');

r = await call(A.base, '/api/admin/users/' + g2Id + '/display', { method: 'POST', body: { as: adminId } }, g2);
ok(r.status === 403, 'не-администратор не может сливать учётки');
r = await call(A.base, '/api/admin/users/' + adminId + '/display', { method: 'POST', body: { as: adminId } }, admin);
ok(r.status === 400, 'нельзя поглотить самого себя');
r = await call(A.base, '/api/admin/users/' + g2Id + '/display', { method: 'POST', body: { as: adminId } }, admin);
ok(r.status === 200, 'слияние выполнено: старая учётка носит внешность новой');
r = await call(A.base, '/api/sync?since=0', {}, admin);
{
  const g2pub = (r.d.users || []).find(x => x.id === g2Id);
  ok(!!g2pub && g2pub.name === 'Мартин' && g2pub.displayAs === adminId, 'в синхронизации старая учётка видна новым именем (вся её переписка получит это лицо)');
}
r = await call(A.base, '/api/admin/users/' + adminId + '/display', { method: 'POST', body: { as: g2Id } }, admin);
ok(r.status === 400, 'цепочки псевдонимов запрещены (цель сама носит чужую внешность)');
r = await call(A.base, '/api/admin/invites', {}, admin);
ok(r.status === 200 && (r.d.users.find(x => x.id === g2Id) || {}).displayAs === adminId, 'в админ-окне видна отметка слияния (значок «слита»)');
r = await call(A.base, '/api/admin/users/' + g2Id + '/display', { method: 'POST', body: { as: null } }, admin);
ok(r.status === 200, 'внешность отвязана (слияние обратимо)');
r = await call(A.base, '/api/sync?since=0', {}, admin);
ok(((r.d.users || []).find(x => x.id === g2Id) || {}).name === 'Гоша', 'после отвязки учётка снова с собственным именем');

console.log('\n──────────────────────────────────────────────────');
console.log(`  Админ-меню участника: ${good} ✓, провалов ${bad}`);
console.log('──────────────────────────────────────────────────\n');
A.proc.kill('SIGTERM');
process.exit(bad ? 1 : 0);
