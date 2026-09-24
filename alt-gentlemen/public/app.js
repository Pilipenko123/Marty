/* Alt-Джентельмены — клиент (оформление в духе Bitrix24).
   Общий чат + комментарии к сообщениям + личные переписки.
   Всё шифруется в браузере: общий чат — общим ключом комнаты,
   личные сообщения — отдельным ключом пары (ECDH P-256), который знают только двое. */
'use strict';

// ─────────────────────────────────────────── помощники
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const show = el => el.classList.remove('hidden');
const hide = el => el.classList.add('hidden');
const enc = new TextEncoder();
const dec = new TextDecoder();
const ITER = 150000;
const ONLINE_MS = 65000;

function toast(msg, isErr) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '');
  clearTimeout(t._t);
  t._t = setTimeout(() => hide(t), 3800);
}
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const linkify = h => h.replace(/(https?:\/\/[^\s<]+)/g, u => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
function fmtBytes(b) {
  if (b < 1024) return b + ' Б';
  if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' КБ';
  return (b / 1024 / 1024).toFixed(2) + ' МБ';
}
const MON = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
function fmtDay(ts) {
  const d = new Date(ts), n = new Date();
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, n)) return 'Сегодня';
  if (same(d, new Date(n - 864e5))) return 'Вчера';
  return `${d.getDate()} ${MON[d.getMonth()]}${d.getFullYear() !== n.getFullYear() ? ' ' + d.getFullYear() : ''}`;
}
const fmtTime = ts => new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
function fmtAgo(ts) {
  if (!ts) return 'давно не заходил';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 90) return 'только что';
  if (s < 3600) return Math.floor(s / 60) + ' мин. назад';
  if (s < 86400) return Math.floor(s / 3600) + ' ч. назад';
  return fmtDay(ts) + ', ' + fmtTime(ts);
}
const plural = (n, a, b, c) => { const m = n % 100, k = n % 10; return n + ' ' + (m > 10 && m < 20 ? c : k === 1 ? a : k > 1 && k < 5 ? b : c); };

// ─────────────────────────────────────────── криптография
const subtle = (window.crypto && window.crypto.subtle) || null;
const rnd = n => crypto.getRandomValues(new Uint8Array(n));
const toHex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const fromHex = h => new Uint8Array(h.match(/.{1,2}/g).map(b => parseInt(b, 16)));
function toB64(buf) {
  const b = new Uint8Array(buf); let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}
const fromB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function pbkdf2(password, saltHex, bits = 256) {
  const base = await subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', salt: fromHex(saltHex), iterations: ITER, hash: 'SHA-256' }, base, bits));
}
async function aesKeyFrom(password, saltHex) {
  return subtle.importKey('raw', await pbkdf2(password, saltHex), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function aesEncryptBytes(key, bytes) {
  const iv = rnd(12);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
  return toB64(out);
}
async function aesDecryptBytes(key, b64) {
  const raw = fromB64(b64);
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, key, raw.slice(12)));
}
const encryptJSON = async (k, o) => aesEncryptBytes(k, enc.encode(JSON.stringify(o)));
const decryptJSON = async (k, b) => JSON.parse(dec.decode(await aesDecryptBytes(k, b)));
const newSalt = () => toHex(rnd(16));

// пара ключей для личных переписок
const EC = { name: 'ECDH', namedCurve: 'P-256' };
async function genPairKeys(wrapKey) {
  const kp = await subtle.generateKey(EC, true, ['deriveKey', 'deriveBits']);
  const pub = toB64(await subtle.exportKey('raw', kp.publicKey));
  const pkcs8 = new Uint8Array(await subtle.exportKey('pkcs8', kp.privateKey));
  return { pub, priv: kp.privateKey, pkcs8, wrappedPriv: await aesEncryptBytes(wrapKey, pkcs8) };
}
const importPriv = pkcs8 => subtle.importKey('pkcs8', pkcs8, EC, true, ['deriveKey', 'deriveBits']);

// ─────────────────────────────────────────── состояние
const S = {
  token: null, me: null, roomKey: null, roomKeyRaw: null, priv: null, privRaw: null, pub: null,
  saltAuth: null, saltWrap: null, codeProofSalt: null,
  users: [], messages: [], plain: new Map(), dmKeys: new Map(),
  view: { type: 'group' }, threadId: null, drafts: {},
  seq: 0, usage: { bytes: 0, limit: 1, percent: 0, messages: 0 },
  attach: null, threadAttach: null, remember: true, timer: null, atBottom: true,
  sig: '', railFilter: ''
};

const dmCh = (a, b) => 'dm:' + [a, b].sort().join('|');
const viewCh = v => (v || S.view).type === 'group' ? 'group' : dmCh(S.me.id, (v || S.view).peer);
const chPeer = ch => ch && ch.startsWith('dm:') ? ch.slice(3).split('|').find(x => x !== S.me.id) : null;
const bucketOf = m => m.parent ? 'thr:' + m.parent : (m.ch || 'group');
const userById = id => S.users.find(u => u.id === id);
const isOnline = u => u && Date.now() - (u.activeAt || 0) < ONLINE_MS;
const myReads = () => (S.me && S.me.reads) || {};

function store() { return S.remember ? localStorage : sessionStorage; }
function saveSession() {
  store().setItem('altg.session', JSON.stringify({
    token: S.token, key: toB64(S.roomKeyRaw), priv: S.privRaw ? toB64(S.privRaw) : null,
    saltAuth: S.saltAuth, saltWrap: S.saltWrap
  }));
}
function loadSessionRaw() {
  const a = localStorage.getItem('altg.session');
  if (a) { S.remember = true; return JSON.parse(a); }
  const b = sessionStorage.getItem('altg.session');
  if (b) { S.remember = false; return JSON.parse(b); }
  return null;
}
function clearSession() { localStorage.removeItem('altg.session'); sessionStorage.removeItem('altg.session'); }

// ─────────────────────────────────────────── сеть
async function api(path, opts = {}) {
  const headers = Object.assign({}, opts.headers || {});
  if (opts.body !== undefined && typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);
  if (opts.body) headers['Content-Type'] = 'application/json';
  if (S.token) headers['Authorization'] = 'Bearer ' + S.token;
  const res = await fetch(path, Object.assign({}, opts, { headers }));
  if (res.status === 401 && S.token) { doLogout(true); throw new Error('Сессия истекла, войдите заново'); }
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    if (!res.ok) throw new Error('Ошибка сети (' + res.status + ')');
    return res;
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Ошибка запроса');
  return data;
}

const screen = name => ['loading', 'setup', 'auth', 'app']
  .forEach(n => document.getElementById('screen-' + n).classList.toggle('hidden', n !== name));

