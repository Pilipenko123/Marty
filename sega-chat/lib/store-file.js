'use strict';
/**
 * Хранение в обычных файлах — режим «мессенджер на своём компьютере».
 * Вся база держится в памяти и сохраняется в data/db.json.
 */

const fs = require('fs');
const path = require('path');
const { emptyDb, migrate, recomputeStats } = require('./model');
const crypto = require('crypto');

function createFileStore(opts = {}) {
  const dataDir = opts.dataDir || process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  const archiveDir = path.join(dataDir, 'archives');
  const dbFile = path.join(dataDir, 'db.json');
  let db = null;

  function writeNow() {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = dbFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, dbFile);
  }

  const store = {
    name: 'file',
    dirty: false,
    dataDir, dbFile, archiveDir,

    async open() {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.mkdirSync(archiveDir, { recursive: true });
      db = emptyDb();
      if (fs.existsSync(dbFile)) {
        try {
          Object.assign(db, JSON.parse(fs.readFileSync(dbFile, 'utf8')));
        } catch (e) {
          const backup = dbFile + '.broken.' + Date.now();
          try { fs.copyFileSync(dbFile, backup); } catch (e2) {}
          console.error('Не удалось прочитать базу:', e.message, '— испорченный файл сохранён как', backup);
        }
      }
      if (!db.serverSecret) db.serverSecret = crypto.randomBytes(32).toString('hex');
      if (!db.createdAt) db.createdAt = Date.now();
      migrate(db);
      recomputeStats(db);
      writeNow();
      return db;
    },

    async load() { if (!db) await store.open(); return db; },
    async flush() { writeNow(); },

    // сессии, сообщения и аватары здесь всегда в памяти — подгружать нечего
    async getSession(token) { return db.sessions[token] || null; },
    dropSession(token) { delete db.sessions[token]; },
    async loadSessions() {},
    async loadSince() {},
    async loadChats() {},
    async getMessage(id) { return db.messages.find(m => m.id === id) || null; },
    dropMessages() {},
    dropChat() {},
    dropUser() {},
    touchPresence() {},
    touchAvatar() {},
    async loadAvatar() {},

    async putArchive(file, text) {
      fs.mkdirSync(archiveDir, { recursive: true });
      fs.writeFileSync(path.join(archiveDir, file), text);
    },
    async getArchive(file) {
      const full = path.join(archiveDir, file);
      if (!full.startsWith(archiveDir) || !fs.existsSync(full)) return null;
      return fs.readFileSync(full, 'utf8');
    },

    async close() { if (db) writeNow(); }
  };
  return store;
}

module.exports = { createFileStore };
