/* SEGA-CHAT — клиент (оформление в духе Bitrix24).
   Любой участник создаёт свои групповые чаты и пишет личные сообщения.
   Всё шифруется в браузере: у каждого чата свой ключ AES-256-GCM,
   который передаётся участникам «завёрнутым» в ключ пары (ECDH P-256). */
'use strict';

// ─────────────────────────────────────────── помощники
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
// метка выпуска: видна в настройках и в журнале, чтобы всегда знать, что стоит в облаке
const BUILD = 'pkg3-19';
const show = el => el.classList.remove('hidden');
const hide = el => el.classList.add('hidden');
const enc = new TextEncoder();
const dec = new TextDecoder();
const ITER = 150000;
const ONLINE_MS = 65000;
const HEAL_PAUSE = 4000;   // пауза автодолечивания ленты, если расшифровать пока нечем
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
// ─────────────────────────────────────────── минималистичные SVG-иконки
// Один набор тонких штриховых значков для всех кнопок и меню.
const SV = p => `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const ICONS = {
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M19 12a7 7 0 0 0-.14-1.4l2-1.55-2-3.46-2.36.95a7 7 0 0 0-2.42-1.4L13.7 2.6h-3.4l-.38 2.54a7 7 0 0 0-2.42 1.4l-2.36-.95-2 3.46 2 1.55A7 7 0 0 0 5 12a7 7 0 0 0 .14 1.4l-2 1.55 2 3.46 2.36-.95a7 7 0 0 0 2.42 1.4l.38 2.54h3.4l.38-2.54a7 7 0 0 0 2.42-1.4l2.36.95 2-3.46-2-1.55A7 7 0 0 0 19 12Z"/>',
  bell: '<path d="M18 9a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6"/><path d="M10.3 19a2 2 0 0 0 3.4 0"/>',
  volume: '<path d="M11 5 6.5 9H3v6h3.5L11 19V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.4 5.6a9 9 0 0 1 0 12.8"/>',
  moon: '<path d="M20 13.5A8 8 0 0 1 10.5 4 8 8 0 1 0 20 13.5Z"/>',
  rows: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  palette: '<circle cx="12" cy="12" r="9"/><circle cx="9" cy="9.5" r="1.1" fill="currentColor" stroke="none"/><circle cx="14.5" cy="8.5" r="1.1" fill="currentColor" stroke="none"/><circle cx="16" cy="13" r="1.1" fill="currentColor" stroke="none"/><path d="M12 21a3 3 0 0 0 0-6h-1.5a2 2 0 0 1 0-4"/>',
  user: '<circle cx="12" cy="8" r="3.6"/><path d="M5 20c.8-3.6 3.6-5.4 7-5.4s6.2 1.8 7 5.4"/>',
  users: '<circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19c.7-3.1 3-4.7 5.5-4.7s4.8 1.6 5.5 4.7"/><path d="M15.5 5.7a3.2 3.2 0 0 1 0 5.6"/><path d="M17.5 14.6c1.6.7 2.7 2.1 3 4.4"/>',
  box: '<path d="M3.5 8 12 3.5 20.5 8v8L12 20.5 3.5 16V8Z"/><path d="M3.5 8 12 12.5 20.5 8"/><path d="M12 12.5v8"/>',
  folder: '<path d="M3.5 7a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7Z"/>',
  download: '<path d="M12 4v10"/><path d="m8 10.5 4 4 4-4"/><path d="M4.5 19h15"/>',
  restore: '<path d="M12 14V4"/><path d="m8 7.5 4-4 4 4"/><path d="M4.5 19h15"/>',
  trash: '<path d="M4.5 6.5h15"/><path d="M9 6.5V5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5v1.5"/><path d="M6.5 6.5 7.5 20h9l1-13.5"/><path d="M10 10.5v6M14 10.5v6"/>',
  pencil: '<path d="m14.5 5.5 4 4L8 20H4v-4L14.5 5.5Z"/><path d="m12.5 7.5 4 4"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  send: '<path d="M20 4 4 11l6 2.5L12.5 20 20 4Z"/><path d="M10 13.5 20 4"/>',
  smile: '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 14.2s1.2 1.8 3.5 1.8 3.5-1.8 3.5-1.8"/><circle cx="9.3" cy="10" r=".9" fill="currentColor" stroke="none"/><circle cx="14.7" cy="10" r=".9" fill="currentColor" stroke="none"/>',
  clip: '<path d="M20 11.5 12.6 19a4.7 4.7 0 0 1-6.6-6.6l7.8-7.8a3.1 3.1 0 0 1 4.4 4.4l-7.8 7.8a1.55 1.55 0 0 1-2.2-2.2l7.2-7.2"/>',
  dots: '<circle cx="12" cy="5.5" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="18.5" r="1.4" fill="currentColor" stroke="none"/>',
  menu: '<path d="M4 7h16M4 12h10M4 17h16"/>',
  x: '<path d="m6 6 12 12M18 6 6 18"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5"/><circle cx="12" cy="7.8" r=".9" fill="currentColor" stroke="none"/>',
  image: '<rect x="3.5" y="5" width="17" height="14" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="m5 17 5-4.5 3.5 3 3-2.5 4 4"/>',
  door: '<path d="M13 4h5.5v16H13"/><path d="M10 8l-4 4 4 4"/><path d="M6 12h9"/>',
  lock: '<rect x="5.5" y="10.5" width="13" height="9" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
  react: '<path d="M12 20.5s-7.5-4.6-7.5-10A4.4 4.4 0 0 1 12 7.6a4.4 4.4 0 0 1 7.5 2.9c0 5.4-7.5 10-7.5 10Z"/>',
  file: '<path d="M6 3.5h8l4 4V20.5H6V3.5Z"/><path d="M14 3.5v4h4"/>',
  play: '<circle cx="12" cy="12" r="8.5"/><path d="m10 8.5 6 3.5-6 3.5v-7Z"/>',
  reply: '<path d="M9.5 7.5 4.5 12l5 4.5"/><path d="M4.5 12H14a5.5 5.5 0 0 1 5.5 5.5V19"/>',
  comment: '<path d="M20.5 11.6c0 4.1-3.8 7.4-8.5 7.4-1 0-2-.15-2.9-.42L4.5 20.4l1.4-3.5c-1.2-1.3-1.9-3-1.9-4.9C4 7.9 7.8 4.5 12.5 4.5s8 3.2 8 7.1Z"/>',
  down: '<path d="M12 5v14"/><path d="m6.5 13.5 5.5 5.5 5.5-5.5"/>'
};
/** Расставляет SVG-иконки по элементам с data-ic; уже готовые не трогает. */
function paintIcons(root) {
  (root || document).querySelectorAll('[data-ic]').forEach(el => {
    const name = el.getAttribute('data-ic');
    if (el.dataset.icDone === name || !ICONS[name]) return;
    el.innerHTML = SV(ICONS[name]);
    el.dataset.icDone = name;
  });
}
// гаммы оформления: личная настройка устройства (id, название, пара цветов рендера)
const PALS = [
  { id: 'classic', name: 'Классика', c1: '#2353a2', c2: '#2fc6f6' },
  { id: 'sea', name: 'Морская', c1: '#0f766e', c2: '#2dd4bf' },
  { id: 'lavender', name: 'Лаванда', c1: '#6d5bd0', c2: '#a78bfa' },
  { id: 'olive', name: 'Олива', c1: '#5f7a2e', c2: '#a3c14a' },
  { id: 'sunset', name: 'Закат', c1: '#c05038', c2: '#f59e6b' },
  { id: 'honey', name: 'Мёд', c1: '#a9761f', c2: '#e8b54a' },
  { id: 'rose', name: 'Роза', c1: '#b04a68', c2: '#e58aa4' },
  { id: 'mint', name: 'Мята', c1: '#2f9e77', c2: '#7fd6b5' },
  { id: 'graphite', name: 'Графит', c1: '#4b5563', c2: '#9aa5b1' }
];
const palById = id => PALS.find(p => p.id === id) || PALS[0];
// ─────────────────────────────────────────── современные эмодзи (Twemoji, CC-BY)
// Картинки подтягиваются с CDN; если сети нет — onerror возвращает системный символ.
const TW_URL = 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/';
const EMO_RE = /(\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier}|\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*)/gu;
// ─────────────────────────────────────────── локальный кэш медиа (IndexedDB)
// Раз загруженное видео/фото/файл живёт в памяти устройства: открываться будет
// мгновенно, без повторной загрузки из облака. Управляется в меню «⋯» → «Медиа на устройстве».
const idb = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((res, rej) => {
      const r = indexedDB.open('sega-media', 1);
      r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('media')) r.result.createObjectStore('media'); };
      r.onsuccess = () => { this.db = r.result; res(this.db); };
      r.onerror = () => rej(r.error || new Error('IndexedDB недоступна'));
    });
  },
  async get(id) { try { const d = await this.open(); return await new Promise(res => { const t = d.transaction('media').objectStore('media').get(id); t.onsuccess = () => res(t.result || null); t.onerror = () => res(null); }); } catch (e) { return null; } },
  async put(id, v) { try { const d = await this.open(); await new Promise((res, rej) => { const t = d.transaction('media', 'readwrite'); t.objectStore('media').put(v, id); t.oncomplete = res; t.onerror = () => rej(t.error); }); } catch (e) {} },
  async del(id) { try { const d = await this.open(); await new Promise(res => { const t = d.transaction('media', 'readwrite'); t.objectStore('media').delete(id); t.oncomplete = res; t.onerror = res; }); } catch (e) {} },
  async all() { try { const d = await this.open(); return await new Promise(res => { const t = d.transaction('media').objectStore('media').openCursor(); const out = []; t.onsuccess = () => { const c = t.result; if (c) { out.push([c.key, c.value]); c.continue(); } else res(out); }; t.onerror = () => res(out); }); } catch (e) { return []; } }
};
const mediaUrls = new Map();
function mediaUrl(id, blob) {
  let u = mediaUrls.get(id);
  if (!u) { u = URL.createObjectURL(blob); mediaUrls.set(id, u); }
  return u;
}
function mediaPlayerHtml(rec, id) {
  const url = mediaUrl(id, rec.blob);
  if (rec.kind === 'video' || (rec.mime || '').startsWith('video/')) return `<video class="att att-vid" controls preload="metadata" src="${url}"></video>`;
  if (rec.kind === 'audio' || (rec.mime || '').startsWith('audio/')) return `<audio controls src="${url}" style="max-width:min(360px,70vw);margin-top:5px"></audio>`;
  if ((rec.mime || '').startsWith('image/')) return `<img class="att" src="${url}" alt="вложение">`;
  return `<a class="att-file" href="${url}" download="${escapeHtml(rec.name || 'file')}">${SV(ICONS.download)}<span>${escapeHtml(rec.name || 'файл')}</span><span class="tiny muted">${fmtBytes(rec.size || rec.blob.size || 0)} · из памяти устройства</span></a>`;
}
function twEmo(html) {
  return String(html).replace(EMO_RE, seq => {
    const cp = [...seq].map(c => c.codePointAt(0).toString(16)).join('-');
    return `<img class="emo" src="${TW_URL}${cp}.png" alt="${seq}" loading="lazy" onerror="this.replaceWith(document.createTextNode(this.alt))">`;
  });
}
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
  keyIssue: new Map(),   // chatId -> { code, who } — почему нечем расшифровать
  healBusy: false, healPauseUntil: 0,   // защита от бесконечного «долечивания» без ключа
  chatTitles: new Map(), // chatId -> строка
  view: null, threadId: null, quote: null, highlight: null, drafts: {}, openMark: null,
  seq: 0, rsince: 0, chg: 0,   // курсоры: сообщения / журнал мелких изменений
  usage: { bytes: 0, limit: 1, percent: 0, messages: 0 }, maxUpload: DEFAULT_MAX_UPLOAD,
  attach: null, threadAttach: null, remember: true, timer: null, atBottom: true,
  notify: { sound: true, muted: {}, desktop: false },
  retry: {},        // черновики своих сообщений, ещё не принятых сервером
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
    saltAuth: S.saltAuth, saltWrap: S.saltWrap, uid: (S.me && S.me.id) || S.uid || null
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

// ─────────────────────────────────────────── шкала первой загрузки
// Перекрывает экран поверх всего, пока история едет и расшифровывается:
// человек видит стадию и честные проценты вместо «чёрного окна» и пустого чата.
const loadUi = {
  el: null,
  node() {
    if (this.el) return this.el;
    const d = document.createElement('div');
    d.id = 'load-ui';
    d.innerHTML = `<div class="lu-box">
      <div class="brand"><h1 class="lockup"><img class="logo" src="logo.png" alt="SEGA"><span>CHAT</span></h1></div>
      <div class="lu-stage" id="lu-stage">Соединяемся с облаком…</div>
      <div class="lu-bar"><i id="lu-fill"></i></div>
      <div class="lu-pct" id="lu-pct"></div>
    </div>`;
    document.body.appendChild(d);
    this.el = d;
    return d;
  },
  show(stage, pct, note) {
    const d = this.node();
    d.classList.remove('hidden');
    if (stage) $('#lu-stage').textContent = stage;
    const fill = $('#lu-fill'), p = $('#lu-pct');
    if (pct == null) { fill.style.width = '10%'; p.textContent = note || ''; }
    else {
      fill.style.width = Math.max(4, Math.min(100, pct)) + '%';
      p.textContent = Math.round(pct) + '%' + (note ? ' · ' + note : '');
    }
  },
  hide() { if (this.el) this.el.classList.add('hidden'); }
};

const screen = name => {
  ['loading', 'setup', 'auth', 'app']
    .forEach(n => document.getElementById('screen-' + n).classList.toggle('hidden', n !== name));
  // гаммы действуют только внутри мессенджера: экраны входа остаются фирменно-синими
  const inApp = name === 'app';
  if (inApp !== (document.documentElement.dataset.inApp === '1')) {
    if (inApp) document.documentElement.dataset.inApp = '1';
    else delete document.documentElement.dataset.inApp;
    applyPalette(currentPal(), false);
  }
};

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
  loadUi.show('Соединяемся с облаком…', null);
  try { st = await api('/api/state'); } catch (e) { loadUi.hide(); toast('Сервер недоступен: ' + e.message, true); return; }
  S.maxUpload = Number(st.maxUpload || DEFAULT_MAX_UPLOAD);
  S.codeProofSalt = st.codeProofSalt || null;   // для проверки кодового слова архивов
  S.serverBuild = st.build || 'без метки (старше pkg2-3)';
  if (st.setupRequired) { loadUi.hide(); return screen('setup'); }

  if (window.createLocalCache) {
    try {
      S.idb = window.indexedDB ? createLocalCache(idbBackend(), { log: m => console.info('[кэш] ' + m) }) : null;
    } catch (e) { S.idb = null; S.idbBootError = String((e && e.message) || e); }
  } else S.idb = null;
  const sess = loadSessionRaw();
  if (sess && sess.token) {
    S.uid = sess.uid || null;
    S.token = sess.token; S.saltAuth = sess.saltAuth; S.saltWrap = sess.saltWrap;
    S.roomKeyRaw = fromB64(sess.key);
    S.roomKey = await importAes(S.roomKeyRaw);
    if (sess.priv) { S.privRaw = fromB64(sess.priv); S.priv = await importPriv(S.privRaw); }
    try { await startApp(); return; } catch (e) { clearSession(); S.token = null; }
  }
  loadUi.hide();
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
    keyIssue: new Map(), healBusy: false, healPauseUntil: 0,
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
  if (S.chatKeys.has(chat.id)) { S.keyIssue.delete(chat.id); return S.chatKeys.get(chat.id); }
  let entry = null, issue = null;
  if (chat.kind === 'dm') {
    const peer = userById(dmPeer(chat));
    if (!S.priv) issue = { code: 'no-priv' };
    else if (!peer || !peer.pub) issue = { code: 'no-peer-pub', who: peer ? peer.name : null };
    else {
      const key = await pairKeyWith(peer.id);
      entry = key ? { key, raw: null } : null;
      if (!entry) issue = { code: 'pair-fail', who: peer.name };
    }
  } else if (chat.legacyRoomKey) {
    if (S.roomKey) entry = { key: S.roomKey, raw: S.roomKeyRaw };
    else issue = { code: 'no-room-key' };
  } else if (chat.key && chat.key.blob) {
    const wrap = await pairKeyWith(chat.key.by);
    if (!wrap) {
      issue = !S.priv ? { code: 'no-priv' } : { code: 'no-wrapper-pub', who: (userById(chat.key.by) || {}).name };
    } else {
      try {
        const raw = await aesDecryptBytes(wrap, chat.key.blob);
        entry = { key: await importAes(raw), raw };
      } catch (e) { entry = null; issue = { code: 'unwrap-fail' }; }
    }
  } else {
    issue = { code: 'no-group-key' };
  }
  if (entry) { S.chatKeys.set(chat.id, entry); S.keyIssue.delete(chat.id); }
  else if (issue) S.keyIssue.set(chat.id, issue);
  return entry;
}
/** Человекочитаемая причина, почему чат не расшифровать на этом устройстве. */
function keyIssueText(c) {
  const it = S.keyIssue.get(c.id);
  if (!it) return null;
  const who = it.who || 'собеседник';
  return {
    'no-priv': 'На этом устройстве нет вашего личного ключа шифрования (например, вход был по старому сохранению без пароля). Без него сообщения остаются закрытыми.',
    'no-room-key': 'На этом устройстве нет общего ключа мессенджера (старое сохранение входа). Нужен повторный вход с паролем.',
    'no-peer-pub': 'У участника ' + who + ' на его устройстве нет ключа шифрования: его сообщения нечем открыть, а ваши он не видит. Ему нужно один раз войти заново (Выйти → Вход с паролем) — после этого всё расшифруется само.',
    'no-wrapper-pub': 'Ключ этого чата упакован для вас участником ' + (it.who || 'создатель чата') + ', но у него нет ключа шифрования. Ему нужно войти заново (Выйти → Вход с паролем).',
    'pair-fail': 'Не удалось построить ключ переписки с ' + who + '. Попробуйте Выйти → Вход с паролем.',
    'unwrap-fail': 'Ключ этого чата не открывается вашим личным ключом. Поможет повторный вход с паролем (Выйти → Вход).',
    'no-group-key': 'Для вас пока нет ключа этого чата. Он доставится автоматически, как только кто-то из участников с ключом откроет чат.'
  }[it.code] || ('Нет ключа шифрования для этого чата (' + it.code + ').');
}
function keyBannerHtml(c) {
  if (!c) return '';
  const txt = keyIssueText(c);
  if (!txt) return '';
  const it = S.keyIssue.get(c.id);
  const btn = (it.code === 'no-priv' || it.code === 'no-room-key' || it.code === 'unwrap-fail' || it.code === 'pair-fail')
    ? '<button class="mini primary" data-restore-keys="1">Ввести пароль и открыть ключи</button>' : '';
  return '<div class="key-banner"><div class="kb-title">🔒 Сообщения не расшифрованы</div>'
    + '<div class="kb-text">' + escapeHtml(txt) + '</div>'
    + (btn ? '<div class="kb-act">' + btn + '</div>' : '')
    + '<div class="kb-code tiny muted">диагностика: ' + escapeHtml(it.code) + ' · ' + escapeHtml(BUILD) + '</div></div>';
}
/** Восстановление личного ключа паролем без потери сеанса. */
function openRestoreKeys() {
  const name = S.me ? S.me.name : '';
  modal('Нет ключа шифрования', `
    <p class="hint">На этом устройстве не хватает вашего личного ключа, поэтому переписка закрыта.
    Введите пароль от имени «${escapeHtml(name)}» — устройство получит ключ с сервера и расшифрует всё само.</p>
    <label>Пароль<input type="password" id="rk-pass" autocomplete="current-password"></label>
    <div class="err" id="rk-err"></div>
    <div class="row" style="margin-top:12px">
      <button class="primary" id="rk-go">Открыть ключи</button>
      <button class="mini" id="rk-later">Позже</button>
    </div>`);
  const go = async () => {
    const pass = $('#rk-pass').value, err = $('#rk-err');
    err.textContent = '';
    if (!pass) return err.textContent = 'Введите пароль';
    $('#rk-go').disabled = true; $('#rk-go').textContent = 'Открываем…';
    try {
      const salts = await api('/api/salt', { method: 'POST', body: { name } });
      const authKey = toHex(await pbkdf2(pass, salts.saltAuth));
      const r = await api('/api/login', { method: 'POST', body: { name, authKey } });
      const wrapKey = await aesKeyFrom(pass, r.saltWrap);
      let roomRaw = null;
      try { roomRaw = await aesDecryptBytes(wrapKey, r.wrappedKeyByPass); } catch (e) { throw new Error('Не удалось расшифровать ключи. Проверьте пароль.'); }
      if (r.wrappedPriv) {
        const pkcs8 = await aesDecryptBytes(wrapKey, r.wrappedPriv);
        S.priv = await importPriv(pkcs8); S.privRaw = pkcs8;
      } else {
        const pair = await genPairKeys(wrapKey);
        await api('/api/profile', { method: 'POST', body: { keys: { pub: pair.pub, wrappedPriv: pair.wrappedPriv } }, headers: { Authorization: 'Bearer ' + r.token } });
        S.priv = pair.priv; S.privRaw = pair.pkcs8; S.pub = pair.pub;
      }
      S.roomKeyRaw = roomRaw; S.roomKey = await importAes(roomRaw);
      S.saltAuth = salts.saltAuth; S.saltWrap = r.saltWrap;
      saveSession();
      S.chatKeys = new Map(); S.pairKeys = new Map(); S.keyIssue = new Map();
      S.healBusy = false; S.healPauseUntil = 0;
      hide($('#modal'));
      toast('Ключи восстановлены — расшифровываю переписку');
      await prepareChats();
      decryptSmart(S.messages).catch(() => {});
      if (S.view) scheduleDecryptRest(S.view);
      S.sig = ''; renderAll(); renderMessages();
    } catch (ex) {
      err.textContent = ex.message || ('' + ex);
      $('#rk-go').disabled = false; $('#rk-go').textContent = 'Открыть ключи';
    }
  };
  $('#rk-go').addEventListener('click', go);
  $('#rk-pass').addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  $('#rk-later').addEventListener('click', () => hide($('#modal')));
}
document.addEventListener('click', e => {
  if (e.target.closest('[data-restore-keys]')) openRestoreKeys();
});
/** Авто-ремонт групп: у кого есть ключ чата — делится им с участниками без ключа. */
const repairStamp = new Map();
async function repairGroupKeys() {
  if (!S.priv) return;
  for (const c of S.chats) {
    if (c.kind !== 'group') continue;
    const entry = S.chatKeys.get(c.id);
    if (!entry || !entry.raw) continue;
    const last = repairStamp.get(c.id) || 0;
    if (Date.now() - last < 5 * 60 * 1000) continue;
    repairStamp.set(c.id, Date.now());
    try {
      const r = await api('/api/chats/' + encodeURIComponent(c.id) + '/keys/missing');
      for (const miss of (r.missing || [])) {
        if (!miss.hasPub || miss.id === S.me.id) continue;
        const pk = await pairKeyWith(miss.id);
        if (!pk) continue;
        await api('/api/chats/' + encodeURIComponent(c.id) + '/keys', { method: 'POST', body: { userId: miss.id, blob: await aesEncryptBytes(pk, entry.raw) } });
        console.info('[keys] доставил ключ чата участнику ' + miss.id);
      }
    } catch (e) { /* тихо: повторим через пять минут */ }
  }
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
  S.lastReactSeen = Date.now();   // старые реакции не будят уведомления
  screen('app');
  S.seq = 0; S.gen = -1; S.rsince = 0; S.chg = 0; S.retry = {};
  S.messages = []; S.messageIds = new Set(); S.plain = new Map(); S.sig = '';
  S.keyIssue = new Map();
  S.healBusy = false; S.healPauseUntil = 0;
  syncPromise = null; syncQueued = false;
  S.resyncHappened = false; S.warm = false;

  // ── локальная память: мгновенно показать то, что уже есть на устройстве ──
  let warm = null;
  if (S.idb && S.uid) {
    try {
      S.cacheFp = await cacheFp();
      const meta = await S.idb.peek(S.cacheFp);
      if (meta && typeof meta.seq === 'number') {
        const data = await S.idb.loadAll();
        if (data && Array.isArray(data.messages)) warm = { meta, data };
      }
    } catch (e) { warm = null; }
  }
  if (warm) {
    S.warm = true;
    S.chats = warm.data.chats || [];
    S.users = warm.data.users || [];
    addMessages(warm.data.messages || []);
    S.seq = warm.meta.seq || 0;
    S.gen = warm.meta.gen === undefined ? -1 : warm.meta.gen;
    S.chg = warm.meta.chg || 0; S.rsince = warm.meta.rsince || 0;
    S.warmAt = warm.meta.at || null; S.warmCount = (warm.data.messages || []).length;
    loadUi.show('Локальная память: открыто с устройства', 100,
      S.messages.length + ' сообщ. · проверяем новинки');
    if (!S.view && S.chats.length) S.view = [...S.chats].sort((a, b) => b.lastTs - a.lastTs)[0].id;
    S.sig = ''; renderAll(); renderMessages(true);
    decryptLocal();
    await sync(false);                 // дельта; при смене gen — полный дозагруз внутри
    S.initialLoad = false;
    if (S.resyncHappened) persistAll();
    S.sig = ''; renderAll(); renderMessages(true);
    requestAnimationFrame(() => requestAnimationFrame(() => loadUi.hide()));
  } else {
    S.initialLoad = true; S.loadRec = 0;
    loadUi.show('Загружаем историю', 0);
    await sync(true);
    S.initialLoad = false;
    loadUi.show('Расшифровываем сообщения', 100);
    if (!S.view && S.chats.length) S.view = [...S.chats].sort((a, b) => b.lastTs - a.lastTs)[0].id;
    S.sig = ''; renderAll(); renderMessages(true);
    persistAll();                      // первый визит: положить историю в локальную память
    requestAnimationFrame(() => requestAnimationFrame(() => loadUi.hide()));
  }
  // старая сессия (сохранённая до pkg3-18) не несла uid: дошиваем и пишем кэш
  if (S.me && S.uid !== S.me.id) { S.uid = S.me.id; saveSession(); }
  if (S.idb && S.uid && !S.cacheFp) { S.cacheFp = await cacheFp(); persistAll(); }
  renderCacheState();
  wake('старт приложения');
  loop();
  if (!S.priv) setTimeout(() => { if (!S.priv) openRestoreKeys(); }, 600);
}
/** Строка в настройках: жива ли локальная память и почему. */
function renderCacheState() {
  const el = $('#cache-state');
  if (!el) return;
  if (!S.idb) { el.textContent = 'Локальная память: недоступна в этом браузере' + (S.idbBootError ? ' (' + S.idbBootError + ')' : '') + ' — история грузится с сервера.'; return; }
  if (S.idb.disabled) { el.textContent = 'Локальная память: отключена (' + (S.idb.disabledReason || S.idb.lastError || 'ошибка') + '). Чат работает по-прежнему.'; return; }
  if (S.warmAt) {
    el.textContent = 'Локальная память: работает. Кэш от ' + new Date(S.warmAt).toLocaleString()
      + ' (' + (S.warmCount || 0) + ' сообщ.). Повторное открытие — мгновенное.';
    return;
  }
  el.textContent = 'Локальная память: включена, кэш запишется после первой полной загрузки.';
}
// ── цикл опроса: «тихий час» ──────────────────────────────────────────
// Пока человек трогает окно (или друзья пишут) — лента опрашивается бодро,
// каждые 2,5 с. Минуту никто ни к чату не прикасается — окно ЗАСЫПАЕТ:
// запросы прекращаются вовсе, остаётся одна редкая проверка «есть кто?»
// (раз в 5 минут) на случай, если пуш-колокольчик не сработал.
// Новое сообщение будит спящее окно МГНОВЕННО: служебный воркер получает
// пуш из облака и толкает окно в бок; просыпается оно и от любого касания.
// В облаке каждое обращение к ленте — деньги, поэтому сон экономит их
// на порядок, а бодрствование остаётся таким же быстрым, как было.
let lastTouch = Date.now();
const POLL_QS = new URLSearchParams(location.search);
const AWAKE_MS = Math.max(1000, Number(POLL_QS.get('awake')) || 60000);  // сколько бодрствуем после касания
const TICK_MS = Math.max(2000, Number(POLL_QS.get('tick')) || 300000);   // проверка во сне (5 минут)
let wakeUntil = Date.now() + AWAKE_MS;
let prevMode = 'awake';
const pollStats = { fast: 0, ticks: 0, wakes: 0, sleeps: 0 };
Object.defineProperty(pollStats, 'mode', { get: pollMode, enumerable: true });
window.__segaPoll = pollStats;          // видно в демо и в консоли браузера
function pollMode() { return Date.now() < wakeUntil ? 'awake' : 'asleep'; }
function wake(why) {
  const was = pollMode();
  wakeUntil = Date.now() + AWAKE_MS;
  if (was === 'asleep') {
    pollStats.wakes++;
    console.info('[poll] подъём: ' + why);
    clearTimeout(S.timer);
    S.timer = setTimeout(() => { loopStep().finally(loop); }, 150);
  }
}
const noteTouch = () => { lastTouch = Date.now(); primeNotifySound(); wake('касание окна'); };
for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
  document.addEventListener(ev, noteTouch, { passive: true });
}
function pollDelay() { return pollMode() === 'awake' ? 2500 : TICK_MS; }
async function loopStep() {
  if (pollMode() === 'awake') pollStats.fast++; else pollStats.ticks++;
  if (S.token) { try { await sync(); } catch (e) {} }
  const now = pollMode();
  if (prevMode === 'awake' && now === 'asleep') {
    pollStats.sleeps++;
    console.info('[poll] тихий час: спим, проверка раз в ' + Math.round(TICK_MS / 1000) + ' с');
  }
  prevMode = now;
}
function loop() {
  clearTimeout(S.timer);
  S.timer = setTimeout(() => { loopStep().finally(loop); }, pollDelay());
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && S.token) { noteTouch(); sync().catch(() => {}); loop(); }
});
window.addEventListener('focus', () => { if (S.token) { noteTouch(); markRead(); } });
// служебный воркер (пуш из облака) будит спящее окно
if (navigator.serviceWorker) {
  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data && e.data.t === 'wake') wake('сигнал из облака');
  });
}

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

function loadProgress(data, fresh) {
  if (!S.initialLoad) return;
  S.loadRec = (S.loadRec || 0) + fresh.reduce((a, m) => a + ((m.blob || '').length + 40), 0);
  const total = Number(data.loadB) || 0;
  const pct = total ? Math.min(99, S.loadRec / total * 100) : null;
  loadUi.show('Загружаем историю', pct, fmtBytes(S.loadRec) + (total ? ' из ' + fmtBytes(total) : ''));
}

async function syncOnce(initial) {
  let data = await api('/api/sync?since=' + S.seq + '&rsince=' + (S.rsince || 0) + '&cchg=' + (S.chg || 0) + (document.hidden ? '' : '&active=1'));
  await applySyncMeta(data);

  let suppressNotify = false;
  const freshAll = [];
  if (!initial && (data.resync || data.gen !== S.gen)) {
    S.resyncHappened = true;
    if (S.warm) { S.initialLoad = true; S.loadRec = 0; loadUi.show('История заменена — загружаем заново', 0); }
    // История изменилась ЦЕЛИКОМ (очистка чата, архивация, выход участника) —
    // перечитываем её с нуля. Ради одной реакции или правки сообщения этот путь
    // больше не запускается: они приходят списком data.changed.
    resetMessageStore();
    suppressNotify = true;
    data = await api('/api/sync?since=0&rsince=0&cchg=' + (data.chg || 0) + (document.hidden ? '' : '&active=1'));
    await applySyncMeta(data);
  }

  let fresh = addMessages(data.messages);
  if (fresh.length) {
    await decryptSmart(fresh);
    freshAll.push(...fresh);
  }
  loadProgress(data, fresh);
  S.seq = data.seq;
  S.gen = data.gen;

  // историю сервер отдаёт порциями — дочитываем остаток
  let guard = 0;
  while (data.more && guard++ < 50) {
    data = await api('/api/sync?since=' + S.seq + '&rsince=' + (S.rsince || 0) + '&cchg=' + (S.chg || 0) + (document.hidden ? '' : '&active=1'));
    await applySyncMeta(data);
    fresh = addMessages(data.messages);
    if (fresh.length) {
      await decryptSmart(fresh);
      freshAll.push(...fresh);
    }
    loadProgress(data, fresh);
    S.seq = data.seq; S.gen = data.gen;
  }

  const touched = await applyChangeDelta(data);
  if (touched) { S.sig = ''; if (S.view) renderMessages(); renderThread(); }
  if (typeof data.rnow === 'number') S.rsince = data.rnow;
  if (typeof data.chg === 'number') S.chg = data.chg;
  if (S.idb && S.cacheFp && !S.initialLoad) {
    S.idb.applySync(S.cacheFp, {
      resync: false,
      messages: freshAll.concat(data.changed || []).map(pickMsg),
      gone: (data.gone || []).map(g => (g && g.id) || g),
      chats: data.chats || [], users: data.users || [],
      meta: { me: S.uid, seq: S.seq, gen: S.gen, chg: S.chg, rsince: S.rsince }
    });
  }
  // друзья пишут — продлеваем бодрствование (спящее окно будит и этот путь)
  if (!initial && (freshAll.length || touched)) wake('новое в ленте');

  if (freshAll.length && !initial && !suppressNotify) notifyNewMessages(freshAll);
  if (!initial) repairGroupKeys();
  if (!initial) {
    notifyReactions();
    // долечиваем заглушки видимого окна на каждом опросе, пока ключи добираются
    const pend = currentWindowIds().filter(id => !S.plain.has(id));
    if (pend.length) {
      const before = S.plain.size;
      ensureIds(pend).then(() => {
        // перерисовываем только если что-то действительно расшифровалось,
        // иначе лента «моргала» бы впустую каждый опрос
        if (S.view && S.plain.size > before) { S.healPauseUntil = 0; renderMessages(); }
      }).catch(() => {});
    }
  }
  // шкала «Память сервера» обновляется на каждом опросе — видно и чужие загрузки
  if (data.usage && typeof data.usage.bytes === 'number') S.usage = data.usage;
  if (S.view && !chatById(S.view)) { S.view = null; S.threadId = null; }
  renderAll();
  if (!document.hidden) markRead();
  if ($('#search').value.trim()) runSearch();
}

/**
 * Убрать сообщения с экрана и из памяти, не дожидаясь перечитывания истории:
 * так работают и ответ сервера, и мгновенное удаление по кнопке «удалить».
 * Комментарии к удалённому сообщению уходят вместе с ним.
 */
function removeLocal(ids) {
  const set = new Set(Array.isArray(ids) ? ids : [ids]);
  let touched = false;
  for (const m of S.messages) if (set.has(m.id) || (m.parent && set.has(m.parent))) set.add(m.id);
  for (const id of set) {
    if (S.messageIds && S.messageIds.has(id)) { S.messageIds.delete(id); touched = true; }
    if (S.plain.has(id)) { S.plain.delete(id); touched = true; }
    delete S.retry[id];
  }
  if (!touched) return false;
  S.messages = S.messages.filter(m => !set.has(m.id));
  rebuildMessageIndex();
  if (S.threadId && set.has(S.threadId)) { S.threadId = null; hide($('#thread')); }
  if (S.quote && set.has(S.quote)) { S.quote = null; renderQuoteBar(); }
  S.sig = '';
  renderMessages(); renderThread();
  return true;
}

/**
 * Применить «мелкие изменения»: обновлённые сообщения (реакции, правки) и
 * удалённые. Возвращает true, если что-то видно на экране изменилось.
 * Повторная доставка одного и того же изменения безопасна.
 */
async function applyChangeDelta(data) {
  const gone = data.gone || [], changed = data.changed || [];
  if (!gone.length && !changed.length) return false;
  let touched = false;
  const redecrypt = [];
  if (gone.length && removeLocal(gone)) touched = true;
  for (const m of changed) {
    if (!m || !m.id) continue;
    const old = S.messages.find(x => x.id === m.id);
    if (!old) { if (addMessages([m]).length) redecrypt.push(m); touched = true; continue; }
    const blobChanged = (old.blob || '') !== (m.blob || '');
    // обновляем запись на месте, не трогая порядок ленты
    for (const k of ['blob', 'bytes', 'rev', 'editedAt', 'reactions', 'reactTs', 'reactBy', 'quote', 'parent']) {
      if (m[k] !== undefined) old[k] = m[k];
    }
    if (blobChanged) { S.plain.delete(m.id); redecrypt.push(old); }
    touched = true;
  }
  if (redecrypt.length) await decryptAll(redecrypt);
  return touched;
}

/** Расшифровать конкретные сообщения, если ещё не расшифрованы. */
async function ensureIds(ids) {
  try {
  const need = [];
  for (const id of ids) {
    if (S.plain.has(id)) continue;
    const m = S.messages.find(x => x.id === id);
    if (m) need.push(m);
  }
  if (need.length) await decryptAll(need);
  } catch (e) { /* повторим при следующей перерисовке или опросе */ }
}
/** Id последнего окна открытого чата — для долечивания заглушек. */
function currentWindowIds() {
  if (!S.view) return [];
  return S.messages.filter(m => m.chat === S.view && !m.parent).slice(-(S.winSize || WIN_SIZE)).map(m => m.id);
}
/**
 * Быстрый первый экран: расшифровываем только последнее сообщение каждого чата
 * (для превью в списке) и видимое окно открытого чата. Остальное — лениво,
 * по мере раскрытия ленты, открытия комментариев, ссылок и поиска.
 */
async function decryptSmart(fresh) {
  const byChat = new Map();
  for (const m of fresh) {
    const arr = byChat.get(m.chat);
    if (arr) arr.push(m); else byChat.set(m.chat, [m]);
  }
  const need = [];
  for (const [chatId, list] of byChat) {
    list.sort((a, b) => a.seq - b.seq);
    need.push(list[list.length - 1]);
    if (chatId === S.view) need.push(...list.slice(-WIN_SIZE));
  }
  await decryptAll(need);
}
async function decryptAll(list) {
  for (const m of list) {
    if (S.plain.has(m.id)) continue;
    let k = null;
    try { k = await chatKeyOf(chatById(m.chat)); } catch (e) { k = null; }
    // ключ ещё не доехал — НЕ ставим заглушку, пропускаем: повторим на следующем опросе
    if (!k) continue;
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
  // перерисовываем сразу, не дожидаясь следующего опроса: счётчики, значок
  // вкладки и красная точка должны гаснуть в момент прочтения
  if (buckets.size) { S.sig = ''; renderAll(); }
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
  return `<span class="av-wrap" data-uid="${escapeHtml(u.id || '')}">${inner}${withStatus ? `<i class="status ${isOnline(u) ? 'on' : ''}"></i>` : ''}</span>`;
}
function chatAvatarHtml(c, cls) {
  if (!c) return `<span class="av-wrap"><span class="avatar ${cls || ''}" style="background:#2353a2"><img class="av-logo" src="logo.png" alt=""></span></span>`;
  if (c.kind === 'dm') return avatarHtml(userById(dmPeer(c)), cls, true);
  const title = chatTitle(c);
  let inner = escapeHtml(initials(title));
  if (c.iconRev) {
    const hit = iconCache.get(c.id);
    if (hit && hit.rev === c.iconRev && hit.data) inner = `<img src="${hit.data}" alt="">`;
    else if (!hit || hit.rev !== c.iconRev) fetchIcon(c);
  }
  return `<span class="av-wrap"><span class="avatar group ${cls || ''}" style="background:${avColor(c.id)}">${inner}</span></span>`;
}
async function decodeAvatar(user) {
  // user.avatar — это короткий отпечаток; сама картинка лежит отдельно,
  // чтобы не гонять её при каждом опросе сервера
  const tag = user.id + ':' + user.avatar;
  if (avatarPending.has(tag) || !user.avatar) return;
  avatarPending.add(tag);
  try {
    const r = await api('/api/avatar/' + encodeURIComponent(user.id) + '?rev=' + encodeURIComponent(user.avatar || ''));
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
  paintIcons(document);
}

function openProfileWithStatus() {
  $('#btn-profile').click();
  setTimeout(() => { const el = $('#pf-status'); if (el) el.focus(); }, 80);
}
function renderMe() {
  $('#me-avatar').innerHTML = avatarHtml(S.me, '', true);
  $('#me-name').textContent = S.me.name;
  const st = (S.me && S.me.status) || '';
  $('#me-sub').textContent = (S.me.isAdmin ? 'администратор · ' : '') + (st || 'в сети');
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
  const body = p.text ? p.text : attLabel(p.att);
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
  const groups = chats.filter(c => c.kind === 'group');
  const dms = chats.filter(c => c.kind === 'dm');
  const chatRow = (c) => {
    const un = unreadIn(c.id);
    const last = lastMessageIn(c.id);
    const peer = c.kind === 'dm' ? userById(dmPeer(c)) : null;
    const sub = last ? preview(last)
      : (c.kind === 'dm' ? (isOnline(peer) ? 'в сети' : fmtAgo(peer && peer.lastSeen))
        : plural(c.members.length, 'участник', 'участника', 'участников'));
    return `<div class="chat-item ${S.view === c.id ? 'active' : ''} ${un.total ? 'unread' : ''}" data-chat="${c.id}">
      ${chatAvatarHtml(c)}
      <div class="ci-main">
        <div class="ci-name">${escapeHtml(chatTitle(c))}${isChatMuted(c.id) ? '<span class="mute-mark" title="Без звука">🔇</span>' : ''}${c.kind === 'group' ? `<span class="tag-grp">${c.members.length}</span>` : ''}</div>
        <div class="ci-last">${escapeHtml(cut(sub, 42))}</div>
      </div>
      ${un.mentions ? `<span class="badge at" title="обращения к вам">@${un.mentions}</span>` : ''}
      ${un.total ? `<span class="badge">${un.total}</span>` : ''}
    </div>`;
  };
  if (groups.length) html += `<div class="rail-group">Групповые чаты</div>` + groups.map(chatRow).join('');
  if (dms.length) html += `<div class="rail-group">Личные чаты</div>` + dms.map(chatRow).join('');

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
    $('#input').placeholder = 'ну пиши, чё?';
    return;
  }
  $('#chat-avatar').innerHTML = chatAvatarHtml(c);
  $('#chat-title').textContent = chatTitle(c);
  if (c.kind === 'dm') {
    const u = userById(dmPeer(c));
    $('#chat-sub').innerHTML = isOnline(u)
      ? '<span style="color:#5c9c1e">в сети, смотрит чат</span> · личная переписка'
      : 'был(а) ' + escapeHtml(fmtAgo(u && u.lastSeen)) + ' · личная переписка';
    $('#input').placeholder = 'ну пиши, чё?';
  } else {
    const online = c.members.map(userById).filter(isOnline).length;
    $('#chat-sub').innerHTML = `${plural(c.members.length, 'участник', 'участника', 'участников')} · <span style="color:#5c9c1e">${online} в сети</span>`;
    $('#input').placeholder = 'ну пиши, чё?';
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
  // своё сообщение показываем сразу, ещё до ответа сервера: часы — «летит»,
  // галочка — «сервер принял», две — «прочитали»
  if (m.local) return `<span class="check pending" title="Отправляется…">⏱</span>`;
  if (m.failed) return `<span class="check failed" title="Не отправлено: ${escapeHtml(m.failed)}">⚠</span><button class="retry-send" data-retry="${m.id}" title="Отправить ещё раз">повторить</button>`;
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
  const body = p.text ? cut(p.text, 90) : attLabel(p.att);
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

/**
 * Ряд реакций под сообщением. Вынесен отдельно, чтобы клик по смайлику
 * перерисовывал только этот ряд, а не всю ленту: реакция появляется
 * мгновенно и лента не «дёргается».
 */
function rxRowHtml(m) {
  const rx = m.reactions || {};
  const keys = Object.keys(rx).filter(k => (rx[k] || []).length);
  if (!keys.length) return '';
  return `<div class="rx-row">${keys.map(k =>
    `<button class="rx ${(rx[k] || []).includes(S.me.id) ? 'mine' : ''}" data-rx="${escapeHtml(k)}" data-mid="${m.id}" title="${plural((rx[k] || []).length, 'человек', 'человека', 'человек')}">${twEmo(escapeHtml(k))}<span>${(rx[k] || []).length}</span></button>`).join('')}</div>`;
}
/** Точечно обновить реакции одного сообщения (в ленте или в панели комментариев). */
function paintReactions(m) {
  const el = document.getElementById('m-' + m.id);
  if (!el) return;
  const wrap = el.querySelector('.bubble-wrap') || el;
  const old = wrap.querySelector('.rx-row');
  const html = rxRowHtml(m);
  if (old) { if (html) old.outerHTML = html; else old.remove(); return; }
  if (!html) return;
  const bubble = wrap.querySelector('.bubble');
  if (bubble) bubble.insertAdjacentHTML('afterend', html);
  else wrap.insertAdjacentHTML('beforeend', html);
}
/** Точечно обновить «галочки» своего сообщения (часы → ✓ → ✓✓). */
function paintDelivery(m) {
  const el = document.getElementById('m-' + m.id);
  if (!el) return;
  const meta = el.querySelector('.meta');
  if (meta) meta.innerHTML = readersHtml(m);
  el.classList.toggle('local', !!m.local);
  el.classList.toggle('failed', !!m.failed);
}

function messageHtml(m, opts = {}) {
  const locked = !S.plain.has(m.id) && S.keyIssue.has(m.chat);
  const p = S.plain.get(m.id) || (locked ? { text: '🔒', locked: true } : { text: '…' });
  const author = userById(m.uid) || { id: m.uid, name: p.author || 'Бывший участник' };
  const mine = m.uid === S.me.id;
  const mentioned = p.mentions && p.mentions.includes(S.me.id) && !mine;
  const kids = opts.noThread ? [] : S.messages.filter(x => x.parent === m.id);
  const unreadKids = kids.length ? threadUnread(m.id) : 0;
  const chat = chatById(m.chat);
  const canDel = mine;   // удалять и править можно только свои сообщения
  const continued = !!opts.continued;
  const continues = !!opts.continues;
  const metaParts = [];
  if (!continues) metaParts.push(readersHtml(m));
  if (m.editedAt) metaParts.push('<span class="edited" title="сообщение изменено">изменено</span>');
  if (kids.length) metaParts.push(`<span class="thread-btn" data-thread="${m.id}">${SV(ICONS.comment)} ${plural(kids.length, 'комментарий', 'комментария', 'комментариев')}${unreadKids ? `<span class="dot-new"></span>` : ''}</span>`);
  const meta = metaParts.filter(Boolean).join('');
  const rxHtml = rxRowHtml(m);
  const sending = !!m.local || !!m.failed;   // ещё не принятое сервером сообщение
  return `<div class="msg ${mine ? 'mine' : ''} ${locked ? 'locked' : ''} ${mentioned ? 'mentioned' : ''} ${continued ? 'grouped' : ''} ${continues ? 'continues' : ''} ${opts.fresh ? 'fresh' : ''} ${m.local ? 'local' : ''} ${m.failed ? 'failed' : ''} ${S.highlight === m.id ? 'hl' : ''}" id="m-${m.id}">
    ${avatarHtml(author, 'sm', true)}
    <div class="bubble-wrap">
      ${continued ? '' : `<div class="head"><span class="who">${escapeHtml(author.name)}</span><span class="time">${fmtTime(m.ts)}</span></div>`}
      <div class="bubble">
        ${m.quote ? quoteCardHtml(m.quote) : ''}
        ${p.text ? `<div class="btext">${twEmo(mentionize(p.text))}</div>` : ''}
        ${p.att ? attHtml(p.att) : ''}
      </div>
      ${rxHtml}
      ${meta ? `<div class="meta">${meta}</div>` : ''}
    </div>
    <div class="tools"${sending ? ' hidden' : ''}>
      <button class="tool" data-rxpick="${m.id}" title="Поставить реакцию">${SV(ICONS.react)}</button>
      <button class="tool" data-quote="${m.id}" title="Ответить ссылкой на это сообщение">${SV(ICONS.reply)}</button>
      ${opts.noThread ? '' : `<button class="tool" data-thread="${m.id}" title="Комментировать внутри сообщения">${SV(ICONS.comment)}</button>`}
      ${mine ? `<button class="tool" data-edit="${m.id}" title="Редактировать своё сообщение">${SV(ICONS.pencil)}</button>` : ''}
      ${canDel ? `<button class="tool" data-del="${m.id}" title="Удалить">${SV(ICONS.trash)}</button>` : ''}
    </div>
  </div>`;
}

function archiveBannerHtml(c) {
  if (!c) return '';
  const who = c.clearedByName || c.archivedByName;
  if (!who) return '';
  const verb = c.clearedByName ? 'очистил(а) этот чат. История удалена из облака.'
    : 'заархивировал(а) этот чат. История сохранена в архив в облаке.';
  const at = c.clearedAt || c.archivedAt;
  const cnt = c.clearedByName ? c.clearedCount : c.archivedCount;
  const dateStr = at ? `${fmtDay(at)}, ${fmtTime(at)}` : '';
  const countStr = (cnt !== null && cnt !== undefined)
    ? ` · удалено ${plural(cnt, 'сообщение', 'сообщения', 'сообщений')}`
    : '';
  const sub = (dateStr || countStr) ? `<div class="archive-banner-sub tiny muted">${dateStr}${countStr}</div>` : '';
  return `<div class="archive-banner">
    <div class="archive-banner-title">Пользователь <b>${escapeHtml(who)}</b> ${verb}</div>
    ${sub}
  </div>`;
}

// какие сообщения уже показаны в открытом чате: анимируем только новые,
// иначе лента «мигала» бы при каждом опросе сервера
let renderedIds = new Set(), renderedChat = null, renderedOnce = false;
const WIN_SIZE = 30;   // сообщений в одном окне ленты (быстрее первый экран)

function renderMessages(force) {
  const box = $('#messages');
  if (renderedChat !== (S.view || null)) { renderedChat = S.view || null; renderedOnce = false; renderedIds = new Set(); }
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
  const full = S.messages.filter(m => m.chat === S.view && !m.parent);
  // лента подгружается окнами: сначала последние WIN_SIZE сообщений,
  // старше — кнопкой «Показать более ранние», чтобы не рисовать тысячи узлов
  const win = S.winSize || WIN_SIZE;
  const off = Math.max(0, full.length - win);
  const list = full.slice(off);
  const moreBtn = off > 0 ? `<button class="load-more" id="load-more">Показать более ранние (${off})</button>` : '';
  const prevTop = box.scrollTop, prevHeight = box.scrollHeight;
  const nearBottom = prevHeight - prevTop - box.clientHeight < 160;
  const c = curChat();
  const banner = archiveBannerHtml(c) + keyBannerHtml(c);
  if (!full.length) {
    const emptyHint = `<div class="sys">${c && c.kind === 'dm'
      ? 'Личная переписка. Никто, кроме вас двоих, её не увидит.'
      : 'Сообщений пока нет. Напишите первое 👋'}</div>`;
    box.innerHTML = banner ? (banner + emptyHint) : emptyHint;
    return;
  }
  let html = banner + moreBtn, lastDay = '';
  const firstPaint = !renderedOnce;
  renderedOnce = true;
  const freshIds = [];
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    const day = new Date(m.ts).toDateString();
    if (day !== lastDay) { html += `<div class="day"><span>${fmtDay(m.ts)}</span></div>`; lastDay = day; }
    if (S.openMark && S.openMark.chat === S.view && S.openMark.msgId === m.id) {
      html += `<div class="unread-line" id="unread-mark">Непрочитанные — ${S.openMark.count}</div>`;
    }
    const fresh = !firstPaint && !renderedIds.has(m.id);
    if (fresh) freshIds.push(m.id);
    html += messageHtml(m, { continued: canGroup(list[i - 1], m), continues: canGroup(m, list[i + 1]), fresh });
  }
  box.innerHTML = html;
  renderedIds = new Set(list.map(m => m.id));
  paintIcons(box);
  // самовосстановление: если в видимом окне остались «…», дошифровываем их сами.
  // ВАЖНО: если ключа на устройстве нет (S.keyIssue), сообщения так и останутся закрытыми,
  // и цикл «перерисовали → не расшифровали → перерисовали» крутился бы вечно, вешая страницу.
  // Поэтому при отсутствии ключа и после неудачной попытки берём паузу: следующую попытку
  // сделает опрос сервера (раз в 2,5 с) — как только ключ доедет, лента расшифруется сама.
  const pending = list.slice(off).filter(m => !S.plain.has(m.id)).map(m => m.id);
  const keyBlocked = !!(S.view && S.keyIssue.has(S.view));
  const cooled = Date.now() < (S.healPauseUntil || 0);
  if (pending.length && !keyBlocked && !cooled && !S.healBusy) {
    S.healBusy = true;
    const before = S.plain.size;
    ensureIds(pending).then(() => {
      S.healBusy = false;
      if (S.plain.size > before) { if (S.view) renderMessages(); }   // есть прогресс — дорисуем
      else S.healPauseUntil = Date.now() + HEAL_PAUSE;               // нет — пауза, ждём опрос сервера
    }).catch(() => { S.healBusy = false; S.healPauseUntil = Date.now() + HEAL_PAUSE; });
  }
  applyWallBackground();
  upgradeMedia(box);
  if (force || nearBottom || S.atBottom) box.scrollTop = box.scrollHeight;
  else box.scrollTop = prevTop + (box.scrollHeight - prevHeight);
  // фокус держим на цели, пока пользователь сам не прокрутит ленту
  if (S.focusPending && !S.userScrolled) applyFocus();
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
      ${p.att ? attHtml(p.att) : ''}
    </div>` + kids.map((k, i) => messageHtml(k, { noThread: true, continued: canGroup(kids[i - 1], k), continues: canGroup(k, kids[i + 1]) })).join('');
  if (atBottom) box.scrollTop = box.scrollHeight;
  else box.scrollTop = prevTop + (box.scrollHeight - prevHeight);
}

