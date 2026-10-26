/* SEGA-CHAT — клиент (оформление в духе Bitrix24).
   Любой участник создаёт свои групповые чаты и пишет личные сообщения.
   Всё шифруется в браузере: у каждого чата свой ключ AES-256-GCM,
   который передаётся участникам «завёрнутым» в ключ пары (ECDH P-256). */
'use strict';

// ─────────────────────────────────────────── помощники
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
// метка выпуска: видна в настройках и в журнале, чтобы всегда знать, что стоит в облаке
const BUILD = 'pkg3-89';
/* pkg3-80: звук игр — модуль public/game-sound.js (синтез кодом, Web Audio).
   pkg3-81: одиннадцать правок владельца — карта не выделяется пальцем, «Далее»
   ждёт нажатия, находки пишутся прямо на карте, звук просыпается после сна
   телефона, все монеты собраны — раунд кончается досрочно, цифры настроек
   читаются, счёт победителя без дубля, вышедший игру больше не видит,
   приглашение не светится в «Сейчас играют», зритель видит карту, пуш не
   мешает тому, кто смотрит на доску.
   Если файл вдруг не догрузился, работает тихая заглушка: отсутствие звука
   не имеет права ломать игру. */
const GS = (typeof window !== 'undefined' && window.GS) || {
  version: 'none', SFX: {},
  ensure() {}, wake() {}, play() {}, startMusic() { return false; }, stopMusic() {},
  musicPref() { return false; }, setMusicPref() {}, toggleMusicPref() { return false; },
  setEnabled() {}, isEnabled() { return false; }, isPlaying() { return false; },
  letterSound() { return null; }, melodyFor() { return null; }
};
/* pkg3-55.1: признак жизни для встроенного сторожа из index.html. Сторож ждёт
   20 секунд и, если файл скрипта не догрузился через сеть (туннель VPN, часы
   белых списков), показывает честную плашку с причинами и кнопкой «Повторить».
   Раз скрипт выполняется — плашка не нужна: ставим признак и убираем её, если
   она уже успела появиться (сеть могла доползти с опозданием). */
window.SEGA_BOOTED = 1;
(function () { const w = document.getElementById('segawd'); if (w) w.remove(); })();
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
  { id: 'synth', name: 'Синтвейв', c1: '#ff2bd6', c2: '#00e5ff' },
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
// узоры фона чата: id + превью для кнопок выбора
// pkg3-38: узоры перерисованы по пожеланиям владельца —
//  · diag — настоящие непрерывные диагональные линии (ровный шаг, сшиваются между плитками)
//  · grid — обычная клетка, повёрнутая на 45° (ромбиком)
//  · waves — настоящие концентрические окружности (не «волны»)
//  · neongrid — бирюзовая клетка на чёрном, уходящая в перспективу (big: во весь экран)
//  · sunset — фиолетовые линии на чёрном, уходящие в перспективу (big: во весь экран)
const PATS = [
  { id: 'dots', prev: 'radial-gradient(rgba(255,255,255,.6) 1.5px, transparent 1.6px)', bg: '#5c6f7c' },
  { id: 'diag', prev: 'repeating-linear-gradient(45deg, rgba(255,255,255,.55) 0 1.6px, transparent 1.6px 9px)', bg: '#5c6f7c' },
  { id: 'grid', prev: 'repeating-linear-gradient(45deg, rgba(255,255,255,.45) 0 1px, transparent 1px 9px), repeating-linear-gradient(-45deg, rgba(255,255,255,.45) 0 1px, transparent 1px 9px)', bg: '#5c6f7c' },
  { id: 'waves', prev: 'repeating-radial-gradient(circle at 50% 50%, rgba(255,255,255,.45) 0 1px, transparent 1px 6px)', bg: '#5c6f7c' },
  { id: 'neongrid', prev: '', bg: '#000', big: true },
  { id: 'sunset', prev: '', bg: '#000', big: true }
];
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
  // pkg3-76: poster — первый кадр видео; плеер показывает его до нажатия «play»
  const post = rec.poster ? ` poster="${rec.poster}"` : '';
  if (rec.kind === 'video' || (rec.mime || '').startsWith('video/')) return `<video class="att att-vid" controls preload="metadata"${post} src="${url}"></video>`;
  if (rec.kind === 'audio' || (rec.mime || '').startsWith('audio/')) return `<audio controls src="${url}" style="max-width:min(360px,70vw);margin-top:5px"></audio>`;
  if ((rec.mime || '').startsWith('image/')) return `<img class="att" src="${url}" alt="вложение">`;
  return `<a class="att-file" href="${url}" download="${escapeHtml(rec.name || 'file')}">${SV(ICONS.download)}<span>${escapeHtml(rec.name || 'файл')}</span><span class="tiny muted">${fmtBytes(rec.size || rec.blob.size || 0)} · из памяти устройства</span></a>`;
}
function twEmo(html) {
  if (S.eco) return String(html);   // эконом-режим: никаких картинок-смайлов с CDN
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
  chatKeysOld: new Map(),   // pkg3-63: chatId -> [ {key,raw,ep} ] прежние копии ключа группы (история)
  chatTitleSrc: new Map(),  // pkg3-65: chatId -> titleBlob, из которого прочитано название
  oldKeysSeen: new Map(),   // pkg3-69: chatId -> сигнатура слотов прежних ключей с сервера
  oldKeysRetry: new Map(),  // pkg3-71: chatId -> время последней допытки обмена
  oldKeysRetryUp: new Map(), // pkg3-72: chatId -> время последней попытки выкладки
  keyEpochSeen: new Map(),  // pkg3-63: chatId -> поколение ключа, которое клиент развернул
  keySplitHinted: new Set(),// pkg3-63: чаты, где уже подсказали про перевыпуск ключа
  keyIssue: new Map(),   // chatId -> { code, who } — почему нечем расшифровать
  healBusy: false, healPauseUntil: 0,   // защита от бесконечного «долечивания» без ключа
  chatTitles: new Map(), // chatId -> строка
  view: null, threadId: null, quote: null, highlight: null, drafts: {}, openMark: null,
  typing: [],          // pkg3-77: кто пишет/загружает — [{uid, chat, kind, at}]
  musicStatus: {},     // pkg3-87: кто слушает музыку — {uid: {note, at}}
  typingHeaderSig: '', // pkg3-77: подпись заголовка, чтобы не перерисовывать его впустую
  chatPos: {},      // pkg3-38: chatId -> где была прокручена лента ({bottom:true} или {id,dy}) — память места в рамках сессии
  seq: 0, rsince: 0, chg: 0,   // курсоры: сообщения / журнал мелких изменений
  usage: { bytes: 0, limit: 1, percent: 0, messages: 0 }, maxUpload: DEFAULT_MAX_UPLOAD,
  attach: null, threadAttach: null, remember: true, timer: null, atBottom: true,
  notify: { sound: true, muted: {}, desktop: true },   // pkg3-37: все движки оповещений по умолчанию включены
  aliases: loadAliases(),   // pkg3-45: локальные псевдонимы (только это устройство)
  retry: {},        // черновики своих сообщений, ещё не принятых сервером
  dmSaved: new Set(),   // pkg3-49: какие личные чаты я сохранил у себя навсегда
  savedSeen: {},        // pkg3-49: chatId -> кого я уже видел в «сохранивших» (без повторов плашек)
  booted: false,       // pkg3-49: первый успешный опрос позади — можно показывать плашки
  serverNow: Date.now(),// pkg3-49: время сервера — по нему тикают счётчики «Новых»
  sig: '', railFilter: '',
  // pkg3-52: строка «Найти чат или участника» ищет людей и на сервере
  sections: [],        // pkg3-53: мои разделы-папки (приезжают в синхронизации)
  collapsed: loadFolds(),  // pkg3-53: какие разделы свёрнуты — помнит это устройство
  railPeople: [],      // кого вернул /api/search для текущего запроса
  railPeopleQ: '',     // какой запрос этим результатам соответствует
  railPeopleErr: '',   // не получилось спросить сервер (лимит, сеть)
  railFindPending: ''  // запрос в пути — показать «Ищу…»
};

// pkg3-45: локальные псевдонимы. Любой ник можно переименовать У СЕБЯ: псевдоним
// хранится только на этом устройстве, на сервер не уходит и владельцу ника
// не виден. userById отдаёт имя с псевдонимом, поэтому ленты, списки, игры
// и уведомления подхватывают его сами, без правки каждого места.
function loadAliases() {
  try { const a = JSON.parse(localStorage.getItem('sega.aliases') || '{}'); return a && typeof a === 'object' ? a : {}; }
  catch (e) { return {}; }
}
function saveAliases() { try { localStorage.setItem('sega.aliases', JSON.stringify(S.aliases)); } catch (e) {} }
// pkg3-53: какие разделы свёрнуты — помнит только это устройство (на сервер не уходит)
function loadFolds() { try { return JSON.parse(localStorage.getItem('sega.folds') || '{}') || {}; } catch (e) { return {}; } }
function saveFolds() { try { localStorage.setItem('sega.folds', JSON.stringify(S.collapsed || {})); } catch (e) {} }
function setAlias(uid, name) {
  S.aliases = S.aliases || {};
  if (name) S.aliases[uid] = name; else delete S.aliases[uid];
  saveAliases();
}
const userByIdRaw = id => S.users.find(u => u.id === id);
const userById = id => {
  const u = userByIdRaw(id);
  const al = u && S.aliases && S.aliases[u.id];
  return al ? Object.assign({}, u, { name: al, aliasOf: u.name }) : u;
};
/** Имя для списков, построенных напрямую из S.users (без userById). */
const displayName = u => (u && ((S.aliases || {})[u.id] || u.name)) || '…';
const chatById = id => S.chats.find(c => c.id === id);
const isOnline = u => u && Date.now() - (u.activeAt || 0) < ONLINE_MS;
// pkg3-77: «пишет / загружает» — короткоживущие сигналы. Сервер хранит их только
// в памяти (набор текста живёт 9 с, загрузка файла — 60 с), клиент держит свой
// запас свежести, чтобы надпись гасла даже тогда, когда опросы заснули.
const TYPE_TTL = 10000, UPTYPE_TTL = 65000;
const typingFresh = t => t && Date.now() - (t.at || 0) < (t.kind === 'upload' ? UPTYPE_TTL : TYPE_TTL);
/** Кто прямо сейчас пишет/загружает в чате (кроме меня самого). */
function typingIn(chatId) {
  if (!chatId) return [];
  const meId = S.me && S.me.id;
  return (S.typing || []).filter(t => t.chat === chatId && t.uid !== meId && typingFresh(t));
}
const typingSig = list => (list || []).map(t => t.uid + ':' + t.kind).sort().join(',');
/** Ответ опроса/сигнала по ОДНОМУ чату: заменяем только его долю списка. */
function mergeTypingChat(chatId, list) {
  const now = Date.now();
  S.typing = (S.typing || []).filter(t => t.chat !== chatId)
    .concat((list || []).map(t => ({ uid: t.uid, chat: chatId, kind: t.kind, at: now })));
}
/** Ответ синхронизации: свежий список сразу по всем моим чатам. */
function mergeTypingAll(list) {
  const now = Date.now();
  S.typing = (list || []).map(t => ({ uid: t.uid, chat: t.chat, kind: t.kind, at: now }));
}
const myReads = () => (S.me && S.me.reads) || {};
const bucketOf = m => m.parent ? 'thr:' + m.parent : m.chat;
const dmPeer = c => c && c.kind === 'dm' ? c.members.find(x => x !== S.me.id) : null;
// pkg3-62: слитые учётки. Поглощённая учётка — только старая история: в списках
// выбора людей её нет (пишут настоящей), а её строка личного чата прячется,
// если с настоящей учёткой уже есть живая переписка — чтобы один человек не
// выглядел двумя одинаковыми строками.
const aliasTargetOf = u => (u && u.displayAs ? userByIdRaw(u.displayAs) : null);
const isNewishChat = (c) => !!c.newUntil && !S.dmSaved.has(c.id);
const peerIsHiddenAlias = (c) => {
  if (!c || c.kind !== 'dm') return false;
  const p = userByIdRaw(dmPeer(c));
  const t = aliasTargetOf(p);
  if (!t) return false;
  return S.chats.some(x => x.kind === 'dm' && x.id !== c.id && x.members.includes(t.id)
    && x.members.includes(S.me.id) && !isNewishChat(x));
};
const isOwner = c => !!c && c.kind === 'group' && c.ownerId === S.me.id;
function chatTitle(c) {
  if (c && c.kind === 'game') return gameTitle(c);
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
    if (!raw) return;   // pkg3-37: чистой установке — все движки включены
    const saved = JSON.parse(raw);
    // pkg3-37: разовый переезд defaults — раньше звук и плашки могли остаться
    // выключенными «с завода», хотя человек их осознанно не трогал
    const migrated = !!localStorage.getItem('sega.notifyDef37');
    if (!migrated) {
      try { localStorage.setItem('sega.notifyDef37', '1'); } catch (e) {}
      S.notify = {
        sound: true,
        muted: saved.muted && typeof saved.muted === 'object' ? saved.muted : {},
        desktop: true,
        gamesound: true
      };
      saveNotifySettings();
      return;
    }
    S.notify = {
      sound: saved.sound !== false,
      muted: saved.muted && typeof saved.muted === 'object' ? saved.muted : {},
      desktop: saved.desktop !== false,
      gamesound: saved.gamesound !== false   // pkg3-80: звук в играх — по умолчанию включён
    };
  } catch (e) {}
}
function saveNotifySettings() {
  try { localStorage.setItem('sega.notify', JSON.stringify(S.notify)); } catch (e) {}
}
/** pkg3-44: в чат-играх все оповещения включены по умолчанию. Разово:
 *  — снимаем «без звука» со всех игровых чатов (партия — не тот чат, который
 *    стоит глушить случайно: пропущенный ход соперника выглядит как «зависло»);
 *  — включаем звуковой и плашечный движки, если они оказались погашены старыми
 *    значениями «с завода» (та же логика, что в pkg3-37).
 *  Флаг ставится один раз: последующие осознанные переключения человека
 *  (включая «без звука» для конкретного чата) не перекрываются. */
function migrateGameNotify44() {
  let flag = false;
  try { flag = !!localStorage.getItem('sega.gameNotify44'); } catch (e) { return; }
  if (flag) return;
  try { localStorage.setItem('sega.gameNotify44', '1'); } catch (e) { return; }
  let touched = false;
  for (const c of (S.chats || [])) {
    if (c && c.kind === 'game' && S.notify && S.notify.muted && S.notify.muted[c.id]) {
      delete S.notify.muted[c.id]; touched = true;
    }
  }
  if (S.notify && S.notify.sound === false) { S.notify.sound = true; touched = true; }
  if (S.notify && S.notify.desktop === false) { S.notify.desktop = true; touched = true; }
  if (touched) saveNotifySettings();
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
  if (box) box.checked = S.notify.sound !== false;
  // pkg3-80: тумблер «Звук в играх» — состояние того же личного файла настроек
  const gbox = $('#game-sound');
  if (gbox) gbox.checked = S.notify.gamesound !== false;
}
loadNotifySettings();
GS.setEnabled(S.notify.gamesound !== false);   // pkg3-80: звуковой движок игр слушает настройку

// ─────────────────────────────────────────── сеть
// В облаке страница может жить по адресу вида https://…/<код-функции>/ —
// тогда сервер подставляет сюда эту приставку, и запросы находят дорогу.
const BASE = (typeof window !== 'undefined' && window.SEGA_BASE) || '';
async function api(path, opts = {}) {
  const headers = Object.assign({}, opts.headers || {});
  if (opts.body !== undefined && typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);
  if (opts.body) headers['Content-Type'] = 'application/json';
  if (S.token) headers['Authorization'] = 'Bearer ' + S.token;
  const timeout = Number(opts.timeout || 25000);   // «висящий» запрос обрываем и пробуем ещё раз
  const attempt = async () => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeout);
    try {
      return await fetch(BASE + path, Object.assign({}, opts, { headers, signal: ac.signal }));
    } finally { clearTimeout(t); }
  };
  let res;
  try { res = await attempt(); }
  catch (e) {
    S.loadNote = 'соединение медленно — повторяю запрос…';
    res = await attempt();
  }
  if (res.status === 401 && S.token) { doLogout(true); throw new Error('Сессия истекла, войдите заново'); }
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    if (!res.ok) throw new Error('Ошибка сети (' + res.status + ')');
    return res;
  }
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.error || 'Ошибка запроса');
    err.code = data.code || null;
    err.until = data.until || 0;
    // pkg3-59: бан по жалобе — показываем честное уведомление и выходим
    if (data.code === 'banned') banNotice(data);
    throw err;
  }
  return data;
}

/** pkg3-59: пользователь, попавший под бан на сутки, узнаёт причину честно:
 * жалоба, срок, и что данные сохранятся. Показывается один раз — при входе
 * ошибку выведет форма входа (бан без активной сессии здесь молчит). */
let banNoticeShown = false;
function banNotice(d) {
  if (banNoticeShown) return;
  if (!S.token) return;                 // форма входа сама покажет причину
  banNoticeShown = true;
  doLogout(true);
  const until = Number((d && d.until) || 0);
  modal('Доступ ограничен', `
    <p>На вас поступила жалоба администратору мессенджера.</p>
    <p class="hint">Доступ ограничен на сутки${until ? ' — до ' + fmtDay(until) + ', ' + fmtTime(until) : ''}.
    Переписка и партии сохранятся: после окончания срока можно войти прежним паролем.</p>
    <button class="primary" id="ban-ok" type="button">Понятно</button>`);
  const b = $('#ban-ok');
  if (b) b.addEventListener('click', () => hide($('#modal')));
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
  ['loading', 'setup', 'auth', 'app', 'recover']
    .forEach(n => document.getElementById('screen-' + n).classList.toggle('hidden', n !== name));
  // гаммы действуют только внутри мессенджера: экраны входа остаются фирменно-синими
  const inApp = name === 'app';
  if (inApp !== (document.documentElement.dataset.inApp === '1')) {
    if (inApp) document.documentElement.dataset.inApp = '1';
    else delete document.documentElement.dataset.inApp;
    applyPalette(currentPal(), false);
  }
};

// ─────────────────────────────────────────── pkg3-55: терпеливый старт
// Сеть может быть ограничена (белые списки операторов в часы беспилотной
// опасности) или туннель VPN может рвать рукопожатие HTTPS. Поэтому не сдаёмся
// после первой неудачи: несколько попыток с растущей паузой и честной стадией
// на шкале, а потом — понятная плашка с причинами и кнопкой «Повторить».
async function fetchStateWithRetry() {
  const tries = 4;
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try { return await api('/api/state'); }
    catch (e) {
      lastErr = e;
      if (i < tries - 1) {
        loadUi.show('Сервер не отвечает — попытка ' + (i + 2) + ' из ' + tries + '…', null,
          'проверяем сеть заново');
        await new Promise(r => setTimeout(r, 1200 * Math.pow(2, i)));
      }
    }
  }
  throw lastErr;
}
/** Плашка «сервер не отвечает»: три честные причины и кнопка повторить. */
function netFailBox(message) {
  loadUi.hide();
  const old = document.getElementById('net-fail');
  if (old) old.remove();
  const d = document.createElement('div');
  d.id = 'net-fail';
  d.innerHTML = `<div class="nf-box">
    <h3>Сервер не отвечает</h3>
    <p class="nf-msg">${escapeHtml(message || '')}</p>
    <ul class="nf-list">
      <li><b>Мобильный интернет ограничен белыми списками</b> операторов (часы
        беспилотной опасности): частные серверы в такие часы не пропускаются.
        Подключитесь к Wi-Fi или включите VPN.</li>
      <li><b>VPN на телефоне мешает соединению.</b> Попробуйте выключить VPN
        или переключить его режим/протокол в приложении VPN.</li>
      <li><b>Сервер перезапускается.</b> Подождите минуту и нажмите «Повторить».</li>
    </ul>
    <button class="primary" id="nf-retry" type="button">Повторить</button>
  </div>`;
  document.body.appendChild(d);
  $('#nf-retry').addEventListener('click', () => { d.remove(); boot(); });
}

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
  try { st = await fetchStateWithRetry(); }
  catch (e) { netFailBox('Подробности: ' + ((e && e.message) || e)); return; }
  S.maxUpload = Number(st.maxUpload || DEFAULT_MAX_UPLOAD);
  S.codeProofSalt = st.codeProofSalt || null;   // для проверки кодового слова архивов
  S.serverBuild = st.build || 'без метки (старше pkg2-3)';
  S.serverLabel = st.serverLabel || '';   // pkg3-51: «VPS (основной)» / «Яндекс (запасной)»
  if (st.setupRequired) { loadUi.hide(); return screen('setup'); }
  // pkg3-64: ссылка из письма («…/?recover=…») ведёт прямо на экран восстановления
  const recToken = new URLSearchParams(location.search).get('recover');
  if (recToken) { loadUi.hide(); openRecover(recToken); return; }

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
    try { await startApp(); return; }
    catch (e) {
      console.error('startApp:', e);
      try { await startApp(); return; }
      catch (e2) {
        const msg = ((e2 && e2.message) || String(e2));
        const authFail = /401|просроч|недейств|истёк|войдите заново/i.test(msg);
        if (authFail) { clearSession(); S.token = null; }
        toast('Не удалось открыть сессию: ' + msg + (authFail ? '' : ' Попробуйте ещё раз или войдите по паролю — галочка «запомнить» не пострадала.'), true);
      }
    }
  }
  loadUi.hide();
  screen('auth');
  refreshRegisterGate();   // pkg3-45: показать, открыта ли регистрация и чем
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
  if (t.dataset.tab === 'register') refreshRegisterGate();   // pkg3-45
}));

// ── pkg3-45: регистрация закрыта; дверь — персональная ссылка-приглашение ──
let joinToken = null, joinInfo = null;
const JOIN_REASON = {
  used: 'уже использована: по ней кто-то вошёл',
  expired: 'просрочена (живёт сутки)',
  revoked: 'отозвана пригласившим',
  gone: 'недействительна: пригласивший больше не участник',
  bad: 'не распознана'
};
function parseJoinToken() {
  const m = (location.hash || '').match(/[#&]join=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
/** Решить, открыта ли регистрация и чем: ссылкой, аварийным окном или ничем. */
async function refreshRegisterGate() {
  const joinRow = $('#reg-join'), closedRow = $('#reg-closed'), codeRow = $('#reg-code-row');
  const btn = $('#form-register button.primary');
  if (!joinRow) return;
  joinRow.classList.add('hidden'); closedRow.classList.add('hidden'); codeRow.classList.add('hidden');
  btn.disabled = false; btn.textContent = 'Присоединиться';
  joinToken = parseJoinToken(); joinInfo = null;
  if (joinToken) {
    try { joinInfo = await api('/api/join-info?token=' + encodeURIComponent(joinToken)); }
    catch (e) { joinInfo = { ok: false, reason: 'bad' }; }
    if (joinInfo.ok) {
      joinRow.textContent = 'Вас пригласил(а): ' + joinInfo.inviter + '. Кодовая фраза не нужна.';
      joinRow.classList.remove('hidden');
      return;
    }
    const reason = JOIN_REASON[joinInfo.reason] || JOIN_REASON.bad;
    joinToken = null; joinInfo = null;
    closedRow.textContent = 'Ссылка-приглашение ' + reason + '. Попросите у участника новую.';
    closedRow.classList.remove('hidden');
    btn.disabled = true; btn.textContent = 'Нужна новая ссылка';
    return;
  }
  let st = S.stateCache;
  if (!st) { try { st = await api('/api/state'); S.stateCache = st; } catch (e) { return; } }
  if (st.emergencyOpen) {
    codeRow.classList.remove('hidden');
    joinRow.textContent = 'Администратор открыл аварийное окно: можно войти по кодовой фразе.';
    joinRow.classList.remove('hidden');
    return;
  }
  closedRow.classList.remove('hidden');
  btn.disabled = true; btn.textContent = 'Регистрация закрыта';
}

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
    // pkg3-64: после «свежего» сброса пароля общего ключа может не быть —
    // это не ошибка пароля, а честное состояние «без старой истории»
    let roomKeyRaw = null;
    if (r.wrappedKeyByPass) {
      try { roomKeyRaw = await aesDecryptBytes(wrapKey, r.wrappedKeyByPass); }
      catch (_) { throw new Error('Не удалось расшифровать ключи. Проверьте пароль.'); }
    }
    let pair = null;
    if (r.wrappedPriv) {
      try {
        const pkcs8 = await aesDecryptBytes(wrapKey, r.wrappedPriv);
        pair = { pkcs8, priv: await importPriv(pkcs8), pub: r.user.pub };
      } catch (_) { pair = null; }   // pkg3-64: конверт личного ключа от другого пароля
    }
    if (!pair) {
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
  const name = el.name.value.trim(), pass = el.pass.value, code = (el.code ? el.code.value : '').trim();
  if (pass !== el.pass2.value) return err.textContent = 'Пароли не совпадают';
  S.remember = el.remember.checked;
  btn.disabled = true; btn.textContent = 'Открываем дверь…';
  try {
    const st = S.stateCache || (S.stateCache = await api('/api/state'));
    const saltAuth = newSalt(), saltWrap = newSalt();
    const wrapKey = await aesKeyFrom(pass, saltWrap);
    const pair = await genPairKeys(wrapKey);
    let roomKeyRaw, body;
    if (joinToken && joinInfo && joinInfo.ok) {
      // pkg3-45: ключ комнаты приезжает в конверте, зашифрованном секретом ссылки
      const secret = joinToken.slice(joinToken.indexOf('.') + 1);
      try { roomKeyRaw = await aesDecryptBytes(await aesKeyFrom(secret, joinInfo.invSalt), joinInfo.wrappedRoomKey); }
      catch (_) { throw new Error('Не удалось открыть ключ комнаты этой ссылкой'); }
      body = {
        name, inviteToken: joinToken, saltAuth, saltWrap,
        authKey: toHex(await pbkdf2(pass, saltAuth)),
        wrappedKeyByPass: await aesEncryptBytes(wrapKey, roomKeyRaw),
        pub: pair.pub, wrappedPriv: pair.wrappedPriv
      };
    } else {
      if (!st.emergencyOpen) throw new Error('Регистрация закрыта: нужна персональная ссылка-приглашение');
      if (!code) throw new Error('Аварийный режим: введите кодовую фразу');
      const codeProof = toHex(await pbkdf2(code, st.codeProofSalt));
      const inv = await api('/api/invite', { method: 'POST', body: { codeProof } });
      try { roomKeyRaw = await aesDecryptBytes(await aesKeyFrom(code, inv.codeSalt), inv.wrappedKeyByCode); }
      catch (_) { throw new Error('Кодовая фраза не подходит'); }
      body = {
        name, codeProof, saltAuth, saltWrap,
        authKey: toHex(await pbkdf2(pass, saltAuth)),
        wrappedKeyByPass: await aesEncryptBytes(wrapKey, roomKeyRaw),
        pub: pair.pub, wrappedPriv: pair.wrappedPriv
      };
    }
    const r = await api('/api/register', { method: 'POST', body });
    try { history.replaceState(null, '', location.pathname + location.search); } catch (_) {}
    joinToken = null; joinInfo = null;
    await enterWith(r, roomKeyRaw, saltAuth, saltWrap, pair);
  } catch (ex) { err.textContent = ex.message; btn.disabled = false; btn.textContent = 'Присоединиться'; refreshRegisterGate(); }
});

async function enterWith(r, roomKeyRaw, saltAuth, saltWrap, pair) {
  S.token = r.token; S.me = r.user;
  banNoticeShown = false;   // pkg3-59: новый вход — уведомление о бане можно показать снова
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
    chatKeysOld: new Map(), keyEpochSeen: new Map(), keySplitHinted: new Set(),   // pkg3-63
    chatTitleSrc: new Map(),   // pkg3-65
    oldKeysSeen: new Map(),   // pkg3-69
    oldKeysRetry: new Map(),   // pkg3-71
    oldKeysRetryUp: new Map(),   // pkg3-72
    seq: 0, view: null, threadId: null, quote: null, sig: '',
    typing: [], typingHeaderSig: '',   // pkg3-77: сигналы «пишет/загружает» чужие — выходим, они не наши
    musicStatus: {}   // pkg3-87: чужие звуковые статусы тоже не переживают выход
  });
  $('#messages').innerHTML = '';
  document.title = 'SEGA-CHAT';
  screen('auth');
  refreshRegisterGate();   // pkg3-45
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
        const curEp = chat.keyEpoch || 0;
        if (chat.kind === 'group' && typeof chat.key.ep === 'number' && chat.key.ep !== curEp) {
          // pkg3-65: копия прошлого поколения — в историю (читать старые письма
          // и прежнее название), а у участников запрашивается свежая копия
          pushOldKey(chat.id, { key: await importAes(raw), raw }, chat.key.ep);
          entry = null; issue = { code: 'stale-copy' };
        } else {
          entry = { key: await importAes(raw), raw, ep: curEp };
        }
      } catch (e) { entry = null; issue = { code: 'unwrap-fail' }; }
    }
  } else {
    issue = { code: 'no-group-key' };
  }
  if (entry) {
    // pkg3-65: если прежде ключ не читался, а теперь развернулся — название,
    // иконка и фон перечитываются (их кэш сбрасывается)
    const hadIssue = S.keyIssue.has(chat.id);
    S.chatKeys.set(chat.id, entry); S.keyIssue.delete(chat.id);
    if (hadIssue) invalidateChatSecrets(chat.id);
  }
  else if (issue) {
    S.keyIssue.set(chat.id, issue);
    // pkg3-61: копия группового ключа не читается (или её нет) — просим
    // остальных участников доставить свежую; они делают это фоном (repairGroupKeys)
    // pkg3-65: копия прошлого поколения (stale-copy) — тоже заявка на свежую
    if (chat.kind === 'group' && ['unwrap-fail', 'no-group-key', 'no-wrapper-pub', 'stale-copy'].includes(issue.code)) {
      requestGroupKey(chat.id);
    }
  }
  return entry;
}
/** pkg3-61: заявка «мне нужен рабочий ключ группы» — один раз на чат за сессию,
 * чтобы не долбить сервер; после доставки ключ расшифруется и заявка не нужна. */
const keyNeedAsked = new Set();
function requestGroupKey(chatId) {
  if (!chatId || keyNeedAsked.has(chatId) || !S.token) return;
  keyNeedAsked.add(chatId);
  api('/api/chats/' + encodeURIComponent(chatId) + '/keys/need', { method: 'POST', body: {} })
    .catch(() => keyNeedAsked.delete(chatId));
}
/** pkg3-65: прежние копии ключа группы ХРАНЯТСЯ НА УСТРОЙСТВЕ (localStorage,
 * отдельно для каждой учётки) — после перевыпуска ключа старая переписка,
 * название и иконка группы остаются читаемыми и после перезагрузки страницы.
 * Ключи групп — не переписка: устройство и так хранит личный ключ и шифротекст,
 * поэтому хранение прежних копий не ослабляет защиту. */
const OLDKEYS_STORE = 'sega.oldKeys.v1';
function oldKeysUid() { return (S.me && S.me.id) || S.uid || null; }
function loadOldKeysRaw() {
  try { return JSON.parse(localStorage.getItem(OLDKEYS_STORE) || '{}') || {}; } catch (e) { return {}; }
}
async function loadOldKeys() {
  const uid = oldKeysUid();
  if (!uid) return;
  const per = loadOldKeysRaw()[uid] || {};
  for (const chatId of Object.keys(per)) {
    const list = Array.isArray(per[chatId]) ? per[chatId] : [];
    const olds = S.chatKeysOld.get(chatId) || [];
    for (const it of list) {
      if (!it || typeof it.raw !== 'string' || !it.raw) continue;
      if (olds.some(o => toB64(o.raw) === it.raw)) continue;
      try { olds.push({ key: await importAes(fromB64(it.raw)), raw: fromB64(it.raw), ep: (typeof it.ep === 'number' ? it.ep : null) }); } catch (e) {}
    }
    if (olds.length) S.chatKeysOld.set(chatId, olds);
  }
}
function persistOldKeys(chatId) {
  const uid = oldKeysUid();
  if (!uid || !chatId) return;
  try {
    const all = loadOldKeysRaw();
    const per = all[uid] || (all[uid] = {});
    per[chatId] = (S.chatKeysOld.get(chatId) || []).map(o => ({ ep: (typeof o.ep === 'number' ? o.ep : null), raw: toB64(o.raw) }));
    localStorage.setItem(OLDKEYS_STORE, JSON.stringify(all));
  } catch (e) { /* приватный режим/переполнение — история останется в памяти */ }
}
function oldKeysOf(chatId) { return S.chatKeysOld.get(chatId) || []; }
/** pkg3-66: обмен прежними ключами группы через сервер (сервер слеп):
 * (а) скачиваем свёртки поколений, которых у нас нет, — история возвращается
 * тем, кто пропустил перевыпуски (сидел с закрытым чатом, ещё не был добавлен);
 * (б) выкладываем свои прежние свёртки, если сервер их ещё не хранит, — чтобы
 * история вернулась остальным текущим участникам. Без кнопок, само. */
/** pkg3-70: отпечаток сырья ключа (16 hex sha256) — адрес слота на сервере.
 * Устройства нумеруют поколения по-своему, а сырьё ключа уникально у всех. */
async function fpOf(raw) {
  const d = await crypto.subtle.digest('SHA-256', raw);
  return toHex(new Uint8Array(d)).slice(0, 16);
}
async function reconcileOldKeys(c) {
  if (!S.priv || !Array.isArray(c.oldKeys)) return;
  // что сервер уже хранит: разворачиваем свои свёртки — получаем сами ключи
  const serverRaws = new Set();
  for (const it of c.oldKeys) {
    if (!it || !it.blob) continue;
    try {
      const wk = await pairKeyWith(it.by);
      if (wk) serverRaws.add(toB64(await aesDecryptBytes(wk, it.blob)));
    } catch (e) { /* не наша свёртка */ }
  }
  // ── вниз: всё, чем это устройство читает группу: история И текущий ключ ──
  // pkg3-70: адрес слота — отпечаток ключа, никаких меток поколений:
  // дубли и коллизии меток больше не могут оставить ключ невыложенным
  const mine = oldKeysOf(c.id).filter(o => o && o.raw).slice();
  const cur = S.chatKeys.get(c.id);
  if (cur && cur.raw) mine.push({ key: cur.key, raw: cur.raw });
  const toSend = mine.filter(o => !serverRaws.has(toB64(o.raw)));
  if (toSend.length) {
    // pkg3-72: повторять раз в минуту, пока всё не выложится: одна неудача
    // больше не лишает чат обмена на весь сеанс
    const lastUp = S.oldKeysRetryUp.get(c.id) || 0;
    if (Date.now() - lastUp > 60000) {
      S.oldKeysRetryUp.set(c.id, Date.now());
      try {
      const oldKeys = [];
      for (const o of toSend) {
        const wraps = {};
        for (const uid of c.members) {   // pkg3-67: заворачиваем и самому себе — вторые устройства учётки тоже получают историю
          const pk = await pairKeyWith(uid);
          if (pk) wraps[uid] = await aesEncryptBytes(pk, o.raw);
        }
        oldKeys.push({ fp: await fpOf(o.raw), wraps });
      }
        if (oldKeys.length) await api('/api/chats/' + encodeURIComponent(c.id) + '/keys/old', { method: 'POST', body: { oldKeys } });
      } catch (e) { /* в следующий раз */ }
    }
  }
  // ── вверх: всё, что сервер хранит для нас и чего у нас ещё нет ──
  let got = 0;
  for (const it of c.oldKeys) {
    if (!it || !it.blob) continue;
    try {
      const wrapKey = await pairKeyWith(it.by);
      if (!wrapKey) continue;
      const raw = await aesDecryptBytes(wrapKey, it.blob);
      if (pushOldKey(c.id, { key: await importAes(raw), raw }, (typeof it.ep === 'number' ? it.ep : null))) got++;
    } catch (e) { /* свёртка не наша — пропускаем */ }
  }
  if (got) {
    // вернувшиеся ключи: перечитать ленту, название, иконку, фон
    invalidateChatSecrets(c.id);
    const list = S.messages.filter(m => m.chat === c.id);
    for (const m of list) S.plain.delete(m.id);
    decryptAll(list).catch(() => {});
    if (S.view === c.id) renderMessages(true);
  }
}
/** Прежняя копия ключа — в историю (с ограничением, чтобы не расти вечно). */
function pushOldKey(chatId, entry, ep) {
  if (!chatId || !entry || !entry.raw) return;
  const olds = S.chatKeysOld.get(chatId) || [];
  const rawB = toB64(entry.raw);
  if (olds.some(o => toB64(o.raw) === rawB)) return;
  olds.push({ key: entry.key, raw: entry.raw, ep: (typeof ep === 'number' ? ep : null) });
  while (olds.length > 24) olds.shift();   // pkg3-67: предел поднят с 12 до 24 — история дороже
  S.chatKeysOld.set(chatId, olds);
  persistOldKeys(chatId);
  return true;
}
/** pkg3-65: ключ чата сменился (перевыпуск/доставка) — кэши прочитанного
 * названия, иконки и фона сбрасываются, чтобы перечитаться заново. */
function invalidateChatSecrets(chatId) {
  S.chatTitles.delete(chatId); S.chatTitleSrc.delete(chatId);
  iconCache.delete(chatId); wallCache.delete(chatId);
}
/** pkg3-65: расшифровать текущим ключом, а не выйдет — прежними копиями. */
async function decryptWithHistory(chat, blob) {
  if (!blob || !chat) return null;
  let k = null;
  try { k = await chatKeyOf(chat); } catch (e) { k = null; }
  const cands = (k ? [k] : []).concat(chat.kind === 'group' ? oldKeysOf(chat.id) : []);
  for (const cand of cands) {
    try { return await decryptJSON(cand.key, blob); } catch (e) { /* пробуем следующую копию */ }
  }
  return null;
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
    'stale-copy': 'Ваша копия ключа группы — прежнего поколения (в группе перевыпускали ключ). Свежая копия доставится автоматически от других участников: оставьте чат открытым на несколько минут. Письма, зашифрованные прежним ключом, откроются, если он хранится на этом устройстве.',
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
  // pkg3-63: в группе предлагаем ещё и перевыпуск ключа — лечит разъехавшиеся копии
  const rot = c.kind === 'group' ? '<button class="mini" data-rotate-now="1">Перевыпустить ключ группы</button>' : '';
  return '<div class="key-banner"><div class="kb-title">🔒 Сообщения не расшифрованы</div>'
    + '<div class="kb-text">' + escapeHtml(txt) + '</div>'
    + ((btn || rot) ? '<div class="kb-act">' + btn + rot + '</div>' : '')
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
  if (e.target.closest('[data-rotate-now]')) rotateGroupKey(curChat());   // pkg3-63
});
/** Авто-ремонт групп: у кого есть ключ чата — делится им с участниками без ключа. */
const repairStamp = new Map();
async function repairGroupKeys() {
  if (!S.priv) return;
  for (const c of S.chats) {
    if (c.kind !== 'group') continue;
    const entry = S.chatKeys.get(c.id);
    if (!entry || !entry.raw) continue;
    // pkg3-65: устаревшей копией не делимся — сначала сами получим свежую
    if (typeof entry.ep === 'number' && entry.ep !== (c.keyEpoch || 0)) continue;
    const last = repairStamp.get(c.id) || 0;
    if (Date.now() - last < 5 * 60 * 1000) continue;
    repairStamp.set(c.id, Date.now());
    try {
      const r = await api('/api/chats/' + encodeURIComponent(c.id) + '/keys/missing');
      for (const miss of (r.missing || [])) {
        if (!miss.hasPub || miss.id === S.me.id) continue;
        const pk = await pairKeyWith(miss.id);
        if (!pk) continue;
        // pkg3-65: доставка помечается поколением ключа — сервер не примет устаревшую
        await api('/api/chats/' + encodeURIComponent(c.id) + '/keys', { method: 'POST', body: { userId: miss.id, blob: await aesEncryptBytes(pk, entry.raw), ep: (typeof entry.ep === 'number' ? entry.ep : (c.keyEpoch || 0)) } });
        console.info('[keys] доставил ключ чата участнику ' + miss.id);
      }
    } catch (e) { /* тихо: повторим через пять минут */ }
  }
}
async function prepareChats() {
  for (const c of S.chats) {
    if (c.kind === 'group' && c.titleBlob
        && (!S.chatTitles.has(c.id) || S.chatTitleSrc.get(c.id) !== c.titleBlob)) {
      // pkg3-65: название пробуем текущим ключом и прежними копиями (оно могло
      // быть зашифровано до перевыпуска) и перечитываем, если шифротекст сменился
      const got = await decryptWithHistory(c, c.titleBlob);
      S.chatTitleSrc.set(c.id, c.titleBlob);
      S.chatTitles.set(c.id, (got && typeof got.title === 'string') ? got.title : 'Чат (не удалось прочитать название)');
    } else {
      await chatKeyOf(c);   // прогрев ключа: заявка на доставку, если копии нет/не читается
    }
    // pkg3-66: обмен прежними ключами — история возвращается сама
    if (c.kind === 'group') await reconcileOldKeys(c);
  }
}

// ─────────────────────────────────────────── цикл синхронизации
async function startApp() {
  S.lastReactSeen = Date.now();   // старые реакции не будят уведомления
  screen('app');
  S.seq = 0; S.gen = -1; S.rsince = 0; S.chg = 0; S.retry = {};
  S.messages = []; S.messageIds = new Set(); S.plain = new Map(); S.sig = '';
  S.keyIssue = new Map();
  S.chatKeysOld = new Map(); S.keyEpochSeen = new Map(); S.keySplitHinted = new Set();   // pkg3-63
  S.chatTitleSrc = new Map();   // pkg3-65
  S.oldKeysSeen = new Map();   // pkg3-69
  S.oldKeysRetry = new Map();   // pkg3-71
  S.oldKeysRetryUp = new Map();   // pkg3-72
  await loadOldKeys();   // pkg3-65: прежние копии ключей групп — из памяти устройства
  S.healBusy = false; S.healPauseUntil = 0;
  syncPromise = null; syncQueued = false;
  S.resyncHappened = false; S.warm = false; S.histReady = false; S.lastMergeGone = null;
  S.dmSaved = new Set(); S.savedSeen = {}; S.booted = false;   // pkg3-49: новый вход — счётчики «Новых» с нуля
  S.gapChecked = S.gapChecked || new Set();

  // ── локальная память: мгновенно показать то, что уже есть на устройстве ──
  let warm = null;
  if (S.idb && S.uid) {
    try {
      S.cacheFp = await cacheFp();
      const meta = await S.idb.peek(S.cacheFp);
      if (meta && typeof meta.seq === 'number') {
        const data = await S.idb.loadAll();
        if (data && Array.isArray(data.messages) && data.messages.length) warm = { meta, data };
      }
    } catch (e) { warm = null; }
  }
  if (warm) {
    const meCached = (warm.data.users || []).find(u => u.id === S.uid);
    if (!meCached) warm = null;      // без «меня» тёплый рендер опасен — идём обычным путём
    else S.me = meCached;
  }
  if (warm) {
    S.warm = true;
    // pkg3-49: истёкшие «Новые» из кэша не показываем — их на сервере уже нет
    S.chats = (warm.data.chats || []).filter(c => !(c.kind === 'dm' && c.newUntil && c.newUntil < Date.now())
      && !leavingGet().includes(c.id));   // pkg3-80: из кэша не всплывает игра, из которой уже вышли
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
    await decryptLocal();
    loadUi.hide();                     // история уже на экране — фон работаем без шторки
    await sync(false);                 // дельта; при смене gen — полный дозагруз внутри
    S.histReady = true;                // pkg3-37: память устройства + дельта доехали
    S.initialLoad = false;
    if (S.resyncHappened) persistAll();
    S.sig = ''; renderAll(); renderMessages(true);
    requestAnimationFrame(() => requestAnimationFrame(() => loadUi.hide()));
  } else {
    S.initialLoad = true; S.loadRec = 0; S.loadT0 = Date.now();
    loadUi.show('Загружаем историю', 0);
    const noteTimer = setInterval(() => {
      if (!S.initialLoad) { clearInterval(noteTimer); return; }
      const sec = Math.round((Date.now() - S.loadT0) / 1000);
      const note = S.loadNote || (sec >= 8 ? 'сервер прогревается после простоя — это разовая задержка' : '');
      loadUi.show(null, null, note ? note + ' · ' + sec + ' с' : sec + ' с');
    }, 1000);
    try { await sync(true); } finally { clearInterval(noteTimer); S.loadNote = ''; }
    S.initialLoad = false;
    S.histReady = true;                // pkg3-37: история целиком на устройстве
    loadUi.show('Расшифровываем сообщения', 100);
    if (!S.view && S.chats.length) S.view = [...S.chats].sort((a, b) => b.lastTs - a.lastTs)[0].id;
    S.sig = ''; renderAll(); renderMessages(true);
    persistAll();                      // первый визит: положить историю в локальную память
    requestAnimationFrame(() => requestAnimationFrame(() => loadUi.hide()));
  }
  // старая сессия (сохранённая до pkg3-18) не несла uid: дошиваем и пишем кэш
  if (S.me && S.uid !== S.me.id) { S.uid = S.me.id; saveSession(); await loadOldKeys(); }   // pkg3-65: история ключей настоящей учётки
  reconcileOldKeysChanged().catch(() => {});   // pkg3-71: обмен сразу, как личный ключ загружен
  if (S.idb && S.uid && !S.cacheFp) { S.cacheFp = await cacheFp(); persistAll(); }
  renderCacheState();
  wake('старт приложения');
  refreshPushReady();                  // pkg3-40: знать, можно ли доске спать спокойно
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
// pkg3-40: опрос подешевел в разы. Главный доставщик новинок — пуш: как
// только сообщение (или ход) ложится в облако, служебный воркер получает
// «звонок» и будит окно за 0,15 с — ждать следующего опроса не нужно.
// Поэтому бодрствующее окно спрашивает ленту раз в 15 с (открытая партия —
// раз в 10 с), а через 30 с бездействия окно ЗАСЫПАЕТ: запросы прекращаются
// вовсе, остаётся одна редкая проверка «есть кто?» (раз в 5 минут) на случай,
// если пуш не сработал. Любое касание и любой пуш будят окно МГНОВЕННО.
// Доска больше не держит окно бодрым вечно: ушёл игрок пить чай — окно спит,
// а ход соперника разбудит его сам. Страховка только для браузеров без пуша
// (pushReady === false): там доска, как раньше, не даёт окну уснуть.
// В облаке каждое обращение к ленте — деньги, поэтому сон экономит их
// на порядок, а новинки прилетают даже быстрее, чем при старом опросе.
let lastTouch = Date.now();
const POLL_QS = new URLSearchParams(location.search);
const AWAKE_MS = Math.max(1000, Number(POLL_QS.get('awake')) || 30000);  // сколько бодрствуем после касания
const FAST_MS = Math.max(1000, Number(POLL_QS.get('fast')) || 15000);    // опрос в бодрствовании (пуш приносит новинки раньше)
const GAME_MS = Math.max(1000, Number(POLL_QS.get('game')) || 10000);    // опрос в бодрствовании при открытой доске
// pkg3-57: в «Морском бою» на выстрел отвечает устройство соперника, а не
// человек, — задержки опроса складываются вдвое и партия ощущается вязкой.
// При открытой доске морского боя спрашиваем ленту заметно чаще.
const SB_GAME_MS = Math.max(800, Number(POLL_QS.get('sbgame')) || 2500);
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
// pkg3-80: первое касание заодно «отпирает» звуковой движок игр — браузер
// разрешает звук только после жеста человека
// pkg3-81 (пункт 4): то же касание будит звук после сна телефона
const noteTouch = () => { lastTouch = Date.now(); primeNotifySound(); GS.ensure(); GS.wake(); bootstrapNotifyEngines(); wake('касание окна'); };
for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
  document.addEventListener(ev, noteTouch, { passive: true });
}
function pollDelay() {
  if (pollMode() !== 'awake') return TICK_MS;
  if (sbOnScreen() || coinsOnScreen()) return SB_GAME_MS;   // pkg3-78: забег «Золотой лихорадки» тоже любит частый опрос
  return gameOnScreen() ? GAME_MS : FAST_MS;
}
function gameOnScreen() {
  const c = curChat();
  return !!(c && c.kind === 'game' && c.game && c.game.status === 'playing' && !document.hidden);
}
/** pkg3-57: открыт ли «Морской бой» с идущей партией — тогда опрос быстрее.
 * S.sbPlaying ставит renderSeabattle: после победы частый опрос не нужен. */
function sbOnScreen() {
  const c = curChat();
  return !!(c && c.kind === 'game' && (c.game || {}).rules === 'seabattle'
    && (c.game || {}).status === 'playing' && !document.hidden && S.sbPlaying !== false);
}
/** pkg3-57: на этом устройстве есть флот идущей партии морского боя —
 * значит устройство обязано отвечать на выстрелы (страховка без пуша). */
/** pkg3-78: открыт ли забег «Золотой лихорадки», который ещё не финализирован, — тогда
 * опрос чаще: ждём чужие результаты раундов. S.coinsPlaying ставит renderCoins. */
function coinsOnScreen() {
  const c = curChat();
  return !!(c && c.kind === 'game' && (c.game || {}).rules === 'coins'
    && (c.game || {}).status === 'playing' && !document.hidden && S.coinsPlaying !== false);
}
function sbFleetOnDevice() {
  if (!S.me || !S.chats || !S.chats.length) return false;
  for (const c of S.chats) {
    if (c.kind !== 'game' || (c.game || {}).rules !== 'seabattle' || (c.game || {}).status !== 'playing') continue;
    if ((c.roles || {})[S.me.id] !== 'player') continue;
    const loc = sbLocalGet(c.id);
    if (loc && loc.fleet) return true;
  }
  return false;
}
// pkg3-40: подключён ли пуш. Пока пуш исправен, открытая доска НЕ держит окно
// бодрым вечно — ход соперника будит окно через служебный воркер за 0,15 с.
// Если пуша нет (браузер не умеет, человек выключил, сервер без VAPID-ключей),
// остаётся прежняя страховка: доска держит окно бодрым, опрос каждые 10 с.
// Проверка стоит одного лёгкого запроса, поэтому делается при старте и не
// чаще раза в 5 минут, пока доска открыта.
let pushReady = false;
let pushCheckedAt = 0;
const PUSH_CHECK_MS = 5 * 60 * 1000;
async function refreshPushReady() {
  pushCheckedAt = Date.now();
  try { pushReady = (await pushState()) === 'on'; } catch (e) { pushReady = false; }
}
async function loopStep() {
  // pkg3-77: в открытом чате кто-то набирает сообщение или грузит файл —
  // держим окно бодрым, чтобы его письмо прилетело сразу, не в «тихий час»
  if (!document.hidden && typingIn(S.view).length) wake('собеседник пишет');
  // открытая партия: с пушем окно живёт по общему расписанию (ход разбудит),
  // без пуша — держим бодрым, чтобы игра никогда не «зависала»
  if (gameOnScreen()) {
    if (Date.now() - pushCheckedAt > PUSH_CHECK_MS) refreshPushReady();
    if (!pushReady) wake('партия на экране (страховка без пуша)');
  } else if (!pushReady && sbFleetOnDevice()) {
    // pkg3-57: окно открыто на другом чате, но на этом устройстве флот
    // идущей партии — без пуша держим окно бодрым, чтобы отвечать на выстрелы
    if (Date.now() - pushCheckedAt > PUSH_CHECK_MS) refreshPushReady();
    wake('морской бой: устройство отвечает на выстрелы (страховка без пуша)');
  }
  if (pollMode() === 'awake') pollStats.fast++; else pollStats.ticks++;
  if (S.token) { try { await sync(); } catch (e) {} }
  if (!S.initialLoad) loadUi.hide();   // фоновая синхронизация не оставляет оверлей
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
// pkg3-77: отдельный лёгкий опрос «кто пишет/загружает» — каждые 4 секунды,
// пока открыт чат и вкладка видна. Запрос крошечный (сервер отвечает из памяти,
// базу не трогает), поэтому он не мешает ни «тихому часу», ни батарее заметнее
// обычного. Тот же опрос гасит надпись, когда собеседник передумал или файл доехал.
const TYPING_POLL_MS = Math.max(1500, Number(POLL_QS.get('typing')) || 4000);
function refreshTypingHeader(chatId) {
  const cid = chatId || S.view;
  if (!cid || cid !== S.view) return;
  const sig = typingSig(typingIn(cid));
  if (sig === (S.typingHeaderSig || '')) return;
  S.typingHeaderSig = sig;
  renderTopbar();
}
setInterval(() => {
  if (!S.token || !S.view || document.hidden) return;
  const cid = S.view;
  api('/api/typing?chat=' + encodeURIComponent(cid))
    .then(r => {
      mergeTypingChat(cid, (r && r.typing) || []);
      mergeMusicStatus(r && r.music);   // pkg3-87: «🎵 слушает» живёт и гаснет вместе с опросом
      refreshTypingHeader(cid);
    })
    .catch(() => {});
}, TYPING_POLL_MS);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && S.token) { noteTouch(); coinsWakeAudio(); sync().catch(() => {}); loop(); }
  else if (document.hidden) stopTypingSignal();   // pkg3-77: вкладку спрятали — «пишет…» гаснет сразу
});
window.addEventListener('focus', () => { if (S.token) { noteTouch(); coinsWakeAudio(); markRead(); } });
/** pkg3-81 (пункт 4): телефон уснул и вернулся — звук игр пропадал, потому что
 * мобильный браузер замораживает аудио без жеста человека, а контекст иногда
 * закрывает вовсе. При возвращении будим движок, а если поиск монет ещё идёт —
 * возобновляем мелодию карты. То же самое делает первое касание (noteTouch). */
function coinsWakeAudio() {
  try {
    GS.wake();
    const L = S.coinsLive;
    if (L && L.hunt && GS.isEnabled() && GS.musicPref()) GS.startMusic(L.gen.mapIdx);
  } catch (e) {}
}
// служебный воркер (пуш из облака) будит спящее окно
// pkg3-57: бодрствующее окно тоже добирает новинки СРАЗУ, не дожидаясь
// следующего опроса, — иначе выстрел и автоответ в морском бою ползут
// по 10–15 секунд каждый. Против «шторма» пушей — порог 600 мс.
let lastWakeSync = 0;
if (navigator.serviceWorker) {
  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data && e.data.t === 'wake') {
      wake('сигнал из облака');
      const now = Date.now();
      if (S.token && now - lastWakeSync > 600) { lastWakeSync = now; sync(false).catch(() => {}); }
    }
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
/** pkg3-37: атомарная замена истории при ресинке: сначала история дочитывается
 * целиком, и только потом локальное хранилище заменяется одним движением —
 * без «пустого чата» на экране и без повторной расшифровки того, что уже есть.
 * Свои ещё не отправленные черновики (m.local) не трогаем. */
function mergeFullStore(list) {
  const keep = new Set();
  for (const m of (list || [])) if (m && m.id) keep.add(m.id);
  const keptMsgs = S.messages.filter(m => keep.has(m.id) || m.local);
  const keptIds = new Set(keptMsgs.map(m => m.id));
  const gone = [];
  for (const m of S.messages) if (!keptIds.has(m.id)) gone.push(m.id);
  for (const id of Array.from(S.plain.keys())) if (!keptIds.has(id)) S.plain.delete(id);
  S.messages = keptMsgs;
  S.messageIds = keptIds;
  S.lastMergeGone = gone;   // pkg3-37: стереть удалённое сервером и из кэша устройства
  return addMessages(list);
}
function addMessages(list) {
  if (!S.messageIds || S.messageIds.size !== S.messages.length) rebuildMessageIndex();
  const fresh = [];
  for (const m of (list || [])) {
    if (!m || !m.id || S.messageIds.has(m.id)) continue;
    // pkg3-36: свой ещё не принятый черновик может долететь через опрос раньше
    // ответа POST — узнаём его по точной копии шифроблоба и сразу «удочеряем»:
    // черновик заменяется настоящей записью, дубля на доске не будет
    if (m.blob && m.uid === (S.me || {}).id) {
      const d = S.messages.find(x => x.local && x.blob === m.blob);
      if (d) { adoptSent(d, m, (S.retry[d.id] || {}).payload); fresh.push(m); continue; }
    }
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
  // pkg3-80: игры, из которых человек вышел «мгновенно», не показываются, даже
  // если сервер ещё не успел их стереть; запрос на выход досылается фоном
  const leavingNow = leavingGet();
  if (leavingNow.length) S.chats = S.chats.filter(x => !leavingNow.includes(x.id));
  S.games = data.games || [];
  S.myKnocks = data.myKnocks || [];   // pkg3-49: чужие заявки в мои партии
  // pkg3-53: мои разделы-папки. Чужих сервер не отдаёт — раскладка личная.
  if (Array.isArray(data.mySections)) S.sections = data.mySections;
  // pkg3-57: мои зашифрованные слепки флота «Морского боя» — восстанавливаем
  // расстановку на этом устройстве, чтобы видеть свои корабли и отвечать на выстрелы
  if (data.mySbFleets && typeof data.mySbFleets === 'object') {
    S.sbFleets = data.mySbFleets;
    sbRestoreFleets().catch(() => {});
  }
  S.invites = data.invites || [];
  if (typeof data.rnow === 'number') S.serverNow = data.rnow;   // pkg3-49: часы сервера
  // pkg3-77: сигналы «пишет / загружает» пришли вместе с синхронизацией —
  // обновляем список и сразу освежаем подпись под заголовком открытого чата
  if (Array.isArray(data.typing)) { mergeTypingAll(data.typing); refreshTypingHeader(); }
  if (Array.isArray(data.music)) { mergeMusicStatus(data.music); refreshTypingHeader(); }   // pkg3-87
  // pkg3-49: мои сохранённые личные чаты — по отметкам savedBy у самих чатов;
  // заодно плашка «вас добавили в личные чаты», когда собеседник сохранил переписку
  const meId0 = (S.me && S.me.id) || null;
  // pkg3-54: savedBy теперь есть и у групповых чатов («оставил у себя»)
  S.dmSaved = new Set(S.chats.filter(c => (c.savedBy || []).includes(meId0)).map(c => c.id));
  for (const c of S.chats) {
    if (c.kind !== 'dm') continue;
    const peer = c.members.find(x => x !== (S.me && S.me.id));
    const before = S.savedSeen[c.id];
    const now = (c.savedBy || []).slice();
    S.savedSeen[c.id] = now;
    if (peer && S.booted && before && !before.includes(peer) && now.includes(peer)) {
      toast((userById(peer) || { name: 'Собеседник' }).name + ' добавил(а) вас в свои личные чаты');
    }
  }
  // pkg3-47: мои связи «Приглашенные» и запросы-согласия.
  // pkg3-60: раздел «Приглашенные» из интерфейса убран по решению владельца —
  // знакомство идёт через личные чаты и «Новые»; данные связей по-прежнему
  // приходят (круг видимости на сервере их учитывает), но тосты о запросах
  // и разделы больше не рисуются.
  S.myBonds = new Set(data.myBonds || []);
  S.bondReqs = data.bondReqs || [];
  reconcileKeyEpochs();   // pkg3-63: поколение ключа группы выросло — пере-развернуть
  await prepareChats();
  migrateGameNotify44();   // pkg3-44: в играх все оповещения включены по умолчанию
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
  const prevChatIds = new Set((S.chats || []).map(c => c.id));
  let data = await api('/api/sync?since=' + S.seq + '&rsince=' + (S.rsince || 0) + '&cchg=' + (S.chg || 0) + (document.hidden ? '' : '&active=1'));
  await applySyncMeta(data);

  // в списке появился чат, которого у нас не было (приняли приглашение, пустили
const invSig = (data.invites || []).map(x => x.id).join(',');
  if (invSig !== (S.invitesSig || '')) { S.invitesSig = invSig; S.sig = ''; if (S.view) renderMessages(); }
  const inResp = {};
  for (const m of (data.messages || [])) inResp[m.chat] = (inResp[m.chat] || 0) + 1;
  let backfill = null;
  for (const c of (data.chats || [])) {
    if (!prevChatIds.has(c.id) && (c.count || 0) > 0) { backfill = c.id; break; }
    if (!S.gapChecked.has(c.id)) {
      S.gapChecked.add(c.id);
      const local = S.messages.filter(m => m.chat === c.id).length;
      if ((c.count || 0) > local + (inResp[c.id] || 0)) { backfill = c.id; break; }
    }
  }
  let suppressNotify = false;
  const freshAll = [];
  if (!initial && (data.resync || data.gen !== S.gen || backfill)) {
    // pkg3-37: ресинк без «пустого чата»: всю историю дочитываем ДО замены
    // локального хранилища — экран продолжает показывать переписку из памяти
    S.resyncHappened = true;
    suppressNotify = true;
    let full = await api('/api/sync?since=0&rsince=0&cchg=' + (data.chg || 0) + (document.hidden ? '' : '&active=1'));
    await applySyncMeta(full);
    const accum = (full.messages || []).slice();
    let guardFull = 0;
    while (full.more && guardFull++ < 50) {
      full = await api('/api/sync?since=' + full.seq + '&rsince=0&cchg=' + (full.chg || 0) + (document.hidden ? '' : '&active=1'));
      await applySyncMeta(full);
      accum.push(...(full.messages || []));
    }
    const merged = mergeFullStore(accum);
    if (merged.length) {
      await decryptSmart(merged);
      freshAll.push(...merged);
    }
    data = Object.assign({}, full, { messages: [], more: false });
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
  // pkg3-56: морской бой — если по нашему полю выстрелили, устройство с флотом
  // отвечает само (и вскрывает флот в конце партии); без этого выстрел висит
  sbAutoRespond().catch(() => {});
  if (typeof data.rnow === 'number') S.rsince = data.rnow;
  if (typeof data.chg === 'number') S.chg = data.chg;
  S.booted = true;   // pkg3-49: первый опрос состоялся — плашки «вас добавили» разрешены
  retryLeavingGames();   // pkg3-80: досылаем запросы «мгновенного выхода», не долетевшие раньше
  // pkg3-49: чат исчез из списка (истёкшие «Новые», убранный личный) — его
  // сообщения больше не нужны ни на экране, ни в памяти устройства
  const aliveChats = new Set(S.chats.map(c => c.id));
  const orphanIds = [];
  for (let i = S.messages.length - 1; i >= 0; i--) {
    const m = S.messages[i];
    if (!aliveChats.has(m.chat)) {
      orphanIds.push(m.id);
      S.messages.splice(i, 1);
      S.messageIds.delete(m.id);
      S.plain.delete(m.id);
    }
  }
  if (S.idb && S.cacheFp && !S.initialLoad) {
    S.idb.applySync(S.cacheFp, {
      resync: false,
      messages: freshAll.concat(data.changed || []).map(pickMsg),
      gone: (data.gone || []).map(g => (g && g.id) || g).concat(S.lastMergeGone || []).concat(orphanIds),
      chats: data.chats || [], users: data.users || [],
      // pkg3-49: чаты, пропавшие из списка (истёкшие «Новые»), — долой из кэша
      chatsGone: [...prevChatIds].filter(id => !(data.chats || []).some(c => c.id === id)),
      meta: { me: S.uid, seq: S.seq, gen: S.gen, chg: S.chg, rsince: S.rsince }
    });
    S.lastMergeGone = null;   // pkg3-37: стёртое уже передано кэшу — не повторяем
  }
  // друзья пишут — продлеваем бодрствование (спящее окно будит и этот путь)
  if (!initial && (freshAll.length || touched)) wake('новое в ленте');

  if (freshAll.length && !initial && !suppressNotify) { playGameSounds(freshAll); notifyNewMessages(freshAll); }
  if (!initial) repairGroupKeys();
  if (!initial) {
    notifyReactions();
    // долечиваем заглушки видимого окна на каждом опросе, пока ключи добираются
    const pend = currentWindowIds().filter(id => plainBroken(id));
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
  // pkg3-69: обмен прежними ключами на КАЖДОМ опросе (а не только при старте и
  // полном пересинхроне): догоняющие окна и вторые устройства подтягивают
  // историю сами, без перезагрузки и полных пересборок
  reconcileOldKeysChanged().catch(() => {});
}
/** pkg3-69: запускает обмен для чатов, у которых изменился набор слотов
 * прежних ключей на сервере (сигнатура = метки + наличие моей свёртки). */
async function reconcileOldKeysChanged() {
  // pkg3-71: без личного ключа обмен невозможен — и метку «пройдено» НЕ
  // ставим, иначе первый же опрос на старте (до загрузки ключа) навсегда
  // закрывал окну обмен (случай окна «Для теста»)
  if (!S.priv) return;
  for (const c of S.chats) {
    if (c.kind !== 'group' || !Array.isArray(c.oldKeys)) continue;
    const sig = c.oldKeys.map(o => (o ? (o.id || o.ep) + (o.blob ? 'b' : '-') : '')).join(',');   // pkg3-70: сигнатура по адресу слота
    if (S.oldKeysSeen.get(c.id) === sig) continue;
    S.oldKeysSeen.set(c.id, sig);
    await reconcileOldKeys(c);
  }
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
/**PlainText ещё нет — или прежняя попытка расшифровки упала: такие записи
 * считаем отсутствующими и честно повторяем расшифровку (раньше «🔒» залипал навечно). */
const plainBroken = id => { const p = S.plain.get(id); return !p || !!p.broken; };
async function ensureIds(ids) {
  try {
  const need = [];
  for (const id of ids) {
    if (!plainBroken(id)) continue;
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
    // pkg3-54: служебные строки (события чата) не шифруются — текст кладём сразу
    if (m.svc) {
      const who = userById(m.uid);
      const name = who ? displayName(who) : 'Участник';
      // pkg3-67: служебная строка перевыпуска ключа — кто и когда починил группу
      S.plain.set(m.id, m.svc === 'rotatekeys'
        ? { text: name + ' перевыпустил ключ группы', svc: m.svc }
        : { text: name + ' добавил этот чат в свои разделы', svc: m.svc });
      continue;
    }
    if (!plainBroken(m.id)) continue;
    const chat = chatById(m.chat);
    let k = null;
    try { k = await chatKeyOf(chat); } catch (e) { k = null; }
    // pkg3-63: ключ группы мог перевыпускаться — пробуем текущую копию, затем
    // прежние: письма «старой эпохи» остаются читабельными у тех, кто её имел.
    // pkg3-65: прежние копии хранятся на устройстве, поэтому старая переписка
    // читается и после перезагрузки; пробуем их, даже если текущая копия
    // ещё не доехала или не читается
    const olds = (chat && chat.kind === 'group') ? oldKeysOf(m.chat) : [];
    // ключа нет и истории нет — НЕ ставим заглушку, пропускаем: повторим на следующем опросе
    if (!k && !olds.length) continue;
    let done = false;
    for (const cand of (k ? [k] : []).concat(olds)) {
      try { S.plain.set(m.id, await decryptJSON(cand.key, m.blob)); done = true; break; }
      catch (e) { /* пробуем следующую копию ключа */ }
    }
    if (!done) {
      S.plain.set(m.id, { text: '🔒 не удалось расшифровать', broken: true });
      if (chat && chat.kind === 'group') {
        noteKeySplit(m.chat);
        // pkg3-71: закрытое письмо при наличии слотов на сервере — повод
        // ещё раз попробовать обмен (не чаще раза в минуту на чат)
        if ((chat.oldKeys || []).length) {
          const last = S.oldKeysRetry.get(chat.id) || 0;
          if (Date.now() - last > 60000) {
            S.oldKeysRetry.set(chat.id, Date.now());
            reconcileOldKeys(chat).catch(() => {});
          }
        }
      }
    }
  }
}
/** pkg3-63: часть писем группы не открылась текущим ключом — подсказываем
 * перевыпуск ключа (раз в чат за сеанс): у участников могли разъехаться копии. */
function noteKeySplit(chatId) {
  if (!S.keySplitHinted || S.keySplitHinted.has(chatId)) return;
  // pkg3-70: до первой попытки обмена в этом чате совет не показываем:
  // ключи могли ещё просто не доехать (случай окна «Для теста»)
  if (!S.oldKeysSeen.has(chatId)) return;
  // pkg3-69: не советуем перевыпуск из-за писем, чьи ключи утеряны навсегда:
  // совет уместен, когда закрыто что-то СВЕЖЕЕ (сутки) — признак живой
  // разъехавшейся копии; при музейных замках и наличии истории/свёрток молчим
  const now = Date.now();
  const freshBroken = S.messages.some(m => m.chat === chatId
    && (S.plain.get(m.id) || {}).broken && (m.ts || 0) > now - 24 * 3600 * 1000);
  const c = chatById(chatId);
  const hasMySlots = c && Array.isArray(c.oldKeys) && c.oldKeys.some(o => o && o.blob);
  if (!freshBroken && (oldKeysOf(chatId).length || hasMySlots)) return;
  // pkg3-72: совет показывается ОДИН раз на чат навсегда (хранится на
  // устройстве) — плашка не имеет права надоедать
  try {
    const hinted = JSON.parse(localStorage.getItem('sega.splitHinted.v1') || '[]');
    if (Array.isArray(hinted) && hinted.includes(chatId)) return;
    hinted.push(chatId);
    localStorage.setItem('sega.splitHinted.v1', JSON.stringify(hinted));
  } catch (e) {}
  S.keySplitHinted.add(chatId);
  toast('Похоже, ключ этой группы у части участников другой. Откройте меню чата (⋯) → «Перевыпустить ключ группы»: новые письма снова будут читаться у всех.', true);
}
/** pkg3-63: сервер сообщил о новом поколении ключа группы — прежнюю копию
 * убираем в историю (читать старые письма), текущую разворачиваем заново. */
function reconcileKeyEpochs() {
  const changed = [];
  for (const c of S.chats) {
    if (c.kind !== 'group') continue;
    const ep = c.keyEpoch || 0;
    const seen = S.keyEpochSeen.get(c.id);
    S.keyEpochSeen.set(c.id, ep);
    if (seen === undefined || seen === ep) continue;
    const cur = S.chatKeys.get(c.id);
    // pkg3-65: прежняя копия — в СТОЙКУЮ историю устройства: старая переписка,
    // название и иконка остаются читаемыми и после перезагрузки страницы
    if (cur) pushOldKey(c.id, cur, (typeof cur.ep === 'number' ? cur.ep : (typeof seen === 'number' ? seen : null)));
    S.chatKeys.delete(c.id);
    S.keyIssue.delete(c.id);
    invalidateChatSecrets(c.id);   // название/иконка/фон перечитаются новым ключом и историей
    changed.push(c.id);
  }
  if (!changed.length) return;
  const set = new Set(changed);
  const list = S.messages.filter(m => set.has(m.chat));
  for (const m of list) S.plain.delete(m.id);
  decryptAll(list).catch(() => {});
  S.sig = '';
  if (S.view && set.has(S.view)) renderMessages(true);
}
/** pkg3-63: перевыпуск ключа группы: новый ключ заворачивается каждому
 * текущему участнику, все копии на сервере заменяются, поколение растёт.
 * Закрытые прежде письма остаются закрытыми (старого ключа у части участников
 * не было вовсе — это свойство шифрования), новые читают все. */
async function rotateGroupKey(c) {
  if (!c || c.kind !== 'group') return;
  if (!S.priv) { toast('Нет ключа шифрования: выйдите и войдите снова', true); return; }
  if (!confirm('Перевыпустить ключ группы?\n\n'
    + 'Новый ключ получат все текущие участники: будущие письма снова будут читаться у всех. '
    + 'Сообщения, которые не расшифровываются СЕЙЧАС, останутся закрытыми (старого ключа у части '
    + 'участников не было). Ваша читаемая история останется читаемой: прежние ключи сохраняются '
    + 'на устройстве. Название и иконка группы тоже сохранятся.')) return;
  const raw = rnd(32);
  const keys = {};
  for (const id of c.members) {
    const pk = await pairKeyWith(id);
    if (!pk) { toast('У участника ' + ((userById(id) || {}).name || '') + ' нет ключа шифрования — пусть войдёт с паролем, затем повторите', true); return; }
    keys[id] = { blob: await aesEncryptBytes(pk, raw) };
  }
  try {
    const cur = S.chatKeys.get(c.id);
    // pkg3-65: все ключи, которыми это устройство умеет читать группу —
    // они понадобятся, чтобы переоформить название/иконку/фон новым ключом
    const prevList = (cur ? [cur] : []).concat(oldKeysOf(c.id));
    if (cur) pushOldKey(c.id, cur, (typeof cur.ep === 'number' ? cur.ep : (c.keyEpoch || 0)));
    const r = await api('/api/chats/' + encodeURIComponent(c.id) + '/keys/rotate', { method: 'POST', body: { keys } });
    const newEntry = { key: await importAes(raw), raw, ep: r.keyEpoch };
    S.chatKeys.set(c.id, newEntry);
    S.keyEpochSeen.set(c.id, r.keyEpoch);
    S.keyIssue.delete(c.id);
    S.oldKeysRetryUp.delete(c.id);   // pkg3-67: новый ключ тоже уйдёт в обмен на ближайшей синхронизации
    invalidateChatSecrets(c.id);
    // pkg3-65: название, иконка и фон были зашифрованы прежним ключом —
    // переоформляем их новым, чтобы они не пропали у участников
    await rewrapChatSecrets(c, prevList, newEntry);
    toast('Ключ группы перевыпущен: новые письма будут читаться у всех участников');
    const list = S.messages.filter(m => m.chat === c.id);
    for (const m of list) S.plain.delete(m.id);
    await decryptAll(list);
    S.sig = ''; renderMessages(true);
  } catch (ex) { toast(ex.message, true); }
}
/** pkg3-65: после перевыпуска ключа группы перезашифровать её название, иконку
 * и фото-фон новым ключом (если прежние копии их читают). Сервер содержимое
 * не видит — он хранит новые шифротексты вместо прежних. */
async function rewrapChatSecrets(c, prevList, newEntry) {
  const readOld = async (blob) => {
    if (!blob) return null;
    for (const cand of prevList) {
      try { return await decryptJSON(cand.key, blob); } catch (e) { /* следующая копия */ }
    }
    return null;
  };
  try {
    if (c.titleBlob) {
      const t = await readOld(c.titleBlob);
      if (t && typeof t.title === 'string') {
        const nb = await encryptJSON(newEntry.key, { title: t.title });
        await api('/api/chats/' + encodeURIComponent(c.id) + '/title', { method: 'POST', body: { titleBlob: nb } });
        S.chatTitles.set(c.id, t.title); S.chatTitleSrc.set(c.id, nb);
      }
    }
  } catch (e) { /* название можно переименовать вручную — не страшно */ }
  try {
    if (c.iconRev) {
      const r = await api('/api/chaticon/' + encodeURIComponent(c.id) + '?rev=' + encodeURIComponent(c.iconRev));
      const ic = (r && r.icon) ? await readOld(r.icon) : null;
      if (ic && ic.data) {
        const nb = await encryptJSON(newEntry.key, { data: ic.data });
        await api('/api/chats/' + encodeURIComponent(c.id) + '/icon', { method: 'POST', body: { data: nb } });
        iconCache.delete(c.id);
      }
    }
  } catch (e) { /* иконку можно поставить заново — не страшно */ }
  try {
    if (c.wallRev) {
      const r = await api('/api/wall/' + encodeURIComponent(c.id) + '?rev=' + encodeURIComponent(c.wallRev));
      const w = (r && r.wall) ? await readOld(r.wall) : null;
      if (w && w.data) {
        const nb = await encryptJSON(newEntry.key, { data: w.data });
        await api('/api/chats/' + encodeURIComponent(c.id) + '/wallphoto', { method: 'POST', body: { data: nb } });
        wallCache.delete(c.id);
      }
    }
  } catch (e) { /* фон можно поставить заново — не страшно */ }
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
  // pkg3-36: ходы и события партии подписываем по-человечески (раньше любое
  // сообщение без текста показывалось как «📷 изображение»)
  // pkg3-41: значок — по игре чата, запись хода — по-русски
  const gico = gameIconImg(gameRulesOf(c), 'gmini');   // pkg3-83: в ленте — иконка-картинка
  const body = p.k === 'move' ? `${gico} ход ${rusSan(p.san) || (p.from + '–' + p.to)} · ${author.name}`
    : p.k === 'game-event' ? `${gico} ${p.text || 'событие игры'}`
    : (p.k && p.k.slice(0, 3) === 'sb-') ? `${gico} ${sbNote(p)} · ${author.name}`
    : p.text ? `${author.name}: ${cut(p.text, 120)}` : `${author.name}: 📷 изображение`;
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
  // pkg3-80 (просьба владельца): чат, который открыт на экране, не «сигналит»
  // и не показывает плашку — человек и так смотрит на доску. Мешало в «Морском
  // бое»: глядишь на карту, а на каждый чужой выстрел сверху прилетает
  // уведомление со звуком (на телефоне вкладка «на виду», но «не в фокусе» —
  // старая проверка этого не понимала). Не смотришь на карту — всё как раньше.
  const openId = document.hidden ? null : S.view;
  const incoming = list.filter(m => m.uid !== S.me.id && !isChatMuted(m.chat) && m.chat !== openId);
  if (!incoming.length || S.notify.sound === false) return;
  playNotifySound();
  showDesktopNotification(incoming[incoming.length - 1]);
}

/** pkg3-80: звук игр. Письма партии, которая открыта перед человеком,
 * озвучиваются движком GS (ход, выстрел, попадание…). Тот же набор писем,
 * что глушится в notifyNewMessages, здесь наоборот звучит — одно правило:
 * смотришь на доску → слышишь игру, не смотришь → работает уведомление. */
function playGameSounds(list) {
  if (document.hidden || S.notify.gamesound === false) return;
  const c = chatById(S.view);
  if (!c || c.kind !== 'game') return;
  const fresh = list.filter(m => m.chat === c.id && m.uid !== S.me.id);
  if (!fresh.length) return;
  const p = S.plain.get(fresh[fresh.length - 1].id);
  const name = GS.letterSound(p, false);
  if (name) GS.play(name);
}
/** pkg3-37: движки оповещений по умолчанию включены — но браузер разрешает
 * попросить разрешение только в ответ на касание человека. Поэтому на первом
 * касании окна один раз тихо пробуем включить всё сами: плашки браузера и
 * пуш-подписку. Отказ или ручное выключение запоминаются — больше не пристаём. */
let notifyBootstrapped = false;
function bootstrapNotifyEngines() {
  if (notifyBootstrapped || !S.me) return;
  notifyBootstrapped = true;
  if (S.notify.sound !== false && S.notify.desktop !== false
    && 'Notification' in window && Notification.permission === 'default') {
    requestDesktopNotifications();
  }
  maybeAutoPush();
}
async function maybeAutoPush() {
  try {
    if (localStorage.getItem('sega.pushAuto37')) return;      // уже пробовали или человек решил сам
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !window.isSecureContext) return;
    const st = await pushState();
    if (st !== 'off') return;                                 // пуш уже включён или недоступен
    localStorage.setItem('sega.pushAuto37', 'tried');
    await setPush(true);
  } catch (e) {}
}

// ─────────────────────────────────────────── непрочитанное
/** pkg3-57: служебное письмо партии (ход шахмат/шашек или выстрел морского
 * боя) — не «сообщение»: живёт на доске и в списке ходов, а не в ленте. */
const isGameLetter = p => !!(p && typeof p.k === 'string'
  && (p.k === 'move' || p.k.slice(0, 3) === 'sb-' || p.k.slice(0, 6) === 'coins-'));
/** pkg3-78: человечья подпись служебных писем забега (превью, уведомления).
 * pkg3-80: игра называется «Золотая лихорадка». */
function coinsNote(p) {
  if (!p || !p.k) return 'сталкер';
  if (p.k === 'coins-result') return 'результат раунда ' + (p.round | 0) + ': ' + (p.score | 0) + ' монет';
  if (p.k === 'coins-surrender') return 'сдался в раунде ' + (p.round | 0);
  if (p.k === 'coins-record') return 'новый рекорд забега: ' + (p.total | 0) + ' монет';
  return 'сталкер';
}
/** pkg3-36: видно ли сообщение в ленте. В игровом чате ходы живут на доске и
 * в списке ходов, а не в ленте; нерасшифрованное там же тоже прячется — его
 * вот-вот долечит boardSoon. Правило одно и для ленты, и для линии
 * «Непрочитанные», и для фокуса при открытии чата. */
function feedVisible(m) {
  const c = chatById(m.chat);
  if (!c || c.kind !== 'game') return true;
  const p = S.plain.get(m.id);
  return !!(p && !p.broken && !isGameLetter(p));
}
/** pkg3-37: готовность истории чата на устройстве. Пока история не доехала и
 * не расшифровалась целиком, НЕ показываем пустой чат и «исходную» расстановку
 * фигур — вместо них крутится анимация загрузки.
 *  'ready' — всё на устройстве, можно рисовать;
 *  'load'  — ждём память устройства или сервер (крутим анимацию);
 *  'nokey' — истории нет, потому что нет ключа: показываем плашку, не спиннер. */
function chatHistState(chatId) {
  if (S.keyIssue && chatId && S.keyIssue.has(chatId)) return 'nokey';
  if (S.histReady) return 'ready';
  if (!chatId) return 'load';
  if (!S.warm) return 'load';                 // холодный старт: ждём первую синхронизацию
  const list = S.messages.filter(m => m.chat === chatId && !m.parent);
  if (!list.length) return 'load';            // чата нет в кэше — ждём дельту с сервера
  return list.every(m => S.plain.has(m.id)) ? 'ready' : 'load';
}
const chatHistReady = chatId => chatHistState(chatId) === 'ready';
/** pkg3-37: анимация процесса загрузки — колечко и подпись, чтобы было
 * понятно: история едет, надо немного подождать. */
function histLoadHtml(text) {
  return `<div class="hist-load"><span class="hl-spin"></span><span>${escapeHtml(text || 'Загружаем…')}</span></div>`;
}
function unreadIn(chatId) {
  const reads = myReads();
  const gchat = chatById(chatId);
  let total = 0, mentions = 0;
  for (const m of S.messages) {
    if (m.chat !== chatId || m.uid === S.me.id) continue;
    if (m.seq <= (reads[bucketOf(m)] || 0)) continue;
    const p = S.plain.get(m.id);
    // pkg3-36: ходы партии — не «сообщения»: ни счётчика, ни красной линии.
    // pkg3-57: выстрелы морского боя — тоже (единое правило isGameLetter).
    // В игровом чате нерасшифрованное тоже не считаем: почти всегда это ход,
    // а долечит его boardSoon в течение пары секунд.
    if (isGameLetter(p)) continue;
    if (gchat && gchat.kind === 'game' && (!p || p.broken)) continue;
    total++;
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
  if (S.eco) {
    inner = `<span class="avatar ${cls || ''} eco-av" style="background:${avColor(u.id)}">${escapeHtml(initials(u.name))}</span>`;
  } else if (u.avatar) {
    const hit = avatarCache.get(u.id);
    if (hit && hit.rev === u.avatar) inner = `<img class="avatar ${cls || ''}" src="${hit.src}" alt="">`;
    else { decodeAvatar(u); inner = `<span class="avatar ${cls || ''}" style="background:${avColor(u.id)}">${escapeHtml(initials(u.name))}</span>`; }
  } else {
    inner = `<span class="avatar ${cls || ''}" style="background:${avColor(u.id)}">${escapeHtml(initials(u.name))}</span>`;
  }
  return `<span class="av-wrap" data-uid="${escapeHtml(u.id || '')}">${inner}${withStatus ? `<i class="status${cls === 'xs' ? ' xs' : ''}${isOnline(u) ? ' on' : ''}"></i>` : ''}</span>`;
}
/** pkg3-36: маячки «в сети» обновляются СИНХРОННО во всём готовом DOM —
 * лента, списки чатов, участники, модалки. Раньше лента обновляла аватар
 * только вместе со строкой сообщения, и один человек мог «светиться» в списке
 * и «не светиться» в ленте. Теперь правило одно: смотрит чат — зелёный везде,
 * не смотрит — погашен везде. */
function paintStatuses() {
  const wraps = document.querySelectorAll('.av-wrap[data-uid]');
  for (const w of wraps) {
    const st = w.querySelector('.status');
    if (!st) continue;
    st.classList.toggle('on', !!isOnline(userById(w.dataset.uid)));
  }
}
function chatAvatarHtml(c, cls) {
  if (!c) return `<span class="av-wrap"><span class="avatar ${cls || ''}" style="background:#2353a2"><img class="av-logo" src="logo.png" alt=""></span></span>`;
  if (c.kind === 'dm') return avatarHtml(userById(dmPeer(c)), cls, true);
  const title = chatTitle(c);
  // pkg3-77: игровой чат узнаётся по значку НА ИКОНКЕ (● шашки, ♟ шахматы,
  // ⚓ морской бой) — из названия значок убран, там остались только имена
  let inner = c.kind === 'game' ? gameIconImg(gameRulesOf(c), 'gimg') : escapeHtml(initials(title));
  if (S.eco) { /* иконки чатов в эконом-режиме не подгружаются */ }
  else if (c.iconRev) {
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
    (S.sections || []).map(x => [x.id, x.name, (x.chats || []).length]),
    S.chats.map(c => [c.id, c.members.length, chatTitle(c), c.lastTs, c.archivedByName, c.archivedAt]),
    S.users.map(u => [u.id, u.name, u.isAdmin, !!u.avatar, isOnline(u), u.reads])
  ]);
  if (sig === S.sig) return;
  S.sig = sig;
  renderMe(); renderRail(); renderTopbar(); renderDmBanner(); renderMessages(); renderThread(); renderMemory(); renderQuoteBar(); updateTitle();
  paintIcons(document);
  paintStatuses();   // маячки «в сети» — одним проходом по всему экрану
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
  const gp = S.plain.get(m.id);
  // pkg3-41: значок и запись хода — по игре чата (шашки ●, шахматы ♟), ход по-русски
  const gico = gameIcon(chatById(m.chat));
  if (gp && gp.k === 'move') return gico + ' ход ' + (rusSan(gp.san) || (gp.from + '–' + gp.to));
  if (gp && gp.k && gp.k.slice(0, 3) === 'sb-') return gico + ' ' + sbNote(gp);
  if (gp && gp.k === 'game-invite') return gico + ' приглашение в игру';
  if (gp && gp.k === 'game-decline') return gico + ' приглашение в игру отклонено';   // pkg3-81
  if (gp && gp.k === 'game-event') return gico + ' ' + (gp.text || 'событие игры');
  if (!m) return '';
  const p = S.plain.get(m.id) || {};
  const who = m.uid === S.me.id ? 'Вы: ' : ((userById(m.uid) || {}).name || '') + ': ';
  const body = p.text ? p.text : attLabel(p.att);
  return who + (m.parent ? '↳ ' : '') + body;
}

// ─────────────────────────────────────────── игры: доска и партии (шахматы и шашки)
const PIECE_GLYPH = { P: '♙', N: '♘', B: '♗', R: '♖', Q: '♕', K: '♔', p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚' };
const isWhitePiece = p => p === p.toUpperCase();
const sqIndex = name => 'abcdefgh'.indexOf(name[0]) + (Number(name[1]) - 1) * 8;
const userNameById = id => (userById(id) || {}).name || '…';
/** pkg3-41: в разделе «Игры» живут две игры — шахматы и русские шашки.
 * Правила записаны в карточке игры (game.rules); старым партиям без метки
 * считаем шахматами, поэтому история не ломается. */
const gameRulesOf = c => ((c && c.game && c.game.rules) === 'checkers') ? 'checkers'
  : ((c && c.game && c.game.rules) === 'seabattle') ? 'seabattle'
  : ((c && c.game && c.game.rules) === 'coins') ? 'coins' : 'chess';   // pkg3-78: золотая лихорадка
const gameIcon = c => gameRulesOf(c) === 'checkers' ? '●' : gameRulesOf(c) === 'seabattle' ? '⚓'
  : gameRulesOf(c) === 'coins' ? '🪙' : '♟';
/** pkg3-83 (пункт 3): иконки игр — плитки, нарисованные владельцем (лист 2×2
 * разрезан на четыре файла). Картинками оформлены аватары чатов, письма-партии
 * в ленте и меню «Новая игра»; в чисто текстовых строках (превью списка,
 * подписи ходов) остаются прежние значки-символы: в текст картинку не поставить. */
const GAME_ICON_SRC = { chess: 'img/game-chess.png', checkers: 'img/game-checkers.png', seabattle: 'img/game-seabattle.png', coins: 'img/game-stalker.png' };
const gameIconSrc = rules => GAME_ICON_SRC[rules] || GAME_ICON_SRC.chess;
const gameIconImg = (rules, cls) => `<img class="${cls || 'gimg'}" src="${gameIconSrc(rules)}" alt="">`;
/** pkg3-83 (пункт 1): игра зовётся «Сталкер» (прежнее имя — «Золотая лихорадка»).
 * Внутренний id coins и письма coins-* НЕ менялись — старые чаты и забеги живы. */
const GAME_NAMES = { chess: 'Шахматы', checkers: 'Шашки (русские)', seabattle: 'Морской бой', coins: 'Сталкер' };
const gameNameOf = rules => GAME_NAMES[rules] || String(rules || '');
/** pkg3-56: человеческая подпись служебных писем морского боя (лента, превью, уведомления). */
function sbNote(p) {
  if (!p || !p.k) return 'морской бой';
  if (p.k === 'sb-commit') return 'флот расставлен и запечатан';
  if (p.k === 'sb-shot') return 'выстрел ' + SB.cellName(p.x, p.y);
  if (p.k === 'sb-reply') return SB.cellName(p.x, p.y) + (p.r === 'hit' ? ': ранил' : p.r === 'sunk' ? ': потопил' : ': мимо');
  if (p.k === 'sb-reveal') return 'флот открыт для проверки';
  return 'морской бой';
}
/** pkg3-41: русская шашка — кругляш с короной у дамки. Инлайн-SVG масштабируется
 * под клетку; в эконом-режиме и в неоне перекрашивается правилами CSS. */
function ckDiscHtml(p) {
  const white = p === 'w' || p === 'W';
  const king = p === p.toUpperCase();
  const label = (white ? 'Белая ' : 'Чёрная ') + (king ? 'дамка' : 'шашка');
  const crown = king ? '<path class="crc" d="M30 64 L34 44 L42 54 L50 38 L58 54 L66 44 L70 64 Z"/>' : '';
  return `<span class="ckd ${white ? 'cw' : 'cb'}" role="img" aria-label="${label}" title="${label}">`
    + `<svg viewBox="0 0 100 100"><circle class="cfl" cx="50" cy="50" r="46"/><circle class="crn" cx="50" cy="50" r="33"/>${crown}</svg></span>`;
}
/** pkg3-42: в заголовке партии союз «и» вместо «против» — «Пётр и Мария» короче,
 * чем «Пётр против Марии», а на телефоне каждый знак на счету. Смысл не теряется:
 * значок игры и подписи «приглашение» / «завершена» остались на месте. */
/** pkg3-77: имя игрока в заголовках партии. Соперника, которого нет в моих
 * чатах, зовём «Кто-то» — честнее многоточия. */
const gamePlayerName = id => (userById(id) || {}).name || 'Кто-то';
function gameTitle(c) {
  const g = c.game || {};
  // pkg3-78: у «Золотой лихорадки» нет белых/чёрных — в названии список игроков забега
  if (gameRulesOf(c) === 'coins') {
    const names = (g.players || []).map(gamePlayerName);
    const base = names.length > 1 ? names.join(', ') : 'Сталкер · соло';
    if (g.status === 'finished') return base + ' · завершена';
    return base;
  }
  // pkg3-77: в названии — только имена (значок игры живёт на иконке чата)
  const base = gamePlayerName(g.white) + ' и ' + gamePlayerName(g.black);
  if (g.status === 'invite') return base + ' · приглашение';
  if (g.status === 'finished') return base + ' · завершена';
  return base;
}
/** pkg3-36: подпись в списке чатов у игры — не «последнее сообщение» (это ход,
 * а ходы в ленте больше не живут), а состояние партии. «Последний ход и чей
 * ход» пишем, только когда история целиком расшифрована: иначе позиция врёт.
 * pkg3-41: ход показываем по-русски («Конь f3», «g4:e6»). */
function gameRailSub(c) {
  const g = c.game || {};
  if (g.status === 'invite') return 'ожидание соперника';
  if (g.status === 'finished') {
    return g.result && g.result.winner ? 'победил ' + userNameById(g.result.winner) : 'партия завершена';
  }
  const broken = S.messages.some(m => m.chat === c.id && !m.parent && plainBroken(m.id));
  if (broken) return 'идёт партия…';
  // pkg3-56: морской бой — своя подпись: расстановка / чей выстрел / победа
  if (gameRulesOf(c) === 'seabattle') {
    try {
      const { eng } = gameReplay(c);
      const st = eng.status();
      if (st === 'over') return 'весь флот потоплен — победил ' + userNameById(eng.winner() === 'w' ? g.white : g.black);
      if (st === 'placing') return 'морской бой · расстановка флота';
      return 'морской бой · стреляет ' + userNameById(eng.turn() === 'w' ? g.white : g.black);
    } catch (e) { return 'морской бой…'; }
  }
  // pkg3-78: «Золотая лихорадка» — раунд забега или имя победителя
  if (gameRulesOf(c) === 'coins') {
    try {
      const cs = coinsRunState(c);
      if (cs.plan.final) {
        const w = CE.winnerOf(cs.game, cs.letters, Date.now(), cs.run);
        if ((g.players || []).length <= 1) return 'сталкер · соло · забег ' + cs.run + ' завершён';
        return w ? 'сталкер · победил ' + w.ids.map(gamePlayerName).join(', ') : 'сталкер · забег завершён';
      }
      // pkg3-82 (правка 1): раунды идут личным темпом — в списке чатов
      // виден СВОЙ следующий раунд; у зрителя — сколько раундов закрыто
      const myPer = (cs.plan.per || {})[S.me.id];
      if (myPer && myPer.next) return 'сталкер · ваш раунд ' + myPer.next + ' из ' + cs.rounds;
      if (myPer) return 'сталкер · все раунды пройдены — ждём остальных';
      if (cs.plan.lastDone) return 'сталкер · закрыто раундов: ' + cs.plan.lastDone + ' из ' + cs.rounds;
      return 'сталкер · ждём первого старта';
    } catch (e) { return 'сталкер…'; }
  }
  try {
    const { eng, sans } = gameReplay(c);
    const st = eng.status();
    if (gameRulesOf(c) === 'checkers') {
      if (st === 'over') return 'партия решена';
    } else {
      if (st === 'checkmate') return 'мат! партия решена';
      if (st === 'stalemate' || st === 'draw50') return 'ничья';
    }
    const who = userNameById(eng.turn() === 'w' ? g.white : g.black);
    return (sans.length ? rusSan(sans[sans.length - 1]) + ' · ' : '') + 'ход: ' + who;
  } catch (e) { return 'идёт партия…'; }
}
function openGameTitle(g) {
  // pkg3-78: «Сейчас играют» в «Золотой лихорадке» — вместо пары именуются все игроки забега
  if (g && g.rules === 'coins') {
    const names = (g.players || []).map(gamePlayerName);
    return names.length > 1 ? names.join(', ') : 'Сталкер';
  }
  return gamePlayerName(g.white) + ' и ' + gamePlayerName(g.black);   // pkg3-42: «и» вместо «против»; pkg3-77: незнакомый — «Кто-то»
}
/** pkg3-41: партия разбирается тем движком, что записан в правилах игры:
 * шашки — createCheckers, шахматы — createChess. Записи ходов в истории
 * одинаковые ({k:'move', from, to, …}), движок просто свой. */
function gameReplay(c) {
  // pkg3-56: морской бой разбирается своим движком; сторона письма — по цвету
  // игрока («белый» стреляет первым), как в шахматах и шашках
  if (gameRulesOf(c) === 'seabattle') {
    const eng = createSeabattle();
    const g = c.game || {};
    const sans = [];
    let skipped = 0;
    const msgs = S.messages.filter(m => m.chat === c.id && !m.parent && !m.failed).sort((a, b) => a.seq - b.seq);
    for (const m of msgs) {
      const p = S.plain.get(m.id);
      if (!p || !p.k || p.k.slice(0, 3) !== 'sb-') continue;
      const side = m.uid === g.white ? 'w' : m.uid === g.black ? 'b' : null;
      const line = side ? eng.apply(p, side) : null;
      if (line) sans.push(line);
      else if (p.k === 'sb-reply' || p.k === 'sb-shot') skipped++;
    }
    return { eng, sans, skipped };
  }
  const eng = gameRulesOf(c) === 'checkers' ? createCheckers() : createChess();
  const sans = [];
  let skipped = 0;
  const msgs = S.messages.filter(m => m.chat === c.id && !m.parent && !m.failed).sort((a, b) => a.seq - b.seq);
  for (const m of msgs) {
    const p = S.plain.get(m.id);
    if (p && p.k === 'move') { const san = eng.apply(p); if (san) sans.push(san); else skipped++; }
  }
  return { eng, sans, skipped };
}
const myGameColor = c => (c.game || {}).white === S.me.id ? 'w' : (c.game || {}).black === S.me.id ? 'b' : null;
function gameStatusText(c, eng, st) {
  const g = c.game || {};
  if (g.status === 'invite') return 'Ожидание соперника: приглашение отправлено';
  if (g.status === 'finished' && g.result) {
    return 'Партия окончена: победил ' + userNameById(g.result.winner) + ' (соперник сдался)';
  }
  if (gameRulesOf(c) === 'seabattle') return sbStatusText(c, eng, false);
  if (gameRulesOf(c) === 'checkers') {
    if (st === 'over') return 'Партия окончена: победил ' + userNameById(eng.turn() === 'w' ? g.black : g.white) + ' — у соперника не осталось ходов';
    return 'Ход: ' + userNameById(eng.turn() === 'w' ? g.white : g.black);
  }
  if (st === 'checkmate') return 'Мат! Победил ' + userNameById(eng.turn() === 'w' ? g.black : g.white);
  if (st === 'stalemate') return 'Пат — ничья';
  if (st === 'draw50') return 'Ничья: 50 ходов без взятий и шахов';
  return (st === 'check' ? 'Шах! ' : '') + 'Ход: ' + userNameById(eng.turn() === 'w' ? g.white : g.black);
}
/** pkg3-43: та же суть, но короче — для телефона, где строка на счету.
 * Показывается вместо полной подписи на узком экране (см. .bph-short).
 * Смысл не теряется: подробности всегда есть в списке ходов и в самой партии. */
function gameStatusShortText(c, eng, st) {
  const g = c.game || {};
  if (g.status === 'invite') return 'Ожидание соперника';
  if (g.status === 'finished' && g.result) return 'Победил ' + userNameById(g.result.winner);
  if (gameRulesOf(c) === 'seabattle') return sbStatusText(c, eng, true);
  if (gameRulesOf(c) === 'checkers') {
    if (st === 'over') return 'Победил ' + userNameById(eng.turn() === 'w' ? g.black : g.white);
    return 'Ход: ' + userNameById(eng.turn() === 'w' ? g.white : g.black);
  }
  if (st === 'checkmate') return 'Мат! Победил ' + userNameById(eng.turn() === 'w' ? g.black : g.white);
  if (st === 'stalemate') return 'Ничья: пат';
  if (st === 'draw50') return 'Ничья: 50 ходов';
  return (st === 'check' ? 'Шах! ' : '') + 'Ход: ' + userNameById(eng.turn() === 'w' ? g.white : g.black);
}
function gamePayloadHtml(p, chat) {
  if (!p || typeof p !== 'object' || !p.k) return '';
  const gc0 = chat || (p.game ? (S.chats || []).find(x => x.id === p.game) : null);
  const rules = (gc0 && gc0.game && gc0.game.rules) || p.rules || 'chess';
  const ico = gameIconImg(rules, 'gmini');   // pkg3-83: иконка-картинка в письмах партии
  if (p.k && p.k.slice(0, 3) === 'sb-') return `<div class="mv-line">${ico} ${escapeHtml(sbNote(p))}</div>`;
  if (p.k && p.k.slice(0, 6) === 'coins-') return `<div class="mv-line">${ico} ${escapeHtml(coinsNote(p))}</div>`;   // pkg3-78
  if (p.k === 'move') return `<div class="mv-line">${ico} ${escapeHtml(rusSan(p.san) || (p.from + '–' + p.to))}</div>`;
  if (p.k === 'game-event') return `<div class="mv-sys">${escapeHtml(p.text || '')}</div>`;
  // pkg3-81 (пункт 9): отказ от приглашения — пригласивший видит, кто отказался
  if (p.k === 'game-decline') {
    const gname = rules === 'coins' ? '«Сталкер»'
      : rules === 'checkers' ? 'шашки' : rules === 'seabattle' ? 'морской бой' : 'шахматы';
    const who = p.by === (S.me || {}).id ? 'Вы отклонили приглашение в '
      : userNameById(p.by) + ' отклонил(а) приглашение в ';
    return `<div class="mv-sys">${ico} ${escapeHtml(who + gname)}</div>`;
  }
  // pkg3-87: предложение слушать вместе — карточка с кнопкой «Слушать»
  if (p.k === 'mus-together') {
    return `<div class="mus-card">${p.cover
      ? `<img class="mus-cc" src="${escapeHtml(p.cover)}" alt="">`
      : '<span class="mus-cc mus-cc-e">🎵</span>'}
      <span class="mus-ct"><b>Слушать вместе</b><span>${escapeHtml(p.title || p.url || '')}</span></span>
      <button class="mini primary" data-mus-join="${escapeHtml(p.url || '')}" data-mus-title="${escapeHtml(p.title || p.url || '')}" data-mus-pos="${Number(p.pos) || 0}" data-mus-ts="${Number(p.ts) || 0}">Слушать</button></div>`;
  }
  if (p.k === 'game-invite') {
    const mine = p.to === (S.me || {}).id;
    const gc = (S.chats || []).find(x => x.id === p.game);
    const pending = (S.invites || []).some(x => x.id === p.game);
    // pkg3-61: принятое приглашение — второй вход в игру для обеих сторон
    // (пригласившего и приглашённого), и остаётся им, пока игру не удалили
    const inGc = !!(gc && (gc.members || []).includes((S.me || {}).id));
    // pkg3-78: «Золотая лихорадка» стартует сразу, статус 'playing' ещё не значит «принято»:
    // принято — когда адресат вошёл в состав игроков; отклонено — когда выпал из invitees
    const coinsInv = rules === 'coins';
    const toMember = !!(gc && (gc.members || []).includes(p.to));
    const toInvited = !!(gc && (((gc.game || {}).invitees) || []).includes(p.to));
    const accepted = coinsInv ? !!(gc && (toMember || inGc))
      : !!(gc && (inGc || (gc.game || {}).status !== 'invite'));
    const declinedCoins = coinsInv && !!gc && !toMember && !toInvited;
    let act;
    if (declinedCoins) {
      act = '<div class="tiny muted">Приглашение отклонено</div>';
    } else if (accepted) {
      act = '<div class="tiny" style="color:#2c7a3f;font-weight:600">Приглашение принято ✓</div>'
        + (inGc ? `<div style="margin-top:8px"><button class="mini primary" data-game-enter="${escapeHtml(p.game)}">Войти в игру</button></div>` : '');
    } else if (gc && !mine) {
      act = '<div class="tiny muted">ждём ответа…</div>';
    } else if (pending && mine) {
      act = `<div style="margin-top:8px;display:flex;gap:6px">
        <button class="mini primary" data-game-accept="${escapeHtml(p.game)}" data-choice="${escapeHtml(p.colorChoice || '')}" data-rules="${escapeHtml(p.rules || '')}">Войти в игру</button>
        <button class="mini danger" data-game-decline="${escapeHtml(p.game)}" data-rules="${escapeHtml(p.rules || '')}">Отклонить</button></div>`;
    } else act = coinsInv
      ? '<div class="tiny muted">Приглашение больше недействительно</div>'
      : '<div class="tiny muted">Приглашение больше недействительно (игра удалена)</div>';
    return `<div class="invite-card">${ico} <b>Приглашение в ${rules === 'checkers' ? 'шашки' : rules === 'seabattle' ? 'морской бой' : rules === 'coins' ? '«Сталкер»' : 'шахматы'}</b>
      <div class="tiny muted">${escapeHtml(p.note || '')}</div>${act}</div>`;
  }
  return '';
}
function layoutGame(on) {
  const main = $('#main');
  let right = $('#game-right');
  if (on) {
    // уже разложены — не трогаем DOM, иначе каждое перерисовывание даёт моргание
    if (right && main.classList.contains('game-mode')
      && $('#messages').parentElement === right && $('#composer').parentElement === right) return;
    // pkg3-39: браузер сбрасывает прокрутку, когда узел #messages переносят
    // в другой угол DOM, — запоминаем место ленты до переноса и возвращаем после
    const keep = feedScrollKeep();
    if (!right) { right = document.createElement('div'); right.id = 'game-right'; main.appendChild(right); }
    right.appendChild($('#search-results'));
    right.appendChild($('#messages'));
    right.appendChild($('#scroll-bottom'));
    right.appendChild($('#composer'));
    main.classList.add('game-mode');
    // pkg3-37: ручка сверху шторки чата: одно касание — раскрыть чат поверх
    // доски, ещё одно — свернуть; потянул — выбрал нужный размер окна чата
    if (!right.querySelector('#gm-grip')) {
      right.insertAdjacentHTML('afterbegin',
        '<div id="gm-grip" role="button" aria-label="Окно чата: коснитесь, чтобы раскрыть или свернуть; потяните, чтобы изменить размер"><i></i></div>');
    }
    applyGmChatSize();
    feedScrollKeepRestore(keep);
  } else if (right) {
    const keep = feedScrollKeep();
    const bw = $('#board-wrap');
    bw.after($('#search-results'), $('#messages'), $('#scroll-bottom'), $('#composer'));
    right.remove();
    main.classList.remove('game-mode', 'gm-expanded', 'gm-sized', 'thread-collapsed');
    feedScrollKeepRestore(keep);
  } else {
    main.classList.remove('game-mode', 'gm-expanded', 'gm-sized', 'thread-collapsed');
  }
}
/** pkg3-37: вернуть выбранный перетаскиванием размер шторки чата (телефон, вертикально). */
function applyGmChatSize() {
  const main = $('#main'), right = $('#game-right');
  if (!right) return;
  if (!window.matchMedia('(max-width:959px) and (orientation:portrait)').matches) { clearGmSize(); return; }
  let h = '';
  try { h = localStorage.getItem('sega.gmChatH') || ''; } catch (e) {}
  if (/^\d+(\.\d+)?px$/.test(h)) {
    right.style.height = h;
    main.classList.add('gm-sized');
    main.classList.remove('gm-expanded', 'thread-collapsed');
  } else clearGmSize();
}
function clearGmSize() {
  const right = $('#game-right');
  if (right) right.style.height = '';
  $('#main').classList.remove('gm-sized');
}
// ── pkg3-37: ручка шторки чата на телефоне: касание — раскрыть/свернуть, тяга — размер ──
(function initGmGrip() {
  let drag = null;
  document.addEventListener('pointerdown', e => {
    const g = e.target.closest && e.target.closest('#gm-grip');
    if (!g) return;
    const right = $('#game-right');
    if (!right) return;
    e.preventDefault();
    drag = { y: e.clientY, h: right.offsetHeight, moved: false };
    if (g.setPointerCapture) { try { g.setPointerCapture(e.pointerId); } catch (err) {} }
  }, { passive: false });
  document.addEventListener('pointermove', e => {
    if (!drag) return;
    const dy = drag.y - e.clientY;
    if (!drag.moved && Math.abs(dy) < 7) return;
    drag.moved = true;
    const right = $('#game-right'), main = $('#main');
    if (!right) return;
    const max = Math.round((window.innerHeight || 600) * 0.92);
    const h = Math.max(120, Math.min(max, drag.h + dy));
    main.classList.add('gm-sized');
    main.classList.remove('gm-expanded', 'thread-collapsed');
    right.style.height = h + 'px';
  });
  const finishGrip = () => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    const main = $('#main');
    if (moved) {
      const right = $('#game-right');
      if (right) { try { localStorage.setItem('sega.gmChatH', right.style.height || ''); } catch (e) {} }
      return;
    }
    // касание: свёрнутый → обычный; раскрытый → обычный; обычный → раскрытый поверх доски
    if (main.classList.contains('thread-collapsed')) { main.classList.remove('thread-collapsed'); return; }
    if (main.classList.contains('gm-expanded')) { main.classList.remove('gm-expanded'); clearGmSize(); return; }
    clearGmSize();
    main.classList.add('gm-expanded');
  };
  document.addEventListener('pointerup', finishGrip);
  document.addEventListener('pointercancel', () => { drag = null; });
})();
window.addEventListener('resize', () => {
  if ($('#main').classList.contains('game-mode')) applyGmChatSize();
  syncSearchVisibility();   // pkg3-42: повернули телефон / изменили размер — строка поиска могла скрыться
});
/** pkg3-36: король на доске — аватар игрока (фото или кружок с инициалами).
 * Пустая строка — аватар ещё грузится, тогда временно остаётся обычный король.
 * В эконом-режиме (1 бит) фотографии запрещены — всегда обычный король. */
function kingFaceHtml(p, g) {
  if (S.eco) return '';
  const uid = isWhitePiece(p) ? g.white : g.black;
  const u = userById(uid);
  if (!u) return '';
  const side = isWhitePiece(p) ? ' kw' : ' kb';
  const hit = avatarCache.get(u.id);
  if (u.avatar) {
    if (hit && hit.rev === u.avatar) return `<img class="pcimg king-av${side}" src="${hit.src}" alt="${escapeHtml(p)}" draggable="false">`;
    decodeAvatar(u);
    return '';
  }
  return `<span class="pcimg king-av king-init${side}" style="background:${avColor(u.id)}">${escapeHtml(initials(u.name))}</span>`;
}
/** Состояние аватаров королей — в сигнатуре доски: как только картинка
 * доехала, доска перерисуется и король сменится аватаром. */
function kingFaceSig(g) {
  return [g.white, g.black].map(id => {
    const u = userById(id);
    if (!u) return '?';
    if (!u.avatar) return 'i' + u.name;
    const hit = avatarCache.get(u.id);
    return (hit && hit.rev === u.avatar) ? 'y' : 'n';
  }).join(',');
}
/** pkg3-36: компактная запись ВСЕЙ партии парами «1. e4 e5», последний ход
 * подсвечен. Список живёт под доской и прокручивается отдельно от чата.
 * pkg3-41: ходы показываются по-русски — «Конь f3» вместо «Nf3»,
 * «Короткая рокировка» вместо «O-O»; шашечная запись («c3-d4», «g4:e6»)
 * и так русская, rusSan пропускает её как есть. */
function movesListHtml(sans) {
  if (!sans.length) return '<div class="tiny muted mv-empty">Ходов пока нет — партия вот-вот начнётся</div>';
  let out = '';
  for (let i = 0; i < sans.length; i += 2) {
    const w = rusSan(sans[i]), bl = sans[i + 1] ? rusSan(sans[i + 1]) : '';
    out += `<div class="mrow-mv"><span class="mv-n">${i / 2 + 1}.</span>`
      + `<span class="mv-w${i === sans.length - 1 ? ' last' : ''}">${escapeHtml(w)}</span>`
      + `<span class="mv-b${bl && i + 1 === sans.length - 1 ? ' last' : ''}">${bl ? escapeHtml(bl) : ''}</span></div>`;
  }
  return out;
}
/** pkg3-80: спокойный сигнал конца партии. Играется ОДИН раз на устройство,
 * когда состояние партии сменилось на глазах: победа / поражение / ничья.
 * Ключ состояния запоминается в S.sndEnd: первое знакомство с партией (открыли
 * старую, уже завершённую) проходит молча, а спящая вкладка не тратит звук —
 * доиграет, когда человек вернётся. */
function gameEndSound(c, key) {
  S.sndEnd = S.sndEnd || {};
  const prev = S.sndEnd[c.id];
  if (prev === key) return;
  if (document.hidden) return;
  S.sndEnd[c.id] = key;
  if (prev === undefined || key === 'play') return;
  if (key === 'draw') { GS.play('draw'); return; }
  if (key === 'victory') { GS.play('victory'); return; }
  if (key === 'end-neutral') { GS.play('end'); return; }
  const id = key.slice(key.indexOf(':') + 1);
  const role = (c.roles || {})[S.me.id];
  if (role !== 'player') { GS.play('end'); return; }   // зрителю — нейтральная кода
  GS.play(id === S.me.id ? 'win' : 'lose');
}
/** pkg3-80: конец партии шахмат/шашек/морского боя → ключ для gameEndSound. */
function boardEndKey(c, g, st, eng, sbWinner) {
  if (g.status === 'finished') {
    const w = (g.result || {}).winner;
    return w ? 'over:' + w : 'draw';
  }
  if (sbWinner) return 'over:' + sbWinner;
  if (st === 'checkmate' || st === 'over') {
    const w = eng.turn() === 'w' ? g.black : g.white;   // ходить нечем/мат — победа соперника
    return w ? 'over:' + w : 'end-neutral';
  }
  if (st === 'stalemate' || st === 'draw50') return 'draw';
  return 'play';
}
function renderBoard() {
  const wrap = $('#board-wrap');
  if (!wrap) return;
  const c = curChat();
  if (!c || c.kind !== 'game') { GS.stopMusic(); layoutGame(false); wrap.classList.add('hidden'); wrap.innerHTML = ''; return; }
  if (gameRulesOf(c) !== 'coins') GS.stopMusic();   // pkg3-80: музыка lebt только в забеге
  layoutGame(true);
  // pkg3-37: ложная «исходная расстановка» больше не показывается: пока ходы
  // не доехали и не расшифровались — анимация загрузки; нет ключа — плашка
  const hst = chatHistState(c.id);
  if (hst !== 'ready') {
    const lsig = 'hist|' + hst + '|' + c.id + '|' + (S.eco ? 1 : 0);
    if (S.boardSig !== lsig || wrap.dataset.chat !== c.id || !wrap.firstChild) {
      S.boardSig = lsig; wrap.dataset.chat = c.id;
      wrap.classList.remove('hidden');
      wrap.innerHTML = `<div class="board-panel"><div class="bp-loading">`
        + (hst === 'nokey'
          ? `<span class="bp-load-ico">🔒</span><b>На устройстве нет ключа этой партии</b><span class="tiny muted">Доска откроется, когда ключ вернётся — плашка «Восстановить ключи» ждёт в ленте чата</span>`
          : `<span class="hl-spin big"></span><b>Загружаем ходы партии…</b><span class="tiny muted">Положение фигур появится, как только история догрузится</span>`)
        + `</div></div>`;
    }
    return;
  }
  // pkg3-78: «Золотая лихорадка» — своя панель: карта с туманом войны, результаты
  if (gameRulesOf(c) === 'coins') return renderCoins(wrap, c);
  const { eng, sans, skipped } = gameReplay(c);
  const st = eng.status();
  const my = myGameColor(c);
  const role = (c.roles || {})[S.me.id];
  const flip = my === 'b';
  const b = eng.board();
  const lm = eng.lastMove();
  const g = c.game || {};
  const rules = gameRulesOf(c);
  // pkg3-56: морской бой рисуется своей панелью (два поля 10×10 вместо доски 8×8)
  if (rules === 'seabattle') return renderSeabattle(wrap, c, eng, st, sans, role, my);
  gameEndSound(c, boardEndKey(c, g, st, eng, null));   // pkg3-80: финал партии звучит один раз
  // pkg3-41: у шашек подсвечиваем всю цепочку взятия (откуда — посадки — куда)
  const lmSqs = lm ? (lm.path && lm.path.length ? lm.path : [lm.from, lm.to]) : [];
  let cells = '';
  for (let r = 7; r >= 0; r--) {
    for (let f = 0; f < 8; f++) {
      const rr = flip ? 7 - r : r, ff = flip ? 7 - f : f;
      const i = rr * 8 + ff;
      const name = 'abcdefgh'[ff] + (rr + 1);
      const cls = 'sq ' + (((ff + rr) % 2) ? 'dark' : 'light')
        + (lmSqs.includes(name) ? ' lm' : '')
        + (S.selSq === name ? ' sel' : '')
        + ((S.selTargets || []).includes(name) ? (b[i] ? ' tgt cap' : ' tgt') : '');
      const p = b[i];
      let img = '';
      if (p) {
        if (rules === 'checkers') img = ckDiscHtml(p);
        else {
          const face = p.toUpperCase() === 'K' ? kingFaceHtml(p, g) : '';
          img = face || `<img class="pcimg" src="pieces/${isWhitePiece(p) ? 'w' : 'b'}${p.toUpperCase()}.svg" alt="${escapeHtml((window.PIECE_RUS || {})[p.toUpperCase()] || p)}" draggable="false">`;
        }
      }
      // pkg3-44: координаты больше НЕ рисуются внутри клеток — они вынесены
      // за пределы доски (колонка цифр слева, ряд букв снизу), см. board-frame.
      cells += `<div class="${cls}" data-sq="${name}">${img}</div>`;
    }
  }
  // pkg3-44: подписи рядов и колонок за доской. Порядок — экранный (сверху вниз,
  // слева направо), значения — настоящие координаты с учётом переворота,
  // поэтому при игре чёрными рамка показывает верные цифры и буквы.
  const rankLbl = [], fileLbl = [];
  for (let r = 7; r >= 0; r--) rankLbl.push((flip ? 7 - r : r) + 1);
  for (let f = 0; f < 8; f++) fileLbl.push('abcdefgh'[flip ? 7 - f : f]);
  const ids_missing = S.messages.filter(m => m.chat === c.id && !m.parent && plainBroken(m.id)).length;
  /** pkg3-42: кнопки управления партией переехали из-под доски в заголовок над ней —
   * слева и справа от надписи «чей ход». Так они не занимают отдельную строку,
   * а на телефоне доска вместе с чатом умещается в экран без прокрутки.
   * Подписи укорочены (полный текст — во всплывающей подсказке и в окне
   * подтверждения, которое и так всё объясняет). */
  const ctrlL = [], ctrlR = [];
  if (role) {
    const label = role === 'viewer' ? 'Покинуть'
      : g.status === 'playing' ? 'Сдаться'
        : g.status === 'invite' ? 'Отменить приглашение'
          : 'Удалить игру';
    const full = role === 'viewer' ? 'Покинуть игру'
      : g.status === 'playing' ? 'Сдаться и выйти'
        : g.status === 'invite' ? 'Отменить приглашение и удалить игру'
          : 'Закрыть и удалить игру';
    ctrlL.push(`<button class="mini danger" id="gm-leave" title="${escapeHtml(full)}">${label}</button>`);
  }
  if (role === 'player' && (c.knocks || []).length) {
    ctrlR.push(`<button class="mini" id="gm-knocks" title="Заявки зрителей: ${c.knocks.length}">Заявки: ${c.knocks.length}</button>`);
  }
  const ctrl = ctrlL.concat(ctrlR);
  // pkg3-38: мобильная кнопка «чат: свернуть/развернуть» убрана по просьбе владельца —
  // на телефоне чат и так всегда внизу, а ручка-шторка над ним раскрывает и меняет размер
  const showTurn = g.status === 'playing' && (st === 'playing' || st === 'check');
  const sig = [c.id, sans.length, st, S.selSq || '', (S.selTargets || []).join(','),
    ctrl.join(','), (c.knocks || []).length, flip ? 1 : 0, gameStatusText(c, eng, st),
    rules === 'checkers' ? 'ck' : kingFaceSig(g), S.eco ? 1 : 0].join('|');
  if (S.boardSig === sig && wrap.dataset.chat === c.id && wrap.firstChild) return;
  // куда был прокручен список ходов — вернём позицию, если партия не изменилась
  const prevGm = $('#game-moves');
  const prevTop = prevGm ? prevGm.scrollTop : null;
  const prevMoves = (S.movesShown && S.movesShown.chat === c.id) ? S.movesShown.len : -1;
  S.boardSig = sig; wrap.dataset.chat = c.id;
  if (skipped) {
    // ход есть в истории, но на доску не лёг: порядок или расшифровка сбоили
    console.warn('[board] ходов не легло: ' + skipped + ' из ' + sans.length);
    const guard = c.id + ':' + sans.length;
    if (!ids_missing && S.reskipGuard !== guard) { S.reskipGuard = guard; sync(false).catch(() => {}); }
  }
  wrap.classList.remove('hidden');
  // pkg3-43: заголовок доски — ДВЕ строки, а не одна с кнопками по краям.
  // В pkg3-42 кнопки стояли на одной строке с надписью; при длинной надписи
  // («Ожидание соперника: приглашение отправлено» в гамме «Синтвейв» — моноширинный
  // шрифт, верхний регистр, разрядка) боковые колонки сжимались, и кнопка с
  // white-space:nowrap вылезала прямо поверх текста. Две строки исключают
  // наложение при любой длине надписи и любой гамме.
  //   строка 1 — состояние партии (по центру, переносится при нужде);
  //   строка 2 — кнопки управления, по центру с зазором.
  // На телефоне строка 1 показывает короткую подпись (.bph-short), строка 2 —
  // те же кнопки, но уплотнённые. Кнопок нет (человек не участник и не зритель) —
  // вторая строка не рисуется вовсе, чтобы не оставлять пустую полосу.
  const btnsRow = ctrl.length
    ? `<div class="bph-btns">${ctrl.join(' ')}</div>` : '';
  wrap.innerHTML = `<div class="board-panel">
    <div class="bp-head">
      <div class="bph-top">${showTurn ? `<i class="tdot ${eng.turn()}"></i>` : ''}<span class="bph-full">${escapeHtml(gameStatusText(c, eng, st))}</span><span class="bph-short">${escapeHtml(gameStatusShortText(c, eng, st))}</span></div>
      ${btnsRow}
    </div>
    <div class="board-frame">
      <div class="bf-ranks" aria-hidden="true">${rankLbl.map(x => `<i>${x}</i>`).join('')}</div>
      <div class="board" id="board">${cells}</div>
      <div class="bf-files" aria-hidden="true">${fileLbl.map(x => `<i>${x}</i>`).join('')}</div>
    </div>
    <div class="bp-moves-list" id="game-moves">${movesListHtml(sans)}</div>
  </div>`;
  const gm = $('#game-moves');
  if (gm) {
    if (prevMoves !== sans.length) gm.scrollTop = gm.scrollHeight;   // новый ход — следим за концом
    else if (prevTop !== null) gm.scrollTop = prevTop;               // просто перерисовали — держим позицию
    S.movesShown = { chat: c.id, len: sans.length };
  }
}
// ─────────────────────────────────────────── pkg3-56: морской бой ─────────────────
/** Порядок расстановки: сначала крупные, как на листочке. */
const SB_ORD = [4, 3, 3, 2, 2, 2, 1, 1, 1, 1];
function sbLocalGet(id) { try { return JSON.parse(localStorage.getItem('sega.sb.' + id)) || null; } catch (e) { return null; } }
function sbLocalSet(id, v) { try { localStorage.setItem('sega.sb.' + id, JSON.stringify(v)); } catch (e) {} }
async function sbSha(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function sbPlace(c) {
  S.sbPlace = S.sbPlace || {};
  if (!S.sbPlace[c.id]) S.sbPlace[c.id] = { fleet: [], horiz: true };
  return S.sbPlace[c.id];
}
/** pkg3-56: состояние морского боя словами — в заголовок панели и на телефон. */
function sbStatusText(c, eng, short) {
  const g = c.game || {};
  const my = myGameColor(c);
  const nameOf = s => userNameById(s === 'w' ? g.white : g.black);
  if (g.status === 'invite') return short ? 'Ожидание соперника' : 'Ожидание соперника: приглашение отправлено';
  if (g.status === 'finished' && g.result) {
    return (short ? '' : 'Партия окончена: ') + 'победил ' + userNameById(g.result.winner) + (short ? '' : ' (соперник сдался)');
  }
  const st = eng.status();
  if (st === 'over') return (short ? '' : 'Весь флот потоплен! ') + 'Победил ' + nameOf(eng.winner());
  if (st === 'placing') {
    if (!my) return short ? 'Расстановка' : 'Игроки расставляют флот';
    if (!eng.committed(my)) return short ? 'Расставьте флот' : 'Расставьте флот: корабли не касаются друг друга даже углами. Потом — «В бой!»';
    if (!eng.committed(SB.other(my))) return short ? 'Ждём соперника' : 'Ваш флот запечатан. Ждём расстановку соперника…';
    return short ? 'Вот-вот начнём' : 'Оба флота запечатаны — сейчас начнём';
  }
  if (!my) return short ? 'Идёт партия' : 'Стреляет ' + nameOf(eng.turn());
  const pen = eng.pendingShot();
  if (pen) {
    return pen.side === my
      ? (short ? 'Ждём ответ' : 'Ваш выстрел отправлен — ждём ответ устройства соперника')
      : (short ? 'Соперник стреляет' : 'Соперник стреляет по вашему полю…');
  }
  if (eng.turn() === my) return short ? 'Ваш выстрел' : 'Ваш выстрел! Выберите клетку на чужом поле';
  return short ? 'Стреляет соперник' : 'Стреляет соперник: ' + nameOf(eng.turn());
}
/** Рамка поля 10×10 с подписями рядов и колонок, как в бумажной игре. */
function sbFrameHtml(boardHtml) {
  const ranks = Array.from({ length: 10 }, (_, i) => `<i>${i + 1}</i>`).join('');
  const files = SB.COLS.map(l => `<i>${l}</i>`).join('');
  return `<div class="sb-frame"><div class="sbf-ranks" aria-hidden="true">${ranks}</div>${boardHtml}<div class="sbf-files" aria-hidden="true">${files}</div></div>`;
}
function sbShipImg(s) {
  const w = s.horiz ? s.len * 10 : 10, h = s.horiz ? 10 : s.len * 10;
  return `<img class="sb-ship" src="img/sb-ship${s.len}${s.horiz ? 'h' : ''}.png" alt="${escapeHtml(SB.SHIP_NAMES[s.len] || 'корабль')}" draggable="false"
    style="left:${s.x * 10}%;top:${s.y * 10}%;width:${w}%;height:${h}%">`;
}
/**
 * Поле стороны boardSide: сетка с отметками (точка — промах, взрыв — ранение,
 * взрыв по всему кораблю + точки вокруг — потопил) и кораблями.
 * pkg3-57: три слоя — клетки-сетка (низ), корабли (середина), отметки (верх):
 * взрывы теперь рисуются ПОВЕРХ кораблей, а не прячутся под ними.
 * Корабли: свои — всегда (расстановка с этого устройства или слепок с другого
 * своего устройства), чужие — потопленные (их клетки пришли в ответе «потопил»,
 * это уже не секрет) и все подряд после вскрытия флота в конце партии.
 */
function sbShipFromCells(cells) {
  if (!Array.isArray(cells) || !cells.length) return null;
  const xs = cells.map(k => k.x), ys = cells.map(k => k.y);
  const horiz = ys.every(y => y === ys[0]);
  return { x: Math.min.apply(null, xs), y: Math.min.apply(null, ys), len: cells.length, horiz };
}
function sbBoardHtml(c, eng, boardSide, meSide, opts) {
  const o = opts || {};
  const v = eng.viewOf(boardSide);
  const reveal = eng.revealOf(boardSide);
  const fleet = reveal && reveal.fleet ? reveal.fleet : (boardSide === meSide && o.loc ? o.loc.fleet : null);
  const canShoot = !!o.shoot && eng.status() === 'playing' && !eng.pendingShot() && eng.turn() === meSide && boardSide !== meSide;
  let cells = '', marks = '';
  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < 10; x++) {
      const gs = v.grid[y * 10 + x];
      const cls = 'sbc' + (canShoot && !gs ? ' can' : '') + (o.place ? ' place' : '');
      cells += `<div class="${cls}" data-sbcell="${x},${y}" data-sbboard="${boardSide}"></div>`;
      const mark = gs === 'miss' ? '<i class="sb-dot" title="мимо"></i>'
        : gs === 'hit' ? '<img class="sb-boom" src="img/sb-boom.png" alt="ранил" draggable="false">'
          : gs === 'sunk' ? '<img class="sb-boom" src="img/sb-boom.png" alt="потопил" draggable="false">' : '';
      if (mark) marks += `<div class="sbm" style="left:${x * 10}%;top:${y * 10}%">${mark}</div>`;
    }
  }
  let ships = '';
  if (fleet) {
    for (const s of fleet) {
      const isSunkShip = v.sunk.some(sn => (sn.cells || []).length === s.len
        && sn.cells.every(cc => SB.shipCells(s).some(k => k.x === cc.x && k.y === cc.y)));
      if (boardSide !== meSide && !isSunkShip && !reveal) continue;   // чужой флот до вскрытия не показываем
      ships += sbShipImg(s);
    }
  } else if (boardSide !== meSide) {
    // pkg3-57: потопленные корабли соперника видны сразу — клетки корабля
    // пришли в ответе «потопил», по ним и рисуем спрайт (взрывы лягут поверх)
    for (const sn of v.sunk) { const s = sbShipFromCells(sn.cells); if (s) ships += sbShipImg(s); }
  }
  return sbFrameHtml(`<div class="sb-board${o.place ? ' placing' : ''}">${cells}<div class="sb-ships">${ships}</div><div class="sb-marks">${marks}</div></div>`);
}
function sbLogHtml(c, sans) {
  if (!sans.length) return '<div class="tiny muted mv-empty">Выстрелов пока нет — флоты расставляются</div>';
  const g = c.game || {};
  let out = '';
  for (let i = 0; i < sans.length; i++) {
    const [side, text] = [sans[i].slice(0, 1), sans[i].slice(2)];
    const who = userNameById(side === 'w' ? g.white : g.black);
    out += `<div class="mrow-mv"><span class="mv-n">${i + 1}.</span><span class="mv-w">${escapeHtml(who)}: ${escapeHtml(text)}</span></div>`;
  }
  return out;
}
/** Значок честности: сверяем вскрытый флот с печатью sb-commit.
 * pkg3-58: в «открытом» режиме флот приезжает вместе с печатью — письма
 * вскрытия может не быть, тогда сверяем флот из печати (тот же алгоритм). */
function sbVerifyBadge(c, eng, side, meSide) {
  const rev = eng.revealOf(side) || (eng.fleetOf ? eng.fleetOf(side) : null);
  if (!rev || !rev.fleet) return '';
  const key = c.id + '|' + side;
  S.sbVerify = S.sbVerify || {};
  const cur = S.sbVerify[key];
  if (cur === undefined) {
    S.sbVerify[key] = '…';
    (async () => {
      const hex = await sbSha(SB.canon(rev.fleet, rev.salt));
      const shots = eng._state().shots.filter(s => s.side === SB.other(side) && s.r);
      S.sbVerify[key] = SB.checkReveal(rev, eng.commitOf(side), hex, shots) ? 'ok' : 'bad';
      S.boardSig = ''; renderBoard();
    })().catch(() => { S.sbVerify[key] = 'bad'; });
    return '<span class="tiny muted">проверка…</span>';
  }
  if (cur === 'ok') return '<span class="sb-verify ok">' + (side === meSide ? 'ваш флот совпал с печатью ✓' : 'флот соперника честен ✓') + '</span>';
  if (cur === 'bad') return '<span class="sb-verify bad">флот не совпал с печатью — соперник мухлевал!</span>';
  return '<span class="tiny muted">проверка…</span>';
}
function renderSeabattle(wrap, c, eng, st, sans, role, my) {
  const g = c.game || {};
  // pkg3-80: весь флот потоплен — спокойный финальный сигнал (один раз на устройство)
  gameEndSound(c, boardEndKey(c, g, st, eng, st === 'over' ? (eng.winner() === 'w' ? g.white : g.black) : null));
  const opp = SB.other(my || 'w');
  const nameOf = s => userNameById(s === 'w' ? g.white : g.black);
  const ctrlL = [], ctrlR = [];
  if (role) {
    const label = role === 'viewer' ? 'Покинуть'
      : g.status === 'playing' ? 'Сдаться'
        : g.status === 'invite' ? 'Отменить приглашение'
          : 'Удалить игру';
    const full = role === 'viewer' ? 'Покинуть игру'
      : g.status === 'playing' ? 'Сдаться и выйти'
        : g.status === 'invite' ? 'Отменить приглашение и удалить игру'
          : 'Закрыть и удалить игру';
    ctrlL.push(`<button class="mini danger" id="gm-leave" title="${escapeHtml(full)}">${label}</button>`);
  }
  if (role === 'player' && (c.knocks || []).length) {
    ctrlR.push(`<button class="mini" id="gm-knocks" title="Заявки зрителей: ${c.knocks.length}">Заявки: ${c.knocks.length}</button>`);
  }
  const btnsRow = ctrlL.concat(ctrlR).length ? `<div class="bph-btns">${ctrlL.concat(ctrlR).join(' ')}</div>` : '';
  const P = sbPlace(c);
  const loc = sbLocalGet(c.id);
  const myCommitted = my ? eng.committed(my) : false;
  const placing = role === 'player' && !!my && !myCommitted && g.status === 'playing';
  const tab = S.sbTab || 'enemy';
  const over = st === 'over' || g.status === 'finished';
  S.sbPlaying = !over;   // pkg3-57: частый опрос ленты — только пока партия идёт
  const sig = ['sb', c.id, sans.length, st, eng.turn(), JSON.stringify(eng.pendingShot() || 0),
    myCommitted ? 1 : 0, P.fleet.length, P.horiz ? 1 : 0, tab, (c.knocks || []).length, role || '-',
    g.status, JSON.stringify(S.sbVerify || {}), loc ? 1 : 0, S.eco ? 1 : 0].join('|');
  if (S.boardSig === sig && wrap.dataset.chat === c.id && wrap.firstChild) return;
  const prevGm = $('#game-moves');
  const prevTop = prevGm ? prevGm.scrollTop : null;
  const prevMoves = (S.movesShown && S.movesShown.chat === c.id) ? S.movesShown.len : -1;
  S.boardSig = sig; wrap.dataset.chat = c.id;
  wrap.classList.remove('hidden');

  let mineInner, enemyInner;
  if (placing) {
    const left = {};
    for (const len of SB_ORD) left[len] = (left[len] || 0) + 1;
    for (const s of P.fleet) left[s.len]--;
    const curLen = SB_ORD[P.fleet.length] || 0;
    const chips = [4, 3, 2, 1].map(len => `<span class="sb-chip${len === curLen ? ' cur' : ''}${left[len] ? '' : ' done'}" title="${escapeHtml(SB.SHIP_NAMES[len])}: осталось ${left[len] || 0}">
        <img src="img/sb-ship${len}h.png" alt="${escapeHtml(SB.SHIP_NAMES[len])}" draggable="false"><b>×${left[len] || 0}</b></span>`).join('');
    mineInner = sbBoardHtml(c, eng, my, my, { loc: { fleet: P.fleet }, place: true })
      + `<div class="sb-pal">${chips}</div>
         <div class="sb-pal-btns">
           <button class="mini" id="sb-rot" title="Повернуть корабль">Повернуть: ${P.horiz ? 'горизонтально' : 'вертикально'}</button>
           <button class="mini" id="sb-rand" title="Расставить случайно">Случайно</button>
           <button class="mini" id="sb-clear" title="Убрать все корабли">Очистить</button>
           <button class="mini primary" id="sb-go" ${P.fleet.length === 10 ? '' : 'disabled'} title="Запечатать флот и начать бой">В бой!</button>
         </div>
         <div class="tiny muted sb-hint">Коснитесь клетки — корабль встанет туда носом (${curLen ? SB.SHIP_NAMES[curLen] + ', ' + curLen + ' кл.' : 'все расставлены'}). Коснитесь своего корабля — он вернётся в запас.</div>`;
    enemyInner = `<div class="sb-lock">🔒<span class="tiny muted">Поле соперника откроется, когда оба флота будут запечатаны</span></div>`;
  } else {
    enemyInner = sbBoardHtml(c, eng, opp, my, { shoot: role === 'player' })
      + (over ? `<div class="sb-verifyrow">${sbVerifyBadge(c, eng, opp, my)}</div>` : '');
    mineInner = sbBoardHtml(c, eng, my, my, { loc })
      + (!loc && myCommitted ? '<div class="tiny muted sb-hint">Расстановка хранится на устройстве, где вы ставили флот. Отметки выстрелов соперника видны здесь.</div>' : '')
      + (over ? `<div class="sb-verifyrow">${sbVerifyBadge(c, eng, my, my)}</div>` : '');
  }
  const tabs = `<div class="sb-tabs">
      <button class="mini${tab === 'enemy' ? ' primary' : ''}" data-sb-tab="enemy">Поле соперника</button>
      <button class="mini${tab === 'mine' ? ' primary' : ''}" data-sb-tab="mine">Моё поле</button>
    </div>`;
  const enemyCap = `Поле соперника · ${escapeHtml(nameOf(opp))}`;
  const mineCap = `Моё поле · ${escapeHtml(nameOf(my || 'w'))}`;
  wrap.innerHTML = `<div class="board-panel sb-panel">
    <div class="bp-head">
      <div class="bph-top"><span class="bph-full">${escapeHtml(gameStatusText(c, eng, st))}</span><span class="bph-short">${escapeHtml(gameStatusShortText(c, eng, st))}</span></div>
      ${btnsRow}
    </div>
    ${tabs}
    <div class="sb-fields">
      <div class="sb-field${tab !== 'enemy' ? ' sb-hide-m' : ''}"><div class="sb-cap">${enemyCap}</div>${enemyInner}</div>
      <div class="sb-field${tab !== 'mine' ? ' sb-hide-m' : ''}"><div class="sb-cap">${mineCap}</div>${mineInner}</div>
    </div>
    <div class="bp-moves-list" id="game-moves">${sbLogHtml(c, sans)}</div>
  </div>`;
  const gm = $('#game-moves');
  if (gm) {
    if (prevMoves !== sans.length) gm.scrollTop = gm.scrollHeight;
    else if (prevTop !== null) gm.scrollTop = prevTop;
    S.movesShown = { chat: c.id, len: sans.length };
  }
}
async function onSbCell(el) {
  const c = curChat();
  if (!c || c.kind !== 'game' || gameRulesOf(c) !== 'seabattle') return;
  if ((c.roles || {})[S.me.id] !== 'player') return;
  const { eng } = gameReplay(c);
  const my = myGameColor(c);
  if (!my) return;
  const board = el.dataset.sbboard;
  const [x, y] = String(el.dataset.sbcell).split(',').map(Number);
  if (board === my) {
    if (eng.committed(my) || (c.game || {}).status !== 'playing') return;   // запечатано — не трогаем
    const P = sbPlace(c);
    const at = P.fleet.findIndex(s => SB.shipCells(s).some(k => k.x === x && k.y === y));
    if (at >= 0) P.fleet.splice(at, 1);
    else {
      const len = SB_ORD[P.fleet.length];
      if (!len) return;
      if (!SB.canPlace(P.fleet, x, y, len, P.horiz)) { toast('Здесь не встанет: корабли не касаются друг друга даже углами', true); return; }
      P.fleet.push({ x, y, len, horiz: P.horiz });
    }
    S.boardSig = ''; renderBoard();
    return;
  }
  if (eng.status() !== 'playing' || eng.turn() !== my || eng.pendingShot()) return;
  const v = eng.viewOf(board);
  if (v.grid[y * 10 + x]) { toast('Сюда уже стреляли', true); return; }
  await sendSb(c, { k: 'sb-shot', x, y });
}
/** Письмо морского боя уходит так же, как ход шахмат: черновик на доске сразу, доставка фоном. */
async function sendSb(c, payload) {
  if (S.sbSending) return;
  const k = await chatKeyOf(c);
  if (!k) { toast('Не удалось получить ключ шифрования для этой игры', true); return; }
  let blob;
  try { blob = await encryptJSON(k.key, payload); }
  catch (ex) { toast(ex.message || 'Не удалось зашифровать', true); return; }
  const tmpId = 'tmpsb' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const draft = {
    id: tmpId, seq: nextLocalSeq(), uid: S.me.id, ts: Date.now(),
    blob, bytes: blob.length, chat: c.id, parent: null, quote: null, local: true
  };
  S.retry[tmpId] = { blob, chat: c.id, parent: null, quote: null, payload };
  addMessages([draft]);
  S.plain.set(tmpId, payload);
  GS.play(GS.letterSound(payload, true));   // pkg3-80: выстрел/печать звучат сразу
  S.sbSending = true;
  S.sig = ''; renderBoard(); renderRail();
  wake('ход морского боя');
  postSb(draft);
}
async function postSb(draft) {
  const rec = S.retry[draft.id] || {};
  try {
    // pkg3-57: notify:1 — сервер сразу будит устройство соперника пушем:
    // на выстрел отвечает машина, и ждать её очередного опроса незачем
    const r = await api('/api/messages', { method: 'POST', timeout: 15000, body: { chat: rec.chat, blob: rec.blob, notify: 1 } });
    S.sbSending = false;
    adoptSent(draft, r.message, rec.payload);
    cacheMsg(r.message);
    if (r.usage) S.usage = r.usage;
    if (r.notify) fireNotify(Object.assign({}, r.notify, { body: 'game' }));
    S.sig = ''; renderBoard(); renderRail();
    sync(false).catch(() => {});
  } catch (ex) {
    S.sbSending = false;
    removeLocal([draft.id]);
    S.boardSig = ''; renderBoard(); renderRail();
    toast('Не отправилось (' + (ex.message || 'сбой сети') + ') — попробуйте ещё раз', true);
  }
}
async function sbCommitSend() {
  const c = curChat();
  if (!c || gameRulesOf(c) !== 'seabattle') return;
  const P = sbPlace(c);
  if (P.fleet.length !== 10) { toast('Расставьте все десять кораблей', true); return; }
  const salt = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
  const commit = await sbSha(SB.canon(P.fleet, salt));
  const loc = { fleet: P.fleet, salt, commit };
  sbLocalSet(c.id, loc);
  delete S.sbPlace[c.id];
  S.boardSig = '';
  // pkg3-58: печать несёт и сам флот — письмо зашифровано ключом чата, сервер
  // его не читает, а устройство соперника с этой минуты отвечает на выстрелы
  // мгновенно (считает результат само, из того же флота). Старая версия
  // клиента лишние поля просто не заметит и заиграет как прежде — по ответам.
  await sendSb(c, { k: 'sb-commit', commit, fleet: P.fleet, salt });
  // pkg3-57: шифрованный слепок флота — моим ДРУГИМ устройствам (ПК и телефон
  // видят свои корабли и могут отвечать на выстрелы). Сервер содержимое не читает.
  sbFleetUpload(c.id, loc).catch(() => {});
}
/** pkg3-57: личный ключ слепков флота — из закрытого ключа участника (он один
 * на все устройства: приходит при входе по паролю). Сервер и соперник таким
 * ключом не владеют, поэтому слепок для них — шифротекст. */
async function sbSelfKey() {
  const meId = (S.me && S.me.id) || null;
  if (!meId || !S.privRaw) return null;
  if (S.sbKeyFor === meId && S.sbKeyP) return S.sbKeyP;
  S.sbKeyFor = meId;
  S.sbKeyP = (async () => importAes(new Uint8Array(await crypto.subtle.digest('SHA-256', S.privRaw))))().catch(() => null);
  return S.sbKeyP;
}
async function sbFleetUpload(chatId, loc) {
  const key = await sbSelfKey();
  if (!key) return;
  const blob = loc
    ? await aesEncryptBytes(key, enc.encode(JSON.stringify(loc)))
    : null;
  await api('/api/games/' + encodeURIComponent(chatId) + '/sbfleet', { method: 'POST', body: { blob } });
  if (!loc && S.sbFleets) delete S.sbFleets[chatId];
}
/** pkg3-57: вернуть свой флот из серверного слепка на это устройство.
 * Слепок принимаем, только если он совпал с печатью sb-commit — подменённый
 * или побитый флот на устройство не попадёт и в игре не участвует. */
async function sbRestoreFleets() {
  const key = await sbSelfKey();
  if (!key) return;
  for (const chatId of Object.keys(S.sbFleets || {})) {
    if (sbLocalGet(chatId)) continue;                      // на этом устройстве флот уже есть
    if (S.sbRestoreTried && S.sbRestoreTried.has(chatId)) continue;   // мусор не долбим
    try {
      const loc = await decryptJSON(key, S.sbFleets[chatId]);
      if (!loc || !Array.isArray(loc.fleet) || loc.fleet.length !== 10) throw new Error('состав не тот');
      for (const s of loc.fleet) {
        if (!s || !Number.isInteger(s.x) || !Number.isInteger(s.y) || !Number.isInteger(s.len)) throw new Error('состав не тот');
        if (s.x < 0 || s.y < 0 || s.x > 9 || s.y > 9 || s.len < 1 || s.len > 4) throw new Error('состав не тот');
      }
      const commit = await sbSha(SB.canon(loc.fleet, loc.salt));
      if (commit !== loc.commit) throw new Error('флот не совпал с печатью');
      sbLocalSet(chatId, { fleet: loc.fleet, salt: loc.salt, commit });
      if (S.view === chatId) { S.boardSig = ''; renderBoard(); }
    } catch (e) {
      (S.sbRestoreTried = S.sbRestoreTried || new Set()).add(chatId);
    }
  }
}
function sbToggleRot() {
  const c = curChat(); if (!c) return;
  const P = sbPlace(c); P.horiz = !P.horiz;
  S.boardSig = ''; renderBoard();
}
function sbRandom() {
  const c = curChat(); if (!c) return;
  const f = SB.randomFleet();
  if (!f) { toast('Не удалось расставить — попробуйте ещё раз', true); return; }
  sbPlace(c).fleet = f;
  S.boardSig = ''; renderBoard();
}
function sbClear() {
  const c = curChat(); if (!c) return;
  sbPlace(c).fleet = [];
  S.boardSig = ''; renderBoard();
}
/**
 * pkg3-56: устройство, на котором хранится флот, отвечает на выстрелы само —
 * человеку не нужно ни нажимать ничего, ни (главное) «подыгрывать» себе:
 * ответ считается из настоящей расстановки. В конце партии флот вскрывается
 * для сверки с печатью.
 */
async function sbAutoRespond() {
  if (!S.me || !S.chats || !S.chats.length) return;
  for (const c of S.chats) {
    if (c.kind !== 'game' || (c.game || {}).rules !== 'seabattle') continue;
    const my = myGameColor(c);
    if (!my) continue;
    // pkg3-57: партия завершена (сдача) — слепок флота на сервере больше не нужен
    if ((c.game || {}).status === 'finished' && S.sbFleets && S.sbFleets[c.id]) {
      sbFleetUpload(c.id, null).catch(() => {});
      continue;
    }
    if ((c.game || {}).status !== 'playing') continue;
    if ((c.roles || {})[S.me.id] !== 'player') continue;
    const { eng } = gameReplay(c);
    const st = eng.status();
    const loc = sbLocalGet(c.id);
    // pkg3-57: страховка от редкой гонки «флот расставили на двух устройствах»:
    // в ленте побеждает первая печать — если локальный флот ей не соответствует,
    // забываем его (из серверного слепка вернётся настоящий, совпадающий с печатью)
    if (loc && loc.commit && eng.committed(my) && eng.commitOf(my) !== loc.commit) {
      try { localStorage.removeItem('sega.sb.' + c.id); } catch (e) {}
      if (S.sbRestoreTried) S.sbRestoreTried.delete(c.id);
      sbRestoreFleets().catch(() => {});
      if (S.view === c.id) { S.boardSig = ''; renderBoard(); }
      continue;
    }
    // pkg3-57: партия, начатая ДО обновления, — слепка на сервере нет;
    // досылаем его с устройства, где флот расставлен (один раз, дальше
    // синхронизация сама приносит отметку о наличии)
    if (loc && loc.fleet && st !== 'over' && S.sbFleets && !S.sbFleets[c.id]) {
      sbFleetUpload(c.id, loc).catch(() => {});
    }
    const pen = eng.pendingShot();
    if (st === 'playing' && pen && pen.side !== my && loc && loc.fleet && !S.sbBusy) {
      S.sbBusy = c.id + ':' + pen.x + ',' + pen.y;
      try {
        const ship = SB.shipAt(loc.fleet, pen.x, pen.y);
        let r = 'miss', cells = null, aura = null;
        if (ship) {
          const v = eng.viewOf(my);
          const hits = new Set();
          for (let i = 0; i < 100; i++) if (v.grid[i] === 'hit' || v.grid[i] === 'sunk') hits.add(SB.ck(i % 10, Math.floor(i / 10)));
          hits.add(SB.ck(pen.x, pen.y));
          if (SB.isSunk(ship, hits)) {
            r = 'sunk';
            cells = SB.shipCells(ship).map(k => SB.ck(k.x, k.y));
            aura = SB.auraOf(ship);
          } else r = 'hit';
        }
        const k = await chatKeyOf(c);
        if (k) {
          const payload = { k: 'sb-reply', x: pen.x, y: pen.y, r, cells, aura };
          // pkg3-80: защищающийся слышит исход чужого выстрела — только глядя на доску
          if (!document.hidden && S.view === c.id) GS.play(r === 'sunk' ? 'sunk' : r === 'hit' ? 'hit' : 'miss');
          const blob = await encryptJSON(k.key, payload);
          // pkg3-57: notify:1 — пуш будит устройство стрелявшего: ответ виден сразу
          const rr = await api('/api/messages', { method: 'POST', timeout: 15000, body: { chat: c.id, blob, notify: 1 } });
          S.plain.set(rr.message.id, payload);
          addMessages([rr.message]);
          cacheMsg(rr.message);
          if (rr.notify) fireNotify(Object.assign({}, rr.notify, { body: 'game' }));
          S.sig = ''; renderBoard(); renderRail();
        }
      } catch (e) { /* повторим на следующей синхронизации */ }
      S.sbBusy = null;
    }
    // pkg3-58: в «открытом» режиме (обе печати принесли флоты) письмо вскрытия
    // не нужно — устройства и так сверят флот с печатью; старому сопернику
    // (печать без флота) вскрытие отправляем, как прежде, ради его значка
    if (st === 'over' && loc && loc.fleet && !eng.revealOf(my)
      && !(eng.openMode && eng.openMode()) && !S.sbRevealBusy) {
      S.sbRevealBusy = c.id;
      try {
        const k = await chatKeyOf(c);
        if (k) {
          const payload = { k: 'sb-reveal', fleet: loc.fleet, salt: loc.salt };
          const blob = await encryptJSON(k.key, payload);
          const rr = await api('/api/messages', { method: 'POST', body: { chat: c.id, blob, notify: 1 } });
          S.plain.set(rr.message.id, payload);
          addMessages([rr.message]);
          cacheMsg(rr.message);
          if (rr.notify) fireNotify(Object.assign({}, rr.notify, { body: 'game' }));
          S.sig = ''; renderBoard();
          // pkg3-57: флот вскрыт в ленте — серверный слепок больше не нужен
          sbFleetUpload(c.id, null).catch(() => {});
        }
      } catch (e) { /* повторим на следующей синхронизации */ }
      S.sbRevealBusy = null;
    }
  }
}

async function onBoardClick(sq) {
  const c = curChat();
  if (!c || c.kind !== 'game') return;
  if (gameRulesOf(c) === 'seabattle') return;   // pkg3-56: у морского боя свои клики
  const { eng } = gameReplay(c);
  const st = eng.status();
  if (st !== 'playing' && st !== 'check') return;
  const my = myGameColor(c);
  if ((c.roles || {})[S.me.id] !== 'player' || eng.turn() !== my) return;
  if (S.selSq && (S.selTargets || []).includes(sq)) {
    let mv;
    if (gameRulesOf(c) === 'checkers') {
      // pkg3-41: у шашек from→to иногда мало (разные цепочки взятий ведут
      // в одну клетку) — выбираем конкретную цепочку и передаём её путь
      const legal = eng.legalMoves().find(m => m.from === S.selSq && m.to === sq);
      mv = { from: S.selSq, to: sq, path: legal ? legal.path : null };
    } else {
      const promo = eng.legalMoves().some(m => m.from === S.selSq && m.to === sq && m.promo) ? 'q' : null;
      mv = { from: S.selSq, to: sq, promo };
    }
    S.selSq = null; S.selTargets = [];
    await sendGameMove(c, mv);
    return;
  }
  const p = eng.board()[sqIndex(sq)];
  // pkg3-41: у шашек свои обозначения — 'w'/'W' (белые шашка/дамка), 'b'/'B' (чёрные);
  // шахматное «регистр = цвет» к ним не подходит
  const pWhite = gameRulesOf(c) === 'checkers' ? (p === 'w' || p === 'W') : isWhitePiece(p);
  if (p && pWhite === (eng.turn() === 'w')) {
    S.selSq = sq;
    S.selTargets = [...new Set(eng.legalMoves().filter(m => m.from === sq).map(m => m.to))];
  } else { S.selSq = null; S.selTargets = []; }
  renderBoard();
}
/** pkg3-36: «быстрый ход» — фигура встаёт на доску МГНОВЕННО, а отправка на
 * сервер идёт фоном. Черновик хода живёт как обычное локальное сообщение
 * (tmp-идентификатор, local:true), поэтому лента, кэш и повторная доставка
 * через опрос работают по уже обкатанным рельсам. */
async function sendGameMove(c, mv) {
  const { eng } = gameReplay(c);
  const ck = gameRulesOf(c) === 'checkers';
  const samePath = (a, b) => (!a && !b) || (!!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]));
  // pkg3-41: шахматный ход узнаём по from/to/promo, шашечный — по from/to и
  // точному пути цепочки (path); лишний признак другой игре не мешает
  const legal = eng.legalMoves().find(m => m.from === mv.from && m.to === mv.to
    && (ck ? samePath(m.path || null, mv.path || null) : (m.promo || null) === (mv.promo || null)));
  if (!legal) { toast('Так ходить нельзя', true); return; }
  if (S.moveSending) return;   // предыдущий ход ещё летит — второй не накладываем
  const k = await chatKeyOf(c);
  if (!k) { toast('Не удалось получить ключ шифрования для этой игры', true); return; }
  const payload = { k: 'move', from: mv.from, to: mv.to, promo: mv.promo || null, path: mv.path || null, san: legal.san, author: S.me.name };
  let blob;
  try { blob = await encryptJSON(k.key, payload); }
  catch (ex) { toast(ex.message || 'Не удалось зашифровать ход', true); return; }
  const tmpId = 'tmpmv' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const draft = {
    id: tmpId, seq: nextLocalSeq(), uid: S.me.id, ts: Date.now(),
    blob, bytes: blob.length, chat: c.id, parent: null, quote: null, local: true
  };
  S.retry[tmpId] = { blob, chat: c.id, parent: null, quote: null, payload };
  addMessages([draft]);
  S.plain.set(tmpId, payload);
  GS.play(GS.letterSound(payload, true));   // pkg3-80: мой ход звучит сразу
  S.moveSending = true;
  S.sig = ''; renderBoard(); renderRail();
  wake('ход в игре');
  postMove(draft);
}
/** Догоняющая отправка хода: успех — черновик заменяется настоящей записью,
 * сбой — ход убирается с доски (позиция откатывается), иначе я и соперник
 * видели бы разные доски. */
async function postMove(draft) {
  const rec = S.retry[draft.id] || {};
  try {
    const r = await api('/api/messages', { method: 'POST', timeout: 15000, body: { chat: rec.chat, blob: rec.blob } });
    S.moveSending = false;
    adoptSent(draft, r.message, rec.payload);
    cacheMsg(r.message);
    if (r.usage) S.usage = r.usage;
    S.sig = ''; renderBoard(); renderRail();
    sync(false).catch(() => {});
  } catch (ex) {
    S.moveSending = false;
    removeLocal([draft.id]);
    S.boardSig = ''; renderBoard(); renderRail();
    toast('Ход не отправился (' + (ex.message || 'сбой сети') + ') — попробуйте ещё раз', true);
  }
}
// ──────────────────────── pkg3-78/80: «Золотая лихорадка» — забег с туманом войны ────────────────────────
/** Карта раунда и значки кэшируются: перерисовка не ходит в сеть по кругу. */
const coinsImgs = {};
function coinsImg(src) {
  if (coinsImgs[src]) return coinsImgs[src];
  const im = new Image();
  im.onload = () => { try { if (S.coinsLive) coinsDraw(); } catch (e) {} };
  im.src = src;
  coinsImgs[src] = im;
  return im;
}
/** Состояние забега на устройстве: идущий раунд переживёт перезагрузку страницы. */
function coinsLocalGet(id) { try { return JSON.parse(localStorage.getItem('sega.coins.' + id)) || null; } catch (e) { return null; } }
function coinsLocalSet(id, v) { try { if (v) localStorage.setItem('sega.coins.' + id, JSON.stringify(v)); else localStorage.removeItem('sega.coins.' + id); } catch (e) {} }
/** Письма забега: расшифрованные payloads с автором и временем — вход для движка CE. */
function coinsLetters(c) {
  const out = [];
  const msgs = S.messages.filter(m => m.chat === c.id && !m.parent && !m.failed).sort((a, b) => a.seq - b.seq);
  for (const m of msgs) {
    const p = S.plain.get(m.id);
    if (!p || typeof p.k !== 'string' || p.k.slice(0, 6) !== 'coins-') continue;
    out.push(Object.assign({}, p, { author: m.uid, ts: Number(m.ts) || 0 }));
  }
  return out;
}
/** Всё о забеге одним вычислением: раунд, план, таблица, победитель.
 * Чужие результаты сразу перепроверяются перепроигрыванием пути по той же
 * карте (CE.verify): неверный счёт becomes «не проверено» и обнуляется. */
function coinsRunState(c, runWant) {
  const g = c.game || {};
  const letters0 = coinsLetters(c);
  const solo = (g.players || []).length <= 1;
  const maxRun = letters0.reduce((m, l) => Math.max(m, l.run || 1), 1);
  const run = solo ? Math.max(1, Math.min(runWant || maxRun, maxRun + 1)) : 1;
  const rounds = Math.max(1, Math.min(CE.MAX_ROUNDS, g.rounds | 0));
  const genCache = {};
  const gen = r => genCache[r] || (genCache[r] = CE.genRound(g.seed, r, run));
  const letters = letters0.map(l => {
    if (!CE.isResult(l) || (l.run || 1) !== run) return l;
    const r = l.round | 0;
    if (!(r >= 1 && r <= rounds)) return Object.assign({}, l, { score: 0, bad: true });
    return CE.verify(gen(r), l, g.minutes) ? l : Object.assign({}, l, { score: 0, bad: true });
  });
  const now = Date.now();
  const game = Object.assign({}, g, { rounds });
  return {
    g, game, solo, run, maxRun, rounds, gen, letters,
    plan: CE.roundPlan(game, letters, now, run),
    table: CE.table(game, letters, now, run),
    winner: CE.winnerOf(game, letters, now, run)
  };
}
/** Письмо забега уходит зашифрованным и будит остальных игроков пушем. */
async function sendCoins(c, payload) {
  const k = await chatKeyOf(c);
  if (!k) { toast('Не удалось получить ключ шифрования для этой игры', true); return null; }
  let blob;
  try { blob = await encryptJSON(k.key, payload); }
  catch (ex) { toast(ex.message || 'Не удалось зашифровать', true); return null; }
  try {
    const body = { chat: c.id, blob, notify: 1 };
    // pkg3-82 (правка 5): письмо с результатом раунда несёт ОТКРЫТУЮ метку —
    // сервер письмо не читает (blob зашифрован), он лишь запоминает, что игрок
    // сдал результат: забег попадает в чужое «Сейчас играют», только когда
    // таких игроков хотя бы двое
    if (payload && payload.k === 'coins-result') body.mark = 'coins-result';
    const r = await api('/api/messages', { method: 'POST', timeout: 15000, body });
    S.plain.set(r.message.id, payload);
    addMessages([r.message]);
    cacheMsg(r.message);
    if (r.usage) S.usage = r.usage;
    if (r.notify) fireNotify(Object.assign({}, r.notify, { body: 'coins' }));
    S.sig = ''; S.boardSig = ''; renderBoard(); renderRail();
    return r.message;
  } catch (ex) {
    toast('Письмо забега не отправилось (' + (ex.message || 'сбой сети') + ') — попробуйте ещё раз', true);
    return null;
  }
}
/** Живой поиск: из локального состояния раунда. */
function coinsMakeLive(c, cs, loc) {
  const round = Number(loc.round) || 1;   // pkg3-82: раунд — из локального следа (общего плана раундов больше нет)
  return {
    chatId: c.id, cs, gen: cs.gen(round), minutes: Number(cs.g.minutes) || 3,
    run: cs.run, round,
    startedAt: Number(loc.startedAt) || 0, moves: String(loc.moves || ''),
    x: loc.x | 0, y: loc.y | 0, score: loc.score | 0, got: (loc.got || []).slice(),
    bgot: (loc.bgot || []).slice(),   // pkg3-80: собранные бонусы (часы/компас/фонарь) — каждый один раз
    hg: loc.hg | 0, lanternUntil: loc.lanternUntil | 0, compassUntil: loc.compassUntil | 0,
    sent: loc.sent || null, hunt: true, reveal: false, flash: null, warn30: false
  };
}
/** Раскрытие карты после финиша: из своего письма (или локального sent). */
function coinsLiveFromResult(c, cs, res, loc) {
  const r = Number(res.round) || 1;
  const gen = cs.gen(r);
  const sim = CE.simulate(gen, res.moves);
  const got = [];
  for (let i = 0; i < sim.got.length; i++) if (sim.got[i]) got.push(i);
  const bgot = [];
  for (let i = 0; i < sim.bgot.length; i++) if (sim.bgot[i]) bgot.push(i);
  return {
    chatId: c.id, cs, gen, minutes: Number(cs.g.minutes) || 3,
    run: cs.run, round: r,
    startedAt: Number(res.startedAt) || 0, moves: String(res.moves || ''),
    x: sim.end[0], y: sim.end[1], score: res.score | 0, got, bgot, hg: sim.hg,
    lanternUntil: 0, compassUntil: 0,
    sent: (loc && loc.sent) || res, hunt: false, reveal: true, flash: null,
    who: res.author || null,   // pkg3-81 (пункт 10): чей путь показан (зрителю — не свой)
    bad: res.bad === true
  };
}
function coinsSaveLoc(L) {
  coinsLocalSet(L.chatId, {
    run: L.run, round: L.round, startedAt: L.startedAt, moves: L.moves,
    x: L.x, y: L.y, score: L.score, got: L.got, bgot: L.bgot || [], hg: L.hg,
    lanternUntil: L.lanternUntil, compassUntil: L.compassUntil, sent: L.sent || null
  });
}
const coinsTimeLeft = L => Math.max(0, Number(L.startedAt) + (Number(L.minutes) * 60 + (L.hg | 0) * 10) * 1000 - Date.now());
function coinsFmtSec(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
/** pkg3-85: время раунда в секундах: новые карты игр держат sec, старые — целые
 * минуты; здесь оба случая читаются одинаково. */
const coinsSecOf = g => Math.round(Number(g && g.sec) > 0 ? Number(g.sec) : (Number(g && g.minutes) || 3) * 60);
/** pkg3-85: человекочитаемое время раунда: 1:00, 1:10, 12:30. */
const fmtCoinsTime = sec => Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
/** Клетки пути — для линии на раскрытой карте. */
function coinsPath(gen, moves) {
  const pts = [{ x: gen.start.x, y: gen.start.y }];
  let x = gen.start.x, y = gen.start.y;
  for (const ch of String(moves || '')) {
    const d = CE.STEP[ch]; if (!d) continue;
    const nx = x + d[0], ny = y + d[1];
    if (CE.isWall(gen, nx, ny)) continue;
    x = nx; y = ny; pts.push({ x, y });
  }
  return pts;
}
// ── движение: экранный крест и стрелки клавиатуры ──
let coinsHold = { dir: null, t: 0, pid: null };
function coinsHoldStart(dir, ev) {
  if (ev && ev.pointerId !== undefined && coinsHold.pid !== null && coinsHold.pid !== ev.pointerId && coinsHold.dir) return;
  coinsHoldStop();
  coinsHold.dir = dir; coinsHold.pid = ev && ev.pointerId !== undefined ? ev.pointerId : null;
  coinsStep(dir);
  coinsHold.t = setInterval(() => { if (coinsHold.dir) coinsStep(coinsHold.dir); }, 170);
}
function coinsHoldStop() {
  if (coinsHold.t) clearInterval(coinsHold.t);
  coinsHold.t = 0; coinsHold.dir = null; coinsHold.pid = null;
}
window.addEventListener('blur', coinsHoldStop);
const COINS_KEYS = { ArrowUp: 'U', ArrowDown: 'D', ArrowLeft: 'L', ArrowRight: 'R', KeyW: 'U', KeyS: 'D', KeyA: 'L', KeyD: 'R' };
document.addEventListener('keydown', e => {
  const L = S.coinsLive;
  if (!L || !L.hunt) return;
  const d = COINS_KEYS[e.code];
  if (!d) return;
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return;
  e.preventDefault();
  if (e.repeat) return;
  coinsHoldStart(d);
});
document.addEventListener('keyup', e => { if (COINS_KEYS[e.code]) coinsHoldStop(); });
function coinsStep(dir) {
  const L = S.coinsLive;
  if (!L || !L.hunt) return;
  const d = CE.STEP[dir];
  if (!d || coinsTimeLeft(L) <= 0) return;
  const nx = L.x + d[0], ny = L.y + d[1];
  if (CE.isWall(L.gen, nx, ny)) { GS.play('wall'); return; }   // в камень не ходим
  L.x = nx; L.y = ny; L.moves += dir;
  GS.play('step');
  const ci = CE.coinAt(L.gen, nx, ny);
  if (ci >= 0 && !L.got.includes(ci)) {
    L.got.push(ci); L.score++;
    GS.play('coin');
    coinsFlash(L, '🪙 +1 монета');
  }
  // pkg3-80: бонус подбирается ОДИН раз и тут же исчезает с карты — как монета.
  // Раньше часы можно было «фармить», шагая по клетке туда-сюда.
  const bi = CE.bonusIdxAt(L.gen, nx, ny);
  if (bi >= 0 && !(L.bgot || (L.bgot = [])).includes(bi)) {
    L.bgot.push(bi);
    const t = (L.gen.bonuses[bi] || {}).t;
    if (t === 'hourglass') { L.hg++; GS.play('hourglass'); coinsFlash(L, '⏳ песочные часы: +10 секунд'); }
    if (t === 'lantern') { L.lanternUntil = Date.now() + 15000; GS.play('lantern'); coinsFlash(L, '🔦 фонарь: видно дальше 15 секунд'); }
    if (t === 'compass') { L.compassUntil = Date.now() + 2500; GS.play('compass'); coinsFlash(L, '🧭 компас: стрелка к ближайшей монете'); }
  }
  coinsSaveLoc(L);
  coinsDraw(); coinsHud();
  // pkg3-81 (пункт 5): собраны ВСЕ монеты карты — раунд заканчивается досрочно,
  // не дожидаясь таймера: победный сигнал, открытая карта и кнопка «Далее»
  if (L.hunt && L.got.length >= L.gen.coins.length) {
    toast('🏆 Все монеты собраны! Раунд завершён досрочно');
    coinsFinishRound(true);
  }
}
/** pkg3-81 (пункт 3): находка подписывается ПРЯМО НА КАРТЕ — надпись в стороне
 * от аватара плавно растворяется за 2 секунды. Панель над картой не растёт,
 * кнопка музыки не перескакивает на новую строку и карта не дёргается. */
function coinsFlash(L, text) {
  L.flash = { text, born: Date.now(), until: Date.now() + 2000, total: 2000 };
}
// ── canvas: карта, туман войны, артефакты, аватар ──
let coinsFogCv = null;
function coinsFogLayer(cw, ch, sx, sy, aura) {
  if (!coinsFogCv) coinsFogCv = document.createElement('canvas');
  const f = coinsFogCv;
  if (f.width !== cw || f.height !== ch) { f.width = cw; f.height = ch; }
  const x = f.getContext('2d');
  x.clearRect(0, 0, cw, ch);
  x.fillStyle = 'rgba(6,7,12,0.93)';
  x.fillRect(0, 0, cw, ch);
  x.globalCompositeOperation = 'destination-out';
  const gr = x.createRadialGradient(sx, sy, aura * 0.3, sx, sy, aura);
  gr.addColorStop(0, 'rgba(0,0,0,1)');
  gr.addColorStop(0.72, 'rgba(0,0,0,0.92)');
  gr.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = gr;
  x.beginPath(); x.arc(sx, sy, aura, 0, Math.PI * 2); x.fill();
  x.globalCompositeOperation = 'source-over';
  return f;
}
function coinsDraw() {
  const L = S.coinsLive;
  if (!L) return;
  const cv = document.getElementById('coins-canvas');
  if (!cv || !cv.getContext) return;
  try {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = cv.clientWidth || 320, ch = cv.clientHeight || 480;
    if (cv.width !== Math.round(cw * dpr) || cv.height !== Math.round(ch * dpr)) {
      cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr);
    }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    const gen = L.gen;
    const cell = cw / CE.W;
    const mapW = cell * CE.W, mapH = cell * CE.H;
    // камера: игрок в центре, у краёв карты упирается (фигура смещается к краю)
    let camX = L.x * cell + cell / 2 - cw / 2;
    let camY = L.y * cell + cell / 2 - ch / 2;
    camX = Math.max(0, Math.min(camX, Math.max(0, mapW - cw)));
    camY = Math.max(0, Math.min(camY, Math.max(0, mapH - ch)));
    const sx = L.x * cell + cell / 2 - camX, sy = L.y * cell + cell / 2 - camY;
    // 1) карта-картинка
    const im = coinsImg('img/coins-map' + (gen.mapIdx + 1) + '.jpg');
    if (im.complete && im.naturalWidth) ctx.drawImage(im, -camX, -camY, mapW, mapH);
    else { ctx.fillStyle = '#3d4a38'; ctx.fillRect(0, 0, cw, ch); }
    // 2) стены-лабиринт
    for (let y = 0; y < CE.H; y++) {
      for (let x = 0; x < CE.W; x++) {
        if (!gen.walls[CE.idx(x, y)]) continue;
        const dx = x * cell - camX, dy = y * cell - camY;
        if (dx + cell < 0 || dy + cell < 0 || dx > cw || dy > ch) continue;
        ctx.fillStyle = 'rgba(26,22,17,0.9)';
        ctx.fillRect(dx, dy, cell, cell);
        ctx.strokeStyle = 'rgba(0,0,0,0.55)';
        ctx.strokeRect(dx + 0.5, dy + 0.5, cell - 1, cell - 1);
        ctx.fillStyle = 'rgba(255,255,255,0.06)';
        ctx.fillRect(dx + 2, dy + 2, cell - 4, Math.max(2, cell * 0.12));
      }
    }
    // 3) артефакты: в тумане их не видно — рисуем только в ареоле (или при раскрытии)
    const lanternOn = L.lanternUntil > Date.now();
    const aura = (lanternOn ? 4.6 : 2.6) * cell;
    const near = (x, y) => L.reveal || Math.hypot(x - L.x, y - L.y) * cell <= aura;
    const putImg = (src, cxp, cyp, size, alpha) => {
      const i2 = coinsImg(src);
      ctx.globalAlpha = alpha;
      if (i2.complete && i2.naturalWidth) ctx.drawImage(i2, cxp - size / 2, cyp - size / 2, size, size);
      else { ctx.fillStyle = 'rgba(245,197,66,' + alpha + ')'; ctx.beginPath(); ctx.arc(cxp, cyp, size / 3, 0, Math.PI * 2); ctx.fill(); }
      ctx.globalAlpha = 1;
    };
    for (const cn of gen.coins) {
      const gi = CE.coinAt(gen, cn.x, cn.y);
      const got = L.got.includes(gi);
      if (!L.reveal) {
        if (got || !near(cn.x, cn.y)) continue;
        putImg('img/coins-coin.png', cn.x * cell - camX + cell / 2, cn.y * cell - camY + cell / 2, cell * 0.62, 1);
      } else {
        // pkg3-80: несобранные монеты видно отчётливо — раунд окончен, карта открыта целиком
        putImg('img/coins-coin.png', cn.x * cell - camX + cell / 2, cn.y * cell - camY + cell / 2, cell * 0.62, got ? 1 : 0.42);
      }
    }
    // pkg3-80: бонус — одноразовая находка: подобранный исчезает с карты,
    // а на раскрытии подобранные показаны еле-еле, неподообранные — отчётливо
    gen.bonuses.forEach((bn, bi) => {
      const bgot = (L.bgot || []).includes(bi);
      if (bgot && !L.reveal) return;
      if (!L.reveal && !near(bn.x, bn.y)) return;
      putImg('img/coins-' + bn.t + '.png', bn.x * cell - camX + cell / 2, bn.y * cell - camY + cell / 2, cell * 0.7, L.reveal ? (bgot ? 0.22 : 0.8) : 1);
    });
    // 4) раскрытие: линия моего пути
    if (L.reveal) {
      const pts = coinsPath(gen, L.moves);
      ctx.strokeStyle = 'rgba(245,197,66,0.85)';
      ctx.lineWidth = Math.max(2, cell * 0.09);
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.beginPath();
      pts.forEach((p, i) => {
        const pxp = p.x * cell - camX + cell / 2, pyp = p.y * cell - camY + cell / 2;
        if (i === 0) ctx.moveTo(pxp, pyp); else ctx.lineTo(pxp, pyp);
      });
      ctx.stroke();
    } else {
      // 5) туман войны: всё вне ареола — во тьме
      ctx.drawImage(coinsFogLayer(cw, ch, sx, sy, aura), 0, 0, cw, ch);
      // 6) компас: стрелка к ближайшей ненайденной монете
      if (L.compassUntil > Date.now()) {
        let best = null, bd = 1e9;
        gen.coins.forEach(cn => {
          const gi = CE.coinAt(gen, cn.x, cn.y);
          if (L.got.includes(gi)) return;
          const d = Math.hypot(cn.x - L.x, cn.y - L.y);
          if (d < bd) { bd = d; best = cn; }
        });
        if (best) {
          const ang = Math.atan2(best.y - L.y, best.x - L.x);
          const r0 = cell * 0.6, r1 = cell * 1.7;
          const x0 = sx + Math.cos(ang) * r0, y0 = sy + Math.sin(ang) * r0;
          const x1 = sx + Math.cos(ang) * r1, y1 = sy + Math.sin(ang) * r1;
          ctx.save();
          ctx.shadowColor = 'rgba(245,197,66,0.9)'; ctx.shadowBlur = 8;
          ctx.strokeStyle = '#f5c542'; ctx.lineWidth = Math.max(2.5, cell * 0.1);
          ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(x1 + Math.cos(ang) * cell * 0.35, y1 + Math.sin(ang) * cell * 0.35);
          ctx.lineTo(x1 + Math.cos(ang + 2.5) * cell * 0.3, y1 + Math.sin(ang + 2.5) * cell * 0.3);
          ctx.lineTo(x1 + Math.cos(ang - 2.5) * cell * 0.3, y1 + Math.sin(ang - 2.5) * cell * 0.3);
          ctx.closePath(); ctx.fillStyle = '#f5c542'; ctx.fill();
          ctx.restore();
        }
      }
    }
    // 7) моя фигура — аватар чата (на раскрытии метка конца пути)
    coinsDrawMe(ctx, sx, sy, cell, L.who);
    // 8) pkg3-81 (пункт 3): свежая находка подписывается ПРЯМО НА КАРТЕ —
    // надпись появляется в стороне от аватара и плавно растворяется за 2 секунды
    if (L.hunt && L.flash && L.flash.until) {
      const left = L.flash.until - Date.now();
      if (left <= 0) L.flash = null;
      else {
        const a = Math.max(0.04, Math.min(1, left / (L.flash.total || 2000)));
        const ty = sy > ch / 2 ? ch * 0.14 : ch * 0.86;   // где аватара нет
        ctx.save();
        ctx.globalAlpha = a;
        ctx.font = '600 ' + Math.max(12.5, Math.round(cell * 0.4)) + 'px system-ui, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        const tw = Math.min(cw - 16, ctx.measureText(L.flash.text).width);
        const bx = cw / 2, padX = 10, padY = 6;
        ctx.fillStyle = 'rgba(8,10,16,0.78)';
        ctx.fillRect(bx - tw / 2 - padX, ty - padY - 1, tw + padX * 2, padY * 2 + 2);
        ctx.strokeStyle = 'rgba(245,197,66,0.6)';
        ctx.strokeRect(bx - tw / 2 - padX, ty - padY - 1, tw + padX * 2, padY * 2 + 2);
        ctx.fillStyle = '#f5c542';
        ctx.fillText(L.flash.text, bx, ty, tw);
        ctx.restore();
      }
    }
  } catch (e) { /* сбой отрисовки не смертелен */ }
}
function coinsDrawMe(ctx, sx, sy, cell, who) {
  // pkg3-81 (пункт 10): зритель видит путь того игрока, чья карта открыта, —
  // фигура рисуется с ЕГО аватаром, а не с аватаром зрителя
  const uid = who || (S.me || {}).id;
  const r = cell * 0.42;
  ctx.save();
  ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.closePath(); ctx.clip();
  const av = avatarCache.get(uid);
  const im = av && av.src ? coinsImg(av.src) : null;
  if (im && im.complete && im.naturalWidth) {
    ctx.drawImage(im, sx - r, sy - r, r * 2, r * 2);
  } else {
    ctx.fillStyle = '#c8912a'; ctx.fillRect(sx - r, sy - r, r * 2, r * 2);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold ' + Math.round(r * 1.1) + 'px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String((userById(uid) || {}).name || '?').slice(0, 1).toUpperCase(), sx, sy);
  }
  ctx.restore();
  ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2);
  ctx.lineWidth = Math.max(2, cell * 0.09); ctx.strokeStyle = '#f5c542'; ctx.stroke();
  ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(0,0,0,0.65)'; ctx.stroke();
}
function coinsHud() {
  const L = S.coinsLive;
  if (!L) return;
  const t = document.getElementById('coins-timer');
  if (t) {
    const left = L.hunt ? coinsTimeLeft(L) : 0;
    t.textContent = L.hunt ? coinsFmtSec(left) : '—';
    if (t.classList) t.classList.toggle('low', L.hunt && left <= 30000);
  }
  const s = document.getElementById('coins-score');
  if (s) s.textContent = '🪙 ' + (L.score | 0) + '/' + CE.COINS;
  const b = document.getElementById('coins-bonus');
  if (b) {
    const now = Date.now(), chips = [];
    if (L.hunt && L.lanternUntil > now) chips.push('🔦 ' + Math.ceil((L.lanternUntil - now) / 1000) + ' с');
    if (L.hunt && L.compassUntil > now) chips.push('🧭 компас');
    if (L.hg > 0) chips.push('⏳ +' + (L.hg * 10) + ' с');
    // pkg3-81 (пункт 3): подписи находок здесь больше не появляются — они
    // рисуются прямо на карте и гаснут за 2 секунды, панель не разъезжается
    b.textContent = chips.join(' · ');
  }
}
let coinsTicker = 0;
function coinsTickerStart() {
  if (coinsTicker) return;
  coinsTicker = setInterval(() => {
    try {
      const L = S.coinsLive;
      if (!L || !L.hunt) return;
      // pkg3-82 (правка 6): мелодия карты лечится сама — если аудиоконтекст
      // не ожил с первой попытки (телефон спал, вкладка пряталась), тикер
      // повторяет старт; насос внутри движка будит контекст каждые полсекунды
      if (GS.isEnabled() && GS.musicPref() && !GS.isPlaying()) GS.startMusic(L.gen.mapIdx);
      const left = coinsTimeLeft(L);
      if (left <= 0) { coinsFinishRound(false); return; }
      // pkg3-80: за полминуты до конца раунда — спокойное двойное напоминание
      if (!L.warn30 && left <= 30000) { L.warn30 = true; GS.play('warn'); }
      if (!document.getElementById('coins-canvas')) return;
      coinsDraw(); coinsHud();
    } catch (e) {}
  }, 200);
}
// ── старт, финиш, сдача, повтор забега ──
function coinsStartRound() {
  const c = curChat();
  if (!c || gameRulesOf(c) !== 'coins') return;
  if ((c.roles || {})[S.me.id] !== 'player') return;
  const cs = coinsRunState(c, (S.coinsRun || {})[c.id]);
  if (cs.plan.final) return;
  // pkg3-82 (правка 1): стартуем СВОЙ следующий раунд — соперников не ждём,
  // они идут своим чередом; номер раунда считают наши же письма-результаты
  const mine = (cs.plan.per || {})[S.me.id];
  if (!mine || mine.finished || mine.surrenderedAt !== null || !mine.next) return;
  const r = mine.next;
  const gen = cs.gen(r);
  coinsLocalSet(c.id, {
    run: cs.run, round: r, startedAt: Date.now(), moves: '',
    x: gen.start.x, y: gen.start.y, score: 0, got: [], bgot: [], hg: 0,
    lanternUntil: 0, compassUntil: 0, sent: null
  });
  S.coinsLive = null; S.boardSig = '';
  GS.play('roundstart');   // pkg3-80: раунд начинается — спокойный сигнал и музыка карты
  renderBoard();
}
let coinsFinishing = false;
/** Конец раунда (время вышло, вкладка спала или собраны все монеты — early):
 * карта раскрывается целиком, результат улетает письмом. pkg3-80: отдельной
 * кнопки «Сдаться» больше нет — покинуть забег можно единственной кнопкой
 * «Выйти» над картой (coinsLeaveSmart). */
async function coinsFinishRound(early) {
  const L = S.coinsLive;
  if (!L || coinsFinishing) return;
  const c = S.chats.find(x => x.id === L.chatId);
  if (!c) return;
  if (L.sent || !L.hunt) return;
  coinsFinishing = true;
  L.hunt = false;
  coinsHoldStop();
  GS.stopMusic();          // pkg3-80: раунд окончен — музыка карты замолкает
  // pkg3-81 (пункт 5): досрочный финиш «все монеты собраны» — победный сигнал
  GS.play(early ? 'victory' : 'roundend');
  const limit = (Number(L.minutes) * 60 + (L.hg | 0) * 10) * 1000;
  // финиш честный: даже если страницу открыли спустя часы, временем считается лимит
  const finishedAt = Math.min(Date.now(), Number(L.startedAt) + limit + 400);
  const payload = {
    k: 'coins-result', run: L.run, round: L.round,
    seedUsed: CE.runSeed(String(cs78seed(L)), L.run),
    score: L.score | 0, moves: L.moves, end: [L.x, L.y], hg: L.hg | 0,
    startedAt: Number(L.startedAt), finishedAt
  };
  L.sent = payload;
  coinsSaveLoc(L);
  S.boardSig = '';
  renderBoard();                       // карта раскрывается сразу, не дожидаясь сети
  const m = await sendCoins(c, payload);
  coinsFinishing = false;
  if (m) { toast('Результат раунда отправлен: ' + payload.score + ' монет'); renderRail(); }
  else { S.boardSig = ''; renderBoard(); }
}
const cs78seed = L => (L.cs && L.cs.g && L.cs.g.seed) || '';
async function coinsResend() {
  const c = curChat();
  if (!c || gameRulesOf(c) !== 'coins') return;
  const loc = coinsLocalGet(c.id);
  if (!loc || !loc.sent) { toast('Нечего досылать'); return; }
  const m = await sendCoins(c, loc.sent);
  if (m) toast('Результат дослан');
}
function coinsNewRun() {
  const c = curChat();
  if (!c || gameRulesOf(c) !== 'coins') return;
  const cs = coinsRunState(c, (S.coinsRun || {})[c.id]);
  if (!cs.solo || !cs.plan.final) return;
  S.coinsRun[c.id] = cs.maxRun + 1;
  coinsLocalSet(c.id, null);
  S.coinsLive = null; S.boardSig = '';
  renderBoard();
}
/** Соло: новый рекорд забега — письмо-метка и поздравление. */
let coinsRecBusy = '';
function coinsMaybeRecord(c, cs) {
  if (!cs.solo || cs.run <= 1 || !cs.plan.final) return;
  if (cs.letters.some(l => l.k === 'coins-record' && l.author === S.me.id && (l.run || 1) === cs.run)) return;
  const my = cs.table.find(x => x.id === S.me.id);
  const total = my ? my.total : 0;
  let best = 0;
  const now = Date.now();
  for (let u = 1; u < cs.run; u++) {
    const t = CE.table(cs.game, cs.letters, now, u);
    const me = t.find(x => x.id === S.me.id);
    if (me && me.total > best) best = me.total;
  }
  if (total <= best) return;
  const key = c.id + ':' + cs.run;
  if (coinsRecBusy === key) return;
  coinsRecBusy = key;
  sendCoins(c, { k: 'coins-record', run: cs.run, total }).then(() => {
    toast('🏅 Новый рекорд забега: ' + total + ' монет!');
  });
}

/** Состояние забега словами — в шапку панели и на телефон. */
function coinsStatusText(cs, phase, plan, short) {
  const g = cs.g;
  if (phase === 'final') {
    if (cs.solo) {
      const me = cs.table.find(x => x.id === S.me.id);
      return (short ? '' : 'Забег ' + cs.run + ' завершён: ') + 'всего ' + (me ? me.total : 0) + ' монет';
    }
    const w = cs.winner;
    if (!w) return 'Забег завершён: монет не собрал никто';
    const names = w.ids.map(gamePlayerName).join(', ');
    // pkg3-81 (пункт 7): plural() сам печатает число — второй раз его приписывать
    // не нужно, иначе выходило «Победил Серёга — 200200 монет»
    return (w.ids.length > 1 ? 'Ничья: ' + names : (short ? 'Победил ' : 'Забег завершён, победил ') + names) + ' — ' + plural(w.total, 'монета', 'монеты', 'монет');
  }
  if (phase === 'out') return short ? 'Вы сдались' : 'Вы сдались — забег идёт без вас';
  // pkg3-82 (правки 1–3): общий раунд исчез — у каждого игрока свой темп;
  // зритель видит, сколько раундов уже закрыто хоть кем-то
  if (phase === 'viewer') return (short ? '' : 'Сталкер: ') + (plan.lastDone ? 'закрыто раундов: ' + plan.lastDone + ' из ' + cs.rounds : 'забег начался — ждём первые результаты');
  if (phase === 'sending') return short ? 'Результат отправляется…' : 'Результат раунда отправляется…';
  if (phase === 'reveal') {
    const L = S.coinsLive;
    const n = L ? (L.score | 0) : 0;
    // pkg3-81 (пункт 2): номер раунда берём из вскрытой карты
    const rnd = L ? (L.round | 0) : (((plan.per || {})[S.me.id] || {}).results || 1);
    const mine = (plan.per || {})[S.me.id] || {};
    if (mine.finished) return short ? 'Все раунды пройдены' : 'Вы прошли все раунды — ждём остальных игроков';
    return 'Раунд ' + rnd + ': найдено ' + n + ' из ' + CE.COINS + ' монет';
  }
  if (phase === 'hunt') {
    const L = S.coinsLive;
    const rnd = L ? (L.round | 0) : 1;
    return short ? 'Раунд ' + rnd + ': поиск' : 'Раунд ' + rnd + ' из ' + cs.rounds + ': ищем монеты!';
  }
  const mine = (plan.per || {})[S.me.id] || {};
  const r0 = mine.next || 1;
  return short ? 'Раунд ' + r0 + ' из ' + cs.rounds
    : 'Раунд ' + r0 + ' из ' + cs.rounds + '. Время раунда: ' + fmtCoinsTime(coinsSecOf(g)) + ' — стартует с вашего личного старта';
}
/** Кто в игре: игроки и приглашённые, онлайн/офлайн и метки состояния. */
function coinsPresenceHtml(cs, plan) {
  const g = cs.g;
  // pkg3-82 (правки 1–3): темп у каждого личный — метка показывает прогресс
  // игрока (сколько раундов сдал), а не общий раунд забега
  const row = (id, invited) => {
    const u = userById(id);
    const on = isOnline(u);
    const per = (plan.per || {})[id];
    let mark = '';
    if (invited) mark = '<span class="cp-mark">приглашён</span>';
    else if (per && per.surrenderedAt !== null) mark = '<span class="cp-mark">сдался</span>';
    else if (per && per.finished) mark = '<span class="cp-mark done">все раунды ✓</span>';
    else if (per && per.results > 0) mark = '<span class="cp-mark done">' + per.results + ' из ' + plan.rounds + ' раундов ✓</span>';
    else if (per && !plan.final) mark = '<span class="cp-mark wait">ещё не начал</span>';
    return `<span class="cp-item${on ? ' on' : ''}" title="${on ? 'в сети' : 'не в сети'}"><i class="cp-dot"></i>${escapeHtml(gamePlayerName(id))}${id === (S.me || {}).id ? ' (вы)' : ''}${mark}</span>`;
  };
  return (g.players || []).map(id => row(id, false)).join('') + (g.invitees || []).map(id => row(id, true)).join('');
}
/** Таблица результатов забега: очки по раундам, итог, метки честности. */
function coinsTableHtml(cs) {
  const head = '<tr><th>Игрок</th>' + Array.from({ length: cs.rounds }, (_, i) => '<th>Р' + (i + 1) + '</th>').join('') + '<th>Итог</th></tr>';
  const rows = cs.table.map(row => {
    const tds = row.per.map(cell => {
      if (cell.score === null) return '<td class="ct-wait" title="результата ещё нет">…</td>';
      if (cell.surrendered) return '<td class="ct-surr" title="сдался">сд.</td>';
      if (cell.bad) return '<td class="ct-bad" title="не проверено: результат не сходится с перепроигрыванием пути — засчитан ноль">0*</td>';
      return '<td>' + cell.score + '</td>';
    }).join('');
    const win = cs.plan.final && cs.winner && cs.winner.ids.includes(row.id);
    return `<tr${win ? ' class="ct-win"' : ''}><td class="ct-name">${escapeHtml(gamePlayerName(row.id))}${row.id === S.me.id ? ' (вы)' : ''}</td>${tds}<td class="ct-total">${row.total}</td></tr>`;
  }).join('');
  return `<table class="coins-table">${head}${rows}</table>`;
}
/** Кого ещё ждём: у каждого свой темп, ждём личный финиш каждого. */
function coinsWaitHtml(cs, plan) {
  if (plan.final || !plan.waiting.length) return '';
  const names = plan.waiting.map(gamePlayerName).join(', ');
  return `<div class="coins-wait tiny muted">Ещё в пути: ${escapeHtml(names)}. Каждый проходит раунды в своём темпе; как только все закончат — появятся итоги и победитель.</div>`;
}
/** Соло: все забеги устройства — переключение и сравнение, рекорд помечен. */
function coinsRunsHtml(cs) {
  const now = Date.now();
  const recs = {};
  for (const l of cs.letters) if (l.k === 'coins-record') recs[l.run || 1] = l.total | 0;
  const chips = [];
  const last = Math.max(cs.maxRun, cs.run);
  for (let u = 1; u <= last; u++) {
    const t = CE.table(cs.game, cs.letters, now, u);
    const me = t.find(x => x.id === S.me.id);
    const total = me ? me.total : 0;
    chips.push(`<button class="mini run-chip${u === cs.run ? ' cur' : ''}" data-coins-run="${u}" title="Открыть забег ${u}">Забег ${u} · ${total}🪙${recs[u] !== undefined ? ' ⭐ рекорд' : ''}</button>`);
  }
  return `<div class="coins-runs"><div class="tiny muted">Забеги этого устройства — переключайте и сравнивайте:</div><div class="run-chips">${chips.join('')}</div></div>`;
}
/** pkg3-80: «Результаты» — таблица всех игроков на данный момент, отдельным
 * окном (пункт 6 владельца): очки по раундам, итоги, метки и кто в сети. */
function coinsOpenResults() {
  const c = curChat();
  if (!c || gameRulesOf(c) !== 'coins') return;
  const cs = coinsRunState(c, (S.coinsRun || {})[c.id]);
  // pkg3-82 (правка 4): в соло после последнего раунда «Начать снова» живёт
  // прямо под таблицей — результаты всех забегов копятся в ней же, пока
  // игрок не выйдет из игры
  const soloFinal = cs.solo && cs.plan.final;
  const html = `<div class="coins-results open">
      ${coinsTableHtml(cs)}
      ${coinsWaitHtml(cs, cs.plan)}
      ${cs.solo && Math.max(cs.maxRun, cs.run) > 1 ? coinsRunsHtml(cs) : ''}
      <div class="coins-presence">${coinsPresenceHtml(cs, cs.plan)}</div>
      ${soloFinal ? `<div class="coins-acts"><button class="primary" id="coins-again2">Начать снова</button><span class="tiny muted">новый забег — новый порядок карт; прежние результаты останутся в таблице</span></div>` : ''}
      <p class="hint">Таблица — на данный момент. В раундах, где результат ещё не пришёл, стоит «…»: чужие находки во время раунда не видны никому, таковы правила забега.</p>
    </div>`;
  modal('Сталкер — результаты', html);
  const again2 = $('#modal #coins-again2');
  if (again2) again2.addEventListener('click', () => { hide($('#modal')); coinsNewRun(); });
  for (const chip of $$('#modal [data-coins-run]')) {   // pkg3-89: список, а не один элемент — иначе цикл падает и кнопки не слушают
    chip.addEventListener('click', () => {
      S.coinsRun[c.id] = Number(chip.dataset.coinsRun) || 1;
      hide($('#modal')); S.boardSig = ''; renderBoard();
    });
  }
}
/** pkg3-80: управление перетаскиванием по карте (пункт 8 владельца).
 * Палец в любое место карты и в сторону — фигура идёт туда шагом каждые
 * 170 мс БЕЗ ОСТАНОВКИ, пока палец не отпущен; вернулся к точке касания —
 * встала. На компьютере — стрелки клавиатуры (они уже работали). */
function coinsDragBind(cv) {
  let ox = 0, oy = 0, pid = null, cur = null;
  const TH = 14;   // пикселей от точки касания: меньше — случайные тыки
  const dirOf = (dx, dy) => {
    if (Math.abs(dx) < TH && Math.abs(dy) < TH) return null;
    return Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'R' : 'L') : (dy > 0 ? 'D' : 'U');
  };
  cv.addEventListener('pointerdown', ev => {
    ev.preventDefault();
    try { cv.setPointerCapture(ev.pointerId); } catch (e) {}
    // pkg3-81 (пункт 1): палец на карте не должен ничего выделять — ни текст
    // панели, ни саму карту как элемент; уже возникшее выделение гасим сразу
    try { const sel = document.getSelection && document.getSelection(); if (sel && sel.removeAllRanges) sel.removeAllRanges(); } catch (e) {}
    pid = ev.pointerId; ox = ev.clientX; oy = ev.clientY; cur = null;
    GS.ensure();
  });
  cv.addEventListener('pointermove', ev => {
    if (pid === null || ev.pointerId !== pid) return;
    ev.preventDefault();
    const dir = dirOf(ev.clientX - ox, ev.clientY - oy);
    if (dir === cur) return;
    cur = dir;
    if (dir) coinsHoldStart(dir, ev); else coinsHoldStop();
  });
  const up = ev => {
    if (pid === null || (ev.pointerId !== undefined && ev.pointerId !== pid)) return;
    pid = null; cur = null; coinsHoldStop();
  };
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', up);
  cv.addEventListener('lostpointercapture', up);
  cv.addEventListener('contextmenu', ev => ev.preventDefault());
  // pkg3-81 (пункт 1): браузер не начинает выделение текста и перетаскивание
  // картинки, пока палец ездит по карте
  cv.addEventListener('selectstart', ev => ev.preventDefault());
  cv.addEventListener('dragstart', ev => ev.preventDefault());
}
/** Панель «Золотой лихорадки»: canvas-карта с туманом войны, управление
 * перетаскиванием, присутствующие, результаты окном (pkg3-80). */
function renderCoins(wrap, c) {
  const g = c.game || {};
  const role = (c.roles || {})[S.me.id] || null;
  S.coinsRun = S.coinsRun || {};
  const cs = coinsRunState(c, S.coinsRun[c.id]);
  S.coinsRun[c.id] = cs.run;
  const plan = cs.plan;
  const isPlayer = role === 'player';
  const mySurr = isPlayer ? (cs.letters.find(l => CE.isSurr(l) && l.author === S.me.id && (l.run || 1) === cs.run) || null) : null;
  // pkg3-82 (правки 1–3): темп личный — прогресс каждого игрока считается по
  // его собственным письмам; общего «текущего раунда» забега больше нет.
  // Я могу проходить раунды, не дожидаясь соперника, и он может делать так же;
  // забег ждёт, пока ВСЕ пройдут ВСЕ раунды, — тогда таблица появляется у всех.
  const mine = (plan.per || {})[S.me.id] || { results: 0, done: [], next: null, finished: false, surrenderedAt: null };
  const myNext = (isPlayer && !mySurr && !mine.finished) ? (mine.next || null) : null;
  // моё последнее письмо-результат — из него вскрывается карта после перезагрузки
  let myLastRes = null;
  if (isPlayer) {
    for (const l of cs.letters) if (CE.isResult(l) && l.author === S.me.id && (!myLastRes || (l.round | 0) > (myLastRes.round | 0))) myLastRes = l;
  }
  let loc = coinsLocalGet(c.id);
  // локальный поиск устарел (сменился забег) — стереть
  if (loc && Number(loc.run || 1) !== cs.run) { loc = null; coinsLocalSet(c.id, null); }
  let phase;
  if (!isPlayer) phase = 'viewer';
  else if (mySurr) phase = 'out';
  // pkg3-83 (пункт 2): финал забега ГЛАВНЕЕ локального следа вскрытой карты —
  // иначе игрок, закончивший последним (у него ещё жив loc.sent), застревал
  // на «вы прошли все раунды — ждём остальных» и не видел победителя
  else if (plan.final) phase = 'final';
  else if (loc && loc.startedAt && !loc.sent) phase = 'hunt';
  else if (loc && loc.sent) {
    // pkg3-81 (пункт 2) + pkg3-82: вскрытая карта стоит, пока не нажата
    // «Следующий раунд» / «Результаты»; письмо пришло — reveal, не пришло — sending
    const by = CE.resultsOf(cs.game, cs.letters, Number(loc.round) || 1, cs.run);
    phase = by[S.me.id] ? 'reveal' : 'sending';
  }
  else if (mine.results > 0) phase = 'reveal';
  else phase = 'start';
  // pkg3-78: пока забег не финализирован — опрос ленты чаще (ждём чужие результаты)
  S.coinsPlaying = isPlayer && !plan.final;
  if (phase === 'final' && cs.solo) coinsMaybeRecord(c, cs);
  if (phase === 'hunt') {
    S.coinsLive = coinsMakeLive(c, cs, loc);
    coinsTickerStart();
    if (coinsTimeLeft(S.coinsLive) <= 0) { coinsFinishRound(); return; }   // время вышло, пока вкладка спала
  } else if (phase === 'reveal' || phase === 'sending') {
    const by = (loc && loc.sent) ? (CE.resultsOf(cs.game, cs.letters, Number(loc.round) || 1, cs.run)[S.me.id] || null) : null;
    const src = by || (loc && loc.sent) || myLastRes;
    S.coinsLive = src ? coinsLiveFromResult(c, cs, src, loc) : null;
  } else if (phase === 'final' && cs.solo && myLastRes) {
    // pkg3-82 (правка 4): соло-финал — открытая карта последнего раунда,
    // а таблица результатов и «Начать снова» — за кнопкой «Результаты»
    S.coinsLive = coinsLiveFromResult(c, cs, myLastRes, null);
  } else if (phase === 'viewer') {
    // pkg3-81 (пункт 10): зритель видит НЕ только таблицу — как только хоть
    // один раунд закончен, перед ним открытая карта с путём того, кто
    // сдал результат последним. Живые позиции игроков не передаются по сети
    // (переписка зашифрована), поэтому во время поиска — честная заглушка.
    const vres = cs.letters.filter(l => CE.isResult(l) && (l.run || 1) === cs.run)
      .sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0))[0] || null;
    S.coinsLive = vres ? coinsLiveFromResult(c, cs, vres, null) : null;
  } else S.coinsLive = null;
  // музыка карты звучит только во время поиска и только при поднятой панели
  if (phase === 'hunt' && S.coinsLive) GS.startMusic(S.coinsLive.gen.mapIdx); else GS.stopMusic();
  // финал забега озвучивается один раз на устройство: победа или спокойная кода
  if (phase === 'final') {
    const w = cs.winner;
    gameEndSound(c, cs.solo || (w && w.ids.includes(S.me.id)) ? 'victory' : 'end-neutral');
  } else gameEndSound(c, 'play');
  // шапка: ОДНА кнопка «Выйти» над картой (pkg3-80, пункт 5)
  const ctrl = [];
  if (role) {
    const label = role === 'viewer' ? 'Покинуть' : 'Выйти';
    const full = role === 'viewer' ? 'Покинуть игру'
      : (phase === 'final' || mySurr) ? 'Игра закончена — выйти и убрать её с устройства'
      : 'Покинуть забег: остальные продолжат без вас (в таблице — «сдался»)';
    ctrl.push(`<button class="mini danger" id="gm-leave" title="${escapeHtml(full)}">${label}</button>`);
  }
  if (role === 'player' && (c.knocks || []).length) {
    ctrl.push(`<button class="mini" id="gm-knocks" title="Заявки зрителей: ${c.knocks.length}">Заявки: ${c.knocks.length}</button>`);
  }
  const btnsRow = ctrl.length ? `<div class="bph-btns">${ctrl.join(' ')}</div>` : '';
  const musicOn = GS.musicPref();
  const presSig = (g.players || []).concat(g.invitees || []).map(id => (isOnline(userById(id)) ? 1 : 0)).join('');
  const sig = ['coins', c.id, cs.run, mine.results, myNext || '-', plan.final ? 1 : 0, plan.lastDone, cs.letters.length, phase,
    loc ? (loc.startedAt + (loc.sent ? ':s' : '')) : '-',
    (g.players || []).join(','), (g.invitees || []).join(','),
    phase === 'hunt' ? '' : presSig, musicOn ? 1 : 0, role || '-', S.eco ? 1 : 0].join('|');
  if (S.boardSig === sig && wrap.dataset.chat === c.id && wrap.firstChild) {
    if (S.coinsLive) { coinsDraw(); coinsHud(); }   // панель та же — освежаем холст и цифры
    return;
  }
  S.boardSig = sig; wrap.dataset.chat = c.id;
  wrap.classList.remove('hidden');
  // номер раунда в шапке — тот, чья карта сейчас на экране (свой темп)
  const shownRound = S.coinsLive ? (S.coinsLive.round | 0) : (myNext || plan.lastDone || 1);
  // pkg3-82 (правка 4): в соло-финале карта ПОКАЗЫВАЕТСЯ (в компании финал — таблица)
  const showStage = phase !== 'out' && (phase !== 'final' || !!(cs.solo && S.coinsLive));
  const hud = (phase === 'hunt' || phase === 'reveal' || phase === 'sending' || (phase === 'final' && cs.solo && S.coinsLive))
    ? `<div class="coins-hud"><span class="ch-round">Раунд ${shownRound}/${cs.rounds}</span><span class="ch-timer" id="coins-timer">—</span><span class="ch-score" id="coins-score">🪙</span><span class="ch-bonus" id="coins-bonus"></span>${phase === 'hunt' ? `<button class="mini ch-music" id="coins-music" title="Фоновая музыка этой карты">${musicOn ? '🎵 музыка: вкл' : '🎵 музыка: выкл'}</button>` : ''}</div>`
    // pkg3-81 (пункт 10): у зрителя своя компактная шапка — раунд и роль
    : phase === 'viewer'
    ? `<div class="coins-hud"><span class="ch-round">${S.coinsLive ? 'Раунд ' + shownRound + '/' + cs.rounds : 'Забег идёт'}</span><span class="ch-score">👁 вы зритель</span></div>` : '';
  let stage = '';
  if (showStage) {
    const ovl = phase === 'start' ? `<div class="coins-ovl">
        <b>Раунд ${myNext || 1} из ${cs.rounds}</b>
        <span class="tiny muted">Соберите как можно больше из ${CE.COINS} монет, пока не истекло время. Туман прячет карту — артефакты видны только вблизи. Управление: на телефоне — проведите пальцем по карте в нужную сторону (фигура идёт, пока палец не отпущен), на компьютере — стрелки клавиатуры. Бонусы подбираются один раз и исчезают с карты: 🔦 фонарь — видно дальше 15 секунд, 🧭 компас — стрелка к ближайшей монете, ⏳ песочные часы — +10 секунд.${cs.solo ? '' : ' Каждый игрок проходит раунды в своём темпе — ждать соперников не нужно.'}</span>
        <button class="primary" id="coins-start">Начать раунд</button>
      </div>` : (phase === 'viewer' && !S.coinsLive) ? `<div class="coins-ovl">
        <b>Забег начался: идёт поиск</b>
        <span class="tiny muted">Игроки ищут монеты — каждый в своём темпе. Живые шаги по сети не летают — переписка зашифрована, сервер о поиске не знает ничего. Как только игрок закончит раунд, здесь появится открытая карта с его путём и находками.</span>
      </div>` : '';
    // pkg3-80 (пункт 4): время вышло — карта открыта ЦЕЛИКОМ, несобранные
    // монеты и артефакты видны, счётчик честный
    let badge = '';
    if ((phase === 'reveal' || phase === 'sending' || (phase === 'final' && cs.solo)) && S.coinsLive) {
      const L = S.coinsLive;
      const missC = Math.max(0, CE.COINS - (L.score | 0));
      const missB = Math.max(0, (L.gen.bonuses || []).length - (L.bgot || []).length);
      badge = `<div class="coins-rev">${L.score >= L.gen.coins.length ? '🏆 Все монеты собраны! ' : ''}Карта открыта: найдено ${L.score | 0} из ${CE.COINS} монет${L.bad ? ' · <b>не проверено — засчитан ноль</b>' : ''}</div>
        <div class="coins-miss">Не собрано: ${plural(missC, 'монета', 'монеты', 'монет')} · ${plural(missB, 'артефакт', 'артефакта', 'артефактов')}</div>`;
    }
    // pkg3-81 (пункт 10): подпись зрительской карты — чей путь открыт
    if (phase === 'viewer' && S.coinsLive) {
      const L = S.coinsLive;
      badge = `<div class="coins-rev">Раунд ${L.round | 0}: карта ${L.who ? escapeHtml(gamePlayerName(L.who)) : 'игрока'} открыта · найдено ${L.score | 0} из ${CE.COINS} монет</div>`;
    }
    stage = `<div class="coins-stage">
        <canvas id="coins-canvas" aria-label="Карта забега"></canvas>
        ${ovl}${badge}
      </div>`;
  }
  // pkg3-80/82 (правка 3): финал компании — таблица результатов появляется
  // АВТОМАТИЧЕСКИ у всех; pkg3-83 (пункт 2): победитель объявлен и в её шапке
  const wLine = cs.winner
    ? ' · ' + (cs.winner.ids.length > 1
      ? 'ничья: ' + cs.winner.ids.map(gamePlayerName).join(', ')
      : 'победил ' + gamePlayerName(cs.winner.ids[0]))
      + ' — ' + plural(cs.winner.total, 'монета', 'монеты', 'монет')
    : '';
  const finalTable = (phase === 'final' && !(cs.solo && S.coinsLive)) ? `<div class="coins-results open coins-final-table">
      <div class="cr-head"><b>Итоги забега${cs.solo && Math.max(cs.maxRun, cs.run) > 1 ? ' · забег ' + cs.run : ''}${wLine}</b></div>
      ${coinsTableHtml(cs)}
      ${cs.solo && Math.max(cs.maxRun, cs.run) > 1 ? coinsRunsHtml(cs) : ''}
    </div>` : '';
  let acts = '';
  if (phase === 'hunt') acts = `<div class="coins-acts tiny muted">Проведите пальцем по карте — фигура пойдёт в эту сторону. Стрелки клавиатуры тоже работают.</div>`;
  if (phase === 'sending') acts = `<div class="coins-acts"><button class="mini primary" id="coins-resend">Дослать результат</button><span class="tiny muted">письмо с результатом не ушло — нажмите, чтобы повторить</span></div>`;
  // pkg3-82 (правка 2): после каждого раунда — вскрытая карта и кнопка
  // «Следующий раунд» (свой темп — никого не ждём); после последнего своего
  // раунда — кнопка «Результаты» и честная отметка, кого ещё ждём
  if (phase === 'reveal') {
    if (myNext) {
      acts += `<div class="coins-acts"><button class="primary coins-next" id="coins-next">Следующий раунд: ${myNext} из ${cs.rounds} →</button></div>`;
    } else {
      acts += `<div class="coins-acts"><button class="primary" id="coins-resbtn">Результаты</button></div>`;
      if (!cs.solo && !plan.final) {
        const names = plan.waiting.filter(x => x !== S.me.id).map(gamePlayerName);
        acts += `<div class="coins-waitall">✅ Вы закончили все раунды. Остальные игроки ещё ищут${names.length ? ': <b>' + escapeHtml(names.join(', ')) + '</b>' : ''}. Как только все закончат, таблица результатов появится автоматически. Новый забег компанией можно начать только через «+».</div>`;
      }
    }
  }
  // pkg3-82 (правка 4): соло-финал — карта последнего раунда, а результаты
  // и «Начать снова» — за кнопкой «Результаты» (таблица пополняется каждым
  // новым забегом, пока игрок не вышел из игры)
  if (phase === 'final' && cs.solo) acts = `<div class="coins-acts"><button class="primary" id="coins-resbtn">Результаты</button><span class="tiny muted">таблица всех забегов этого устройства; «Начать снова» — под таблицей</span></div>`;
  if (phase === 'final' && !cs.solo) acts = `<div class="coins-acts tiny muted">Сыграть ещё раз компанией? Новый забег создаётся только через «+»: «Новая игра» → «Сталкер».</div>`;
  wrap.innerHTML = `<div class="board-panel coins-panel">
    <div class="bp-head">
      <div class="bph-top"><span class="bph-full">${escapeHtml(coinsStatusText(cs, phase, plan, false))}</span><span class="bph-short">${escapeHtml(coinsStatusText(cs, phase, plan, true))}</span></div>
      ${btnsRow}
    </div>
    ${hud}
    ${stage}
    ${finalTable}
    ${acts}
    <div class="coins-presence">${coinsPresenceHtml(cs, plan)}</div>
    <button class="mini coins-restoggle" id="coins-restoggle">Результаты</button>
  </div>`;
  const b1 = $('#coins-start', wrap); if (b1) b1.addEventListener('click', () => { GS.ensure(); coinsStartRound(); });
  const b3 = $('#coins-resend', wrap); if (b3) b3.addEventListener('click', coinsResend);
  const b4 = $('#coins-again', wrap); if (b4) b4.addEventListener('click', coinsNewRun);
  const b5 = $('#coins-restoggle', wrap); if (b5) b5.addEventListener('click', coinsOpenResults);
  const b6 = $('#coins-next', wrap); if (b6) b6.addEventListener('click', () => { GS.ensure(); coinsStartRound(); });
  const b7 = $('#coins-resbtn', wrap); if (b7) b7.addEventListener('click', coinsOpenResults);
  const bm = $('#coins-music', wrap);
  if (bm) bm.addEventListener('click', () => {
    const on = GS.toggleMusicPref();
    if (on && S.coinsLive && S.coinsLive.hunt) GS.startMusic(S.coinsLive.gen.mapIdx); else GS.stopMusic();
    S.boardSig = ''; renderBoard();
  });
  const cv = $('#coins-canvas', wrap);
  if (cv && phase === 'hunt') coinsDragBind(cv);
  coinsDraw(); coinsHud();
}

async function acceptGame(id, choice, rules) {
  let color = undefined;
  if (choice === 'choice') {
    // pkg3-57: в морском бое нет «белых» и «чёрных» — вопрос звучит по-человечески:
    // «кто стреляет первым: я или соперник»
    const sb = rules === 'seabattle';
    color = await new Promise(res => {
      modal(sb ? 'Кто стреляет первым' : 'Ваш цвет', `<p class="hint">${sb
        ? 'Создатель игры оставил выбор за вами: кто стреляет первым — вы или соперник.'
        : 'Создатель игры оставил выбор цвета за вами.'}</p>
        <button class="primary" id="pc-w">${sb ? 'Стреляю первым я' : 'Играю белыми'}</button>
        <button class="primary" id="pc-b">${sb ? 'Первым стреляет соперник' : 'Играю чёрными'}</button>`);
      $('#pc-w').addEventListener('click', () => { hide($('#modal')); res('white'); });
      $('#pc-b').addEventListener('click', () => { hide($('#modal')); res('black'); });
    });
  }
  await api('/api/games/' + id + '/accept', { method: 'POST', body: { color } });
  await sync(false);
  const c = S.chats.find(x => x.id === id);
  if (c) {
    const ck = await chatKeyOf(c);
    if (ck) {
      const sbGame = (c.game || {}).rules === 'seabattle';
      const coinsGame = (c.game || {}).rules === 'coins';   // pkg3-78
      const payload = { k: 'game-event', text: coinsGame
        ? '«Сталкер»: ' + userNameById(S.me.id) + ' в игре — можно начинать забег'
        : sbGame
        ? 'Партия началась: ' + userNameById(c.game.white) + ' стреляет первым. Расставьте флот и жмите «В бой!»'
        : 'Партия началась: ' + userNameById(c.game.white) + ' (белые) против ' + userNameById(c.game.black) + ' (чёрные)' };
      const rr = await api('/api/messages', { method: 'POST', body: { chat: id, blob: await encryptJSON(ck.key, payload) } });
      S.plain.set(rr.message.id, payload);
      addMessages([rr.message]);
      cacheMsg(rr.message);
      GS.play('start');   // pkg3-80: партия началась — спокойный стартовый сигнал
    }
    await openChat(id);
    renderBoard();
  }
  loadUi.hide();
  S.sig = ''; renderAll(); renderMessages(true); renderBoard();
}
async function declineGame(id, rules) {
  // pkg3-78: отказ от «Золотой лихорадки» чужой забег не удаляет — остальные продолжают без меня
  if (!confirm(rules === 'coins'
    ? 'Отклонить приглашение в «Сталкер»? Другие игроки продолжат забег без вас.'
    : 'Отклонить приглашение? Игра будет удалена.')) return;
  // pkg3-81 (пункт 9): пригласивший узнаёт об отказе — шлём ему шифрованное
  // письмо в личный чат ещё до удаления игры (иначе у пар-игр не осталось бы
  // даже карточки, из которой видно, кто звал). Он получит обычное уведомление.
  const inv = (S.invites || []).find(x => x.id === id);
  let inviter = inv && inv.owner ? inv.owner : null;
  if (!inviter) {
    const lm = S.messages.find(m => { const p = S.plain.get(m.id); return p && p.k === 'game-invite' && p.game === id && m.uid !== S.me.id; });
    if (lm) inviter = lm.uid;
  }
  await api('/api/games/' + id + '/decline', { method: 'POST', body: {} });
  if (inviter && inviter !== S.me.id) {
    try {
      const dm = (await api('/api/dm', { method: 'POST', body: { peer: inviter } })).chat;
      const dk = await chatKeyOf(dm);
      if (dk) {
        const note = { k: 'game-decline', game: id, rules: rules || 'chess', by: S.me.id };
        const rr = await api('/api/messages', { method: 'POST', timeout: 15000, body: { chat: dm.id, blob: await encryptJSON(dk.key, note), notify: 1 } });
        S.plain.set(rr.message.id, note);
        addMessages([rr.message]);
        cacheMsg(rr.message);
        if (rr.notify) fireNotify(rr.notify);   // «Новое сообщение» — разбудит телефон пригласившего
      }
    } catch (e) { /* письмо отказа — любезность, не обязанность: игра уже отклонена */ }
  }
  await sync(false); renderAll();
  toast('Приглашение отклонено');
}
function leaveKindOf(c) {
  const role = (c.roles || {})[S.me.id];
  if (role === 'viewer') return 'viewer';
  const st = (c.game || {}).status;
  return st === 'playing' ? 'resign' : st === 'invite' ? 'cancel' : 'close';
}
/** pkg3-80 (пункт 3 владельца): выход из ЗАКОНЧЕННОЙ игры происходит на
 * устройстве МГНОВЕННО — чат-игра исчезает из списка сразу, не дожидаясь
 * ответа сервера, а сервер стирает её следом в спокойном режиме. Если запрос
 * не долетел (пропала связь), ид игры ждёт в памяти устройства и досылается
 * при следующей синхронизации; пока сервер не подтвердил выход, игра в список
 * не возвращается. */
const LEAVE_Q = 'sega.leaving80';
function leavingGet() { try { return JSON.parse(localStorage.getItem(LEAVE_Q) || '[]'); } catch (e) { return []; } }
function leavingPut(a) { try { localStorage.setItem(LEAVE_Q, JSON.stringify(a)); } catch (e) {} }
function leaveGameNow(c) {
  if (!c) return;
  const id = c.id;
  GS.stopMusic();
  try { coinsHoldStop(); } catch (e) {}
  const q = leavingGet();
  if (!q.includes(id)) { q.push(id); leavingPut(q); }
  if (S.view === id) { S.view = null; S.threadId = null; }
  S.chats = S.chats.filter(x => x.id !== id);
  S.sig = ''; S.boardSig = '';
  try { renderAll(); } catch (e) {}
  try { renderBoard(); } catch (e) {}
  toast('Игра убрана с устройства — сервер сотрёт её следом');
  fireLeaveGame(id);
}
async function fireLeaveGame(id) {
  try {
    await api('/api/games/' + id + '/leave', { method: 'POST', timeout: 15000, body: {} });
    leavingPut(leavingGet().filter(x => x !== id));   // сервер подтвердил — долг снят
    sync(false).catch(() => {});
  } catch (e) { /* не долетело — retryLeavingGames() повторит на следующей синхронизации */ }
}
let leaveRetryAt = 0;
function retryLeavingGames() {
  const q = leavingGet();
  if (!q.length) return;
  const now = Date.now();
  if (now - leaveRetryAt < 30000) return;   // не чаще раза в 30 секунд — сервер не дёргаем
  leaveRetryAt = now;
  for (const id of q) fireLeaveGame(id);
}
async function leaveGameSmart() {
  const c = curChat();
  if (!c) return;
  if (gameRulesOf(c) === 'coins') return coinsLeaveSmart(c);   // pkg3-80: у забега свой порядок
  const kind = leaveKindOf(c);
  // законченная партия или место зрителя — выход мгновенный, без ожидания сервера
  if (kind === 'close' || kind === 'viewer') { leaveGameNow(c); return; }
  await leaveGame(kind);
}
/** pkg3-80 (пункт 5 владельца): в «Золотой лихорадке» ОДНА кнопка «Выйти» над
 * картой — она же «сдаться». Забег ещё идёт: предупреждаем, пишем письмо
 * «сдался» (оставшиеся раунды больше не ждут человека), убираем игру сразу.
 * Игра закончена — выход мгновенный, как во всех играх. */
async function coinsLeaveSmart(c) {
  const cs = coinsRunState(c, (S.coinsRun || {})[c.id]);
  const role = (c.roles || {})[S.me.id];
  const mySurr = role === 'player'
    ? (cs.letters.find(l => CE.isSurr(l) && l.author === S.me.id && (l.run || 1) === cs.run) || null) : null;
  if (role !== 'player' || cs.plan.final || mySurr) { leaveGameNow(c); return; }
  if (!confirm('Покинуть забег «Сталкер»? В таблице вы будете помечены «сдался», остальные игроки продолжат без вас.')) return;
  // pkg3-82: сдаёмся на СВОЁМ текущем раунде — общего раунда забега больше нет
  const mineP = (cs.plan.per || {})[S.me.id];
  const locP = coinsLocalGet(c.id);
  const curRound = (locP && Number(locP.round)) || (mineP && mineP.next) || 1;
  try { await sendCoins(c, { k: 'coins-surrender', run: cs.run, round: curRound }); } catch (e) {}
  coinsLocalSet(c.id, null);
  leaveGameNow(c);
}
async function leaveGame(kind) {
  const c = curChat();
  if (!c || c.kind !== 'game') return;
  // pkg3-78: выход из «Золотой лихорадки» — не поражение: остальные продолжают забег
  const coinsLeave = gameRulesOf(c) === 'coins';
  const asks = {
    resign: coinsLeave
      ? 'Покинуть забег «Сталкер»? Остальные игроки продолжат без вас. Если вы последний игрок — игра удалится.'
      : 'Вы сдаётесь? Партия завершится победой соперника, и вы покинете чат-игру.',
    cancel: 'Отменить приглашение? Игра ещё не началась и будет удалена без следа.',
    close: 'Закрыть и удалить игру? Партия завершена; чат-игра исчезнет у всех оставшихся участников и зрителей. История ходов удалится безвозвратно.',
    viewer: 'Покинуть игру в роли зрителя?'
  };
  if (!confirm(asks[kind] || 'Покинуть игру?')) return;
  const r = await api('/api/games/' + c.id + '/leave', { method: 'POST', body: {} });
  if (r.wiped) { toast('Игроков не осталось — чат-игра стёрта'); S.view = null; }
  else toast(r.resigned ? 'Вы сдались. Результат записан.' : 'Вы вышли из игры');
  await sync(false);
  S.sig = ''; renderAll(); renderMessages(true); renderBoard();
}
async function openKnocks(c) {
  const list = (c.knocks || []).map(userById).filter(Boolean);
  if (!list.length) { toast('Заявок сейчас нет'); return; }
  modal('Заявки в зрители', list.map(u => `<div class="mrow">
    <span class="nm">${escapeHtml(u.name)}</span>
    <button class="mini" data-knock-approve="${escapeHtml(u.id)}">пустить</button>
    <button class="mini danger" data-knock-reject="${escapeHtml(u.id)}">отказать</button></div>`).join(''));
}
/** pkg3-83 (пункт 4): «Новая игра» открывается в ДВА шага. Шаг первый — список
 * игр с иконками-плитками владельца и названиями; шаг второй — настройки
 * выбранной игры (соперник и кто ходит первый / минуты, раунды и гости).
 * Прежде список и настройки жили в одном окне с выпадающим списком игр. */
// ─────────────────────────── pkg3-86: «Моя музыка» ───────────────────────────
/** Плеер мессенджера: ОДИН звуковой элемент на всё приложение; плейлисты —
 * списки ПРЯМЫХ ссылок на аудиофайлы (треки на VPS не хранятся). Публичные
 * плейлисты видны участникам, «только я» зашифрованы личным ключом владельца.
 * pkg3-87: статус «🎵 слушает», «🎧 вместе», чужие публичные списки.
 * pkg3-88: второй род треков — «виджет» Яндекс.Музыки. Это НЕ файл, а чужой
 * встроенный плеер в изолированной рамке (iframe): звук играет Яндекс, мы не
 * можем ни перемотать его, ни услышать, когда трек кончился. Поэтому виджет
 * живёт в отдельной панели внизу окна, не участвует в «🎧 вместе» и не
 * транслируется в статус — там, где нужна точность, работаем только с файлами. */
const MUS = { a: null, list: [], idx: -1, plId: null, widget: null };
/** pkg3-88: трек-виджет (плеер Яндекс.Музыки) вместо прямой ссылки на файл. */
const musicIsWidget = t => !!(t && t.kind === 'widget');
/** pkg3-88: разбор вставленного текста — код плеера, ссылка Яндекса или файл.
 * Сам разбор живёт в music-paste.js: он «чистый» (без сети и DOM) и покрыт
 * тестом test/music88.mjs, а приложение лишь пользуется его ответом. */
function musicParsePaste(text) {
  const mp = (typeof window !== 'undefined' && window.MP) || null;
  if (!mp || typeof mp.parsePaste !== 'function') return { kind: 'none', hint: 'Модуль распознавания ссылок не загрузился — обновите страницу.' };
  try { return mp.parsePaste(text); } catch (e) { return { kind: 'none', hint: 'Не удалось разобрать вставленный текст.' }; }
}
const musicWhatRu = w => ((window.MP && window.MP.whatRu) ? window.MP.whatRu(w) : 'плеер');
function musicAudio() {
  if (!MUS.a) {
    MUS.a = new Audio();
    MUS.a.preload = 'metadata';
    MUS.a.addEventListener('ended', () => musicStep(1, true));
    MUS.a.addEventListener('play', musicFabSync);
    MUS.a.addEventListener('pause', musicFabSync);
    MUS.a.addEventListener('timeupdate', musicTickUi);
  }
  return MUS.a;
}
/** Загрузка моих списков: публичные открыто, личные — расшифровка личным ключом. */
async function musicLoad() {
  const r = await api('/api/music');
  const pub = Array.isArray(r.pub) ? r.pub : [];
  let priv = [], km = null;
  if (r.key) {
    try { km = await importAes(await aesDecryptBytes(S.priv, r.key)); } catch (e) { km = null; }
  }
  if (r.priv && km) { try { const p = await decryptJSON(km, r.priv); priv = Array.isArray(p) ? p : []; } catch (e) { priv = []; } }
  S.music = { pub, priv, km, keyWrap: r.key || null };
  return S.music;
}
/** Сохранение: публичные открыто, личные — шифротекст на ключе музыки. */
async function musicSave() {
  const m = S.music;
  if (!m) return;
  let key = m.keyWrap || null, privBlob = null;
  if (m.priv.length) {
    if (!m.km) {
      const raw = crypto.getRandomValues(new Uint8Array(32));
      m.km = await importAes(raw);
      key = await aesEncryptBytes(S.pub, raw);
    }
    privBlob = await encryptJSON(m.km, m.priv);
  }
  m.keyWrap = key;
  await api('/api/music', { method: 'POST', body: { pub: m.pub, priv: privBlob, key } });
}
const musicAll = () => ((S.music && S.music.pub) || []).concat((S.music && S.music.priv) || []);
const musicFind = id => musicAll().find(p => p.id === id) || null;
const musicUid = () => 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
function musicPlay(pl, idx) {
  MUS.list = (pl && pl.tracks) || [];
  MUS.idx = idx;
  MUS.plId = (pl && pl.id) || null;
  const t = MUS.list[idx];
  if (!t) return;
  // pkg3-88: виджет Яндекс.Музыки играет чужим плеером, файл — нашим
  if (musicIsWidget(t)) { musicPlayWidget(t); return; }
  musWidgetHide();
  const a = musicAudio();
  a.src = t.url;
  a.play().catch(() => toast('Не удалось проиграть трек: похоже, ссылка ведёт на страницу, а не на файл', true));
  musicNowUi(); musicFabSync();
}
/** pkg3-88: включить трек-виджет. Наш звуковой элемент при этом гаснет — иначе
 * две песни звучали бы одновременно. Рамка собирается САМИМ приложением из
 * ссылки, которую пропустил белый список (только music.yandex.ru/iframe/):
 * чужой HTML-код из буфера обмена в разметку не вставляется. */
function musicPlayWidget(t) {
  const a = musicAudio();
  a.pause();
  a.removeAttribute('src');
  try { a.load(); } catch (e) {}
  MUS.widget = t;
  musWidgetShow(t);
  musicNowUi(); musicFabSync();
}
/** Панель встроенного плеера: одна на приложение, живёт прямо в странице —
 * поэтому звук не обрывается, когда окно «Моя музыка» закрыли. */
function musWidgetShow(t) {
  let box = document.getElementById('mus-widget');
  if (!box) {
    box = document.createElement('div');
    box.id = 'mus-widget';
    box.className = 'mus-widget';
    box.innerHTML = '<div class="mus-widget-hd"><b id="mus-widget-t"></b>'
      + '<button class="mini" id="mus-widget-stop" type="button" title="Закрыть плеер">■ стоп</button></div>'
      + '<div id="mus-widget-frame"></div>'
      + '<p class="mus-widget-note" id="mus-widget-note">Плеер Яндекс.Музыки: перемотка, громкость и «следующий трек» — внутри него. Без входа в Яндекс песни звучат только по 30 секунд.</p>';
    document.body.appendChild(box);
    box.querySelector('#mus-widget-stop').addEventListener('click', () => musWidgetStop());
  }
  box.querySelector('#mus-widget-t').textContent = t.title || 'Яндекс.Музыка';
  const holder = box.querySelector('#mus-widget-frame');
  const f = document.createElement('iframe');
  f.setAttribute('src', t.url);
  f.setAttribute('title', 'Плеер Яндекс.Музыки');
  f.setAttribute('frameborder', '0');
  f.setAttribute('allow', 'autoplay; encrypted-media; fullscreen');
  // «песочница»: чужому плееру разрешено ровно то, что нужно для звука и входа
  f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-forms allow-popups-to-escape-sandbox');
  f.style.height = (Number(t.h) > 60 ? Number(t.h) : 180) + 'px';
  holder.textContent = '';
  holder.appendChild(f);
  show(box);
  musUiMode();
}
/** Убрать панель (звук Яндекса при этом прекращается — рамка уничтожается). */
function musWidgetHide() {
  const box = document.getElementById('mus-widget');
  if (box) {
    const holder = box.querySelector('#mus-widget-frame');
    if (holder) holder.textContent = '';
    hide(box);
  }
  if (MUS.widget) { MUS.widget = null; musUiMode(); musicFabSync(); }
}
/** Кнопка «■ стоп»: гасим и виджет, и наш плеер. */
function musWidgetStop() {
  musWidgetHide();
  const a = MUS.a;
  if (a) { a.pause(); }
  musicNowUi(); musicFabSync();
  toast('Плеер Яндекс.Музыки закрыт');
}
/** Подпись плеера в окне «Моя музыка» в зависимости от рода трека. */
function musUiMode() {
  const box = document.querySelector('#modal .mus-player');
  if (!box) return;
  const w = !!MUS.widget;
  box.classList.toggle('widget-mode', w);
  const tog = box.querySelector('#mus-toggle');
  if (tog) tog.textContent = w ? '■ стоп' : '▶ / ⏸';
  const tg = box.querySelector('#mus-together');
  if (tg) { tg.disabled = w; tg.title = w ? 'Встроенный плеер Яндекс.Музыки нельзя запустить у собеседника с той же секунды' : 'Предложить открытому чату слушать этот трек вместе'; }
  const note = box.querySelector('#mus-now-kind');
  if (note) note.textContent = w ? 'Встроенный плеер Яндекс.Музыки открыт внизу окна: перемотка и громкость — внутри него.' : '';
}
function musicStep(d, auto) {
  if (!MUS.list.length) return;
  let n = MUS.idx + d;
  if (n >= MUS.list.length) { if (auto) { const a = musicAudio(); a.pause(); a.currentTime = 0; musicFabSync(); return; } n = 0; }
  if (n < 0) n = MUS.list.length - 1;
  musicPlay(musicFind(MUS.plId) || { id: MUS.plId, tracks: MUS.list }, n);
}
function musicNowUi() {
  const el = document.getElementById('mus-now');
  const t = MUS.list[MUS.idx] || MUS.widget;
  if (el) el.textContent = t ? ('♪ ' + (t.title || t.url)) : '—';
  musUiMode();   // pkg3-88: обычный трек или встроенный плеер Яндекса
}
function musicTickUi() {
  const a = MUS.a;
  const time = document.getElementById('mus-time');
  const seek = document.getElementById('mus-seek');
  if (!a || !time) return;
  const d = isFinite(a.duration) ? a.duration : 0;
  time.textContent = coinsFmtSec(a.currentTime * 1000) + ' / ' + (d ? coinsFmtSec(d * 1000) : '—:—');
  if (seek && d) seek.value = String(Math.round(a.currentTime / d * 100));
}
/** pkg3-87: статус «🎵 слушает»: короткая строка, которую клиент сам решает
 * показать миру. Название трека уходит только из ПУБЛИЧНОГО плейлиста; из личного
 * («только я») — пусто, и собеседники видят просто «слушает музыку». */
function musicStatusNote() {
  const t = MUS.list[MUS.idx];
  if (!t) return '';
  const pl = musicFind(MUS.plId);
  const pub = !!pl && ((S.music && S.music.pub) || []).some(x => x.id === pl.id);
  return pub ? String(t.title || t.url).slice(0, 80) : '';
}
let musStatusOn = false;
function musicStatusKick() {
  if (!S.token) return;
  const a = MUS.a;
  // pkg3-88: встроенный плеер Яндекс.Музыки — чужая рамка, мы не знаем, играет
  // ли она прямо сейчас и что именно. Врать статусом не будем: виджет в «🎵
  // слушает» не участвует (файлы — как раньше).
  const on = !MUS.widget && !!(a && a.src && !a.paused && !a.ended);
  if (!on && !musStatusOn) return;
  musStatusOn = on;
  api('/api/typing', { method: 'POST', body: on ? { kind: 'music', note: musicStatusNote() } : { kind: 'music-off' } })
    .catch(() => {});
}
setInterval(() => {   // раз в 20 секунд подтверждаем: сервер держит статус 45
  const a = MUS.a;
  if (musStatusOn || (a && a.src && !a.paused && !a.ended)) musicStatusKick();
}, 20000);
/** Проиграть ОДИН трек по ссылке (чужая карта «слушать вместе» / публичный список). */
function musicPlayOnce(url, title, offset, kind) {
  MUS.list = [{ url: url, title: title || url, kind: kind || '' }];
  MUS.idx = 0; MUS.plId = null;
  if (musicIsWidget(MUS.list[0])) { musicPlayWidget(MUS.list[0]); return; }
  musWidgetHide();
  const a = musicAudio();
  a.src = url;
  if (offset > 0) {
    const seek0 = () => {
      a.removeEventListener('loadedmetadata', seek0);
      if (isFinite(a.duration) && a.duration && offset < a.duration) a.currentTime = offset;
    };
    a.addEventListener('loadedmetadata', seek0);
  }
  a.play().catch(() => toast('Не удалось проиграть трек: похоже, ссылка ведёт на страницу, а не на файл', true));
  musicNowUi(); musicFabSync();
}
/** pkg3-87: «слушать вместе» — письмо в открытый чат с якорем: трек, позиция,
 * время отправки. Письмо зашифровано ключом чата, как любое другое: сервер не
 * видит ни трека, ни названия. Собеседник жмёт «Слушать» — плеер стартует с того
 * же места песни, на котором она у предложившего (якорь догоняет по часам). */
async function musicTogether() {
  const c = curChat();
  const t = MUS.list[MUS.idx];
  if (!c) { toast('Сначала откройте чат с тем, с кем хотите слушать вместе', true); return; }
  if (musicIsWidget(t) || MUS.widget) {
    toast('Это встроенный плеер Яндекс.Музыки: запустить его у собеседника с той же секунды нельзя. Предложите вместе обычный трек-файл', true);
    return;
  }
  if (!t || !MUS.a || !MUS.a.src || MUS.a.paused) { toast('Сначала включите трек — потом предложите слушать вместе', true); return; }
  const payload = {
    k: 'mus-together', url: t.url, title: t.title || t.url, cover: t.cover || '',
    pos: Math.round(MUS.a.currentTime || 0), ts: Date.now()
  };
  const r = await sendCoins(c, payload);   // тот же запечатанный конверт, что у писем партии
  if (r) toast('Предложение слушать вместе ушло в чат «' + chatTitle(c) + '»');
}
function musicFabSync() {
  let fab = document.getElementById('music-fab');
  const on = MUS.widget ? true : !!(MUS.a && !MUS.a.paused && !MUS.a.ended);
  if (!fab) {
    fab = document.createElement('button');
    fab.id = 'music-fab';
    fab.className = 'music-fab';
    fab.addEventListener('click', () => openMusic());
    document.body.appendChild(fab);
  }
  fab.classList.toggle('on', on);
  fab.textContent = on ? (MUS.widget ? '🎵 Яндекс' : '🎵 играет') : '';
  musicStatusKick();   // pkg3-87: play/pause/конец трека сразу отражаются в статусе
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-mus-join]');
  if (!b) return;
  const url = b.getAttribute('data-mus-join');
  if (!url) return;
  const pos = Number(b.getAttribute('data-mus-pos')) || 0;
  const ts = Number(b.getAttribute('data-mus-ts')) || 0;
  const off = Math.max(0, pos + (Date.now() - ts) / 1000);   // якорь догоняет песню
  musicPlayOnce(url, b.getAttribute('data-mus-title') || url, off);
  toast('Слушаем вместе: трек пошёл с того же места');
});
/** Прямая ли ссылка? Пробуем услышать файл за 6 секунд (метаданные аудио). */
function musicProbe(url) {
  return new Promise(res => {
    const p = new Audio();
    p.preload = 'metadata';
    const t = setTimeout(() => res(false), 6000);
    p.onloadedmetadata = () => { clearTimeout(t); res(true); };
    p.onerror = () => { clearTimeout(t); res(false); };
    p.src = url;
  });
}
/** Обложка трека: картинка → квадрат 96 px, data-URL (лёгкий, лежит в списке). */
function musicCoverOf(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = 96; c.height = 96;
        const x = c.getContext('2d');
        const s = Math.min(img.width, img.height);
        x.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 96, 96);
        res(c.toDataURL('image/jpeg', 0.72));
      };
      img.onerror = () => rej(new Error('Картинка не читается'));
      img.src = fr.result;
    };
    fr.onerror = () => rej(new Error('Файл не читается'));
    fr.readAsDataURL(file);
  });
}
/** Окно «Моя музыка»: плейлисты слева, треки и плеер справа. */
async function openMusic(wantId) {
  try {
    if (!S.music) await musicLoad();
  } catch (e) { toast('Не удалось загрузить плейлисты: ' + (e.message || e), true); return; }
  const m = S.music;
  const all = musicAll();
  const plId = wantId || MUS.plId || (all[0] && all[0].id) || null;
  const pl = musicFind(plId);
  modal('Моя музыка', `<div class="mus-wrap">
    <div class="mus-left">
      <div class="mus-pls">${all.map(p => `<button class="mus-pl${p.id === plId ? ' cur' : ''}" data-mus-pl="${escapeHtml(p.id)}">${escapeHtml(p.name)} <span class="tiny muted">${p.vis === 'priv' ? '· только я' : '· публичный'} · ${(p.tracks || []).length}</span></button>`).join('') || '<div class="tiny muted">Плейлистов пока нет.</div>'}</div>
      <div class="mus-acts"><button class="mini" id="mus-add-pl">+ плейлист</button>${pl ? ' <button class="mini" id="mus-ren-pl">переименовать</button> <button class="mini" id="mus-vis-pl">видимость</button> <button class="mini danger" id="mus-del-pl">удалить</button>' : ''}</div>
    </div>
    <div class="mus-right">
      ${pl ? `<div class="mus-trs">${(pl.tracks || []).map((t, i) => `<div class="mus-tr${MUS.plId === pl.id && MUS.idx === i ? ' cur' : ''}">
          <button class="mini" data-mus-play="${i}" title="Играть">▶</button>
          <span class="mus-tr-t">${t.cover ? `<img class="mus-cov" src="${t.cover}" alt="">` : '<span class="mus-cov mus-cov-e">♪</span>'}<span class="mus-tr-n">${escapeHtml(t.title || t.url)}${musicIsWidget(t) ? ` <span class="mus-badge-y" title="Встроенный плеер Яндекс.Музыки: звук играет Яндекс, а без входа в его аккаунт песни звучат отрывками по 30 секунд">Я · ${musicWhatRu(t.what)}</span>` : ''}</span></span>
          ${musicIsWidget(t) ? `<a class="mini mus-y-link" data-mus-y="${i}" href="${escapeHtml(t.page || t.url)}" target="_blank" rel="noopener noreferrer" title="Открыть в Яндекс.Музыке">↗ Яндекс</a>` : ''}
          <button class="mini" data-mus-edit="${i}">правка</button>
          <button class="mini danger" data-mus-del="${i}" title="Убрать трек">×</button>
        </div>`).join('') || '<div class="tiny muted">В плейлисте пока нет треков — добавьте первый ниже.</div>'}</div>
      <div class="mus-add">
        <input id="mus-url" type="text" placeholder="Вставьте: код плеера Яндекс.Музыки, ссылку на трек/альбом/плейлист или прямую ссылку на файл">
        <input id="mus-title" type="text" placeholder="Название (необязательно)">
        <input id="mus-cover" type="file" accept="image/*" title="Обложка (необязательно)">
        <button class="mini primary" id="mus-add-tr">Добавить</button>
        <span class="tiny muted" id="mus-add-hint">Умная вставка: «Поделиться → Код плеера» Яндекс.Музыки, ссылка на трек/альбом/плейлист/артиста Яндекса или прямая ссылка на файл (…/track.mp3, .ogg, .m4a). Адреса страниц других сайтов (VK, YouTube, Spotify) не играются.</span>
      </div>` : '<div class="tiny muted">Создайте первый плейлист слева — в нём будут треки-ссылки на файлы.</div>'}
      <div class="mus-player">
        <b id="mus-now">—</b>
        <span class="tiny muted" id="mus-now-kind"></span>
        <div class="mus-ctl">
          <button class="mini" id="mus-prev" title="Предыдущий">⏮</button>
          <button class="mini primary" id="mus-toggle">▶ / ⏸</button>
          <button class="mini" id="mus-next" title="Следующий">⏭</button>
          <input id="mus-seek" type="range" min="0" max="100" value="0" title="Перемотка">
          <span id="mus-time" class="tiny muted">0:00 / —:—</span>
          <input id="mus-vol" type="range" min="0" max="100" value="90" title="Громкость">
          <button class="mini" id="mus-together" title="Предложить открытому чату слушать этот трек вместе">🎧 вместе</button>
        </div>
      </div>
    </div>
  </div>`);
  musicNowUi(); musicTickUi();
  for (const b of $$('#modal [data-mus-pl]')) b.addEventListener('click', () => openMusic(b.getAttribute('data-mus-pl')));
  for (const b of $$('#modal [data-mus-play]')) b.addEventListener('click', () => musicPlay(pl, Number(b.getAttribute('data-mus-play'))));
  // pkg3-89: здесь был один доллар вместо двух — цикл падал на первой же кнопке, и всё
  // ниже (добавить трек, «▶ / ⏸», перемотка, громкость, «вместе») оставалось
  // БЕЗ слушателей: окно выглядело живым, но кнопки не отвечали.
  for (const b of $$('#modal [data-mus-edit]')) b.addEventListener('click', async () => {
    const i = Number(b.getAttribute('data-mus-edit'));
    const t = pl.tracks[i];
    const url = prompt('Ссылка (прямая на файл, «код плеера» или ссылка Яндекс.Музыки):', t.page || t.url);
    if (url === null) return;
    const title = prompt('Название трека:', t.title || '');
    if (title === null) return;
    // pkg3-88: правка тем же «умным» разбором — трек можно превратить из файла
    // в виджет Яндекс.Музыки и обратно, не удаляя его из списка.
    const r = musicParsePaste(url);
    if (r.kind === 'widget') {
      t.kind = 'widget'; t.what = r.what || 'track'; t.url = r.url;
      t.page = r.orig || r.url; t.h = r.h || 180;
    } else if (r.kind === 'file') {
      t.kind = ''; t.what = ''; t.url = r.url; t.page = ''; t.h = 0;
    } else {
      toast(r.hint || 'Не удалось понять вставленный текст — трек не изменён', true);
      return;
    }
    t.title = title.trim() || t.title || t.url;
    await musicSave(); openMusic(pl.id);
  });
  for (const b of $$('#modal [data-mus-del]')) b.addEventListener('click', async () => {   // pkg3-89: список, а не один элемент (см. выше)
    const i = Number(b.getAttribute('data-mus-del'));
    if (!confirm('Убрать трек «' + (pl.tracks[i].title || pl.tracks[i].url) + '» из плейлиста?')) return;
    // pkg3-88: если убирают виджет, который звучит прямо сейчас, — гасим панель,
    // иначе чужой плеер продолжал бы играть «без хозяина»
    const gone = pl.tracks[i];
    if (musicIsWidget(gone) && MUS.widget && MUS.widget.id === gone.id) musWidgetStop();
    pl.tracks.splice(i, 1);
    await musicSave(); openMusic(pl.id);
  });
  const addPl = $('#mus-add-pl');
  if (addPl) addPl.addEventListener('click', async () => {
    const name = prompt('Название плейлиста:');
    if (!name || !name.trim()) return;
    const vis = confirm('Показывать плейлист другим участникам?\n«ОК» — публичный (виден из вашего аватара), «Отмена» — только я (зашифрован)') ? 'pub' : 'priv';
    const np = { id: musicUid(), name: name.trim(), vis, tracks: [] };
    m[vis].push(np);
    await musicSave(); openMusic(np.id);
  });
  const renPl = $('#mus-ren-pl');
  if (renPl) renPl.addEventListener('click', async () => {
    const name = prompt('Новое название плейлиста:', pl.name);
    if (!name || !name.trim()) return;
    pl.name = name.trim();
    await musicSave(); openMusic(pl.id);
  });
  const visPl = $('#mus-vis-pl');
  if (visPl) visPl.addEventListener('click', async () => {
    const to = pl.vis === 'pub' ? 'priv' : 'pub';
    if (!confirm(to === 'pub' ? 'Сделать плейлист публичным (виден другим участникам)?' : 'Скрыть плейлист «только я» (будет зашифрован)?')) return;
    m[pl.vis] = m[pl.vis].filter(x => x.id !== pl.id);
    pl.vis = to; m[to].push(pl);
    await musicSave(); openMusic(pl.id);
  });
  const delPl = $('#mus-del-pl');
  if (delPl) delPl.addEventListener('click', async () => {
    if (!confirm('Удалить плейлист «' + pl.name + '» со всеми треками?')) return;
    m[pl.vis] = m[pl.vis].filter(x => x.id !== pl.id);
    if (MUS.plId === pl.id) { const a = musicAudio(); a.pause(); a.src = ''; MUS.list = []; MUS.idx = -1; MUS.plId = null; musWidgetHide(); musicFabSync(); }
    await musicSave(); openMusic(null);
  });
  const addTr = $('#mus-add-tr');
  if (addTr) addTr.addEventListener('click', async () => {
    const raw = $('#mus-url').value || '';
    const title = ($('#mus-title').value || '').trim();
    const hintEl = $('#mus-add-hint');
    // pkg3-88: «умная вставка». Один и тот же кусок буфера может оказаться кодом
    // плеера Яндекс.Музыки (<iframe src=…>), ссылкой на трек/альбом/плейлист
    // Яндекса, прямой ссылкой на аудиофайл или адресом чужой страницы. Разбираем
    // ДО отправки и честно говорим, что из этого выйдет: виджет (играет чужим
    // плеером), файл (играет наш плеер) или «это страница, играть нечего».
    const r = musicParsePaste(raw);
    let cover = '';
    const cf = $('#mus-cover').files && $('#mus-cover').files[0];
    if (cf && (r.kind === 'widget' || r.kind === 'file')) {
      try { cover = await musicCoverOf(cf); } catch (e) { toast('Обложка не получилась: ' + e.message, true); }
    }
    if (r.kind === 'widget') {
      if ((pl.tracks || []).some(t => t.url === r.url)) { toast('Такой ' + musicWhatRu(r.what) + ' Яндекс.Музыки уже есть в этом плейлисте', true); return; }
      pl.tracks.push({
        id: musicUid(), kind: 'widget', what: r.what || 'track', url: r.url,
        page: r.orig || r.url, h: r.h || 180,
        title: title || r.title || 'Яндекс.Музыка', cover: cover
      });
      await musicSave(); openMusic(pl.id);
      toast('Добавлено: ' + musicWhatRu(r.what) + ' Яндекс.Музыки — играет встроенным плеером');
      return;
    }
    if (r.kind === 'page' || r.kind === 'none') {
      const msg = r.hint || 'Не удалось понять вставленный текст';
      if (hintEl) { hintEl.textContent = msg; hintEl.classList.add('warn'); }
      toast(msg, true);
      return;
    }
    const url = r.url;   // r.kind === 'file'
    const okProbe = await musicProbe(url);
    if (!okProbe && !confirm('За 6 секунд файл по ссылке не откликнулся: похоже, это адрес СТРАНИЦЫ, а не файла. Добавить всё равно?')) return;
    if ((pl.tracks || []).some(t => t.url === url)) { toast('Такая ссылка уже есть в этом плейлисте', true); return; }
    pl.tracks.push({ id: musicUid(), url: url, title: title || url, cover: cover });
    await musicSave(); openMusic(pl.id);
  });
  const tog = $('#mus-toggle');
  if (tog) tog.addEventListener('click', () => {
    if (MUS.widget) { musWidgetStop(); return; }   // pkg3-88: «■ стоп» закрывает плеер Яндекса
    const a = musicAudio();
    if (!a.src) { if (pl && (pl.tracks || []).length) musicPlay(pl, 0); return; }
    if (a.paused) a.play().catch(() => toast('Не удалось проиграть трек', true)); else a.pause();
  });
  const prev = $('#mus-prev'), next = $('#mus-next');
  if (prev) prev.addEventListener('click', () => musicStep(-1, false));
  if (next) next.addEventListener('click', () => musicStep(1, false));
  const seek = $('#mus-seek');
  if (seek) seek.addEventListener('input', () => {
    const a = musicAudio();
    if (a && isFinite(a.duration) && a.duration) a.currentTime = Number(seek.value) / 100 * a.duration;
  });
  const vol = $('#mus-vol');
  if (vol) vol.addEventListener('input', () => { musicAudio().volume = Number(vol.value) / 100; });
  const tgb = $('#mus-together');
  if (tgb) tgb.addEventListener('click', () => musicTogether());
}

/** pkg3-87: «🎵 музыка» у чужого аватара: публичные плейлисты участника, только
 * чтение. Сервер отдаёт сюда ТОЛЬКО публичное (GET /api/music/ID); личные списки
 * и ключ не покидают устройство владельца. Кнопка «▶» включает трек НА МОЁМ
 * устройстве прямо с источника — как обычная ссылка. */
async function openMusicOf(u) {
  let pub = [];
  try {
    const r = await api('/api/music/' + encodeURIComponent(u.id));
    pub = Array.isArray(r.pub) ? r.pub : [];
  } catch (e) { toast('Не удалось открыть музыку участника: ' + (e.message || e), true); return; }
  const pls = pub.filter(p => (p.tracks || []).length);
  modal('Музыка · ' + (u.name || ''), pls.length ? `
    <div class="mus-of">${pls.map(p => `
      <div class="mus-of-pl"><b>${escapeHtml(p.name || 'Плейлист')}</b>
        ${(p.tracks || []).map(t => `<button class="mus-of-tr${musicIsWidget(t) ? ' y' : ''}" data-musof-url="${escapeHtml(t.url)}" data-musof-kind="${escapeHtml(t.kind || '')}" data-musof-title="${escapeHtml(t.title || t.url)}" title="Включить на моём устройстве">▶ ${escapeHtml(t.title || t.url)}${musicIsWidget(t) ? ' <span class="mus-badge-y">Я</span>' : ''}</button>`).join('')}
      </div>`).join('')}
    </div>
    <p class="hint">Это публичные плейлисты участника: звук идёт с источника прямо на ваше устройство, треки не скачиваются на сервер. Личные списки (если они есть) видны только владельцу.</p>`
    : '<div class="tiny muted">У участника пока нет публичных плейлистов с треками.</div>');
  $('#modal-body').addEventListener('click', e => {
    const b = e.target.closest('[data-musof-url]');
    if (!b) return;
    hide($('#modal'));
    // pkg3-88: чужой трек может быть виджетом Яндекс.Музыки — тогда он откроется
    // встроенным плеером, а не нашим звуковым элементом
    musicPlayOnce(b.getAttribute('data-musof-url'), b.getAttribute('data-musof-title'), 0, b.getAttribute('data-musof-kind'));
  });
}

async function openNewGame() {
  const users = S.users.filter(u => u.id !== S.me.id && !u.displayAs);   // pkg3-62: слитых не зовём
  const list = ['chess', 'checkers', 'seabattle', 'coins'].filter(r => r === 'coins' || users.length);
  modal('Новая игра', `
    <div class="ng-games" id="ng-games">
      ${list.map(r => `<button class="ng-game" data-ng-rules="${r}">
        ${gameIconImg(r, 'gimg-ng')}
        <span>${escapeHtml(gameNameOf(r))}</span>
      </button>`).join('')}
    </div>
    <p class="hint">${users.length
      ? 'Выберите игру — откроются её настройки: соперник, кто ходит первым, время и раунды.'
      : 'Пока некого позвать — доступен только «Сталкер»: соло-забег открыт всегда.'}</p>`);
  for (const b of $$('#ng-games [data-ng-rules]')) {
    b.addEventListener('click', () => openNewGameSettings(b.getAttribute('data-ng-rules'), users));
  }
}
/** pkg3-83: второй шаг — настройки выбранной игры и создание партии. */
async function openNewGameSettings(rules, users) {
  const pair = rules !== 'coins';
  const sb = rules === 'seabattle';
  modal('Новая игра · ' + gameNameOf(rules), `
    <button class="mini" id="ng-back">← к списку игр</button>
    ${pair ? `
    <div id="ng-pair"${users.length ? '' : ' class="hidden"'}>
      <label>Соперник<select id="ng-opp">${users.map(u => `<option value="${escapeHtml(u.id)}">${escapeHtml(u.name)}</option>`).join('')}</select></label>
      <label>${sb ? 'Кто стреляет первым' : 'Ваш цвет'}<select id="ng-color">
        <option value="random">Случайно</option>
        <option value="white">${sb ? 'Я стреляю первым' : 'Белые'}</option>
        <option value="black">${sb ? 'Соперник стреляет первым' : 'Чёрные'}</option>
        <option value="choice">${sb ? 'Пусть решит соперник' : 'Пусть выберет соперник'}</option>
      </select></label>
      <p class="hint">Сопернику придёт приглашение в личном чате с кнопками «Войти в игру» и «Отклонить».</p>
    </div>` : `
    <div id="ng-coins">
      <label>Время раунда (10 секунд — 30 минут, шаг 10 секунд)</label>
      <div class="ng-sec" id="ng-secwrap">
        <button class="mini" id="ng-sec-minus" type="button">− 10 с</button>
        <b id="ng-sec-view">1:00</b>
        <button class="mini" id="ng-sec-plus" type="button">+ 10 с</button>
        <input id="ng-sec" type="hidden" value="60">
      </div>
      <label>Раундов (1–6, по одному на карту)<input id="ng-rounds" type="number" min="1" max="6" step="1" value="3"></label>
      <label>Позвать игроков — не больше трёх (никого = соло-забег)</label>
      <div class="ng-pick" id="ng-pick">${users.length
        ? users.map(u => `<label class="ng-pick-row"><input type="checkbox" value="${escapeHtml(u.id)}"><span>${escapeHtml(u.name)}</span></label>`).join('')
        : '<div class="tiny muted">Пока некого позвать — доступен соло-забег: рекорды и сравнение забегов останутся у вас.</div>'}</div>
      <p class="hint">Карта у всех одна: порядок карт, монеты и бонусы рождаются из общего зерна. Каждый стартует раунд, когда удобно, — таймер идёт с личного старта.</p>
    </div>`}
    <button class="primary" id="ng-go">Создать и пригласить</button>`);
  const goLbl = () => {
    const go = $('#ng-go');
    if (go) go.textContent = (!pair && !coinsPicked().length) ? 'Начать соло-забег' : 'Создать и пригласить';
  };
  const pickBox = $('#ng-pick');
  if (pickBox) pickBox.addEventListener('change', goLbl);
  const back = $('#ng-back');
  if (back) back.addEventListener('click', () => openNewGame());
  // pkg3-85: время раунда — степпером по 10 секунд (по умолчанию 1 минута)
  const secIn = $('#ng-sec'), secView = $('#ng-sec-view');
  const secSync = () => { if (secView && secIn) secView.textContent = fmtCoinsTime(Number(secIn.value) || 60); };
  const secStep = d => { if (!secIn) return; secIn.value = String(Math.min(1800, Math.max(10, (Number(secIn.value) || 60) + d))); secSync(); };
  const secMinus = $('#ng-sec-minus'), secPlus = $('#ng-sec-plus');
  if (secMinus) secMinus.addEventListener('click', () => secStep(-10));
  if (secPlus) secPlus.addEventListener('click', () => secStep(10));
  secSync();
  goLbl();
  $('#ng-go').addEventListener('click', async () => {
    if (rules === 'coins') { await createCoinsGame(); return; }
    const opp = $('#ng-opp').value, color = $('#ng-color').value;
    try {
      const raw = crypto.getRandomValues(new Uint8Array(32));
      const keys = {};
      for (const id of [S.me.id, opp]) {
        const pk = await pairKeyWith(id);
        if (!pk) throw new Error('У участника нет ключа шифрования — попросите его войти в чат');
        keys[id] = { blob: await aesEncryptBytes(pk, raw) };
      }
      const r = await api('/api/games', { method: 'POST', body: { opponent: opp, color, keys, rules } });
      const gid = r.chat.id;
      S.chatKeys.set(gid, { key: await importAes(raw), raw });
      hide($('#modal'));
      const dm = (await api('/api/dm', { method: 'POST', body: { peer: opp } })).chat;
      const dk = await chatKeyOf(dm);
      const inv = {
        k: 'game-invite', game: gid, to: opp, colorChoice: color, rules,
        note: 'Соперник: ' + S.me.name + (color === 'choice'
          ? (sb ? ' · кто стреляет первым, решите вы' : ' · цвет выберете вы')
          : '')
      };
      const rr = await api('/api/messages', { method: 'POST', body: { chat: dm.id, blob: await encryptJSON(dk.key, inv) } });
      S.plain.set(rr.message.id, inv);
      addMessages([rr.message]);
      cacheMsg(rr.message);
      await sync(false); renderAll();
      toast('Игра создана, приглашение отправлено');
    } catch (ex) { toast(ex.message, true); }
  });
}
/** pkg3-78: отмеченные гости для «Сталкера». */
/** pkg3-78: отмеченные гости для «Золотой лихорадки». */
function coinsPicked() {
  return $$('#ng-pick input[type=checkbox]').filter(x => x.checked).map(x => x.value);
}
/** pkg3-78: создание забега «Золотой лихорадки» — соло или компанией до четырёх человек. */
async function createCoinsGame() {
  const picks = coinsPicked();
  if (picks.length > 3) { toast('Позвать можно максимум троих — всего четыре игрока', true); return; }
  const sec = Math.min(1800, Math.max(10, Math.round((Number($('#ng-sec').value) || 60) / 10) * 10));
  const rounds = Math.min(6, Math.max(1, Math.round(Number($('#ng-rounds').value) || 3)));
  try {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const keys = {};
    for (const id of [S.me.id, ...picks]) {
      const pk = await pairKeyWith(id);
      if (!pk) throw new Error('У одного из игроков нет ключа шифрования — попросите его войти в чат');
      keys[id] = { blob: await aesEncryptBytes(pk, raw) };
    }
    const seed = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
    const r = await api('/api/games', { method: 'POST', body: { rules: 'coins', players: picks, minutes: sec / 60, sec, rounds, seed, keys } });
    const gid = r.chat.id;
    S.chatKeys.set(gid, { key: await importAes(raw), raw });
    hide($('#modal'));
    for (const opp of picks) {
      const dm = (await api('/api/dm', { method: 'POST', body: { peer: opp } })).chat;
      const dk = await chatKeyOf(dm);
      const inv = {
        k: 'game-invite', game: gid, to: opp, rules: 'coins',
        note: 'Сталкер: ' + rounds + ' раунд(а) по ' + fmtCoinsTime(sec) + ' · до четверых · старт, когда удобно'
      };
      const rr = await api('/api/messages', { method: 'POST', body: { chat: dm.id, blob: await encryptJSON(dk.key, inv) } });
      S.plain.set(rr.message.id, inv);
      addMessages([rr.message]);
      cacheMsg(rr.message);
    }
    await sync(false); renderAll();
    toast(picks.length ? 'Забег создан — приглашения отправлены' : 'Соло-забег создан — удачи!');
    await openChat(gid);
    renderBoard();
  } catch (ex) { toast(ex.message, true); }
}

function renderRail() {
  const flt = S.railFilter.toLowerCase();
  const chats = S.chats
    .filter(c => !peerIsHiddenAlias(c))   // pkg3-62: слитая учётка не двоится в списке
    .filter(c => !flt || chatTitle(c).toLowerCase().includes(flt))
    .sort((a, b) => {
      const la = lastMessageIn(a.id), lb = lastMessageIn(b.id);
      return (lb ? lb.ts : b.createdAt) - (la ? la.ts : a.createdAt);
    });

  let html = '';
  // своя идущая партия — выше завершённых и приглашений внутри раздела
  const games = chats.filter(c => c.kind === 'game').sort((a, b) =>
    (((b.game || {}).status === 'playing') ? 1 : 0) - (((a.game || {}).status === 'playing') ? 1 : 0));
  // pkg3-54: в «Новых» теперь и групповые чаты, куда меня добавили (маркер newUntil);
  // старые группы без маркера видны как раньше — правило их не трогает
  const isNewChat = (c) => !!c.newUntil && !S.dmSaved.has(c.id);
  const groups = chats.filter(c => c.kind === 'group' && !isNewChat(c));
  // pkg3-38: в «Личных чатах» кто сейчас в сети — поднимаются наверх;
  // остальные остаются в прежнем порядке (по свежести сообщений).
  // Сортировка устойчивая: внутри групп порядок не ломается.
  // pkg3-49: личные чаты делятся на сохранённые («Личные чаты») и чужие-новые
  // («Новые» — живут сутки, потом удаляются сами, если их не сохранить).
  const allDms = chats.filter(c => c.kind === 'dm').sort((a, b) =>
    (isOnline(userById(dmPeer(b))) ? 1 : 0) - (isOnline(userById(dmPeer(a))) ? 1 : 0));
  const newDms = allDms.filter(isNewChat);
  const dms = allDms.filter(c => !isNewChat(c));
  const newChatsList = chats.filter(isNewChat);   // pkg3-54: личные + группы в порядке свежести
  const chatRow = (c) => {
    const un = unreadIn(c.id);
    const last = lastMessageIn(c.id);
    const peer = c.kind === 'dm' ? userById(dmPeer(c)) : null;
    const sub = c.kind === 'game' ? gameRailSub(c)
      : last ? preview(last)
      : (c.kind === 'dm' ? (isOnline(peer) ? 'в сети' : fmtAgo(peer && peer.lastSeen))
        : plural(c.members.length, 'участник', 'участника', 'участников'));
    // pkg3-38: напротив личного чата — когда человек последний раз заходил
    // (тот же формат, что вверху личной переписки: «в сети» / «был(а) …»)
    const mst = c.kind === 'dm' && peer ? musicStatusOf(peer.id) : null;   // pkg3-87
    const seen = c.kind === 'dm' && peer
      ? (mst
        ? '<div class="ci-seen on" title="Сейчас слушает музыку">🎵 слушает</div>'
        : `<div class="ci-seen ${isOnline(peer) ? 'on' : ''}" title="Последний визит">${isOnline(peer) ? 'в сети' : 'был(а) ' + escapeHtml(fmtAgo(peer.lastSeen))}</div>`)
      : '';
    return `<div class="chat-item ${S.view === c.id ? 'active' : ''} ${un.total ? 'unread' : ''}" data-chat="${c.id}">
      ${chatAvatarHtml(c)}
      <div class="ci-main">
        <div class="ci-name">${escapeHtml(chatTitle(c))}${isChatMuted(c.id) ? '<span class="mute-mark" title="Без звука">🔇</span>' : ''}${isNewChat(c) && c.newUntil ? `<span class="tag-new" data-newcd="${c.id}" title="Чат из раздела «Новые»: удалится сам, если не сохранить">новые · ${escapeHtml(fmtLeft(c.newUntil))}</span>` : ''}${c.kind === 'group' ? `<span class="tag-grp">${c.members.length}</span>` : ''}</div>
        <div class="ci-last">${escapeHtml(cut(sub, 42))}</div>
      </div>
      ${seen}
      ${un.mentions ? `<span class="badge at" title="обращения к вам">@${un.mentions}</span>` : ''}
      ${un.total ? `<span class="badge">${un.total}</span>` : ''}
    </div>`;
  };
  // pkg3-53: все разделы чатов сворачиваются; на свёрнутом разделе — красная
  // точка с числом непрочитанных. При поиске разделы раскрыты, иначе результат
  // не увидеть. Состояние «свёрнут/развёрнут» помнит это устройство.
  const openSec = (key) => !!flt || !S.collapsed[key];
  const unreadSum = (list) => list.reduce((a, c) => a + (((unreadIn(c.id) || {}).total) || 0), 0);
  const foldBadge = (n) => n ? `<span class="fold-badge" title="Непрочитанные в свёрнутом разделе">${n > 99 ? '99+' : n}</span>` : '';
  const foldHead = (key, title, list, extra, cls) => {
    const open = openSec(key);
    return `<div class="rail-group fold ${cls || ''} ${open ? '' : 'folded'}" data-fold="${key}" title="Нажмите, чтобы свернуть или развернуть">`
      + `<span class="fold-ic" aria-hidden="true"></span><span class="fold-t">${escapeHtml(title)}</span>`
      + (open ? '' : foldBadge(unreadSum(list))) + (extra || '') + `</div>`;
  };
  const sec = (key, title, list, extra, cls) => list.length
    ? foldHead(key, title, list, extra, cls) + (openSec(key) ? list.map(chatRow).join('') : '')
    : '';
  if (games.length) html += sec('game', 'Игровые чаты', games);
  // pkg3-36: начавшиеся партии — всегда в самом верху списка. У игроков это
  // их чат-игра (раздел «Игры» — первым), у остальных мессенджера — плашка
  // «Сейчас играют» с плавным миганием, чтобы её замечали краем глаза.
  // pkg3-49: чужие партии видны только из своего круга, зато заявки зрителей
  // в МОИ партии (myKnocks) показываются мне всегда — иначе не пустить зрителя.
  const live = (S.games || []).concat((S.myKnocks || []).filter(g => !(S.games || []).some(x => x.id === g.id)));
  const open = live.filter(g => !S.chats.some(c => c.id === g.id));
  if (open.length) {
    // pkg3-54: «Сейчас играют» сворачивается, как остальные разделы
    const liveRows = open.map(g => `<div class="chat-item game-live">
        <div class="ci-main">
          <div class="ci-name">${g.rules === 'checkers' ? '●' : g.rules === 'seabattle' ? '⚓' : g.rules === 'coins' ? '🪙' : '♟'} ${escapeHtml(openGameTitle(g))}</div>
          <div class="ci-last">${g.rules === 'coins' ? 'идёт «Сталкер»' : 'идёт партия' + (g.rules === 'checkers' ? ' в шашки' : g.rules === 'seabattle' ? ' · морской бой' : '') + ' · ' + plural(g.moves || 0, 'ход', 'хода', 'ходов')}${g.knocks ? ' · заявок: ' + g.knocks : ''}</div>
        </div>
        <button class="mini" data-knock-btn="${escapeHtml(g.id)}">постучаться</button>
      </div>`).join('');
    html += foldHead('live', 'Сейчас играют', []) + (openSec('live') ? liveRows : '');
  }
  // pkg3-60: разделы «Запросы в «Приглашенные»» и «Приглашенные» убраны по
  // решению владельца: приглашённый и так появляется у пригласившего в
  // «Личных чатах», а знакомиться удобнее через поиск и «Новые». Серверные
  // связи (bonds) продолжают жить — круг видимости использует их, как прежде.
  if (groups.length) html += sec('group', 'Групповые чаты', groups);
  // pkg3-49: раздел «Новые» — личная переписка, которую начали со мной из поиска.
  // Чат живёт здесь сутки (счётчик в плашке), потом удалится сам; кнопка
  // «Добавить пользователя в мои личные чаты» (плашка внутри чата или меню «⋯») сохраняет навсегда.
  if (newChatsList.length) html += sec('new', 'Новые', newChatsList);
  if (dms.length) html += sec('dm', 'Личные чаты', dms);

  // pkg3-53: свои разделы-папки — ниже системных. Пустой раздел тоже виден:
  // иначе его не найти, чтобы переименовать, удалить или положить в него чат.
  for (const sn of (S.sections || [])) {
    const key = 'sec:' + sn.id;
    const list = chats.filter(c => (sn.chats || []).includes(c.id));
    const dots = `<button class="sec-dots" data-sec-menu="${sn.id}" title="Раздел: переименовать или удалить">\u22ee</button>`;
    html += foldHead(key, sn.name, list, dots, 'custom fold-mark-folder');
    if (openSec(key)) {
      html += list.length ? list.map(chatRow).join('')
        : `<div class="rail-note">В разделе пусто. Откройте нужный чат, нажмите «⋯» и выберите «Переместить в раздел».</div>`;
    }
  }

  // pkg3-48/49: раздела «Написать лично» со всеми участниками больше нет —
  // мессенджер не показывает весь список людей каждому. Новый собеседник
  // находится поиском по нику (лупа вверху): у АВТОРА письма чат остаётся
  // в «Личных чатах», а у адресата попадает в раздел «Новые» на сутки —
  // сохранить его навсегда можно кнопкой «Добавить пользователя в мои личные чаты».
  // pkg3-52: ниже своих чатов — участники, которых строка поиска нашла на сервере
  // (включая незнакомых: синхронизация отдаёт каждому только его круг, поэтому
  // людей ищем именно сервером). Те, с кем уже есть личная переписка, не дублируются.
  const qNow = flt.trim();
  const meId = (S.me || {}).id;
  const hasDmWith = (u) => S.chats.some(c => c.kind === 'dm' && c.members.includes(u.id) && meId && c.members.includes(meId));
  if (qNow && S.railPeopleQ === qNow) {
    const ppl = S.railPeople.filter(u => !hasDmWith(u));
    html += `<div class="rail-group people">Участники — найдено ${S.railPeople.length}</div>`;
    html += ppl.length ? ppl.map(u => `<div class="chat-item person" data-peer="${u.id}" title="Написать лично">
          <div class="ci-main">
            <div class="ci-name">${escapeHtml(displayName(u))}${u.isAdmin ? '<span class="tag-admin">адм</span>' : ''}</div>
            <div class="ci-last">${isOnline(u) ? 'в сети' : 'был(а) ' + escapeHtml(fmtAgo(u.lastSeen))} · нажмите, чтобы написать</div>
          </div>
        </div>`).join('')
      : `<div class="rail-note">${S.railPeople.length ? 'Все найденные уже есть в ваших чатах' : 'Никого не нашёл по такому нику'}</div>`;
  } else if (qNow && S.railFindPending === qNow) {
    html += `<div class="rail-group people">Участники</div><div class="rail-note">Ищу…</div>`;
  }
  if (qNow && S.railPeopleErr) html += `<div class="rail-note">${escapeHtml(S.railPeopleErr)}</div>`;

  if (!html) html = `<div class="ci-last" style="padding:14px 10px">Здесь пока пусто. Пригласите друзей ссылкой
    (кнопка «+» вверху списка) или найдите человека этой строкой поиска — она ищет
    по всем участникам мессенджера, а не только по вашим чатам.</div>`;
  $('#chat-list').innerHTML = html;
}

/** pkg3-77: строка для заголовка группы/игры — кто прямо сейчас пишет или
 * загружает, с именами: «Сергей пишет…», «Сергей и Аня загружают…». */
// pkg3-87: звуковой статус участника (свежий — не старше минуты) и строка для шапки
function mergeMusicStatus(list) {
  if (!Array.isArray(list)) return;
  const now = Date.now();
  S.musicStatus = S.musicStatus || {};
  for (const x of list) if (x && x.uid) S.musicStatus[x.uid] = { note: String(x.note || ''), at: now };
}
function musicStatusOf(uid) {
  const s = (S.musicStatus || {})[uid];
  if (!s || Date.now() - s.at > 60000) return null;
  return s;
}
function musicLine(c) {
  const ids = (c.members || []).filter(id => id !== (S.me || {}).id && musicStatusOf(id));
  if (!ids.length) return '';
  return ids.map(id => {
    const st = musicStatusOf(id);
    const nm = escapeHtml((userById(id) || {}).name || 'Кто-то');
    return '🎵 ' + nm + (st.note ? ' слушает: ' + escapeHtml(st.note) : ' слушает музыку');
  }).join(' · ');
}

function typingLine(c) {
  const ts = typingIn(c.id);
  if (!ts.length) return '';
  const nameOf = uid => escapeHtml((userById(uid) || {}).name || 'Кто-то');
  const part = (list, one, many) => {
    const names = list.map(t => nameOf(t.uid));
    const joined = names.length === 1 ? names[0]
      : names.length === 2 ? names[0] + ' и ' + names[1]
      : names.slice(0, -1).join(', ') + ' и ' + names[names.length - 1];
    return joined + ' ' + (names.length === 1 ? one : many);
  };
  const typ = ts.filter(t => t.kind !== 'upload');
  const upl = ts.filter(t => t.kind === 'upload');
  const bits = [];
  if (typ.length) bits.push(part(typ, 'пишет…', 'пишут…'));
  if (upl.length) bits.push(part(upl, 'загружает…', 'загружают…'));
  return bits.join(' · ');
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
    $('#input').placeholder = 'Пишите';
    return;
  }
  $('#chat-avatar').innerHTML = chatAvatarHtml(c);
  $('#chat-title').textContent = chatTitle(c);
  if (c.kind === 'dm') {
    const u = userById(dmPeer(c));
    // pkg3-77: «пишет…» / «загружает…» важнее дежурного «смотрит чат» —
    // как только сигнал погас, строка сама возвращается к прежнему виду
    const t = typingIn(c.id)[0];
    const ms = musicStatusOf(u && u.id);   // pkg3-87: слышно, что собеседник слушает
    const act = t ? (t.kind === 'upload' ? 'загружает…' : 'пишет…')
      : ms ? ('🎵 слушает' + (ms.note ? ': ' + escapeHtml(ms.note) : ' музыку')) : '';
    $('#chat-sub').innerHTML = act
      ? '<span style="color:#5c9c1e">' + act + '</span> · личная переписка'
      : isOnline(u)
        ? '<span style="color:#5c9c1e">в сети, смотрит чат</span> · личная переписка'
        : 'был(а) ' + escapeHtml(fmtAgo(u && u.lastSeen)) + ' · личная переписка';
    $('#input').placeholder = 'Пишите';
  } else {
    const online = c.members.map(userById).filter(isOnline).length;
    // pkg3-77: имена тех, кто пишет/загружает; pkg3-87: и кто слушает музыку
    const act = [typingLine(c), musicLine(c)].filter(Boolean).join(' · ');
    $('#chat-sub').innerHTML = `${plural(c.members.length, 'участник', 'участника', 'участников')} · <span style="color:#5c9c1e">${act || online + ' в сети'}</span>`;
    $('#input').placeholder = 'Пишите';
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
  const rs = readersOf(m);
  if (m.uid !== S.me.id) {
    // pkg3-61: на чужих сообщениях тоже видно, кто их уже прочитал (просьба
    // владельца). «Галочки доставки» при этом остаются принадлежностью автора —
    // у чужих сообщений рисуем только полоску прочитавших.
    if (!rs.length) return '';
    const shown = rs.slice(0, 5).map(u => avatarHtml(u, 'xs', true)).join('');
    const names = rs.map(u => u.name).join(', ');
    return `<span class="readers" title="Прочитали: ${escapeHtml(names)}">${shown}${rs.length > 5 ? `<span class="tiny muted">+${rs.length - 5}</span>` : ''}</span>`;
  }
  // своё сообщение показываем сразу, ещё до ответа сервера: часы — «летит»,
  // галочка — «сервер принял», две — «прочитали»
  if (m.local) return `<span class="check pending" title="Отправляется…">⏱</span>`;
  if (m.failed) return `<span class="check failed" title="Не отправлено: ${escapeHtml(m.failed)}">⚠</span><button class="retry-send" data-retry="${m.id}" title="Отправить ещё раз">повторить</button>`;
  if (!rs.length) return `<span class="check" title="Отправлено">✓</span>`;
  const shown = rs.slice(0, 5).map(u => avatarHtml(u, 'xs', true)).join('');
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
  // pkg3-61: в подсказке — имена, а кнопка «👥» открывает список «кто что поставил»
  return `<div class="rx-row">${keys.map(k => {
    const names = (rx[k] || []).map(id => (userById(id) || { name: 'Бывший участник' }).name).join(', ');
    return `<button class="rx ${(rx[k] || []).includes(S.me.id) ? 'mine' : ''}" data-rx="${escapeHtml(k)}" data-mid="${m.id}" title="${escapeHtml(names)}">${twEmo(escapeHtml(k))}<span>${(rx[k] || []).length}</span></button>`;
  }).join('')}<button class="rx rx-who" data-rxlist="${m.id}" title="Кто поставил реакции">👥</button></div>`;
}
/** pkg3-61: кто поставил реакции — по смайликам, именами. */
function openRxList(mid) {
  const m = S.messages.find(x => x.id === mid);
  const rx = (m && m.reactions) || {};
  const keys = Object.keys(rx).filter(k => (rx[k] || []).length);
  modal('Кто поставил реакции', keys.length
    ? keys.map(k => `<div class="mrow"><span style="font-size:22px;line-height:1">${twEmo(escapeHtml(k))}</span>
        <span class="nm">${rx[k].map(id => escapeHtml((userById(id) || { name: 'Бывший участник' }).name)).join(', ')}</span></div>`).join('')
    : '<div class="tiny muted">Реакций пока нет</div>');
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
  // pkg3-54: «N добавил этот чат в свои разделы» — открытое событие участников,
  // рисуется системной строкой: без пузыря, аватара и кнопок переписки
  if (m.svc) {
    const p = S.plain.get(m.id) || {};
    return `<div class="sys svc" id="m-${m.id}">${escapeHtml(fmtTime(m.ts))} · ${escapeHtml(p.text || 'событие чата')}</div>`;
  }
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
        ${p.text ? `<div class="btext">${twEmo(mentionize(p.text))}</div>` : ''}${gamePayloadHtml(p, chatById(m.chat))}
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

/** Доска — только из полностью расшифрованной истории: если хоть один ход ещё
 * «…» или однажды не расшифровался, сперва дошифровываем, потом рисуем.
 * Иначе фигуры встанут не туда, пока следующий ход или перезагрузка не починят. */
function boardSoon() {
  const c = curChat();
  if (!c || c.kind !== 'game') { renderBoard(); return; }
  const hst = chatHistState(c.id);
  if (hst === 'nokey') { renderBoard(); return; }
  if (hst === 'load') {
    // pkg3-37: история ещё не вся — рисуем анимацию загрузки и дошифровываем
    // ходы в фоне; «исходную расстановку» вместо правды не показываем никогда
    renderBoard();
    const wait = S.messages.filter(m => m.chat === c.id && !m.parent && !S.plain.has(m.id)).map(m => m.id);
    if (wait.length) ensureIds(wait).then(() => { if (S.view === c.id) renderBoard(); }).catch(() => {});
    return;
  }
  const ids = S.messages.filter(m => m.chat === c.id && !m.parent && plainBroken(m.id)).map(m => m.id);
  if (!ids.length) { renderBoard(); return; }
  ensureIds(ids).then(() => renderBoard()).catch(() => renderBoard());
}
function renderMessages(force) {
  setTimeout(boardSoon, 0);
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
  // pkg3-36: ходы в ленту игры не попадают — они живут на доске и в списке
  // ходов под ней (feedVisible — единое правило для ленты и счётчиков)
  const full = S.messages.filter(m => m.chat === S.view && !m.parent && feedVisible(m));
  // лента подгружается окнами: сначала последние WIN_SIZE сообщений,
  // старше — кнопкой «Показать более ранние», чтобы не рисовать тысячи узлов
  const win = S.winSize || WIN_SIZE;
  const off = Math.max(0, full.length - win);
  const list = full.slice(off);
  const moreBtn = off > 0 ? `<button class="load-more" id="load-more">Показать более ранние (${off})</button>` : '';
  const listSig = list.map(m => m.id).join(',');
  const sameList = !force && renderedOnce && listSig === (S.lastListSig || '');
  const prevTop = box.scrollTop, prevHeight = box.scrollHeight;
  const nearBottom = prevHeight - prevTop - box.clientHeight < 160;
  const c = curChat();
  const banner = archiveBannerHtml(c) + keyBannerHtml(c);
  if (!full.length) {
    // pkg3-37: пока история чата ещё едет с устройства или с сервера —
    // никакого «пустого чата»: показываем анимацию загрузки
    const hst = chatHistState(S.view);
    if (hst === 'load') {
      box.innerHTML = banner + histLoadHtml('Загружаем переписку…');
      return;
    }
    const emptyHint = `<div class="sys">${c && c.kind === 'game'
      ? 'Ходы партии — на доске и в списке ходов. Здесь — только обсуждение: напишите первое сообщение 👋'
      : c && c.kind === 'dm'
      ? 'Личная переписка. Никто, кроме вас двоих, её не увидит.'
      : 'Сообщений пока нет. Напишите первое 👋'}</div>`;
    box.innerHTML = banner ? (banner + emptyHint) : emptyHint;
    return;
  }
  let html = banner + moreBtn, lastDay = '';
  const firstPaint = !renderedOnce;
  renderedOnce = true;
  const markHtml = S.openMark && S.openMark.chat === S.view
    ? `<div class="unread-line" id="unread-mark">${S.openMark.count ? 'Непрочитанные — ' + S.openMark.count : 'Новые реакции или комментарии'}</div>`
    : '';
  if (sameList) {
    // лента та же — обновляем точечно только изменившиеся строки: без моргания
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      const el = document.getElementById('m-' + m.id);
      if (!el) continue;
      const rs = rowSig(m);
      if (el.dataset.rs !== rs) {
        const tmp = document.createElement('div');
        tmp.innerHTML = messageHtml(m, { continued: canGroup(list[i - 1], m), continues: canGroup(m, list[i + 1]), fresh: false }).trim();
        el.replaceWith(tmp.firstChild);
      }
    }
    S.lastListSig = listSig;
  } else {
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      const day = new Date(m.ts).toDateString();
      if (day !== lastDay) { html += `<div class="day"><span>${fmtDay(m.ts)}</span></div>`; lastDay = day; }
      if (S.openMark && S.openMark.chat === S.view && S.openMark.msgId === m.id) html += markHtml;
      const fresh = !firstPaint && !renderedIds.has(m.id);
      html += messageHtml(m, { continued: canGroup(list[i - 1], m), continues: canGroup(m, list[i + 1]), fresh });
    }
    box.innerHTML = html;
    renderedIds = new Set(list.map(m => m.id));
    for (const m of list) { const el = document.getElementById('m-' + m.id); if (el) el.dataset.rs = rowSig(m); }
    S.lastListSig = listSig;
    paintIcons(box);
  }
  // самовосстановление: если в видимом окне остались «…», дошифровываем их сами.
  // ВАЖНО: если ключа на устройстве нет (S.keyIssue), сообщения так и останутся закрытыми,
  // и цикл «перерисовали → не расшифровали → перерисовали» крутился бы вечно, вешая страницу.
  // Поэтому при отсутствии ключа и после неудачной попытки берём паузу: следующую попытку
  // сделает опрос сервера (раз в 2,5 с) — как только ключ доедет, лента расшифруется сама.
  const pending = list.slice(off).filter(m => plainBroken(m.id)).map(m => m.id);
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
  if (sameList) { if (S.atBottom || nearBottom) box.scrollTop = box.scrollHeight; }
  else if (S.focusPending && !S.userScrolled) { /* позицию ставит applyFocus — без двойного прыжка */ }
  else if (force || nearBottom || S.atBottom) box.scrollTop = box.scrollHeight;
  else box.scrollTop = prevTop + (box.scrollHeight - prevHeight);
  // фокус держим на цели, пока пользователь сам не прокрутит ленту
  if (S.focusPending && !S.userScrolled) applyFocus();
}

function rowSig(m) {
  const p = S.plain.get(m.id);
  return [p ? 1 : 0, (p && p.rev) || 0, m.rev || 0, m.reactTs || 0,
    Object.keys(m.reactions || {}).length, S.highlight === m.id ? 1 : 0].join(':');
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
      ${p.text ? `<div class="txt">${mentionize(p.text)}</div>` : ''}${gamePayloadHtml(p, chatById(parent.chat))}
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
  $('#mem-warn').classList.toggle('hidden', pct < 80);
  // подробности — в окне «Управление мессенджером», раздел «Память»:
  // если оно открыто, строки обновляются на каждом опросе сервера
  const mm = $('#ad-mem-main');
  if (mm) {
    const c = curChat();
    mm.textContent = `Занято ${fmtBytes(u.bytes)} из ${fmtBytes(u.limit)} · ${u.messages} сообщ.`
      + (u.archives ? ` · ${plural(u.archives, 'архив', 'архива', 'архивов')}` : '')
      + (c ? ` · этот чат ${fmtBytes(c.bytes)}` : '');
  }
  const parts = $('#ad-mem-parts');
  if (parts) {
    const txt = usagePartsText(u);
    parts.textContent = txt || '—';
  }
}

// ─────────────────────────────────────────────────────────── pkg3-74:
// ПУЛЬТ ПАМЯТИ СЕРВЕРА: открывается нажатием на шкалу «Память сервера».
// Бублик с процентом занятого в центре и сектором свободного места;
// тумблер «мои чаты / все чаты»; кнопка «Актуализировать» с прогрессом;
// списки своих загрузок с просмотром и удалением; админу — операции в
// «всех чатах» без просмотра содержимого и управление пределом хранилища.
const ST_COLORS = { messages: '#6f9bff', photos: '#ff7ab2', media: '#b28cff', files: '#ffb86b', free: '#39415a' };
const ST_LABEL = { messages: 'Сообщения', photos: 'Фотографии', media: 'Медиа', files: 'Файлы', free: 'Свободное место' };
let stScope = 'me';
const stMB = b => (b / 1048576).toFixed(1) + ' МБ';
function stDonutHtml(cats, free, percent) {
  const total = cats.messages.bytes + cats.photos.bytes + cats.media.bytes + cats.files.bytes + free;
  const R = 54, C = 2 * Math.PI * R;
  let off = 0, arcs = '';
  for (const k of ['messages', 'photos', 'media', 'files', 'free']) {
    const v = k === 'free' ? free : cats[k].bytes;
    if (!total || v <= 0) continue;
    const len = v / total * C;
    arcs += `<circle r="${R}" cx="70" cy="70" fill="none" stroke="${ST_COLORS[k]}" stroke-width="26"
      stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}"
      data-st="${k}" style="cursor:${k === 'free' ? 'default' : 'pointer'}"></circle>`;
    off += len;
  }
  return `<svg viewBox="0 0 140 140" width="168" height="168" style="display:block;margin:0 auto">
    <g transform="rotate(-90 70 70)">${arcs}</g>
    <text x="70" y="66" text-anchor="middle" style="font-size:20px;font-weight:700;fill:currentColor">${percent}%</text>
    <text x="70" y="84" text-anchor="middle" style="font-size:9px;fill:currentColor;opacity:.7">занято</text>
  </svg>`;
}
function stLegendHtml(d) {
  const rows = ['messages', 'photos', 'media', 'files', 'free'].map(k => {
    const v = k === 'free' ? d.free : d.cats[k].bytes;
    const cnt = k === 'free' ? '' : (' · ' + d.cats[k].count + ' шт.');
    return `<div class="st-row" data-stk="${k}" style="display:flex;align-items:center;gap:8px;padding:4px 2px;${k === 'free' ? '' : 'cursor:pointer'}">
      <span style="width:12px;height:12px;border-radius:3px;background:${ST_COLORS[k]};flex:none"></span>
      <span style="flex:1">${ST_LABEL[k]}</span>
      <span class="tiny muted">${stMB(v)}${cnt}</span></div>`;
  }).join('');
  return rows;
}
async function openStoragePanel(scope) {
  stScope = scope || stScope || 'me';
  modal('Память сервера', '<div id="st-body"><div class="tiny muted">Запрашиваю сводку…</div></div>');
  await stRender(false);
}
async function stRender(fresh) {
  const body = $('#st-body');
  if (!body) return;
  body.innerHTML = '<div class="st-prog" style="height:6px;background:#ffffff22;border-radius:3px;overflow:hidden;margin:6px 0">'
    + '<div id="st-prog-fill" style="height:100%;width:8%;background:#6f9bff;transition:width .2s"></div></div>'
    + '<div id="st-prog-txt" class="tiny muted">опрашиваю сервер… 8%</div><div id="st-main"></div>';
  const setP = (p, t) => {
    const f = $('#st-prog-fill'); if (f) f.style.width = p + '%';
    const x = $('#st-prog-txt'); if (x) x.textContent = t + ' ' + p + '%';
  };
  setP(8, 'опрашиваю сервер…');
  let d = null;
  try { d = await api('/api/storage/summary?scope=' + stScope + (fresh ? '&fresh=1' : '')); }
  catch (e) { setP(100, 'ошибка:'); $('#st-main').innerHTML = '<div class="tiny">' + escapeHtml(e.message) + '</div>'; return; }
  setP(62, 'размечаю сектора…');
  await new Promise(r => setTimeout(r, 30));
  const togg = `<div style="display:flex;gap:6px;justify-content:center;margin:8px 0">
    <button class="mini ${stScope === 'me' ? 'primary' : ''}" id="st-me">Мои чаты</button>
    <button class="mini ${stScope === 'all' ? 'primary' : ''}" id="st-all">Все чаты</button>
    <button class="mini" id="st-fresh" title="Пересчитать без кэша">Актуализировать</button></div>`;
  const lim = d.canOperate ? `<div class="tiny muted" style="text-align:center;margin-top:8px">
    Предел хранилища: ${stMB(d.limit)} · свободно на диске: ${d.diskFree == null ? 'н/д' : stMB(d.diskFree)}<br>
    <input id="st-lim" type="number" min="1" style="width:90px" placeholder="МБ"> <button class="mini" id="st-lim-go">Расширить до МБ</button>
    <div class="tiny muted">Диск расширить нельзя (это тариф хостинга); можно поднять предел мессенджера, пока на диске есть место, и освободить место удалениями.</div></div>` : '';
  $('#st-main').innerHTML = stDonutHtml(d.cats, d.free, d.percent) + togg
    + '<div style="max-width:340px;margin:0 auto">' + stLegendHtml(d) + '</div>'
    + '<div class="tiny muted" style="text-align:center;margin-top:6px">Занято ' + stMB(d.used) + ' из ' + stMB(d.limit)
    + (stScope === 'all' && !d.canOperate ? ' · просмотр сумм без операций' : '') + '</div>' + lim;
  setP(100, 'готово:');
  setTimeout(() => { const p = $('#st-prog-fill'); if (p) p.parentElement.style.display = 'none'; const t = $('#st-prog-txt'); if (t) t.style.display = 'none'; }, 500);
  $('#st-me').addEventListener('click', () => { stScope = 'me'; stRender(false); });
  $('#st-all').addEventListener('click', () => { stScope = 'all'; stRender(false); });
  $('#st-fresh').addEventListener('click', () => stRender(true));
  $('#st-main').querySelectorAll('[data-st],[data-stk]').forEach(el => {
    el.addEventListener('click', () => {
      const k = el.dataset.st || el.dataset.stk;
      if (k === 'free') return;
      if (k === 'messages') openStorageChats(); else openStorageKind(k);
    });
  });
  const lg = $('#st-lim-go');
  if (lg) lg.addEventListener('click', async () => {
    const mb = Number($('#st-lim').value);
    if (!mb || mb < 1) return toast('Введите предел в МБ', true);
    try {
      const r = await api('/api/admin/storage/limit', { method: 'POST', body: { bytes: Math.floor(mb * 1048576) } });
      toast('Предел хранилища: ' + stMB(r.limit));
      stRender(true);
    } catch (e) { toast(e.message, true); }
  });
}
async function openStorageKind(kind) {
  modal(ST_LABEL[kind] + ' на сервере', '<div id="stk-body"><div class="tiny muted">Загружаю список…</div></div>');
  let cursor = 0;
  const load = async () => {
    const r = await api('/api/storage/items?scope=' + stScope + '&kind=' + kind + '&cursor=' + cursor);
    const box = $('#stk-body');
    if (!box) return;
    if (!cursor) box.innerHTML = '';
    const byChat = {};
    for (const it of r.items) (byChat[it.chat] = byChat[it.chat] || []).push(it);
    for (const chatId of Object.keys(byChat)) {
      const c = chatById(chatId);
      const head = stScope === 'all' ? (byChat[chatId][0].chatLabel || 'чат') : (c ? chatTitle(c) : 'чат');
      const h = document.createElement('div');
      h.className = 'divider'; h.innerHTML = '<span>' + escapeHtml(head) + '</span>';
      box.appendChild(h);
      for (const it of byChat[chatId]) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:5px 2px';
        row.innerHTML = '<span style="flex:1">' + escapeHtml(it.name)
          + (it.mine && stScope === 'all' ? ' <b class="tiny">(моё)</b>' : '')
          + '<div class="tiny muted">' + new Date(it.ts).toLocaleDateString() + '</div></span>'
          + '<span class="tiny muted">' + stMB(it.bytes) + '</span>'
          + (it.mine ? '<button class="mini" data-stopen="' + it.upId + '" data-stchat="' + it.chat + '">открыть</button>' : '')
          + ((it.mine || (S.me && S.me.isAdmin)) ? '<button class="mini danger" data-stdel="' + it.upId + '">удалить</button>' : '');
        box.appendChild(row);
      }
    }
    if (!r.items.length && !cursor) box.innerHTML = '<div class="tiny muted">В этой категории пока пусто.</div>';
    if (r.next != null) {
      const more = document.createElement('button');
      more.className = 'mini'; more.textContent = 'Показать ещё';
      more.addEventListener('click', () => { more.remove(); cursor = r.next; load(); });
      box.appendChild(more);
    }
    box.querySelectorAll('[data-stdel]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('Удалить вложение с сервера навсегда? В ленте останется пометка «вложение удалено».')) return;
      try {
        const rr = await api('/api/storage/delete', { method: 'POST', body: { upId: b.dataset.stdel } });
        toast('Удалено, освобождено ' + stMB(rr.freed));
        openStorageKind(kind);
        if ($('#st-body')) stRender(true);
      } catch (e) { toast(e.message, true); }
    }));
    box.querySelectorAll('[data-stopen]').forEach(b => b.addEventListener('click', () => stOpen(b.dataset.stopen, b.dataset.stchat)));
  };
  try { await load(); } catch (e) { const box = $('#stk-body'); if (box) box.innerHTML = '<div class="tiny">' + escapeHtml(e.message) + '</div>'; }
}
async function stOpen(upId, chatId) {
  // качаем и расшифровываем ключом чата вложения: владелец вложения и так
  // владеет этим ключом — содержимое не покидает модель сквозного шифрования
  const chat = chatById(chatId);
  const k = chat ? await chatKeyOf(chat) : null;
  if (!k) return toast('Ключ этого чата не найден на устройстве', true);
  try {
    const it = await api('/api/upload/' + encodeURIComponent(upId) + '/0');
    const parts = Math.max(1, Number(it.parts) || 1);
    let enc = it.data;
    for (let i = 1; i < parts; i++) enc += (await api('/api/upload/' + encodeURIComponent(upId) + '/' + i)).data;
    const bytes = await aesDecryptBytes(k.key, enc);
    const rec = { blob: new Blob([bytes], { type: it.mime || 'application/octet-stream' }), name: it.name || 'file', size: it.size || 0, mime: it.mime || '', ts: Date.now() };
    modal(it.name || 'Вложение', '<div id="st-view">' + mediaPlayerHtml(rec, upId) + '</div>');
  } catch (e) { toast(e.message, true); }
}
async function openStorageChats() {
  modal('Сообщения по чатам', '<div id="stc-body"><div class="tiny muted">Загружаю…</div></div>');
  try {
    const r = await api('/api/storage/chats?scope=' + stScope);
    const box = $('#stc-body');
    if (!box) return;
    box.innerHTML = '';
    for (const row of r.rows) {
      const c = chatById(row.chat);
      const name = stScope === 'all' ? (row.type === 'dm' ? 'Личный чат №' + row.n : 'Групповой чат №' + row.n) : (c ? chatTitle(c) : 'чат');
      const div = document.createElement('div');
      div.style.cssText = 'display:flex;align-items:center;gap:8px;padding:5px 2px';
      div.innerHTML = '<span style="flex:1">' + escapeHtml(name)
        + '<div class="tiny muted">' + row.msgCount + ' сообщ. · ' + stMB(row.msgBytes) + (row.upBytes ? ' + вложения ' + stMB(row.upBytes) : '') + '</div></span>'
        + (row.canClear ? '<button class="mini danger" data-stclear="' + row.chat + '" data-sttype="' + row.type + '" data-stname="' + escapeHtml(name) + '">очистить</button>' : '');
      box.appendChild(div);
    }
    if (!r.rows.length) box.innerHTML = '<div class="tiny muted">Пусто.</div>';
    box.querySelectorAll('[data-stclear]').forEach(b => b.addEventListener('click', async () => {
      const id = b.dataset.stclear;
      if (!confirm('Очистить чат «' + b.dataset.stname + '» целиком? История сотрётся у ВСЕХ участников, вложения удалятся с сервера. Действие необратимо.')) return;
      try {
        await api('/api/chats/' + encodeURIComponent(id) + '/clear', { method: 'POST', body: {} });
        toast('Чат очищен, место освобождено');
        openStorageChats();
        if ($('#st-body')) stRender(true);
      } catch (e) { toast(e.message, true); }
    }));
  } catch (e) { const box = $('#stc-body'); if (box) box.innerHTML = '<div class="tiny">' + escapeHtml(e.message) + '</div>'; }
}

// pkg3-74: шкала «Память сервера» — сама кнопка пульта (для всех участников)
document.addEventListener('click', e => {
  if (e.target.closest('.memory')) openStoragePanel('me');
});

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
  // pkg3-60: запросов «в мои Приглашенные» в интерфейсе больше нет (раздел убран
  // по решению владельца) — прежний обработчик accept/decline удалён вместе с ним
  // pkg3-53: три точки на разделе — его меню; клик по заголовку — свернуть/развернуть
  const sm = e.target.closest('[data-sec-menu]');
  if (sm) { e.stopPropagation(); openSectionMenu(sm.dataset.secMenu); return; }
  const fold = e.target.closest('[data-fold]');
  if (fold) {
    const k = fold.dataset.fold;
    if (S.collapsed[k]) delete S.collapsed[k]; else S.collapsed[k] = 1;
    saveFolds();
    renderRail();
    return;
  }
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
  if (leavingGet().includes(id)) return;   // pkg3-80: из этой игры уже вышли — не открываем
  if (S.view) { S.drafts[S.view] = $('#input').value; captureChatPos(); }
  stopTypingSignal();   // pkg3-77: ушли из чата — там больше не «пишем»
  S.view = id;
  S.typingHeaderSig = '';
  S.threadId = null; S.quote = null;
  S.atBottom = true; S.sig = '';
  renderedChat = null; renderedOnce = false; renderedIds = new Set();
  S.winSize = WIN_SIZE;
  // pkg3-39: раскладку игры (перенос ленты в колонку рядом с доской или обратно)
  // собираем СРАЗУ, до отрисовки ленты. Раньше её собирал отложенный boardSoon —
  // уже после того, как лента поставлена на запомненное место; перенос #messages
  // сбрасывал прокрутку в ноль, и при возврате в чат лента оказывалась в самом
  // начале переписки. Теперь перенос всегда происходит ДО постановки позиции,
  // а заодно сразу рисуется доска (или спиннер «загружаем ходы») — без пустой колонки.
  boardSoon();
  // pkg3-44: гасим фон прошлого чата СРАЗУ, не дожидаясь отрисовки ленты
  // (в игре она откладывается ради доски) — иначе личный фон «доезжает» в игру
  applyWallBackground();
  // pkg3-42: строка поиска в мобильной игре скрыта — вместе с ней гасим результаты.
  // При возврате в обычный чат поле снова видно: если запрос не пуст и история уже
  // расшифрована, результаты возвращаются сразу, не дожидаясь следующего опроса.
  if (searchBarHidden()) syncSearchVisibility();
  else if ($('#search').value.trim() && S.searchReady) runSearch();
  // pkg3-38: возвращаемся в чат, где в этой сессии читали середину, —
  // окно ленты расширяем так, чтобы запомненное сообщение точно отрисовалось
  const pos = S.chatPos[id];
  if (pos && pos.id) {
    const full = S.messages.filter(m => m.chat === id && !m.parent && feedVisible(m));
    const idx = full.findIndex(m => m.id === pos.id);
    if (idx >= 0) S.winSize = Math.max(WIN_SIZE, full.length - idx + 2);
  }
  S.healBusy = false; S.healPauseUntil = 0;
  S.lastListSig = '';
  $('#input').value = S.drafts[id] || '';
  // фокус при открытии: строго первое непрочитанное, а если их нет — последнее сообщение
  const un = unreadIn(id);
  S.openMark = un.total ? firstUnreadMark(id, un.total) : firstUnseenMark(id);
  S.focusPending = true; S.userScrolled = false;
  bumpSeen(id);
  try {
    // ПЕРВЫМ ДЕЛОМ: расшифровать и нарисовать видимое окно сообщений
    const winIds = S.messages.filter(m => m.chat === id && !m.parent).slice(-(S.winSize || WIN_SIZE)).map(m => m.id);
    S.programmatic = true;   // pkg3-37: пока ставим позицию — прокрутка не «человеческая»
    await ensureIds(winIds).catch(() => {});
    renderAll();
    renderMessages(!S.openMark);
    applyFocus();
  } finally {
    requestAnimationFrame(() => { S.programmatic = false; });   // страховка, если фокус не поставился
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
      const need = list.slice(i, i + 20).filter(m => m.id && plainBroken(m.id));
      if (!need.length) continue;
      await decryptAll(need);
      renderMessages();          // «…» заменяются текстом, прокрутка сохраняется
      await new Promise(r => setTimeout(r, 0));
    }
  }, 300);
}
/** pkg3-39: «снимок» прокрутки ленты: {bottom:true} — лента внизу,
 * иначе {id,dy} — первое видимое сообщение и его смещение от верха экрана.
 * Снимок нужен везде, где DOM ленты пересоздаётся или переносится: браузер
 * в такие моменты сбрасывает прокрутку в ноль, а мы ставим её обратно. */
function feedScrollKeep() {
  const box = $('#messages');
  if (!box || !box.scrollHeight) return null;
  if (box.scrollHeight - box.scrollTop - box.clientHeight < 160) return { bottom: true };
  const br = box.getBoundingClientRect();
  for (const el of box.querySelectorAll('.msg')) {
    if (el.getBoundingClientRect().bottom > br.top + 1) {
      if (!el.id || el.id.indexOf('m-') !== 0) return { bottom: true };
      return { id: el.id.slice(2), dy: el.getBoundingClientRect().top - br.top };
    }
  }
  return { bottom: true };
}
/** pkg3-39: вернуть прокрутку по снимку: «внизу» — мотаем вниз,
 * «сообщение» — ставим ленту так, чтобы оно оказалось на том же расстоянии от верха. */
function feedScrollKeepRestore(keep) {
  const box = $('#messages');
  if (!keep || !box) return;
  if (keep.bottom) { box.scrollTop = box.scrollHeight; return; }
  const el = document.getElementById('m-' + keep.id);
  box.scrollTop = el
    ? box.scrollTop + (el.getBoundingClientRect().top - box.getBoundingClientRect().top) - keep.dy
    : box.scrollHeight;
}
/** pkg3-38: запомнить, где была прокручена лента текущего чата (делаем при уходе из чата).
 * Внизу — просто «вниз»; в середине — первое видимое сообщение и его смещение от верха экрана.
 * Память живёт до перезагрузки страницы — как и просил владелец, «в текущей сессии». */
function captureChatPos() {
  const box = $('#messages');
  if (!S.view || !box || renderedChat !== S.view) return;
  S.chatPos[S.view] = feedScrollKeep() || { bottom: true };
}
/** Детерминированный фокус: pkg3-38 — сначала возвращаем запомненное место сессии,
 * затем первое непрочитанное (с разделителем), иначе низ ленты. */
function applyFocus() {
  const box = $('#messages');
  S.programmatic = true;
  const pos = S.view ? S.chatPos[S.view] : null;
  let done = false;
  if (pos && pos.bottom) {
    box.scrollTop = box.scrollHeight;
    done = true;
  } else if (pos && pos.id) {
    const el = document.getElementById('m-' + pos.id);
    if (el) {
      // ставим ленту так, чтобы запомненное сообщение оказалось на том же расстоянии от верха
      box.scrollTop += (el.getBoundingClientRect().top - box.getBoundingClientRect().top) - pos.dy;
      done = true;
    }
  }
  if (!done) {
    if (S.openMark) {
      const el = $('#unread-mark') || document.getElementById('m-' + S.openMark.msgId);
      if (el) el.scrollIntoView({ block: 'start', behavior: 'auto' });
    } else {
      box.scrollTop = box.scrollHeight;
    }
  }
  // pkg3-37: позицию ставим мгновенно и сами помним, где низ ленты, —
  // обработчик прокрутки в это время спит, поэтому «середина» не возникает
  S.atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
  $('#scroll-bottom').classList.toggle('hidden', S.atBottom);
  requestAnimationFrame(() => { S.programmatic = false; });
}
/** Если непрочитанных сообщений нет — ищем первое сообщение с новой реакцией
 *  или первый непрочитанный комментарий: лента откроется на нём. */
function firstUnseenMark(chatId) {
  const seen = seenTs()[chatId] || 0;
  const reads = myReads();
  const cands = [];
  for (const m of S.messages) {
    if (m.chat !== chatId || m.parent) continue;
    if ((m.reactTs || 0) > seen) cands.push(m);
  }
  for (const m of S.messages) {
    if (m.chat !== chatId || m.parent) continue;
    if (S.messages.some(k => k.parent === m.id && k.seq > (reads['thr:' + m.id] || 0))) cands.push(m);
  }
  cands.sort((a, b) => a.seq - b.seq);
  return cands.length ? { chat: chatId, msgId: cands[0].id, count: 0 } : null;
}
/** Первое непрочитанное сообщение чата (сверху вниз) + сколько их всего. */
function firstUnreadMark(chatId, count) {
  const reads = myReads();
  const list = S.messages
    .filter(m => m.chat === chatId && !m.parent && m.uid !== S.me.id
      && m.seq > (reads[bucketOf(m)] || 0) && feedVisible(m))
    .sort((a, b) => a.seq - b.seq);
  return list.length ? { chat: chatId, msgId: list[0].id, count } : null;
}
// pkg3-52: одна строка ищет и свои чаты (по названию, сразу, на устройстве),
// и всех участников мессенджера (по нику, на сервере). Серверный запрос уходит
// через 350 мс после последней буквы, а рисуется только самый свежий ответ —
// та же защита от гонки, что в окне приглашения.
let railFindSeq = 0, railFindTimer = 0;
async function railFindPeople(q) {
  const seq = ++railFindSeq;
  let people = null;
  try { people = (await api('/api/search?q=' + encodeURIComponent(q))).users || []; } catch (e) { people = null; }
  if (seq !== railFindSeq) return;                                  // в пути более свежий запрос
  const box = $('#chat-filter');
  if (!box || (box.value || '').trim().toLowerCase() !== q) return; // поле изменилось, пока ждали
  S.railPeople = people || [];
  S.railPeopleQ = people ? q : '';
  S.railPeopleErr = people ? '' : 'Не получилось поискать участников — попробуйте чуть позже';
  S.railFindPending = '';
  renderRail();
}
$('#chat-filter').addEventListener('input', e => {
  S.railFilter = e.target.value; S.sig = '';
  const q = (e.target.value || '').trim().toLowerCase();
  clearTimeout(railFindTimer);
  S.railPeople = []; S.railPeopleQ = ''; S.railPeopleErr = ''; S.railFindPending = '';
  if (q) { S.railFindPending = q; railFindTimer = setTimeout(() => railFindPeople(q), 350); }
  else railFindSeq++;                                              // устаревшие ответы — мимо
  renderAll();
});
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
  if (m && !m.parent) {
    const full = S.messages.filter(x => x.chat === m.chat && !x.parent);
    const fromEnd = full.length - full.findIndex(x => x.id === id);
    if (fromEnd > (S.winSize || WIN_SIZE)) S.winSize = fromEnd + 60;
  }
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

const MS_RX_SET = ['👍', '❤️', '😂', '', '😢', ''];
function toggleBigRx(mid) {
  const el = document.getElementById('m-' + mid);
  if (!el) return;
  const old = el.querySelector('.rx-big');
  if (old) { old.remove(); return; }
  const box = document.createElement('div');
  box.className = 'rx-big';
  box.innerHTML = MS_RX_SET.map(em => `<button class="rx-big-btn" data-rxset="${em}" data-mid="${mid}">${em}</button>`).join('')
    + `<button class="rx-big-btn" data-rxmore="${mid}" title="Любой смайл">…</button>`;
  (el.querySelector('.tools') || el).appendChild(box);
}
/** Клавиатура при правке не должна заслонять редактируемое сообщение. */
function keepEditVisible(mid) {
  if (!window.matchMedia('(max-width:900px)').matches) return;
  const scroll = () => {
    const el = document.getElementById('m-' + mid);
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };
  setTimeout(scroll, 80); setTimeout(scroll, 400);
  const vv = window.visualViewport;
  if (vv) {
    const onR = () => scroll();
    vv.addEventListener('resize', onR);
    setTimeout(() => vv.removeEventListener('resize', onR), 5000);
  }
}


function handleMsgClick(e) {
  // на телефоне инструменты сообщения открываются тапом по сообщению,
  // чтобы панель кнопок не распирала ленту по горизонтали
  if (window.matchMedia('(max-width:900px)').matches) {
    const msgEl = e.target.closest('.msg');
    const solo = (el) => $$('#messages .msg.show-tools').forEach(x => { if (x !== el) x.classList.remove('show-tools'); });
    if (!msgEl) { solo(null); }                       // касание мимо — плашка закрывается
    else {
      const media = e.target.closest('img.att, video, audio, [data-upl]');
      const interactive = e.target.closest('button, a, [data-goto], input, textarea');
      if (interactive) { solo(msgEl); }               // кнопки, цитата, ссылки работают сразу
      else if (media) {
        // 1-е касание по медиа — плашка; 2-е (когда плашка открыта) — открыть медиа
        if (!msgEl.classList.contains('show-tools')) { solo(msgEl); msgEl.classList.add('show-tools'); return; }
      } else {
        const was = msgEl.classList.contains('show-tools');
        solo(null);
        if (!was) msgEl.classList.add('show-tools');
        return;
      }
    }
  }
  const upl = e.target.closest('[data-upl]');
  if (upl) { loadUpload(upl).catch(ex => toast(ex.message, true)); return; }
  const goto = e.target.closest('[data-goto]');
  if (goto) return goToMessage(goto.dataset.goto);
  const rxb = e.target.closest('[data-rx]');
  if (rxb) return toggleReaction(rxb.dataset.mid, rxb.dataset.rx);
  const rw = e.target.closest('[data-rxlist]');
  if (rw) return openRxList(rw.dataset.rxlist);   // pkg3-61: кто поставил реакции
  const rtb = e.target.closest('[data-retry]');
  if (rtb) return retrySend(rtb.dataset.retry);
  const rbig = e.target.closest('.rx-big [data-rxset]');
  if (rbig) {
    const rb = rbig.closest('.rx-big');
    if (rb) rb.remove();
    return toggleReaction(rbig.dataset.mid, rbig.dataset.rxset);
  }
  const rmore = e.target.closest('[data-rxmore]');
  if (rmore) return openRxPop(rmore.dataset.rxmore, rmore);
  const rxp = e.target.closest('[data-rxpick]');
  if (rxp) return openRxPicker(rxp.dataset.rxpick, rxp);
  const ed = e.target.closest('[data-edit]');
  if (ed) { openEditor(ed.dataset.edit); keepEditVisible(ed.dataset.edit); return; }
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
  // pkg3-37: пока позицию ставит сам чат (открытие, фокус на непрочитанном),
  // обработчик спит — иначе мгновенные прыжки принимались бы за прокрутку
  // человеком и лента «открывалась посередине»
  if (!S.programmatic) {
    S.focusPending = false; S.userScrolled = true;
    S.atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
    $('#scroll-bottom').classList.toggle('hidden', S.atBottom);
  }
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
  if (window.matchMedia('(max-width:900px)').matches) { toggleBigRx(mid); return; }
  return openRxPop(mid, anchor);
}
function openRxPop(mid, anchor) {
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
  // pkg3-76: клик по иконке группового чата в шапке открывает её крупной
  if (host.id === 'topbar') {
    const c = curChat();
    if (c && c.kind !== 'dm') return openChatIconView(c);
  }
});

/** pkg3-76: крупный просмотр иконки группового чата. Иконка зашифрована
 * ключом группы и расшифровывается только на устройстве участника —
 * сервер отдаёт закрытый конверт, как и раньше. */
async function openChatIconView(c) {
  const data = await fetchIcon(c);
  if (!data) return toast('У этого чата пока нет своей иконки. Поставить: меню чата → «Фон и иконка»');
  const lb = document.createElement('div');
  lb.className = 'lightbox';
  lb.innerHTML = `<img src="${data}" alt="">`;
  lb.onclick = () => lb.remove();
  document.body.appendChild(lb);
}

// ─────────────────────────────────────────── фон и иконка чата (общие для участников)
const wallCache = new Map(), iconCache = new Map();
async function chatKey(c) { const k = await chatKeyOf(c); return k ? k.key : null; }
async function fetchWall(c) {
  if (!c || !c.wallRev) return null;
  const hit = wallCache.get(c.id);
  if (hit && hit.rev === c.wallRev) return hit.data;
  try {
    const r = await api('/api/wall/' + encodeURIComponent(c.id) + '?rev=' + encodeURIComponent(c.wallRev || ''));
    // pkg3-65: фон пробуется текущим ключом и прежними копиями
    const got = r.wall ? await decryptWithHistory(c, r.wall) : null;
    const data = got ? got.data : null;
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
    // pkg3-65: иконка пробуется текущим ключом и прежними копиями
    const got = r.icon ? await decryptWithHistory(c, r.icon) : null;
    const data = got ? got.data : null;
    iconCache.set(c.id, { rev: c.iconRev, data });
    S.sig = ''; renderAll();
    return data;
  } catch (e) { return null; }
}
function patSvg(kind) {
  const s = 'rgba(255,255,255,.28)';
  const svg = (w, h, body) => `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}' viewBox='0 0 ${w} ${h}'>${body}</svg>`)}")`;
  // pkg3-38: большие «перспективные» обои — одна картина на весь экран, со своим чёрным фоном
  if (kind === 'neongrid' || kind === 'sunset') return svg(240, 160, perspBody(kind));
  const body = {
    // точки — без изменений
    dots: `<circle cx='6' cy='6' r='1.4' fill='${s}'/><circle cx='18' cy='18' r='1.4' fill='${s}'/>`,
    // непрерывные диагональные линии: ровный шаг, концы выведены за плитку —
    // при повторении плитки линии сшиваются в сплошные полосы без разрывов
    diag: `<path d='M0 6 L6 0 M0 18 L18 0 M6 24 L24 6 M18 24 L24 18' stroke='${s}' stroke-width='1.4' fill='none'/>`,
    // клетка, повёрнутая на 45°: те же сплошные диагонали + перпендикулярные им
    grid: `<path d='M0 6 L6 0 M0 18 L18 0 M6 24 L24 6 M18 24 L24 18 M6 0 L24 18 M18 0 L24 6 M0 18 L6 24 M0 6 L18 24' stroke='${s}' stroke-width='1' fill='none'/>`,
    // настоящие концентрические окружности: кольца из центра крупной плитки
    waves: `<circle cx='24' cy='24' r='6' stroke='${s}' stroke-width='1.3' fill='none'/><circle cx='24' cy='24' r='12' stroke='${s}' stroke-width='1.3' fill='none'/><circle cx='24' cy='24' r='18' stroke='${s}' stroke-width='1.3' fill='none'/><circle cx='24' cy='24' r='23.4' stroke='${s}' stroke-width='1.3' fill='none'/>`
  }[kind] || '';
  return svg(kind === 'waves' ? 48 : 24, kind === 'waves' ? 48 : 24, body);
}
/** pkg3-38: «перспективные» картины: горизонт y=60, точка схода (120,60), чёрный фон.
 * neongrid — бирюзовая клетка пола, уходящая вдаль; sunset — фиолетовые лучи-линии. */
function perspBody(kind) {
  const W = 240, H = 160, HZ = 60, VX = 120;
  let g = `<rect width='${W}' height='${H}' fill='#000'/>`;
  let d = '';
  if (kind === 'neongrid') {
    const c = 'rgba(0,229,255,';
    // горизонтали пола: шаг растёт вниз — та самая перспектива
    for (let i = 1; i <= 9; i++) { const t = i / 9; d += `M0 ${(HZ + (H - HZ) * t * t).toFixed(1)} H${W} `; }
    g += `<path d='${d.trim()}' stroke='${c}.45)' stroke-width='1' fill='none'/>`;
    // вертикали сходятся в одну точку на горизонте
    d = '';
    for (let k = -7; k <= 7; k++) d += `M${VX} ${HZ} L${VX + k * 34} ${H} `;
    g += `<path d='${d.trim()}' stroke='${c}.45)' stroke-width='1' fill='none'/>`;
    g += `<path d='M0 ${HZ} H${W}' stroke='${c}.8)' stroke-width='1.2'/>`;
  } else {
    const c = 'rgba(176,106,255,';
    // фиолетовые линии-лучи расходятся из точки на горизонте — коридор, уходящий вдаль
    for (let a = 6; a < 360; a += 12) {
      const r = a * Math.PI / 180;
      d += `M${VX} ${HZ} L${(VX + Math.cos(r) * 420).toFixed(1)} ${(HZ + Math.sin(r) * 420).toFixed(1)} `;
    }
    g += `<path d='${d.trim()}' stroke='${c}.4)' stroke-width='1' fill='none'/>`;
    g += `<path d='M0 ${HZ} H${W}' stroke='${c}.55)' stroke-width='1'/>`;
    g += `<circle cx='${VX}' cy='${HZ}' r='3' fill='rgba(255,43,214,.5)'/>`;
  }
  return g;
}
const patMeta = id => PATS.find(p => p.id === id) || PATS[0];
/** pkg3-38: как класть узор в фон: мелкие плиткой (repeat), большие «перспективные» — во весь экран. */
function patLayer(pat) {
  return patMeta(pat).big ? `${patSvg(pat)} center/cover no-repeat` : `${patSvg(pat)} repeat`;
}
/** Превью для кнопок выбора узора: у больших — та же картина, у мелких — CSS-градиент. */
const patPrev = p => p.big ? `${patSvg(p.id)} center/cover no-repeat` : p.prev;
async function applyWallBackground() {
  const box = $('#messages'), c = curChat();
  if (S.eco) { box.style.background = ''; return; }   // эконом-режим: фонов нет
  // pkg3-44: в чат-игре фона нет никогда. Раньше случалось, что лента приезжала
  // в игру с фоном личного чата (отрисовка игры откладывается ради доски,
  // и inline-фон прошлого чата оставался на #messages). Теперь фон гасится
  // сразу при входе в игру, а редактор фона в играх не предлагается вовсе.
  if (c && c.kind === 'game') { box.style.background = ''; return; }
  if (!c || !c.wall || c.wall.type === 'none') { box.style.background = ''; return; }
  // страховка: цвета могли не сохраниться в старых версиях — подставляем дефолт
  const w = Object.assign({ type: 'grad', c1: '#eef2f4', c2: '#e8f4fe', a: 165, pat: 'dots' }, c.wall);
  const grad = `linear-gradient(${w.a}deg, ${w.c1}, ${w.c2})`;
  if (w.type === 'grad') { box.style.background = grad; return; }
  if (w.type === 'pat') { box.style.background = `${patLayer(w.pat)}, ${grad}`; return; }
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
        ${PATS.map(p => `<button class="pat ${w.pat === p.id ? 'on' : ''}" data-pat="${p.id}" style="background:${patPrev(p)};background-color:${p.bg}"></button>`).join('')}
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
    if (state.type === 'pat') box.style.background = `${patLayer(state.pat)}, ${grad}`;
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
    e.target.value = '';
    try {
      // pkg3-76: фон тоже кадрируется вручную (прямоугольная рамка) и молча
      // сжимается до предела сервера (~350 КБ) — ошибка «слишком большое» ушла
      const canvas = await openCropDialog(f, { shape: 'rect', title: 'Фон чата' });
      if (!canvas) return;
      const data = await encodeImageUnderLimit(canvas, 0.8, 340 * 1024);
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
        <div class="tiny muted" style="margin-top:6px">фото можно двигать и увеличивать — обрежется по кругу; шифруется; видят все участники</div>
        ${c.iconRev ? '<button class="mini danger" id="ic-del" style="margin-top:8px">Убрать иконку</button>' : ''}
      </div>
    </div>
    <p class="hint">Иконку группового чата может поставить любой участник — как и название и фон.</p>`);
  const prev = iconCache.get(c.id);
  if (prev && prev.data) $('#ic-prev').innerHTML = `<img src="${prev.data}" alt="">`;
  // pkg3-76: клик по картинке иконки в редакторе открывает её крупной
  $('#ic-prev').style.cursor = 'zoom-in';
  $('#ic-prev').addEventListener('click', () => openChatIconView(c));
  $('#ic-file').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    e.target.value = '';
    try {
      // pkg3-76: иконка группы кадрируется так же, как аватар — круг с перетаскиванием
      const canvas = await openCropDialog(f, { shape: 'circle', size: 320, title: 'Иконка чата' });
      if (!canvas) return;
      const data = await canvasToDataURL(canvas, 'image/jpeg', 0.85);
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
  const others = S.users.filter(u => u.id !== S.me.id && !u.displayAs);   // pkg3-62: слитых не зовём
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
// pkg3-52: одна кнопка «+» вместо прежних «Новый чат» и «♟ Игра».
// Меню закрывается кликом мимо, по Escape и после выбора действия.
function plusMenu(open) {
  const m = $('#plus-menu'), b = $('#btn-plus');
  if (!m || !b) return;
  m.classList.toggle('hidden', !open);
  b.setAttribute('aria-expanded', open ? 'true' : 'false');
}
$('#btn-plus').addEventListener('click', e => {
  e.stopPropagation();
  plusMenu($('#plus-menu').classList.contains('hidden'));
});
$('#plus-menu').addEventListener('click', e => {
  const it = e.target.closest('[data-plus]');
  if (!it) return;
  plusMenu(false);
  $('#rail').classList.remove('open');                 // на телефоне шторка списка закрывается
  const act = it.dataset.plus;
  if (act === 'game') return openNewGame();
  if (act === 'group') return openCreateChat();
  if (act === 'invite') return openInviteFriend();
  if (act === 'section') return openCreateSection();
  if (act === 'music') return openMusic();   // pkg3-87: плашка прямо в первом меню
});
document.addEventListener('click', e => {
  if (!e.target.closest('#plus-menu') && !e.target.closest('#btn-plus')) plusMenu(false);
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') plusMenu(false); });

// ─────────────────────────────────────────── pkg3-53: свои разделы (папки) чатов
// Раздел — личная папка: в неё кладётся КОПИЯ чата, из системного раздела чат не
// исчезает. Удаление раздела убирает только папку. Список разделов приходит в
// синхронизации (mySections) и обновляется после каждого действия.
async function reloadSections() {
  try {
    const r = await api('/api/sections');
    S.sections = r.sections || [];
  } catch (e) { /* останутся прежние из синхронизации */ }
  S.sig = '';
  renderRail();
}
function sectionForm(title, hint, value, submitLabel, onSubmit) {
  modal(title, `
    <form class="card" id="form-section" autocomplete="off">
      <label>Название раздела
        <input name="name" type="text" maxlength="32" required placeholder="Например: работа, семья, шахматы" value="${escapeHtml(value || '')}">
      </label>
      <p class="hint">${hint}</p>
      <div class="err" id="sec-err"></div>
      <button class="primary" type="submit">${submitLabel}</button>
    </form>`);
  const f = $('#form-section');
  f.addEventListener('submit', async e => {
    e.preventDefault();
    const name = String(new FormData(f).get('name') || '').trim();
    const err = $('#sec-err'), btn = f.querySelector('button[type=submit]');
    if (btn) btn.disabled = true;
    try {
      await onSubmit(name);
      hide($('#modal'));
      await reloadSections();
    } catch (ex) {
      if (err) err.textContent = ex.message || 'Не получилось';
      if (btn) btn.disabled = false;
    }
  });
  setTimeout(() => { const i = f.querySelector('input[name=name]'); if (i) i.focus(); }, 30);
}
function openCreateSection() {
  sectionForm('Новый раздел',
    'Раздел — ваша личная папка: в неё можно положить копию любого чата, из системных разделов чат не исчезнет. Раздел виден только вам.',
    '', 'Создать раздел', async (name) => {
      await api('/api/sections', { method: 'POST', body: { name } });
      toast('Раздел «' + name + '» создан');
    });
}
function openRenameSection(id) {
  const s = (S.sections || []).find(x => x.id === id);
  if (!s) return;
  sectionForm('Переименовать раздел', 'Название раздела видно только вам.', s.name, 'Сохранить',
    async (name) => {
      await api('/api/sections/' + encodeURIComponent(id) + '/rename', { method: 'POST', body: { name } });
      toast('Раздел переименован');
    });
}
/** Три точки на заголовке раздела: переименовать или удалить. */
function openSectionMenu(id) {
  const s = (S.sections || []).find(x => x.id === id);
  if (!s) return;
  const n = (s.chats || []).length;
  modal('Раздел «' + s.name + '»', `
    <div class="card">
      <p class="hint">В разделе ${plural(n, 'чат', 'чата', 'чатов')}. Раздел виден только вам.</p>
      <div class="set-row"><span class="ico" data-ic="pencil"></span>
        <div class="t"><b>Переименовать</b><span>другое название папки</span></div>
        <button class="mini" id="sec-rename" type="button">Открыть</button></div>
      <div class="set-row"><span class="ico" data-ic="rows"></span>
        <div class="t"><b>Переместить раздел</b><span>порядок ваших папок в списке</span></div>
        <span class="mv-b"><button class="mini" id="sec-up" type="button">Выше</button>
        <button class="mini" id="sec-down" type="button">Ниже</button></span></div>
      <div class="set-row"><span class="ico" data-ic="trash"></span>
        <div class="t"><b>Удалить раздел</b><span>чаты останутся в своих разделах</span></div>
        <button class="mini" id="sec-delete" type="button">Удалить</button></div>
    </div>`);
  const idx = (S.sections || []).findIndex(x => x.id === id);
  const upB = $('#sec-up'), downB = $('#sec-down');
  if (upB) upB.disabled = idx <= 0;
  if (downB) downB.disabled = idx < 0 || idx >= (S.sections || []).length - 1;
  const moveSec = async (dir) => {
    try {
      await api('/api/sections/' + encodeURIComponent(id) + '/move', { method: 'POST', body: { dir } });
      hide($('#modal'));
      await reloadSections();
    } catch (ex) { toast(ex.message, true); }
  };
  if (upB) upB.addEventListener('click', () => moveSec('up'));
  if (downB) downB.addEventListener('click', () => moveSec('down'));
  $('#sec-rename').addEventListener('click', () => openRenameSection(id));
  $('#sec-delete').addEventListener('click', async () => {
    if (!confirm('Удалить раздел «' + s.name + '»?' + String.fromCharCode(10, 10)
      + 'Удалится только папка: чаты останутся в своих разделах.')) return;
    try {
      await api('/api/sections/' + encodeURIComponent(id) + '/delete', { method: 'POST' });
      hide($('#modal'));
      await reloadSections();
      toast('Раздел удалён; чаты остались на своих местах');
    } catch (ex) { toast(ex.message || 'Не получилось удалить', true); }
  });
}
/** Меню чата «Переместить в раздел…»: положить копию в папку или убрать её. */
function openChatSections(c) {
  const has = (id) => (S.sections || []).some(s => s.id === id && (s.chats || []).includes(c.id));
  const rows = (S.sections || []).map(s => `
      <div class="set-row"><span class="ico">📁</span>
        <div class="t"><b>${escapeHtml(s.name)}</b><span>${plural((s.chats || []).length, 'чат', 'чата', 'чатов')} в разделе</span></div>
        <button class="mini" data-sec-pick="${s.id}" type="button">${has(s.id) ? 'Убрать' : 'Положить'}</button></div>`).join('');
  modal('Переместить чат в раздел', `
    <div class="card">
      <p class="hint">Раздел хранит копию чата: из «Личных», «Групповых» или «Игровых» чатов он не исчезнет.</p>
      <div id="sec-pick-list">${rows || '<p class="hint">Разделов пока нет — создайте первый.</p>'}</div>
      <div class="err" id="sec-err"></div>
      <button class="primary" id="sec-create-here" type="button">Создать раздел</button>
    </div>`);
  // слушатель вешаем на СВЕЖУЮ карточку окна: она пересоздаётся каждый раз,
  // поэтому обработчики не накапливаются и не срабатывают дважды
  const card = $('#modal-body').querySelector('.card');
  card.addEventListener('click', async e => {
    if (e.target.closest('#sec-create-here')) { openCreateSection(); return; }
    const b = e.target.closest('[data-sec-pick]');
    if (!b) return;
    b.disabled = true;
    const id = b.dataset.secPick, wasThere = has(id);
    try {
      await api('/api/chats/' + encodeURIComponent(c.id) + '/section', {
        method: 'POST', body: { section: wasThere ? null : id }
      });
      await reloadSections();
      hide($('#modal'));
      toast(wasThere ? 'Копия убрана из раздела' : 'Копия чата положена в раздел');
    } catch (ex) {
      const err = $('#sec-err');
      if (err) err.textContent = ex.message || 'Не получилось';
      b.disabled = false;
    }
  });
}

// ─────────────────────────────────────────── участники чата
// pkg3-60: функция bondStateWith («Приглашенные») удалена вместе с разделом —
// серверные связи bonds по-прежнему приходят в синхронизации и учитываются
// кругом видимости, но в интерфейсе больше не отображаются.
$('#btn-members').addEventListener('click', () => {
  const c = curChat();
  if (!c) return;
  const members = c.members.map(userById).filter(Boolean);
  const canAdd = c.kind === 'group';
  const rows = members.map(u => {
    const mst = u.id !== S.me.id ? musicStatusOf(u.id) : null;   // pkg3-87
    return `<div class="mrow">${avatarHtml(u, '', true)}
      <span class="nm">${escapeHtml(u.name)}${u.id === S.me.id ? ' <span class="muted">(вы)</span>' : ''}${c.ownerId === u.id ? '<span class="tag-admin">создатель</span>' : ''}
        <div class="tiny muted">${mst ? '🎵 слушает' + (mst.note ? ': ' + escapeHtml(mst.note) : ' музыку') : isOnline(u) ? 'в сети, смотрит чат' : 'был(а) ' + escapeHtml(fmtAgo(u.lastSeen))}</div></span>
      ${u.id !== S.me.id ? `<button class="mini" data-mus-of="${u.id}" title="Публичные плейлисты участника">🎵 музыка</button>` : ''}
      ${u.id !== S.me.id && c.kind === 'group' ? `<button class="mini" data-open-dm="${u.id}">лично</button>` : ''}
      ${isOwner(c) && u.id !== S.me.id ? `<button class="mini danger" data-kick="${u.id}">убрать</button>` : ''}
    </div>`;
  }).join('');
  const rest = S.users.filter(u => !c.members.includes(u.id) && !u.displayAs);   // pkg3-62: слитых не зовём
  modal('Участники · ' + chatTitle(c), rows + (canAdd ? `
    <div class="divider"><span>Добавить в чат</span></div>
    ${rest.length ? rest.map(u => `<div class="mrow">${avatarHtml(u, '', true)}
        <span class="nm">${escapeHtml(u.name)}</span>
        <button class="mini" data-add="${u.id}">добавить</button></div>`).join('')
      : '<div class="tiny muted">Все участники мессенджера уже здесь</div>'}
    <p class="hint">Новый участник получит ключ чата и сможет прочитать всю его историю.</p>` : ''));

  $('#modal-body').addEventListener('click', async e => {
    const mo = e.target.closest('[data-mus-of]');   // pkg3-87: чужая музыка
    if (mo) {
      const u = userById(mo.getAttribute('data-mus-of'));
      if (u) openMusicOf(u);
      return;
    }
    const dm = e.target.closest('[data-open-dm]');
    if (dm) {
      hide($('#modal'));
      const r = await api('/api/dm', { method: 'POST', body: { peer: dm.dataset.openDm } });
      await sync(); openChat(r.chat.id);
      return;
    }
    // pkg3-60: запросов «в мои Приглашенные» больше нет (раздел убран)
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
    // pkg3-44: в чат-игре фона нет и редактор не нужен — прячем пункт меню
    d.querySelector('[data-act="wall"]').classList.toggle('hidden', c.kind === 'game');
    // pkg3-63: перевыпуск ключа группы — только в групповых чатах
    // pkg3-73: перевыпуск — ремонт, а не игрушка: решает создатель чата или
    // администратор мессенджера, и только когда в чате есть чему чиниться
    const canRotate = c.kind === 'group' && (c.ownerId === S.me.id || (S.me && S.me.isAdmin));
    const needRot = c.kind === 'group' && (S.keyIssue.has(c.id)
      || S.messages.some(m => m.chat === c.id && (S.plain.get(m.id) || {}).broken));
    const rkBtn = d.querySelector('[data-act="rotatekeys"]');
    if (rkBtn) rkBtn.classList.toggle('hidden', !(canRotate && needRot));
    // pkg3-73: «Очистить чат» в группе решает только создатель или администратор —
    // остальным пункт не показываем (сервер их и так не пустит)
    const clBtn = d.querySelector('[data-act="clear"]');
    if (clBtn) clBtn.classList.toggle('hidden', c.kind === 'group' && !(c.ownerId === S.me.id || (S.me && S.me.isAdmin)));
    // pkg3-60: пункт «Взять в «Приглашенные»» из меню чата убран (раздел снят)
    // pkg3-50: «Добавить пользователя в мои личные чаты» — для чата из раздела «Новые»,
    // «Убрать из моих личных чатов» — для сохранённого личного чата
    // pkg3-54: «сохранить» и «отклонить» работают и для группового чата из «Новых»
    const inNew = !!c.newUntil && !S.dmSaved.has(c.id);
    d.querySelector('[data-act="save"]').classList.toggle('hidden',
      !((c.kind === 'dm' || c.kind === 'group') && inNew));
    d.querySelector('[data-act="decline"]').classList.toggle('hidden',
      !((c.kind === 'dm' || c.kind === 'group') && inNew));
    d.querySelector('[data-act="hide"]').classList.toggle('hidden', !(c.kind === 'dm' && S.dmSaved.has(c.id)));
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
  if (b.dataset.act === 'wall') { if (c.kind !== 'game') wallEditor(c); return; }   // pkg3-44: в играх фона нет
  if (b.dataset.act === 'rotatekeys') return rotateGroupKey(c);   // pkg3-63: ключ группы разъехался — перевыпустить
  if (b.dataset.act === 'alias') return openAliasEditor();   // pkg3-45: локальные псевдонимы
  // pkg3-60: пункта «bond» в меню больше нет (раздел «Приглашенные» снят)
  // pkg3-50: «Добавить пользователя в мои личные чаты» — сохранить чат из «Новых» навсегда
  if (b.dataset.act === 'section') return openChatSections(c);   // pkg3-53: копия чата в свою папку
  if (b.dataset.act === 'decline') return declineChat(c);         // pkg3-54: отклонить чат из «Новых»
  if (b.dataset.act === 'save') return saveDmChat(c);
  if (b.dataset.act === 'hide') {
    (async () => {
      try {
        await api('/api/chats/' + c.id + '/hide', { method: 'POST', body: { hidden: true } });
        if (S.view === c.id) {
          S.view = null; S.threadId = null; S.sig = '';
          $('#messages').innerHTML = ''; renderTopbar(); renderDmBanner(); renderMessages(true);
        }
        await sync(false); renderRail();
        toast('Чат убран из ваших личных чатов. Собеседник по-прежнему видит переписку у себя; его новое письмо вернёт чат в раздел «Новые» ещё на 7 суток');
      } catch (ex) { toast(ex.message, true); }
    })();
    return;
  }
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
    hide($('#modal')); S.view = null; S.sig = ''; await sync(); renderDmBanner(); renderMessages(true); toast('Вы покинули чат');
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
/** pkg3-76: окно загрузки с полосой прогресса. Вместо мелькающих уведомлений
 * «Загружено 40%» человек видит честную полосу и подпись, что происходит.
 * Окно можно закрыть — загрузка продолжится (обновления просто не рисуются). */
function openUploadModal(name) {
  modal('Отправка в облако', `
    <div class="up-name">${SV(ICONS.file)}<span>${escapeHtml(name)}</span></div>
    <div class="up-track"><i id="up-fill"></i></div>
    <div class="tiny muted" id="up-step" style="margin-top:6px">готовлюсь…</div>
    <div class="tiny muted" style="margin-top:10px">Окно можно закрыть — отправка продолжится,
    а письмо появится в ленте, когда все куски доедут.</div>`);
}
function upStep(text, frac) {
  const s = $('#up-step'); if (s) s.textContent = text;
  if (typeof frac === 'number') { const f = $('#up-fill'); if (f) f.style.width = Math.round(frac * 100) + '%'; }
}
function closeUploadModal() { if ($('#up-fill')) hide($('#modal')); }
async function uploadChunked(file, c, att) {
  const k = await chatKeyOf(c);
  if (!k) throw new Error('Нет ключа чата для шифрования вложения');
  openUploadModal(att.name || 'файл');
  try {
    upStep('Шифрую на устройстве…');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const enc = await aesEncryptBytes(k.key, bytes);
    const CH = 900000;
    const parts = Math.max(1, Math.ceil(enc.length / CH));
    upStep('Загружаю: ' + (parts > 1 ? parts + ' кусков' : '1 кусок') + '…', 0);
    const init = await api('/api/upload/init', { method: 'POST', body: { chat: c.id, name: att.name, size: file.size, mime: att.mime, parts } });
    for (let i = 0; i < parts; i++) {
      await api('/api/upload/chunk', { method: 'POST', body: { upId: init.upId, i, data: enc.slice(i * CH, (i + 1) * CH) } });
      upStep('Загружено ' + Math.round((i + 1) / parts * 100) + '% (' + (i + 1) + ' из ' + parts + ')', (i + 1) / parts);
    }
    upStep('Проверяю на сервере…', 1);
    await api('/api/upload/fin', { method: 'POST', body: { upId: init.upId, stored: enc.length } });
    // pkg3-76: отправитель кладёт готовый файл в память устройства — своё видео
    // открывается у него мгновенно, без повторного скачивания с сервера
    idb.put(init.upId, {
      blob: file, kind: att.kind, name: att.name, size: file.size, mime: att.mime,
      ts: Date.now(), poster: att.poster || ''
    });
    closeUploadModal();
    return { kind: att.kind, upId: init.upId, parts, name: att.name, size: file.size, mime: att.mime, poster: att.poster || '' };
  } catch (ex) {
    closeUploadModal();
    throw ex;
  }
}
async function loadUpload(el) {
  if (el.dataset.busy) return;          // pkg3-76: повторный клик не запускает вторую загрузку
  el.dataset.busy = '1';
  const upId = el.dataset.upl, parts = Math.max(1, Number(el.dataset.parts) || 1);
  try {
    let rec = await idb.get(upId);
    if (!rec) {
      const c = curChat();
      const k = await chatKeyOf(c);
      let enc = '';
      for (let i = 0; i < parts; i++) {
        let r;
        try {
          r = await api('/api/upload/' + encodeURIComponent(upId) + '/' + i);
        } catch (ex) {
          // pkg3-74: вложение удалено с сервера через пульт памяти
          if (/удалено/i.test(ex.message || '')) {
            el.outerHTML = '<div class="att gone tiny muted" style="padding:6px 10px;border:1px dashed #8884;border-radius:10px">вложение удалено с сервера</div>';
            return;
          }
          throw ex;
        }
        enc += r.data;
        // pkg3-76: честный прогресс скачивания — проценты текстом и полосой
        const pct = Math.round((i + 1) / parts * 100);
        const pr = el.querySelector('.tiny');
        if (pr) pr.textContent = 'скачиваю ' + pct + '%';
        const bar = el.querySelector('.vd-bar i');
        if (bar) { el.querySelector('.vd-bar').classList.add('on'); bar.style.width = pct + '%'; }
      }
      const bytes = await aesDecryptBytes(k.key, enc);
      rec = {
        blob: new Blob([bytes], { type: el.dataset.mime || 'application/octet-stream' }),
        kind: el.dataset.kind, name: el.dataset.name || 'file',
        size: Number(el.dataset.size) || 0, mime: el.dataset.mime || '', ts: Date.now(),
        poster: el.dataset.poster || ''   // pkg3-76: первый кадр видео живёт и в памяти устройства
      };
      await idb.put(upId, rec);
    }
    el.outerHTML = mediaPlayerHtml(rec, upId);
  } finally { delete el.dataset.busy; }
}
/** После перерисовки ленты уже закэшированные медиа подставляются сами, без клика. */
async function upgradeMedia(box) {
  if (S.eco) return;   // эконом-режим: медиа не разворачиваются
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
  stopTypingSignal();   // pkg3-77: письмо само скажет «дописал» — сигнал «пишет…» гаснет
  const k = await chatKeyOf(c);
  if (!k) return toast('Не удалось получить ключ шифрования для этого чата', true);
  // pkg3-67: ключ, которым шифруется отправка, СРАЗУ кладётся в историю
  // устройства — свои же письма больше не закроются сменой поколения ключа
  if (c.kind === 'group') pushOldKey(c.id, k, c.keyEpoch || 0);
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
    cacheMsg(r.message);              // эхо сразу в локальную память — курсор кэша честный
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

/** Сервер принял сообщение: подменяем черновик настоящей записью.
 * pkg3-36: настоящая запись к этому моменту могла уже прийти через опрос —
 * тогда просто убираем черновик, не плодя дубль. */
function adoptSent(draft, real, plain) {
  delete S.retry[draft.id];
  if (!real || !real.id) return;
  S.messageIds.delete(draft.id);
  S.plain.delete(draft.id);
  const i = S.messages.findIndex(m => m.id === draft.id);
  if (i >= 0) S.messages.splice(i, 1);
  const j = S.messages.findIndex(m => m.id === real.id);
  if (j >= 0) S.messages[j] = real;
  else { S.messages.push(real); S.messageIds.add(real.id); }
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
      body: JSON.stringify({ kind: ticket.kind, chat: ticket.chat, mid: ticket.mid, body: ticket.body || null })
    }).catch(() => {});
  } catch (e) {}
}
$('#btn-send').addEventListener('click', () => send({ textarea: $('#input'), attachKey: 'attach' }));
$('#thread-send').addEventListener('click', () => send({ textarea: $('#thread-input'), parent: S.threadId, attachKey: 'threadAttach' }));

// pkg3-77: сигнал «пишу» на сервер. Отправляем не чаще раза в 3 секунды, пока
// человек действительно набирает, и гасим через 5 секунд после последнего
// символа (или сразу — при отправке, смене чата, уходе с вкладки). Сервер
// хранит сигнал только в памяти и сам забудет его через 9 секунд — «залипших»
// надписей «пишет…» не бывает даже тогда, когда браузер закрыли силой.
let typingLastSig = 0, typingStopTimer = 0, typingChat = null;
function postTyping(chatId, kind) {
  api('/api/typing', { method: 'POST', body: { chat: chatId, kind } })
    .then(r => { if (r && Array.isArray(r.typing)) { mergeTypingChat(chatId, r.typing); refreshTypingHeader(chatId); } })
    .catch(() => {});
}
function sigTyping(kind) {
  if (!S.token) return;
  if (kind !== 'type') { stopTypingSignal(); return; }
  const c = curChat();
  if (!c) return;
  if (typingChat && typingChat !== c.id) stopTypingSignal();   // перешли в другой чат — там гасим
  typingChat = c.id;
  const now = Date.now();
  if (now - typingLastSig < 3000) { scheduleTypingStop(); return; }
  typingLastSig = now;
  scheduleTypingStop();
  postTyping(c.id, 'type');
}
function scheduleTypingStop() {
  clearTimeout(typingStopTimer);
  typingStopTimer = setTimeout(() => { typingStopTimer = 0; stopTypingSignal(); }, 5000);
}
/** Немедленно замолчать: сообщение ушло, чат сменился или вкладку спрятали. */
function stopTypingSignal() {
  clearTimeout(typingStopTimer); typingStopTimer = 0; typingLastSig = 0;
  const chatId = typingChat; typingChat = null;
  if (chatId && S.token) postTyping(chatId, '');
}

function composerKeydown(e, sendFn) {
  if (mentionKeydown(e)) return;
  if (e.key === 'Escape' && S.quote) { S.quote = null; renderQuoteBar(); return; }
  if (e.key === 'Enter' && !e.shiftKey && window.matchMedia('(min-width: 901px)').matches) { e.preventDefault(); sendFn(); }
}
$('#input').addEventListener('keydown', e => composerKeydown(e, () => send({ textarea: $('#input'), attachKey: 'attach' })));
$('#thread-input').addEventListener('keydown', e => composerKeydown(e, () => send({ textarea: $('#thread-input'), parent: S.threadId, attachKey: 'threadAttach' })));
$('#input').addEventListener('input', e => { autoGrow(e.target); mentionInput(e.target, $('#mention-pop')); if (e.target.value.trim()) sigTyping('type'); });
$('#thread-input').addEventListener('input', e => { autoGrow(e.target); mentionInput(e.target, $('#thread-mention-pop')); if (e.target.value.trim()) sigTyping('type'); });

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
// pkg3-80: «Звук в играх» — спокойные сигналы событий и музыка забега.
// Личная настройка устройства: на чужих не влияет, сервер о ней не знает.
$('#game-sound').addEventListener('change', e => {
  S.notify.gamesound = e.target.checked;
  saveNotifySettings();
  GS.setEnabled(S.notify.gamesound !== false);
  renderNotifyControls();
  if (S.notify.gamesound !== false) {
    GS.ensure();
    GS.play('start');
    toast('Звук в играх включён');
  } else {
    GS.stopMusic();
    toast('Звук в играх выключен');
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
    // pkg3-76: у видео в превью виден первый кадр — понятно, что отправляем
    box.innerHTML = `<div class="file-chip">${a.poster ? `<img class="fc-thumb" src="${a.poster}" alt="">` : SV(a.kind === 'video' ? ICONS.play : ICONS.file)}
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
/** pkg3-76: спокойное сообщение о пределе 25 МБ — без красной ругани.
 * Предел остался прежним (облако хранит один файл до 25 МБ), но говорим
 * по-человечески и подсказываем, что можно сделать. */
function tooBigToast(file, kind) {
  const what = kind === 'video' ? 'Видео' : kind === 'audio' ? 'Запись' : 'Файл';
  const tip = kind === 'video' ? 'Попробуйте обрезать или сжать его на телефоне — тогда оно отправится.'
    : kind === 'audio' ? 'Попробуйте запись покороче — тогда она отправится.'
    : 'Попробуйте файл поменьше — тогда он отправится.';
  toast(`${what} весит ${fmtBytes(file.size)}, а облако хранит один файл до 25 МБ. ${tip}`);
}
/** pkg3-76: первый кадр видео — картинка-превью, которую видно в ленте
 * ещё до скачивания. Кадр летит внутри письма (как и всё — зашифрованным),
 * поэтому сервер его не видит. Не получилось — не беда, вернём пустоту. */
async function videoPoster(file) {
  let url = null;
  try {
    url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('timeout')), 9000);
      v.onloadeddata = () => { clearTimeout(t); res(); };
      v.onerror = () => { clearTimeout(t); rej(new Error('video')); };
    });
    const seeked = new Promise(res => { const t = setTimeout(res, 2500); v.onseeked = () => { clearTimeout(t); res(); }; });
    try { v.currentTime = Math.min(0.6, (v.duration || 1) * 0.05 + 0.05); } catch (e) {}
    await seeked;
    const w = v.videoWidth, h = v.videoHeight;
    if (!w || !h) return '';
    const t = targetImageSize(w, h, 480);
    const c = drawImageToCanvas(v, t.w, t.h);
    const data = await canvasToDataURL(c, 'image/jpeg', 0.6);
    v.removeAttribute('src');
    return data.length < 180000 ? data : '';
  } catch (e) { return ''; }
  finally { if (url) try { URL.revokeObjectURL(url); } catch (e) {} }
}
async function attachFile(file, key) {
  const mime = file.type || 'application/octet-stream';
  try {
    if (/^image\//.test(mime)) {
      if (isHeic(file)) return toast('iPhone: сначала конвертируйте HEIC в JPG (Настройки → Камера → Форматы → наиболее совместимый)', true);
      // pkg3-76: GIF отправляем как есть — байт в байт, анимация сохраняется.
      // Перерисовка в JPEG сделала бы из него неподвижный снимок.
      if (/^image\/gif/i.test(mime)) {
        const data = await blobToDataURL(file);
        if (estimatedEncryptedUploadChars(data) <= Number(S.maxUpload || DEFAULT_MAX_UPLOAD)) {
          S[key] = { kind: 'image', data, name: file.name || 'анимация.gif', size: file.size, mime: 'image/gif' };
          showAttach(key, S[key]);
          toast('GIF прикреплён: анимация сохранится');
          return;
        }
        if (file.size > 25 * 1024 * 1024) return tooBigToast(file, 'file');
        // слишком большой для письма, но проходит в облако файлом — при скачивании анимация цела
        S[key] = { kind: 'file', pending: true, file, name: file.name || 'анимация.gif', size: file.size, mime };
        showAttach(key, S[key]);
        toast('GIF большой — отправится файлом, анимация сохранится');
        return;
      }
      toast('Готовим фото…');
      // pkg3-76: resizeImage больше не умеет падать из-за размера — жмёт молча
      const data = await resizeImage(file, 1800, 0.82);
      S[key] = { kind: 'image', data, name: file.name || 'фото', size: file.size, mime: 'image/jpeg' };
      showAttach(key, S[key]);
      toast('Фото готово к отправке');
      return;
    }
    const kind = /^video\//.test(mime) ? 'video' : /^audio\//.test(mime) ? 'audio' : 'file';
    if (file.size > 25 * 1024 * 1024) return tooBigToast(file, kind);
    if (kind === 'video') {
      // pkg3-76: сразу делаем превью из первого кадра — его увидят все
      toast('Готовлю превью видео…');
      const poster = await videoPoster(file);
      S[key] = { kind, pending: true, file, name: file.name || 'видео', size: file.size, mime, poster };
    } else {
      S[key] = { kind, pending: true, file, name: file.name || kind, size: file.size, mime };
    }
    showAttach(key, S[key]);
    toast('Вложение прикреплено: зашифруется и загрузится кусками при отправке');
  }
  catch (ex) { toast(ex && ex.message ? ex.message : 'Не удалось обработать вложение', true); }
}
async function pickAttach(e, key) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  return attachFile(file, key);
}
// ─── pkg3-76: вставка из буфера обмена (Ctrl+V / правая кнопка → «Вставить») ───
// Картинка, GIF, видео или запись, скопированные в буфер, прикрепляются к письму
// так же, как через скрепку. Текст продолжает вставляться в поле как раньше.
function handlePaste(e, key) {
  const cd = e.clipboardData;
  if (!cd || !cd.items || !cd.items.length) return;
  for (const it of cd.items) {
    if (it.kind !== 'file') continue;
    const f = it.getAsFile();
    if (!f) continue;
    e.preventDefault();
    attachFile(f, key);
    return;
  }
}
$('#input').addEventListener('paste', e => handlePaste(e, 'attach'));
$('#thread-input').addEventListener('paste', e => handlePaste(e, 'threadAttach'));
const attLabel = a => !a ? '' : (typeof a === 'string' || a.kind === 'image' ? '📷 изображение' : a.kind === 'video' ? '🎬 видео' : '📎 ' + (a.name || 'файл'));
/** pkg3-76: видео в ленте — карточка с первым кадром. До скачивания видно,
 * что за видео и сколько оно весит; во время скачивания — проценты и полоса;
 * когда готово — карточка сама заменяется плеером (upgradeMedia/loadUpload). */
function vidCardHtml(a, eco) {
  const poster = a.poster ? `<img src="${a.poster}" alt="">` : '';
  const hint = eco ? 'в экономном режиме не грузится автоматически; нажать — загрузить' : 'нажмите, чтобы скачать видео';
  return `<span class="att-file vid-card" role="button" data-upl="${a.upId}" data-parts="${a.parts || 1}" data-kind="${a.kind}" data-name="${escapeHtml(a.name || 'видео')}" data-size="${a.size || 0}" data-mime="${escapeHtml(a.mime || '')}" data-poster="${a.poster || ''}">`
    + `<span class="vd-thumb">${poster}<span class="vd-play">${SV(ICONS.play)}</span></span>`
    + `<span class="vd-info"><span class="vd-name">${escapeHtml(a.name || 'видео')}</span>`
    + `<span class="tiny muted vd-status">${fmtBytes(a.size || 0)} · ${hint}</span>`
    + `<span class="vd-bar"><i></i></span></span></span>`;
}
function attHtml(a) {
  if (!a) return '';
  const isVid = a && a !== null && typeof a === 'object' && (a.kind === 'video' || String(a.mime || '').startsWith('video/'));
  if (S.eco) {
    if (typeof a === 'string' || a.kind === 'image') return `<span class="att-file eco-hidden">${SV(ICONS.image)}<span>Картинка скрыта в экономном режиме</span></span>`;
    if (a.upId && isVid) return vidCardHtml(a, true);
    if (a.kind === 'video' || a.kind === 'audio') return `<span class="att-file eco-hidden">${SV(ICONS[a.kind === 'video' ? 'play' : 'volume'])}<span>Медиа скрыто в экономном режиме</span></span>`;
    if (a.upId) return `<span class="att-file" role="button" data-upl="${a.upId}" data-parts="${a.parts || 1}" data-kind="${a.kind}" data-name="${escapeHtml(a.name || 'файл')}" data-size="${a.size || 0}" data-mime="${escapeHtml(a.mime || '')}">${SV(ICONS[a.kind === 'video' ? 'play' : a.kind === 'audio' ? 'volume' : 'file'])}<span>${escapeHtml(a.name || 'файл')}</span><span class="tiny muted">${fmtBytes(a.size || 0)} · в экономном режиме не грузится автоматически; нажать — загрузить</span></span>`;
    return `<span class="att-file eco-hidden">${SV(ICONS.file)}<span>Вложение скрыто в экономном режиме</span></span>`;
  }
  if (typeof a === 'string') return `<img class="att" src="${a}" alt="вложение">`;
  if (a.kind === 'image') return `<img class="att" src="${a.data}" alt="вложение">`;
  if (a.upId && isVid) return vidCardHtml(a, false);
  if (a.upId) return `<span class="att-file" role="button" data-upl="${a.upId}" data-parts="${a.parts || 1}" data-kind="${a.kind}" data-name="${escapeHtml(a.name || 'файл')}" data-size="${a.size || 0}" data-mime="${escapeHtml(a.mime || '')}">${SV(ICONS[a.kind === 'video' ? 'play' : a.kind === 'audio' ? 'volume' : 'file'])}<span>${escapeHtml(a.name || 'файл')}</span><span class="tiny muted">${fmtBytes(a.size || 0)} · нажать для загрузки</span></span>`;
  if (a.kind === 'video') return `<video class="att att-vid" controls preload="metadata"${a.poster ? ` poster="${a.poster}"` : ''} src="${a.data}"></video>`;
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
async function encodeImageUnderLimit(canvas, quality, limitOverride) {
  // pkg3-76: предел можно передать свой (фон чата сервер принимает до ~350 КБ);
  // по умолчанию — предел письма из /api/state
  const limit = Number(limitOverride || S.maxUpload || DEFAULT_MAX_UPLOAD);
  const plainLimit = Math.floor(limit * UPLOAD_PLAIN_HEADROOM);
  let q = quality, cur = canvas, last = '';
  for (let attempt = 0; attempt < 30; attempt++) {
    const data = await canvasToDataURL(cur, 'image/jpeg', q);
    last = data;
    if (data.length <= plainLimit && estimatedEncryptedUploadChars(data) <= limit) return data;
    if (q > 0.5) { q = Math.max(0.5, q - 0.08); continue; }
    const w = Math.max(1, Math.round(cur.width * 0.82));
    const h = Math.max(1, Math.round(cur.height * 0.82));
    if ((w >= cur.width && h >= cur.height) || Math.max(w, h) < 64) break;
    cur = downscaleCanvas(cur, w, h);
    q = 0.72;
  }
  // pkg3-76: никогда не бросаем «фото слишком большое» — сжимаем молча до конца
  // и отправляем самый лёгкий получившийся вариант. Ошибка размера больше не
  // появляется: даже гигантский снимок ужимается до проходимых килобайт.
  return last;
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
/** pkg3-76: окно кадрирования с перетаскиванием и масштабом.
 * Раньше аватар и иконка обрезались строго по центру — голову «срезало»,
 * а поправить было нельзя. Теперь человек сам двигает фото пальцем или мышью,
 * увеличивает колёсиком/щипком/ползунком и видит, что попадёт в круг (или в
 * прямоугольник фона), ДО сохранения.
 * opts: { shape: 'circle' | 'rect', size: 320, title: '…', maxOut: 1600 }
 * Возвращает Promise<canvas|null>: null — окно закрыли без сохранения. */
function openCropDialog(file, opts) {
  const o = Object.assign({ shape: 'circle', size: 320, title: 'Обрезать фото', maxOut: 1600 }, opts || {});
  return new Promise(resolve => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => build();
    img.onerror = () => {
      URL.revokeObjectURL(url);
      toast(isHeic(file)
        ? 'Не удалось открыть HEIC/HEIF. На iPhone включите «Настройки → Камера → Форматы → Наиболее совместимый» или отправьте JPEG/PNG.'
        : 'Браузер не смог открыть эту картинку', true);
      resolve(null);
    };
    img.src = url;

    function build() {
      const ovl = document.createElement('div');
      ovl.className = 'crop-ovl';
      ovl.innerHTML = `
        <div class="crop-box">
          <div class="crop-head"><b>${escapeHtml(o.title)}</b><button class="icon" id="crop-x" title="Отменить">${SV(ICONS.x)}</button></div>
          <div class="crop-stage"><img class="crop-img" alt=""><div class="crop-frame ${o.shape === 'circle' ? 'circle' : 'rect'}"></div></div>
          <div class="crop-ctl"><span class="tiny muted">−</span><input type="range" id="crop-zoom" min="100" max="400" value="100" step="1" aria-label="Масштаб"><span class="tiny muted">+</span></div>
          <div class="tiny muted crop-hint">Тяните фото пальцем или мышью · масштаб — колёсиком, щипком или ползунком</div>
          <div class="crop-btns"><button class="primary soft" id="crop-cancel">Отменить</button><button class="primary" id="crop-ok">Готово</button></div>
        </div>`;
      document.body.appendChild(ovl);
      const stage = ovl.querySelector('.crop-stage');
      const shown = ovl.querySelector('.crop-img');
      shown.src = url;
      const nw = img.naturalWidth || img.width, nh = img.naturalHeight || img.height;
      const sw = stage.clientWidth || 400, sh = stage.clientHeight || 320;
      const fw = o.shape === 'circle' ? Math.max(80, Math.min(sw, sh) - 16) : Math.max(80, sw - 12);
      const fh = o.shape === 'circle' ? fw : Math.max(60, sh - 12);
      const frame = ovl.querySelector('.crop-frame');
      frame.style.width = fw + 'px'; frame.style.height = fh + 'px';
      const s0 = Math.max(fw / nw, fh / nh);
      let zoom = 1, ox = 0, oy = 0;
      const dw = () => nw * s0 * zoom, dh = () => nh * s0 * zoom;
      function apply() {
        zoom = Math.min(4, Math.max(1, zoom));
        const mx = Math.max(0, (dw() - fw) / 2), my = Math.max(0, (dh() - fh) / 2);
        ox = Math.min(mx, Math.max(-mx, ox)); oy = Math.min(my, Math.max(-my, oy));
        shown.style.width = dw() + 'px'; shown.style.height = dh() + 'px';
        shown.style.marginLeft = -dw() / 2 + 'px'; shown.style.marginTop = -dh() / 2 + 'px';
        shown.style.transform = `translate(${ox}px, ${oy}px)`;
        const z = ovl.querySelector('#crop-zoom');
        if (z && document.activeElement !== z) z.value = String(Math.round(zoom * 100));
      }
      apply();
      // перетаскивание и щипок двумя пальцами — указательными событиями (мышь+тач)
      const pts = new Map();
      let pinch0 = null;
      stage.addEventListener('pointerdown', e => {
        try { stage.setPointerCapture(e.pointerId); } catch (err) {}
        pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pts.size === 2) {
          const [a, b] = [...pts.values()];
          pinch0 = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom };
        }
        e.preventDefault();
      });
      stage.addEventListener('pointermove', e => {
        const p = pts.get(e.pointerId); if (!p) return;
        const dx = e.clientX - p.x, dy = e.clientY - p.y;
        p.x = e.clientX; p.y = e.clientY;
        if (pts.size >= 2 && pinch0) {
          const [a, b] = [...pts.values()];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (pinch0.d > 0) { zoom = pinch0.zoom * d / pinch0.d; apply(); }
          return;
        }
        ox += dx; oy += dy; apply();
      });
      const drop = e => { pts.delete(e.pointerId); if (pts.size < 2) pinch0 = null; };
      stage.addEventListener('pointerup', drop);
      stage.addEventListener('pointercancel', drop);
      stage.addEventListener('wheel', e => { e.preventDefault(); zoom *= e.deltaY < 0 ? 1.08 : 1 / 1.08; apply(); }, { passive: false });
      ovl.querySelector('#crop-zoom').addEventListener('input', e => { zoom = Number(e.target.value) / 100; apply(); });
      const esc = e => { if (e.key === 'Escape') close(null); };
      document.addEventListener('keydown', esc);
      ovl.addEventListener('click', e => { if (e.target === ovl) close(null); });
      ovl.querySelector('#crop-x').addEventListener('click', () => close(null));
      ovl.querySelector('#crop-cancel').addEventListener('click', () => close(null));
      ovl.querySelector('#crop-ok').addEventListener('click', () => {
        try {
          const s = s0 * zoom;
          const ix = (sw - dw()) / 2 + ox, iy = (sh - dh()) / 2 + oy;  // левый верх фото на сцене
          const fx = (sw - fw) / 2, fy = (sh - fh) / 2;                // левый верх рамки
          const sx = Math.max(0, Math.min(nw - 1, (fx - ix) / s));
          const sy = Math.max(0, Math.min(nh - 1, (fy - iy) / s));
          const cw = Math.max(1, Math.min(nw - sx, fw / s));
          const ch = Math.max(1, Math.min(nh - sy, fh / s));
          const k = o.shape === 'circle' ? o.size / fw : Math.min(1, o.maxOut / Math.max(cw, ch));
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(cw * k)); c.height = Math.max(1, Math.round(ch * k));
          const ctx = c.getContext('2d', { alpha: false });
          if (!ctx) throw new Error('Браузер не дал доступ к canvas');
          ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(img, sx, sy, cw, ch, 0, 0, c.width, c.height);
          close(c);
        } catch (ex) {
          close(null);
          toast(ex && ex.message ? ex.message : 'Не удалось обрезать фото', true);
        }
      });
      let done = false;
      function close(result) {
        if (done) return;
        done = true;
        document.removeEventListener('keydown', esc);
        try { ovl.remove(); } catch (e) {}
        try { URL.revokeObjectURL(url); } catch (e) {}
        resolve(result);
      }
    }
  });
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
/** pkg3-42: на телефоне в чат-игре строка поиска скрыта (правило
 * `#main.game-mode .search-wrap` в styles.css) — значит, и список результатов
 * показывать нельзя: крестик «очистить» уехал вместе с полем, и список повис бы
 * незакрываемым. Гасим его при входе в игру и при повороте экрана. */
function searchBarHidden() {
  const c = curChat();
  return !!(c && c.kind === 'game' && window.matchMedia('(max-width:959px)').matches);
}
function syncSearchVisibility() {
  if (!searchBarHidden()) return;
  const box = $('#search-results');
  hide(box); box.innerHTML = '';
}
async function runSearch() {
  const q = $('#search').value.trim().toLowerCase();
  if (searchBarHidden()) { syncSearchVisibility(); return; }
  if (q && !S.searchReady) {
    toast('Готовлю поиск по всей истории…');
    await decryptAll(S.messages);
    S.searchReady = true;
  }
  const box = $('#search-results');
  if (!q) { hide(box); box.innerHTML = ''; return; }
  // pkg3-48: людей ищем на сервере по всему мессенджеру — синхронизация отдаёт
  // каждому только его круг, поэтому незнакомца видно лишь через поиск
  let people = [];
  try { people = (await api('/api/search?q=' + encodeURIComponent(q))).users || []; } catch (e) { people = []; }
  const words = q.split(/\s+/).filter(Boolean);
  const hits = [];
  for (let i = S.messages.length - 1; i >= 0 && hits.length < 300; i--) {
    const m = S.messages[i], p = S.plain.get(m.id);
    if (!p || !p.text) continue;
    const low = p.text.toLowerCase();
    if (words.every(w => low.includes(w))) hits.push({ m, p });
  }
  box.innerHTML =
    (people.length ? `<div class="sr-head">Люди по нику — ${people.length}</div>` + people.map(u => {
      return `<div class="sr" style="display:flex;align-items:center;gap:8px">
        <div style="flex:1;min-width:0">
          <b>${escapeHtml(u.name)}</b>${u.isAdmin ? '<span class="tag-admin">адм</span>' : ''}
          <span class="tiny muted">${isOnline(u) ? 'в сети' : 'был(а) ' + escapeHtml(fmtAgo(u.lastSeen))}</span>
        </div>
        <button class="btn sm" data-peer="${u.id}">написать</button>
      </div>`;
    }).join('') : '') +
    `<div class="sr-head">Найдено ${hits.length}${hits.length >= 300 ? '+' : ''} — нажмите, чтобы перейти</div>` +
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
  const go = e.target.closest('[data-go]');
  if (go) { goToMessage(go.dataset.go); return; }
  const peer = e.target.closest('[data-peer]');
  if (peer) {
    // пишем человеку, найденному поиском: создаётся личный чат, и после
    // синхронизации собеседник попадает в «Личные чаты»
    (async () => {
      try {
        const r = await api('/api/dm', { method: 'POST', body: { peer: peer.dataset.peer } });
        hide($('#search-results')); $('#search').value = '';
        await sync();
        openChat(r.chat.id);
      } catch (ex) { toast(ex.message, true); }
    })();
    return;
  }
  // pkg3-60: кнопки «в Приглашенные» в поиске больше нет (раздел убран)
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
  pushReady = st === 'on';             // pkg3-40: тумблер в настройках — тоже точка правды о пуше
  pushCheckedAt = Date.now();
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
  refreshPushReady();                  // pkg3-40: доска сразу узнаёт, можно ли ей спать
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
        <div class="tiny muted" style="margin-top:6px">фото можно двигать и увеличивать — обрежется в круг; шифруется</div>
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
    <button class="primary" id="pf-save-pass">Сменить пароль</button>
    <div class="divider"><span>Почта для восстановления</span></div>
    <div id="pf-mail"><div class="tiny muted">Загружаем…</div></div>`);
  paintPfMail();   // pkg3-64: привязка почты и код восстановления

  $('#pf-file').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    e.target.value = '';
    try {
      // pkg3-76: кадрируем с перетаскиванием и масштабом — круг человек видит заранее
      const canvas = await openCropDialog(f, { shape: 'circle', size: 320, title: 'Ваш аватар' });
      if (!canvas) return;
      const data = await canvasToDataURL(canvas, 'image/jpeg', 0.85);
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
    <p class="hint" id="ad-mem-main">Занято ${fmtBytes(S.usage.bytes)} из ${fmtBytes(S.usage.limit)} (${S.usage.percent}%).</p>
    <p class="hint" id="ad-mem-parts">Из чего состоит: ${usagePartsText(S.usage) || '—'}.</p>
    <p class="hint">Шкала загрузки — слева под списком чатов; сюда подробности переехали, чтобы не мельтешили под рукой. Архивами управляет создатель каждого чата (меню «⋯» в чате).</p>
    <div class="divider"><span>Резервная копия</span></div>
    <p class="hint" id="ad-bk-where">Проверяю облачное хранилище…</p>
    <button class="primary" id="ad-bk-make">Сохранить копию в облако</button>
    <div class="err" id="ad-bk-err"></div>
    <div id="ad-bk-list"></div>`);
  renderAdminUsers();
  initBackups();
  renderMemory();

  $('#ad-users').addEventListener('click', async e => {
    const b = e.target.closest('button[data-id]'); if (!b) return;
    try {
      if (b.dataset.act === 'del') {
        if (!confirm('Исключить участника из мессенджера? Он потеряет доступ ко всем чатам, а личные переписки и игры с ним удалятся безвозвратно.')) return;
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
    const r = await api('/api/admin/restore', { method: 'POST', timeout: 180000, body: { key, codeProof: await codeProofOf(word) } });
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
      method: 'POST', timeout: 180000, body: { step: 'fin', id: init.id, codeProof: await codeProofOf(word) }
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
        const r = await api('/api/admin/backup', { method: 'POST', timeout: 180000 });
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
/** Положить в локальную память только что отправленное сообщение:
 *  курсор кэша darf идти вперёд только вместе с сохранённым телом. */
function cacheMsg(m) {
  if (!S.idb || !S.cacheFp || !m) return;
  S.idb.applySync(S.cacheFp, {
    messages: [pickMsg(m)],
    meta: { me: S.uid, seq: Math.max(S.seq || 0, m.seq || 0), gen: S.gen, chg: S.chg, rsince: S.rsince }
  });
}
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
  const list = S.messages.filter(m => plainBroken(m.id) && m.blob);
  if (!list.length) return;
  for (let i = 0; i < list.length; i += 96) {
    const part = list.slice(i, i + 96);
    await decryptSmart(part);
    const done = Math.min(list.length, i + part.length);
    loadUi.show('Расшифровываем на устройстве', done / list.length * 100, done + ' из ' + list.length);
    renderMessages();   // pkg3-37: точечно заменяем «…» на текст, без прыжков ленты
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
document.addEventListener('click', async e => {
  const sq = e.target.closest('[data-sq]');
  if (sq) { await onBoardClick(sq.dataset.sq); return; }
  // pkg3-56: морской бой — свои клетки и кнопки
  const sbc = e.target.closest('[data-sbcell]');
  if (sbc) { await onSbCell(sbc); return; }
  if (e.target.closest('#sb-rot')) { sbToggleRot(); return; }
  if (e.target.closest('#sb-rand')) { sbRandom(); return; }
  if (e.target.closest('#sb-clear')) { sbClear(); return; }
  if (e.target.closest('#sb-go')) { await sbCommitSend(); return; }
  const sbt = e.target.closest('[data-sb-tab]');
  if (sbt) { S.sbTab = sbt.dataset.sbTab; S.boardSig = ''; renderBoard(); return; }
  if (e.target.closest('#gm-leave')) { await leaveGameSmart(); return; }
  if (e.target.closest('#gm-knocks')) { openKnocks(curChat()); return; }
  // pkg3-61: принятое приглашение — вход в игру, пока её не удалили
  const ge = e.target.closest('[data-game-enter]');
  if (ge) {
    const gid = ge.dataset.gameEnter;
    if (chatById(gid)) openChat(gid);
    else toast('Игры больше нет — её удалили', true);
    return;
  }
  const acc = e.target.closest('[data-game-accept]');
  if (acc) {
    acc.disabled = true; acc.textContent = 'Входим…';
    const decBtn = acc.parentElement.querySelector('[data-game-decline]');
    if (decBtn) decBtn.disabled = true;
    try { await acceptGame(acc.dataset.gameAccept, acc.dataset.choice, acc.dataset.rules); }
    catch (ex) { toast(ex.message, true); acc.disabled = false; acc.textContent = 'Войти в игру'; if (decBtn) decBtn.disabled = false; }
    return;
  }
  const dec = e.target.closest('[data-game-decline]');
  if (dec) { try { await declineGame(dec.dataset.gameDecline, dec.dataset.rules); } catch (ex) { toast(ex.message, true); } return; }
  const kb = e.target.closest('[data-knock-btn]');
  if (kb) {
    e.stopPropagation();
    try { await api('/api/games/' + kb.dataset.knockBtn + '/knock', { method: 'POST', body: {} }); toast('Заявка отправлена игрокам'); await sync(false); renderRail(); }
    catch (ex) { toast(ex.message, true); }
    return;
  }
  const ka = e.target.closest('[data-knock-approve]');
  if (ka) {
    const c = curChat();
    const ck = await chatKeyOf(c);
    const pk = await pairKeyWith(ka.dataset.knockApprove);
    const blob = await aesEncryptBytes(pk, ck.raw);
    await api('/api/games/' + c.id + '/knock/approve', { method: 'POST', body: { uid: ka.dataset.knockApprove, blob } });
    hide($('#modal'));
    await sync(false); renderAll();
    toast('Зритель допущен в игру');
    return;
  }
  const kr = e.target.closest('[data-knock-reject]');
  if (kr) {
    const c = curChat();
    await api('/api/games/' + c.id + '/knock/reject', { method: 'POST', body: { uid: kr.dataset.knockReject } });
    hide($('#modal'));
    await sync(false); renderAll();
    return;
  }
});
$('#btn-dropcache').addEventListener('click', async () => {
  if (!confirm('Стереть кэш переписки с этого устройства?\n\nПереписка останется в облаке; следующая загрузка вытянет её оттуда заново.')) return;
  if (S.idb) await S.idb.clear();
  toast('Локальный кэш стёрт');
});

// ─────────────────────────────────────────── оформление: тема, плотность, гамма
function currentPal() {
  return document.documentElement.dataset.pal || 'synth';   // pkg3-34: «Синтвейв» — гамма по умолчанию
}
function metaThemeColor() {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  const dark = document.documentElement.dataset.theme === 'dark';
  const inApp = document.documentElement.dataset.inApp === '1';
  if (inApp && currentPal() === 'synth') { meta.setAttribute('content', '#0d0221'); return; }
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
function applyEco(on, save) {
  S.eco = !!on;
  if (S.eco) document.documentElement.dataset.eco = '1';
  else delete document.documentElement.dataset.eco;
  if (save !== false) { try { localStorage.setItem('sega.eco', S.eco ? '1' : '0'); } catch (e) {} }
  const sw = $('#sw-eco');
  if (sw) sw.checked = S.eco;
  if (S.view) { applyWallBackground(); S.sig = ''; renderMessages(true); }
  renderRail();
}
function applyPalette(id, save) {
  const pal = palById(id);
  document.documentElement.dataset.pal = pal.id;
  // «Синтвейв» живёт только в тёмной теме — включаем её вместе с гаммой (pkg3-34)
  if (pal.id === 'synth' && document.documentElement.dataset.theme !== 'dark') applyTheme('dark');
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
  const ar = $('#row-admin-invites');   // pkg3-45: админский экран виден только администратору
  if (ar) ar.style.display = (S.me && S.me.isAdmin) ? '' : 'none';
  const swD = $('#sw-dark'); if (swD) swD.checked = document.documentElement.dataset.theme === 'dark';
  const swE = $('#sw-eco'); if (swE) swE.checked = !!S.eco;
  renderNotifyControls();
  show($('#sheet-settings'));
  const bt = $('#build-tag');
  if (bt) bt.textContent = 'Интерфейс: ' + BUILD + ' · Сервер: ' + (S.serverBuild || 'без метки')
    + (S.serverLabel ? ' · ' + S.serverLabel : '');
  // pkg3-72: строка-диагностика истории ключей — видно без консоли, доехали ли ключи
  const okt = $('#oldkeys-tag');
  if (okt) {
    let n = 0, m = 0;
    for (const cc of S.chats) if (cc.kind === 'group') { n += oldKeysOf(cc.id).length; m += (cc.oldKeys || []).length; }
    // pkg3-72/73: видно без консоли, доехали ли ключи и всё ли выложено на
    // сервер (M >= N значит друзья получат историю сами, без ручных передач)
    okt.textContent = 'Ключи групп: история ' + n + ' · на сервере ' + m;
  }
  refreshPushSwitch();
}
// ── pkg3-72: перенос набора ключей групп между устройствами без консоли ──
const bkCopyBtn = $('#btn-oldkeys-copy');   // pkg3-73: null-защита на стыке кэшей
if (bkCopyBtn) bkCopyBtn.addEventListener('click', async () => {
  const out = { chats: [] };
  for (const c of S.chats) {
    if (c.kind !== 'group') continue;
    const seen = {}; const raws = [];
    for (const o of oldKeysOf(c.id)) { if (o && o.raw) { const b = toB64(o.raw); if (!seen[b]) { seen[b] = 1; raws.push(b); } } }
    const cur = S.chatKeys.get(c.id);
    if (cur && cur.raw) { const b = toB64(cur.raw); if (!seen[b]) { seen[b] = 1; raws.push(b); } }
    if (raws.length) out.chats.push({ id: c.id, keys: raws.map((b, i) => ({ ep: Math.max((c.keyEpoch || 0) - 1 - i, 0), raw: b })) });
  }
  const n = out.chats.reduce((a, c2) => a + c2.keys.length, 0);
  try {
    await navigator.clipboard.writeText(JSON.stringify(out));
    toast('Набор ключей скопирован (' + n + ' шт.). Вставьте его в настройках другого устройства: «Вставить набор ключей групп»');
  } catch (e) { toast('Не удалось скопировать: ' + e.message, true); }
  closeSettings();
});
const bkPasteBtn = $('#btn-oldkeys-paste');   // pkg3-73: null-защита на стыке кэшей
if (bkPasteBtn) bkPasteBtn.addEventListener('click', () => {
  closeSettings();
  modal('Ключи групп', '<textarea id="bk-in" style="width:100%;height:140px" placeholder="Сюда вставьте скопированный набор"></textarea>'
    + '<div style="margin-top:10px"><button class="primary" id="bk-go">Применить и перезапустить</button></div>');
  $('#bk-go').addEventListener('click', () => {
    let src = null;
    try { src = JSON.parse($('#bk-in').value.trim()); } catch (e) { return toast('Не распознал набор: проверьте, что он скопирован целиком', true); }
    const uid = (S.me && S.me.id) || S.uid;
    if (!uid || !src || !Array.isArray(src.chats)) return toast('Набор пуст', true);
    const all = loadOldKeysRaw();
    const per = all[uid] || (all[uid] = {});
    let n = 0;
    for (const ch of src.chats) {
      if (!ch || !ch.id || !Array.isArray(ch.keys)) continue;
      const curList = per[ch.id] || (per[ch.id] = []);
      for (const k of ch.keys) {
        if (!k || typeof k.raw !== 'string' || !k.raw) continue;
        if (!curList.some(x => x.raw === k.raw)) { curList.push({ ep: (typeof k.ep === 'number' ? k.ep : null), raw: k.raw }); n++; }
      }
    }
    try { localStorage.setItem(OLDKEYS_STORE, JSON.stringify(all)); } catch (e) { return toast('Не удалось сохранить набор', true); }
    hide($('#modal'));
    toast('Добавлено ключей: ' + n + '. Перезапускаю…');
    setTimeout(() => location.reload(), 1200);
  });
});
function closeSettings() { hide($('#sheet-settings')); }
$('#btn-admin-invites').addEventListener('click', openAdminInvites);       // pkg3-45
// ── pkg3-45: персональные приглашения (ссылка + QR + пересылка) ────────────
const fmtDur = ms => {
  const m = Math.max(1, Math.round(ms / 60000));
  return m >= 60 ? Math.floor(m / 60) + ' ч ' + (m % 60) + ' мин' : m + ' мин';
};
// pkg3-49: «осталось N ч» — счётчик суток в разделе «Новые»
const fmtLeft = ms => {
  const left = Math.max(0, ms - (S.serverNow || Date.now()));
  const h = Math.floor(left / 3600000);
  if (h >= 1) return 'осталось ' + h + ' ч';
  return 'осталось ' + Math.max(1, Math.round(left / 60000)) + ' мин';
};
// pkg3-49: плашка над лентой личного чата из раздела «Новые»:
// счётчик суток + кнопка «Добавить пользователя в мои личные чаты», а если сохранил
// собеседник — отметка об этом.
function renderDmBanner() {
  const el = $('#dm-banner');
  if (!el) return;
  const c = curChat();
  if (!c || (c.kind !== 'dm' && c.kind !== 'group') || S.dmSaved.has(c.id)) { hide(el); el.innerHTML = ''; return; }
  const cd = c.newUntil ? ` <span data-bncd="${escapeHtml(c.id)}">(${escapeHtml(fmtLeft(c.newUntil))})</span>` : '';
  // pkg3-54: групповой чат из «Новых» — оставить у себя или отклонить
  if (c.kind === 'group') {
    if (!c.newUntil) { hide(el); el.innerHTML = ''; return; }
    el.innerHTML =
      `<div class="dm-bn-text">👥 Вас добавили в групповой чат. Он живёт в разделе «Новые»${cd};
      если не оставить его у себя, через срок он исчезнет из вашего списка.</div>
      <button class="mini primary" id="dm-save-btn">Оставить в моих чатах</button>
      <button class="mini" id="dm-decline-btn">Отклонить</button>`;
    show(el);
    return;
  }
  const peer = userById(dmPeer(c));
  const pname = peer ? displayName(peer) : 'Собеседник';
  const theySaved = (c.savedBy || []).includes(peer && peer.id);
  el.innerHTML =
    `<div class="dm-bn-text">💬 ${escapeHtml(pname)} написал(а) вам впервые. Чат удалится сам через 7 суток` +
    cd + ` — у собеседника он сохранится в любом случае.</div>
    <button class="mini primary" id="dm-save-btn">Добавить в мои личные чаты</button>
    <button class="mini" id="dm-decline-btn">Отклонить</button>
    ${theySaved ? '<div class="dm-bn-note">✓ Вы в личных чатах у собеседника</div>' : ''}`;
  show(el);
}
// pkg3-49: одна команда «сохранить чат» для плашки и для меню «⋯»
async function saveDmChat(c) {
  if (!c) return;
  try {
    await api('/api/chats/' + c.id + '/save', { method: 'POST', body: {} });
    api('/api/notify', { method: 'POST', body: { kind: 'saved', chat: c.id } }).catch(() => {});
    await sync(false);
    renderAll();
    toast('Чат добавлен в ваши личные чаты навсегда. Собеседник видит, что вы его сохранили');
  } catch (ex) { toast(ex.message, true); }
}
/** pkg3-54/60: «Отклонить» — чат из «Новых» исчезает; новое письмо собеседника
 * вернёт его обратно в «Новые» с новым отсчётом (решение владельца, pkg3-60). */
async function declineChat(c) {
  if (!c) return;
  if (!confirm('Отклонить этот чат?\n\nОн исчезнет из вашего списка. Если собеседник напишет снова, чат вернётся в раздел «Новые» — снова на 7 суток, пока вы не примете решение.')) return;
  try {
    await api('/api/chats/' + c.id + '/decline', { method: 'POST', body: {} });
    await sync(false);
    S.view = null; S.sig = '';
    renderAll();
    toast('Чат отклонён');
  } catch (ex) { toast(ex.message, true); }
}
document.addEventListener('click', e => {
  if (e.target.closest('#dm-save-btn')) saveDmChat(curChat());
  if (e.target.closest('#dm-decline-btn')) declineChat(curChat());
});
// счётчики «Новых» тикают раз в минуту без полной перерисовки списков
setInterval(() => {
  const c = curChat();
  if (c && (c.kind === 'dm' || c.kind === 'group') && c.newUntil && !S.dmSaved.has(c.id)) {
    const b = document.querySelector('[data-bncd]');
    if (b) b.textContent = '(' + fmtLeft(c.newUntil) + ')';
  }
  for (const t of document.querySelectorAll('[data-newcd]')) {
    const ch = chatById(t.dataset.newcd);
    if (ch && ch.newUntil) t.textContent = 'новых · ' + fmtLeft(ch.newUntil);
  }
}, 60000);
function qrSvg(text) {
  // вендоренный qrcode-generator (MIT, Kazuhiko Arase): сеть не нужна
  const qr = window.qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}
async function openInviteFriend() {
  hide($('#sheet-settings'));
  let st;
  try { st = await api('/api/invites'); } catch (e) { toast(e.message, true); return; }
  const STATE = { live: 'жива', used: 'использована', expired: 'истекла', revoked: 'отозвана' };
  const rows = st.invites.map(i => `<div class="inv-row">
      <div class="ci-main"><div class="ci-name">${STATE[i.state] || i.state}${i.usedByName ? ' · вошёл: ' + escapeHtml(i.usedByName) : ''}</div>
      <div class="ci-last">${fmtDay(i.createdAt)}, ${fmtTime(i.createdAt)}${i.state === 'live' ? ' · действительна до ' + fmtTime(i.expiresAt) : ''}</div></div>
      ${i.state === 'live' ? `<button class="mini danger" data-inv-revoke="${escapeHtml(i.id)}">отозвать</button>` : ''}
    </div>`).join('') || '<div class="tiny muted">Ссылок ещё не было.</div>';
  const wait = st.nextAt > Date.now();
  modal('Пригласить по ссылке', `
    <p class="hint">Ссылка персональная: по ней регистрируется <b>один</b> человек и только
    в течение суток. Секрет ссылки не хранится на сервере, поэтому показать её повторно
    нельзя — перешлите или скопируйте сразу.</p>
    ${st.blocked ? '<div class="hint">Администратор запретил вам создавать приглашения.</div>' : ''}
    ${wait ? `<div class="hint">Одна ссылка в сутки: следующая через ${fmtDur(st.nextAt - Date.now())}.</div>` : ''}
    <button class="primary" id="inv-create" ${st.blocked || wait ? 'disabled' : ''}>Создать ссылку</button>
    <div id="inv-box" class="hidden">
      <div class="qr-box" id="inv-qr"></div>
      <input id="inv-link" class="inv-link" readonly>
      <div class="bph-btns"><button class="mini primary" id="inv-share">Переслать</button>
      <button class="mini" id="inv-copy">Скопировать</button></div>
    </div>
    <div class="divider"><span>Мои ссылки</span></div>
    <div id="inv-list">${rows}</div>
    <div class="divider"><span>Найти по нику</span></div>
    <p class="hint">Поиск идёт по всем участникам мессенджера: ник уникален,
    поэтому найдётся именно тот человек. «Написать» открывает личный чат,
    «в мои приглашенные» шлёт запрос с его согласием (нужна общая группа).</p>
    <input id="inv-find" type="search" placeholder="ник или имя…" autocomplete="off">
    <div id="inv-find-res" class="bp-moves-list" style="max-height:170px"><div class="mv-empty">Начните печатать</div></div>`);
  // pkg3-48: «Найти по нику» спрашивает СЕРВЕР (/api/search) — синхронизация
  // отдаёт каждому только его круг, поэтому незнакомца в S.users больше нет.
  // Часто печатать — не часто спрашивать: запрос уходит через 350 мс после
  // последней буквы, а рисуется только самый свежий ответ (защита от гонки).
  let findSeq = 0, findDone = '', findTimer = 0;
  const paintFind = async (force) => {
    const box = $('#inv-find-res');
    if (!box) return;
    const q = ($('#inv-find').value || '').trim();
    if (!q) { findSeq++; findDone = ''; box.innerHTML = '<div class="mv-empty">Начните печатать</div>'; return; }
    if (!force && q.toLowerCase() === findDone) return;   // этот ник уже показан
    const seq = ++findSeq;
    box.innerHTML = '<div class="mv-empty">Ищу…</div>';
    let people = [];
    try { people = (await api('/api/search?q=' + encodeURIComponent(q))).users || []; }
    catch (e) { if (seq === findSeq) box.innerHTML = '<div class="mv-empty">Не получилось поискать — попробуйте чуть позже</div>'; return; }
    if (seq !== findSeq) return;                            // в пути уже более свежий запрос
    if (($('#inv-find') || {}).value === undefined) return; // окно закрыли — рисовать негде
    if ((($('#inv-find').value || '').trim()) !== q) return; // поле изменилось, пока ждали ответ
    findDone = q.toLowerCase();
    box.innerHTML = people.length ? people.map(u => {
      // pkg3-60: «в мои приглашенные» убрано (раздел «Приглашенные» снят) —
      // остаётся только «написать»: личный чат и так свяжет вас
      return `<div class="mrow-mv"><span class="mv-w">${escapeHtml(displayName(u))}</span>
        <span class="mv-b"><button class="mini" data-find-dm="${u.id}">написать</button>
        </span></div>`;
    }).join('') : '<div class="mv-empty">Никого не нашёл по такому нику</div>';
  };
  $('#inv-find').addEventListener('input', () => { clearTimeout(findTimer); findTimer = setTimeout(() => paintFind(), 350); });
  $('#modal').addEventListener('click', async e => {
    const fdm = e.target.closest('[data-find-dm]');
    if (fdm) {
      hide($('#modal'));
      try { const r = await api('/api/dm', { method: 'POST', body: { peer: fdm.dataset.findDm } }); await sync(); openChat(r.chat.id); }
      catch (ex) { toast(ex.message, true); }
      return;
    }
    // pkg3-60: запросов «в мои приглашенные» больше нет (раздел убран)
  });
  let lastLink = '';
  const putLink = link => {
    lastLink = link;
    show($('#inv-box'));
    $('#inv-link').value = link;
    $('#inv-qr').innerHTML = qrSvg(link);
  };
  $('#inv-create').addEventListener('click', async () => {
    try {
      const secret = toHex(crypto.getRandomValues(new Uint8Array(24)));
      const invSalt = newSalt();
      const wrappedRoomKey = await aesEncryptBytes(await aesKeyFrom(secret, invSalt), S.roomKeyRaw);
      const secretHash = toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)));
      const r = await api('/api/invites', { method: 'POST', body: { invSalt, wrappedRoomKey, secretHash } });
      putLink(location.origin + (BASE || '') + '/#join=' + r.invite.id + '.' + secret);
      toast('Ссылка готова: перешлите или покажите QR');
    } catch (e) { toast(e.message, true); }
  });
  $('#inv-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(lastLink); toast('Ссылка скопирована'); }
    catch (e) { $('#inv-link').select(); document.execCommand && document.execCommand('copy'); toast('Ссылка скопирована'); }
  });
  $('#inv-share').addEventListener('click', async () => {
    if (navigator.share) { try { await navigator.share({ title: 'SEGA-CHAT', text: 'Приглашение в мессенджер', url: lastLink }); return; } catch (e) { if (e && e.name === 'AbortError') return; } }
    try { await navigator.clipboard.writeText(lastLink); toast('Ссылка скопирована — вставьте в любое сообщение'); } catch (e) { toast('Не удалось переслать: скопируйте ссылку руками', true); }
  });
  $('#modal').addEventListener('click', async e => {
    const rv = e.target.closest('[data-inv-revoke]');
    if (!rv) return;
    try { await api('/api/invites/' + rv.dataset.invRevoke + '/revoke', { method: 'POST', body: {} }); toast('Ссылка отозвана'); openInviteFriend(); }
    catch (ex) { toast(ex.message, true); }
  });
}

// ── pkg3-45: администратору — дерево приглашений, блокировки, аварийное окно
async function openAdminInvites() {
  hide($('#sheet-settings'));
  let d;
  try { d = await api('/api/admin/invites'); } catch (e) { toast(e.message, true); return; }
  // pkg3-48: защита от неполного ответа — раньше окно не открывалось вовсе, если
  // в облачной базе политика приглашений лежала пустой (null)
  d.users = d.users || []; d.invites = d.invites || []; d.log = d.log || [];
  const pol = d.policy || { globalOff: false, blockedUsers: [], blockedChats: [] };
  pol.blockedUsers = pol.blockedUsers || []; pol.blockedChats = pol.blockedChats || [];
  S.adminInv = d;   // pkg3-59: данные окна — для меню «⋮» у участника
  // pkg3-62: у слитой учётки показываем имя той, чью внешность она носит,
  // и честную подпись — одна строка не выглядит «вторым человеком»
  const rawNameOf = id => (d.users.find(u => u.id === id) || {}).name || '?';
  const nameOf = id => id === 'root' ? 'основатели' : id === 'code' ? 'аварийный вход'
    : rawNameOf(id);
  const shownName = u => u.displayAs
    ? (rawNameOf(u.displayAs) + ' <span class="tiny muted">(слита: прежняя учётка «' + escapeHtml(u.name) + '»)</span>')
    : escapeHtml(u.name);
  const kids = {};
  for (const u of d.users) (kids[u.invitedBy] = kids[u.invitedBy] || []).push(u);
  // pkg3-59: значки состояния и меню «⋮» рядом с каждым участником дерева
  const meId0 = (S.me && S.me.id) || null;
  const uMarks = u => ((u.bannedUntil || 0) > Date.now() ? ' <span class="tag-new" title="Доступ ограничен на сутки по жалобе">⛔ бан</span>' : '')
    + (pol.blockedUsers.includes(u.id) ? ' <span class="tag-grp" title="Запрещено приглашать других">🚫 звать</span>' : '')
    + (u.displayAs ? ' <span class="tag-grp" title="Носит имя и аватар другой учётки (поглощена)">👤 слита</span>' : '');
  const uMenu = u => u.id === meId0 ? ''
    : ` <button class="sec-dots" data-umenu="${escapeHtml(u.id)}" title="Управление участником">⋮</button>`;
  let tree = '';
  const walk = (id, depth) => (kids[id] || [])
    .sort((a, b) => a.createdAt - b.createdAt)
    .forEach(u => {
      tree += `<div class="tr-row" style="padding-left:${depth * 14}px">↳ ${shownName(u)}
        <span class="tiny muted">· ${fmtDay(u.createdAt)}</span>${uMarks(u)}${uMenu(u)}</div>`;
      walk(u.id, depth + 1);
    });
  (kids.root || []).forEach(u => {
    tree += `<div class="tr-row"><b>${escapeHtml(u.name)}</b> <span class="tiny muted">· основатель</span>${uMarks(u)}${uMenu(u)}</div>`;
    walk(u.id, 1);
  });
  (kids.code || []).forEach(u => {
    tree += `<div class="tr-row">↳ ${escapeHtml(u.name)} <span class="tiny muted">· аварийный вход</span>${uMarks(u)}${uMenu(u)}</div>`;
    walk(u.id, 1);
  });
  const groups = S.chats.filter(c => c.kind === 'group');
  const emOpen = d.emergencyRegUntil > Date.now();
  modal('Приглашения: дерево и блокировки', `
    <div class="divider"><span>Дерево приглашений</span></div>
    <div class="bp-moves-list" style="max-height:180px">${tree || '<div class="mv-empty">Пока пусто</div>'}</div>
    <div class="divider"><span>Кому запрещено приглашать</span></div>
    <p class="hint" style="margin:2px 0 8px">Отдельному участнику запрет ставится в меню «⋮» рядом с его именем в дереве.</p>
    <label class="row-check"><input type="checkbox" id="pol-global" ${pol.globalOff ? 'checked' : ''}>
      <span>Запретить всем, кроме администраторов</span></label>
    ${groups.map(c => `<label class="row-check"><input type="checkbox" data-pol-chat="${c.id}" ${pol.blockedChats.includes(c.id) ? 'checked' : ''}>
      <span>Запретить группе: ${escapeHtml(chatTitle(c))}</span></label>`).join('') || '<div class="tiny muted">Групп пока нет.</div>'}
    <button class="primary" id="pol-save">Сохранить блокировки</button>
    <div class="divider"><span>Аварийная регистрация по кодовой фразе</span></div>
    <p class="hint">${emOpen ? 'Открыта до ' + fmtTime(d.emergencyRegUntil) + '.' : 'Закрыта.'}
    Включённая, открывает регистрацию по кодовой фразе на один час; каждое переключение пишется в журнал.</p>
    <button class="mini ${emOpen ? 'danger' : ''}" id="em-toggle">${emOpen ? 'Закрыть сейчас' : 'Открыть на 1 час'}</button>
    <div class="divider"><span>Журнал</span></div>
    <div class="bp-moves-list" style="max-height:140px">${d.log.slice().reverse().map(e =>
      `<div class="mrow-mv"><span class="mv-w">${fmtDay(e.at)} ${fmtTime(e.at)}</span><span class="mv-b">${escapeHtml((d.users.find(u => u.id === e.by) || {}).name || '?')}</span><span>${escapeHtml(e.what)}</span></div>`).join('') || '<div class="mv-empty">Журнал пуст</div>'}</div>`);
  // pkg3-59: «⋮» в строках дерева — слушатель на карточке окна, со снятием
  // прежнего (иначе накапливается и меню открывается дважды — урок pkg3-53)
  const mEl = $('#modal');
  mEl.removeEventListener('click', adminTreeClick);
  mEl.addEventListener('click', adminTreeClick);
  $('#pol-save').addEventListener('click', async () => {
    // pkg3-60: списка галочек по участникам здесь больше нет (они в меню «⋮») —
    // сохранение общих блокировок НЕ должно стирать запреты, поставленные через меню
    const blockedUsers = pol.blockedUsers || [];
    const blockedChats = [...document.querySelectorAll('[data-pol-chat]')].filter(x => x.checked).map(x => x.dataset.polChat);
    try {
      await api('/api/admin/invite-policy', { method: 'POST', body: { globalOff: $('#pol-global').checked, blockedUsers, blockedChats } });
      toast('Политика приглашений сохранена'); openAdminInvites();
    } catch (e) { toast(e.message, true); }
  });
  $('#em-toggle').addEventListener('click', async () => {
    try {
      await api('/api/admin/emergency-reg', { method: 'POST', body: { open: !emOpen } });
      toast(emOpen ? 'Аварийное окно закрыто' : 'Аварийное окно открыто на 1 час');
      openAdminInvites();
    } catch (e) { toast(e.message, true); }
  });
}

// ── pkg3-59: меню «⋮» у участника дерева приглашений ──
function adminTreeClick(e) {
  const b = e.target.closest('[data-umenu]');
  if (b) openUserAdmin(b.dataset.umenu);
}
/** Карточка управления участником: запрет приглашать (галочка), бан на сутки
 * с уведомлением о жалобе, удаление из мессенджера навсегда. */
function openUserAdmin(id) {
  const d = S.adminInv;
  if (!d) return;
  const u = (d.users || []).find(x => x.id === id);
  if (!u) return;
  const pol = d.policy || { globalOff: false, blockedUsers: [], blockedChats: [] };
  const blocked = (pol.blockedUsers || []).includes(id);
  const banned = (u.bannedUntil || 0) > Date.now();
  const aliasName = u.displayAs ? ((d.users.find(x => x.id === u.displayAs) || {}).name || '?') : null;
  // pkg3-62: в заголовке — видимое имя (у слитой учётки оно уже новое)
  const visName = (S.users.find(x => x.id === id) || u).name || u.name;
  modal('Участник «' + visName + '»', `
    <div class="card">
      <label class="row-check"><input type="checkbox" id="ua-noinvite" ${blocked ? 'checked' : ''}>
        <span>Запрещено приглашать других пользователей</span></label>
      <div class="set-row">
        <div class="t"><b>${banned ? 'Доступ ограничен по жалобе' : 'Бан на сутки'}</b>
          <span>${banned
            ? 'до ' + fmtDay(u.bannedUntil) + ', ' + fmtTime(u.bannedUntil) + ' — можно снять досрочно'
            : 'пользователь получит уведомление о поступившей жалобе'}</span></div>
        <button class="mini ${banned ? '' : 'danger'}" id="ua-ban" type="button">${banned ? 'Снять бан' : 'Забанить'}</button>
      </div>
      <div class="set-row">
        <div class="t"><b>${aliasName ? 'Носит внешность «' + escapeHtml(aliasName) + '»' : 'Слияние с другой учёткой'}</b>
          <span>${aliasName
            ? 'вся переписка этой учётки отображается новым именем и аватаром'
            : 'кто потерял пароль и зарегистрировался заново: старая учётка получает новые имя и аватар'}</span></div>
        <button class="mini" id="ua-display" type="button">${aliasName ? 'Изменить / Отвязать' : 'Привязать внешность'}</button>
      </div>
      <div class="set-row">
        <div class="t"><b>Удалить из мессенджера навсегда</b>
          <span>все данные участника стираются с сервера; возврат — только по новому приглашению и новой регистрацией</span></div>
        <button class="mini danger" id="ua-del" type="button">Удалить</button>
      </div>
    </div>`);
  $('#ua-display').addEventListener('click', () => openAdminDisplayMerge(id));
  $('#ua-noinvite').addEventListener('change', async e => {
    const list = new Set(pol.blockedUsers || []);
    if (e.target.checked) list.add(id); else list.delete(id);
    try {
      await api('/api/admin/invite-policy', {
        method: 'POST',
        body: { globalOff: !!pol.globalOff, blockedUsers: [...list], blockedChats: pol.blockedChats || [] }
      });
      toast(e.target.checked ? '«' + u.name + '» больше не может приглашать' : '«' + u.name + '» снова может приглашать');
      openAdminInvites();
    } catch (ex) { toast(ex.message, true); }
  });
  $('#ua-ban').addEventListener('click', async () => {
    try {
      if (banned) {
        await api('/api/admin/users/' + encodeURIComponent(id) + '/ban', { method: 'POST', body: { on: false } });
        toast('Бан снят: доступ возвращён');
      } else {
        if (!confirm('Ограничить «' + u.name + '» доступ на сутки? Пользователь получит уведомление о поступившей жалобе.')) return;
        await api('/api/admin/users/' + encodeURIComponent(id) + '/ban', { method: 'POST', body: { on: true } });
        toast('Доступ ограничен на сутки');
      }
      openAdminInvites();
    } catch (ex) { toast(ex.message, true); }
  });
  $('#ua-del').addEventListener('click', async () => {
    if (!confirm('Удалить «' + u.name + '» из мессенджера НАВСЕГДА?\n\n'
      + 'Профиль, ключи и настройки будут стёрты с сервера, личные чаты с ним удалены у обеих сторон, '
      + 'его приглашения погаснут. В групповых чатах его сообщения останутся с подписью «Бывший участник». '
      + 'Вернуться он сможет только по новому приглашению и новой регистрацией — прежнее не восстановится.')) return;
    try {
      await api('/api/admin/users/' + encodeURIComponent(id), { method: 'DELETE' });
      toast('Участник удалён навсегда');
      hide($('#modal'));
      await sync(false).catch(() => {});
      S.sig = ''; renderAll();
      openAdminInvites();
    } catch (ex) { toast(ex.message, true); }
  });
}
/** pkg3-61: «поглощение» учётки — старая учётка (потерян пароль) получает имя
 * и аватар другой: вся её переписка отображается новым лицом. Шифрование и
 * авторство не подменяются — только внешность; действие обратимо. */
function openAdminDisplayMerge(oldId) {
  const d = S.adminInv;
  if (!d) return;
  const old = (d.users || []).find(x => x.id === oldId);
  if (!old) return;
  // pkg3-62: имена берём из синхронизации (там они уже видимые), в списке
  // выбора только настоящие учётки
  const nm = id => ((S.users.find(x => x.id === id) || {}).name
    || (d.users.find(x => x.id === id) || {}).name || '?');
  const list = (d.users || []).filter(x => x.id !== oldId && !x.displayAs);
  modal('Слияние учёток (внешность)', `
    <p class="hint">Старая учётка «${escapeHtml(nm(oldId))}» станет продолжением выбранной:
    имя и аватар — общие, поиск её больше не находит, а «написать» открывает уже
    существующую переписку. Сообщения и ключи не подменяются — шифрование цело.
    Действие можно отменить кнопкой «Отвязать».</p>
    ${old.displayAs ? `<button class="mini" id="dp-off" type="button" style="margin-bottom:10px">Отвязать (вернуть собственное лицо)</button>` : ''}
    ${list.map(x => `<div class="mrow"><span class="nm">${escapeHtml(nm(x.id))}${x.isAdmin ? ' <span class="tag-admin">адм</span>' : ''}</span>
      <button class="mini" data-dp-as="${escapeHtml(x.id)}" type="button">Взять её внешность</button></div>`).join('') || '<div class="tiny muted">Подходящих учёток нет</div>'}`);
  const off = $('#dp-off');
  if (off) off.addEventListener('click', async () => {
    off.disabled = true;
    try {
      await api('/api/admin/users/' + encodeURIComponent(oldId) + '/display', { method: 'POST', body: { as: null } });
      toast('Собственное лицо возвращено');
      hide($('#modal'));
      await sync(false).catch(() => {});
      S.sig = ''; renderAll();
      openAdminInvites();
    } catch (ex) { toast(ex.message, true); off.disabled = false; }
  });
  for (const b of document.querySelectorAll('[data-dp-as]')) {
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        await api('/api/admin/users/' + encodeURIComponent(oldId) + '/display', { method: 'POST', body: { as: b.dataset.dpAs } });
        toast('Внешность привязана: старая переписка отображается новой учёткой');
        hide($('#modal'));
        await sync(false).catch(() => {});
        S.sig = ''; renderAll();
        openAdminInvites();
      } catch (ex) { toast(ex.message, true); b.disabled = false; }
    });
  }
}

// ── pkg3-45: локальные псевдонимы — переименовать любого у себя
function openAliasEditor() {
  closeDrop();
  modal('Переименовать у себя', `
    <p class="hint">Псевдоним виден только в вашем мессенджере: в списках, лентах
    и уведомлениях. Владелец ника об этом не узнает, на сервер псевдоним не уходит.
    Пустое поле — вернуть настоящий ник.</p>
    ${S.users.filter(u => u.id !== S.me.id && !u.displayAs).map(u => `<label>${escapeHtml(u.name)}
      <input data-alias-for="${u.id}" type="text" maxlength="32" value="${escapeHtml(S.aliases[u.id] || '')}" placeholder="${escapeHtml(u.name)}"></label>`).join('') || '<div class="tiny muted">Пока некого переименовывать.</div>'}`);
  $('#modal').addEventListener('input', e => {
    const inp = e.target.closest('[data-alias-for]');
    if (!inp) return;
    setAlias(inp.dataset.aliasFor, inp.value.trim());
    S.sig = ''; renderRail(); renderMessages(true);
  });
}

$('#btn-gear').addEventListener('click', openSettings);
$('#settings-close').addEventListener('click', closeSettings);
$('#sheet-settings').addEventListener('click', e => { if (e.target.id === 'sheet-settings') closeSettings(); });
// пункты «Профиль / Управление / Архивы / Выйти» открывают свои окна — сворачиваем настройки
document.addEventListener('click', e => {
  if (e.target.closest('[data-close-sheet]')) closeSettings();
}, true);
$('#sw-dark').addEventListener('change', e => {
  if (!e.target.checked && currentPal() === 'synth') {
    e.target.checked = true;
    toast('Гамма «Синтвейв» бывает только тёмной. Сначала выберите другую гамму — тогда тему можно выключить.');
    return;
  }
  applyTheme(e.target.checked ? 'dark' : 'light');
});
$('#sw-eco').addEventListener('change', e => {
  applyEco(e.target.checked);
  toast(e.target.checked ? 'Экономный режим включён: медиа, аватары и фоны не грузятся' : 'Экономный режим выключен');
});
$('#sw-push').addEventListener('change', e => {
  try { localStorage.setItem('sega.pushAuto37', 'manual'); } catch (err) {}   // pkg3-37: решение человека — не перекрывать
  setPush(e.target.checked);
});
$('#pals').addEventListener('click', e => {
  const b = e.target.closest('[data-pal]');
  if (!b) return;
  applyPalette(b.dataset.pal);
  toast('Гамма: ' + palById(b.dataset.pal).name);
});

(function initAppearance() {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  applyEco(localStorage.getItem('sega.eco') === '1', false);
  applyPalette(currentPal(), false);
  paintIcons(document);
})();

// ─────────────────────────────────────────── pkg3-64: показать пароль ─────────
function bindShowPass(boxId, inputIds) {
  const box = $(boxId);
  if (!box) return;
  box.addEventListener('change', e => {
    const t = e.target.checked ? 'text' : 'password';
    for (const id of inputIds) { const el = $(id); if (el) el.type = t; }
  });
}
bindShowPass('#login-show-pass', ['#login-pass']);
bindShowPass('#reg-show-pass', ['#reg-pass', '#reg-pass2']);

// ─────────────────────────────────────────── pkg3-64: почта и восстановление ─────────
const fmtRecoveryCode = K => toB64(K).replace(/=+$/, '').match(/.{1,4}/g).join('-');
function parseRecoveryCode(str) {
  try {
    const b64 = String(str || '').replace(/[\s-]/g, '');
    if (!b64) return null;
    const raw = fromB64(b64);
    return raw.length === 32 ? raw : null;
  } catch (e) { return null; }
}
/** Копия восстановления: секреты учётки, завёрнутые случайным кодом, который
 * владелец хранит сам (или шлёт себе письмом). Сервер видит только шифротекст. */
async function makeRecoveryCode() {
  if (!S.privRaw || !S.roomKeyRaw) {
    toast('На этом устройстве нет ключей для копии: войдите с паролем и повторите', true);
    return null;
  }
  try {
    const K = rnd(32);
    const blob = await aesEncryptBytes(K, enc.encode(JSON.stringify({ pkcs8: toB64(S.privRaw), room: toB64(S.roomKeyRaw) })));
    await api('/api/profile', { method: 'POST', body: { recoveryBlob: blob } });
    return fmtRecoveryCode(K);
  } catch (e) { toast(e.message, true); return null; }
}
const recoveryCodeHtml = code => `<div class="card" style="padding:10px;margin-top:10px">
  <b>Код восстановления</b>
  <div class="tiny muted" style="margin:4px 0 8px">Сохраните его или отправьте СЕБЕ на привязанную почту своим письмом:
  без этого кода после сброса пароля старая переписка не откроется. Сервер код не видит.</div>
  <div style="font-family:monospace;font-size:15px;letter-spacing:1px;word-break:break-all">${escapeHtml(code)}</div>
  <button class="mini" id="pf-rec-copy" type="button" style="margin-top:8px">Скопировать</button></div>`;
document.addEventListener('click', e => {
  if (!e.target.closest('#pf-rec-copy')) return;
  const code = (e.target.closest('.card').querySelector('div[style*="monospace"]') || {}).textContent || '';
  try { navigator.clipboard.writeText(code); toast('Код скопирован'); } catch (err) { toast('Скопируйте код вручную', true); }
});
async function paintPfMail() {
  const box = $('#pf-mail');
  if (!box) return;
  let st = null;
  try { st = await api('/api/profile'); }
  catch (e) { box.innerHTML = '<div class="tiny muted">' + escapeHtml(e.message) + '</div>'; return; }
  if (st.emailConfirmed) {
    box.innerHTML = `
      <p class="hint">Привязана: <b>${escapeHtml(st.email)}</b>. Забыли пароль — на экране входа
      «Забыли пароль?», ссылка придёт на эту почту.</p>
      <button class="mini" id="pf-mail-code" type="button">Показать новый код восстановления</button>
      <button class="mini danger" id="pf-mail-off" type="button" style="margin-left:6px">Отвязать почту</button>
      <div id="pf-mail-codebox"></div>`;
    $('#pf-mail-code').addEventListener('click', async () => {
      const code = await makeRecoveryCode();
      if (code) $('#pf-mail-codebox').innerHTML = recoveryCodeHtml(code);
    });
    $('#pf-mail-off').addEventListener('click', async () => {
      if (!confirm('Отвязать почту? Восстановление пароля по письму станет недоступно, код восстановления перестанет действовать.')) return;
      try { await api('/api/profile', { method: 'POST', body: { email: '' } }); toast('Почта отвязана'); paintPfMail(); }
      catch (e) { toast(e.message, true); }
    });
    return;
  }
  box.innerHTML = `
    <p class="hint">Необязательно: привяжите почту — если забудете пароль,
    ссылка для восстановления придёт на неё. Почта хранится на сервере открыто
    (нужно для отправки писем) и больше ни для чего не используется.</p>
    <label>Почта<input type="email" id="pf-mail-in" placeholder="you@example.com" autocomplete="email"></label>
    <button class="mini primary" id="pf-mail-go" type="button">Привязать</button>
    <div id="pf-mail-code-row" class="hidden" style="margin-top:8px">
      <label>Код из письма<input type="text" id="pf-mail-codein" inputmode="numeric" maxlength="6" placeholder="6 цифр"></label>
      <button class="mini primary" id="pf-mail-confirm" type="button">Подтвердить</button>
    </div>`;
  $('#pf-mail-go').addEventListener('click', async () => {
    try {
      await api('/api/profile', { method: 'POST', body: { email: $('#pf-mail-in').value.trim() } });
      toast('Код подтверждения отправлен на почту');
      $('#pf-mail-code-row').classList.remove('hidden');
    } catch (e) { toast(e.message, true); }
  });
  $('#pf-mail-confirm').addEventListener('click', async () => {
    try {
      await api('/api/profile', { method: 'POST', body: { emailCode: $('#pf-mail-codein').value.trim() } });
      toast('Почта привязана');
      const code = await makeRecoveryCode();
      paintPfMail();
      if (code) $('#pf-mail-codebox').innerHTML = recoveryCodeHtml(code);
    } catch (e) { toast(e.message, true); }
  });
}

/** Экран восстановления пароля. token — из письма (?recover=…), null — шаг запроса. */
function openRecover(token) {
  screen('recover');
  const box = $('#recover-steps');
  if (!box) return;
  if (!token) {
    box.innerHTML = `
      <p class="hint">Шаг 1. Введите ник и почту, привязанную в профиле:
      на почту уйдёт ссылка для восстановления (действует час, одноразовая).</p>
      <label>Ник<input type="text" id="rc-name" autocomplete="username"></label>
      <label>Почта<input type="email" id="rc-email" autocomplete="email"></label>
      <div class="err" id="rc-err"></div>
      <button class="primary" id="rc-go" type="button">Восстановить пароль</button>`;
    $('#rc-go').addEventListener('click', async () => {
      const err = $('#rc-err'); err.textContent = '';
      try {
        await api('/api/recover/request', { method: 'POST', body: { name: $('#rc-name').value.trim(), email: $('#rc-email').value.trim() } });
        box.innerHTML = '<p class="hint">Письмо со ссылкой ушло на привязанную почту. Откройте ссылку на любом устройстве — она одна и на один час.</p>';
      } catch (e) { err.textContent = e.message; }
    });
    return;
  }
  (async () => {
    let st;
    try { st = await api('/api/recover/state?token=' + encodeURIComponent(token)); }
    catch (e) { box.innerHTML = '<p class="hint">' + escapeHtml(e.message) + '</p>'; return; }
    box.innerHTML = `
      <p class="hint">Восстанавливаем пароль для имени <b>${escapeHtml(st.name)}</b>.
      Шаг 2: новый пароль${st.hasBlob ? ' и код восстановления, если вы его сохраняли' : ''}.</p>
      ${st.hasBlob
        ? `<label>Код восстановления <span class="tiny muted">(необязательно, но с ним вернётся старая переписка)</span>
           <input type="text" id="rc-code" placeholder="xxxx-xxxx-xxxx-…" autocomplete="off"></label>`
        : '<p class="tiny muted">Копии восстановления у этого имени нет: учётка оживёт, но старая переписка останется закрытой.</p>'}
      <label>Новый пароль<input type="password" id="rc-pass" minlength="6" autocomplete="new-password" placeholder="минимум 6 символов"></label>
      <label>Повторите новый<input type="password" id="rc-pass2" minlength="6" autocomplete="new-password"></label>
      <label class="row-check"><input type="checkbox" id="rc-show"> <span>Показать пароль</span></label>
      <div class="err" id="rc-err"></div>
      <button class="primary" id="rc-go" type="button">Поставить новый пароль</button>`;
    $('#rc-show').addEventListener('change', e => {
      const t = e.target.checked ? 'text' : 'password';
      $('#rc-pass').type = t; $('#rc-pass2').type = t;
    });
    $('#rc-go').addEventListener('click', async () => {
      const err = $('#rc-err'); err.textContent = '';
      const pass = $('#rc-pass').value;
      if (pass !== $('#rc-pass2').value) { err.textContent = 'Пароли не совпадают'; return; }
      if (pass.length < 6) { err.textContent = 'Пароль минимум 6 символов'; return; }
      const btn = $('#rc-go'); btn.disabled = true; btn.textContent = 'Ставим…';
      try {
        const saltAuth = newSalt(), saltWrap = newSalt();
        const authKey = toHex(await pbkdf2(pass, saltAuth));
        const wrapKey = await aesKeyFrom(pass, saltWrap);
        const body = { token, saltAuth, authKey, saltWrap, wrappedKeyByPass: null, wrappedPriv: null };
        const codeEl = $('#rc-code');
        if (st.hasBlob && codeEl && codeEl.value.trim()) {
          const K = parseRecoveryCode(codeEl.value);
          if (!K) { err.textContent = 'Код восстановления похоже не тот: проверьте строку'; btn.disabled = false; btn.textContent = 'Поставить новый пароль'; return; }
          let sec;
          try { sec = JSON.parse(dec.decode(await aesDecryptBytes(K, st.blob))); }
          catch (e) { err.textContent = 'Код не подошёл: копия восстановления не открылась'; btn.disabled = false; btn.textContent = 'Поставить новый пароль'; return; }
          body.wrappedKeyByPass = await aesEncryptBytes(wrapKey, fromB64(sec.room));
          body.wrappedPriv = await aesEncryptBytes(wrapKey, fromB64(sec.pkcs8));
        } else if (st.hasBlob) {
          if (!confirm('Без кода восстановления учётка получит новый пароль, но старая переписка этого имени останется закрытой НАВСЕГДА. Продолжить?')) { btn.disabled = false; btn.textContent = 'Поставить новый пароль'; return; }
        }
        await api('/api/recover/commit', { method: 'POST', body });
        try { history.replaceState(null, '', location.pathname); } catch (e) {}
        screen('auth');
        toast('Новый пароль поставлен — войдите им' + (body.wrappedPriv ? '' : ' (старая переписка имени останется закрытой)'));
      } catch (e) { err.textContent = e.message || ('' + e); btn.disabled = false; btn.textContent = 'Поставить новый пароль'; }
    });
  })();
}
$('#login-forgot').addEventListener('click', e => { e.preventDefault(); openRecover(null); });
$('#recover-back').addEventListener('click', e => { e.preventDefault(); screen('auth'); });

boot();
