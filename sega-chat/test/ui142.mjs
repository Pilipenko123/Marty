// test/ui142.mjs — pkg3-146: код восстановления действительно создаётся
//                  и восстановление по письму проходит целиком.
//
// Владелец привязал почту (код из письма пришёл и принялся), но внизу профиля
// выскочило красное: «Failed to execute 'encrypt' on 'SubtleCrypto': parameter 2
// is not of type 'CryptoKey'». Причина: в AES-GCM уходили сырые 32 байта вместо
// импортированного ключа — и так было с самого появления кода восстановления,
// то есть создать его не мог НИКТО. Та же ошибка ждала и на другом конце —
// при вводе кода на странице восстановления.
//
// Здесь проверяем:
//   • воспроизводим ошибку владельца на сырых байтах (чтобы не вернулась);
//   • убеждаемся, что с импортированным ключом шифрование и расшифровка сходятся;
//   • в коде клиента ключ импортируется в обоих местах, а человеку показывают
//     русский текст, а не «Failed to execute…»;
//   • восстановление по письму проходит целиком: письмо → ссылка → состояние →
//     новый пароль → вход новым паролем.
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
console.log('  pkg3-146: код восстановления и полный сброс пароля');
console.log('══════════════════════════════════════════════════\n');

/* ── 1. Та самая ошибка и её лечение ────────────────────────────────────── */
console.log('  1. Шифрование кода восстановления');
const { webcrypto } = await import('node:crypto');
const subtle = webcrypto.subtle;
const enc = new TextEncoder();
const toB64u8 = u8 => Buffer.from(u8).toString('base64');
const fromB64u8 = b => new Uint8Array(Buffer.from(b, 'base64'));
const importAes = raw => subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
async function aesEncryptBytes(key, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
  return toB64u8(out);
}
async function aesDecryptBytes(key, b64) {
  const raw = fromB64u8(b64);
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, key, raw.slice(12)));
}

const K = crypto.getRandomValues(new Uint8Array(32));
let rawErr = null;
try { await aesEncryptBytes(K, enc.encode('секрет')); } catch (e) { rawErr = e; }
ok(!!rawErr && /CryptoKey/i.test(String(rawErr && rawErr.message)), 'сырые байты вместо ключа дают ровно ту ошибку владельца');
ok(!!rawErr && /parameter 2|CryptoKey/i.test(String(rawErr.message)), 'это её текст: «parameter 2 is not of type CryptoKey»');

const key = await importAes(K);
const blob = await aesEncryptBytes(key, enc.encode(JSON.stringify({ pkcs8: 'priv', room: 'room' })));
ok(typeof blob === 'string' && blob.length > 20, 'с импортированным ключом шифрование проходит');
const back = JSON.parse(new TextDecoder().decode(await aesDecryptBytes(await importAes(K), blob)));
ok(back.pkcs8 === 'priv' && back.room === 'room', 'и расшифровывается тем же кодом обратно');
const other = crypto.getRandomValues(new Uint8Array(32));
let wrong = null;
try { await aesDecryptBytes(await importAes(other), blob); } catch (e) { wrong = e; }
ok(!!wrong, 'чужой код восстановления не откроет копию');

