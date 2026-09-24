/* Alt-Джентельмены — клиент.
   Всё шифрование происходит здесь, в браузере. На сервер уходят только
   зашифрованные блобы (AES-256-GCM), ключ комнаты сервер не видит никогда. */
'use strict';

// ─────────────────────────────────────────────── мелкие помощники
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const show = (el) => el.classList.remove('hidden');
const hide = (el) => el.classList.add('hidden');
const enc = new TextEncoder();
const dec = new TextDecoder();
const ITER = 150000;

function toast(msg, isErr) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '');
  clearTimeout(t._t);
  t._t = setTimeout(() => hide(t), 3600);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function linkify(html) {
  return html.replace(/(https?:\/\/[^\s<]+)/g, u => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
}
function fmtBytes(b) {
  if (b < 1024) return b + ' Б';
  if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' КБ';
  return (b / 1024 / 1024).toFixed(2) + ' МБ';
}
const DAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const MON = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
function fmtDay(ts) {
  const d = new Date(ts), n = new Date();
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, n)) return 'сегодня';
  const y = new Date(n.getTime() - 864e5);
  if (same(d, y)) return 'вчера';
  return `${d.getDate()} ${MON[d.getMonth()]}${d.getFullYear() !== n.getFullYear() ? ' ' + d.getFullYear() : ''}, ${DAYS[d.getDay()]}`;
}
const fmtTime = ts => new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

// ─────────────────────────────────────────────── криптография
const subtle = (window.crypto && window.crypto.subtle) || null;
const rnd = (n) => crypto.getRandomValues(new Uint8Array(n));
const toHex = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const fromHex = (h) => new Uint8Array(h.match(/.{1,2}/g).map(b => parseInt(b, 16)));
function toB64(buf) {
  const b = new Uint8Array(buf); let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}
const fromB64 = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

async function pbkdf2(password, saltHex, bits = 256) {
  const base = await subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits(
    { name: 'PBKDF2', salt: fromHex(saltHex), iterations: ITER, hash: 'SHA-256' }, base, bits));
}
async function aesKeyFrom(password, saltHex) {
  const bits = await pbkdf2(password, saltHex);
  return subtle.importKey('raw', bits, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function aesEncryptBytes(key, bytes) {
  const iv = rnd(12);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv); out.set(ct, iv.length);
  return toB64(out);
}
async function aesDecryptBytes(key, b64) {
  const raw = fromB64(b64);
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, key, raw.slice(12)));
}
const encryptJSON = async (key, obj) => aesEncryptBytes(key, enc.encode(JSON.stringify(obj)));
const decryptJSON = async (key, b64) => JSON.parse(dec.decode(await aesDecryptBytes(key, b64)));
const newSalt = () => toHex(rnd(16));

// ─────────────────────────────────────────────── состояние
const S = {
  token: null, me: null, roomKey: null, roomKeyRaw: null,
  saltAuth: null, saltWrap: null, codeProofSalt: null,
  users: [], messages: [], plain: new Map(), // id -> {text, att}
  seq: 0, usage: { bytes: 0, limit: 1, percent: 0 },
  attach: null, remember: true, timer: null, atBottom: true
};

function store() { return S.remember ? localStorage : sessionStorage; }
function saveSession() {
  const data = JSON.stringify({ token: S.token, key: toB64(S.roomKeyRaw), saltAuth: S.saltAuth, saltWrap: S.saltWrap });
  store().setItem('altg.session', data);
}
function loadSessionRaw() {
  const a = localStorage.getItem('altg.session');
  if (a) { S.remember = true; return JSON.parse(a); }
  const b = sessionStorage.getItem('altg.session');
  if (b) { S.remember = false; return JSON.parse(b); }
  return null;
}
function clearSession() {
  localStorage.removeItem('altg.session');
  sessionStorage.removeItem('altg.session');
}

