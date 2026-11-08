// test/ui138.mjs — pkg3-146: «Проверить почтовый сервер» видно всегда,
//                 и nginx больше не ломается на задвоенном server_tokens.
//
// Владелец поставил 137-й и написал две вещи:
//   1) в профиле нет кнопки «Проверить почтовый сервер»;
//   2) установка ругается: «"server_tokens" directive is duplicate в
//      /etc/nginx/conf.d/sega-limits.conf:4», certbot не сработал.
//
// Первое — наша ошибка размещения: кнопка жила в ветке «почта привязана»,
// то есть ровно тогда, когда привязка не работает, кнопки не было. Второе —
// наша ошибка конфига: server_tokens писался в http-контекст (conf.d), где
// директива уже задана; nginx отказывался стартовать, а certbot с плагином
// nginx отказывался выпускать/продлевать сертификат.
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
console.log('  pkg3-146: кнопка проверки почты и nginx без дубликатов');
console.log('══════════════════════════════════════════════════\n');

const appJs = read('public/app.js');
const setupSh = read('cloud-vps/setup.sh');
const certSh = read('cloud-vps/cert.sh');

/* ── 1. Кнопка проверки почты видна всегда ──────────────────────────────── */
console.log('  1. «Проверить почтовый сервер» есть и до привязки почты');
const diagUses = (appJs.match(/\$\{diag\}/g) || []).length;
ok(diagUses === 2, `блок проверки вставлен в обе ветки профиля (${diagUses})`);
ok((appJs.match(/id="pf-mail-diag"/g) || []).length === 1, 'сама кнопка объявлена один раз — не разъезжается по копиям');
ok(/const isAdmin = !!\(S\.me && S\.me\.isAdmin\)/.test(appJs), 'видит её только владелец');
ok(/Этой же кнопкой проверяется, почему не приходит письмо/.test(appJs), 'и подписано, зачем она нужна, когда письмо не приходит');
const pStart = appJs.indexOf('async function paintPfMail()');
const pNext = appJs.indexOf('\nasync function ', pStart + 10);
const paint = appJs.slice(pStart, pNext > 0 ? pNext : pStart + 4000);
ok(/if \(st\.emailConfirmed\) \{/.test(paint), 'ветка «почта привязана» на месте');
ok(/\$\{diag\}`;/.test(paint), 'блок проверки есть и в ветке «почта ещё не привязана»');
ok((paint.match(/wireDiag\(\);/g) || []).length === 2, 'кнопка подключается в обеих ветках');
ok(/b\.addEventListener\('click', mailDiag\)/.test(appJs), 'нажатие ведёт в саму проверку, а не в заглушку');

/* ── 2. nginx: никакого server_tokens в http-контексте ──────────────────── */
console.log('\n  2. nginx: server_tokens больше не дублируется');
const limBlock = (setupSh.match(/cat > \/etc\/nginx\/conf\.d\/sega-limits\.conf <<'LIM'\n([\s\S]*?)\nLIM/) || [])[1] || '';
ok(!!limBlock, 'sega-limits.conf пишется отдельным блоком — его можно проверить');
ok(/limit_req_zone \$binary_remote_addr zone=segalogin:10m rate=20r\/m;/.test(limBlock), 'ограничение частоты входа осталось');
ok(!/server_tokens/.test(limBlock), 'в http-контексте (conf.d) server_tokens больше нет — именно он и был дубликатом');
ok((setupSh.match(/server_tokens off;/g) || []).length >= 2, 'версия сервера скрывается в наших же server-блоках');
ok(/server_tokens off;[\s\S]{0,200}ssl_certificate/.test(setupSh), 'и именно в HTTPS-блоке — то есть там, где надо');
ok(/if nginx -t >\/tmp\/sega-nginx-test\.log 2>&1; then/.test(setupSh), 'проверка конфига пишет лог, а не глотает ошибку');
ok(/sed -n '1,6p' \/tmp\/sega-nginx-test\.log/.test(setupSh), 'и при провале показывает первые строки — видно, что именно не так');
ok(/grep -rn \\"server_tokens\\" \/etc\/nginx\//.test(setupSh), 'и подсказывает, где искать задвоенную директиву');
ok(/прежняя настройка в порядке|возвращаю прежнюю настройку сайта/.test(setupSh), 'прежняя настройка сайта возвращается при провале');

/* ── 3. cert.sh: сначала проверка и починка, потом certbot ──────────────── */
console.log('\n  3. cert.sh: понятная причина вместо MisconfigurationError');
ok(/nginx -t/.test(certSh), 'сертификат не зовётся вслепую: сначала nginx -t');
ok(/grep -qE '\^\[\[:space:\]\]\*server_tokens/.test(certSh), 'сам убирает server_tokens из нашего sega-limits.conf');
ok(/grep -vE '\^\[\[:space:\]\]\*server_tokens/.test(certSh), 'и переписывает файл без него');
ok(/Пока это не исправлено, certbot работать не будет/.test(certSh), 'при чужой поломке честно говорит, что делать');
ok(/certbot --nginx -d "\$DOMAIN"/.test(certSh), 'и всё-таки выпускает сертификат, когда конфиг в порядке');
ok(/set -euo pipefail/.test(certSh), 'ошибки не проглатываются');

/* ── 4. Живой сервер: кнопка доступна владельцу и закрыта остальным ─────── */
console.log('\n  4. Живой сервер: проверка почты — только владельцу');
function fakeSmtpServer() {
  return new Promise(res => {
    const srv = net.createServer(sock => {
      sock.setEncoding('utf8');
      sock.write('220 fake ESMTP\r\n');
      let buf = '', step = null;
      sock.on('data', d => {
        buf += d; let i;
        while ((i = buf.indexOf('\r\n')) >= 0) {
          const ln = buf.slice(0, i); buf = buf.slice(i + 2);
          const up = ln.toUpperCase();
          if (up.startsWith('EHLO')) sock.write('250-fake\r\n250 AUTH LOGIN\r\n');
          else if (up === 'AUTH LOGIN') { step = 'user'; sock.write('334 VXNlcm5hbWU6\r\n'); }
          else if (step === 'user') { step = 'pass'; sock.write('334 UGFzc3dvcmQ6\r\n'); }
          else if (step === 'pass') { step = null; sock.write('235 2.7.0 ok\r\n'); }
          else if (up === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
          else sock.write('250 ok\r\n');
        }
      });
      sock.on('error', () => {});
    });
    srv.listen(0, '127.0.0.1', () => res({ port: srv.address().port, close: () => srv.close() }));
  });
}
const smtpSrv = await fakeSmtpServer();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sega-138-'));
const port = await freePort();
const base = 'http://127.0.0.1:' + port;
const proc = spawn(process.execPath, ['server.js'], {
  cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
  env: Object.assign({}, process.env, {
    STORE: 'file', DATA_DIR: path.join(dir, 'data'), HOST: '127.0.0.1', HTTPS: '', PRESENCE_EVERY: '0',
    NEW_INVITE_DELAY: '0', INVITE_COOLDOWN_MS: '0', PORT: String(port),
    SEGA_SMTP_HOST: '127.0.0.1', SEGA_SMTP_PORT: String(smtpSrv.port),
    SEGA_SMTP_USER: 'bot@test.local', SEGA_SMTP_PASS: 'good',
    SEGA_SMTP_FROM: 'bot@test.local', SEGA_SMTP_PLAIN: '1'
  })
});
process.on('exit', () => { try { proc.kill('SIGKILL'); } catch (e) {} try { smtpSrv.close(); } catch (e) {} });
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
r = await call('/api/profile', {}, admin);
ok(r.status === 200 && r.d.emailConfirmed === false, 'почта ещё не привязана — ровно случай со снимка');
// клиент берёт «я владелец» из синхронизации (S.me = data.me), а не из профиля
r = await call('/api/sync?since=0&rsince=0', {}, admin);
ok(r.status === 200 && r.d.me && r.d.me.isAdmin === true, 'синхронизация говорит «я владелец» — значит кнопку увидит');
r = await call('/api/admin/mail', {}, admin);
ok(r.status === 200 && r.d.config && r.d.config.host === '127.0.0.1', 'проверка почты работает и без привязанной почты — кнопке есть что показать');
const guest = creds('Гость');
r = await call('/api/register', { method: 'POST', body: Object.assign({}, guest, { invite: '' }) });
const guestToken = r.status === 200 && r.d.token ? r.d.token : null;
if (!guestToken) {
  // регистрация может требовать инвайт — тогда проверяем отказ без токена
  r = await call('/api/admin/mail', {}, 'bogus-token');
  ok(r.status === 401 || r.status === 403, 'без владельца проверка почты закрыта');
} else {
  r = await call('/api/admin/mail', {}, guestToken);
  ok(r.status === 403, 'обычному участнику проверка почты закрыта');
}
ok(/\/api\/admin\/mail/.test(appJs) && /pf-mail-diagbox/.test(appJs), 'окно вывода на месте — есть куда показать отчёт');

/* ── 5. Отметки выпуска ─────────────────────────────────────────────────── */
console.log('\n  5. Отметки выпуска');
ok((/const BUILD = '([^']+)'/.exec(appJs) || [])[1] === BUILD && /^pkg3-1\d\d$/.test(BUILD), `отметка выпуска одна (${BUILD})`);
ok(((/const BUILD = '([^']+)'/.exec(read('lib/api.js')) || [])[1]) === BUILD, 'BUILD в lib/api.js тот же');
ok((/const STATIC_CACHE = '([^']+)'/.exec(read('public/sw.js')) || [])[1] === 'sega-static-v146', 'кэш оформления поднят до v132');
ok(/\| pkg3-146 \|/.test(read('README.md')), 'в журнале README есть строка pkg3-146');
ok(read('package.json').includes('node test/ui138.mjs'), 'тест ui138 включён в цепочку npm test');

console.log(`\n  ИТОГ: ${good} ✓, ${bad ? bad + ' провалов' : 'провалов нет'}\n`);
process.exit(bad ? 1 : 0);
