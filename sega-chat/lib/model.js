'use strict';
/**
 * Модель данных, общая для всех способов хранения.
 * Здесь нет ни файлов, ни сети — только структура базы и её починка.
 */

const crypto = require('crypto');

const DB_VERSION = 3;

function emptyDb() {
  return {
    version: DB_VERSION,
    createdAt: null,
    room: null,     // { codeProofSalt, codeProofHash, codeSalt, wrappedKeyByCode, rotatedAt }
    users: [],      // { id, name, nameLower, isAdmin, saltAuth, authHash, saltWrap, wrappedKeyByPass,
                    //   pub, wrappedPriv, avatar, avatarRev, avatarLen, reads, lastSeen, activeAt,
                    //   invitedBy }  // pkg3-45: ид пригласившего, 'root' у основателей
    chats: [],      // { id, kind:'group'|'dm', titleBlob, ownerId, members:[uid], keys:{uid:{by,blob}}, createdAt,
                    //   archivedByName, archivedAt, archivedCount, lastArchive,
                    //   savedBy:[uid],  // pkg3-49: кто держит личный чат в своих «Личных чатах»
                    //   openedBy:[uid] }// pkg3-49: кто создавал/открывал чат — у автора он никогда не «Новый»
    messages: [],   // { id, seq, uid, ts, blob, bytes, chat, parent, quote }
    sessions: {},   // token -> { uid, exp }
    invites: [],    // pkg3-45: { id, ownerId, secretHash, invSalt, wrappedRoomKey, createdAt,
                    //   expiresAt, usedBy, usedAt, revoked } — одноразовые ссылки-приглашения
    bonds: [],      // pkg3-47: { owner, member, origin:'invite'|'request', at } — кто кого
                    //   держит у себя в разделе «Приглашенные»; у участника может быть
                    //   несколько таких связей, в отличие от единственного invitedBy
    bondReqs: [],   // pkg3-47: { id, from, to, chat, createdAt, state:'pending'|'accepted'|'declined' }
    invitePolicy: { globalOff: false, blockedUsers: [], blockedChats: [] },  // pkg3-45/48
    adminLog: [],   // pkg3-45: журнал администратора { at, by, what }
    emergencyRegUntil: 0,  // pkg3-45: до какого момента открыта аварийная регистрация по кодовой фразе
    archives: [],   // { file, createdAt, count, bytes, chat }
    seq: 0,
    gen: 0,         // растёт при СТРУКТУРНЫХ изменениях (очистка/архив чата) — сигнал «перечитай всё»
    chg: 0,         // счётчик мелких изменений (реакция, правка, удаление сообщения)
    changes: [],    // журнал «что изменилось»: { i: id, c: чат, r: отметка, d: 1 если удалено }
    backups: [],    // следы резервных копий в облачном хранилище: { key, bytes, rows, at, by }
    dmSaved49: false, // pkg3-49: разовый перенос старых личных чатов в «сохранённые» выполнен
    serverSecret: null,
    stats: { bytes: 0, count: 0, chats: {} } // счётчики вместо пересчёта всей истории
  };
}

/** Пересчитать счётчики по полной истории (нужно файловому хранилищу при старте). */
function recomputeStats(db) {
  const s = { bytes: 0, count: 0, chats: {} };
  for (const c of db.chats) s.chats[c.id] = { n: 0, b: 0, t: c.createdAt || 0 };
  for (const m of db.messages) {
    const bytes = m.bytes || 0;
    s.bytes += bytes; s.count++;
    const cs = s.chats[m.chat] || (s.chats[m.chat] = { n: 0, b: 0, t: 0 });
    cs.n++; cs.b += bytes; if ((m.ts || 0) > cs.t) cs.t = m.ts || 0;
  }
  db.stats = s;
  return db;
}

/**
 * Приведение старых баз к текущей версии:
 *  v1 — один общий чат 'group' и личные каналы 'dm:a|b';
 *  v2 — аватар лежал прямо в карточке участника и уезжал клиенту при каждом опросе.
 */