// ─────────────────────────────────────────────── сеть
async function api(path, opts = {}) {
  const headers = Object.assign({}, opts.headers || {});
  if (opts.body !== undefined && typeof opts.body !== 'string') { opts.body = JSON.stringify(opts.body); }
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

// ─────────────────────────────────────────────── экраны
function screen(name) {
  ['loading', 'setup', 'auth', 'app'].forEach(n => document.getElementById('screen-' + n).classList.toggle('hidden', n !== name));
}

async function boot() {
  if (!subtle) {
    screen('setup');
    $('#form-setup').innerHTML = `<div class="brand"><div class="hat">🎩</div><h1>Alt-Джентельмены</h1></div>
      <p class="hint">Браузер не даёт доступ к шифрованию, потому что страница открыта по незащищённому адресу.
      Откройте чат по адресу <b>http://localhost:8080</b> на том же компьютере, либо запустите сервер по HTTPS
      (см. инструкцию в README, раздел «Доступ с телефона»).</p>`;
    return;
  }
  let st;
  try { st = await api('/api/state'); }
  catch (e) { toast('Сервер недоступен: ' + e.message, true); return; }
  S.codeProofSalt = st.codeProofSalt;
  if (st.setupRequired) { screen('setup'); return; }

  const sess = loadSessionRaw();
  if (sess && sess.token) {
    S.token = sess.token; S.saltAuth = sess.saltAuth; S.saltWrap = sess.saltWrap;
    S.roomKeyRaw = fromB64(sess.key);
    S.roomKey = await subtle.importKey('raw', S.roomKeyRaw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    try { await startApp(); return; } catch (e) { clearSession(); S.token = null; }
  }
  screen('auth');
}

// ─────────────────────────────────────────────── настройка чата
$('#form-setup').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target, err = $('#setup-err'), btn = f.querySelector('button');
  err.textContent = '';
  const el = f.elements;
  const name = el.name.value.trim(), pass = el.pass.value, code = el.code.value.trim();
  if (pass !== el.pass2.value) return err.textContent = 'Пароли не совпадают';
  if (code !== el.code2.value.trim()) return err.textContent = 'Кодовые фразы не совпадают';
  btn.disabled = true; btn.textContent = 'Создаём ключи…';
  try {
    const saltAuth = newSalt(), saltWrap = newSalt(), codeProofSalt = newSalt(), codeSalt = newSalt();
    const roomKeyRaw = rnd(32);
    const authKey = toHex(await pbkdf2(pass, saltAuth));
    const wrapKey = await aesKeyFrom(pass, saltWrap);
    const codeProof = toHex(await pbkdf2(code, codeProofSalt));
    const codeKey = await aesKeyFrom(code, codeSalt);
    const body = {
      name, saltAuth, saltWrap, authKey,
      wrappedKeyByPass: await aesEncryptBytes(wrapKey, roomKeyRaw),
      codeProofSalt, codeProof, codeSalt,
      wrappedKeyByCode: await aesEncryptBytes(codeKey, roomKeyRaw)
    };
    const r = await api('/api/setup', { method: 'POST', body });
    await enterWith(r, roomKeyRaw, saltAuth, saltWrap, true);
  } catch (ex) {
    err.textContent = ex.message; btn.disabled = false; btn.textContent = 'Основать клуб';
  }
});

// ─────────────────────────────────────────────── вход / регистрация
$$('.tab').forEach(t => t.addEventListener('click', () => {
  $$('.tab').forEach(x => x.classList.toggle('active', x === t));
  $('#form-login').classList.toggle('hidden', t.dataset.tab !== 'login');
  $('#form-register').classList.toggle('hidden', t.dataset.tab !== 'register');
}));

$('#form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target, err = $('#login-err'), btn = f.querySelector('button.primary');
  err.textContent = ''; btn.disabled = true; btn.textContent = 'Проверяем…';
  try {
    const el = f.elements;
    const name = el.name.value.trim(), pass = el.pass.value;
    S.remember = el.remember.checked;
    const salts = await api('/api/salt', { method: 'POST', body: { name } });
    const authKey = toHex(await pbkdf2(pass, salts.saltAuth));
    const r = await api('/api/login', { method: 'POST', body: { name, authKey } });
    const wrapKey = await aesKeyFrom(pass, r.saltWrap);
    let roomKeyRaw;
    try { roomKeyRaw = await aesDecryptBytes(wrapKey, r.wrappedKeyByPass); }
    catch (_) { throw new Error('Не удалось расшифровать ключ чата. Проверьте пароль.'); }
    await enterWith(r, roomKeyRaw, salts.saltAuth, r.saltWrap);
  } catch (ex) {
    err.textContent = ex.message; btn.disabled = false; btn.textContent = 'Войти';
  }
});

