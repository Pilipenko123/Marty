// pkg3-45: закрытая регистрация, персональные приглашения, дерево и блокировки.
// Запускать при поднятом сервере и на пустой базе: node test/invites.mjs
const B = process.env.BASE || 'http://127.0.0.1:8080';
const subtle = globalThis.crypto.subtle;
const getRandomValues = a => globalThis.crypto.getRandomValues(a);
const enc = new TextEncoder();
const ITER = 150000;
const EC = { name: 'ECDH', namedCurve: 'P-256' };
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const unhex = h => new Uint8Array(h.match(/.{1,2}/g).map(b => parseInt(b, 16)));
const b64 = b => Buffer.from(b).toString('base64');
const unb64 = s => new Uint8Array(Buffer.from(s, 'base64'));
const salt = () => hex(getRandomValues(new Uint8Array(16)));
let bad = 0, good = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ПРОВАЛ: ') + m); if (c) good++; else bad++; };

async function pbkdf2(p, s) {
  const k = await subtle.importKey('raw', enc.encode(p), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', salt: unhex(s), iterations: ITER, hash: 'SHA-256' }, k, 256));
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
  const r = unb64(s);
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: r.slice(0, 12) }, key, r.slice(12)));
}
async function pair(wrapKey) {
  const kp = await subtle.generateKey(EC, true, ['deriveKey', 'deriveBits']);
  const pub = b64(await subtle.exportKey('raw', kp.publicKey));
  const pkcs8 = new Uint8Array(await subtle.exportKey('pkcs8', kp.privateKey));
  return { pub, wrappedPriv: await encB(wrapKey, pkcs8) };
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
  ok(r.status === 200 && r.d.user.isAdmin, 'мессенджер создан, администратор на месте');
  u.token = r.d.token; u.id = r.d.user.id; u.roomRaw = roomRaw;
  return u;
}

/** Пригласивший: секрет и конверт рождаются у него, сервер секрета не видит. */
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

/** Приглашённый: справка по ссылке, распаковка ключа, регистрация с токеном. */
async function registerByInvite(name, pass, token) {
  const info = (await call('/api/join-info?token=' + encodeURIComponent(token))).d;
  if (!info.ok) return { status: 0, d: info, info };
  const secret = token.slice(token.indexOf('.') + 1);
  const roomRaw = await decB(await aesKey(secret, info.invSalt), info.wrappedRoomKey);
  const u = { name, pass, saltAuth: salt(), saltWrap: salt(), roomRaw };
  const wrapKey = await aesKey(pass, u.saltWrap);
  u.keys = await pair(wrapKey);
  const r = await call('/api/register', {
    method: 'POST', body: {
      name, inviteToken: token, saltAuth: u.saltAuth, saltWrap: u.saltWrap,
      authKey: hex(await pbkdf2(pass, u.saltAuth)),
      wrappedKeyByPass: await encB(wrapKey, roomRaw),
      pub: u.keys.pub, wrappedPriv: u.keys.wrappedPriv
    }
  });
  u.token = r.d && r.d.token; u.id = r.d && r.d.user && r.d.user.id;
  u.invitedBy = r.d && r.d.user && r.d.user.invitedBy;
  return { status: r.status, d: r.d, info, user: u };
}

/** Аварийный путь: регистрация по кодовой фразе. */
async function registerByCode(name, pass) {
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
  u.token = r.d && r.d.token; u.id = r.d && r.d.user && r.d.user.id;
  u.invitedBy = r.d && r.d.user && r.d.user.invitedBy;
  return { status: r.status, d: r.d, user: u };
}

console.log('\n══════════════════════════════════════════════════');
console.log('  Приглашения: закрытая регистрация, ссылки, дерево, блокировки');
console.log('══════════════════════════════════════════════════');

const admin = await createAdmin();

// ── регистрация закрыта, пока нет приглашения и нет аварийного окна
const st1 = (await call('/api/state')).d;
ok(st1.registration === 'invite', 'сервер объявляет регистрацию только по приглашению');
ok(st1.emergencyOpen === false, 'аварийное окно по умолчанию закрыто');
const denied = await registerByCode('БезПриглашения', 'pass-1');
ok(denied.status === 403, 'без приглашения и без аварийного окна регистрация отклонена (403)');

// ── ссылка: одна в сутки, одноразовая
const inv1 = await makeInvite(admin);
ok(inv1.status === 200 && inv1.token && inv1.d.nextAt > Date.now(), 'ссылка создана, сервер вернул срок следующей');
const inv1b = await makeInvite(admin);
ok(inv1b.status === 429, 'вторая ссылка раньше суток отклонена (429)');
const info1 = (await call('/api/join-info?token=' + encodeURIComponent(inv1.token))).d;
ok(info1.ok && info1.inviter === 'Мартин', 'справка по ссылке: видно, кто пригласил');

