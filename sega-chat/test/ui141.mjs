// test/ui141.mjs — pkg3-146: «Мои устройства» и «Выйти на всех остальных».
//
// Отпечатки сессий появились в базе ещё в 135-м, но человек их не видел:
// украденный вход можно было заметить только по странным сообщениям. Здесь
// проверяем, что теперь видно «когда, откуда, с чего входили», что чужие входы
// закрываются в один клик, что сессия живёт 30 дней, а не 60, и что владелец
// может послать себе тестовое письмо — «сервер принял» и «письмо дошло» это
// разные вещи.
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
console.log('  pkg3-146: мои устройства, выход на всех, тестовое письмо');
console.log('══════════════════════════════════════════════════\n');

function fakeSmtp() {
  return new Promise(res => {
    const holder = { port: 0, last: null, rcpt: '' };
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
          else if (up.startsWith('RCPT TO')) { holder.rcpt = ln.replace(/^.*<|>.*$/g, ''); sock.write('250 ok\r\n'); }
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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sega-141-'));
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

const UA_PHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const UA_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

async function call(p, opts = {}, token, ua) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = 'Bearer ' + token;
  if (ua) h['User-Agent'] = ua;
  const r = await fetch(base + p, { ...opts, headers: h, body: opts.body ? JSON.stringify(opts.body) : undefined });
  let d = null;
  try { d = await r.json(); } catch (e) {}
  return { status: r.status, d };
}
const creds = name => ({ name, saltAuth: hex(), authKey: hex(32), saltWrap: hex(), wrappedKeyByPass: 'w:' + hex(), pub: 'pub:' + hex(), wrappedPriv: 'priv:' + hex() });

/* ── 1. Список входов ───────────────────────────────────────────────────── */
console.log('  1. «Мои устройства»: что видно');
// пароль не пересчитываем: сервер сверяет присланный authKey — берём тот же
const myAuth = hex(32);
const me1 = creds('Владелец');
me1.authKey = myAuth;
const reg = await call('/api/setup', { method: 'POST', body: Object.assign({}, me1, { codeProofSalt: hex(), codeProof: hex(32), codeSalt: hex(), wrappedKeyByCode: 'k:' + hex() }) }, null, UA_WIN);
const admin = reg.d.token;
ok(reg.status === 200 && !!admin, 'владелец вошёл с компьютера');

let r = await call('/api/sessions', {}, admin, UA_WIN);
ok(r.status === 200 && Array.isArray(r.d.list) && r.d.list.length === 1, 'список входов отдаётся (один вход)');
const first = (r.d.list || [])[0] || {};
ok(first.current === true, 'свой вход помечен «это устройство»');
ok(/Windows/.test(first.device || '') && /Chrome/.test(first.device || ''), `устройство названо по-человечески («${first.device}»)`);
ok(!!first.at && !!first.seen, 'видно, когда вошли и когда были последний раз');
ok(r.d.ttlDays === 30, `сессия живёт 30 дней (${r.d.ttlDays})`);
ok(!!first.id, 'у входа есть короткое имя — по нему можно закрыть именно его');

/* ── 2. Чужой вход закрывается ──────────────────────────────────────────── */
console.log('\n  2. «Выйти на всех остальных»');
// второй вход тем же человеком, но «с телефона»
r = await call('/api/login', { method: 'POST', body: { name: 'Владелец', authKey: myAuth } }, null, UA_PHONE);
const phone = r.d && r.d.token;
ok(r.status === 200 && !!phone, 'второй вход с телефона');
r = await call('/api/sessions', {}, admin, UA_WIN);
ok(r.d.list.length === 2, 'оба входа видны в списке');
const phones = r.d.list.filter(x => /iPhone/.test(x.device || ''));
ok(phones.length === 1 && phones[0].current === false, 'телефон узнан по строке браузера и помечен как чужой');
ok(r.d.list.filter(x => x.current).length === 1, '«это устройство» ровно одно');

r = await call('/api/sessions/revoke', { method: 'POST', body: {} }, admin, UA_WIN);
ok(r.status === 200 && r.d.closed === 1, '«выйти на всех остальных» закрыл ровно один вход');
const phoneAfter = await call('/api/sessions', {}, phone, UA_PHONE);
ok(phoneAfter.status === 401, 'закрытый вход больше не пускает');
r = await call('/api/sessions', {}, admin, UA_WIN);
ok(r.d.list.length === 1 && r.d.list[0].current === true, 'свой вход остался — с него и продолжаем');

// и отдельный вход тоже закрывается — по имени
r = await call('/api/login', { method: 'POST', body: { name: 'Владелец', authKey: myAuth } }, null, UA_PHONE);
const phone2 = r.d.token;
r = await call('/api/sessions', {}, admin, UA_WIN);
const victim = (r.d.list.find(x => !x.current) || {}).id;
r = await call('/api/sessions/revoke', { method: 'POST', body: { id: victim } }, admin, UA_WIN);
ok(r.status === 200 && r.d.closed === 1, 'один конкретный вход закрывается по имени');
const phoneGone = await call('/api/sessions', {}, phone2, UA_PHONE);
ok(phoneGone.status === 401, 'и закрыт именно он');

/* ── 3. Срок жизни сессии ───────────────────────────────────────────────── */
console.log('\n  3. Срок сессии и устройства');
ok(/const SESSION_TTL = Number\(opts\.sessionTtl \|\| 30 \* 24 \* 60 \* 60 \* 1000\)/.test(read('lib/api.js')),
  'в коде срок сессии — 30 дней (вместо прежних 60)');
ok(/deviceOf/.test(read('lib/api.js')), 'устройство угадывается по строке браузера');
ok(/ua: String\(h\['user-agent'\]/.test(read('lib/api.js')), 'и сохраняется вместе с сессией, а не выдумывается потом');

/* ── 4. Тестовое письмо ─────────────────────────────────────────────────── */
console.log('\n  4. «Отправить тестовое письмо»');
// почту привяжем по-настоящему: код берём из письма
await call('/api/profile', { method: 'POST', body: { email: 'owner@test.local' } }, admin, UA_WIN);
const code = ((String(smtpSrv.last || '').match(/Код подтверждения:\s*(\d{6})/) || [])[1] || '');
await call('/api/profile', { method: 'POST', body: { emailCode: code } }, admin, UA_WIN);
smtpSrv.last = null; smtpSrv.rcpt = '';
r = await call('/api/admin/mail/test', { method: 'POST', body: {} }, admin, UA_WIN);
ok(r.status === 200 && r.d.ok === true, 'тестовое письмо отправлено');
ok(/owner@test\.local/.test(smtpSrv.rcpt || ''), 'на привязанный адрес, а не «куда-нибудь»');
ok(/проверочное письмо/i.test(smtpSrv.last || ''), 'и в письме понятный текст');
r = await call('/api/profile', {}, admin, UA_WIN);
ok(r.d.mail && r.d.mail.last && r.d.mail.last.ok === true, 'успех отмечен в профиле');

await smtpSrv.close();
r = await call('/api/admin/mail/test', { method: 'POST', body: {} }, admin, UA_WIN);
ok(r.status === 502 && /не ушло/i.test(r.d.error || ''), 'если почта умерла — честный отказ, а не «отправлено»');

/* ── 5. Клиент и отметки ────────────────────────────────────────────────── */
console.log('\n  5. Клиент и отметки');
const appJs = read('public/app.js');
ok(/Мои устройства/.test(appJs) && /paintPfDevices/.test(appJs), 'в профиле есть раздел «Мои устройства»');
ok(/\/api\/sessions/.test(appJs), 'клиент спрашивает список входов у сервера');
ok(/Выйти на всех остальных/.test(appJs), 'и умеет закрыть все остальные');
// pkg3-146: «Выйти здесь» стало «Закрыть» на строке устройства — проверяем,
// что вход по-прежнему можно закрыть по имени, а не только все сразу
ok(/data-ids=/.test(appJs) && /\/api\/sessions\/revoke/.test(appJs), 'и отдельные входы закрываются по имени');
ok(/проверочное письмо|Отправить тестовое письмо/.test(appJs), 'есть кнопка тестового письма');
ok(/\/api\/admin\/mail\/test/.test(appJs), 'и она действительно ходит на сервер');
ok((/const BUILD = '([^']+)'/.exec(appJs) || [])[1] === BUILD && /^pkg3-1\d\d$/.test(BUILD), `отметка выпуска одна (${BUILD})`);
ok(((/const BUILD = '([^']+)'/.exec(read('lib/api.js')) || [])[1]) === BUILD, 'BUILD в lib/api.js тот же');
ok((/const STATIC_CACHE = '([^']+)'/.exec(read('public/sw.js')) || [])[1] === 'sega-static-v144', 'кэш оформления поднят до v135');
ok(/\| pkg3-146 \|/.test(read('README.md')), 'в журнале README есть строка pkg3-146');
ok(read('package.json').includes('node test/ui141.mjs'), 'тест ui141 включён в цепочку npm test');

console.log(`\n  ИТОГ: ${good} ✓, ${bad ? bad + ' провалов' : 'провалов нет'}\n`);
process.exit(bad ? 1 : 0);
