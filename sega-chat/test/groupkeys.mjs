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
const env = { STORE: 'file', DATA_DIR: dir, HOST: '127.0.0.1', HTTPS: '', PRESENCE_EVERY: '0', NEW_INVITE_DELAY: '0', ROTATE_COOLDOWN_MS: '0' };
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

// ══════════════════════════════ 4. прежние ключи: возвращение истории (pkg3-66)
console.log('\n  4. Прежние ключи: возвращение истории — pkg3-66');
{
  const db3 = emptyDb();
  db3.chats.push({ id: 'g9', kind: 'group', members: ['u1'], keys: {}, createdAt: 1 });
  migrate(db3);
  ok(db3.chats[0].oldKeys && typeof db3.chats[0].oldKeys === 'object' && !Array.isArray(db3.chats[0].oldKeys),
    'migrate: хранилище прежних ключей добавляется с дефолтом');
}

// настоящий четвёртый пользователь — вне группы с ротациями
r = await register(creds('Незнакомка'), g3);
const g4 = r.d.token, g4Id = r.d.user.id;
ok(!!g4, 'четвёртый участник готов (вне группы с ротациями)');

// не-участник не выкладывает прежние ключи
r = await call(A.base, '/api/chats/' + grp + '/keys/old', { method: 'POST', body: { oldKeys: [{ ep: 0, wraps: { [adminId]: 'x' } }] } }, g4);
ok(r.status === 403, 'не-участник не может выкладывать прежние ключи');

// текущее поколение «прежним» не принимается
r = await call(A.base, '/api/chats/' + grp + '/keys/old', { method: 'POST', body: { oldKeys: [{ ep: 2, wraps: { [adminId]: 'x' } }] } }, g1);
ok(r.status === 200 && r.d.added === 0, 'свёртка текущего поколения как «прежняя» не принимается');