// из чего складывается занятое место (сервер присылает parts в usage)
function usagePartsText(u) {
  const p = (u && u.parts) || {};
  const rows = [
    ['сообщения', (p.messages || 0) + (p.overhead || 0)],
    ['файлы, фото и видео', p.uploads || 0],
    ['аватары', p.avatars || 0],
    ['фоны и значки чатов', p.assets || 0],
    ['архивы', p.archives || 0]
  ].filter(r => r[1] > 0).sort((a, b) => b[1] - a[1]);
  if (!rows.length) return '';
  return rows.map(r => r[0] + ' ' + fmtBytes(r[1])).join(' · ');
}

function renderMemory() {
  const u = S.usage, pct = Math.min(100, u.percent);
  $('#mem-pct').textContent = pct + '%';
  const fill = $('#mem-fill');
  fill.style.width = Math.max(pct, u.bytes > 0 ? 1.5 : 0) + '%';
  fill.classList.toggle('hot', pct >= 80);
  const c = curChat();
  $('#mem-text').textContent = `${fmtBytes(u.bytes)} из ${fmtBytes(u.limit)} · ${u.messages} сообщ.`
    + (u.archives ? ` · ${plural(u.archives, 'архив', 'архива', 'архивов')}` : '')
    + (c ? ` · этот чат ${fmtBytes(c.bytes)}` : '');
  $('#mem-warn').classList.toggle('hidden', pct < 80);
  const parts = $('#mem-parts');
  if (parts) {
    const txt = usagePartsText(u);
    parts.textContent = txt;
    parts.classList.toggle('hidden', !txt);
  }
}

