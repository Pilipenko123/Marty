// test/ui136.mjs — pkg3-146: «письмо не уходит» → по одному нажатию видно, почему.
//
// После 135-го владелец получил честный текст: «почтовый сервер не ответил за
// 20 с · соединение не установилось». Это уже лучше прежнего молчания, но всё
// ещё не ответ: то ли адрес неверный, то ли порт закрыт, то ли сервер молчит.
// Здесь проверяем новую проверку почты:
//   • имя сервера находится или нет (DNS);
//   • отвечают ли порты 465 (SSL), 587 (STARTTLS), 25 и порт из .env;
//   • проходит ли вход (AUTH) — и что именно ответил сервер;
//   • совет по делу: «смените порт на 465» / «порты закрыты у хостера» / «всё в порядке»;
//   • в текстах ошибок видно, КАКОЙ сервер молчал (host:port), а не безымянный «он».
import { BUILD } from './build.mjs';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let good = 0, bad = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ПРОВАЛ: ') + m); if (c) good++; else bad++; };
const hex = (n = 16) => crypto.randomBytes(n).toString('hex');
const wait = ms => new Promise(r => setTimeout(r, ms));

console.log('\n══════════════════════════════════════════════════');
console.log('  pkg3-146: проверка почты — имя, порты, вход');
console.log('══════════════════════════════════════════════════\n');

const smtp = await import('../lib/smtp.js').then(m => m.default || m);

/* ── 1. Имя сервера ──────────────────────────────────────────────────────── */
console.log('  1. Находится ли имя сервера');
const dnsLocal = await smtp.resolveHost('127.0.0.1');
ok(dnsLocal.ok && dnsLocal.addresses.length >= 1, 'числовой адрес «находится» и отдаётся списком');
const dnsBad = await smtp.resolveHost('нет-такого-сервера.invalid');
ok(!dnsBad.ok && !!dnsBad.error, `несуществующее имя честно не находится (${dnsBad.error})`);

/* ── 2. Порты: отвечает / молчит / закрыт ────────────────────────────────── */
console.log('\n  2. Порты: кто отвечает, кто молчит');
const talking = net.createServer(sock => { sock.setEncoding('utf8'); sock.write('220 probe ESMTP ready\r\n'); sock.on('error', () => {}); });
await new Promise(r => talking.listen(0, '127.0.0.1', r));
const talkingPort = talking.address().port;
const p1 = await smtp.probePort('127.0.0.1', talkingPort, 2000);
ok(p1.ok && /220/.test(p1.detail), `живой порт отвечает и показывает приветствие («${p1.detail}»)`);
ok(p1.mode === 'STARTTLS', 'режим порта назван (у 465 будет SSL)');

const silent = net.createServer(() => { /* принимает и молчит */ });
await new Promise(r => silent.listen(0, '127.0.0.1', r));
const silentPort = silent.address().port;
const t0 = Date.now();
const p2 = await smtp.probePort('127.0.0.1', silentPort, 1200);
ok(!p2.ok && /нет ответа/.test(p2.detail), 'молчащий порт отличается от закрытого — «нет ответа»');
ok(Date.now() - t0 < 3000, 'и проверка не висит: укладывается в свой срок');

const deadPort = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const p3 = await smtp.probePort('127.0.0.1', deadPort, 1500);
ok(!p3.ok, 'закрытый порт — отказ сразу, без ожидания');

