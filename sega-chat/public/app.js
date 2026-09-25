/* SEGA-CHAT — клиент (оформление в духе Bitrix24).
   Любой участник создаёт свои групповые чаты и пишет личные сообщения.
   Всё шифруется в браузере: у каждого чата свой ключ AES-256-GCM,
   который передаётся участникам «завёрнутым» в ключ пары (ECDH P-256). */
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
const MB = 1024 * 1024;
const DEFAULT_MAX_UPLOAD = 3.1 * MB;
const UPLOAD_PLAIN_HEADROOM = 0.70; // AES-GCM + base64 + JSON должны уложиться в лимит Cloud Functions
const GROUP_GAP_MS = 5 * 60 * 1000;
const EMOJIS = '😀 😃 😄 😁 😆 😊 🙂 😉 😍 🥰 😘 😎 🤔 😅 😂 🤣 🙃 😇 😌 😍 😜 🤗 🤝 👍 👎 👌 🙌 👏 🤞 💪 🙏 ❤️ 🧡 💛 💚 💙 💜 🤍 🔥 ✨ 🎉 ✅ ☕ 🍻 🥂 🍷 🎲 🚀 📌'.split(' ');

function toast(msg, isErr) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '');
  clearTimeout(t._t);
  t._t = setTimeout(() => hide(t), 3800);
}
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// иконка-корзина для кнопки удаления сообщения
const ICON_TRASH = '<svg class="ic" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m2 0v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V7m4 4v6m4-6v6"/></svg>';
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
const cut = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

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
const importAes = raw => subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);

// пара ключей для личных переписок и передачи ключей групп
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
  saltAuth: null, saltWrap: null,
  users: [], chats: [], messages: [], messageIds: new Set(), plain: new Map(),
  pairKeys: new Map(),   // userId -> CryptoKey
  chatKeys: new Map(),   // chatId -> { key, raw }
  chatTitles: new Map(), // chatId -> строка
  view: null, threadId: null, quote: null, highlight: null, drafts: {},
  seq: 0, usage: { bytes: 0, limit: 1, percent: 0, messages: 0 }, maxUpload: DEFAULT_MAX_UPLOAD,
  attach: null, threadAttach: null, remember: true, timer: null, atBottom: true,
  notify: { sound: true, muted: {}, desktop: false },
  sig: '', railFilter: ''
};

const userById = id => S.users.find(u => u.id === id);
const chatById = id => S.chats.find(c => c.id === id);
const isOnline = u => u && Date.now() - (u.activeAt || 0) < ONLINE_MS;
const myReads = () => (S.me && S.me.reads) || {};
const bucketOf = m => m.parent ? 'thr:' + m.parent : m.chat;
const dmPeer = c => c && c.kind === 'dm' ? c.members.find(x => x !== S.me.id) : null;
const isOwner = c => !!c && c.kind === 'group' && c.ownerId === S.me.id;
function chatTitle(c) {
  if (!c) return '';
  if (c.kind === 'dm') { const u = userById(dmPeer(c)); return u ? u.name : 'Личная переписка'; }
  return S.chatTitles.get(c.id) || c.titlePlain || 'Групповой чат';
}
const curChat = () => chatById(S.view);

function store() { return S.remember ? localStorage : sessionStorage; }
function saveSession() {
  store().setItem('sega.session', JSON.stringify({
    token: S.token, key: toB64(S.roomKeyRaw), priv: S.privRaw ? toB64(S.privRaw) : null,
    saltAuth: S.saltAuth, saltWrap: S.saltWrap
  }));
}
function loadSessionRaw() {
  const a = localStorage.getItem('sega.session');
  if (a) { S.remember = true; return JSON.parse(a); }
  const b = sessionStorage.getItem('sega.session');
  if (b) { S.remember = false; return JSON.parse(b); }
  return null;
}
function clearSession() { localStorage.removeItem('sega.session'); sessionStorage.removeItem('sega.session'); }

function loadNotifySettings() {
  try {
    const raw = localStorage.getItem('sega.notify');
    if (!raw) return;
    const saved = JSON.parse(raw);
    S.notify = {
      sound: saved.sound !== false,
      muted: saved.muted && typeof saved.muted === 'object' ? saved.muted : {},
      desktop: !!saved.desktop
    };
  } catch (e) {}
}
function saveNotifySettings() {
  try { localStorage.setItem('sega.notify', JSON.stringify(S.notify)); } catch (e) {}
}
function isChatMuted(chatId) { return !!(chatId && S.notify && S.notify.muted && S.notify.muted[chatId]); }
function setChatMuted(chatId, muted) {
  if (!chatId) return;
  if (muted) S.notify.muted[chatId] = true;
  else delete S.notify.muted[chatId];
  saveNotifySettings();
}
function renderNotifyControls() {
  const box = $('#notify-sound');
  if (!box) return;
  box.checked = S.notify.sound !== false;
  box.setAttribute('aria-checked', String(box.checked));
}
loadNotifySettings();

// ─────────────────────────────────────────── сеть
// В облаке страница может жить по адресу вида https://…/<код-функции>/ —
// тогда сервер подставляет сюда эту приставку, и запросы находят дорогу.
const BASE = (typeof window !== 'undefined' && window.SEGA_BASE) || '';
async function api(path, opts = {}) {
  const headers = Object.assign({}, opts.headers || {});
  if (opts.body !== undefined && typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);
  if (opts.body) headers['Content-Type'] = 'application/json';
  if (S.token) headers['Authorization'] = 'Bearer ' + S.token;
  const res = await fetch(BASE + path, Object.assign({}, opts, { headers }));
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
    $('#form-setup').innerHTML = `<div class="brand"><h1 class="lockup"><img class="logo" src="logo.png" alt="SEGA"><span>CHAT</span></h1></div>
      <p class="hint">Браузер не даёт доступ к шифрованию, потому что страница открыта по незащищённому адресу.
      Откройте чат по адресу <b>http://localhost:8080</b> на этом компьютере или запустите сервер по HTTPS
      (README, раздел «Как открыть чат с телефона»).</p>`;
    return;
  }
  let st;
  try { st = await api('/api/state'); } catch (e) { toast('Сервер недоступен: ' + e.message, true); return; }
  S.maxUpload = Number(st.maxUpload || DEFAULT_MAX_UPLOAD);
  if (st.setupRequired) return screen('setup');

  const sess = loadSessionRaw();
  if (sess && sess.token) {
    S.token = sess.token; S.saltAuth = sess.saltAuth; S.saltWrap = sess.saltWrap;
    S.roomKeyRaw = fromB64(sess.key);
    S.roomKey = await importAes(S.roomKeyRaw);
    if (sess.priv) { S.privRaw = fromB64(sess.priv); S.priv = await importPriv(S.privRaw); }
    try { await startApp(); return; } catch (e) { clearSession(); S.token = null; }
  }
  screen('auth');
}

// ─────────────────────────────────────────── создание мессенджера
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
  } catch (ex) { err.textContent = ex.message; btn.disabled = false; btn.textContent = 'Создать мессенджер'; }
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
    catch (_) { throw new Error('Не удалось расшифровать ключи. Проверьте пароль.'); }
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
  S.roomKey = await importAes(S.roomKeyRaw);
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
    messages: [], messageIds: new Set(), chats: [], plain: new Map(), pairKeys: new Map(), chatKeys: new Map(), chatTitles: new Map(),
    seq: 0, view: null, threadId: null, quote: null, sig: ''
  });
  $('#messages').innerHTML = '';
  document.title = 'SEGA-CHAT';
  screen('auth');
}

