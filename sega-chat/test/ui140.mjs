// test/ui140.mjs — pkg3-143: «письмо не ушло» — честно и без тупика.
//
// Хостер окончательно закрыл почтовые порты (2525 тоже молчит), владелец
// написал в поддержку. Пока ответа нет, письма не уходят — и это должно быть
// честно видно с двух сторон:
//   • человек на экране входа не должен читать «проверьте SEGA_SMTP_PORT»:
//     он не админ сервера, ему нужно знать, что делать ЕМУ;
//   • владелец должен видеть «последнее письмо не ушло» в профиле, не дожидаясь
//     жалобы от того, кому это письмо нужно.
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
console.log('  pkg3-143: письмо не ушло — честно и без тупика');
console.log('══════════════════════════════════════════════════\n');

/* ── 1. Живой сервер ────────────────────────────────────────────────────── */
console.log('  1. Сервер: пока почта мертва, он так и говорит');
function fakeSmtp() {
  return new Promise(res => {
    const holder = { port: 0, last: null };
    const srv = net.createServer(sock => {
      sock.setEncoding('utf8');
      sock.write('220 fake ESMTP\r\n');
      let buf = '', step = null, inData = false, text = '';
      sock.on('data', d => {
        buf += d; let i;
        while ((i = buf.indexOf('\r\n')) >= 0) {
          const ln = buf.slice(0, i); buf = buf.slice(i + 2);
          const up = ln.toUpperCase();
          if (inData) {
            if (ln === '.') { inData = false; holder.last = text; sock.write('250 2.0.0 queued\r\n'); }
            else text += ln + '\n';
            continue;
          }
          if (up === 'DATA') { inData = true; sock.write('354 go ahead\r\n'); }
          else if (up.startsWith('EHLO')) sock.write('250-fake\r\n250 AUTH LOGIN\r\n');
          else if (up === 'AUTH LOGIN') { step = 'user'; sock.write('334 VXNlcm5hbWU6\r\n'); }
          else if (step === 'user') { step = 'pass'; sock.write('334 UGFzc3dvcmQ6\r\n'); }
          else if (step === 'pass') { step = null; sock.write('235 2.7.0 ok\r\n'); }
          else if (up === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
          else sock.write('250 ok\r\n');
        }
      });
      sock.on('error', () => {});
    });
    srv.listen(0, '127.0.0.1', () => {
      holder.port = srv.address().port;
      holder.close = () => new Promise(r => srv.close(r));
      res(holder);
    });
  });
}
const smtpSrv = await fakeSmtp();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sega-140-'));
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
process.on('exit', () => { try { proc.kill('SIGKILL'); } catch (e) {} });
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

// пока почта работает — письмо уходит, и это отмечено
r = await call('/api/profile', { method: 'POST', body: { email: 'owner@test.local' } }, admin);
ok(r.status === 200, 'письмо с кодом привязки уходит, пока сервер почты жив');
// код берём из самого письма — как это сделал бы владелец
const code = ((String(smtpSrv.last || '').match(/Код подтверждения:\s*(\d{6})/) || [])[1] || '');
ok(/^\d{6}$/.test(code), 'письмо с кодом действительно ушло (код в тексте письма есть)');
r = await call('/api/profile', { method: 'POST', body: { emailCode: code } }, admin);
ok(r.status === 200, 'код из письма подтверждает привязку');
r = await call('/api/profile', {}, admin);
ok(r.status === 200 && r.d.mail && r.d.mail.last && r.d.mail.last.ok === true, 'в профиле владельца отмечено: последнее письмо ушло');
ok(r.d.mail.configured === true, 'и что почта настроена');

// теперь сервер почты «умер» — как у владельца, когда порты закрыты
await smtpSrv.close();

// восстановление пароля: человек на экране входа должен понять, что делать
r = await call('/api/recover/request', { method: 'POST', body: { name: 'Владелец', email: 'owner@test.local' } });
ok(r.status === 502, 'письмо не ушло — и сервер не делает вид, что ушло');
const msg = String((r.d && r.d.error) || '');
ok(/не ушло/i.test(msg), 'ошибка так и начинается: «Письмо не ушло»');
ok(/не ваша ошибка/i.test(msg), 'и снимает вину с человека');
ok(/владельца|владелец/i.test(msg) && /вручную/i.test(msg), 'и говорит, что делать: попросить владельца сбросить вручную');
ok(!/SEGA_SMTP|465|587|хостера/i.test(msg), 'никакой серверной техники в лицо обычному человеку');
ok(/код восстановления/i.test(msg), 'и напоминает про одноразовый код');

// владелец видит поломку сам, без жалоб от людей
r = await call('/api/profile', {}, admin);
const last = r.d.mail && r.d.mail.last;
ok(last && last.ok === false, 'в профиле владельца: последнее письмо не ушло');
ok(last && !!last.error, 'с причиной, а не просто «ошибка»');
ok(last && last.at > 0, 'и со временем попытки');

/* ── 2. Клиент ──────────────────────────────────────────────────────────── */
console.log('\n  2. Клиент: и на экране входа, и в профиле');
const appJs = read('public/app.js');
ok(/последнее письмо/.test(appJs), 'в профиле есть строка «последнее письмо»');
ok(/почта на сервере не настроена/.test(appJs), 'и отдельная строка, если почта вообще не настроена');
ok(/Если письмо не приходит — это не ваша ошибка/.test(appJs), 'на экране восстановления заранее сказано, что делать без письма');
ok(/Профиль → Участники → «Сбросить пароль»/.test(appJs), 'и назван точный путь ручного сброса');
ok(/Одноразовый код восстановления/.test(appJs), 'и напоминание про код');
ok(/st\.mail/.test(appJs), 'профиль берёт состояние почты с сервера, а не выдумывает');
ok(/mailStatus|mailNote/.test(read('lib/api.js')), 'сервер запоминает итог последней отправки');
ok(/me\.isAdmin \? \{ configured/.test(read('lib/api.js')), 'и показывает его только владельцу');

/* ── 3. Отметки выпуска ─────────────────────────────────────────────────── */
console.log('\n  3. Отметки выпуска');
ok((/const BUILD = '([^']+)'/.exec(appJs) || [])[1] === BUILD && BUILD === 'pkg3-143', `отметка выпуска одна (${BUILD})`);
ok(((/const BUILD = '([^']+)'/.exec(read('lib/api.js')) || [])[1]) === BUILD, 'BUILD в lib/api.js тот же');
ok((/const STATIC_CACHE = '([^']+)'/.exec(read('public/sw.js')) || [])[1] === 'sega-static-v137', 'кэш оформления поднят до v134');
ok(/\| pkg3-143 \|/.test(read('README.md')), 'в журнале README есть строка pkg3-143');
ok(read('package.json').includes('node test/ui140.mjs'), 'тест ui140 включён в цепочку npm test');

console.log(`\n  ИТОГ: ${good} ✓, ${bad ? bad + ' провалов' : 'провалов нет'}\n`);
process.exit(bad ? 1 : 0);
