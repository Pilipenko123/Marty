// test/ui143.mjs — pkg3-146: «Мои устройства» — по строке на устройство,
//                  и входы не копятся сотнями.
//
// Владелец поставил 141/142 и увидел в профиле длинную простыню строк: «вероятно
// это из-за того, что я постоянно выхожу и захожу». Так и было: каждая запись —
// отдельный вход, даже с того же компьютера, живёт 30 дней. Теперь сервер
// собирает входы по устройствам (одна строка «Windows · Chrome, входов: 6»),
// лишние входы сверх потолка закрываются сами, а «Выйти» убирает запись
// действительно, а не только из памяти процесса.
//
// Проверяем:
//   • 6 входов с компьютера и 3 с телефона — это ДВЕ строки, а не девять;
//   • строку устройства можно закрыть целиком ({ids:[…]});
//   • на своём устройстве закрываются только старые входы, текущий остаётся;
//   • «Выйти» убирает строку из списка;
//   • потолок входов (SESSION_MAX=4 на тестовом стенде) вытесняет самые давние;
//   • клиент рисует группы и не спрашивает сервер по-старому.
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
console.log('  pkg3-146: устройства одной строкой, входы не копятся');
console.log('══════════════════════════════════════════════════\n');

const UA_PHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const UA_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const UA_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

const procs = [];
process.on('exit', () => { for (const p of procs) { try { p.kill('SIGKILL'); } catch (e) {} } });

async function startServer(tag, extraEnv) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sega-143-' + tag + '-'));
  const port = await freePort();
  const base = 'http://127.0.0.1:' + port;
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
    env: Object.assign({}, process.env, {
      STORE: 'file', DATA_DIR: path.join(dir, 'data'), HOST: '127.0.0.1', HTTPS: '', PRESENCE_EVERY: '0',
      NEW_INVITE_DELAY: '0', INVITE_COOLDOWN_MS: '0', PORT: String(port)
    }, extraEnv || {})
  });
  procs.push(proc);
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/api/state')).ok) break; } catch (e) {} await wait(200); }
  return { base, proc, dir };
}

function client(base) {
  return async function call(p, opts = {}, token, ua) {
    const h = { 'Content-Type': 'application/json' };
    if (token) h.Authorization = 'Bearer ' + token;
    if (ua) h['User-Agent'] = ua;
    const r = await fetch(base + p, { ...opts, headers: h, body: opts.body ? JSON.stringify(opts.body) : undefined });
    let d = null;
    try { d = await r.json(); } catch (e) {}
    return { status: r.status, d };
  };
}
const creds = name => ({ name, saltAuth: hex(), authKey: hex(32), saltWrap: hex(), wrappedKeyByPass: 'w:' + hex(), pub: 'pub:' + hex(), wrappedPriv: 'priv:' + hex() });

const srv = await startServer('main');
const call = client(srv.base);
const myAuth = hex(32);

/* ── 1. Девять входов — две строки ──────────────────────────────────────── */
console.log('  1. Входы собраны по устройствам');
const me = creds('Владелец');
me.authKey = myAuth;
const reg = await call('/api/setup', { method: 'POST', body: Object.assign({}, me, { codeProofSalt: hex(), codeProof: hex(32), codeSalt: hex(), wrappedKeyByCode: 'k:' + hex() }) }, null, UA_WIN);
const admin = reg.d.token;
ok(reg.status === 200 && !!admin, 'владелец вошёл с компьютера');

const winTokens = [];
for (let i = 0; i < 5; i++) {
  const r = await call('/api/login', { method: 'POST', body: { name: 'Владелец', authKey: myAuth } }, null, UA_WIN);
  winTokens.push(r.d && r.d.token);
}
const phoneTokens = [];
for (let i = 0; i < 3; i++) {
  const r = await call('/api/login', { method: 'POST', body: { name: 'Владелец', authKey: myAuth } }, null, UA_PHONE);
  phoneTokens.push(r.d && r.d.token);
}
ok(winTokens.every(Boolean) && phoneTokens.every(Boolean), 'ещё 5 входов с компьютера и 3 с телефона');