// ─────────────────────────────────────────── запуск
async function boot() {
  if (!subtle) {
    screen('setup');
    $('#form-setup').innerHTML = `<div class="brand"><div class="hat">🎩</div><h1>Alt-Джентельмены</h1></div>
      <p class="hint">Браузер не даёт доступ к шифрованию, потому что страница открыта по незащищённому адресу.
      Откройте чат по адресу <b>http://localhost:8080</b> на этом компьютере или запустите сервер по HTTPS
      (README, раздел «Как открыть чат с телефона»).</p>`;
    return;
  }
  let st;
  try { st = await api('/api/state'); } catch (e) { toast('Сервер недоступен: ' + e.message, true); return; }
  S.codeProofSalt = st.codeProofSalt;
  if (st.setupRequired) return screen('setup');

  const sess = loadSessionRaw();
  if (sess && sess.token) {
    S.token = sess.token; S.saltAuth = sess.saltAuth; S.saltWrap = sess.saltWrap;
    S.roomKeyRaw = fromB64(sess.key);
    S.roomKey = await subtle.importKey('raw', S.roomKeyRaw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    if (sess.priv) { S.privRaw = fromB64(sess.priv); S.priv = await importPriv(S.privRaw); }
    try { await startApp(); return; } catch (e) { clearSession(); S.token = null; }
  }
  screen('auth');
}

// ─────────────────────────────────────────── создание чата
$('#form-setup').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target, el = f.elements, err = $('#setup-err'), btn = f.querySelector('button.primary');
  err.textContent = '';
  const name = el.name.value.trim(), pass = el.pass.value, code = el.code.value.trim();
  if (pass !== el.pass2.value) return err.textContent = 'Пароли не совпадают';
  if (code !== el.code2.value.trim()) return err.textContent = 'Кодовые фразы не совпадают';
  btn.disabled = true; btn.textContent = 'Создаём ключи…';
  try {
    const saltAuth = newSalt(), saltWrap = newSalt(), codeProofSalt = newSalt(), codeSalt = newSalt();
    const roomKeyRaw = rnd(32);
    const wrapKey = await aesKeyFrom(pass, saltWrap);
    const pair = await genPairKeys(wrapKey);
    const body = {
      name, saltAuth, saltWrap,
      authKey: toHex(await pbkdf2(pass, saltAuth)),
      wrappedKeyByPass: await aesEncryptBytes(wrapKey, roomKeyRaw),
      codeProofSalt, codeProof: toHex(await pbkdf2(code, codeProofSalt)),
      codeSalt, wrappedKeyByCode: await aesEncryptBytes(await aesKeyFrom(code, codeSalt), roomKeyRaw),
      pub: pair.pub, wrappedPriv: pair.wrappedPriv
    };
    const r = await api('/api/setup', { method: 'POST', body });
    await enterWith(r, roomKeyRaw, saltAuth, saltWrap, pair);
  } catch (ex) { err.textContent = ex.message; btn.disabled = false; btn.textContent = 'Создать чат'; }
});

// ─────────────────────────────────────────── вход / регистрация
$$('.tab').forEach(t => t.addEventListener('click', () => {
  $$('.tab').forEach(x => x.classList.toggle('active', x === t));
  $('#form-login').classList.toggle('hidden', t.dataset.tab !== 'login');
  $('#form-register').classList.toggle('hidden', t.dataset.tab !== 'register');
}));

$('#form-login').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target, el = f.elements, err = $('#login-err'), btn = f.querySelector('button.primary');
  err.textContent = ''; btn.disabled = true; btn.textContent = 'Проверяем…';
  try {
    const name = el.name.value.trim(), pass = el.pass.value;
    S.remember = el.remember.checked;
    const salts = await api('/api/salt', { method: 'POST', body: { name } });
    const authKey = toHex(await pbkdf2(pass, salts.saltAuth));
    const r = await api('/api/login', { method: 'POST', body: { name, authKey } });
    const wrapKey = await aesKeyFrom(pass, r.saltWrap);
    let roomKeyRaw;
    try { roomKeyRaw = await aesDecryptBytes(wrapKey, r.wrappedKeyByPass); }
    catch (_) { throw new Error('Не удалось расшифровать ключ чата. Проверьте пароль.'); }
    let pair = null;
    if (r.wrappedPriv) {
      const pkcs8 = await aesDecryptBytes(wrapKey, r.wrappedPriv);
      pair = { pkcs8, priv: await importPriv(pkcs8), pub: r.user.pub };
    } else {
      pair = await genPairKeys(wrapKey);
      await api('/api/profile', { method: 'POST', body: { keys: { pub: pair.pub, wrappedPriv: pair.wrappedPriv } }, headers: { Authorization: 'Bearer ' + r.token } });
    }
    await enterWith(r, roomKeyRaw, salts.saltAuth, r.saltWrap, pair);
  } catch (ex) { err.textContent = ex.message; btn.disabled = false; btn.textContent = 'Войти'; }
});

$('#form-register').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target, el = f.elements, err = $('#reg-err'), btn = f.querySelector('button.primary');
  err.textContent = '';
  const name = el.name.value.trim(), pass = el.pass.value, code = el.code.value.trim();
  if (pass !== el.pass2.value) return err.textContent = 'Пароли не совпадают';
  S.remember = el.remember.checked;
  btn.disabled = true; btn.textContent = 'Открываем дверь…';
  try {
    const st = await api('/api/state');
    const codeProof = toHex(await pbkdf2(code, st.codeProofSalt));
    const inv = await api('/api/invite', { method: 'POST', body: { codeProof } });
    let roomKeyRaw;
    try { roomKeyRaw = await aesDecryptBytes(await aesKeyFrom(code, inv.codeSalt), inv.wrappedKeyByCode); }
    catch (_) { throw new Error('Кодовая фраза не подходит'); }
    const saltAuth = newSalt(), saltWrap = newSalt();
    const wrapKey = await aesKeyFrom(pass, saltWrap);
    const pair = await genPairKeys(wrapKey);
    const r = await api('/api/register', {
      method: 'POST',
      body: {
        name, codeProof, saltAuth, saltWrap,
        authKey: toHex(await pbkdf2(pass, saltAuth)),
        wrappedKeyByPass: await aesEncryptBytes(wrapKey, roomKeyRaw),
        pub: pair.pub, wrappedPriv: pair.wrappedPriv
      }
    });
    await enterWith(r, roomKeyRaw, saltAuth, saltWrap, pair);
  } catch (ex) { err.textContent = ex.message; btn.disabled = false; btn.textContent = 'Присоединиться'; }
});

async function enterWith(r, roomKeyRaw, saltAuth, saltWrap, pair) {
  S.token = r.token; S.me = r.user;
  S.roomKeyRaw = roomKeyRaw instanceof Uint8Array ? roomKeyRaw : new Uint8Array(roomKeyRaw);
  S.roomKey = await subtle.importKey('raw', S.roomKeyRaw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  if (pair) { S.priv = pair.priv; S.privRaw = pair.pkcs8; S.pub = pair.pub; }
  S.saltAuth = saltAuth; S.saltWrap = saltWrap;
  saveSession();
  await startApp();
}

function doLogout(silent) {
  if (S.token && !silent) api('/api/logout', { method: 'POST' }).catch(() => {});
  clearTimeout(S.timer);
  clearSession();
  Object.assign(S, {
    token: null, me: null, roomKey: null, roomKeyRaw: null, priv: null, privRaw: null,
    messages: [], plain: new Map(), dmKeys: new Map(), seq: 0, view: { type: 'group' }, threadId: null, sig: ''
  });
  $('#messages').innerHTML = '';
  document.title = 'Alt-Джентельмены';
  screen('auth');
}

// ─────────────────────────────────────────── цикл синхронизации
async function startApp() {
  screen('app');
  S.seq = 0; S.messages = []; S.plain = new Map(); S.sig = '';
  await sync(true);
  loop();
  $('#input').focus();
  if (!S.priv) toast('Войдите заново (Выйти → Вход), чтобы включить личные переписки', true);
}
function loop() {
  clearTimeout(S.timer);
  S.timer = setTimeout(async () => {
    if (!document.hidden && S.token) { try { await sync(); } catch (e) {} }
    loop();
  }, document.hidden ? 9000 : 2000);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.token) sync().catch(() => {}); });