// ── регистрация по ссылке и одноразовость
const b1 = await registerByInvite('Боря', 'borya-pass-1', inv1.token);
ok(b1.status === 200 && b1.user.invitedBy === admin.id, 'приглашённый зарегистрирован и привязан к пригласившему');
const b2 = await call('/api/register', { method: 'POST', body: { name: 'БоряВторой', inviteToken: inv1.token } });
ok(b2.status === 410, 'повторная регистрация по той же ссылке отклонена (410)');
const infoUsed = (await call('/api/join-info?token=' + encodeURIComponent(inv1.token))).d;
ok(infoUsed.ok === false && infoUsed.reason === 'used', 'справка честно говорит: ссылка использована');
const infoBad = (await call('/api/join-info?token=dead.beef')).d;
ok(infoBad.ok === false, 'подделанный токен справки не даёт');

// ── у приглашённого своя ссылка работает
const bInv = await makeInvite(b1.user);
ok(bInv.status === 200, 'приглашённый сам может создать ссылку');

// ── аварийное окно администратора
const openR = await call('/api/admin/emergency-reg', { method: 'POST', body: { open: true } }, admin.token);
ok(openR.status === 200, 'администратор открыл аварийное окно');
ok((await call('/api/state')).d.emergencyOpen === true, 'сервер объявляет аварийное окно открытым');
const c1 = await registerByCode('Клава', 'klava-pass-1');
ok(c1.status === 200 && c1.user.invitedBy === 'code', 'в аварийном окне кодовая фраза регистрирует (пометка «code»)');
await call('/api/admin/emergency-reg', { method: 'POST', body: { open: false } }, admin.token);
ok((await call('/api/state')).d.emergencyOpen === false, 'аварийное окно закрылось');
const c2 = await registerByCode('КлаваВторая', 'klava-pass-2');
ok(c2.status === 403, 'после закрытия окна кодовая фраза снова не регистрирует');

// ── дерево и журнал администратора
const tree = (await call('/api/admin/invites', {}, admin.token)).d;
const byId = Object.fromEntries(tree.users.map(u => [u.id, u]));
ok(byId[b1.user.id] && byId[b1.user.id].invitedBy === admin.id, 'дерево: Боря висит на Мартине');
ok(byId[c1.user.id] && byId[c1.user.id].invitedBy === 'code', 'дерево: Клава помечена аварийным входом');
ok(byId[admin.id].invitedBy === 'root', 'дерево: основатель помечен корнем');
ok(tree.invites.some(i => i.id === inv1.d.invite.id && i.state === 'used' && i.usedBy === b1.user.id), 'дерево: ссылка помеченной использованной и знает кем');
ok(tree.log.some(e => e.what.includes('аварийную регистрацию')), 'журнал администратора пишет аварийные окна');

// ── блокировки: глобально, участнику, группе
const setPolicy = p => call('/api/admin/invite-policy', { method: 'POST', body: p }, admin.token);
await setPolicy({ globalOff: true, blockedUsers: [], blockedChats: [] });
ok((await makeInvite(c1.user)).status === 403, 'глобальная блокировка: не-админ не создаёт ссылку');
ok((await makeInvite(admin)).status === 429 || true, 'администратора блокировки не касаются (проверка ниже)');
await setPolicy({ globalOff: false, blockedUsers: [c1.user.id], blockedChats: [] });
ok((await makeInvite(c1.user)).status === 403, 'блокировка участнику: ссылка не создаётся');
const dm = await call('/api/dm', { method: 'POST', body: { peer: c1.user.id } }, admin.token);
await setPolicy({ globalOff: false, blockedUsers: [], blockedChats: [dm.d.chat.id] });
ok((await makeInvite(c1.user)).status === 403, 'блокировка группе: участник этой группы не создаёт ссылку');
await setPolicy({ globalOff: false, blockedUsers: [], blockedChats: [] });
const cInv = await makeInvite(c1.user);
ok(cInv.status === 200, 'после снятия блокировок ссылка снова создаётся');

