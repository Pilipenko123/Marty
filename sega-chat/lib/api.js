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
const smtp = require('./smtp.js');   // pkg3-64: письма привязки почты и восстановления (без новых зависимостей)

const MB = 1024 * 1024;

/** Отметка выпуска: её видно в подвале настроек и в /api/state. */
const BUILD = 'pkg3-76';
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

  // pkg3-51: где лежат принятые слепки канала «основной → запасной».
  // В облаке — приватный бакет рядом с программой (папка standby/),
  // в файловом режиме — папка standby/ рядом с базой. Имена относительные,
  // всякие «../» из запроса наружу не выпускаем.
  function stPath(rel) {
    const fs = require('fs'), path = require('path'), os = require('os');
    const base = path.join(store.dataDir || os.tmpdir(), 'standby');
    const full = path.join(base, String(rel));
    if (!full.startsWith(base + path.sep) && full !== base) throw new Error('Неверное имя');
    return full;
  }
  async function stPut(rel, buf) {
    if (backup.enabled()) return backup.s3().put('standby/' + rel, buf, 'application/octet-stream');
    const fs = require('fs'), path = require('path');
    const p = stPath(rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, buf);
  }
  async function stGet(rel) {
    if (backup.enabled()) {
      try { return await backup.s3().get('standby/' + rel); } catch (e) { return null; }
    }
    const fs = require('fs');
    try { return fs.readFileSync(stPath(rel)); } catch (e) { return null; }
  }
  async function stDel(rel) {
    if (backup.enabled()) return backup.s3().del('standby/' + rel);
    const fs = require('fs');
    fs.rmSync(stPath(rel), { force: true });
  }
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

  // ── pkg3-45: персональные приглашения ────────────────────────────────────
  /** Срок жизни ссылки и период «одна ссылка в сутки» — одинаковые 24 часа. */
  const INVITE_TTL = 24 * 3600 * 1000;
  // pkg3-62: пауза «одна ссылка в сутки» отделена от срока жизни ссылки —
  // в бою сутки, в опытах (тесты) обнуляется переменной окружения
  const INVITE_COOLDOWN_MS = Number(process.env.INVITE_COOLDOWN_MS === undefined ? INVITE_TTL : process.env.INVITE_COOLDOWN_MS);
  /** Состояние ссылки: жива / использована / истекла / отозвана. */
  function inviteState(inv, now) {
    if (inv.revoked) return 'revoked';
    if (inv.usedBy) return 'used';
    if (inv.expiresAt <= now) return 'expired';
    return 'live';
  }
  /** Разобрать токен «id.секрет» и проверить секрет по хешу. Сервер секрет не хранит. */
  function findInviteByToken(token) {
    const t = String(token || '');
    const dot = t.indexOf('.');
    if (dot < 1) return null;
    const inv = db.invites.find(x => x.id === t.slice(0, dot));
    if (!inv) return null;
    const h = crypto.createHash('sha256').update(t.slice(dot + 1)).digest('hex');
    if (!timingEqual(h, inv.secretHash)) return null;
    return inv;
  }
  /** Когда владельцу можно следующую ссылку (0 — можно прямо сейчас). */
  function inviteNextAt(ownerId, now) {
    const last = db.invites.filter(i => i.ownerId === ownerId)
      .map(i => i.createdAt).sort((a, b) => b - a)[0] || 0;
    return last && now - last < INVITE_COOLDOWN_MS ? last + INVITE_COOLDOWN_MS : 0;
  }
  /** Политика блокировок: глобально / участнику / группе. Администраторов не касается. */
  function inviteBlocked(user) {
    if (user.isAdmin) return false;
    const p = db.invitePolicy || {};
    if (p.globalOff) return 'global';
    if ((p.blockedUsers || []).includes(user.id)) return 'user';
    if ((p.blockedChats || []).some(cid => {
      const c = db.chats.find(x => x.id === cid);
      return c && c.members.includes(user.id);
    })) return 'group';
    return false;
  }
  /** Журнал администратора: держим последние 500 записей, чтобы не раздувать базу. */
  function adminLogAdd(by, what) {
    db.adminLog.push({ at: Date.now(), by, what });
    if (db.adminLog.length > 500) db.adminLog.splice(0, db.adminLog.length - 500);
  }

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
    const KIND_OF = m => String(m || '').startsWith('image/') ? 'photos'
      : (String(m || '').startsWith('video/') || String(m || '').startsWith('audio/') ? 'media' : 'files');
    const KIND_LABEL = { photos: 'Фото', media: 'Медиа', files: 'Файлы' };
    const storageCache = new Map();   // ключ -> {ts, data}
    async function storageSummary(scope, meId, fresh, isAdmin) {
      const key = scope + ':' + meId;
      if (!fresh) {
        const hit = storageCache.get(key);
        if (hit && Date.now() - hit.ts < 5 * 60 * 1000) return hit.data;
      }
      const ups = (await store.listUpMeta()).filter(u => u && !u.gone);
      const u = usage();
      const upTotal = ups.reduce((a, x) => a + Math.ceil((x.stored || x.size || 0) * UP_B64), 0);
      const mine = scope === 'me';
      const cats = {
        messages: { bytes: 0, count: 0 },
        photos: { bytes: 0, count: 0 },
        media: { bytes: 0, count: 0 },
        files: { bytes: 0, count: 0 }
      };
      for (const x of ups) {
        if (mine && x.owner !== meId) continue;
        const b = Math.ceil((x.stored || x.size || 0) * UP_B64);
        cats[KIND_OF(x.mime)].bytes += b;
        cats[KIND_OF(x.mime)].count += 1;
      }
      if (mine) {
        for (const m of db.messages) {
          if (m.uid !== meId || m.svc) continue;
          cats.messages.bytes += (m.bytes || 0) + MSG_ROW_OVERHEAD;
          cats.messages.count += 1;
        }
      } else {
        cats.messages.bytes = Math.max(0, u.bytes - upTotal);
        cats.messages.count = db.stats.count;
      }
      const data = {
        scope, used: u.bytes, limit: u.limit, percent: u.percent,
        diskFree: diskFree(), cats,
        free: Math.max(0, u.limit - u.bytes),
        canOperate: isAdmin === true
      };
      storageCache.set(key, { ts: Date.now(), data });
      return data;
    }

  // pkg3-74: предел хранилища может поднять администратор из мессенджера
  // (db.storageLimit); без него действует предел из окружения
  function currentLimit() {
    const v = Number(db.storageLimit);
    return v > 0 ? v : STORAGE_LIMIT;
  }
  // pkg3-74: свободное место диска под базой (для пульта и для предела)
  function diskFree() {
    // pkg3-75: fs требуем прямо здесь — в области видимости модуля его нет,
    // и в pkg3-74 функция молча падала в catch, отдавая null («н/д» в пульте).
    try {
      const fs = require('fs');
      const st = fs.statfsSync(process.env.DATA_DIR || 'data');
      return Math.floor(st.bavail * st.bsize);
    } catch (e) { return null; }
  }
  function usage() {
    const arcBytes = db.archives.reduce((a, r) => a + (r.bytes || 0), 0);
    const chatAssets = db.chats.reduce((a, c) => a + (c.wallLen || 0) + (c.iconLen || 0), 0);
    const uploads = Math.ceil((db.upBytes || 0) * UP_B64);
    const overhead = db.stats.count * MSG_ROW_OVERHEAD;
    const bytes = db.stats.bytes + overhead + avatarBytes() + arcBytes + uploads + chatAssets;
    const LIMIT = currentLimit();
    return {
      bytes, limit: LIMIT,
      percent: Math.min(100, Math.round(bytes / LIMIT * 1000) / 10),
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
    // pkg3-61: «поглощение» учётки — администратор привязал к старой учётке
    // внешность другой (друг потерял пароль и зарегистрировался заново):
    // имя и аватар берутся от новой учётки, поэтому ВСЯ старая переписка
    // отображается новым лицом. Идентификатор остаётся прежним — авторство
    // сообщений и ключи не подменяются, шифрование не трогается.
    const t = u.displayAs ? db.users.find(x => x.id === u.displayAs && !x.displayAs) : null;
    return {
      id: u.id, name: t ? t.name : u.name, isAdmin: !!u.isAdmin,
      invitedBy: u.invitedBy || 'root',   // pkg3-45: для раздела «Приглашенные» и дерева
      avatar: t ? (t.avatarRev || null) : (u.avatarRev || null),   // отпечаток: сама картинка скачивается через /api/avatar/:id
      status: u.status || null,           // короткий статус участника («на связи до шести»)
      createdAt: u.createdAt, lastSeen: u.lastSeen || 0, activeAt: u.activeAt || 0,
      pub: u.pub || null, reads: u.reads || {},
      displayAs: (u.displayAs && t) ? t.id : null
    };
  }

  /** pkg3-62: настоящая учётка человека. Поглощённая (слитая) учётка — только
   * старая история: её не видно в поиске, а новое обращение уходит на ту, чью
   * внешность она носит. Цепочек псевдонимов не бывает (слияние это запрещает),
   * поэтому достаточно одного шага. */
  function realOf(u) {
    if (!u || !u.displayAs) return u;
    return db.users.find(x => x.id === u.displayAs && !x.displayAs) || u;
  }

  // ------------------------------------------------------------- чаты
  const dmId = (a, b) => 'dm:' + [a, b].sort().join('|');
  const chatById = (id) => db.chats.find(c => c.id === id) || null;
  const isMember = (chat, userId) => !!chat && chat.members.includes(userId);
  const myChats = (userId) => db.chats.filter(c => c.members.includes(userId));
  /** pkg3-49/50: личные чаты, которые участник держит у себя.
   *  Раздел «Новые»: чат с незнакомцем живёт у адресата СУТКИ после появления
   *  (или после нового письма, если срок уже истёк) и удаляется сам — но только
   *  из списков адресата: у автора письма переписка остаётся навсегда.
   *  Кнопка «Добавить пользователя в мои личные чаты» сохраняет чат безвременно.
   *  pkg3-50: правило действует на всех одинаково, включая администратора —
   *  владелец мессенджера тоже даёт согласие кнопкой. */
  // pkg3-54: «Новые» живут 7 суток (по ТЗ), а не сутки, как в pkg3-49/50
  const NEW_DM_TTL = Number(process.env.NEW_DM_TTL || 7 * 24 * 60 * 60 * 1000);
  // pkg3-54: не больше четырёх одновременных партий, где участник — игрок
  const MAX_LIVE_GAMES = Math.max(1, Number(process.env.MAX_LIVE_GAMES || 4));
  // pkg3-59: «бан на сутки» по жалобе — срок в тестах укорачивают переменной
  const BAN_MS = Math.max(1000, Number(process.env.BAN_MS || 24 * 60 * 60 * 1000));
  /** pkg3-59: одинаковый честный отказ забаненному — и при входе, и при опросе.
   * Клиент по коду 'banned' показывает уведомление о жалобе и срок. */
  /** pkg3-64: базовый адрес для ссылок в письмах (или заголовок запроса). */
  const publicBase = req => String(process.env.SEGA_PUBLIC_URL || '').replace(/\/$/, '')
    || ('https://' + ((req && req.headers && req.headers.host) || 'segachat.pilpro.ru'));
  const banError = until => ({
    status: 403,
    json: { error: 'Поступила жалоба — доступ ограничен на сутки', code: 'banned', until }
  });
  // pkg3-54: приглашённый первые сутки не может приглашать сам; 0 — выключено (для проверок)
  const NEW_INVITE_DELAY = Number(process.env.NEW_INVITE_DELAY === undefined
    ? 24 * 60 * 60 * 1000 : process.env.NEW_INVITE_DELAY);
  // pkg3-53: пользовательские разделы (папки) — личные, хранят КОПИИ ссылок на чаты
  const MAX_SECTIONS = Math.max(1, Number(process.env.MAX_SECTIONS || 20));
  const MAX_SECTION_CHATS = Math.max(1, Number(process.env.MAX_SECTION_CHATS || 300));
  /** Возвращает { chats, newUntil }: положенные участнику чаты и отметки
   * «удалится сам» для его раздела «Новые». Отметки живут в отдельной карте —
   * общие объекты чатов трогать нельзя: их видят и другие участники.
   * pkg3-50: правило «Новых» действует и на администратора — владелец мессенджера
   * сам решает кнопкой, пускать незнакомца в личные чаты или нет. Исключение
   * осталось одно: автор письма и сохранивший чат видят его как обычный личный. */
  /** pkg3-54: сколько одновременных партий, где участник — игрок (ещё не завершено). */
  const liveGamesOf = (id) => db.chats.filter(c => c.kind === 'game'
    && (c.roles || {})[id] === 'player'
    && ['invite', 'playing'].includes(((c.game || {}).status))).length;
  const myVisibleChats = (userId, now) => {
    const u = db.users.find(x => x.id === userId) || {};
    // pkg3-54: отклонённый чат скрыт даже от возрождения новым письмом
    const hidden = new Set([...(u.hiddenChats || []), ...(u.declined || [])]);
    const t = now || Date.now();
    const out = [], newUntil = {};
    for (const c of db.chats) {
      if (!c.members.includes(userId) || hidden.has(c.id)) continue;
      // «Новые»: адресат, который сам чат не создавал и не сохранял.
      // pkg3-54: правило действует и на групповые чаты, куда меня добавил кто-то
      // другой, — маркер newChats ставится при создании группы и при добавлении.
      // Старые группы (без маркера) видны как раньше: правило их не трогает.
      // pkg3-60: ЖИВОЙ отсчёт «Новых» важнее отметки «открывал»: чат, возвращённый
      // новым письмом после удаления/отклонения, попадает в «Новые», даже если
      // участник когда-то в нём писал (сценарий «убрал знакомого — он написал»).
      const saved = (c.savedBy || []).includes(userId);
      const dmRec = (u.newChats || {})[c.id];
      const dmNew = c.kind === 'dm' && !saved
        && ((dmRec && dmRec.until >= t) || !(c.openedBy || []).includes(userId));
      const grpNew = c.kind === 'group' && (c.ownerId || null) !== userId && !saved
        && !!((u.newChats || {})[c.id]);
      if (dmNew || grpNew) {
        const st = db.stats.chats[c.id] || { t: 0 };
        const last = Math.max(c.createdAt || 0, st.t || 0);
        const rec = (u.newChats || {})[c.id];
        // новое письмо после истечения срока возвращает чат в «Новые» ещё на сутки
        if (!rec || (rec.until < t && last > rec.until)) {
          u.newChats = u.newChats || {};
          u.newChats[c.id] = { at: t, until: t + NEW_DM_TTL };
          save();
        }
        if (u.newChats[c.id].until < t) continue;   // сутки прошли — чат удалился сам
        newUntil[c.id] = u.newChats[c.id].until;    // отметка для счётчика в интерфейсе
      }
      out.push(c);
    }
    return { chats: out, newUntil };
  };
  /** Те же чаты простым списком — для внутренних расчётов круга видимости. */
  const myVisibleChatList = (userId, now) => myVisibleChats(userId, now).chats;
  /** pkg3-48: кого видит участник. По умолчанию мессенджер больше не показывает
   * весь список людей каждому: видны только участники своих чатов, связи
   * «Приглашенных» (в обе стороны), собеседники по запросам и использованным
   * ссылкам, а также игроки открытых партий и стучащиеся в мои игры.
   * Остальных находим поиском по нику (/api/search) и добавляем личным чатом. */
  function visibleUsers(me) {
    const ids = new Set([me.id]);
    for (const c of myVisibleChatList(me.id)) {
      for (const m of c.members) ids.add(m);
      for (const k of (c.knocks || [])) ids.add(k);
    }
    for (const b of db.bonds) {
      if (b.owner === me.id) ids.add(b.member);
      if (b.member === me.id) ids.add(b.owner);
    }
    for (const r of db.bondReqs) {
      if (r.to === me.id) ids.add(r.from);
      if (r.from === me.id) ids.add(r.to);
    }
    for (const i of db.invites) if (i.ownerId === me.id && i.usedBy) ids.add(i.usedBy);
    // pkg3-49: игроки из плашки «Сейчас играют» в список людей НЕ добавляются —
    // партию видно и так, а знакомиться положено поиском. Стучащиеся в мои
    // партии видны мне всегда (иначе не пустить зрителя).
    for (const c of db.chats) {
      if (c.kind === 'game' && c.game && (c.game.white === me.id || c.game.black === me.id)) {
        for (const k of (c.knocks || [])) ids.add(k);
      }
    }
    return db.users.filter(u => ids.has(u.id));
  }

  function publicChat(c, meId, newUntil) {
    const st = db.stats.chats[c.id] || { n: 0, b: 0, t: 0 };
    return {
      id: c.id, kind: c.kind, titleBlob: c.titleBlob || null, titlePlain: c.titlePlain || null,
      legacyRoomKey: !!c.legacyRoomKey, ownerId: c.ownerId || null, members: c.members,
      createdAt: c.createdAt, key: (c.keys && c.keys[meId]) || null,
      keyEpoch: c.keyEpoch || 0,   // pkg3-63: поколение ключа группы — клиенты ловят перевыпуск
      // pkg3-66: прежние поколения ключа — участнику отдаются ТОЛЬКО его свёртки
      // (blob) и метка, кто завернул (by); сервер содержимое не видит
      oldKeys: Object.entries(c.oldKeys || {}).map(([id, o]) => ({
        // pkg3-70: адрес слота — отпечаток ключа (fp); для старых слотов
        // оставляем и числовую метку ep — клиенты 66–69 читают только её
        id: id, ep: Number.isFinite(Number(id)) ? Number(id) : undefined,
        by: (o && o.by) || null, blob: ((o && o.wraps) || {})[meId] || null
      })),
      count: st.n, bytes: st.b, lastTs: st.t || c.createdAt || 0,
      archivedByName: c.archivedByName || (c.lastArchive ? c.lastArchive.byName : null) || null,
      archivedAt: c.archivedAt || (c.lastArchive ? (c.lastArchive.at || c.lastArchive.createdAt) : null) || null,
      archivedCount: c.archivedCount !== undefined ? c.archivedCount : (c.lastArchive ? c.lastArchive.count : null),
      clearedByName: c.clearedByName || null,
      clearedAt: c.clearedAt || null,
      clearedCount: c.clearedCount !== undefined && c.clearedCount !== null ? c.clearedCount : null,
      wall: c.wall || null, wallRev: c.wallRev || null, iconRev: c.iconRev || null,
      lastArchive: c.lastArchive || null,
      roles: c.roles || null, game: c.game || null, knocks: c.knocks || null,
      // pkg3-49: кто из двоих держит этот личный чат в своих «Личных чатах»
      // и когда чат удалится сам, если он лежит в разделе «Новые»
      savedBy: Array.isArray(c.savedBy) ? c.savedBy.slice() : [],
      newUntil: newUntil || null
    };
  }

  /** Живые приглашения: адресат видит их до вступления в игру. */
  function openInvites(uid) {
    return db.chats
      .filter(c => c.kind === 'game' && c.game && c.game.status === 'invite' && c.game.invitee === uid)
      .map(c => ({ id: c.id, owner: c.ownerId, colorChoice: c.game.colorChoice, createdAt: c.createdAt }));
  }

  /** Открытые игры для тех, кто не участник: справочник «постучаться в зрители».
   * pkg3-49: чужие партии больше не видны всем подряд — плашка появляется, только
   * если ХОТЯ БЫ ОДИН игрок из моего тесного круга: собеседники по личным
   * перепискам, «Приглашенные» в обе стороны и собеседники по запросам-согласиям.
   * Совсем чужие люди (никогда не переписывались) в справочник не попадают.
   * Администратор видит всё. */
  function openGames(uid) {
    const me = db.users.find(u => u.id === uid);
    if (!me) return [];
    const circle = new Set([uid]);
    if (!me.isAdmin) {
      for (const c of db.chats) {
        if (c.kind === 'dm' && c.members.includes(uid)) {
          for (const m of c.members) circle.add(m);
        }
      }
      for (const b of db.bonds) { if (b.owner === uid) circle.add(b.member); if (b.member === uid) circle.add(b.owner); }
      for (const r of db.bondReqs) { if (r.to === uid) circle.add(r.from); if (r.from === uid) circle.add(r.to); }
    }
    return db.chats
      .filter(c => c.kind === 'game' && c.game && c.game.status === 'playing' && !c.members.includes(uid))
      .filter(c => me.isAdmin || circle.has(c.game.white) || circle.has(c.game.black))
      .map(c => ({
        id: c.id, white: c.game.white, black: c.game.black,
        rules: c.game.rules || 'chess',
        createdAt: c.createdAt, knocks: (c.knocks || []).length,
        moves: (db.stats.chats[c.id] || {}).n || 0
      }));
  }

  /** pkg3-49: чужие заявки в МОИ партии — заявщик может быть не из моего круга,
   * но мне нужно видеть, кто стучится, и кого пускать в зрители. */
  function myKnockedGames(uid) {
    return db.chats
      .filter(c => c.kind === 'game' && c.game && c.game.status === 'playing'
        && (c.game.white === uid || c.game.black === uid) && (c.knocks || []).length)
      .map(c => ({
        id: c.id, white: c.game.white, black: c.game.black,
        rules: c.game.rules || 'chess',
        createdAt: c.createdAt, knocks: (c.knocks || []).length,
        moves: (db.stats.chats[c.id] || {}).n || 0
      }));
  }

  function ensureDm(a, b) {
    const id = dmId(a, b);
    let c = chatById(id);
    if (!c) {
      c = { id, kind: 'dm', members: [a, b].sort(), keys: {}, createdAt: Date.now(), savedBy: [], openedBy: [] };
      db.chats.push(c);
      db.stats.chats[id] = { n: 0, b: 0, t: c.createdAt };
      save();
    }
    return c;
  }
  /** pkg3-49: участник создал/открыл личный чат — для него чат обычный, не «Новый». */
  function markDmOpened(chat, userId) {
    if (!chat || chat.kind !== 'dm') return;
    if (!Array.isArray(chat.openedBy)) chat.openedBy = [];
    if (!chat.openedBy.includes(userId)) { chat.openedBy.push(userId); save(); }
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
    // pkg3-57: слепки флота «Морского боя» стираем вместе с игрой
    for (const u of db.users) if (u.sbFleets && u.sbFleets[chatId]) delete u.sbFleets[chatId];
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
        c.savedBy = (c.savedBy || []).filter(id => userIds.has(id));   // pkg3-49
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
  // pkg3-52: лимит теперь настраивается per-ключ. Вход и регистрация остались
  // строгими (25 попыток за 10 минут), а поиск участников стал центральным —
  // он живёт в строке «Найти чат или участника» и дёргается при каждом запросе,
  // поэтому ему разрешено больше (SEARCH_LIMIT, по умолчанию 60).
  const SEARCH_LIMIT = Math.max(5, Number(process.env.SEARCH_LIMIT || 60));
  function throttle(key, limit) {
    const max = Number(limit) > 0 ? Number(limit) : 25;
    const now = Date.now();
    const rec = attempts.get(key) || { n: 0, t: now };
    if (now - rec.t > 10 * 60 * 1000) { rec.n = 0; rec.t = now; }
    rec.n++; attempts.set(key, rec);
    return rec.n > max; // больше max попыток за 10 минут — отказ
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
    // pkg3-59: забаненный не проходит ни на один маршрут — но узнаёт причину
    if (u.bannedUntil && u.bannedUntil > Date.now()) return { banned: u.bannedUntil };
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
      // pkg3-57: подпись пуша — только из готового набора (сервер не читает
      // переписку, а клиенту важно разбудить устройство соперника в морском
      // бою внятным текстом). Неизвестный знак — прежняя подпись по умолчанию.
      const NOTIFY_BODIES = { game: 'Ход в игре — откройте партию' };
      sent += await notifyPush(chat, me, NOTIFY_BODIES[String(b.body || '')]);
      if (kind === 'thr' && m) {
        const author = db.users.find(u => u.id === m.uid);
        if (author && author.id !== me.id) sent += await notifyPushTo(author, me, me.name + ' прокомментировал(а) ваше сообщение');
      }
    } else if (kind === 'react') {
      const m = b.mid ? await findMessage(b.mid) : null;
      if (!m || m.chat !== chat.id) return E(404, 'Сообщение не найдено');
      const author = db.users.find(u => u.id === m.uid);
      if (author && author.id !== me.id) sent += await notifyPushTo(author, me, me.name + ' отреагировал(а) на ваше сообщение');
    } else if (kind === 'saved') {
      // pkg3-49: «я добавил вас в свои личные чаты» — короткий пуш собеседнику
      const peer = db.users.find(u => u.id !== me.id && chat.members.includes(u.id));
      if (peer) sent += await notifyPushTo(peer, me, me.name + ' добавил(а) вас в свои личные чаты');
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
        diskFree: diskFree(),   // pkg3-74: пульт памяти показывает свободное место диска
        codeProofSalt: db.room ? db.room.codeProofSalt : null,
        // pkg3-45: регистрация закрыта — только по персональному приглашению;
        // кодовая фраза принимает лишь пока открыто аварийное окно администратора
        registration: 'invite',
        emergencyOpen: db.emergencyRegUntil > Date.now(),
        limit: currentLimit(), maxUpload: MAX_UPLOAD,   // pkg3-74: предел может поднять администратор
        // pkg3-51: подпись сервера («VPS (основной)» / «Яндекс (запасной)») —
        // владелец ставит её переменной окружения SEGA_LABEL, чтобы в подвале
        // было видно, КТО именно сейчас отвечает
        serverLabel: process.env.SEGA_LABEL ? String(process.env.SEGA_LABEL) : null
      });
    }

    // ─────────────────────────────────────────────────────────────────
    // pkg3-51: канал «основной сервер → запасной». Оба сервера шлют друг
    // другу шифрованные слепки базы поверх HTTPS; вход — по общему секрету
    // SEGA_STANDBY_TOKEN (переменная окружения с обеих сторон). Без секрета
    // маршрутов просто нет: посторонний получит «404».
    //   POST /api/standby/receive  {token,id,i,data}   кусок слепка
    //   POST /api/standby/receive  {token,id,fin,parts,sha256}  собрать куски
    //   GET  /api/standby/snapshot?token=              последний принятый слепок
    //   GET  /api/standby/ping?token=                  жив ли приёмник
    //   GET  /api/standby/export?token=&key=&i=&size=  слепок СЕЙЧАС, зашифрованный
    //                                                  одноразовым ключом key
    // ─────────────────────────────────────────────────────────────────
    if (pathname.startsWith('/api/standby/')) {
      const want = String(process.env.SEGA_STANDBY_TOKEN || '');
      const got = String(query.get('token') || (req.body && req.body.token) || '');
      const okToken = !!want && !!got && Buffer.from(got).length === Buffer.from(want).length
        && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
      if (!okToken) return E(404, 'Нет такой страницы');

      if (pathname === '/api/standby/ping' && method === 'GET') {
        const last = await stGet('latest.sbgz');
        return J(200, { ok: true, build: BUILD, at: Date.now(), has: !!last, bytes: last ? last.length : 0 });
      }

      if (pathname === '/api/standby/receive' && method === 'POST') {
        const b = req.body || {};
        const id = String(b.id || '');
        if (!/^[a-f0-9]{8,64}$/.test(id)) return E(400, 'Неверный идентификатор передачи');
        if (b.fin) {
          const n = Math.max(1, Math.min(4000, Number(b.parts) || 0));
          const chunks = [];
          for (let i = 0; i < n; i++) {
            const p = await stGet('parts-' + id + '/' + i);
            if (!p) return E(400, 'Не все куски доехали — начните передачу заново');
            chunks.push(p);
          }
          const blob = Buffer.concat(chunks);
          const sha = crypto.createHash('sha256').update(blob).digest('hex');
          if (String(b.sha256 || '') !== sha) return E(400, 'Слепок пришёл повреждённым — начните передачу заново');
          await stPut('latest.sbgz', blob);
          for (let i = 0; i < n; i++) await stDel('parts-' + id + '/' + i).catch(() => {});
          return J(200, { ok: true, bytes: blob.length, sha256: sha, at: Date.now() });
        }
        const i = Number(b.i);
        if (!Number.isInteger(i) || i < 0 || i > 3999) return E(400, 'Неверный номер куска');
        const data = String(b.data || '');
        if (!data || data.length > 8 * MB) return E(400, 'Неверный кусок');
        const buf = Buffer.from(data, 'base64');
        if (Math.abs(buf.length * 4 / 3 - data.length) > 8 && data.length % 4 !== 0) return E(400, 'Кусок пришёл повреждённым');
        await stPut('parts-' + id + '/' + i, buf);
        return J(200, { ok: true, i, bytes: buf.length });
      }

      if (pathname === '/api/standby/snapshot' && method === 'GET') {
        const buf = await stGet('latest.sbgz');
        if (!buf) return E(404, 'Слепка ещё нет');
        return { status: 200, body: buf, headers: { 'Content-Type': 'application/octet-stream' } };
      }

      if (pathname === '/api/standby/export' && method === 'GET') {
        const key = String(query.get('key') || '');
        if (!/^[0-9a-f]{32,128}$/.test(key)) return E(400, 'Неверный одноразовый ключ');
        const snap = await backup.makeSnapshot({ store, db, build: BUILD, secret: key });
        const blob = snap.blob;
        const iRaw = query.get('i');
        if (iRaw === null || iRaw === '') {
          if (blob.length > 3.2 * MB) return E(413, 'Слепок большой — забирайте его кусками (i, size)');
          return J(200, {
            data: blob.toString('base64'), i: 0, done: true,
            bytes: blob.length, sha256: snap.sha256, rows: snap.rows, at: Date.now()
          });
        }
        const i = Number(iRaw);
        const size = Math.max(64 * 1024, Math.min(3 * MB, Number(query.get('size')) || 2 * MB));
        if (!Number.isInteger(i) || i < 0 || i > 3999) return E(400, 'Неверный номер куска');
        const piece = blob.subarray(i * size, (i + 1) * size);
        if (!piece.length && i > 0) return E(404, 'Куска с таким номером нет');
        return J(200, {
          data: piece.toString('base64'), i, done: (i + 1) * size >= blob.length,
          bytes: blob.length, sha256: snap.sha256, rows: snap.rows, at: Date.now()
        });
      }

      return E(404, 'Нет такой страницы');
    }

    // --- pkg3-45: публичная справка по ссылке-приглашению (до регистрации):
    // кто пригласил и конверт ключа комнаты. Секрет из ссылки серверу не показан.
    if (pathname === '/api/join-info' && method === 'GET') {
      const inv = findInviteByToken(query.get('token'));
      if (!inv) return J(200, { ok: false, reason: 'bad' });
      const st = inviteState(inv, Date.now());
      if (st !== 'live') return J(200, { ok: false, reason: st });
      const owner = db.users.find(u => u.id === inv.ownerId);
      if (!owner) return J(200, { ok: false, reason: 'gone' });
      return J(200, {
        ok: true, inviter: owner.name, invSalt: inv.invSalt, wrappedRoomKey: inv.wrappedRoomKey
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
      // pkg3-59: забаненный при входе получает честную причину и срок
      if (u.bannedUntil && u.bannedUntil > Date.now()) return banError(u.bannedUntil);
      const token = crypto.randomBytes(24).toString('hex');
      db.sessions[token] = { uid: u.id, exp: Date.now() + SESSION_TTL };
      u.lastSeen = Date.now();
      save();
      return J(200, { token, user: publicUser(u), saltWrap: u.saltWrap, wrappedKeyByPass: u.wrappedKeyByPass, wrappedPriv: u.wrappedPriv || null });
    }

    // --- pkg3-64: восстановление пароля через привязанную почту ------------
    if (pathname === '/api/recover/request' && method === 'POST') {
      if (throttle('recover:' + ip, 10)) return E(429, 'Слишком много попыток. Подождите 10 минут.');
      const b = req.body || {};
      const name = normName(b.name || '').toLowerCase();
      const em = String(b.email || '').trim().toLowerCase();
      const u = db.users.find(x => x.nameLower === name);
      // не подсказываем, существует ли имя и привязана ли почта, — единый ответ
      if (!u || !u.emailConfirmed || u.email !== em) return E(404, 'Такая почта к этому имени не привязана');
      if (!smtp.enabled()) return E(503, 'Почта на сервере не настроена: восстановление недоступно');
      if (throttle('recovermail:' + u.id, 1)) return E(429, 'Письмо уже отправлено: подождите немного');
      const token = crypto.randomBytes(24).toString('hex');
      db.recover = (db.recover || []).filter(x => x.exp > Date.now());
      db.recover.push({ token, uid: u.id, exp: Date.now() + 60 * 60 * 1000 });
      save();
      try {
        await smtp.sendMail(em, 'SEGA-CHAT: восстановление пароля',
          'Кто-то (надеемся, вы) запросил восстановление пароля для имени «' + u.name + '».\n\n'
          + 'Ссылка (действует 1 час, одноразовая):\n' + publicBase(req) + '/?recover=' + token + '\n\n'
          + 'На открывшейся странице введите код восстановления (если вы сохранили его или отправили себе на почту) и новый пароль.\n'
          + 'Не запрашивали? Просто проигнорируйте письмо: без ссылки и кода пароль не изменить.');
      } catch (e) { return E(502, 'Не удалось отправить письмо: ' + (e.message || 'почтовый сервер недоступен')); }
      return J(200, { ok: true });
    }
    if (pathname === '/api/recover/state' && method === 'GET') {
      const t = String(query.get('token') || '');
      const rec = (db.recover || []).find(x => x.token === t && x.exp > Date.now());
      const u = rec && db.users.find(x => x.id === rec.uid);
      if (!rec || !u) return E(410, 'Ссылка просрочена или уже использована');
      return J(200, { ok: true, name: u.name, hasBlob: !!u.recoveryBlob, blob: u.recoveryBlob || null });
    }
    if (pathname === '/api/recover/commit' && method === 'POST') {
      if (throttle('recovercommit:' + ip, 10)) return E(429, 'Слишком много попыток. Подождите 10 минут.');
      const b = req.body || {};
      const rec = (db.recover || []).find(x => x.token === String(b.token || '') && x.exp > Date.now());
      const u = rec && db.users.find(x => x.id === rec.uid);
      if (!rec || !u) return E(410, 'Ссылка просрочена или уже использована');
      for (const k of ['saltAuth', 'authKey', 'saltWrap'])
        if (!b[k]) return E(400, 'Не хватает поля ' + k);
      u.saltAuth = b.saltAuth;
      u.authHash = hashSecret(b.authKey, u.saltAuth);
      u.saltWrap = b.saltWrap;
      // полный режим несёт новый конверт общего ключа; «свежий» (без кода
      // восстановления) оставляет общий ключ недоступным — учётка живёт дальше
      // без старой истории, а личный ключ пересоздаётся при входе
      u.wrappedKeyByPass = b.wrappedKeyByPass || null;
      // полный режим: клиент расшифровал копию восстановления своим кодом и
      // пере-завернул личный ключ новым паролем (pub не меняется).
      // «Свежий» режим (без кода): личный ключ пересоздаётся начисто — старые
      // обёртки и pub сбрасываются, при входе пересоздаётся пара ключей
      if (b.wrappedPriv) u.wrappedPriv = b.wrappedPriv;
      else { u.wrappedPriv = null; u.pub = null; }
      db.recover = (db.recover || []).filter(x => x.token !== rec.token);
      save();
      return J(200, { ok: true, mode: b.wrappedPriv ? 'full' : 'fresh' });
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
      // pkg3-45: регистрация закрыта для всех, кроме двух дверей:
      //  1) одноразовая персональная ссылка-приглашение (основной путь);
      //  2) кодовая фраза, но ТОЛЬКО пока администратор не закрыл аварийное окно.
      // После успешной регистрации ссылка гасится, у участника появляется
      // приглашенный родитель — по нему администратор видит дерево.
      let invitedBy = null, invite = null;
      if (b.inviteToken) {
        invite = findInviteByToken(b.inviteToken);
        if (!invite) return E(403, 'Приглашение не найдено или ссылка подделана');
        const st = inviteState(invite, Date.now());
        if (st === 'revoked') return E(410, 'Приглашение отозвано пригласившим');
        if (st === 'used') return E(410, 'По этому приглашению уже зарегистрировались');
        if (st === 'expired') return E(410, 'Приглашение просрочено: попросите новую ссылку');
        const owner = db.users.find(u => u.id === invite.ownerId);
        if (!owner) return E(410, 'Пригласивший больше не участник мессенджера');
        invitedBy = owner.id;
      } else if (db.emergencyRegUntil > Date.now()) {
        invitedBy = 'code';
      } else {
        return E(403, 'Регистрация закрыта: попросите персональное приглашение у участника');
      }
      if (!b.inviteToken) {
        if (!b.codeProof || !timingEqual(hashSecret(b.codeProof, db.room.codeProofSalt), db.room.codeProofHash)) {
          return E(403, 'Неверная кодовая фраза чата');
        }
      }
      const name = normName(b.name);
      if (name.length < 2 || name.length > 32) return E(400, 'Имя: от 2 до 32 символов');
      if (db.users.some(x => x.nameLower === name.toLowerCase())) return E(409, 'Такое имя уже занято');
      // pkg3-62: имя, которое «носит» слитая учётка, тоже занято: иначе в списке
      // снова появятся два одинаковых имени
      if (db.users.some(x => x.displayAs
        && ((db.users.find(y => y.id === x.displayAs) || {}).nameLower === name.toLowerCase())))
        return E(409, 'Такое имя уже занято');
      for (const k of ['saltAuth', 'authKey', 'saltWrap', 'wrappedKeyByPass']) if (!b[k]) return E(400, 'Не хватает поля ' + k);
      const user = {
        id: uid(), name, nameLower: name.toLowerCase(), isAdmin: false,
        saltAuth: b.saltAuth, authHash: hashSecret(b.authKey, b.saltAuth),
        saltWrap: b.saltWrap,
        wrappedKeyByPass: b.wrappedKeyByPass, avatar: null,
        pub: b.pub || null, wrappedPriv: b.wrappedPriv || null, reads: {},
        invitedBy,
        createdAt: Date.now(), lastSeen: Date.now(), activeAt: Date.now()
      };
      db.users.push(user);
      if (invite) {
        invite.usedBy = user.id; invite.usedAt = Date.now();
        // pkg3-47: связь «пригласивший держит приглашённого у себя в разделе»
        db.bonds.push({ owner: invitedBy, member: user.id, origin: 'invite', at: Date.now() });
        // pkg3-48: личный чат пригласивший↔приглашённый создаётся сразу:
        // приглашённый видит пригласившего в «Личных чатах» с первой минуты,
        // а пригласивший — приглашённого в разделе «Приглашенные» и в чатах.
        // Ключи чата пустые: первый открывший сгенерирует и раздаст их сам.
        ensureDm(invitedBy, user.id);   // штатный личный чат (тот же id и счётчики, что при ручном создании)
        // pkg3-49: этот чат сразу сохранён и открыт у ОБОИХ — он не попадает
        // в «Новые» и не удалится через сутки: пригласивший видит приглашённого
        // в разделе «Приглашенные» и в «Личных чатах», приглашённый — только этот чат.
        const dm0 = chatById(dmId(invitedBy, user.id));
        if (dm0) { dm0.savedBy = [invitedBy, user.id]; dm0.openedBy = [invitedBy, user.id]; }
      }
      const token = crypto.randomBytes(24).toString('hex');
      db.sessions[token] = { uid: user.id, exp: Date.now() + SESSION_TTL };
      save();
      return J(200, { token, user: publicUser(user), saltWrap: user.saltWrap, wrappedKeyByPass: user.wrappedKeyByPass, wrappedPriv: user.wrappedPriv });
    }

    // ------------------------------------------------ дальше только с токеном
    const session = await auth(req);
    if (session && session.banned) return banError(session.banned);
    if (!session) return E(401, 'Нужен вход');
    const me = session.user;

    // --- pkg3-45: персональные приглашения (список, создание, отзыв) --------
    if (pathname === '/api/invites' && method === 'GET') {
      const now = Date.now();
      const mine = db.invites.filter(i => i.ownerId === me.id)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(i => ({
          id: i.id, createdAt: i.createdAt, expiresAt: i.expiresAt,
          state: inviteState(i, now), usedBy: i.usedBy || null,
          usedByName: i.usedBy ? (db.users.find(u => u.id === i.usedBy) || {}).name || null : null
        }));
      return J(200, { invites: mine, nextAt: inviteNextAt(me.id, now), blocked: inviteBlocked(me) });
    }
    if (pathname === '/api/invites' && method === 'POST') {
      const blocked = inviteBlocked(me);
      if (blocked) {
        return E(403, blocked === 'global' ? 'Приглашения сейчас выключены администратором для всех'
          : blocked === 'user' ? 'Вам запрещено создавать приглашения'
            : 'Участникам одной из ваших групп запрещено создавать приглашения');
      }
      const now = Date.now();
      // pkg3-54: приглашённый первые сутки не может приглашать сам
      if (NEW_INVITE_DELAY > 0 && me.invitedBy && me.invitedBy !== 'root' && me.invitedBy !== 'code'
        && now - (me.createdAt || 0) < NEW_INVITE_DELAY) {
        const mins = Math.max(1, Math.ceil((NEW_INVITE_DELAY - (now - (me.createdAt || 0))) / 60000));
        return E(403, 'Первые сутки после регистрации приглашать нельзя — осталось ' + mins + ' мин');
      }
      const nextAt = inviteNextAt(me.id, now);
      if (nextAt) {
        const mins = Math.max(1, Math.ceil((nextAt - now) / 60000));
        return E(429, 'Одна ссылка в сутки: следующая будет доступна через ' + mins + ' мин');
      }
      const b = req.body || {};
      if (!b.wrappedRoomKey || !b.invSalt || !b.secretHash) {
        return E(400, 'Не хватает конверта ключа или отпечатка секрета');
      }
      // секрет ссылки рождается на устройстве пригласившего и сюда не приходит:
      // сервер хранит только его хеш, а токен «id.секрет» клиент собирает сам
      const inv = {
        id: uid(), ownerId: me.id,
        secretHash: String(b.secretHash), invSalt: String(b.invSalt),
        wrappedRoomKey: String(b.wrappedRoomKey),
        createdAt: now, expiresAt: now + INVITE_TTL,
        usedBy: null, usedAt: null, revoked: false
      };
      db.invites.push(inv);
      if (db.invites.length > 2000) db.invites.splice(0, db.invites.length - 2000);
      save();
      return J(200, {
        invite: { id: inv.id, createdAt: inv.createdAt, expiresAt: inv.expiresAt },
        nextAt: inv.createdAt + INVITE_TTL
      });
    }
    const inviteRevoke = pathname.match(/^\/api\/invites\/([\w-]+)\/revoke$/);
    if (inviteRevoke && method === 'POST') {
      const inv = db.invites.find(i => i.id === inviteRevoke[1]);
      if (!inv) return E(404, 'Приглашение не найдено');
      if (inv.ownerId !== me.id && !me.isAdmin) return E(403, 'Это не ваше приглашение');
      if (!inv.revoked && !inv.usedBy) {
        inv.revoked = true;
        if (me.isAdmin && inv.ownerId !== me.id) adminLogAdd(me.id, 'отозвал чужое приглашение ' + inv.id);
        save();
      }
      return J(200, { ok: true });
    }

    // --- pkg3-48: поиск по нику по всему мессенджеру. Синхронизация больше не
    // отдаёт весь список людей (виден только свой круг), поэтому знакомство
    // начинается здесь: нашёл → написал → человек появился в личных чатах.
    if (pathname === '/api/search' && method === 'GET') {
      const q = String(query.get('q') || '').trim().toLowerCase();
      if (!q) return J(200, { users: [] });
      if (throttle('search:' + me.id, SEARCH_LIMIT)) return E(429, 'Слишком часто ищете: подождите немного');
      // pkg3-62: поглощённые учётки в поиске не показываются — человек ищется
      // одной (настоящей) учёткой, иначе в списке два одинаковых имени
      const hits = db.users
        .filter(u => u.id !== me.id && !u.displayAs && (u.nameLower || u.name.toLowerCase()).includes(q))
        .slice(0, 30)
        // pub — открытый ключ: без него найденному человеку нельзя написать
        // шифрованное сообщение (ECDH), а секретов он не раскрывает
        .map(u => ({ id: u.id, name: u.name, pub: u.pub || null, isAdmin: !!u.isAdmin, lastSeen: u.lastSeen || 0, activeAt: u.activeAt || 0 }));
      return J(200, { users: hits });
    }

    // --- pkg3-47: запрос «возьми меня в свои Приглашенные» между участниками
    // одной группы. Адресат решает; принятое запрос превращает в связь (bond),
    // и запрашивающий появляется у адресата в разделе «Приглашенные».
    if (pathname === '/api/bond-req' && method === 'POST') {
      const b = req.body || {};
      const to = db.users.find(u => u.id === String(b.to || ''));
      if (!to) return E(404, 'Участник не найден');
      if (to.displayAs) return E(400, 'Эта учётка слита с другой — выберите настоящую');   // pkg3-62
      if (to.id === me.id) return E(400, 'Нельзя запросить самого себя');
      const chat = db.chats.find(c => c.id === String(b.chat || '') && c.kind === 'group'
        && c.members.includes(me.id) && c.members.includes(to.id));
      if (!chat) return E(403, 'Запрос возможен только между участниками одной группы');
      if (db.bonds.some(x => x.owner === me.id && x.member === to.id)) {
        return E(409, 'Этот человек уже у вас в «Приглашенных»');
      }
      if (db.bondReqs.some(r => r.from === me.id && r.to === to.id && r.state === 'pending')) {
        return E(409, 'Запрос уже отправлен и ещё не решён');
      }
      const rq = { id: uid(), from: me.id, to: to.id, chat: chat.id, createdAt: Date.now(), state: 'pending' };
      db.bondReqs.push(rq);
      if (db.bondReqs.length > 1000) db.bondReqs.splice(0, db.bondReqs.length - 1000);
      save();
      return J(200, { ok: true, req: { id: rq.id, createdAt: rq.createdAt } });
    }
    const bondAct = pathname.match(/^\/api\/bond-req\/([\w-]+)\/(accept|decline)$/);
    if (bondAct && method === 'POST') {
      const rq = db.bondReqs.find(x => x.id === bondAct[1]);
      if (!rq) return E(404, 'Запрос не найден');
      if (rq.to !== me.id) return E(403, 'Решать может только адресат');
      if (rq.state !== 'pending') return E(409, 'Запрос уже решён');
      rq.state = bondAct[2] === 'accept' ? 'accepted' : 'declined';
      rq.decidedAt = Date.now();
      if (rq.state === 'accepted' && !db.bonds.some(b => b.owner === rq.from && b.member === rq.to)) {
        db.bonds.push({ owner: rq.from, member: rq.to, origin: 'request', at: Date.now() });
      }
      // pkg3-49: принятое согласие — это взаимные «Приглашенные»: люди видят
      // друг друга, а личный чат между ними живёт по общим правилам (кто первым
      // написал — у того «Личные чаты», у адресата — «Новые» на сутки)
      db.gen++;   // списки людей изменились — клиенты перечитают их сразу
      save();
      return J(200, { ok: true, state: rq.state });
    }

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
      // pkg3-49: сначала выясняем, какие чаты участнику вообще положены
      // (скрытые и истёкшие «Новые» не отдают ни своих сообщений, ни собеседников)
      const vis = myVisibleChats(me.id, rnow);
      const mch = vis.chats;
      const list = mch;
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

      return J(200, {
        messages: out,
        changed, gone: delta.gone, rnow, chg: db.chg || 0, resync: delta.resync,
        chats: mch.map(c => publicChat(c, me.id, vis.newUntil[c.id])),
        seq: seqOut, more, gen: db.gen,
        // сколько всего истории у участника — клиент рисует честные проценты загрузки
        loadN: mch.reduce((a, c) => a + (((db.stats.chats || {})[c.id] || {}).n || 0), 0),
        loadB: mch.reduce((a, c) => a + (((db.stats.chats || {})[c.id] || {}).b || 0), 0),
        games: openGames(me.id),
        myKnocks: myKnockedGames(me.id),   // pkg3-49: чужие заявки в мои партии
        invites: openInvites(me.id),
        // pkg3-47: кого я держу в «Приглашенных» (связи) и запросы, где я адресат/автор
        myBonds: db.bonds.filter(b => b.owner === me.id).map(b => b.member),
        // pkg3-53: мои разделы-папки. Чужих в ответе нет: это личная раскладка
        mySections: (Array.isArray(me.sections) ? me.sections : [])
          .map(x => ({ id: x.id, name: x.name, chats: (x.chats || []).slice() })),
        // pkg3-57: мои зашифрованные слепки флота «Морского боя» — для других
        // моих устройств. Сервер содержимое не читает, чужим не отдаёт
        mySbFleets: (me.sbFleets && typeof me.sbFleets === 'object' && !Array.isArray(me.sbFleets)) ? me.sbFleets : {},
        bondReqs: db.bondReqs.filter(r => r.to === me.id || r.from === me.id)
          .map(r => ({ id: r.id, from: r.from, to: r.to, chat: r.chat, createdAt: r.createdAt, state: r.state })),
        users: visibleUsers(me).map(publicUser),   // pkg3-48: видим только свой круг, остальных ищет /api/search
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
      // pkg3-62: поглощённая учётка — только старая история: в новый чат зовём настоящую
      for (const id of members) {
        const mu = db.users.find(u => u.id === id);
        if (mu && mu.displayAs) return E(400, 'Эта учётка слита с другой — пригласите настоящую');
      }
      if (!b.titleBlob || typeof b.titleBlob !== 'string' || b.titleBlob.length > 8192) return E(400, 'Нужно название чата');
      const keys = {};
      for (const id of members) {
        const k = (b.keys || {})[id];
        if (!k || !k.blob) return E(400, 'Нет ключа для участника ' + id);
        keys[id] = { by: me.id, blob: String(k.blob).slice(0, 4096), ep: 0 };   // pkg3-65: поколение копии
      }
      const chat = {
        id: uid(), kind: 'group', titleBlob: b.titleBlob, ownerId: me.id,
        members, keys, createdAt: Date.now()
      };
      db.chats.push(chat);
      // pkg3-54: каждый добавленный (кроме создателя) встречает группу в «Новых»
      for (const mid of members) {
        if (mid === me.id) continue;
        const mu = db.users.find(x => x.id === mid);
        if (!mu) continue;
        mu.newChats = mu.newChats || {};
        mu.newChats[chat.id] = { at: chat.createdAt, until: chat.createdAt + NEW_DM_TTL };
      }
      db.stats.chats[chat.id] = { n: 0, b: 0, t: chat.createdAt };
      db.seq++;
      save();
      return J(200, { chat: publicChat(chat, me.id) });
    }

    if (pathname === '/api/dm' && method === 'POST') {
      const b = req.body;
      // pkg3-62: обращение к поглощённой учётке уходит на настоящую — и если
      // личный чат с ней уже есть (он же «старый»), открывается ОН: для
      // собеседника это одна и та же учётка, а не две разные
      const asked = db.users.find(u => u.id === b.peer);
      if (!asked) return E(404, 'Участник не найден');
      // pkg3-62: обращение к поглощённой учётке — это обращение к тому же
      // человеку: если старая переписка ещё видна мне, «написать» открывает ЕЁ
      // (история на месте, новых писем не видно без неё), иначе — переписку
      // с настоящей учёткой. Второй ряд с тем же человеком не создаётся.
      let peer = asked;
      if (asked.displayAs) {
        const t = realOf(asked);
        if (t.id === me.id) return E(400, 'Нельзя писать самому себе');
        const old = chatById(dmId(me.id, asked.id));
        const now = Date.now();
        const rec = old ? (me.newChats || {})[old.id] : null;
        const visible = !!old && ((old.savedBy || []).includes(me.id) || (old.openedBy || []).includes(me.id)
          || (rec && rec.until >= now));
        if (!visible) peer = t;
      }
      if (peer.id === me.id) return E(400, 'Нельзя писать самому себе');
      const chat = ensureDm(me.id, peer.id);
      markDmOpened(chat, me.id);   // pkg3-49: автор видит чат сразу в «Личных чатах»
      return J(200, { chat: publicChat(chat, me.id) });
    }

    // --------------------------------------- pkg3-53: свои разделы (папки) чатов
    // Разделы личные: хранят КОПИИ ссылок на чаты (сам чат остаётся и в системном
    // разделе), видны только своему владельцу и не влияют на чужие списки.
    if (pathname === '/api/sections' || pathname.startsWith('/api/sections/')) {
      const parts = pathname.split('/');                  // '', api, sections, :id?, действие?
      const sid = parts[3] ? decodeURIComponent(parts[3]) : '';
      const act = parts[4] || '';
      if (!Array.isArray(me.sections)) me.sections = [];
      const cleanName = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();

      if (method === 'GET') return J(200, { sections: me.sections });

      if (!sid && method === 'POST') {
        if (throttle('section:' + me.id)) return E(429, 'Слишком часто: подождите немного');
        const name = cleanName((req.body || {}).name);
        if (name.length < 1 || name.length > 32) return E(400, 'Название раздела: от 1 до 32 символов');
        if (me.sections.length >= MAX_SECTIONS) return E(400, 'Разделов достаточно (' + MAX_SECTIONS + ') — удалите лишний');
        if (me.sections.some(x => (x.name || '').toLowerCase() === name.toLowerCase())) return E(409, 'Раздел с таким названием уже есть');
        me.sections.push({ id: uid(), name, createdAt: Date.now(), chats: [] });
        save();
        return J(200, { ok: true, sections: me.sections });
      }

      const sec = me.sections.find(x => x.id === sid);
      if (!sec) return E(404, 'Раздел не найден');

      // Переименование и удаление — через POST: тело запроса сервер читает только
      // у POST/PUT (server.js:67), поэтому PATCH/DELETE пришли бы пустыми.
      if (act === 'rename' && method === 'POST') {
        const name = cleanName((req.body || {}).name);
        if (name.length < 1 || name.length > 32) return E(400, 'Название раздела: от 1 до 32 символов');
        if (me.sections.some(x => x.id !== sid && (x.name || '').toLowerCase() === name.toLowerCase())) {
          return E(409, 'Раздел с таким названием уже есть');
        }
        sec.name = name;
        save();
        return J(200, { ok: true, sections: me.sections });
      }
      if (act === 'delete' && method === 'POST') {
        // удаляется ТОЛЬКО папка: чаты остаются в своих системных разделах
        me.sections = me.sections.filter(x => x.id !== sid);
        save();
        return J(200, { ok: true, sections: me.sections });
      }
      // pkg3-54: перестановка своих разделов местами (кнопки «выше»/«ниже» в меню раздела)
      if (act === 'move' && method === 'POST') {
        const dirRaw = String((req.body || {}).dir || '');
        const dir = dirRaw === 'up' ? -1 : dirRaw === 'down' ? 1 : 0;
        if (!dir) return E(400, 'Направление: up или down');
        const i = me.sections.findIndex(x => x.id === sid);
        const j = i + dir;
        if (i < 0) return E(404, 'Раздел не найден');
        if (j < 0 || j >= me.sections.length) return E(400, 'Крайний раздел дальше не двигается');
        const tmp = me.sections[i];
        me.sections[i] = me.sections[j];
        me.sections[j] = tmp;
        save();
        return J(200, { ok: true, sections: me.sections });
      }
      return E(404, 'Нет такой команды для разделов');
    }

    if (pathname.startsWith('/api/chats/')) {
      const parts = pathname.split('/'); // '', api, chats, :id, action?
      const chat = chatById(decodeURIComponent(parts[3] || ''));
      const action = parts[4];
      if (!chat) return E(404, 'Чат не найден');
      if (!isMember(chat, me.id)) return E(403, 'Вы не участник этого чата');
      const isOwner = chat.kind === 'group' && chat.ownerId === me.id;

      // --- pkg3-48/49: убрать чат из своих списков (у собеседника всё остаётся).
      // Для личного чата это «убрать из личных чатов»: отметка «сохранён» снимается,
      // и чат возвращается в раздел «Новые» — живёт сутки, новое письмо собеседника
      // возвращает его обратно ещё на сутки.
      if (action === 'hide' && method === 'POST') {
        const on = !!(req.body || {}).hidden;
        me.hiddenChats = me.hiddenChats || [];
        if (on && !me.hiddenChats.includes(chat.id)) me.hiddenChats.push(chat.id);
        if (!on) me.hiddenChats = me.hiddenChats.filter(x => x !== chat.id);
        if (on && chat.kind === 'dm') {
          chat.savedBy = (chat.savedBy || []).filter(x => x !== me.id);
        }
        db.gen++;   // собеседник должен сразу увидеть смену статуса «в личных чатах»
        save();
        return J(200, { ok: true, hiddenChats: me.hiddenChats, chat: publicChat(chat, me.id) });
      }

      // --- pkg3-49/50: «Добавить пользователя в мои личные чаты» — чат из раздела «Новые»
      // сохраняется безвременно, собеседник видит отметку «вы в его личных чатах».
      if (action === 'save' && method === 'POST') {
        // pkg3-54: сохранять можно и групповой чат — это «я принял его, оставьте у меня»
        if (chat.kind !== 'dm' && chat.kind !== 'group') {
          return E(400, 'Сохранять можно только личную переписку и групповые чаты');
        }
        if (me.hiddenChats) me.hiddenChats = me.hiddenChats.filter(x => x !== chat.id);
        if (me.declined) me.declined = me.declined.filter(x => x !== chat.id);
        chat.savedBy = Array.from(new Set([...(chat.savedBy || []), me.id]));
        if (me.newChats) delete me.newChats[chat.id];
        // pkg3-54: в групповом чате появляется служебная строка «N добавил этот чат».
        // Содержимого в ней нет — шифровать нечего: это открытое для участников событие.
        if (chat.kind === 'group') {
          const svc = {
            id: uid(), seq: await store.reserveSeq(), uid: me.id, ts: Date.now(),
            chat: chat.id, parent: null, quote: null, upId: null, svc: 'saved', bytes: 0
          };
          db.messages.push(svc);
          addStat(svc, 1);
          db.seq++;
        }
        db.gen++;   // оба списка чатов изменились — клиенты перечитают их сразу
        save();
        return J(200, { ok: true, chat: publicChat(chat, me.id) });
      }

      // --- pkg3-54/60: «Отклонить» — чат из «Новых» удаляется у меня.
      // pkg3-60 (решение владельца): новое письмо собеседника возвращает его
      // обратно в «Новые» с новым отсчётом — «призраков» (оповещения есть,
      // чата нет) больше не бывает. Своё письмо возвращает чат сразу.
      if (action === 'decline' && method === 'POST') {
        me.declined = Array.isArray(me.declined) ? me.declined : [];
        if (!me.declined.includes(chat.id)) me.declined.push(chat.id);
        me.hiddenChats = Array.isArray(me.hiddenChats) ? me.hiddenChats : [];
        if (!me.hiddenChats.includes(chat.id)) me.hiddenChats.push(chat.id);
        if (me.newChats) delete me.newChats[chat.id];
        if (chat.kind === 'dm') chat.savedBy = (chat.savedBy || []).filter(x => x !== me.id);
        db.gen++;
        save();
        return J(200, { ok: true, declined: me.declined, chat: publicChat(chat, me.id) });
      }

      // --- pkg3-53: копия чата в свой раздел (папку); section=null — убрать из всех папок.
      // Чат остаётся в системном разделе: разделы дублируют, а не перемещают.
      if (action === 'section' && method === 'POST') {
        const b = req.body || {};
        if (!Array.isArray(me.sections)) me.sections = [];
        const raw = b.section;
        const target = (raw === null || raw === undefined || raw === '') ? null : String(raw);
        if (target) {
          const sec = me.sections.find(x => x.id === target);
          if (!sec) return E(404, 'Раздел не найден');
          if (!Array.isArray(sec.chats)) sec.chats = [];
          if (!sec.chats.includes(chat.id)) {
            if (sec.chats.length >= MAX_SECTION_CHATS) {
              return E(400, 'В разделе уже ' + MAX_SECTION_CHATS + ' чатов — больше не поместится');
            }
            sec.chats.push(chat.id);
          }
        } else {
          for (const x of me.sections) x.chats = (x.chats || []).filter(id => id !== chat.id);
        }
        save();
        return J(200, { ok: true, sections: me.sections });
      }

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
          // pkg3-61: «нуждающимися» считаются и те, у кого копия ключа есть,
          // но она не читается (пометка need) — иначе такой участник застревал
          // навсегда: ключ формально есть, а расшифровать не может
          // pkg3-65: нуждающийся — ещё и тот, чья копия прошлого поколения
          // (ep не совпадает): после перевыпуска устаревшие копии сводятся к текущей
          const curEp = chat.keyEpoch || 0;
          const missing = chat.members
            .filter(id => {
              const e = (chat.keys || {})[id];
              return !e || e.need || (typeof e.ep === 'number' && e.ep !== curEp);
            })
            .map(id => ({ id, hasPub: !!(db.users.find(u => u.id === id) || {}).pub }));
          return J(200, { missing });
        }
        if (sub === 'need' && method === 'POST') {
          // pkg3-61: участник сообщает «моя копия ключа не читается» —
          // остальные участники с рабочей копией доставят новую (repairGroupKeys)
          if (!chat.keys) chat.keys = {};
          const e = chat.keys[me.id];
          if (!e) chat.keys[me.id] = { by: null, blob: '', need: true };
          else if (!e.need) e.need = true;
          else return J(200, { ok: true, already: true });
          db.seq++;   // пусть остальные участники скорее увидят просьбу
          save();
          return J(200, { ok: true });
        }
        if (sub === '' && method === 'POST') {
          const b = req.body || {};
          const target = String(b.userId || '');
          if (!chat.members.includes(target)) return E(400, 'Адресат не участник этого чата');
          if (!b.blob || typeof b.blob !== 'string' || b.blob.length > 4096) return E(400, 'Нет ключа для участника');
          if (!chat.keys) chat.keys = {};
          // pkg3-65: доставка ключа помечается поколением (ep). После перевыпуска
          // ключа группы доставка старого ключа запрещена — иначе копии снова
          // «разъезжаются» и переписка становится нечитаемой у половины участников.
          // Клиенты прежних выпусков ep не присылают: им разрешена доставка только
          // в группы без перевыпусков (поколение 0).
          const curEp = chat.keyEpoch || 0;
          if (typeof b.ep !== 'undefined' && b.ep !== curEp)
            return E(409, 'Ключ устарел: группа перевыпустила ключ. Обновите приложение и повторите');
          if (curEp > 0 && typeof b.ep !== 'number')
            return E(409, 'Ключ устарел: группа перевыпустила ключ. Обновите приложение и повторите');
          // pkg3-61: битую копию (пометка need) разрешается перезаписать;
          // pkg3-65: копию прошлого поколения — тоже
          const ex = chat.keys[target];
          if (ex && !ex.need && ex.ep === curEp) return E(409, 'У участника уже есть ключ этого чата');
          chat.keys[target] = { by: me.id, blob: b.blob, ep: curEp };
          db.seq++; save();
          return J(200, { ok: true, chat: publicChat(chat, me.id) });
        }
        if (sub === 'old' && method === 'POST') {
          // pkg3-66: участник выкладывает свёртки ПРЕЖНИХ ключей, которые у
          // него сохранились, — чтобы история вернулась тем, кто пропустил
          // поколения (был с закрытым чатом во время перевыпуска или ещё не
          // был добавлен). Сервер ключ не разворачивает и не видит: хранит
          // свёртки для каждого участника, как и текущие копии.
          // pkg3-70: адрес слота — отпечаток самого ключа (fp, hex sha256),
          // а не метка поколения: метки устройства назначают по-своему и
          // collide; прежние клиенты могут слать ep — примем и их (слот «eN»)
          const b = req.body || {};
          const list = Array.isArray(b.oldKeys) ? b.oldKeys : null;
          if (!list) return E(400, 'Нет прежних ключей');
          if (list.length > 32) return E(400, 'Слишком много прежних ключей');
          if (!chat.oldKeys || typeof chat.oldKeys !== 'object' || Array.isArray(chat.oldKeys)) chat.oldKeys = {};
          const capEp = (chat.keyEpoch || 0) + 24;
          let added = 0;
          for (const it of list) {
            const fp = String((it && it.fp) || '');
            const legacy = (it && typeof it.ep === 'number') ? it.ep : NaN;
            let slotId = '';
            if (/^[0-9a-f]{16,64}$/.test(fp)) slotId = fp;
            else if (Number.isFinite(legacy) && legacy >= 0 && legacy < capEp) slotId = 'e' + legacy;
            if (!slotId) continue;
            const wraps = (it && it.wraps && typeof it.wraps === 'object') ? it.wraps : null;
            if (!wraps) continue;
            const slot = chat.oldKeys[slotId] || (chat.oldKeys[slotId] = { by: me.id, wraps: {} });
            for (const uid of chat.members) {
              const blob = wraps[uid];
              if (typeof blob !== 'string' || !blob || blob.length > 4096) continue;
              if (slot.wraps[uid]) continue;   // прежнюю свёртку не перезаписываем
              slot.wraps[uid] = blob; added++;
            }
          }
          // защитный предел числа слотов: самые старые уходят
          const ids = Object.keys(chat.oldKeys);
          if (ids.length > 40) {
            for (const drop of ids.slice(0, ids.length - 40)) delete chat.oldKeys[drop];
          }
          db.seq++; save();
          return J(200, { ok: true, added });
        }
        if (sub === 'rotate' && method === 'POST') {
          // pkg3-63: перевыпуск ключа группы — участник принёс новые свёртки
          // нового ключа ДЛЯ ВСЕХ текущих участников (сервер ключ не видит и
          // не разворачивает). Все копии заменяются, поколение растёт —
          // клиенты понимают, что их копию пора пере-развернуть с сервера.
          // pkg3-73: перевыпуск ключа решает создатель чата или администратор
          if (!isOwner && !me.isAdmin) return E(403, 'Перевыпустить ключ группы может только создатель чата или администратор');
          const b = req.body || {};
          const wraps = (b.keys && typeof b.keys === 'object') ? b.keys : null;
          if (!wraps) return E(400, 'Нет новых копий ключа');
          // pkg3-67: предохранитель от «часто жал кнопку» — перевыпуск не чаще
          // раза в час на группу (ROTATE_COOLDOWN_MS=0 выключает, для тестов).
          // Частые переключения поколений — главный источник закрытых писем
          const rotMs = Number(process.env.ROTATE_COOLDOWN_MS !== undefined ? process.env.ROTATE_COOLDOWN_MS : 3600000);
          if (rotMs > 0 && typeof chat.lastRotateAt === 'number' && Date.now() - chat.lastRotateAt < rotMs)
            return E(429, 'Ключ этой группы уже перевыпускали недавно. Следующий перевыпуск будет доступен через час: частые переключения и закрывают письма');
          for (const mid of chat.members) {
            const w = wraps[mid];
            if (!w || typeof w.blob !== 'string' || !w.blob || w.blob.length > 4096)
              return E(400, 'Нет копии ключа для участника ' + mid);
          }
          const nextEp = (chat.keyEpoch || 0) + 1;
          const next = {};
          // pkg3-65: новые копии помечаются новым поколением — доставка
          // устаревшим ключом после этого невозможна
          for (const mid of chat.members) next[mid] = { by: me.id, blob: String(wraps[mid].blob).slice(0, 4096), ep: nextEp };
          chat.keys = next;
          chat.keyEpoch = nextEp;
          chat.lastRotateAt = Date.now();   // pkg3-67: часовой предохранитель
          // pkg3-67: служебная строка в ленту: все участники видят, кто и когда
          // перевыпустил ключ (событие открытое, шифровать нечего)
          const svcRot = {
            id: uid(), seq: await store.reserveSeq(), uid: me.id, ts: Date.now(),
            chat: chat.id, parent: null, quote: null, upId: null, svc: 'rotatekeys', bytes: 0
          };
          db.messages.push(svcRot);
          addStat(svcRot, 1);
          db.seq++; save();
          return J(200, { ok: true, keyEpoch: chat.keyEpoch, chat: publicChat(chat, me.id) });
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
          chat.keys[u.id] = { by: me.id, blob: String(a.blob).slice(0, 4096), ep: chat.keyEpoch || 0 };   // pkg3-65
          // pkg3-54: нового участника готовой группы тоже встречаем «Новыми»
          if (!(chat.savedBy || []).includes(u.id)) {
            u.newChats = u.newChats || {};
            u.newChats[chat.id] = { at: Date.now(), until: Date.now() + NEW_DM_TTL };
          }
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
        // Для группового чата — только создатель или администратор мессенджера
        // (pkg3-73), для личной переписки — любой из двоих.
        if (chat.kind === 'group' && !isOwner && !me.isAdmin) return E(403, 'Очистить групповой чат может только создатель чата или администратор');
        await store.loadChats([chat.id]);
        const msgs = db.messages.filter(m => m.chat === chat.id);
        const count = msgs.length;
        dropChat(chat.id);                 // освобождает место и счётчики
        // pkg3-74: вложения очищенного чата стираем с сервера тоже
        for (const um of await store.listUpMeta()) {
          if (um.chat !== chat.id || um.gone) continue;
          if (db.messages.some(m => m.upId === um.id)) continue;
          await store.delUp(um.id);
          db.upBytes = Math.max(0, (db.upBytes || 0) - (um.stored || um.size || 0));
        }
        storageCache.clear();
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
      // pkg3-48/49: новое письмо возвращает спрятанный личный чат в списки
      // адресата (снятием скрытия); автор письма всегда остаётся «открывшим»
      // чат и держит его у себя в «Личных чатах» — даже если раньше убрал
      if (chat.kind === 'dm') {
        markDmOpened(chat, me.id);
        chat.savedBy = Array.from(new Set([...(chat.savedBy || []), me.id]));
      }
      for (const mem of chat.members) {
        if (mem === me.id) continue;
        const u = db.users.find(x => x.id === mem);
        if (!u) continue;
        const wasDeclined = Array.isArray(u.declined) && u.declined.includes(chat.id);
        // pkg3-54: отклонённый ГРУППОВОЙ чат не возвращается сам (участников
        // много, письма частые — иначе отклонение ничего бы не значило)
        if (wasDeclined && chat.kind !== 'dm') continue;
        // pkg3-60: новое письмо собеседника возвращает отклонённый или убранный
        // ЛИЧНЫЙ чат — снова в «Новые» с новым отсчётом. Прежнее поведение
        // (отклонённый не возвращается; убранный возвращается только если ему
        // никогда не отвечали) рождало «призраков»: оповещения о письмах
        // приходят, а чата нет ни в одном разделе. Решение владельца.
        if (wasDeclined) u.declined = u.declined.filter(x => x !== chat.id);
        if (Array.isArray(u.hiddenChats) && u.hiddenChats.includes(chat.id)) {
          u.hiddenChats = u.hiddenChats.filter(x => x !== chat.id);
        }
        // адресат ещё не решил (никогда не писал в чат и не сохранял его) —
        // свежий отсчёт «Новых» с каждого его нового письма
        if (chat.kind === 'dm' && !(chat.savedBy || []).includes(mem)) {
          u.newChats = u.newChats || {};
          u.newChats[chat.id] = { at: Date.now(), until: Date.now() + NEW_DM_TTL };
        }
      }
      // pkg3-54: сам написал в отклонённый чат — вернул его себе (восстановление поиском)
      if (Array.isArray(me.declined) && me.declined.includes(chat.id)) {
        me.declined = me.declined.filter(x => x !== chat.id);
        if (Array.isArray(me.hiddenChats)) me.hiddenChats = me.hiddenChats.filter(x => x !== chat.id);
      }
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

    // --- чаты-игры: шахматы и шашки как чат (правила живут в клиентах, сервер слеп)
    if (pathname === '/api/games' && method === 'POST') {
      const b = req.body || {};
      const opp = db.users.find(u => u.id === String(b.opponent || ''));
      if (!opp) return E(404, 'Соперник не найден');
      if (opp.displayAs) return E(400, 'Эта учётка слита с другой — пригласите настоящую');   // pkg3-62
      if (opp.id === me.id) return E(400, 'Пригласите кого-то ещё, не себя');
      const color = String(b.color || 'random');
      if (!['white', 'black', 'random', 'choice'].includes(color)) return E(400, 'Цвет: white, black, random или choice');
      // pkg3-41: сервер правила не понимает, только записывает; без метки — шахматы
      // (старые клиенты создают игры как раньше и ничего не замечают)
      const rules = b.rules === undefined ? 'chess' : String(b.rules);
      if (!['chess', 'checkers', 'seabattle'].includes(rules)) return E(400, 'Игра: chess, checkers или seabattle');
      // pkg3-54: не больше четырёх одновременных партий, где я игрок
      if (liveGamesOf(me.id) >= MAX_LIVE_GAMES) {
        return E(400, 'У вас уже ' + MAX_LIVE_GAMES + ' одновременные партии — завершите одну, чтобы начать новую');
      }
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
        game: { rules, status: 'invite', invitee: opp.id, colorChoice: color, white, black, result: null }
      };
      db.chats.push(chat);
      db.stats.chats[chat.id] = { n: 0, b: 0, t: chat.createdAt };
      // pkg3-49: приглашение в игру приходит в личный чат — чтобы адресат его
      // не потерял, чат создаётся сразу и сохраняется у обоих (не «Новые»)
      const gdm = ensureDm(me.id, opp.id);
      gdm.savedBy = Array.from(new Set([...(gdm.savedBy || []), me.id, opp.id]));
      gdm.openedBy = Array.from(new Set([...(gdm.openedBy || []), me.id, opp.id]));
      db.seq++; save();
      return J(200, { chat: publicChat(chat, me.id) });
    }

    if (pathname.startsWith('/api/games/') && pathname.endsWith('/accept') && method === 'POST') {
      const chat = chatById(pathname.split('/')[3]);
      if (!chat || chat.kind !== 'game') return E(404, 'Игра не найдена');
      if (chat.game.status !== 'invite' || chat.game.invitee !== me.id) {
        return E(403, 'Приглашение адресовано не вам или уже обработано');
      }
      // pkg3-54: принять пятую одновременную партию нельзя
      if (liveGamesOf(me.id) >= MAX_LIVE_GAMES) {
        return E(400, 'У вас уже ' + MAX_LIVE_GAMES + ' одновременные партии — примите новую, когда завершите одну');
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
      // pkg3-57: вышел из партии — слепок флота «Морского боя» больше не нужен
      if (me.sbFleets && me.sbFleets[chat.id]) delete me.sbFleets[chat.id];
      db.seq++; save();
      return J(200, { ok: true, resigned, wiped });
    }

    // pkg3-57: «Морской бой» — личный зашифрованный слепок флота. Устройство,
    // где флот расставили, кладёт сюда непрозрачный blob (шифр на личном ключе
    // владельца), а другие устройства владельца забирают его в синхронизации
    // (mySbFleets) и могут показывать свои корабли и отвечать на выстрелы.
    // Сервер содержимое не читает и чужим не отдаёт; blob:null — стереть.
    if (pathname.startsWith('/api/games/') && pathname.endsWith('/sbfleet') && method === 'POST') {
      const chat = chatById(pathname.split('/')[3]);
      if (!chat || chat.kind !== 'game' || ((chat.game || {}).rules) !== 'seabattle') return E(404, 'Игра не найдена');
      if ((chat.roles || {})[me.id] !== 'player') return E(403, 'Это не ваша партия');
      if (throttle('sbfleet:' + me.id, 60)) return E(429, 'Слишком часто: подождите немного');
      const b = req.body || {};
      if (!me.sbFleets || typeof me.sbFleets !== 'object' || Array.isArray(me.sbFleets)) me.sbFleets = {};
      if (b.blob === null || b.blob === undefined || b.blob === '') {
        delete me.sbFleets[chat.id];
      } else {
        const blob = String(b.blob);
        if (!blob || blob.length > 8192) return E(400, 'Слепок флота слишком большой');
        me.sbFleets[chat.id] = blob;
      }
      save();
      return J(200, { ok: true });
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
    if (pathname === '/api/profile' && method === 'GET') {
      // pkg3-64: своя почта и наличие копии восстановления (в publicUser этого нет)
      return J(200, {
        email: me.email || '', emailConfirmed: !!me.emailConfirmed,
        hasRecoveryBlob: !!me.recoveryBlob
      });
    }
    if (pathname === '/api/profile' && method === 'POST') {
      const b = req.body;
      if (b.name !== undefined) {
        const name = normName(b.name);
        if (name.length < 2 || name.length > 32) return E(400, 'Имя: от 2 до 32 символов');
        if (db.users.some(x => x.nameLower === name.toLowerCase() && x.id !== me.id)) return E(409, 'Такое имя уже занято');
        // pkg3-62: занято и то имя, которое носит слитая учётка
        if (db.users.some(x => x.displayAs && x.id !== me.id
          && ((db.users.find(y => y.id === x.displayAs) || {}).nameLower === name.toLowerCase())))
          return E(409, 'Такое имя уже занято');
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
      // ── pkg3-64: привязка почты (необязательно, один раз) для восстановления ──
      if (b.email !== undefined) {
        const em = String(b.email || '').trim().toLowerCase();
        if (!em) {
          me.email = ''; me.emailConfirmed = false; me.emailPending = null;
          me.emailCodeHash = null; me.emailCodeExp = 0; me.recoveryBlob = null;
        } else {
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em) || em.length > 120) return E(400, 'Непохоже на адрес почты');
          if (db.users.some(x => x.id !== me.id && x.email === em && x.emailConfirmed))
            return E(409, 'Эта почта уже привязана к другой учётке');
          if (!smtp.enabled()) return E(503, 'Почта на сервере не настроена: привязка и восстановление недоступны (нужны SEGA_SMTP_* в .env)');
          if (throttle('email:' + me.id, 10)) return E(429, 'Слишком часто: подождите немного');
          const code = String(crypto.randomInt(100000, 999999));
          me.emailPending = em;
          me.emailCodeHash = crypto.createHash('sha256').update(code + me.id).digest('hex');
          me.emailCodeExp = Date.now() + 15 * 60 * 1000;
          try {
            await smtp.sendMail(em, 'SEGA-CHAT: привязка почты',
              'Код подтверждения: ' + code + '\n\nДействует 15 минут. Введите его в окне мессенджера.\n'
              + 'Если вы не привязывали почту — просто проигнорируйте письмо.\n\nВаш мессенджер: ' + publicBase(req));
          } catch (e) { return E(502, 'Не удалось отправить письмо: ' + (e.message || 'почтовый сервер недоступен')); }
        }
      }
      if (b.emailCode !== undefined) {
        const code = String(b.emailCode || '').trim();
        if (!me.emailPending || !me.emailCodeHash) return E(400, 'Сначала запросите привязку почты');
        if ((me.emailCodeExp || 0) < Date.now()) return E(400, 'Код просрочен: запросьте привязку ещё раз');
        if (!timingEqual(crypto.createHash('sha256').update(code + me.id).digest('hex'), me.emailCodeHash))
          return E(403, 'Неверный код');
        me.email = me.emailPending; me.emailConfirmed = true;
        me.emailPending = null; me.emailCodeHash = null; me.emailCodeExp = 0;
      }
      if (b.recoveryBlob !== undefined) {
        if (b.recoveryBlob === null || b.recoveryBlob === '') me.recoveryBlob = null;
        else {
          if (String(b.recoveryBlob).length > 16384) return E(400, 'Копия восстановления слишком велика');
          me.recoveryBlob = String(b.recoveryBlob);
        }
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

      // ── pkg3-45: дерево приглашений, политика блокировок, аварийное окно ──
      if (pathname === '/api/admin/invites' && method === 'GET') {
        const now = Date.now();
        return J(200, {
          users: db.users.map(u => ({
            id: u.id, name: u.name, isAdmin: !!u.isAdmin,
            invitedBy: u.invitedBy || 'root', createdAt: u.createdAt || 0,
            bannedUntil: u.bannedUntil || 0,   // pkg3-59: отметка действующего бана
            displayAs: u.displayAs || null     // pkg3-61: чью внешность носит учётка
          })),
          invites: db.invites.map(i => ({
            id: i.id, ownerId: i.ownerId, state: inviteState(i, now),
            createdAt: i.createdAt, expiresAt: i.expiresAt,
            usedBy: i.usedBy || null, revoked: !!i.revoked
          })),
          // pkg3-48: политика всегда объектом — в старых облачных базах она
          // могла лежать пустой (null), и клиентское окно не открывалось
          policy: db.invitePolicy || { globalOff: false, blockedUsers: [], blockedChats: [] },
          bonds: db.bonds.map(b => Object.assign({}, b)),
          bondReqs: db.bondReqs.map(r => Object.assign({}, r)),
          emergencyRegUntil: db.emergencyRegUntil,
          log: db.adminLog.slice(-60)
        });
      }
      if (pathname === '/api/admin/invite-policy' && method === 'POST') {
        const b = req.body || {};
        db.invitePolicy = {
          globalOff: !!b.globalOff,
          blockedUsers: Array.isArray(b.blockedUsers)
            ? b.blockedUsers.filter(x => db.users.some(u => u.id === x)) : [],
          blockedChats: Array.isArray(b.blockedChats)
            ? b.blockedChats.filter(x => db.chats.some(c => c.id === x)) : []
        };
        adminLogAdd(me.id, 'изменил политику приглашений'
          + (db.invitePolicy.globalOff ? ' (выключены для всех)' : ''));
        save();
        return J(200, { ok: true, policy: db.invitePolicy });
      }
      if (pathname === '/api/admin/emergency-reg' && method === 'POST') {
        const open = !!(req.body || {}).open;
        db.emergencyRegUntil = open ? Date.now() + 3600 * 1000 : 0;
        adminLogAdd(me.id, open ? 'открыл аварийную регистрацию по кодовой фразе на 1 час'
          : 'закрыл аварийную регистрацию по кодовой фразе');
        save();
        return J(200, { ok: true, emergencyRegUntil: db.emergencyRegUntil });
      }

      if (pathname.startsWith('/api/admin/users/')) {
        const parts = pathname.split('/'); // '', api, admin, users, :id, action?
        const id = parts[4], action = parts[5];
        const u = db.users.find(x => x.id === id);
        if (!u) return E(404, 'Участник не найден');
        if (method === 'DELETE') {
          if (u.id === me.id) return E(400, 'Нельзя удалить самого себя');
          // pkg3-59: стираем ВСЁ, что принадлежало участнику: связи «Приглашенные»,
          // запросы-согласия и его живые ссылки-приглашения (дерево помнит его
          // как родителя приглашённых — имя в дереве заменяется на «?»)
          db.bonds = db.bonds.filter(b => b.owner !== id && b.member !== id);
          db.bondReqs = db.bondReqs.filter(r => r.from !== id && r.to !== id);
          db.invites = db.invites.filter(i => i.ownerId !== id);
          adminLogAdd(me.id, 'удалил участника «' + u.name + '» навсегда');
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
        // pkg3-59: бан на сутки по жалобе (on:false — снять досрочно)
        if (method === 'POST' && action === 'ban') {
          if (u.id === me.id) return E(400, 'Нельзя ограничить самого себя');
          const on = !!((req.body || {}).on);
          if (on) {
            u.bannedUntil = Date.now() + BAN_MS;
            adminLogAdd(me.id, 'ограничил доступ «' + u.name + '» на сутки (жалоба)');
          } else {
            u.bannedUntil = 0;
            adminLogAdd(me.id, 'снял ограничение доступа с «' + u.name + '»');
          }
          save();
          return J(200, { ok: true, bannedUntil: u.bannedUntil || 0 });
        }
        // pkg3-61: «поглощение» учётки — привязать внешность (имя и аватар)
        // другой учётки. Нужно, когда человек потерял пароль и зарегистрировался
        // заново: старая переписка становится «новой учёткой» на вид. Ключи и
        // авторство не подменяются; as:null — вернуть собственное лицо.
        if (method === 'POST' && action === 'display') {
          const as = (req.body || {}).as;
          if (as === null || as === undefined || as === '') {
            if (u.displayAs) adminLogAdd(me.id, 'вернул учётке «' + u.name + '» собственное лицо');
            u.displayAs = null;
            save();
            return J(200, { ok: true, user: publicUser(u) });
          }
          const t = db.users.find(x => x.id === String(as));
          if (!t) return E(404, 'Учётка-внешность не найдена');
          if (t.id === u.id) return E(400, 'Нельзя поглотить самого себя');
          if (t.displayAs) return E(400, 'Эта учётка сама носит чужую внешность — выберите настоящую');
          // pkg3-62: единственность видимых имён гарантируют правила регистрации
          // и переименования (имя слитой учётки занято), поэтому две учётки
          // с одинаковым именем здесь появиться не могут — слияние безопасно
          u.displayAs = t.id;
          adminLogAdd(me.id, 'привязал внешность «' + t.name + '» к учётке «' + u.name + '» (поглощение)');
          save();
          return J(200, { ok: true, user: publicUser(u) });
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
      // pkg3-76: предел тот же (25 МБ), но отвечаем спокойно, без ругани
      if (size > UP_MAX) return E(413, 'Файл больше облачного предела: 25 МБ на один файл');
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
      if (meta.gone) return E(410, 'Вложение удалено с сервера');   // pkg3-74
      if (!isMember(chatById(meta.chat), me.id)) return E(403, 'Это не ваш чат');
      const d = await store.getUpPart(meta.chat, upId, i);
      if (d == null) return E(404, 'Кусок не найден');
      return J(200, { data: d, parts: meta.parts, name: meta.name, mime: meta.mime, size: meta.size });
    }

    // ────────────────────────────────────────────────────────────────────
    // pkg3-74: ПУЛЬТ ПАМЯТИ СЕРВЕРА. Сервер слеп к содержимому, но метаданные
    // загрузок (владелец, чат, mime, байты) не секретны — на них и считаем.
    // ────────────────────────────────────────────────────────────────────
    if (pathname === '/api/storage/summary' && method === 'GET') {
      const scope = query.get('scope') === 'all' ? 'all' : 'me';
      const fresh = query.get('fresh') === '1';
      return J(200, await storageSummary(scope, me.id, fresh, me.isAdmin === true));
    }
    if (pathname === '/api/storage/items' && method === 'GET') {
      const scope = query.get('scope') === 'all' ? 'all' : 'me';
      const kind = ['photos', 'media', 'files'].includes(query.get('kind')) ? query.get('kind') : 'photos';
      const cursor = Math.max(0, Number(query.get('cursor')) || 0);
      if (scope === 'all' && !me.isAdmin) return E(403, 'Список всех загрузок видит только администратор');
      const ups = (await store.listUpMeta())
        .filter(u => u && !u.gone && KIND_OF(u.mime) === kind && (scope === 'all' || u.owner === me.id))
        .sort((a, b) => (a.ts || 0) - (b.ts || 0));
      const numbered = ups.map((u, i) => Object.assign({ num: i + 1 }, u)).reverse();   // свежие сверху
      const page = numbered.slice(cursor, cursor + 50);
      const chatNo = {};
      db.chats.forEach((c, i) => { chatNo[c.id] = { n: i + 1, kind: c.kind }; });
      const items = page.map(u => {
        const mine = u.owner === me.id;
        const cn = chatNo[u.chat] || { n: 0, kind: 'group' };
        return {
          upId: u.id, chat: u.chat, bytes: Math.ceil((u.stored || u.size || 0) * UP_B64),
          ts: u.ts || 0, mime: u.mime || '', kind,
          name: (scope === 'me' || mine) ? (u.name || 'file') : (KIND_LABEL[kind] + ' №' + u.num),
          chatLabel: (scope === 'me' || mine) ? null : (cn.kind === 'dm' ? 'Личный чат №' + cn.n : 'Групповой чат №' + cn.n),
          mine
        };
      });
      return J(200, { items, next: cursor + page.length < numbered.length ? cursor + 50 : null });
    }
    if (pathname === '/api/storage/chats' && method === 'GET') {
      const scope = query.get('scope') === 'all' ? 'all' : 'me';
      if (scope === 'all' && !me.isAdmin) return E(403, 'Сводку по всем чатам видит только администратор');
      const ups = (await store.listUpMeta()).filter(u => u && !u.gone);
      const rows = [];
      db.chats.forEach((c, i) => {
        if (scope === 'me' && !isMember(c, me.id)) return;
        let msgBytes = 0, msgCount = 0;
        for (const m of db.messages) {
          if (m.chat !== c.id || m.svc) continue;
          if (scope === 'me' && m.uid !== me.id) continue;
          msgBytes += (m.bytes || 0) + MSG_ROW_OVERHEAD; msgCount += 1;
        }
        const upBytes = ups.filter(u => u.chat === c.id && (scope === 'all' || u.owner === me.id))
          .reduce((a, u) => a + Math.ceil((u.stored || u.size || 0) * UP_B64), 0);
        if (!msgBytes && !upBytes) return;
        rows.push({
          chat: c.id, n: i + 1, type: c.kind,
          msgBytes, msgCount, upBytes,
          canClear: c.kind === 'group' ? (c.ownerId === me.id || me.isAdmin === true) : true
        });
      });
      rows.sort((a, b) => (b.msgBytes + b.upBytes) - (a.msgBytes + a.upBytes));
      return J(200, { rows });
    }
    if (pathname === '/api/storage/delete' && method === 'POST') {
      const b = req.body || {};
      const upId = safeFile(String(b.upId || ''));
      const meta = await store.getUpMeta(upId);
      if (!meta || meta.gone) return E(404, 'Вложение не найдено или уже удалено');
      if (meta.owner !== me.id && me.isAdmin !== true) return E(403, 'Удалять вложение может только владелец или администратор');
      await store.delUpParts(upId);
      const freed = meta.stored || meta.size || 0;
      meta.gone = true; meta.stored = 0;
      await store.putUpMeta(upId, meta);
      db.upBytes = Math.max(0, (db.upBytes || 0) - freed);
      db.seq++; save();
      storageCache.clear();
      return J(200, { ok: true, freed: Math.ceil(freed * UP_B64) });
    }
    if (pathname === '/api/admin/storage/limit' && method === 'POST') {
      // pkg3-74: администратор поднимает предел хранилища из мессенджера.
      // Сам диск расширить нельзя — можно лишь занять свободное место диска
      // под предел мессенджера (с неснижаемым запасом 256 МБ).
      if (!me.isAdmin) return E(403, 'Только администратор мессенджера');
      const b = req.body || {};
      const v = Math.floor(Number(b.bytes));
      const u = usage();
      if (!Number.isFinite(v) || v < u.bytes) return E(400, 'Предел не может быть меньше занятого (' + Math.ceil(u.bytes / 1048576) + ' МБ)');
      const df = diskFree();
      if (df != null) {
        const headroom = u.bytes + Math.max(0, df - 256 * 1048576);
        if (v > headroom) return E(400, 'На диске нет места под такой предел: свободно ' + Math.floor(df / 1048576) + ' МБ, запас 256 МБ неснижаемый');
      }
      db.storageLimit = v; save();
      storageCache.clear();
      return J(200, { ok: true, limit: v, diskFree: df });
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
      let who = db.users.find(x => x.id === decodeURIComponent(pathname.split('/')[3] || ''));
      if (!who) return E(404, 'Участник не найден');
      // pkg3-61: поглощённая учётка показывает аватар той, чью внешность носит
      if (who.displayAs) {
        const t = db.users.find(x => x.id === who.displayAs && !x.displayAs);
        if (t) who = t;
      }
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
