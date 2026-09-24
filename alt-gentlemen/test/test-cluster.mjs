/**
 * Проверка облачного хранилища в самых неприятных условиях:
 * над одной базой одновременно работают ДВА экземпляра функции.
 * Именно так ведёт себя Yandex Cloud, когда запросов становится много.
 *
 * Здесь не проверяется шифрование (это делает test-flow.mjs) — только то,
 * что данные не теряются, не перетираются и доезжают до второго экземпляра.
 *
 * Запуск: node test/test-cluster.mjs
 */

import { spawn } from 'node:child_process';
import { startMock } from './mock-ydb.mjs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const hex = (n = 16) => crypto.randomBytes(n).toString('hex');
const wait = (ms) => new Promise(r => setTimeout(r, ms));
let bad = 0;
let t0 = Date.now();
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ПРОВАЛ: ') + m + (process.env.TIMING ? ` [${Date.now() - t0} мс]` : '')); t0 = Date.now(); if (!c) bad++; };

async function call(base, p, opts = {}, token) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { ...opts, headers: h, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, d: ct.includes('json') ? await r.json() : await r.text() };
}
const syncOf = (base, token, since = 0) => call(base, '/api/sync?since=' + since, {}, token).then(r => r.d);

async function waitReady(base) {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(base + '/api/state')).ok) return; } catch (e) {}
    await wait(250);
  }
  throw new Error('не поднялся ' + base);
}

const mock = await startMock();
const env = {
  STORE: 'ydb', YDB_ENDPOINT: mock.endpoint, YDB_TABLE: 'alt_chat',
  YDB_ACCESS_KEY_ID: mock.accessKeyId, YDB_SECRET_ACCESS_KEY: mock.secretAccessKey,
  HOST: '127.0.0.1', HTTPS: '', PRESENCE_EVERY: '0'
};
const procs = [];
process.on('exit', () => { for (const p of procs) { try { p.kill('SIGKILL'); } catch (e) {} } });
async function freePort() {
  const { createServer } = await import('node:net');
  return new Promise(r => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
}
function up(port) {
  const p = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
    env: Object.assign({}, process.env, env, { PORT: String(port) })
  });
  procs.push(p);
  return `http://127.0.0.1:${port}`;
}
const A = up(await freePort()), B = up(await freePort());
await waitReady(A); await waitReady(B);
console.log('\nДва экземпляра работают над одной базой (как при наплыве в облаке).\n');

// ── общие данные для входа (шифрование здесь неважно)
const CODE_SALT = hex(), CODE_PROOF = hex(32);
const creds = (name) => ({
  name, saltAuth: hex(), authKey: hex(32), saltWrap: hex(),
  wrappedKeyByPass: 'w:' + hex(), pub: 'pub:' + hex(), wrappedPriv: 'priv:' + hex()
});

const adminCred = creds('Мартин');
let r = await call(A, '/api/setup', {
  method: 'POST', body: Object.assign({}, adminCred, {
    codeProofSalt: CODE_SALT, codeProof: CODE_PROOF, codeSalt: hex(), wrappedKeyByCode: 'k:' + hex()
  })
});
ok(r.status === 200, 'экземпляр A создал мессенджер');
const admin = { token: r.d.token, id: r.d.user.id };

// второй экземпляр должен сразу увидеть чужую регистрацию
const st = await call(B, '/api/state');
ok(st.d.setupRequired === false, 'экземпляр B увидел, что мессенджер уже настроен');
const jamesCred = creds('Джеймс');
r = await call(B, '/api/register', { method: 'POST', body: Object.assign({}, jamesCred, { codeProof: CODE_PROOF }) });
ok(r.status === 200, 'экземпляр B зарегистрировал второго участника');
const james = { token: r.d.token, id: r.d.user.id };
ok((await syncOf(A, admin.token)).users.length === 2, 'экземпляр A увидел участника, созданного на B');

// ── чат создан на A, виден на B
r = await call(A, '/api/chats', {
  method: 'POST', body: {
    titleBlob: 'enc:' + hex(), members: [james.id],
    keys: { [admin.id]: { blob: 'k1' }, [james.id]: { blob: 'k2' } }
  }
}, admin.token);
ok(r.status === 200, 'чат создан на A');
const chat = r.d.chat.id;
ok((await syncOf(B, james.token)).chats.some(c => c.id === chat), 'чат виден на B');

// ── сообщения летают в обе стороны
await call(A, '/api/messages', { method: 'POST', body: { chat, blob: 'enc-A-1' } }, admin.token);
let s = await syncOf(B, james.token);
ok(s.messages.length === 1 && s.messages[0].blob === 'enc-A-1', 'сообщение с A прочитано на B');
const seqAfter = s.seq;
ok((await syncOf(B, james.token, seqAfter)).messages.length === 0, 'повторный опрос не тянет старое');

await call(B, '/api/messages', { method: 'POST', body: { chat, blob: 'enc-B-1' } }, james.token);
s = await syncOf(A, admin.token);
ok(s.messages.length === 2, 'оба экземпляра пишут в общую историю, ничего не затёрлось');
ok(new Set(s.messages.map(m => m.seq)).size === 2, 'номера сообщений не совпали');