$('#form-register').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target, err = $('#reg-err'), btn = f.querySelector('button.primary');
  err.textContent = '';
  const el = f.elements;
  const name = el.name.value.trim(), pass = el.pass.value, code = el.code.value.trim();
  if (pass !== el.pass2.value) return err.textContent = 'Пароли не совпадают';
  S.remember = el.remember.checked;
  btn.disabled = true; btn.textContent = 'Открываем дверь…';
  try {
    const st = await api('/api/state');
    const codeProof = toHex(await pbkdf2(code, st.codeProofSalt));
    const inv = await api('/api/invite', { method: 'POST', body: { codeProof } });
    const codeKey = await aesKeyFrom(code, inv.codeSalt);
    let roomKeyRaw;
    try { roomKeyRaw = await aesDecryptBytes(codeKey, inv.wrappedKeyByCode); }
    catch (_) { throw new Error('Кодовая фраза не подходит'); }
    const saltAuth = newSalt(), saltWrap = newSalt();
    const authKey = toHex(await pbkdf2(pass, saltAuth));
    const wrapKey = await aesKeyFrom(pass, saltWrap);
    const r = await api('/api/register', {
      method: 'POST',
      body: { name, codeProof, saltAuth, saltWrap, authKey, wrappedKeyByPass: await aesEncryptBytes(wrapKey, roomKeyRaw) }
    });
    await enterWith(r, roomKeyRaw, saltAuth, saltWrap);
  } catch (ex) {
    err.textContent = ex.message; btn.disabled = false; btn.textContent = 'Войти в клуб';
  }
});

async function enterWith(r, roomKeyRaw, saltAuth, saltWrap) {
  S.token = r.token; S.me = r.user;
  S.roomKeyRaw = roomKeyRaw instanceof Uint8Array ? roomKeyRaw : new Uint8Array(roomKeyRaw);
  S.roomKey = await subtle.importKey('raw', S.roomKeyRaw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  S.saltAuth = saltAuth; S.saltWrap = saltWrap;
  saveSession();
  await startApp();
}

function doLogout(silent) {
  if (S.token && !silent) api('/api/logout', { method: 'POST' }).catch(() => {});
  clearTimeout(S.timer);
  clearSession();
  Object.assign(S, { token: null, me: null, roomKey: null, roomKeyRaw: null, messages: [], plain: new Map(), seq: 0 });
  $('#messages').innerHTML = '';
  screen('auth');
}

// ─────────────────────────────────────────────── основной цикл
async function startApp() {
  screen('app');
  S.seq = 0; S.messages = []; S.plain = new Map();
  await sync(true);
  loop();
  $('#input').focus();
}
function loop() {
  clearTimeout(S.timer);
  S.timer = setTimeout(async () => {
    if (!document.hidden && S.token) { try { await sync(); } catch (e) {} }
    loop();
  }, document.hidden ? 8000 : 2200);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.token) sync().catch(() => {}); });

async function sync(initial) {
  const data = await api('/api/sync?since=' + S.seq);
  S.users = data.users;
  S.me = data.me;
  S.usage = data.usage;
  let changed = false;

  if (data.messages.length) {
    for (const m of data.messages) S.messages.push(m);
    S.messages.sort((a, b) => a.seq - b.seq);
    await decryptAll(data.messages);
    changed = true;
  } else if (data.seq !== S.seq && !initial) {
    // что-то удалили — перечитываем историю целиком
    const full = await api('/api/sync?since=0');
    S.messages = full.messages; S.plain = new Map();
    await decryptAll(S.messages);
    S.seq = full.seq; changed = true;
  }
  S.seq = data.seq;
  renderUsers(); renderMemory();
  if (changed || initial) { renderMessages(initial); if ($('#search').value.trim()) runSearch(); }
}

