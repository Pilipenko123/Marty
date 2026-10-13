/**
 * pkg3-51: канал «основной сервер → запасной» и переезд базы.
 *   • строки облачной таблицы превращаются в домашнюю базу (lib/rows2db.js);
 *   • маршруты /api/standby/* закрыты для посторонних (без секрета — «404»);
 *   • приём слепка кусками с проверкой отпечатка, отдача последнего слепка;
 *   • выгрузка слепка СЕЙЧАС с одноразовым ключом — целиком и кусками;
 *   • push-snapshot.js довозит слепок до приёмника по расписанию;
 *   • import-from-yandex.js переносит базу и не затирает чужую переписку.
 *
 * Запуск: node test/standby.mjs
 */

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startMock } from './mock-ydb.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const backup = require(path.join(ROOT, 'lib', 'backup.js'));
const { rowsToPayload } = require(path.join(ROOT, 'lib', 'rows2db.js'));

let bad = 0, good = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ПРОВАЛ: ') + m); if (c) good++; else bad++; }
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const procs = [];
process.on('exit', () => { for (const p of procs) { try { p.kill('SIGKILL'); } catch (e) {} } });

async function freePort() {
  const { createServer } = await import('node:net');
  return new Promise(r => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
}
async function waitReady(base) {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(base + '/api/state')).ok) return; } catch (e) {}
    await wait(200);
  }
  throw new Error('не поднялся ' + base);
}
function up(port, env) {
  const p = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
    env: Object.assign({}, process.env, { HTTPS: '' }, env, { PORT: String(port), HOST: '127.0.0.1' })
  });
  procs.push(p);
  return 'http://127.0.0.1:' + port;
}
function runScript(file, env) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [file], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.assign({}, process.env, env)
    });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { out += d; });
    p.on('exit', code => resolve({ code: code || 0, out }));
  });
}
async function call(base, p, opts = {}) {
  const r = await fetch(base + p, opts);
  const ct = r.headers.get('content-type') || '';
  const buf = Buffer.from(await r.arrayBuffer());
  if (ct.includes('json')) { try { return { status: r.status, d: JSON.parse(buf.toString('utf8')), buf }; } catch (e) {} }
  return { status: r.status, d: buf.toString('utf8'), buf };
}

// ══════════════════════════════════════════════════════ 1. строки -> домашняя база
console.log('\n══════════════════════════════════════════════════');
console.log('  1. Переезд: строки облачной таблицы -> файлы VPS');
console.log('══════════════════════════════════════════════════');

const mock = await startMock();
const ydbEnv = {
  STORE: 'ydb', YDB_ENDPOINT: mock.endpoint, YDB_TABLE: 'sega_chat',
  YDB_ACCESS_KEY_ID: mock.accessKeyId, YDB_SECRET_ACCESS_KEY: mock.secretAccessKey
};
const yStore = require(path.join(ROOT, 'lib', 'store-ydb.js'))
  .createYdbStore({ endpoint: mock.endpoint, accessKeyId: mock.accessKeyId, secretAccessKey: mock.secretAccessKey, table: 'sega_chat' });
await yStore.open();
const ydb1 = await yStore.load();
ydb1.users.push(
  { id: 'u1', name: 'Аня', nameLower: 'аня', saltAuth: 's1', authHash: 'h1', pub: 'p1', wrappedPriv: 'w1' },
  { id: 'u2', name: 'Борис', nameLower: 'борис', saltAuth: 's2', authHash: 'h2', pub: 'p2', wrappedPriv: 'w2' }
);
ydb1.chats.push({ id: 'c1', kind: 'group', titleBlob: 'название', ownerId: 'u1', members: ['u1', 'u2'], keys: {}, createdAt: 1000 });
ydb1.messages.push({ id: 'm1', seq: 1, uid: 'u1', ts: 1001, blob: 'СЕКРЕТНЫЙТЕКСТ', bytes: 14, chat: 'c1' });
ydb1.sessions['tok1'] = { uid: 'u1', exp: Date.now() + 1000000 };
ydb1.archives.push({ file: 'arc1.txt', createdAt: 5, count: 1, bytes: 2, chat: 'c1' });
yStore.pushChange({ i: 'm1', c: 'c1' });
await yStore.putArchive('arc1.txt', 'текст архива');
await yStore.putWall('c1', 'фон чата');
await yStore.putIcon('c1', 'иконка чата');
await yStore.putUpMeta('up1', { size: 6, parts: 1, ts: 7 });
await yStore.putUpPart('c1', 'up1', 0, 'кусок0');
await yStore.flush(ydb1);
const dump = await yStore.dumpAll();
ok(dump.rows.length >= 10, 'облачная база выгрузилась строками (' + dump.rows.length + ')');

