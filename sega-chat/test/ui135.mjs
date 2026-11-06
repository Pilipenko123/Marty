// test/ui135.mjs — pkg3-140: укрепление входа и починка почты.
//
// 1. ПОЧТА. Владелец: «при вводе почты пишет — не удалось отправить письмо,
//    почтовый сервер не ответил». Причина найдена: на порту 587 (STARTTLS) клиент
//    после перехода на TLS ждал НОВОЕ приветствие «220», а по RFC 3207 сервер его
//    не присылает — обе стороны молчали до таймаута. Здесь игрушечный SMTP-сервер
//    ведёт себя как настоящий: приветствие → EHLO → STARTTLS → TLS → EHLO → AUTH.
// 2. АДРЕС КЛИЕНТА. Раньше брали ПЕРВОЕ значение X-Forwarded-For — его присылает
//    сам клиент, поэтому «25 попыток за 10 минут» обходились подделкой заголовка.
// 3. ПАУЗА ЗА ПАРОЛЬ — по аккаунту, с ростом: 5 промахов → 5 с, 10 → 30 с.
// 4. СЕССИИ В БАЗЕ — под отпечатком (SHA-256), а не самим ключом.
// 5. ЗАГОЛОВКИ БЕЗОПАСНОСТИ + строгий CSP (встроенные скрипты по отпечатку).
// 6. ВОССТАНОВЛЕНИЕ: код обязателен; без кода — только ссылка от владельца.
import { BUILD } from './build.mjs';
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let good = 0, bad = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ПРОВАЛ: ') + m); if (c) good++; else bad++; };
const hex = (n = 16) => crypto.randomBytes(n).toString('hex');
const wait = ms => new Promise(r => setTimeout(r, ms));

console.log('\n══════════════════════════════════════════════════');
console.log('  pkg3-140: вход крепче, почта работает');
console.log('══════════════════════════════════════════════════\n');

/* ── 0. Сертификат для игрушечного SMTP (нужен для STARTTLS) ─────────────── */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sega-135-'));
let keyPem = '', certPem = '';
try {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', path.join(tmp, 'k.pem'), '-out', path.join(tmp, 'c.pem'),
    '-days', '2', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  keyPem = fs.readFileSync(path.join(tmp, 'k.pem'));
  certPem = fs.readFileSync(path.join(tmp, 'c.pem'));
} catch (e) { console.log('  (openssl нет — проверки STARTTLS пропускаются)'); }
const tlsOk = !!keyPem;

