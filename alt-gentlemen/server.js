#!/usr/bin/env node
/**
 * Alt-Джентельмены — приватный мессенджер со сквозным шифрованием.
 * Сервер без внешних зависимостей (только стандартная библиотека Node.js >= 18).
 *
 * Сервер НИКОГДА не видит: пароли, кодовую фразу, названия чатов, тексты сообщений,
 * вложения и аватары. Всё шифруется в браузере (AES-256-GCM),
 * на диск попадают только зашифрованные блобы.
 *
 * Чаты: любой участник создаёт свои групповые чаты и пишет личные сообщения.
 * Ключ группового чата случайный; каждому участнику он передаётся «завёрнутым»
 * в ключ пары (ECDH P-256) — сервер ключей не знает.
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------- настройки
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ARCHIVE_DIR = path.join(DATA_DIR, 'archives');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const STORAGE_LIMIT = Number(process.env.STORAGE_LIMIT || 25 * 1024 * 1024); // 25 МБ
const MAX_BODY = 12 * 1024 * 1024; // максимум 12 МБ на один запрос (вложения)
const SESSION_TTL = 60 * 24 * 60 * 60 * 1000; // 60 дней
const MAX_MEMBERS = 200;

// ---------------------------------------------------------------- хранилище
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

let db = {
  version: 2,
  createdAt: null,
  room: null,   // { codeProofSalt, codeProofHash, codeSalt, wrappedKeyByCode, rotatedAt }
  users: [],    // { id, name, nameLower, isAdmin, saltAuth, saltWrap, authHash, wrappedKeyByPass, pub, wrappedPriv, avatar, reads, ... }
  chats: [],    // { id, kind:'group'|'dm', titleBlob, ownerId, members:[uid], keys:{uid:{by,blob}}, createdAt }
  messages: [], // { id, seq, uid, ts, blob, bytes, chat, parent, quote }
  sessions: {}, // token -> { uid, exp }
  seq: 0,
  serverSecret: null,
  archives: []  // { file, createdAt, count, bytes, chat }
};

function migrate() {
  // Раньше был один общий чат ('group') и личные каналы 'dm:a|b'.
  // Превращаем их в обычные чаты новой модели, чтобы история не потерялась.
  if (!db.chats) db.chats = [];
  const needs = db.messages.some(m => m.ch !== undefined && m.chat === undefined);
  if (!needs) return;
  const legacyId = 'legacy-group';
  for (const m of db.messages) {
    if (m.chat !== undefined) continue;
    const ch = m.ch || 'group';
    if (ch === 'group') {
      m.chat = legacyId;
    } else {
      m.chat = ch; // 'dm:a|b' остаётся идентификатором личного чата
      if (!db.chats.some(c => c.id === ch)) {
        db.chats.push({ id: ch, kind: 'dm', members: ch.slice(3).split('|'), keys: {}, createdAt: m.ts });
      }
    }
    delete m.ch;
  }
  if (db.messages.some(m => m.chat === legacyId) && !db.chats.some(c => c.id === legacyId)) {
    db.chats.unshift({
      id: legacyId, kind: 'group', titleBlob: null, titlePlain: 'Общий чат (прежний)',
      ownerId: (db.users.find(u => u.isAdmin) || db.users[0] || {}).id || null,
      members: db.users.map(u => u.id), keys: {}, legacyRoomKey: true, createdAt: db.createdAt || Date.now()
    });
  }
  for (const u of db.users) {
    if (!u.reads) continue;
    if (u.reads.group !== undefined) { u.reads[legacyId] = u.reads.group; delete u.reads.group; }
  }
  for (const a of db.archives || []) if (!a.chat) a.chat = legacyId;
  db.version = 2;
}

function loadDb() {
  if (fs.existsSync(DB_FILE)) {
    try {
      db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
    } catch (e) {
      console.error('Не удалось прочитать базу:', e.message);
      const backup = DB_FILE + '.broken.' + Date.now();
      fs.copyFileSync(DB_FILE, backup);
      console.error('Повреждённый файл сохранён как', backup);
    }
  }
  if (!db.serverSecret) db.serverSecret = crypto.randomBytes(32).toString('hex');
  if (!db.createdAt) db.createdAt = Date.now();
  if (!db.chats) db.chats = [];
  migrate();
  saveNow();
}

let saveTimer = null;
let dirty = false;
function save() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; if (dirty) saveNow(); }, 400);
}
function saveNow() {
  dirty = false;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);
  } catch (e) {
    console.error('Не удалось сохранить базу:', e.message);
  }
}
process.on('SIGINT', () => { saveNow(); process.exit(0); });
process.on('SIGTERM', () => { saveNow(); process.exit(0); });

// ---------------------------------------------------------------- утилиты
const json = (res, code, obj) => {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  });
  res.end(body);
};
const bad = (res, code, msg) => json(res, code, { error: msg });

function hashSecret(hexValue, saltHex) {
  // scrypt поверх значения, которое клиент вывел из пароля (сам пароль сюда не попадает)
  return crypto.scryptSync(Buffer.from(hexValue, 'hex'), Buffer.from(saltHex, 'hex'), 32).toString('hex');
}
function timingEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
function stableSalt(label) {
  // Детерминированная «соль» для несуществующих пользователей — чтобы нельзя было
  // по ответу сервера узнать, зарегистрирован ли такой участник.
  return crypto.createHmac('sha256', db.serverSecret).update('salt:' + label).digest('hex').slice(0, 32);
}
const uid = () => crypto.randomBytes(9).toString('hex');
const normName = (s) => String(s || '').trim().replace(/\s+/g, ' ');

function usage() {
  const bytes = db.messages.reduce((a, m) => a + (m.bytes || 0), 0)
    + db.users.reduce((a, u) => a + (u.avatar ? u.avatar.length : 0), 0);
  return { bytes, limit: STORAGE_LIMIT, percent: Math.min(100, Math.round(bytes / STORAGE_LIMIT * 1000) / 10), messages: db.messages.length };
}

function publicUser(u) {
  return {
    id: u.id, name: u.name, isAdmin: !!u.isAdmin, avatar: u.avatar || null,
    createdAt: u.createdAt, lastSeen: u.lastSeen || 0, activeAt: u.activeAt || 0,
    pub: u.pub || null, reads: u.reads || {}
  };
}

// ---------------------------------------------------------------- чаты
const dmId = (a, b) => 'dm:' + [a, b].sort().join('|');
const chatById = (id) => db.chats.find(c => c.id === id) || null;
const isMember = (chat, userId) => !!chat && chat.members.includes(userId);
const myChats = (userId) => db.chats.filter(c => c.members.includes(userId));

function publicChat(c, meId) {
  const msgs = db.messages.filter(m => m.chat === c.id);
  return {
    id: c.id, kind: c.kind, titleBlob: c.titleBlob || null, titlePlain: c.titlePlain || null,
    legacyRoomKey: !!c.legacyRoomKey, ownerId: c.ownerId || null, members: c.members,
    createdAt: c.createdAt, key: (c.keys && c.keys[meId]) || null,
    count: msgs.length, bytes: msgs.reduce((a, m) => a + (m.bytes || 0), 0),
    lastTs: msgs.length ? msgs[msgs.length - 1].ts : (c.createdAt || 0)
  };
}

function ensureDm(a, b) {
  const id = dmId(a, b);
  let c = chatById(id);
  if (!c) {
    c = { id, kind: 'dm', members: [a, b].sort(), keys: {}, createdAt: Date.now() };
    db.chats.push(c);
    save();
  }
  return c;
}

// простейшая защита от перебора
const attempts = new Map();
function throttle(key) {
  const now = Date.now();
  const rec = attempts.get(key) || { n: 0, t: now };
  if (now - rec.t > 10 * 60 * 1000) { rec.n = 0; rec.t = now; }
  rec.n++; attempts.set(key, rec);
  return rec.n > 25; // больше 25 попыток за 10 минут — отказ
}

function auth(req) {
  const h = req.headers['authorization'] || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return null;
  const s = db.sessions[token];
  if (!s || s.exp < Date.now()) { if (s) { delete db.sessions[token]; save(); } return null; }
  const u = db.users.find(x => x.id === s.uid);
  if (!u) return null;
  u.lastSeen = Date.now();
  return { user: u, token };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('too-large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('bad-json')); }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------- статика
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const full = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!full.startsWith(PUBLIC_DIR) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Не найдено');
  }
  const body = fs.readFileSync(full);
  res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Content-Length': body.length, 'Cache-Control': 'no-cache' });
  res.end(body);
}

// ---------------------------------------------------------------- API
async function api(req, res, pathname, query) {
  const method = req.method;
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

  if (pathname === '/api/state' && method === 'GET') {
    return json(res, 200, {
      app: 'Alt-Джентельмены',
      setupRequired: db.users.length === 0,
      codeProofSalt: db.room ? db.room.codeProofSalt : null,
      limit: STORAGE_LIMIT
    });
  }

  // --- первичная настройка: создаётся администратор и кодовая фраза
  if (pathname === '/api/setup' && method === 'POST') {
    if (db.users.length) return bad(res, 409, 'Чат уже настроен');
    const b = await readBody(req);
    const name = normName(b.name);
    if (name.length < 2 || name.length > 32) return bad(res, 400, 'Имя: от 2 до 32 символов');
    for (const k of ['saltAuth', 'authKey', 'saltWrap', 'wrappedKeyByPass', 'codeProofSalt', 'codeProof', 'codeSalt', 'wrappedKeyByCode']) {
      if (!b[k]) return bad(res, 400, 'Не хватает поля ' + k);
    }
    db.room = {
      codeProofSalt: b.codeProofSalt,
      codeProofHash: hashSecret(b.codeProof, b.codeProofSalt),
      codeSalt: b.codeSalt,
      wrappedKeyByCode: b.wrappedKeyByCode,
      rotatedAt: Date.now()
    };
    const user = {
      id: uid(), name, nameLower: name.toLowerCase(), isAdmin: true,
      saltAuth: b.saltAuth, authHash: hashSecret(b.authKey, b.saltAuth),
      saltWrap: b.saltWrap,
      wrappedKeyByPass: b.wrappedKeyByPass, avatar: null,
      pub: b.pub || null, wrappedPriv: b.wrappedPriv || null, reads: {},
      createdAt: Date.now(), lastSeen: Date.now(), activeAt: Date.now()
    };
    db.users.push(user);
    const token = crypto.randomBytes(24).toString('hex');
    db.sessions[token] = { uid: user.id, exp: Date.now() + SESSION_TTL };
    saveNow();
    return json(res, 200, { token, user: publicUser(user), saltWrap: user.saltWrap, wrappedKeyByPass: user.wrappedKeyByPass, wrappedPriv: user.wrappedPriv });
  }

  // --- соль для вывода ключей по имени
  if (pathname === '/api/salt' && method === 'POST') {
    const b = await readBody(req);
    const name = normName(b.name).toLowerCase();
    const u = db.users.find(x => x.nameLower === name);
    return json(res, 200, { saltAuth: u ? u.saltAuth : stableSalt(name) });
  }

  if (pathname === '/api/login' && method === 'POST') {
    if (throttle('login:' + ip)) return bad(res, 429, 'Слишком много попыток. Подождите 10 минут.');
    const b = await readBody(req);
    const name = normName(b.name).toLowerCase();
    const u = db.users.find(x => x.nameLower === name);
    if (!u || !b.authKey || !timingEqual(hashSecret(b.authKey, u.saltAuth), u.authHash)) {
      return bad(res, 403, 'Неверное имя или пароль');
    }
    const token = crypto.randomBytes(24).toString('hex');
    db.sessions[token] = { uid: u.id, exp: Date.now() + SESSION_TTL };
    u.lastSeen = Date.now();
    save();
    return json(res, 200, { token, user: publicUser(u), saltWrap: u.saltWrap, wrappedKeyByPass: u.wrappedKeyByPass, wrappedPriv: u.wrappedPriv || null });
  }

  // --- получить «завёрнутый» ключ каталога по кодовой фразе (для регистрации)
  if (pathname === '/api/invite' && method === 'POST') {
    if (throttle('invite:' + ip)) return bad(res, 429, 'Слишком много попыток. Подождите 10 минут.');
    const b = await readBody(req);
    if (!db.room) return bad(res, 409, 'Чат ещё не настроен');
    if (!b.codeProof || !timingEqual(hashSecret(b.codeProof, db.room.codeProofSalt), db.room.codeProofHash)) {
      return bad(res, 403, 'Неверная кодовая фраза чата');
    }
    return json(res, 200, { codeSalt: db.room.codeSalt, wrappedKeyByCode: db.room.wrappedKeyByCode });
  }

  if (pathname === '/api/register' && method === 'POST') {
    if (throttle('register:' + ip)) return bad(res, 429, 'Слишком много попыток. Подождите 10 минут.');
    const b = await readBody(req);
    if (!db.room) return bad(res, 409, 'Чат ещё не настроен');
    if (!b.codeProof || !timingEqual(hashSecret(b.codeProof, db.room.codeProofSalt), db.room.codeProofHash)) {
      return bad(res, 403, 'Неверная кодовая фраза чата');
    }
    const name = normName(b.name);
    if (name.length < 2 || name.length > 32) return bad(res, 400, 'Имя: от 2 до 32 символов');
    if (db.users.some(x => x.nameLower === name.toLowerCase())) return bad(res, 409, 'Такое имя уже занято');
    for (const k of ['saltAuth', 'authKey', 'saltWrap', 'wrappedKeyByPass']) if (!b[k]) return bad(res, 400, 'Не хватает поля ' + k);
    const user = {
      id: uid(), name, nameLower: name.toLowerCase(), isAdmin: false,
      saltAuth: b.saltAuth, authHash: hashSecret(b.authKey, b.saltAuth),
      saltWrap: b.saltWrap,
      wrappedKeyByPass: b.wrappedKeyByPass, avatar: null,
      pub: b.pub || null, wrappedPriv: b.wrappedPriv || null, reads: {},
      createdAt: Date.now(), lastSeen: Date.now(), activeAt: Date.now()
    };
    db.users.push(user);
    const token = crypto.randomBytes(24).toString('hex');
    db.sessions[token] = { uid: user.id, exp: Date.now() + SESSION_TTL };
    saveNow();
    return json(res, 200, { token, user: publicUser(user), saltWrap: user.saltWrap, wrappedKeyByPass: user.wrappedKeyByPass, wrappedPriv: user.wrappedPriv });
  }

  // ------------------------------------------------ дальше только с токеном
  const session = auth(req);
  if (!session) return bad(res, 401, 'Нужен вход');
  const me = session.user;

  if (pathname === '/api/logout' && method === 'POST') {
    delete db.sessions[session.token]; save();
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/sync' && method === 'GET') {
    const since = Number(query.get('since') || 0);
    if (query.get('active') === '1') me.activeAt = Date.now();
    const mine = new Set(myChats(me.id).map(c => c.id));
    const msgs = db.messages.filter(m => m.seq > since && mine.has(m.chat));
    return json(res, 200, {
      messages: msgs,
      chats: myChats(me.id).map(c => publicChat(c, me.id)),
      seq: db.seq,
      users: db.users.map(publicUser),
      usage: usage(),
      me: publicUser(me),
      serverTime: Date.now()
    });
  }

  // --- отметка «прочитано» (bucket: <chatId> | thr:<messageId>)
  if (pathname === '/api/read' && method === 'POST') {
    const b = await readBody(req);
    const bucket = String(b.bucket || '');
    const seq = Number(b.seq || 0);
    if (!bucket || !seq) return bad(res, 400, 'Нужны bucket и seq');
    if (!bucket.startsWith('thr:') && !isMember(chatById(bucket), me.id)) return bad(res, 403, 'Это не ваш чат');
    me.reads = me.reads || {};
    if ((me.reads[bucket] || 0) < seq) { me.reads[bucket] = seq; save(); }
    return json(res, 200, { ok: true });
  }

  // ------------------------------------------------ чаты
  if (pathname === '/api/chats' && method === 'POST') {
    const b = await readBody(req);
    const members = [...new Set([me.id, ...(Array.isArray(b.members) ? b.members : [])])];
    if (members.length > MAX_MEMBERS) return bad(res, 400, 'Слишком много участников');
    for (const id of members) if (!db.users.some(u => u.id === id)) return bad(res, 404, 'Участник не найден');
    if (!b.titleBlob || typeof b.titleBlob !== 'string' || b.titleBlob.length > 8192) return bad(res, 400, 'Нужно название чата');
    const keys = {};
    for (const id of members) {
      const k = (b.keys || {})[id];
      if (!k || !k.blob) return bad(res, 400, 'Нет ключа для участника ' + id);
      keys[id] = { by: me.id, blob: String(k.blob).slice(0, 4096) };
    }
    const chat = {
      id: uid(), kind: 'group', titleBlob: b.titleBlob, ownerId: me.id,
      members, keys, createdAt: Date.now()
    };
    db.chats.push(chat);
    db.seq++;
    saveNow();
    return json(res, 200, { chat: publicChat(chat, me.id) });
  }

  if (pathname === '/api/dm' && method === 'POST') {
    const b = await readBody(req);
    const peer = db.users.find(u => u.id === b.peer);
    if (!peer) return bad(res, 404, 'Участник не найден');
    if (peer.id === me.id) return bad(res, 400, 'Нельзя писать самому себе');
    const chat = ensureDm(me.id, peer.id);
    return json(res, 200, { chat: publicChat(chat, me.id) });
  }

  if (pathname.startsWith('/api/chats/')) {
    const parts = pathname.split('/'); // '', api, chats, :id, action?
    const chat = chatById(decodeURIComponent(parts[3] || ''));
    const action = parts[4];
    if (!chat) return bad(res, 404, 'Чат не найден');
    if (!isMember(chat, me.id)) return bad(res, 403, 'Вы не участник этого чата');
    const isOwner = chat.kind === 'group' && chat.ownerId === me.id;

    if (action === 'title' && method === 'POST') {
      if (chat.kind !== 'group') return bad(res, 400, 'У личной переписки нет названия');
      const b = await readBody(req);
      if (!b.titleBlob || b.titleBlob.length > 8192) return bad(res, 400, 'Нужно название');
      chat.titleBlob = b.titleBlob; chat.titlePlain = null;
      db.seq++; saveNow();
      return json(res, 200, { chat: publicChat(chat, me.id) });
    }

    if (action === 'members' && method === 'POST') {
      if (chat.kind !== 'group') return bad(res, 400, 'Состав личной переписки менять нельзя');
      const b = await readBody(req);
      for (const a of (b.add || [])) {
        const u = db.users.find(x => x.id === a.id);
        if (!u) return bad(res, 404, 'Участник не найден');
        if (!a.blob) return bad(res, 400, 'Нет ключа для нового участника');
        if (chat.members.length >= MAX_MEMBERS) return bad(res, 400, 'Слишком много участников');
        if (!chat.members.includes(u.id)) chat.members.push(u.id);
        chat.keys[u.id] = { by: me.id, blob: String(a.blob).slice(0, 4096) };
      }
      for (const id of (b.remove || [])) {
        if (!isOwner) return bad(res, 403, 'Исключать может только создатель чата');
        if (id === chat.ownerId) return bad(res, 400, 'Нельзя исключить создателя чата');
        chat.members = chat.members.filter(x => x !== id);
        delete chat.keys[id];
      }
      db.seq++; saveNow();
      return json(res, 200, { chat: publicChat(chat, me.id) });
    }

    if (action === 'leave' && method === 'POST') {
      if (chat.kind !== 'group') return bad(res, 400, 'Из личной переписки выйти нельзя');
      if (isOwner && chat.members.length > 1) return bad(res, 400, 'Сначала передайте чат другому участнику или исключите всех');
      chat.members = chat.members.filter(x => x !== me.id);
      delete chat.keys[me.id];
      if (!chat.members.length) {
        db.chats = db.chats.filter(c => c.id !== chat.id);
        db.messages = db.messages.filter(m => m.chat !== chat.id);
      }
      db.seq++; saveNow();
      return json(res, 200, { ok: true, usage: usage() });
    }

    if (action === 'owner' && method === 'POST') {
      if (!isOwner) return bad(res, 403, 'Только создатель чата');
      const b = await readBody(req);
      if (!chat.members.includes(b.id)) return bad(res, 400, 'Новый владелец должен быть участником чата');
      chat.ownerId = b.id;
      db.seq++; saveNow();
      return json(res, 200, { chat: publicChat(chat, me.id) });
    }

    if (action === 'archive' && method === 'POST') {
      if (chat.kind === 'group' && !isOwner) return bad(res, 403, 'Архивировать чат может создатель');
      const b = await readBody(req);
      const msgs = db.messages.filter(m => m.chat === chat.id);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = `archive-${chat.id}-${stamp}.json`;
      const payload = {
        app: 'Alt-Джентельмены',
        format: 'encrypted-archive-v2',
        createdAt: Date.now(),
        note: 'Сообщения зашифрованы ключом чата (AES-256-GCM). Открывается только участниками этого чата.',
        chat: { id: chat.id, kind: chat.kind, titleBlob: chat.titleBlob || null, titlePlain: chat.titlePlain || null, members: chat.members },
        users: db.users.map(u => ({ id: u.id, name: u.name })),
        messages: msgs
      };
      try {
        fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
        fs.writeFileSync(path.join(ARCHIVE_DIR, file), JSON.stringify(payload));
      } catch (e) {
        return bad(res, 500, 'Не удалось сохранить архив на сервере: ' + e.message);
      }
      const rec = { file, createdAt: Date.now(), count: msgs.length, bytes: msgs.reduce((a, m) => a + (m.bytes || 0), 0), chat: chat.id };
      db.archives.push(rec);
      if (b.reset) {
        db.messages = db.messages.filter(m => m.chat !== chat.id);
        db.seq++;
      }
      saveNow();
      return json(res, 200, { archive: rec, usage: usage(), cleared: !!b.reset });
    }

    if (action === 'archives' && method === 'GET') {
      return json(res, 200, { archives: db.archives.filter(a => a.chat === chat.id).reverse() });
    }
  }

  // ------------------------------------------------ сообщения
  if (pathname === '/api/messages' && method === 'POST') {
    const b = await readBody(req);
    if (!b.blob || typeof b.blob !== 'string') return bad(res, 400, 'Пустое сообщение');
    const u = usage();
    if (u.bytes + b.blob.length > STORAGE_LIMIT) {
      return bad(res, 507, 'Память чата заполнена. Заархивируйте историю, чтобы продолжить.');
    }
    const chat = chatById(b.chat);
    if (!chat) return bad(res, 404, 'Чат не найден');
    if (!isMember(chat, me.id)) return bad(res, 403, 'Вы не участник этого чата');

    let parent = null;
    if (b.parent) {
      const p = db.messages.find(x => x.id === b.parent);
      if (!p) return bad(res, 404, 'Исходное сообщение не найдено');
      if (p.chat !== chat.id) return bad(res, 400, 'Комментарий не из того чата');
      if (p.parent) return bad(res, 400, 'Комментировать можно только исходное сообщение');
      parent = p.id;
    }
    let quote = null;
    if (b.quote) {
      const q = db.messages.find(x => x.id === b.quote);
      if (!q) return bad(res, 404, 'Сообщение-ссылка не найдено');
      if (q.chat !== chat.id) return bad(res, 400, 'Ссылаться можно только на сообщение этого чата');
      quote = q.id;
    }
    const m = { id: uid(), seq: ++db.seq, uid: me.id, ts: Date.now(), blob: b.blob, bytes: b.blob.length, chat: chat.id, parent, quote };
    db.messages.push(m);
    me.reads = me.reads || {};
    me.reads[parent ? 'thr:' + parent : chat.id] = m.seq;
    save();
    return json(res, 200, { message: m, usage: usage() });
  }

  if (pathname.startsWith('/api/messages/') && method === 'DELETE') {
    const id = pathname.split('/')[3];
    const victim = db.messages.find(m => m.id === id);
    if (!victim) return bad(res, 404, 'Сообщение не найдено');
    const chat = chatById(victim.chat);
    if (!isMember(chat, me.id)) return bad(res, 403, 'Это не ваш чат');
    const canDelete = victim.uid === me.id || (chat.kind === 'group' && chat.ownerId === me.id);
    if (!canDelete) return bad(res, 403, 'Удалять может автор или создатель чата');
    db.messages = db.messages.filter(m => m.id !== id && m.parent !== id);
    for (const m of db.messages) if (m.quote === id) m.quote = null;
    db.seq++;
    save();
    return json(res, 200, { ok: true, usage: usage() });
  }

  // --- профиль: имя, аватар, пароль
  if (pathname === '/api/profile' && method === 'POST') {
    const b = await readBody(req);
    if (b.name !== undefined) {
      const name = normName(b.name);
      if (name.length < 2 || name.length > 32) return bad(res, 400, 'Имя: от 2 до 32 символов');
      if (db.users.some(x => x.nameLower === name.toLowerCase() && x.id !== me.id)) return bad(res, 409, 'Такое имя уже занято');
      // при смене имени соли остаются прежними — ключи не ломаются
      me.name = name; me.nameLower = name.toLowerCase();
    }
    if (b.avatar !== undefined) {
      if (b.avatar && b.avatar.length > 400 * 1024) return bad(res, 413, 'Аватар слишком большой');
      me.avatar = b.avatar || null;
    }
    if (b.keys && b.keys.pub && b.keys.wrappedPriv && !me.pub) {
      me.pub = b.keys.pub; me.wrappedPriv = b.keys.wrappedPriv;
    }
    if (b.password) {
      const p = b.password; // { saltAuth, authKey, saltWrap, wrappedKeyByPass, oldAuthKey, wrappedPriv }
      if (!p.oldAuthKey || !timingEqual(hashSecret(p.oldAuthKey, me.saltAuth), me.authHash)) {
        return bad(res, 403, 'Текущий пароль неверен');
      }
      for (const k of ['saltAuth', 'authKey', 'saltWrap', 'wrappedKeyByPass']) if (!p[k]) return bad(res, 400, 'Не хватает поля ' + k);
      me.saltAuth = p.saltAuth;
      me.authHash = hashSecret(p.authKey, p.saltAuth);
      me.saltWrap = p.saltWrap;
      me.wrappedKeyByPass = p.wrappedKeyByPass;
      if (p.wrappedPriv) me.wrappedPriv = p.wrappedPriv;
      // прочие сессии этого пользователя закрываем
      for (const [t, s] of Object.entries(db.sessions)) if (s.uid === me.id && t !== session.token) delete db.sessions[t];
    }
    saveNow();
    return json(res, 200, { user: publicUser(me), wrappedPriv: me.wrappedPriv || null });
  }

  // ------------------------------------------------ администратор мессенджера
  if (pathname.startsWith('/api/admin/')) {
    if (!me.isAdmin) return bad(res, 403, 'Только для администратора');

    if (pathname === '/api/admin/code' && method === 'POST') {
      const b = await readBody(req);
      for (const k of ['codeProofSalt', 'codeProof', 'codeSalt', 'wrappedKeyByCode']) if (!b[k]) return bad(res, 400, 'Не хватает поля ' + k);
      db.room = {
        codeProofSalt: b.codeProofSalt,
        codeProofHash: hashSecret(b.codeProof, b.codeProofSalt),
        codeSalt: b.codeSalt,
        wrappedKeyByCode: b.wrappedKeyByCode,
        rotatedAt: Date.now()
      };
      saveNow();
      return json(res, 200, { ok: true });
    }

    if (pathname.startsWith('/api/admin/users/')) {
      const parts = pathname.split('/'); // '', api, admin, users, :id, action?
      const id = parts[4], action = parts[5];
      const u = db.users.find(x => x.id === id);
      if (!u) return bad(res, 404, 'Участник не найден');
      if (method === 'DELETE') {
        if (u.id === me.id) return bad(res, 400, 'Нельзя удалить самого себя');
        db.users = db.users.filter(x => x.id !== id);
        for (const [t, s] of Object.entries(db.sessions)) if (s.uid === id) delete db.sessions[t];
        // выводим из всех чатов; чаты, где он был единственным, удаляем вместе с историей
        for (const c of db.chats) {
          c.members = c.members.filter(x => x !== id);
          if (c.keys) delete c.keys[id];
          if (c.ownerId === id) c.ownerId = c.members[0] || null;
        }
        const dead = db.chats.filter(c => !c.members.length).map(c => c.id);
        db.chats = db.chats.filter(c => c.members.length);
        db.messages = db.messages.filter(m => !dead.includes(m.chat));
        db.seq++;
        saveNow();
        return json(res, 200, { ok: true });
      }
      if (method === 'POST' && action === 'admin') {
        const b = await readBody(req);
        if (u.id === me.id && b.value === false) return bad(res, 400, 'Нельзя снять права с самого себя');
        u.isAdmin = !!b.value;
        saveNow();
        return json(res, 200, { user: publicUser(u) });
      }
    }

    if (pathname === '/api/admin/archives' && method === 'GET') {
      return json(res, 200, { archives: db.archives.slice().reverse() });
    }
  }

  // --- выгрузка своих чатов (данные всё равно зашифрованы)
  if (pathname === '/api/export' && method === 'GET') {
    const mine = new Set(myChats(me.id).map(c => c.id));
    const payload = {
      app: 'Alt-Джентельмены',
      format: 'encrypted-archive-v2',
      createdAt: Date.now(),
      chats: myChats(me.id).map(c => publicChat(c, me.id)),
      users: db.users.map(u => ({ id: u.id, name: u.name })),
      messages: db.messages.filter(m => mine.has(m.chat))
    };
    const body = Buffer.from(JSON.stringify(payload));
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="alt-gentlemen-export-${new Date().toISOString().slice(0, 10)}.json"`,
      'Content-Length': body.length
    });
    return res.end(body);
  }

  if (pathname.startsWith('/api/archives/') && method === 'GET') {
    const file = path.basename(decodeURIComponent(pathname.split('/')[3] || ''));
    const rec = db.archives.find(a => a.file === file);
    const full = path.join(ARCHIVE_DIR, file);
    if (!rec || !full.startsWith(ARCHIVE_DIR) || !fs.existsSync(full)) return bad(res, 404, 'Архив не найден');
    const chat = chatById(rec.chat);
    // архив скачивают только те, кто состоит(ял) в этом чате
    let allowed = isMember(chat, me.id);
    if (!allowed) {
      try { allowed = (JSON.parse(fs.readFileSync(full, 'utf8')).chat.members || []).includes(me.id); } catch (e) {}
    }
    if (!allowed) return bad(res, 403, 'Это архив чужого чата');
    const body = fs.readFileSync(full);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${file}"`,
      'Content-Length': body.length
    });
    return res.end(body);
  }

  return bad(res, 404, 'Неизвестный метод API');
}

// ---------------------------------------------------------------- сервер
loadDb();

// Необязательный HTTPS: нужен, чтобы чат открывался с телефона по локальной сети
// (браузеры дают доступ к шифрованию только на https или на localhost).
// Включается переменной окружения HTTPS=1, сертификат создаётся сам (нужен openssl).
function httpsOptions() {
  if (process.env.HTTPS !== '1') return null;
  const key = path.join(DATA_DIR, 'key.pem'), cert = path.join(DATA_DIR, 'cert.pem');
  if (!fs.existsSync(key) || !fs.existsSync(cert)) {
    console.log('  Создаю самоподписанный сертификат…');
    const { execFileSync } = require('child_process');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3650',
      '-keyout', key, '-out', cert, '-subj', '/CN=alt-gentlemen'], { stdio: 'ignore' });
  }
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

const handler = async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  try {
    if (url.pathname.startsWith('/api/')) {
      await api(req, res, url.pathname, url.searchParams);
    } else {
      serveStatic(req, res, url.pathname);
    }
  } catch (e) {
    if (!res.headersSent) {
      const msg = e.message === 'too-large' ? 'Файл слишком большой' : (e.message === 'bad-json' ? 'Некорректный запрос' : 'Ошибка сервера');
      bad(res, e.message === 'too-large' ? 413 : 500, msg);
    }
    if (!['too-large', 'bad-json'].includes(e.message)) console.error(e);
  }
};

let tls = null;
try { tls = httpsOptions(); } catch (e) { console.error('Не удалось включить HTTPS (нужен openssl):', e.message); }
const server = tls ? require('https').createServer(tls, handler) : http.createServer(handler);
const scheme = tls ? 'https' : 'http';

server.listen(PORT, HOST, () => {
  const nets = require('os').networkInterfaces();
  const lan = Object.values(nets).flat().filter(n => n && n.family === 'IPv4' && !n.internal).map(n => n.address);
  console.log('');
  console.log('  ╔══════════════════════════════════════════════╗');
  console.log('  ║           A L T - Д Ж Е Н Т Е Л Ь М Е Н Ы    ║');
  console.log('  ╚══════════════════════════════════════════════╝');
  console.log('');
  console.log('  Мессенджер запущен. Открывайте в браузере:');
  console.log('    • на этом компьютере: ' + scheme + '://localhost:' + PORT);
  lan.forEach(a => console.log('    • в этой Wi-Fi сети:  ' + scheme + '://' + a + ':' + PORT));
  if (!tls) console.log('      (с телефона по сети — запустите с HTTPS=1, см. README)');
  console.log('');
  console.log('  Память: лимит ' + (STORAGE_LIMIT / 1024 / 1024).toFixed(0) + ' МБ, занято ' + (usage().bytes / 1024 / 1024).toFixed(2) + ' МБ'
    + ' · чатов: ' + db.chats.length);
  console.log('  Данные: ' + DB_FILE);
  console.log('  Остановить: Ctrl + C');
  console.log('');
});