const conv = rowsToPayload(dump.rows);
const dirF = fs.mkdtempSync(path.join(os.tmpdir(), 'sega-conv-'));
const fStore = require(path.join(ROOT, 'lib', 'store-file.js')).createFileStore({ dataDir: dirF });
await fStore.open();
await fStore.restoreFiles({ db: conv.db, files: conv.files });
await fStore.close();
const dbF = JSON.parse(fs.readFileSync(path.join(dirF, 'db.json'), 'utf8'));
ok(dbF.users.length === 2 && dbF.users[0].name === 'Аня', 'участники переехали (2, с именами)');
ok(dbF.chats.length === 1 && dbF.chats[0].titleBlob === 'название', 'чат переехал с названием');
ok(dbF.messages.length === 1 && dbF.messages[0].blob === 'СЕКРЕТНЫЙТЕКСТ', 'сообщение переехало байт в байт');
ok(dbF.sessions.tok1 && dbF.sessions.tok1.uid === 'u1', 'сессия переехала — вход не сломается');
ok(dbF.serverSecret === ydb1.serverSecret, 'секрет сервера переехал — шифры читаются');
ok(dbF.archives.length === 1 && dbF.archives[0].file === 'arc1.txt', 'индекс архивов переехал');
ok(fs.readFileSync(path.join(dirF, 'archives', 'arc1.txt'), 'utf8') === 'текст архива', 'файл архива переехал');
ok(fs.readFileSync(path.join(dirF, 'wall-c1.txt'), 'utf8') === 'фон чата', 'фон чата переехал файлом');
ok(fs.readFileSync(path.join(dirF, 'cicon-c1.txt'), 'utf8') === 'иконка чата', 'иконка чата переехала файлом');
ok(fs.readFileSync(path.join(dirF, 'up-up1-0.txt'), 'utf8') === 'кусок0', 'кусок вложения переехал файлом');
ok(JSON.parse(fs.readFileSync(path.join(dirF, 'upmeta-up1.json'), 'utf8')).size === 6, 'мета вложения переехала');
ok(dbF.changes.length === 1 && dbF.changes[0].i === 'm1', 'журнал изменений переехал');
ok(dbF.stats.chats.c1 && dbF.stats.chats.c1.n === 1, 'счётчики чатов пересчитались');
ok(Array.isArray(dbF.invites) && Array.isArray(dbF.bonds), 'новые коллекции на месте (приглашения, связи)');

// ══════════════════════════════════════════════════════ 2. маршруты /api/standby
console.log('\n══════════════════════════════════════════════════');
console.log('  2. Канал «основной → запасной»: приём, отдача, выгрузка');
console.log('══════════════════════════════════════════════════');

const TOK_A = 'tok-' + randomBytes(12).toString('hex');
const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'sega-stA-'));
fs.mkdirSync(path.join(dirA, 'archives'), { recursive: true });
fs.writeFileSync(path.join(dirA, 'db.json'), JSON.stringify({
  version: 3, createdAt: 1, serverSecret: 'a'.repeat(64),
  users: [{ id: 'u1', name: 'Аня', nameLower: 'аня' }],
  chats: [{ id: 'c1', kind: 'group', titleBlob: 'tb', ownerId: 'u1', members: ['u1'], keys: {}, createdAt: 1 }],
  messages: [{ id: 'm1', seq: 1, uid: 'u1', ts: 2, blob: 'zz', bytes: 2, chat: 'c1' }],
  sessions: {}
}));
const portA = await freePort();
const baseA = up(portA, { DATA_DIR: dirA, STORE: 'file', SEGA_STANDBY_TOKEN: TOK_A, SEGA_LABEL: 'VPS (основной)' });
await waitReady(baseA);