function renderQuoteBar() {
  const bar = $('#quote-bar');
  if (!S.quote) return hide(bar);
  const q = S.messages.find(m => m.id === S.quote);
  if (!q) { S.quote = null; return hide(bar); }
  const p = S.plain.get(q.id) || {};
  const author = userById(q.uid) || { name: p.author || 'Бывший участник' };
  $('#quote-who').textContent = 'Ответ ' + author.name + ': ';
  $('#quote-preview').textContent = cut(p.text || attLabel(p.att), 70);
  show(bar);
}

function updateTitle() {
  let total = 0;
  for (const c of S.chats) total += unreadIn(c.id).total;
  const rx = unreadReactions();
  total += rx;
  document.title = (total ? `(${total}) ` : '') + 'SEGA-CHAT';
  $('#rail-badge').classList.toggle('hidden', !total);
  updateFavicon(total);
}

// ─────────────────────────────────────────── непрочитанные реакции
/** Отметка времени, когда я последний смотрел чат: хранится локально. */
function seenTs() {
  try { return JSON.parse(localStorage.getItem('sega.seenTs') || '{}'); } catch (e) { return {}; }
}
function bumpSeen(chatId) {
  if (!chatId) return;
  const m = seenTs(); m[chatId] = Date.now();
  try { localStorage.setItem('sega.seenTs', JSON.stringify(m)); } catch (e) {}
}
/** Реакции на мои сообщения, поставленные другими после моего последнего просмотра чата. */
function unreadReactions() {
  const seen = seenTs();
  let n = 0;
  for (const m of S.messages) {
    if (m.uid !== S.me.id || !m.reactTs || m.reactBy === S.me.id) continue;
    if (m.reactTs > (seen[m.chat] || 0)) n++;
  }
  return n;
}
function notifyReactions() {
  const seen = seenTs();
  const fresh = S.messages.filter(m => m.uid === S.me.id && m.reactTs && m.reactBy !== S.me.id
    && m.reactTs > (S.lastReactSeen || 0));
  S.lastReactSeen = Math.max(S.lastReactSeen || 0, ...fresh.map(m => m.reactTs), 0);
  if (!fresh.length) return;
  const inactive = document.hidden || (document.hasFocus && !document.hasFocus());
  if (!inactive) return;
  const by = userById(fresh[fresh.length - 1].reactBy);
  playNotifySound();
  try {
    if (S.notify.desktop && 'Notification' in window && Notification.permission === 'granted') {
      const n = new Notification('SEGA-CHAT', { body: (by ? by.name : 'Кто-то') + ' отреагировал(а) на ваше сообщение', tag: 'sega-react', silent: true });
      n.onclick = () => { window.focus(); openChat(fresh[fresh.length - 1].chat); n.close(); };
      setTimeout(() => n.close(), 8000);
    }
  } catch (e) {}
  void seen;
}

