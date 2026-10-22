/**
 * pkg3-77: сигналы «пишет / загружает».
 *   • POST /api/typing ставит и снимает сигнал участника чата;
 *   • GET /api/typing отдаёт только чужие сигналы и только участникам чата;
 *   • сигналы короткоживущие: истекли сами, без записи в базу;
 *   • ответ синхронизации несёт «кто пишет» по всем моим чатам;
 *   • загрузка файла помечает себя сама: init/куски — «загружает…», fin — гаснет;
 *   • мусор вместо kind сигнал не ставит.
 * Запуск: node test/typing77.mjs
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
console.log('  «Пишет / загружает» — pkg3-77');
console.log('══════════════════════════════════════════════════\n');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sega-ty-'));
const port = await freePort();
const proc = spawn(process.execPath, ['server.js'], {
  cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
  env: Object.assign({}, process.env, {
    STORE: 'file', DATA_DIR: dir, HOST: '127.0.0.1', HTTPS: '', PRESENCE_EVERY: '0', NEW_INVITE_DELAY: '0',
    INVITE_COOLDOWN_MS: '0',   // лимит «одна ссылка в сутки» тесту не нужен
    PORT: String(port),
    // сигналы живут совсем недолго — тест не ждёт настоящие 9 и 60 секунд
    TYPING_TTL_TYPE: '700', TYPING_TTL_UPLOAD: '1500'
  })
});
procs.push(proc);
const base = `http://127.0.0.1:${port}`;
await waitReady(base);

const creds = name => ({ name, saltAuth: hex(), authKey: hex(32), saltWrap: hex(), wrappedKeyByPass: 'w:' + hex(), pub: 'pub:' + hex(), wrappedPriv: 'priv:' + hex() });
let r = await call(base, '/api/setup', { method: 'POST', body: Object.assign({}, creds('Мартин'), { codeProofSalt: hex(), codeProof: hex(32), codeSalt: hex(), wrappedKeyByCode: 'k:' + hex() }) });
ok(r.status === 200, 'мессенджер настроен');
const admin = r.d.token, adminId = r.d.user.id;
async function register(c, inviter) {
  const secret = hex(24);
  const sha = crypto.createHash('sha256').update(secret).digest('hex');
  const ir = await call(base, '/api/invites', { method: 'POST', body: { invSalt: hex(), wrappedRoomKey: 'k:' + hex(), secretHash: sha } }, inviter);
  if (!ir.d || !ir.d.invite) throw new Error('приглашение не создано: ' + ir.status + ' ' + JSON.stringify(ir.d).slice(0, 200));
  return call(base, '/api/register', { method: 'POST', body: Object.assign({}, c, { inviteToken: ir.d.invite.id + '.' + secret }) });
}
r = await register(creds('Поля'), admin);
const g1 = r.d.token, g1Id = r.d.user.id;
r = await register(creds('Гоша'), g1);
const g2 = r.d.token, g2Id = r.d.user.id;
r = await register(creds('Вася'), admin);
const v1 = r.d.token;
ok(!!g2 && !!v1, 'участники готовы');

r = await call(base, '/api/chats', { method: 'POST', body: { titleBlob: 'enc:' + hex(), members: [g1Id, g2Id], keys: { [adminId]: { blob: 'w-a' }, [g1Id]: { blob: 'w-1' }, [g2Id]: { blob: 'w-2' } } } }, admin);
const grp = r.d.chat.id;
ok(r.status === 200, 'группа создана');
r = await call(base, '/api/dm', { method: 'POST', body: { peer: g2Id } }, g1);
const dm = r.d.chat.id;
ok(r.status === 200, 'личный чат открыт');

// ── сигнал «пишет» в группе
r = await call(base, '/api/typing', { method: 'POST', body: { chat: grp, kind: 'type' } }, g1);
ok(r.status === 200 && Array.isArray(r.d.typing) && r.d.typing.length === 0, 'Поля сообщила «пишу» (в ответе только ЧУЖие сигналы — своих нет)');
r = await call(base, '/api/typing?chat=' + grp, {}, g2);
ok(r.status === 200 && r.d.typing.length === 1 && r.d.typing[0].uid === g1Id && r.d.typing[0].kind === 'type',
  'Гоша видит: Поля пишет');
r = await call(base, '/api/typing?chat=' + grp, {}, g1);
ok(r.status === 200 && r.d.typing.length === 0, 'сама Поля свой сигнал не видит');

// ── чужим вход закрыт
r = await call(base, '/api/typing?chat=' + grp, {}, v1);
ok(r.status === 403, 'не участник чата сигналы не видит (403)');
r = await call(base, '/api/typing', { method: 'POST', body: { chat: grp, kind: 'type' } }, v1);
ok(r.status === 403, 'не участник чата не может «писать» в него (403)');
r = await call(base, '/api/typing?chat=' + grp);
ok(r.status === 401, 'без входа сигналов нет (401)');

// ── синхронизация несёт «кто пишет»
r = await call(base, '/api/sync?since=999999999&rsince=0', {}, g2);
ok(r.status === 200 && Array.isArray(r.d.typing) && r.d.typing.some(t => t.uid === g1Id && t.chat === grp && t.kind === 'type'),
  'ответ синхронизации: Гоше видно, что Поля пишет в группе');

// ── стоп-сигнал
r = await call(base, '/api/typing', { method: 'POST', body: { chat: grp, kind: '' } }, g1);
ok(r.status === 200, 'Поля замолчала');
r = await call(base, '/api/typing?chat=' + grp, {}, g2);
ok(r.status === 200 && r.d.typing.length === 0, 'сигнал снят сразу');

// ── сигнал истекает сам
await call(base, '/api/typing', { method: 'POST', body: { chat: dm, kind: 'type' } }, g1);
await wait(1000);   // TYPING_TTL_TYPE=700
r = await call(base, '/api/typing?chat=' + dm, {}, g2);
ok(r.status === 200 && r.d.typing.length === 0, 'сигнал «пишет» истёк сам, без записи в базу');

// ── мусор вместо kind сигнал не ставит
r = await call(base, '/api/typing', { method: 'POST', body: { chat: dm, kind: 'шпионю' } }, g1);
ok(r.status === 200 && r.d.typing.length === 0, 'непонятный kind просто гасит сигнал');
r = await call(base, '/api/typing?chat=' + dm, {}, g2);
ok(r.d.typing.length === 0, 'после мусорного kind Гоше никто «не пишет»');

// ── загрузка файла помечает себя сама
r = await call(base, '/api/upload/init', { method: 'POST', body: { chat: grp, name: 'котик.png', size: 4, mime: 'image/png', parts: 1 } }, g1);
ok(r.status === 200, 'загрузка начата');
const upId = r.d.upId;
r = await call(base, '/api/typing?chat=' + grp, {}, g2);
ok(r.status === 200 && r.d.typing.length === 1 && r.d.typing[0].uid === g1Id && r.d.typing[0].kind === 'upload',
  'Гоша видит «загружает…» без единого сигнала от клиента — сервер понял из init');
r = await call(base, '/api/upload/chunk', { method: 'POST', body: { upId, i: 0, data: 'QUJDRA==' } }, g1);
ok(r.status === 200, 'кусок принят — сигнал продлён');
r = await call(base, '/api/upload/fin', { method: 'POST', body: { upId, stored: 4 } }, g1);
ok(r.status === 200, 'загрузка завершена');
r = await call(base, '/api/typing?chat=' + grp, {}, g2);
ok(r.status === 200 && r.d.typing.length === 0, 'файл доехал — «загружает…» погас');

// ── брошенная загрузка истекает сама
r = await call(base, '/api/upload/init', { method: 'POST', body: { chat: grp, name: 'видео.mp4', size: 4, mime: 'video/mp4', parts: 1 } }, g1);
ok(r.status === 200, 'вторая загрузка начата');
await wait(1800);   // TYPING_TTL_UPLOAD=1500
r = await call(base, '/api/typing?chat=' + grp, {}, g2);
ok(r.status === 200 && r.d.typing.length === 0, 'брошенная загрузка истекла сама');

// ── сигналы не пишутся в базу
const dbRaw = fs.readFileSync(path.join(dir, 'db.json'), 'utf8');
ok(!dbRaw.includes('typing') || !/"kind"\s*:\s*"(type|upload)"/.test(dbRaw), 'в базе данных сигналов нет — только память');

console.log('\n──────────────────────────────────────────────────');
console.log(`  «Пишет / загружает»: ${good} ✓, провалов ${bad}`);
console.log('──────────────────────────────────────────────────\n');
proc.kill('SIGTERM');
process.exit(bad ? 1 : 0);
