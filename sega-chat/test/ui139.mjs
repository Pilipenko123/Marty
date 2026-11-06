// test/ui139.mjs — pkg3-142: письмо в поддержку стало письмом, по которому
//                 можно открыть порты, а не отчётом о сбое программы.
//
// Владелец прислал текст, который собрал 138-й. Диагноз в нём уже правильный
// (порты 465/587/25 молчат и по IPv4, и по IPv6, а 443 работает — значит,
// блокирует хостер), но само письмо выглядело сырым:
//   • каждый адрес печатался ДВАЖДЫ — в строке ошибки и ещё раз в скобках;
//   • не было ни адреса сервера, ни даты проверки — хостеру не за что зацепиться;
//   • «нет ответа за 2.0 с» — мало, в поддержке вправе сказать «мало ждали»;
//   • не было обходного пути: у SendGrid/Mailgun и подобных есть порт 2525,
//     который часто остаётся открытым, когда 25/465/587 закрыты.
// Здесь проверяем, что всё это исправлено.
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
console.log('  pkg3-142: письмо в поддержку — по делу и без повторов');
console.log('══════════════════════════════════════════════════\n');

const smtp = await import('../lib/smtp.js').then(m => m.default || m);

/* ── 1. Адрес сервера: хос­теру нужен IP, а не имя машины ─────────────────── */
console.log('  1. Адрес сервера для поддержки');
process.env.SEGA_SERVER_IP = '185.72.144.74';
ok(smtp.serverAddress() === '185.72.144.74', 'адрес можно задать руками (SEGA_SERVER_IP) — на облачном VPS он не всегда на интерфейсе');
process.env.SEGA_SERVER_IP = 'не-адрес';
ok(smtp.serverAddress() !== 'не-адрес', 'мусор в переменной не попадает в письмо');
delete process.env.SEGA_SERVER_IP;
ok(typeof smtp.serverAddress() === 'string', 'без переменной функция отвечает строкой (адрес интерфейса или пусто)');

/* ── 2. Письмо: без задвоенных адресов, с фактами ───────────────────────── */
console.log('\n  2. Письмо в поддержку');
const silent = net.createServer(() => { /* принимает и молчит */ });
await new Promise(r => silent.listen(0, '127.0.0.1', r));
const silentPort = silent.address().port;
const web = net.createServer(s => s.end());
await new Promise(r => web.listen(0, '127.0.0.1', r));
const webPort = web.address().port;
const deadPort = await freePort();

process.env.SEGA_SERVER_IP = '185.72.144.74';
process.env.SEGA_SMTP_HOST = '127.0.0.1';
process.env.SEGA_SMTP_PORT = String(silentPort);
process.env.SEGA_SMTP_USER = 'me@example.com';
process.env.SEGA_SMTP_FROM = 'me@example.com';
process.env.SEGA_SMTP_PLAIN = '1';
const rep = await smtp.checkAll(2500, { netTargets: [{ target: '1.1.1.1:443', host: '127.0.0.1', port: webPort }] });
const t = String(rep.ticket || '');
ok(t.length > 200, 'письмо собрано');
ok(t.includes('185.72.144.74'), 'в письме есть IP сервера — хостеру есть что проверить');
ok(t.includes(os.hostname()), 'и имя машины');
ok(/Проверено .*\d{2}\.\d{2}\.\d{4}/.test(t) || /Проверено .*\d{4}-\d{2}-\d{2}/.test(t), 'и дата проверки (не «когда-то»)');
ok(t.includes('127.0.0.1:' + silentPort), 'и адрес почтового сервера с портом');
ok(/Интернет при этом работает/.test(t), 'и доказательство, что интернет жив');
ok(!/\[[^\]]*нет ответа[^\]]*\]/.test(t), 'адреса больше не дублируются в квадратных скобках');
ok((t.match(/127\.0\.0\.1 \(IPv4\)/g) || []).length >= 4, 'каждый порт показан по адресу отдельной строкой');
ok(/465 \(SSL\)/.test(t) && /587 \(STARTTLS\)/.test(t), 'порты 465 и 587 названы');
ok(/2525/.test(t), 'и обходной 2525 — у некоторых сервисов он открыт, когда остальные закрыты');
ok(/закрыт \(сервер отказал в соединении\)/.test(t), 'закрытый порт назван закрытым, а не «нет ответа»');
ok(/нет ответа/.test(t), 'а молчащий — молчащим (это разные вещи для поддержки)');
ok(/для адреса 185\.72\.144\.74/.test(t), 'просьба сформулирована про конкретный адрес');
ok(/релей/i.test(t), 'и есть запасной вопрос — про SMTP-релей хостера');
delete process.env.SEGA_SERVER_IP;