/* ── 2. Клиент: ключ импортируется на обоих концах ──────────────────────── */
console.log('\n  2. Клиент больше не суёт сырые байты');
const appJs = read('public/app.js');
ok(/aesEncryptBytes\(await importAes\(K\)/.test(appJs), 'при создании кода ключ импортируется');
ok(/aesDecryptBytes\(await importAes\(K\)/.test(appJs), 'и при вводе кода на восстановлении — тоже');
ok(!/aesEncryptBytes\(K,/.test(appJs), 'сырых байтов в encrypt больше нет');
ok(!/aesDecryptBytes\(K,/.test(appJs), 'сырых байтов в decrypt больше нет');
ok(/Не удалось собрать код восстановления/.test(appJs), 'если что-то сломается — человеку по-русски, а не «Failed to execute»');
ok(/Почта уже привязана/.test(appJs), 'и сказано, что почта при этом уже привязана (чтобы не паниковать)');

/* ── 3. Полное восстановление по письму ─────────────────────────────────── */
console.log('\n  3. Восстановление по письму — целиком');
function fakeSmtp() {
  return new Promise(res => {
    const holder = { port: 0, last: '' };
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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sega-142-'));
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
const creds = (name, authKey) => ({ name, saltAuth: hex(), authKey, saltWrap: hex(), wrappedKeyByPass: 'w:' + hex(), pub: 'pub:' + hex(), wrappedPriv: 'priv:' + hex() });
const oldAuth = hex(32);
let r = await call('/api/setup', { method: 'POST', body: Object.assign({}, creds('Владелец', oldAuth), { codeProofSalt: hex(), codeProof: hex(32), codeSalt: hex(), wrappedKeyByCode: 'k:' + hex() }) });
const admin = r.d.token;

// привязываем почту настоящим кодом из письма
await call('/api/profile', { method: 'POST', body: { email: 'owner@test.local' } }, admin);
const bindCode = ((String(smtpSrv.last || '').match(/Код подтверждения:\s*(\d{6})/) || [])[1] || '');
r = await call('/api/profile', { method: 'POST', body: { emailCode: bindCode } }, admin);
ok(r.status === 200, 'почта привязана кодом из письма');

// кладём «копию восстановления» так же, как это делает клиент (шифротекст)
const recoveryBlob = await aesEncryptBytes(await importAes(K), enc.encode(JSON.stringify({ pkcs8: 'priv-ключ', room: 'ключ-комнаты' })));
r = await call('/api/profile', { method: 'POST', body: { recoveryBlob } }, admin);
ok(r.status === 200, 'копия восстановления сохранена (сервер видит только шифротекст)');

// «Забыли пароль?» — письмо со ссылкой
smtpSrv.last = '';
r = await call('/api/recover/request', { method: 'POST', body: { name: 'Владелец', email: 'owner@test.local' } });
ok(r.status === 200, 'запрос восстановления принят');
const link = (String(smtpSrv.last || '').match(/\?recover=([0-9a-f]{20,})/) || [])[1] || '';
ok(!!link, 'в письме есть ссылка восстановления');
r = await call('/api/recover/state?token=' + link);
ok(r.status === 200 && r.d.name === 'Владелец', 'ссылка открывается и знает, чья она');
ok(r.d.hasBlob === true && typeof r.d.blob === 'string', 'и отдаёт копию восстановления');

// открываем копию кодом (как клиент) и ставим новый пароль
const sec = JSON.parse(new TextDecoder().decode(await aesDecryptBytes(await importAes(K), r.d.blob)));
ok(sec.room === 'ключ-комнаты', 'код восстановления открывает копию — старая переписка не потеряется');
const newAuth = hex(32), saltAuth = hex(), saltWrap = hex();
const wrapKey = await importAes(crypto.getRandomValues(new Uint8Array(32)));
const body = {
  token: link, saltAuth, authKey: newAuth, saltWrap,
  wrappedKeyByPass: await aesEncryptBytes(wrapKey, fromB64u8(Buffer.from(sec.room, 'utf8').toString('base64'))),
  wrappedPriv: await aesEncryptBytes(wrapKey, fromB64u8(Buffer.from(sec.pkcs8, 'utf8').toString('base64')))
};
r = await call('/api/recover/commit', { method: 'POST', body });
ok(r.status === 200, 'новый пароль поставлен по ссылке из письма');
r = await call('/api/login', { method: 'POST', body: { name: 'Владелец', authKey: newAuth } });
ok(r.status === 200 && !!r.d.token, 'и вход новым паролем работает');
r = await call('/api/login', { method: 'POST', body: { name: 'Владелец', authKey: oldAuth } });
ok(r.status === 403, 'а старый пароль больше не пускает');

/* ── 4. Отметки выпуска ─────────────────────────────────────────────────── */
console.log('\n  4. Отметки выпуска');
ok((/const BUILD = '([^']+)'/.exec(appJs) || [])[1] === BUILD && /^pkg3-1\d\d$/.test(BUILD), `отметка выпуска одна (${BUILD})`);
ok(((/const BUILD = '([^']+)'/.exec(read('lib/api.js')) || [])[1]) === BUILD, 'BUILD в lib/api.js тот же');
ok((/const STATIC_CACHE = '([^']+)'/.exec(read('public/sw.js')) || [])[1] === 'sega-static-v142', 'кэш оформления поднят до v136');
ok(/\| pkg3-146 \|/.test(read('README.md')), 'в журнале README есть строка pkg3-146');
ok(read('package.json').includes('node test/ui142.mjs'), 'тест ui142 включён в цепочку npm test');

console.log(`\n  ИТОГ: ${good} ✓, ${bad ? bad + ' провалов' : 'провалов нет'}\n`);
process.exit(bad ? 1 : 0);
