/**
 * pkg3-64: почта для восстановления пароля + «свежий» сброс.
 *
 * Что проверяется:
 *   • перенос: у старых учёток появляются email/emailConfirmed/recoveryBlob, db.recover;
 *   • без SMTP-настройки привязка почты честно отвечает 503 «почта не настроена»;
 *   • привязка: код уходит письмом (подставной SMTP-сервер), чужой код — 403,
 *     верный код — подтверждение; та же почта у другой учётки — 409;
 *   • копия восстановления (recoveryBlob) сохраняется, гигантская — 400;
 *   • запрос восстановления: не та почта/имя — единый 404 (не подсказываем),
 *     верные — письмо со ссылкой, токен одноразовый (state повторно — 410);
 *   • commit «полный»: новые соль/обёртки принимаются, вход новым паролем,
 *     старым — отказ; commit «свежий» (без wrappedPriv): личный ключ и pub
 *     сбрасываются, вход работает, обёрток нет;
 *   • частые письма — 429.
 *
 * Запуск: node test/recover.mjs
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { migrate, emptyDb } = require(path.join(ROOT, 'lib', 'model.js'));

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
  return new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
}
const procs = [];
process.on('exit', () => { for (const p of procs) { try { p.kill('SIGKILL'); } catch (e) {} } });
function up(port, env) {
  const p = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
    env: Object.assign({}, process.env, env, { PORT: String(port) })
  });
  procs.push(p);
  return { base: `http://127.0.0.1:${port}`, proc: p };
}

// ── подставной SMTP-сервер: говорит минимум протокола, письма складывает в mails
const mails = [];
function mockSmtp() {
  return new Promise(res => {
    const srv = net.createServer(sock => {
      sock.setEncoding('utf8');
      let bufIn = '';
      let dataMode = false, dataBuf = '', authStep = null;
      sock.write('220 mock ESMTP\r\n');
      sock.on('data', chunk => {
        bufIn += chunk;
        let i;
        while ((i = bufIn.indexOf('\r\n')) >= 0) {
          const ln = bufIn.slice(0, i); bufIn = bufIn.slice(i + 2);
          if (dataMode) {
            if (ln === '.') { dataMode = false; mails.push(dataBuf); sock.write('250 OK\r\n'); }
            else dataBuf += ln + '\n';
            continue;
          }
          const up = ln.toUpperCase();
          if (up.startsWith('EHLO')) sock.write('250-mock\r\n250 AUTH LOGIN\r\n');
          else if (up.startsWith('AUTH LOGIN')) { authStep = 'user'; sock.write('334 VXNlcm5hbWU6\r\n'); }
          else if (authStep === 'user') { authStep = 'pass'; sock.write('334 UGFzc3dvcmQ6\r\n'); }
          else if (authStep === 'pass') { authStep = null; sock.write('235 OK\r\n'); }
          else if (up.startsWith('MAIL FROM')) sock.write('250 OK\r\n');
          else if (up.startsWith('RCPT TO')) sock.write('250 OK\r\n');
          else if (up === 'DATA') { dataMode = true; dataBuf = ''; sock.write('354 go\r\n'); }
          else if (up === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
          else sock.write('250 OK\r\n');
        }
      });
      sock.on('error', () => {});
    });
    srv.listen(0, '127.0.0.1', () => res(srv));
  });
}

console.log('\n══════════════════════════════════════════════════');
console.log('  Почта и восстановление пароля — pkg3-64');
console.log('══════════════════════════════════════════════════\n');

// ══════════════════════════════ 1. перенос старых записей
console.log('  1. Старые записи базы');
{
  const db = emptyDb();
  db.users.push({ id: 'u1', name: 'Старый', nameLower: 'старый' });
  db.users.push({ id: 'u2', name: 'С почтой', nameLower: 'с почтой', email: 'a@b.ru', emailConfirmed: true, recoveryBlob: 'x' });
  migrate(db);
  ok(db.users[0].email === '' && db.users[0].emailConfirmed === false && db.users[0].recoveryBlob === null,
    'у старой учётки появились пустая почта, неподтверждённая, без копии');
  ok(db.users[1].email === 'a@b.ru' && db.users[1].recoveryBlob === 'x', 'привязанная почта и копия не тронуты');
  ok(Array.isArray(db.recover), 'появился список токенов восстановления db.recover');
  migrate(db);
  ok(db.users[0].email === '', 'перенос идемпотентен');
}

// ══════════════════════════════ 2. сервер БЕЗ почты: честный отказ
console.log('\n  2. Почта не настроена — честный отказ');
const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'sega-rc-a-'));
const A = up(await freePort(), { STORE: 'file', DATA_DIR: dirA, HOST: '127.0.0.1', HTTPS: '', PRESENCE_EVERY: '0', NEW_INVITE_DELAY: '0', INVITE_COOLDOWN_MS: '0', SEGA_SMTP_HOST: '', SEGA_SMTP_FROM: '' });
await waitReady(A.base);
const creds = (name) => ({
  name, saltAuth: hex(), authKey: hex(32), saltWrap: hex(),
  wrappedKeyByPass: 'w:' + hex(), pub: 'pub:' + hex(), wrappedPriv: 'priv:' + hex()
});
let r = await call(A.base, '/api/setup', {
  method: 'POST', body: Object.assign({}, creds('Мартин'), {
    codeProofSalt: hex(), codeProof: hex(32), codeSalt: hex(), wrappedKeyByCode: 'k:' + hex()
  })
});
ok(r.status === 200, 'мессенджер без SMTP настроен, администратор вошёл');
const adminA = r.d.token;
r = await call(A.base, '/api/profile', { method: 'POST', body: { email: 'kto@to.ru' } }, adminA);
ok(r.status === 503 && /не настроена/.test(r.d.error || ''), 'привязка почты без SMTP — 503 «почта не настроена»');

// ══════════════════════════════ 3. сервер С подставной почтой
console.log('\n  3. Привязка почты и восстановление');
const smtpSrv = await mockSmtp();
const smtpPort = smtpSrv.address().port;
const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'sega-rc-b-'));
const B = up(await freePort(), {
  STORE: 'file', DATA_DIR: dirB, HOST: '127.0.0.1', HTTPS: '', PRESENCE_EVERY: '0',
  NEW_INVITE_DELAY: '0', INVITE_COOLDOWN_MS: '0',
  SEGA_SMTP_HOST: '127.0.0.1', SEGA_SMTP_PORT: String(smtpPort),
  SEGA_SMTP_USER: 'bot', SEGA_SMTP_PASS: 'secret', SEGA_SMTP_FROM: 'chat@test.local'
});
await waitReady(B.base);

r = await call(B.base, '/api/setup', {
  method: 'POST', body: Object.assign({}, creds('Мартин'), {
    codeProofSalt: hex(), codeProof: hex(32), codeSalt: hex(), wrappedKeyByCode: 'k:' + hex()
  })
});
ok(r.status === 200, 'мессенджер с SMTP настроен');
const admin = r.d.token;

async function register(c, inviter) {
  const secret = hex(24);
  const sha = crypto.createHash('sha256').update(secret).digest('hex');
  const ir = await call(B.base, '/api/invites', { method: 'POST', body: { invSalt: hex(), wrappedRoomKey: 'k:' + hex(), secretHash: sha } }, inviter);
  if (!ir.d.invite) throw new Error('приглашение не создано: ' + JSON.stringify(ir.d));
  return call(B.base, '/api/register', { method: 'POST', body: Object.assign({}, c, { inviteToken: ir.d.invite.id + '.' + secret }) });
}
const polyaC = creds('Поля');
r = await register(polyaC, admin);
const polya = r.d.token;
const klavaC = creds('Клава');
r = await register(klavaC, polya);
const klava = r.d.token;
ok(!!polya && !!klava, 'участницы Поля и Клава готовы');

r = await call(B.base, '/api/profile', {}, polya);
ok(r.status === 200 && r.d.email === '' && r.d.emailConfirmed === false && r.d.hasRecoveryBlob === false,
  'GET /api/profile: почты нет, копии нет');

r = await call(B.base, '/api/profile', { method: 'POST', body: { email: 'непочта' } }, polya);
ok(r.status === 400, 'кривой адрес почты — 400');

mails.length = 0;
r = await call(B.base, '/api/profile', { method: 'POST', body: { email: 'Polina@Test.Local' } }, polya);
ok(r.status === 200, 'запрос привязки принят');
await wait(300);
ok(mails.length === 1 && /Polina@Test\.Local|polina@test\.local/i.test(mails[0]) || mails.length === 1, 'письмо с кодом ушло');
const codeMatch = (mails[0] || '').match(/Код подтверждения: (\d{6})/);
ok(!!codeMatch, 'в письме шестизначный код');

r = await call(B.base, '/api/profile', { method: 'POST', body: { emailCode: '000000' } }, polya);
ok(r.status === 403, 'чужой код — 403');
r = await call(B.base, '/api/profile', { method: 'POST', body: { emailCode: codeMatch[1] } }, polya);
ok(r.status === 200, 'верный код — почта подтверждена');
r = await call(B.base, '/api/profile', {}, polya);
ok(r.d.email === 'polina@test.local' && r.d.emailConfirmed === true, 'почта сохранена в нижнем регистре, подтверждена');

r = await call(B.base, '/api/profile', { method: 'POST', body: { email: 'polina@test.local' } }, klava);
ok(r.status === 409, 'та же почта у второй учётки — 409');

r = await call(B.base, '/api/profile', { method: 'POST', body: { recoveryBlob: 'x'.repeat(20000) } }, polya);
ok(r.status === 400, 'гигантская копия восстановления — 400');
const blob = 'blob:' + hex(64);
r = await call(B.base, '/api/profile', { method: 'POST', body: { recoveryBlob: blob } }, polya);
ok(r.status === 200, 'копия восстановления сохранена');
r = await call(B.base, '/api/profile', {}, polya);
ok(r.d.hasRecoveryBlob === true, 'GET /api/profile видит копию');

// ── запросы восстановления
r = await call(B.base, '/api/recover/request', { method: 'POST', body: { name: 'Поля', email: 'levy@test.local' } });
ok(r.status === 404, 'чужая почта — единый 404 (не подсказываем)');
r = await call(B.base, '/api/recover/request', { method: 'POST', body: { name: 'НетТакой', email: 'polina@test.local' } });
ok(r.status === 404, 'неверное имя — тот же 404');
mails.length = 0;
r = await call(B.base, '/api/recover/request', { method: 'POST', body: { name: 'Поля', email: 'polina@test.local' } });
ok(r.status === 200, 'верные имя и почта — запрос принят');
await wait(300);
const tokMatch = (mails[0] || '').match(/\/\?recover=([0-9a-f]{48})/);
ok(mails.length === 1 && !!tokMatch, 'письмо со ссылкой восстановления ушло, токен в ссылке');
const token = tokMatch[1];
r = await call(B.base, '/api/recover/request', { method: 'POST', body: { name: 'Поля', email: 'polina@test.local' } });
ok(r.status === 429, 'повторное письмо сразу — 429 (защита от спама)');

r = await call(B.base, '/api/recover/state?token=' + hex(24));
ok(r.status === 410, 'левый токен — 410');
r = await call(B.base, '/api/recover/state?token=' + token);
ok(r.status === 200 && r.d.name === 'Поля' && r.d.hasBlob === true && r.d.blob === blob,
  'state по токену: имя, наличие копии и сама копия');

r = await call(B.base, '/api/recover/commit', { method: 'POST', body: { token: hex(24), saltAuth: hex(), authKey: hex(32), saltWrap: hex() } });
ok(r.status === 410, 'commit с левым токеном — 410');

// полный режим: новые креденшелы + пере-завёрнутые ключи
const newPolya = { saltAuth: hex(), authKey: hex(32), saltWrap: hex(), wrappedKeyByPass: 'w2:' + hex(), wrappedPriv: 'priv2:' + hex() };
r = await call(B.base, '/api/recover/commit', { method: 'POST', body: Object.assign({ token }, newPolya) });
ok(r.status === 200 && r.d.mode === 'full', 'commit полный: принят, mode=full');
r = await call(B.base, '/api/recover/state?token=' + token);
ok(r.status === 410, 'токен одноразовый: повторно — 410');

r = await call(B.base, '/api/salt', { method: 'POST', body: { name: 'Поля' } });
ok(r.d.saltAuth === newPolya.saltAuth, 'соль входа заменена на новую');
r = await call(B.base, '/api/login', { method: 'POST', body: { name: 'Поля', authKey: newPolya.authKey } });
ok(r.status === 200, 'вход новым паролем работает');
ok(r.d.wrappedPriv === newPolya.wrappedPriv && r.d.wrappedKeyByPass === newPolya.wrappedKeyByPass,
  'новые обёртки ключей выданы при входе');
r = await call(B.base, '/api/login', { method: 'POST', body: { name: 'Поля', authKey: polyaC.authKey } });
ok(r.status !== 200, 'старым паролем вход больше не работает');

// ── «свежий» режим (без кода): ключи и pub сбрасываются
mails.length = 0;
r = await call(B.base, '/api/profile', { method: 'POST', body: { email: 'klava@test.local' } }, klava);
ok(r.status === 200, 'Клава запросила привязку');
await wait(300);
const codeK = ((mails[0] || '').match(/Код подтверждения: (\d{6})/) || [])[1];
r = await call(B.base, '/api/profile', { method: 'POST', body: { emailCode: codeK } }, klava);
ok(r.status === 200, 'Клава подтвердила почту');
mails.length = 0;
r = await call(B.base, '/api/recover/request', { method: 'POST', body: { name: 'Клава', email: 'klava@test.local' } });
ok(r.status === 200, 'запрос восстановления Клавы принят');
await wait(300);
const tokenK = ((mails[0] || '').match(/\/\?recover=([0-9a-f]{48})/) || [])[1];
ok(!!tokenK, 'ссылка Клаве ушла');
const fresh = { saltAuth: hex(), authKey: hex(32), saltWrap: hex(), wrappedKeyByPass: null, wrappedPriv: null };
r = await call(B.base, '/api/recover/commit', { method: 'POST', body: Object.assign({ token: tokenK }, fresh) });
ok(r.status === 200 && r.d.mode === 'fresh', 'commit свежий: принят, mode=fresh');
r = await call(B.base, '/api/login', { method: 'POST', body: { name: 'Клава', authKey: fresh.authKey } });
ok(r.status === 200, 'вход новым паролем Клавы работает');
ok(!r.d.wrappedKeyByPass && !r.d.wrappedPriv && !r.d.user.pub,
  'обёртки и pub сброшены: при входе пересоздастся пара ключей, старая история закрыта');

// ── отвязка почты стирает копию
r = await call(B.base, '/api/profile', { method: 'POST', body: { email: '' } }, polya);
ok(r.status === 200, 'почта отвязана');
r = await call(B.base, '/api/profile', {}, polya);
ok(r.d.email === '' && r.d.emailConfirmed === false && r.d.hasRecoveryBlob === false,
  'после отвязки: почты, подтверждения и копии восстановления нет');

// ── разметка клиента на месте
console.log('\n  4. Клиент: галочки и экран восстановления');
const appJs = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const idxHtml = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
ok(idxHtml.includes('id="login-show-pass"') && idxHtml.includes('Показать пароль'), 'в окне входа галочка «Показать пароль»');
ok(idxHtml.includes('id="reg-show-pass"'), 'в окне регистрации галочка «Показать пароль»');
ok(idxHtml.includes('id="screen-recover"') && idxHtml.includes('recover-steps'), 'экран восстановления в разметке');
ok(idxHtml.includes('id="login-forgot"'), 'на входе ссылка «Забыли пароль?»');
ok(/openRecover\(/.test(appJs) && /makeRecoveryCode/.test(appJs) && /paintPfMail/.test(appJs),
  'в app.js: экран восстановления, код восстановления, блок почты в профиле');
ok(/URLSearchParams\(location\.search\)\.get\('recover'\)/.test(appJs), 'boot() ловит ?recover= из письма');
ok(/parseRecoveryCode/.test(appJs) && /fmtRecoveryCode/.test(appJs), 'код восстановления форматируется и разбирается');
const smtpLib = fs.readFileSync(path.join(ROOT, 'lib', 'smtp.js'), 'utf8');
ok(/SEGA_SMTP_HOST/.test(smtpLib) && !/require\(['"]nodemailer/.test(smtpLib), 'свой SMTP-клиент без новых зависимостей');

procs.forEach(p => { try { p.kill('SIGKILL'); } catch (e) {} });
smtpSrv.close();
console.log('\n  ИТОГ: ' + good + ' ✓' + (bad ? ', ' + bad + ' ✗ ПРОВАЛОВ' : ', провалов нет'));
if (bad) { console.log('ЕСТЬ ПРОВАЛЫ'); process.exit(1); }
process.exit(0);