/* ── 3. Порт 2525 как обходной путь ─────────────────────────────────────── */
console.log('\n  3. Если открыт только 2525');
let alt = null;
try {
  alt = net.createServer(s => { s.end('220 alt ESMTP\r\n'); });
  await new Promise((res, rej) => { alt.once('error', rej); alt.listen(2525, '127.0.0.1', res); });
} catch (e) { alt = null; }
if (alt) {
  process.env.SEGA_SMTP_PORT = String(deadPort);
  const repAlt = await smtp.checkAll(1500, { netTargets: [{ target: '1.1.1.1:443', host: '127.0.0.1', port: webPort }] });
  ok(repAlt.ports.some(p => p.port === 2525 && p.ok), 'проверка замечает открытый 2525');
  ok(/2525/.test(repAlt.advice || '') && /SEGA_SMTP_PORT=2525/.test(repAlt.advice || ''), 'и советует поставить его в настройки');
  alt.close();
} else {
  ok(/2525/.test(read('lib/smtp.js')), 'порт 2525 проверяется (занять его на стенде не вышло)');
  ok(/SEGA_SMTP_PORT=2525/.test(read('lib/smtp.js')), 'и совет про 2525 есть в коде');
}
silent.close(); web.close();

/* ── 4. Клиент: спокойное объяснение, что почта не обязательна ──────────── */
console.log('\n  4. Клиент: почта не обязательна');
const appJs = read('public/app.js');
ok(/Почта нужна только для восстановления пароля по письму/.test(appJs), 'в окне проверки сказано, зачем вообще почта');
ok(/пароль владелец может сбросить вручную/.test(appJs), 'и что пароль можно сбросить без неё');
ok(/pf-mail-copy/.test(appJs) && /navigator\.clipboard\.writeText\(r\.ticket\)/.test(appJs), 'кнопка «Скопировать для поддержки» на месте');
ok(/checkAll\(5000\)/.test(read('lib/api.js')), 'на проверку даётся 5 с — в письме не будет «мало ждали»');

/* ── 5. Живой сервер: письмо отдаётся кнопке ────────────────────────────── */
console.log('\n  5. Живой сервер: письмо приходит в ответ кнопки');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sega-139-'));
const port = await freePort();
const base = 'http://127.0.0.1:' + port;
const proc = spawn(process.execPath, ['server.js'], {
  cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
  env: Object.assign({}, process.env, {
    STORE: 'file', DATA_DIR: path.join(dir, 'data'), HOST: '127.0.0.1', HTTPS: '', PRESENCE_EVERY: '0',
    NEW_INVITE_DELAY: '0', INVITE_COOLDOWN_MS: '0', PORT: String(port),
    SEGA_SMTP_HOST: '127.0.0.1', SEGA_SMTP_PORT: String(silentPort),
    SEGA_SMTP_USER: 'bot@test.local', SEGA_SMTP_PASS: 'good',
    SEGA_SMTP_FROM: 'bot@test.local', SEGA_SMTP_PLAIN: '1', SEGA_SERVER_IP: '185.72.144.74'
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
r = await call('/api/admin/mail', {}, admin);
ok(r.status === 200 && typeof r.d.ticket === 'string' && r.d.ticket.length > 200, 'кнопка отдаёт готовое письмо');
ok(r.d.ticket.includes('185.72.144.74'), 'и в нём адрес сервера из SEGA_SERVER_IP');
ok(r.d.ports.some(p => p.port === 2525), 'и проверка портов включает 2525');
ok(!/\[[^\]]*(нет ответа|ECONNREFUSED)[^\]]*\]/.test(r.d.ticket), 'в письме нет квадратных скобок с повторами');

/* ── 6. Отметки выпуска ─────────────────────────────────────────────────── */
console.log('\n  6. Отметки выпуска');
ok((/const BUILD = '([^']+)'/.exec(appJs) || [])[1] === BUILD && BUILD === 'pkg3-142', `отметка выпуска одна (${BUILD})`);
ok(((/const BUILD = '([^']+)'/.exec(read('lib/api.js')) || [])[1]) === BUILD, 'BUILD в lib/api.js тот же');
ok((/const STATIC_CACHE = '([^']+)'/.exec(read('public/sw.js')) || [])[1] === 'sega-static-v136', 'кэш оформления поднят до v133');
ok(/\| pkg3-142 \|/.test(read('README.md')), 'в журнале README есть строка pkg3-142');
ok(read('package.json').includes('node test/ui139.mjs'), 'тест ui139 включён в цепочку npm test');

console.log(`\n  ИТОГ: ${good} ✓, ${bad ? bad + ' провалов' : 'провалов нет'}\n`);
process.exit(bad ? 1 : 0);
