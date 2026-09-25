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
                    //   pub, wrappedPriv, avatar, avatarRev, avatarLen, reads, lastSeen, activeAt }
    chats: [],      // { id, kind:'group'|'dm', titleBlob, ownerId, members:[uid], keys:{uid:{by,blob}}, createdAt,
                    //   archivedByName, archivedAt, archivedCount, lastArchive }
    messages: [],   // { id, seq, uid, ts, blob, bytes, chat, parent, quote }
    sessions: {},   // token -> { uid, exp }
    archives: [],   // { file, createdAt, count, bytes, chat }
    seq: 0,
    gen: 0,         // растёт при удалениях — сигнал «перечитай всё»
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
