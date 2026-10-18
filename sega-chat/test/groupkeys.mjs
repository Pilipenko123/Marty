/**
 * pkg3-63: перевыпуск ключа группы (keys/rotate) и поколение ключа (keyEpoch).
 * pkg3-65: копии ключа помечаются поколением (ep); устаревшая доставка
 * отклоняется; нуждающимся считается и участник с копией прежнего поколения.
 *
 * Что проверяется:
 *   • перенос: у старых чатов появляется keyEpoch = 0 (migrate), прежние копии
 *     ключа помечаются текущим поколением;
 *   • ротация: участник приносит свёртки нового ключа для ВСЕХ — сервер
 *     заменяет копии и наращивает поколение; не-участник — 403;
 *     неполный набор копий — 400;
 *   • после ротации точечная доставка (POST keys) снова защищена от перезаписи (409),
 *     а keys/missing пуст (нуждающихся нет);
 *   • доставка ключа прежнего поколения (или без отметки, если были ротации) — 409;
 *   • публичный чат несёт keyEpoch и ep копии — клиент по ним ловит перевыпуск.
 *
 * Запуск: node test/groupkeys.mjs
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
console.log('  Ключ группы: перевыпуск и поколение — pkg3-63');
console.log('══════════════════════════════════════════════════\n');

// ══════════════════════════════ 1. перенос старых записей
console.log('  1. Старые записи базы');
{
  const db = emptyDb();
  db.chats.push({ id: 'g1', kind: 'group', members: ['u1'], keys: {}, createdAt: 1 });
  db.chats.push({ id: 'g2', kind: 'group', members: ['u1'], keys: {}, createdAt: 1, keyEpoch: 7 });
  migrate(db);
  ok(db.chats[0].keyEpoch === 0, 'у старого чата без поколения появилось keyEpoch = 0');
  ok(db.chats[1].keyEpoch === 7, ' имеющееся поколение не тронуто');
  migrate(db);
  ok(db.chats[0].keyEpoch === 0, 'перенос идемпотентен');

  // pkg3-65: копии ключа помечаются поколением
  const db2 = emptyDb();
  db2.chats.push({
    id: 'g3', kind: 'group', members: ['u1', 'u2'], createdAt: 1, keyEpoch: 5,
    keys: { u1: { by: 'u2', blob: 'x' }, u2: { by: 'u1', blob: 'y', ep: 3 } }
  });
  migrate(db2);
  ok(db2.chats[0].keys.u1.ep === 5, 'копия без отметки помечена текущим поколением (5)');
  ok(db2.chats[0].keys.u2.ep === 3, 'копия с прежним поколением (3) не тронута');
  migrate(db2);
  ok(db2.chats[0].keys.u1.ep === 5 && db2.chats[0].keys.u2.ep === 3, 'отметки поколений идемпотентны');
}

// ══════════════════════════════ 2. живой сервер
console.log('\n  2. Сервер: ротация ключа группы');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sega-gk-'));
const env = { STORE: 'file', DATA_DIR: dir, HOST: '127.0.0.1', HTTPS: '', PRESENCE_EVERY: '0', NEW_INVITE_DELAY: '0' };
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

async function register(c, inviter) {
  const secret = hex(24);
  const sha = crypto.createHash('sha256').update(secret).digest('hex');
  const ir = await call(A.base, '/api/invites', { method: 'POST', body: { invSalt: hex(), wrappedRoomKey: 'k:' + hex(), secretHash: sha } }, inviter);
  if (!ir.d.invite) throw new Error('приглашение не создано: ' + JSON.stringify(ir.d));
  return call(A.base, '/api/register', { method: 'POST', body: Object.assign({}, c, { inviteToken: ir.d.invite.id + '.' + secret }) });
}
r = await register(creds('Поля'), admin);
const g1 = r.d.token, g1Id = r.d.user.id;
r = await register(creds('Гоша'), g1);
const g2 = r.d.token, g2Id = r.d.user.id;
r = await register(creds('Клава'), g2);
const g3 = r.d.token, g3Id = r.d.user.id;   // вне группы — для проверки прав
ok(!!g3, 'участники готовы (Клава — вне группы)');

r = await call(A.base, '/api/chats', {
  method: 'POST',
  body: {
    titleBlob: 'enc:' + hex(), members: [g1Id, g2Id],
    keys: { [adminId]: { blob: 'w-admin-0' }, [g1Id]: { blob: 'w-g1-0' }, [g2Id]: { blob: 'w-g2-0' } }
  }
}, admin);
ok(r.status === 200, 'группа создана, копии ключа розданы');
const grp = r.d.chat.id;
ok((r.d.chat.keyEpoch || 0) === 0, 'поколение ключа новой группы — 0');

// не-участник не перевыпускает
r = await call(A.base, '/api/chats/' + grp + '/keys/rotate', {
  method: 'POST',
  body: { keys: { [adminId]: { blob: 'x1' }, [g1Id]: { blob: 'x2' }, [g2Id]: { blob: 'x3' } } }
}, g3);
ok(r.status === 403, 'не-участник не может перевыпустить ключ группы');

// неполный набор копий отклоняется
r = await call(A.base, '/api/chats/' + grp + '/keys/rotate', {
  method: 'POST', body: { keys: { [adminId]: { blob: 'x1' } } }
}, g1);
ok(r.status === 400, 'ротация без копии для каждого участника отклоняется');

// участник перевыпускает ключ
r = await call(A.base, '/api/chats/' + grp + '/keys/rotate', {
  method: 'POST',
  body: { keys: { [adminId]: { blob: 'w-admin-1' }, [g1Id]: { blob: 'w-g1-1' }, [g2Id]: { blob: 'w-g2-1' } } }
}, g1);
ok(r.status === 200 && r.d.keyEpoch === 1, 'ротация выполнена: поколение выросло до 1');

r = await call(A.base, '/api/sync?since=0', {}, admin);
const gc = (r.d.chats || []).find(c => c.id === grp);
ok(!!gc && gc.keyEpoch === 1 && gc.key && gc.key.blob === 'w-admin-1',
  'администратор получил новую копию ключа и новое поколение в синхронизации');

// после ротации точечная доставка снова защищена от перезаписи
r = await call(A.base, '/api/chats/' + grp + '/keys', { method: 'POST', body: { userId: adminId, blob: 'w-admin-X', ep: 1 } }, g2);
ok(r.status === 409, 'поверх живой копии ключа точечно не пишут (409)');
r = await call(A.base, '/api/chats/' + grp + '/keys/missing', {}, admin);
ok(r.status === 200 && (r.d.missing || []).length === 0, 'нуждающихся в ключе после ротации нет');

// вторая ротация — поколение растёт дальше
r = await call(A.base, '/api/chats/' + grp + '/keys/rotate', {
  method: 'POST',
  body: { keys: { [adminId]: { blob: 'w-admin-2' }, [g1Id]: { blob: 'w-g1-2' }, [g2Id]: { blob: 'w-g2-2' } } }
}, g2);
ok(r.status === 200 && r.d.keyEpoch === 2, 'вторая ротация: поколение 2');
r = await call(A.base, '/api/sync?since=0', {}, g1);
const gc2 = (r.d.chats || []).find(c => c.id === grp);
ok(!!gc2 && gc2.keyEpoch === 2 && gc2.key.blob === 'w-g1-2', 'участник видит свежую копию и поколение');

// ══════════════════════════════ 3. поколения копий и устаревшие доставки (pkg3-65)
console.log('\n  3. Поколения копий и устаревшие доставки — pkg3-65');

r = await call(A.base, '/api/sync?since=0', {}, admin);
let g = (r.d.chats || []).find(c => c.id === grp);
ok(!!g && g.key && g.key.ep === 2, 'после двух ротаций копия несёт текущее поколение (ep = 2)');

// битая копия → заявка need → участник в списке нуждающихся
r = await call(A.base, '/api/chats/' + grp + '/keys/need', { method: 'POST', body: {} }, g2);
ok(r.status === 200, 'участник заявил, что его копия не читается (need)');
r = await call(A.base, '/api/chats/' + grp + '/keys/missing', {}, admin);
ok(r.status === 200 && (r.d.missing || []).some(m => m.id === g2Id), 'заявитель виден в списке нуждающихся');

// устаревшие доставки отклоняются
r = await call(A.base, '/api/chats/' + grp + '/keys', { method: 'POST', body: { userId: g2Id, blob: 'w-g2-old', ep: 1 } }, g1);
ok(r.status === 409, 'доставка ключа прежнего поколения отклоняется (409)');
r = await call(A.base, '/api/chats/' + grp + '/keys', { method: 'POST', body: { userId: g2Id, blob: 'w-g2-old' } }, g1);
ok(r.status === 409, 'доставка без отметки поколения после ротации отклоняется (409)');

// доставка текущего поколения проходит и снимает заявку
r = await call(A.base, '/api/chats/' + grp + '/keys', { method: 'POST', body: { userId: g2Id, blob: 'w-g2-3', ep: 2 } }, g1);
ok(r.status === 200, 'доставка ключа текущего поколения принята');
r = await call(A.base, '/api/sync?since=0', {}, g2);
g = (r.d.chats || []).find(c => c.id === grp);
ok(!!g && g.key && g.key.blob === 'w-g2-3' && g.key.ep === 2 && !g.key.need, 'адресат получил свежую копию с поколением, заявка снята');
r = await call(A.base, '/api/chats/' + grp + '/keys/missing', {}, admin);
ok(r.status === 200 && (r.d.missing || []).length === 0, 'нуждающихся снова нет');

// новый участник получает копию, помеченную текущим поколением
r = await call(A.base, '/api/chats/' + grp + '/members', { method: 'POST', body: { add: [{ id: g3Id, blob: 'w-g3-2' }] } }, g1);
ok(r.status === 200, 'Клава добавлена в группу');
r = await call(A.base, '/api/sync?since=0', {}, g3);
g = (r.d.chats || []).find(c => c.id === grp);
ok(!!g && g.key && g.key.blob === 'w-g3-2' && g.key.ep === 2, 'копия нового участника помечена текущим поколением');

// группа без ротаций: доставка без отметки (старые клиенты) по-прежнему работает
r = await call(A.base, '/api/chats', {
  method: 'POST',
  body: {
    titleBlob: 'enc2:' + hex(), members: [g1Id, g2Id],
    keys: { [adminId]: { blob: 'b-admin' }, [g1Id]: { blob: 'b-g1' }, [g2Id]: { blob: 'b-g2' } }
  }
}, admin);
ok(r.status === 200, 'вторая группа создана (ротаций не было)');
const grp2 = r.d.chat.id;
r = await call(A.base, '/api/chats/' + grp2 + '/keys/need', { method: 'POST', body: {} }, g1);
ok(r.status === 200, 'вторая группа: участник заявил битую копию');
r = await call(A.base, '/api/chats/' + grp2 + '/keys', { method: 'POST', body: { userId: g1Id, blob: 'b-g1-fixed' } }, admin);
ok(r.status === 200, 'группа поколения 0 принимает доставку без отметки (старые клиенты работают)');

console.log('\n──────────────────────────────────────────────────');
console.log(`  Ключ группы (ротация): ${good} ✓, провалов ${bad}`);
console.log('──────────────────────────────────────────────────\n');
A.proc.kill('SIGTERM');
process.exit(bad ? 1 : 0);