window.addEventListener('focus', () => { if (S.token) markRead(); });

async function sync(initial) {
  const data = await api('/api/sync?since=' + S.seq + (document.hidden ? '' : '&active=1'));
  S.users = data.users;
  S.me = data.me;
  S.usage = data.usage;
  if (data.messages.length) {
    S.messages.push(...data.messages);
    S.messages.sort((a, b) => a.seq - b.seq);
    await decryptAll(data.messages);
  } else if (data.seq !== S.seq && !initial) {
    const full = await api('/api/sync?since=0');
    S.messages = full.messages; S.plain = new Map();
    await decryptAll(S.messages);
    S.seq = full.seq;
  }
  S.seq = data.seq;
  renderAll();
  if (!document.hidden) markRead();
  if ($('#search').value.trim()) runSearch();
}

async function keyForCh(ch) {
  if (!ch || ch === 'group') return S.roomKey;
  const peer = chPeer(ch);
  if (!peer) return null;
  if (S.dmKeys.has(peer)) return S.dmKeys.get(peer);
  const u = userById(peer);
  if (!u || !u.pub || !S.priv) return null;
  try {
    const pubKey = await subtle.importKey('raw', fromB64(u.pub), EC, false, []);
    const key = await subtle.deriveKey({ name: 'ECDH', public: pubKey }, S.priv, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    S.dmKeys.set(peer, key);
    return key;
  } catch (e) { return null; }
}

async function decryptAll(list) {
  for (const m of list) {
    if (S.plain.has(m.id)) continue;
    const key = await keyForCh(m.ch);
    if (!key) { S.plain.set(m.id, { text: '🔒 нет ключа для расшифровки', broken: true }); continue; }
    try { S.plain.set(m.id, await decryptJSON(key, m.blob)); }
    catch (e) { S.plain.set(m.id, { text: '🔒 не удалось расшифровать', broken: true }); }
  }
}

// ─────────────────────────────────────────── непрочитанное
function unreadIn(ch) {
  const reads = myReads();
  let total = 0, mentions = 0;
  for (const m of S.messages) {
    if ((m.ch || 'group') !== ch || m.uid === S.me.id) continue;
    if (m.seq <= (reads[bucketOf(m)] || 0)) continue;
    total++;
    const p = S.plain.get(m.id);
    if (p && p.mentions && p.mentions.includes(S.me.id)) mentions++;
  }
  return { total, mentions };
}
function threadUnread(parentId) {
  const reads = myReads();
  return S.messages.filter(m => m.parent === parentId && m.uid !== S.me.id && m.seq > (reads['thr:' + parentId] || 0)).length;
}
async function markRead() {
  if (!S.me) return;
  const reads = myReads();
  const buckets = new Map();
  const ch = viewCh();
  for (const m of S.messages) {
    if ((m.ch || 'group') !== ch) continue;
    const isThread = !!m.parent;
    if (isThread && m.parent !== S.threadId) continue; // ветку помечаем, только когда она открыта
    const b = bucketOf(m);
    if (m.seq > (reads[b] || 0) && m.seq > (buckets.get(b) || 0)) buckets.set(b, m.seq);
  }
  for (const [bucket, seq] of buckets) {
    reads[bucket] = seq;
    try { await api('/api/read', { method: 'POST', body: { bucket, seq } }); } catch (e) {}
  }
  if (buckets.size) renderAll();
}

// ─────────────────────────────────────────── отрисовка
const avatarCache = new Map(), avatarPending = new Set();
function initials(name) {
  const p = String(name || '?').trim().split(/\s+/);
  return ((p[0] || '?')[0] + (p[1] ? p[1][0] : '')).toUpperCase();
}
function avColor(id) {
  const palette = ['#2067b0', '#2fa8a0', '#c1682b', '#7a55b5', '#3f8f3f', '#b1425e', '#4a6fa5', '#9a7a1f'];
  let h = 0; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) % 9973;
  return palette[h % palette.length];
}
function avatarHtml(user, cls, withStatus) {
  const u = user || {};
  let inner;
  if (u.avatar) {
    const src = avatarCache.get(u.id);
    if (src) inner = `<img class="avatar ${cls || ''}" src="${src}" alt="">`;
    else { decodeAvatar(u); inner = `<span class="avatar ${cls || ''}" style="background:${avColor(u.id)}">${escapeHtml(initials(u.name))}</span>`; }
  } else {
    inner = `<span class="avatar ${cls || ''}" style="background:${avColor(u.id)}">${escapeHtml(initials(u.name))}</span>`;
  }
  return `<span class="av-wrap">${inner}${withStatus ? `<i class="status ${isOnline(u) ? 'on' : ''}"></i>` : ''}</span>`;
}
async function decodeAvatar(user) {
  if (avatarPending.has(user.id) || !user.avatar) return;
  avatarPending.add(user.id);
  try { avatarCache.set(user.id, (await decryptJSON(S.roomKey, user.avatar)).data); S.sig = ''; renderAll(); }
  catch (e) {}
  avatarPending.delete(user.id);
}

function renderAll() {
  if (!S.me) return;
  const sig = JSON.stringify([
    S.seq, S.messages.length, S.view, S.threadId, S.usage.bytes, S.railFilter,
    S.users.map(u => [u.id, u.name, u.isAdmin, !!u.avatar, isOnline(u), u.reads])
  ]);
  if (sig === S.sig) return;
  S.sig = sig;
  renderMe(); renderRail(); renderTopbar(); renderMessages(); renderThread(); renderMemory(); updateTitle();
}

function renderMe() {
  $('#me-avatar').innerHTML = avatarHtml(S.me, '', true);
  $('#me-name').textContent = S.me.name;
  $('#me-sub').textContent = S.me.isAdmin ? 'администратор · в сети' : 'в сети';
  $('#btn-admin').classList.toggle('hidden', !S.me.isAdmin);
}

function lastMessageIn(ch) {
  let best = null;
  for (const m of S.messages) if ((m.ch || 'group') === ch && (!best || m.seq > best.seq)) best = m;
  return best;
}
function preview(m) {
  if (!m) return '';
  const p = S.plain.get(m.id) || {};
  const who = m.uid === S.me.id ? 'Вы: ' : ((userById(m.uid) || {}).name || '') + ': ';
  const body = p.text ? p.text : (p.att ? '📷 изображение' : '');
  return who + (m.parent ? '↳ ' : '') + body;
}

