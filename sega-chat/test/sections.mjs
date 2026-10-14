/**
 * pkg3-53: пользовательские разделы (папки) чатов.
 *
 * Что проверяется:
 *   • перенос старых записей: у участника без поля `sections` оно появляется,
 *     а мусор внутри приводится к одному виду (migrate в lib/model.js);
 *   • разделы создаются, переименовуются и удаляются; название уникально,
 *     длина ограничена, больше MAX_SECTIONS создать нельзя;
 *   • в раздел кладётся КОПИЯ чата: сам чат остаётся в системном разделе,
 *     повторное добавление не дублирует, section=null убирает копию;
 *   • удаление раздела удаляет только папку — чат жив и виден в синхронизации;
 *   • разделы личные: чужих в синхронизации нет, в чужой список не попасть;
 *   • чужой чат в свой раздел положить нельзя;
 *   • разделы переживают холодный перезапуск сервера (файловое хранилище).
 *
 * Запуск: node test/sections.mjs
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
console.log('  Разделы (папки) чатов — pkg3-53');
console.log('══════════════════════════════════════════════════\n');

// ══════════════════════════════ 1. перенос старых записей (migrate)
console.log('  1. Старые записи базы');
{
  const db = emptyDb();
  db.users.push({ id: 'u1', name: 'Старый', nameLower: 'старый', createdAt: 1 });   // без sections
  db.users.push({ id: 'u2', name: 'Мусор', nameLower: 'мусор', createdAt: 1, sections: [null, 42, { id: 's1' }, { id: 's2', name: '  Да  ва  ', chats: 'не массив' }] });
  db.messages = db.messages || [];
  migrate(db);
  ok(Array.isArray(db.users[0].sections) && db.users[0].sections.length === 0,
    'у участника без разделов появилось пустое поле sections');
  const s = db.users[1].sections;
  ok(s.length === 2, 'мусор из разделов отсеян: осталось ' + s.length + ' из 4');
  ok(s[1].name === 'Да ва', 'название раздела приводится к одному виду («Да ва»)');
  ok(Array.isArray(s[1].chats) && s[1].chats.length === 0, 'неспсик чатов заменяется пустым списком');
  migrate(db);
  ok(db.users[1].sections.length === 2, 'перенос идемпотентен: повторный вызов ничего не портит');
}

// ══════════════════════════════ 2. живой сервер
console.log('\n  2. Сервер: разделы, копии чатов и приватность');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sega-sec-'));
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

// личный чат и группа
r = await call(A.base, '/api/dm', { method: 'POST', body: { peer: guestId } }, admin);
ok(r.status === 200, 'личный чат создан');
const dmId = r.d.chat.id;
r = await call(A.base, '/api/chats', {
  method: 'POST',
  body: { titleBlob: 'enc:' + hex(), members: [guestId], keys: { [adminId]: { blob: 'k1' }, [guestId]: { blob: 'k2' } } }
}, admin);
ok(r.status === 200, 'групповой чат создан');
const groupId = r.d.chat.id;

// ── создание разделов
r = await call(A.base, '/api/sections', { method: 'POST', body: { name: 'Работа' } }, admin);
ok(r.status === 200 && r.d.sections.length === 1, 'раздел «Работа» создан');
const secId = r.d.sections[0].id;
ok(!!secId && r.d.sections[0].chats.length === 0, 'новый раздел пуст и имеет идентификатор');

r = await call(A.base, '/api/sections', { method: 'POST', body: { name: 'работа' } }, admin);
ok(r.status === 409, 'второй раздел с таким же названием (регистр не важен) отклонён');
r = await call(A.base, '/api/sections', { method: 'POST', body: { name: '   ' } }, admin);
ok(r.status === 400, 'раздел без названия отклонён');
r = await call(A.base, '/api/sections', { method: 'POST', body: { name: 'о'.repeat(33) } }, admin);
ok(r.status === 400, 'слишком длинное название отклонено');
r = await call(A.base, '/api/sections', {}, admin);
ok(r.status === 200 && r.d.sections.length === 1, 'GET /api/sections отдаёт свой список');
r = await call(A.base, '/api/sections', { method: 'POST', body: { name: 'Без входа' } });
ok(r.status === 401, 'без входа раздел не создать');

// ── переименование
r = await call(A.base, '/api/sections/' + secId + '/rename', { method: 'POST', body: { name: 'Служба' } }, admin);
ok(r.status === 200 && r.d.sections[0].name === 'Служба', 'раздел переименован');
r = await call(A.base, '/api/sections/нет-такого/rename', { method: 'POST', body: { name: 'Х' } }, admin);
ok(r.status === 404, 'переименование несуществующего раздела — 404');

// ── копия чата в раздел
r = await call(A.base, '/api/chats/' + dmId + '/section', { method: 'POST', body: { section: secId } }, admin);
ok(r.status === 200 && r.d.sections[0].chats.includes(dmId), 'копия личного чата положена в раздел');
r = await call(A.base, '/api/chats/' + dmId + '/section', { method: 'POST', body: { section: secId } }, admin);
ok(r.status === 200 && r.d.sections[0].chats.filter(x => x === dmId).length === 1, 'повторное добавление не дублирует чат');
r = await call(A.base, '/api/chats/' + groupId + '/section', { method: 'POST', body: { section: secId } }, admin);
ok(r.status === 200 && r.d.sections[0].chats.length === 2, 'в том же разделе лежит и копия группового чата');
r = await call(A.base, '/api/chats/' + dmId + '/section', { method: 'POST', body: { section: 'нет-такого' } }, admin);
ok(r.status === 404, 'копию в несуществующий раздел положить нельзя');

// чат при этом никуда не делся: он по-прежнему в списке чатов
r = await call(A.base, '/api/sync?since=0', {}, admin);
ok(r.status === 200 && r.d.chats.some(c => c.id === dmId) && r.d.chats.some(c => c.id === groupId),
  'чаты остались в своих системных разделах — разделы их не перемещают');
ok(Array.isArray(r.d.mySections) && r.d.mySections.length === 1 && r.d.mySections[0].chats.length === 2,
  'синхронизация отдаёт мои разделы (' + (r.d.mySections || []).length + ')');

// ── приватность: чужие разделы не видны
r = await call(A.base, '/api/sync?since=0', {}, guest);
ok(r.status === 200 && (r.d.mySections || []).length === 0, 'у второго участника своих разделов нет и чужих не видно');
ok(!JSON.stringify(r.d).includes('Служба'), 'название чужого раздела не уехало в чужую синхронизацию');
r = await call(A.base, '/api/chats/' + dmId + '/section', { method: 'POST', body: { section: secId } }, guest);
ok(r.status === 404, 'второй участник не может положить чат в ЧУЖОЙ раздел');

// ── чужой чат в свой раздел положить нельзя (нужен третий участник, не входящий в чат)
r = await call(A.base, '/api/sections', { method: 'POST', body: { name: 'Моё' } }, guest);
ok(r.status === 200, 'второй участник создал свой раздел');
const guestSec = r.d.sections[0].id;
{
  const third = creds('Гоша');
  const secret2 = hex(24);
  const sha2 = crypto.createHash('sha256').update(secret2).digest('hex');
  // приглашение делает второй участник: у администратора своя ссылка уже есть (одна в сутки)
  const ir2 = await call(A.base, '/api/invites', { method: 'POST', body: { invSalt: hex(), wrappedRoomKey: 'k:' + hex(), secretHash: sha2 } }, guest);
  const rr = await call(A.base, '/api/register', { method: 'POST', body: Object.assign({}, third, { inviteToken: ir2.d.invite.id + '.' + secret2 }) });
  ok(rr.status === 200, 'третий участник зарегистрировался');
  const r3 = await call(A.base, '/api/sections', { method: 'POST', body: { name: 'Гошина' } }, rr.d.token);
  ok(r3.status === 200, 'третий создал свой раздел');
  const r4 = await call(A.base, '/api/chats/' + dmId + '/section', { method: 'POST', body: { section: r3.d.sections[0].id } }, rr.d.token);
  ok(r4.status === 403, 'чужой чат (не участник) в свой раздел положить нельзя — 403');
  const r5 = await call(A.base, '/api/sections/' + guestSec + '/delete', { method: 'POST' }, rr.d.token);
  ok(r5.status === 404, 'чужой раздел удалить нельзя — 404');
}
await call(A.base, '/api/sections/' + guestSec + '/delete', { method: 'POST' }, guest);

// ── удаление раздела: папка исчезает, чаты остаются
r = await call(A.base, '/api/sections/' + secId + '/delete', { method: 'POST' }, admin);
ok(r.status === 200 && r.d.sections.length === 0, 'раздел удалён');
r = await call(A.base, '/api/sync?since=0', {}, admin);
ok(r.d.chats.some(c => c.id === dmId) && r.d.chats.some(c => c.id === groupId),
  'после удаления раздела оба чата на месте — удалена только папка');

// ── уборка копии без удаления раздела
r = await call(A.base, '/api/sections', { method: 'POST', body: { name: 'Шахматы' } }, admin);
const sec2 = r.d.sections[0].id;
await call(A.base, '/api/chats/' + dmId + '/section', { method: 'POST', body: { section: sec2 } }, admin);
r = await call(A.base, '/api/chats/' + dmId + '/section', { method: 'POST', body: { section: null } }, admin);
ok(r.status === 200 && r.d.sections[0].chats.length === 0, 'копия убрана из раздела (section=null), раздел цел');

// ── предел числа разделов
let created = 1, refused = 0;
for (let i = 0; i < 25; i++) {
  const rr = await call(A.base, '/api/sections', { method: 'POST', body: { name: 'Папка ' + i } }, admin);
  if (rr.status === 200) created++; else if (rr.status === 400) { refused++; break; }
  else if (rr.status === 429) { refused = -1; break; }
}
ok(created === 20 && refused === 1, 'разделов больше 20 создать нельзя (создано ' + created + ', отказ получен)');

// ── pkg3-54: перестановка своих разделов местами
{
  const rr = await call(A.base, '/api/sections', {}, admin);
  const names = rr.d.sections.map(x => x.name);
  const first = rr.d.sections[0].id, second = rr.d.sections[1].id;
  const mv = await call(A.base, '/api/sections/' + first + '/move', { method: 'POST', body: { dir: 'down' } }, admin);
  ok(mv.status === 200 && mv.d.sections[1].id === first, 'раздел сдвинулся вниз');
  const back = await call(A.base, '/api/sections/' + first + '/move', { method: 'POST', body: { dir: 'up' } }, admin);
  ok(back.status === 200 && back.d.sections[0].id === first, 'и вернулся вверх');
  const edge = await call(A.base, '/api/sections/' + first + '/move', { method: 'POST', body: { dir: 'up' } }, admin);
  ok(edge.status === 400, 'выше верхнего края не двигает (400)');
  const badDir = await call(A.base, '/api/sections/' + second + '/move', { method: 'POST', body: { dir: 'sideways' } }, admin);
  ok(badDir.status === 400, 'неизвестное направление отклонено');
  ok(names.length === rr.d.sections.length, 'перестановка не теряет разделы');
}

// ── холодный перезапуск: разделы пережили
A.proc.kill('SIGTERM');
await wait(400);
const B = up(await freePort(), env);
await waitReady(B.base);
r = await call(B.base, '/api/login', { method: 'POST', body: { name: 'Мартин', authKey: adminC.authKey } });
ok(r.status === 200, 'после перезапуска вход по прежнему паролю работает');
const token2 = r.d.token;
r = await call(B.base, '/api/sections', {}, token2);
ok(r.status === 200 && r.d.sections.length === 20, 'после перезапуска разделы отдаются снова: ' + (r.d.sections || []).length);
const db = JSON.parse(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'));
const meRow = db.users.find(u => u.id === adminId);
ok(Array.isArray(meRow.sections) && meRow.sections.length === 20,
  'разделы записаны в базу и пережили перезапуск: ' + meRow.sections.length);
ok(meRow.sections.some(x => x.name === 'Шахматы'), 'раздел «Шахматы» на месте после перезапуска');
ok(db.users.every(u => Array.isArray(u.sections)), 'поле разделов есть у всех участников (перенос отработал)');

console.log('\n──────────────────────────────────────────────────');
console.log(`  Разделы (папки): ${good} ✓, провалов ${bad}`);
console.log('──────────────────────────────────────────────────\n');

try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
process.exit(bad ? 1 : 0);