/* ── 3. Полный отчёт: подставной SMTP на своём порту ─────────────────────── */
console.log('\n  3. Отчёт «Проверить почтовый сервер»');
function fakeSmtpServer(opts = {}) {
  return new Promise(res => {
    const srv = net.createServer(sock => {
      sock.setEncoding('utf8');
      if (opts.silent) return;
      sock.write('220 fake ESMTP\r\n');
      let buf = '', authed = false, step = null, inData = false;
      sock.on('data', d => {
        buf += d; let i;
        while ((i = buf.indexOf('\r\n')) >= 0) {
          const ln = buf.slice(0, i); buf = buf.slice(i + 2);
          const up = ln.toUpperCase();
          if (inData) {
            if (ln === '.') { inData = false; sock.write('250 2.0.0 queued\r\n'); }
            continue;
          }
          if (up === 'DATA') { inData = true; sock.write('354 End data with <CR><LF>.<CR><LF>\r\n'); }
          else if (up.startsWith('EHLO')) sock.write('250-fake\r\n250 AUTH LOGIN\r\n');
          else if (up === 'AUTH LOGIN') { step = 'user'; sock.write('334 VXNlcm5hbWU6\r\n'); }
          else if (step === 'user') { step = 'pass'; sock.write('334 UGFzc3dvcmQ6\r\n'); }
          else if (step === 'pass') {
            step = null;
            const p = Buffer.from(ln, 'base64').toString('utf8');
            if (p !== (opts.pass || 'good')) return sock.write('535 5.7.8 authentication failed\r\n');
            authed = true; sock.write('235 2.7.0 ok\r\n');
          } else if (up === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
          else sock.write('250 ok\r\n');
        }
      });
      sock.on('error', () => {});
    });
    srv.listen(0, '127.0.0.1', () => res({ port: srv.address().port, close: () => srv.close() }));
  });
}
const okSrv = await fakeSmtpServer({ pass: 'good' });
process.env.SEGA_SMTP_HOST = '127.0.0.1';
process.env.SEGA_SMTP_PORT = String(okSrv.port);
process.env.SEGA_SMTP_USER = 'bot@test.local';
process.env.SEGA_SMTP_PASS = 'good';
process.env.SEGA_SMTP_FROM = 'bot@test.local';
process.env.SEGA_SMTP_PLAIN = '1';
const rep = await smtp.checkAll(2500);
ok(rep.ok === true, 'рабочая почта: отчёт «работает»');
ok(rep.dns && rep.dns.ok && rep.dns.addresses.length >= 1, 'в отчёте есть найденный адрес сервера');
ok(Array.isArray(rep.ports) && rep.ports.some(p => p.port === okSrv.port && p.ok), 'в отчёте видно, что порт из .env открыт');
ok(rep.ports.some(p => p.port === 465 && !p.ok), 'и что 465 при этом закрыт — это нормально');
ok(/всё в порядке|в порядке/i.test(rep.advice || ''), `совет по делу: «${String(rep.advice).slice(0, 50)}…»`);

// неверный пароль: порты открыты, значит дело не в сети
process.env.SEGA_SMTP_PASS = 'wrong';
const repAuth = await smtp.checkAll(2500);
ok(repAuth.ok === false, 'неверный пароль: отчёт «не работает»');
ok(/535/.test(repAuth.error || ''), 'и показывает ответ сервера (535)');
ok(/пароль приложения/.test(repAuth.hint || ''), 'с подсказкой про пароль приложения');

// порт закрыт, сервер чужой: совет «смените порт» подсказывает открытый
const closedPort = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
process.env.SEGA_SMTP_PASS = 'good';
process.env.SEGA_SMTP_PORT = String(closedPort);
process.env.SEGA_SMTP_FROM = 'bot@test.local';
const repClosed = await smtp.checkAll(1500);
ok(repClosed.ok === false, 'закрытый порт из .env: отчёт «не работает»');
ok(/не ответил|не установилось|ECONNREFUSED/i.test(repClosed.error || ''), `ошибка называет сервер и порт: «${String(repClosed.error).slice(0, 70)}»`);
ok(String(repClosed.error).includes('127.0.0.1:' + closedPort), 'в тексте ошибки есть host:port — видно, кто именно молчал');
ok(/закрыт|молчит|порт/i.test(repClosed.advice || ''), `совет объясняет порты: «${String(repClosed.advice).slice(0, 70)}…»`);
okSrv.close();

// молчащий сервер: «порты закрыты у хостера» — и это не наша ошибка настроек
const black = await new Promise(res => {
  const srv = net.createServer(() => { /* SYN принят, дальше тишина */ });
  srv.listen(0, '127.0.0.1', () => res({ port: srv.address().port, close: () => srv.close() }));
});
process.env.SEGA_SMTP_PORT = String(black.port);
const repBlack = await smtp.checkAll(1200);
ok(repBlack.ok === false && /не ответил|не установилось/i.test(repBlack.error || ''), 'молчащий сервер: «не ответил», без выдумок');
ok(/хостер|поддержк|сети/i.test(String(repBlack.advice) + String(repBlack.hint)), 'совет: порты закрыты у хостера, а не «вы всё неверно ввели»');
black.close();

/* ── 4. Живой сервер: кнопка и текст ошибки ─────────────────────────────── */
console.log('\n  4. Живой сервер: /api/admin/mail');
const challenge = await fakeSmtpServer({ pass: 'good' });
async function freePort() {
  return new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sega-136-'));
const port = await freePort();
const base = 'http://127.0.0.1:' + port;
const proc = spawn(process.execPath, ['server.js'], {
  cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
  env: Object.assign({}, process.env, {
    STORE: 'file', DATA_DIR: path.join(dir, 'data'), HOST: '127.0.0.1', HTTPS: '', PRESENCE_EVERY: '0',
    NEW_INVITE_DELAY: '0', INVITE_COOLDOWN_MS: '0', PORT: String(port),
    SEGA_SMTP_HOST: '127.0.0.1', SEGA_SMTP_PORT: String(challenge.port),
    SEGA_SMTP_USER: 'bot@test.local', SEGA_SMTP_PASS: 'good',
    SEGA_SMTP_FROM: 'bot@test.local', SEGA_SMTP_PLAIN: '1'
  })
});
process.on('exit', () => { try { proc.kill('SIGKILL'); } catch (e) {} try { challenge.close(); } catch (e) {} });
for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/api/state')).ok) break; } catch (e) {} await wait(200); }

async function call(p, opts = {}, token) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { ...opts, headers: h, body: opts.body ? JSON.stringify(opts.body) : undefined });
  let d = null;
  try { d = await r.json(); } catch (e) {}
  return { status: r.status, d };
}
const creds = name => ({ name, saltAuth: hex(), authKey: hex(32), saltWrap: hex(), wrappedKeyByPass: 'w:' + hex(), pub: 'pub:' + hex(), wrappedPriv: 'priv:' + hex() });
let r = await call('/api/setup', { method: 'POST', body: Object.assign({}, creds('Владелец'), { codeProofSalt: hex(), codeProof: hex(32), codeSalt: hex(), wrappedKeyByCode: 'k:' + hex() }) });
const admin = r.d.token;
r = await call('/api/admin/mail', {}, admin);
ok(r.status === 200 && r.d.ok === true, 'кнопка «Проверить почтовый сервер»: почта работает');
ok(r.d.dns && r.d.dns.ok, 'в ответе есть проверка имени сервера');
ok(Array.isArray(r.d.ports) && r.d.ports.length >= 3, `в ответе есть порты (${(r.d.ports || []).map(p => p.port).join(', ')})`);
ok(/в порядке/i.test(r.d.advice || ''), 'и человеческий совет');