function renderRail() {
  const flt = S.railFilter.toLowerCase();
  const gu = unreadIn('group');
  const gLast = lastMessageIn('group');
  let html = `<div class="rail-group">Общий чат</div>
    <div class="chat-item ${S.view.type === 'group' ? 'active' : ''} ${gu.total ? 'unread' : ''}" data-ch="group">
      <span class="av-wrap"><span class="avatar" style="background:#12323f">🎩</span></span>
      <div class="ci-main">
        <div class="ci-name">Alt-Джентельмены</div>
        <div class="ci-last">${escapeHtml(preview(gLast) || plural(S.users.length, 'участник', 'участника', 'участников'))}</div>
      </div>
      ${gu.mentions ? `<span class="badge at" title="упоминания">@${gu.mentions}</span>` : ''}
      ${gu.total ? `<span class="badge">${gu.total}</span>` : ''}
    </div>`;

  const peers = S.users.filter(u => u.id !== S.me.id && (!flt || u.name.toLowerCase().includes(flt)));
  peers.sort((a, b) => {
    const la = lastMessageIn(dmCh(S.me.id, a.id)), lb = lastMessageIn(dmCh(S.me.id, b.id));
    if (la && lb) return lb.ts - la.ts;
    if (la) return -1;
    if (lb) return 1;
    if (isOnline(a) !== isOnline(b)) return isOnline(a) ? -1 : 1;
    return a.name.localeCompare(b.name, 'ru');
  });
  html += `<div class="rail-group">Личные сообщения</div>`;
  if (!peers.length) html += `<div class="ci-last" style="padding:6px 10px">Пока никого нет</div>`;
  for (const u of peers) {
    const ch = dmCh(S.me.id, u.id);
    const un = unreadIn(ch);
    const last = lastMessageIn(ch);
    html += `<div class="chat-item ${S.view.type === 'dm' && S.view.peer === u.id ? 'active' : ''} ${un.total ? 'unread' : ''}" data-peer="${u.id}">
      ${avatarHtml(u, '', true)}
      <div class="ci-main">
        <div class="ci-name">${escapeHtml(u.name)}${u.isAdmin ? '<span class="tag-admin">адм</span>' : ''}</div>
        <div class="ci-last">${escapeHtml(preview(last) || (isOnline(u) ? 'в сети' : fmtAgo(u.lastSeen)))}</div>
      </div>
      ${un.total ? `<span class="badge">${un.total}</span>` : ''}
    </div>`;
  }
  $('#chat-list').innerHTML = html;
}

function renderTopbar() {
  if (S.view.type === 'group') {
    const online = S.users.filter(isOnline);
    $('#chat-avatar').innerHTML = `<span class="av-wrap"><span class="avatar" style="background:#12323f">🎩</span></span>`;
    $('#chat-title').textContent = 'Alt-Джентельмены';
    $('#chat-sub').innerHTML = `${plural(S.users.length, 'участник', 'участника', 'участников')} · <span style="color:#5c9c1e">${online.length} в сети</span>`;
  } else {
    const u = userById(S.view.peer) || { name: 'Участник' };
    $('#chat-avatar').innerHTML = avatarHtml(u, '', true);
    $('#chat-title').textContent = u.name;
    $('#chat-sub').innerHTML = isOnline(u)
      ? '<span style="color:#5c9c1e">в сети, смотрит чат</span>'
      : 'был(а) ' + escapeHtml(fmtAgo(u.lastSeen)) + ' · личная переписка';
  }
  $('#input').placeholder = S.view.type === 'group'
    ? 'Написать в общий чат…  (@ — обратиться к участнику)'
    : 'Личное сообщение для ' + ($('#chat-title').textContent) + '…';
}

