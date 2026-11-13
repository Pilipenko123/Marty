// pkg3-154: серверная очередь папок + помощник: три ПК, друг, отзыв, ключи.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { BUILD } from './build.mjs';
const require = createRequire(import.meta.url);
const core = require('../helper/core.js');
const { createAgent } = require('../helper/agent.js');
const { emptyDb, migrate } = require('../lib/model.js');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let good = 0, bad = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ПРОВАЛ: ') + m); if (c) good++; else bad++; };
const wait = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'sega-sync-server-'));
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const ownerKeys = core.generateDeviceKeys(), friendKeys = core.generateDeviceKeys();
const ownerToken = 't-owner-' + crypto.randomBytes(8).toString('hex');
const friendToken = 't-friend-' + crypto.randomBytes(8).toString('hex');
const sid = t => crypto.createHash('sha256').update('sega-session:' + t).digest('hex');
const db = emptyDb();
db.createdAt = Date.now();
db.users.push({ id: 'owner000000000001', name: 'Владелец', nameLower: 'владелец', pub: ownerKeys.pub, reads: {}, createdAt: Date.now(), lastSeen: Date.now() });
db.users.push({ id: 'friend00000000001', name: 'Друг', nameLower: 'друг', pub: friendKeys.pub, reads: {}, createdAt: Date.now(), lastSeen: Date.now() });
db.sessions[sid(ownerToken)] = { uid: 'owner000000000001', exp: Date.now() + 3600000 };
db.sessions[sid(friendToken)] = { uid: 'friend00000000001', exp: Date.now() + 3600000 };
db.chats.push({ id: 'chat000000000001', kind: 'group', members: ['owner000000000001', 'friend00000000001'], keys: {}, createdAt: Date.now() });
migrate(db);
fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify(db));
const port = await freePort();
const base = 'http://127.0.0.1:' + port;
const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'], env: Object.assign({}, process.env, { STORE: 'file', DATA_DIR: dataDir, HOST: '127.0.0.1', PORT: String(port), HTTPS: '', PRESENCE_EVERY: '0', FILE_FLUSH_BG: '' }) });
for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/api/state')).ok) break; } catch (e) {} await wait(150); }
async function call(p, method = 'GET', body, token) {
  const r = await fetch(base + p, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}), body: body === undefined ? undefined : JSON.stringify(body) });
  const d = await r.json().catch(() => null);
  if (!r.ok) { const e = new Error((d && d.error) || r.status); e.status = r.status; throw e; }
  return d;
}
console.log('\n  Синхронизация папок · сервер и помощник\n');
try {
  const state = await call('/api/state');
  ok(state.build === BUILD, 'сервер отдаёт текущую отметку выпуска');
  const zip = await fetch(base + '/api/sync/download');
  ok(zip.ok && (zip.headers.get('content-type') || '').includes('zip'), 'помощник скачивается архивом');
  const zb = Buffer.from(await zip.arrayBuffer());
  ok(zb.length > 1000 && zb.readUInt32LE(0) === 0x04034b50, 'архив помощника — настоящий ZIP');
  const tmpZip = path.join(tmp, 'helper.zip'); fs.writeFileSync(tmpZip, zb);
  const { execFileSync } = await import('node:child_process');
  const zlist = execFileSync('python3', ['-c', 'import zipfile,sys; print("\\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))', tmpZip], { encoding: 'utf8' });
  ok(zlist.includes('SEGA-CHAT-Sync/agent.js') && zlist.includes('SEGA-CHAT-Sync/install.ps1'), 'в архиве есть агент и установщик');

  const folderKey = crypto.randomBytes(32);
  const devices = [];
  for (let i = 0; i < 3; i++) {
    const code = await call('/api/sync/pair/init', 'POST', {}, ownerToken);
    const keys = core.generateDeviceKeys();
    const claim = await call('/api/sync/pair/claim', 'POST', { code: code.code, name: 'ПК-' + (i + 1), pub: keys.pub });
    ok(!!claim.token && !!claim.deviceId, 'ПК ' + (i + 1) + ' подключён по разовому коду');
    let reused = false; try { await call('/api/sync/pair/claim', 'POST', { code: code.code, name: 'ещё', pub: keys.pub }); } catch (e) { reused = e.status === 403; }
    ok(reused, 'повторное использование кода запрещено');
    const root = path.join(tmp, 'pc' + i); await fsp.mkdir(root, { recursive: true });
    const stateDir = path.join(tmp, 'state' + i);
    const vault = { save: async o => { vault.obj = o; }, load: async () => vault.obj || null };
    vault.obj = { server: base, deviceId: claim.deviceId, token: claim.token, priv: keys.priv, pub: keys.pub, root, folders: {} };
    const agent = createAgent({ stateDir, vault, win32: false, log: () => {} });
    devices.push({ keys, claim, root, stateDir, agent, vault });
  }
  const d0 = devices[0];
  const wrap0 = { by: 'owner000000000001', blob: core.sealFor(ownerKeys.priv, d0.keys.pub, folderKey) };
  const userWrap = core.sealFor(ownerKeys.priv, ownerKeys.pub, folderKey);
  const created = await call('/api/sync/folders', 'POST', { name: 'Документы', deviceId: d0.claim.deviceId, wrap: wrap0, userWrap }, ownerToken);
  const fid = created.folder.id;
  ok(!!fid, 'папка создана в чате');
  for (let i = 1; i < 3; i++) {
    const wrap = { by: 'owner000000000001', blob: core.sealFor(ownerKeys.priv, devices[i].keys.pub, folderKey) };
    await call('/api/sync/folders/' + fid + '/wrap', 'POST', { deviceId: devices[i].claim.deviceId, wrap }, ownerToken);
  }
  await fsp.writeFile(path.join(d0.root, 'отчёт.txt'), 'версия 1');
  for (const d of devices) await d.agent.tick();
  for (const d of devices.slice(1)) await d.agent.tick();
  ok((await fsp.readFile(path.join(devices[1].root, 'отчёт.txt'), 'utf8')) === 'версия 1', 'файл дошёл до второго ПК');
  ok((await fsp.readFile(path.join(devices[2].root, 'отчёт.txt'), 'utf8')) === 'версия 1', 'файл дошёл до третьего ПК');
  const q1 = await call('/api/sync/agent/queue', 'GET', undefined, devices[1].claim.token);
  ok(q1.events.length === 0, 'подтверждённое событие убрано из очереди');

  await fsp.writeFile(path.join(d0.root, 'отчёт.txt'), 'версия 2');
  await fsp.writeFile(path.join(devices[1].root, 'отчёт.txt'), 'правка второго');
  await devices[0].agent.tick();
  await devices[1].agent.tick();
  await devices[1].agent.tick();
  const files1 = await fsp.readdir(devices[1].root);
  ok(files1.some(n => n.includes('конфликт')), 'одновременная правка сохранила обе версии');
  ok((await fsp.readFile(path.join(devices[1].root, 'отчёт.txt'), 'utf8')) === 'правка второго', 'оригинал второго ПК не затёрт');

  await fsp.writeFile(path.join(d0.root, 'удали.txt'), 'важное');
  for (const d of devices) await d.agent.tick();
  for (const d of devices.slice(1)) await d.agent.tick();
  await fsp.unlink(path.join(d0.root, 'удали.txt'));
  await devices[0].agent.tick();
  const st0 = await call('/api/sync/devices', 'GET', undefined, ownerToken);
  const dev0 = st0.devices.find(x => x.id === d0.claim.deviceId);
  const state0 = core.openOpaque(folderKey, dev0.status.folders.find(x => x.id === fid).state);
  const pend = state0.pending.find(p => p.kind === 'local-delete');
  ok(!!pend, 'локальное удаление ждёт подтверждения, а не улетает само');
  ok(fs.existsSync(path.join(devices[1].root, 'удали.txt')), 'на другом ПК файл пока цел');
  await call('/api/sync/devices/command', 'POST', { id: d0.claim.deviceId, command: { t: 'approve', folderId: fid, pendingId: pend.id } }, ownerToken);
  await devices[0].agent.tick();
  await devices[1].agent.tick();
  const pendingDelete = devices[1].agent.folders.get(fid).local.journal.pending;
  const pd1 = Object.values(pendingDelete).find(p => p.kind === 'delete' && p.path === 'удали.txt');
  ok(!!pd1, 'удаление с другого ПК тоже ждёт подтверждения');
  await call('/api/sync/devices/command', 'POST', { id: devices[1].claim.deviceId, command: { t: 'approve', folderId: fid, pendingId: pd1.eventId } }, ownerToken);
  await devices[1].agent.tick();
  ok(!fs.existsSync(path.join(devices[1].root, 'удали.txt')), 'после подтверждения удаление применено на другом ПК');

  const share = await call('/api/sync/folders/' + fid + '/share', 'POST', { uid: 'friend00000000001', perm: 'read', userWrap: core.sealFor(ownerKeys.priv, friendKeys.pub, folderKey) }, ownerToken);
  const fin = await call('/api/sync/shares', 'GET', undefined, friendToken);
  ok(fin.incoming.some(x => x.id === share.shareId), 'друг получил приглашение');
  const fkeys = core.generateDeviceKeys();
  const fcode = await call('/api/sync/pair/init', 'POST', {}, friendToken);
  const fclaim = await call('/api/sync/pair/claim', 'POST', { code: fcode.code, name: 'ПК-друга', pub: fkeys.pub });
  const froot = path.join(tmp, 'friend'); await fsp.mkdir(froot);
  const fvault = { obj: { server: base, deviceId: fclaim.deviceId, token: fclaim.token, priv: fkeys.priv, pub: fkeys.pub, root: froot, folders: {} }, save: async o => { fvault.obj = o; }, load: async () => fvault.obj };
  const fagent = createAgent({ stateDir: path.join(tmp, 'fstate'), vault: fvault, win32: false, log: () => {} });
  const rawFriend = core.openFor(friendKeys.priv, ownerKeys.pub, fin.incoming[0].userWrap);
  await call('/api/sync/shares/accept', 'POST', { shareId: share.shareId, deviceId: fclaim.deviceId, wrap: { by: 'friend00000000001', blob: core.sealFor(friendKeys.priv, fkeys.pub, rawFriend) } }, friendToken);
  await fagent.tick(); await fagent.tick();
  const fresync = await call('/api/sync/devices/command', 'POST', { id: d0.claim.deviceId, command: { t: 'resync', folderId: fid } }, ownerToken);
  await devices[0].agent.tick();
  await fagent.tick();
  ok(fs.existsSync(path.join(froot, 'отчёт.txt')), 'друг получил файлы разрешённой папки');
  let denied = false;
  try { await call('/api/sync/agent/event', 'POST', { folderId: fid, envelope: core.sealEvent(rawFriend, { id: 'event-denied-0001', folderId: fid, deviceId: fclaim.deviceId, op: 'mkdir', path: 'нельзя', keyRev: 1 }), blobKeys: [] }, fclaim.token); } catch (e) { denied = e.status === 403; }
  ok(denied, 'друг с правом чтения не может отправлять изменения');

  await call('/api/sync/folders/' + fid + '/unshare', 'POST', { uid: 'friend00000000001' }, ownerToken);
  const revokedList = await call('/api/sync/folders', 'GET', undefined, ownerToken);
  ok(revokedList.folders.find(x => x.id === fid).needsRotation === true, 'после отзыва друга папка ждёт обновления ключа');
  const newKey = crypto.randomBytes(32);
  const fl = await call('/api/sync/folders', 'GET', undefined, ownerToken);
  const fnow = fl.folders.find(x => x.id === fid);
  const wraps = {}, userWraps = {};
  for (const d of fnow.devices) wraps[d.id] = { by: 'owner000000000001', blob: core.sealFor(ownerKeys.priv, d.pub, newKey) };
  for (const m of fnow.members) userWraps[m.id] = core.sealFor(ownerKeys.priv, m.pub, newKey);
  await call('/api/sync/folders/' + fid + '/rotate', 'POST', { wraps, userWraps }, ownerToken);
  await fagent.tick();
  const fcfg2 = await call('/api/sync/agent/config', 'GET', undefined, fclaim.token);
  ok(!fcfg2.folders.some(x => x.id === fid), 'отозванный компьютер больше не получает папку');
  await call('/api/sync/devices/revoke', 'POST', { id: fclaim.deviceId }, friendToken);
  let rev = false; try { await call('/api/sync/agent/config', 'GET', undefined, fclaim.token); } catch (e) { rev = e.status === 401; }
  ok(rev, 'отозванный пропуск компьютера не работает');
  for (const d of devices) await d.agent.release();
  await fagent.release();
} catch (e) { ok(false, 'неожиданная ошибка: ' + (e.stack || e)); }
finally { try { proc.kill('SIGKILL'); } catch (e) {} await fsp.rm(tmp, { recursive: true, force: true }); }
console.log(`\n  ИТОГ: ${good} ✓, ${bad ? bad + ' провалов' : 'провалов нет'}\n`);
process.exit(bad ? 1 : 0);