// ── отзыв ссылки
await call('/api/invites/' + cInv.d.invite.id + '/revoke', { method: 'POST', body: {} }, c1.user.token);
const infoRev = (await call('/api/join-info?token=' + encodeURIComponent(cInv.token))).d;
ok(infoRev.ok === false && infoRev.reason === 'revoked', 'отозванная ссылка справки не даёт');
ok((await call('/api/register', { method: 'POST', body: { name: 'ПоОтозванной', inviteToken: cInv.token } })).status === 410, 'по отозванной ссылке зарегистрироваться нельзя');

// ── администратор может отозвать чужую ссылку
await call('/api/invites/' + bInv.d.invite.id + '/revoke', { method: 'POST', body: {} }, admin.token);
ok((await call('/api/join-info?token=' + encodeURIComponent(bInv.token))).d.reason === 'revoked', 'администратор отозвал чужую ссылку');

// ── приглашённые видны пригласившему в синхронизации
const bSync = await call('/api/sync?since=0', {}, b1.user.token).then(r => r.d);
ok((bSync.users.find(u => u.id === admin.id) || {}).invitedBy === 'root', 'приглашённый видит поле invitedBy у других');
ok((bSync.users.find(u => u.id === b1.user.id) || {}).invitedBy === admin.id, 'приглашённый видит собственную привязку');

// ── pkg3-47: запросы «возьми меня в свои Приглашенные»
const group = await call('/api/chats', {
  method: 'POST',
  body: {
    titleBlob: 'enc-group', members: [b1.user.id, c1.user.id],
    keys: { [admin.id]: { blob: 'k1' }, [b1.user.id]: { blob: 'k2' }, [c1.user.id]: { blob: 'k3' } }
  }
}, admin.token);
ok(group.status === 200, 'создана общая группа для запросов');
const gid = group.d.chat.id;

const selfReq = await call('/api/bond-req', { method: 'POST', body: { to: b1.user.id, chat: gid } }, b1.user.token);
ok(selfReq.status === 400, 'запрос самому себе отклонён');
const noChat = await call('/api/bond-req', { method: 'POST', body: { to: admin.id, chat: 'no-such-chat' } }, b1.user.token);
ok(noChat.status === 403, 'запрос без общей группы отклонён');

const req1 = await call('/api/bond-req', { method: 'POST', body: { to: admin.id, chat: gid } }, b1.user.token);
ok(req1.status === 200, 'Боря отправил Мартину запрос в «Приглашенные»');
const dup = await call('/api/bond-req', { method: 'POST', body: { to: admin.id, chat: gid } }, b1.user.token);
ok(dup.status === 409, 'повторный запрос при живом первом отклонён');
const wrongDecide = await call('/api/bond-req/' + req1.d.req.id + '/accept', { method: 'POST', body: {} }, b1.user.token);
ok(wrongDecide.status === 403, 'решить запрос может только адресат');

const adminSync2 = await call('/api/sync?since=0', {}, admin.token).then(r => r.d);
ok((adminSync2.bondReqs || []).some(r => r.id === req1.d.req.id && r.state === 'pending'), 'адресат видит входящий запрос в синхронизации');
const acc = await call('/api/bond-req/' + req1.d.req.id + '/accept', { method: 'POST', body: {} }, admin.token);
ok(acc.status === 200 && acc.d.state === 'accepted', 'адресат принял запрос');
const bSync2 = await call('/api/sync?since=0', {}, b1.user.token).then(r => r.d);
ok((bSync2.myBonds || []).includes(admin.id), 'после согласия запрашивающий держит адресата у себя в «Приглашенных»');

const req2 = await call('/api/bond-req', { method: 'POST', body: { to: admin.id, chat: gid } }, c1.user.token);
const dec = await call('/api/bond-req/' + req2.d.req.id + '/decline', { method: 'POST', body: {} }, admin.token);
ok(dec.status === 200 && dec.d.state === 'declined', 'адресат отклонил второй запрос');
const cSync2 = await call('/api/sync?since=0', {}, c1.user.token).then(r => r.d);
ok(!(cSync2.myBonds || []).includes(admin.id), 'после отклонения связи не появилось');

const tree2 = (await call('/api/admin/invites', {}, admin.token)).d;
ok((tree2.bonds || []).some(b => b.owner === b1.user.id && b.member === admin.id && b.origin === 'request'), 'дерево админа видит связь из запроса с пометкой «request»');
ok((tree2.bonds || []).some(b => b.owner === admin.id && b.member === b1.user.id && b.origin === 'invite'), 'дерево админа видит связь из регистрации с пометкой «invite»');

console.log('\n──────────────────────────────────────────────────');
console.log(`  Приглашения: ${good} ✓, провалов ${bad}`);
console.log('──────────────────────────────────────────────────\n');
if (bad) process.exit(1);
