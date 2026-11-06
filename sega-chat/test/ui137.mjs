// test/ui137.mjs — pkg3-139: почта — «есть ли интернет» и письмо в поддержку.
//
// Владелец поставил 136-й и прислал новый снимок: «smtp.gmail.com:465 не
// ответил за 12 с · Соединение не установилось». То есть дело не в выборе
// порта и не в пароле — до сервера не доходит связь. Но один и тот же текст
// бывает в двух разных случаях:
//   • у сервера есть интернет, а хостер закрыл именно почтовые порты;
//   • у сервера не открывается вообще ничего (сеть, фаервол, сломанный IPv6).
// Здесь проверяем, что чат их различает:
//   • каждый порт проверяется по адресам (IPv4 первым, потом IPv6) и видно, кто ответил;
//   • контрольная проверка 443 до посторонних хостов — «интернет у сервера есть»;
//   • совет зависит от этого: «закрыты почтовые порты» или «не открывается и 443»;
//   • готовый текст в поддержку хостера (ticket) — с адресом, портами и временем;
//   • подсказка на 465 больше не советует «попробуйте 465».
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
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

console.log('\n══════════════════════════════════════════════════');
console.log('  pkg3-139: почта — сеть, адреса и письмо в поддержку');
console.log('══════════════════════════════════════════════════\n');

const smtp = await import('../lib/smtp.js').then(m => m.default || m);

/* ── 1. Адрес за адресом ────────────────────────────────────────────────── */
console.log('  1. Адреса сервера: сначала IPv4');
const sorted = smtp.sortAddresses([
  { address: '2a00:1450:4025:40b::6d', family: 6 },
  { address: '74.125.131.108', family: 4 },
  { address: '74.125.131.109', family: 4 }
]);
ok(sorted[0].family === 4 && sorted[0].address === '74.125.131.108', 'IPv4 идёт первым — у VPS часто сломан IPv6');
ok(sorted.filter(a => a.family === 4).length === 2, 'оба IPv4 остаются в списке (порядок устойчив)');
const aLocal = await smtp.addresses('127.0.0.1');
ok(aLocal.length === 1 && aLocal[0].family === 4, 'числовой адрес не гоняем через DNS');
const aSix = await smtp.addresses('::1');
ok(aSix.length === 1 && aSix[0].family === 6, 'IPv6-адрес тоже распознаётся');

/* ── 2. Порт: какой адрес ответил ───────────────────────────────────────── */
console.log('\n  2. Порт отвечает, молчит или закрыт — и по какому адресу');
const talking = net.createServer(s => { s.setEncoding('utf8'); s.write('220 probe ESMTP ready\r\n'); s.on('error', () => {}); });
await new Promise(r => talking.listen(0, '127.0.0.1', r));
const talkingPort = talking.address().port;
const p1 = await smtp.probePort('127.0.0.1', talkingPort, 2000);
ok(p1.ok && /220/.test(p1.detail), `живой порт отвечает («${p1.detail}»)`);
ok(/127\.0\.0\.1/.test(p1.via || '') && /IPv4/.test(p1.via || ''), `и видно, какой адрес ответил («${p1.via}»)`);
ok(Array.isArray(p1.tried) && p1.tried[0].ok === true, 'в отчёте есть разбор по адресам');

const silent = net.createServer(() => { /* принимает и молчит */ });
await new Promise(r => silent.listen(0, '127.0.0.1', r));
const silentPort = silent.address().port;
const p2 = await smtp.probePort('127.0.0.1', silentPort, 1200);
ok(!p2.ok && /нет ответа/.test(p2.detail), 'молчащий порт — «нет ответа», а не «закрыт»');
ok(p2.tried.length === 1 && p2.tried[0].ok === false, 'и в разборе по адресам он отмечен как молчащий');

const deadPort = await freePort();
const p3 = await smtp.probePort('127.0.0.1', deadPort, 1500);
ok(!p3.ok && /ECONNREFUSED/.test(p3.detail), 'закрытый порт отличается от молчащего (ECONNREFUSED)');