function mentionize(text, mentions) {
  let html = linkify(escapeHtml(text));
  const names = S.users.map(u => u.name).sort((a, b) => b.length - a.length);
  for (const n of names) {
    const safe = escapeHtml(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    html = html.replace(new RegExp('@' + safe + '(?![\\wА-Яа-яЁё])', 'g'), m => `<span class="m-at">${m}</span>`);
  }
  return html;
}

function readersOf(m) {
  const bucket = bucketOf(m);
  return S.users.filter(u => u.id !== m.uid && ((u.reads || {})[bucket] || 0) >= m.seq);
}
function readersHtml(m) {
  if (m.uid !== S.me.id) return '';
  const rs = readersOf(m);
  if (!rs.length) return `<span class="check" title="Отправлено">✓</span>`;
  const shown = rs.slice(0, 5).map(u => avatarHtml(u, 'xs')).join('');
  const names = rs.map(u => u.name).join(', ');
  return `<span class="check" title="Прочитали: ${escapeHtml(names)}">✓✓</span>
    <span class="readers" title="Прочитали: ${escapeHtml(names)}">${shown}${rs.length > 5 ? `<span class="tiny muted">+${rs.length - 5}</span>` : ''}</span>`;
}

function messageHtml(m, opts = {}) {
  const p = S.plain.get(m.id) || { text: '…' };
  const author = userById(m.uid) || { id: m.uid, name: p.author || 'Бывший участник' };
  const mine = m.uid === S.me.id;
  const mentioned = p.mentions && p.mentions.includes(S.me.id) && !mine;
  const kids = opts.noThread ? [] : S.messages.filter(x => x.parent === m.id);
  const unreadKids = kids.length ? threadUnread(m.id) : 0;
  const canDel = mine || (S.me.isAdmin && (m.ch || 'group') === 'group');
  return `<div class="msg ${mine ? 'mine' : ''} ${mentioned ? 'mentioned' : ''}" id="m-${m.id}">
    ${avatarHtml(author, 'sm', true)}
    <div class="bubble-wrap">
      <div class="head"><span class="who">${escapeHtml(author.name)}</span><span class="time">${fmtTime(m.ts)}</span></div>
      <div class="bubble">${p.text ? mentionize(p.text, p.mentions) : ''}${p.att ? `<img class="att" src="${p.att}" alt="вложение">` : ''}</div>
      <div class="meta">
        ${readersHtml(m)}
        ${kids.length ? `<span class="thread-btn" data-thread="${m.id}">💬 ${plural(kids.length, 'комментарий', 'комментария', 'комментариев')}${unreadKids ? `<span class="dot-new"></span>` : ''}</span>` : ''}
      </div>
    </div>
    <div class="tools">
      ${opts.noThread ? '' : `<button class="tool" data-thread="${m.id}" title="Комментировать">💬</button>`}
      ${(m.ch || 'group') === 'group' && !mine ? `<button class="tool" data-dm="${m.uid}" title="Написать лично">✉️</button>` : ''}
      ${canDel ? `<button class="tool" data-del="${m.id}" title="Удалить">🗑</button>` : ''}
    </div>
  </div>`;
}

function renderMessages(force) {
  const box = $('#messages');
  const ch = viewCh();
  const list = S.messages.filter(m => (m.ch || 'group') === ch && !m.parent);
  const prevTop = box.scrollTop, prevHeight = box.scrollHeight;
  const nearBottom = prevHeight - prevTop - box.clientHeight < 160;
  if (!list.length) {
    box.innerHTML = `<div class="sys">${S.view.type === 'group'
      ? 'Сообщений пока нет. Поздоровайтесь с клубом 👋'
      : 'Личная переписка. Никто, кроме вас двоих, её не увидит.'}</div>`;
    return;
  }
  let html = '', lastDay = '';
  for (const m of list) {
    const day = new Date(m.ts).toDateString();
    if (day !== lastDay) { html += `<div class="day"><span>${fmtDay(m.ts)}</span></div>`; lastDay = day; }
    html += messageHtml(m);
  }
  box.innerHTML = html;
  if (force || nearBottom || S.atBottom) box.scrollTop = box.scrollHeight;
  else box.scrollTop = prevTop + (box.scrollHeight - prevHeight); // не дёргаем чтение истории
}

function renderThread() {
  const panel = $('#thread');
  if (!S.threadId) { hide(panel); return; }
  const parent = S.messages.find(m => m.id === S.threadId);
  if (!parent) { S.threadId = null; hide(panel); return; }
  show(panel);
  const p = S.plain.get(parent.id) || {};
  const author = userById(parent.uid) || { id: parent.uid, name: p.author || 'Бывший участник' };
  const kids = S.messages.filter(m => m.parent === parent.id);
  $('#thread-sub').textContent = kids.length ? plural(kids.length, 'комментарий', 'комментария', 'комментариев') : 'ещё никто не комментировал';
  const box = $('#thread-body');
  const prevTop = box.scrollTop, prevHeight = box.scrollHeight;
  const atBottom = prevHeight - prevTop - box.clientHeight < 120;
  box.innerHTML = `<div class="parent-card">
      <div style="display:flex;gap:9px;align-items:center">${avatarHtml(author, 'sm', true)}
        <div><div class="who">${escapeHtml(author.name)}</div><div class="tiny muted">${fmtDay(parent.ts)}, ${fmtTime(parent.ts)}</div></div></div>
      <div class="txt">${p.text ? mentionize(p.text, p.mentions) : ''}</div>
      ${p.att ? `<img src="${p.att}" alt="">` : ''}
    </div>` + kids.map(k => messageHtml(k, { noThread: true })).join('');
  if (atBottom) box.scrollTop = box.scrollHeight;
  else box.scrollTop = prevTop + (box.scrollHeight - prevHeight);
}

function renderMemory() {
  const u = S.usage, pct = Math.min(100, u.percent);
  $('#mem-pct').textContent = pct + '%';
  const fill = $('#mem-fill');
  fill.style.width = Math.max(pct, u.bytes > 0 ? 1.5 : 0) + '%';
  fill.classList.toggle('hot', pct >= 80);
  $('#mem-text').textContent = `${fmtBytes(u.bytes)} из ${fmtBytes(u.limit)} · ${u.messages} сообщ.`;
  $('#mem-warn').classList.toggle('hidden', pct < 80);
}

function updateTitle() {
  let total = 0, mentions = 0;
  const add = ch => { const u = unreadIn(ch); total += u.total; mentions += u.mentions; };
  add('group');
  S.users.forEach(u => { if (u.id !== S.me.id) add(dmCh(S.me.id, u.id)); });
  document.title = (total ? `(${total}) ` : '') + 'Alt-Джентельмены';
  $('#rail-badge').classList.toggle('hidden', !total);
  const btn = $('#btn-members');
  btn.title = mentions ? `Вас упомянули ${mentions} раз(а)` : 'Участники';
}

// ─────────────────────────────────────────── навигация
$('#chat-list').addEventListener('click', e => {
  const item = e.target.closest('[data-ch],[data-peer]');
  if (!item) return;
  openView(item.dataset.ch === 'group' ? { type: 'group' } : { type: 'dm', peer: item.dataset.peer });
  $('#rail').classList.remove('open');
});
function openView(view) {
  S.drafts[viewCh()] = $('#input').value;
  S.view = view;
  S.threadId = null;
  S.atBottom = true; S.sig = '';
  $('#input').value = S.drafts[viewCh()] || '';
  renderAll();
  renderMessages(true);
  markRead();
  if (window.matchMedia('(min-width: 901px)').matches) $('#input').focus();
}
$('#chat-filter').addEventListener('input', e => { S.railFilter = e.target.value; S.sig = ''; renderAll(); });
$('#btn-open-rail').addEventListener('click', () => $('#rail').classList.add('open'));
$('#btn-close-rail').addEventListener('click', () => $('#rail').classList.remove('open'));

function openThread(id) {
  S.threadId = id; S.sig = '';
  renderAll();
  markRead();
  setTimeout(() => { const b = $('#thread-body'); b.scrollTop = b.scrollHeight; $('#thread-input').focus(); }, 60);
}
$('#thread-close').addEventListener('click', () => { S.threadId = null; S.sig = ''; renderAll(); });

function handleMsgClick(e) {
  const th = e.target.closest('[data-thread]');
  if (th) return openThread(th.dataset.thread);
  const dm = e.target.closest('[data-dm]');
  if (dm) return openView({ type: 'dm', peer: dm.dataset.dm });
  const del = e.target.closest('[data-del]');
  if (del) {
    if (!confirm('Удалить сообщение у всех? Комментарии к нему тоже исчезнут.')) return;
    api('/api/messages/' + del.dataset.del, { method: 'DELETE' })
      .then(() => { if (S.threadId === del.dataset.del) S.threadId = null; return sync(); })
      .catch(ex => toast(ex.message, true));
    return;
  }
  const img = e.target.closest('img.att');
  if (img) {
    const lb = document.createElement('div');
    lb.className = 'lightbox';
    lb.innerHTML = `<img src="${img.src}" alt="">`;
    lb.onclick = () => lb.remove();
    document.body.appendChild(lb);
  }
}
$('#messages').addEventListener('click', handleMsgClick);
$('#thread-body').addEventListener('click', handleMsgClick);
$('#messages').addEventListener('scroll', () => {
  const box = $('#messages');
  S.atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
  $('#scroll-bottom').classList.toggle('hidden', S.atBottom);
});
$('#scroll-bottom').addEventListener('click', () => { const b = $('#messages'); b.scrollTop = b.scrollHeight; });

// список участников (кнопка 👥)
$('#btn-members').addEventListener('click', () => {
  const rows = S.users.map(u => `<div class="mrow">${avatarHtml(u, '', true)}
      <span class="nm">${escapeHtml(u.name)}${u.id === S.me.id ? ' <span class="muted">(вы)</span>' : ''}${u.isAdmin ? '<span class="tag-admin">адм</span>' : ''}
        <div class="tiny muted">${isOnline(u) ? 'в сети, смотрит чат' : 'был(а) ' + escapeHtml(fmtAgo(u.lastSeen))}</div></span>
      ${u.id !== S.me.id ? `<button class="mini" data-open-dm="${u.id}">написать лично</button>` : ''}
    </div>`).join('');
  modal(`Участники · ${S.users.length}`, rows + `<p class="hint">Зелёная точка — участник сейчас открыл чат.</p>`);
  $('#modal-body').addEventListener('click', e => {
    const b = e.target.closest('[data-open-dm]');
    if (b) { hide($('#modal')); openView({ type: 'dm', peer: b.dataset.openDm }); }
  });
});

// ─────────────────────────────────────────── отправка сообщений
function autoGrow(el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 150) + 'px'; }
function findMentions(text) {
  const ids = [];
  for (const u of [...S.users].sort((a, b) => b.name.length - a.name.length)) {
    const safe = u.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp('@' + safe + '(?![\\wА-Яа-яЁё])').test(text)) ids.push(u.id);
  }
  return ids;
}
async function send({ textarea, parent, attachKey }) {
  const text = textarea.value.trim();
  const att = S[attachKey];
  if (!text && !att) return;
  const ch = viewCh();
  const key = await keyForCh(ch);
  if (!key) return toast('Не удалось получить ключ шифрования для этого чата', true);
  const payload = { v: 1, text, author: S.me.name, mentions: findMentions(text) };
  if (att) payload.att = att;
  textarea.value = ''; autoGrow(textarea);
  clearAttach(attachKey);
  try {
    const blob = await encryptJSON(key, payload);
    const r = await api('/api/messages', { method: 'POST', body: { blob, ch, parent: parent || null } });
    S.usage = r.usage; S.atBottom = true; S.sig = '';
    await sync();
    if (!parent) renderMessages(true);
  } catch (ex) {
    toast(ex.message, true);
    textarea.value = text; S[attachKey] = att;
    if (att) showAttach(attachKey, att);
  }
}
$('#btn-send').addEventListener('click', () => send({ textarea: $('#input'), attachKey: 'attach' }));
$('#thread-send').addEventListener('click', () => send({ textarea: $('#thread-input'), parent: S.threadId, attachKey: 'threadAttach' }));