// ─────────────────────────────────────────── значок вкладки и ярлыка
// Значок — скруглённый квадрат с рендером текущей гаммы и белой S;
// поверх горит красная точка, пока есть непрочитанные сообщения.
let lastFav = '';
const FAV_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAR1ElEQVR4nO1beZBlVXn/fefc7S3dPUs3synLOIDDWGpkjSYwmhAVlIGQ7ioXQigXlFQ0mkpEgXn9ZkAJlmsiFQvLxBAzplsZJFqMIgWYIFEYwGUGB0XGkZmhZ3p6fctdzjlf/rhvuW+bvj2LlUryVZ3uu5x77/m+c77t950H/B8nOulfYCaMgrABhF0Pn/zvAcCGjYwR0mm6WidlAMyE0Ycldh9mEGkAfFK+cwLoxAqAmTAOUWNaEYDXfOSLA4edNetCYZ8RMVYYpowgI8HcFIoAwEQgYsAABgDVzk2tD+nafRGfG1PrU3uPAUBg2BlyovnpA1ve+iVKIfgTJ4CxMVljXJ9/498t3+edc4Uv7E17GBcaIVeynQELiabW1cdGtTNGUiM7dYXb7tSfSPRkDXZycGZ+c1ACdyUe6CmIEyAAJgyPC4yM6HM//MXBfQNn/eUzZL9Lu/mVhhmsQkBHTH7FgLoPZKFpSq8/bFhrAcaRtE8cnwAKBYEiGRqHXrH5/mv2WH2fUF7/GhNUQNV5DQAEiHipQrYMFSfGAretC4NYR1LzdewCKBQEikVz7bXXevetvebOWW/wOh0FoOqsIoYEkez2WPts1gXR7frC1HyypT9R6kVzbAKoMX/Rh+5atn3Juu1BdvBirswqAguArLRTyy36D/SyD+1P9b5Xv8WkATo5RjD267ikMJR/Wqy7P8gsvwDlmYiI7J6Dii2+WXhmkrePxnz7cYNiFWDSMuUiWqwACOMQVCT9k83f3eZnBy9AeToCCbt7dzZgYliOhO1KItFmB9tnPPFkFwH0sKHN+2zATg4IZ5ednBUwNiYwQnrw5m9/dL5v1VtQnolAwk4atLpGEkPDyUghBCx/7kWhyj+SOnrGFmKGwErDgEgwMwgtx4AEoJkJArE+6/hYQDTNXD1AiMMBZmYiYtaRS66pTokm80cVQnpDXGCBInhd4ZvrD1pDT0csBLESSYtDABAPBcLLk+PPPu1y8OkL+flvfKt4fSX1t36LlH4F7B4nwog5zN+5Qzk5m6rzGhQz35AiM7OQsARRrjyx5dCWNxYJMAc//NXBodEHr1ZE52uIVcxGmKN8qpV6zVGXiWVm2B55wdz+qa1v/gA3X3CcgdDwmMT4iF59y70XTjv9l7NfMtTu5piZhWUsQRioTlxz8LZN2zbeUMgPrrh49BnhXmec3DJDEmDTg6nekQERgTtY6CYADbg5UOgfMMAHT5wNGB4GxoESsu/XThZUnW9oYkP3SRhpu7K/9ML7Dt62advpf3332U/1nfb1MLP0FdovgaolvbAXSFoSar2cKoZkA2MEgaZT8YVUAmDCCOlzPzI28HMh38JhFcQsQc0BMrNGJi/d8qHtE7dd8cWX3bT9pRPOsh2h0386lacjAlnJwCjmJznb3Wa/ea1z9nsRxRMjWKZ1g2LBHmPjAgAOyMxFxu1fTjoyXNN9rg9PCGGFZX85Vf+GARwRmX+IMstOJ38udpFELdx1id067h5boMzpuE7QwgLYNUQA4AvrtWy5XJMygLrVhyE3R3ZU+e5zxU2/POWWb18aZAcv4+qcqscH1NaSA07Gg8cGG7S+tX6kU0pwYQFs2MgAoIS1npk7Z5KIBRgOme0Aky/s642wuXvQwgxAM2CSzbSdx427XGtv1DiOJyY+BxOfuEhwGIYAMImXwGhwm2QZkBSU2dP+44XCKH0KF1/AKiCqCbehycyAtElYthQmQvI13TMB7mL7qHaNE/2piQuwErBsUGC8NMynEwAJBgDD1Ac2IDA1DRgzC4uE8qtrZHBwG85aZoiGWCsATAmwgyFtskx4KF8+dD0zJtloIiE7nZsggmIhYQSEZDIRk0UmAmCrBcYqJEPPkm38ylzilccngGZEKWLLT223CExk8h70/mrOY3RNgxnCIqmqR6ZuveLeo6GVv23wMIUA4kUnBAUa1OqTCXG+A3i/qnoDa3Hk0BHuK4HEUpikGSIB5SOwMuu90UdeBJlZgASYmZkBIiZmYsAQkU+gSQnznAN+Is8zj+0tXv2zhuUt/MzBht0a40cZ8jnDjCKlCjYXFkDBCBTJSObJSAjAJF04EVgbdnOyWqmuf2Trdfvym7/3LFnOBTDKAJAtemwUQjuzAkKuAHd3WUQEkAAJ+QcBm/eWAlflt3z/cZeiu19Vevxfv1d8xSzAhMIooVhMH1H3oIW9AB4WDIDYPEdCoN28E8iwdBGQ/CMAcFl9XUiLUHMZHUyq0FBYNYiqhlqab4TyDcKKgV/WXJ1T2i+piMmq2rnfLbnL7/xh7nU/Hip85wYBYhSLBmNjXVGnEyyAmCxET1DXOJ6FjnyEwv6TSwr/6K0ozX3ZKk9OwHYl2JhO3w8RY9tCAFRr8TEz4vMYP7QIsASYRVgxulpSgXBPK+VWfqFvy/cfOfPmbesxMqJReOi4cM00K8AAQB/5/0H+vKI2cBMgQVGgVXbpqc/ooffv/szIVD4q/bktBLGwGcx1cHSByKSn+SMGxUCnDoyulpTv9F98wDvtsdU333sFiq9XxyOEdPFmoSCoWDT5zQ/8MMwuPx9BxTASgmBmtmx2WJVeMnfggj2fHNkz+LH7PlDpW/U5ZQBSgQIz1ZCL3t9M2pbEaaevZA3LkRYx8qWJaw59YtO/oPCQheLrF3KUHZRSBTYKBpCB+rIQkjoKEkREOkIkM/0H+1bcc+7H7l41+fErPj9QfuEq1/i/pEyfBS8vWTqCpE2QVkvjehMWMQlCDPeo2v/GlxopBZGEDk1k2JTyK+9edcs3N6H4enUsNiEtfksAcEnhC7md2PDz0M6thg441t9kN9bwctKLys8sDY6849e3XvnU8PCHMg9vuOzPQmFv0izOMcz9xDXvQ6YW2FENWGLJIJedrDCWA44CIAo06rWFjoGzYWGTQ7q8xt9/3p5bR/bEyFU6F7gIAQD1JXZK4f53z+dW36UrcwpEnbrHrMnJSEv7lQxXbz/Nmf78zhtHZoF4ub28MJa3YVsA0BdUaN7NMjADzABORsgJuaQ/tDLrA5KXRmRfqb3+03XoAzo0INEQeAKF0vDy0vOnfnTXOUdeOzIOYHzEIGVMtbicc3hMFs4Z4c/yAw/7uaHfZ39eAV2EADYgKYSXg/TnDrocfds20YNW6O8WqjxpWegaDPY5Ll+Fn8wUi8UQAK4tFLz78br3la3sLZGVXYagrOu4QtvAlcgOWPm5fX9xeOvlf78Ye7A4ARQKAsVRPrvwtdNesF6yMyJ3GZTfMjMJITAYhi1HCicLMgoUVgATRahlOi34kAFIEIMwJwl7bKj7Vlf2fOmnt98wfcaN286azK7+auD0nwe/pEEk2/TBsOXCi8qTZ1b2nLXzb99bSwUWrhCljgMAAMWiwfC42FN8294l/qFhi7RiaRPYdNE5IhBJUiFzdU6ZoKIVA0q4tpauo8hxlHQdJV0nEq6jbNeJpONG0hsKnL7fq2SG7tibe+VPV978rXc+f/vbnl175MlL3WDmSXJzktiYJObNDEGhz1Fm6Sn7vNPfARCj8HAqg3hs9cnaEltzy/arp72VX4sgLVJBQx3aI8C6/aptCWCiODumWsemV2lgRbEOS8eybBv58oHNh7ZcvvXMG7+69kD21CciYQ9ARQRqsYwaTkY4/vQTc8U/vJBqOcZCrCxuBdSpFnzs33rVN5aUXnyTy+oQvH6L400RBq0Gu2UvBACK/SbVTH/9PxoNgCQii3RgVFBVpdyaLStv/tY7f3H7O36VjWY2C9sTaFRGGiQ59GGE85q1hXvOBBGjUFiQv2MTQEIIBz5x1YOrp395USaY2WF5eQu2J8CsCdBJOJN7IJsx+11uMCO2ClooFZmS1ffZdR8dGzp3UN5llaf2wXYlYtQomZxq4/XLMjIXx1c2nkQBALEQhsfks5/60+fnNl/y5v7KxHWuru4RmbxkLy8hLCKGJkBRUyiG2Zg4j+b4P9jEyFjHrMZCiHyjssuWT1v979rxwcsCh6Jxsj0k8ckaNAEmgRDWeWlZOD4BAMD4iEahIJiZJopv/Kc3Tt3zOwP+4Wu9YPZBm1VVeDlJmX4LmT7JTlbCyQo4OcF2VrCTFXCyAnbtmnQEdYPCiMjoiENyrgIA15gHhAoAcMv4mZmYDQxoXbyoNi4YEC2uNrh7vHf/YQC7zpEY3RDFQCmw9qZ7Xla2By4Iic5XjDMN0SmK4YGZ0FH+JQPCEFuZVawj5qSBY2aWNtnan75sdueanf1nDr1IA79SZMsYY613ZUNOVjjB7I9Lo294dTdU8dgF8FsgCcAbfei5yM6tJRWYZqjNzCTJNmG0Otx7xlC0ZO7p3JL9kfT6SEfcDJPZkJ0RbjD3i1m84eVURD1/P87aIICVHxs/z5cDOUv5SJtysbDJghHKaIKQDBhDRnL7V9kQEbRxpbVqnqylZHSMwdTux6khASCT42w4kw1tgC10YNS19xE0Rk/gBgkCMC+XbjN9p6zzw0oNx+hZymyBDMN4SI2/9SyyFRCLJ8kXFkwUgIwCt+SbxCQkkdGHn3J2HTlVv2Y9O3YGxnDShzQFZUrx/gBujzc7KLURZBIVrUJjtFJGR4ZVZEyjKaNVVGuBMVFgjAqNbrT4nokio1VojAqNiZItMDoKjQkqGkZxW7INAAaWy7bRj1NxlH3hncduHgRuzSkYDCEgwAcYAMYW5m8RXoBF3J8FuH4MwQzBzAKMZgNaz+v3a9e5fpxotUKK7BYVMADJilwT3gUQB4wru04rERMJtlnvAoA0e5MX6QZbKsLJMAetWHka20qJFJ/a0/0msYkoM2A5lckHD269bMe6m+55mXbyb+KgwgRu33tIQofkGvUoAGDD4RMdCnOPgaZluvmeVsPMzUixYdCZwRyx12e71ekXTtGz7yEQT8rsHcrJeWS0qWcZBICYGdKS5M9PnxHt+wEAYHh4wTggtRcgIg2iGKYiEvH0d6vrp3wfmuFxB87MTCxtKb2c7Vandg+V9488e8fbn195033Xz2aG/pj9ku7YoUKkyclIR83f/5+33zCd2Lt8VEotAGYsgddnNVDsjsVVrxotXOamHsd1VSDWkGF5yqtMfOXs0s7CDz75kflVhfvePmsP3amjUNc2ZLaODxBWVKU+Hd45DeColaMEpRZAH4Ltunr4VA6rDBKU2K/WhRZXsIndl2QDKGOw34F68jT/wI7Hb7/2yKOAGCw8MDrr9BWUNkxGdxoMZk2ZPumUJ773m62XP1rDBVP9YOJ/VCSYpEv/6p9zTw+sujqA86HIHXi19ktcy/HbxszMwtI2MQ36h87/9a1XPYXhf5MYHzmxvxgZ3LzjPSbTP2SiKseQRi9qXxndUvdk39oGSDbxBh9jlilhn/0YxHna6VthjAGq87HOd/ssQ4lM3s7O7N3y61uvfApjYxIj6ZgHFhEJVmHfojNDL4Ws1Fz6IqhnNN7dVjAzOPJBfkUTMfXaeQ7mCNkB25uf+M6hrW8dpVeyxEh6SBxY1FZZmuLq3CpE1UaSwj14aHgyJOxi8npnqaf9lCjejyDrSWNndBQzn/GnnrwIu0YIDAwjNRxep/ReAEbGCQgMx5FgrZTdjSF0DDq5etv3jLU/Hzv3tlXW6MSGQYZyS+xMderRV+k9V+4ofnAOmBLHUi5fxFruHez0Zq5O3BMSa7635gJ7D4ABViwdYXk5K1859JVLp++99JHi9ZP13y+kYqONjqmq2jNsTVBj6zcdJcxteV9CT+rCqv/OAABbthR2xnL8uf258tRHJ7a8+e5xAMfDPLDYSLBZsOxYOfVxN+Du+sUFiBN/m9VgipFhyyFYrhTEkEH5QMaf/PKpM7/43M5PXz9Z372+mDpgN0ovAGCZyPRbLGWnfja4qWX8daygPeXv9t66JaUE+1pDhBUIVT1g6eoPPQq/efrU3n//r8+8Z+owEP9EL+UvQxeiVAJgAG4wexPP0nJEPuvamiYWCRY12LRVcEWtElK7Hp/HHo1JUVwhFLXrBiCLHYkAzBMZqL1rKi8+99gn3z0/A+BFABhjiWGYNDH+/x4aHpMoPGThaBsrjoPSv3RsTNb3DZ902rCRsQuMIjhNgfP/6TjovwH09vrPUSj2TwAAAABJRU5ErkJggg==';
function favSvg(badge) {
  const dot = badge ? `<circle cx='50' cy='14' r='13' fill='#ff3b30' stroke='white' stroke-width='4'/>` : '';
  const s = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><image href='${FAV_PNG}' width='64' height='64'/>${dot}</svg>`;
  return 'data:image/svg+xml,' + encodeURIComponent(s);
}
function updateFavicon(total) {
  let n = total;
  if (n === undefined) { n = 0; for (const c of S.chats) n += unreadIn(c.id).total; }
  const href = favSvg(n > 0);
  if (href === lastFav) return;
  lastFav = href;
  const link = document.querySelector('link[rel="icon"]');
  if (link) link.href = href;
  // бейдж на ярлыке установленного чата (Android/Chrome); у iPhone веб-приложениям бейдж не разрешён
  try {
    if (n > 0) navigator.setAppBadge && navigator.setAppBadge(n);
    else navigator.clearAppBadge && navigator.clearAppBadge();
  } catch (e) {}
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
async function openChat(id) {
  if (S.view) S.drafts[S.view] = $('#input').value;
  S.view = id;
  S.threadId = null; S.quote = null;
  S.atBottom = true; S.sig = '';
  renderedChat = null; renderedOnce = false; renderedIds = new Set();
  S.winSize = WIN_SIZE;
  S.healBusy = false; S.healPauseUntil = 0;
  $('#input').value = S.drafts[id] || '';
  // фокус при открытии: строго первое непрочитанное, а если их нет — последнее сообщение
  const un = unreadIn(id);
  S.openMark = un.total ? firstUnreadMark(id, un.total) : null;
  S.focusPending = true; S.userScrolled = false;
  bumpSeen(id);
  try {
    // ПЕРВЫМ ДЕЛОМ: расшифровать и нарисовать последние 30 сообщений
    const winIds = S.messages.filter(m => m.chat === id && !m.parent).slice(-WIN_SIZE).map(m => m.id);
    await ensureIds(winIds).catch(() => {});
    renderAll();
    renderMessages(!S.openMark);
    applyFocus();
  } finally {
    markRead();
    if (window.matchMedia('(min-width: 901px)').matches) $('#input').focus();
    // ПОТОМ ФОНОМ: остальная история и медиа — после первого экрана (гарантированно)
    scheduleDecryptRest(id);
  }
}
let decryptRestTimer = null;
function scheduleDecryptRest(chatId) {
  clearTimeout(decryptRestTimer);
  decryptRestTimer = setTimeout(async () => {
    const list = S.messages.filter(m => m.chat === chatId);
    for (let i = 0; i < list.length; i += 20) {
      if (S.view !== chatId) return;
      const need = list.slice(i, i + 20).filter(m => m.id && !S.plain.has(m.id));
      if (!need.length) continue;
      await decryptAll(need);
      renderMessages();          // «…» заменяются текстом, прокрутка сохраняется
      await new Promise(r => setTimeout(r, 0));
    }
  }, 300);
}
/** Детерминированный фокус: первое непрочитанное (с разделителем) или низ ленты. */
function applyFocus() {
  const box = $('#messages');
  S.programmatic = true;
  if (S.openMark) {
    const el = $('#unread-mark') || document.getElementById('m-' + S.openMark.msgId);
    if (el) el.scrollIntoView({ block: 'start', behavior: 'auto' });
  } else {
    box.scrollTop = box.scrollHeight;
  }
  requestAnimationFrame(() => { S.programmatic = false; });
}
/** Первое непрочитанное сообщение чата (сверху вниз) + сколько их всего. */
function firstUnreadMark(chatId, count) {
  const reads = myReads();
  const list = S.messages
    .filter(m => m.chat === chatId && !m.parent && m.uid !== S.me.id && m.seq > (reads[bucketOf(m)] || 0))
    .sort((a, b) => a.seq - b.seq);
  return list.length ? { chat: chatId, msgId: list[0].id, count } : null;
}
$('#chat-filter').addEventListener('input', e => { S.railFilter = e.target.value; S.sig = ''; renderAll(); });
$('#btn-open-rail').addEventListener('click', () => $('#rail').classList.add('open'));
$('#btn-close-rail').addEventListener('click', () => $('#rail').classList.remove('open'));

async function openThread(id) {
  S.threadId = id; S.sig = '';
  await ensureIds([id, ...S.messages.filter(m => m.parent === id).map(m => m.id)]);
  renderAll();
  markRead();
  setTimeout(() => { const b = $('#thread-body'); b.scrollTop = b.scrollHeight; $('#thread-input').focus(); }, 60);
}
$('#thread-close').addEventListener('click', () => { S.threadId = null; S.sig = ''; renderAll(); });

// переход к сообщению, на которое ссылаются
let hlTimer = null;
async function goToMessage(id) {
  const m = S.messages.find(x => x.id === id);
  if (m) await ensureIds([id]);
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
  // на телефоне инструменты сообщения открываются тапом по сообщению,
  // чтобы панель кнопок не распирала ленту по горизонтали
  if (window.matchMedia('(max-width:900px)').matches) {
    const msgEl = e.target.closest('.msg');
    if (msgEl && !e.target.closest('button, a, img, video, audio, [data-upl]')) {
      const was = msgEl.classList.contains('show-tools');
      $$('#messages .msg.show-tools').forEach(x => x.classList.remove('show-tools'));
      if (!was) msgEl.classList.add('show-tools');
      return;
    }
  }
  const upl = e.target.closest('[data-upl]');
  if (upl) { loadUpload(upl).catch(ex => toast(ex.message, true)); return; }
  const goto = e.target.closest('[data-goto]');
  if (goto) return goToMessage(goto.dataset.goto);
  const rxb = e.target.closest('[data-rx]');
  if (rxb) return toggleReaction(rxb.dataset.mid, rxb.dataset.rx);
  const rtb = e.target.closest('[data-retry]');
  if (rtb) return retrySend(rtb.dataset.retry);
  const rxp = e.target.closest('[data-rxpick]');
  if (rxp) return openRxPicker(rxp.dataset.rxpick, rxp);
  const ed = e.target.closest('[data-edit]');
  if (ed) return openEditor(ed.dataset.edit);
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
    const goneId = del.dataset.del;
    removeLocal([goneId]);            // исчезает с экрана сразу, не дожидаясь сервера
    api('/api/messages/' + goneId, { method: 'DELETE' })
      .then(r => {
        if (r && r.usage) S.usage = r.usage;
        if (S.threadId === goneId) S.threadId = null;
        S.sig = ''; renderMemory(); renderMessages(); renderThread();
        return sync();
      })
      .catch(ex => { toast(ex.message, true); sync().catch(() => {}); });
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
  if (!S.programmatic) { S.focusPending = false; S.userScrolled = true; }
  S.atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
  $('#scroll-bottom').classList.toggle('hidden', S.atBottom);
});
$('#messages').addEventListener('click', async e => {
  const lm = e.target.closest('#load-more');
  if (!lm) return;
  const full = S.messages.filter(m => m.chat === S.view && !m.parent);
  const oldOff = Math.max(0, full.length - (S.winSize || WIN_SIZE));
  S.winSize = (S.winSize || WIN_SIZE) + 160;
  const newOff = Math.max(0, full.length - S.winSize);
  for (let i = newOff; i < oldOff; i++) renderedIds.add(full[i].id);   // доскрытое не анимируем
  await ensureIds(full.slice(newOff, oldOff).map(m => m.id));
  S.sig = '';
  renderMessages();
});
$('#scroll-bottom').addEventListener('click', () => { const b = $('#messages'); b.scrollTop = b.scrollHeight; });

// ─────────────────────────────────────────── реакции на сообщения
const RX_SET = ['😀','😂','😍','👍','👎','','🔥','🎉','❤️','😢','😮','🤝'];
let rxPopFor = null;
function closeRxPicker() { const p = $('#rx-pop'); if (p) { hide(p); rxPopFor = null; } }
function openRxPicker(mid, anchor) {
  let pop = $('#rx-pop');
  if (!pop) {
    pop = document.createElement('div');
    pop.id = 'rx-pop';
    pop.className = 'emoji-pop rx-pop';
    document.body.appendChild(pop);
    pop.addEventListener('mousedown', e => {
      const b = e.target.closest('[data-rxset]');
      if (!b) return;
      e.preventDefault();
      const id = rxPopFor;
      closeRxPicker();
      if (id) toggleReaction(id, b.dataset.rxset);
    });
  }
  if (rxPopFor === mid && !pop.classList.contains('hidden')) return closeRxPicker();
  rxPopFor = mid;
  pop.innerHTML = RX_SET.map(e => `<button data-rxset="${e}" title="${e}">${twEmo(escapeHtml(e))}</button>`).join('');
  show(pop);
  const r = anchor.getBoundingClientRect();
  const w = pop.offsetWidth || 286;
  let x = Math.min(window.innerWidth - w - 8, Math.max(8, r.left - w + 40));
  pop.style.left = x + 'px';
  pop.style.top = (r.top - 44) + 'px';
}
document.addEventListener('mousedown', e => {
  if (!e.target.closest('#rx-pop, [data-rxpick]')) closeRxPicker();
});
async function toggleReaction(mid, emoji) {
  const m = S.messages.find(x => x.id === mid);
  if (!m || m.local || m.failed) return;
  // Смайлик встаёт на место СРАЗУ, ещё до ответа сервера: именно ожидание
  // ответа и перерисовка всей истории и давали паузу в 8–10 секунд.
  const before = m.reactions ? JSON.parse(JSON.stringify(m.reactions)) : null;
  const rx = Object.assign({}, m.reactions || {});
  const had = (rx[emoji] || []).includes(S.me.id);
  const arr = (rx[emoji] || []).filter(x => x !== S.me.id);
  if (!had) arr.push(S.me.id);
  if (arr.length) rx[emoji] = arr; else delete rx[emoji];
  m.reactions = rx; m.reactTs = Date.now(); m.reactBy = S.me.id;
  paintReactions(m);
  try {
    const r = await api('/api/messages/' + mid + '/react', { method: 'POST', body: { emoji, notify: 1 } });
    if (r && r.reactions !== undefined) m.reactions = r.reactions;
    if (r && r.rev !== undefined) m.rev = r.rev;
    if (r && r.reactTs) m.reactTs = r.reactTs;
    if (r && r.usage) S.usage = r.usage;
    paintReactions(m);
    if (r && r.notify) fireNotify(r.notify);
    sync().catch(() => {});          // фон: добираем чужие реакции, экран не ждёт
  } catch (ex) {
    m.reactions = before;            // откатываем, если сервер не принял
    paintReactions(m);
    toast(ex.message, true);
  }
}

// ─────────────────────────────────────────── правка своего сообщения
function openEditor(mid) {
  const m = S.messages.find(x => x.id === mid);
  if (!m || m.uid !== S.me.id) return;
  const el = document.getElementById('m-' + mid);
  if (!el || el.dataset.editing) return;
  el.classList.add('editing');
  const p = S.plain.get(mid) || {};
  const bubble = el.querySelector('.bubble');
  if (!bubble) return;
  el.dataset.editing = '1';
  const old = bubble.outerHTML;
  bubble.outerHTML = `<div class="edit-box">
    <textarea id="ed-${mid}" class="edit-area" maxlength="4000">${escapeHtml(p.text || '')}</textarea>
    <div class="edit-row">
      <button class="mini" id="edc-${mid}">Отмена</button>
      <button class="mini primary" id="eds-${mid}">Сохранить</button>
    </div>
  </div>`;
  const ta = $('#ed-' + mid);
  ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px';   // текст виден целиком, без полосы прокрутки
  ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
  ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; });
  $('#edc-' + mid).addEventListener('click', () => {
    const box = ta.closest('.edit-box');
    if (box) box.outerHTML = old;
    delete el.dataset.editing;
    el.classList.remove('editing');
  });
  $('#eds-' + mid).addEventListener('click', async () => {
    const text = ta.value.trim();
    if (!text) return toast('Пустое сообщение', true);
    const prev = { plain: S.plain.get(mid), blob: m.blob, bytes: m.bytes, editedAt: m.editedAt, rev: m.rev };
    try {
      const c = chatById(m.chat);
      const k = await chatKeyOf(c);
      const mentions = findMentions(text);
      const blob = await encryptJSON(k.key, { text, mentions, author: S.me.name });
      // Новый текст показываем СРАЗУ, ещё до ответа сервера: именно ожидание
      // ответа и перерисовка всей истории давали паузу в 8–10 секунд.
      S.plain.set(mid, Object.assign({}, prev.plain || {}, { text, mentions }));
      m.blob = blob; m.bytes = blob.length; m.editedAt = Date.now(); m.rev = (m.rev || 0) + 1;
      S.sig = ''; renderMessages(); renderThread();
      toast('Сохраняем правку…');
      try {
        await api('/api/messages/' + mid + '/edit', { method: 'POST', body: { blob } });
        toast('Сообщение изменено');
        sync().catch(() => {});      // остальным правка придёт точечно, журналом изменений
      } catch (ex) {
        // сервер не принял — возвращаем прежний текст, чтобы не врать на экране
        if (prev.plain) S.plain.set(mid, prev.plain); else S.plain.delete(mid);
        m.blob = prev.blob; m.bytes = prev.bytes; m.editedAt = prev.editedAt; m.rev = prev.rev;
        S.sig = ''; renderMessages(); renderThread();
        toast(ex.message || 'Правка не сохранилась', true);
      }
    } catch (ex) { toast(ex.message, true); }
  });
}

// ─────────────────────────────────────────── крупный просмотр аватара и статус
function openAvatarView(userId) {
  const u = userById(userId) || (S.me && S.me.id === userId ? S.me : null);
  if (!u) return;
  const me = u.id === S.me.id;
  const av = avatarCache.get(u.id);
  const inner = (u.avatar && av) ? `<img src="${av.src}" alt="">` : escapeHtml(initials(u.name));
  modal((me ? 'Ваш профиль' : u.name), `
    <div class="lb-ava" style="background:${avColor(u.id)}">${inner}</div>
    <div style="text-align:center;font-weight:600;font-size:16px">${escapeHtml(u.name)}${u.isAdmin ? '<span class="tag-admin">адм</span>' : ''}</div>
    <div class="tiny muted" style="text-align:center;margin-top:3px">${isOnline(u) ? 'в сети' : 'был(а) ' + escapeHtml(fmtAgo(u.lastSeen))}${u.status ? ' · ' + escapeHtml(u.status) : ''}</div>
    ${me ? '<button class="primary soft" id="lb-status" style="margin-top:14px">Изменить статус</button>' : ''}`);
  const bs = $('#lb-status');
  if (bs) bs.addEventListener('click', () => { hide($('#modal')); openProfileWithStatus(); });
}
document.addEventListener('click', e => {
  const av = e.target.closest('.av-wrap');
  if (!av) return;
  const host = av.closest('.msg, #me-box, #topbar, .mention-item');
  if (!host) return;
  e.stopPropagation();
  const img = av.querySelector('.avatar');
  const uid = av.dataset.uid || (host.classList && host.classList.contains('msg') ? null : null);
  if (uid) return openAvatarView(uid);
  // определяем автора по сообщению
  const msgEl = av.closest('.msg');
  if (msgEl) {
    const m = S.messages.find(x => 'm-' + x.id === msgEl.id);
    if (m) return openAvatarView(m.uid);
  }
  if (av.closest('#me-box')) return openAvatarView(S.me.id);
});

// ─────────────────────────────────────────── фон и иконка чата (общие для участников)
const wallCache = new Map(), iconCache = new Map();
async function chatKey(c) { const k = await chatKeyOf(c); return k ? k.key : null; }
async function fetchWall(c) {
  if (!c || !c.wallRev) return null;
  const hit = wallCache.get(c.id);
  if (hit && hit.rev === c.wallRev) return hit.data;
  try {
    const r = await api('/api/wall/' + encodeURIComponent(c.id) + '?rev=' + encodeURIComponent(c.wallRev || ''));
    const key = await chatKey(c);
    const data = (r.wall && key) ? (await decryptJSON(key, r.wall)).data : null;
    wallCache.set(c.id, { rev: c.wallRev, data });
    return data;
  } catch (e) { return null; }
}
async function fetchIcon(c) {
  if (!c || !c.iconRev) return null;
  const hit = iconCache.get(c.id);
  if (hit && hit.rev === c.iconRev) return hit.data;
  try {
    const r = await api('/api/chaticon/' + encodeURIComponent(c.id) + '?rev=' + encodeURIComponent(c.iconRev || ''));
    const key = await chatKey(c);
    const data = (r.icon && key) ? (await decryptJSON(key, r.icon)).data : null;
    iconCache.set(c.id, { rev: c.iconRev, data });
    S.sig = ''; renderAll();
    return data;
  } catch (e) { return null; }
}
function patSvg(kind) {
  const s = 'rgba(255,255,255,.28)';
  const body = {
    dots: `<circle cx='6' cy='6' r='1.4' fill='${s}'/><circle cx='18' cy='18' r='1.4' fill='${s}'/>`,
    diag: `<path d='M-4 8 L8 -4 M4 20 L20 4 M12 28 L28 12' stroke='${s}' stroke-width='1.4'/>`,
    grid: `<path d='M0 8 H24 M0 16 H24 M8 0 V24 M16 0 V24' stroke='${s}' stroke-width='1'/>`,
    waves: `<path d='M0 8 q6 -5 12 0 t12 0 M0 18 q6 -5 12 0 t12 0' stroke='${s}' stroke-width='1.4' fill='none'/>`
  }[kind] || '';
  return `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24'>${body}</svg>`)}")`;
}
async function applyWallBackground() {
  const box = $('#messages'), c = curChat();
  if (!c || !c.wall || c.wall.type === 'none') { box.style.background = ''; return; }
  // страховка: цвета могли не сохраниться в старых версиях — подставляем дефолт
  const w = Object.assign({ type: 'grad', c1: '#eef2f4', c2: '#e8f4fe', a: 165, pat: 'dots' }, c.wall);
  const grad = `linear-gradient(${w.a}deg, ${w.c1}, ${w.c2})`;
  if (w.type === 'grad') { box.style.background = grad; return; }
  if (w.type === 'pat') { box.style.background = `${patSvg(w.pat)} repeat, ${grad}`; return; }
  const data = await fetchWall(c);
  box.style.background = data ? `linear-gradient(165deg, ${w.c1}22, ${w.c2}55), url(${data}) center/cover no-repeat` : grad;
}
function wallEditor(c) {
  const w = c.wall || { type: 'grad', c1: '#eef2f4', c2: '#e8f4fe', a: 165, pat: 'dots' };
  modal('Фон и гамма · ' + chatTitle(c), `
    <div class="seg" id="w-tabs">
      <button class="tab ${w.type === 'grad' || w.type === 'none' ? 'active' : ''}" data-wt="grad">Рендер</button>
      <button class="tab ${w.type === 'pat' ? 'active' : ''}" data-wt="pat">Узор</button>
      <button class="tab ${w.type === 'photo' ? 'active' : ''}" data-wt="photo">Фото</button>
    </div>
    <div id="w-grad" class="${w.type === 'pat' || w.type === 'photo' ? 'hidden' : ''}">
      <label>Откуда<input type="color" id="w-c1" value="${w.c1}"></label>
      <label>Куда<input type="color" id="w-c2" value="${w.c2}"></label>
      <label>Направление · <span id="w-a-val">${w.a}°</span><input type="range" id="w-a" min="0" max="360" value="${w.a}"></label>
    </div>
    <div id="w-pat" class="${w.type === 'pat' ? '' : 'hidden'}">
      <div class="pat-grid" id="w-pats">
        ${['dots', 'diag', 'grid', 'waves'].map(p => `<button class="pat ${w.pat === p ? 'on' : ''}" data-pat="${p}" style="background:${p === 'dots' ? 'radial-gradient(rgba(255,255,255,.6) 1.5px, transparent 1.6px)' : p === 'diag' ? 'repeating-linear-gradient(45deg, rgba(255,255,255,.5) 0 2px, transparent 2px 8px)' : p === 'grid' ? 'repeating-linear-gradient(0deg, rgba(255,255,255,.4) 0 1px, transparent 1px 8px), repeating-linear-gradient(90deg, rgba(255,255,255,.4) 0 1px, transparent 1px 8px)' : 'repeating-radial-gradient(circle at 0 8px, rgba(255,255,255,.4) 0 2px, transparent 2px 8px)'};background-color:#5c6f7c"></button>`).join('')}
      </div>
    </div>
    <div id="w-photo" class="${w.type === 'photo' ? '' : 'hidden'}">
      <label class="file-btn" for="w-file">Выбрать фотографию</label>
      <input type="file" id="w-file" accept="image/*" hidden>
      <div class="tiny muted" style="margin-top:6px">фото хранится в зашифрованном виде и видно всем участникам</div>
      ${c.wallRev ? '<button class="mini danger" id="w-photo-del" style="margin-top:8px">Убрать фото</button>' : ''}
    </div>
    <div class="divider"><span>Моя гамма на этом устройстве</span></div>
    <div class="pals" id="w-pals">${PALS.map(p => `<span class="pal ${currentPal() === p.id ? 'on' : ''}" data-pal="${p.id}" title="${p.name}" style="background:linear-gradient(135deg,${p.c1},${p.c2})"></span>`).join('')}</div>
    <p class="hint">Фон видят одинаково все участники чата, менять может любой. Гамма — личная настройка устройства.</p>`);
  const state = Object.assign({}, w);
  const rerender = async () => {
    const box = $('#messages');
    const grad = `linear-gradient(${state.a}deg, ${state.c1}, ${state.c2})`;
    if (state.type === 'pat') box.style.background = `${patSvg(state.pat)} repeat, ${grad}`;
    else if (state.type !== 'photo') box.style.background = grad;
  };
  $('#w-tabs').addEventListener('click', e => {
    const t = e.target.closest('[data-wt]'); if (!t) return;
    state.type = t.dataset.wt;
    $$('#w-tabs .tab').forEach(x => x.classList.toggle('active', x === t));
    $('#w-grad').classList.toggle('hidden', state.type === 'photo');
    $('#w-pat').classList.toggle('hidden', state.type !== 'pat');
    $('#w-photo').classList.toggle('hidden', state.type !== 'photo');
    rerender();
  });
  $('#w-c1').addEventListener('input', e => { state.c1 = e.target.value; rerender(); });
  $('#w-c2').addEventListener('input', e => { state.c2 = e.target.value; rerender(); });
  $('#w-a').addEventListener('input', e => { state.a = Number(e.target.value); $('#w-a-val').textContent = state.a + '°'; rerender(); });
  $('#w-pats').addEventListener('click', e => {
    const p = e.target.closest('[data-pat]'); if (!p) return;
    state.pat = p.dataset.pat; state.type = 'pat';
    $$('#w-pats .pat').forEach(x => x.classList.toggle('on', x === p));
    rerender();
  });
  $('#w-pals').addEventListener('click', e => {
    const b = e.target.closest('[data-pal]'); if (!b) return;
    applyPalette(b.dataset.pal);
    $$('#w-pals .pal').forEach(x => x.classList.toggle('on', x === b));
  });
  $('#w-file').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const data = await resizeImage(f, 1600, 0.8);
      const key = await chatKey(c);
      await api('/api/chats/' + c.id + '/wallphoto', { method: 'POST', body: { data: await encryptJSON(key, { data }) } });
      wallCache.delete(c.id);
      S.sig = ''; await sync();
      toast('Фото фона установлено для всех участников');
    } catch (ex) { toast(ex.message, true); }
  });
  const del = $('#w-photo-del');
  if (del) del.addEventListener('click', async () => {
    await api('/api/chats/' + c.id + '/wallphoto', { method: 'POST', body: { data: null } });
    wallCache.delete(c.id); S.sig = ''; await sync(); toast('Фото фона убрано');
  });
  // сохранение параметров фона при закрытии окна
  const box = $('#modal');
  const obs = new MutationObserver(async () => {
    if (!box.classList.contains('hidden')) return;
    obs.disconnect();
    try {
      await api('/api/chats/' + c.id + '/wall', { method: 'POST', body: { wall: state } });
      S.sig = ''; await sync();
    } catch (ex) { toast(ex.message, true); }
  });
  obs.observe(box, { attributes: true, attributeFilter: ['class'] });
}
function iconEditor(c) {
  modal('Иконка чата · ' + chatTitle(c), `
    <div class="avatar-pick">
      <span id="ic-prev" class="avatar group lg" style="background:${avColor(c.id)}">${escapeHtml(initials(chatTitle(c)))}</span>
      <div>
        <label class="file-btn" for="ic-file">Загрузить фото</label>
        <input type="file" id="ic-file" accept="image/*" hidden>
        <div class="tiny muted" style="margin-top:6px">обрезается в квадрат, шифруется; видят все участники</div>
        ${c.iconRev ? '<button class="mini danger" id="ic-del" style="margin-top:8px">Убрать иконку</button>' : ''}
      </div>
    </div>
    <p class="hint">Иконку группового чата может поставить любой участник — как и название и фон.</p>`);
  const prev = iconCache.get(c.id);
  if (prev && prev.data) $('#ic-prev').innerHTML = `<img src="${prev.data}" alt="">`;
  $('#ic-file').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const data = await cropSquare(f, 160);
      const key = await chatKey(c);
      await api('/api/chats/' + c.id + '/icon', { method: 'POST', body: { data: await encryptJSON(key, { data }) } });
      iconCache.delete(c.id); S.sig = ''; await sync(); toast('Иконка чата обновлена');
    } catch (ex) { toast(ex.message, true); }
  });
  const del = $('#ic-del');
  if (del) del.addEventListener('click', async () => {
    await api('/api/chats/' + c.id + '/icon', { method: 'POST', body: { data: null } });
    iconCache.delete(c.id); S.sig = ''; await sync(); toast('Иконка убрана');
  });
}