// ─────────────────────────────────────────── ключи чатов
async function pairKeyWith(userId) {
  if (S.pairKeys.has(userId)) return S.pairKeys.get(userId);
  const u = userById(userId);
  if (!u || !u.pub || !S.priv) return null;
  try {
    const pub = await subtle.importKey('raw', fromB64(u.pub), EC, false, []);
    const key = await subtle.deriveKey({ name: 'ECDH', public: pub }, S.priv, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    S.pairKeys.set(userId, key);
    return key;
  } catch (e) { return null; }
}
async function chatKeyOf(chat) {
  if (!chat) return null;
  if (S.chatKeys.has(chat.id)) return S.chatKeys.get(chat.id);
  let entry = null;
  if (chat.kind === 'dm') {
    const key = await pairKeyWith(dmPeer(chat));
    entry = key ? { key, raw: null } : null;
  } else if (chat.legacyRoomKey) {
    entry = { key: S.roomKey, raw: S.roomKeyRaw };
  } else if (chat.key && chat.key.blob) {
    const wrap = await pairKeyWith(chat.key.by);
    if (wrap) {
      try {
        const raw = await aesDecryptBytes(wrap, chat.key.blob);
        entry = { key: await importAes(raw), raw };
      } catch (e) { entry = null; }
    }
  }
  if (entry) S.chatKeys.set(chat.id, entry);
  return entry;
}
async function prepareChats() {
  for (const c of S.chats) {
    const k = await chatKeyOf(c);
    if (!k) continue;
    if (c.kind === 'group' && c.titleBlob && !S.chatTitles.has(c.id)) {
      try { S.chatTitles.set(c.id, (await decryptJSON(k.key, c.titleBlob)).title); }
      catch (e) { S.chatTitles.set(c.id, 'Чат (не удалось прочитать название)'); }
    }
  }
}

// ─────────────────────────────────────────── цикл синхронизации
async function startApp() {
  screen('app');
  S.seq = 0; S.gen = -1; S.messages = []; S.messageIds = new Set(); S.plain = new Map(); S.sig = '';
  syncPromise = null; syncQueued = false;
  await sync(true);
  if (!S.view && S.chats.length) S.view = [...S.chats].sort((a, b) => b.lastTs - a.lastTs)[0].id;
  S.sig = ''; renderAll(); renderMessages(true);
  loop();
  if (!S.priv) toast('Войдите заново (Выйти → Вход), чтобы включить шифрование чатов', true);
}
// Опрашиваем сервер тем реже, чем дольше человек ничего не делает.
// На домашнем сервере это незаметно, а в облаке заметно экономит бесплатный лимит.
let lastTouch = Date.now();
const noteTouch = () => { lastTouch = Date.now(); primeNotifySound(); };
for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
  document.addEventListener(ev, noteTouch, { passive: true });
}
function pollDelay() {
  if (document.hidden) return 45000;
  const idle = Date.now() - lastTouch;
  if (idle < 90000) return 2500;      // человек только что что-то делал
  if (idle < 15 * 60000) return 10000;
  return 30000;                        // вкладка открыта, но о ней забыли
}
function loop() {
  clearTimeout(S.timer);
  S.timer = setTimeout(async () => {
    if (S.token && (!document.hidden || Date.now() - lastTouch < 60 * 60000)) {
      try { await sync(); } catch (e) {}
    }
    loop();
  }, pollDelay());
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && S.token) { noteTouch(); sync().catch(() => {}); loop(); }
});
window.addEventListener('focus', () => { if (S.token) { noteTouch(); markRead(); } });

let syncPromise = null;
let syncQueued = false;

function rebuildMessageIndex() {
  const seen = new Set(), unique = [];
  for (const m of S.messages.slice().sort((a, b) => a.seq - b.seq)) {
    if (!m || seen.has(m.id)) continue;
    seen.add(m.id); unique.push(m);
  }
  S.messages = unique;
  S.messageIds = seen;
}
function resetMessageStore() {
  S.messages = [];
  S.messageIds = new Set();
  S.plain = new Map();
}
function addMessages(list) {
  if (!S.messageIds || S.messageIds.size !== S.messages.length) rebuildMessageIndex();
  const fresh = [];
  for (const m of (list || [])) {
    if (!m || !m.id || S.messageIds.has(m.id)) continue;
    S.messageIds.add(m.id);
    S.messages.push(m);
    fresh.push(m);
  }
  if (fresh.length) S.messages.sort((a, b) => a.seq - b.seq);
  return fresh;
}
async function applySyncMeta(data) {
  S.users = data.users;
  S.me = data.me;
  S.usage = data.usage;
  S.chats = data.chats;
  await prepareChats();
}

async function sync(initial) {
  if (syncPromise) {
    // Несколько источников (таймер, отправка, focus/visibility) могут попросить
    // синхронизацию одновременно. Не запускаем второй запрос с тем же since,
    // а дочитываем ещё раз сразу после текущего прохода.
    syncQueued = true;
    return syncPromise;
  }
  syncPromise = (async () => {
    let first = true;
    try {
      do {
        syncQueued = false;
        await syncOnce(first && !!initial);
        first = false;
      } while (syncQueued && S.token);
    } finally {
      syncPromise = null;
    }
  })();
  return syncPromise;
}

async function syncOnce(initial) {
  let data = await api('/api/sync?since=' + S.seq + (document.hidden ? '' : '&active=1'));
  await applySyncMeta(data);

  let suppressNotify = false;
  const freshAll = [];
  if (!initial && data.gen !== S.gen) {
    // История могла измениться не только добавлением (удаление/архивация):
    // перечитываем её целиком, чтобы локально исчезли удалённые сообщения.
    resetMessageStore();
    suppressNotify = true;
    data = await api('/api/sync?since=0' + (document.hidden ? '' : '&active=1'));
    await applySyncMeta(data);
  }

  let fresh = addMessages(data.messages);
  if (fresh.length) {
    await decryptAll(fresh);
    freshAll.push(...fresh);
  }
  S.seq = data.seq;
  S.gen = data.gen;

  // историю сервер отдаёт порциями — дочитываем остаток
  let guard = 0;
  while (data.more && guard++ < 50) {
    data = await api('/api/sync?since=' + S.seq + (document.hidden ? '' : '&active=1'));
    await applySyncMeta(data);
    fresh = addMessages(data.messages);
    if (fresh.length) {
      await decryptAll(fresh);
      freshAll.push(...fresh);
    }
    S.seq = data.seq; S.gen = data.gen;
  }

  if (freshAll.length && !initial && !suppressNotify) notifyNewMessages(freshAll);
  if (S.view && !chatById(S.view)) { S.view = null; S.threadId = null; }
  renderAll();
  if (!document.hidden) markRead();
  if ($('#search').value.trim()) runSearch();
}

async function decryptAll(list) {
  for (const m of list) {
    if (S.plain.has(m.id)) continue;
    const k = await chatKeyOf(chatById(m.chat));
    if (!k) { S.plain.set(m.id, { text: '🔒 нет ключа для расшифровки', broken: true }); continue; }
    try { S.plain.set(m.id, await decryptJSON(k.key, m.blob)); }
    catch (e) { S.plain.set(m.id, { text: '🔒 не удалось расшифровать', broken: true }); }
  }
}

// ─────────────────────────────────────────── уведомления
let notifyAudio = null;
let notifySoundPrimed = false;
function primeNotifySound() {
  if (notifySoundPrimed || S.notify.sound === false) return;
  unlockNotifySound().then(ok => { notifySoundPrimed = !!ok; }).catch(() => {});
}
async function unlockNotifySound() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return false;
  if (!notifyAudio) notifyAudio = new AC();
  if (notifyAudio.state === 'suspended') await notifyAudio.resume();
  return notifyAudio.state === 'running';
}
function playNotifySound() {
  if (S.notify.sound === false) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  try {
    if (!notifyAudio) notifyAudio = new AC();
    const ctx = notifyAudio;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const now = ctx.currentTime;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.18, now + 0.018);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);
    gain.connect(ctx.destination);
    for (const [i, hz] of [880, 1175].entries()) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(hz, now + i * 0.07);
      osc.connect(gain);
      osc.start(now + i * 0.07);
      osc.stop(now + 0.20 + i * 0.07);
    }
    setTimeout(() => gain.disconnect(), 420);
  } catch (e) {}
}
async function requestDesktopNotifications() {
  if (!('Notification' in window) || !window.isSecureContext) return;
  try {
    if (Notification.permission === 'default') {
      S.notify.desktop = (await Notification.requestPermission()) === 'granted';
      saveNotifySettings();
    } else {
      S.notify.desktop = Notification.permission === 'granted';
      saveNotifySettings();
    }
  } catch (e) {}
}
function showDesktopNotification(m) {
  if (!S.notify.desktop || !('Notification' in window) || Notification.permission !== 'granted') return;
  const c = chatById(m.chat), p = S.plain.get(m.id) || {};
  const author = userById(m.uid) || { name: p.author || 'Сообщение' };
  const body = p.text ? `${author.name}: ${cut(p.text, 120)}` : `${author.name}: 📷 изображение`;
  try {
    const n = new Notification(chatTitle(c) || 'SEGA-CHAT', {
      body, tag: 'sega-chat-' + m.chat, icon: (BASE || '') + '/favicon.png', silent: true
    });
    n.onclick = () => { window.focus(); openChat(m.chat); n.close(); };
    setTimeout(() => n.close(), 8000);
  } catch (e) {}
}
function notifyNewMessages(list) {
  if (!S.me) return;
  const inactive = document.hidden || (document.hasFocus && !document.hasFocus());
  if (!inactive) return;
  const incoming = list.filter(m => m.uid !== S.me.id && !isChatMuted(m.chat));
  if (!incoming.length || S.notify.sound === false) return;
  playNotifySound();
  showDesktopNotification(incoming[incoming.length - 1]);
}