// привязка почты на рабочем сервере проходит
r = await call('/api/profile', { method: 'POST', body: { email: 'owner@test.local' } }, admin);
ok(r.status === 200, 'привязка почты: письмо уходит (сервер принял)');
const friendC = creds('Друг');
r = await call('/api/admin/mail', {}, 'bogus-token');
ok(r.status === 401 || r.status === 403, 'проверка почты — только владельцу');

/* ── 5. Клиент и отметки ─────────────────────────────────────────────────── */
console.log('\n  5. Клиент показывает имя, порты и совет');
const appJs = read('public/app.js');
ok(/r\.dns/.test(appJs) && /r\.ports/.test(appJs), 'окно проверки выводит DNS и порты');
ok(/r\.advice/.test(appJs), 'и совет «что делать»');
ok(/\/api\/admin\/mail/.test(appJs), 'кнопка обращается к проверке почты');
ok(/checkAll/.test(read('lib/api.js')), 'сервер отвечает полной проверкой, а не только входом');
ok(/12000/.test(read('lib/smtp.js')), 'письмо ждём 12 с вместо 20 — меньше сидения впустую');
ok(/host \+ ':' \+ c\.port/.test(read('lib/smtp.js')), 'в текстах ошибок видно, какой сервер молчал');

console.log('\n  6. Отметки выпуска');
ok((/const BUILD = '([^']+)'/.exec(appJs) || [])[1] === BUILD && /^pkg3-1\d\d$/.test(BUILD), `отметка выпуска одна (${BUILD})`);
ok(((/const BUILD = '([^']+)'/.exec(read('lib/api.js')) || [])[1]) === BUILD, 'BUILD в lib/api.js тот же');
ok((/const STATIC_CACHE = '([^']+)'/.exec(read('public/sw.js')) || [])[1] === 'sega-static-v147', 'кэш оформления поднят до v130');
ok(/\| pkg3-146 \|/.test(read('README.md')), 'в журнале README есть строка pkg3-146');
ok(read('package.json').includes('node test/ui136.mjs'), 'тест ui136 включён в цепочку npm test');

console.log(`\n  ИТОГ: ${good} ✓, ${bad ? bad + ' провалов' : 'провалов нет'}\n`);
process.exit(bad ? 1 : 0);