let r = await call('/api/sessions', {}, admin, UA_WIN);
let list = (r.d && r.d.list) || [];
ok(r.status === 200 && list.length === 2, `девять входов — это ${list.length} строки, а не девять`);
const win = list.find(x => /Windows/.test(x.device || '')) || {};
const ph = list.find(x => /iPhone/.test(x.device || '')) || {};
ok(win.count === 6 && (win.ids || []).length === 6, `на компьютере входов: ${win.count}`);
ok(ph.count === 3 && (ph.ids || []).length === 3, `на телефоне входов: ${ph.count}`);
ok(win.current === true && ph.current === false, '«это устройство» стоит ровно на своей строке');
ok(!!ph.id && /iPhone/.test(ph.device || ''), 'у строки телефона есть имя для закрытия');
ok(r.d.total === 9, `всего живых входов: ${r.d.total}`);
ok(win.seen >= win.at && ph.seen >= ph.at, 'видно первый вход и последнюю активность');
ok(r.d.ttlDays === 30, 'срок входа по-прежнему 30 дней');

/* ── 2. Устройство закрывается целиком ──────────────────────────────────── */
console.log('\n  2. «Закрыть» на строке устройства');
r = await call('/api/sessions/revoke', { method: 'POST', body: { ids: ph.ids } }, admin, UA_WIN);
ok(r.status === 200 && r.d.closed === 3, `закрылись все три входа с телефона (${r.d.closed})`);
let alive = 0;
for (const t of phoneTokens) { const x = await call('/api/profile', {}, t, UA_PHONE); if (x.status !== 401) alive++; }
ok(alive === 0, 'ни один закрытый вход больше не пускает');
ok((await call('/api/profile', {}, admin, UA_WIN)).status === 200, 'свой вход продолжает работать');
r = await call('/api/sessions', {}, admin, UA_WIN);
ok(r.d.list.length === 1 && r.d.list[0].count === 6, 'в списке осталась одна строка');

/* ── 3. На своём устройстве — только старые входы ───────────────────────── */
console.log('\n  3. Старые входы на своём устройстве');
const ownIds = (r.d.list[0].ids || []).filter(id => id !== r.d.list[0].currentId);
ok(ownIds.length === 5, 'текущий вход в список на закрытие не попадает');
r = await call('/api/sessions/revoke', { method: 'POST', body: { ids: ownIds } }, admin, UA_WIN);
ok(r.status === 200 && r.d.closed === 5, `закрылись только старые входы (${r.d.closed})`);
alive = 0;
for (const t of winTokens) { const x = await call('/api/profile', {}, t, UA_WIN); if (x.status !== 401) alive++; }
ok(alive === 0, 'старые входы с этого компьютера больше не пускают');
ok((await call('/api/profile', {}, admin, UA_WIN)).status === 200, 'а тот, с которого смотрим, — пускает');
r = await call('/api/sessions', {}, admin, UA_WIN);
ok(r.d.list.length === 1 && r.d.list[0].count === 1, 'в строке остался один вход');

/* ── 4. «Выйти» убирает запись, а не оставляет её ───────────────────────── */
console.log('\n  4. «Выйти» действительно убирает вход');
const mac = await call('/api/login', { method: 'POST', body: { name: 'Владелец', authKey: myAuth } }, null, UA_MAC);
r = await call('/api/sessions', {}, admin, UA_WIN);
ok(r.d.list.length === 2 && /Mac/.test((r.d.list.find(x => !x.current) || {}).device || ''), 'вход с Mac виден отдельной строкой');
await call('/api/logout', { method: 'POST', body: {} }, mac.d.token, UA_MAC);
ok((await call('/api/profile', {}, mac.d.token, UA_MAC)).status === 401, 'после «Выйти» этот вход закрыт');
r = await call('/api/sessions', {}, admin, UA_WIN);
ok(r.d.list.length === 1 && !r.d.list.find(x => /Mac/.test(x.device || '')), 'и строка Mac исчезла из списка, а не осталась висеть');