function composerKeydown(e, sendFn) {
  if (mentionKeydown(e)) return;
  if (e.key === 'Enter' && !e.shiftKey && window.matchMedia('(min-width: 901px)').matches) { e.preventDefault(); sendFn(); }
}
$('#input').addEventListener('keydown', e => composerKeydown(e, () => send({ textarea: $('#input'), attachKey: 'attach' })));
$('#thread-input').addEventListener('keydown', e => composerKeydown(e, () => send({ textarea: $('#thread-input'), parent: S.threadId, attachKey: 'threadAttach' })));
$('#input').addEventListener('input', e => { autoGrow(e.target); mentionInput(e.target, $('#mention-pop')); });
$('#thread-input').addEventListener('input', e => { autoGrow(e.target); mentionInput(e.target, $('#thread-mention-pop')); });

// ─────────────────────────────────────────── обращения через @
let mention = { pop: null, target: null, items: [], sel: 0, start: -1 };
function mentionInput(textarea, pop) {
  const pos = textarea.selectionStart;
  const before = textarea.value.slice(0, pos);
  const m = before.match(/(^|\s)@([\wА-Яа-яЁё-]{0,24})$/);
  if (!m) return closeMention();
  const q = m[2].toLowerCase();
  const list = S.users.filter(u => u.id !== S.me.id && u.name.toLowerCase().includes(q)).slice(0, 8);
  if (!list.length) return closeMention();
  mention = { pop, target: textarea, items: list, sel: 0, start: pos - m[2].length - 1 };
  drawMention();
}
function drawMention() {
  if (!mention.pop) return;
  mention.pop.innerHTML = mention.items.map((u, i) =>
    `<div class="mention-item ${i === mention.sel ? 'sel' : ''}" data-mi="${i}">${avatarHtml(u, 'sm', true)}<span>${escapeHtml(u.name)}</span></div>`).join('');
  show(mention.pop);
}
function closeMention() { if (mention.pop) hide(mention.pop); mention.items = []; mention.pop = null; }
function pickMention(i) {
  const u = mention.items[i];
  if (!u) return;
  const t = mention.target, val = t.value;
  const after = val.slice(t.selectionStart);
  t.value = val.slice(0, mention.start) + '@' + u.name + ' ' + after;
  const caret = mention.start + u.name.length + 2;
  closeMention();
  t.focus(); t.setSelectionRange(caret, caret);
}
function mentionKeydown(e) {
  if (!mention.items.length) return false;
  if (e.key === 'ArrowDown') { mention.sel = (mention.sel + 1) % mention.items.length; drawMention(); e.preventDefault(); return true; }
  if (e.key === 'ArrowUp') { mention.sel = (mention.sel - 1 + mention.items.length) % mention.items.length; drawMention(); e.preventDefault(); return true; }
  if (e.key === 'Enter' || e.key === 'Tab') { pickMention(mention.sel); e.preventDefault(); return true; }
  if (e.key === 'Escape') { closeMention(); e.preventDefault(); return true; }
  return false;
}
['#mention-pop', '#thread-mention-pop'].forEach(sel => $(sel).addEventListener('mousedown', e => {
  const it = e.target.closest('[data-mi]');
  if (it) { e.preventDefault(); pickMention(Number(it.dataset.mi)); }
}));

// ─────────────────────────────────────────── вложения
function showAttach(key, data) {
  if (key === 'attach') { $('#attach-img').src = data; show($('#attach-preview')); }
  else { $('#thread-attach-img').src = data; show($('#thread-attach')); }
}
function clearAttach(key) {
  S[key] = null;
  if (key === 'attach') { hide($('#attach-preview')); $('#attach-img').src = ''; }
  else { hide($('#thread-attach')); $('#thread-attach-img').src = ''; }
}
async function pickImage(e, key) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try { const data = await resizeImage(file, 1400, 0.82); S[key] = data; showAttach(key, data); }
  catch (ex) { toast('Не удалось обработать картинку', true); }
}
$('#file-input').addEventListener('change', e => pickImage(e, 'attach'));
$('#thread-file').addEventListener('change', e => pickImage(e, 'threadAttach'));
$('#attach-remove').addEventListener('click', () => clearAttach('attach'));
$('#thread-attach-remove').addEventListener('click', () => clearAttach('threadAttach'));

function resizeImage(file, max, quality) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width: w, height: h } = img;
        const k = Math.min(1, max / Math.max(w, h));
        w = Math.round(w * k); h = Math.round(h * k);
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL('image/jpeg', quality));
      };
      img.onerror = reject; img.src = fr.result;
    };
    fr.onerror = reject; fr.readAsDataURL(file);
  });
}
function cropSquare(file, size) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const img = new Image();
      img.onload = () => {
        const s = Math.min(img.width, img.height);
        const c = document.createElement('canvas');
        c.width = c.height = size;
        c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
        resolve(c.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = reject; img.src = fr.result;
    };
    fr.onerror = reject; fr.readAsDataURL(file);
  });
}

