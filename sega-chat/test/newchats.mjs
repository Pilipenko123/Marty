// pkg3-49: «Новые» и «Личные чаты».
//  1) приглашённый сразу виден у пригласившего (связь + сохранённый личный чат);
//  2) приглашённый видит ТОЛЬКО один личный чат с пригласившим — чужие группы и партии скрыты;
//  3) письмо из поиска падает адресату в «Новые» на сутки и удаляется само,
//     у автора остаётся навсегда; «Добавить пользователя в мои личные чаты» сохраняет безвременно;
//  4) любой может убрать чат из своих личных — новое письмо вернёт его в «Новые»;
//  + связи «Приглашенные» переживают перезапуск облачной базы (починка pkg3-47).
// Запуск: node test/newchats.mjs  (сервер поднимает test/run-all.mjs; можно и вручную:
//   PORT=8797 STORE=file DATA_DIR=/tmp/nc NEW_DM_TTL=1200 node server.js)
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock } from './mock-ydb.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const subtle = globalThis.crypto.subtle;
const getRandomValues = a => globalThis.crypto.getRandomValues(a);
const enc = new TextEncoder();
const ITER = 150000;
const EC = { name: 'ECDH', namedCurve: 'P-256' };
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const unhex = h => new Uint8Array(h.match(/.{1,2}/g).map(b => parseInt(b, 16)));
const b64 = b => Buffer.from(b).toString('base64');
const salt = () => hex(getRandomValues(new Uint8Array(16)));
let bad = 0, good = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ПРОВАЛ: ') + m); if (c) good++; else bad++; };
const wait = ms => new Promise(r => setTimeout(r, ms));