async function decryptAll(list) {
  for (const m of list) {
    if (S.plain.has(m.id)) continue;
    try { S.plain.set(m.id, await decryptJSON(S.roomKey, m.blob)); }
    catch (e) { S.plain.set(m.id, { text: '🔒 не удалось расшифровать сообщение', broken: true }); }
  }
}

// ─────────────────────────────────────────────── отрисовка
function avatarEl(user, cls) {
  const initials = (user && user.name ? user.name.trim()[0] : '?').toUpperCase();
  if (user && user.avatar) {
    const src = avatarCache.get(user.id);
    if (src) return `<img class="avatar ${cls || ''}" src="${src}" alt="">`;
    decodeAvatar(user);
  }
  return `<span class="avatar ${cls || ''}" data-uid="${user ? user.id : ''}">${escapeHtml(initials)}</span>`;
}
const avatarCache = new Map();
const avatarPending = new Set();
async function decodeAvatar(user) {
  if (avatarPending.has(user.id)) return;
  avatarPending.add(user.id);
  try {
    const obj = await decryptJSON(S.roomKey, user.avatar);
    avatarCache.set(user.id, obj.data);
    renderUsers(); renderMessages();
  } catch (e) { /* чужой ключ — оставляем инициалы */ }
  avatarPending.delete(user.id);
}

function renderUsers() {
  const box = $('#users-list');
  const now = Date.now();
  box.innerHTML = S.users.map(u => `
    <div class="user-row">
      ${avatarEl(u)}
      <span class="nm">${escapeHtml(u.name)}${u.id === S.me.id ? ' <span class="muted tiny">(вы)</span>' : ''}</span>
      ${u.isAdmin ? '<span class="badge">адм</span>' : ''}
      <span class="dot ${now - (u.lastSeen || 0) < 70000 ? 'on' : ''}"></span>
    </div>`).join('');
  $('#users-count').textContent = '· ' + S.users.length;
  $('#btn-admin').classList.toggle('hidden', !S.me.isAdmin);
  $('#side-sub').textContent = S.me.isAdmin ? 'вы — администратор' : 'участник клуба';
}

function renderMemory() {
  const u = S.usage;
  const pct = Math.min(100, u.percent);
  $('#mem-pct').textContent = pct + '%';
  const fill = $('#mem-fill');
  fill.style.width = Math.max(pct, u.bytes > 0 ? 1.5 : 0) + '%';
  fill.classList.toggle('hot', pct >= 80);
  $('#mem-text').textContent = `${fmtBytes(u.bytes)} из ${fmtBytes(u.limit)} · ${u.messages} сообщ.`;
  $('#mem-warn').classList.toggle('hidden', pct < 80);
}

function renderMessages(scroll) {
  const box = $('#messages');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
  let html = '', lastDay = '', prevUid = '', prevTs = 0;
  if (!S.messages.length) {
    html = '<div class="sys">История пуста. Скажите джентльменам что-нибудь приятное.</div>';
  }
  for (const m of S.messages) {
    const p = S.plain.get(m.id) || { text: '…' };
    const day = new Date(m.ts).toDateString();
    if (day !== lastDay) { html += `<div class="day">${fmtDay(m.ts)}</div>`; lastDay = day; prevUid = ''; }
    const user = S.users.find(u => u.id === m.uid) || { id: m.uid, name: p.author || 'Выбывший', avatar: null };
    const grouped = prevUid === m.uid && m.ts - prevTs < 5 * 60 * 1000;
    prevUid = m.uid; prevTs = m.ts;
    const canDel = m.uid === S.me.id || S.me.isAdmin;
    html += `<div class="msg ${m.uid === S.me.id ? 'mine' : ''} ${grouped ? 'grouped' : ''}" id="m-${m.id}">
      <div style="width:34px;flex:none">${grouped ? '' : avatarEl(user, 'msg')}</div>
      <div class="body">
        ${grouped ? '' : `<div class="head"><span class="who">${escapeHtml(user.name)}</span><span class="time">${fmtTime(m.ts)}</span></div>`}
        ${p.text ? `<div class="text">${linkify(escapeHtml(p.text))}</div>` : ''}
        ${p.att ? `<img class="att" src="${p.att}" alt="вложение">` : ''}
      </div>
      ${canDel ? `<button class="del" data-del="${m.id}" title="Удалить">удалить</button>` : ''}
    </div>`;
  }
  box.innerHTML = html;
  if (scroll || nearBottom || S.atBottom) box.scrollTop = box.scrollHeight;
}

