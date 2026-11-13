'use strict';
/** Фоновый помощник Windows. Запуск: node agent.js run --state <папка>.
 * Подключение: node agent.js pair --server https://… --code … --root … --name … --state … */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const core = require('./core');
const { createLocalFolder } = require('./local');
const { createVault } = require('./vault');
const { createCloudBridge } = require('./cloud');

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));
function args(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { a[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; }
    else a._.push(argv[i]);
  }
  return a;
}
function defaultState() {
  return process.env.SEGA_SYNC_STATE || (process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || os.homedir(), 'SEGA-CHAT-Sync')
    : path.join(__dirname, 'state'));
}
async function jsonAtomic(file, obj) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(obj), { mode: 0o600 });
  await fsp.rename(tmp, file);
}
async function readJson(file, fallback) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}

function createTransport(server, token) {
  const base = String(server || '').replace(/\/+$/, '');
  return async function call(method, p, body) {
    const r = await fetch(base + p, {
      method, headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000)
    });
    const ct = r.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      if (!r.ok) throw new Error('Сервер ответил ' + r.status);
      return r;
    }
    const d = await r.json();
    if (!r.ok) { const e = new Error(d.error || 'Ошибка сервера'); e.status = r.status; throw e; }
    return d;
  };
}

async function pair(opts) {
  const stateDir = path.resolve(opts.state || defaultState());
  const vault = createVault(stateDir, { win32: opts.win32 });
  let v = await vault.load();
  if (v && v.token && !opts.force) throw new Error('Помощник уже подключён. Отзовите компьютер в чате или запустите с --force');
  const server = String(opts.server || '').replace(/\/+$/, '');
  if (!/^https:\/\//i.test(server) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(server)) throw new Error('Адрес сервера должен начинаться с https://');
  const root = path.resolve(String(opts.root || ''));
  const st = await fsp.lstat(root).catch(() => null);
  if (!st || !st.isDirectory() || st.isSymbolicLink()) throw new Error('Выберите существующую обычную папку');
  const keys = core.generateDeviceKeys();
  const call = createTransport(server);
  const r = await call('POST', '/api/sync/pair/claim', { code: String(opts.code || '').trim(), name: String(opts.name || os.hostname()).slice(0, 80), pub: keys.pub });
  v = { server, deviceId: r.deviceId, token: r.token, priv: keys.priv, pub: keys.pub, root, folders: {} };
  await vault.save(v);
  await jsonAtomic(path.join(stateDir, 'config.json'), { server, root, name: opts.name || os.hostname() });
  return { stateDir, deviceId: r.deviceId };
}

function createAgent(opts) {
  const stateDir = path.resolve(opts.stateDir);
  const vault = opts.vault || createVault(stateDir, { win32: opts.win32 });
  const callFactory = opts.callFactory || createTransport;
  let v = null, call = null, stopped = false, locked = false;
  const folders = new Map();
  const log = opts.log || (() => {});
  const limits = Object.assign({ maxFiles: 20000, maxDepth: core.MAX_DEPTH, maxFileBytes: 128 * 1024 * 1024 }, opts.limits || {});

  async function acquire() {
    await fsp.mkdir(stateDir, { recursive: true, mode: 0o700 });
    const lock = path.join(stateDir, 'agent.lock');
    try {
      await fsp.writeFile(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const pid = Number(await fsp.readFile(lock, 'utf8').catch(() => 0));
      let alive = false;
      if (pid > 0) { try { process.kill(pid, 0); alive = true; } catch (x) { alive = x.code === 'EPERM'; } }
      if (alive) throw new Error('Помощник уже запущен');
      await fsp.unlink(lock).catch(() => {});
      await fsp.writeFile(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
    }
    locked = true;
  }
  async function release() {
    for (const f of folders.values()) { try { await f.local.release(); } catch (e) {} if (f.watcher) f.watcher.close(); }
    folders.clear();
    if (locked) await fsp.unlink(path.join(stateDir, 'agent.lock')).catch(() => {});
    locked = false;
  }
  async function load() {
    v = await vault.load();
    if (!v || !v.token) throw new Error('Помощник не подключён к чату');
    call = callFactory(v.server, v.token);
    limits.maxFileBytes = Math.min(limits.maxFileBytes, 128 * 1024 * 1024);
  }
  async function ensureFolder(cf) {
    let f = folders.get(cf.id);
    const root = (v.folders && v.folders[cf.id] && v.folders[cf.id].root) || v.root;
    if (!root) throw new Error('Для папки не выбрана папка на этом компьютере');
    if (cf.needsRotation) { if (f) f.paused = true; return f || null; }
    if (!f || f.keyRev !== cf.keyRev || f.root !== root) {
      if (f) { await f.local.release(); if (f.watcher) f.watcher.close(); }
      const key = core.openFor(v.priv, cf.wrap.pub, cf.wrap.blob);
      const local = createLocalFolder({ root, stateDir: path.join(stateDir, 'folders', cf.id), folderId: cf.id, deviceId: v.deviceId, limits });
      await local.init(); await local.acquire();
      const saved = (v.folders && v.folders[cf.id]) || {};
      f = { id: cf.id, key, keyRev: cf.keyRev, root, local, limits, paused: !!saved.paused, dirty: true, lastScan: 0, error: '', watcher: null, deviceRev: 0, mounts: [], bridges: new Map(), cloudAt: 0 };
      folders.set(cf.id, f);
      v.folders = v.folders || {}; v.folders[cf.id] = { root, keyRev: cf.keyRev };
      await vault.save(v);
      try {
        f.watcher = fs.watch(root, { recursive: true }, () => { f.dirty = true; });
        f.watcher.on('error', () => { f.dirty = true; });
      } catch (e) { f.watcher = null; }
    }
    f.perm = cf.perm; f.mounts = cf.mounts || [];
    if (f.deviceRev !== cf.deviceRev) { f.deviceRev = cf.deviceRev; f.dirty = true; f.resync = true; }
    return f;
  }

  async function uploadFile(f, rel, fp, baseHash) {
    // Одна и та же версия файла получает одну метку события: повтор после обрыва
    // сети не плодит копии в очереди и не тратит место на сервере дважды.
    const eid = 'e_' + sha(f.id + '|' + v.deviceId + '|' + rel + '|' + fp.hash + '|' + (baseHash || '') + '|' + f.keyRev).slice(0, 40);
    const full = path.join(f.local.root, rel);
    const chunks = [];
    const keys = [];
    const fh = await fsp.open(full, 'r');
    try {
      let i = 0, pos = 0;
      while (pos < fp.size) {
        const want = Math.min(core.CHUNK_PLAIN, fp.size - pos);
        const buf = Buffer.alloc(want);
        const { bytesRead } = await fh.read(buf, 0, want, pos);
        if (bytesRead !== want) throw new core.SyncError('changed', 'Файл изменился во время чтения');
        const env = core.sealChunk(f.key, f.id, eid, i, buf);
        const key = sha(f.id + '|' + eid + '|' + i + '|' + env.ct);
        const up = await call('POST', '/api/sync/agent/blob', { folderId: f.id, eventId: eid, index: i, key, data: env });
        if (!up || !up.ok) throw new core.SyncError('upload', 'Сервер не принял кусок файла');
        chunks.push({ i, key, hash: sha(buf), size: bytesRead });
        keys.push(key);
        pos += bytesRead; i++;
      }
    } finally { await fh.close(); }
    const after = await f.local.fingerprintAt(rel);
    if (!after || after.hash !== fp.hash) throw new core.SyncError('changed', 'Файл изменился во время отправки');
    const event = { id: eid, folderId: f.id, deviceId: v.deviceId, op: 'put', path: rel, at: Date.now(), file: fp, baseHash: baseHash || null, keyRev: f.keyRev, chunks };
    const sent = await call('POST', '/api/sync/agent/event', { folderId: f.id, envelope: core.sealEvent(f.key, event), blobKeys: keys });
    if (!sent || !sent.ok) throw new core.SyncError('upload', 'Сервер не принял событие файла');
    await f.local.setBase(rel, fp);
  }
  async function publishScan(f, force) {
    const scan = await f.local.scan();
    const j = f.local.journal;
    const seen = new Set();
    for (const d of scan.dirs) {
      if (!j.dirs[d] || force) {
        const event = { id: 'e_' + sha(f.id + '|' + v.deviceId + '|mkdir|' + d + '|' + f.keyRev).slice(0, 40), folderId: f.id, deviceId: v.deviceId, op: 'mkdir', path: d, at: Date.now(), keyRev: f.keyRev };
        await call('POST', '/api/sync/agent/event', { folderId: f.id, envelope: core.sealEvent(f.key, event), blobKeys: [] });
        await f.local.markDir(d);
      }
    }
    for (const file of scan.files) {
      seen.add(file.path);
      const base = j.bases[file.path];
      if (!force && base && !base.deleted && base.hash === file.hash) continue;
      if (f.perm !== 'write') continue;
      await uploadFile(f, file.path, file, base && !base.deleted ? base.hash : null);
    }
    if (f.perm === 'write') for (const [rel, base] of Object.entries(j.bases)) {
      if (base.deleted || seen.has(rel)) continue;
      const now = await f.local.fingerprintAt(rel);
      if (!now) await f.local.noteLocalDelete(rel, base.hash);
    }
    f.lastScan = Date.now(); f.dirty = false; f.resync = false; f.skipped = scan.skipped;
  }
  async function downloadEvent(f, item, event) {
    const dir = path.join(stateDir, 'incoming');
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(dir, item.id + '.tmp');
    await fsp.unlink(tmp).catch(() => {});   // недокачка прошлого раза не мешает повтору
    const fh = await fsp.open(tmp, 'wx', 0o600);
    const h = crypto.createHash('sha256');
    let size = 0;
    try {
      const manifest = Array.isArray(event.chunks) ? event.chunks : [];
      if (event.file.size > 0 && !manifest.length) throw new core.SyncError('chunks', 'В событии нет списка кусков');
      for (let i = 0; i < manifest.length; i++) {
        const c = manifest[i];
        if (!c || c.i !== i || typeof c.key !== 'string' || !/^[a-f0-9]{64}$/.test(c.key)) throw new core.SyncError('chunks', 'Повреждён список кусков');
        const env = await call('GET', '/api/sync/agent/blob-get?key=' + encodeURIComponent(c.key));
        const buf = core.openChunk(f.key, f.id, event.id, i, env);
        if (buf.length !== c.size || sha(buf) !== c.hash) throw new core.SyncError('chunk-hash', 'Кусок файла не совпал с описанием');
        size += buf.length; h.update(buf); await fh.write(buf);
      }
      if (size !== event.file.size || h.digest('hex') !== event.file.hash) throw new core.SyncError('checksum', 'Файл не совпал с описанием');
      await fh.sync(); await fh.close();
      return tmp;
    } catch (e) { await fh.close().catch(() => {}); await fsp.unlink(tmp).catch(() => {}); throw e; }
  }
  async function receive(f) {
    const r = await call('GET', '/api/sync/agent/queue?limit=100');
    for (const item of r.events || []) {
      if (item.folderId !== f.id) continue;
      let event;
      try { event = core.openEvent(f.key, item.envelope); }
      catch (e) { f.error = 'Событие не открылось ключом этой папки'; f.hadError = true; continue; }
      if (event.keyRev !== f.keyRev) { f.error = 'Событие старой версии ключа'; f.hadError = true; continue; }
      let tmp = null;
      try {
        let result;
        if (event.op === 'put') {
          tmp = await downloadEvent(f, item, event);
          result = await f.local.apply(event, () => fs.createReadStream(tmp));
          if (result.action === 'confirm-restore') {
            const pd = path.join(stateDir, 'pending'); await fsp.mkdir(pd, { recursive: true, mode: 0o700 });
            await fsp.rename(tmp, path.join(pd, event.id + '.bin')); tmp = null;
          }
        } else result = await f.local.apply(event);
        await call('POST', '/api/sync/agent/ack', { ids: [item.seq] });
        f.dirty = true;
        log('apply', result.action, event.path);
      } catch (e) { f.error = e.message || String(e); f.hadError = true; log('receive-error', e.message); }
      finally { if (tmp) await fsp.unlink(tmp).catch(() => {}); }
    }
  }
  async function ensureBridges(f) {
    const live = new Set();
    for (const m of f.mounts || []) {
      live.add(m.id);
      let bridge = f.bridges.get(m.id);
      if (!bridge) {
        bridge = createCloudBridge({
          call, folder: f, mount: m, stateDir: path.join(stateDir, 'cloud', m.id), deviceId: v.deviceId,
          publish: {
            put: async (rel, baseHash) => { if (f.perm === 'write') { const fp = await f.local.fingerprintAt(rel); if (fp) await uploadFile(f, rel, fp, baseHash || null); } },
            mkdir: async rel => { if (f.perm === 'write') { const event = { id: 'e_' + sha(f.id + '|' + v.deviceId + '|mkdir|' + rel + '|' + f.keyRev).slice(0, 40), folderId: f.id, deviceId: v.deviceId, op: 'mkdir', path: rel, at: Date.now(), keyRev: f.keyRev }; await call('POST', '/api/sync/agent/event', { folderId: f.id, envelope: core.sealEvent(f.key, event), blobKeys: [] }); } },
            delete: async (rel, hash) => { if (f.perm === 'write') { const event = { id: 'e_' + sha(f.id + '|' + v.deviceId + '|delete|' + rel + '|' + hash + '|' + f.keyRev).slice(0, 40), folderId: f.id, deviceId: v.deviceId, op: 'delete', path: rel, at: Date.now(), file: { hash, size: 0, mtimeMs: 0 }, keyRev: f.keyRev }; await call('POST', '/api/sync/agent/event', { folderId: f.id, envelope: core.sealEvent(f.key, event), blobKeys: [] }); } }
          }
        });
        f.bridges.set(m.id, bridge);
      }
      await bridge.load();
    }
    for (const id of f.bridges.keys()) if (!live.has(id)) f.bridges.delete(id);
  }
  async function saveFolderFlag(f, name, value) {
    v.folders = v.folders || {};
    v.folders[f.id] = Object.assign({}, v.folders[f.id], { [name]: value });
    await vault.save(v);
  }
  async function commands(f) {
    const r = await call('GET', '/api/sync/agent/commands');
    const done = [];
    for (const c of r.commands || []) {
      if (c.folderId !== f.id) continue;
      try {
        if (c.t === 'pause') { f.paused = true; await saveFolderFlag(f, 'paused', true); }
        else if (c.t === 'resume') { f.paused = false; f.dirty = true; await saveFolderFlag(f, 'paused', false); }
        else if (c.t === 'resync') { f.dirty = true; f.resync = true; }
        else if (c.t === 'approve') {
          let cloudDone = false;
          for (const br of f.bridges.values()) { if (await br.approve(c.pendingId)) { cloudDone = true; break; } }
          if (cloudDone) { done.push(c.id); f.dirty = true; continue; }
          const p = f.local.journal.pending[c.pendingId];
          if (!p) { done.push(c.id); continue; }
          if (p.kind === 'delete') await f.local.approveDelete(c.pendingId);
          else if (p.kind === 'local-delete') {
            const rr = await f.local.approveLocalDelete(c.pendingId);
            if (f.perm === 'write') {
              const event = { id: 'e_' + sha(f.id + '|' + v.deviceId + '|delete|' + rr.path + '|' + rr.expectedHash + '|' + f.keyRev).slice(0, 40), folderId: f.id, deviceId: v.deviceId, op: 'delete', path: rr.path, at: Date.now(), file: { hash: rr.expectedHash, size: 0, mtimeMs: 0 }, keyRev: f.keyRev };
              await call('POST', '/api/sync/agent/event', { folderId: f.id, envelope: core.sealEvent(f.key, event), blobKeys: [] });
            }
          } else if (p.kind === 'restore') {
            const file = path.join(stateDir, 'pending', p.eventId + '.bin');
            await f.local.approveRestore(c.pendingId, () => fs.createReadStream(file));
            await fsp.unlink(file).catch(() => {});
          }
          f.dirty = true;
        }
        done.push(c.id);
      } catch (e) { f.error = e.message || String(e); }
    }
    if (done.length) await call('POST', '/api/sync/agent/commands/ack', { ids: done });
  }
  async function status() {
    const list = [];
    for (const f of folders.values()) {
      const j = f.local.journal;
      const cloudPending = [];
      for (const br of f.bridges.values()) cloudPending.push(...br.pending());
      const st = { paused: !!f.paused, error: f.error || '', lastScan: f.lastScan || 0,
        pending: Object.values(j.pending).map(p => ({ id: p.eventId, kind: p.kind, path: p.path, at: p.at })).concat(cloudPending),
        conflicts: Object.values(j.conflicts || {}).slice(-50), skipped: (f.skipped || []).slice(0, 50) };
      list.push({ id: f.id, state: core.sealOpaque(f.key, st) });
    }
    await call('POST', '/api/sync/agent/status', { folders: list });
  }
  async function tick() {
    if (!v) await load();
    const cfg = await call('GET', '/api/sync/agent/config');
    if (cfg.limits && cfg.limits.file) limits.maxFileBytes = Math.min(limits.maxFileBytes, cfg.limits.file);
    const live = new Set();
    for (const cf of cfg.folders || []) {
      live.add(cf.id);
      let f;
      try { f = await ensureFolder(cf); } catch (e) { log('folder-error', e.message); continue; }
      if (!f) continue;
      try {
        await ensureBridges(f);
        await commands(f);
        if (!f.paused) {
          await receive(f);
          const due = f.dirty || f.resync || Date.now() - f.lastScan > 60000;
          if (due) await publishScan(f, !!f.resync);
          if (Date.now() - f.cloudAt > 60000) {
            f.cloudAt = Date.now();
            for (const bridge of f.bridges.values()) await bridge.reconcile();
            f.dirty = true;   // облачные изменения уйдут остальным ПК следующим проходом
          }
        }
        if (!f.hadError) f.error = '';
        f.hadError = false;
      } catch (e) { f.error = e.message || String(e); log('tick-error', f.error); }
    }
    for (const [id, f] of folders) if (!live.has(id)) { await f.local.release(); if (f.watcher) f.watcher.close(); folders.delete(id); }
    await status();
  }
  async function run() {
    await acquire(); await load();
    let delay = 3000, last = Date.now();
    while (!stopped) {
      if (fs.existsSync(path.join(stateDir, 'stop.flag'))) { stopped = true; break; }
      const now = Date.now();
      if (now - last > 30000) for (const f of folders.values()) f.dirty = true;
      last = now;
      try { await tick(); delay = 3000; }
      catch (e) { log('offline', e.message); delay = Math.min(60000, Math.round(delay * 1.7)); }
      const step = Math.min(delay, 1000);
      for (let t = 0; t < delay && !stopped; t += step) await sleep(step);
    }
    await release();
  }
  function stop() { stopped = true; }
  return { run, tick, stop, acquire, release, load, get folders() { return folders; } };
}

async function main() {
  const a = args(process.argv.slice(2));
  const cmd = a._[0] || 'run';
  if (cmd === 'pair') {
    const r = await pair({ state: a.state, server: a.server, code: a.code, root: a.root, name: a.name });
    console.log('Компьютер подключён: ' + r.deviceId);
    return;
  }
  if (cmd === 'run') {
    const agent = createAgent({ stateDir: a.state || defaultState() });
    process.on('SIGINT', () => agent.stop());
    process.on('SIGTERM', () => agent.stop());
    await agent.run();
    return;
  }
  throw new Error('Команда: pair или run');
}
if (require.main === module) main().catch(e => { console.error(e.message || e); process.exit(1); });
module.exports = { createAgent, pair, createTransport, defaultState, args };
