/**
 * Проверка ОБХОДНОГО переноса истории из резервной копии бакета (pkg3-51).
 *
 * Зачем: штатный переезд (cloud-vps/import-from-yandex.js) требует живой
 * функции в Yandex Cloud. Если облако не отвечает, владелец достаёт историю
 * из бакета Object Storage: скачивает файл копии мышкой, берёт секрет
 * мессенджера (serverSecret) из строки meta/root облачной таблицы и
 * переносит всё на VPS скриптом cloud-vps/import-from-backup.js.
 *
 * Что проверяется сквозняком, на заглушках облака:
 *   • живой мессенджер на облачной базе → копия по кнопке администратора;
 *   • файл копии + секрет из meta/root открываются и превращаются в домашнюю
 *     базу (db.json + соседние файлы), секрет переезжает вместе с ней;
 *   • после переноса сервер в файловом режиме поднимается, вход по прежнему
 *     имени и паролю работает, чат и сообщения читаются через /api/sync;
 *   • --inspect ничего не меняет; чужой секрет копию не открывает;
 *   • своя переписка этого сервера без --force не затирается, а со --force
 *     сначала делается страховочный файл.
 *
 * Запуск: node test/import-backup.mjs
 */

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock } from './mock-ydb.mjs';
import { startMockS3 } from './mock-s3.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const IMPORTER = path.join(ROOT, 'cloud-vps', 'import-from-backup.js');

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
function runImporter(args, env = {}) {
  return spawnSync(process.execPath, [IMPORTER, ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 120000,
    env: Object.assign({}, process.env, env)
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sega-import-'));
const dataDir = path.join(tmp, 'vps-data');
fs.mkdirSync(dataDir, { recursive: true });

console.log('\n══════════════════════════════════════════════════');
console.log('  Обходной перенос: копия из бакета → домашняя база');
console.log('══════════════════════════════════════════════════\n');

// ══════════════════════════════ 1. облачный мессенджер с историей
console.log('  1. Облако: мессенджер, переписка и копия по кнопке');
const s3mock = await startMockS3({ bucket: 'sega-chat-code', token: 'iam-abc' });
const mock = await startMock();
const A = up(await freePort(), {
  STORE: 'ydb', YDB_ENDPOINT: mock.endpoint, YDB_TABLE: 'sega_chat',
  YDB_ACCESS_KEY_ID: mock.accessKeyId, YDB_SECRET_ACCESS_KEY: mock.secretAccessKey,
  HOST: '127.0.0.1', HTTPS: '', PRESENCE_EVERY: '0',
  CODE_BUCKET: s3mock.bucket, S3_ENDPOINT: s3mock.endpoint, YC_IAM_TOKEN: s3mock.token,
  BACKUP_KEEP: '3'
});
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
ok(r.status === 200 && !!r.d.token, 'второй участник зарегистрировался по приглашению');
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

r = await call(A, '/api/admin/backup', { method: 'POST' }, adminToken);
ok(r.status === 200 && r.d.ok === true, 'копия сохранена в бакет' + (r.d.error ? ': ' + r.d.error : ''));
const bkey = (r.d.backup || {}).key || '';
ok(s3mock.objects.has(bkey), 'файл копии физически лежит в бакете: ' + bkey);

// ══════════════════════ 2. то, что руками делает владелец: файл + секрет
console.log('\n  2. Владелец скачивает файл и достаёт секрет из meta/root');
const copyFile = path.join(tmp, path.basename(bkey));
fs.writeFileSync(copyFile, s3mock.objects.get(bkey).body);
ok(fs.statSync(copyFile).size > 100, 'файл копии скачан на компьютер (' + fs.statSync(copyFile).size + ' байт)');

const metaItem = mock.tables.get('sega_chat').get('meta\u0000root');
const serverSecret = metaItem ? JSON.parse(metaItem.d.S).serverSecret : null;
ok(/^[0-9a-f]{64}$/.test(serverSecret || ''), 'секрет мессенджера добыт из строки meta/root (64 символа)');

// ══════════════════════════════ 3. осмотр, чужой секрет, настоящий перенос
console.log('\n  3. Переносчик cloud-vps/import-from-backup.js');
let p = runImporter(['--file', copyFile, '--data-dir', dataDir, '--inspect'], { SEGA_BACKUP_SECRET: serverSecret });
ok(p.status === 0, '--inspect отработал без ошибки');
ok(/копия опознана/.test(p.stdout) && /сделана:/.test(p.stdout), 'осмотр показал, что это за копия и когда сделана');
ok(/записей в копии: [1-9]/.test(p.stdout), 'осмотр честно посчитал записи');
ok(!fs.existsSync(path.join(dataDir, 'db.json')), 'осмотр ничего не записал на сервер');

p = runImporter(['--file', copyFile, '--data-dir', dataDir], { SEGA_BACKUP_SECRET: hex(32) });
ok(p.status === 1, 'чужой секрет копию не открыл (выход 1)');
ok(/секрет не подошёл/.test(p.stderr), 'про чужой секрет сказано понятно');
ok(!fs.existsSync(path.join(dataDir, 'db.json')), 'после неудачи на сервере ничего не появилось');

p = runImporter(['--file', copyFile, '--data-dir', dataDir], {});
ok(p.status === 1 && /не передан секрет/.test(p.stderr), 'без секрета перенос не начинается и объясняет, где его взять');

p = runImporter(['--file', copyFile, '--data-dir', dataDir], { SEGA_BACKUP_SECRET: serverSecret });
ok(p.status === 0, 'перенос состоялся' + (p.status ? ': ' + (p.stderr || p.stdout).slice(-300) : ''));
ok(/готово: участников 2/.test(p.stdout), 'в отчёте два участника');
ok(/сообщений 5/.test(p.stdout), 'в отчёте пять сообщений');
ok(/в Яндексе ничего не менялось/.test(p.stdout), 'напомнили, что облако только читалось');

const dbFile = path.join(dataDir, 'db.json');
ok(fs.existsSync(dbFile), 'появилась домашняя база db.json');
const db = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
ok(db.users.length === 2, 'участники переехали: ' + db.users.length);
ok(db.chats.some(c => c.id === chatId), 'чат переехал с тем же идентификатором');
ok(db.messages.filter(m => m.chat === chatId).length === 5, 'пять сообщений на месте');
ok(db.messages.some(m => m.blob === 'шифр-сообщение-4'), 'текст последнего сообщения не потерялся');
ok(db.serverSecret === serverSecret, 'секрет мессенджера переехал — старые шифры читаются');
ok(!!db.room && !!db.room.codeProofHash, 'комната и кодовая фраза переехали');
ok(Array.isArray(db.invites) && db.invites.length > 0, 'приглашения переехали');
ok(db.users.find(u => u.id === guestId)?.invitedBy === adminId, 'дерево приглашений (кто кого позвал) сохранено');

// ══════════════════════ 4. домашний сервер поднимается и пускает своих
console.log('\n  4. Сервер на перенесённой базе: вход и чтение истории');
const B = up(await freePort(), { STORE: 'file', DATA_DIR: dataDir, HOST: '127.0.0.1', HTTPS: '', PRESENCE_EVERY: '0' });
await waitReady(B);

r = await call(B, '/api/state');
ok(r.status === 200 && r.d.setupRequired === false, 'сервер не предлагает «первый запуск» — база уже есть');
ok(r.d.registration === 'invite', 'регистрация по-прежнему закрыта (только по приглашениям)');

r = await call(B, '/api/login', { method: 'POST', body: { name: 'Мартин', authKey: adminCreds.authKey } });
ok(r.status === 200 && !!r.d.token, 'администратор вошёл ПО ПРЕЖНИМУ имени и паролю');
const tok2 = r.d.token;
ok(r.d.wrappedKeyByPass === adminCreds.wrappedKeyByPass, 'завёрнутый ключ участника переехал — переписка откроется');

const sync = await call(B, '/api/sync?since=0', {}, tok2);
ok(sync.status === 200, 'синхронизация отвечает');
const got = (sync.d.messages || []).filter(m => m.chat === chatId);
ok(got.length === 5, 'история чата читается целиком: ' + got.length + ' сообщений');
ok((sync.d.chats || []).some(c => c.id === chatId), 'чат виден в списке');

r = await call(B, '/api/login', { method: 'POST', body: { name: 'Поля', authKey: guestCreds.authKey } });
ok(r.status === 200, 'второй участник тоже вошёл по своему паролю');

// ══════════════════════ 5. защита от затирания и страховка
console.log('\n  5. Защита чужой и своей переписки');
p = runImporter(['--file', copyFile, '--data-dir', dataDir], { SEGA_BACKUP_SECRET: serverSecret });
ok(p.status === 1, 'повторный перенос без --force остановлен');
ok(/уже есть переписка/.test(p.stderr) && /--force/.test(p.stderr), 'объяснено, что нужен --force');

p = runImporter(['--file', copyFile, '--data-dir', dataDir, '--force'], { SEGA_BACKUP_SECRET: serverSecret });
ok(p.status === 0, 'с флагом --force перенос прошёл');
ok(fs.readdirSync(dataDir).some(f => /^db\.json\.before-import-/.test(f)), 'прежняя база сохранена страховочным файлом');

p = runImporter(['--file', path.join(tmp, 'нет-такого.sbgz'), '--data-dir', dataDir], { SEGA_BACKUP_SECRET: serverSecret });
ok(p.status === 1 && /нет на этом сервере/.test(p.stderr), 'несуществующий файл — понятная ошибка');

const junk = path.join(tmp, 'мусор.sbgz');
fs.writeFileSync(junk, Buffer.from('это не копия, а просто текст'));
p = runImporter(['--file', junk, '--data-dir', dataDir], { SEGA_BACKUP_SECRET: serverSecret });
ok(p.status === 1, 'чужой файл копией не считается (выход 1)');

console.log('\n──────────────────────────────────────────────────');
console.log(`  Перенос из копии бакета: ${good} ✓, провалов ${bad}`);
console.log('──────────────────────────────────────────────────\n');

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
process.exit(bad ? 1 : 0);