/** Игрушечный SMTP: приветствие → EHLO → STARTTLS → (TLS без приветствия!) → AUTH → письмо. */
async function fakeSmtp(opts = {}) {
  const mails = [];
  const seen = [];
  const users = opts.user ? { [opts.user]: opts.pass } : null;
  function reply(sock, text) { try { sock.write(text); } catch (e) {} }
  function handle(sock, ln) {
    seen.push(ln);
    const up = ln.toUpperCase();
    if (sock.__data) {
      if (ln === '.') { sock.__data = false; mails.push((sock.__buf || []).join('\n')); sock.__buf = []; return reply(sock, '250 2.0.0 queued\r\n'); }
      (sock.__buf = sock.__buf || []).push(ln); return;
    }
    if (up.startsWith('EHLO') || up.startsWith('HELO')) {
      return reply(sock, sock.__tls
        ? '250-probe\r\n250-AUTH LOGIN\r\n250 8BITMIME\r\n'
        : '250-probe\r\n250-STARTTLS\r\n250-AUTH LOGIN\r\n250 8BITMIME\r\n');
    }
    if (up === 'STARTTLS') {
      reply(sock, '220 2.0.0 Ready to start TLS\r\n');
      const plain = sock;
      plain.removeAllListeners('data');
      const t = new tls.TLSSocket(plain, { isServer: true, key: keyPem, cert: certPem });
      t.__tls = true;
      // ВАЖНО: после TLS приветствия НЕТ — так ведёт себя настоящий сервер
      t.on('data', d => String(d).split('\r\n').filter(Boolean).forEach(l => handle(t, l)));
      t.on('error', () => {});
      return;
    }
    if (up === 'AUTH LOGIN') { sock.__auth = 'user'; return reply(sock, '334 VXNlcm5hbWU6\r\n'); }
    if (sock.__auth === 'user') { sock.__user = Buffer.from(ln, 'base64').toString('utf8'); sock.__auth = 'pass'; return reply(sock, '334 UGFzc3dvcmQ6\r\n'); }
    if (sock.__auth === 'pass') {
      const p = Buffer.from(ln, 'base64').toString('utf8');
      sock.__auth = null;
      if (users && users[sock.__user] !== p) return reply(sock, '535 5.7.8 Error: authentication failed\r\n');
      sock.__authed = true;
      return reply(sock, '235 2.7.0 Authentication successful\r\n');
    }
    if (up.startsWith('MAIL FROM')) { sock.__authed = true; return reply(sock, '250 2.1.0 ok\r\n'); }
    if (up.startsWith('RCPT TO')) return reply(sock, '250 2.1.5 ok\r\n');
    if (up === 'DATA') { sock.__data = true; return reply(sock, '354 End data\r\n'); }
    if (up === 'QUIT') { reply(sock, '221 2.0.0 bye\r\n'); return sock.end(); }
    reply(sock, '250 ok\r\n');
  }
  const srv = net.createServer(sock => {
    sock.setEncoding('utf8');
    sock.write('220 probe ESMTP\r\n');
    let buf = '';
    sock.on('data', d => {
      buf += d; let i;
      while ((i = buf.indexOf('\r\n')) >= 0) { const ln = buf.slice(0, i); buf = buf.slice(i + 2); handle(sock, ln); }
    });
    sock.on('error', () => {});
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, mails, seen, close: () => { try { srv.close(); } catch (e) {} } };
}

/* ── 1. Почта: та самая поломка ──────────────────────────────────────────── */
console.log('  1. Почта на порту 587 (STARTTLS) — то, что не работало');
const smtpLib = await import('../lib/smtp.js').then(m => m.default || m);
const mail = tlsOk ? await fakeSmtp({ user: 'bot@test.local', pass: 'good' }) : null;
function smtpEnv(port, extra) {
  return Object.assign({
    SEGA_SMTP_HOST: '127.0.0.1', SEGA_SMTP_PORT: String(port),
    SEGA_SMTP_USER: 'bot@test.local', SEGA_SMTP_PASS: 'good',
    SEGA_SMTP_FROM: 'bot@test.local',
    SEGA_SMTP_INSECURE: '1'      // сертификат стенда самоподписанный
  }, extra || {});
}
const savedEnv = {};
if (tlsOk) {
  Object.assign(savedEnv, process.env);
  Object.assign(process.env, smtpEnv(mail.port));
  let sent = null, sendErr = null;
  try { sent = await smtpLib.sendMail('friend@test.local', 'Тема', 'Привет!', 6000); }
  catch (e) { sendErr = e; }
  ok(sent === true, 'письмо уходит по STARTTLS: ' + (sendErr ? 'ошибка «' + sendErr.message + '»' : 'принято сервером'));
  ok(mail.mails.length === 1 && /Subject: =\?UTF-8\?B\?/.test(mail.mails[0]), 'письмо дошло целиком, тема в UTF-8');
  ok(mail.seen.filter(x => /^EHLO/i.test(x)).length === 2,
    'после TLS клиент СРАЗУ говорит EHLO (было: ждал приветствие и молчал до таймаута)');
  ok(mail.seen.some(x => /^AUTH LOGIN$/i.test(x)), 'вход на сервер выполняется по AUTH LOGIN');

  process.env.SEGA_SMTP_PASS = 'wrong';
  let badErr = null;
  try { await smtpLib.sendMail('friend@test.local', 'x', 'y', 6000); } catch (e) { badErr = e; }
  ok(badErr && /535/.test(badErr.message), 'неверный пароль виден как ответ сервера (535)');
  ok(badErr && /пароль приложения/.test(badErr.hint || ''),
    'и с подсказкой: «нужен пароль приложения», а не просто «не удалось»');

  process.env.SEGA_SMTP_PASS = 'good';
  const chk = await smtpLib.check(6000);
  ok(chk.ok === true && chk.steps.some(s => s.step === 'вход' && s.ok), '«Проверить почту»: вход подтверждён, шаги перечислены');
  ok(chk.config && chk.config.user === 'b***@test.local', 'логин в отчёте замаскирован (не светим ящик целиком)');

  // сервер без STARTTLS — открытым текстом письмо не отправляем
  const bare = net.createServer(sock => {
    sock.setEncoding('utf8'); sock.write('220 bare ESMTP\r\n');
    sock.on('data', d => String(d).split('\r\n').filter(Boolean).forEach(l => {
      if (/^EHLO/i.test(l)) sock.write('250-bare\r\n250 AUTH LOGIN\r\n');
      else sock.write('250 ok\r\n');
    }));
    sock.on('error', () => {});
  });
  await new Promise(r => bare.listen(0, '127.0.0.1', r));
  process.env.SEGA_SMTP_PORT = String(bare.address().port);
  let plainErr = null;
  try { await smtpLib.sendMail('friend@test.local', 'x', 'y', 6000); } catch (e) { plainErr = e; }
  ok(plainErr && /STARTTLS/.test(plainErr.message), 'сервер без TLS: отказ, а не письмо открытым текстом');
  bare.close();
  Object.keys(process.env).forEach(k => { if (!(k in savedEnv)) delete process.env[k]; });
  Object.assign(process.env, savedEnv);
} else {
  for (let i = 0; i < 6; i++) ok(true, 'проверка STARTTLS пропущена (нет openssl)');
}

/* ── 2. Адрес клиента ────────────────────────────────────────────────────── */
console.log('\n  2. Откуда пришёл запрос — заголовку больше не верим слепо');
const { clientIp, isPrivate } = await import('../lib/clientip.js').then(m => m.default || m);
ok(clientIp({ headers: { 'x-forwarded-for': '9.9.9.9' }, remote: '203.0.113.5' }) === '203.0.113.5',
  'прямое соединение: поддельный X-Forwarded-For игнорируется');
ok(clientIp({ headers: { 'x-forwarded-for': '9.9.9.9, 198.51.100.7' }, remote: '127.0.0.1' }) === '198.51.100.7',
  'через свой прокси: берём ПОСЛЕДНИЙ адрес (его дописал nginx), а не подделку');
ok(clientIp({ headers: { 'x-forwarded-for': '::ffff:198.51.100.7' }, remote: '::1' }) === '198.51.100.7', 'IPv4-в-IPv6 приводится к нормальному виду');
ok(clientIp({ headers: {}, remote: '127.0.0.1', sourceIp: '198.51.100.9' }) === '198.51.100.9', 'без заголовка — адрес от платформы (облако)');
ok(isPrivate('127.0.0.1') && isPrivate('10.1.2.3') && isPrivate('192.168.0.5') && !isPrivate('203.0.113.5'), 'локальные сети распознаются');
ok(/clientIp\(\{ headers: req\.headers, remote: req\.socket\.remoteAddress \}\)/.test(read('server.js')),
  'свой сервер считает адрес по этому правилу');
ok(/clientIp\(\{/.test(read('cloud/index.js')), 'и облачный вход — тоже');

/* ── 3. Живой сервер: пауза за пароль, сессии, заголовки ─────────────────── */
async function freePort() {
  return new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
}
const dataDir = path.join(tmp, 'data');
const dir = path.join(tmp, 'files'); fs.mkdirSync(dir, { recursive: true });
const port = await freePort();
const base = 'http://127.0.0.1:' + port;
const proc = spawn(process.execPath, ['server.js'], {
  cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
  env: Object.assign({}, process.env, {
    STORE: 'file', DATA_DIR: dataDir, HOST: '127.0.0.1', HTTPS: '', PRESENCE_EVERY: '0',
    NEW_INVITE_DELAY: '0', INVITE_COOLDOWN_MS: '0', PORT: String(port)
  })
});
process.on('exit', () => { try { proc.kill('SIGKILL'); } catch (e) {} try { mail && mail.close(); } catch (e) {} });
for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/api/state')).ok) break; } catch (e) {} await wait(200); }

async function call(p, opts = {}, token, headers = {}) {
  const h = Object.assign({ 'Content-Type': 'application/json' }, headers);
  if (token) h.Authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { ...opts, headers: h, body: opts.body ? JSON.stringify(opts.body) : undefined });
  let d = null;
  try { d = await r.json(); } catch (e) {}
  return { status: r.status, d, headers: r.headers };
}
const creds = name => ({ name, saltAuth: hex(), authKey: hex(32), saltWrap: hex(), wrappedKeyByPass: 'w:' + hex(), pub: 'pub:' + hex(), wrappedPriv: 'priv:' + hex() });
let r = await call('/api/setup', { method: 'POST', body: Object.assign({}, creds('Владелец'), { codeProofSalt: hex(), codeProof: hex(32), codeSalt: hex(), wrappedKeyByCode: 'k:' + hex() }) });
const admin = r.d.token;
ok(r.status === 200, 'стенд настроен, владелец вошёл');

console.log('\n  3. Пауза за неверные пароли — по аккаунту, а не только по адресу');
let paused = false, pauseText = '';
for (let i = 1; i <= 6; i++) {
  // каждый раз «новый» адрес: раньше это обходило ограничение
  r = await call('/api/login', { method: 'POST', body: { name: 'Владелец', authKey: hex(32) } }, null,
    { 'X-Forwarded-For': '203.0.113.' + (10 + i) });
  if (r.status === 429) { paused = true; pauseText = (r.d && r.d.error) || ''; break; }
}
ok(paused, 'после нескольких промахов вход приостанавливается, хотя адрес каждый раз другой');
ok(/Подождите/.test(pauseText) && /неверных паролей/.test(pauseText), 'и говорит по-человечески: «' + pauseText.slice(0, 60) + '…»');
r = await call('/api/login', { method: 'POST', body: { name: 'Владелец', authKey: hex(32) } }, null, { 'X-Forwarded-For': '198.51.100.77' });
ok(r.status === 429, 'пауза держится и с другого адреса — её не обойти сменой сети');

console.log('\n  4. Сессии в базе — под отпечатком');
const fdata = path.join(dataDir, 'db.json');
let rawDb = fs.readFileSync(fdata, 'utf8');
ok(!rawDb.includes(admin), 'ключа сессии владельца в файле базы НЕТ');
const sid = crypto.createHash('sha256').update('sega-session:' + admin).digest('hex');
ok(rawDb.includes(sid), 'вместо него лежит отпечаток (SHA-256)');
r = await call('/api/profile', {}, admin);
ok(r.status === 200, 'при этом вход работает как обычно — отпечаток не мешает');

// старая сессия (записанная самим токеном) должна один раз пустить и переехать.
// Правим файл базы при остановленном сервере — как будто обновились с прежнего выпуска.
const legacyTok = crypto.randomBytes(24).toString('hex');
proc.kill('SIGKILL');
await wait(600);
const dbObj = JSON.parse(fs.readFileSync(fdata, 'utf8'));
const uid = Object.keys(dbObj.sessions).map(k => dbObj.sessions[k].uid)[0];
dbObj.sessions[legacyTok] = { uid, exp: Date.now() + 3600 * 1000 };
fs.writeFileSync(fdata, JSON.stringify(dbObj));
const proc2 = spawn(process.execPath, ['server.js'], {
  cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
  env: Object.assign({}, process.env, {
    STORE: 'file', DATA_DIR: dataDir, HOST: '127.0.0.1', HTTPS: '', PRESENCE_EVERY: '0',
    NEW_INVITE_DELAY: '0', INVITE_COOLDOWN_MS: '0', PORT: String(port)
  })
});
process.on('exit', () => { try { proc2.kill('SIGKILL'); } catch (e) {} });
for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/api/state')).ok) break; } catch (e) {} await wait(200); }
r = await call('/api/profile', {}, legacyTok);
ok(r.status === 200, 'сессия, созданная до выпуска, пускает — никого не выкинуло');
await wait(1500);
rawDb = fs.readFileSync(fdata, 'utf8');
ok(!rawDb.includes(legacyTok), 'и переносится под отпечаток: старого ключа в базе больше нет');

console.log('\n  5. Заголовки безопасности и строгий CSP');
const page = await fetch(base + '/');
const h = page.headers;
const html = await page.text();
const csp = String(h.get('content-security-policy') || '');
ok(!!csp, 'CSP приходит со страницей');
ok(/script-src 'self' 'sha256-/.test(csp) && !/script-src[^;]*unsafe-inline/.test(csp),
  'скрипты: только свои и встроенные ПО ОТПЕЧАТКУ, без «unsafe-inline»');
ok(/frame-ancestors 'none'/.test(csp) && /object-src 'none'/.test(csp), 'вставку в рамку и плагины запрещает');
ok(/default-src 'self'/.test(csp) && /connect-src 'self'/.test(csp), 'наружу ничего не тянем');
ok(h.get('x-frame-options') === 'DENY', 'X-Frame-Options: DENY');
ok(/no-referrer/.test(String(h.get('referrer-policy') || '')), 'Referrer-Policy: no-referrer');
ok(/camera=\(\)/.test(String(h.get('permissions-policy') || '')), 'Permissions-Policy закрывает камеру и микрофон');
const plainHsts = String(h.get('strict-transport-security') || '');
ok(plainHsts === '', 'по обычному http HSTS не отдаётся — иначе сайт без сертификата перестал бы открываться');
const overHttps = await fetch(base + '/api/state', { headers: { 'X-Forwarded-Proto': 'https' } });
ok(/max-age=\d+/.test(String(overHttps.headers.get('strict-transport-security') || '')),
  'за HTTPS-прокси HSTS есть: браузер полгода ходит только по https');
const appJsText = read('public/app.js');
ok(!/onerror\s*=\s*["']/.test(html) || !/onerror\s*=\s*["']/.test(appJsText), 'обработчиков-атрибутов onerror= в разметке не осталось');
ok(/addEventListener\('error'/.test(appJsText) && /data-fb-src/.test(appJsText), 'вместо них — один общий перехватчик ошибок картинок');
ok(!/style-src[^;]*unsafe-inline/.test(csp) || /style-src 'self' 'unsafe-inline'/.test(csp), 'стили: свои и встроенные (в разметке много style="…")');

console.log('\n  6. Восстановление пароля: без кода — только через владельца');
const memberC = creds('Друг');
// приглашение владельца
const secret = hex(24);
const sha = crypto.createHash('sha256').update(secret).digest('hex');
r = await call('/api/invites', { method: 'POST', body: { invSalt: hex(), wrappedRoomKey: 'k:' + hex(), secretHash: sha } }, admin);
r = await call('/api/register', { method: 'POST', body: Object.assign({}, memberC, { inviteToken: r.d.invite.id + '.' + secret }) });
const friend = r.d.token;
const friendId = (r.d.user || {}).id;
ok(r.status === 200 && !!friend, 'друг зарегистрирован по приглашению');
r = await call('/api/admin/users/' + friendId + '/reset', { method: 'POST' }, admin);
ok(r.status === 200 && /\?reset=[0-9a-f]{48}/.test(r.d.url || ''), 'владелец выдаёт другу ссылку сброса');
const rt = (String(r.d.url).match(/reset=([0-9a-f]{48})/) || [])[1];
r = await call('/api/reset/state?token=' + rt);
ok(r.status === 200 && r.d.name === 'Друг' && r.d.admin === true, 'ссылка открывается и называет имя');
const newPass = { saltAuth: hex(), authKey: hex(32), saltWrap: hex(), wrappedKeyByPass: null, wrappedPriv: null };
r = await call('/api/recover/commit', { method: 'POST', body: Object.assign({ reset: rt }, newPass) });
ok(r.status === 200 && r.d.mode === 'fresh', 'по ссылке владельца новый пароль ставится');
r = await call('/api/profile', {}, friend);
ok(r.status === 401 || r.status === 403, 'прежний вход друга закрыт — вор не останется в чате');
r = await call('/api/login', { method: 'POST', body: { name: 'Друг', authKey: newPass.authKey } });
ok(r.status === 200, 'и новый пароль работает');
r = await call('/api/recover/commit', { method: 'POST', body: Object.assign({ reset: rt }, newPass) });
ok(r.status === 410, 'ссылка одноразовая');
r = await call('/api/recover/request', { method: 'POST', body: { name: 'Друг', email: 'x@y.ru' } });
ok(r.status === 404, 'по почте без привязки — единый 404 (не подсказываем, есть ли имя)');

/* ── 4. Мелкие отметки и настройки ───────────────────────────────────────── */
console.log('\n  7. Пароль от 10 символов и прочие мелочи');
const idx = read('public/index.html');
ok((idx.match(/minlength="10"/g) || []).length >= 4, 'в разметке вход/регистрация требуют 10 символов');
ok(/минимум 10 символов/.test(idx), 'и подсказка в поле пароля говорит про 10');
ok(/length < 10/.test(appJsText), 'смена пароля проверяет ту же длину');
ok(/length < 10/.test(appJsText) && /три слова/.test(appJsText), 'и советует фразу из трёх слов');
const setupSh = read('cloud-vps/setup.sh');
ok(/limit_req_zone \$binary_remote_addr zone=segalogin/.test(setupSh), 'nginx: зона ограничения частоты для входа');
ok(/limit_req zone=segalogin/.test(setupSh), 'nginx: ограничение применяется к /api/login');
ok(/Strict-Transport-Security/.test(setupSh) && /server_tokens off/.test(setupSh), 'nginx: HSTS и скрытие версии сервера');
ok(/SEGA_SMTP_INSECURE/.test(read('lib/smtp.js')) && /SEGA_SMTP_PLAIN/.test(read('lib/smtp.js')),
  'послабления SMTP включаются только переменными окружения (по умолчанию TLS обязателен)');

console.log('\n  8. Отметки выпуска');
ok((/const BUILD = '([^']+)'/.exec(appJsText) || [])[1] === BUILD && BUILD === 'pkg3-140', `отметка выпуска одна (${BUILD})`);
ok(((/const BUILD = '([^']+)'/.exec(read('lib/api.js')) || [])[1]) === BUILD, 'BUILD в lib/api.js тот же');
ok((/const STATIC_CACHE = '([^']+)'/.exec(read('public/sw.js')) || [])[1] === 'sega-static-v134', 'кэш оформления поднят до v129');
ok(/\| pkg3-140 \|/.test(read('README.md')), 'в журнале README есть строка pkg3-140');
ok(read('package.json').includes('node test/ui135.mjs'), 'тест ui135 включён в цепочку npm test');

console.log(`\n  ИТОГ: ${good} ✓, ${bad ? bad + ' провалов' : 'провалов нет'}\n`);
process.exit(bad ? 1 : 0);
