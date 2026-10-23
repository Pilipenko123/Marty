/**
 * pkg3-84: щадящее фоновое сохранение базы (лечение «задыхающегося» сервера).
 *   • режим FILE_FLUSH_BG=1: запрос с изменением отвечает СРАЗУ, базу дописывает
 *     фоновая волна (FILE_FLUSH_MS); частые изменения сливаются в одну запись;
 *   • на выходе службы (SIGTERM/остановка) всё накопленное дожимается синхронно —
 *     перезапуск службы не теряет ни одного изменения;
 *   • без FILE_FLUSH_BG поведение прежнее: пишем до ответа (детерминизм тестов
 *     и облачная функция, засыпающая после ответа);
 *   • атомарность прежняя: временный файл + переименование, хвостов не остаётся.
 * Запуск: node test/save84.mjs
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let good = 0, bad = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ПРОВАЛ: ') + m); if (c) good++; else bad++; };
const hex = (n = 16) => crypto.randomBytes(n).toString('hex');
const wait = ms => new Promise(r => setTimeout(r, ms));

async function call(base, p, opts = {}, token) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { ...opts, headers: h, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const ct = r.headers.get('content-type') || '';
  const buf = Buffer.from(await r.arrayBuffer());
  if (ct.includes('json')) { try { return { status: r.status, d: JSON.parse(buf.toString('utf8')) }; } catch (e) {} }
  return { status: r.status, d: buf.toString('utf8') };
}
async function waitReady(base) {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/api/state')).ok) return; } catch (e) {}
    await wait(200);
  }
  throw new Error('не поднялся ' + base);
}
async function freePort() {
  const { createServer } = await import('node:net');
  return new Promise(r => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
}
const procs = [];
process.on('exit', () => { for (const p of procs) { try { p.kill('SIGKILL'); } catch (e) {} } });

console.log('\n══════════════════════════════════════════════════');
console.log('  pkg3-84: сохранение базы без удушения сервера');
console.log('══════════════════════════════════════════════════\n');

const creds = name => ({ name, saltAuth: hex(), authKey: hex(32), saltWrap: hex(), wrappedKeyByPass: 'w:' + hex(), pub: 'pub:' + hex(), wrappedPriv: 'priv:' + hex() });
async function boot(envExtra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sega-s84-'));
  const port = await freePort();
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
    env: Object.assign({}, process.env, {
      STORE: 'file', DATA_DIR: dir, HOST: '127.0.0.1', HTTPS: '', PRESENCE_EVERY: '0', NEW_INVITE_DELAY: '0',
      INVITE_COOLDOWN_MS: '0', PORT: String(port)
    }, envExtra)
  });
  procs.push(proc);
  const base = `http://127.0.0.1:${port}`;
  await waitReady(base);
  let r = await call(base, '/api/setup', { method: 'POST', body: Object.assign({}, creds('Мартин'), { codeProofSalt: hex(), codeProof: hex(32), codeSalt: hex(), wrappedKeyByCode: 'k:' + hex() }) });
  return { dir, proc, base, token: r.d.token, dbFile: path.join(dir, 'db.json') };
}
const dbName = f => { try { return JSON.parse(readFileSync(f, 'utf8')).users[0].name; } catch (e) { return null; } };

// ── режим фона: ответ не ждёт запись, волна дописывает сама ──
{
  const s = await boot({ FILE_FLUSH_BG: '1', FILE_FLUSH_MS: '200' });
  ok(true, 'сервер с FILE_FLUSH_BG=1 поднялся');
  const t0 = Date.now();
  const r = await call(s.base, '/api/profile', { method: 'POST', body: { name: 'Мартин Фоновый' } }, s.token);
  const dt = Date.now() - t0;
  ok(r.status === 200, 'переименование принято');
  ok(dt < 1500, 'ответ с изменением не ждал запись базы (' + dt + ' мс)');
  await wait(800);   // волна (200 мс) гарантированно прошла
  ok(dbName(s.dbFile) === 'Мартин Фоновый', 'фоновая волна дописала изменение в базу');
  // шквал изменений сливается в волны, база остаётся целой
  for (let i = 1; i <= 6; i++) await call(s.base, '/api/profile', { method: 'POST', body: { name: 'Шквал ' + i } }, s.token);
  await wait(800);
  let parsed = null;
  try { parsed = JSON.parse(readFileSync(s.dbFile, 'utf8')); } catch (e) {}
  ok(!!parsed && parsed.users[0].name === 'Шквал 6', 'шесть изменений подряд: база целая, последнее значение на месте');
  ok(!fs.readdirSync(s.dir).some(f => f.endsWith('.tmp-bg') || f.endsWith('.tmp')), 'хвостов временных файлов не осталось');
  // выход службы дожимает всё синхронно
  const r2 = await call(s.base, '/api/profile', { method: 'POST', body: { name: 'ПередВыходом' } }, s.token);
  ok(r2.status === 200, 'изменение перед остановом принято');
  await new Promise(res => { s.proc.once('exit', res); s.proc.kill('SIGTERM'); });
  ok(dbName(s.dbFile) === 'ПередВыходом', 'SIGTERM: накопленное дожито синхронно — перезапуск службы ничего не теряет');
}

// ── прежний режим (без FILE_FLUSH_BG): пишем до ответа — как всегда ──
{
  const s = await boot({});
  const r = await call(s.base, '/api/profile', { method: 'POST', body: { name: 'Мартин Синхронный' } }, s.token);
  ok(r.status === 200 && dbName(s.dbFile) === 'Мартин Синхронный',
    'без FILE_FLUSH_BG поведение прежнее: изменение в базе сразу после ответа');
  s.proc.kill('SIGTERM');
  await new Promise(res => { s.proc.once('exit', res); });
}

// ── метки лечения в исходниках ──
const storeJs = readFileSync(path.join(ROOT, 'lib', 'store-file.js'), 'utf8');
const apiJs = readFileSync(path.join(ROOT, 'lib', 'api.js'), 'utf8');
const setupSh = readFileSync(path.join(ROOT, 'cloud-vps', 'setup.sh'), 'utf8');
ok(storeJs.includes('function flushAsync()') && storeJs.includes('flushAsync,'),
  'хранилище умеет фоновую волну: асинхронная запись + переименование');
ok(storeJs.includes('if (bgWriting) { bgPending = true;') ,
  'одновременно пишется не более одной волны; изменения во время записи ждут следующей');
ok(apiJs.includes("const BG_FLUSH = store.name === 'file' && String(process.env.FILE_FLUSH_BG || '') === '1';"),
  'фоновый режим включается только для файлового хранилища и только флажком окружения');
ok(apiJs.includes("process.on('exit'") && apiJs.includes('store.flush();'),
  'на любом выходе накопленное дожимается синхронно');
ok(setupSh.includes('ensure_key FILE_FLUSH_BG 1'),
  'установщик включает щадящий режим на VPS строкой .env');
ok(apiJs.includes('if (!BG_FLUSH) dirty = false;'),
  'в фоновом режиме флажок изменения принадлежит волне — запрос его не стирает');

console.log('\n──────────────────────────────────────────────────');
console.log(`  pkg3-84 сохранение: ${good} ✓, провалов ${bad}`);
console.log('──────────────────────────────────────────────────\n');
process.exit(bad ? 1 : 0);