/* ── 5. Потолок входов ──────────────────────────────────────────────────── */
console.log('\n  5. Входы не копятся без предела (SESSION_MAX=4)');
const srv2 = await startServer('cap', { SESSION_MAX: '4' });
const call2 = client(srv2.base);
const capAuth = hex(32);
const me2 = creds('Хозяин');
me2.authKey = capAuth;
const reg2 = await call2('/api/setup', { method: 'POST', body: Object.assign({}, me2, { codeProofSalt: hex(), codeProof: hex(32), codeSalt: hex(), wrappedKeyByCode: 'k:' + hex() }) }, null, UA_WIN);
const first = reg2.d.token;
ok(reg2.status === 200 && !!first, 'на втором стенде владелец вошёл');
let last = first;
for (let i = 0; i < 8; i++) {
  const x = await call2('/api/login', { method: 'POST', body: { name: 'Хозяин', authKey: capAuth } }, null, UA_WIN);
  last = x.d && x.d.token;
}
r = await call2('/api/sessions', {}, last, UA_WIN);
ok(r.status === 200 && r.d.total === 4, `после девяти входов живых осталось: ${r.d.total} (потолок 4)`);
ok(r.d.list.length === 1 && r.d.list[0].count === 4, 'и это по-прежнему одна строка устройства');
ok((await call2('/api/profile', {}, first, UA_WIN)).status === 401, 'самый давний вход вытеснен и не пускает');
ok((await call2('/api/profile', {}, last, UA_WIN)).status === 200, 'самый свежий вход работает');
r = await call2('/api/sessions', {}, last, UA_WIN);
ok((r.d.list[0].ids || []).length === r.d.list[0].count && !!r.d.list[0].currentId, 'в строке только живые входы, и свой отмечен');

/* ── 6. Клиент и отметки ────────────────────────────────────────────────── */
console.log('\n  6. Клиент и отметки');
const appJs = read('public/app.js');
const apiJs = read('lib/api.js');
ok(/const SESSION_MAX = Math\.max\(3, Number\(process\.env\.SESSION_MAX \|\| 12\)\)/.test(apiJs), 'потолок входов задан в коде (по умолчанию 12)');
ok(/pruneSessions\(u\.id\)/.test(apiJs) && /pruneSessions\(me\.id\)/.test(apiJs), 'и подчищает и при входе, и при просмотре списка');
ok(/byDevice/.test(apiJs) && /ids: \[\]/.test(apiJs), 'сервер отдаёт группы входов по устройствам');
ok(/Array\.isArray\(b\.ids\)/.test(apiJs), 'закрыть можно сразу список входов');
ok(/store\.dropSession\(session\.token\)/.test(apiJs), '«Выйти» чистит и хранилище, а не только память');
ok(/data-ids=/.test(appJs) && /Закрыть старые входы/.test(appJs), 'клиент рисует кнопку на строку устройства');
ok(/входов: /.test(appJs) && /Строки собраны по устройствам/.test(appJs), 'и подписывает, сколько входов в строке');
ok(!/data-close-session/.test(appJs), 'старая разметка «строка на вход» убрана');
ok((/const BUILD = '([^']+)'/.exec(appJs) || [])[1] === BUILD && /^pkg3-1\d\d$/.test(BUILD), `отметка выпуска одна (${BUILD})`);
ok(((/const BUILD = '([^']+)'/.exec(apiJs) || [])[1]) === BUILD, 'BUILD в lib/api.js тот же');
ok((/const STATIC_CACHE = '([^']+)'/.exec(read('public/sw.js')) || [])[1] === 'sega-static-v148', 'кэш оформления поднят до v137');
ok(/\| pkg3-146 \|/.test(read('README.md')), 'в журнале README есть строка pkg3-146');
ok(read('package.json').includes('node test/ui143.mjs'), 'тест ui143 включён в цепочку npm test');

console.log(`\n  ИТОГ: ${good} ✓, ${bad ? bad + ' провалов' : 'провалов нет'}\n`);
process.exit(bad ? 1 : 0);
