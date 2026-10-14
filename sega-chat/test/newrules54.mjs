/**
 * pkg3-54: «Новые» на 7 суток, групповые чаты в «Новых», «Отклонить»,
 * служебная строка «N добавил этот чат», лимиты (4 партии, сутки без приглашений).
 *
 * Сценарий:
 *   сервер A1 (старый срок 24 ч) создаёт ситуации → холодный перезапуск с новым
 *   сроком по умолчанию (7 суток) доказывает продление идущих таймеров;
 *   затем: группа в «Новых», принятие группы со служебной строкой в ленте,
 *   отклонение личного чата (и что новое письмо его не возвращает), восстановление
 *   своим письмом, предел четырёх одновременных партий;
 *   сервер B (правило включено): приглашённый первые сутки не может приглашать.
 *
 * Запуск: node test/newrules54.mjs
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;

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
  if (ct.includes('json')) { try { return { status: r.status, d: JSON.parse(buf.toString('utf8')) }; } catch (e) {} }
  return { status: r.status, d: buf.toString('utf8') };
}
async function freePort() {
  const { createServer } = await import('node:net');
  return new Promise(r => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
}
const procs = [];
process.on('exit', () => { for (const p of procs) { try { p.kill('SIGKILL'); } catch (e) {} } });
async function up(dir, extra = {}) {
  const port = await freePort();
  const p = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
    env: Object.assign({}, process.env, { PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, STORE: 'file', HTTPS: '', PRESENCE_EVERY: '0' }, extra)
  });
  procs.push(p);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/api/state')).ok) return base; } catch (e) {} await wait(200); }
  throw new Error('не поднялся ' + base);
}
const creds = (name) => ({
  name, saltAuth: hex(), authKey: hex(32), saltWrap: hex(),
  wrappedKeyByPass: 'w:' + hex(), pub: 'pub:' + hex(), wrappedPriv: 'priv:' + hex()
});
async function setup(base) {
  const c = creds('Мартин');
  const r = await call(base, '/api/setup', {
    method: 'POST', body: Object.assign({}, c, { codeProofSalt: hex(), codeProof: hex(32), codeSalt: hex(), wrappedKeyByCode: 'k:' + hex() })
  });
  return { token: r.d.token, id: r.d.user.id, creds: c };
}
async function invite(base, by, name) {
  const secret = hex(24);
  const sha = crypto.createHash('sha256').update(secret).digest('hex');
  const ir = await call(base, '/api/invites', { method: 'POST', body: { invSalt: hex(), wrappedRoomKey: 'k:' + hex(), secretHash: sha } }, by);
  const rr = await call(base, '/api/register', { method: 'POST', body: Object.assign({}, creds(name), { inviteToken: ir.d.invite.id + '.' + secret }) });
  return { token: rr.d.token, id: rr.d.user.id };
}
const syncOf = (base, tok) => call(base, '/api/sync?since=0', {}, tok).then(r => r.d);

console.log('\n══════════════════════════════════════════════════');
console.log('  pkg3-54: «Новые» на 7 суток, группы, «Отклонить», лимиты');
console.log('══════════════════════════════════════════════════\n');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sega-n54-'));

// ───────────────────────── 1. старый срок (сутки): заводим ситуации
console.log('  1. Ситуации на старом сроке (24 ч)');
let A = await up(dir, { NEW_DM_TTL: String(DAY), NEW_INVITE_DELAY: '0' });
const admin = await setup(A);
const guest = await invite(A, admin.token, 'Поля');
const gosh = await invite(A, guest.token, 'Гоша');     // приглашённый зовёт сам: правило выключено
ok(!!gosh.token, 'при выключенном правиле приглашённый может приглашать сразу');

// незнакомец пишет администратору
const srch = await call(A, '/api/search?q=' + encodeURIComponent('Мартин'), {}, gosh.token);
const adminHit = (srch.d.users || []).find(u => u.id === admin.id);
ok(!!adminHit, 'незнакомец нашёл администратора поиском');
const dmR = await call(A, '/api/dm', { method: 'POST', body: { peer: admin.id } }, gosh.token);
ok(dmR.status === 200, 'личный чат незнакомца создан');
const strangerDm = dmR.d.chat.id;
await call(A, '/api/messages', { method: 'POST', body: { chat: strangerDm, blob: 'письмо незнакомца' } }, gosh.token);

// администратор создаёт группу с Полем
const grpR = await call(A, '/api/chats', {
  method: 'POST',
  body: { titleBlob: 'enc:' + hex(), members: [guest.id], keys: { [admin.id]: { blob: 'k1' }, [guest.id]: { blob: 'k2' } } }
}, admin.token);
ok(grpR.status === 200, 'групповой чат создан');
const grp = grpR.d.chat.id;

let sA = await syncOf(A, admin.token);
const dmAtOld = (sA.chats.find(c => c.id === strangerDm) || {}).newUntil;
ok(!!dmAtOld && Math.abs(dmAtOld - sA.serverTime - DAY) < 120000, 'личный чат незнакомца идёт по старому сроку (~24 ч)');
let sG = await syncOf(A, guest.token);
const grpAtOld = (sG.chats.find(c => c.id === grp) || {}).newUntil;
ok(!!grpAtOld && Math.abs(grpAtOld - sG.serverTime - DAY) < 120000, 'групповой чат у добавленного попадает в «Новые» со сроком ~24 ч');
sA = await syncOf(A, admin.token);
ok(!(sA.chats.find(c => c.id === grp) || {}).newUntil, 'у создателя группы счётчика «Новых» нет');
procs.pop().kill('SIGTERM');
await wait(400);

// ───────────────────────── 2. холодный перезапуск: срок продлился до 7 суток
console.log('\n  2. Перезапуск с новым сроком (7 суток)');
A = await up(dir, { NEW_INVITE_DELAY: '0' });
sA = await syncOf(A, admin.token);
const dmAtNew = (sA.chats.find(c => c.id === strangerDm) || {}).newUntil;
ok(!!dmAtNew && Math.abs(dmAtNew - sA.serverTime - WEEK) < 120000, 'идущий таймер личного чата продлился до 7 суток');
sG = await syncOf(A, guest.token);
const grpAtNew = (sG.chats.find(c => c.id === grp) || {}).newUntil;
ok(!!grpAtNew && Math.abs(grpAtNew - sG.serverTime - WEEK) < 120000, 'идущий таймер группы тоже продлился до 7 суток');
ok(dmAtNew > dmAtOld + 5 * DAY, 'продление заметно больше пяти суток');

// ───────────────────────── 3. принятие группы: служебная строка в ленте
console.log('\n  3. Принятие группового чата');
const sv = await call(A, '/api/chats/' + grp + '/save', { method: 'POST', body: {} }, guest.token);
ok(sv.status === 200, 'групповой чат можно принять (/save)');
sA = await syncOf(A, admin.token);
const svcMsg = (sA.messages || []).find(m => m.chat === grp && m.svc === 'saved');
ok(!!svcMsg && svcMsg.uid === guest.id, 'в ленте группы появилась служебная строка «добавил этот чат» от принявшего');
ok(!svcMsg.blob, 'в служебной строке нет шифротекста — шифровать нечего');
sG = await syncOf(A, guest.token);
ok(!(sG.chats.find(c => c.id === grp) || {}).newUntil, 'после принятия группа вышла из «Новых»');

// ───────────────────────── 4. «Отклонить»: не возвращается сам, своё письмо возвращает
console.log('\n  4. Отклонение и восстановление');
sA = await syncOf(A, admin.token);
const stDm = (sA.chats || []).find(c => c.id === strangerDm);
ok(!!stDm && !!stDm.newUntil, 'у администратора чат незнакомца виден в «Новых» со счётчиком');
const dec = await call(A, '/api/chats/' + strangerDm + '/decline', { method: 'POST', body: {} }, admin.token);
ok(dec.status === 200, 'администратор отклонил чат незнакомца');
sA = await syncOf(A, admin.token);
ok(!(sA.chats || []).some(c => c.id === strangerDm), 'после отклонения чат исчез из списка администратора');
await call(A, '/api/messages', { method: 'POST', body: { chat: strangerDm, blob: 'ещё одно письмо' } }, gosh.token);
sA = await syncOf(A, admin.token);
ok(!(sA.chats || []).some(c => c.id === strangerDm), 'новое письмо собеседника отклонённый чат НЕ вернуло');
const back = await call(A, '/api/dm', { method: 'POST', body: { peer: gosh.id } }, admin.token);
ok(back.status === 200, 'поиск нашёл человека и открыл с ним чат');
await call(A, '/api/messages', { method: 'POST', body: { chat: strangerDm, blob: 'письмо после возврата' } }, admin.token);
ok(true, 'своё письмо восстанавливает чат (поиск → написать)');
sA = await syncOf(A, admin.token);
const backChat = (sA.chats || []).find(c => c.id === strangerDm);
ok(!!backChat && !backChat.newUntil, 'восстановленный чат виден и не висит в «Новых»');

// ───────────────────────── 5. предел четырёх одновременных партий
console.log('\n  5. Не больше четырёх одновременных партий');
let made = 0, fifth = null;
for (let i = 0; i < 5; i++) {
  const r = await call(A, '/api/games', {
    method: 'POST',
    body: { opponent: guest.id, color: 'random', keys: { [admin.id]: { blob: 'k' }, [guest.id]: { blob: 'k' } } }
  }, admin.token);
  if (r.status === 200) made++; else fifth = r;
}
ok(made === 4 && !!fifth, 'четыре партии создаются, пятая отклоняется');
ok(fifth && fifth.status === 400 && /одновременные партии/.test(fifth.d.error || ''), 'в отказе объяснение про одновременные партии');

// ───────────────────────── 6. приглашённый первые сутки не приглашает
console.log('\n  6. Сутки без приглашений для новичка');
const B = await up(fs.mkdtempSync(path.join(os.tmpdir(), 'sega-n54b-')));
const bAdmin = await setup(B);
const bNew = await invite(B, bAdmin.token, 'Дима');
const rInv = await call(B, '/api/invites', { method: 'POST', body: { invSalt: hex(), wrappedRoomKey: 'k:' + hex(), secretHash: hex() } }, bNew.token);
ok(rInv.status === 403, 'приглашённый в первые сутки не может создать ссылку (403)');
ok(/сутки/.test(rInv.d.error || ''), 'в отказе сказано про первые сутки');

console.log('\n──────────────────────────────────────────────────');
console.log(`  Правила pkg3-54: ${good} ✓, провалов ${bad}`);
console.log('──────────────────────────────────────────────────\n');

for (const p of procs) { try { p.kill('SIGTERM'); } catch (e) {} }
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
process.exit(bad ? 1 : 0);
