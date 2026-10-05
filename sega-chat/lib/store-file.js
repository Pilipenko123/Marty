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

    // журнал мелких изменений: в файловом режиме он лежит прямо в db.json
    pushChange(rec) {
      const r = rec.r || Math.max(Date.now(), (db.changes[db.changes.length - 1] || { r: 0 }).r + 1);
      const item = { i: rec.i, c: rec.c, r, d: rec.d ? 1 : 0 };
      db.changes.push(item);
      if (db.changes.length > 200) db.changes = db.changes.slice(-200);
      db.chg = (db.chg || 0) + 1;
      store.dirty = true;
      return item;
    },
    async loadChanges(sinceR, overlap) {
      const from = Number(sinceR || 0) - Number(overlap || 0);
      return db.changes.filter(x => x.r > from).sort((a, b) => a.r - b.r);
    },
    async trimChanges() {
      const cut = Date.now() - 24 * 60 * 60 * 1000;
      const before = db.changes.length;
      db.changes = db.changes.filter(x => x.r > cut);
      return before - db.changes.length;
    },

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

    /**
     * Полная выгрузка — для резервной копии.
     * В файловом режиме «база» это data/db.json плюс соседние файлы
     * (архивы, куски вложений, фоны и иконки чатов), поэтому копируем всё.
     */
    async dumpAll() {
      writeNow();
      const files = {};
      const counts = {};
      const walk = (dir, prefix, depth) => {
        let names = [];
        try { names = fs.readdirSync(dir); } catch (e) { return; }
        for (const f of names.sort()) {
          const full = path.join(dir, f);
          let st = null;
          try { st = fs.statSync(full); } catch (e) { continue; }
          const rel = prefix ? prefix + '/' + f : f;
          if (st.isDirectory()) { if (depth > 0) walk(full, rel, depth - 1); continue; }
          if (f.endsWith('.tmp') || f.endsWith('.broken')) continue;
          try { files[rel] = fs.readFileSync(full, 'utf8'); } catch (e) {}
          const group = rel.split('/')[0].replace(/-[\w.]+$/, '');
          counts[group] = (counts[group] || 0) + 1;
        }
      };
      walk(dataDir, '', 1);
      delete files['db.json'];                 // база уходит отдельным полем, без дубля
      return {
        table: null,
        rows: [],
        db: JSON.parse(JSON.stringify(db)),
        files,
        counts: Object.assign({ db: 1 }, counts)
      };
    },

    async close() { if (db) writeNow(); },

    /**
     * Восстановление из копии файлового режима: база целиком плюс соседние
     * файлы (архивы, куски вложений, фоны и иконки чатов).
     */
    async restoreFiles(payload) {
      const files = payload.files || {};
      let written = 0;
      for (const [rel, text] of Object.entries(files)) {
        const full = path.join(dataDir, rel);
        if (!full.startsWith(dataDir)) continue;      // всякие «../» из копии не пишем
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, text);
        written++;
      }
      db = payload.db && typeof payload.db === 'object' ? payload.db : emptyDb();
      if (!db.serverSecret) db.serverSecret = crypto.randomBytes(32).toString('hex');
      migrate(db);
      recomputeStats(db);
      writeNow();
      return { dropped: null, written };
    }
  };
  return store;
}

module.exports = { createFileStore };