function migrate(db) {
  if (!db.chats) db.chats = [];
  if (!db.archives) db.archives = [];
  if (!db.sessions) db.sessions = {};
  if (!db.gen) db.gen = 0;
  // журнал мелких изменений (реакции, правки, удаления отдельных сообщений):
  // без него клиентам приходилось перечитывать всю историю ради одного смайлика
  if (!db.chg) db.chg = 0;
  if (!Array.isArray(db.changes)) db.changes = [];
  if (!Array.isArray(db.backups)) db.backups = [];

  const legacyId = 'legacy-group';
  if (db.messages.some(m => m.ch !== undefined && m.chat === undefined)) {
    for (const m of db.messages) {
      if (m.chat !== undefined) continue;
      const ch = m.ch || 'group';
      if (ch === 'group') {
        m.chat = legacyId;
      } else {
        m.chat = ch;
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
      if (u.reads && u.reads.group !== undefined) { u.reads[legacyId] = u.reads.group; delete u.reads.group; }
    }
    for (const a of db.archives) if (!a.chat) a.chat = legacyId;
  }

  // Push-подписки добавлены без изменения старых ключей и сообщений.
  for (const u of db.users) if (!Array.isArray(u.pushSubs)) u.pushSubs = [];

  // pkg3-54: «Новые» живут 7 суток вместо прежних 24 часов. Уже идущие таймеры,
  // заведённые ровно по старым суткам, продлеваем под действующий NEW_DM_TTL.
  // Флаг не нужен: после продления длительность становится недельной и под
  // условие больше не подходит, а в проверках TTL короткий (не сутки) — там
  // продление ничего не трогает. Перенос идемпотентен при каждом старте.
  {
    const ttl = Number(process.env.NEW_DM_TTL || 7 * 24 * 60 * 60 * 1000);
    const OLD_TTL = 24 * 60 * 60 * 1000;
    if (ttl > OLD_TTL) {
      for (const u of db.users) {
        if (!u.newChats || typeof u.newChats !== 'object') continue;
        for (const k of Object.keys(u.newChats)) {
          const e = u.newChats[k];
          if (e && typeof e === 'object' && Number.isFinite(e.at)
            && Math.abs((e.until - e.at) - OLD_TTL) <= 1000) {
            e.until = e.at + ttl;
          }
        }
      }
    }
  }

  // pkg3-53: пользовательские разделы (папки). Поле личное: хранит копии ссылок
  // на чаты, системные разделы не заменяет. У старых записей поля нет — добавляем
  // пустой список и заодно приводим содержимое к одному виду (защита от мусора).
  for (const u of db.users) {
    if (!Array.isArray(u.sections)) u.sections = [];
    u.sections = u.sections
      .filter(x => x && typeof x === 'object' && x.id)
      .map(x => ({
        id: String(x.id),
        name: (String(x.name == null ? '' : x.name).replace(/\s+/g, ' ').trim().slice(0, 32)) || 'Без названия',
        createdAt: Number(x.createdAt) || 0,
        chats: (Array.isArray(x.chats) ? x.chats : []).map(String).slice(0, 300)
      }));
  }

  // pkg3-57: «Морской бой» — зашифрованные слепки флота для ДРУГИХ устройств
  // владельца (карта chatId → blob). Содержимое серверу непрозрачно: blob
  // шифруется личным ключом участника и возвращается только ему (mySbFleets).
  // У старых записей поля нет — добавляем пустую карту и срезаем мусор.
  for (const u of db.users) {
    if (!u.sbFleets || typeof u.sbFleets !== 'object' || Array.isArray(u.sbFleets)) u.sbFleets = {};
    for (const k of Object.keys(u.sbFleets)) {
      if (typeof u.sbFleets[k] !== 'string' || !u.sbFleets[k] || u.sbFleets[k].length > 8192) delete u.sbFleets[k];
    }
    // страховка от разрастания: держим не больше 60 слепков (порядок вставки)
    const ks = Object.keys(u.sbFleets);
    if (ks.length > 60) for (const k of ks.slice(0, ks.length - 60)) delete u.sbFleets[k];
  }

  // pkg3-59: «бан на сутки» по жалобе администратора. У старых записей отметки
  // нет — ставим ноль (не забанен); мусор приводим к тому же виду.
  for (const u of db.users) {
    if (typeof u.bannedUntil !== 'number' || !Number.isFinite(u.bannedUntil) || u.bannedUntil < 0) u.bannedUntil = 0;
  }

  // pkg3-61: «поглощение» учётки — у старых записей привязки внешности нет.
  for (const u of db.users) {
    if (typeof u.displayAs !== 'string' || !u.displayAs) u.displayAs = null;
  }

  // pkg3-64: почта для восстановления (необязательная) и копии восстановления.
  for (const u of db.users) {
    if (typeof u.email !== 'string') u.email = '';
    u.emailConfirmed = !!u.emailConfirmed;
    if (typeof u.recoveryBlob !== 'string' || !u.recoveryBlob) u.recoveryBlob = null;
  }
  if (!Array.isArray(db.recover)) db.recover = [];
  db.recover = db.recover.filter(x => x && typeof x.token === 'string' && x.exp > Date.now() - 7 * 24 * 3600 * 1000);

  // pkg3-63: поколение ключа группы (epoch). Растёт при каждом перевыпуске
  // ключа — клиенты по нему понимают, что их копия устарела и её надо
  // пере-развернуть с сервера. У старых чатов поколения нет — ставим ноль.
  for (const c of db.chats) {
    if (typeof c.keyEpoch !== 'number' || !Number.isFinite(c.keyEpoch) || c.keyEpoch < 0) c.keyEpoch = 0;
    // pkg3-66: хранилище свёрток прежних ключей (по поколениям); у старых чатов его нет
    if (!c.oldKeys || typeof c.oldKeys !== 'object' || Array.isArray(c.oldKeys)) c.oldKeys = {};
    // pkg3-65: каждая копия ключа группы помечается поколением (ep). Сервер
    // благодаря этому отказывается принимать устаревшие доставки ключа, а
    // клиент понимает, что его копия — прежнего поколения, и просит свежую.
    // Старые копии (до отметок) считаем текущим поколением: истинное поколение
    // узнать нельзя, а перевыпуск ключа и так заменяет все копии разом.
    if (c.keys && typeof c.keys === 'object') {
      for (const id of Object.keys(c.keys)) {
        const e = c.keys[id];
        if (e && typeof e === 'object' && (typeof e.ep !== 'number' || !Number.isFinite(e.ep) || e.ep < 0)) e.ep = c.keyEpoch;
      }
    }
  }

  // pkg3-45: закрытая регистрация и приглашения. Новые коллекции и дерево «кто кого
  // позвал»: у участников, пришедших до введения приглашений, приглашенческого
  // корня нет — помечаем их основателями ('root'). Секретов в этих полях нет.
  if (!Array.isArray(db.invites)) db.invites = [];
  if (!Array.isArray(db.bonds)) db.bonds = [];
  if (!Array.isArray(db.bondReqs)) db.bondReqs = [];
  // pkg3-47: связи «приглашенные» до этого выпуска жили только в invitedBy;
  // переносим их в таблицу связей, чтобы запросы-согласия могли добавлять новые
  for (const u of db.users) {
    if (u.invitedBy && u.invitedBy !== 'root' && u.invitedBy !== 'code'
      && !db.bonds.some(b => b.owner === u.invitedBy && b.member === u.id)) {
      db.bonds.push({ owner: u.invitedBy, member: u.id, origin: 'invite', at: u.createdAt || 0 });
    }
  }
  if (!db.invitePolicy || typeof db.invitePolicy !== 'object') {
    db.invitePolicy = { globalOff: false, blockedUsers: [], blockedChats: [] };
  }
  if (!Array.isArray(db.invitePolicy.blockedUsers)) db.invitePolicy.blockedUsers = [];
  if (!Array.isArray(db.invitePolicy.blockedChats)) db.invitePolicy.blockedChats = [];
  if (!Array.isArray(db.adminLog)) db.adminLog = [];
  if (typeof db.emergencyRegUntil !== 'number') db.emergencyRegUntil = 0;
  for (const u of db.users) if (u.invitedBy === undefined) u.invitedBy = 'root';
  // pkg3-48: скрытые личные чаты — личный список «не показывать мне этот чат»
  for (const u of db.users) if (!Array.isArray(u.hiddenChats)) u.hiddenChats = [];

  // pkg3-49: «Новые» и «Личные чаты».
  //  savedBy  — у самого чата: кто из двоих держит его в своих «Личных чатах»;
  //  openedBy — кто из двоих создавал чат или писал в него: для автора
  //              переписки чат обычный с первой минуты, «Новые» — для адресата;
  //  newChats — у участника: какие чаты лежат в «Новых» и до какого момента
  //              ({ 'dm:…': { at, until } }, «until» — самоудаление через сутки).
  // Поля приводим у всех личных чатов (это безопасно повторять), а вот СТАРУЮ
  // историю переносим ОДИН РАЗ под флагом dmSaved49: чаты с перепиской, которая
  // была до этого выпуска, сохраняем обеим сторонам — прежнее поведение не
  // меняется. Без флага перенос срабатывал бы после каждого письма и «спасал» бы
  // чат у адресата, ломая правило суток. Пустые чаты-заготовки сохранёнными не
  // считаем — они живут по общему правилу «Новых».
  for (const c of db.chats) {
    if (c.kind !== 'dm') continue;
    if (!Array.isArray(c.savedBy)) c.savedBy = [];
    if (!Array.isArray(c.openedBy)) c.openedBy = [];
  }
  if (!db.dmSaved49) {
    const hasMsgs = {};
    for (const m of db.messages || []) hasMsgs[m.chat] = true;
    for (const c of db.chats) {
      if (c.kind !== 'dm') continue;
      const cnt = ((db.stats && db.stats.chats && db.stats.chats[c.id]) || {}).n || 0;
      if (cnt > 0 || hasMsgs[c.id]) {
        for (const id of (c.members || [])) {
          if (!c.savedBy.includes(id)) c.savedBy.push(id);
          if (!c.openedBy.includes(id)) c.openedBy.push(id);
        }
      }
    }
    db.dmSaved49 = true;
  }
  for (const u of db.users) if (!u.newChats || typeof u.newChats !== 'object') u.newChats = {};

  // аватар: теперь клиенту отдаётся только отпечаток, картинка скачивается отдельно
  for (const u of db.users) {
    if (u.avatar && !u.avatarRev) {
      u.avatarRev = crypto.createHash('sha256').update(u.avatar).digest('hex').slice(0, 8);
      u.avatarLen = u.avatar.length;
    }
    if (!u.avatar && u.avatarRev && u.avatarLen === undefined) u.avatarLen = 0;
  }

  db.version = DB_VERSION;
  return db;
}

module.exports = { DB_VERSION, emptyDb, migrate, recomputeStats };
