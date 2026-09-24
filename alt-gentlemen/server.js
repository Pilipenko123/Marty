#!/usr/bin/env node
/**
 * Alt-Джентельмены — приватный чат со сквозным шифрованием.
 * Сервер без внешних зависимостей (только стандартная библиотека Node.js >= 18).
 *
 * Сервер НИКОГДА не видит: пароли, кодовую фразу чата, тексты сообщений,
 * вложения и аватары. Всё шифруется в браузере (AES-256-GCM),
 * на диск попадают только зашифрованные блобы.
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
// Лимит «памяти» чата (объём переписки). Меняется переменной окружения.
const STORAGE_LIMIT = Number(process.env.STORAGE_LIMIT || 25 * 1024 * 1024); // 25 МБ
const MAX_BODY = 12 * 1024 * 1024; // максимум 12 МБ на один запрос (вложения)
const SESSION_TTL = 60 * 24 * 60 * 60 * 1000; // 60 дней

// ---------------------------------------------------------------- хранилище
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

let db = {
  version: 1,
  createdAt: null,
  room: null, // { codeProofSalt, codeProofHash, codeSalt, wrappedKeyByCode, rotatedAt }
  users: [],  // { id, name, nameLower, isAdmin, saltAuth, saltWrap, authHash, wrappedKeyByPass, avatar, createdAt, lastSeen }
  messages: [], // { id, seq, uid, ts, blob, bytes, edited }
  sessions: {}, // token -> { uid, exp }
  seq: 0,
  serverSecret: null,
  archives: [] // { file, createdAt, count, bytes }
};

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
  return { id: u.id, name: u.name, isAdmin: !!u.isAdmin, avatar: u.avatar || null, createdAt: u.createdAt, lastSeen: u.lastSeen || 0 };
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
  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404');
  }
  const body = fs.readFileSync(file);
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Content-Length': body.length, 'Cache-Control': 'no-cache' });
  res.end(body);
}

// ---------------------------------------------------------------- API
async function api(req, res, pathname, query) {
  const method = req.method;
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

  // --- публичное состояние
  if (pathname === '/api/state' && method === 'GET') {
    return json(res, 200, {
      setupRequired: !db.room,
      title: 'Alt-Джентельмены',
      codeProofSalt: db.room ? db.room.codeProofSalt : null,
      usage: usage()
    });
  }

  // --- первичная настройка (создаётся администратор и ключ комнаты)
  if (pathname === '/api/setup' && method === 'POST') {
    if (db.room) return bad(res, 409, 'Чат уже настроен');
    const b = await readBody(req);
    const name = normName(b.name);
    if (!name) return bad(res, 400, 'Нужно имя');
    const need = ['saltAuth', 'saltWrap', 'authKey', 'wrappedKeyByPass', 'codeProofSalt', 'codeProof', 'codeSalt', 'wrappedKeyByCode'];
    for (const k of need) if (!b[k]) return bad(res, 400, 'Не хватает поля ' + k);
    db.room = {
      codeProofSalt: b.codeProofSalt,
      codeProofHash: hashSecret(b.codeProof, b.codeProofSalt),
      codeSalt: b.codeSalt,
      wrappedKeyByCode: b.wrappedKeyByCode,
      rotatedAt: Date.now()
    };
    const user = {
      id: uid(), name, nameLower: name.toLowerCase(), isAdmin: true,
      saltAuth: b.saltAuth, saltWrap: b.saltWrap,
      authHash: hashSecret(b.authKey, b.saltAuth),
      wrappedKeyByPass: b.wrappedKeyByPass, avatar: null,
      createdAt: Date.now(), lastSeen: Date.now()
    };
    db.users.push(user);
    const token = crypto.randomBytes(24).toString('hex');
    db.sessions[token] = { uid: user.id, exp: Date.now() + SESSION_TTL };
    saveNow();
    return json(res, 200, { token, user: publicUser(user), saltWrap: user.saltWrap, wrappedKeyByPass: user.wrappedKeyByPass });
  }

  // --- соль для вывода ключей по имени (нужна и для входа, и для регистрации)
  if (pathname === '/api/salt' && method === 'POST') {
    const b = await readBody(req);
    const name = normName(b.name);
    if (!name) return bad(res, 400, 'Нужно имя');
    const u = db.users.find(x => x.nameLower === name.toLowerCase());
    return json(res, 200, {
      saltAuth: u ? u.saltAuth : stableSalt('auth:' + name.toLowerCase()),
      saltWrap: u ? u.saltWrap : stableSalt('wrap:' + name.toLowerCase())
    });
  }

  // --- вход
  if (pathname === '/api/login' && method === 'POST') {
    if (throttle('login:' + ip)) return bad(res, 429, 'Слишком много попыток. Подождите 10 минут.');
    const b = await readBody(req);
    const name = normName(b.name);
    const u = db.users.find(x => x.nameLower === String(name).toLowerCase());
    if (!u || !b.authKey || !timingEqual(hashSecret(b.authKey, u.saltAuth), u.authHash)) {
      return bad(res, 401, 'Неверное имя или пароль');
    }
    const token = crypto.randomBytes(24).toString('hex');
    db.sessions[token] = { uid: u.id, exp: Date.now() + SESSION_TTL };
    u.lastSeen = Date.now();
    save();
    return json(res, 200, { token, user: publicUser(u), saltWrap: u.saltWrap, wrappedKeyByPass: u.wrappedKeyByPass });
  }

  // --- получить «завёрнутый» ключ комнаты по кодовой фразе (для регистрации)
  if (pathname === '/api/invite' && method === 'POST') {
    if (throttle('invite:' + ip)) return bad(res, 429, 'Слишком много попыток. Подождите 10 минут.');
    if (!db.room) return bad(res, 409, 'Чат не настроен');
    const b = await readBody(req);
    if (!b.codeProof || !timingEqual(hashSecret(b.codeProof, db.room.codeProofSalt), db.room.codeProofHash)) {
      return bad(res, 403, 'Неверная кодовая фраза чата');
    }
    return json(res, 200, { codeSalt: db.room.codeSalt, wrappedKeyByCode: db.room.wrappedKeyByCode });
  }

  // --- регистрация
  if (pathname === '/api/register' && method === 'POST') {
    if (throttle('reg:' + ip)) return bad(res, 429, 'Слишком много попыток. Подождите 10 минут.');
    if (!db.room) return bad(res, 409, 'Чат не настроен');
    const b = await readBody(req);
    const name = normName(b.name);
    if (name.length < 2 || name.length > 32) return bad(res, 400, 'Имя: от 2 до 32 символов');
    if (db.users.some(x => x.nameLower === name.toLowerCase())) return bad(res, 409, 'Такое имя уже занято');
    if (!b.codeProof || !timingEqual(hashSecret(b.codeProof, db.room.codeProofSalt), db.room.codeProofHash)) {
      return bad(res, 403, 'Неверная кодовая фраза чата');
    }
    for (const k of ['saltAuth', 'saltWrap', 'authKey', 'wrappedKeyByPass']) if (!b[k]) return bad(res, 400, 'Не хватает поля ' + k);
    const user = {
      id: uid(), name, nameLower: name.toLowerCase(), isAdmin: false,
      saltAuth: b.saltAuth, saltWrap: b.saltWrap,
      authHash: hashSecret(b.authKey, b.saltAuth),
      wrappedKeyByPass: b.wrappedKeyByPass, avatar: null,
      createdAt: Date.now(), lastSeen: Date.now()
    };
    db.users.push(user);
    const token = crypto.randomBytes(24).toString('hex');
    db.sessions[token] = { uid: user.id, exp: Date.now() + SESSION_TTL };
    saveNow();
    return json(res, 200, { token, user: publicUser(user), saltWrap: user.saltWrap, wrappedKeyByPass: user.wrappedKeyByPass });
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
    const msgs = db.messages.filter(m => m.seq > since);
    return json(res, 200, {
      messages: msgs,
      seq: db.seq,
      users: db.users.map(publicUser),
      usage: usage(),
      me: publicUser(me),
      serverTime: Date.now()
    });
  }

  if (pathname === '/api/messages' && method === 'POST') {
    const b = await readBody(req);
    if (!b.blob || typeof b.blob !== 'string') return bad(res, 400, 'Пустое сообщение');
    const u = usage();
    if (u.bytes + b.blob.length > STORAGE_LIMIT) {
      return bad(res, 507, 'Память чата заполнена. Заархивируйте историю, чтобы продолжить.');
    }
    const m = { id: uid(), seq: ++db.seq, uid: me.id, ts: Date.now(), blob: b.blob, bytes: b.blob.length, kind: b.kind || 'text' };
    db.messages.push(m);
    save();
    return json(res, 200, { message: m, usage: usage() });
  }

  if (pathname.startsWith('/api/messages/') && method === 'DELETE') {
    const id = pathname.split('/')[3];
    const i = db.messages.findIndex(m => m.id === id);
    if (i < 0) return bad(res, 404, 'Сообщение не найдено');
    if (db.messages[i].uid !== me.id && !me.isAdmin) return bad(res, 403, 'Можно удалять только свои сообщения');
    db.messages.splice(i, 1);
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
    if (b.password) {
      const p = b.password; // { saltAuth, authKey, saltWrap, wrappedKeyByPass, oldAuthKey }
      if (!p.oldAuthKey || !timingEqual(hashSecret(p.oldAuthKey, me.saltAuth), me.authHash)) {
        return bad(res, 403, 'Текущий пароль неверен');
      }
      for (const k of ['saltAuth', 'authKey', 'saltWrap', 'wrappedKeyByPass']) if (!p[k]) return bad(res, 400, 'Не хватает поля ' + k);
      me.saltAuth = p.saltAuth;
      me.authHash = hashSecret(p.authKey, p.saltAuth);
      me.saltWrap = p.saltWrap;
      me.wrappedKeyByPass = p.wrappedKeyByPass;
      // прочие сессии этого пользователя закрываем
      for (const [t, s] of Object.entries(db.sessions)) if (s.uid === me.id && t !== session.token) delete db.sessions[t];
    }
    saveNow();
    return json(res, 200, { user: publicUser(me) });
  }

  // ------------------------------------------------ администратор
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

    if (pathname === '/api/admin/archive' && method === 'POST') {
      const b = await readBody(req);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = `archive-${stamp}.json`;
      const payload = {
        app: 'Alt-Джентельмены',
        format: 'encrypted-archive-v1',
        createdAt: Date.now(),
        note: 'Сообщения зашифрованы ключом комнаты (AES-256-GCM). Для чтения нужна кодовая фраза чата.',
        room: { codeSalt: db.room.codeSalt },
        users: db.users.map(u => ({ id: u.id, name: u.name, avatar: u.avatar || null })),
        messages: db.messages
      };
      fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
      fs.writeFileSync(path.join(ARCHIVE_DIR, file), JSON.stringify(payload));
      const rec = { file, createdAt: Date.now(), count: db.messages.length, bytes: usage().bytes };
      db.archives.push(rec);
      if (b.reset) { db.messages = []; db.seq++; }
      saveNow();
      return json(res, 200, { archive: rec, usage: usage(), cleared: !!b.reset });
    }

    if (pathname === '/api/admin/archives' && method === 'GET') {
      return json(res, 200, { archives: db.archives.slice().reverse() });
    }
  }

  // --- скачать архив / выгрузку (доступно любому участнику: данные всё равно шифрованные)
  if (pathname === '/api/export' && method === 'GET') {
    const payload = {
      app: 'Alt-Джентельмены',
      format: 'encrypted-archive-v1',
      createdAt: Date.now(),
      room: { codeSalt: db.room.codeSalt },
      users: db.users.map(u => ({ id: u.id, name: u.name, avatar: u.avatar || null })),
      messages: db.messages
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
    const full = path.join(ARCHIVE_DIR, file);
    if (!full.startsWith(ARCHIVE_DIR) || !fs.existsSync(full)) return bad(res, 404, 'Архив не найден');
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
  console.log('  Чат запущен. Открывайте в браузере:');
  console.log('    • на этом компьютере: ' + scheme + '://localhost:' + PORT);
  lan.forEach(a => console.log('    • в этой Wi-Fi сети:  ' + scheme + '://' + a + ':' + PORT));
  if (!tls) console.log('      (с телефона по сети — запустите с HTTPS=1, см. README)');
  console.log('');
  console.log('  Память чата: лимит ' + (STORAGE_LIMIT / 1024 / 1024).toFixed(0) + ' МБ, занято ' + (usage().bytes / 1024 / 1024).toFixed(2) + ' МБ');
  console.log('  Данные: ' + DB_FILE);
  console.log('  Остановить: Ctrl + C');
  console.log('');
});