async function pbkdf2(p, s) {
  const k = await subtle.importKey('raw', enc.encode(p), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unhex(s), iterations: ITER }, k, 256));
}
const aesKey = async (p, s) => subtle.importKey('raw', await pbkdf2(p, s), 'AES-GCM', false, ['encrypt', 'decrypt']);
const sha256hex = async s => hex(await subtle.digest('SHA-256', enc.encode(s)));
async function encB(key, bytes) {
  const iv = getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
  return b64(out);
}
async function decB(key, s) {
  const r = new Uint8Array(Buffer.from(s, 'base64'));
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: r.slice(0, 12) }, key, r.slice(12)));
}
const encJ = async (k, o) => encB(k, enc.encode(JSON.stringify(o)));
/** пара ключей: pub — наружу (b64), priv — CryptoKey для ECDH внутри теста */
async function pairFull(wrapKey) {
  const kp = await subtle.generateKey(EC, true, ['deriveKey', 'deriveBits']);
  const pub = b64(await subtle.exportKey('raw', kp.publicKey));
  const pkcs8 = new Uint8Array(await subtle.exportKey('pkcs8', kp.privateKey));
  return { pub, wrappedPriv: await encB(wrapKey, pkcs8), priv: kp.privateKey };
}
async function pairKey(myPriv, peerPubB64) {
  const pub = await subtle.importKey('raw', unhex2(peerPubB64), EC, false, []);
  return subtle.deriveKey({ name: 'ECDH', public: pub }, myPriv, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
const unhex2 = s => new Uint8Array(Buffer.from(s, 'base64'));

const CODE = 'cigar-club-1894';
let B = process.env.BASE || '';
const call = async (p, opts = {}, token) => {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = 'Bearer ' + token;
  const r = await fetch(B + p, { ...opts, headers: h, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const d = r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text();
  return { status: r.status, d };
};
const syncOf = async u => (await call('/api/sync?since=0&rsince=0', {}, u.token)).d;

async function createAdmin(name, pass) {
  const u = { name, pass, saltAuth: salt(), saltWrap: salt() };
  const wrapKey = await aesKey(pass, u.saltWrap);
  u.keys = await pairFull(wrapKey);
  const roomRaw = getRandomValues(new Uint8Array(32));
  const codeProofSalt = salt(), codeSalt = salt();
  const r = await call('/api/setup', {
    method: 'POST', body: {
      name, saltAuth: u.saltAuth, saltWrap: u.saltWrap,
      authKey: hex(await pbkdf2(pass, u.saltAuth)),
      wrappedKeyByPass: await encB(wrapKey, roomRaw),
      codeProofSalt, codeProof: hex(await pbkdf2(CODE, codeProofSalt)),
      codeSalt, wrappedKeyByCode: await encB(await aesKey(CODE, codeSalt), roomRaw),
      pub: u.keys.pub, wrappedPriv: u.keys.wrappedPriv
    }
  });
  if (r.status !== 200) throw new Error('setup: ' + r.status + ' ' + JSON.stringify(r.d));
  u.token = r.d.token; u.id = r.d.user.id; u.roomRaw = roomRaw;
  return u;
}
async function makeInvite(u) {
  const secret = hex(getRandomValues(new Uint8Array(24)));
  const invSalt = salt();
  const wrappedRoomKey = await encB(await aesKey(secret, invSalt), u.roomRaw);
  const r = await call('/api/invites', {
    method: 'POST', body: { invSalt, wrappedRoomKey, secretHash: await sha256hex(secret) }
  }, u.token);
  if (r.status !== 200) return r;
  return Object.assign(r, { token: r.d.invite.id + '.' + secret });
}
async function registerByInvite(name, pass, token) {
  const info = (await call('/api/join-info?token=' + encodeURIComponent(token))).d;
  if (!info.ok) return { status: 0, d: info, info };
  const secret = token.slice(token.indexOf('.') + 1);
  const roomRaw = await decB(await aesKey(secret, info.invSalt), info.wrappedRoomKey);
  const u = { name, pass, saltAuth: salt(), saltWrap: salt(), roomRaw };
  const wrapKey = await aesKey(pass, u.saltWrap);
  u.keys = await pairFull(wrapKey);
  const r = await call('/api/register', {
    method: 'POST', body: {
      name, inviteToken: token, saltAuth: u.saltAuth, saltWrap: u.saltWrap,
      authKey: hex(await pbkdf2(pass, u.saltAuth)),
      wrappedKeyByPass: await encB(wrapKey, roomRaw),
      pub: u.keys.pub, wrappedPriv: u.keys.wrappedPriv
    }
  });
  u.token = r.d && r.d.token; u.id = r.d && r.d.user && r.d.user.id;
  return { status: r.status, d: r.d, user: u };
}
async function registerByCode(name, pass) {
  const st = (await call('/api/state')).d;
  const codeProof = hex(await pbkdf2(CODE, st.codeProofSalt));
  const inv = (await call('/api/invite', { method: 'POST', body: { codeProof } })).d;
  const roomRaw = await decB(await aesKey(CODE, inv.codeSalt), inv.wrappedKeyByCode);
  const u = { name, pass, saltAuth: salt(), saltWrap: salt(), roomRaw };
  const wrapKey = await aesKey(pass, u.saltWrap);
  u.keys = await pairFull(wrapKey);
  const r = await call('/api/register', {
    method: 'POST', body: {
      name, codeProof, saltAuth: u.saltAuth, saltWrap: u.saltWrap,
      authKey: hex(await pbkdf2(pass, u.saltAuth)),
      wrappedKeyByPass: await encB(wrapKey, roomRaw),
      pub: u.keys.pub, wrappedPriv: u.keys.wrappedPriv
    }
  });
  u.token = r.d && r.d.token; u.id = r.d && r.d.user && r.d.user.id;
  return { status: r.status, d: r.d, user: u };
}
/** шифрованное письмо в личный чат (ECDH-ключ, как в настоящем клиенте) */
async function sendDm(from, to, chatId, text) {
  const k = await pairKey(from.keys.priv, to.keys.pub);
  return call('/api/messages', { method: 'POST', body: { chat: chatId, blob: await encJ(k, { text }) } }, from.token);
}
const dmBetween = (s, a, b) => (s.chats || []).find(c => c.kind === 'dm' && c.members.includes(a) && c.members.includes(b));

console.log('\n══════════════════════════════════════════════════');
console.log('  pkg3-49: «Новые», сутки, сохранение и облачная память связей');
console.log('══════════════════════════════════════════════════');

// ── среда 1: файлы, «сутки» укорочены до 1.2 с (TTL задаёт run-all через окружение)
const dirA = mkdtempSync(join(tmpdir(), 'sega-nc-a-'));
const PORT_A = 8961 + Math.floor(Math.random() * 200);
const srvA = spawn(process.execPath, ['server.js'], {
  cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
  env: Object.assign({}, process.env, { PORT: String(PORT_A), HOST: '127.0.0.1', DATA_DIR: dirA, STORE: 'file', HTTPS: '', NEW_DM_TTL: '1200' })
});
B = 'http://127.0.0.1:' + PORT_A;
for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/api/state')).ok) break; } catch (e) {} await wait(250); }

// ══ требование 1: приглашённый сразу виден у пригласившего ══════════
console.log('\n  ── приглашение: связь и общий личный чат');
const martin = await createAdmin('Мартин', 'martin-pass-1');
const inv1 = await makeInvite(martin);
ok(inv1.status === 200, 'ссылка-приглашение создана');
const boryaR = await registerByInvite('Боря', 'borya-pass-1', inv1.token);
const borya = boryaR.user;
ok(boryaR.status === 200, 'Боря зарегистрировался по ссылке');

let sM = await syncOf(martin);
ok((sM.myBonds || []).includes(borya.id), 'требование 1: Боря сразу в «Приглашенных» у Мартина (myBonds)');
ok((sM.users || []).some(u => u.id === borya.id), 'требование 1: Мартин видит Борю в списке людей');
let dmMB = dmBetween(sM, martin.id, borya.id);
ok(!!dmMB, 'требование 1: личный чат Мартин↔Боря создан при регистрации');
ok(!!dmMB && (dmMB.savedBy || []).includes(martin.id) && (dmMB.savedBy || []).includes(borya.id),
  'требование 1: чат сразу сохранён у обоих — ни у кого не попадёт в «Новые»');
ok(!!dmMB && !dmMB.newUntil, 'требование 1: у приглашённого чата нет счётчика суток');
ok((dmMB.savedBy || []).includes(martin.id), 'требование 1: Мартин держит чат в своих «Личных чатах»');
let sB = await syncOf(borya);
ok((dmMB.savedBy || []).includes(borya.id), 'требование 1: Боря держит чат в своих «Личных чатах»');
ok((sB.users || []).some(u => u.id === martin.id), 'требование 1: Боря видит Мартина');

// ══ требование 2: приглашённый видит только один личный чат ═════════
console.log('\n  ── требование 2: чужие группы и партии приглашённому не видны');
// аварийное окно — чтобы добавить людей без второй ссылки (одна в сутки)
ok((await call('/api/admin/emergency-reg', { method: 'POST', body: { open: true } }, martin.token)).status === 200, 'аварийное окно открыто');
const klava = (await registerByCode('Клава', 'klava-pass-1')).user;
await call('/api/admin/emergency-reg', { method: 'POST', body: { open: false } }, martin.token);
ok(!!klava.token, 'Клава зарегистрирована по кодовой фразе');

// группа Мартин+Клава
const gk = getRandomValues(new Uint8Array(32));
const keysG = {
  [martin.id]: { blob: await encB(await pairKey(martin.keys.priv, martin.keys.pub), gk) },
  [klava.id]: { blob: await encB(await pairKey(martin.keys.priv, klava.keys.pub), gk) }
};
const grp = await call('/api/chats', { method: 'POST', body: { members: [klava.id], titleBlob: await encJ(await subtle.importKey('raw', gk, 'AES-GCM', false, ['encrypt']), { title: 'Друзья' }), keys: keysG } }, martin.token);
ok(grp.status === 200, 'группа Мартин+Клава создана');
// партия Мартин (белые) vs Клава (чёрные)
const keysGame = {
  [martin.id]: { blob: await encB(await pairKey(martin.keys.priv, martin.keys.pub), gk) },
  [klava.id]: { blob: await encB(await pairKey(martin.keys.priv, klava.keys.pub), gk) }
};
const game = await call('/api/games', { method: 'POST', body: { opponent: klava.id, color: 'white', keys: keysGame } }, martin.token);
ok(game.status === 200, 'партия создана');
const gid = game.d.chat.id;
ok((await call('/api/games/' + gid + '/accept', { method: 'POST', body: {} }, klava.token)).status === 200, 'партия начата (playing)');

sB = await syncOf(borya);
ok(sB.chats.length === 1 && sB.chats[0].id === dmMB.id, 'требование 2: у Бори ровно один чат — личный с Мартином');
ok(!(sB.chats || []).some(c => c.id === grp.d.chat.id), 'требование 2: чужая группа Боре не видна');
ok(!(sB.chats || []).some(c => c.id === gid), 'требование 2: чужая партия Боре не видна');
ok((sB.games || []).some(g => g.id === gid), 'плашка «Сейчас играют»: партию СВОЕГО контакта (Мартина) Боря видит');
ok(!(sB.users || []).some(u => u.id === klava.id), 'требование 2: Клавы в списке людей у Бори нет');
const sK = await syncOf(klava);
ok((sK.chats || []).some(c => c.id === gid && c.kind === 'game'), 'а у Клавы своя партия видна в чатах (раздел «Игры»)');
// приглашение в игру создаёт личный чат, сохранённый у обоих: адресат не потеряет приглашение
const dmMKg = dmBetween(sK, martin.id, klava.id);
ok(!!dmMKg && (dmMKg.savedBy || []).includes(klava.id) && (dmMKg.savedBy || []).includes(martin.id),
  'приглашение в игру: личный чат создан и сохранён у обоих — не «Новые»');

// ══ требование 3: письмо из поиска → «Новые» на сутки ═══════════════
console.log('\n  ── требование 3: «Новые», сутки, сохранение');
const srch = await call('/api/search?q=' + encodeURIComponent('лав'), {}, borya.token);
ok(srch.status === 200 && (srch.d.users || []).some(u => u.id === klava.id), 'Боря нашёл Клаву поиском по нику');
ok((srch.d.users || []).some(u => u.id === klava.id && u.pub), 'поиск отдаёт открытый ключ — найденному можно написать');
const dmBK = (await call('/api/dm', { method: 'POST', body: { peer: klava.id } }, borya.token)).d.chat;
ok((await sendDm(borya, klava, dmBK.id, 'Здравствуйте, Клава!')).status === 200, 'Боря написал Клаве первое письмо');

let sK2 = await syncOf(klava);
let chatK = (sK2.chats || []).find(c => c.id === dmBK.id);
ok(!!chatK, 'требование 3: у Клавы чат появился');
ok(!!chatK && !!chatK.newUntil && chatK.newUntil > Date.now(), 'требование 3: чат в «Новых» — с отметкой «удалится сам»');
ok(!!chatK && chatK.newUntil - Date.now() <= 1200 + 5000 && chatK.newUntil - Date.now() > 0, 'требование 3: срок отсчитан от появления (тестовые «сутки» = 1.2 с)');
ok(!(chatK.savedBy || []).includes(klava.id), 'требование 3: у Клавы чат НЕ в «Личных» (savedBy без неё)');
let sB2 = await syncOf(borya);
let chatB = (sB2.chats || []).find(c => c.id === dmBK.id);
ok(!!chatB && (chatB.savedBy || []).includes(borya.id), 'требование 3: у Бори (автора) чат сразу в «Личных чатах»');
// круг плашки «Сейчас играют»: теперь Боря знаком с обоими игроками (Мартином —
// по приглашению, Клавой — по переписке), поэтому их партию он видит
ok((sB2.games || []).some(g => g.id === gid), 'круг игр: Боря видит партию знакомых ему людей в «Сейчас играют»');
ok(!!chatB && !chatB.newUntil, 'требование 3: у автора нет счётчика суток');
ok(!!chatB && !(chatB.savedBy || []).includes(klava.id), 'требование 3: Боря видит «ещё не добавили в личные чаты» (savedBy без Клавы)');
ok((await call('/api/notify', { method: 'POST', body: { kind: 'saved', chat: dmBK.id } }, borya.token)).status === 200, 'уведомление «добавил в личные» принимается сервером');

// сохранение: «Добавить пользователя в мои личные чаты»
const sv = await call('/api/chats/' + dmBK.id + '/save', { method: 'POST', body: {} }, klava.token);
ok(sv.status === 200 && (sv.d.chat.savedBy || []).includes(klava.id), 'требование 3: Клава сохранила чат — она в savedBy');
sK2 = await syncOf(klava);
chatK = (sK2.chats || []).find(c => c.id === dmBK.id);
ok(!!chatK && !chatK.newUntil && (chatK.savedBy || []).includes(klava.id), 'требование 3: чат переехал из «Новых» в «Личные чаты» навсегда');
sB2 = await syncOf(borya);
chatB = (sB2.chats || []).find(c => c.id === dmBK.id);
ok(!!chatB && (chatB.savedBy || []).includes(klava.id), 'требование 3: Боря видит «его добавили в личные чаты» (savedBy с Клавой)');
ok((await call('/api/chats/' + grp.d.chat.id + '/save', { method: 'POST', body: {} }, klava.token)).status === 400, 'сохранять можно только личную переписку (группа — 400)');

// ══ требование 3+4: сутки прошли — чат удалился сам; автор не пострадал ══
console.log('\n  ── сутки: самоудаление у адресата, вечность у автора');
const inv2 = await makeInvite(borya);   // у Бори своя ссылка (в сутки — одна, у него ещё не было)
const dashaR = await registerByInvite('Даша', 'dasha-pass-1', inv2.token);
const dasha = dashaR.user;
ok(dashaR.status === 200, 'Даша зарегистрировалась по ссылке Бори (проверка на «коротких сутках»)');
sB2 = await syncOf(borya);
const dmBD = dmBetween(sB2, borya.id, dasha.id);
ok(!!dmBD && !dmBD.newUntil && (dmBD.savedBy || []).includes(borya.id) && (dmBD.savedBy || []).includes(dasha.id),
  'приглашённый чат Бориса сохранён у обоих и на «коротких сутках» — в «Новые» не свалился');
// круг «Сейчас играют»: Даша не видит партию Мартина и Клавы (оба не из её круга)
const sD0 = await syncOf(dasha);
ok(!(sD0.games || []).some(g => g.id === gid), 'круг игр: Даша не видит партию Мартина и Клавы — оба ей чужие');
ok(!(sD0.users || []).some(u => u.id === klava.id), 'круг людей: Даша не видит Клаву (только Борю)');

const dmKD = (await call('/api/dm', { method: 'POST', body: { peer: dasha.id } }, klava.token)).d.chat;
ok((await sendDm(klava, dasha, dmKD.id, 'Привет, Даша!')).status === 200, 'Клава написала Даше (незнакомцу)');
let sD = await syncOf(dasha);
ok(!!(sD.chats || []).find(c => c.id === dmKD.id && c.newUntil), 'у Даши письмо Клавы — в «Новых»');
await wait(1500);
sD = await syncOf(dasha);
ok(!(sD.chats || []).some(c => c.id === dmKD.id), 'требование 3: сутки прошли — у Даши чат удалился сам');
ok(!(sD.users || []).some(u => u.id === klava.id), 'требование 3: вместе с чатом исчезла и Клава из списка людей');
let sK3 = await syncOf(klava);
let chatK3 = (sK3.chats || []).find(c => c.id === dmKD.id);
ok(!!chatK3 && (chatK3.savedBy || []).includes(klava.id) && !chatK3.newUntil, 'требование 3: у Клавы чат остался в «Личных чатах» навсегда');

// новое письмо возвращает чат в «Новые» ещё на сутки
ok((await sendDm(klava, dasha, dmKD.id, 'Даша, вы тут?')).status === 200, 'Клава написала снова');
sD = await syncOf(dasha);
const chatD2 = (sD.chats || []).find(c => c.id === dmKD.id);
ok(!!chatD2 && !!chatD2.newUntil, 'требование 3: новое письмо вернуло чат Даше в «Новые» (ещё на сутки)');

// ══ требование 4: убрать чат из своих личных ════════════════════════
console.log('\n  ── требование 4: «убрать из моих личных чатов»');
const hd = await call('/api/chats/' + dmBK.id + '/hide', { method: 'POST', body: { hidden: true } }, klava.token);
ok(hd.status === 200, 'команда «убрать» принята');
ok(!(hd.d.chat.savedBy || []).includes(klava.id), 'требование 4: Клава вышла из savedBy — Боря увидит «ещё не добавили»');
sK3 = await syncOf(klava);
ok(!(sK3.chats || []).some(c => c.id === dmBK.id),
  'требование 4: чат исчез из списков Клавы (savedBy без неё — проверка выше)');
sB2 = await syncOf(borya);
chatB = (sB2.chats || []).find(c => c.id === dmBK.id);
ok(!!chatB && !(chatB.savedBy || []).includes(klava.id), 'требование 4: у Бори чат остался, статус честно «не добавлен»');
ok((await sendDm(borya, klava, dmBK.id, 'Клава, вы где?')).status === 200, 'Боря написал в убранный чат');
sK3 = await syncOf(klava);
const chatK4 = (sK3.chats || []).find(c => c.id === dmBK.id);
ok(!!chatK4 && !!chatK4.newUntil, 'требование 4: новое письмо вернуло чат Клаве — в «Новые» на сутки');

// pkg3-50: правило «Новых» действует и на администратора — владелец тоже даёт
// согласие кнопкой. Сначала обычное: Мартин написал первым — он автор, чат
// сразу в его «Личных чатах».
const dmMD = (await call('/api/dm', { method: 'POST', body: { peer: dasha.id } }, martin.token)).d.chat;
await sendDm(martin, dasha, dmMD.id, 'Даша, добрый день');
sM = await syncOf(martin);
const chatM = (sM.chats || []).find(c => c.id === dmMD.id);
ok(!!chatM && !chatM.newUntil, 'админ написал первым: чат сразу в его «Личных чатах» (правило автора)');
// главное требование pkg3-50: незнакомец, у которого с админом НИКОГДА не было
// переписки, написал АДМИНУ первым — чат падает в «Новые» с отсчётом,
// а не в «Личные чаты»
ok((await call('/api/admin/emergency-reg', { method: 'POST', body: { open: true } }, martin.token)).status === 200, 'аварийное окно открыто для Гоши');
const gosha = (await registerByCode('Гоша', 'gosha-pass-1')).user;
await call('/api/admin/emergency-reg', { method: 'POST', body: { open: false } }, martin.token);
ok(!!gosha.token, 'Гоша зарегистрирован по кодовой фразе');
const dmGM = (await call('/api/dm', { method: 'POST', body: { peer: martin.id } }, gosha.token)).d.chat;
await sendDm(gosha, martin, dmGM.id, 'Мартин, здравствуйте — нашёл вас по нику');
sM = await syncOf(martin);
const chatMA = (sM.chats || []).find(c => c.id === dmGM.id);
ok(!!chatMA && !!chatMA.newUntil && chatMA.newUntil > Date.now(),
  'pkg3-50: написавший админу незнакомец попадает в «Новые» (отсчёт пошёл)');
ok(!!chatMA && !(chatMA.savedBy || []).includes(martin.id),
  'pkg3-50: без согласия админа чат НЕ в его «Личных чатах»');
// кнопка согласия переносит чат в «Личные чаты» админа
ok((await call('/api/chats/' + dmGM.id + '/save', { method: 'POST', body: {} }, martin.token)).status === 200,
  'pkg3-50: админ нажал «Добавить пользователя в мои личные чаты»');
sM = await syncOf(martin);
const chatMS = (sM.chats || []).find(c => c.id === dmGM.id);
ok(!!chatMS && (chatMS.savedBy || []).includes(martin.id) && !chatMS.newUntil,
  'pkg3-50: после кнопки чат у админа в «Личных чатах» без отсчёта');

// принятый запрос в «Приглашенные»: люди видят друг друга, чат — по общим правилам
ok((await call('/api/bond-req', { method: 'POST', body: { to: klava.id, chat: grp.d.chat.id } }, martin.token)).status === 200, 'Мартин отправил Клаве запрос в «Приглашенные»');
let sK5 = await syncOf(klava);
const rq = (sK5.bondReqs || []).find(r => r.from === martin.id && r.state === 'pending');
ok(!!rq, 'Клава видит запрос');
ok((await call('/api/bond-req/' + rq.id + '/accept', { method: 'POST', body: {} }, klava.token)).status === 200, 'Клава приняла запрос');
sK5 = await syncOf(klava);
ok((sK5.users || []).some(u => u.id === martin.id), 'после принятия Клава видит Мартина в списке людей');
// «Новые» для свежего собеседника: Ирина и Мартин раньше не переписывались
// (у Клавы с Мартином чат уже есть — его создало приглашение в игру)
await call('/api/admin/emergency-reg', { method: 'POST', body: { open: true } }, martin.token);
const irinaF = (await registerByCode('Ирина', 'irina-pass-1')).user;
await call('/api/admin/emergency-reg', { method: 'POST', body: { open: false } }, martin.token);
const dmMI = (await call('/api/dm', { method: 'POST', body: { peer: irinaF.id } }, martin.token)).d.chat;
sM = await syncOf(martin);
const chatMI = (sM.chats || []).find(c => c.id === dmMI.id);
ok(!!chatMI && !chatMI.newUntil, 'у Мартина (автора) новый личный чат — сразу в «Личных чатах»');
// тестовые «сутки» здесь короткие (1.2 с): отсчёт начинается, когда адресат
// впервые увидел чат, — после этого он исчезает сам
let sI0 = await syncOf(irinaF);
const chatI00 = (sI0.chats || []).find(c => c.id === dmMI.id);
ok(!!chatI00 && !!chatI00.newUntil, 'пустой чат от незнакомца Ирина видит в «Новых» (сутки пошли)');
await wait(1500);
sI0 = await syncOf(irinaF);
ok(!(sI0.chats || []).some(c => c.id === dmMI.id), 'пустой чат из «Новых» удалён у адресата по истечении срока');
ok((await sendDm(martin, irinaF, dmMI.id, 'Ирина, это Мартин')).status === 200, 'Мартин написал Ирине');
sI0 = await syncOf(irinaF);
const chatI0 = (sI0.chats || []).find(c => c.id === dmMI.id);
ok(!!chatI0 && !!chatI0.newUntil, 'письмо вернуло чат Ирине — в «Новые» на сутки');
ok((await call('/api/chats/' + dmMI.id + '/save', { method: 'POST', body: {} }, irinaF.token)).status === 200, 'Ирина сохранила чат — он остался навсегда');

// перезапуск файлового сервера: связи и сохранения на месте + перенос старой базы
srvA.kill('SIGTERM');
await wait(400);
const srvA2 = spawn(process.execPath, ['server.js'], {
  cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
  env: Object.assign({}, process.env, { PORT: String(PORT_A), HOST: '127.0.0.1', DATA_DIR: dirA, STORE: 'file', HTTPS: '' })
});
for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/api/state')).ok) break; } catch (e) {} await wait(250); }
sB2 = await syncOf(borya);
ok((sB2.myBonds || []).includes(dasha.id), 'после перезапуска связь «Боря пригласил Дашу» на месте');
const dmBD2 = dmBetween(sB2, borya.id, dasha.id);
ok(!!dmBD2 && (dmBD2.savedBy || []).includes(borya.id) && (dmBD2.savedBy || []).includes(dasha.id), 'после перезапуска сохранённые личные чаты на месте');

// ══ среда 2: облачная база (YDB) — починка pkg3-47 + «Новые» в облаке ══
console.log('\n  ── облачная база: связи переживают перезапуск функции');
const mock = await startMock();
const ydbEnv = {
  STORE: 'ydb', YDB_ENDPOINT: mock.endpoint, YDB_TABLE: 'sega_nc',
  YDB_ACCESS_KEY_ID: mock.accessKeyId, YDB_SECRET_ACCESS_KEY: mock.secretAccessKey,
  PRESENCE_EVERY: '0'
};
const PORT_Y = PORT_A + 1;
const B_Y = 'http://127.0.0.1:' + PORT_Y;
const srvY = spawn(process.execPath, ['server.js'], {
  cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
  env: Object.assign({}, process.env, ydbEnv, { PORT: String(PORT_Y), HOST: '127.0.0.1', HTTPS: '', NEW_DM_TTL: '3600000' })
});
const Bsave = B; B = B_Y;
for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/api/state')).ok) break; } catch (e) {} await wait(250); }

const admin2 = await createAdmin('Основатель', 'osn-pass-1');
const inv3 = await makeInvite(admin2);
const petr = (await registerByInvite('Пётр', 'petr-pass-1', inv3.token)).user;
ok(!!petr.token, 'облако: Пётр зарегистрирован по ссылке');
let sA2 = await syncOf(admin2);
ok((sA2.myBonds || []).includes(petr.id), 'облако: связь видна сразу');
const dmAP = dmBetween(sA2, admin2.id, petr.id);
ok(!!dmAP && (dmAP.savedBy || []).includes(admin2.id) && (dmAP.savedBy || []).includes(petr.id), 'облако: приглашённый чат сохранён у обоих');
await sendDm(admin2, petr, dmAP.id, 'Пётр, добро пожаловать');

// письмо из поиска → «Новые» в облаке (TTL час — не истекает во время теста)
const srch2 = await call('/api/search?q=' + encodeURIComponent('ётр'), {}, admin2.token);
ok(srch2.status === 200, 'облако: поиск по нику работает');
await call('/api/admin/emergency-reg', { method: 'POST', body: { open: true } }, admin2.token);
const irina = (await registerByCode('Ирина', 'irina-pass-1')).user;
await call('/api/admin/emergency-reg', { method: 'POST', body: { open: false } }, admin2.token);
const dmPI = (await call('/api/dm', { method: 'POST', body: { peer: irina.id } }, petr.token)).d.chat;
await sendDm(petr, irina, dmPI.id, 'Ирина, здравствуйте');
let sI = await syncOf(irina);
const chatI = (sI.chats || []).find(c => c.id === dmPI.id);
ok(!!chatI && !!chatI.newUntil && !(chatI.savedBy || []).includes(irina.id), 'облако: у Ирины чат в «Новых» с отметкой срока');
let sP = await syncOf(petr);
ok(!!(sP.chats || []).find(c => c.id === dmPI.id && (c.savedBy || []).includes(petr.id)), 'облако: у Петра (автора) чат в «Личных чатах»');

// «холодный старт» облачной функции: новый процесс, та же таблица
srvY.kill('SIGTERM');
await wait(400);
const srvY2 = spawn(process.execPath, ['server.js'], {
  cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
  env: Object.assign({}, process.env, ydbEnv, { PORT: String(PORT_Y), HOST: '127.0.0.1', HTTPS: '', NEW_DM_TTL: '3600000' })
});
for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/api/state')).ok) break; } catch (e) {} await wait(250); }
sA2 = await syncOf(admin2);
ok((sA2.myBonds || []).includes(petr.id), 'ПОЧИНКА pkg3-47: связь «Приглашенные» пережила холодный старт облака');
const dmAP2 = dmBetween(sA2, admin2.id, petr.id);
ok(!!dmAP2 && (dmAP2.savedBy || []).includes(admin2.id) && (dmAP2.savedBy || []).includes(petr.id), 'облако: сохранённый личный чат пережил холодный старт');
sI = await syncOf(irina);
const chatI2 = (sI.chats || []).find(c => c.id === dmPI.id);
ok(!!chatI2 && !!chatI2.newUntil, 'облако: «Новые» с отметкой срока пережили холодный старт');
const sv2 = await call('/api/chats/' + dmPI.id + '/save', { method: 'POST', body: {} }, irina.token);
ok(sv2.status === 200 && (sv2.d.chat.savedBy || []).includes(irina.id), 'облако: Ирина сохранила чат');
sP = await syncOf(petr);
const chatP2 = (sP.chats || []).find(c => c.id === dmPI.id);
ok(!!chatP2 && (chatP2.savedBy || []).includes(irina.id), 'облако: Пётр видит, что его добавили в личные чаты');
// запрос-согласие переживает холодный старт
const grp2Keys = {
  [admin2.id]: { blob: await encB(await pairKey(admin2.keys.priv, admin2.keys.pub), gk) },
  [irina.id]: { blob: await encB(await pairKey(admin2.keys.priv, irina.keys.pub), gk) }
};
const grp2 = await call('/api/chats', { method: 'POST', body: { members: [irina.id], titleBlob: await encJ(await subtle.importKey('raw', gk, 'AES-GCM', false, ['encrypt']), { title: 'Клуб' }), keys: grp2Keys } }, admin2.token);
ok((await call('/api/bond-req', { method: 'POST', body: { to: admin2.id, chat: grp2.d.chat.id } }, irina.token)).status === 200, 'облако: Ирина отправила запрос основателю');
srvY2.kill('SIGTERM');
await wait(400);
const srvY3 = spawn(process.execPath, ['server.js'], {
  cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
  env: Object.assign({}, process.env, ydbEnv, { PORT: String(PORT_Y), HOST: '127.0.0.1', HTTPS: '', NEW_DM_TTL: '3600000' })
});
for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/api/state')).ok) break; } catch (e) {} await wait(250); }
sA2 = await syncOf(admin2);
const rq2 = (sA2.bondReqs || []).find(r => r.from === irina.id && r.state === 'pending');
ok(!!rq2, 'ПОЧИНКА pkg3-47: нерешённый запрос пережил холодный старт облака');
ok((await call('/api/bond-req/' + rq2.id + '/accept', { method: 'POST', body: {} }, admin2.token)).status === 200, 'облако: запрос принят после перезапуска');
let sI2 = await syncOf(irina);
ok((sI2.myBonds || []).includes(admin2.id), 'облако: принятая связь на месте (у Ирины — основатель)');
ok((sI2.users || []).some(u => u.id === admin2.id), 'облако: после принятия стороны видят друг друга');
srvY3.kill('SIGTERM');
await wait(300);
sA2 = null;

// связь, принятая ДО перезапуска, тоже должна пережить следующий холодный старт
const srvY4 = spawn(process.execPath, ['server.js'], {
  cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
  env: Object.assign({}, process.env, ydbEnv, { PORT: String(PORT_Y), HOST: '127.0.0.1', HTTPS: '', NEW_DM_TTL: '3600000' })
});
for (let i = 0; i < 60; i++) { try { if ((await fetch(B + '/api/state')).ok) break; } catch (e) {} await wait(250); }
sA2 = await syncOf(admin2);
sI2 = await syncOf(irina);
ok((sI2.myBonds || []).includes(admin2.id), 'ПОЧИНКА pkg3-47: принятая связь пережила ещё один холодный старт');
ok((sA2.bondReqs || []).every(r => r.from !== irina.id || r.state === 'accepted'), 'состояние запроса («принят») тоже сохранилось');
srvY4.kill('SIGTERM');
await mock.close();
B = Bsave;
srvA2.kill('SIGTERM');

console.log('\n──────────────────────────────────────────────────');
console.log(`  «Новые» и личные чаты pkg3-49/50: ${good} ✓, провалов ${bad}`);
console.log('──────────────────────────────────────────────────\n');
process.exit(bad ? 1 : 0);
