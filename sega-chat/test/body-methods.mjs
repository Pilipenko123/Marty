/**
 * pkg3-53: тело запроса у методов DELETE и PATCH должно доходить до сервера.
 *
 * Зачем отдельная проверка: локальный сервер (server.js — на нём работает VPS)
 * читал тело только у POST и PUT, поэтому отписка от уведомлений
 * (DELETE /api/push/subscribe с адресом подписки в теле) приходила пустой и
 * молча не срабатывала: сервер отвечал «готово», а подписка оставалась.
 * В облачном входе (cloud/index.js) тело читается всегда — там ошибки не было,
 * поэтому она и всплыла только после переезда на свой сервер.
 *
 * Запуск: node test/body-methods.mjs
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
const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function call(base, p, opts = {}, token) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { ...opts, headers: h, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const ct = r.headers.get('content-type') || '';
  const buf = Buffer.from(await r.arrayBuffer());
  if (ct.includes('json')) { try { return { status: r.status, d: JSON.parse(buf.toString('utf8')) }; } catch (e) {} }
  return { status: r.status, d: buf.toString('utf8') };
}
async function freePort() {
  const { createServer } = await import('node:net');
  return new Promise(r => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
}
const procs = [];
process.on('exit', () => { for (const p of procs) { try { p.kill('SIGKILL'); } catch (e) {} } });

console.log('\n══════════════════════════════════════════════════');
console.log('  Тело запроса у DELETE/PATCH доходит до сервера');
console.log('══════════════════════════════════════════════════\n');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sega-body-'));
const dbFile = path.join(dir, 'db.json');
const port = await freePort();
const srv = spawn(process.execPath, ['server.js'], {
  cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
  env: Object.assign({}, process.env, { PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir, STORE: 'file', HTTPS: '', PRESENCE_EVERY: '0' })
});
procs.push(srv);
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/api/state')).ok) break; } catch (e) {} await wait(200); }

const creds = { name: 'Мартин', saltAuth: hex(), authKey: hex(32), saltWrap: hex(), wrappedKeyByPass: 'w:' + hex() };
let r = await call(base, '/api/setup', {
  method: 'POST', body: Object.assign({}, creds, { codeProofSalt: hex(), codeProof: hex(32), codeSalt: hex(), wrappedKeyByCode: 'k:' + hex() })
});
ok(r.status === 200, 'мессенджер настроен, администратор вошёл');
const token = r.d.token;
const readSubs = () => {
  try { return (JSON.parse(fs.readFileSync(dbFile, 'utf8')).users[0].pushSubs) || []; } catch (e) { return null; }
};

const sub = { endpoint: 'https://push.example/abc', keys: { p256dh: hex(32), auth: hex(8) } };
r = await call(base, '/api/push/subscribe', { method: 'POST', body: { subscription: sub } }, token);
ok(r.status === 200, 'подписка на уведомления принята (POST)');
ok(readSubs().length === 1, 'подписка записана в базу');

// главное: DELETE с телом. Раньше тело терялось, подписка оставалась, а сервер
// отвечал «готово» — то есть проверка обязана смотреть В БАЗУ, а не в ответ.
r = await call(base, '/api/push/subscribe', { method: 'DELETE', body: { endpoint: sub.endpoint } }, token);
ok(r.status === 200, 'отписка отвечала успешно');
ok(readSubs().length === 0, 'отписка реально сработала: подписки в базе больше нет (тело DELETE дошло)');

// повторная отписка и DELETE без тела не должны ни падать, ни висеть
r = await call(base, '/api/push/subscribe', { method: 'DELETE', body: { endpoint: sub.endpoint } }, token);
ok(r.status === 200, 'повторная отписка не ломает сервер');
r = await call(base, '/api/push/subscribe', { method: 'DELETE' }, token);
ok(r.status === 200, 'DELETE вообще без тела проходит без ошибки и без зависания');

// GET по-прежнему работает и не пытается читать тело (иначе запрос бы висел)
r = await call(base, '/api/state');
ok(r.status === 200 && r.d.build, 'GET после всех DELETE отвечает нормально');

// и сам локальный сервер обязан читать тело у этих методов
const srvJs = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
ok(srvJs.includes("'PATCH'") && srvJs.includes("'DELETE'"),
  'локальный сервер читает тело у PATCH и DELETE (облачный вход читал его всегда)');

console.log('\n──────────────────────────────────────────────────');
console.log(`  Тело запроса: ${good} ✓, провалов ${bad}`);
console.log('──────────────────────────────────────────────────\n');

srv.kill('SIGTERM');
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
process.exit(bad ? 1 : 0);