// ─────────────────────────────────────────── поиск по всей истории
let searchTimer = null;
$('#search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 160); });
$('#btn-search-clear').addEventListener('click', () => { $('#search').value = ''; runSearch(); });

function chLabel(m) {
  const ch = m.ch || 'group';
  if (ch === 'group') return m.parent ? 'Общий чат · комментарий' : 'Общий чат';
  const peer = userById(chPeer(ch));
  return 'Лично: ' + ((peer && peer.name) || 'участник');
}
function runSearch() {
  const q = $('#search').value.trim().toLowerCase();
  const box = $('#search-results');
  if (!q) { hide(box); box.innerHTML = ''; return; }
  const words = q.split(/\s+/).filter(Boolean);
  const hits = [];
  for (let i = S.messages.length - 1; i >= 0 && hits.length < 300; i--) {
    const m = S.messages[i], p = S.plain.get(m.id);
    if (!p || !p.text) continue;
    const low = p.text.toLowerCase();
    if (words.every(w => low.includes(w))) hits.push({ m, p });
  }
  box.innerHTML = `<div class="sr-head">Найдено ${hits.length}${hits.length >= 300 ? '+' : ''} — нажмите, чтобы перейти</div>` +
    (hits.map(({ m, p }) => {
      let t = escapeHtml(p.text);
      words.forEach(w => { t = t.replace(new RegExp('(' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi'), '<mark>$1</mark>'); });
      const author = userById(m.uid) || { name: p.author || 'Бывший участник' };
      return `<div class="sr" data-go="${m.id}">
        <div class="m"><b>${escapeHtml(author.name)}</b><span class="chip">${escapeHtml(chLabel(m))}</span><span>${fmtDay(m.ts)}, ${fmtTime(m.ts)}</span></div>
        <div class="t">${t}</div></div>`;
    }).join('') || '<div class="sr muted">Ничего не найдено</div>');
  show(box);
}
$('#search-results').addEventListener('click', e => {
  const el = e.target.closest('[data-go]');
  if (!el) return;
  const m = S.messages.find(x => x.id === el.dataset.go);
  if (!m) return;
  const ch = m.ch || 'group';
  const view = ch === 'group' ? { type: 'group' } : { type: 'dm', peer: chPeer(ch) };
  if (JSON.stringify(view) !== JSON.stringify(S.view)) openView(view);
  if (m.parent) openThread(m.parent);
  setTimeout(() => {
    const target = document.getElementById('m-' + m.id);
    if (!target) return;
    if (target.scrollIntoView) target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    target.classList.remove('hl'); void target.offsetWidth; target.classList.add('hl');
  }, 120);
});

// ─────────────────────────────────────────── модальные окна
function modal(title, html) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = html;
  show($('#modal'));
}
$('#modal-close').addEventListener('click', () => hide($('#modal')));
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') hide($('#modal')); });

// профиль
$('#btn-profile').addEventListener('click', () => {
  $('#rail').classList.remove('open');
  const me = userById(S.me.id) || S.me;
  modal('Профиль', `
    <div class="avatar-pick">
      <span id="pf-avatar">${avatarHtml(me, 'lg')}</span>
      <div>
        <label class="file-btn" for="pf-file">Загрузить аватар</label>
        <input type="file" id="pf-file" accept="image/*" hidden>
        <div class="tiny muted" style="margin-top:6px">обрезается в круг, шифруется</div>
        ${me.avatar ? '<button class="mini danger" id="pf-avatar-del" style="margin-top:8px">Убрать аватар</button>' : ''}
      </div>
    </div>
    <div class="divider"><span>Имя</span></div>
    <label>Как вас называть<input type="text" id="pf-name" value="${escapeHtml(me.name)}" maxlength="32"></label>
    <button class="primary" id="pf-save-name">Сохранить имя</button>
    <div class="divider"><span>Пароль</span></div>
    <label>Текущий пароль<input type="password" id="pf-old" autocomplete="current-password"></label>
    <label>Новый пароль<input type="password" id="pf-new" autocomplete="new-password" placeholder="минимум 6 символов"></label>
    <label>Повторите новый<input type="password" id="pf-new2" autocomplete="new-password"></label>
    <div class="err" id="pf-err"></div>
    <button class="primary" id="pf-save-pass">Сменить пароль</button>`);

  $('#pf-file').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const data = await cropSquare(f, 160);
      await api('/api/profile', { method: 'POST', body: { avatar: await encryptJSON(S.roomKey, { data }) } });
      avatarCache.set(S.me.id, data);
      $('#pf-avatar').innerHTML = `<img class="avatar lg" src="${data}" alt="">`;
      S.sig = ''; await sync(); toast('Аватар обновлён');
    } catch (ex) { toast(ex.message, true); }
  });
  const del = $('#pf-avatar-del');
  if (del) del.addEventListener('click', async () => {
    await api('/api/profile', { method: 'POST', body: { avatar: null } });
    avatarCache.delete(S.me.id); S.sig = ''; await sync(); hide($('#modal')); toast('Аватар убран');
  });
  $('#pf-save-name').addEventListener('click', async () => {
    try { await api('/api/profile', { method: 'POST', body: { name: $('#pf-name').value.trim() } }); S.sig = ''; await sync(); toast('Имя обновлено'); }
    catch (ex) { toast(ex.message, true); }
  });
  $('#pf-save-pass').addEventListener('click', async () => {
    const err = $('#pf-err'); err.textContent = '';
    const oldP = $('#pf-old').value, np = $('#pf-new').value;
    if (np.length < 6) return err.textContent = 'Новый пароль слишком короткий';
    if (np !== $('#pf-new2').value) return err.textContent = 'Новые пароли не совпадают';
    const btn = $('#pf-save-pass'); btn.disabled = true; btn.textContent = 'Меняем ключи…';
    try {
      const salts = await api('/api/salt', { method: 'POST', body: { name: S.me.name } });
      const oldAuthKey = toHex(await pbkdf2(oldP, salts.saltAuth));
      const saltAuth = newSalt(), saltWrap = newSalt();
      const wrapKey = await aesKeyFrom(np, saltWrap);
      const body = {
        password: {
          oldAuthKey, saltAuth, saltWrap,
          authKey: toHex(await pbkdf2(np, saltAuth)),
          wrappedKeyByPass: await aesEncryptBytes(wrapKey, S.roomKeyRaw),
          wrappedPriv: S.privRaw ? await aesEncryptBytes(wrapKey, S.privRaw) : null
        }
      };
      await api('/api/profile', { method: 'POST', body });
      S.saltAuth = saltAuth; S.saltWrap = saltWrap; saveSession();
      hide($('#modal')); toast('Пароль изменён. На других устройствах нужно войти заново.');
    } catch (ex) { err.textContent = ex.message; }
    btn.disabled = false; btn.textContent = 'Сменить пароль';
  });
});

// управление (админ)
$('#btn-admin').addEventListener('click', async () => {
  $('#rail').classList.remove('open');
  let archives = [];
  try { archives = (await api('/api/admin/archives')).archives; } catch (e) {}
  modal('Управление чатом', `
    <div class="divider"><span>Участники</span></div>
    <div id="ad-users"></div>
    <div class="divider"><span>Кодовая фраза</span></div>
    <p class="hint">Смена фразы закрывает вход новым людям по старой. Уже зарегистрированные продолжают читать историю.</p>
    <label>Новая кодовая фраза<input type="text" id="ad-code" placeholder="минимум 6 символов" autocomplete="off"></label>
    <div class="err" id="ad-code-err"></div>
    <button class="primary" id="ad-code-save">Обновить фразу</button>
    <div class="divider"><span>Память и архивы</span></div>
    <p class="hint">Занято ${fmtBytes(S.usage.bytes)} из ${fmtBytes(S.usage.limit)} (${S.usage.percent}%). Архивы лежат в папке <b>data/archives</b>.</p>
    <button class="primary" id="ad-archive" style="background:#5c6f7c">Заархивировать историю и начать новую</button>
    <div id="ad-archives" style="margin-top:10px">${archives.length ? archives.map(a => `
      <div class="archive-row"><span style="flex:1">${new Date(a.createdAt).toLocaleString('ru-RU')} · ${a.count} сообщ. · ${fmtBytes(a.bytes)}</span>
      <button class="mini" data-arch="${a.file}">скачать</button></div>`).join('') : '<div class="tiny muted">Архивов пока нет</div>'}</div>`);
  renderAdminUsers();

  $('#ad-users').addEventListener('click', async e => {
    const b = e.target.closest('button[data-id]'); if (!b) return;
    try {
      if (b.dataset.act === 'del') {
        if (!confirm('Исключить участника? Его сообщения останутся в истории.')) return;
        await api('/api/admin/users/' + b.dataset.id, { method: 'DELETE' });
      } else {
        await api('/api/admin/users/' + b.dataset.id + '/admin', { method: 'POST', body: { value: b.dataset.act === 'up' } });
      }
      S.sig = ''; await sync(); renderAdminUsers();
    } catch (ex) { toast(ex.message, true); }
  });
  $('#ad-code-save').addEventListener('click', async () => {
    const code = $('#ad-code').value.trim(), err = $('#ad-code-err');
    err.textContent = '';
    if (code.length < 6) return err.textContent = 'Слишком короткая фраза';
    const btn = $('#ad-code-save'); btn.disabled = true; btn.textContent = 'Обновляем…';
    try {
      const codeProofSalt = newSalt(), codeSalt = newSalt();
      await api('/api/admin/code', {
        method: 'POST', body: {
          codeProofSalt, codeProof: toHex(await pbkdf2(code, codeProofSalt)),
          codeSalt, wrappedKeyByCode: await aesEncryptBytes(await aesKeyFrom(code, codeSalt), S.roomKeyRaw)
        }
      });
      $('#ad-code').value = ''; toast('Кодовая фраза обновлена');
    } catch (ex) { err.textContent = ex.message; }
    btn.disabled = false; btn.textContent = 'Обновить фразу';
  });
  $('#ad-archive').addEventListener('click', async () => {
    if (!confirm('Сохранить архив на сервере и очистить переписку? Сначала лучше скачать читаемую копию (кнопка «Архив»).')) return;
    try {
      const r = await api('/api/admin/archive', { method: 'POST', body: { reset: true } });
      try { await downloadArchive(r.archive.file); }
      catch (e) { toast('Архив на сервере сохранён, но скачать не удалось: ' + e.message, true); }
      S.sig = ''; await sync(); hide($('#modal')); toast('Архив создан, чат очищен');
    } catch (ex) { toast(ex.message, true); }
  });
  $('#ad-archives').addEventListener('click', e => {
    const b = e.target.closest('[data-arch]');
    if (b) downloadArchive(b.dataset.arch).catch(ex => toast(ex.message, true));
  });
});
function renderAdminUsers() {
  const box = $('#ad-users');
  if (!box) return;
  box.innerHTML = S.users.map(u => `<div class="mrow">${avatarHtml(u, '', true)}
    <span class="nm">${escapeHtml(u.name)}${u.isAdmin ? '<span class="tag-admin">адм</span>' : ''}</span>
    ${u.id !== S.me.id ? `<button class="mini" data-id="${u.id}" data-act="${u.isAdmin ? 'down' : 'up'}">${u.isAdmin ? 'снять права' : 'сделать адм.'}</button>
    <button class="mini danger" data-id="${u.id}" data-act="del">исключить</button>` : '<span class="tiny muted">это вы</span>'}</div>`).join('');
}

// ─────────────────────────────────────────── архивы
async function downloadArchive(file) {
  const res = await fetch('/api/archives/' + encodeURIComponent(file), { headers: { Authorization: 'Bearer ' + S.token } });
  if (!res.ok) throw new Error('Не удалось скачать архив');
  saveBlob(await res.blob(), file);
}
function saveBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
$('#btn-export').addEventListener('click', () => {
  $('#rail').classList.remove('open');
  modal('Сохранить архив', `
    <p class="hint">Читаемая копия открывается в любом браузере без чата и без пароля (в ней общий чат, комментарии и ваши личные переписки). Зашифрованная выгрузка безопасна, но открывается только этим приложением.</p>
    <button class="primary" id="ex-html">Читаемая копия (HTML)</button>
    <button class="primary" id="ex-json" style="background:#5c6f7c;margin-top:8px">Читаемая копия (JSON)</button>
    <button class="primary" id="ex-enc" style="background:#5c6f7c;margin-top:8px">Зашифрованная выгрузка с сервера</button>
    <div class="tiny muted" style="margin-top:12px">Всего сообщений: ${S.messages.length}, объём ${fmtBytes(S.usage.bytes)}.</div>`);
  $('#ex-html').addEventListener('click', exportHtml);
  $('#ex-json').addEventListener('click', exportJson);
  $('#ex-enc').addEventListener('click', async () => {
    try {
      const res = await fetch('/api/export', { headers: { Authorization: 'Bearer ' + S.token } });
      saveBlob(await res.blob(), 'alt-gentlemen-encrypted-' + new Date().toISOString().slice(0, 10) + '.json');
    } catch (ex) { toast('Не удалось выгрузить', true); }
  });
});
function plainList() {
  return S.messages.map(m => {
    const p = S.plain.get(m.id) || {};
    const u = userById(m.uid);
    return {
      time: new Date(m.ts).toLocaleString('ru-RU'), ts: m.ts,
      chat: chLabel(m), parent: m.parent || null, id: m.id,
      author: (u && u.name) || p.author || 'Бывший участник',
      text: p.text || '', image: p.att || null
    };
  });
}
function exportJson() {
  saveBlob(new Blob([JSON.stringify({ chat: 'Alt-Джентельмены', exportedAt: new Date().toISOString(), messages: plainList() }, null, 2)],
    { type: 'application/json' }), 'alt-gentelmeny-' + new Date().toISOString().slice(0, 10) + '.json');
}
function exportHtml() {
  const rows = plainList().map(m => `<div class="m${m.parent ? ' c' : ''}"><div class="h"><b>${escapeHtml(m.author)}</b>
    <span>${escapeHtml(m.time)}</span><i>${escapeHtml(m.chat)}</i></div>
    ${m.text ? `<div class="t">${linkify(escapeHtml(m.text))}</div>` : ''}${m.image ? `<img src="${m.image}">` : ''}</div>`).join('\n');
  const html = `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Alt-Джентельмены — архив</title><style>
body{background:#eef2f4;color:#1f2b33;font-family:Helvetica,Arial,sans-serif;margin:0;padding:24px}
.wrap{max-width:860px;margin:0 auto}h1{color:#2067b0}
#q{width:100%;padding:10px 12px;border-radius:8px;border:1px solid #d7dfe5;margin:12px 0 18px}
.m{background:#fff;border-radius:10px;padding:10px 13px;margin-bottom:8px;box-shadow:0 1px 2px rgba(20,50,70,.09)}
.m.c{margin-left:36px;border-left:3px solid #2fc6f6}
.h b{color:#2067b0}.h span{color:#8b98a4;font-size:12px;margin-left:8px}.h i{color:#8b98a4;font-size:11px;margin-left:8px}
.t{white-space:pre-wrap;margin-top:4px}img{max-width:min(420px,90%);border-radius:8px;margin-top:8px;display:block}
a{color:#2067b0}.muted{color:#8b98a4}</style></head><body><div class="wrap">
<h1>🎩 Alt-Джентельмены</h1><div class="muted">Архив · ${new Date().toLocaleString('ru-RU')} · ${S.messages.length} сообщений</div>
<input id="q" placeholder="Поиск по архиву…" oninput="(function(v){document.querySelectorAll('.m').forEach(function(e){e.style.display=e.innerText.toLowerCase().includes(v.toLowerCase())?'':'none'})})(this.value)">
${rows}</div></body></html>`;
  saveBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), 'alt-gentelmeny-' + new Date().toISOString().slice(0, 10) + '.html');
}

$('#btn-logout').addEventListener('click', () => { if (confirm('Выйти из чата на этом устройстве?')) doLogout(); });

boot();
