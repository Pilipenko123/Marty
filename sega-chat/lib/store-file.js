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
    async loadArchives() {},   // в файловом режиме список всегда актуален в памяти
    async putWall(id, data) { fs.writeFileSync(path.join(dataDir, 'wall-' + id + '.txt'), data || ''); },
    async getWall(id) {
      const f = path.join(dataDir, 'wall-' + id + '.txt');
      try { return fs.readFileSync(f, 'utf8') || null; } catch (e) { return null; }
    },
    async putIcon(id, data) { fs.writeFileSync(path.join(dataDir, 'cicon-' + id + '.txt'), data || ''); },
    async getIcon(id) {
      const f = path.join(dataDir, 'cicon-' + id + '.txt');
      try { return fs.readFileSync(f, 'utf8') || null; } catch (e) { return null; }
    },
    async putUpMeta(id, meta) { fs.writeFileSync(path.join(dataDir, 'upmeta-' + id + '.json'), JSON.stringify(meta)); },
    async getUpMeta(id) {
      try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'upmeta-' + id + '.json'), 'utf8')); } catch (e) { return null; }
    },
    async putUpPart(chatId, upId, i, data) { fs.writeFileSync(path.join(dataDir, 'up-' + upId + '-' + i + '.txt'), data); },
    async getUpPart(chatId, upId, i) {
      try { return fs.readFileSync(path.join(dataDir, 'up-' + upId + '-' + i + '.txt'), 'utf8'); } catch (e) { return null; }
    },
    async delUp(upId) {
      try {
        for (const f of fs.readdirSync(dataDir)) {
          if (f.startsWith('up-' + upId + '-') || f === 'upmeta-' + upId + '.json') fs.rmSync(path.join(dataDir, f), { force: true });
        }
      } catch (e) {}
    },
    async delArchive(file) {
      const full = path.join(archiveDir, file);
      if (full.startsWith(archiveDir)) fs.rmSync(full, { force: true });
    },
    async countArchiveParts(file) {
      return fs.existsSync(path.join(archiveDir, file)) ? 1 : 0;
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