$('#messages').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del]');
  if (del) {
    if (!confirm('Удалить сообщение у всех?')) return;
    try { const r = await api('/api/messages/' + del.dataset.del, { method: 'DELETE' }); S.usage = r.usage; await sync(); }
    catch (ex) { toast(ex.message, true); }
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
});
$('#messages').addEventListener('scroll', () => {
  const box = $('#messages');
  S.atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
  $('#scroll-bottom').classList.toggle('hidden', S.atBottom);
});
$('#scroll-bottom').addEventListener('click', () => {
  const box = $('#messages'); box.scrollTop = box.scrollHeight;
});

// ─────────────────────────────────────────────── отправка
const input = $('#input');
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 160) + 'px';
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && window.matchMedia('(min-width: 821px)').matches) {
    e.preventDefault(); sendMessage();
  }
});
$('#btn-send').addEventListener('click', sendMessage);

async function sendMessage() {
  const text = input.value.trim();
  if (!text && !S.attach) return;
  const payload = { v: 1, text, author: S.me.name };
  if (S.attach) payload.att = S.attach;
  input.value = ''; input.style.height = 'auto';
  const att = S.attach; clearAttach();
  try {
    const blob = await encryptJSON(S.roomKey, payload);
    const r = await api('/api/messages', { method: 'POST', body: { blob } });
    S.usage = r.usage;
    S.atBottom = true;
    await sync();
  } catch (ex) {
    toast(ex.message, true);
    input.value = text; S.attach = att;
    if (att) showAttach(att);
  }
}

// вложения-картинки
$('#file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = await resizeImage(file, 1400, 0.82);
    S.attach = data; showAttach(data);
  } catch (ex) { toast('Не удалось обработать картинку', true); }
});
$('#attach-remove').addEventListener('click', clearAttach);
function showAttach(data) { $('#attach-img').src = data; show($('#attach-preview')); }
function clearAttach() { S.attach = null; hide($('#attach-preview')); $('#attach-img').src = ''; }

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
      img.onerror = reject;
      img.src = fr.result;
    };
    fr.onerror = reject;
    fr.readAsDataURL(file);
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