// ─────────────────────────────────────────── непрочитанное
function unreadIn(chatId) {
  const reads = myReads();
  let total = 0, mentions = 0;
  for (const m of S.messages) {
    if (m.chat !== chatId || m.uid === S.me.id) continue;
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
  if (!S.me || !S.view) return;
  const reads = myReads();
  const buckets = new Map();
  for (const m of S.messages) {
    if (m.chat !== S.view) continue;
    if (m.parent && m.parent !== S.threadId) continue; // ветку помечаем, только когда она открыта
    const b = bucketOf(m);
    if (m.seq > (reads[b] || 0) && m.seq > (buckets.get(b) || 0)) buckets.set(b, m.seq);
  }
  for (const [bucket, seq] of buckets) {
    reads[bucket] = seq;
    try { await api('/api/read', { method: 'POST', body: { bucket, seq } }); } catch (e) {}
  }
  if (buckets.size) renderAll();
}

// ─────────────────────────────────────────── аватары
const avatarCache = new Map(), avatarPending = new Set();
function initials(name) {
  const p = String(name || '?').trim().split(/\s+/);
  return ((p[0] || '?')[0] + (p[1] ? p[1][0] : '')).toUpperCase();
}
function avColor(id) {
  const palette = ['#2353a2', '#2fa8a0', '#c1682b', '#7a55b5', '#3f8f3f', '#b1425e', '#4a6fa5', '#9a7a1f'];
  let h = 0; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) % 9973;
  return palette[h % palette.length];
}
function avatarHtml(user, cls, withStatus) {
  const u = user || {};
  let inner;
  if (u.avatar) {
    const hit = avatarCache.get(u.id);
    if (hit && hit.rev === u.avatar) inner = `<img class="avatar ${cls || ''}" src="${hit.src}" alt="">`;
    else { decodeAvatar(u); inner = `<span class="avatar ${cls || ''}" style="background:${avColor(u.id)}">${escapeHtml(initials(u.name))}</span>`; }
  } else {
    inner = `<span class="avatar ${cls || ''}" style="background:${avColor(u.id)}">${escapeHtml(initials(u.name))}</span>`;
  }
  return `<span class="av-wrap">${inner}${withStatus ? `<i class="status ${isOnline(u) ? 'on' : ''}"></i>` : ''}</span>`;
}
function chatAvatarHtml(c, cls) {
  if (!c) return `<span class="av-wrap"><span class="avatar ${cls || ''}" style="background:#2353a2"><img class="av-logo" src="logo.png" alt=""></span></span>`;
  if (c.kind === 'dm') return avatarHtml(userById(dmPeer(c)), cls, true);
  const title = chatTitle(c);
  return `<span class="av-wrap"><span class="avatar group ${cls || ''}" style="background:${avColor(c.id)}">${escapeHtml(initials(title))}</span></span>`;
}
async function decodeAvatar(user) {
  // user.avatar — это короткий отпечаток; сама картинка лежит отдельно,
  // чтобы не гонять её при каждом опросе сервера
  const tag = user.id + ':' + user.avatar;
  if (avatarPending.has(tag) || !user.avatar) return;
  avatarPending.add(tag);
  try {
    const r = await api('/api/avatar/' + encodeURIComponent(user.id));
    if (r && r.avatar) {
      avatarCache.set(user.id, { rev: user.avatar, src: (await decryptJSON(S.roomKey, r.avatar)).data });
      S.sig = ''; renderAll();
    }
  } catch (e) {}
  avatarPending.delete(tag);
}

// ─────────────────────────────────────────── отрисовка
function renderAll() {
  if (!S.me) return;
  const sig = JSON.stringify([
    S.seq, S.messages.length, S.view, S.threadId, S.quote, S.highlight, S.usage.bytes, S.railFilter,
    S.chats.map(c => [c.id, c.members.length, chatTitle(c), c.lastTs, c.archivedByName, c.archivedAt]),
    S.users.map(u => [u.id, u.name, u.isAdmin, !!u.avatar, isOnline(u), u.reads])
  ]);
  if (sig === S.sig) return;
  S.sig = sig;
  renderMe(); renderRail(); renderTopbar(); renderMessages(); renderThread(); renderMemory(); renderQuoteBar(); updateTitle();
}

function renderMe() {
  $('#me-avatar').innerHTML = avatarHtml(S.me, '', true);
  $('#me-name').textContent = S.me.name;
  $('#me-sub').textContent = S.me.isAdmin ? 'администратор · в сети' : 'в сети';
  $('#btn-admin').classList.toggle('hidden', !S.me.isAdmin);
  renderNotifyControls();
}

const lastMessageIn = chatId => {
  let best = null;
  for (const m of S.messages) if (m.chat === chatId && (!best || m.seq > best.seq)) best = m;
  return best;
};
function preview(m) {
  if (!m) return '';
  const p = S.plain.get(m.id) || {};
  const who = m.uid === S.me.id ? 'Вы: ' : ((userById(m.uid) || {}).name || '') + ': ';
  const body = p.text ? p.text : (p.att ? '📷 изображение' : '');
  return who + (m.parent ? '↳ ' : '') + body;
}

function renderRail() {
  const flt = S.railFilter.toLowerCase();
  const chats = S.chats
    .filter(c => !flt || chatTitle(c).toLowerCase().includes(flt))
    .sort((a, b) => {
      const la = lastMessageIn(a.id), lb = lastMessageIn(b.id);
      return (lb ? lb.ts : b.createdAt) - (la ? la.ts : a.createdAt);
    });

  let html = '';
  if (chats.length) {
    html += `<div class="rail-group">Чаты</div>`;
    for (const c of chats) {
      const un = unreadIn(c.id);
      const last = lastMessageIn(c.id);
      const peer = c.kind === 'dm' ? userById(dmPeer(c)) : null;
      const sub = last ? preview(last)
        : (c.kind === 'dm' ? (isOnline(peer) ? 'в сети' : fmtAgo(peer && peer.lastSeen))
          : plural(c.members.length, 'участник', 'участника', 'участников'));
      html += `<div class="chat-item ${S.view === c.id ? 'active' : ''} ${un.total ? 'unread' : ''}" data-chat="${c.id}">
        ${chatAvatarHtml(c)}
        <div class="ci-main">
          <div class="ci-name">${escapeHtml(chatTitle(c))}${isChatMuted(c.id) ? '<span class="mute-mark" title="Без звука">🔇</span>' : ''}${c.kind === 'group' ? `<span class="tag-grp">${c.members.length}</span>` : ''}</div>
          <div class="ci-last">${escapeHtml(cut(sub, 42))}</div>
        </div>
        ${un.mentions ? `<span class="badge at" title="обращения к вам">@${un.mentions}</span>` : ''}
        ${un.total ? `<span class="badge">${un.total}</span>` : ''}
      </div>`;
    }
  }

  const known = new Set(S.chats.filter(c => c.kind === 'dm').map(c => dmPeer(c)));
  const others = S.users.filter(u => u.id !== S.me.id && !known.has(u.id) && (!flt || u.name.toLowerCase().includes(flt)))
    .sort((a, b) => (isOnline(b) - isOnline(a)) || a.name.localeCompare(b.name, 'ru'));
  if (others.length) {
    html += `<div class="rail-group">Написать лично</div>`;
    for (const u of others) {
      html += `<div class="chat-item" data-peer="${u.id}">
        ${avatarHtml(u, '', true)}
        <div class="ci-main">
          <div class="ci-name">${escapeHtml(u.name)}${u.isAdmin ? '<span class="tag-admin">адм</span>' : ''}</div>
          <div class="ci-last">${isOnline(u) ? 'в сети' : escapeHtml(fmtAgo(u.lastSeen))}</div>
        </div>
      </div>`;
    }
  }
  if (!html) html = `<div class="ci-last" style="padding:14px 10px">Никого нет — пригласите друзей по кодовой фразе.</div>`;
  $('#chat-list').innerHTML = html;
}