// ─────────────────────────────────────────── медиа на устройстве (меню «⋯»)
async function openMediaManager() {
  const list = await idb.all();
  const total = list.reduce((a, [, v]) => a + (v.size || (v.blob && v.blob.size) || 0), 0);
  modal('Медиа на устройстве', `
    <div class="tiny muted">Здесь лежат уже загруженные видео, фото и файлы: открываются мгновенно,
    без обращения к облаку. Занимают на этом устройстве: ${fmtBytes(total)}.</div>
    ${list.length ? list.map(([id, v]) => `
      <div class="archive-row">
        <div style="flex:1;min-width:0">
          <div>${escapeHtml(v.name || id)}</div>
          <div class="tiny muted">${fmtBytes(v.size || (v.blob && v.blob.size) || 0)} · ${(v.mime || '').split('/')[0] || 'файл'} · ${new Date(v.ts || Date.now()).toLocaleDateString('ru-RU')}</div>
        </div>
        <button class="mini" data-media-open="${escapeHtml(id)}" title="Открыть">${SV(ICONS.play)}</button>
        <button class="mini danger" data-media-del="${escapeHtml(id)}" title="Удалить из памяти устройства">${SV(ICONS.trash)}</button>
      </div>`).join('') : '<p class="hint">Пока пусто: откройте видео или файл в чате — и они появятся здесь.</p>'}
    ${list.length ? '<button class="primary soft danger" id="media-clear" style="margin-top:10px">Очистить всё</button>' : ''}`);
  void 0;
}
document.addEventListener('click', async e => {
    const op = e.target.closest('[data-media-open]');
    if (op) {
      const rec = await idb.get(op.dataset.mediaOpen);
      if (!rec) return;
      const url = mediaUrl(op.dataset.mediaOpen, rec.blob);
      if ((rec.mime || '').startsWith('image/')) {
        const lb = document.createElement('div'); lb.className = 'lightbox';
        lb.innerHTML = `<img src="${url}" alt="">`; lb.onclick = () => lb.remove();
        document.body.appendChild(lb);
      } else window.open(url, '_blank');
      return;
    }
    const dl = e.target.closest('[data-media-del]');
    if (dl) {
      const id = dl.dataset.mediaDel;
      await idb.del(id);
      const u = mediaUrls.get(id); if (u) { URL.revokeObjectURL(u); mediaUrls.delete(id); }
      hide($('#modal')); openMediaManager();
      return;
    }
    if (e.target.closest('#media-clear')) {
      if (!confirm('Удалить все закэшированные медиа с этого устройства?')) return;
      for (const [id] of await idb.all()) await idb.del(id);
      for (const u of mediaUrls.values()) URL.revokeObjectURL(u);
      mediaUrls.clear();
      hide($('#modal')); openMediaManager();
    }
});
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
// ─────────────────────────────────────────── меню чата «⋯»: выпадающий список, как в макете
function closeDrop() { hide($('#drop')); }
$('#btn-chat-menu').addEventListener('click', e => {
  e.stopPropagation();
  const c = curChat();
  if (!c) return;
  const d = $('#drop');
  const willOpen = d.classList.contains('hidden');
  d.classList.toggle('hidden');
  if (willOpen) {
    d.querySelector('[data-act="leave"]').classList.toggle('hidden', c.kind !== 'group');
    d.querySelector('[data-act="icon"]').classList.toggle('hidden', c.kind !== 'group');
  }
});
document.addEventListener('click', e => {
  if (!e.target.closest('#drop, #btn-chat-menu')) closeDrop();
});
$('#drop').addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  closeDrop();
  if (b.dataset.act === 'media') { openMediaManager(); return; }
  const c = curChat();
  if (!c) return;
  if (b.dataset.act === 'info') return openChatInfo(c);
  if (b.dataset.act === 'copy') { exportHtml(c); return; }
  if (b.dataset.act === 'wall') return wallEditor(c);
  if (b.dataset.act === 'icon') return iconEditor(c);
  if (b.dataset.act === 'clear') return clearChatFlow(c);
  if (b.dataset.act === 'leave') return leaveChatFlow(c);
});