const st = await call(baseA, '/api/state');
ok(st.d.serverLabel === 'VPS (основной)', 'подвал получит подпись «VPS (основной)» из SEGA_LABEL');
ok((await call(baseA, '/api/standby/ping')).status === 404, 'без секрета канала маршрутов нет (404)');
ok((await call(baseA, '/api/standby/ping?token=chuzhoy-token-ne-tot')).status === 404, 'с чужим секретом — тоже 404');
const ping = await call(baseA, '/api/standby/ping?token=' + TOK_A);
ok(ping.status === 200 && ping.d.ok === true && ping.d.has === false, 'с своим секретом приёмник живой, слепка ещё нет');

const big = randomBytes(7 * 1024 * 1024);
const id = sha256(big).slice(0, 32);
const CH = 3 * 1024 * 1024;
let partsOk = true;
for (let i = 0; i < Math.ceil(big.length / CH); i++) {
  const r = await call(baseA, '/api/standby/receive', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: TOK_A, id, i, data: big.subarray(i * CH, (i + 1) * CH).toString('base64') })
  });
  if (!r.ok && r.status !== 200) partsOk = false;
  if (r.status !== 200) partsOk = false;
}
ok(partsOk, 'слепок 7 МБ принят тремя кусками');
const finBad = await call(baseA, '/api/standby/receive', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ token: TOK_A, id, fin: true, parts: 3, sha256: '0'.repeat(64) })
});
ok(finBad.status === 400, 'повреждённый слепок (чужой отпечаток) не принят');
const fin = await call(baseA, '/api/standby/receive', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ token: TOK_A, id, fin: true, parts: 3, sha256: sha256(big) })
});
ok(fin.status === 200 && fin.d.ok && fin.d.bytes === big.length, 'сборка кусков подтверждена, размер совпал');
const snapGot = await call(baseA, '/api/standby/snapshot?token=' + TOK_A);
ok(snapGot.status === 200 && snapGot.buf.equals(big), 'последний слепок отдаётся байт в байт');
ok(!fs.existsSync(path.join(dirA, 'standby', 'parts-' + id, '0')), 'куски после сборки подчищены');

const tKey = randomBytes(32).toString('hex');
const exp = await call(baseA, '/api/standby/export?token=' + TOK_A + '&key=' + tKey);
ok(exp.status === 200 && exp.d.done === true, 'выгрузка слепка целиком прошла');
const payA = backup.open(Buffer.from(exp.d.data, 'base64'), tKey);
ok(payA.db && payA.db.users[0].name === 'Аня' && payA.store === 'file', 'слепок расшифрован одноразовым ключом: база на месте');
ok((await call(baseA, '/api/standby/export?token=' + TOK_A + '&key=zz')).status === 400, 'одноразовый ключ проверяется по формату');

const chunks = [];
let meta = null;
for (let i = 0; i < 50; i++) {
  const r = await call(baseA, '/api/standby/export?token=' + TOK_A + '&key=' + tKey + '&i=' + i + '&size=65536');
  if (r.status !== 200) break;
  meta = r.d;
  chunks.push(Buffer.from(r.d.data, 'base64'));
  if (r.d.done) break;
}
const whole = Buffer.concat(chunks);
ok(meta && meta.done && sha256(whole) === meta.sha256, 'выгрузка кусками собралась с тем же отпечатком');
ok(backup.open(whole, tKey).db.messages[0].blob === 'zz', 'и кусками — та же база');

// ══════════════════════════════════════════════════════ 3. push-snapshot.js
console.log('\n══════════════════════════════════════════════════');
console.log('  3. Отправка слепка по расписанию (push-snapshot.js)');
console.log('══════════════════════════════════════════════════');

const TOK_B = 'tok-' + randomBytes(12).toString('hex');
const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'sega-stB-'));
const portB = await freePort();
const baseB = up(portB, { DATA_DIR: dirB, STORE: 'file', SEGA_STANDBY_TOKEN: TOK_B });
await waitReady(baseB);