function renderTopbar() {
  const c = curChat();
  const hasChat = !!c;
  $('#btn-members').classList.toggle('hidden', !hasChat);
  $('#btn-chat-menu').classList.toggle('hidden', !hasChat);
  if (!hasChat) {
    $('#chat-avatar').innerHTML = chatAvatarHtml(null);
    $('#chat-title').textContent = 'SEGA-CHAT';
    $('#chat-sub').textContent = 'выберите чат слева или создайте новый';
    $('#input').placeholder = 'Написать сообщение…';
    return;
  }
  $('#chat-avatar').innerHTML = chatAvatarHtml(c);
  $('#chat-title').textContent = chatTitle(c);
  if (c.kind === 'dm') {
    const u = userById(dmPeer(c));
    $('#chat-sub').innerHTML = isOnline(u)
      ? '<span style="color:#5c9c1e">в сети, смотрит чат</span> · личная переписка'
      : 'был(а) ' + escapeHtml(fmtAgo(u && u.lastSeen)) + ' · личная переписка';
    $('#input').placeholder = 'Личное сообщение для ' + chatTitle(c) + '…';
  } else {
    const online = c.members.map(userById).filter(isOnline).length;
    $('#chat-sub').innerHTML = `${plural(c.members.length, 'участник', 'участника', 'участников')} · <span style="color:#5c9c1e">${online} в сети</span>`;
    $('#input').placeholder = 'Написать в «' + chatTitle(c) + '»…  (@ — обратиться к участнику)';
  }
}