// ── одновременная отправка с двух экземпляров
await Promise.all([
  call(A, '/api/messages', { method: 'POST', body: { chat, blob: 'одновременно-A' } }, admin.token),
  call(B, '/api/messages', { method: 'POST', body: { chat, blob: 'одновременно-B' } }, james.token)
]);
s = await syncOf(A, admin.token);
ok(s.messages.filter(m => m.blob.startsWith('одновременно')).length === 2, 'два сообщения, отправленных в один момент, оба на месте');

// ── переименование чата
await call(B, '/api/chats/' + chat + '/title', { method: 'POST', body: { titleBlob: 'enc-new-title' } }, james.token);
ok((await syncOf(A, admin.token)).chats.find(c => c.id === chat).titleBlob === 'enc-new-title', 'переименование с B видно на A');

// ── длинное сообщение режется на куски и собирается обратно
const big = 'Ж'.repeat(60000) + '|конец';
r = await call(A, '/api/messages', { method: 'POST', body: { chat, blob: big } }, admin.token);
ok(r.status === 200, 'отправлено сообщение на ' + big.length + ' символов');
s = await syncOf(B, james.token);
const gotBig = s.messages.find(m => m.blob.length > 50000);
ok(!!gotBig && gotBig.blob === big, 'длинное сообщение собрано из кусков без потерь');

// ── много сообщений: постраничная выборка из базы
for (let i = 0; i < Number(process.env.MANY || 120); i++) await call(A, '/api/messages', { method: 'POST', body: { chat, blob: 'm' + i } }, admin.token);
s = await syncOf(B, james.token);
ok(s.messages.length === Number(process.env.MANY || 120) + 5, `вся история (${s.messages.length} сообщений) вычитана постранично`);
ok(s.messages.filter(m => m.blob === 'm' + (Number(process.env.MANY || 120) - 1)).length === 1, 'последнее из череды сообщений на месте');
const usage = s.usage;
ok(usage.bytes > 60000 && usage.messages === Number(process.env.MANY || 120) + 5, 'счётчики памяти совпадают с историей');

// ── удаление
const victim = s.messages.find(m => m.blob === 'm' + Math.floor(Number(process.env.MANY || 120) / 2));
const genBefore = s.gen;
r = await call(A, '/api/messages/' + victim.id, { method: 'DELETE' }, admin.token);
ok(r.status === 200, 'сообщение удалено на A');
s = await syncOf(B, james.token);
ok(!s.messages.some(m => m.id === victim.id), 'на B сообщение тоже пропало');
ok(s.gen !== genBefore, '«поколение» базы изменилось — клиенты перечитают историю');
ok(s.usage.messages === Number(process.env.MANY || 120) + 4, 'счётчик сообщений уменьшился');

// ── аватар: большой, через куски, с удалением
const pic = 'data:image/png;base64,' + 'Q'.repeat(120000);
r = await call(A, '/api/profile', { method: 'POST', body: { avatar: 'enc:' + pic } }, admin.token);
ok(r.status === 200, 'аватар на 120 КБ сохранён');
const rev = r.d.user.avatar;
let av = await call(B, '/api/avatar/' + admin.id, {}, james.token);
ok(av.d.avatar === 'enc:' + pic && av.d.rev === rev, 'аватар целиком скачан со второго экземпляра');
await call(A, '/api/profile', { method: 'POST', body: { avatar: null } }, admin.token);
av = await call(B, '/api/avatar/' + admin.id, {}, james.token);
ok(av.d.avatar === null, 'после удаления от аватара не осталось кусков');

// ── архив
r = await call(A, '/api/chats/' + chat + '/archive', { method: 'POST', body: { reset: true } }, admin.token);
ok(r.status === 200 && r.d.archive.count === Number(process.env.MANY || 120) + 4, 'архив создан на A');
const file = r.d.archive.file;
const dl = await fetch(B + '/api/archives/' + encodeURIComponent(file), { headers: { Authorization: 'Bearer ' + james.token } });
const text = await dl.text();
ok(dl.status === 200 && text.includes('enc-A-1') && text.includes(big.slice(0, 200)), 'архив скачан со второго экземпляра целиком');
s = await syncOf(B, james.token);
ok(s.messages.length === 0 && s.usage.messages === 0, 'после архивации история очищена на обоих экземплярах');

// ── присутствие и сессии
await call(A, '/api/sync?since=0&active=1', {}, admin.token);
const seen = (await syncOf(B, james.token)).users.find(u => u.id === admin.id);
ok(seen.activeAt > 0, 'второй экземпляр видит, что человек сейчас в чате');
const loginA = await call(A, '/api/login', { method: 'POST', body: { name: 'Джеймс', authKey: jamesCred.authKey } });
ok(loginA.status === 200, 'вход через A');
ok((await call(B, '/api/sync?since=0', {}, loginA.d.token)).status === 200, 'выданный на A пропуск работает на B');
await call(B, '/api/logout', { method: 'POST' }, loginA.d.token);
ok((await call(A, '/api/sync?since=0', {}, loginA.d.token)).status === 401, 'выход на B закрыл сессию и на A');

for (const p of procs) p.kill('SIGTERM');
await mock.close();
console.log('\n  обращений к базе за весь прогон: ' + mock.counters.calls);
console.log(bad ? '\n  ЕСТЬ ПРОВАЛЫ\n' : '\n  Оба экземпляра видят одну и ту же картину.\n');
process.exit(bad ? 1 : 0);