const skip = await runScript('cloud-vps/push-snapshot.js', { DATA_DIR: dirA, SEGA_STANDBY_URL: '', SEGA_STANDBY_TOKEN: '' });
ok(skip.code === 0 && /пропуск/.test(skip.out), 'без настроек отправка вежливо пропускает ход');
const wrong = await runScript('cloud-vps/push-snapshot.js', { DATA_DIR: dirA, SEGA_STANDBY_URL: baseB, SEGA_STANDBY_TOKEN: 'ne-tot' });
ok(wrong.code === 1 && /404/.test(wrong.out), 'с чужим секретом приёмник не принимает (404)');
const push = await runScript('cloud-vps/push-snapshot.js', { DATA_DIR: dirA, SEGA_STANDBY_URL: baseB, SEGA_STANDBY_TOKEN: TOK_B });
ok(push.code === 0 && /ок:/.test(push.out), 'слепок ушёл на запасной сервер и принят');
const gotB = await call(baseB, '/api/standby/snapshot?token=' + TOK_B);
const secretA = JSON.parse(fs.readFileSync(path.join(dirA, 'db.json'), 'utf8')).serverSecret;
const payB = backup.open(gotB.buf, secretA);
ok(gotB.status === 200 && payB.db.users[0].name === 'Аня', 'на запасном сервере лежит слепок, зашифрованный секретом базы');

// ══════════════════════════════════════════════════════ 4. переезд import-from-yandex.js
console.log('\n══════════════════════════════════════════════════');
console.log('  4. Вечер переезда: import-from-yandex.js');
console.log('══════════════════════════════════════════════════');

const guard = await runScript('cloud-vps/import-from-yandex.js', { DATA_DIR: dirA, SEGA_STANDBY_URL: baseA, SEGA_STANDBY_TOKEN: TOK_A });
ok(guard.code === 1 && /уже есть переписка/.test(guard.out), 'поверх чужой переписки без --force не пишет');

const dirC = fs.mkdtempSync(path.join(os.tmpdir(), 'sega-stC-'));
const imp1 = await runScript('cloud-vps/import-from-yandex.js', { DATA_DIR: dirC, SEGA_STANDBY_URL: baseA, SEGA_STANDBY_TOKEN: TOK_A });
const dbC = JSON.parse(fs.readFileSync(path.join(dirC, 'db.json'), 'utf8'));
ok(imp1.code === 0 && dbC.users[0].name === 'Аня' && dbC.messages[0].blob === 'zz', 'переезд из файлового сервера: база на месте');
ok(dbC.serverSecret === secretA, 'секрет переехал — старые сообщения откроются');

const TOK_D = 'tok-' + randomBytes(12).toString('hex');
const portD = await freePort();
const baseD = up(portD, Object.assign({}, ydbEnv, { YDB_TABLE: 'sega_chat', SEGA_STANDBY_TOKEN: TOK_D }));
await waitReady(baseD);
const dirE = fs.mkdtempSync(path.join(os.tmpdir(), 'sega-stE-'));
const imp2 = await runScript('cloud-vps/import-from-yandex.js', { DATA_DIR: dirE, SEGA_STANDBY_URL: baseD, SEGA_STANDBY_TOKEN: TOK_D });
const dbE = JSON.parse(fs.readFileSync(path.join(dirE, 'db.json'), 'utf8'));
ok(imp2.code === 0, 'переезд из облачной базы (строки таблицы) прошёл');
ok(dbE.users.length === 2 && dbE.messages[0].blob === 'СЕКРЕТНЫЙТЕКСТ', 'облачная переписка стала домашней: 2 участника, сообщение цело');
ok(fs.readFileSync(path.join(dirE, 'archives', 'arc1.txt'), 'utf8') === 'текст архива', 'архив из облака переехал файлом');
ok(fs.readFileSync(path.join(dirE, 'wall-c1.txt'), 'utf8') === 'фон чата', 'фон чата из облака переехал файлом');
ok(dbE.serverSecret === ydb1.serverSecret, 'секрет облачной базы стал секретом домашней');

console.log('\n  итог: ' + good + ' норма, ' + bad + ' беда');
for (const p of procs) { try { p.kill('SIGTERM'); } catch (e) {} }
await mock.close().catch(() => {});
process.exit(bad ? 1 : 0);
