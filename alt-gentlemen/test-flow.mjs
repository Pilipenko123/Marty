import fs from 'node:fs';
// Проверка серверного API и схемы шифрования (повторяет логику браузера).
const B = 'http://127.0.0.1:8080';
const subtle = globalThis.crypto.subtle;
const getRandomValues = (a) => globalThis.crypto.getRandomValues(a);
const enc = new TextEncoder(), dec = new TextDecoder();
const ITER = 150000;
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const unhex = h => new Uint8Array(h.match(/.{1,2}/g).map(b => parseInt(b, 16)));
const b64 = b => Buffer.from(b).toString('base64');
const unb64 = s => new Uint8Array(Buffer.from(s, 'base64'));
const salt = () => hex(getRandomValues(new Uint8Array(16)));
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

async function call(p, opts = {}, token) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = 'Bearer ' + token;
  const r = await fetch(B + p, { ...opts, headers: h, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const d = r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text();
  return { status: r.status, d };
}
const ok = (c, m) => console.log((c ? '  ✓ ' : '  ✗ ПРОВАЛ: ') + m);

const CODE = 'cigar-club-1894';
let st = (await call('/api/state')).d;
console.log('state:', st.setupRequired ? 'нужна настройка' : 'настроен');

// --- админ
const ADMIN_PASS = 'martin-pass-1';
let roomRaw, admin = {};
if (st.setupRequired) {
  admin.saltAuth = salt(); admin.saltWrap = salt();
  const codeProofSalt = salt(), codeSalt = salt();
  roomRaw = getRandomValues(new Uint8Array(32));
  const body = {
    name: 'Мартин', saltAuth: admin.saltAuth, saltWrap: admin.saltWrap,
    authKey: hex(await pbkdf2(ADMIN_PASS, admin.saltAuth)),
    wrappedKeyByPass: await encB(await aesKey(ADMIN_PASS, admin.saltWrap), roomRaw),
    codeProofSalt, codeProof: hex(await pbkdf2(CODE, codeProofSalt)),
    codeSalt, wrappedKeyByCode: await encB(await aesKey(CODE, codeSalt), roomRaw)
  };
  const r = await call('/api/setup', { method: 'POST', body });
  ok(r.status === 200 && r.d.user.isAdmin, 'setup: админ создан');
  admin.token = r.d.token; admin.id = r.d.user.id;
}
// повторный setup запрещён
ok((await call('/api/setup', { method: 'POST', body: { name: 'x' } })).status === 409, 'повторная настройка запрещена');

// --- логин админа
{
  const s = (await call('/api/salt', { method: 'POST', body: { name: 'Мартин' } })).d;
  const r = await call('/api/login', { method: 'POST', body: { name: 'Мартин', authKey: hex(await pbkdf2(ADMIN_PASS, s.saltAuth)) } });
  ok(r.status === 200, 'вход админа');
  admin.token = r.d.token;
  const key = await aesKey(ADMIN_PASS, r.d.saltWrap);
  roomRaw = await decB(key, r.d.wrappedKeyByPass);
  ok(roomRaw.length === 32, 'ключ комнаты расшифрован паролем');
  const bad = await call('/api/login', { method: 'POST', body: { name: 'Мартин', authKey: hex(await pbkdf2('wrong', s.saltAuth)) } });
  ok(bad.status === 401, 'неверный пароль отклонён');
}
const roomKey = await subtle.importKey('raw', roomRaw, 'AES-GCM', false, ['encrypt', 'decrypt']);

// --- регистрация друга по кодовой фразе
st = (await call('/api/state')).d;
const friend = { pass: 'friend-pass-2', saltAuth: salt(), saltWrap: salt() };
{
  const bad = await call('/api/invite', { method: 'POST', body: { codeProof: hex(await pbkdf2('не та фраза', st.codeProofSalt)) } });
  ok(bad.status === 403, 'неверная кодовая фраза отклонена');
  const proof = hex(await pbkdf2(CODE, st.codeProofSalt));
  const inv = (await call('/api/invite', { method: 'POST', body: { codeProof: proof } })).d;
  const fRoom = await decB(await aesKey(CODE, inv.codeSalt), inv.wrappedKeyByCode);
  ok(Buffer.compare(Buffer.from(fRoom), Buffer.from(roomRaw)) === 0, 'друг получил тот же ключ комнаты по фразе');
  const r = await call('/api/register', {
    method: 'POST', body: {
      name: 'Джеймс', codeProof: proof, saltAuth: friend.saltAuth, saltWrap: friend.saltWrap,
      authKey: hex(await pbkdf2(friend.pass, friend.saltAuth)),
      wrappedKeyByPass: await encB(await aesKey(friend.pass, friend.saltWrap), fRoom)
    }
  });
  ok(r.status === 200 && !r.d.user.isAdmin, 'друг зарегистрирован');
  friend.token = r.d.token; friend.id = r.d.user.id;
  const dup = await call('/api/register', { method: 'POST', body: { name: 'Джеймс', codeProof: proof, saltAuth: salt(), saltWrap: salt(), authKey: 'aa', wrappedKeyByPass: 'x' } });
  ok(dup.status === 409, 'дубль имени отклонён');
}

// --- сообщения
for (const [who, txt] of [[admin, 'Господа, партия в бридж в четверг?'], [friend, 'Всенепременно, беру виски'], [admin, 'Секретное слово: пингвин']]) {
  const r = await call('/api/messages', { method: 'POST', body: { blob: await encJ(roomKey, { v: 1, text: txt, author: 'x' }) } }, who.token);
  ok(r.status === 200, 'отправлено: ' + txt.slice(0, 22) + '…');
}
{
  const sync = (await call('/api/sync?since=0', {}, friend.token)).d;
  ok(sync.messages.length === 3, 'синхронизация: 3 сообщения');
  const texts = [];
  for (const m of sync.messages) texts.push((await decJ(roomKey, m.blob)).text);
  ok(texts[2].includes('пингвин'), 'расшифровка у второго участника работает');
  ok(!JSON.stringify(sync.messages).includes('пингвин'), 'на сервере текст не хранится в открытом виде');
  ok(!fs.readFileSync('./data/db.json', 'utf8').includes('пингвин'), 'в файле базы открытого текста нет');
  const found = texts.filter(t => t.toLowerCase().includes('виски'));
  ok(found.length === 1, 'поиск по ключевому слову находит сообщение');
  ok(sync.usage.bytes > 0 && sync.usage.limit > 0, `шкала памяти: ${sync.usage.percent}% (${sync.usage.bytes} Б)`);
}

// --- права
{
  const sync = (await call('/api/sync?since=0', {}, admin.token)).d;
  const foreign = sync.messages.find(m => m.uid === admin.id);
  ok((await call('/api/messages/' + foreign.id, { method: 'DELETE' }, friend.token)).status === 403, 'чужое сообщение удалить нельзя');
  ok((await call('/api/messages/' + foreign.id, { method: 'DELETE' }, admin.token)).status === 200, 'админ удаляет любое сообщение');
  ok((await call('/api/admin/archives', {}, friend.token)).status === 403, 'админ-раздел закрыт для участника');
}

// --- смена имени и пароля
{
  ok((await call('/api/profile', { method: 'POST', body: { name: 'Джеймс Старший' } }, friend.token)).status === 200, 'имя изменено');
  const nSaltA = salt(), nSaltW = salt(), np = 'new-friend-pass';
  const wrapped = await encB(await aesKey(np, nSaltW), roomRaw);
  const r = await call('/api/profile', {
    method: 'POST', body: {
      password: {
        oldAuthKey: hex(await pbkdf2(friend.pass, friend.saltAuth)),
        saltAuth: nSaltA, authKey: hex(await pbkdf2(np, nSaltA)), saltWrap: nSaltW, wrappedKeyByPass: wrapped
      }
    }
  }, friend.token);
  ok(r.status === 200, 'пароль изменён');
  const s2 = (await call('/api/salt', { method: 'POST', body: { name: 'Джеймс Старший' } })).d;
  const li = await call('/api/login', { method: 'POST', body: { name: 'Джеймс Старший', authKey: hex(await pbkdf2(np, s2.saltAuth)) } });
  ok(li.status === 200, 'вход с новым паролем и новым именем');
  const rk = await decB(await aesKey(np, li.d.saltWrap), li.d.wrappedKeyByPass);
  ok(Buffer.compare(Buffer.from(rk), Buffer.from(roomRaw)) === 0, 'после смены пароля история по-прежнему читается');
}

// --- смена кодовой фразы
{
  const cps = salt(), cs = salt(), NEW = 'new-club-phrase';
  const r = await call('/api/admin/code', {
    method: 'POST', body: {
      codeProofSalt: cps, codeProof: hex(await pbkdf2(NEW, cps)),
      codeSalt: cs, wrappedKeyByCode: await encB(await aesKey(NEW, cs), roomRaw)
    }
  }, admin.token);
  ok(r.status === 200, 'кодовая фраза обновлена');
  const st2 = (await call('/api/state')).d;
  ok((await call('/api/invite', { method: 'POST', body: { codeProof: hex(await pbkdf2(CODE, st2.codeProofSalt)) } })).status === 403, 'старая фраза больше не работает');
  const inv = (await call('/api/invite', { method: 'POST', body: { codeProof: hex(await pbkdf2(NEW, st2.codeProofSalt)) } })).d;
  const rk = await decB(await aesKey(NEW, inv.codeSalt), inv.wrappedKeyByCode);
  ok(Buffer.compare(Buffer.from(rk), Buffer.from(roomRaw)) === 0, 'новая фраза открывает тот же ключ');
}

// --- архив
{
  const before = (await call('/api/sync?since=0', {}, admin.token)).d.messages.length;
  const a = await call('/api/admin/archive', { method: 'POST', body: { reset: true } }, admin.token);
  ok(a.status === 200 && a.d.cleared, 'архив создан, чат очищен');
  const dl = await fetch(B + '/api/archives/' + a.d.archive.file, { headers: { Authorization: 'Bearer ' + admin.token } });
  const arch = await dl.json();
  ok(arch.messages.length === before, `в архиве ${arch.messages.length} сообщений (было ${before})`);
  const t = await decJ(roomKey, arch.messages[0].blob);
  ok(!!t.text, 'архив расшифровывается ключом комнаты: «' + t.text + '»');
  ok((await call('/api/sync?since=0', {}, admin.token)).d.messages.length === 0, 'после архивации история пуста');
  ok((await call('/api/sync?since=0', {}, admin.token)).d.usage.bytes < 1000, 'шкала памяти обнулилась');
}
console.log('\nГотово.');