// ─────────────────────────────────────────────── поиск
let searchTimer = null;
$('#search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 160); });
$('#btn-search-clear').addEventListener('click', () => { $('#search').value = ''; runSearch(); });

function runSearch() {
  const q = $('#search').value.trim().toLowerCase();
  const box = $('#search-results');
  if (!q) { hide(box); box.innerHTML = ''; return; }
  const words = q.split(/\s+/).filter(Boolean);
  const hits = [];
  for (let i = S.messages.length - 1; i >= 0; i--) {
    const m = S.messages[i];
    const p = S.plain.get(m.id);
    if (!p || !p.text) continue;
    const low = p.text.toLowerCase();
    if (words.every(w => low.includes(w))) hits.push({ m, p });
    if (hits.length >= 300) break;
  }
  const name = (uid) => (S.users.find(u => u.id === uid) || {}).name || 'Выбывший';
  box.innerHTML = `<div class="sr-head">Найдено: ${hits.length}${hits.length >= 300 ? '+' : ''} — нажмите, чтобы перейти</div>` +
    hits.map(({ m, p }) => {
      let t = escapeHtml(p.text);
      words.forEach(w => {
        t = t.replace(new RegExp('(' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi'), '<mark>$1</mark>');
      });
      return `<div class="sr" data-go="${m.id}">
        <div class="m"><b>${escapeHtml(name(m.uid))}</b><span>${fmtDay(m.ts)}, ${fmtTime(m.ts)}</span></div>
        <div class="t">${t}</div></div>`;
    }).join('') || '<div class="sr muted">Ничего не найдено</div>';
  show(box);
}
$('#search-results').addEventListener('click', (e) => {
  const el = e.target.closest('[data-go]');
  if (!el) return;
  const target = document.getElementById('m-' + el.dataset.go);
  if (!target) return;
  if (target.scrollIntoView) target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  target.classList.remove('hl'); void target.offsetWidth; target.classList.add('hl');
});

// ─────────────────────────────────────────────── боковое меню (мобильные)
$('#btn-open-side').addEventListener('click', () => $('#sidebar').classList.add('open'));
$('#btn-close-side').addEventListener('click', () => $('#sidebar').classList.remove('open'));
$('#messages').addEventListener('touchstart', () => $('#sidebar').classList.remove('open'), { passive: true });

// ─────────────────────────────────────────────── модальные окна
function modal(title, html) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = html;
  show($('#modal'));
}
$('#modal-close').addEventListener('click', () => hide($('#modal')));
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') hide($('#modal')); });

// ── профиль
$('#btn-profile').addEventListener('click', () => {
  $('#sidebar').classList.remove('open');
  const me = S.users.find(u => u.id === S.me.id) || S.me;
  modal('Профиль', `
    <div class="avatar-pick">
      <span id="pf-avatar">${avatarEl(me, 'lg')}</span>
      <div>
        <label class="file-btn" for="pf-file">Загрузить аватар</label>
        <input type="file" id="pf-file" accept="image/*" hidden>
        <div class="tiny muted" style="margin-top:6px">квадрат, до 400 КБ, шифруется</div>
        ${me.avatar ? '<button class="mini danger" id="pf-avatar-del" style="margin-top:8px">Убрать аватар</button>' : ''}
      </div>
    </div>
    <div class="divider"><span>Имя</span></div>
    <label>Как вас называть
      <input type="text" id="pf-name" value="${escapeHtml(me.name)}" maxlength="32">
    </label>
    <button class="primary" id="pf-save-name">Сохранить имя</button>
    <div class="divider"><span>Пароль</span></div>
    <label>Текущий пароль<input type="password" id="pf-old" autocomplete="current-password"></label>
    <label>Новый пароль<input type="password" id="pf-new" autocomplete="new-password" placeholder="минимум 6 символов"></label>
    <label>Повторите новый<input type="password" id="pf-new2" autocomplete="new-password"></label>
    <div class="err" id="pf-err"></div>
    <button class="primary" id="pf-save-pass">Сменить пароль</button>
  `);

  $('#pf-file').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const data = await cropSquare(f, 160);
      const blob = await encryptJSON(S.roomKey, { data });
      await api('/api/profile', { method: 'POST', body: { avatar: blob } });
      avatarCache.set(S.me.id, data);
      $('#pf-avatar').innerHTML = `<img class="avatar lg" src="${data}" alt="">`;
      await sync(); toast('Аватар обновлён');
    } catch (ex) { toast(ex.message, true); }
  });
  const delBtn = $('#pf-avatar-del');
  if (delBtn) delBtn.addEventListener('click', async () => {
    await api('/api/profile', { method: 'POST', body: { avatar: null } });
    avatarCache.delete(S.me.id); await sync(); hide($('#modal')); toast('Аватар убран');
  });

  $('#pf-save-name').addEventListener('click', async () => {
    const name = $('#pf-name').value.trim();
    try { await api('/api/profile', { method: 'POST', body: { name } }); await sync(); toast('Имя обновлено'); }
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
      const authKey = toHex(await pbkdf2(np, saltAuth));
      const wrapKey = await aesKeyFrom(np, saltWrap);
      const wrappedKeyByPass = await aesEncryptBytes(wrapKey, S.roomKeyRaw);
      await api('/api/profile', { method: 'POST', body: { password: { oldAuthKey, saltAuth, saltWrap, authKey, wrappedKeyByPass } } });
      S.saltAuth = saltAuth; S.saltWrap = saltWrap; saveSession();
      hide($('#modal')); toast('Пароль изменён. Другие устройства придётся ввести заново.');
    } catch (ex) { err.textContent = ex.message; }
    btn.disabled = false; btn.textContent = 'Сменить пароль';
  });
});

