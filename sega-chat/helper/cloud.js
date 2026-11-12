'use strict';
/** Мост выбранной папки Яндекс/Google. Токены дисков остаются на сервере;
 * помощник получает только адрес одного действия и ходит по нему потоком.
 * Облачные изменения сначала применяются к локальной папке владельца, а уже
 * обычный проход помощника рассылает их остальным ПК через зашифрованную очередь. */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const core = require('./core');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
async function readJson(file, fallback) { try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; } }
async function writeJson(file, obj) { await fsp.mkdir(path.dirname(file), { recursive: true }); const t = file + '.tmp'; await fsp.writeFile(t, JSON.stringify(obj), { mode: 0o600 }); await fsp.rename(t, file); }
async function streamToFile(stream, file, max) {
  const fh = await fsp.open(file, 'wx', 0o600); const h = crypto.createHash('sha256'); let size = 0;
  try {
    for await (const c of stream) { const b = Buffer.isBuffer(c) ? c : Buffer.from(c); size += b.length; if (size > max) throw new core.SyncError('file-large', 'Облачный файл больше разрешённого размера'); h.update(b); await fh.write(b); }
    await fh.sync(); await fh.close(); return { hash: h.digest('hex'), size };
  } catch (e) { await fh.close().catch(() => {}); await fsp.unlink(file).catch(() => {}); throw e; }
}
function createCloudBridge(opts) {
  const { call, folder, mount, stateDir, publish } = opts;
  const file = path.join(stateDir, 'journal.json');
  let j = null;
  const maxFiles = 20000, maxDepth = core.MAX_DEPTH;
  const maxBytes = Math.min(128 * 1024 * 1024, (folder.local && folder.limits && folder.limits.maxFileBytes) || 128 * 1024 * 1024);
  const q = (p, extra) => '/api/sync/agent/cloud/' + p + '?folderId=' + encodeURIComponent(folder.id) + '&mountId=' + encodeURIComponent(mount.id) + (extra || '');
  async function load() { j = await readJson(file, { v: 1, files: {}, dirs: { '': mount.path }, pending: {}, conflicts: {} }); return j; }
  async function save() { await writeJson(file, j); }
  function ver(it) { return String(it.path || '') + '|' + String(it.modified || '') + '|' + Number(it.size || 0); }
  function eid(rel, v) { return 'e_' + sha(mount.id + '|' + rel + '|' + v).slice(0, 40); }
  async function listAll(rel, dirPath, depth, out) {
    if (depth > maxDepth) throw new core.SyncError('deep', 'Облачная папка слишком глубокая');
    let offset = 0, pageToken = '';
    for (;;) {
      const extra = '&path=' + encodeURIComponent(dirPath) + (mount.kind === 'google' ? (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '') : '&offset=' + offset);
      const r = await call('GET', q('list', extra + '&limit=200'));
      for (const it of r.items || []) {
        let name; try { name = core.normalizePath(it.name); } catch (e) { continue; }
        let child; try { child = core.normalizePath(rel ? rel + '/' + name : name); } catch (e) { continue; }
        if (it.dir) { j.dirs[child] = it.path; out.dirs.push(child); await listAll(child, it.path, depth + 1, out); }
        else { if (out.files.length >= maxFiles) throw new core.SyncError('many-files', 'В облачной папке слишком много файлов'); out.files.push({ rel: child, it }); }
      }
      if (mount.kind === 'google') { if (!r.nextPageToken) break; pageToken = r.nextPageToken; }
      else { offset += (r.items || []).length; if (offset >= (r.total || 0) || !(r.items || []).length) break; }
    }
  }
  async function remoteStream(it) {
    if (mount.kind === 'yandex') {
      const r = await call('GET', q('href', '&path=' + encodeURIComponent(it.path)));
      const res = await fetch(r.href, { signal: AbortSignal.timeout(120000) });
      if (!res.ok || !res.body) throw new Error('Яндекс не отдал файл');
      return res.body;
    }
    const res = await call('GET', q('file', '&path=' + encodeURIComponent(it.path)));
    if (!res.body) throw new Error('Google не отдал файл');
    return res.body;
  }
  async function ensureDirs(rel) {
    const parts = rel.split('/'); parts.pop();
    let cur = '', parent = j.dirs[''] || mount.path;
    for (const part of parts) {
      cur = cur ? cur + '/' + part : part;
      if (j.dirs[cur]) { parent = j.dirs[cur]; continue; }
      const target = mount.kind === 'google' ? parent.replace(/\/?$/, '/') + part : parent.replace(/\/$/, '') + '/' + part;
      const r = await call('POST', q('mkdir'), { path: target });
      j.dirs[cur] = r.path || target; parent = j.dirs[cur]; await save();
    }
    return parent;
  }
  async function upload(rel, fp) {
    if (mount.perm !== 'write' || folder.perm !== 'write') return;
    const parent = await ensureDirs(rel);
    const name = rel.split('/').pop();
    const old = j.files[rel];
    const target = mount.kind === 'google' ? (old && old.remotePath ? old.remotePath : parent.replace(/\/?$/, '/') + name) : parent.replace(/\/$/, '') + '/' + name;
    const body = { path: target, mime: 'application/octet-stream', size: fp.size, existing: !!(old && old.remotePath) };
    const r = await call('POST', q('upload-url'), body);
    const url = r.url || r.href, method = r.method || 'PUT';
    const full = path.join(folder.local.root, rel);
    const stat = await fsp.stat(full);
    const res = await fetch(url, { method, headers: Object.assign({ 'Content-Type': 'application/octet-stream', 'Content-Length': String(stat.size) }, r.headers || {}), body: fs.createReadStream(full), duplex: 'half', signal: AbortSignal.timeout(300000) });
    if (!res.ok) throw new Error('Облако не приняло файл (' + res.status + ')');
    j.files[rel] = Object.assign({}, old, { localHash: fp.hash, hash: fp.hash, remotePath: (old && old.remotePath) || target, ver: 'uploaded:' + fp.hash });
    await save();
  }
  async function reconcile() {
    await load();
    const out = { files: [], dirs: [] };
    await listAll('', mount.path, 0, out);
    const seen = new Set();
    for (const d of out.dirs) {
      if (!j.dirs['seen:' + d]) {
        await folder.local.apply({ id: eid(d, 'mkdir'), folderId: folder.id, deviceId: mount.id, op: 'mkdir', path: d, keyRev: folder.keyRev });
        if (publish) await publish.mkdir(d);
        j.dirs['seen:' + d] = true; await save();
      }
    }
    for (const { rel, it } of out.files) {
      seen.add(rel);
      const old = j.files[rel];
      const v = ver(it);
      const local = await folder.local.fingerprintAt(rel);
      const remoteChanged = !old || old.ver !== v;
      const localChanged = !!(local && old && local.hash !== old.localHash);
      if (old && !remoteChanged) continue;          // облако не менялось — локальную правку отправим ниже
      if (Number(it.size) > maxBytes) continue;
      const tmp = path.join(stateDir, 'dl-' + crypto.randomBytes(8).toString('hex') + '.tmp');
      await fsp.mkdir(stateDir, { recursive: true });
      let fp;
      try { fp = await streamToFile(await remoteStream(it), tmp, maxBytes); }
      catch (e) { await fsp.unlink(tmp).catch(() => {}); throw e; }
      try {
        const event = { id: eid(rel, v + '|' + fp.hash), folderId: folder.id, deviceId: mount.id, op: 'put', path: rel, at: Date.now(), file: Object.assign({ mtimeMs: Date.parse(it.modified) || 0 }, fp), baseHash: old ? old.localHash : null, keyRev: folder.keyRev };
        const r = await folder.local.apply(event, () => fs.createReadStream(tmp));
        j.files[rel] = { remotePath: it.path, ver: v, hash: fp.hash, localHash: (r.action === 'conflict' || r.action === 'keep-local') ? ((local && local.hash) || fp.hash) : fp.hash };
        if (r.action === 'conflict') j.conflicts[rel] = { at: Date.now(), copy: r.copy };
        if (publish) {
          if (r.action === 'conflict' && r.copy) await publish.put(r.copy, null);
          else if (r.action === 'create' || r.action === 'update' || r.action === 'noop') await publish.put(rel, old ? old.localHash : null);
        }
        await save();
      } finally { await fsp.unlink(tmp).catch(() => {}); }
    }
    for (const [rel, old] of Object.entries(j.files)) {
      if (seen.has(rel) || j.pending['remote:' + rel] || j.pending['local:' + rel]) continue;
      const local = await folder.local.fingerprintAt(rel);
      if (local && local.hash === old.hash) {
        const event = { id: eid(rel, 'delete:' + old.hash), folderId: folder.id, deviceId: mount.id, op: 'delete', path: rel, at: Date.now(), file: { hash: old.hash, size: 0, mtimeMs: 0 }, keyRev: folder.keyRev };
        const r = await folder.local.apply(event);
        if (r.action === 'confirm-delete') j.pending['remote:' + rel] = { kind: 'cloud-remote-delete', rel, pendingId: r.pendingId, hash: old.hash, at: Date.now() };
        else { delete j.files[rel]; }
        await save();
      } else if (!local) {
        const base = folder.local.journal.bases[rel];
        if (base && base.deleted) { delete j.files[rel]; await save(); }
      }
    }
    const scan = await folder.local.scan();
    const scanSet = new Set(scan.files.map(f => f.path));
    for (const f of scan.files) {
      const old = j.files[f.path];
      if (old && old.localHash === f.hash) continue;
      await upload(f.path, f);
    }
    for (const [rel, old] of Object.entries(j.files)) {
      if (scanSet.has(rel)) continue;
      const base = folder.local.journal.bases[rel];
      if (base && base.deleted) { delete j.files[rel]; await save(); continue; }
      if (!j.pending['local:' + rel] && !j.pending['remote:' + rel]) {
        j.pending['local:' + rel] = { kind: 'cloud-local-delete', rel, hash: old.hash, remotePath: old.remotePath, at: Date.now() }; await save();
      }
    }
  }
  async function approve(id) {
    await load();
    const p = j.pending[id];
    if (!p) return false;
    if (p.kind === 'cloud-local-delete') {
      if (mount.perm !== 'write') throw new core.SyncError('read-only', 'Облачная папка открыта только на чтение');
      const local = await folder.local.fingerprintAt(p.rel);
      if (local) throw new core.SyncError('stale-delete', 'Файл вернулся — удаление отменено');
      await call('POST', q('delete'), { path: p.remotePath });
      await folder.local.setDeleted(p.rel, p.hash);
      if (publish) await publish.delete(p.rel, p.hash);
      delete j.files[p.rel];
    } else if (p.kind === 'cloud-remote-delete') {
      await folder.local.approveDelete(p.pendingId);
      if (publish) await publish.delete(p.rel, p.hash);
      delete j.files[p.rel];
    }
    delete j.pending[id]; await save();
    return true;
  }
  function pending() { return Object.entries(j ? j.pending : {}).map(([id, p]) => ({ id, kind: p.kind, path: p.rel, at: p.at })); }
  return { reconcile, approve, pending, load, get journal() { return j; } };
}
module.exports = { createCloudBridge };
