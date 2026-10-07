'use strict';
/**
 * SEGA-CHAT — вся логика мессенджера.
 *
 * Файл не знает, где лежат данные и кто принёс запрос: он получает разобранный
 * запрос и возвращает готовый ответ. Благодаря этому один и тот же код работает
 * и на домашнем компьютере (lib/store-file.js), и в облаке Yandex Cloud
 * (lib/store-ydb.js + cloud/index.js).
 *
 * Сервер НИКОГДА не видит: пароли, кодовую фразу, названия чатов, тексты
 * сообщений, вложения и аватары — всё шифруется в браузере (AES-256-GCM).
 */

const crypto = require('crypto');
const backup = require('./backup');

const MB = 1024 * 1024;

/** Отметка выпуска: её видно в подвале настроек и в /api/state. */
const BUILD = 'pkg3-40';
/** Предел выдачи файла через функцию (у облачной функции потолок ответа 3,5 МБ). */
const BACKUP_DL_MAX = 3.2 * MB;

function createApi(store, opts = {}) {
  const STORAGE_LIMIT = Number(opts.storageLimit || process.env.STORAGE_LIMIT || 250 * MB);
  const SESSION_TTL = Number(opts.sessionTtl || 60 * 24 * 60 * 60 * 1000); // 60 дней
  const MAX_MEMBERS = Number(opts.maxMembers || process.env.MAX_MEMBERS || 200);
  const MAX_UPLOAD = Number(opts.maxUpload || process.env.MAX_UPLOAD || 3.1 * MB);
  const SYNC_MAX_COUNT = Number(opts.syncMaxCount || 400);
  const SYNC_MAX_BYTES = Number(opts.syncMaxBytes || process.env.SYNC_MAX_BYTES || 2.8 * MB);
  const UP_MAX = Number(opts.upMax || process.env.UP_MAX || 25 * MB);   // предел одного вложения
  const UP_CHUNK = 900000;                                               // символов в одном куске загрузки

  let db = null;

  // ------------------------------------------------------------- ответы
  const J = (status, json, headers) => ({ status, json, headers });
  const E = (status, msg) => ({ status, json: { error: msg } });
  const FILE = (text, name) => ({
    status: 200,
    body: Buffer.from(text),
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name.replace(/[^\w.\-]/g, '_')}"`
    }
  });
  /** То же, но для двоичных данных (резервная копия, картинка). */
  const BIN = (buf, name, type) => ({
    status: 200,
    body: Buffer.isBuffer(buf) ? buf : Buffer.from(buf),
    headers: {
      'Content-Type': type || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${String(name).replace(/[^\w.\-]/g, '_')}"`
    }
  });

  // ------------------------------------------------------------- утилиты
  function hashSecret(hexValue, saltHex) {
    // scrypt поверх значения, которое клиент вывел из пароля (сам пароль сюда не попадает)
    return crypto.scryptSync(Buffer.from(hexValue, 'hex'), Buffer.from(saltHex, 'hex'), 32).toString('hex');
  }
  /** Проверка кодового слова мессенджера: клиент присылает proof, выведенный из слова. */
  const normFile = (f) => String(f || '').replace(/[^\w.\-]/g, '').toLowerCase();
  const findArchive = (file) => db.archives.find(a => a.file === file)
    || db.archives.find(a => normFile(a.file) === normFile(file));
  const arcDiag = (file) => '[arc] запрошен: ' + file + ' | в базе: ' + db.archives.length
    + ' | примеры: ' + db.archives.slice(0, 3).map(a => a.file).join(', ');
  function verifyCodeProof(proof) {
    if (!db.room || !proof) return false;
    return timingEqual(hashSecret(proof, db.room.codeProofSalt), db.room.codeProofHash);
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
  const safeFile = (s) => String(s || '').replace(/[^\w.\-]/g, '').slice(0, 120);

  function avatarBytes() {
    return db.users.reduce((a, u) => a + (u.avatarLen || 0), 0);
  }
  /**
   * ЧЕСТНАЯ шкала памяти: показывает не только сами шифротела, но и всё, что
   * физически ложится в базу вместе с ними. Раньше счётчик занижал занятое
   * место примерно вдвое (замер tools/measure-space.mjs: 2,93 МБ на шкале
   * против 3,67 МБ в таблице), и лимит срабатывал «внезапно».
   *
   * Что добавлено:
   *   • каждое сообщение — это ДВЕ строки в базе (само сообщение + указатель
   *     «id → чат») плюс JSON-конверт и атрибуты: ~286 Б сверх шифротела;
   *   • вложения лежат в базе текстом base64, а он на треть длиннее байтов файла.
   */
  const MSG_ROW_OVERHEAD = Number(process.env.MSG_ROW_OVERHEAD || 286);
  const UP_B64 = 4 / 3;
  function usage() {
    const arcBytes = db.archives.reduce((a, r) => a + (r.bytes || 0), 0);
    const chatAssets = db.chats.reduce((a, c) => a + (c.wallLen || 0) + (c.iconLen || 0), 0);
    const uploads = Math.ceil((db.upBytes || 0) * UP_B64);
    const overhead = db.stats.count * MSG_ROW_OVERHEAD;
    const bytes = db.stats.bytes + overhead + avatarBytes() + arcBytes + uploads + chatAssets;
    return {
      bytes, limit: STORAGE_LIMIT,
      percent: Math.min(100, Math.round(bytes / STORAGE_LIMIT * 1000) / 10),
      messages: db.stats.count,
      archives: db.archives.length,
      archiveBytes: arcBytes,
      // составляющие — для плавки «сколько чего занимает»
      parts: {
        messages: db.stats.bytes, overhead, uploads,
        avatars: avatarBytes(), archives: arcBytes, assets: chatAssets
      }
    };
  }

  function publicUser(u) {
    return {
      id: u.id, name: u.name, isAdmin: !!u.isAdmin,
      avatar: u.avatarRev || null,        // отпечаток: сама картинка скачивается через /api/avatar/:id
      status: u.status || null,           // короткий статус участника («на связи до шести»)
      createdAt: u.createdAt, lastSeen: u.lastSeen || 0, activeAt: u.activeAt || 0,
      pub: u.pub || null, reads: u.reads || {}
    };
  }

  // ------------------------------------------------------------- чаты
  const dmId = (a, b) => 'dm:' + [a, b].sort().join('|');
  const chatById = (id) => db.chats.find(c => c.id === id) || null;
  const isMember = (chat, userId) => !!chat && chat.members.includes(userId);
  const myChats = (userId) => db.chats.filter(c => c.members.includes(userId));

  function publicChat(c, meId) {
    const st = db.stats.chats[c.id] || { n: 0, b: 0, t: 0 };
    return {
      id: c.id, kind: c.kind, titleBlob: c.titleBlob || null, titlePlain: c.titlePlain || null,
      legacyRoomKey: !!c.legacyRoomKey, ownerId: c.ownerId || null, members: c.members,
      createdAt: c.createdAt, key: (c.keys && c.keys[meId]) || null,
      count: st.n, bytes: st.b, lastTs: st.t || c.createdAt || 0,
      archivedByName: c.archivedByName || (c.lastArchive ? c.lastArchive.byName : null) || null,
      archivedAt: c.archivedAt || (c.lastArchive ? (c.lastArchive.at || c.lastArchive.createdAt) : null) || null,
      archivedCount: c.archivedCount !== undefined ? c.archivedCount : (c.lastArchive ? c.lastArchive.count : null),
      clearedByName: c.clearedByName || null,
      clearedAt: c.clearedAt || null,
      clearedCount: c.clearedCount !== undefined && c.clearedCount !== null ? c.clearedCount : null,
      wall: c.wall || null, wallRev: c.wallRev || null, iconRev: c.iconRev || null,
      lastArchive: c.lastArchive || null,
      roles: c.roles || null, game: c.game || null, knocks: c.knocks || null
    };
  }

  /** Живые приглашения: адресат видит их до вступления в игру. */
  function openInvites(uid) {
    return db.chats
      .filter(c => c.kind === 'game' && c.game && c.game.status === 'invite' && c.game.invitee === uid)
      .map(c => ({ id: c.id, owner: c.ownerId, colorChoice: c.game.colorChoice, createdAt: c.createdAt }));
  }

  /** Открытые игры для тех, кто не участник: справочник «постучаться в зрители». */
  function openGames(uid) {
    return db.chats
      .filter(c => c.kind === 'game' && c.game && c.game.status === 'playing' && !c.members.includes(uid))
      .map(c => ({
        id: c.id, white: c.game.white, black: c.game.black,
        createdAt: c.createdAt, knocks: (c.knocks || []).length,
        moves: (db.stats.chats[c.id] || {}).n || 0
      }));
  }

  function ensureDm(a, b) {
    const id = dmId(a, b);
    let c = chatById(id);
    if (!c) {
      c = { id, kind: 'dm', members: [a, b].sort(), keys: {}, createdAt: Date.now() };
      db.chats.push(c);
      db.stats.chats[id] = { n: 0, b: 0, t: c.createdAt };
      save();
    }
    return c;
  }

  // ------------------------------------------------------------- счётчики истории
  function addStat(m, sign) {
    const s = db.stats, bytes = m.bytes || 0;
    s.bytes = Math.max(0, s.bytes + sign * bytes);
    s.count = Math.max(0, s.count + sign);
    const cs = s.chats[m.chat] || (s.chats[m.chat] = { n: 0, b: 0, t: 0 });
    cs.n = Math.max(0, cs.n + sign);
    cs.b = Math.max(0, cs.b + sign * bytes);
    if (sign > 0 && (m.ts || 0) > cs.t) cs.t = m.ts;
    save();
  }
  /** Удалить сообщения по признаку (они уже должны быть загружены). */
  function dropMessages(pred) {
    const gone = db.messages.filter(pred);
    if (!gone.length) return gone;
    db.messages = db.messages.filter(m => !pred(m));
    for (const m of gone) addStat(m, -1);
    store.dropMessages(gone);
    // «поколение» базы не трогаем: клиенты узнают об удалении из журнала изменений
    // и уберут только эти сообщения, не перечитывая всю историю
    for (const m of gone) noteChange(m, true);
    return gone;
  }
  /** Удалить всю историю чата, даже если она не загружена в память. */
  function dropChat(chatId) {
    db.messages = db.messages.filter(m => m.chat !== chatId);
    const cs = db.stats.chats[chatId];
    if (cs) {
      db.stats.bytes = Math.max(0, db.stats.bytes - cs.b);
      db.stats.count = Math.max(0, db.stats.count - cs.n);
    }
    delete db.stats.chats[chatId];
    store.dropChat(chatId);
    db.gen++;
    save();
  }
  /** Убирает «призраков»: личные чаты, оставшиеся вдвоём с исчезнувшим участником,
   *  пустые групповые чаты и незавершённые игры без игрока. Такой чат всё равно
   *  не открыть, а список он засоряет — поэтому стирается вместе с историей. */
  function pruneGhostChats() {
    const userIds = new Set(db.users.map(u => u.id));
    const dead = [];
    for (const c of db.chats) {
      const before = (c.members || []).length;
      c.members = (c.members || []).filter(id => userIds.has(id));
      if (c.members.length !== before) {
        if (c.keys) for (const k of Object.keys(c.keys)) if (!userIds.has(k)) delete c.keys[k];
        if (c.roles) for (const k of Object.keys(c.roles)) if (!userIds.has(k)) delete c.roles[k];
        c.knocks = (c.knocks || []).filter(id => userIds.has(id));
      }
      if (!c.members.length) dead.push(c.id);
      else if (c.kind === 'dm' && c.members.length < 2) dead.push(c.id);
      else if (c.kind === 'game') {
        const g = c.game || {};
        // приглашение живо, пока жив его создатель; начатая партия — пока оба игрока в составе;
        // завершённую не трогаем: зрители и игроки могут перечитывать историю
        if (g.status === 'invite') { if (!c.members.includes(c.ownerId)) dead.push(c.id); }
        else if (g.status === 'playing') {
          const players = [g.white, g.black].filter(Boolean);
          if (players.length < 2 || players.some(pl => !c.members.includes(pl))) dead.push(c.id);
        }
      }
    }
    if (!dead.length) return 0;
    for (const id of dead) dropChat(id);
    db.chats = db.chats.filter(c => !dead.includes(c.id));
    db.seq++;
    save();
    return dead.length;
  }

  async function findMessage(id) {
    if (!id) return null;
    return db.messages.find(x => x.id === id) || await store.getMessage(id);
  }

  // ------------------------------------------------------------- защита от перебора
  const attempts = new Map();
  function throttle(key) {
    const now = Date.now();
    const rec = attempts.get(key) || { n: 0, t: now };
    if (now - rec.t > 10 * 60 * 1000) { rec.n = 0; rec.t = now; }
    rec.n++; attempts.set(key, rec);
    return rec.n > 25; // больше 25 попыток за 10 минут — отказ
  }

  async function auth(req) {
    const h = req.headers['authorization'] || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return null;
    let s = db.sessions[token];
    if (s === undefined) s = await store.getSession(token);
    if (!s || s.exp < Date.now()) {
      if (s) { delete db.sessions[token]; store.dropSession(token); save(); }
      return null;
    }
    const u = db.users.find(x => x.id === s.uid);
    if (!u) return null;
    u.lastSeen = Date.now();
    store.touchPresence(u);
    return { user: u, token };
  }

  let dirty = false;
  function save() { dirty = true; }

  // ------------------------------------------------------------- уведомления
  // Облачная функция засыпает сразу после того, как ответила браузеру, поэтому
  // рассылку push нужно дождаться внутри своего запроса. Но ждать её в момент
  // отправки сообщения нельзя — именно так раньше и рождалась пауза в 2–3 секунды.
  // Теперь отправка отвечает мгновенно, а браузер сразу следом делает короткий
  // запрос /api/notify, который и раздаёт уведомления (см. public/app.js).
  const PUSH_TIMEOUT = Number(process.env.PUSH_TIMEOUT_MS || 1500);   // на одну доставку
  const PUSH_BUDGET = Number(process.env.PUSH_BUDGET_MS || 8000);     // на весь запрос /api/notify

  function withTimeout(promise, ms) {
    let timer = null;
    return Promise.race([
      Promise.resolve(promise).finally(() => { if (timer) clearTimeout(timer); }),
      new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('push:timeout')), ms); })
    ]);
  }
  function pusher() {
    const webpush = require('web-push');
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
    return webpush;
  }
  const pushEnabled = () => !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);

  /** Одна доставка одному браузеру. Мёртвые подписки (404/410) вычищаем сразу. */
  async function deliver(webpush, target, sub, payload) {
    try {
      await withTimeout(webpush.sendNotification(sub, payload), PUSH_TIMEOUT);
      return true;
    } catch (e) {
      if (e && (e.statusCode === 404 || e.statusCode === 410)) {
        target.pushSubs = (target.pushSubs || []).filter(x => x.endpoint !== sub.endpoint);
        save();
      } else if (process.env.PUSH_DEBUG) console.error('[push]', e.message);
      return false;
    }
  }

  /**
   * Разослать уведомление участникам чата (кроме отправителя).
   * Возвращает число доставок; на всё про всё — не дольше PUSH_BUDGET.
   */
  async function notifyPush(chat, sender, body) {
    if (!pushEnabled() || !chat) return 0;
    const webpush = pusher();
    const payload = JSON.stringify({ title: 'SEGA-CHAT', body: body || 'Новое сообщение', tag: chat.id });
    const jobs = [];
    for (const u of db.users) {
      if (u.id === sender.id || !chat.members.includes(u.id)) continue;
      for (const sub of (u.pushSubs || [])) jobs.push(deliver(webpush, u, sub, payload));
    }
    if (!jobs.length) return 0;
    const done = await withTimeout(Promise.all(jobs), PUSH_BUDGET).catch(() => []);
    save();
    return Array.isArray(done) ? done.filter(Boolean).length : 0;
  }

  /** Пуш конкретному человеку (реакция на его сообщение, комментарий и т.п.). */
  async function notifyPushTo(target, sender, body) {
    if (!pushEnabled() || !target || target.id === sender.id) return 0;
    const subs = target.pushSubs || [];
    if (!subs.length) return 0;
    const webpush = pusher();
    const payload = JSON.stringify({ title: 'SEGA-CHAT', body, tag: 'evt-' + target.id });
    const done = await withTimeout(Promise.all(subs.map(sub => deliver(webpush, target, sub, payload))), PUSH_BUDGET).catch(() => []);
    save();
    return Array.isArray(done) ? done.filter(Boolean).length : 0;
  }

  /**
   * Выполнить просьбу браузера «разошли уведомления». Браузер шлёт её сразу
   * после отправки сообщения отдельным коротким запросом, поэтому человек не
   * ждёт доставки: сообщение у него на экране появляется мгновенно.
   */
  async function runNotify(b, me) {
    if (!pushEnabled()) return { ok: true, sent: 0, push: false };
    const kind = String(b.kind || b.k || 'msg');
    const chat = chatById(b.chat);
    if (!chat || !isMember(chat, me.id)) return E(403, 'Это не ваш чат');
    let sent = 0;
    if (kind === 'msg' || kind === 'thr') {
      const m = b.mid ? await findMessage(b.mid) : null;
      if (m && m.chat !== chat.id) return E(400, 'Сообщение не из этого чата');
      sent += await notifyPush(chat, me);
      if (kind === 'thr' && m) {
        const author = db.users.find(u => u.id === m.uid);
        if (author && author.id !== me.id) sent += await notifyPushTo(author, me, me.name + ' прокомментировал(а) ваше сообщение');
      }
    } else if (kind === 'react') {
      const m = b.mid ? await findMessage(b.mid) : null;
      if (!m || m.chat !== chat.id) return E(404, 'Сообщение не найдено');
      const author = db.users.find(u => u.id === m.uid);
      if (author && author.id !== me.id) sent += await notifyPushTo(author, me, me.name + ' отреагировал(а) на ваше сообщение');
    } else {
      return E(400, 'Непонятный тип уведомления');
    }
    return { ok: true, sent };
  }

  // ------------------------------------------------------------- журнал изменений
  // Реакция, правка и удаление одного сообщения — это НЕ повод перечитывать всю
  // историю. Сервер делает пометку «изменилось сообщение такое-то», а опрос
  // забирает только такие пометки и присылает сами сообщения.
  const CHANGE_OVERLAP = Number(process.env.CHANGE_OVERLAP || 2000);   // запас по времени, мс
  const CHANGE_STALE = Number(process.env.CHANGE_STALE || 20 * 60 * 60 * 1000);
  const CHANGE_MAX = 80;                                              // сколько изменений отдаём за опрос

  function noteChange(m, deleted) {
    if (!m || !m.id) return;
    store.pushChange({ i: m.id, c: m.chat, d: deleted ? 1 : 0 });
  }

  /**
   * Собрать для участника список сообщений, изменившихся после отметки rsince.
   * Возвращает { changed, gone, rnow, resync }.
   */
  async function collectChanges(me, rsince, cchg, rnow) {
    const mine = new Set(myChats(me.id).map(c => c.id));
    const out = { changed: [], gone: [], rnow, resync: false };
    if (!rsince) return out;
    // клиент отсутствовал дольше, чем живёт журнал, — проще перечитать всё заново
    if (rnow - rsince > CHANGE_STALE) { out.resync = true; return out; }
    // счётчик не сдвинулся — ничего не менялось, запрос к базе не нужен вовсе
    if (cchg !== undefined && cchg === (db.chg || 0)) return out;
    let recs = [];
    try { recs = await store.loadChanges(rsince, CHANGE_OVERLAP); } catch (e) { recs = []; }
    for (const rec of recs.slice(0, CHANGE_MAX)) {
      if (!mine.has(rec.c)) continue;
      if (rec.d) { out.gone.push(rec.i); continue; }
      const m = db.messages.find(x => x.id === rec.i) || await store.getMessage(rec.i);
      if (m && m.chat === rec.c) out.changed.push(m);
      else out.gone.push(rec.i);
    }
    return out;
  }

  // ------------------------------------------------------------- маршруты
  async function api(req) {
    const { method, path: pathname, query, ip } = req;

    if (pathname === '/api/state' && method === 'GET') {
      return J(200, {
        app: 'SEGA-CHAT',
        build: BUILD,
        setupRequired: db.users.length === 0,
        codeProofSalt: db.room ? db.room.codeProofSalt : null,
        limit: STORAGE_LIMIT, maxUpload: MAX_UPLOAD
      });
    }

    // --- первичная настройка: создаётся администратор и кодовая фраза
    if (pathname === '/api/setup' && method === 'POST') {
      if (db.users.length) return E(409, 'Чат уже настроен');
      const b = req.body;
      const name = normName(b.name);
      if (name.length < 2 || name.length > 32) return E(400, 'Имя: от 2 до 32 символов');
      for (const k of ['saltAuth', 'authKey', 'saltWrap', 'wrappedKeyByPass', 'codeProofSalt', 'codeProof', 'codeSalt', 'wrappedKeyByCode']) {
        if (!b[k]) return E(400, 'Не хватает поля ' + k);
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
      save();
      return J(200, { token, user: publicUser(user), saltWrap: user.saltWrap, wrappedKeyByPass: user.wrappedKeyByPass, wrappedPriv: user.wrappedPriv });
    }

    // --- соль для вывода ключей по имени
    if (pathname === '/api/salt' && method === 'POST') {
      const b = req.body;
      const name = normName(b.name).toLowerCase();
      const u = db.users.find(x => x.nameLower === name);
      return J(200, { saltAuth: u ? u.saltAuth : stableSalt(name) });
    }

    if (pathname === '/api/login' && method === 'POST') {
      if (throttle('login:' + ip)) return E(429, 'Слишком много попыток. Подождите 10 минут.');
      const b = req.body;
      const name = normName(b.name).toLowerCase();
      const u = db.users.find(x => x.nameLower === name);
      if (!u || !b.authKey || !timingEqual(hashSecret(b.authKey, u.saltAuth), u.authHash)) {
        return E(403, 'Неверное имя или пароль');
      }
      const token = crypto.randomBytes(24).toString('hex');
      db.sessions[token] = { uid: u.id, exp: Date.now() + SESSION_TTL };
      u.lastSeen = Date.now();
      save();
      return J(200, { token, user: publicUser(u), saltWrap: u.saltWrap, wrappedKeyByPass: u.wrappedKeyByPass, wrappedPriv: u.wrappedPriv || null });
    }

    // --- получить «завёрнутый» ключ каталога по кодовой фразе (для регистрации)
    if (pathname === '/api/invite' && method === 'POST') {
      if (throttle('invite:' + ip)) return E(429, 'Слишком много попыток. Подождите 10 минут.');
      const b = req.body;
      if (!db.room) return E(409, 'Чат ещё не настроен');
      if (!b.codeProof || !timingEqual(hashSecret(b.codeProof, db.room.codeProofSalt), db.room.codeProofHash)) {
        return E(403, 'Неверная кодовая фраза чата');
      }
      return J(200, { codeSalt: db.room.codeSalt, wrappedKeyByCode: db.room.wrappedKeyByCode });
    }

    if (pathname === '/api/register' && method === 'POST') {
      if (throttle('register:' + ip)) return E(429, 'Слишком много попыток. Подождите 10 минут.');
      const b = req.body;
      if (!db.room) return E(409, 'Чат ещё не настроен');
      if (!b.codeProof || !timingEqual(hashSecret(b.codeProof, db.room.codeProofSalt), db.room.codeProofHash)) {
        return E(403, 'Неверная кодовая фраза чата');
      }
      const name = normName(b.name);
      if (name.length < 2 || name.length > 32) return E(400, 'Имя: от 2 до 32 символов');
      if (db.users.some(x => x.nameLower === name.toLowerCase())) return E(409, 'Такое имя уже занято');
      for (const k of ['saltAuth', 'authKey', 'saltWrap', 'wrappedKeyByPass']) if (!b[k]) return E(400, 'Не хватает поля ' + k);
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
      save();
      return J(200, { token, user: publicUser(user), saltWrap: user.saltWrap, wrappedKeyByPass: user.wrappedKeyByPass, wrappedPriv: user.wrappedPriv });
    }

    // ------------------------------------------------ дальше только с токеном
    const session = await auth(req);
    if (!session) return E(401, 'Нужен вход');
    const me = session.user;

    if (pathname === '/api/logout' && method === 'POST') {
      delete db.sessions[session.token]; save();
      return J(200, { ok: true });
    }

    // Web Push subscriptions contain no message content. They are kept per user
    // so a browser can be replaced without invalidating other devices.
    if (pathname === '/api/push/config' && method === 'GET') {
      return J(200, { enabled: !!process.env.VAPID_PUBLIC_KEY, publicKey: process.env.VAPID_PUBLIC_KEY || null });
    }
    if (pathname === '/api/push/subscribe' && method === 'POST') {
      const sub = req.body && req.body.subscription;
      if (!sub || typeof sub.endpoint !== 'string' || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return E(400, 'Некорректная подписка');
      if (sub.endpoint.length > 2048) return E(400, 'Слишком длинный адрес подписки');
      me.pushSubs = Array.isArray(me.pushSubs) ? me.pushSubs : [];
      me.pushSubs = me.pushSubs.filter(x => x.endpoint !== sub.endpoint);
      me.pushSubs.push({ endpoint: sub.endpoint, keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) }, createdAt: Date.now() });
      me.pushSubs = me.pushSubs.slice(-5); save();
      return J(200, { ok: true });
    }
    if (pathname === '/api/push/subscribe' && method === 'DELETE') {
      const endpoint = String((req.body || {}).endpoint || '');
      me.pushSubs = (me.pushSubs || []).filter(x => x.endpoint !== endpoint); save();
      return J(200, { ok: true });
    }

    if (pathname === '/api/sync' && method === 'GET') {
      const rnow = Date.now();
      const since = Number(query.get('since') || 0);
      const rsince = Number(query.get('rsince') || 0);
      const cchg = query.get('cchg') === null ? undefined : Number(query.get('cchg'));
      if (query.get('active') === '1') { me.activeAt = rnow; store.touchPresence(me, true); }
      const list = myChats(me.id);
      await store.loadSince(list.map(c => c.id), since);
      const mine = new Set(list.map(c => c.id));
      const msgs = db.messages.filter(m => m.seq > since && mine.has(m.chat)).sort((a, b) => a.seq - b.seq);

      // ответ отдаём порциями: у облачной функции есть предел на размер ответа,
      // а первый вход в чат с большой историей иначе упёрся бы в него
      let out = msgs, more = false, seqOut = db.seq, size = 0;
      for (let i = 0; i < msgs.length; i++) {
        size += (msgs[i].bytes || 0) + 200;
        if (i >= SYNC_MAX_COUNT || size > SYNC_MAX_BYTES) {
          const edge = msgs[Math.max(0, i - 1)].seq;
          out = msgs.filter(m => m.seq <= edge);
          if (!out.length) out = msgs.slice(0, 1);
          more = out.length < msgs.length;
          if (more) seqOut = out[out.length - 1].seq;
          break;
        }
      }

      // мелкие изменения (реакции, правки, удалённые сообщения) — отдельным коротким
      // списком, чтобы ради одного смайлика не перечитывать и не расшифровывать всё
      const delta = more ? { changed: [], gone: [], rnow, resync: false }
        : await collectChanges(me, rsince, cchg, rnow);
      const seen = new Set(out.map(m => m.id));
      const changed = delta.changed.filter(m => !seen.has(m.id));
      if (process.env.CHG_DEBUG) console.error(`[chg] rsince=${rsince} cchg=${cchg} db.chg=${db.chg} changed=${changed.length} gone=${delta.gone.length} resync=${delta.resync}`);
      store.trimChanges().catch(() => {});

      const mch = myChats(me.id);
      return J(200, {
        messages: out,
        changed, gone: delta.gone, rnow, chg: db.chg || 0, resync: delta.resync,
        chats: mch.map(c => publicChat(c, me.id)),
        seq: seqOut, more, gen: db.gen,
        // сколько всего истории у участника — клиент рисует честные проценты загрузки
        loadN: mch.reduce((a, c) => a + (((db.stats.chats || {})[c.id] || {}).n || 0), 0),
        loadB: mch.reduce((a, c) => a + (((db.stats.chats || {})[c.id] || {}).b || 0), 0),
        games: openGames(me.id),
        invites: openInvites(me.id),
        users: db.users.map(publicUser),
        usage: usage(),
        me: publicUser(me),
        serverTime: rnow
      });
    }

    // --- разослать уведомления (браузер просит об этом сразу после отправки)
    if (pathname === '/api/notify' && method === 'POST') {
      return J(200, await runNotify(req.body || {}, me));
    }

    // --- отметка «прочитано» (bucket: <chatId> | thr:<messageId>)
    if (pathname === '/api/read' && method === 'POST') {
      const b = req.body;
      const bucket = String(b.bucket || '');
      const seq = Number(b.seq || 0);
      if (!bucket || !seq) return E(400, 'Нужны bucket и seq');
      if (!bucket.startsWith('thr:') && !isMember(chatById(bucket), me.id)) return E(403, 'Это не ваш чат');
      me.reads = me.reads || {};
      if ((me.reads[bucket] || 0) < seq) { me.reads[bucket] = seq; save(); }
      return J(200, { ok: true });
    }

    // ------------------------------------------------ чаты
    if (pathname === '/api/chats' && method === 'POST') {
      const b = req.body;
      const members = [...new Set([me.id, ...(Array.isArray(b.members) ? b.members : [])])];
      if (members.length > MAX_MEMBERS) return E(400, 'Слишком много участников');
      for (const id of members) if (!db.users.some(u => u.id === id)) return E(404, 'Участник не найден');
      if (!b.titleBlob || typeof b.titleBlob !== 'string' || b.titleBlob.length > 8192) return E(400, 'Нужно название чата');
      const keys = {};
      for (const id of members) {
        const k = (b.keys || {})[id];
        if (!k || !k.blob) return E(400, 'Нет ключа для участника ' + id);
        keys[id] = { by: me.id, blob: String(k.blob).slice(0, 4096) };
      }
      const chat = {
        id: uid(), kind: 'group', titleBlob: b.titleBlob, ownerId: me.id,
        members, keys, createdAt: Date.now()
      };
      db.chats.push(chat);
      db.stats.chats[chat.id] = { n: 0, b: 0, t: chat.createdAt };
      db.seq++;
      save();
      return J(200, { chat: publicChat(chat, me.id) });
    }

    if (pathname === '/api/dm' && method === 'POST') {
      const b = req.body;
      const peer = db.users.find(u => u.id === b.peer);
      if (!peer) return E(404, 'Участник не найден');
      if (peer.id === me.id) return E(400, 'Нельзя писать самому себе');
      const chat = ensureDm(me.id, peer.id);
      return J(200, { chat: publicChat(chat, me.id) });
    }

    if (pathname.startsWith('/api/chats/')) {
      const parts = pathname.split('/'); // '', api, chats, :id, action?
      const chat = chatById(decodeURIComponent(parts[3] || ''));
      const action = parts[4];
      if (!chat) return E(404, 'Чат не найден');
      if (!isMember(chat, me.id)) return E(403, 'Вы не участник этого чата');
      const isOwner = chat.kind === 'group' && chat.ownerId === me.id;

      if (action === 'title' && method === 'POST') {
        if (chat.kind !== 'group') return E(400, 'У личной переписки нет названия');
        const b = req.body;
        if (!b.titleBlob || b.titleBlob.length > 8192) return E(400, 'Нужно название');
        chat.titleBlob = b.titleBlob; chat.titlePlain = null;
        db.seq++; save();
        return J(200, { chat: publicChat(chat, me.id) });
      }

      // --- ремонт ключа чата: участники, у которых нет своей копии ключа.
      // Любой текущий участник и так владеет ключом чата, поэтому выдача копии
      // «запертому» участнику не открывает никому ничего нового — зато автоматически
      // возвращает человеку доступ к переписке (клиенты делают это сами, фоном).
      if (action === 'keys' && chat.kind === 'group') {
        const sub = parts[5] || '';
        if (sub === 'missing' && method === 'GET') {
          const missing = chat.members
            .filter(id => !(chat.keys || {})[id])
            .map(id => ({ id, hasPub: !!(db.users.find(u => u.id === id) || {}).pub }));
          return J(200, { missing });
        }
        if (sub === '' && method === 'POST') {
          const b = req.body || {};
          const target = String(b.userId || '');
          if (!chat.members.includes(target)) return E(400, 'Адресат не участник этого чата');
          if (!b.blob || typeof b.blob !== 'string' || b.blob.length > 4096) return E(400, 'Нет ключа для участника');
          if (!chat.keys) chat.keys = {};
          if (chat.keys[target]) return E(409, 'У участника уже есть ключ этого чата');
          chat.keys[target] = { by: me.id, blob: b.blob };
          db.seq++; save();
          return J(200, { ok: true, chat: publicChat(chat, me.id) });
        }
      }

      if (action === 'members' && method === 'POST') {
        if (chat.kind !== 'group') return E(400, 'Состав личной переписки менять нельзя');
        const b = req.body;
        for (const a of (b.add || [])) {
          const u = db.users.find(x => x.id === a.id);
          if (!u) return E(404, 'Участник не найден');
          if (!a.blob) return E(400, 'Нет ключа для нового участника');
          if (chat.members.length >= MAX_MEMBERS) return E(400, 'Слишком много участников');
          if (!chat.members.includes(u.id)) chat.members.push(u.id);
          chat.keys[u.id] = { by: me.id, blob: String(a.blob).slice(0, 4096) };
        }
        for (const id of (b.remove || [])) {
          if (!isOwner) return E(403, 'Исключать может только создатель чата');
          if (id === chat.ownerId) return E(400, 'Нельзя исключить создателя чата');
          chat.members = chat.members.filter(x => x !== id);
          delete chat.keys[id];
        }
        db.seq++; save();
        return J(200, { chat: publicChat(chat, me.id) });
      }

      if (action === 'leave' && method === 'POST') {
        if (chat.kind !== 'group') return E(400, 'Из личной переписки выйти нельзя');
        chat.members = chat.members.filter(x => x !== me.id);
        if (chat.keys) delete chat.keys[me.id];
        if (chat.members.length > 0) {
          if (chat.ownerId === me.id) {
            chat.ownerId = chat.members[0];
          }
        } else {
          db.chats = db.chats.filter(c => c.id !== chat.id);
          dropChat(chat.id);
        }
        db.seq++; save();
        return J(200, { ok: true, usage: usage() });
      }

      if (action === 'owner' && method === 'POST') {
        if (!isOwner) return E(403, 'Только создатель чата');
        const b = req.body;
        if (!chat.members.includes(b.id)) return E(400, 'Новый владелец должен быть участником чата');
        chat.ownerId = b.id;
        db.seq++; save();
        return J(200, { chat: publicChat(chat, me.id) });
      }

      if (action === 'wall' && method === 'POST') {
        // фон чата — общий объект: видеть и менять может любой участник
        const w = (req.body || {}).wall || {};
        if (!['grad', 'pat', 'photo', 'none'].includes(w.type)) return E(400, 'Непонятный тип фона');
        const hex = v => /^#[0-9a-fA-F]{6}$/.test(v || '');
        chat.wall = {
          type: w.type,
          c1: hex(w.c1) ? w.c1 : '#eef2f4',
          c2: hex(w.c2) ? w.c2 : '#e8f4fe',
          a: Math.max(0, Math.min(360, Number(w.a) || 165)),
          pat: ['dots', 'diag', 'grid', 'waves'].includes(w.pat) ? w.pat : 'dots'
        };
        db.seq++; save();
        return J(200, { chat: publicChat(chat, me.id) });
      }

      if (action === 'wallphoto' && method === 'POST') {
        const b = req.body || {};
        if (b.data && b.data.length > 350 * 1024) return E(413, 'Фото фона слишком большое (до ~350 КБ в шифрованном виде)');
        chat.wallRev = b.data ? crypto.randomBytes(4).toString('hex') : null;
        chat.wallLen = b.data ? b.data.length : 0;
        await store.putWall(chat.id, b.data || '');
        if (b.data) chat.wall = Object.assign({ type: 'grad', c1: '#eef2f4', c2: '#e8f4fe', a: 165, pat: 'dots' }, chat.wall || {}, { type: 'photo' });
        db.seq++; save();
        return J(200, { chat: publicChat(chat, me.id) });
      }

      if (action === 'icon' && method === 'POST') {
        if (chat.kind !== 'group') return E(400, 'Иконка есть только у групповых чатов');
        const b = req.body || {};
        if (b.data && b.data.length > 350 * 1024) return E(413, 'Иконка слишком большая (до ~350 КБ в шифрованном виде)');
        chat.iconRev = b.data ? crypto.randomBytes(4).toString('hex') : null;
        chat.iconLen = b.data ? b.data.length : 0;
        await store.putIcon(chat.id, b.data || '');
        db.seq++; save();
        return J(200, { chat: publicChat(chat, me.id) });
      }

      if (action === 'clear' && method === 'POST') {
        // «Очистить чат»: история удаляется из облака и перестаёт занимать место.
        // Для группового чата — только создатель, для личной переписки — любой из двоих.
        if (chat.kind === 'group' && !isOwner) return E(403, 'Очистить групповой чат может создатель');
        await store.loadChats([chat.id]);
        const msgs = db.messages.filter(m => m.chat === chat.id);
        const count = msgs.length;
        dropChat(chat.id);                 // освобождает место и счётчики
        chat.clearedByName = me.name;
        chat.clearedAt = Date.now();
        chat.clearedCount = count;
        db.seq++;
        save();
        return J(200, { cleared: count, usage: usage(), chat: publicChat(chat, me.id) });
      }

      if (action === 'archive' && method === 'POST') {
        if (chat.kind === 'group' && !isOwner) return E(403, 'Архивировать чат может создатель');
        const b = req.body || {};
        // архивация защищена кодовым словом мессенджера: одно слово на все архивы
        if (!verifyCodeProof(b.codeProof)) return E(403, 'Неверное кодовое слово');
        await store.loadChats([chat.id]);
        const msgs = db.messages.filter(m => m.chat === chat.id);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const file = `archive-${chat.id}-${stamp}.json`;
        const payload = {
          app: 'SEGA-CHAT',
          format: 'encrypted-archive-v2',
          createdAt: Date.now(),
          note: 'Сообщения зашифрованы ключом чата (AES-256-GCM). Открывается только участниками этого чата.',
          chat: { id: chat.id, kind: chat.kind, titleBlob: chat.titleBlob || null, titlePlain: chat.titlePlain || null, members: chat.members },
          users: db.users.map(u => ({ id: u.id, name: u.name })),
          messages: msgs
        };
        try {
          await store.putArchive(file, JSON.stringify(payload));
        } catch (e) {
          return E(500, 'Не удалось сохранить архив: ' + e.message);
        }
        // страховка от «призраков»: сразу читаем записанное обратно
        const back = await store.getArchive(file);
        if (back == null) {
          console.error('[arc] запись не читается после создания:', file);
          await store.delArchive(file);
          return E(500, 'Архив не записался в базу (запись не читается). Повторите попытку и пришлите журнал, если повторится');
        }
        const rec = { file, createdAt: Date.now(), count: msgs.length, bytes: JSON.stringify(payload).length, chat: chat.id };
        db.archives.push(rec);
        dropChat(chat.id);
        db.stats.chats[chat.id] = { n: 0, b: 0, t: chat.createdAt || Date.now() };
        db.seq++;

        chat.archivedByName = me.name;
        chat.archivedAt = rec.createdAt;
        chat.archivedCount = rec.count;
        chat.lastArchive = {
          file,
          createdAt: rec.createdAt,
          count: rec.count,
          bytes: rec.bytes,
          byName: me.name,
          byId: me.id
        };
        save();
        return J(200, { archive: rec, usage: usage(), cleared: true, chat: publicChat(chat, me.id) });
      }

      if (action === 'archives' && method === 'GET') {
        await store.loadArchives();
        const list = db.archives.filter(a => a.chat === chat.id).reverse();
        // правда о списке = наличие тела в базе: призраков убираем сразу,
        // заодно удалённые архивы не задерживаются в списке из-за задержки индекса
        const alive = [];
        for (const a of list) {
          if ((await store.countArchiveParts(a.file)) > 0) { a.hasContent = true; alive.push(a); }
          else db.archives = db.archives.filter(x => x.file !== a.file);
        }
        if (alive.length !== list.length) { db.seq++; save(); }
        return J(200, { archives: alive });
      }

      // --- восстановление заархивированной истории обратно в чат
      if (action === 'restore' && method === 'POST') {
        await store.loadArchives();
        const b = req.body || {};
        if (!verifyCodeProof(b.codeProof)) return E(403, 'Неверное кодовое слово');
        const file = safeFile(String(b.file || ''));
        const rec = db.archives.find(a => a.file === file && a.chat === chat.id)
          || db.archives.find(a => normFile(a.file) === normFile(file) && a.chat === chat.id);
        if (!rec) {
          console.error(arcDiag(file), '| чат:', chat.id);
          return E(404, 'Архив не найден в списке этого чата (архивов в базе: ' + db.archives.length + ')');
        }
        const text = await store.getArchive(file);
        if (!text) return E(404, 'Архив не найден');
        let payload;
        try { payload = JSON.parse(text); } catch (e) { return E(500, 'Архив повреждён'); }
        const list = Array.isArray(payload.messages) ? payload.messages : [];
        if (!list.length) return E(400, 'В архиве нет сообщений');
        await store.loadChats([chat.id]);
        const have = new Set(db.messages.map(m => m.id));
        let n = 0;
        for (const m of list) {
          if (!m || have.has(m.id) || m.chat !== chat.id) continue;
          const msg = {
            id: m.id, seq: await store.reserveSeq(), uid: m.uid, ts: m.ts || Date.now(),
            blob: m.blob, bytes: m.bytes || (m.blob || '').length,
            chat: chat.id, parent: m.parent || null, quote: m.quote || null
          };
          db.messages.push(msg);
          addStat(msg, 1);
          have.add(msg.id);
          n++;
        }
        save();
        return J(200, { restored: n, usage: usage() });
      }
    }

    // ------------------------------------------------ сообщения
    if (pathname === '/api/messages' && method === 'POST') {
      const b = req.body;
      if (!b.blob || typeof b.blob !== 'string') return E(400, 'Пустое сообщение');
      if (b.blob.length > MAX_UPLOAD) return E(413, 'Вложение слишком большое после шифрования, попробуйте фото поменьше');
      const u = usage();
      if (u.bytes + b.blob.length > STORAGE_LIMIT) {
        return E(507, 'Память чата заполнена. Заархивируйте историю, чтобы продолжить.');
      }
      const chat = chatById(b.chat);
      if (!chat) return E(404, 'Чат не найден');
      if (!isMember(chat, me.id)) return E(403, 'Вы не участник этого чата');

      let parent = null, parentMsg = null;
      if (b.parent) {
        const p = await findMessage(b.parent);
        if (!p) return E(404, 'Исходное сообщение не найдено');
        if (p.chat !== chat.id) return E(400, 'Комментарий не из того чата');
        if (p.parent) return E(400, 'Комментировать можно только исходное сообщение');
        parent = p.id; parentMsg = p;
      }
      let quote = null;
      if (b.quote) {
        const q = await findMessage(b.quote);
        if (!q) return E(404, 'Сообщение-ссылка не найдено');
        if (q.chat !== chat.id) return E(400, 'Ссылаться можно только на сообщение этого чата');
        quote = q.id;
      }
      const m = { id: uid(), seq: await store.reserveSeq(), uid: me.id, ts: Date.now(), blob: b.blob, bytes: b.blob.length, chat: chat.id, parent, quote, upId: b.upId || null };
      db.messages.push(m);
      addStat(m, 1);
      me.reads = me.reads || {};
      me.reads[parent ? 'thr:' + parent : chat.id] = m.seq;
      save();
      // Уведомления больше НЕ тормозят отправку: отвечаем сразу, а браузер
      // следом шлёт короткий /api/notify (см. runNotify). Старым клиентам,
      // которые такого запроса не делают, рассылаем сами — но коротко.
      const selfNotify = !!(b.notify === 1 || b.notify === true);
      let sent = 0;
      if (!selfNotify && pushEnabled()) {
        sent += await notifyPush(chat, me).catch(() => 0);
        if (parentMsg) {
          const pAuthor = db.users.find(u => u.id === parentMsg.uid);
          if (pAuthor && pAuthor.id !== me.id) sent += await notifyPushTo(pAuthor, me, me.name + ' прокомментировал(а) ваше сообщение').catch(() => 0);
        }
      }
      return J(200, { message: m, usage: usage(), notify: selfNotify ? { kind: parent ? 'thr' : 'msg', chat: chat.id, mid: m.id } : null, sent });
    }

    if (pathname.startsWith('/api/messages/') && pathname.endsWith('/react') && method === 'POST') {
      const id = pathname.split('/')[3];
      const m = await findMessage(id);
      if (!m) return E(404, 'Сообщение не найдено');
      const chat = chatById(m.chat);
      if (!isMember(chat, me.id)) return E(403, 'Это не ваш чат');
      const emo = String((req.body || {}).emoji || '').trim().slice(0, 16);
      if (!emo) return E(400, 'Нет реакции');
      m.reactions = m.reactions || {};
      const had = (m.reactions[emo] || []).includes(me.id);
      const arr = (m.reactions[emo] || []).filter(x => x !== me.id);
      if (!had) arr.push(me.id);
      if (arr.length) m.reactions[emo] = arr; else delete m.reactions[emo];
      m.rev = (m.rev || 0) + 1;
      m.reactTs = Date.now();
      m.reactBy = me.id;
      // Никакого gen++ и перечитывания всей истории: помечаем только это сообщение,
      // и остальные браузеры подхватят реакцию ближайшим опросом (секунды, не десятки).
      noteChange(m);
      save();
      const author = db.users.find(u => u.id === m.uid);
      const selfNotify = !!(req.body && (req.body.notify === 1 || req.body.notify === true));
      let sent = 0;
      // уведомляем автора, когда реакцию СТАВЯТ (раньше условие было перевёрнуто)
      if (author && author.id !== me.id && !had && !selfNotify && pushEnabled()) {
        sent += await notifyPushTo(author, me, me.name + ' отреагировал(а) на ваше сообщение').catch(() => 0);
      }
      return J(200, {
        reactions: m.reactions, rev: m.rev, reactTs: m.reactTs, usage: usage(), sent,
        notify: selfNotify && author && author.id !== me.id && !had
          ? { kind: 'react', chat: m.chat, mid: m.id } : null
      });
    }

    if (pathname.startsWith('/api/messages/') && pathname.endsWith('/edit') && method === 'POST') {
      const id = pathname.split('/')[3];
      const m = await findMessage(id);
      if (!m) return E(404, 'Сообщение не найдено');
      if (m.uid !== me.id) return E(403, 'Редактировать можно только своё сообщение');
      const b = req.body || {};
      if (!b.blob || typeof b.blob !== 'string') return E(400, 'Пустое сообщение');
      if (b.blob.length > MAX_UPLOAD) return E(413, 'Слишком большой объём после шифрования');
      await store.loadChats([m.chat]);
      const old = m.bytes || 0;
      m.blob = b.blob; m.bytes = b.blob.length; m.editedAt = Date.now(); m.rev = (m.rev || 0) + 1;
      noteChange(m);   // правку увидят все — но без перечитывания всей истории
      db.stats.bytes = Math.max(0, db.stats.bytes - old + m.bytes);
      const cs = db.stats.chats[m.chat];
      if (cs) cs.b = Math.max(0, cs.b - old + m.bytes);
      save();
      return J(200, { message: m, usage: usage() });
    }

    if (pathname.startsWith('/api/messages/') && method === 'DELETE') {
      const id = pathname.split('/')[3];
      const victim = await findMessage(id);
      if (!victim) return E(404, 'Сообщение не найдено');
      const chat = chatById(victim.chat);
      if (!isMember(chat, me.id)) return E(403, 'Это не ваш чат');
      const canDelete = victim.uid === me.id;   // удалять можно только свои сообщения
      if (!canDelete) return E(403, 'Удалять можно только свои сообщения');
      await store.loadChats([victim.chat]);
      const ups = new Set(db.messages.filter(m => (m.id === id || m.parent === id) && m.upId).map(m => m.upId));
      dropMessages(m => m.id === id || m.parent === id);
      for (const up of ups) {
        const meta = await store.getUpMeta(up);
        if (meta && !db.messages.some(m => m.upId === up)) {
          await store.delUp(up);
          db.upBytes = Math.max(0, (db.upBytes || 0) - (meta.stored || meta.size || 0));
        }
      }
      for (const m of db.messages) if (m.quote === id) { m.quote = null; m.rev = (m.rev || 0) + 1; noteChange(m); }
      db.seq++;
      save();
      return J(200, { ok: true, usage: usage() });
    }

    // --- чаты-игры: шахматы как чат (правила живут в клиентах, сервер слеп)
    if (pathname === '/api/games' && method === 'POST') {
      const b = req.body || {};
      const opp = db.users.find(u => u.id === String(b.opponent || ''));
      if (!opp) return E(404, 'Соперник не найден');
      if (opp.id === me.id) return E(400, 'Пригласите кого-то ещё, не себя');
      const color = String(b.color || 'random');
      if (!['white', 'black', 'random', 'choice'].includes(color)) return E(400, 'Цвет: white, black, random или choice');
      const keys = {};
      for (const id of [me.id, opp.id]) {
        const k = (b.keys || {})[id];
        if (!k || !k.blob) return E(400, 'Нет ключа чата для ' + (id === me.id ? 'вас' : 'соперника'));
        keys[id] = { by: me.id, blob: String(k.blob).slice(0, 4096) };
      }
      let white = null, black = null;
      if (color === 'white') { white = me.id; black = opp.id; }
      if (color === 'black') { black = me.id; white = opp.id; }
      if (color === 'random') {
        if (crypto.randomBytes(1)[0] % 2) { white = me.id; black = opp.id; }
        else { black = me.id; white = opp.id; }
      }
      const chat = {
        id: uid(), kind: 'game', ownerId: me.id, createdAt: Date.now(),
        members: [me.id], roles: { [me.id]: 'player' }, keys, knocks: [],
        game: { rules: 'chess', status: 'invite', invitee: opp.id, colorChoice: color, white, black, result: null }
      };
      db.chats.push(chat);
      db.stats.chats[chat.id] = { n: 0, b: 0, t: chat.createdAt };
      db.seq++; save();
      return J(200, { chat: publicChat(chat, me.id) });
    }

    if (pathname.startsWith('/api/games/') && pathname.endsWith('/accept') && method === 'POST') {
      const chat = chatById(pathname.split('/')[3]);
      if (!chat || chat.kind !== 'game') return E(404, 'Игра не найдена');
      if (chat.game.status !== 'invite' || chat.game.invitee !== me.id) {
        return E(403, 'Приглашение адресовано не вам или уже обработано');
      }
      const b = req.body || {};
      if (chat.game.colorChoice === 'choice') {
        const pick = String(b.color || 'white');
        if (!['white', 'black'].includes(pick)) return E(400, 'Цвет: white или black');
        chat.game[pick] = me.id;
        chat.game[pick === 'white' ? 'black' : 'white'] = chat.ownerId;
      }
      if (!chat.game.white || !chat.game.black) return E(500, 'Не удалось распределить цвета');
      chat.members.push(me.id);
      chat.roles[me.id] = 'player';
      chat.game.status = 'playing';
      chat.game.invitee = null;
      db.seq++; save();
      return J(200, { ok: true, chat: publicChat(chat, me.id) });
    }

    if (pathname.startsWith('/api/games/') && pathname.endsWith('/decline') && method === 'POST') {
      const chat = chatById(pathname.split('/')[3]);
      if (!chat || chat.kind !== 'game') return E(404, 'Игра не найдена');
      if (chat.game.status !== 'invite' || chat.game.invitee !== me.id) return E(403, 'Приглашение адресовано не вам');
      dropChat(chat.id);
      db.chats = db.chats.filter(c => c.id !== chat.id);
      db.seq++; save();
      return J(200, { ok: true, wiped: true });
    }

    if (pathname.startsWith('/api/games/') && pathname.endsWith('/leave') && method === 'POST') {
      const chat = chatById(pathname.split('/')[3]);
      if (!chat || chat.kind !== 'game') return E(404, 'Игра не найдена');
      if (!chat.members.includes(me.id)) return E(403, 'Вы не участник этой игры');
      const isPlayer = (chat.roles || {})[me.id] === 'player';
      let resigned = false;
      if (isPlayer && chat.game.status === 'playing') {
        chat.game.status = 'finished';
        chat.game.result = {
          winner: me.id === chat.game.white ? chat.game.black : chat.game.white,
          how: 'resign', at: Date.now()
        };
        resigned = true;
      }
      chat.members = chat.members.filter(x => x !== me.id);
      delete chat.roles[me.id];
      delete chat.keys[me.id];
      let wiped = false;
      const playersIn = [chat.game.white, chat.game.black].filter(x => x && chat.members.includes(x));
      if (!playersIn.length) {
        dropChat(chat.id);
        db.chats = db.chats.filter(c => c.id !== chat.id);
        wiped = true;
      }
      db.seq++; save();
      return J(200, { ok: true, resigned, wiped });
    }

    if (pathname.startsWith('/api/games/') && pathname.endsWith('/knock') && method === 'POST') {
      const chat = chatById(pathname.split('/')[3]);
      if (!chat || chat.kind !== 'game') return E(404, 'Игра не найдена');
      if (chat.members.includes(me.id)) return E(400, 'Вы уже в этой игре');
      if (chat.game.status !== 'playing') return E(400, 'Игра ещё не началась или уже закончена');
      chat.knocks = chat.knocks || [];
      if (!chat.knocks.includes(me.id)) chat.knocks.push(me.id);
      db.seq++; save();
      return J(200, { ok: true, knocks: chat.knocks.length });
    }

    if (pathname.startsWith('/api/games/') && pathname.endsWith('/knock/approve') && method === 'POST') {
      const b = req.body || {};
      const chat = chatById(pathname.split('/')[3]);
      if (!chat || chat.kind !== 'game') return E(404, 'Игра не найдена');
      if ((chat.roles || {})[me.id] !== 'player') return E(403, 'Пускать зрителей может только игрок');
      const uidKnock = String(b.uid || '');
      if (!(chat.knocks || []).includes(uidKnock)) return E(404, 'Запрос не найден');
      const k = (b.blob && { by: me.id, blob: String(b.blob).slice(0, 4096) }) || null;
      if (!k) return E(400, 'Нет ключа чата для зрителя');
      if (!chat.members.includes(uidKnock)) chat.members.push(uidKnock);
      chat.roles[uidKnock] = 'viewer';
      chat.keys[uidKnock] = k;
      chat.knocks = chat.knocks.filter(x => x !== uidKnock);
      db.seq++; save();
      return J(200, { ok: true });
    }

    if (pathname.startsWith('/api/games/') && pathname.endsWith('/knock/reject') && method === 'POST') {
      const b = req.body || {};
      const chat = chatById(pathname.split('/')[3]);
      if (!chat || chat.kind !== 'game') return E(404, 'Игра не найдена');
      if ((chat.roles || {})[me.id] !== 'player') return E(403, 'Решать по заявкам может только игрок');
      chat.knocks = (chat.knocks || []).filter(x => x !== String(b.uid || ''));
      db.seq++; save();
      return J(200, { ok: true });
    }

    // --- профиль: имя, аватар, пароль
    if (pathname === '/api/profile' && method === 'POST') {
      const b = req.body;
      if (b.name !== undefined) {
        const name = normName(b.name);
        if (name.length < 2 || name.length > 32) return E(400, 'Имя: от 2 до 32 символов');
        if (db.users.some(x => x.nameLower === name.toLowerCase() && x.id !== me.id)) return E(409, 'Такое имя уже занято');
        // при смене имени соли остаются прежними — ключи не ломаются
        me.name = name; me.nameLower = name.toLowerCase();
      }
      if (b.avatar !== undefined) {
        if (b.avatar && b.avatar.length > 400 * 1024) return E(413, 'Аватар слишком большой');
        me.avatar = b.avatar || null;
        me.avatarLen = b.avatar ? b.avatar.length : 0;
        me.avatarRev = b.avatar ? crypto.randomBytes(4).toString('hex') : null;
        store.touchAvatar(me);
      }
      if (b.status !== undefined) {
        me.status = String(b.status || '').replace(/\s+/g, ' ').trim().slice(0, 48) || null;
      }
      if (b.keys && b.keys.pub && b.keys.wrappedPriv && !me.pub) {
        me.pub = b.keys.pub; me.wrappedPriv = b.keys.wrappedPriv;
      }
      if (b.password) {
        const p = b.password; // { saltAuth, authKey, saltWrap, wrappedKeyByPass, oldAuthKey, wrappedPriv }
        if (!p.oldAuthKey || !timingEqual(hashSecret(p.oldAuthKey, me.saltAuth), me.authHash)) {
          return E(403, 'Текущий пароль неверен');
        }
        for (const k of ['saltAuth', 'authKey', 'saltWrap', 'wrappedKeyByPass']) if (!p[k]) return E(400, 'Не хватает поля ' + k);
        me.saltAuth = p.saltAuth;
        me.authHash = hashSecret(p.authKey, p.saltAuth);
        me.saltWrap = p.saltWrap;
        me.wrappedKeyByPass = p.wrappedKeyByPass;
        if (p.wrappedPriv) me.wrappedPriv = p.wrappedPriv;
        // прочие сессии этого пользователя закрываем
        await store.loadSessions();
        for (const [t, s] of Object.entries(db.sessions)) if (s.uid === me.id && t !== session.token) delete db.sessions[t];
      }
      save();
      return J(200, { user: publicUser(me), wrappedPriv: me.wrappedPriv || null });
    }

    // ------------------------------------------------ администратор мессенджера
    if (pathname.startsWith('/api/admin/')) {
      if (!me.isAdmin) return E(403, 'Только для администратора');

      if (pathname === '/api/admin/code' && method === 'POST') {
        const b = req.body;
        for (const k of ['codeProofSalt', 'codeProof', 'codeSalt', 'wrappedKeyByCode']) if (!b[k]) return E(400, 'Не хватает поля ' + k);
        db.room = {
          codeProofSalt: b.codeProofSalt,
          codeProofHash: hashSecret(b.codeProof, b.codeProofSalt),
          codeSalt: b.codeSalt,
          wrappedKeyByCode: b.wrappedKeyByCode,
          rotatedAt: Date.now()
        };
        save();
        return J(200, { ok: true });
      }

      if (pathname.startsWith('/api/admin/users/')) {
        const parts = pathname.split('/'); // '', api, admin, users, :id, action?
        const id = parts[4], action = parts[5];
        const u = db.users.find(x => x.id === id);
        if (!u) return E(404, 'Участник не найден');
        if (method === 'DELETE') {
          if (u.id === me.id) return E(400, 'Нельзя удалить самого себя');
          db.users = db.users.filter(x => x.id !== id);
          store.dropUser(id);
          await store.loadSessions();
          for (const [t, s] of Object.entries(db.sessions)) if (s.uid === id) delete db.sessions[t];
          // выводим из всех чатов; чаты, где он был единственным, удаляем вместе с историей
          for (const c of db.chats) {
            c.members = c.members.filter(x => x !== id);
            if (c.keys) delete c.keys[id];
            if (c.ownerId === id) c.ownerId = c.members[0] || null;
          }
          pruneGhostChats();   // личные чаты с ним и брошенные игры стираются следом
          db.seq++;
          save();
          return J(200, { ok: true });
        }
        if (method === 'POST' && action === 'admin') {
          const b = req.body;
          if (u.id === me.id && b.value === false) return E(400, 'Нельзя снять права с самого себя');
          u.isAdmin = !!b.value;
          save();
          return J(200, { user: publicUser(u) });
        }
      }

      if (pathname === '/api/admin/archives' && method === 'GET') {
        await store.loadArchives();
        return J(200, { archives: db.archives.slice().reverse() });
      }

      // ------------------------------------------------ резервные копии в облаке
      // Копия всей базы уходит в приватный бакет Object Storage — туда же, где
      // лежит сама программа. Так всё хозяйство мессенджера собирается в одном
      // облаке: один «контейнер» под код, один под переписку, один под копии.
      if (pathname === '/api/admin/backups' && method === 'GET') {
        const bc = backup.config();
        if (!bc.bucket) return J(200, { enabled: false, reason: 'У функции не задана переменная CODE_BUCKET' });
        try {
          const items = await backup.listBackups();
          return J(200, {
            enabled: true, bucket: bc.bucket, prefix: bc.prefix, keep: bc.keep,
            items, last: items[0] || null
          });
        } catch (e) {
          const denied = !!(e && (e.status === 403 || e.code === 'AccessDenied'));
          return J(200, {
            enabled: false,
            code: denied ? 'denied' : 'unavailable',
            reason: denied
              ? 'Служебной учётной записи функции не хватает роли storage.editor на каталог с ящиком «'
                + bc.bucket + '». Лечение — одна команда в Cloud Shell: '
                + 'yc resource-manager folder add-access-binding <ID-каталога-ящика> '
                + '--role storage.editor --service-account-id <ID-учётки-функции>'
              : 'Хранилище недоступно: ' + e.message
          });
        }
      }

      if (pathname === '/api/admin/backup' && method === 'POST') {
        if (!backup.enabled()) return E(501, 'Облачное хранилище не настроено (нет переменной CODE_BUCKET)');
        let res;
        try {
          res = await backup.createBackup({ store, db, build: BUILD });
        } catch (e) {
          const denied = !!(e && (e.status === 403 || e.code === 'AccessDenied'));
          return E(502, denied
            ? 'Не удалось сохранить копию: у функции нет прав на ящик (нужна роль storage.editor на каталог с ящиком)'
            : 'Не удалось сохранить копию: ' + e.message);
        }
        db.backups = db.backups || [];
        db.backups.unshift({ key: res.key, bytes: res.bytes, rows: res.rows, at: res.at, by: me.id });
        db.backups = db.backups.slice(0, 20);
        db.seq++; save();
        if (!res.verify) return J(200, { ok: true, warn: 'Копия записана, но обратная проверка не прошла — сделайте ещё раз', backup: res });
        return J(200, { ok: true, backup: res });
      }

      if (pathname.startsWith('/api/admin/backups/')) {
        const name = decodeURIComponent(pathname.split('/').slice(4).join('/'));
        let key;
        try { key = backup.safeKey(name, backup.config().prefix); }
        catch (e) { return E(400, e.message); }

        if (method === 'DELETE') {
          try { await backup.deleteBackup(key); }
          catch (e) { return E(502, 'Не удалось удалить копию: ' + e.message); }
          db.backups = (db.backups || []).filter(b => b.key !== key);
          save();
          return J(200, { ok: true });
        }

        if (method === 'GET') {
          const off = Math.max(0, Number(query.get('off') || 0));
          const len = Math.max(0, Number(query.get('len') || 0));
          if (len > 0) {
            // большой файл отдаём по кусочкам: у облачной функции потолок ответа,
            // а диапазон читается прямо из хранилища, без загрузки копии целиком
            if (len > BACKUP_DL_MAX) return E(413, 'Кусок больше предела выдачи — уменьшите len');
            let part;
            try { part = await backup.s3().getRange(key, off, len); }
            catch (e) { return E(502, 'Не удалось прочитать кусок копии: ' + e.message); }
            if (!part) return E(404, 'Такой копии нет');
            return BIN(part, key.split('/').pop() + '.part', 'application/octet-stream');
          }
          let buf;
          try { buf = await backup.readBackup(key); }
          catch (e) { return E(502, 'Не удалось прочитать копию: ' + e.message); }
          if (!buf) return E(404, 'Такой копии нет');
          if (buf.length > BACKUP_DL_MAX) {
            return E(413, 'Копия ' + Math.round(buf.length / MB * 10) / 10 + ' МБ — больше разовой выдачи через функцию. '
              + 'Кнопка «скачать» в чате загрузит её по кусочкам; с другого компьютера — консоль: '
              + 'Object Storage → ' + backup.config().bucket + ' → ' + key + ' → «Скачать».');
          }
          return BIN(buf, key.split('/').pop(), 'application/octet-stream');
        }
      }
    }

    // --- восстановление из резервной копии (из ящика или файлом с компьютера)
    if (pathname === '/api/admin/restore' && method === 'POST') {
      const b = req.body || {};
      if (!verifyCodeProof(b.codeProof)) return E(403, 'Восстановление из копии защищено кодовым словом');
      const key = String(b.key || '');
      if (!/^[A-Za-z0-9/.\-_]+$/.test(key) || !(key.startsWith('backups/') || key.startsWith('prerestore/'))) {
        return E(400, 'Неверное имя копии');
      }
      let buf;
      try { buf = await backup.readBackup(key); }
      catch (e) { return E(502, 'Не удалось прочитать копию: ' + e.message); }
      if (!buf) return E(404, 'Такой копии нет');
      return doRestore(buf);
    }

    if (pathname === '/api/admin/restore/upload' && method === 'POST') {
      const b = req.body || {};
      if (b.step === 'init') {
        const size = Number(b.size) || 0;
        if (size <= 0) return E(400, 'Пустой файл');
        if (size > 64 * MB) return E(413, 'Файл больше 64 МБ восстановить нельзя');
        const id = 'rst-' + uid();
        await store.putUpMeta(id, { restore: 1, size, parts: Math.max(1, Number(b.parts) || 1), ts: Date.now() });
        return J(200, { id, chunk: UP_CHUNK });
      }
      if (b.step === 'chunk') {
        const meta = await store.getUpMeta(String(b.id || ''));
        if (!meta || !meta.restore) return E(404, 'Загрузка не найдена — начните заново');
        await store.putUpPart('', String(b.id), Number(b.i) || 0, String(b.data || ''));
        return J(200, { ok: true });
      }
      if (b.step === 'fin') {
        if (!verifyCodeProof(b.codeProof)) return E(403, 'Восстановление из копии защищено кодовым словом');
        const meta = await store.getUpMeta(String(b.id || ''));
        if (!meta || !meta.restore) return E(404, 'Загрузка не найдена — начните заново');
        const parts = [];
        for (let i = 0; i < meta.parts; i++) {
          const pc = await store.getUpPart('', String(b.id), i);
          if (pc == null) return E(400, 'Не все куски файла доехали — начните загрузку заново');
          parts.push(pc);
        }
        await store.delUp(String(b.id));
        const buf = Buffer.from(parts.join(''), 'base64');
        if (Math.abs(buf.length - Number(meta.size)) > 8) return E(400, 'Файл собрался неточно — начните загрузку заново');
        return doRestore(buf);
      }
      return E(400, 'Неизвестный шаг загрузки');
    }

    // --- кусковая загрузка больших вложений (видео, аудио, файлы до 25 МБ)
    if (pathname === '/api/upload/init' && method === 'POST') {
      const b = req.body || {};
      const chat = chatById(b.chat);
      if (!chat || !isMember(chat, me.id)) return E(403, 'Это не ваш чат');
      const size = Number(b.size) || 0;
      if (size > UP_MAX) return E(413, 'Файл больше 25 МБ — предела облачного хранилища');
      if (size <= 0) return E(400, 'Пустой файл');
      const upId = uid();
      await store.putUpMeta(upId, {
        chat: chat.id, name: String(b.name || 'file').slice(0, 120), size,
        mime: String(b.mime || 'application/octet-stream').slice(0, 80),
        parts: Math.max(1, Number(b.parts) || 1), owner: me.id, ts: Date.now()
      });
      return J(200, { upId, chunk: UP_CHUNK });
    }
    if (pathname === '/api/upload/chunk' && method === 'POST') {
      const b = req.body || {};
      const meta = await store.getUpMeta(b.upId);
      if (!meta) return E(404, 'Загрузка не найдена — начните заново');
      if (!isMember(chatById(meta.chat), me.id)) return E(403, 'Это не ваш чат');
      if (meta.owner !== me.id) return E(403, 'Догружать может только начавший загрузку');
      const i = Number(b.i) || 0;
      if (i < 0 || i >= 5000) return E(400, 'Неверный номер куска');
      if (!b.data || b.data.length > UP_CHUNK + 8192) return E(413, 'Кусок больше допустимого');
      await store.putUpPart(meta.chat, b.upId, i, b.data);
      return J(200, { ok: true });
    }
    if (pathname === '/api/upload/fin' && method === 'POST') {
      const b = req.body || {};
      const meta = await store.getUpMeta(b.upId);
      if (!meta) return E(404, 'Загрузка не найдена — начните заново');
      if (!isMember(chatById(meta.chat), me.id)) return E(403, 'Это не ваш чат');
      const u = usage();
      if (u.bytes + Math.ceil(meta.size * UP_B64) > STORAGE_LIMIT) return E(507, 'Память чата заполнена — освободите место');
      const stored = Number(b.stored) || meta.size;
      meta.stored = stored;
      await store.putUpMeta(b.upId, meta);
      db.upBytes = (db.upBytes || 0) + stored;
      db.seq++; save();
      return J(200, { ok: true, meta });
    }
    if (pathname.startsWith('/api/upload/') && method === 'GET') {
      const seg = pathname.split('/').filter(Boolean);
      const upId = safeFile(decodeURIComponent(seg[2] || ''));
      const i = Number(seg[3] || 0);
      const meta = await store.getUpMeta(upId);
      if (!meta) return E(404, 'Загрузка не найдена');
      if (!isMember(chatById(meta.chat), me.id)) return E(403, 'Это не ваш чат');
      const d = await store.getUpPart(meta.chat, upId, i);
      if (d == null) return E(404, 'Кусок не найден');
      return J(200, { data: d, parts: meta.parts, name: meta.name, mime: meta.mime, size: meta.size });
    }

    // --- выгрузка своих чатов (данные всё равно зашифрованы)
    if (pathname === '/api/export' && method === 'GET') {
      const list = myChats(me.id);
      await store.loadChats(list.map(c => c.id));
      const mine = new Set(list.map(c => c.id));
      const payload = {
        app: 'SEGA-CHAT',
        format: 'encrypted-archive-v2',
        createdAt: Date.now(),
        chats: myChats(me.id).map(c => publicChat(c, me.id)),
        users: db.users.map(u => ({ id: u.id, name: u.name })),
        messages: db.messages.filter(m => mine.has(m.chat))
      };
      return FILE(JSON.stringify(payload), `sega-chat-export-${new Date().toISOString().slice(0, 10)}.json`);
    }

    if (pathname.startsWith('/api/archives/') && method === 'GET') {
      await store.loadArchives();
      const file = safeFile(decodeURIComponent(pathname.split('/')[3] || ''));
      const rec = findArchive(file);
      if (!rec) {
        console.error(arcDiag(file));
        return E(404, 'Архив не найден в списке (архивов в базе: ' + db.archives.length
          + '). Пример: ' + (db.archives[0] ? db.archives[0].file : '-'));
      }
      // тело архива отдаём только участнику чата, знающему кодовое слово мессенджера
      let allowed = isMember(chatById(rec.chat), me.id);
      if (!allowed) {
        const t0 = await store.getArchive(file);
        try { allowed = (JSON.parse(t0).chat.members || []).includes(me.id); } catch (e) {}
      }
      if (!allowed) return E(403, 'Это архив чужого чата');
      if (!verifyCodeProof(req.headers['x-code-proof'] || query.codeProof)) return E(403, 'Нужно кодовое слово мессенджера');
      const text = await store.getArchive(file);
      if (text == null) {
        const parts = await store.countArchiveParts(file);
        console.error('[arc] не собрался:', file, '| кусков в базе:', parts);
        if (parts === 0) {
          // запись-призак: тело архива отсутствует (удалено старым кодом) — убираем её из индекса
          db.archives = db.archives.filter(a => a.file !== file);
          db.seq++; save();
          return E(404, 'Запись архива была пустой (тело удалено старым кодом) — она убрана из списка');
        }
        return E(404, 'Архив не собрался из кусков (кусков: ' + parts + '). Пришлите этот текст разработчику');
      }
      return FILE(text, file);
    }

    // --- удалить архив с сервера (освобождает место в базе)
    if (pathname.startsWith('/api/archives/') && method === 'DELETE') {
      await store.loadArchives();
      const file = safeFile(decodeURIComponent(pathname.split('/')[3] || ''));
      const rec = findArchive(file);
      if (!rec) {
        console.error(arcDiag(file));
        return E(404, 'Архив не найден в списке (архивов в базе: ' + db.archives.length
          + '). Пример: ' + (db.archives[0] ? db.archives[0].file : '-'));
      }
      let allowed = isMember(chatById(rec.chat), me.id) || me.isAdmin;
      if (!allowed) {
        const t0 = await store.getArchive(file);
        try { allowed = (JSON.parse(t0).chat.members || []).includes(me.id); } catch (e) {}
      }
      if (!allowed) return E(403, 'Это архив чужого чата');
      await store.delArchive(file);
      db.archives = db.archives.filter(a => a.file !== file);
      db.seq++;
      save();
      return J(200, { ok: true, usage: usage() });
    }

    // --- проверка кодового слова мессенджера (для архивов) без раскрытия результата заранее
    if (pathname === '/api/code/check' && method === 'POST') {
      if (!verifyCodeProof((req.body || {}).codeProof)) return E(403, 'Неверное кодовое слово');
      return J(200, { ok: true });
    }

    // --- аватар участника (зашифрован; скачивается один раз и кэшируется браузером)
    if (pathname.startsWith('/api/wall/') && method === 'GET') {
      const id = decodeURIComponent(pathname.split('/')[3] || '');
      const c = chatById(id);
      if (!c || !isMember(c, me.id)) return E(403, 'Это не ваш чат');
      const w = await store.getWall(id);
      return J(200, { wall: w || null, rev: c.wallRev || null }, { 'Cache-Control': 'no-store' });
    }
    if (pathname.startsWith('/api/chaticon/') && method === 'GET') {
      const id = decodeURIComponent(pathname.split('/')[3] || '');
      const c = chatById(id);
      if (!c || !isMember(c, me.id)) return E(403, 'Это не ваш чат');
      const ic = await store.getIcon(id);
      return J(200, { icon: ic || null, rev: c.iconRev || null }, { 'Cache-Control': 'no-store' });
    }
    if (pathname.startsWith('/api/avatar/') && method === 'GET') {
      const who = db.users.find(x => x.id === decodeURIComponent(pathname.split('/')[3] || ''));
      if (!who) return E(404, 'Участник не найден');
      if (!who.avatarRev) return J(200, { avatar: null, rev: null });
      await store.loadAvatar(who);
      return J(200, { avatar: who.avatar || null, rev: who.avatarRev },
        { 'Cache-Control': 'no-store' });
    }

    return E(404, 'Неизвестный метод API');
  }

  /**
   * Восстановить базу из распакованной копии. Всегда сначала страховочная
   * копия текущего состояния — чтобы откат был возможен даже после отката.
   */
  async function doRestore(buf) {
    let payload;
    try { payload = backup.open(buf, db.serverSecret); }
    catch (e) { return E(400, 'Копия не открылась: ' + e.message); }
    let safety = null;
    try {
      safety = await backup.createBackup({ store, db, build: BUILD, prefix: 'prerestore/' });
    } catch (e) {
      return E(502, 'Остановлено: не удалось сделать страховочную копию текущего состояния (' + e.message + ')');
    }
    let res;
    try {
      if (store.name === 'ydb') {
        if (!Array.isArray(payload.rows)) return E(400, 'Копия не подходит для облачного восстановления (в ней нет записей таблицы)');
        res = await store.restoreRows(payload.rows);
      } else {
        if (!payload.db || typeof payload.db !== 'object') return E(400, 'Копия не подходит для домашнего режима (в ней нет базы)');
        res = await store.restoreFiles(payload);
      }
    } catch (e) {
      return E(502, 'Восстановление прервано: ' + e.message);
    }
    db = await store.load();
    return J(200, {
      ok: true,
      safety: safety ? safety.key : null,
      dropped: res.dropped === undefined ? null : res.dropped,
      written: res.written === undefined ? null : res.written,
      createdAt: payload.createdAt || null
    });
  }

  // ------------------------------------------------------------- точка входа
  async function handle(req) {
    dirty = false;
    db = await store.load();
    try { pruneGhostChats(); } catch (e) { /* чистка не должна ломать запрос */ }
    let out;
    try {
      out = await api(req);
    } catch (e) {
      if (e && e.statusCode) return { status: e.statusCode, json: { error: e.message } };
      throw e;
    }
    if (dirty || store.dirty) {
      try {
        await store.flush(db);
      } catch (e) {
        return { status: 503, json: { error: 'Не удалось сохранить данные: ' + e.message } };
      }
    }
    return out;
  }

  return { handle, config: { STORAGE_LIMIT, SESSION_TTL, MAX_MEMBERS, MAX_UPLOAD }, store };
}

module.exports = { createApi };