/** «Очистить чат»: сначала предлагаем сохранить копию, затем удаляем историю из облака. */
function clearChatFlow(c) {
  if (c.kind === 'group' && !isOwner(c)) return toast('Очистить групповой чат может только создатель', true);
  modal('Очистить чат «' + chatTitle(c) + '»', `
    <p class="hint">История этого чата будет удалена из облака безвозвратно и перестанет
    занимать место на сервере — шкала «Память сервера» сразу покажет освобождение.
    Участники увидят надпись, кто и когда очистил чат. Другие чаты не пострадают.</p>
    <div class="divider"><span>Сначала сохраните копию (необязательно)</span></div>
    <button class="primary" id="cl-html">${SV(ICONS.download)} Скачать копию (HTML с поиском)</button>
    <button class="primary soft" id="cl-json" style="margin-top:8px">${SV(ICONS.download)} Скачать копию (JSON)</button>
    <label class="row-check" style="margin-top:14px"><input type="checkbox" id="cl-ok">
      <span>Я понимаю, что история этого чата удалится из облака навсегда</span></label>
    <div class="err" id="cl-err"></div>
    <button class="primary soft danger" id="cl-go">${SV(ICONS.trash)} Очистить чат</button>`);
  $('#cl-html').addEventListener('click', () => exportHtml(c));
  $('#cl-json').addEventListener('click', () => exportJson(c));
  $('#cl-go').addEventListener('click', async () => {
    if (!$('#cl-ok').checked) { $('#cl-err').textContent = 'Отметьте, что понимаете последствия'; return; }
    try {
      const r = await api('/api/chats/' + c.id + '/clear', { method: 'POST', body: {} });
      hide($('#modal'));
      S.sig = ''; await sync(); renderMessages(true);
      toast('Чат очищен: удалено ' + plural(r.cleared, 'сообщение', 'сообщения', 'сообщений') + ', место освобождено');
    } catch (ex) { toast(ex.message, true); }
  });
}

function openChatInfo(c) {
  const owner = isOwner(c);
  modal('Чат «' + chatTitle(c) + '»', `
    <div class="tiny muted">${plural(c.count, 'сообщение', 'сообщения', 'сообщений')} · ${fmtBytes(c.bytes)}</div>
    <label class="row-check menu-switch"><input type="checkbox" id="cm-mute" ${isChatMuted(c.id) ? 'checked' : ''}> <span>Без звука для этого чата</span></label>
    ${owner ? `<div class="divider"><span>Название чата</span></div>
      <label>Как называть чат<input type="text" id="cm-title" value="${escapeHtml(chatTitle(c))}" maxlength="60"></label>
      <button class="primary soft" id="cm-rename">Переименовать</button>` : ''}
    <p class="hint">Название и переписка шифруются ключом этого чата. Менять название может создатель чата.</p>`);
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
}

async function leaveChatFlow(c) {
  const owner = isOwner(c);
  const confirmLeave = (owner && c.members.length > 1)
    ? 'Покинуть чат? Вы перестанете видеть его сообщения, а права создателя перейдут другому участнику.'
    : 'Покинуть чат? Вы перестанете видеть его сообщения.';
  if (!confirm(confirmLeave)) return;
  try {
    await api('/api/chats/' + c.id + '/leave', { method: 'POST', body: {} });
    hide($('#modal')); S.view = null; S.sig = ''; await sync(); renderMessages(true); toast('Вы покинули чат');
  } catch (ex) { toast(ex.message, true); }
}

// ─────────────────────────────────────────── кодовое слово мессенджера
const codeProofOf = async word => {
  // соль комнаты могла не подтянуться на самом первом запуске (до создания мессенджера)
  if (!S.codeProofSalt) {
    try { S.codeProofSalt = (await api('/api/state')).codeProofSalt || null; } catch (e) {}
  }
  return toHex(await pbkdf2(word, S.codeProofSalt));
};
/** Просит кодовое слово и проверяет его на сервере; неверное — красная ошибка в окне. */
function askCodeword(title, subtitle, repeat) {
  return new Promise((resolve, reject) => {
    modal(title, `
      <p class="hint">${subtitle}</p>
      <label>Кодовое слово<input type="password" id="cw1" autocomplete="off" placeholder="то же, что при регистрации"></label>
      ${repeat ? '<label>Повторите кодовое слово<input type="password" id="cw2" autocomplete="off"></label>' : ''}
      <div class="err" id="cw-err"></div>
      <button class="primary" id="cw-go">Продолжить</button>`);
    $('#cw1').focus();
    $('#cw-go').addEventListener('click', async () => {
      const err = $('#cw-err');
      err.textContent = '';
      const w = $('#cw1').value;
      if (w.length < 6) { err.textContent = 'Кодовое слово короче 6 символов'; return; }
      if (repeat && w !== $('#cw2').value) { err.textContent = 'Кодовые слова не совпадают'; return; }
      try {
        await api('/api/code/check', { method: 'POST', body: { codeProof: await codeProofOf(w) } });
      } catch (ex) { err.textContent = ex.message || 'Неверное кодовое слово'; return; }
      hide($('#modal'));
      resolve(w);
    });
  });
}

// ─────────────────────────────────────────── архивы на сервере
async function archiveCreateFlow(c) {
  const word = await askCodeword('Архив на сервере…',
    'Архив ляжет в облако в зашифрованном виде, а доступ к нему получит только тот, кто знает кодовое слово мессенджера. Слово одно на все архивы; если администратор сменит его, новые архивы будут открываться новым словом.',
    true).catch(() => null);
  if (!word) return;
  const confirmMsg = c.kind === 'dm'
    ? 'Сохранить архив переписки на сервере и очистить историю в облаке?'
    : 'Сохранить архив чата на сервере и очистить переписку в облаке?';
  if (!confirm(confirmMsg)) return;
  try {
    const r = await api('/api/chats/' + c.id + '/archive', { method: 'POST', body: { reset: true, codeProof: await codeProofOf(word) } });
    hide($('#modal')); S.sig = ''; await sync(); renderMessages(true);
    toast('Архив создан: ' + plural(r.archive.count, 'сообщение', 'сообщения', 'сообщений') + ' сохранено в облаке');
  } catch (ex) { toast(ex.message, true); }
}

async function fetchArchiveEnv(rec, word) {
  const res = await fetch(BASE + '/api/archives/' + encodeURIComponent(rec.file), {
    headers: { Authorization: 'Bearer ' + S.token, 'X-Code-Proof': await codeProofOf(word) }
  });
  if (!res.ok) {
    let msg = 'Не удалось скачать архив (HTTP ' + res.status + ')';
    try {
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('json')) { const j = await res.json(); if (j && j.error) msg = j.error; }
    } catch (e) {}
    if (res.status === 403 && msg.indexOf('кодовое слово') === -1) msg = 'Неверное кодовое слово';
    throw new Error(msg);
  }
  return JSON.parse(await res.text());
}

/** Расшифровывает сообщения архива ключом чата и приводит их к виду списка для HTML-страницы. */
async function archiveRows(payload) {
  const meta = payload.chat || {};
  const c = chatById(meta.id) || { id: meta.id, kind: meta.kind, members: meta.members || [] };
  const { key } = await chatKeyOf(c);
  const names = new Map((payload.users || []).map(u => [u.id, u.name]));
  const label = c.kind === 'dm'
    ? 'Лично: ' + ((names.get((meta.members || []).find(x => x !== S.me.id)) || 'Личная переписка'))
    : (S.chatTitles.get(c.id) || meta.titlePlain || 'Групповой чат');
  const rows = [];
  for (const m of payload.messages || []) {
    let p = {};
    try { p = await decryptJSON(key, m.blob); } catch (e) { p = { text: '…' }; }
    rows.push({
      id: m.id, parent: m.parent || null, quote: m.quote || null, ts: m.ts,
      time: new Date(m.ts).toLocaleString('ru-RU'),
      chat: label + (m.parent ? ' · комментарий' : ''),
      author: names.get(m.uid) || (userById(m.uid) || {}).name || p.author || 'Бывший участник',
      text: p.text || '', image: (typeof p.att === 'string' ? p.att : (p.att && p.att.kind === 'image' ? p.att.data : null))
    });
  }
  rows.sort((a, b) => a.ts - b.ts);
  return rows;
}

async function archivesFlow(c) {
  let list = [];
  try { list = (await api('/api/chats/' + c.id + '/archives')).archives; } catch (e) { toast(e.message, true); return; }
  S.arcList = list;
  modal('Архивы · ' + chatTitle(c), list.length ? list.map(a => `
    <div class="archive-row${a.hasContent === false ? ' ghost' : ''}">
      <div style="flex:1;min-width:0">
        <div>${new Date(a.createdAt).toLocaleString('ru-RU')}</div>
        <div class="tiny muted">${plural(a.count, 'сообщение', 'сообщения', 'сообщений')} · ${fmtBytes(a.bytes)} · ${a.hasContent === false ? 'тело отсутствует (удалено старым кодом) — можно только удалить запись' : 'зашифрован'}</div>
      </div>
      ${a.hasContent === false ? '' : `
      <button class="mini" data-arc-view="${a.file}" title="Открыть HTML-страницу с поиском">${SV(ICONS.search)}</button>
      <button class="mini" data-arc-dl="${a.file}" title="Скачать HTML-страницу с поиском">${SV(ICONS.download)}</button>
      <button class="mini" data-arc-restore="${a.file}" title="Вернуть сообщения в чат">${SV(ICONS.restore)}</button>`}
      <button class="mini danger" data-arc-del="${a.file}" title="Удалить запись с сервера">${SV(ICONS.trash)}</button>
    </div>`).join('')
    : '<p class="hint">Архивов пока нет. Создать: меню «⋯» → «Архив на сервере…».</p>');
}