// ── управление (администратор)
$('#btn-admin').addEventListener('click', async () => {
  $('#sidebar').classList.remove('open');
  let archives = [];
  try { archives = (await api('/api/admin/archives')).archives; } catch (e) {}
  modal('Управление клубом', `
    <div class="side-label">Участники</div>
    <div id="ad-users"></div>
    <div class="divider"><span>Кодовая фраза</span></div>
    <p class="hint">Смена фразы закрывает вход новым людям по старой фразе. Уже зарегистрированные участники продолжают читать историю как ни в чём не бывало.</p>
    <label>Новая кодовая фраза<input type="text" id="ad-code" placeholder="минимум 6 символов" autocomplete="off"></label>
    <div class="err" id="ad-code-err"></div>
    <button class="primary" id="ad-code-save">Обновить фразу</button>
    <div class="divider"><span>Память и архивы</span></div>
    <p class="hint">Занято ${fmtBytes(S.usage.bytes)} из ${fmtBytes(S.usage.limit)} (${S.usage.percent}%). Архив сохраняется на сервере в папке <b>data/archives</b>, скачать его можно кнопками ниже.</p>
    <button class="ghost" id="ad-archive">Заархивировать историю и начать новую</button>
    <div id="ad-archives" style="margin-top:10px">${archives.length ? archives.map(a => `
      <div class="archive-row"><span style="flex:1">${new Date(a.createdAt).toLocaleString('ru-RU')} · ${a.count} сообщ. · ${fmtBytes(a.bytes)}</span>
      <button class="mini" data-arch="${a.file}">скачать</button></div>`).join('') : '<div class="tiny muted">Архивов пока нет</div>'}</div>
  `);
  renderAdminUsers();

  $('#ad-users').addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const id = b.dataset.id;
    try {
      if (b.dataset.act === 'del') {
        if (!confirm('Исключить участника из клуба? Его сообщения останутся в истории.')) return;
        await api('/api/admin/users/' + id, { method: 'DELETE' });
      } else {
        await api('/api/admin/users/' + id + '/admin', { method: 'POST', body: { value: b.dataset.act === 'up' } });
      }
      await sync(); renderAdminUsers();
    } catch (ex) { toast(ex.message, true); }
  });

  $('#ad-code-save').addEventListener('click', async () => {
    const code = $('#ad-code').value.trim(), err = $('#ad-code-err');
    err.textContent = '';
    if (code.length < 6) return err.textContent = 'Слишком короткая фраза';
    const btn = $('#ad-code-save'); btn.disabled = true; btn.textContent = 'Обновляем…';
    try {
      const codeProofSalt = newSalt(), codeSalt = newSalt();
      const codeProof = toHex(await pbkdf2(code, codeProofSalt));
      const codeKey = await aesKeyFrom(code, codeSalt);
      const wrappedKeyByCode = await aesEncryptBytes(codeKey, S.roomKeyRaw);
      await api('/api/admin/code', { method: 'POST', body: { codeProofSalt, codeProof, codeSalt, wrappedKeyByCode } });
      $('#ad-code').value = '';
      toast('Кодовая фраза обновлена');
    } catch (ex) { err.textContent = ex.message; }
    btn.disabled = false; btn.textContent = 'Обновить фразу';
  });

  $('#ad-archive').addEventListener('click', async () => {
    if (!confirm('Сохранить архив истории на сервере и очистить чат? Перед очисткой стоит скачать читаемую копию (кнопка «Сохранить архив»).')) return;
    try {
      const r = await api('/api/admin/archive', { method: 'POST', body: { reset: true } });
      try { await downloadArchive(r.archive.file); }
      catch (e) { toast('Архив сохранён на сервере, но скачать не удалось: ' + e.message, true); }
      await sync();
      hide($('#modal'));
      toast('Архив создан, чат очищен');
    } catch (ex) { toast(ex.message, true); }
  });

  $('#ad-archives').addEventListener('click', (e) => {
    const b = e.target.closest('[data-arch]');
    if (b) downloadArchive(b.dataset.arch).catch(ex => toast(ex.message, true));
  });
});

