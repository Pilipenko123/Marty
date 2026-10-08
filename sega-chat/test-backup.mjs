/**
 * Проверка переезда хозяйства в одно облако (пакет 4, pkg3-14):
 *   • клиент Object Storage (lib/s3.js) — авторизация IAM-токеном, запись,
 *     чтение, список с дочитыванием страниц, удаление, серверная копия;
 *   • резервная копия (lib/backup.js) — сжатие, шифрование, самопроверка,
 *     чистка старых копий;
 *   • маршруты администратора /api/admin/backup(s) — права, скачивание,
 *     защита от выхода за «папку» копий;
 *   • поведение, когда облачное хранилище не настроено (локальный режим).
 *
 * Всё поднимается на заглушках: test/mock-ydb.mjs и test/mock-s3.mjs.
 *
 * Запуск: node test/test-backup.mjs
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { startMock } from './mock-ydb.mjs';
import { startMockS3 } from './mock-s3.mjs';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
// отметку выпуска берём прямо из кода — тест не придётся править к каждому релизу
const BUILD = (/const BUILD = '([^']+)'/.exec(String(require('fs').readFileSync(path.join(ROOT, 'lib/api.js'), 'utf8'))) || [])[1] || '?';
const backupLib = require(path.join(ROOT, 'lib', 'backup.js'));
const { createS3 } = require(path.join(ROOT, 'lib', 's3.js'));

const hex = (n = 16) => crypto.randomBytes(n).toString('hex');
const wait = (ms) => new Promise(r => setTimeout(r, ms));
let bad = 0, good = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ПРОВАЛ: ') + m); if (c) good++; else bad++; };

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
  for (let i = 0; i < 80; i++) {
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

// ══════════════════════════════════════════════════════ 1. клиент хранилища
console.log('\n══════════════════════════════════════════════════');
console.log('  Облачное хранилище: клиент lib/s3.js');
console.log('══════════════════════════════════════════════════');

const s3mock = await startMockS3({ bucket: 'sega-chat-code', token: 'iam-abc' });
const cli = createS3({ bucket: s3mock.bucket, endpoint: s3mock.endpoint, token: s3mock.token });

await cli.put('sega-chat.zip', Buffer.from('код программы'), 'application/zip');
ok((await cli.get('sega-chat.zip')).toString() === 'код программы', 'записали и прочитали объект');
ok((await cli.head('sega-chat.zip')).size === Buffer.byteLength('код программы'), 'head знает размер');
ok((await cli.get('нет-такого.zip')) === null, 'несуществующий объект -> null, а не ошибка');

// токен заведомо чужой; ASCII — потому что Node не пропускает кириллицу в заголовки
const noAuth = createS3({ bucket: s3mock.bucket, endpoint: s3mock.endpoint, token: 'wrong-token' });
let denied = false;
try { await noAuth.get('sega-chat.zip'); } catch (e) { denied = e.status === 403; }
ok(denied, 'с чужим токеном хранилище отказывает (403)');

await cli.copy('sega-chat.zip', 'releases/sega-chat-old.zip');
ok((await cli.get('releases/sega-chat-old.zip')).toString() === 'код программы', 'серверная копия внутри бакета');

// список: страниц по 5, объектов 13 — проверяем дочитывание
for (let i = 0; i < 13; i++) await cli.put('probe/b' + String(i).padStart(2, '0') + '.sbgz', 'x' + i);
const all = await cli.list('probe/');
ok(all.length === 13, 'список дочитал все страницы: ' + all.length + ' из 13');
ok(all.every(x => x.size > 0 && x.key.startsWith('probe/')), 'в списке есть размер и ключ');
ok((await cli.list('пусто/')).length === 0, 'пустой префикс -> пустой список');

await cli.del('probe/b00.sbgz');
ok((await cli.list('probe/')).length === 12, 'удаление работает');
ok(await cli.ping() === true, 'ping бакета прошёл');

const noBucket = createS3({ bucket: 'no-such-bucket', endpoint: s3mock.endpoint, token: s3mock.token });
let noSuch = false;
try { await noBucket.ping(); } catch (e) { noSuch = e.code === 'NoSuchBucket'; }
ok(noSuch, 'несуществующий бакет -> понятная ошибка NoSuchBucket');

let noBucketCfg = false;
try { createS3({ bucket: '', endpoint: s3mock.endpoint }); } catch (e) { noBucketCfg = true; }
ok(noBucketCfg, 'клиент не создаётся без имени бакета');

// ═════════════════════════════════════════ 2. шифрование самой копии
console.log('\n══════════════════════════════════════════════════');
console.log('  Резервная копия: сжатие, шифрование, подлинность');
console.log('══════════════════════════════════════════════════');

const secret = hex(32);
const plain = zlib.gzipSync(Buffer.from(JSON.stringify({ привет: 'мир', n: 42 })));
const blob = backupLib.encrypt(plain, secret);
ok(blob.subarray(0, 8).toString() === 'SEGABK01', 'у файла копии опознавательный заголовок SEGABK01');
ok(blob.length > plain.length, 'копия больше открытого текста (iv + метка подлинности)');
ok(zlib.gunzipSync(backupLib.decrypt(blob, secret)).toString().includes('привет'), 'своим секретом расшифровывается');
let wrongKey = false;
try { backupLib.decrypt(blob, hex(32)); } catch (e) { wrongKey = true; }
ok(wrongKey, 'чужим секретом НЕ расшифровывается');
let tampered = false;
const evil = Buffer.from(blob); evil[evil.length - 1] ^= 0xff;
try { backupLib.decrypt(evil, secret); } catch (e) { tampered = true; }
ok(tampered, 'подделанный файл не проходит проверку подлинности');
let shortFile = false;
try { backupLib.decrypt(Buffer.from('мусор'), secret); } catch (e) { shortFile = true; }
ok(shortFile, 'случайный файл копией не считается');
ok(backupLib.safeKey('../../sega-chat.zip', 'backups/') === 'backups/sega-chat.zip', 'safeKey обрезает путь до папки копий');
let badName = false;
try { backupLib.safeKey('../..', 'backups/'); } catch (e) { badName = true; }
ok(badName, 'safeKey отвергает мусор вместо имени');
// ══════════════════════════════════════ 3. живой мессенджер + копия в облако
console.log('\n══════════════════════════════════════════════════');
console.log('  Мессенджер целиком: копия по кнопке администратора');
console.log('══════════════════════════════════════════════════');

const mock = await startMock();
const env = {
  STORE: 'ydb', YDB_ENDPOINT: mock.endpoint, YDB_TABLE: 'sega_chat',
  YDB_ACCESS_KEY_ID: mock.accessKeyId, YDB_SECRET_ACCESS_KEY: mock.secretAccessKey,
  HOST: '127.0.0.1', HTTPS: '', PRESENCE_EVERY: '0',
  CODE_BUCKET: s3mock.bucket, S3_ENDPOINT: s3mock.endpoint, YC_IAM_TOKEN: s3mock.token,
  BACKUP_KEEP: '3'
};
const A = up(await freePort(), env);
await waitReady(A);

const CODE_PROOF = hex(32);
const creds = (name) => ({
  name, saltAuth: hex(), authKey: hex(32), saltWrap: hex(),
  wrappedKeyByPass: 'w:' + hex(), pub: 'pub:' + hex(), wrappedPriv: 'priv:' + hex()
});
let r = await call(A, '/api/setup', {
  method: 'POST', body: Object.assign(creds('Мартин'), {
    codeProofSalt: hex(), codeProof: CODE_PROOF, codeSalt: hex(), wrappedKeyByCode: 'k:' + hex()
  })
});
ok(r.status === 200 && !!r.d.token, 'мессенджер настроен, администратор вошёл');
const adminToken = r.d.token, adminId = r.d.user.id;

r = await call(A, '/api/state');
ok(r.d.build === BUILD, 'сервер сообщает отметку ' + BUILD + ' (пришло: ' + r.d.build + ')');

const sha256hex = s => createHash('sha256').update(s).digest('hex');
{
  const secret = hex(24);
  const ir = await call(A, '/api/invites', { method: 'POST', body: { invSalt: hex(), wrappedRoomKey: 'k:' + hex(), secretHash: sha256hex(secret) } }, adminToken);
  r = await call(A, '/api/register', { method: 'POST', body: Object.assign(creds('Поля'), { inviteToken: ir.d.invite.id + '.' + secret }) });
}
ok(r.status === 200 && !!r.d.token, 'второй участник зарегистрировался');
const guestToken = r.d.token, guestId = r.d.user.id;

r = await call(A, '/api/chats', {
  method: 'POST',
  body: { titleBlob: 'enc:' + hex(), members: [guestId], keys: { [adminId]: { blob: 'k1' }, [guestId]: { blob: 'k2' } } }
}, adminToken);
ok(r.status === 200, 'чат создан');
const chat = r.d.chat.id;
let sent = 0;
for (let i = 0; i < 5; i++) {
  const rr = await call(A, '/api/messages', { method: 'POST', body: { chat, blob: 'шифр-сообщение-' + i } }, adminToken);
  if (rr.status === 200) sent++;
}
ok(sent === 5, 'пять сообщений отправлено');

r = await call(A, '/api/admin/backups', {}, adminToken);
ok(r.status === 200 && r.d.enabled === true && r.d.items.length === 0, 'список копий пуст, хранилище настроено');
r = await call(A, '/api/admin/backups', {}, guestToken);
ok(r.status === 403, 'не администратору список копий недоступен (403)');
r = await call(A, '/api/admin/backup', { method: 'POST' }, guestToken);
ok(r.status === 403, 'не администратор не может сделать копию (403)');

r = await call(A, '/api/admin/backup', { method: 'POST' }, adminToken);
ok(r.status === 200 && r.d.ok === true, 'копия создана' + (r.d.error ? ': ' + r.d.error : ''));
const first = r.d.backup || {};
ok(first.verify === true, 'обратная проверка копии прошла (verify)');
ok(first.rows > 0, 'в копии ' + first.rows + ' записей базы');
ok(first.gzBytes < first.rawBytes, 'сжатие сработало: ' + first.rawBytes + ' -> ' + first.gzBytes + ' байт');
ok(s3mock.objects.has(first.key), 'файл копии физически лежит в бакете');

// --- читаем копию напрямую из заглушки и расшифровываем секретом из базы
const metaItem = mock.tables.get('sega_chat').get('meta\u0000root');
const serverSecret = metaItem ? JSON.parse(metaItem.d.S).serverSecret : null;
ok(!!serverSecret, 'секрет мессенджера найден в базе');
const unpacked = JSON.parse(zlib.gunzipSync(backupLib.decrypt(s3mock.objects.get(first.key).body, serverSecret)).toString('utf8'));
ok(unpacked.format === 'sega-chat-cloud-backup-v1', 'формат копии опознаётся');
ok(unpacked.build === BUILD, 'в копии записана отметка выпуска ' + BUILD);
ok(unpacked.store === 'ydb' && unpacked.table === 'sega_chat', 'в копии указано, откуда она (ydb/sega_chat)');
const rowD = x => x.d !== undefined ? x.d : (x.item && x.item.d ? x.item.d.S : '');
const blobs = unpacked.rows.map(rowD).join('|');
ok(unpacked.rows.filter(x => x.pk.startsWith('m#')).length >= 5, 'в копии все пять сообщений');
ok(blobs.includes('шифр-сообщение-4'), 'текст последнего сообщения на месте');
ok(unpacked.rows.some(x => x.pk === 'user' && rowD(x).includes('Поля')), 'в копии есть карточка второго участника');
ok(unpacked.rows.some(x => x.pk === 'meta' && x.item && x.item.seq), 'копия хранит служебные колонки меты (seq/gen/dv/sv)');
ok(unpacked.counts && unpacked.counts.user >= 2, 'в копии есть счётчики разделов: ' + JSON.stringify(unpacked.counts));

// --- скачивание копии через сам мессенджер
const name = first.key.split('/').pop();
r = await call(A, '/api/admin/backups/' + encodeURIComponent(name), {}, adminToken);
ok(r.status === 200 && r.raw.equals(s3mock.objects.get(first.key).body), 'копия скачивается байт в байт');
r = await call(A, '/api/admin/backups/' + encodeURIComponent(name), {}, guestToken);
ok(r.status === 403, 'не администратору копию не отдать (403)');

// --- попытка выйти за папку копий и скачать программу
r = await call(A, '/api/admin/backups/' + encodeURIComponent('../../sega-chat.zip'), {}, adminToken);
ok(r.status !== 200, 'путь «../../sega-chat.zip» не отдаёт программу (статус ' + r.status + ')');
r = await call(A, '/api/admin/backups/no-such-backup.sbgz', {}, adminToken);
ok(r.status === 404, 'несуществующая копия -> 404');
r = await call(A, '/api/admin/backups/' + encodeURIComponent('им я.sbgz'), {}, adminToken);
ok(r.status === 400, 'мусор вместо имени -> 400');
r = await call(A, '/api/admin/backups/' + encodeURIComponent('копия.sbgz'), {}, adminToken);
ok(r.status === 400, 'имена копий только латиницей: кириллица отвергается (400)');

// --- чистка старых копий: держим BACKUP_KEEP = 3
const keys = [first.key];
for (let i = 0; i < 3; i++) {
  const rr = await call(A, '/api/admin/backup', { method: 'POST' }, adminToken);
  if (rr.status === 200) keys.push(rr.d.backup.key);
}
ok(keys.length === 4 && new Set(keys).size === 4, 'четыре копии получили четыре разных имени');
r = await call(A, '/api/admin/backups', {}, adminToken);
ok(r.d.items.length === 3, 'старые копии подчищены: осталось ' + r.d.items.length + ' из 4 (держим 3)');
ok(r.d.items.some(x => x.key === keys[3]), 'самая свежая копия цела');
ok(r.d.items.every((x, i) => i === 0 || (x.at || 0) <= (r.d.items[i - 1].at || 0)), 'список отсортирован от свежих к старым');
ok(r.d.bucket === 'sega-chat-code' && r.d.keep === 3, 'в ответе видно бакет и сколько копий держим');

// --- удаление одной копии руками
r = await call(A, '/api/admin/backups/' + encodeURIComponent(keys[3].split('/').pop()), { method: 'DELETE' }, adminToken);
ok(r.status === 200 && r.d.ok === true, 'копию можно удалить');
ok(!s3mock.objects.has(keys[3]), 'файл удалён и из бакета');
r = await call(A, '/api/admin/backups', {}, adminToken);
ok(r.d.items.length === 2, 'в списке осталось ' + r.d.items.length + ' копии');
r = await call(A, '/api/admin/backups/' + encodeURIComponent(keys[3].split('/').pop()), { method: 'DELETE' }, adminToken);
ok(r.status === 200, 'повторное удаление не роняет сервер');

// --- переписка после копии не пострадала
r = await call(A, '/api/messages', { method: 'POST', body: { chat, blob: 'после-копии' } }, adminToken);
ok(r.status === 200, 'мессенджер продолжает работать после создания копии');
r = await call(A, '/api/sync?since=0', {}, guestToken);
ok(r.d.messages.some(m => m.blob === 'после-копии'), 'второй участник видит новое сообщение');

// ══════════════════════════════ 4. локальный режим (хранилище не настроено)
console.log('\n══════════════════════════════════════════════════');
console.log('  Мессенджер на своём компьютере: хранилища нет');
console.log('══════════════════════════════════════════════════');

const tmpDir = await (async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  return mkdtemp(path.join(tmpdir(), 'sega-nobk-'));
})();
const C = up(await freePort(), {
  STORE: 'file', DATA_DIR: tmpDir, HOST: '127.0.0.1', HTTPS: '',
  CODE_BUCKET: '', S3_ENDPOINT: '', YC_IAM_TOKEN: '', PRESENCE_EVERY: '0'
});
await waitReady(C);
r = await call(C, '/api/setup', {
  method: 'POST', body: Object.assign(creds('Локальный'), {
    codeProofSalt: hex(), codeProof: CODE_PROOF, codeSalt: hex(), wrappedKeyByCode: 'k:' + hex()
  })
});
const localToken = r.d.token;
ok(r.status === 200, 'локальный мессенджер поднялся');
r = await call(C, '/api/admin/backups', {}, localToken);
ok(r.status === 200 && r.d.enabled === false && !!r.d.reason, 'без CODE_BUCKET честно сообщает: копии не настроены');
r = await call(C, '/api/admin/backup', { method: 'POST' }, localToken);
ok(r.status === 501, 'кнопка копии отвечает 501, а не падает');

// файловое хранилище тоже умеет выгружать копию (пригодится при переносе)
const { createFileStore } = require(path.join(ROOT, 'lib', 'store-file.js'));
const fs3 = await startMockS3({ bucket: 'local-bucket', token: 'iam-local' });
const fstore = createFileStore({ dataDir: tmpDir });
const fdb = await fstore.open();
const fcli = createS3({ bucket: fs3.bucket, endpoint: fs3.endpoint, token: fs3.token });
process.env.CODE_BUCKET = fs3.bucket; process.env.S3_ENDPOINT = fs3.endpoint;
const fres = await backupLib.createBackup({ store: fstore, db: fdb, build: 'pkg3-14', s3: fcli });
ok(fres.verify === true && fres.bytes > 0, 'копия файлового режима тоже создается и проверяется');
const funpack = JSON.parse(zlib.gunzipSync(backupLib.decrypt(fs3.objects.get(fres.key).body, fdb.serverSecret)).toString('utf8'));
ok(funpack.store === 'file' && funpack.db && Array.isArray(funpack.db.users), 'в копии файлового режима база целиком');
ok(funpack.db.users.some(u => u.name === 'Локальный'), 'в копии есть участник локального мессенджера');
delete process.env.CODE_BUCKET; delete process.env.S3_ENDPOINT;

// ═══════════════════════ 5. кусковое скачивание и восстановление из копии
console.log('\n══════════════════════════════════════════════════');
console.log('  Кусковое скачивание и восстановление из копии');
console.log('══════════════════════════════════════════════════');

const snapSync = async (tok) => (await call(A, '/api/sync?since=0', {}, tok)).d;
const before = await snapSync(adminToken);
const beforeIds = before.messages.filter(m => !m.parent).map(m => m.id).sort();

r = await call(A, '/api/admin/backup', { method: 'POST' }, adminToken);
ok(r.status === 200 && r.d.ok, 'копия C1 создана перед изменениями');
const c1 = r.d.backup;

const added = await call(A, '/api/messages', { method: 'POST', body: { chat, blob: 'исчезнет-после-восстановления' } }, adminToken);
ok(added.status === 200, 'сообщение добавлено ПОСЛЕ копии');
const victimId = before.messages.find(m => !m.parent && m.uid === adminId).id;
ok((await call(A, '/api/messages/' + victimId, { method: 'DELETE' }, adminToken)).status === 200, 'старое сообщение удалено ПОСЛЕ копии');

{
  const piece = await call(A, '/api/admin/backups/' + encodeURIComponent(c1.key) + '?off=0&len=64', {}, adminToken);
  ok(piece.status === 200 && piece.raw.subarray(0, 8).toString('ascii') === 'SEGABK01', 'кусок с нуля начинается с магии копии');
}

r = await call(A, '/api/admin/restore', { method: 'POST', body: { key: c1.key, codeProof: hex(32) } }, adminToken);
ok(r.status === 403, 'восстановление с неверным кодовым словом отклонено (403)');
r = await call(A, '/api/admin/restore', { method: 'POST', body: { key: c1.key, codeProof: CODE_PROOF } }, guestToken);
ok(r.status === 403, 'не администратор не может восстановить (403)');

r = await call(A, '/api/admin/restore', { method: 'POST', body: { key: c1.key, codeProof: CODE_PROOF } }, adminToken);
ok(r.status === 200 && r.d.ok, 'восстановление из копии в ящике прошло');
ok(!!r.d.safety && String(r.d.safety).startsWith('prerestore/'), 'страховочная копия создана в папке prerestore/');
const safetyKey = r.d.safety;

let after = await snapSync(adminToken);
ok(JSON.stringify(after.messages.filter(m => !m.parent).map(m => m.id).sort()) === JSON.stringify(beforeIds),
  'сообщения вернулись к состоянию на момент копии');
ok(!after.messages.some(m => m.blob === 'исчезнет-после-восстановления'), 'добавленное после копии сообщение исчезло');
ok(after.messages.some(m => m.id === victimId), 'удалённое сообщение вернулось');

ok(s3mock.objects.has(safetyKey), 'страховочная копия физически в бакете');
r = await call(A, '/api/admin/restore', { method: 'POST', body: { key: safetyKey, codeProof: CODE_PROOF } }, adminToken);
ok(r.status === 200 && r.d.ok, 'откат из страховочной копии прошёл');
after = await snapSync(adminToken);
ok(after.messages.some(m => m.blob === 'исчезнет-после-восстановления'), 'после отката сообщение «после копии» снова на месте');
r = await call(A, '/api/admin/restore', { method: 'POST', body: { key: c1.key, codeProof: CODE_PROOF } }, adminToken);
ok(r.status === 200, 'повторное восстановление C1 перед тестом большой копии');

// ── большая копия: вложение ~4 МБ несжимаемых данных
const big = crypto.randomBytes(4 * 1024 * 1024).toString('base64');
const ini = await call(A, '/api/upload/init', {
  method: 'POST',
  body: { chat, name: 'big.bin', size: big.length, mime: 'application/octet-stream', parts: Math.ceil(big.length / 675000) }
}, adminToken);
ok(ini.status === 200, 'загрузка вложения ~4 МБ начата');
for (let off = 0, i = 0; off < big.length; off += 675000, i++) {
  await call(A, '/api/upload/chunk', { method: 'POST', body: { upId: ini.d.upId, i, data: big.slice(off, off + 675000) } }, adminToken);
}
r = await call(A, '/api/upload/fin', { method: 'POST', body: { upId: ini.d.upId, stored: big.length } }, adminToken);
ok(r.status === 200, 'вложение собрано на сервере');
r = await call(A, '/api/messages', { method: 'POST', body: { chat, blob: 'держи-файл', upId: ini.d.upId } }, adminToken);
ok(r.status === 200, 'сообщение сослалось на вложение');

r = await call(A, '/api/admin/backup', { method: 'POST' }, adminToken);
ok(r.status === 200 && r.d.ok, 'большая копия создана');
const bigc = r.d.backup;
ok(bigc.bytes > 3200000, 'копия больше предела разовой выдачи (' + (Math.round(bigc.bytes / 1048576 * 10) / 10) + ' МБ)');
const whole = await call(A, '/api/admin/backups/' + encodeURIComponent(bigc.key), {}, adminToken);
ok(whole.status === 413, 'целиком большая копия не выдаётся (413) — кнопка скачает по кускам');

let off2 = 0; const dparts = [];
while (off2 < bigc.bytes) {
  const len = Math.min(2500000, bigc.bytes - off2);
  const pc = await call(A, '/api/admin/backups/' + encodeURIComponent(bigc.key) + '?off=' + off2 + '&len=' + len, {}, adminToken);
  if (pc.status !== 200) { ok(false, 'кусок большой копии вернул ' + pc.status); break; }
  dparts.push(pc.raw); off2 += pc.raw.length;
}
const assembled = Buffer.concat(dparts);
ok(assembled.length === bigc.bytes, 'большая копия собрана из кусков целиком (' + assembled.length + ' байт)');
ok(assembled.subarray(0, 8).toString('ascii') === 'SEGABK01', 'собранный файл — валидная копия');

// ── восстановление из «файла с компьютера» (загрузка кусочками)
await call(A, '/api/messages', { method: 'POST', body: { chat, blob: 'временное-перед-файлом' } }, adminToken);
const ini2 = await call(A, '/api/admin/restore/upload', {
  method: 'POST', body: { step: 'init', size: assembled.length, parts: Math.ceil(assembled.length / 675000) }
}, adminToken);
ok(ini2.status === 200, 'загрузка файла копии начата');
for (let o = 0, i = 0; o < assembled.length; o += 675000, i++) {
  const rc2 = await call(A, '/api/admin/restore/upload', {
    method: 'POST', body: { step: 'chunk', id: ini2.d.id, i, data: assembled.subarray(o, o + 675000).toString('base64') }
  }, adminToken);
  if (rc2.status !== 200) ok(false, 'кусок файла копии не принят: ' + rc2.status);
}
const fin2 = await call(A, '/api/admin/restore/upload', {
  method: 'POST', body: { step: 'fin', id: ini2.d.id, codeProof: CODE_PROOF }
}, adminToken);
ok(fin2.status === 200 && fin2.d.ok, 'восстановление из загруженного файла прошло');
after = await snapSync(adminToken);
ok(!after.messages.some(m => m.blob === 'временное-перед-файлом'), 'файловое восстановление вернуло базу к состоянию копии');
ok(after.messages.some(m => m.upId), 'вложение из копии снова на месте');

// ══════════════════════════════════════════════════ итог
await wait(150);
console.log('\n──────────────────────────────────────────────────');
console.log(`  Резервные копии и облачное хранилище: ${good} ✓, провалов ${bad}`);
console.log('──────────────────────────────────────────────────\n');
for (const p of procs) { try { p.kill('SIGKILL'); } catch (e) {} }
await mock.close(); await s3mock.close(); await fs3.close();
process.exit(bad ? 1 : 0);
