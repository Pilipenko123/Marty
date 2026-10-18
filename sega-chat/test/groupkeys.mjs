/**
 * pkg3-63: перевыпуск ключа группы (keys/rotate) и поколение ключа (keyEpoch).
 *
 * Что проверяется:
 *   • перенос: у старых чатов появляется keyEpoch = 0 (migrate);
 *   • ротация: участник приносит свёртки нового ключа для ВСЕХ — сервер
 *     заменяет копии и наращивает поколение; не-участник — 403;
 *     неполный набор копий — 400;
 *   • после ротации точечная доставка (POST keys) снова защищена от перезаписи (409),
 *     а keys/missing пуст (нуждающихся нет);
 *   • публичный чат несёт keyEpoch — клиент по нему ловит перевыпуск.
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
r = await call(A.base, '/api/chats/' + grp + '/keys', { method: 'POST', body: { userId: adminId, blob: 'w-admin-X' } }, g2);
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

console.log('\n──────────────────────────────────────────────────');
console.log(`  Ключ группы (ротация): ${good} ✓, провалов ${bad}`);
console.log('──────────────────────────────────────────────────\n');
A.proc.kill('SIGTERM');
process.exit(bad ? 1 : 0);