// настоящая криптография: как у клиента (ECDH + AES-GCM)
const { webcrypto } = await import('node:crypto');
const subtleW = webcrypto.subtle;
const ECW = { name: 'ECDH', namedCurve: 'P-256' };
const kpA = await subtleW.generateKey(ECW, true, ['deriveKey']);
const kpG1 = await subtleW.generateKey(ECW, true, ['deriveKey']);
const kpG2 = await subtleW.generateKey(ECW, true, ['deriveKey']);
const pubA = Buffer.from(await subtleW.exportKey('raw', kpA.publicKey)).toString('base64');
const pubG1 = Buffer.from(await subtleW.exportKey('raw', kpG1.publicKey)).toString('base64');
const pubG2 = Buffer.from(await subtleW.exportKey('raw', kpG2.publicKey)).toString('base64');
async function ecdhAes(priv, pubB64) {
  const pub = await subtleW.importKey('raw', Buffer.from(pubB64, 'base64'), ECW, false, []);
  return subtleW.deriveKey({ name: 'ECDH', public: pub }, priv, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function aesEncW(key, bytes) {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtleW.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
  return Buffer.from(out).toString('base64');
}
const O1 = webcrypto.getRandomValues(new Uint8Array(32));
const wrapForAdmin = await aesEncW(await ecdhAes(kpG1.privateKey, pubA), O1);
const wrapForG2 = await aesEncW(await ecdhAes(kpG1.privateKey, pubG2), O1);

r = await call(A.base, '/api/chats/' + grp + '/keys/old', {
  method: 'POST',
  body: { oldKeys: [{ ep: 1, wraps: { [adminId]: wrapForAdmin, [g2Id]: wrapForG2 } }] }
}, g1);
ok(r.status === 200 && r.d.added === 2, 'участник выложил свёртки прежнего ключа (поколение 1)');

r = await call(A.base, '/api/sync?since=0', {}, admin);
g = (r.d.chats || []).find(c => c.id === grp);
const okEntry = (g.oldKeys || []).find(o => o.ep === 1);
ok(!!okEntry && okEntry.by === g1Id && typeof okEntry.blob === 'string' && okEntry.blob.length > 0,
  'администратор получил свою свёртку прежнего ключа в синхронизации');
r = await call(A.base, '/api/sync?since=0', {}, g3);
g = (r.d.chats || []).find(c => c.id === grp);
const nullEntry = (g.oldKeys || []).find(o => o.ep === 1);
ok(!!nullEntry && nullEntry.blob === null, 'участнику без свёртки отдаётся метка поколения без содержимого');

// свёртки не перезаписываются
r = await call(A.base, '/api/chats/' + grp + '/keys/old', {
  method: 'POST', body: { oldKeys: [{ ep: 1, wraps: { [adminId]: 'zzz' } }] }
}, g2);
ok(r.status === 200 && r.d.added === 0, 'прежнюю свёртку участника не перезаписывают');

// криптопуть клиента: свёртка разворачивается личным ключом адресата
{
  r = await call(A.base, '/api/sync?since=0', {}, admin);
  g = (r.d.chats || []).find(c => c.id === grp);
  const entry = (g.oldKeys || []).find(o => o.ep === 1);
  const k = await ecdhAes(kpA.privateKey, pubG1);   // pairKeyWith(кто завернул)
  const rawB = Buffer.from(entry.blob, 'base64');
  const plain = new Uint8Array(await subtleW.decrypt({ name: 'AES-GCM', iv: rawB.slice(0, 12) }, k, rawB.slice(12)));
  ok(Buffer.from(plain).equals(Buffer.from(O1)), 'свёртка прежнего ключа разворачивается, как в клиенте (ECDH + AES-GCM)');
}

// ══════════════════════════════ 5. предохранители перевыпуска (pkg3-67)
console.log('\n  5. Предохранители перевыпуска — pkg3-67');
{
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sega-gk67-'));
  const env2 = { STORE: 'file', DATA_DIR: dir2, HOST: '127.0.0.1', HTTPS: '', PRESENCE_EVERY: '0', NEW_INVITE_DELAY: '0', ROTATE_COOLDOWN_MS: '150' };
  const B2 = up(await freePort(), env2);
  await waitReady(B2.base);
  const r2 = await call(B2.base, '/api/setup', {
    method: 'POST', body: Object.assign({}, creds('Хозяин'), {
      codeProofSalt: hex(), codeProof: hex(32), codeSalt: hex(), wrappedKeyByCode: 'k:' + hex()
    })
  });
  const tA = r2.d.token, idA = r2.d.user.id;
  const secret2 = hex();
  const sha2 = crypto.createHash('sha256').update(secret2).digest('hex');
  const ir2 = await call(B2.base, '/api/invites', { method: 'POST', body: { invSalt: hex(), wrappedRoomKey: 'k:' + hex(), secretHash: sha2 } }, tA);
  if (!ir2.d.invite) throw new Error('приглашение на втором сервере не создано: ' + JSON.stringify(ir2.d));
  const r3 = await call(B2.base, '/api/register', { method: 'POST', body: Object.assign({}, creds('Гость'), { inviteToken: ir2.d.invite.id + '.' + secret2 }) });
  const tB = r3.d.token, idB = r3.d.user.id;
  const rc = await call(B2.base, '/api/chats', {
    method: 'POST',
    body: { titleBlob: 'enc:' + hex(), members: [idB], keys: { [idA]: { blob: 'w-a' }, [idB]: { blob: 'w-b' } } }
  }, tA);
  const grp67 = rc.d.chat.id;
  const rot = { method: 'POST', body: { keys: { [idA]: { blob: 'x-a' }, [idB]: { blob: 'x-b' } } } };
  let q = await call(B2.base, '/api/chats/' + grp67 + '/keys/rotate', rot, tA);
  ok(q.status === 200, 'первый перевыпуск прошёл');
  q = await call(B2.base, '/api/chats/' + grp67 + '/keys/rotate', rot, tB);
  ok(q.status === 429, 'второй перевыпуск подряд отклонён (429, часовой предохранитель)');
  await wait(200);
  q = await call(B2.base, '/api/chats/' + grp67 + '/keys/rotate', rot, tB);
  ok(q.status === 200, 'после паузы перевыпуск снова разрешён');
  q = await call(B2.base, '/api/sync?since=0', {}, tA);
  const svc = (q.d.messages || []).filter(m => m.chat === grp67 && m.svc === 'rotatekeys');
  ok(svc.length === 2, 'каждый перевыпуск оставил в ленте служебную строку (2 шт.)');
  B2.proc.kill('SIGTERM');
}

// свёртка самому себе: второе устройство той же учётки получит историю
r = await call(A.base, '/api/chats/' + grp + '/keys/old', {
  method: 'POST',
  body: { oldKeys: [{ ep: 1, wraps: { [g1Id]: 'w-self-g1' } }] }
}, g1);
ok(r.status === 200 && r.d.added === 1, 'свёртка самому себе принята (вторые устройства учётки)');
r = await call(A.base, '/api/sync?since=0', {}, g1);
g = (r.d.chats || []).find(c => c.id === grp);
ok(!!(g.oldKeys || []).find(o => o.ep === 1 && o.blob === 'w-self-g1'), 'участник видит в синхронизации собственную свёртку');

console.log('\n──────────────────────────────────────────────────');
console.log(`  Ключ группы (ротация): ${good} ✓, провалов ${bad}`);
console.log('──────────────────────────────────────────────────\n');
A.proc.kill('SIGTERM');
process.exit(bad ? 1 : 0);