function renderAdminUsers() {
  const box = $('#ad-users');
  if (!box) return;
  box.innerHTML = S.users.map(u => `
    <div class="mrow">${avatarEl(u)}
      <span class="nm">${escapeHtml(u.name)}${u.isAdmin ? ' <span class="badge">адм</span>' : ''}</span>
      ${u.id !== S.me.id ? `<button class="mini" data-id="${u.id}" data-act="${u.isAdmin ? 'down' : 'up'}">${u.isAdmin ? 'снять права' : 'сделать адм.'}</button>
      <button class="mini danger" data-id="${u.id}" data-act="del">исключить</button>` : '<span class="tiny muted">это вы</span>'}
    </div>`).join('');
}

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

// ── сохранение архива: читаемая копия + зашифрованная выгрузка
$('#btn-export').addEventListener('click', () => {
  $('#sidebar').classList.remove('open');
  modal('Сохранить архив', `
    <p class="hint">Две формы архива. Читаемую копию можно открыть в любом браузере без чата и без пароля —
    храните её в надёжном месте. Зашифрованная выгрузка безопасна, но открывается только этим приложением.</p>
    <button class="primary" id="ex-html">Читаемая копия (HTML)</button>
    <button class="ghost" id="ex-json" style="margin-top:10px">Читаемая копия (JSON)</button>
    <button class="ghost" id="ex-enc" style="margin-top:4px">Зашифрованная выгрузка с сервера</button>
    <div class="tiny muted" style="margin-top:12px">В архиве: ${S.messages.length} сообщений, ${fmtBytes(S.usage.bytes)}.</div>
  `);
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
    const u = S.users.find(x => x.id === m.uid);
    return { time: new Date(m.ts).toLocaleString('ru-RU'), ts: m.ts, author: (u && u.name) || p.author || 'Выбывший', text: p.text || '', image: p.att || null };
  });
}
function exportJson() {
  const data = { chat: 'Alt-Джентельмены', exportedAt: new Date().toISOString(), messages: plainList() };
  saveBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), 'alt-gentelmeny-' + new Date().toISOString().slice(0, 10) + '.json');
}
function exportHtml() {
  const rows = plainList().map(m => `<div class="m"><div class="h"><b>${escapeHtml(m.author)}</b> <span>${escapeHtml(m.time)}</span></div>
    ${m.text ? `<div class="t">${linkify(escapeHtml(m.text))}</div>` : ''}${m.image ? `<img src="${m.image}">` : ''}</div>`).join('\n');
  const html = `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Alt-Джентельмены — архив</title><style>
body{background:#0e1013;color:#e8e6e1;font-family:system-ui,sans-serif;margin:0;padding:24px}
.wrap{max-width:820px;margin:0 auto}h1{font-family:Georgia,serif;color:#c8a45c;letter-spacing:.05em}
#q{width:100%;padding:10px 12px;border-radius:10px;border:1px solid #262b33;background:#14171c;color:#e8e6e1;margin:12px 0 20px}
.m{border-bottom:1px solid #1d2128;padding:10px 0}.h b{color:#c8a45c}.h span{color:#8b8f98;font-size:12px;margin-left:8px}
.t{white-space:pre-wrap;margin-top:4px}img{max-width:min(420px,90%);border-radius:10px;margin-top:8px;display:block}
a{color:#9db9d8}.muted{color:#8b8f98}</style></head><body><div class="wrap">
<h1>🎩 Alt-Джентельмены</h1><div class="muted">Архив истории · ${new Date().toLocaleString('ru-RU')} · ${S.messages.length} сообщений</div>
<input id="q" placeholder="Поиск по архиву…" oninput="(function(v){document.querySelectorAll('.m').forEach(function(e){e.style.display=e.innerText.toLowerCase().includes(v.toLowerCase())?'':'none'})})(this.value)">
${rows}</div></body></html>`;
  saveBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), 'alt-gentelmeny-' + new Date().toISOString().slice(0, 10) + '.html');
}

$('#btn-logout').addEventListener('click', () => { if (confirm('Выйти из чата на этом устройстве?')) doLogout(); });

boot();
