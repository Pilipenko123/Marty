'use strict';
/**
 * SEGA-CHAT · синхронизация папок (pkg3-154).
 * Сервер хранит только зашифрованные события/куски, свёртки ключей и очередь.
 * Ключ папки живёт у владельца и разрешённых помощников. Помощник ходит по
 * собственному отзываемому пропуску, а не по паролю участника.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { PassThrough, Readable } = require('stream');
const core = require('../helper/core');
const zipLib = require('./zip');

const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const rid = p => p + crypto.randomBytes(12).toString('hex');
const b64len = s => { try { return Buffer.from(String(s || ''), 'base64').length; } catch (e) { return 0; } };
const isId = s => /^[a-zA-Z0-9_-]{8,80}$/.test(String(s || ''));
const isWrap = w => w && typeof w === 'object' && isId(w.by) && typeof w.blob === 'string' && w.blob.length <= 200 && b64len(w.blob) === 60;

function createSync(ctx) {
  const { getDb, auth, save, J, E, throttle, store } = ctx;
  const MB = 1024 * 1024;
  const CHUNK_MAX = core.CHUNK_PLAIN + 16;
  const QUEUE_DEVICE = Number(process.env.SYNC_QUEUE_DEVICE || 128 * MB);
  const QUEUE_FOLDER = Number(process.env.SYNC_QUEUE_FOLDER || 256 * MB);
  const QUEUE_TOTAL = Number(process.env.SYNC_QUEUE_TOTAL || 512 * MB);
  const FILE_MAX = Number(process.env.SYNC_FILE_MAX || 128 * MB);
  const TTL = Number(process.env.SYNC_TTL || 7 * 24 * 60 * 60 * 1000);
  const LIMITS = { chunk: core.CHUNK_PLAIN, file: FILE_MAX, queueDevice: QUEUE_DEVICE, queueFolder: QUEUE_FOLDER };

  function S() {
    const db = getDb();
    if (!db.sync || typeof db.sync !== 'object') db.sync = {};
    const s = db.sync;
    for (const k of ['pairs', 'devices', 'folders', 'queue', 'blobs', 'commands', 'shares']) if (!s[k] || typeof s[k] !== 'object') s[k] = {};
    if (!Number.isSafeInteger(s.seq)) s.seq = 0;
    return s;
  }
  function unref(k) {
    const s = S(), b = s.blobs[k];
    if (!b) return;
    b.refs = Math.max(0, (b.refs || 0) - 1);
    if (b.refs <= 0) delBlob(k);
  }
  function delBlob(k) {
    const s = S();
    delete s.blobs[k];
    if (store.delSyncBlob) Promise.resolve(store.delSyncBlob(k)).catch(() => {});
  }
  function dropFolderQueue(s, fid) {
    for (const did of Object.keys(s.queue)) {
      const keep = [];
      for (const e of s.queue[did]) {
        if (e.folderId === fid) { for (const k of e.blobs || []) unref(k); }
        else keep.push(e);
      }
      s.queue[did] = keep;
    }
    for (const [k, b] of Object.entries(s.blobs)) if (b.folderId === fid) delBlob(k);
  }
  function gc() {
    const s = S(), now = Date.now();
    let changed = false;
    for (const [k, p] of Object.entries(s.pairs)) if (p.exp < now || p.used) { delete s.pairs[k]; changed = true; }
    for (const [did, q] of Object.entries(s.queue)) {
      const keep = [];
      for (const e of q) {
        if (now - e.at > TTL) { for (const k of e.blobs || []) unref(k); changed = true; }
        else keep.push(e);
      }
      if (keep.length !== q.length) { s.queue[did] = keep; changed = true; }
    }
    for (const [k, b] of Object.entries(s.blobs)) if ((b.refs || 0) <= 0 && now - b.at > 60 * 60 * 1000) { delBlob(k); changed = true; }
    for (const f of Object.values(s.folders)) {
      if (!f.events) f.events = {};
      for (const [eid, e] of Object.entries(f.events)) if (now - e.at > TTL) { delete f.events[eid]; changed = true; }
    }
    for (const [sid, sh] of Object.entries(s.shares)) if (sh.state !== 'done' && now - sh.createdAt > TTL) { delete s.shares[sid]; changed = true; }
    if (changed) save();
  }
  function folderForDevice(s, f, did) { return !!(f && f.wraps && f.wraps[did] && s.devices[did] && !s.devices[did].revoked && !f.needsRotation); }
  function perm(f, uid) { return f && f.perm && f.perm[uid] || ''; }
  function queueBytes(s, did) { return (s.queue[did] || []).reduce((a, e) => a + (e.size || 0), 0); }
  function totalBytes(s) { return Object.values(s.blobs).reduce((a, b) => a + (b.size || 0), 0); }
  function folderBytes(s, fid) { return Object.values(s.blobs).reduce((a, b) => a + (b.folderId === fid ? b.size : 0), 0); }
  function bump(s, f) { f.deviceRev = (f.deviceRev || 1) + 1; }
  function resyncCommands(s, f, except) {
    for (const did of Object.keys(f.wraps || {})) {
      if (did === except || !s.devices[did] || s.devices[did].revoked) continue;
      if (!s.commands[did]) s.commands[did] = [];
      if (!s.commands[did].some(c => c.t === 'resync' && c.folderId === f.id)) s.commands[did].push({ id: rid('c_'), t: 'resync', folderId: f.id, at: Date.now() });
    }
  }
  async function user(req) {
    const a = await auth(req);
    if (!a) return null;
    if (a.banned) { const e = new Error('Доступ ограничен'); e.statusCode = 403; throw e; }
    return a.user;
  }
  function device(req) {
    const h = req.headers['authorization'] || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (!token.startsWith('sd_')) return null;
    const s = S(), hash = sha(token);
    const d = Object.values(s.devices).find(x => x.tokenHash === hash && !x.revoked);
    if (!d) return null;
    const now = Date.now();
    if (now - (d.lastSeen || 0) > 60000) { d.lastSeen = now; save(); }
    return d;
  }
  function ownDevice(s, uid, did) { const d = s.devices[did]; return d && d.uid === uid && !d.revoked ? d : null; }
  function commonChat(db, a, b) { return db.chats.some(c => Array.isArray(c.members) && c.members.includes(a) && c.members.includes(b)); }
  function pubOf(db, uid) { const u = db.users.find(x => x.id === uid); return u && u.pub || ''; }
  function validUserWrap(w) { return typeof w === 'string' && w.length <= 200 && b64len(w) === 60; }

  async function handle(req, pathname, query, method) {
    if (store.name !== 'file') return E(503, 'Синхронизация папок доступна на основном сервере с файловым хранилищем');
    gc();
    const body = req.body || {};
    const db = getDb();
    const s = S();

    if (pathname === '/api/sync/download' && method === 'GET') {
      if (throttle('sync-dl-' + (req.ip || ''), 30)) return E(429, 'Слишком много скачиваний — подождите');
      const dir = ctx.helperDir;
      const out = new PassThrough();
      const zip = new zipLib.ZipWriter(out);
      const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
      const host = String(req.headers.host || 'localhost').split(',')[0].trim();
      (async () => {
        const files = [];
        (function walk(rel) {
          for (const ent of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
            if (['runtime', 'state', 'node_modules', '.git'].includes(ent.name)) continue;
            const r = rel ? rel + '/' + ent.name : ent.name;
            if (ent.isDirectory()) walk(r); else if (ent.isFile()) files.push(r);
          }
        })('');
        files.sort();
        for (const r of files) await zip.addFile('SEGA-CHAT-Sync/' + r, () => fs.createReadStream(path.join(dir, r)));
        await zip.addFile('SEGA-CHAT-Sync/server.txt', () => Readable.from([Buffer.from(proto + '://' + host + '\n')]));
        await zip.end();
        out.end();
      })().catch(e => out.destroy(e));
      return { status: 200, cap: 8 * 1024 * 1024, pipe: { stream: out, abort() { out.destroy(); } }, headers: { 'Content-Type': 'application/zip', 'Content-Disposition': zipLib.disposition('SEGA-CHAT-Sync'), 'Cache-Control': 'no-store' } };
    }

    if (pathname === '/api/sync/pair/init' && method === 'POST') {
      const u = await user(req); if (!u) return E(401, 'Войдите в чат');
      if (throttle('sync-pair-' + u.id, 20)) return E(429, 'Слишком много кодов — подождите');
      if (Object.values(s.devices).filter(d => d.uid === u.id && !d.revoked).length >= 12) return E(409, 'Уже подключено 12 компьютеров — отзовите лишний');
      const code = crypto.randomBytes(24).toString('base64url');
      const exp = Date.now() + 10 * 60 * 1000;
      s.pairs[sha(code)] = { uid: u.id, exp, used: false };
      save(); return J(200, { code, expiresAt: exp });
    }
    if (pathname === '/api/sync/pair/claim' && method === 'POST') {
      if (throttle('sync-claim-' + (req.ip || ''), 30)) return E(429, 'Слишком много попыток — подождите');
      const code = String(body.code || '').trim();
      const p = s.pairs[sha(code)];
      if (!p || p.used || p.exp < Date.now()) return E(403, 'Код подключения неверен или истёк');
      const name = String(body.name || 'Компьютер').trim().slice(0, 80);
      const pub = String(body.pub || '');
      try { core.publicKeyFromRaw(pub); } catch (e) { return E(400, 'Неверный открытый ключ компьютера'); }
      if (!name) return E(400, 'Нужно имя компьютера');
      const did = rid('d_'), token = 'sd_' + crypto.randomBytes(32).toString('base64url');
      s.devices[did] = { id: did, uid: p.uid, name, pub, tokenHash: sha(token), createdAt: Date.now(), lastSeen: Date.now(), revoked: false };
      p.used = true; save();
      return J(200, { deviceId: did, token, limits: LIMITS });
    }

    const dev = device(req);
    if (pathname.startsWith('/api/sync/agent/')) {
      if (!dev) return E(401, 'Пропуск компьютера неверен или отозван');
      if (pathname === '/api/sync/agent/config' && method === 'GET') {
        const folders = Object.values(s.folders).filter(f => f.wraps && f.wraps[dev.id] && !s.devices[dev.id].revoked).map(f => ({
          id: f.id, name: f.name, perm: perm(f, dev.uid) || 'read', wrap: Object.assign({}, f.wraps[dev.id], { pub: pubOf(db, f.wraps[dev.id].by) }),
          keyRev: f.keyRev || 1, deviceRev: f.deviceRev || 1, needsRotation: !!f.needsRotation, mounts: f.needsRotation || dev.uid !== f.owner ? [] : (f.mounts || [])
        }));
        return J(200, { deviceId: dev.id, folders, limits: LIMITS });
      }
      if (pathname === '/api/sync/agent/status' && method === 'POST') {
        const list = Array.isArray(body.folders) ? body.folders.slice(0, 20) : [];
        const mine = new Set(Object.values(s.folders).filter(f => folderForDevice(s, f, dev.id)).map(f => f.id));
        dev.status = { at: Date.now(), folders: list.filter(x => x && isId(x.id) && mine.has(String(x.id)) && typeof x.state === 'string' && x.state.length <= 300000).map(x => ({ id: String(x.id), state: String(x.state) })) };
        save(); return J(200, { ok: true });
      }
      if (pathname === '/api/sync/agent/commands' && method === 'GET') return J(200, { commands: (s.commands[dev.id] || []).slice(0, 50) });
      if (pathname === '/api/sync/agent/commands/ack' && method === 'POST') {
        const ids = new Set((Array.isArray(body.ids) ? body.ids : []).map(String));
        s.commands[dev.id] = (s.commands[dev.id] || []).filter(c => !ids.has(c.id));
        save(); return J(200, { ok: true });
      }
      if (pathname === '/api/sync/agent/blob' && method === 'POST') {
        const f = s.folders[String(body.folderId || '')];
        if (!f || !folderForDevice(s, f, dev.id)) return E(403, 'Папка не открыта этому компьютеру');
        if (perm(f, dev.uid) !== 'write') return E(403, 'Этому компьютеру разрешено только получение');
        const eid = String(body.eventId || ''), index = Number(body.index);
        if (!isId(eid) || !Number.isSafeInteger(index) || index < 0 || index > Math.ceil(FILE_MAX / core.CHUNK_PLAIN)) return E(400, 'Неверная метка куска');
        const data = body.data, key = String(body.key || '');
        const size = b64len(data && data.ct);
        if (!data || data.v !== 1 || b64len(data.iv) !== 12 || size < 17 || size > CHUNK_MAX) return E(400, 'Неверный зашифрованный кусок');
        if (key !== sha(f.id + '|' + eid + '|' + index + '|' + data.ct)) return E(400, 'Ключ куска не совпал с содержимым');
        const old = s.blobs[key];
        if (old) {
          if (old.folderId !== f.id || old.eventId !== eid || old.index !== index) return E(409, 'Кусок уже занят другим событием');
          return J(200, { ok: true, key, duplicate: true });
        }
        if (folderBytes(s, f.id) + size > QUEUE_FOLDER || totalBytes(s) + size > QUEUE_TOTAL) return E(507, 'Очередь папки заполнена — дождитесь получения на других компьютерах');
        if (!store.putSyncBlob) return E(503, 'Хранилище кусков недоступно');
        await store.putSyncBlob(key, Buffer.from(JSON.stringify(data)));
        s.blobs[key] = { folderId: f.id, eventId: eid, index, owner: f.owner, size, refs: 0, at: Date.now() };
        save(); return J(200, { ok: true, key });
      }
      if (pathname === '/api/sync/agent/event' && method === 'POST') {
        const f = s.folders[String(body.folderId || '')];
        if (!f || !folderForDevice(s, f, dev.id)) return E(403, 'Папка не открыта этому компьютеру');
        if (perm(f, dev.uid) !== 'write') return E(403, 'Этому компьютеру разрешено только получение');
        const env = body.envelope;
        if (!env || env.v !== 1 || env.alg !== 'A256GCM' || !env.context || env.context.folderId !== f.id || env.context.deviceId !== dev.id
          || env.context.keyRev !== (f.keyRev || 1) || !/^[a-f0-9]{64}$/.test(String(env.context.pathHash || ''))
          || b64len(env.iv) !== 12 || b64len(env.ct) < 17 || b64len(env.ct) > core.MAX_EVENT_BYTES + 16) return E(400, 'Неверный конверт события');
        const eid = String(env.context.eventId || '');
        if (!isId(eid)) return E(400, 'Неверная метка события');
        if (f.events && f.events[eid]) return J(200, { ok: true, duplicate: true, queued: 0 });
        const keys = (Array.isArray(body.blobKeys) ? body.blobKeys : []).map(String);
        if (keys.length !== new Set(keys).size || keys.length > Math.ceil(FILE_MAX / core.CHUNK_PLAIN) + 1) return E(400, 'Неверный список кусков');
        let size = 0;
        for (let i = 0; i < keys.length; i++) {
          const b = s.blobs[keys[i]];
          if (!b || b.folderId !== f.id || b.eventId !== eid || b.index !== i) return E(400, 'Кусок не принадлежит событию');
          size += b.size;
        }
        if (size > Math.ceil(FILE_MAX / core.CHUNK_PLAIN) * CHUNK_MAX + keys.length * 64) return E(413, 'Файл больше разрешённого размера');
        const targets = Object.keys(f.wraps || {}).filter(did => did !== dev.id && s.devices[did] && !s.devices[did].revoked);
        for (const did of targets) if (queueBytes(s, did) + size > QUEUE_DEVICE) return E(507, 'Очередь компьютера-получателя заполнена');
        if (!f.events) f.events = {};
        f.events[eid] = { at: Date.now(), from: dev.id };
        let queued = 0;
        for (const did of targets) {
          if (!s.queue[did]) s.queue[did] = [];
          s.seq++;
          s.queue[did].push({ seq: s.seq, id: eid, folderId: f.id, from: dev.id, keyRev: f.keyRev || 1, envelope: env, blobs: keys, size, at: Date.now() });
          for (const k of keys) if (s.blobs[k]) s.blobs[k].refs = (s.blobs[k].refs || 0) + 1;
          queued++;
        }
        if (!targets.length) for (const k of keys) delBlob(k);
        save(); return J(200, { ok: true, queued });
      }
      if (pathname === '/api/sync/agent/queue' && method === 'GET') {
        const after = Number(query.get('after') || 0);
        const limit = Math.min(100, Math.max(1, Number(query.get('limit') || 20)));
        const list = (s.queue[dev.id] || []).filter(e => e.seq > after).slice(0, limit);
        return J(200, { events: list });
      }
      if (pathname === '/api/sync/agent/ack' && method === 'POST') {
        const ids = new Set((Array.isArray(body.ids) ? body.ids : []).map(Number));
        const keep = [];
        for (const e of s.queue[dev.id] || []) {
          if (ids.has(e.seq)) { for (const k of e.blobs || []) unref(k); }
          else keep.push(e);
        }
        s.queue[dev.id] = keep; save(); return J(200, { ok: true });
      }
      if (pathname === '/api/sync/agent/blob-get' && method === 'GET') {
        const key = String(query.get('key') || ''), b = s.blobs[key];
        if (!b) return E(404, 'Кусок не найден или уже получен');
        const f = s.folders[b.folderId];
        if (!f || !folderForDevice(s, f, dev.id)) return E(403, 'Папка не открыта этому компьютеру');
        if (!(s.queue[dev.id] || []).some(e => (e.blobs || []).includes(key))) return E(403, 'Кусок не адресован этому компьютеру');
        const buf = await store.getSyncBlob(key);
        if (!buf) return E(404, 'Кусок не найден');
        return J(200, JSON.parse(buf.toString('utf8')));
      }
      if (pathname.startsWith('/api/sync/agent/cloud/')) {
        const f = s.folders[String(query.get('folderId') || body.folderId || '')];
        if (!f || !folderForDevice(s, f, dev.id)) return E(403, 'Папка не открыта этому компьютеру');
        if (dev.uid !== f.owner) return E(403, 'Облачный мост работает только на компьютере владельца');
        const mount = (f.mounts || []).find(m => m.id === String(query.get('mountId') || body.mountId || ''));
        if (!mount) return E(404, 'Облачная папка не подключена');
        const owner = db.users.find(u => u.id === f.owner);
        if (!owner) return E(404, 'Владелец папки не найден');
        const canWrite = perm(f, dev.uid) === 'write' && mount.perm === 'write';
        const rawPath = String(query.get('path') || body.path || mount.path);
        try {
          if (mount.kind === 'yandex') {
            const tok = await ctx.ydFreshToken(owner, ctx.yadisk.loadKeys(), mount.slot);
            if (!tok) return E(409, 'Яндекс.Диск владельца не подключён');
            const p = ctx.yadisk.safePath(rawPath);
            if (!p || !insideYandex(p, mount.path)) return E(400, 'Путь вне выбранной облачной папки');
            if (pathname.endsWith('/list') && method === 'GET') return J(200, await ctx.yadisk.listFolder(tok.access_token, p, { limit: query.get('limit'), offset: query.get('offset') }));
            if (pathname.endsWith('/href') && method === 'GET') return J(200, await ctx.yadisk.downloadHref(tok.access_token, p));
            if (pathname.endsWith('/upload-url') && method === 'POST') {
              if (!canWrite) return E(403, 'Запись в облачную папку не разрешена');
              return J(200, await ctx.yadisk.uploadUrl(tok.access_token, p, { overwrite: body.overwrite !== false }));
            }
            if (pathname.endsWith('/mkdir') && method === 'POST') {
              if (!canWrite) return E(403, 'Запись в облачную папку не разрешена');
              return J(200, await ctx.yadisk.mkdir(tok.access_token, p));
            }
            if (pathname.endsWith('/delete') && method === 'POST') {
              if (!canWrite) return E(403, 'Удаление в облачной папке не разрешено');
              return J(200, await ctx.yadisk.removePath(tok.access_token, p));
            }
          } else if (mount.kind === 'google') {
            const tok = await ctx.gdFreshToken(owner, mount.slot);
            if (!tok) return E(409, 'Google Диск владельца не подключён');
            const p = ctx.gdrive.safePath(rawPath);
            if (!p || !(await insideGoogle(tok.access_token, p, mount.path))) return E(400, 'Путь вне выбранной облачной папки');
            if (pathname.endsWith('/list') && method === 'GET') return J(200, await ctx.gdrive.listFolder(tok.access_token, p, { limit: query.get('limit'), pageToken: query.get('pageToken') }));
            if (pathname.endsWith('/file') && method === 'GET') {
              const r = await fetch(ctx.gdrive.mediaUrl(p), { headers: { Authorization: 'Bearer ' + tok.access_token }, signal: AbortSignal.timeout(60000) });
              if (!r.ok || !r.body) return E(502, 'Google не отдал файл');
              const { Readable } = require('stream');
              return { status: 200, pipe: { stream: Readable.fromWeb(r.body) }, headers: { 'Content-Type': 'application/octet-stream' } };
            }
            if (pathname.endsWith('/upload-url') && method === 'POST') {
              if (!canWrite) return E(403, 'Запись в облачную папку не разрешена');
              if (body.existing) return J(200, await ctx.gdrive.updateSession(tok.access_token, p, { mime: body.mime, size: body.size }));
              return J(200, await ctx.gdrive.uploadSession(tok.access_token, p, { mime: body.mime, size: body.size }));
            }
            if (pathname.endsWith('/mkdir') && method === 'POST') {
              if (!canWrite) return E(403, 'Запись в облачную папку не разрешена');
              return J(200, await ctx.gdrive.mkdir(tok.access_token, p));
            }
            if (pathname.endsWith('/delete') && method === 'POST') {
              if (!canWrite) return E(403, 'Удаление в облачной папке не разрешено');
              return J(200, await ctx.gdrive.trashPath(tok.access_token, p));
            }
          }
        } catch (e) { return E(e.status || 502, e.message || 'Облачный диск не ответил'); }
        return E(404, 'Неизвестное действие облачного моста');
      }
      return E(404, 'Неизвестный маршрут помощника');
    }

    const u = await user(req);
    if (!u) return E(401, 'Войдите в чат');
    if (pathname === '/api/sync/devices' && method === 'GET') {
      return J(200, { devices: Object.values(s.devices).filter(d => d.uid === u.id).map(d => ({ id: d.id, name: d.name, pub: d.pub, createdAt: d.createdAt, lastSeen: d.lastSeen, revoked: d.revoked, status: d.status || null })) });
    }
    if (pathname === '/api/sync/devices/revoke' && method === 'POST') {
      const d = ownDevice(s, u.id, String(body.id || ''));
      if (!d) return E(404, 'Компьютер не найден');
      d.revoked = true;
      for (const f of Object.values(s.folders)) if (f.wraps && f.wraps[d.id]) { delete f.wraps[d.id]; f.needsRotation = true; bump(s, f); dropFolderQueue(s, f.id); f.events = {}; }
      delete s.queue[d.id]; delete s.commands[d.id];
      save(); return J(200, { ok: true });
    }
    if (pathname === '/api/sync/devices/command' && method === 'POST') {
      const d = ownDevice(s, u.id, String(body.id || ''));
      if (!d) return E(404, 'Компьютер не найден');
      const c = body.command || {};
      if (!['approve', 'resync', 'pause', 'resume'].includes(c.t)) return E(400, 'Неизвестная команда');
      if (!isId(c.folderId)) return E(400, 'Неверная папка');
      const f = s.folders[c.folderId];
      if (!f || !f.wraps || !f.wraps[d.id]) return E(403, 'Папка не открыта этому компьютеру');
      if (!s.commands[d.id]) s.commands[d.id] = [];
      if (s.commands[d.id].length >= 200) return E(429, 'Слишком много команд — дождитесь ответа компьютера');
      const cmd = { id: rid('c_'), t: c.t, pendingId: String(c.pendingId || '').slice(0, 1200), folderId: f.id, at: Date.now() };
      s.commands[d.id].push(cmd); save(); return J(200, { ok: true, command: cmd });
    }
    if (pathname === '/api/sync/folders' && method === 'GET') {
      const list = Object.values(s.folders).filter(f => perm(f, u.id)).map(f => ({
        id: f.id, name: f.name, owner: f.owner, perm: perm(f, u.id), createdAt: f.createdAt,
        userWrap: (f.userWraps || {})[u.id] || '', keyRev: f.keyRev || 1, needsRotation: !!f.needsRotation,
        members: Object.keys(f.perm || {}).map(uid => ({ id: uid, name: (db.users.find(x => x.id === uid) || {}).name || uid, pub: pubOf(db, uid) })),
        devices: Object.entries(f.wraps || {}).map(([did, w]) => ({ id: did, uid: w.uid, name: (s.devices[did] || {}).name || did, pub: (s.devices[did] || {}).pub || '', state: ((s.devices[did] || {}).status || {}).folders ? ((s.devices[did].status.folders.find(x => x.id === f.id) || {}).state || '') : '' })),
        mounts: f.owner === u.id ? (f.mounts || []) : [], deviceRev: f.deviceRev || 1
      }));
      return J(200, { folders: list });
    }
    if (pathname === '/api/sync/folders' && method === 'POST') {
      const name = String(body.name || '').trim();
      const d = ownDevice(s, u.id, String(body.deviceId || ''));
      if (!name || name.length > 80 || !d || !isWrap(body.wrap) || body.wrap.by !== u.id || !validUserWrap(body.userWrap)) return E(400, 'Нужны название, свой компьютер и ключи');
      if (Object.values(s.folders).filter(f => f.owner === u.id).length >= 20) return E(409, 'Не больше 20 папок на участника');
      if (Object.values(s.folders).some(f => f.wraps && f.wraps[d.id])) return E(409, 'Этот компьютер уже привязан к папке — сначала отзовите его');
      const fid = rid('f_');
      s.folders[fid] = { id: fid, owner: u.id, name, createdAt: Date.now(), perm: { [u.id]: 'write' }, wraps: { [d.id]: { by: u.id, blob: body.wrap.blob, uid: u.id } }, userWraps: { [u.id]: body.userWrap }, keyRev: 1, deviceRev: 1, needsRotation: false, mounts: [], events: {} };
      save(); return J(200, { folder: { id: fid, name } });
    }
    const fm = /^\/api\/sync\/folders\/([a-zA-Z0-9_]+)\/(wrap|rotate|share|unshare|mounts|unmount|delete)$/.exec(pathname);
    if (fm) {
      const f = s.folders[fm[1]];
      if (!f) return E(404, 'Папка не найдена');
      if (fm[2] === 'wrap' && method === 'POST') {
        if (f.owner !== u.id || f.needsRotation) return E(403, 'Сначала обновите ключ папки');
        const d = ownDevice(s, u.id, String(body.deviceId || ''));
        if (!d || !isWrap(body.wrap) || body.wrap.by !== u.id) return E(400, 'Нужен свой компьютер и ключ');
        if (Object.values(s.folders).some(x => x.id !== f.id && x.wraps && x.wraps[d.id])) return E(409, 'Этот компьютер уже привязан к другой папке');
        f.wraps[d.id] = { by: u.id, blob: body.wrap.blob, uid: u.id }; bump(s, f); resyncCommands(s, f, d.id);
        save(); return J(200, { ok: true });
      }
      if (fm[2] === 'rotate' && method === 'POST') {
        if (f.owner !== u.id) return E(403, 'Только владелец обновляет ключ');
        const wraps = body.wraps || {}, userWraps = body.userWraps || {};
        if (!validUserWrap(userWraps[u.id])) return E(400, 'Нет ключа владельца');
        for (const did of Object.keys(f.wraps || {})) {
          const d = s.devices[did];
          if (!d || d.revoked) continue;
          if (!isWrap(wraps[did]) || wraps[did].by !== d.uid) return E(400, 'Не всем компьютерам передан новый ключ');
        }
        for (const uid of Object.keys(f.perm || {})) if (!validUserWrap(userWraps[uid])) return E(400, 'Не всем участникам передан новый ключ');
        const nw = {};
        for (const did of Object.keys(f.wraps || {})) if (s.devices[did] && !s.devices[did].revoked) nw[did] = { by: s.devices[did].uid, uid: s.devices[did].uid, blob: wraps[did].blob };
        dropFolderQueue(s, f.id);
        f.wraps = nw; f.userWraps = {};
        for (const uid of Object.keys(f.perm || {})) f.userWraps[uid] = userWraps[uid];
        f.keyRev = (f.keyRev || 1) + 1; f.needsRotation = false; f.events = {}; bump(s, f); resyncCommands(s, f);
        save(); return J(200, { ok: true, keyRev: f.keyRev });
      }
      if (fm[2] === 'share' && method === 'POST') {
        if (f.owner !== u.id || f.needsRotation) return E(403, 'Сначала обновите ключ папки');
        const other = db.users.find(x => x.id === String(body.uid || ''));
        if (!other || other.id === u.id || !commonChat(db, u.id, other.id) || !other.pub) return E(400, 'Выберите участника из общего чата');
        if (perm(f, other.id)) return E(409, 'Участник уже имеет доступ');
        if (!validUserWrap(body.userWrap)) return E(400, 'Нет ключа для участника');
        const sid = rid('s_');
        s.shares[sid] = { id: sid, folderId: f.id, folderName: f.name, owner: u.id, uid: other.id, perm: body.perm === 'write' ? 'write' : 'read', userWrap: body.userWrap, state: 'pending', createdAt: Date.now() };
        save(); return J(200, { shareId: sid });
      }
      if (fm[2] === 'unshare' && method === 'POST') {
        if (f.owner !== u.id) return E(403, 'Только владелец отзывает доступ');
        const uid = String(body.uid || '');
        if (uid === f.owner) return E(400, 'Владельца нельзя удалить из его папки');
        delete f.perm[uid]; delete (f.userWraps || {})[uid];
        for (const [did, w] of Object.entries(f.wraps || {})) if (w.uid === uid) { delete f.wraps[did]; delete s.queue[did]; }
        for (const [sid, sh] of Object.entries(s.shares)) if (sh.folderId === f.id && sh.uid === uid) delete s.shares[sid];
        f.needsRotation = true; bump(s, f); dropFolderQueue(s, f.id); f.events = {};
        save(); return J(200, { ok: true });
      }
      if (fm[2] === 'mounts' && method === 'POST') {
        if (f.owner !== u.id || f.needsRotation) return E(403, 'Сначала обновите ключ папки');
        const kind = body.kind === 'google' ? 'google' : 'yandex';
        const slot = Math.min(3, Math.max(1, Number(body.slot) || 1));
        if (!ctx.driveRec(u, kind, slot)) return E(409, 'Сначала подключите этот диск в «Моих дисках»');
        let p = kind === 'google' ? ctx.gdrive.safePath(String(body.path || '')) : ctx.yadisk.safePath(String(body.path || ''));
        if (!p || (kind === 'yandex' && p === 'disk:/') || (kind === 'google' && p === 'google:/root')) return E(400, 'Выберите конкретную папку, а не весь диск');
        p = p.replace(/^(disk|google)\d*:/, '$1:');
        if ((f.mounts || []).length >= 6) return E(409, 'Не больше шести облачных папок у одной папки ПК');
        if (f.mounts.some(m => m.kind === kind && m.slot === slot && m.path === p)) return E(409, 'Эта папка уже подключена');
        const m = { id: rid('m_'), kind, slot, path: p, perm: body.perm === 'read' ? 'read' : 'write' };
        f.mounts.push(m); bump(s, f); resyncCommands(s, f);
        save(); return J(200, { mount: m });
      }
      if (fm[2] === 'unmount' && method === 'POST') {
        if (f.owner !== u.id) return E(403, 'Только владелец отключает облачную папку');
        f.mounts = (f.mounts || []).filter(m => m.id !== String(body.mountId || '')); bump(s, f);
        save(); return J(200, { ok: true });
      }
      if (fm[2] === 'delete' && method === 'POST') {
        if (f.owner !== u.id) return E(403, 'Только владелец убирает папку из синхронизации');
        dropFolderQueue(s, f.id);
        for (const did of Object.keys(f.wraps || {})) delete s.commands[did];
        for (const [sid, sh] of Object.entries(s.shares)) if (sh.folderId === f.id) delete s.shares[sid];
        delete s.folders[f.id];
        save(); return J(200, { ok: true });
      }
    }
    if (pathname === '/api/sync/shares' && method === 'GET') {
      const incoming = Object.values(s.shares).filter(x => x.uid === u.id && x.state === 'pending').map(x => ({ id: x.id, folderId: x.folderId, folderName: x.folderName, owner: x.owner, ownerPub: pubOf(db, x.owner), perm: x.perm, userWrap: x.userWrap }));
      const outgoing = Object.values(s.shares).filter(x => x.owner === u.id && x.state !== 'done').map(x => ({ id: x.id, folderId: x.folderId, uid: x.uid, state: x.state }));
      return J(200, { incoming, outgoing });
    }
    if (pathname === '/api/sync/shares/accept' && method === 'POST') {
      const sh = s.shares[String(body.shareId || '')];
      if (!sh || sh.uid !== u.id || sh.state !== 'pending') return E(404, 'Приглашение не найдено');
      const f = s.folders[sh.folderId];
      if (!f || f.needsRotation) return E(409, 'Владелец меняет ключ папки — попробуйте позже');
      const d = ownDevice(s, u.id, String(body.deviceId || ''));
      if (!d || !isWrap(body.wrap) || body.wrap.by !== u.id) return E(400, 'Выберите свой компьютер и передайте ключ');
      if (Object.values(s.folders).some(x => x.wraps && x.wraps[d.id])) return E(409, 'Этот компьютер уже привязан к папке');
      f.perm[sh.uid] = sh.perm; f.userWraps[sh.uid] = sh.userWrap;
      f.wraps[d.id] = { by: u.id, blob: body.wrap.blob, uid: u.id };
      sh.state = 'done'; bump(s, f); resyncCommands(s, f, d.id);
      save(); return J(200, { ok: true });
    }
    if (pathname === '/api/sync/shares/decline' && method === 'POST') {
      const sh = s.shares[String(body.shareId || '')];
      if (!sh || sh.uid !== u.id) return E(404, 'Приглашение не найдено');
      delete s.shares[sh.id]; save(); return J(200, { ok: true });
    }
    return E(404, 'Неизвестный маршрут синхронизации');
  }

  function insideYandex(p, root) {
    const a = ctx.yadisk.safePath(p), b = ctx.yadisk.safePath(root);
    return !!a && !!b && (a === b || a.startsWith(b.replace(/\/$/, '') + '/'));
  }
  const gInsideCache = new Map();
  async function insideGoogle(token, p, root) {
    const id0 = ctx.gdrive.idOf(p), r = ctx.gdrive.idOf(root);
    if (!id0 || !r) return false;
    if (id0 === r) return true;
    const key = r + '|' + id0, hit = gInsideCache.get(key);
    if (hit && Date.now() - hit.at < 60000) return hit.ok;
    let level = [id0], ok = false;
    for (let i = 0; i < 12 && level.length && !ok; i++) {
      const next = [];
      for (const x of level.slice(0, 4)) {
        let parents = [];
        try { parents = await ctx.gdrive.parentsOf(token, x); } catch (e) { parents = []; }
        if (parents.includes(r)) { ok = true; break; }
        next.push(...parents);
      }
      level = next;
    }
    if (gInsideCache.size > 5000) gInsideCache.clear();
    gInsideCache.set(key, { at: Date.now(), ok });
    return ok;
  }
  return { handle };
}
module.exports = { createSync };
