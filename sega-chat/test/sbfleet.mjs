/**
 * pkg3-57: «Морской бой» — зашифрованный слепок флота на сервере.
 *
 * Что проверяется:
 *   • перенос старых записей: у участника без поля `sbFleets` оно появляется,
 *     мусор отсеивается, больше 60 слепков не держим (migrate в lib/model.js);
 *   • игрок кладёт слепок (POST /api/games/:id/sbfleet) и забирает его
 *     в синхронизации (mySbFleets) — на всех СВОИХ устройствах;
 *   • приватность: сопернику слепок не отдаётся ни в каком виде;
 *   • не-игрок (ещё не принял приглашение) положить слепок не может;
 *   • валидация: огромный blob — 400, не морской бой / нет игры — 404, без входа — 401;
 *   • blob:null стирает слепок; выход из партии и удаление игры — тоже;
 *   • слепок переживает холодный перезапуск сервера (файловое хранилище).
 *
 * Запуск: node test/sbfleet.mjs
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
console.log('  Морской бой: слепок флота на сервере — pkg3-57');
console.log('══════════════════════════════════════════════════\n');

// ══════════════════════════════ 1. перенос старых записей (migrate)
console.log('  1. Старые записи базы');
{
  const db = emptyDb();
  db.users.push({ id: 'u1', name: 'Старый', nameLower: 'старый', createdAt: 1 });   // без sbFleets
  db.users.push({
    id: 'u2', name: 'Мусор', nameLower: 'мусор', createdAt: 1,
    sbFleets: { a: 'blob', b: 42, c: null, d: 'x'.repeat(9000), e: '' }
  });
  const many = {};
  for (let i = 0; i < 70; i++) many['g' + i] = 'b' + i;
  db.users.push({ id: 'u3', name: 'Полка', nameLower: 'полка', createdAt: 1, sbFleets: many });
  migrate(db);
  ok(db.users[0].sbFleets && typeof db.users[0].sbFleets === 'object'
    && Object.keys(db.users[0].sbFleets).length === 0,
  'у участника без слепков появилась пустая карта sbFleets');
  const f2 = db.users[1].sbFleets;
  ok(Object.keys(f2).length === 1 && f2.a === 'blob', 'мусор из слепков отсечён: осталась одна настоящая запись');
  ok(Object.keys(db.users[2].sbFleets).length === 60, 'больше 60 слепков не держим (осталось 60 из 70)');
  migrate(db);
  ok(Object.keys(db.users[1].sbFleets).length === 1, 'перенос идемпотентен: повторный вызов ничего не портит');
}

// ══════════════════════════════ 2. живой сервер
console.log('\n  2. Сервер: слепок флота, приватность, уборка');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sega-sbf-'));
const env = { STORE: 'file', DATA_DIR: dir, HOST: '127.0.0.1', HTTPS: '', PRESENCE_EVERY: '0', NEW_INVITE_DELAY: '0' };
let A = up(await freePort(), env);
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

const guestC = creds('Поля');
{
  const secret = hex(24);
  const sha = crypto.createHash('sha256').update(secret).digest('hex');
  const ir = await call(A.base, '/api/invites', { method: 'POST', body: { invSalt: hex(), wrappedRoomKey: 'k:' + hex(), secretHash: sha } }, admin);
  r = await call(A.base, '/api/register', { method: 'POST', body: Object.assign({}, guestC, { inviteToken: ir.d.invite.id + '.' + secret }) });
}
ok(r.status === 200, 'второй участник зарегистрировался');
const guest = r.d.token, guestId = r.d.user.id;

// партия морского боя: Мартин (белый, стреляет первым) приглашает Полю
r = await call(A.base, '/api/games', {
  method: 'POST',
  body: { opponent: guestId, color: 'white', rules: 'seabattle', keys: { [adminId]: { blob: 'k:' + hex() }, [guestId]: { blob: 'k:' + hex() } } }
}, admin);
ok(r.status === 200 && (r.d.chat.game || {}).rules === 'seabattle', 'партия морского боя создана');
const gid = r.d.chat.id;
const blobA = 'enc-fleet-' + hex(40);

// до принятия приглашения Поля не игрок — слепок положить не может
r = await call(A.base, '/api/games/' + gid + '/sbfleet', { method: 'POST', body: { blob: 'enc-fleet-' + hex() } }, guest);
ok(r.status === 403, 'не-игрок (приглашение не принято) слепок положить не может');

r = await call(A.base, '/api/games/' + gid + '/sbfleet', { method: 'POST', body: { blob: blobA } }, admin);
ok(r.status === 200 && r.d.ok === true, 'игрок положил зашифрованный слепок флота');
r = await call(A.base, '/api/games/' + gid + '/sbfleet', { method: 'POST', body: { blob: 'ы'.repeat(9000) } }, admin);
ok(r.status === 400, 'огромный слепок отклонён (400)');
r = await call(A.base, '/api/games/' + gid + '/sbfleet', { method: 'POST', body: { blob: blobA } });
ok(r.status === 401, 'без входа слепок не положить');

r = await call(A.base, '/api/sync?since=0', {}, admin);
ok(r.status === 200 && r.d.mySbFleets && r.d.mySbFleets[gid] === blobA, 'синхронизация возвращает МОЙ слепок (mySbFleets)');
r = await call(A.base, '/api/sync?since=0', {}, guest);
ok(r.status === 200 && (!r.d.mySbFleets || !r.d.mySbFleets[gid]), 'сопернику мой слепок не отдаётся');
ok(!r.raw.toString('utf8').includes(blobA), 'в чужом ответе синхронизации нет даже шифротекста слепка');

// шахматы — не морской бой: слепка не бывает
r = await call(A.base, '/api/games', {
  method: 'POST',
  body: { opponent: guestId, color: 'white', rules: 'chess', keys: { [adminId]: { blob: 'k:' + hex() }, [guestId]: { blob: 'k:' + hex() } } }
}, admin);
const chessId = r.d.chat.id;
r = await call(A.base, '/api/games/' + chessId + '/sbfleet', { method: 'POST', body: { blob: blobA } }, admin);
ok(r.status === 404, 'у шахмат слепка флота нет (404)');
r = await call(A.base, '/api/games/нет-такой-игры/sbfleet', { method: 'POST', body: { blob: blobA } }, admin);
ok(r.status === 404, 'несуществующая игра — 404');

// Поля принимает приглашение и кладёт свой слепок
r = await call(A.base, '/api/games/' + gid + '/accept', { method: 'POST', body: {} }, guest);
ok(r.status === 200, 'приглашение принято — партия идёт');
const blobB = 'enc-fleet-b-' + hex(40);
r = await call(A.base, '/api/games/' + gid + '/sbfleet', { method: 'POST', body: { blob: blobB } }, guest);
ok(r.status === 200, 'второй игрок положил свой слепок');
r = await call(A.base, '/api/sync?since=0', {}, admin);
ok(!r.raw.toString('utf8').includes(blobB), 'слепок соперника не уехал в мою синхронизацию');

// стереть слепок
r = await call(A.base, '/api/games/' + gid + '/sbfleet', { method: 'POST', body: { blob: null } }, admin);
ok(r.status === 200, 'просьба стереть слепок (blob:null) принята');
r = await call(A.base, '/api/sync?since=0', {}, admin);
ok(!r.d.mySbFleets || !r.d.mySbFleets[gid], 'слепок стёрт — синхронизация его больше не отдаёт');
// положим обратно для проверки перезапуска
await call(A.base, '/api/games/' + gid + '/sbfleet', { method: 'POST', body: { blob: blobA } }, admin);

// ══════════════════════════════ 3. холодный перезапуск
console.log('\n  3. Холодный перезапуск сервера');
A.proc.kill('SIGTERM');
await wait(400);
const B = up(await freePort(), env);
await waitReady(B.base);
r = await call(B.base, '/api/login', { method: 'POST', body: { name: 'Мартин', authKey: adminC.authKey } });
ok(r.status === 200, 'после перезапуска вход по прежнему паролю работает');
const admin2 = r.d.token;
r = await call(B.base, '/api/login', { method: 'POST', body: { name: 'Поля', authKey: guestC.authKey } });
ok(r.status === 200, 'второй участник тоже вошёл после перезапуска');
const guest2 = r.d.token;
r = await call(B.base, '/api/sync?since=0', {}, admin2);
ok(r.status === 200 && r.d.mySbFleets && r.d.mySbFleets[gid] === blobA, 'слепок пережил холодный перезапуск сервера');

// ══════════════════════════════ 4. уборка при выходе из партии
console.log('\n  4. Выход из партии и удаление игры');
r = await call(B.base, '/api/games/' + gid + '/leave', { method: 'POST', body: {} }, admin2);
ok(r.status === 200 && r.d.resigned === true, 'Мартин сдался и вышел из партии');
r = await call(B.base, '/api/sync?since=0', {}, admin2);
ok(!r.d.mySbFleets || !r.d.mySbFleets[gid], 'у вышедшего игрока слепок стёрт');
r = await call(B.base, '/api/games/' + gid + '/leave', { method: 'POST', body: {} }, guest2);
ok(r.status === 200 && r.d.wiped === true, 'игроков не осталось — игра стёрта');
r = await call(B.base, '/api/sync?since=0', {}, guest2);
ok(!r.d.mySbFleets || !r.d.mySbFleets[gid], 'при удалении игры слепки стираются у обоих');

console.log('\n──────────────────────────────────────────────────');
console.log(`  Слепок флота (сервер): ${good} ✓, провалов ${bad}`);
console.log('──────────────────────────────────────────────────\n');
B.proc.kill('SIGTERM');
process.exit(bad ? 1 : 0);
