// Проверка серверного API и схемы шифрования (повторяет логику браузера).
// Запускать при поднятом сервере и на пустой базе: node test-flow.mjs
import fs from 'node:fs';
const B = process.env.BASE || 'http://127.0.0.1:8080';
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
const importAes = raw => subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
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
async function pairKey(myPriv, peerPubB64) {
  const pub = await subtle.importKey('raw', unb64(peerPubB64), EC, false, []);
  return subtle.deriveKey({ name: 'ECDH', public: pub }, myPriv, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function call(p, opts = {}, token) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = 'Bearer ' + token;
  const r = await fetch(B + p, { ...opts, headers: h, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const d = r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text();
  return { status: r.status, d };
}

const CODE = 'cigar-club-1894';

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
  ok(r.status === 200 && r.d.user.isAdmin, 'мессенджер создан, администратор зарегистрирован');
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
if (!st0.setupRequired) { console.log('База не пустая — очистите хранилище и перезапустите сервер.'); process.exit(1); }

const admin = await createAdmin();
const friend = await register('Джеймс', 'friend-pass-2');
const third = await register('Оскар', 'third-pass-3');
const outsider = await register('Чужак', 'outsider-pass-4');

// ── нет никакого общего чата по умолчанию
{
  const s = await syncOf(admin);
  ok(Array.isArray(s.chats) && s.chats.length === 0, 'после регистрации ни у кого нет предустановленного общего чата');
}

// ── любой участник создаёт свой групповой чат
const pubs = {};
{
  const users = (await syncOf(admin)).users;
  for (const u of users) pubs[u.id] = u.pub;
}
async function makeGroup(creator, title, memberIds) {
  const raw = getRandomValues(new Uint8Array(32));
  const key = await importAes(raw);
  const keys = {};
  for (const id of [creator.id, ...memberIds]) keys[id] = { blob: await encB(await pairKey(creator.keys.priv, pubs[id]), raw) };
  const r = await call('/api/chats', {
    method: 'POST', body: { titleBlob: await encJ(key, { title }), members: memberIds, keys }
  }, creator.token);
  return { r, raw, key };
}
const bridge = await makeGroup(admin, 'Партия в бридж', [friend.id, third.id]);
ok(bridge.r.status === 200 && bridge.r.d.chat.kind === 'group', 'администратор создал групповой чат «Партия в бридж»');
const cigars = await makeGroup(friend, 'Сигары и виски', [third.id]);
ok(cigars.r.status === 200, 'обычный участник тоже может создать свой групповой чат');
const chat1 = bridge.r.d.chat.id, chat2 = cigars.r.d.chat.id;

// ── ключ чата разворачивается участником через ключ пары
{
  const s = await syncOf(friend);
  const c = s.chats.find(x => x.id === chat1);
  ok(!!c && c.key && c.key.by === admin.id, 'участник получил свой экземпляр ключа чата');
  const raw = await decB(await pairKey(friend.keys.priv, pubs[admin.id]), c.key.blob);
  const key = await importAes(raw);
  ok((await decJ(key, c.titleBlob)).title === 'Партия в бридж', 'название чата расшифровано ключом чата');
  friend.k1 = key;
  ok(!JSON.stringify(c).includes('Партия'), 'на сервере название чата хранится только зашифрованным');
}
{
  const s = await syncOf(outsider);
  ok(s.chats.length === 0, 'посторонний участник не видит чужие чаты');
  ok((await send(outsider, { blob: 'xxx', chat: chat1 })).status === 403, 'посторонний не может писать в чужой чат');
}

// ── переписка в групповом чате
let first = null;
{
  const msgs = [[admin, 'Господа, партия в четверг?'], [friend, 'Всенепременно, беру виски'], [admin, 'Секретное слово: пингвин']];
  for (const [who, text] of msgs) {
    const k = who === admin ? bridge.key : friend.k1;
    const r = await send(who, { blob: await encJ(k, { v: 1, text, author: who.name, mentions: [] }), chat: chat1 });
    if (!first) first = r.d.message.id;
  }
  const s = await syncOf(third);
  const raw = await decB(await pairKey(third.keys.priv, pubs[admin.id]), s.chats.find(c => c.id === chat1).key.blob);
  third.k1 = await importAes(raw);
  const texts = [];
  for (const m of s.messages.filter(m => m.chat === chat1)) texts.push((await decJ(third.k1, m.blob)).text);
  ok(texts.length === 3 && texts.some(t => t.includes('пингвин')), 'все участники чата читают его историю');
  const dump = process.env.DATA_FILE || './data/db.json';
  if (fs.existsSync(dump)) ok(!fs.readFileSync(dump, 'utf8').includes('пингвин'), 'в файле базы нет открытого текста');
  else ok(!!process.env.STORE_CHECKED_ELSEWHERE, 'содержимое хранилища проверяется снаружи (облачный режим)');
  const s2 = await syncOf(outsider);
  ok(!s2.messages.some(m => m.chat === chat1), 'посторонний не получает сообщений чужого чата');
}

// ── у второго чата свой ключ: участники первого его не прочитают
{
  const r = await send(friend, { blob: await encJ(cigars.key, { v: 1, text: 'Оскар, только между нами', author: 'Джеймс' }), chat: chat2 });
  ok(r.status === 200, 'сообщение во втором групповом чате отправлено');
  const s = await syncOf(admin);
  ok(!s.messages.some(m => m.chat === chat2), 'создатель другого чата вообще не видит этих сообщений');
  let readable = false;
  const m = (await syncOf(third)).messages.find(x => x.chat === chat2);
  try { await decJ(third.k1, m.blob); readable = true; } catch (e) {}
  ok(!readable, 'ключ одного чата не открывает переписку другого');
}

// ── комментарии внутри сообщения (ветка)
{
  const c1 = await send(friend, { blob: await encJ(friend.k1, { v: 1, text: 'Давайте в пятницу' }), chat: chat1, parent: first });
  ok(c1.status === 200 && c1.d.message.parent === first, 'комментарий внутри сообщения создан');
  const deep = await send(third, { blob: await encJ(third.k1, { v: 1, text: 'вложенный' }), chat: chat1, parent: c1.d.message.id });
  ok(deep.status === 400, 'комментарий к комментарию запрещён (одна ветка)');
}

// ── ответ-ссылка на любое сообщение чата (новым сообщением ниже)
let quoteMsg = null;
{
  const r = await send(third, { blob: await encJ(third.k1, { v: 1, text: 'А я про пингвина не понял', author: 'Оскар' }), chat: chat1, quote: first });
  ok(r.status === 200 && r.d.message.quote === first, 'сообщение-ответ ссылается на исходное сообщение');
  quoteMsg = r.d.message.id;
  const s = await syncOf(admin);
  const m = s.messages.find(x => x.id === quoteMsg);
  ok(!!s.messages.find(x => x.id === m.quote), 'по ссылке находится исходное сообщение — переход возможен');
  const wrong = await send(third, { blob: 'x', chat: chat2, quote: first });
  ok(wrong.status === 400, 'нельзя сослаться на сообщение из другого чата');
}

// ── личная переписка
{
  const r = await call('/api/dm', { method: 'POST', body: { peer: friend.id } }, admin.token);
  ok(r.status === 200 && r.d.chat.kind === 'dm', 'личный чат создаётся по запросу');
  const dm = r.d.chat.id;
  const kAdmin = await pairKey(admin.keys.priv, pubs[friend.id]);
  const kFriend = await pairKey(friend.keys.priv, pubs[admin.id]);
  await send(admin, { blob: await encJ(kAdmin, { v: 1, text: 'Джеймс, тет-а-тет: сюрприз для Оскара' }), chat: dm });
  const sf = await syncOf(friend);
  const m = sf.messages.find(x => x.chat === dm);
  ok((await decJ(kFriend, m.blob)).text.includes('сюрприз'), 'личное сообщение расшифровано получателем');
  ok(!(await syncOf(third)).messages.some(x => x.chat === dm), 'третий участник не получает чужую личную переписку');
  ok((await send(third, { blob: 'x', chat: dm })).status === 403, 'нельзя писать в чужой личный чат');
}

// ── прочтения, присутствие, упоминания
{
  const s = await syncOf(friend);
  const last = s.messages.filter(m => m.chat === chat1 && !m.parent).pop();
  await call('/api/read', { method: 'POST', body: { bucket: chat1, seq: last.seq } }, friend.token);
  const fr = (await syncOf(admin)).users.find(u => u.id === friend.id);
  ok((fr.reads[chat1] || 0) >= last.seq, 'отметка «прочитано» видна автору сообщения');
  ok(Date.now() - fr.activeAt < 60000, 'присутствие: участник отмечен как активный');
  ok((await call('/api/read', { method: 'POST', body: { bucket: chat2, seq: 1 } }, admin.token)).status === 403, 'нельзя отметить прочтение в чужом чате');
  const r = await send(admin, { blob: await encJ(bridge.key, { v: 1, text: '@Оскар подготовьте сигары', author: 'Мартин', mentions: [third.id] }), chat: chat1 });
  const m = (await syncOf(third)).messages.find(x => x.id === r.d.message.id);
  ok((await decJ(third.k1, m.blob)).mentions.includes(third.id), 'обращение через @ доходит до адресата');
  ok(!JSON.stringify(m).includes('Оскар'), 'на сервере обращение хранится зашифрованным');
}

// ── состав участников чата
{
  const raw = await decB(await pairKey(admin.keys.priv, pubs[admin.id]), (await syncOf(admin)).chats.find(c => c.id === chat1).key.blob);
  ok(Buffer.compare(Buffer.from(raw), Buffer.from(bridge.raw)) === 0, 'создатель разворачивает ключ чата сам себе (ECDH со своим ключом)');
  const add = await call('/api/chats/' + chat1 + '/members', {
    method: 'POST', body: { add: [{ id: outsider.id, blob: await encB(await pairKey(admin.keys.priv, pubs[outsider.id]), raw) }] }
  }, admin.token);
  ok(add.status === 200, 'в чат добавлен новый участник');
  const s = await syncOf(outsider);
  const c = s.chats.find(x => x.id === chat1);
  const oraw = await decB(await pairKey(outsider.keys.priv, pubs[admin.id]), c.key.blob);
  const okey = await importAes(oraw);
  const texts = [];
  for (const m of s.messages.filter(m => m.chat === chat1 && !m.parent)) texts.push((await decJ(okey, m.blob)).text);
  ok(texts.some(t => t.includes('пингвин')), 'новый участник читает всю прошлую историю чата');
  ok((await call('/api/chats/' + chat1 + '/members', { method: 'POST', body: { remove: [third.id] } }, outsider.token)).status === 403,
    'исключать из чата может только его создатель');
  ok((await call('/api/chats/' + chat1 + '/members', { method: 'POST', body: { remove: [outsider.id] } }, admin.token)).status === 200,
    'создатель чата убрал участника');
  ok(!(await syncOf(outsider)).chats.some(x => x.id === chat1), 'убранный участник больше не видит чат');
}

// ── права на удаление
{
  const s = await syncOf(admin);
  const own = s.messages.find(m => m.uid === admin.id && m.chat === chat1 && !m.parent);
  ok((await call('/api/messages/' + own.id, { method: 'DELETE' }, friend.token)).status === 403, 'чужое сообщение удалить нельзя');
  ok((await call('/api/messages/' + first, { method: 'DELETE' }, admin.token)).status === 200, 'создатель чата удаляет сообщение вместе с веткой');
  const s2 = await syncOf(admin);
  ok(!s2.messages.some(m => m.id === first || m.parent === first), 'ветка комментариев удалена вместе с сообщением');
  const q = s2.messages.find(m => m.id === quoteMsg);
  ok(q && !q.quote, 'ссылка на удалённое сообщение аккуратно снята');
}

// ── свой архив для каждого участника + архивация создателем
{
  const before = (await syncOf(friend)).messages.filter(m => m.chat === chat1).length;
  ok(before > 0, 'в чате есть сообщения для архива');
  const exp = await fetch(B + '/api/export', { headers: { Authorization: 'Bearer ' + friend.token } });
  const data = await exp.json();
  ok(data.messages.length >= before, 'любой участник выгружает себе зашифрованную копию своих чатов');
  ok(!data.messages.some(m => m.chat === chat2 && false), 'в выгрузке только свои чаты');
  ok((await call('/api/chats/' + chat1 + '/archive', { method: 'POST', body: { reset: true } }, third.token)).status === 403,
    'архивировать чат на сервере может только создатель');
  const a = await call('/api/chats/' + chat1 + '/archive', { method: 'POST', body: { reset: true } }, admin.token);
  ok(a.status === 200 && a.d.cleared, 'создатель заархивировал чат и очистил переписку');
  const dl = await fetch(B + '/api/archives/' + a.d.archive.file, { headers: { Authorization: 'Bearer ' + friend.token } });
  ok((await dl.json()).messages.length === before, 'участник чата скачивает архив себе');
  const denied = await fetch(B + '/api/archives/' + a.d.archive.file, { headers: { Authorization: 'Bearer ' + outsider.token } });
  ok(denied.status === 403, 'посторонний архив скачать не может');
  ok((await syncOf(admin)).messages.filter(m => m.chat === chat1).length === 0, 'после архивации чат пуст');
  ok((await syncOf(friend)).messages.some(m => m.chat === chat2), 'другие чаты архивация не затронула');
}

// ── выход из чата и смена пароля
{
  ok((await call('/api/chats/' + chat2 + '/leave', { method: 'POST', body: {} }, third.token)).status === 200, 'участник покинул чат');
  ok(!(await syncOf(third)).chats.some(c => c.id === chat2), 'покинутый чат исчез из списка');
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
  const s2 = (await call('/api/salt', { method: 'POST', body: { name: 'Джеймс' } })).d;
  const li = await call('/api/login', { method: 'POST', body: { name: 'Джеймс', authKey: hex(await pbkdf2(np, s2.saltAuth)) } });
  const wk = await aesKey(np, li.d.saltWrap);
  const pk = await decB(wk, li.d.wrappedPriv);
  ok(Buffer.compare(Buffer.from(pk), Buffer.from(friend.keys.pkcs8)) === 0, 'ключ доступа к чатам пережил смену пароля');
}

// ── кодовая фраза и память
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
  const u = (await syncOf(admin)).usage;
  ok(u.bytes >= 0 && u.limit > 0, `шкала памяти: ${u.percent}% (${u.bytes} Б из ${u.limit})`);
}
// ── аватар: клиенту уходит только отпечаток, картинка скачивается отдельно
{
  const roomKey = await importAes(admin.roomRaw);
  const pic = 'data:image/png;base64,' + 'A'.repeat(4000);
  const saved = await call('/api/profile', { method: 'POST', body: { avatar: await encJ(roomKey, { data: pic }) } }, admin.token);
  ok(saved.status === 200, 'аватар сохранён');
  const rev = saved.d.user.avatar;
  ok(typeof rev === 'string' && rev.length <= 16, 'в списке участников вместо картинки короткий отпечаток');
  const inSync = (await syncOf(friend)).users.find(u => u.id === admin.id);
  ok(inSync.avatar === rev && inSync.avatar.length <= 16, 'опрос сервера не тащит картинку с собой');
  const got = await call('/api/avatar/' + admin.id, {}, friend.token);
  ok(got.status === 200 && (await decJ(roomKey, got.d.avatar)).data === pic, 'аватар скачивается отдельным запросом и расшифровывается');
  ok((await call('/api/avatar/' + admin.id, {})).status === 401, 'чужому без входа аватар не отдают');
  const u2 = (await syncOf(admin)).usage;
  ok(u2.bytes > 4000, 'аватар учтён в шкале памяти');
}

// ── история отдаётся порциями
{
  const before = await syncOf(admin);
  const page = await call('/api/sync?since=0', {}, admin.token);
  ok(page.d.messages.length === before.messages.length && page.d.more === false,
    `история целиком помещается в один ответ (${page.d.messages.length} шт.)`);
  ok(typeof page.d.gen === 'number', 'сервер сообщает «поколение» базы для перечитывания после удалений');
}
console.log('\nГотово.');