/** Единая обработка кнопок архивов (вешается один раз). */
$('#modal-body').addEventListener('click', async e => {
  const btn = e.target.closest('[data-arc-view],[data-arc-dl],[data-arc-restore],[data-arc-del]');
  if (!btn) return;
  const rec = (S.arcList || []).find(a => a.file === (btn.dataset.arcView || btn.dataset.arcDl || btn.dataset.arcRestore || btn.dataset.arcDel));
  if (!rec) return;
  const c = chatById(rec.chat);
  try {
    if (btn.dataset.arcDel) {
      if (!confirm('Удалить архив с сервера безвозвратно? Место в базе освободится.')) return;
      const res = await fetch(BASE + '/api/archives/' + encodeURIComponent(rec.file), { method: 'DELETE', headers: { Authorization: 'Bearer ' + S.token } });
      if (!res.ok) throw new Error((await res.json()).error || 'Не удалось удалить');
      S.sig = ''; await sync();
      toast('Архив удалён, место освобождено');
      if (c) return archivesFlow(c);
      hide($('#modal'));
      return;
    }
    if (btn.dataset.arcRestore) {
      const word = await askCodeword('Восстановить архив', 'Введите кодовое слово мессенджера — сообщения вернутся в чат.', false).catch(() => null);
      if (!word) return;
      const r = await api('/api/chats/' + rec.chat + '/restore', { method: 'POST', body: { file: rec.file, codeProof: await codeProofOf(word) } });
      hide($('#modal')); S.sig = ''; await sync(); renderMessages(true);
      toast('Восстановлено сообщений: ' + r.restored);
      return;
    }
    // просмотр или скачивание HTML-страницы с поиском
    const word = await askCodeword('Открыть архив', 'Архив зашифрован кодовым словом мессенджера.', false).catch(() => null);
    if (!word) return;
    const env = await fetchArchiveEnv(rec, word);
    const rows = await archiveRows(env);
    const html = archivePageHtml((c ? chatTitle(c) : 'Архив'), rows);
    if (btn.dataset.arcDl) {
      saveBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), 'sega-archive-' + rec.file.replace(/^archive-/, '').replace(/\.json$/, '') + '.html');
      toast('Страница архива скачана — поиск работает без интернета');
      return;
    }
    modal('Архив · ' + (c ? chatTitle(c) : ''), `<iframe class="arc-frame" id="arc-frame"></iframe>
      <button class="primary soft" id="arc-dl">${SV(ICONS.download)} Скачать эту страницу</button>`);
    $('#arc-frame').srcdoc = html;
    $('#arc-dl').addEventListener('click', () => {
      saveBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), 'sega-archive-' + rec.file.replace(/^archive-/, '').replace(/\.json$/, '') + '.html');
    });
  } catch (ex) { toast(ex.message, true); }
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
async function uploadChunked(file, c, att) {
  const k = await chatKeyOf(c);
  if (!k) throw new Error('Нет ключа чата для шифрования вложения');
  toast('Шифруем «' + (att.name || '') + '»…');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const enc = await aesEncryptBytes(k.key, bytes);
  const CH = 900000;
  const parts = Math.max(1, Math.ceil(enc.length / CH));
  const init = await api('/api/upload/init', { method: 'POST', body: { chat: c.id, name: att.name, size: file.size, mime: att.mime, parts } });
  for (let i = 0; i < parts; i++) {
    await api('/api/upload/chunk', { method: 'POST', body: { upId: init.upId, i, data: enc.slice(i * CH, (i + 1) * CH) } });
    toast('Загружено ' + Math.round((i + 1) / parts * 100) + '%');
  }
  await api('/api/upload/fin', { method: 'POST', body: { upId: init.upId, stored: enc.length } });
  return { kind: att.kind, upId: init.upId, parts, name: att.name, size: file.size, mime: att.mime };
}
async function loadUpload(el) {
  const upId = el.dataset.upl, parts = Math.max(1, Number(el.dataset.parts) || 1);
  let rec = await idb.get(upId);
  if (!rec) {
    const c = curChat();
    const k = await chatKeyOf(c);
    let enc = '';
    for (let i = 0; i < parts; i++) {
      const r = await api('/api/upload/' + encodeURIComponent(upId) + '/' + i);
      enc += r.data;
      const pr = el.querySelector('.tiny');
      if (pr) pr.textContent = 'загружено ' + Math.round((i + 1) / parts * 100) + '%';
    }
    const bytes = await aesDecryptBytes(k.key, enc);
    rec = {
      blob: new Blob([bytes], { type: el.dataset.mime || 'application/octet-stream' }),
      kind: el.dataset.kind, name: el.dataset.name || 'file',
      size: Number(el.dataset.size) || 0, mime: el.dataset.mime || '', ts: Date.now()
    };
    await idb.put(upId, rec);
  }
  el.outerHTML = mediaPlayerHtml(rec, upId);
}
/** После перерисовки ленты уже закэшированные медиа подставляются сами, без клика. */
async function upgradeMedia(box) {
  const nodes = [...box.querySelectorAll('[data-upl]')];
  for (const el of nodes) {
    const rec = await idb.get(el.dataset.upl);
    if (rec && document.contains(el)) el.outerHTML = mediaPlayerHtml(rec, el.dataset.upl);
  }
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
  let attRef = att;
  if (att && att.pending) {
    try { attRef = await uploadChunked(att.file, c, att); }
    catch (ex) { toast(ex.message, true); textarea.value = text; return; }
  }
  const payload = { v: 1, text, author: S.me.name, mentions: findMentions(text) };
  if (attRef) payload.att = attRef;
  textarea.value = ''; autoGrow(textarea);
  clearAttach(attachKey);
  if (!parent) { S.quote = null; renderQuoteBar(); }

  // Сообщение появляется в ленте СРАЗУ (с часиками «отправляется»), а не после
  // ответа сервера: раньше человек смотрел на пустое место две-три секунды.
  let blob;
  try { blob = await encryptJSON(k.key, payload); }
  catch (ex) { return sendFail(ex, text, att, attachKey, quote); }
  const tmpId = 'tmp' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const draft = {
    id: tmpId, seq: nextLocalSeq(), uid: S.me.id, ts: Date.now(),
    blob, bytes: blob.length, chat: c.id, parent: parent || null, quote: quote || null,
    upId: (attRef && attRef.upId) || null, local: true
  };
  S.retry[tmpId] = { blob, chat: c.id, parent: parent || null, quote: quote || null, payload };
  addMessages([draft]);
  S.plain.set(tmpId, payload);
  S.atBottom = true; S.sig = '';
  renderMessages(true); renderRail();
  postMessage(draft, text, att, attachKey, quote);
}

/** Локальный номер для «своего» сообщения — только чтобы встать в конец ленты. */
let localSeqTop = 0;
function nextLocalSeq() {
  let top = S.seq || 0;
  for (const m of S.messages) if ((m.seq || 0) > top) top = m.seq;
  localSeqTop = Math.max(localSeqTop, top) + 1;
  return localSeqTop;
}

/** Отправить черновик на сервер и заменить его настоящей записью. */
async function postMessage(draft, text, att, attachKey, quote) {
  const body = Object.assign({ notify: 1 }, S.retry[draft.id] || {});
  try {
    const r = await api('/api/messages', { method: 'POST', body });
    adoptSent(draft, r.message, S.retry[draft.id] && S.retry[draft.id].payload);
    if (r.usage) S.usage = r.usage;
    if (r.notify) fireNotify(r.notify);
    S.sig = '';
    renderMessages();
    sync().catch(() => {});          // добираем чужие сообщения фоном
  } catch (ex) {
    const keep = S.retry[draft.id];
    draft.local = false; draft.failed = ex.message || 'не отправлено';
    if (!keep) delete S.retry[draft.id];
    S.sig = ''; renderMessages();
    toast(ex.message, true);
    if (!keep) {                     // повторять нечего — возвращаем текст в поле
      const ta = $('#input');
      if (ta && !ta.value && text) { ta.value = text; autoGrow(ta); }
      if (att && !att.pending && attachKey) { S[attachKey] = att; showAttach(attachKey, att); }
      if (quote) { S.quote = quote; renderQuoteBar(); }
    }
  }
}

/** Сервер принял сообщение: подменяем черновик настоящей записью. */
function adoptSent(draft, real, plain) {
  delete S.retry[draft.id];
  if (!real || !real.id) return;
  S.messageIds.delete(draft.id);
  S.plain.delete(draft.id);
  const i = S.messages.findIndex(m => m.id === draft.id);
  if (i >= 0) S.messages[i] = real; else S.messages.push(real);
  S.messageIds.add(real.id);
  if (plain) S.plain.set(real.id, plain);
  S.messages.sort((a, b) => a.seq - b.seq);
  // курсор since НЕ двигаем: пусть его выставит ответ сервера, иначе можно
  // пропустить чужое сообщение, прилетевшее в ту же секунду
}

/** Повторная отправка после сбоя (кнопка «повторить» под сообщением). */
function retrySend(tmpId) {
  const m = S.messages.find(x => x.id === tmpId);
  const rec = S.retry[tmpId];
  if (!m || !rec) return;
  delete m.failed; m.local = true;
  S.sig = ''; renderMessages();
  postMessage(m);
}

function sendFail(ex, text, att, attachKey, quote) {
  toast(ex.message, true);
  const ta = $('#input');
  if (ta && !ta.value && text) { ta.value = text; autoGrow(ta); }
  if (att && !att.pending && attachKey) { S[attachKey] = att; showAttach(attachKey, att); }
  if (quote) { S.quote = quote; renderQuoteBar(); }
}

/**
 * Просьба серверу разослать уведомления. Делается отдельным коротким запросом
 * сразу после отправки, чтобы ожидание push-службы не тормозило сообщение.
 * keepalive — запрос успеет уйти, даже если вкладку тут же закрыли.
 */
function fireNotify(ticket) {
  if (!ticket || !S.token) return;
  try {
    fetch(BASE + '/api/notify', {
      method: 'POST', keepalive: true,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + S.token },
      body: JSON.stringify({ kind: ticket.kind, chat: ticket.chat, mid: ticket.mid })
    }).catch(() => {});
  } catch (e) {}
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
  pop.innerHTML = EMOJIS.map(e => `<button type="button" data-emoji="${e}" title="${e}">${twEmo(escapeHtml(e))}</button>`).join('');
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
function showAttach(key, a) {
  const box = $(key === 'attach' ? '#attach-preview' : '#thread-attach');
  if (!box) return;
  if (!a) { box.innerHTML = ''; hide(box); return; }
  const isImg = typeof a === 'string' || a.kind === 'image';
  if (isImg) {
    const data = typeof a === 'string' ? a : a.data;
    box.innerHTML = `<img alt=""><button class="icon" data-xatt="${key}" title="Убрать">${SV(ICONS.x)}</button>`;
    box.querySelector('img').src = data;
  } else {
    box.innerHTML = `<div class="file-chip">${SV(a.kind === 'video' ? ICONS.play : ICONS.file)}
      <span class="fc-name">${escapeHtml(a.name || 'файл')}</span>
      <span class="tiny muted">${fmtBytes(a.size || 0)}</span>
      <button class="icon" data-xatt="${key}" title="Убрать">${SV(ICONS.x)}</button></div>`;
  }
  show(box);
}
function clearAttach(key) {
  S[key] = null;
  const box = $(key === 'attach' ? '#attach-preview' : '#thread-attach');
  if (box) { box.innerHTML = ''; hide(box); }
}
async function pickAttach(e, key) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const mime = file.type || 'application/octet-stream';
  try {
    if (/^image\//.test(mime)) {
      if (isHeic(file)) return toast('iPhone: сначала конвертируйте HEIC в JPG (Настройки → Камера → Форматы → наиболее совместимый)', true);
      toast('Готовим фото…');
      const data = await resizeImage(file, 1800, 0.82);
      S[key] = { kind: 'image', data, name: file.name || 'фото', size: file.size, mime: 'image/jpeg' };
      showAttach(key, S[key]);
      toast('Фото готово к отправке');
      return;
    }
    const kind = /^video\//.test(mime) ? 'video' : /^audio\//.test(mime) ? 'audio' : 'file';
    if (file.size > 25 * 1024 * 1024) return toast('Файл больше 25 МБ — предел облачного хранилища', true);
    S[key] = { kind, pending: true, file, name: file.name || kind, size: file.size, mime };
    showAttach(key, S[key]);
    toast('Вложение прикреплено: зашифруется и загрузится кусками при отправке');
  }
  catch (ex) { toast(ex && ex.message ? ex.message : 'Не удалось обработать вложение', true); }
}
const attLabel = a => !a ? '' : (typeof a === 'string' || a.kind === 'image' ? '📷 изображение' : a.kind === 'video' ? '🎬 видео' : '📎 ' + (a.name || 'файл'));
function attHtml(a) {
  if (!a) return '';
  if (typeof a === 'string') return `<img class="att" src="${a}" alt="вложение">`;
  if (a.kind === 'image') return `<img class="att" src="${a.data}" alt="вложение">`;
  if (a.upId) return `<span class="att-file" role="button" data-upl="${a.upId}" data-parts="${a.parts || 1}" data-kind="${a.kind}" data-name="${escapeHtml(a.name || 'файл')}" data-size="${a.size || 0}" data-mime="${escapeHtml(a.mime || '')}">${SV(ICONS[a.kind === 'video' ? 'play' : a.kind === 'audio' ? 'volume' : 'file'])}<span>${escapeHtml(a.name || 'файл')}</span><span class="tiny muted">${fmtBytes(a.size || 0)} · нажать для загрузки</span></span>`;
  if (a.kind === 'video') return `<video class="att att-vid" controls preload="metadata" src="${a.data}"></video>`;
  return `<a class="att-file" href="${a.data}" download="${escapeHtml(a.name || 'file')}">${SV(ICONS.file)}<span>${escapeHtml(a.name || 'файл')}</span><span class="tiny muted">${fmtBytes(a.size || 0)}</span></a>`;
}
$('#file-input').addEventListener('change', e => pickAttach(e, 'attach'));
$('#thread-file').addEventListener('change', e => pickAttach(e, 'threadAttach'));
document.addEventListener('click', e => {
  const x = e.target.closest('[data-xatt]');
  if (x) clearAttach(x.dataset.xatt);
});

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
async function runSearch() {
  const q = $('#search').value.trim().toLowerCase();
  if (q && !S.searchReady) {
    toast('Готовлю поиск по всей истории…');
    await decryptAll(S.messages);
    S.searchReady = true;
  }
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
  paintIcons($('#modal'));
  show($('#modal'));
}
$('#modal-close').addEventListener('click', () => hide($('#modal')));
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal') hide($('#modal')); });

