// Проверка серверного API и схемы шифрования (повторяет логику браузера).
// Запускать при поднятом сервере и желательно на пустой базе: node test-flow.mjs
import fs from 'node:fs';
const B = 'http://127.0.0.1:8080';
const subtle = globalThis.crypto.subtle;
const getRandomValues = (a) => globalThis.crypto.getRandomValues(a);
const enc = new TextEncoder(), dec = new TextDecoder();
const ITER = 150000;
const EC = { name: 'ECDH', namedCurve: 'P-256' };
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const unhex = h => new Uint8Array(h.match(/.{1,2}/g).map(b => parseInt(b, 16)));
const b64 = b => Buffer.from(b).toString('base64');
const unb64 = s => new Uint8Array(Buffer.from(s, 'base64'));
const salt = () => hex(getRandomValues(new Uint8Array(16)));
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ПРОВАЛ: ') + m); if (!c) process.exitCode = 1; };

async function pbkdf2(p, s) {
  const k = await subtle.importKey('raw', enc.encode(p), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', salt: unhex(s), iterations: ITER, hash: 'SHA-256' }, k, 256));
}
const aesKey = async (p, s) => subtle.importKey('raw', await pbkdf2(p, s), 'AES-GCM', false, ['encrypt', 'decrypt']);
async function encB(key, bytes) {
  const iv = getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
  return b64(out);
}
async function decB(key, s) {
  const r = unb64(s);
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: r.slice(0, 12) }, key, r.slice(12)));
}
const encJ = async (k, o) => encB(k, enc.encode(JSON.stringify(o)));
const decJ = async (k, s) => JSON.parse(dec.decode(await decB(k, s)));
async function pair(wrapKey) {
  const kp = await subtle.generateKey(EC, true, ['deriveKey', 'deriveBits']);
  const pub = b64(await subtle.exportKey('raw', kp.publicKey));
  const pkcs8 = new Uint8Array(await subtle.exportKey('pkcs8', kp.privateKey));
  return { pub, priv: kp.privateKey, pkcs8, wrappedPriv: await encB(wrapKey, pkcs8) };
}
async function dmKey(myPriv, peerPubB64) {
  const pub = await subtle.importKey('raw', unb64(peerPubB64), EC, false, []);
  return subtle.deriveKey({ name: 'ECDH', public: pub }, myPriv, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
const dmCh = (a, b) => 'dm:' + [a, b].sort().join('|');

async function call(p, opts = {}, token) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = 'Bearer ' + token;
  const r = await fetch(B + p, { ...opts, headers: h, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const d = r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text();
  return { status: r.status, d };
}

const CODE = 'cigar-club-1894';
const users = {};

async function createAdmin() {
  const u = { name: 'Мартин', pass: 'martin-pass-1', saltAuth: salt(), saltWrap: salt() };
  const wrapKey = await aesKey(u.pass, u.saltWrap);
  u.keys = await pair(wrapKey);
  const roomRaw = getRandomValues(new Uint8Array(32));
  const codeProofSalt = salt(), codeSalt = salt();
  const r = await call('/api/setup', {
    method: 'POST', body: {
      name: u.name, saltAuth: u.saltAuth, saltWrap: u.saltWrap,
      authKey: hex(await pbkdf2(u.pass, u.saltAuth)),
      wrappedKeyByPass: await encB(wrapKey, roomRaw),
      codeProofSalt, codeProof: hex(await pbkdf2(CODE, codeProofSalt)),
      codeSalt, wrappedKeyByCode: await encB(await aesKey(CODE, codeSalt), roomRaw),
      pub: u.keys.pub, wrappedPriv: u.keys.wrappedPriv
    }
  });
  ok(r.status === 200 && r.d.user.isAdmin, 'основан чат, создан администратор');
  u.token = r.d.token; u.id = r.d.user.id; u.roomRaw = roomRaw;
  return u;
}
async function register(name, pass) {
  const st = (await call('/api/state')).d;
  const codeProof = hex(await pbkdf2(CODE, st.codeProofSalt));
  const inv = (await call('/api/invite', { method: 'POST', body: { codeProof } })).d;
  const roomRaw = await decB(await aesKey(CODE, inv.codeSalt), inv.wrappedKeyByCode);
  const u = { name, pass, saltAuth: salt(), saltWrap: salt(), roomRaw };
  const wrapKey = await aesKey(pass, u.saltWrap);
  u.keys = await pair(wrapKey);
  const r = await call('/api/register', {
    method: 'POST', body: {
      name, codeProof, saltAuth: u.saltAuth, saltWrap: u.saltWrap,
      authKey: hex(await pbkdf2(pass, u.saltAuth)),
      wrappedKeyByPass: await encB(wrapKey, roomRaw),
      pub: u.keys.pub, wrappedPriv: u.keys.wrappedPriv
    }
  });
  ok(r.status === 200, 'зарегистрирован участник ' + name);
  u.token = r.d.token; u.id = r.d.user.id;
  return u;
}
const send = (u, body) => call('/api/messages', { method: 'POST', body }, u.token);
const syncOf = (u, since = 0) => call('/api/sync?since=' + since + '&active=1', {}, u.token).then(r => r.d);

// ─────────────────────────────────────────────────────────────── сценарий
const st0 = (await call('/api/state')).d;
if (!st0.setupRequired) { console.log('База не пустая — удалите data/db.json и перезапустите сервер.'); process.exit(1); }

const admin = await createAdmin();
users.admin = admin;
const friend = await register('Джеймс', 'friend-pass-2');
const third = await register('Оскар', 'third-pass-3');

const roomKey = await subtle.importKey('raw', admin.roomRaw, 'AES-GCM', false, ['encrypt', 'decrypt']);

// ── общий чат
let groupIds = [];
for (const [who, txt] of [[admin, 'Господа, партия в бридж в четверг?'], [friend, 'Всенепременно, беру виски'],
[admin, 'Секретное слово: пингвин']]) {
  const r = await send(who, { blob: await encJ(roomKey, { v: 1, text: txt, author: who.name, mentions: [] }), ch: 'group' });
  groupIds.push(r.d.message.id);
}
ok(groupIds.length === 3, 'три сообщения в общем чате');
{
  const s = await syncOf(friend);
  const texts = [];
  for (const m of s.messages) texts.push((await decJ(roomKey, m.blob)).text);
  ok(texts.some(t => t.includes('пингвин')), 'общий чат расшифровывается всеми участниками');
  ok(!fs.readFileSync('./data/db.json', 'utf8').includes('пингвин'), 'в файле базы нет открытого текста');
}

// ── комментарии к сообщению (чат внутри чата)
{
  const parent = groupIds[0];
  const c1 = await send(friend, { blob: await encJ(roomKey, { v: 1, text: 'Я за, но давайте в пятницу', author: 'Джеймс' }), ch: 'group', parent });
  const c2 = await send(third, { blob: await encJ(roomKey, { v: 1, text: 'Поддерживаю пятницу', author: 'Оскар' }), ch: 'group', parent });
  ok(c1.status === 200 && c2.status === 200, 'два комментария к сообщению созданы');
  ok(c1.d.message.parent === parent, 'комментарий привязан к исходному сообщению');
  const deep = await send(third, { blob: await encJ(roomKey, { v: 1, text: 'вложенный' }), ch: 'group', parent: c1.d.message.id });
  ok(deep.status === 400, 'комментарий к комментарию запрещён (одна ветка)');
  const s = await syncOf(admin);
  ok(s.messages.filter(m => m.parent === parent).length === 2, 'в ветке видно оба комментария');
}

// ── личная переписка: ключ пары через ECDH
{
  const users2 = (await syncOf(admin)).users;
  const friendPub = users2.find(u => u.id === friend.id).pub;
  const adminPub = users2.find(u => u.id === admin.id).pub;
  const kAdmin = await dmKey(admin.keys.priv, friendPub);
  const kFriend = await dmKey(friend.keys.priv, adminPub);
  const ch = dmCh(admin.id, friend.id);
  const r = await send(admin, { blob: await encJ(kAdmin, { v: 1, text: 'Джеймс, тет-а-тет: сюрприз для Оскара' }), ch });
  ok(r.status === 200, 'личное сообщение отправлено');
  const sf = await syncOf(friend);
  const dm = sf.messages.find(m => m.ch === ch);
  ok(!!dm, 'получатель видит личное сообщение');
  ok((await decJ(kFriend, dm.blob)).text.includes('сюрприз'), 'получатель расшифровал его своим ключом пары');
  const st = await syncOf(third);
  ok(!st.messages.some(m => m.ch === ch), 'третий участник вообще не получает чужую личную переписку');
  const hack = await send(third, { blob: 'xxx', ch });
  ok(hack.status === 403, 'нельзя писать в чужой личный канал');
  let readable = false;
  try { await decJ(roomKey, dm.blob); readable = true; } catch (e) {}
  ok(!readable, 'общий ключ комнаты не открывает личную переписку');
}

// ── прочтения и присутствие
{
  const s = await syncOf(friend);
  const last = s.messages.filter(m => (m.ch || 'group') === 'group' && !m.parent).pop();
  await call('/api/read', { method: 'POST', body: { bucket: 'group', seq: last.seq } }, friend.token);
  const s2 = await syncOf(admin);
  const fr = s2.users.find(u => u.id === friend.id);
  ok((fr.reads.group || 0) >= last.seq, 'отметка «прочитано» видна автору сообщения');
  ok(Date.now() - fr.activeAt < 60000, 'присутствие: участник отмечен как активный');
  const foreign = await call('/api/read', { method: 'POST', body: { bucket: dmCh(admin.id, friend.id), seq: 1 } }, third.token);
  ok(foreign.status === 403, 'нельзя отметить прочтение в чужой переписке');
}

// ── упоминания через @ (хранятся внутри зашифрованного сообщения)
{
  const r = await send(admin, { blob: await encJ(roomKey, { v: 1, text: '@Оскар подготовьте сигары', author: 'Мартин', mentions: [third.id] }), ch: 'group' });
  ok(r.status === 200, 'сообщение с обращением через @ отправлено');
  const s = await syncOf(third);
  const m = s.messages.find(x => x.id === r.d.message.id);
  const p = await decJ(roomKey, m.blob);
  ok(p.mentions.includes(third.id), 'упомянутый участник видит адресованное ему обращение');
  ok(!JSON.stringify(m).includes('Оскар'), 'на сервере обращение хранится в зашифрованном виде');
}

// ── права и удаление
{
  const s = await syncOf(admin);
  const own = s.messages.find(m => m.uid === admin.id && !m.parent && (m.ch || 'group') === 'group');
  ok((await call('/api/messages/' + own.id, { method: 'DELETE' }, friend.token)).status === 403, 'чужое сообщение удалить нельзя');
  const kids = s.messages.filter(m => m.parent === own.id).length;
  const del = await call('/api/messages/' + own.id, { method: 'DELETE' }, admin.token);
  ok(del.status === 200, 'админ удаляет сообщение в общем чате' + (kids ? ' вместе с веткой' : ''));
  const s2 = await syncOf(admin);
  ok(!s2.messages.some(m => m.id === own.id || m.parent === own.id), 'комментарии удалённого сообщения тоже исчезли');
  ok((await call('/api/admin/archives', {}, friend.token)).status === 403, 'админ-раздел закрыт для обычного участника');
}

// ── смена имени и пароля (ключ пары перезаворачивается)
{
  ok((await call('/api/profile', { method: 'POST', body: { name: 'Джеймс Старший' } }, friend.token)).status === 200, 'имя изменено');
  const np = 'friend-pass-3', nSaltA = salt(), nSaltW = salt();
  const wrapKey = await aesKey(np, nSaltW);
  const r = await call('/api/profile', {
    method: 'POST', body: {
      password: {
        oldAuthKey: hex(await pbkdf2(friend.pass, friend.saltAuth)),
        saltAuth: nSaltA, authKey: hex(await pbkdf2(np, nSaltA)), saltWrap: nSaltW,
        wrappedKeyByPass: await encB(wrapKey, friend.roomRaw),
        wrappedPriv: await encB(wrapKey, friend.keys.pkcs8)
      }
    }
  }, friend.token);
  ok(r.status === 200, 'пароль изменён');
  const s2 = (await call('/api/salt', { method: 'POST', body: { name: 'Джеймс Старший' } })).d;
  const li = await call('/api/login', { method: 'POST', body: { name: 'Джеймс Старший', authKey: hex(await pbkdf2(np, s2.saltAuth)) } });
  ok(li.status === 200, 'вход с новым именем и паролем');
  const wk = await aesKey(np, li.d.saltWrap);
  const rk = await decB(wk, li.d.wrappedKeyByPass);
  const pk = await decB(wk, li.d.wrappedPriv);
  ok(Buffer.compare(Buffer.from(rk), Buffer.from(friend.roomRaw)) === 0, 'история общего чата по-прежнему читается');
  ok(Buffer.compare(Buffer.from(pk), Buffer.from(friend.keys.pkcs8)) === 0, 'ключ личных переписок пережил смену пароля');
  friend.token = li.d.token;
}

// ── кодовая фраза
{
  const cps = salt(), cs = salt(), NEW = 'new-club-phrase';
  ok((await call('/api/admin/code', {
    method: 'POST', body: {
      codeProofSalt: cps, codeProof: hex(await pbkdf2(NEW, cps)),
      codeSalt: cs, wrappedKeyByCode: await encB(await aesKey(NEW, cs), admin.roomRaw)
    }
  }, admin.token)).status === 200, 'кодовая фраза обновлена');
  const st2 = (await call('/api/state')).d;
  ok((await call('/api/invite', { method: 'POST', body: { codeProof: hex(await pbkdf2(CODE, st2.codeProofSalt)) } })).status === 403, 'старая фраза больше не работает');
}

// ── память и архив
{
  const before = (await syncOf(admin)).messages.length;
  const u = (await syncOf(admin)).usage;
  ok(u.bytes > 0 && u.limit > 0, `шкала памяти: ${u.percent}% (${u.bytes} Б из ${u.limit})`);
  const a = await call('/api/admin/archive', { method: 'POST', body: { reset: true } }, admin.token);
  ok(a.status === 200 && a.d.cleared, 'архив создан, чат очищен');
  const dl = await fetch(B + '/api/archives/' + a.d.archive.file, { headers: { Authorization: 'Bearer ' + admin.token } });
  const arch = await dl.json();
  ok(arch.messages.length === before, `в архиве администратора ${arch.messages.length} сообщений (было ${before})`);
  const dl3 = await fetch(B + '/api/archives/' + a.d.archive.file, { headers: { Authorization: 'Bearer ' + third.token } });
  const arch3 = await dl3.json();
  ok(arch3.messages.length < before, 'в копии для третьего участника чужих личных сообщений нет');
  ok((await syncOf(admin)).messages.length === 0, 'после архивации история пуста');
  ok((await syncOf(admin)).usage.bytes < 1000, 'шкала памяти обнулилась');
}
console.log('\nГотово.');