function mentionize(text) {
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
  const chat = chatById(m.chat);
  const members = chat ? chat.members : [];
  return S.users.filter(u => u.id !== m.uid && members.includes(u.id) && ((u.reads || {})[bucket] || 0) >= m.seq);
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
function quoteCardHtml(id) {
  const q = S.messages.find(x => x.id === id);
  if (!q) return `<div class="quote-card gone">сообщение удалено</div>`;
  const p = S.plain.get(q.id) || {};
  const author = userById(q.uid) || { name: p.author || 'Бывший участник' };
  const body = p.text ? cut(p.text, 90) : (p.att ? '📷 изображение' : '');
  return `<div class="quote-card" data-goto="${q.id}" title="Перейти к сообщению">
    <b>${escapeHtml(author.name)}</b>
    <span class="qc-time">${fmtDay(q.ts)}, ${fmtTime(q.ts)}</span>
    <div class="qc-text">${escapeHtml(body)}</div>
  </div>`;
}

function canGroup(prev, m) {
  if (!prev || !m) return false;
  return prev.uid === m.uid
    && prev.chat === m.chat
    && (prev.parent || null) === (m.parent || null)
    && new Date(prev.ts).toDateString() === new Date(m.ts).toDateString()
    && Math.abs(m.ts - prev.ts) <= GROUP_GAP_MS;
}

function messageHtml(m, opts = {}) {
  const p = S.plain.get(m.id) || { text: '…' };
  const author = userById(m.uid) || { id: m.uid, name: p.author || 'Бывший участник' };
  const mine = m.uid === S.me.id;
  const mentioned = p.mentions && p.mentions.includes(S.me.id) && !mine;
  const kids = opts.noThread ? [] : S.messages.filter(x => x.parent === m.id);
  const unreadKids = kids.length ? threadUnread(m.id) : 0;
  const chat = chatById(m.chat);
  const canDel = mine || isOwner(chat);
  const continued = !!opts.continued;
  const continues = !!opts.continues;
  const metaParts = [];
  if (!continues) metaParts.push(readersHtml(m));
  if (kids.length) metaParts.push(`<span class="thread-btn" data-thread="${m.id}">💬 ${plural(kids.length, 'комментарий', 'комментария', 'комментариев')}${unreadKids ? `<span class="dot-new"></span>` : ''}</span>`);
  const meta = metaParts.filter(Boolean).join('');
  return `<div class="msg ${mine ? 'mine' : ''} ${mentioned ? 'mentioned' : ''} ${continued ? 'grouped' : ''} ${continues ? 'continues' : ''} ${S.highlight === m.id ? 'hl' : ''}" id="m-${m.id}">
    ${avatarHtml(author, 'sm', true)}
    <div class="bubble-wrap">
      ${continued ? '' : `<div class="head"><span class="who">${escapeHtml(author.name)}</span><span class="time">${fmtTime(m.ts)}</span></div>`}
      <div class="bubble">
        ${m.quote ? quoteCardHtml(m.quote) : ''}
        ${p.text ? `<div class="btext">${mentionize(p.text)}</div>` : ''}
        ${p.att ? `<img class="att" src="${p.att}" alt="вложение">` : ''}
      </div>
      ${meta ? `<div class="meta">${meta}</div>` : ''}
    </div>
    <div class="tools">
      <button class="tool" data-quote="${m.id}" title="Ответить ссылкой на это сообщение">↩</button>
      ${opts.noThread ? '' : `<button class="tool" data-thread="${m.id}" title="Комментировать внутри сообщения">💬</button>`}
      ${canDel ? `<button class="tool" data-del="${m.id}" title="Удалить">${ICON_TRASH}</button>` : ''}
    </div>
  </div>`;
}

function archiveBannerHtml(c) {
  if (!c || !c.archivedByName) return '';
  const dateStr = c.archivedAt ? `${fmtDay(c.archivedAt)}, ${fmtTime(c.archivedAt)}` : '';
  const countStr = (c.archivedCount !== null && c.archivedCount !== undefined)
    ? ` · удалено ${plural(c.archivedCount, 'сообщение', 'сообщения', 'сообщений')}`
    : '';
  const sub = (dateStr || countStr) ? `<div class="archive-banner-sub tiny muted">${dateStr}${countStr}</div>` : '';
  return `<div class="archive-banner">
    <div class="archive-banner-title">Пользователь <b>${escapeHtml(c.archivedByName)}</b> заархивировал(а) этот чат. История удалена из облака.</div>
    ${sub}
  </div>`;
}

function renderMessages(force) {
  const box = $('#messages');
  if (!S.view) {
    box.innerHTML = `<div class="empty">
      <img class="empty-logo" src="logo.png" alt="SEGA">
      <h3>Добро пожаловать в SEGA-CHAT</h3>
      <p class="muted">Здесь пока нет открытого чата. Создайте групповой чат или напишите кому-нибудь лично —<br>список участников в колонке слева.</p>
      <div class="empty-actions">
        <button class="primary" id="empty-new">＋ Создать групповой чат</button>
      </div></div>`;
    const b = $('#empty-new');
    if (b) b.addEventListener('click', openCreateChat);
    return;
  }
  const list = S.messages.filter(m => m.chat === S.view && !m.parent);
  const prevTop = box.scrollTop, prevHeight = box.scrollHeight;
  const nearBottom = prevHeight - prevTop - box.clientHeight < 160;
  const c = curChat();
  const banner = archiveBannerHtml(c);
  if (!list.length) {
    const emptyHint = `<div class="sys">${c && c.kind === 'dm'
      ? 'Личная переписка. Никто, кроме вас двоих, её не увидит.'
      : 'Сообщений пока нет. Напишите первое 👋'}</div>`;
    box.innerHTML = banner ? (banner + emptyHint) : emptyHint;
    return;
  }
  let html = banner, lastDay = '';
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    const day = new Date(m.ts).toDateString();
    if (day !== lastDay) { html += `<div class="day"><span>${fmtDay(m.ts)}</span></div>`; lastDay = day; }
    html += messageHtml(m, { continued: canGroup(list[i - 1], m), continues: canGroup(m, list[i + 1]) });
  }
  box.innerHTML = html;
  if (force || nearBottom || S.atBottom) box.scrollTop = box.scrollHeight;
  else box.scrollTop = prevTop + (box.scrollHeight - prevHeight);
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
      ${p.text ? `<div class="txt">${mentionize(p.text)}</div>` : ''}
      ${p.att ? `<img src="${p.att}" alt="">` : ''}
    </div>` + kids.map((k, i) => messageHtml(k, { noThread: true, continued: canGroup(kids[i - 1], k), continues: canGroup(k, kids[i + 1]) })).join('');
  if (atBottom) box.scrollTop = box.scrollHeight;
  else box.scrollTop = prevTop + (box.scrollHeight - prevHeight);
}

function renderMemory() {
  const u = S.usage, pct = Math.min(100, u.percent);
  $('#mem-pct').textContent = pct + '%';
  const fill = $('#mem-fill');
  fill.style.width = Math.max(pct, u.bytes > 0 ? 1.5 : 0) + '%';
  fill.classList.toggle('hot', pct >= 80);
  const c = curChat();
  $('#mem-text').textContent = `${fmtBytes(u.bytes)} из ${fmtBytes(u.limit)} · ${u.messages} сообщ.`
    + (c ? ` · этот чат ${fmtBytes(c.bytes)}` : '');
  $('#mem-warn').classList.toggle('hidden', pct < 80);
}

function renderQuoteBar() {
  const bar = $('#quote-bar');
  if (!S.quote) return hide(bar);
  const q = S.messages.find(m => m.id === S.quote);
  if (!q) { S.quote = null; return hide(bar); }
  const p = S.plain.get(q.id) || {};
  const author = userById(q.uid) || { name: p.author || 'Бывший участник' };
  $('#quote-who').textContent = 'Ответ ' + author.name + ': ';
  $('#quote-preview').textContent = cut(p.text || (p.att ? '📷 изображение' : ''), 70);
  show(bar);
}

function updateTitle() {
  let total = 0;
  for (const c of S.chats) total += unreadIn(c.id).total;
  document.title = (total ? `(${total}) ` : '') + 'SEGA-CHAT';
  $('#rail-badge').classList.toggle('hidden', !total);
}

// ─────────────────────────────────────────── навигация
$('#chat-list').addEventListener('click', async e => {
  const item = e.target.closest('[data-chat],[data-peer]');
  if (!item) return;
  $('#rail').classList.remove('open');
  if (item.dataset.chat) return openChat(item.dataset.chat);
  try {
    const r = await api('/api/dm', { method: 'POST', body: { peer: item.dataset.peer } });
    await sync();
    openChat(r.chat.id);
  } catch (ex) { toast(ex.message, true); }
});
function openChat(id) {
  if (S.view) S.drafts[S.view] = $('#input').value;
  S.view = id;
  S.threadId = null; S.quote = null;
  S.atBottom = true; S.sig = '';
  $('#input').value = S.drafts[id] || '';
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

// переход к сообщению, на которое ссылаются
let hlTimer = null;
function goToMessage(id) {
  const m = S.messages.find(x => x.id === id);
  if (!m) return toast('Это сообщение удалено', true);
  if (m.chat !== S.view) openChat(m.chat);
  if (m.parent) openThread(m.parent);
  else if (S.threadId) S.threadId = null;
  S.highlight = id; S.sig = '';
  renderAll();
  clearTimeout(hlTimer);
  hlTimer = setTimeout(() => { S.highlight = null; S.sig = ''; renderAll(); }, 3500);
  setTimeout(() => {
    const target = document.getElementById('m-' + m.id);
    if (target && target.scrollIntoView) target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, 80);
}

function handleMsgClick(e) {
  const goto = e.target.closest('[data-goto]');
  if (goto) return goToMessage(goto.dataset.goto);
  const q = e.target.closest('[data-quote]');
  if (q) {
    S.quote = q.dataset.quote; S.sig = '';
    renderQuoteBar();
    $(S.threadId && e.target.closest('#thread-body') ? '#thread-input' : '#input').focus();
    return;
  }
  const th = e.target.closest('[data-thread]');
  if (th) return openThread(th.dataset.thread);
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
$('#quote-cancel').addEventListener('click', () => { S.quote = null; renderQuoteBar(); });
$('#messages').addEventListener('scroll', () => {
  const box = $('#messages');
  S.atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
  $('#scroll-bottom').classList.toggle('hidden', S.atBottom);
});
$('#scroll-bottom').addEventListener('click', () => { const b = $('#messages'); b.scrollTop = b.scrollHeight; });

// ─────────────────────────────────────────── создание группового чата
function openCreateChat() {
  $('#rail').classList.remove('open');
  const others = S.users.filter(u => u.id !== S.me.id);
  modal('Новый групповой чат', `
    <label>Название чата<input type="text" id="nc-title" maxlength="60" placeholder="например: Партия в бридж"></label>
    <div class="divider"><span>Кого позвать</span></div>
    ${others.length ? others.map(u => `<label class="mrow pick">
        <input type="checkbox" value="${u.id}" class="nc-user">
        ${avatarHtml(u, '', true)}<span class="nm">${escapeHtml(u.name)}</span>
      </label>`).join('') : '<div class="tiny muted">Пока в мессенджере только вы. Пригласите друзей по кодовой фразе — и создайте чат.</div>'}
    <p class="hint">Название и переписка шифруются ключом этого чата. Ключ получат только выбранные участники; позже можно добавить ещё.</p>
    <div class="err" id="nc-err"></div>
    <button class="primary" id="nc-create">Создать чат</button>`);
  $('#nc-create').addEventListener('click', async () => {
    const err = $('#nc-err'); err.textContent = '';
    const title = $('#nc-title').value.trim();
    if (title.length < 2) return err.textContent = 'Придумайте название чата';
    if (!S.priv) return err.textContent = 'Нет ключа шифрования: выйдите и войдите снова';
    const members = $$('.nc-user').filter(i => i.checked).map(i => i.value);
    const btn = $('#nc-create'); btn.disabled = true; btn.textContent = 'Создаём ключи…';
    try {
      const raw = rnd(32);
      const key = await importAes(raw);
      const keys = {};
      for (const id of [S.me.id, ...members]) {
        const pk = await pairKeyWith(id);
        if (!pk) throw new Error('У участника нет ключа шифрования — попросите его войти в чат заново');
        keys[id] = { blob: await aesEncryptBytes(pk, raw) };
      }
      const r = await api('/api/chats', {
        method: 'POST',
        body: { titleBlob: await encryptJSON(key, { title }), members, keys }
      });
      S.chatKeys.set(r.chat.id, { key, raw });
      S.chatTitles.set(r.chat.id, title);
      hide($('#modal'));
      await sync();
      openChat(r.chat.id);
      toast('Чат «' + title + '» создан');
    } catch (ex) { err.textContent = ex.message; btn.disabled = false; btn.textContent = 'Создать чат'; }
  });
}
$('#btn-new-chat').addEventListener('click', openCreateChat);

// ─────────────────────────────────────────── участники чата
$('#btn-members').addEventListener('click', () => {
  const c = curChat();
  if (!c) return;
  const members = c.members.map(userById).filter(Boolean);
  const canAdd = c.kind === 'group';
  const rows = members.map(u => `<div class="mrow">${avatarHtml(u, '', true)}
      <span class="nm">${escapeHtml(u.name)}${u.id === S.me.id ? ' <span class="muted">(вы)</span>' : ''}${c.ownerId === u.id ? '<span class="tag-admin">создатель</span>' : ''}
        <div class="tiny muted">${isOnline(u) ? 'в сети, смотрит чат' : 'был(а) ' + escapeHtml(fmtAgo(u.lastSeen))}</div></span>
      ${u.id !== S.me.id && c.kind === 'group' ? `<button class="mini" data-open-dm="${u.id}">лично</button>` : ''}
      ${isOwner(c) && u.id !== S.me.id ? `<button class="mini danger" data-kick="${u.id}">убрать</button>` : ''}
    </div>`).join('');
  const rest = S.users.filter(u => !c.members.includes(u.id));
  modal('Участники · ' + chatTitle(c), rows + (canAdd ? `
    <div class="divider"><span>Добавить в чат</span></div>
    ${rest.length ? rest.map(u => `<div class="mrow">${avatarHtml(u, '', true)}
        <span class="nm">${escapeHtml(u.name)}</span>
        <button class="mini" data-add="${u.id}">добавить</button></div>`).join('')
      : '<div class="tiny muted">Все участники мессенджера уже здесь</div>'}
    <p class="hint">Новый участник получит ключ чата и сможет прочитать всю его историю.</p>` : ''));

  $('#modal-body').addEventListener('click', async e => {
    const dm = e.target.closest('[data-open-dm]');
    if (dm) {
      hide($('#modal'));
      const r = await api('/api/dm', { method: 'POST', body: { peer: dm.dataset.openDm } });
      await sync(); openChat(r.chat.id);
      return;
    }
    const add = e.target.closest('[data-add]');
    if (add) {
      try {
        const k = await chatKeyOf(c);
        if (!k || !k.raw) throw new Error('Нет ключа этого чата');
        const pk = await pairKeyWith(add.dataset.add);
        if (!pk) throw new Error('У участника нет ключа шифрования — попросите его войти заново');
        await api('/api/chats/' + c.id + '/members', { method: 'POST', body: { add: [{ id: add.dataset.add, blob: await aesEncryptBytes(pk, k.raw) }] } });
        hide($('#modal')); await sync(); toast('Участник добавлен');
      } catch (ex) { toast(ex.message, true); }
      return;
    }
    const kick = e.target.closest('[data-kick]');
    if (kick) {
      if (!confirm('Убрать участника из чата? Он перестанет видеть новые сообщения.')) return;
      try {
        await api('/api/chats/' + c.id + '/members', { method: 'POST', body: { remove: [kick.dataset.kick] } });
        hide($('#modal')); await sync(); toast('Участник убран из чата');
      } catch (ex) { toast(ex.message, true); }
    }
  });
});

// ─────────────────────────────────────────── меню чата (⋯)
$('#btn-chat-menu').addEventListener('click', async () => {
  const c = curChat();
  if (!c) return;
  let archives = [];
  try { archives = (await api('/api/chats/' + c.id + '/archives')).archives; } catch (e) {}
  const owner = isOwner(c);

  let managementHtml = '';
  if (c.kind === 'group') {
    managementHtml = `
      <div class="divider"><span>Управление чатом</span></div>
      ${owner ? `<label>Название чата<input type="text" id="cm-title" value="${escapeHtml(chatTitle(c))}" maxlength="60"></label>
        <button class="primary soft" id="cm-rename">Переименовать</button>
        <button class="primary soft" id="cm-archive" style="margin-top:8px">Заархивировать на сервере и очистить чат</button>` : ''}
      <button class="primary soft danger" id="cm-leave" style="margin-top:8px">Покинуть чат</button>
    `;
  } else if (c.kind === 'dm') {
    managementHtml = `
      <div class="divider"><span>Управление перепиской</span></div>
      <button class="primary soft" id="cm-archive">Заархивировать на сервере и очистить чат</button>
    `;
  }

  modal('Чат «' + chatTitle(c) + '»', `
    <div class="tiny muted">${plural(c.count, 'сообщение', 'сообщения', 'сообщений')} · ${fmtBytes(c.bytes)}</div>
    <label class="row-check menu-switch"><input type="checkbox" id="cm-mute" ${isChatMuted(c.id) ? 'checked' : ''}> <span>Без звука для этого чата</span></label>
    <div class="divider"><span>Сохранить себе архив</span></div>
    <p class="hint">Копия скачивается на ваше устройство в расшифрованном виде. Это может сделать любой участник чата.</p>
    <button class="primary" id="cm-html">Читаемая копия (HTML)</button>
    <button class="primary soft" id="cm-json">Читаемая копия (JSON)</button>
    ${managementHtml}
    ${archives.length ? `<div class="divider"><span>Архивы на сервере</span></div>` + archives.map(a => `
      <div class="archive-row"><span style="flex:1">${new Date(a.createdAt).toLocaleString('ru-RU')} · ${a.count} сообщ. · ${fmtBytes(a.bytes)}</span>
      <button class="mini" data-arch="${a.file}">скачать</button></div>`).join('') : ''}`);

  $('#cm-html').addEventListener('click', () => { exportHtml(c); hide($('#modal')); });
  $('#cm-json').addEventListener('click', () => { exportJson(c); hide($('#modal')); });
  $('#cm-mute').addEventListener('change', e => {
    setChatMuted(c.id, e.target.checked);
    S.sig = ''; renderAll();
    toast(e.target.checked ? 'Этот чат теперь без звука' : 'Звук для этого чата включён');
  });
  const ren = $('#cm-rename');
  if (ren) ren.addEventListener('click', async () => {
    const title = $('#cm-title').value.trim();
    if (title.length < 2) return toast('Слишком короткое название', true);
    try {
      const k = await chatKeyOf(c);
      await api('/api/chats/' + c.id + '/title', { method: 'POST', body: { titleBlob: await encryptJSON(k.key, { title }) } });
      S.chatTitles.set(c.id, title); S.sig = '';
      hide($('#modal')); await sync(); toast('Чат переименован');
    } catch (ex) { toast(ex.message, true); }
  });
  const arch = $('#cm-archive');
  if (arch) arch.addEventListener('click', async () => {
    const confirmMsg = c.kind === 'dm'
      ? 'Сохранить архив переписки на сервере и очистить историю в облаке? Сначала лучше скачать читаемую копию.'
      : 'Сохранить архив чата на сервере и очистить переписку? Сначала лучше скачать читаемую копию.';
    if (!confirm(confirmMsg)) return;
    try {
      const r = await api('/api/chats/' + c.id + '/archive', { method: 'POST', body: { reset: true } });
      try { await downloadArchive(r.archive.file); }
      catch (e) { toast('Архив на сервере сохранён, но скачать не удалось: ' + e.message, true); }
      hide($('#modal')); S.sig = ''; await sync(); renderMessages(true); toast('Архив создан, чат очищен');
    } catch (ex) { toast(ex.message, true); }
  });
  const leave = $('#cm-leave');
  if (leave) leave.addEventListener('click', async () => {
    const confirmLeave = (owner && c.members.length > 1)
      ? 'Покинуть чат? Вы перестанете видеть его сообщения, а права создателя перейдут другому участнику.'
      : 'Покинуть чат? Вы перестанете видеть его сообщения.';
    if (!confirm(confirmLeave)) return;
    try {
      await api('/api/chats/' + c.id + '/leave', { method: 'POST', body: {} });
      hide($('#modal')); S.view = null; S.sig = ''; await sync(); renderMessages(true); toast('Вы покинули чат');
    } catch (ex) { toast(ex.message, true); }
  });
  $('#modal-body').addEventListener('click', e => {
    const b = e.target.closest('[data-arch]');
    if (b) downloadArchive(b.dataset.arch).catch(ex => toast(ex.message, true));
  });
});

// ─────────────────────────────────────────── отправка сообщений
function autoGrow(el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 150) + 'px'; }
function chatMembers() {
  const c = curChat();
  return c ? c.members.map(userById).filter(Boolean) : [];
}
function findMentions(text) {
  const ids = [];
  for (const u of chatMembers().sort((a, b) => b.name.length - a.name.length)) {
    const safe = u.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp('@' + safe + '(?![\\wА-Яа-яЁё])').test(text)) ids.push(u.id);
  }
  return ids;
}
async function send({ textarea, parent, attachKey }) {
  const text = textarea.value.trim();
  const att = S[attachKey];
  if (!text && !att) return;
  const c = curChat();
  if (!c) return toast('Сначала выберите чат', true);
  const k = await chatKeyOf(c);
  if (!k) return toast('Не удалось получить ключ шифрования для этого чата', true);
  const quote = parent ? null : S.quote;
  const payload = { v: 1, text, author: S.me.name, mentions: findMentions(text) };
  if (att) payload.att = att;
  textarea.value = ''; autoGrow(textarea);
  clearAttach(attachKey);
  if (!parent) { S.quote = null; renderQuoteBar(); }
  try {
    const blob = await encryptJSON(k.key, payload);
    const r = await api('/api/messages', { method: 'POST', body: { blob, chat: c.id, parent: parent || null, quote } });
    S.usage = r.usage; S.atBottom = true; S.sig = '';
    await sync();
    if (!parent) renderMessages(true);
  } catch (ex) {
    toast(ex.message, true);
    textarea.value = text; S[attachKey] = att;
    if (att) showAttach(attachKey, att);
    if (quote) { S.quote = quote; renderQuoteBar(); }
  }
}
$('#btn-send').addEventListener('click', () => send({ textarea: $('#input'), attachKey: 'attach' }));
$('#thread-send').addEventListener('click', () => send({ textarea: $('#thread-input'), parent: S.threadId, attachKey: 'threadAttach' }));

function composerKeydown(e, sendFn) {
  if (mentionKeydown(e)) return;
  if (e.key === 'Escape' && S.quote) { S.quote = null; renderQuoteBar(); return; }
  if (e.key === 'Enter' && !e.shiftKey && window.matchMedia('(min-width: 901px)').matches) { e.preventDefault(); sendFn(); }
}
$('#input').addEventListener('keydown', e => composerKeydown(e, () => send({ textarea: $('#input'), attachKey: 'attach' })));
$('#thread-input').addEventListener('keydown', e => composerKeydown(e, () => send({ textarea: $('#thread-input'), parent: S.threadId, attachKey: 'threadAttach' })));
$('#input').addEventListener('input', e => { autoGrow(e.target); mentionInput(e.target, $('#mention-pop')); });
$('#thread-input').addEventListener('input', e => { autoGrow(e.target); mentionInput(e.target, $('#thread-mention-pop')); });

// ─────────────────────────────────────────── эмодзи и звук уведомлений
function insertAtCursor(textarea, text) {
  const start = textarea.selectionStart || 0, end = textarea.selectionEnd || start;
  textarea.value = textarea.value.slice(0, start) + text + textarea.value.slice(end);
  const pos = start + text.length;
  textarea.focus();
  textarea.setSelectionRange(pos, pos);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}
function placeEmojiPanel(btn) {
  const pop = $('#emoji-pop');
  pop.innerHTML = EMOJIS.map(e => `<button type="button" data-emoji="${e}" title="${e}">${e}</button>`).join('');
  const r = btn.getBoundingClientRect();
  show(pop);
  const w = pop.offsetWidth || 280, h = pop.offsetHeight || 220;
  pop.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left)) + 'px';
  pop.style.top = Math.max(8, r.top - h - 8) + 'px';
}
let emojiTarget = null, emojiButton = null;
function toggleEmoji(btn, textarea) {
  const pop = $('#emoji-pop');
  if (!pop.classList.contains('hidden') && emojiButton === btn) return closeEmoji();
  emojiTarget = textarea;
  emojiButton = btn;
  placeEmojiPanel(btn);
}
function closeEmoji() { hide($('#emoji-pop')); emojiTarget = null; emojiButton = null; }
$('#btn-emoji').addEventListener('click', e => { e.stopPropagation(); toggleEmoji(e.currentTarget, $('#input')); });
$('#thread-emoji').addEventListener('click', e => { e.stopPropagation(); toggleEmoji(e.currentTarget, $('#thread-input')); });
$('#emoji-pop').addEventListener('mousedown', e => {
  const b = e.target.closest('[data-emoji]');
  if (!b || !emojiTarget) return;
  e.preventDefault();
  insertAtCursor(emojiTarget, b.dataset.emoji);
});
document.addEventListener('mousedown', e => {
  if (!e.target.closest('#emoji-pop,.emoji-btn')) closeEmoji();
});
window.addEventListener('resize', closeEmoji);

$('#notify-sound').addEventListener('change', async e => {
  S.notify.sound = e.target.checked;
  if (!S.notify.sound) notifySoundPrimed = false;
  saveNotifySettings();
  renderNotifyControls();
  if (S.notify.sound) {
    primeNotifySound();
    requestDesktopNotifications();
    toast('Звук уведомлений включён');
  } else {
    toast('Звук уведомлений выключен');
  }
});
renderNotifyControls();

// ─────────────────────────────────────────── обращения через @
let mention = { pop: null, target: null, items: [], sel: 0, start: -1 };
function mentionInput(textarea, pop) {
  const pos = textarea.selectionStart;
  const before = textarea.value.slice(0, pos);
  const m = before.match(/(^|\s)@([\wА-Яа-яЁё-]{0,24})$/);
  if (!m) return closeMention();
  const q = m[2].toLowerCase();
  const list = chatMembers().filter(u => u.id !== S.me.id && u.name.toLowerCase().includes(q)).slice(0, 8);
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
  try {
    toast('Готовим фото…');
    const data = await resizeImage(file, 1800, 0.82);
    S[key] = data; showAttach(key, data);
    toast('Фото готово к отправке');
  }
  catch (ex) { toast(ex && ex.message ? ex.message : 'Не удалось обработать картинку', true); }
}
$('#file-input').addEventListener('change', e => pickImage(e, 'attach'));
$('#thread-file').addEventListener('change', e => pickImage(e, 'threadAttach'));
$('#attach-remove').addEventListener('click', () => clearAttach('attach'));
$('#thread-attach-remove').addEventListener('click', () => clearAttach('threadAttach'));

function isHeic(file) {
  return /image\/(heic|heif)/i.test(file.type || '') || /\.(heic|heif)$/i.test(file.name || '');
}
function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error || new Error('Не удалось прочитать файл'));
    fr.readAsDataURL(blob);
  });
}
function loadImageFromUrl(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Браузер не смог открыть изображение'));
    img.src = url;
  });
}
async function decodeImageFile(file) {
  if (!file || (!String(file.type || '').startsWith('image/') && !isHeic(file))) {
    throw new Error('Выберите файл изображения');
  }
  let bitmapError = null;
  if (window.createImageBitmap) {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      if (bmp && bmp.width && bmp.height) {
        return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close && bmp.close() };
      }
    } catch (e) { bitmapError = e; }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImageFromUrl(url);
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    if (!width || !height) throw new Error('Не удалось определить размер изображения');
    return { source: img, width, height, close: () => URL.revokeObjectURL(url) };
  } catch (e) {
    URL.revokeObjectURL(url);
    if (isHeic(file)) {
      throw new Error('Не удалось открыть HEIC/HEIF. На iPhone включите «Настройки → Камера → Форматы → Наиболее совместимый» или отправьте JPEG/PNG.');
    }
    throw new Error(bitmapError ? 'Браузер не смог декодировать это фото. Попробуйте сохранить его как JPEG/PNG.' : e.message);
  }
}
function targetImageSize(w, h, max) {
  const k = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}
function drawImageToCanvas(source, w, h, crop) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('Браузер не дал доступ к canvas для сжатия фото');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if (crop) ctx.drawImage(source, crop.x, crop.y, crop.size, crop.size, 0, 0, w, h);
  else ctx.drawImage(source, 0, 0, w, h);
  return c;
}
function downscaleCanvas(src, w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('Браузер не смог уменьшить фото');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  return c;
}
async function canvasToDataURL(canvas, type, quality) {
  if (canvas.toBlob) {
    const blob = await new Promise(resolve => canvas.toBlob(resolve, type, quality));
    if (blob) return blobToDataURL(blob);
  }
  try { return canvas.toDataURL(type, quality); }
  catch (e) { throw new Error('Не удалось сжать фото в браузере'); }
}
function estimatedEncryptedUploadChars(dataUrl) {
  // encryptJSON добавит служебные поля JSON, IV/тег AES-GCM и ещё раз base64.
  const plain = String(dataUrl || '').length + 5500;
  return Math.ceil((plain + 32) / 3) * 4;
}
async function encodeImageUnderLimit(canvas, quality) {
  const limit = Number(S.maxUpload || DEFAULT_MAX_UPLOAD);
  const plainLimit = Math.floor(limit * UPLOAD_PLAIN_HEADROOM);
  let q = quality, cur = canvas;
  for (let attempt = 0; attempt < 10; attempt++) {
    const data = await canvasToDataURL(cur, 'image/jpeg', q);
    if (data.length <= plainLimit && estimatedEncryptedUploadChars(data) <= limit) return data;
    if (q > 0.58) { q = Math.max(0.58, q - 0.10); continue; }
    const w = Math.max(1, Math.round(cur.width * 0.82));
    const h = Math.max(1, Math.round(cur.height * 0.82));
    if ((w >= cur.width && h >= cur.height) || Math.max(w, h) < 360) break;
    cur = downscaleCanvas(cur, w, h);
    q = 0.76;
  }
  throw new Error('Фото слишком большое даже после сжатия. Попробуйте кадрировать его или выбрать снимок поменьше.');
}
async function resizeImage(file, max, quality) {
  const decoded = await decodeImageFile(file);
  try {
    const size = targetImageSize(decoded.width, decoded.height, max);
    const canvas = drawImageToCanvas(decoded.source, size.w, size.h);
    return await encodeImageUnderLimit(canvas, quality);
  } catch (e) {
    throw new Error(e && e.message ? e.message : 'Не удалось обработать картинку');
  } finally {
    try { decoded.close(); } catch (e) {}
  }
}
async function cropSquare(file, size) {
  const decoded = await decodeImageFile(file);
  try {
    const s = Math.min(decoded.width, decoded.height);
    const canvas = drawImageToCanvas(decoded.source, size, size, {
      x: Math.max(0, (decoded.width - s) / 2),
      y: Math.max(0, (decoded.height - s) / 2),
      size: s
    });
    return await canvasToDataURL(canvas, 'image/jpeg', 0.85);
  } finally {
    try { decoded.close(); } catch (e) {}
  }
}


// ─────────────────────────────────────────── поиск по всем чатам
let searchTimer = null;
$('#search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 160); });
$('#btn-search-clear').addEventListener('click', () => { $('#search').value = ''; runSearch(); });

function chLabel(m) {
  const c = chatById(m.chat);
  if (!c) return 'Чат';
  const base = c.kind === 'dm' ? 'Лично: ' + chatTitle(c) : chatTitle(c);
  return base + (m.parent ? ' · комментарий' : '');
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
  if (el) goToMessage(el.dataset.go);
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
      const saved = await api('/api/profile', { method: 'POST', body: { avatar: await encryptJSON(S.roomKey, { data }) } });
      avatarCache.set(S.me.id, { rev: saved.user.avatar, src: data });
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

// управление мессенджером (админ)
$('#btn-admin').addEventListener('click', async () => {
  $('#rail').classList.remove('open');
  modal('Управление мессенджером', `
    <div class="divider"><span>Участники</span></div>
    <div id="ad-users"></div>
    <div class="divider"><span>Кодовая фраза</span></div>
    <p class="hint">Смена фразы закрывает вход новым людям по старой. Уже зарегистрированные продолжают пользоваться чатами.</p>
    <label>Новая кодовая фраза<input type="text" id="ad-code" placeholder="минимум 6 символов" autocomplete="off"></label>
    <div class="err" id="ad-code-err"></div>
    <button class="primary" id="ad-code-save">Обновить фразу</button>
    <div class="divider"><span>Память</span></div>
    <p class="hint">Занято ${fmtBytes(S.usage.bytes)} из ${fmtBytes(S.usage.limit)} (${S.usage.percent}%). Архивами управляет создатель каждого чата (меню «⋯» в чате).</p>`);
  renderAdminUsers();

  $('#ad-users').addEventListener('click', async e => {
    const b = e.target.closest('button[data-id]'); if (!b) return;
    try {
      if (b.dataset.act === 'del') {
        if (!confirm('Исключить участника из мессенджера? Он потеряет доступ ко всем чатам.')) return;
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
  const res = await fetch(BASE + '/api/archives/' + encodeURIComponent(file), { headers: { Authorization: 'Bearer ' + S.token } });
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
  const c = curChat();
  modal('Архивы', `
    <p class="hint">Читаемая копия открывается в любом браузере без пароля: в ней ваши чаты, комментарии и ссылки между сообщениями. Зашифрованная выгрузка безопасна, но открывается только этим приложением.</p>
    ${c ? `<button class="primary" id="ex-chat-html">Этот чат («${escapeHtml(cut(chatTitle(c), 24))}») — HTML</button>` : ''}
    <button class="primary ${c ? 'soft' : ''}" id="ex-html" style="margin-top:8px">Все мои чаты — HTML</button>
    <button class="primary soft" id="ex-json" style="margin-top:8px">Все мои чаты — JSON</button>
    <button class="primary soft" id="ex-enc" style="margin-top:8px">Зашифрованная выгрузка с сервера</button>
    <div class="tiny muted" style="margin-top:12px">Всего доступно сообщений: ${S.messages.length}, объём сервера ${fmtBytes(S.usage.bytes)}.</div>`);
  const one = $('#ex-chat-html');
  if (one) one.addEventListener('click', () => { exportHtml(c); hide($('#modal')); });
  $('#ex-html').addEventListener('click', () => { exportHtml(null); hide($('#modal')); });
  $('#ex-json').addEventListener('click', () => { exportJson(null); hide($('#modal')); });
  $('#ex-enc').addEventListener('click', async () => {
    try {
      const res = await fetch(BASE + '/api/export', { headers: { Authorization: 'Bearer ' + S.token } });
      saveBlob(await res.blob(), 'sega-chat-encrypted-' + new Date().toISOString().slice(0, 10) + '.json');
    } catch (ex) { toast('Не удалось выгрузить', true); }
  });
});
function plainList(chat) {
  return S.messages.filter(m => !chat || m.chat === chat.id).map(m => {
    const p = S.plain.get(m.id) || {};
    const u = userById(m.uid);
    return {
      time: new Date(m.ts).toLocaleString('ru-RU'), ts: m.ts,
      chat: chLabel(m), id: m.id, parent: m.parent || null, quote: m.quote || null,
      author: (u && u.name) || p.author || 'Бывший участник',
      text: p.text || '', image: p.att || null
    };
  });
}
function exportJson(chat) {
  const name = 'sega-chat-' + (chat ? cut(chatTitle(chat), 20).replace(/[^\wА-Яа-яЁё-]+/g, '_') + '-' : '') + new Date().toISOString().slice(0, 10) + '.json';
  saveBlob(new Blob([JSON.stringify({ chat: chat ? chatTitle(chat) : 'Все мои чаты', exportedAt: new Date().toISOString(), messages: plainList(chat) }, null, 2)],
    { type: 'application/json' }), name);
}
function exportHtml(chat) {
  const list = plainList(chat);
  const rows = list.map(m => {
    const q = m.quote ? list.find(x => x.id === m.quote) : null;
    return `<div class="m${m.parent ? ' c' : ''}" id="m-${m.id}"><div class="h"><b>${escapeHtml(m.author)}</b>
    <span>${escapeHtml(m.time)}</span><i>${escapeHtml(m.chat)}</i></div>
    ${q ? `<a class="q" href="#m-${q.id}"><b>${escapeHtml(q.author)}</b>: ${escapeHtml(cut(q.text, 80))}</a>` : ''}
    ${m.text ? `<div class="t">${linkify(escapeHtml(m.text))}</div>` : ''}${m.image ? `<img src="${m.image}">` : ''}</div>`;
  }).join('\n');
  const title = chat ? chatTitle(chat) : 'Все мои чаты';
  const html = `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SEGA-CHAT — ${escapeHtml(title)}</title><style>
body{background:#eef2f4;color:#1f2b33;font-family:Helvetica,Arial,sans-serif;margin:0;padding:24px}
.wrap{max-width:860px;margin:0 auto}h1{color:#1f2b33;margin:2px 0 0}
.brand{font-weight:800;letter-spacing:.2em;color:#2353a2;font-size:12px}
#q{width:100%;padding:10px 12px;border-radius:8px;border:1px solid #d7dfe5;margin:12px 0 18px}
.m{background:#fff;border-radius:10px;padding:10px 13px;margin-bottom:8px;box-shadow:0 1px 2px rgba(20,50,70,.09)}
.m.c{margin-left:36px;border-left:3px solid #2fc6f6}
.m:target{box-shadow:0 0 0 3px #ffd98a}
.h b{color:#2353a2}.h span{color:#8b98a4;font-size:12px;margin-left:8px}.h i{color:#8b98a4;font-size:11px;margin-left:8px}
.q{display:block;border-left:3px solid #2fc6f6;background:#f2f8fd;border-radius:6px;padding:5px 9px;margin:5px 0;
   font-size:12.5px;color:#41525e;text-decoration:none}
.t{white-space:pre-wrap;margin-top:4px}img{max-width:min(420px,90%);border-radius:8px;margin-top:8px;display:block}
a{color:#2353a2}.muted{color:#8b98a4}</style></head><body><div class="wrap">
<div class="brand">SEGA-CHAT</div><h1>${escapeHtml(title)}</h1><div class="muted">Архив · ${new Date().toLocaleString('ru-RU')} · ${list.length} сообщений</div>
<input id="q" placeholder="Поиск по архиву…" oninput="(function(v){document.querySelectorAll('.m').forEach(function(e){e.style.display=e.innerText.toLowerCase().includes(v.toLowerCase())?'':'none'})})(this.value)">
${rows}</div></body></html>`;
  const name = 'sega-chat-' + (chat ? cut(chatTitle(chat), 20).replace(/[^\wА-Яа-яЁё-]+/g, '_') + '-' : '') + new Date().toISOString().slice(0, 10) + '.html';
  saveBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), name);
}

$('#btn-logout').addEventListener('click', () => { if (confirm('Выйти из мессенджера на этом устройстве?')) doLogout(); });

// ─────────────────────────────────────────── оформление: тёмная тема и компактная лента
function applyTheme(theme) {
  const dark = theme === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : '';
  try { localStorage.setItem('sega.theme', dark ? 'dark' : 'light'); } catch (e) {}
  const btn = $('#btn-theme');
  if (btn) { btn.textContent = dark ? '☀️ Светлая' : '🌙 Тёмная'; btn.setAttribute('aria-pressed', String(dark)); }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#0b171d' : '#2353A2');
}
function applyDensity(mode) {
  const compact = mode === 'compact';
  if (compact) document.documentElement.dataset.density = 'compact';
  else delete document.documentElement.dataset.density;
  try {
    if (compact) localStorage.setItem('sega.density', 'compact');
    else localStorage.removeItem('sega.density');
  } catch (e) {}
  const btn = $('#btn-compact');
  if (btn) { btn.textContent = compact ? '▤ Просторно' : '☰ Компактно'; btn.setAttribute('aria-pressed', String(compact)); }
}
(function initAppearance() {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  applyDensity(document.documentElement.dataset.density === 'compact' ? 'compact' : 'cozy');
  $('#btn-theme').addEventListener('click', () =>
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
  $('#btn-compact').addEventListener('click', () =>
    applyDensity(document.documentElement.dataset.density === 'compact' ? 'cozy' : 'compact'));
})();

boot();
