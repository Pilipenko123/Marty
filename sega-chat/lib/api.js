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

const MB = 1024 * 1024;

function createApi(store, opts = {}) {
  const STORAGE_LIMIT = Number(opts.storageLimit || process.env.STORAGE_LIMIT || 250 * MB);
  const SESSION_TTL = Number(opts.sessionTtl || 60 * 24 * 60 * 60 * 1000); // 60 дней
  const MAX_MEMBERS = Number(opts.maxMembers || process.env.MAX_MEMBERS || 200);
  const MAX_UPLOAD = Number(opts.maxUpload || process.env.MAX_UPLOAD || 3.1 * MB);
  const SYNC_MAX_COUNT = Number(opts.syncMaxCount || 400);
  const SYNC_MAX_BYTES = Number(opts.syncMaxBytes || process.env.SYNC_MAX_BYTES || 1.2 * MB);
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
  function usage() {
    // плашка показывает РЕАЛЬНО занятый объём: зашифрованные тела сообщений, аватары,
    // конверты архивов, куски загрузок и фото фона/иконок чатов
    const arcBytes = db.archives.reduce((a, r) => a + (r.bytes || 0), 0);
    const chatAssets = db.chats.reduce((a, c) => a + (c.wallLen || 0) + (c.iconLen || 0), 0);
    const bytes = db.stats.bytes + avatarBytes() + arcBytes + (db.upBytes || 0) + chatAssets;
    return {
      bytes, limit: STORAGE_LIMIT,
      percent: Math.min(100, Math.round(bytes / STORAGE_LIMIT * 1000) / 10),
      messages: db.stats.count,
      archives: db.archives.length,
      archiveBytes: arcBytes
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
      lastArchive: c.lastArchive || null
    };
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
    db.gen++;
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
  async function notifyPush(chat, sender) {
    if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return;
    try {
      const webpush = require('web-push');
      webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
      const jobs = [];
      for (const u of db.users) if (u.id !== sender.id && chat.members.includes(u.id)) for (const sub of (u.pushSubs || [])) {
        jobs.push(webpush.sendNotification(sub, JSON.stringify({ title: 'SEGA-CHAT', body: 'Новое сообщение', tag: chat.id })).catch(e => {
          if (e.statusCode === 404 || e.statusCode === 410) u.pushSubs = (u.pushSubs || []).filter(x => x.endpoint !== sub.endpoint);
        }));
      }
      await Promise.all(jobs); if (jobs.length) save();
    } catch (e) { if (process.env.PUSH_DEBUG) console.error('[push]', e.message); }
  }

  /** Пуш конкретному человеку (реакция на его сообщение, комментарий и т.п.). */
  async function notifyPushTo(target, sender, body) {
    if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return;
    if (!target || target.id === sender.id) return;
    try {
      const webpush = require('web-push');
      webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
      for (const sub of (target.pushSubs || [])) {
        webpush.sendNotification(sub, JSON.stringify({ title: 'SEGA-CHAT', body, tag: 'evt-' + target.id })).catch(e => {
          if (e.statusCode === 404 || e.statusCode === 410) target.pushSubs = (target.pushSubs || []).filter(x => x.endpoint !== sub.endpoint);
        });
      }
      await Promise.race([Promise.all((target.pushSubs || []).map(() => Promise.resolve())), new Promise(r => setTimeout(r, 3000))]);
      save();
    } catch (e) { if (process.env.PUSH_DEBUG) console.error('[push]', e.message); }
  }

  // ------------------------------------------------------------- маршруты
  async function api(req) {
    const { method, path: pathname, query, ip } = req;

    if (pathname === '/api/state' && method === 'GET') {
      return J(200, {
        app: 'SEGA-CHAT',
        build: 'pkg3-10',
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
      const since = Number(query.get('since') || 0);
      if (query.get('active') === '1') { me.activeAt = Date.now(); store.touchPresence(me, true); }
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
      return J(200, {
        messages: out,
        chats: myChats(me.id).map(c => publicChat(c, me.id)),
        seq: seqOut, more, gen: db.gen,
        users: db.users.map(publicUser),
        usage: usage(),
        me: publicUser(me),
        serverTime: Date.now()
      });
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
            id: m.id, seq: ++db.seq, uid: m.uid, ts: m.ts || Date.now(),
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

      let parent = null;
      if (b.parent) {
        const p = await findMessage(b.parent);
        if (!p) return E(404, 'Исходное сообщение не найдено');
        if (p.chat !== chat.id) return E(400, 'Комментарий не из того чата');
        if (p.parent) return E(400, 'Комментировать можно только исходное сообщение');
        parent = p.id;
      }
      let quote = null;
      if (b.quote) {
        const q = await findMessage(b.quote);
        if (!q) return E(404, 'Сообщение-ссылка не найдено');
        if (q.chat !== chat.id) return E(400, 'Ссылаться можно только на сообщение этого чата');
        quote = q.id;
      }
      const m = { id: uid(), seq: ++db.seq, uid: me.id, ts: Date.now(), blob: b.blob, bytes: b.blob.length, chat: chat.id, parent, quote, upId: b.upId || null };
      db.messages.push(m);
      addStat(m, 1);
      me.reads = me.reads || {};
      me.reads[parent ? 'thr:' + parent : chat.id] = m.seq;
      save();
      // Облачная функция замораживается сразу после того, как ответила браузеру,
      // поэтому отправку пуша нужно дождаться — иначе он физически не успевает
      // дойти до сервиса рассылок. Но ждём не дольше 3 секунд, чтобы внешняя
      // служба не могла затормозить отправку сообщения.
      await Promise.race([
        notifyPush(chat, me).catch(() => {}),
        new Promise(resolve => setTimeout(resolve, 3000))
      ]);
      if (parent) {
        const pAuthor = db.users.find(u => u.id === parent.uid);
        if (pAuthor && pAuthor.id !== me.id) {
          await Promise.race([
            notifyPushTo(pAuthor, me, me.name + ' прокомментировал(а) ваше сообщение'),
            new Promise(r => setTimeout(r, 3000))
          ]);
        }
      }
      return J(200, { message: m, usage: usage() });
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
      db.seq++; db.gen++; save();   // gen++ → клиенты перечитают сообщение и увидят реакцию
      const author = db.users.find(u => u.id === m.uid);
      if (author && author.id !== me.id && had) {
        await Promise.race([
          notifyPushTo(author, me, me.name + ' отреагировал(а) на ваше сообщение'),
          new Promise(r => setTimeout(r, 3000))
        ]);
      }
      return J(200, { reactions: m.reactions, usage: usage() });
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
      db.gen++;   // правка видна всем: клиенты перечитают историю
      db.stats.bytes = Math.max(0, db.stats.bytes - old + m.bytes);
      const cs = db.stats.chats[m.chat];
      if (cs) cs.b = Math.max(0, cs.b - old + m.bytes);
      db.seq++; save();
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
      for (const m of db.messages) if (m.quote === id) m.quote = null;
      db.seq++;
      save();
      return J(200, { ok: true, usage: usage() });
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
          const dead = db.chats.filter(c => !c.members.length).map(c => c.id);
          db.chats = db.chats.filter(c => c.members.length);
          for (const d of dead) dropChat(d);
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
      if (u.bytes + meta.size > STORAGE_LIMIT) return E(507, 'Память чата заполнена — освободите место');
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

  // ------------------------------------------------------------- точка входа
  async function handle(req) {
    dirty = false;
    db = await store.load();
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
