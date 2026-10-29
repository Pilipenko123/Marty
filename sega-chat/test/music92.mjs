// test/music92.mjs — pkg3-92: пузырёк «Моя музыка», тумблер видимости,
// «Слушаю с …» (живой якорь), меню «Сделать прочитанными?».
// Серверные сценарии: якорь в статусе, область видимости, временная ссылка на
// дисковый трек слушающего, music-off, TTL. Плюс метки клиента и стилей.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
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
console.log('  pkg3-92: пузырёк, тумблер видимости, «Слушаю с …», «Сделать прочитанными?»');
console.log('══════════════════════════════════════════════════\n');

// ─────────────── игрушечный Яндекс (только выдача ссылки) ───────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sega-m92-'));
const keysPath = path.join(dir, 'yandex-oauth.json');
fs.writeFileSync(keysPath, JSON.stringify({ client_id: 'ID92', client_secret: 'SECRET92' }));
const mock = http.createServer((rq, rs) => {
  const u = new URL(rq.url, 'http://mock');
  const jsend = (code, obj) => { rs.writeHead(code, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify(obj)); };
  if (rq.method === 'POST' && u.pathname === '/token') {
    let b = '';
    rq.on('data', c => { b += c; });
    rq.on('end', () => jsend(200, { access_token: 'AT-92', refresh_token: 'RT-92', expires_in: 3600, token_type: 'bearer' }));
    return;
  }
  if (rq.method === 'GET' && u.pathname === '/v1/disk/resources/download') {
    const p = String(u.searchParams.get('path') || '');
    if (p === 'disk:/follow.mp3') return jsend(200, { href: 'https://mock-cdn.yandex.net/get/follow?sig=f92', method: 'GET', ttl: '1800' });
    return jsend(404, { message: 'Resource not found' });
  }
  jsend(404, {});
});
await new Promise(r => mock.listen(0, '127.0.0.1', r));
const mockBase = 'http://127.0.0.1:' + mock.address().port;

