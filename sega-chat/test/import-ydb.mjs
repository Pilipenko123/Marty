/**
 * Проверка переноса ЖИВОЙ облачной базы на этот сервер (pkg3-51).
 *
 * Сценарий аварии: функция в Yandex Cloud не запускается, зато сама база
 * доступна. Владелец создаёт постоянный ключ сервисного аккаунта и запускает
 * cloud-vps/import-from-ydb.js — тот читает строки таблицы через Document API
 * и кладёт их на VPS в домашнем формате.
 *
 * Что проверяется:
 *   • облачный мессенджер с перепиской → перенос на файловое хранилище;
 *   • --inspect ничего не пишет; чужой ключ и недоступный адрес дают понятную ошибку;
 *   • после переноса сервер поднимается, вход по прежнему паролю работает,
 *     история читается через /api/sync, секрет мессенджера переехал;
 *   • своя переписка без --force не затирается, со --force делается страховка;
 *   • --save-copy кладёт рядом годную зашифрованную копию формата .sbgz.
 *
 * Запуск: node test/import-ydb.mjs
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startMock } from './mock-ydb.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const IMPORTER = path.join(ROOT, 'cloud-vps', 'import-from-ydb.js');
const backupLib = require(path.join(ROOT, 'lib', 'backup.js'));

let good = 0, bad = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ПРОВАЛ: ') + m); if (c) good++; else bad++; };
const hex = (n = 16) => crypto.randomBytes(n).toString('hex');
const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function call(base, p, opts = {}, token) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { ...opts, headers: h, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const ct = r.headers.get('content-type') || '';
  const buf = Buffer.from(await r.arrayBuffer());
  if (ct.includes('json')) { try { return { status: r.status, d: JSON.parse(buf.toString('utf8')), raw: buf }; } catch (e) {} }
  return { status: r.status, d: buf.toString('utf8'), raw: buf };
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
function up(port, env) {
  const p = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
    env: Object.assign({}, process.env, env, { PORT: String(port) })
  });
  procs.push(p);
  return `http://127.0.0.1:${port}`;
}
// ВАЖНО: запуск именно асинхронный. Заглушка облака живёт в ЭТОМ процессе,
// а spawnSync заблокировал бы его event loop — и переносчик не достучался бы
// до базы (получили бы «не отвечает» на ровном месте).
function runImporter(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [IMPORTER, ...args], {
      cwd: ROOT, env: Object.assign({}, process.env, env)
    });
    let so = '', se = '';
    child.stdout.on('data', d => { so += d; });
    child.stderr.on('data', d => { se += d; });
    const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} }, 120000);
    child.on('close', (code) => { clearTimeout(killer); resolve({ status: code, stdout: so, stderr: se }); });
    child.on('error', (e) => { clearTimeout(killer); resolve({ status: 1, stdout: so, stderr: se + String(e.message) }); });
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sega-ydb-'));
const dataDir = path.join(tmp, 'vps-data');
fs.mkdirSync(dataDir, { recursive: true });

console.log('\n══════════════════════════════════════════════════');
console.log('  Перенос живой базы Яндекса на свой сервер');
console.log('══════════════════════════════════════════════════\n');

// ══════════════════════════════ 1. облачный мессенджер с историей
console.log('  1. Облако: мессенджер и переписка');
const mock = await startMock();
const yenv = {
  STORE: 'ydb', YDB_ENDPOINT: mock.endpoint, YDB_TABLE: 'sega_chat',
  YDB_ACCESS_KEY_ID: mock.accessKeyId, YDB_SECRET_ACCESS_KEY: mock.secretAccessKey,
  HOST: '127.0.0.1', HTTPS: '', PRESENCE_EVERY: '0'
};
const A = up(await freePort(), yenv);
await waitReady(A);

const creds = (name) => ({
  name, saltAuth: hex(), authKey: hex(32), saltWrap: hex(),
  wrappedKeyByPass: 'w:' + hex(), pub: 'pub:' + hex(), wrappedPriv: 'priv:' + hex()
});
const adminCreds = creds('Мартин');
let r = await call(A, '/api/setup', {
  method: 'POST', body: Object.assign({}, adminCreds, {
    codeProofSalt: hex(), codeProof: hex(32), codeSalt: hex(), wrappedKeyByCode: 'k:' + hex()
  })
});
ok(r.status === 200 && !!r.d.token, 'облачный мессенджер настроен, администратор вошёл');
const adminToken = r.d.token, adminId = r.d.user.id;

const guestCreds = creds('Поля');
{
  const secret = hex(24);
  const sha = crypto.createHash('sha256').update(secret).digest('hex');
  const ir = await call(A, '/api/invites', { method: 'POST', body: { invSalt: hex(), wrappedRoomKey: 'k:' + hex(), secretHash: sha } }, adminToken);
  r = await call(A, '/api/register', { method: 'POST', body: Object.assign({}, guestCreds, { inviteToken: ir.d.invite.id + '.' + secret }) });
}
ok(r.status === 200 && !!r.d.token, 'второй участник зарегистрировался');
const guestId = r.d.user.id;

r = await call(A, '/api/chats', {
  method: 'POST',
  body: { titleBlob: 'enc:' + hex(), members: [guestId], keys: { [adminId]: { blob: 'k1' }, [guestId]: { blob: 'k2' } } }
}, adminToken);
ok(r.status === 200, 'личный чат создан');
const chatId = r.d.chat.id;
let sent = 0;
for (let i = 0; i < 5; i++) {
  const rr = await call(A, '/api/messages', { method: 'POST', body: { chat: chatId, blob: 'шифр-сообщение-' + i } }, adminToken);
  if (rr.status === 200) sent++;
}
ok(sent === 5, 'пять сообщений отправлено');

const metaItem = mock.tables.get('sega_chat').get('meta\u0000root');
const cloudSecret = metaItem ? JSON.parse(metaItem.d.S).serverSecret : null;
ok(/^[0-9a-f]{64}$/.test(cloudSecret || ''), 'секрет облачной базы виден в строке meta/root');

// ══════════════════════════════ 2. осмотр, ошибки, настоящий перенос
console.log('\n  2. Переносчик cloud-vps/import-from-ydb.js');
const kenv = {
  YDB_ENDPOINT: mock.endpoint, YDB_TABLE: 'sega_chat',
  YDB_ACCESS_KEY_ID: mock.accessKeyId, YDB_SECRET_ACCESS_KEY: mock.secretAccessKey
};
let p = await runImporter(['--data-dir', dataDir, '--inspect'], kenv);
ok(p.status === 0, '--inspect отработал без ошибки');
ok(/участников 2/.test(p.stdout) && /сообщений 5/.test(p.stdout), 'осмотр показал состав облачной базы');
ok(/ничего не изменено/.test(p.stdout), 'осмотр честно сказал, что ничего не менял');
ok(!fs.existsSync(path.join(dataDir, 'db.json')), 'после осмотра на сервере ничего не появилось');

p = await runImporter(['--data-dir', dataDir], Object.assign({}, kenv, { YDB_ACCESS_KEY_ID: 'YCAJE-wrong-key-id' }));
ok(p.status === 1 && /ключ не подошёл/.test(p.stderr), 'чужой ключ базу не открыл');
ok(!fs.existsSync(path.join(dataDir, 'db.json')), 'после чужого ключа на сервере ничего не появилось');

p = await runImporter(['--data-dir', dataDir], Object.assign({}, kenv, { YDB_ACCESS_KEY_ID: 'ключ с пробелом' }));
ok(p.status === 1 && /лишние символы/.test(p.stderr), 'ключ с мусором вместо символов отвергнут понятными словами');

p = await runImporter(['--data-dir', dataDir], Object.assign({}, kenv, { YDB_ENDPOINT: 'http://127.0.0.1:1/docapi' }));
ok(p.status === 1 && /не отвечает/.test(p.stderr), 'недоступный адрес — понятная ошибка');

p = await runImporter(['--data-dir', dataDir], Object.assign({}, kenv, { YDB_SECRET_ACCESS_KEY: '' }));
ok(p.status === 1 && /не заданы/.test(p.stderr), 'без секретной части ключа перенос не начинается');

p = await runImporter(['--data-dir', dataDir, '--save-copy'], kenv);
ok(p.status === 0, 'перенос живой базы состоялся' + (p.status ? ': ' + (p.stderr || p.stdout).slice(-300) : ''));
ok(/прочитано строк: [1-9]/.test(p.stdout), 'в отчёте видно, сколько строк прочитано в облаке');
ok(/готово: участников 2/.test(p.stdout) && /сообщений 5/.test(p.stdout), 'в отчёте состав перенесённой базы');
ok(/в облаке ничего не менялось/.test(p.stdout), 'напомнили, что облако только читалось');
ok(/удалить постоянный ключ/.test(p.stdout), 'напомнили удалить ключ после переноса');

const dbFile = path.join(dataDir, 'db.json');
ok(fs.existsSync(dbFile), 'появилась домашняя база db.json');
let db = null;
try { db = JSON.parse(fs.readFileSync(dbFile, 'utf8')); } catch (e) { db = null; }
if (!db) {
  ok(false, 'домашняя база не прочиталась — состав перенесённой истории не проверить');
} else {
  ok(db.users.length === 2, 'участники переехали: ' + db.users.length);
  ok(db.chats.some(c => c.id === chatId), 'чат переехал с тем же идентификатором');
  ok(db.messages.filter(m => m.chat === chatId).length === 5, 'пять сообщений на месте');
  ok(db.messages.some(m => m.blob === 'шифр-сообщение-4'), 'текст последнего сообщения не потерялся');
  ok(db.serverSecret === cloudSecret, 'секрет мессенджера переехал — старые шифры читаются');
  ok(!!db.room && !!db.room.codeProofHash, 'комната и кодовая фраза переехали');
  ok(db.users.find(u => u.id === guestId)?.invitedBy === adminId, 'дерево приглашений сохранено');
}

const copies = fs.readdirSync(tmp).filter(f => f.endsWith('-vps.sbgz'));
ok(copies.length === 1, '--save-copy положил местную копию рядом: ' + (copies[0] || 'нет'));
if (copies.length === 1) {
  let opened = null;
  try { opened = backupLib.open(fs.readFileSync(path.join(tmp, copies[0])), cloudSecret); } catch (e) {}
  ok(!!opened && Array.isArray(opened.rows) && opened.rows.length > 0, 'местная копия открывается тем же секретом и держит строки базы');
}

// ══════════════════════════════ 3. домашний сервер на перенесённой базе
console.log('\n  3. Сервер на перенесённой базе: вход и история');
const B = up(await freePort(), { STORE: 'file', DATA_DIR: dataDir, HOST: '127.0.0.1', HTTPS: '', PRESENCE_EVERY: '0' });
await waitReady(B);

r = await call(B, '/api/state');
ok(r.status === 200 && r.d.setupRequired === false, 'сервер не предлагает «первый запуск» — база уже есть');
r = await call(B, '/api/login', { method: 'POST', body: { name: 'Мартин', authKey: adminCreds.authKey } });
ok(r.status === 200 && !!r.d.token, 'администратор вошёл ПО ПРЕЖНИМУ имени и паролю');
ok(r.d.wrappedKeyByPass === adminCreds.wrappedKeyByPass, 'завёрнутый ключ переехал — переписка откроется');
const sync = await call(B, '/api/sync?since=0', {}, r.d.token);
ok(sync.status === 200 && (sync.d.messages || []).filter(m => m.chat === chatId).length === 5, 'история чата читается целиком');
ok((sync.d.chats || []).some(c => c.id === chatId), 'чат виден в списке');
r = await call(B, '/api/login', { method: 'POST', body: { name: 'Поля', authKey: guestCreds.authKey } });
ok(r.status === 200, 'второй участник тоже вошёл по своему паролю');

// ══════════════════════════════ 4. защита своей переписки
console.log('\n  4. Защита переписки этого сервера');
p = await runImporter(['--data-dir', dataDir], kenv);
ok(p.status === 1 && /уже есть переписка/.test(p.stderr) && /--force/.test(p.stderr), 'повторный перенос без --force остановлен и объяснён');
p = await runImporter(['--data-dir', dataDir, '--force'], kenv);
ok(p.status === 0, 'с флагом --force перенос прошёл');
ok(fs.readdirSync(dataDir).some(f => /^db\.json\.before-import-/.test(f)), 'прежняя база сохранена страховочным файлом');

console.log('\n──────────────────────────────────────────────────');
console.log(`  Перенос живой базы: ${good} ✓, провалов ${bad}`);
console.log('──────────────────────────────────────────────────\n');

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
process.exit(bad ? 1 : 0);
