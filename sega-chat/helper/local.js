'use strict';
/**
 * SEGA-CHAT · локальная папка помощника (этап 1).
 *
 * Журнал лежит ОТДЕЛЬНО от синхронизируемой папки. Запись файла атомарная:
 * временный файл -> контрольная сумма -> переименование. Удаление возможно
 * только после явного подтверждения и сначала сохраняет копию в служебной
 * папке. Символические ссылки и точки соединения не обходятся.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const core = require('./core');

const sha256 = () => crypto.createHash('sha256');
const hex = b => b.toString('hex');

async function hashStream(stream) {
  const h = sha256();
  let size = 0;
  for await (const chunk of stream) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    h.update(b); size += b.length;
  }
  return { hash: hex(h.digest()), size };
}

function disjoint(a, b) {
  const rel = path.relative(a, b);
  return rel === '' ? false : (rel.startsWith('..' + path.sep) || rel === '..' || path.isAbsolute(rel));
}

function createLocalFolder(opts) {
  if (!opts || typeof opts.root !== 'string' || typeof opts.stateDir !== 'string') {
    throw new core.SyncError('options', 'Нужны root и stateDir');
  }
  const root = path.resolve(opts.root);
  const stateDir = path.resolve(opts.stateDir);
  const folderId = String(opts.folderId || '');
  const deviceId = String(opts.deviceId || '');
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(folderId)) throw new core.SyncError('folder-id', 'Неверная метка папки');
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(deviceId)) throw new core.SyncError('device-id', 'Неверная метка компьютера');
  if (!disjoint(root, stateDir) || !disjoint(stateDir, root)) {
    throw new core.SyncError('state-inside', 'Служебная папка должна лежать отдельно от синхронизируемой');
  }
  const limits = Object.assign({ maxFiles: 20000, maxDepth: core.MAX_DEPTH, maxFileBytes: 2 * 1024 * 1024 * 1024 }, opts.limits || {});
  const ignored = core.ignoreMatcher(opts.ignores || core.DEFAULT_IGNORES);
  const journalFile = path.join(stateDir, 'journal.json');
  const lockFile = path.join(stateDir, 'lock');
  let journal = null;
  let locked = false;
  let rootReal = null;

  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();

  async function init() {
    const st = await fsp.lstat(root);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new core.SyncError('root', 'Выбранная папка недоступна');
    rootReal = await fsp.realpath(root);
    await fsp.mkdir(stateDir, { recursive: true, mode: 0o700 });
    const lst = await fsp.lstat(stateDir);
    if (!lst.isDirectory() || lst.isSymbolicLink()) throw new core.SyncError('state', 'Служебная папка недоступна');
    try {
      journal = JSON.parse(await fsp.readFile(journalFile, 'utf8'));
      const map = x => x !== null && typeof x === 'object' && !Array.isArray(x);
      if (!journal || journal.v !== 1 || journal.folderId !== folderId || !map(journal.bases)
        || !map(journal.applied) || !map(journal.pending) || !map(journal.conflicts)) {
        throw new Error('bad journal');
      }
      if (!map(journal.dirs)) journal.dirs = {};
    } catch (e) {
      if (e.code !== 'ENOENT') throw new core.SyncError('journal', 'Журнал синхронизации повреждён — автоматическая замена остановлена');
      journal = { v: 1, folderId, deviceId, bases: {}, dirs: {}, applied: {}, pending: {}, conflicts: {}, updatedAt: 0 };
      await saveJournal();
    }
    return api;
  }

  async function saveJournal() {
    journal.updatedAt = now();
    const tmp = path.join(stateDir, '.journal-' + crypto.randomUUID() + '.tmp');
    const fh = await fsp.open(tmp, 'wx', 0o600);
    try {
      await fh.writeFile(JSON.stringify(journal), 'utf8');
      await fh.sync();
    } finally { await fh.close(); }
    await fsp.rename(tmp, journalFile);
  }

  async function acquire() {
    if (locked) return;
    let fh;
    try { fh = await fsp.open(lockFile, 'wx', 0o600); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let stale = false;
      try {
        const old = JSON.parse(await fsp.readFile(lockFile, 'utf8'));
        if (old && old.host === os.hostname() && Number.isInteger(old.pid) && old.pid > 0) {
          try { process.kill(old.pid, 0); } catch (x) { stale = x.code === 'ESRCH'; }
        }
      } catch (x) { stale = true; }
      if (!stale) throw new core.SyncError('busy', 'Эта папка уже открыта другим помощником');
      await fsp.unlink(lockFile).catch(() => {});
      try { fh = await fsp.open(lockFile, 'wx', 0o600); }
      catch (x) { throw new core.SyncError('busy', 'Эта папка уже открыта другим помощником'); }
    }
    try { await fh.writeFile(JSON.stringify({ pid: process.pid, host: os.hostname(), at: now() })); await fh.sync(); }
    catch (e) { await fh.close().catch(() => {}); await fsp.unlink(lockFile).catch(() => {}); throw e; }
    await fh.close();
    locked = true;
  }

  async function release() {
    if (!locked) return;
    await fsp.unlink(lockFile).catch(() => {});
    locked = false;
  }

  function safeParts(rel) {
    const p = core.normalizePath(rel, { allowRoot: true });
    return p ? p.split('/') : [];
  }

  async function assertDirChain(parts, create = true) {
    let cur = rootReal;
    for (const part of parts) {
      cur = path.join(cur, part);
      let st;
      try { st = await fsp.lstat(cur); }
      catch (e) {
        if (e.code !== 'ENOENT') throw e;
        if (!create) throw e;
        await fsp.mkdir(cur);
        st = await fsp.lstat(cur);
      }
      if (st.isSymbolicLink() || !st.isDirectory()) throw new core.SyncError('symlink', 'Папка ведёт по ссылке наружу выбранной папки');
    }
    return cur;
  }

  async function targetPath(rel, create = true) {
    const parts = safeParts(rel);
    if (!parts.length) throw new core.SyncError('path-root', 'Нельзя заменить саму папку');
    const name = parts.pop();
    const dir = await assertDirChain(parts, create);
    const full = path.join(dir, name);
    const relCheck = path.relative(rootReal, full);
    if (!relCheck || relCheck.startsWith('..') || path.isAbsolute(relCheck)) throw new core.SyncError('escape', 'Путь вышел из выбранной папки');
    return full;
  }

  async function fingerprint(full) {
    const st = await fsp.lstat(full);
    if (st.isSymbolicLink() || !st.isFile()) throw new core.SyncError('not-file', 'Это не обычный файл');
    if (st.size > limits.maxFileBytes) throw new core.SyncError('file-large', 'Файл больше разрешённого размера');
    const h = await hashStream(fs.createReadStream(full));
    return { hash: h.hash, size: st.size, mtimeMs: Math.round(st.mtimeMs) };
  }

  async function fingerprintAt(rel) {
    try {
      const full = await targetPath(rel, false);
      return await fingerprint(full);
    } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }

  async function scan() {
    const files = [], dirs = [], skipped = [];
    let count = 0;
    async function walk(rel, depth) {
      if (depth > limits.maxDepth) throw new core.SyncError('deep', 'Слишком глубокая папка');
      const full = rel ? path.join(rootReal, rel) : rootReal;
      const entries = await fsp.readdir(full, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
      for (const ent of entries) {
        const childRel = rel ? rel + '/' + ent.name : ent.name;
        let p;
        try { p = core.normalizePath(childRel); }
        catch (e) { skipped.push({ path: childRel, reason: e.code }); continue; }
        if (ignored(p)) continue;
        const child = path.join(full, ent.name);
        if (ent.isSymbolicLink()) { skipped.push({ path: p, reason: 'symlink' }); continue; }
        if (ent.isDirectory()) {
          dirs.push(p);
          await walk(p, depth + 1);
        } else if (ent.isFile()) {
          if (++count > limits.maxFiles) throw new core.SyncError('many-files', 'В папке слишком много файлов для одного прохода');
          const st = await fsp.lstat(child);
          if (st.size > limits.maxFileBytes) { skipped.push({ path: p, reason: 'file-large' }); continue; }
          const h = await hashStream(fs.createReadStream(child));
          files.push({ path: p, hash: h.hash, size: st.size, mtimeMs: Math.round(st.mtimeMs) });
        } else {
          skipped.push({ path: p, reason: 'special' });
        }
      }
    }
    await walk('', 0);
    const collisions = core.detectCollisions(files.map(f => f.path).concat(dirs));
    if (collisions.length) throw new core.SyncError('case-collision', 'В папке есть имена, различающиеся только регистром: ' + collisions[0].join(' / '));
    return { files, dirs, skipped };
  }

  async function writeTemp(rel, openContent, expected) {
    const full = await targetPath(rel);
    const dir = path.dirname(full);
    const tmp = path.join(dir, '.sega-tmp-' + crypto.randomUUID());
    const fh = await fsp.open(tmp, 'wx', 0o600);
    const h = sha256();
    let size = 0;
    try {
      const source = await openContent();
      const iterable = Buffer.isBuffer(source) || typeof source === 'string' ? [Buffer.from(source)] : source;
      for await (const chunk of iterable) {
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += b.length;
        if (size > limits.maxFileBytes) throw new core.SyncError('file-large', 'Файл больше разрешённого размера');
        h.update(b);
        await fh.write(b);
      }
      const hash = hex(h.digest());
      if (expected && (hash !== expected.hash || size !== expected.size)) {
        throw new core.SyncError('checksum', 'Содержимое не совпало с ожидаемой версией');
      }
      await fh.sync();
      await fh.close();
      return { tmp, full, hash, size };
    } catch (e) {
      await fh.close().catch(() => {});
      await fsp.unlink(tmp).catch(() => {});
      throw e;
    }
    // успешный путь закрывает дескриптор ниже, после rename нельзя писать
  }

  async function commitNoReplace(item, dest) {
    try {
      await fsp.link(item.tmp, dest);
      await fsp.unlink(item.tmp);
    } catch (e) {
      if (e.code === 'EEXIST') throw e;
      // FAT/exFAT и некоторые сетевые папки не умеют жёсткие ссылки.
      if (e.code === 'EPERM' || e.code === 'ENOSYS' || e.code === 'EOPNOTSUPP') {
        await fsp.copyFile(item.tmp, dest, fs.constants.COPYFILE_EXCL);
        await fsp.unlink(item.tmp);
      } else throw e;
    }
  }

  async function backup(full, fp) {
    const dir = path.join(stateDir, 'backups');
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    const dest = path.join(dir, fp.hash);
    try { await fsp.copyFile(full, dest, fs.constants.COPYFILE_EXCL); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    return dest;
  }

  async function apply(event, openContent) {
    if (!journal) throw new core.SyncError('init', 'Сначала откройте папку');
    core.eventContext(event);
    if (event.folderId !== folderId) throw new core.SyncError('folder', 'Событие от другой папки');
    const rel = core.normalizePath(event.path);
    if (journal.applied[event.id]) return { action: 'noop', reason: 'already-applied', path: rel };

    if (event.op === 'mkdir') {
      const parts = core.normalizePath(event.path).split('/');
      await assertDirChain(parts);
      journal.dirs[rel] = { at: now() };
      journal.applied[event.id] = { at: now(), action: 'mkdir', path: rel };
      await saveJournal();
      return { action: 'mkdir', path: rel };
    }

    if (event.op === 'delete') {
      const expectedHash = event.file && event.file.hash || event.baseHash;
      if (!/^[a-f0-9]{64}$/.test(String(expectedHash || ''))) throw new core.SyncError('delete-hash', 'Для удаления нужна контрольная сумма версии');
      const local = await fingerprintAt(rel);
      const decision = core.classifyChange({ local, base: journal.bases[rel] || null, incoming: { deleted: true } });
      if (decision.action === 'confirm-delete') {
        journal.pending[event.id] = { kind: 'delete', eventId: event.id, path: rel, expectedHash, at: now(), from: event.deviceId };
        await saveJournal();
        return { action: 'confirm-delete', reason: decision.reason, path: rel, pendingId: event.id };
      }
      journal.bases[rel] = { deleted: true, hash: expectedHash };
      journal.applied[event.id] = { at: now(), action: 'noop', path: rel };
      await saveJournal();
      return { action: 'noop', reason: 'already-absent', path: rel };
    }

    if (!core.isFingerprint(event.file)) throw new core.SyncError('event-file', 'В событии нет версии файла');
    if (typeof openContent !== 'function') throw new core.SyncError('content', 'Не передано содержимое файла');
    const local = await fingerprintAt(rel);
    const base = journal.bases[rel] || null;
    const incoming = Object.assign({}, event.file, { baseHash: event.baseHash });
    const decision = core.classifyChange({ local, base, incoming });

    if (decision.action === 'confirm-restore') {
      journal.pending[event.id] = { kind: 'restore', eventId: event.id, path: rel, event, at: now(), from: event.deviceId };
      await saveJournal();
      return { action: 'confirm-restore', reason: decision.reason, path: rel, pendingId: event.id };
    }
    if (decision.action === 'noop' || decision.action === 'keep-local') {
      if (decision.action === 'noop') journal.bases[rel] = { hash: event.file.hash, size: event.file.size, mtimeMs: event.file.mtimeMs };
      journal.applied[event.id] = { at: now(), action: decision.action, path: rel, hash: event.file.hash };
      await saveJournal();
      return Object.assign({ path: rel }, decision);
    }

    let item = await writeTemp(rel, openContent, event.file);
    // Дескриптор закрыт после fsync; дальше только операции с готовым временным файлом.
    try {
      if (decision.action === 'create') {
        try {
          await commitNoReplace(item, item.full);
        } catch (e) {
          if (e.code !== 'EEXIST') throw e;
          const raced = await fingerprintAt(rel);
          if (raced && raced.hash === item.hash) {
            await fsp.unlink(item.tmp).catch(() => {});
            journal.bases[rel] = Object.assign({}, event.file);
            journal.applied[event.id] = { at: now(), action: 'noop', path: rel, hash: item.hash };
            await saveJournal();
            return { action: 'noop', reason: 'appeared-same', path: rel };
          }
          const copy = core.conflictName(rel, event.deviceId, event.id, p => fs.existsSync(path.join(rootReal, p)));
          const dest = await targetPath(copy);
          await commitNoReplace(item, dest);
          journal.conflicts[event.id] = { path: rel, copy, hash: item.hash, at: now() };
          journal.applied[event.id] = { at: now(), action: 'conflict', path: rel, copy, hash: item.hash };
          await saveJournal();
          return { action: 'conflict', reason: 'appeared-different', path: rel, copy };
        }
        journal.bases[rel] = Object.assign({}, event.file);
        journal.applied[event.id] = { at: now(), action: 'create', path: rel, hash: item.hash };
        await saveJournal();
        return { action: 'create', reason: decision.reason, path: rel };
      }

      if (decision.action === 'update') {
        const again = await fingerprintAt(rel);
        if (!again || again.hash !== local.hash) {
          const copy = core.conflictName(rel, event.deviceId, event.id, p => fs.existsSync(path.join(rootReal, p)));
          const dest = await targetPath(copy);
          await commitNoReplace(item, dest);
          journal.conflicts[event.id] = { path: rel, copy, hash: item.hash, at: now() };
          journal.applied[event.id] = { at: now(), action: 'conflict', path: rel, copy, hash: item.hash };
          await saveJournal();
          return { action: 'conflict', reason: 'changed-during-write', path: rel, copy };
        }
        await backup(item.full, local);
        await fsp.rename(item.tmp, item.full);
        journal.bases[rel] = Object.assign({}, event.file);
        journal.applied[event.id] = { at: now(), action: 'update', path: rel, hash: item.hash };
        await saveJournal();
        return { action: 'update', reason: decision.reason, path: rel };
      }

      // conflict: оригинал не трогаем; имя копии детерминировано меткой события.
      const copy = core.conflictName(rel, event.deviceId, event.id, p => fs.existsSync(path.join(rootReal, p)));
      const dest = await targetPath(copy);
      let existed = false;
      try {
        const st = await fsp.lstat(dest);
        if (st.isFile() && !st.isSymbolicLink()) {
          const fp = await fingerprint(dest);
          if (fp.hash === item.hash) existed = true;
        }
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (existed) await fsp.unlink(item.tmp).catch(() => {});
      else await commitNoReplace(item, dest);
      journal.conflicts[event.id] = { path: rel, copy, hash: item.hash, at: now() };
      journal.applied[event.id] = { at: now(), action: 'conflict', path: rel, copy, hash: item.hash };
      await saveJournal();
      return { action: 'conflict', reason: decision.reason, path: rel, copy };
    } catch (e) {
      await fsp.unlink(item.tmp).catch(() => {});
      throw e;
    }
  }

  /** Явное подтверждение удаления. Файл уходит в служебную копию, не в небытие. */
  async function approveDelete(pendingId) {
    const p = journal && journal.pending[pendingId];
    if (!p || p.kind !== 'delete') throw new core.SyncError('pending', 'Нет такого запроса на удаление');
    const rel = core.normalizePath(p.path);
    const local = await fingerprintAt(rel);
    if (local && local.hash !== p.expectedHash) throw new core.SyncError('stale-delete', 'Файл изменился после запроса — удаление отменено');
    let saved = null;
    if (local) {
      const full = await targetPath(rel, false);
      const dir = path.join(stateDir, 'trash', pendingId);
      await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
      saved = path.join(dir, path.basename(rel));
      try { await fsp.copyFile(full, saved, fs.constants.COPYFILE_EXCL); }
      catch (e) { if (e.code !== 'EEXIST') throw e; }
      const check = await fingerprint(saved);
      if (check.hash !== local.hash) throw new core.SyncError('trash-check', 'Служебная копия не совпала');
      const again = await fingerprintAt(rel);
      if (!again || again.hash !== local.hash) throw new core.SyncError('stale-delete', 'Файл изменился перед удалением — удаление отменено');
      await fsp.unlink(full);
    }
    journal.bases[rel] = { deleted: true, hash: p.expectedHash };
    journal.applied[pendingId] = { at: now(), action: 'delete-approved', path: rel };
    delete journal.pending[pendingId];
    await saveJournal();
    return { action: 'delete-approved', path: rel, saved };
  }

  async function setBase(rel, fp) {
    const p = core.normalizePath(rel);
    if (!core.isFingerprint(fp)) throw new core.SyncError('base', 'Неверная версия для журнала');
    journal.bases[p] = Object.assign({}, fp);
    await saveJournal();
  }
  async function setDeleted(rel, hash) {
    const p = core.normalizePath(rel);
    if (!/^[a-f0-9]{64}$/.test(String(hash || ''))) throw new core.SyncError('base', 'Неверная сумма удалённой версии');
    journal.bases[p] = { deleted: true, hash };
    await saveJournal();
  }
  async function noteLocalDelete(rel, expectedHash) {
    const p = core.normalizePath(rel);
    if (!/^[a-f0-9]{64}$/.test(String(expectedHash || ''))) throw new core.SyncError('delete-hash', 'Нужна сумма прежней версии');
    const id = 'local-' + crypto.createHash('sha256').update(p + '|' + expectedHash).digest('hex').slice(0, 32);
    if (!journal.pending[id]) {
      journal.pending[id] = { kind: 'local-delete', eventId: id, path: p, expectedHash, at: now(), from: deviceId };
      await saveJournal();
    }
    return id;
  }
  async function approveLocalDelete(pendingId) {
    const p = journal && journal.pending[pendingId];
    if (!p || p.kind !== 'local-delete') throw new core.SyncError('pending', 'Нет такого запроса на удаление');
    const rel = core.normalizePath(p.path);
    const local = await fingerprintAt(rel);
    if (local) throw new core.SyncError('stale-delete', 'Файл вернулся на место — удаление отменено');
    journal.bases[rel] = { deleted: true, hash: p.expectedHash };
    journal.applied[pendingId] = { at: now(), action: 'local-delete-approved', path: rel };
    delete journal.pending[pendingId];
    await saveJournal();
    return { action: 'local-delete-approved', path: rel, expectedHash: p.expectedHash };
  }
  async function approveRestore(pendingId, openContent) {
    const p = journal && journal.pending[pendingId];
    if (!p || p.kind !== 'restore') throw new core.SyncError('pending', 'Нет такого запроса на восстановление');
    const ev = p.event, rel = core.normalizePath(ev.path);
    const local = await fingerprintAt(rel);
    if (local && local.hash === ev.file.hash) {
      journal.bases[rel] = Object.assign({}, ev.file);
      journal.applied[ev.id] = { at: now(), action: 'noop', path: rel };
      delete journal.pending[pendingId]; await saveJournal();
      return { action: 'noop', path: rel };
    }
    const item = await writeTemp(rel, openContent, ev.file);
    try {
      if (local) {
        const copy = core.conflictName(rel, ev.deviceId, ev.id, x => fs.existsSync(path.join(rootReal, x)));
        await commitNoReplace(item, await targetPath(copy));
        journal.conflicts[ev.id] = { path: rel, copy, hash: item.hash, at: now() };
        journal.applied[ev.id] = { at: now(), action: 'conflict', path: rel, copy };
        delete journal.pending[pendingId]; await saveJournal();
        return { action: 'conflict', path: rel, copy };
      }
      await commitNoReplace(item, item.full);
      journal.bases[rel] = Object.assign({}, ev.file);
      journal.applied[ev.id] = { at: now(), action: 'restore-approved', path: rel };
      delete journal.pending[pendingId]; await saveJournal();
      return { action: 'restore-approved', path: rel };
    } catch (e) { await fsp.unlink(item.tmp).catch(() => {}); throw e; }
  }
  async function markDir(rel) {
    const p = core.normalizePath(rel);
    await assertDirChain(p.split('/'));
    journal.dirs[p] = { at: now() };
    await saveJournal();
  }

  const api = {
    init, acquire, release, scan, apply, approveDelete, approveLocalDelete, approveRestore,
    setBase, setDeleted, noteLocalDelete, markDir,
    fingerprintAt,
    get journal() { return journal; },
    get root() { return rootReal || root; },
    get stateDir() { return stateDir; }
  };
  return api;
}

module.exports = { createLocalFolder, hashStream };