/* ── 3. Контрольная проверка интернета ──────────────────────────────────── */
console.log('\n  3. «А интернет у сервера вообще есть?»');
const web = net.createServer(s => s.end());
await new Promise(r => web.listen(0, '127.0.0.1', r));
const webPort = web.address().port;
const netOpen = await smtp.probeNet(1500, [
  { target: 'свой-стенд:443', host: '127.0.0.1', port: webPort },
  { target: 'закрытый:443', host: '127.0.0.1', port: deadPort }
]);
ok(netOpen.ok === true && netOpen.items[0].ok === true, 'открытый 443 — «интернет есть»');
ok(netOpen.items[1].ok === false, 'а закрытый 443 в том же отчёте виден отдельно');
ok(/127\.0\.0\.1/.test(netOpen.items[0].detail), 'и показывает, до какого адреса дошло');
const netDead = await smtp.probeNet(1200, [{ target: 'закрытый:443', host: '127.0.0.1', port: deadPort }]);
ok(netDead.ok === false, 'если не открывается ничего — так и говорим');

/* ── 4. Подставной SMTP: полный отчёт ───────────────────────────────────── */
console.log('\n  4. Отчёт «Проверить почтовый сервер»');
function fakeSmtpServer(opts = {}) {
  return new Promise(res => {
    const srv = net.createServer(sock => {
      sock.setEncoding('utf8');
      if (opts.silent) return;
      sock.write('220 fake ESMTP\r\n');
      let buf = '', step = null, inData = false;
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
            sock.write('235 2.7.0 ok\r\n');
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
const netTarget = [{ target: 'свой-стенд:443', host: '127.0.0.1', port: webPort }];
const rep = await smtp.checkAll(2000, { netTargets: netTarget });
ok(rep.ok === true, 'рабочая почта: «письма должны уходить»');
ok(rep.net && rep.net.ok === true, 'в отчёте есть «интернет у сервера есть»');
ok(rep.ticket === '', 'и никакого письма в поддержку — оно не нужно');
ok(!/хостер/i.test(rep.advice || ''), 'совет не пугает хостером, когда всё работает');

// порт молчит + интернет есть: виноват хостер, а не пароль
const black = await fakeSmtpServer({ silent: true });
process.env.SEGA_SMTP_PORT = String(black.port);
const repBlack = await smtp.checkAll(1500, { netTargets: netTarget });
ok(repBlack.ok === false, 'молчащий сервер: почта не работает');
ok(/хостер|поддержк/i.test(repBlack.advice || ''), 'совет: дело в хостере, а не в настройках');
ok(/закрыты именно почтовые порты/i.test(repBlack.advice || ''), 'и отдельно сказано: сеть жива, закрыты почтовые порты');
ok(typeof repBlack.ticket === 'string' && repBlack.ticket.length > 120, 'есть готовое письмо в поддержку');
ok(repBlack.ticket.includes('127.0.0.1:') && repBlack.ticket.includes(String(black.port)), 'в письме есть сервер и порт из .env');
ok(/465/.test(repBlack.ticket) && /587/.test(repBlack.ticket), 'и порты 465/587');
ok(/Интернет при этом работает/i.test(repBlack.ticket), 'и доказательство: интернет при этом работает');
ok(/релей/i.test(repBlack.ticket), 'и вопрос про SMTP-релей хостера — это реальный выход');

// портов нет и интернета нет: другой разговор
const repDead = await smtp.checkAll(1200, { netTargets: [{ target: 'закрытый:443', host: '127.0.0.1', port: deadPort }] });
ok(/443 не открывается/i.test(repDead.advice || ''), 'если и 443 молчит — совет про сеть и фаервол сервера');

// рабочая почта ещё раз: письмо действительно уходит (проверка самого sendMail)
process.env.SEGA_SMTP_PORT = String(okSrv.port);
const sent = await smtp.sendMail('owner@test.local', 'тест', 'привет', 3000).then(() => true, e => String(e.message));
ok(sent === true, 'письмо уходит по адресу, а не «в пустоту»');
okSrv.close(); black.close(); talking.close(); silent.close(); web.close();

/* ── 5. Подсказка: не советовать то, что уже сделано ────────────────────── */
console.log('\n  5. Подсказка на 465 не советует «попробуйте 465»');
const h465 = smtp.hintFor('smtp.gmail.com:465 не ответил за 12 с', 465);
ok(!/попробуйте 465/i.test(h465), 'на 465 совета «попробуйте 465» больше нет');
ok(/не в выборе порта|не в пароле/i.test(h465), 'зато сказано, что дело не в порте и не в пароле');
ok(/Проверить почтовый сервер/i.test(h465), 'и куда нажать');
const h587 = smtp.hintFor('smtp.yandex.ru:587 не ответил за 12 с', 587);
ok(/попробуйте 465/i.test(h587), 'на 587 совет попробовать 465 остался');

/* ── 6. Живой сервер: кнопка и отметки ──────────────────────────────────── */
console.log('\n  6. Живой сервер: /api/admin/mail');
const challenge = await fakeSmtpServer({ pass: 'good' });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sega-137-'));
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
ok(r.status === 200 && r.d.ok === true, 'кнопка проверки почты отвечает «работает»');
ok(r.d.net && Array.isArray(r.d.net.items) && r.d.net.items.length >= 1, 'в ответе есть контрольная проверка интернета');
ok('ticket' in r.d, 'и поле ticket (пустое, когда письмо в поддержку не нужно)');
ok(Array.isArray(r.d.ports) && r.d.ports.every(p => Array.isArray(p.tried)), 'по каждому порту виден разбор по адресам');
r = await call('/api/profile', { method: 'POST', body: { email: 'owner@test.local' } }, admin);
ok(r.status === 200, 'привязка почты по-прежнему проходит (письмо уходит)');
r = await call('/api/admin/mail', {}, 'bogus-token');
ok(r.status === 401 || r.status === 403, 'проверка почты — только владельцу');

/* ── 7. Клиент и отметки ────────────────────────────────────────────────── */
console.log('\n  7. Клиент показывает сеть, адреса и письмо в поддержку');
const appJs = read('public/app.js');
ok(/r\.net/.test(appJs), 'окно проверки показывает «интернет у сервера»');
ok(/p\.tried/.test(appJs), 'и разбор порта по адресам (IPv4/IPv6)');
ok(/r\.ticket/.test(appJs) && /pf-mail-copy/.test(appJs), 'и кнопку «Скопировать для поддержки»');
ok(/navigator\.clipboard\.writeText\(r\.ticket\)/.test(appJs), 'она действительно копирует письмо, а не картинку');
const smtpSrc = read('lib/smtp.js');
ok(/function supportTicket/.test(smtpSrc) && /465 и 587/.test(smtpSrc), 'текст в поддержку собирается на сервере');
ok(/sortAddresses/.test(smtpSrc) && /IPv4/.test(smtpSrc), 'адреса сортируются, IPv4 первым');
ok(/checkAll\(5000\)/.test(read('lib/api.js')), 'кнопка зовёт полную проверку');

console.log('\n  8. Отметки выпуска');
ok((/const BUILD = '([^']+)'/.exec(appJs) || [])[1] === BUILD && BUILD === 'pkg3-139', `отметка выпуска одна (${BUILD})`);
ok(((/const BUILD = '([^']+)'/.exec(read('lib/api.js')) || [])[1]) === BUILD, 'BUILD в lib/api.js тот же');
ok((/const STATIC_CACHE = '([^']+)'/.exec(read('public/sw.js')) || [])[1] === 'sega-static-v133', 'кэш оформления поднят до v131');
ok(/\| pkg3-139 \|/.test(read('README.md')), 'в журнале README есть строка pkg3-139');
ok(read('package.json').includes('node test/ui137.mjs'), 'тест ui137 включён в цепочку npm test');

console.log(`\n  ИТОГ: ${good} ✓, ${bad ? bad + ' провалов' : 'провалов нет'}\n`);
process.exit(bad ? 1 : 0);