async function freePort() {
  const { createServer } = await import('node:net');
  return new Promise(r => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
}
const procs = [];
process.on('exit', () => { for (const p of procs) { try { p.kill('SIGKILL'); } catch (e) {} } try { mock.close(); } catch (e) {} });

const port = await freePort();
const proc = spawn(process.execPath, ['server.js'], {
  cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
  env: Object.assign({}, process.env, {
    STORE: 'file', DATA_DIR: path.join(dir, 'data'), HOST: '127.0.0.1', HTTPS: '', PRESENCE_EVERY: '0',
    NEW_INVITE_DELAY: '0', INVITE_COOLDOWN_MS: '0', PORT: String(port),
    TYPING_TTL_MUSIC: '1200',
    YADISK_OAUTH_BASE: mockBase, YADISK_API_BASE: mockBase,
    YADISK_KEYS: keysPath, YADISK_REDIRECT: 'http://127.0.0.1:' + port + '/api/yadisk/callback'
  })
});
procs.push(proc);
const base = 'http://127.0.0.1:' + port;
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

let r = await call('/api/setup', { method: 'POST', body: Object.assign({}, creds('Мартин'), { codeProofSalt: hex(), codeProof: hex(32), codeSalt: hex(), wrappedKeyByCode: 'k:' + hex() }) });
ok(r.status === 200, 'мессенджер настроен');
const admin = r.d.token;
r = await call('/api/state');
ok(r.status === 200 && r.d.build === 'pkg3-97', 'сервер помечен pkg3-97');
const secret = hex(24);
const sha = crypto.createHash('sha256').update(secret).digest('hex');
const ir = await call('/api/invites', { method: 'POST', body: { invSalt: hex(), wrappedRoomKey: 'k:' + hex(), secretHash: sha } }, admin);
r = await call('/api/register', { method: 'POST', body: Object.assign({}, creds('Вася'), { inviteToken: ir.d.invite.id + '.' + secret }) });
const A = r.d.token; const aId = r.d.user.id;
const secret2 = hex(24);
const sha2 = crypto.createHash('sha256').update(secret2).digest('hex');
const ir2 = await call('/api/invites', { method: 'POST', body: { invSalt: hex(), wrappedRoomKey: 'k:' + hex(), secretHash: sha2 } }, admin);
r = await call('/api/register', { method: 'POST', body: Object.assign({}, creds('Клава'), { inviteToken: ir2.d.invite.id + '.' + secret2 }) });
const B = r.d.token; const bId = r.d.user.id;
const secret3 = hex(24);
const sha3 = crypto.createHash('sha256').update(secret3).digest('hex');
const ir3 = await call('/api/invites', { method: 'POST', body: { invSalt: hex(), wrappedRoomKey: 'k:' + hex(), secretHash: sha3 } }, admin);
r = await call('/api/register', { method: 'POST', body: Object.assign({}, creds('Гость'), { inviteToken: ir3.d.invite.id + '.' + secret3 }) });
const C = r.d.token;
ok(!!A && !!B && !!C, 'три участника готовы');

// личный чат А↔B — общая область видимости статуса
r = await call('/api/dm', { method: 'POST', body: { peer: bId } }, A);
ok(r.status === 200 && r.d.chat && r.d.chat.id, 'личный чат Вася↔Клава создан');
const dm = r.d.chat.id;

console.log('\n  1. Якорь прослушивания в статусе');
r = await call('/api/typing', { method: 'POST', body: { kind: 'music', note: 'Неон', sync: { kind: 'url', url: 'https://example.com/a.mp3', pos: 12, at: Date.now(), playing: true } } }, A);
ok(r.status === 200, 'статус с якорем принят');
r = await call('/api/music/status?of=' + aId, {}, B);
ok(r.status === 200 && r.d.note === 'Неон' && r.d.sync && r.d.sync.kind === 'url' && r.d.sync.url === 'https://example.com/a.mp3' && r.d.sync.pos === 12,
  'свой круг видит статус и якорь (трек, позиция, время)');
r = await call('/api/typing?chat=' + dm, {}, B);
ok(r.status === 200 && (r.d.music || [])[0] && r.d.music[0].sync && r.d.music[0].sync.url === 'https://example.com/a.mp3',
  'синхронизация чата тоже несёт якорь');
r = await call('/api/music/status?of=' + aId, {}, C);
ok(r.status === 404, 'посторонний статус не видит (404)');
r = await call('/api/typing', { method: 'POST', body: { kind: 'music', note: 'Личное', sync: { kind: 'url', url: 'http://insecure.example.com/a.mp3', pos: 1, at: Date.now() } } }, A);
r = await call('/api/music/status?of=' + aId, {}, B);
ok(r.status === 200 && r.d.note === 'Личное' && r.d.sync === null, 'не-https ссылка в якорь не проходит: статус без якоря (синхронно слушать нельзя)');
r = await call('/api/typing', { method: 'POST', body: { kind: 'music', note: '', sync: { kind: 'disk', path: 'disk:/follow.mp3', pos: 5, at: Date.now(), playing: true } } }, A);
r = await call('/api/music/status?of=' + aId, {}, B);
ok(r.status === 200 && r.d.sync && r.d.sync.kind === 'disk' && r.d.sync.path === 'disk:/follow.mp3', 'дисковый якорь доходит до своего круга');
r = await call('/api/typing', { method: 'POST', body: { kind: 'music', note: '', sync: { kind: 'disk', path: 'disk:/a/../b', pos: 0, at: Date.now() } } }, A);
r = await call('/api/music/status?of=' + aId, {}, B);
ok(r.status === 200 && r.d.sync === null, 'путь с «..» в якорь не проходит');

console.log('\n  2. Временная ссылка на дисковый трек слушающего');
await call('/api/typing', { method: 'POST', body: { kind: 'music', note: '', sync: { kind: 'disk', path: 'disk:/follow.mp3', pos: 5, at: Date.now(), playing: true } } }, A);
// слушающему нужен свой токен Диска: подключим его через игрушечный Яндекс
r = await call('/api/yadisk/auth-url', {}, A);
ok(r.status === 200 && r.d.url, 'ссылка согласия получена');
const st = String(r.d.url).split('state=')[1];
r = await fetch(base + '/api/yadisk/callback?code=GOODCODE&state=' + st);
ok(r.status === 200, 'обратный ход Яндекса принят (подключение Диска у слушающего)');
r = await call('/api/music/follow-href?owner=' + aId + '&path=' + encodeURIComponent('disk:/follow.mp3'), {}, B);
ok(r.status === 200 && String(r.d.href).startsWith('https://mock-cdn.yandex.net/'), 'нажавший на плашку получил свежую ссылку на трек слушающего');
r = await call('/api/music/follow-href?owner=' + aId + '&path=' + encodeURIComponent('disk:/other.mp3'), {}, B);
ok(r.status === 404, 'ссылка выдаётся ТОЛЬКО на играющийся сейчас путь (иначе 404)');
r = await call('/api/music/follow-href?owner=' + aId + '&path=' + encodeURIComponent('disk:/follow.mp3'), {}, C);
ok(r.status === 404, 'посторонний временную ссылку не получает');

console.log('\n  3. Тумблер видимости и TTL');
r = await call('/api/typing', { method: 'POST', body: { kind: 'music-off' } }, A);
r = await call('/api/music/status?of=' + aId, {}, B);
ok(r.status === 200 && !r.d.note && !r.d.sync, 'music-off (тумблер выключен) гасит статус и якорь');
await call('/api/typing', { method: 'POST', body: { kind: 'music', note: 'ТТЛ', sync: { kind: 'url', url: 'https://example.com/t.mp3', pos: 1, at: Date.now() } } }, A);
await wait(1600);
r = await call('/api/music/status?of=' + aId, {}, B);
ok(r.status === 200 && !r.d.note, 'без подтверждения статус гаснет сам (TTL)');

console.log('\n  4. Метки выпуска в дереве');
const appJs = read('public/app.js');
const apiJs = read('lib/api.js');
const css = read('public/styles.css');
const sw = read('public/sw.js');
const pkg = read('package.json');
const readme = read('README.md');
ok(appJs.includes("fab.textContent = '🎵 Моя музыка';") && appJs.includes('function musicFabBind(') && appJs.includes('sega.musFabPos.v1'),
  'пузырёк переименован в «Моя музыку», перетаскивается и запоминает место');
ok(appJs.includes('function musMinimize(') && appJs.includes('function musFly(') && appJs.includes('function musCloseFull('),
  'pkg3-93: окно сворачивается в пузырёк перелётом, крестик закрывает совсем (пузырёк исчезает)');
ok(appJs.includes('id="mus-vis"') && appJs.includes('function musVisGet(') && css.includes('.mus-sw-pill{') && css.includes('.mus-sw-knob{'),
  '«видно, что слушаю» — тумблер-переключатель в панели плеера');
ok(!appJs.includes('id="mus-together"') && !appJs.includes('async function musicTogether('),
  'кнопки «🎧 вместе» больше нет: писем в открытый чат выпуск не шлёт');
ok(appJs.includes('data-mus-follow') && appJs.includes('function musStartFollow(') && appJs.includes('function musApplySync(') && appJs.includes('function musFollowPoll('),
  'плашка «слушает музыку» кликабельна: живой режим «Слушаю с …» по якорю');
ok(appJs.includes('Слушаю с «') && appJs.includes('function musBreakFollow(') && appJs.includes('musFollowSilence'),
  'надпись «Слушаю с …»; свои стоп/перемотка/трек обрывают синхронизацию, подчинение якорю — нет');
ok(appJs.includes('data-readmenu=') && appJs.includes('function askYesNo(') && appJs.includes('function markChatRead(') && css.includes('.ask-card{'),
  'счётчик непрочитанных открывает меню «Сделать прочитанными? Да/Нет» без открытия чата');
ok(apiJs.includes("'/api/music/status'") && apiJs.includes("'/api/music/follow-href'") && apiJs.includes('function cleanSync('),
  'сервер: маршрут живого статуса и выдача временной ссылки своего круга');
ok(appJs.includes("kind: 'music', note: musicStatusNote(), sync: musicStatusSync()"),
  'клиент шлёт якорь только при включённой видимости и делимом треке');
ok(sw.includes("const STATIC_CACHE = 'sega-static-v90';"), 'кэш статики поднят до v90');
ok(pkg.includes('node test/music92.mjs'), 'тест music92 включён в цепочку npm test');
ok(readme.includes('| pkg3-92 |'), 'в журнале README есть строка выпуска pkg3-92');
const deps = JSON.parse(pkg).dependencies;
ok(Object.keys(deps).length === 1 && deps['web-push'], 'зависимость по-прежнему одна: web-push');

console.log('\n  pkg3-92: ' + good + ' ✓' + (bad ? ', ' + bad + ' ПРОВАЛОВ' : ', провалов нет'));
process.exit(bad ? 1 : 0);   // тест держит живой сервер и игрушечный Яндекс — выходим сами
