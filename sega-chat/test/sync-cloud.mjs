// pkg3-154: облачный мост помощника — игрушечные Яндекс/Google без сети.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const core = require('../helper/core.js');
const { createLocalFolder } = require('../helper/local.js');
const { createCloudBridge } = require('../helper/cloud.js');
let good = 0, bad = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ПРОВАЛ: ') + m); if (c) good++; else bad++; };
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'sega-sync-cloud-'));
console.log('\n  Синхронизация папок · облачные мосты\n');
try {
  const root = path.join(tmp, 'pc'); await fsp.mkdir(root);
  const local = createLocalFolder({ root, stateDir: path.join(tmp, 'state'), folderId: 'folder-cloud-0001', deviceId: 'device-cloud-0001' });
  await local.init(); await local.acquire();
  const key = crypto.randomBytes(32);
  const folder = { id: 'folder-cloud-0001', key, keyRev: 1, perm: 'write', local, limits: { maxFileBytes: 128 * 1024 * 1024 } };
  const published = [];
  const publish = {
    put: async (rel, baseHash) => { published.push({ op: 'put', rel, baseHash }); },
    mkdir: async rel => { published.push({ op: 'mkdir', rel }); },
    delete: async (rel, hash) => { published.push({ op: 'delete', rel, hash }); }
  };
  // Игрушечный Яндекс: одна папка, файлы в памяти.
  const remote = new Map();
  remote.set('disk:/Sync/отчёт.txt', { name: 'отчёт.txt', dir: false, size: 6, modified: '2026-11-12T10:00:00Z', body: Buffer.from('облако') });
  const calls = [];
  const call = async (method, p, body) => {
    calls.push({ method, p, body });
    const u = new URL('http://x' + p);
    const action = u.pathname.split('/').pop();
    const rp = u.searchParams.get('path') || (body && body.path) || 'disk:/Sync';
    if (action === 'list') {
      const items = [];
      for (const [k, v] of remote) if (k.startsWith(rp.replace(/\/$/, '') + '/') && !k.slice(rp.length + 1).includes('/')) items.push(Object.assign({ path: k }, v));
      return { items, total: items.length };
    }
    if (action === 'href') return { href: 'toy://yandex/' + encodeURIComponent(rp) };
    if (action === 'upload-url') return { href: 'toy://upload/' + encodeURIComponent(rp), method: 'PUT' };
    if (action === 'mkdir') { remote.set(rp, { name: rp.split('/').pop(), dir: true, size: 0, modified: '' }); return { path: rp }; }
    if (action === 'delete') { remote.delete(rp); return { ok: true }; }
    throw new Error('неизвестно ' + action);
  };
  const realFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const s = String(url);
    if (s.startsWith('toy://yandex/')) {
      const rp = decodeURIComponent(s.slice('toy://yandex/'.length));
      const it = remote.get(rp);
      return { ok: !!it, body: it ? (async function* () { yield it.body; })() : null };
    }
    if (s.startsWith('toy://upload/')) {
      const rp = decodeURIComponent(s.slice('toy://upload/'.length));
      const chunks = [];
      for await (const c of opts.body) chunks.push(Buffer.from(c));
      const body = Buffer.concat(chunks);
      remote.set(rp, { name: rp.split('/').pop(), dir: false, size: body.length, modified: '2026-11-12T11:00:00Z', body });
      return { ok: true };
    }
    return realFetch(url, opts);
  };
  const mount = { id: 'mount-yandex-0001', kind: 'yandex', slot: 1, path: 'disk:/Sync', perm: 'write' };
  const bridge = createCloudBridge({ call, folder, mount, stateDir: path.join(tmp, 'cloud'), publish });
  await bridge.reconcile();
  ok((await fsp.readFile(path.join(root, 'отчёт.txt'), 'utf8')) === 'облако', 'файл из облачной папки скачан на ПК');
  ok(published.some(x => x.op === 'put' && x.rel === 'отчёт.txt'), 'облачное изменение отправлено в очередь другим ПК');
  ok(calls.every(c => !JSON.stringify(c).includes('access_token') && !JSON.stringify(c).includes('Bearer')), 'помощник не получает токены диска');
  await bridge.reconcile();
  ok(published.filter(x => x.op === 'put' && x.rel === 'отчёт.txt').length === 1, 'повторный проход не скачивает и не публикует тот же файл');
  await fsp.writeFile(path.join(root, 'локальный.txt'), 'с ПК');
  await bridge.reconcile();
  ok(remote.has('disk:/Sync/локальный.txt') && remote.get('disk:/Sync/локальный.txt').body.toString() === 'с ПК', 'новый локальный файл загружен в облачную папку');
  await fsp.writeFile(path.join(root, 'отчёт.txt'), 'правка ПК');
  remote.set('disk:/Sync/отчёт.txt', { name: 'отчёт.txt', dir: false, size: 11, modified: '2026-11-12T12:00:00Z', body: Buffer.from('правка облака') });
  await bridge.reconcile();
  const files = await fsp.readdir(root);
  ok(files.some(n => n.includes('конфликт')), 'одновременная правка ПК и облака сохранила обе версии');
  ok((await fsp.readFile(path.join(root, 'отчёт.txt'), 'utf8')) === 'правка ПК', 'локальный оригинал не затёрт облаком');
  remote.delete('disk:/Sync/локальный.txt');
  await bridge.reconcile();
  const pend = bridge.pending();
  const delPend = pend.find(p => p.kind === 'cloud-remote-delete' && p.path === 'локальный.txt');
  ok(!!delPend && fs.existsSync(path.join(root, 'локальный.txt')), 'удаление в облаке ждёт подтверждения на ПК');
  await bridge.approve(delPend.id);
  ok(!fs.existsSync(path.join(root, 'локальный.txt')), 'подтверждённое облачное удаление применено локально');
  ok(published.some(x => x.op === 'delete' && x.rel === 'локальный.txt'), 'подтверждённое удаление отправлено другим ПК');
  await fsp.unlink(path.join(root, 'отчёт.txt'));
  await bridge.reconcile();
  const localDel = bridge.pending().find(p => p.kind === 'cloud-local-delete' && p.path === 'отчёт.txt');
  ok(!!localDel && remote.has('disk:/Sync/отчёт.txt'), 'локальное удаление не убирает облачный файл без подтверждения');
  await bridge.approve(localDel.id);
  ok(!remote.has('disk:/Sync/отчёт.txt'), 'подтверждённое локальное удаление убрано из облака');
  ok(published.some(x => x.op === 'delete' && x.rel === 'отчёт.txt'), 'локальное удаление облачного файла разослано другим ПК');
  global.fetch = realFetch;
  await local.release();
} catch (e) { ok(false, 'неожиданная ошибка: ' + (e.stack || e)); }
finally { await fsp.rm(tmp, { recursive: true, force: true }); }
console.log(`\n  ИТОГ: ${good} ✓, ${bad ? bad + ' провалов' : 'провалов нет'}\n`);
process.exit(bad ? 1 : 0);