// ─────────────────────────────────────────── push-уведомления: тумблер в настройках
async function pushState() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !window.isSecureContext) return 'unavailable';
  try {
    const cfg = await api('/api/push/config');
    if (!cfg.enabled) return 'noserver';
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg ? await reg.pushManager.getSubscription() : null;
    return sub ? 'on' : 'off';
  } catch (e) { return 'off'; }
}
async function refreshPushSwitch() {
  const sw = $('#sw-push'), hint = $('#push-hint');
  if (!sw) return;
  const st = await pushState();
  sw.disabled = (st === 'unavailable' || st === 'noserver');
  sw.checked = st === 'on';
  const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  const android = /Android/i.test(navigator.userAgent);
  const inAppBrowser = /Telegram|VK|Instagram|WhatsApp|Viber/i.test(navigator.userAgent);
  if (st === 'unavailable') {
    hint.innerHTML = inAppBrowser
      ? '📱 Ссылка открыта во встроенном браузере мессенджера или соцсети — он не умеет пуши. Скопируйте адрес чата и откройте его в ' + (ios ? 'Safari' : 'Chrome') + '.'
      : (ios
        ? '📱 iPhone: пуш работает только у установленного чата. Откройте чат в Safari → «Поделиться» → «На экран “Домой”» → запускайте чат с появившейся иконки (iOS 16.4+). В обычной вкладке Safari пушей не будет — это ограничение Apple.'
        : (android
          ? '📱 Android: откройте чат в Chrome, меню → «Добавить на главный экран». У установленного чата пуши приходят даже с закрытым браузером.'
          : 'Нужен современный браузер и защищённое соединение (HTTPS).'));
    show(hint);
  } else if (st === 'noserver') {
    hint.textContent = 'Уведомления не настроены администратором мессенджера: на сервере не заданы ключи VAPID.';
    show(hint);
  } else hide(hint);
}
async function setPush(on) {
  try {
    if (on) {
      const cfg = await api('/api/push/config');
      if (!cfg.enabled) throw new Error('Уведомления не настроены администратором');
      const reg = await navigator.serviceWorker.register(BASE + '/sw.js');
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new Error('Разрешение на уведомления не выдано');
      const raw = Uint8Array.from(atob(cfg.publicKey.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: raw });
      await api('/api/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
      toast('Уведомления включены');
    } else {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      if (sub) {
        await sub.unsubscribe();
        await api('/api/push/subscribe', { method: 'DELETE', body: { endpoint: sub.endpoint } });
      }
      toast('Уведомления выключены');
    }
  } catch (e) { toast(e.message || 'Не удалось переключить уведомления', true); }
  refreshPushSwitch();
}

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
    <div class="divider"><span>Статус</span></div>
    <label>Короткая строка под именем<input type="text" id="pf-status" value="${escapeHtml(me.status || '')}" maxlength="48" placeholder="например: на связи до шести"></label>
    <button class="primary soft" id="pf-save-status">Сохранить статус</button>
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
  $('#pf-save-status').addEventListener('click', async () => {
    try {
      await api('/api/profile', { method: 'POST', body: { status: $('#pf-status').value } });
      S.sig = ''; await sync(); toast('Статус обновлён');
    } catch (ex) { toast(ex.message, true); }
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
    <p class="hint">Занято ${fmtBytes(S.usage.bytes)} из ${fmtBytes(S.usage.limit)} (${S.usage.percent}%). Архивами управляет создатель каждого чата (меню «⋯» в чате).</p>
    <p class="hint">Из чего состоит: ${usagePartsText(S.usage) || '—'}.</p>
    <div class="divider"><span>Резервная копия</span></div>
    <p class="hint" id="ad-bk-where">Проверяю облачное хранилище…</p>
    <button class="primary" id="ad-bk-make">Сохранить копию в облако</button>
    <div class="err" id="ad-bk-err"></div>
    <div id="ad-bk-list"></div>`);
  renderAdminUsers();
  initBackups();

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
// ─────────────────────────────────────── резервные копии в облачном хранилище
// Копия уходит в приватный бакет Yandex Object Storage — туда же, где лежит
// сама программа. Всё содержимое и так зашифровано, а сверху копия закрыта
// ещё и секретом мессенджера, поэтому читать её может только этот сервер.
function bkWhen(at) {
  if (!at) return '—';
  const d = new Date(at);
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function renderBackups(list, where) {
  const box = $('#ad-bk-list');
  if (!box) return;
  if (!list) { box.innerHTML = ''; return; }
  if (!list.length) {
    box.innerHTML = '<p class="hint">Копий пока нет. Нажмите кнопку выше — первая копия появится здесь.</p>';
    return;
  }
  box.innerHTML = list.map(b => `<div class="mrow bkrow">
      <span class="nm"><span class="bk-date">${escapeHtml(bkWhen(b.at))}</span>
      <span class="tiny muted">${escapeHtml(fmtBytes(b.bytes))} · ${escapeHtml(b.name)}</span></span>
      <button class="mini" data-bk="${escapeHtml(b.name)}" data-key="${escapeHtml(b.key)}" data-bytes="${b.bytes || 0}" data-act="get">скачать</button>
      <button class="mini" data-bk="${escapeHtml(b.name)}" data-key="${escapeHtml(b.key)}" data-bytes="${b.bytes || 0}" data-act="rst">восстановить</button>
      <button class="mini danger" data-bk="${escapeHtml(b.name)}" data-key="${escapeHtml(b.key)}" data-act="del">удалить</button>
    </div>`).join('')
    + `<div style="margin-top:10px"><button class="mini" id="bk-upl">Восстановить из файла с компьютера…</button>
       <input type="file" id="bk-upl-file" accept=".sbgz,application/octet-stream" style="display:none"></div>`
    + `<p class="tiny muted" style="margin-top:8px">${escapeHtml(where || '')}</p>`;
}
const DL_CHUNK = 2500000;   // кусок скачивания копии: с запасом под потолок ответа функции
async function errOf(res) {
  try { return (await res.json()).error || ('Ошибка ' + res.status); } catch (e) { return 'Ошибка ' + res.status; }
}
function b64Of(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
/** Скачивает копию: целиком, если маленькая, иначе по кусочкам с процентами на кнопке. */
async function downloadBackup(name, bytes, btn) {
  const hdr = { headers: { Authorization: 'Bearer ' + S.token } };
  const url = BASE + '/api/admin/backups/' + encodeURIComponent(name);
  if (!bytes || bytes <= 3200000) {
    btn.textContent = 'качаем…';
    const res = await fetch(url, hdr);
    if (!res.ok) throw new Error(await errOf(res));
    saveBlob(await res.blob(), name);
  } else {
    const parts = [];
    let off = 0, rec = 0;
    while (off < bytes) {
      const len = Math.min(DL_CHUNK, bytes - off);
      const res = await fetch(url + '?off=' + off + '&len=' + len, hdr);
      if (!res.ok) throw new Error(await errOf(res));
      const piece = new Uint8Array(await res.arrayBuffer());
      parts.push(piece); rec += piece.length; off += piece.length;
      btn.textContent = Math.round(rec / bytes * 100) + '%';
      if (!piece.length) break;
    }
    saveBlob(new Blob(parts), name);
    toast('Копия скачана: ' + fmtBytes(rec));
  }
  btn.disabled = false; btn.textContent = 'скачать';
}
/** Восстановление из копии, лежащей в ящике. */
async function restoreFromKey(key, name, btn) {
  if (!confirm('Восстановить базу из копии ' + name + '?\n\n'
    + 'Переписка станет такой, как на момент копии; всё, что написано позже, заменится.\n'
    + 'Перед этим мессенджер сам сделает страховочную копию текущего состояния.')) return;
  const word = await askCodeword('Восстановление из копии',
    'Введите кодовое слово мессенджера — база будет заменена содержимым копии.', false).catch(() => null);
  if (!word) return;
  btn.disabled = true; btn.textContent = 'восстанавливаем…';
  try {
    const r = await api('/api/admin/restore', { method: 'POST', body: { key, codeProof: await codeProofOf(word) } });
    toast('Готово: база заменена копией. Страховочная копия: ' + (r.safety || '—'));
    setTimeout(() => location.reload(), 1500);
  } finally {
    btn.disabled = false; btn.textContent = 'восстановить';
  }
}
/** Восстановление из файла .sbgz с компьютера: загружаем кусочками, затем применяем. */
async function restoreFromFile(file) {
  if (!confirm('Восстановить базу из файла ' + file.name + ' (' + fmtBytes(file.size) + ')?\n\n'
    + 'Текущее состояние сначала сохранится в страховочную копию.')) return;
  const word = await askCodeword('Восстановление из файла',
    'Введите кодовое слово мессенджера — база будет заменена содержимым файла.', false).catch(() => null);
  if (!word) return;
  const btn = $('#bk-upl');
  if (btn) { btn.disabled = true; btn.textContent = 'читаем файл…'; }
  try {
    const u8 = new Uint8Array(await file.arrayBuffer());
    const init = await api('/api/admin/restore/upload', {
      method: 'POST', body: { step: 'init', size: u8.length, parts: Math.max(1, Math.ceil(u8.length / 675000)) }
    });
    const chunk = Number(init.chunk || 900000);
    for (let off = 0, i = 0; off < u8.length; off += Math.floor(chunk * 0.75), i++) {
      const slice = u8.subarray(off, Math.min(u8.length, off + Math.floor(chunk * 0.75)));
      await api('/api/admin/restore/upload', {
        method: 'POST', body: { step: 'chunk', id: init.id, i, data: b64Of(slice) }
      });
      if (btn) btn.textContent = 'загружаем ' + Math.round(Math.min(100, off / u8.length * 100)) + '%';
    }
    if (btn) btn.textContent = 'восстанавливаем…';
    const r = await api('/api/admin/restore/upload', {
      method: 'POST', body: { step: 'fin', id: init.id, codeProof: await codeProofOf(word) }
    });
    toast('Готово: база заменена копией из файла. Страховочная копия: ' + (r.safety || '—'));
    setTimeout(() => location.reload(), 1500);
  } catch (ex) {
    toast(ex.message, true);
    if (btn) { btn.disabled = false; btn.textContent = 'Восстановить из файла с компьютера…'; }
  }
}

async function initBackups() {
  const where = $('#ad-bk-where'), make = $('#ad-bk-make');
  try {
    const r = await api('/api/admin/backups');
    if (!r.enabled) {
      const denied = r.code === 'denied';
      where.textContent = (denied
        ? 'Нет прав на облачное хранилище — копии недоступны. '
        : 'Облачное хранилище не настроено — копии недоступны. ') + (r.reason || '');
      if (make) { make.disabled = true; make.textContent = denied ? 'Нет прав на хранилище' : 'Хранилище не настроено'; }
      renderBackups(null);
      return;
    }
    where.textContent = `Копии хранятся в облаке Yandex Cloud, в закрытом ящике «${r.bucket}» `
      + `(папка ${r.prefix}, держим последние ${r.keep}).`
      + (r.items && r.items.length ? ` Сейчас там ${r.items.length}.` : ' Копий пока нет.');
    renderBackups(r.items, r.items && r.items.length
      ? `Последняя копия: ${bkWhen(r.items[0].at)}. Копия зашифрована — открыть её сможет только этот мессенджер.`
      : '');
  } catch (ex) {
    where.textContent = 'Не удалось спросить сервер про копии: ' + ex.message;
    if (make) make.disabled = true;
  }
  const list = $('#ad-bk-list');
  if (list && !list.dataset.bound) {
    list.dataset.bound = '1';
    list.addEventListener('click', async e => {
      const b = e.target.closest('button[data-bk]');
      if (b) {
        const name = b.dataset.bk;
        try {
          if (b.dataset.act === 'del') {
            if (!confirm('Удалить эту копию из облака? Отменить будет нельзя.')) return;
            await api('/api/admin/backups/' + encodeURIComponent(name), { method: 'DELETE' });
            toast('Копия удалена');
            initBackups();
          } else if (b.dataset.act === 'rst') {
            await restoreFromKey(b.dataset.key || ('backups/' + name), name, b);
          } else {
            b.disabled = true;
            await downloadBackup(name, Number(b.dataset.bytes || 0), b);
          }
        } catch (ex) {
          const err = $('#ad-bk-err'); if (err) err.textContent = ex.message;
          toast(ex.message, true);
          b.disabled = false;
          b.textContent = b.dataset.act === 'get' ? 'скачать' : b.dataset.act === 'rst' ? 'восстановить' : 'удалить';
        }
        return;
      }
      const upl = e.target.closest('#bk-upl');
      if (upl) { $('#bk-upl-file').click(); return; }
    });
    list.addEventListener('change', e => {
      if (e.target.id !== 'bk-upl-file') return;
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (f) restoreFromFile(f);
    });
  }
  if (make && !make.dataset.bound) {
    make.dataset.bound = '1';
    make.addEventListener('click', async () => {
      const err = $('#ad-bk-err'); err.textContent = '';
      make.disabled = true; const was = make.textContent; make.textContent = 'Сохраняем…';
      try {
        const r = await api('/api/admin/backup', { method: 'POST' });
        const b = r.backup || {};
        toast(r.warn ? r.warn : 'Копия сохранена в облаке (' + fmtBytes(b.bytes || 0) + ')', !!r.warn);
        await initBackups();
        if (!r.warn) {
          // дописываем честный итог ПОСЛЕ обновления списка, чтобы он не затёрся
          const w = $('#ad-bk-where');
          if (w) w.textContent += ' Последняя: ' + (b.rows || 0) + ' записей, ' + fmtBytes(b.bytes || 0)
            + ', проверка целостности пройдена.';
        }
      } catch (ex) { err.textContent = ex.message; toast(ex.message, true); }
      make.disabled = false; make.textContent = was;
    });
  }
}

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
// ─────────────────────────────────────────── локальная память (IndexedDB)
function idbBackend() {
  const DB = 'sega-local-v1';
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const rq = indexedDB.open(DB, 1);
    rq.onupgradeneeded = () => {
      const d = rq.result;
      ['kv', 'msg', 'chat', 'user'].forEach(st => { if (!d.objectStoreNames.contains(st)) d.createObjectStore(st); });
    };
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  }));
  const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  function run(store, mode, job) {
    return open().then(d => new Promise((res, rej) => {
      const t = d.transaction(store, mode);
      const out = job(t.objectStore(store));
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    }));
  }
  return {
    get: (st, k) => run(st, 'readonly', o => req(o.get(k))),
    put: (st, k, v) => run(st, 'readwrite', o => req(o.put(v, k))),
    del: (st, k) => run(st, 'readwrite', o => req(o.delete(k))),
    delMany: (st, keys) => run(st, 'readwrite', o => { keys.forEach(k => o.delete(k)); return null; }),
    putAll: (st, items) => run(st, 'readwrite', o => { items.forEach(it => o.put(it.value, it.key)); return null; }),
    all: st => run(st, 'readonly', o => req(o.getAll())),
    clear: st => run(st, 'readwrite', o => req(o.clear()))
  };
}
async function cacheFp() {
  const dig = await subtle.digest('SHA-256', S.roomKeyRaw);
  return (S.uid || '-') + ':' + toHex(new Uint8Array(dig)).slice(0, 16);
}
const pickMsg = m => ({
  id: m.id, chat: m.chat, seq: m.seq, uid: m.uid, ts: m.ts,
  parent: m.parent || null, quote: m.quote || null, blob: m.blob || null,
  upId: m.upId || null, bytes: m.bytes || 0, reactions: m.reactions || null,
  rev: m.rev || 0, editedAt: m.editedAt || 0, reactTs: m.reactTs || 0, reactBy: m.reactBy || null
});
function persistAll() {
  if (!S.idb || !S.cacheFp) return;
  // просим браузер не вычищать нас при уборке storage (особенно iOS Safari)
  if (navigator.storage && navigator.storage.persist && !S.persistAsked) {
    S.persistAsked = true;
    Promise.resolve(navigator.storage.persist()).catch(() => {});
  }
  S.idb.saveAll(S.cacheFp, {
    messages: S.messages.map(pickMsg),
    chats: S.chats, users: S.users,
    meta: { me: S.uid, seq: S.seq, gen: S.gen, chg: S.chg, rsince: S.rsince }
  });
}
/** Массовая локальная расшифровка со шкалой — для тёплого старта из кэша. */
async function decryptLocal() {
  const list = S.messages.filter(m => !S.plain.has(m.id) && m.blob);
  if (!list.length) return;
  for (let i = 0; i < list.length; i += 96) {
    const part = list.slice(i, i + 96);
    await decryptSmart(part);
    const done = Math.min(list.length, i + part.length);
    loadUi.show('Расшифровываем на устройстве', done / list.length * 100, done + ' из ' + list.length);
    renderMessages(true);
  }
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
      text: p.text || '', image: (typeof p.att === 'string' ? p.att : (p.att && p.att.kind === 'image' ? p.att.data : null))
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
  const title = chat ? chatTitle(chat) : 'Все мои чаты';
  const html = archivePageHtml(title, list);
  const name = 'sega-chat-' + (chat ? cut(chatTitle(chat), 20).replace(/[^\wА-Яа-яЁё-]+/g, '_') + '-' : '') + new Date().toISOString().slice(0, 10) + '.html';
  saveBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), name);
}

/**
 * Самодостаточная HTML-страница переписки с живым поиском по странице.
 * Используется и для копии чата, и для архивов с сервера: поиск работает без интернета.
 */
function archivePageHtml(title, list) {
  const rows = list.map(m => {
    const q = m.quote ? list.find(x => x.id === m.quote) : null;
    return `<div class="m${m.parent ? ' c' : ''}" id="m-${m.id}"><div class="h"><b>${escapeHtml(m.author)}</b>
    <span>${escapeHtml(m.time)}</span><i>${escapeHtml(m.chat)}</i></div>
    ${q ? `<a class="q" href="#m-${q.id}"><b>${escapeHtml(q.author)}</b>: ${escapeHtml(cut(q.text, 80))}</a>` : ''}
    ${m.text ? `<div class="t">${linkify(escapeHtml(m.text))}</div>` : ''}${m.image ? `<img src="${m.image}">` : ''}</div>`;
  }).join('\n');
  return `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SEGA-CHAT — ${escapeHtml(title)}</title><style>
body{background:#eef2f4;color:#1f2b33;font-family:Helvetica,Arial,sans-serif;margin:0;padding:24px}
.wrap{max-width:860px;margin:0 auto}h1{color:#1f2b33;margin:2px 0 0}
.brand{font-weight:800;letter-spacing:.2em;color:#2353a2;font-size:12px}
#bar{position:sticky;top:0;background:#eef2f4;padding:12px 0;margin:12px 0 18px;display:flex;gap:10px;align-items:center}
#q{flex:1;padding:10px 12px;border-radius:8px;border:1px solid #d7dfe5;font-size:14px}
#n{font-size:12px;color:#8b98a4;white-space:nowrap}
.m{background:#fff;border-radius:10px;padding:10px 13px;margin-bottom:8px;box-shadow:0 1px 2px rgba(20,50,70,.09)}
.m.c{margin-left:36px;border-left:3px solid #2fc6f6}
.m:target{box-shadow:0 0 0 3px #ffd98a}
.h b{color:#2353a2}.h span{color:#8b98a4;font-size:12px;margin-left:8px}.h i{color:#8b98a4;font-size:11px;margin-left:8px}
.q{display:block;border-left:3px solid #2fc6f6;background:#f2f8fd;border-radius:6px;padding:5px 9px;margin:5px 0;
   font-size:12.5px;color:#41525e;text-decoration:none}
.t{white-space:pre-wrap;margin-top:4px}img{max-width:min(420px,90%);border-radius:8px;margin-top:8px;display:block}
a{color:#2353a2}.muted{color:#8b98a4}mark{background:#ffe9a8;border-radius:3px;padding:0 1px}</style></head><body><div class="wrap">
<div class="brand">SEGA-CHAT</div><h1>${escapeHtml(title)}</h1><div class="muted">Архив · ${new Date().toLocaleString('ru-RU')} · ${list.length} сообщений</div>
<div id="bar"><input id="q" placeholder="Поиск по странице…" autocomplete="off"><span id="n"></span></div>
<div id="c">${rows}</div></div><script>
(function(){
  var q=document.getElementById('q'),n=document.getElementById('n'),cards=[].slice.call(document.querySelectorAll('.m'));
  function run(){
    var v=q.value.trim().toLowerCase(),hits=0;
    cards.forEach(function(el){
      var ok=!v||el.innerText.toLowerCase().indexOf(v)!==-1;
      el.style.display=ok?'':'none'; if(ok&&v)hits++;
    });
    n.textContent=v?('найдено: '+hits):'';
  }
  q.addEventListener('input',run);
})();
</script></body></html>`;
}

$('#btn-logout').addEventListener('click', () => { if (confirm('Выйти из мессенджера на этом устройстве?')) doLogout(); });
$('#btn-dropcache').addEventListener('click', async () => {
  if (!confirm('Стереть кэш переписки с этого устройства?\n\nПереписка останется в облаке; следующая загрузка вытянет её оттуда заново.')) return;
  if (S.idb) await S.idb.clear();
  toast('Локальный кэш стёрт');
});

// ─────────────────────────────────────────── оформление: тема, плотность, гамма
function currentPal() {
  return document.documentElement.dataset.pal || 'classic';
}
function metaThemeColor() {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  const dark = document.documentElement.dataset.theme === 'dark';
  const inApp = document.documentElement.dataset.inApp === '1';
  meta.setAttribute('content', dark ? '#0b171d' : (inApp ? palById(currentPal()).c1 : '#2353A2'));
}
function applyTheme(theme) {
  const dark = theme === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : '';
  try { localStorage.setItem('sega.theme', dark ? 'dark' : 'light'); } catch (e) {}
  const sw = $('#sw-dark');
  if (sw) sw.checked = dark;
  metaThemeColor();
}
function applyDensity(mode) {
  const compact = mode === 'compact';
  if (compact) document.documentElement.dataset.density = 'compact';
  else delete document.documentElement.dataset.density;
  try {
    if (compact) localStorage.setItem('sega.density', 'compact');
    else localStorage.removeItem('sega.density');
  } catch (e) {}
  const sw = $('#sw-compact');
  if (sw) sw.checked = compact;
}
function applyPalette(id, save) {
  const pal = palById(id);
  document.documentElement.dataset.pal = pal.id;
  if (save !== false) { try { localStorage.setItem('sega.pal', pal.id); } catch (e) {} }
  paintPalettePickers();
  metaThemeColor();
  lastFav = '';
  updateFavicon();
}
function paintPalettePickers() {
  const box = $('#pals');
  if (!box) return;
  box.innerHTML = PALS.map(p =>
    `<span class="pal ${currentPal() === p.id ? 'on' : ''}" data-pal="${p.id}" title="${p.name}" role="button" tabindex="0" style="background:linear-gradient(135deg,${p.c1},${p.c2})"></span>`).join('');
}

// ─────────────────────────────────────────── окно настроек (шестерёнка)
function openSettings() {
  $('#rail').classList.remove('open');
  paintPalettePickers();
  const swD = $('#sw-dark'); if (swD) swD.checked = document.documentElement.dataset.theme === 'dark';
  const swC = $('#sw-compact'); if (swC) swC.checked = document.documentElement.dataset.density === 'compact';
  renderNotifyControls();
  show($('#sheet-settings'));
  const bt = $('#build-tag');
  if (bt) bt.textContent = 'Интерфейс: ' + BUILD + ' · Сервер: ' + (S.serverBuild || 'без метки');
  refreshPushSwitch();
}
function closeSettings() { hide($('#sheet-settings')); }
$('#btn-gear').addEventListener('click', openSettings);
$('#settings-close').addEventListener('click', closeSettings);
$('#sheet-settings').addEventListener('click', e => { if (e.target.id === 'sheet-settings') closeSettings(); });
// пункты «Профиль / Управление / Архивы / Выйти» открывают свои окна — сворачиваем настройки
document.addEventListener('click', e => {
  if (e.target.closest('[data-close-sheet]')) closeSettings();
}, true);
$('#sw-dark').addEventListener('change', e => applyTheme(e.target.checked ? 'dark' : 'light'));
$('#sw-compact').addEventListener('change', e => applyDensity(e.target.checked ? 'compact' : 'cozy'));
$('#sw-push').addEventListener('change', e => setPush(e.target.checked));
$('#pals').addEventListener('click', e => {
  const b = e.target.closest('[data-pal]');
  if (!b) return;
  applyPalette(b.dataset.pal);
  toast('Гамма: ' + palById(b.dataset.pal).name);
});

(function initAppearance() {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  applyDensity(document.documentElement.dataset.density === 'compact' ? 'compact' : 'cozy');
  applyPalette(currentPal(), false);
  paintIcons(document);
})();

boot();
