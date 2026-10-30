/**
 * pkg3-87: «Моя музыка», этап Б — статус «🎵 слушает», «слушать вместе», чужие плейлисты.
 *   • звуковой статус живёт ТОЛЬКО в памяти сервера (как «пишет»), не привязан к чату:
 *     POST /api/typing kind=music / music-off, читается в GET /api/typing и в синхронизации;
 *   • статус виден лишь тем, с кем у человека есть общий чат (свой круг);
 *   • сервер не хранит статус в базе (слепота и лёгкость перезапуска);
 *   • метки клиента: плашка «Моя музыка» в первом меню «+», карточка «Слушать вместе»
 *     в письмах (якорь: трек + позиция + время), кнопка «🎵 музыка» у чужого аватара,
 *     окно чужих публичных плейлистов только для чтения.
 * Запуск: node test/music87.mjs
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let good = 0, bad = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ПРОВАЛ: ') + m); if (c) good++; else bad++; };
const hex = (n = 16) => crypto.randomBytes(n).toString('hex');
const wait = ms => new Promise(r => setTimeout(r, ms));

async function call(base, p, opts = {}, token) {
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = 'Bearer ' + token;
  const r = await fetch(base + p, { ...opts, headers: h, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const ct = r.headers.get('content-type') || '';
  const buf = Buffer.from(await r.arrayBuffer());
  if (ct.includes('json')) { try { return { status: r.status, d: JSON.parse(buf.toString('utf8')) }; } catch (e) {} }
  return { status: r.status, d: buf.toString('utf8') };
}
async function waitReady(base) {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/api/state')).ok) return; } catch (e) {}
    await wait(200);
  }
  throw new Error('не поднялся ' + base);
}
async function freePort() {
  const { createServer } = await import('node:net');
  return new Promise(r => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
}
const procs = [];
process.on('exit', () => { for (const p of procs) { try { p.kill('SIGKILL'); } catch (e) {} } });

console.log('\n══════════════════════════════════════════════════');
console.log('  pkg3-87: «Моя музыка», этап Б — статус, «вместе», чужие списки');
console.log('══════════════════════════════════════════════════\n');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sega-m87-'));
const port = await freePort();
const proc = spawn(process.execPath, ['server.js'], {
  cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
  env: Object.assign({}, process.env, {
    STORE: 'file', DATA_DIR: dir, HOST: '127.0.0.1', HTTPS: '', PRESENCE_EVERY: '0', NEW_INVITE_DELAY: '0',
    INVITE_COOLDOWN_MS: '0', PORT: String(port)
  })
});
procs.push(proc);
const base = `http://127.0.0.1:${port}`;
await waitReady(base);

const creds = name => ({ name, saltAuth: hex(), authKey: hex(32), saltWrap: hex(), wrappedKeyByPass: 'w:' + hex(), pub: 'pub:' + hex(), wrappedPriv: 'priv:' + hex() });
let r = await call(base, '/api/setup', { method: 'POST', body: Object.assign({}, creds('Мартин'), { codeProofSalt: hex(), codeProof: hex(32), codeSalt: hex(), wrappedKeyByCode: 'k:' + hex() }) });
ok(r.status === 200, 'мессенджер настроен');
const admin = r.d.token, adminId = r.d.user.id;
r = await call(base, '/api/state');
ok(r.status === 200 && r.d.build === 'pkg3-103', 'сервер помечен pkg3-103');
async function register(c, inviter) {
  const secret = hex(24);
  const sha = crypto.createHash('sha256').update(secret).digest('hex');
  const ir = await call(base, '/api/invites', { method: 'POST', body: { invSalt: hex(), wrappedRoomKey: 'k:' + hex(), secretHash: sha } }, inviter);
  return call(base, '/api/register', { method: 'POST', body: Object.assign({}, c, { inviteToken: ir.d.invite.id + '.' + secret }) });
}
r = await register(creds('Вася'), admin);
const v1 = r.d.token, v1Id = r.d.user.id;
ok(!!v1, 'участник готов');
r = await register(creds('Чужой'), v1);   // приглашён Васей: с Мартиным общего чата нет
const outsider = r.d.token, outsiderId = r.d.user.id;
ok(!!outsider, 'второй участник готов (круг Васи, но не Мартина)');

// личный чат админ↔Вася: общий круг для статуса
r = await call(base, '/api/dm', { method: 'POST', body: { peer: v1Id } }, admin);
ok(r.status === 200 && r.d.chat && r.d.chat.id, 'личный чат создан');
const dmId = r.d.chat.id;

// ── статус «🎵 слушает»: ставится без чата и виден своему кругу
r = await call(base, '/api/typing', { method: 'POST', body: { kind: 'music', note: 'Тест-трек' } }, admin);
ok(r.status === 200 && r.d.ok, 'звуковой статус принят без привязки к чату');
r = await call(base, '/api/typing?chat=' + dmId, {}, v1);
ok(r.status === 200 && Array.isArray(r.d.music) && r.d.music.some(x => x.uid === adminId && x.note === 'Тест-трек'),
  'собеседник видит статус в лёгком опросе чата');
r = await call(base, '/api/sync', {}, v1);
ok(r.status === 200 && Array.isArray(r.d.music) && r.d.music.some(x => x.uid === adminId && x.note === 'Тест-трек'),
  'синхронизация несёт статус «🎵 слушает» своему кругу');

// ── чужому (нет общего чата с админом? есть групповой? нет) статус не светится
r = await call(base, '/api/sync', {}, outsider);
ok(r.status === 200 && !(r.d.music || []).some(x => x.uid === adminId),
  'вне общего чата статус не виден: круг остаётся кругом');

// ── длинная строка статуса обрезается до 80 знаков
r = await call(base, '/api/typing', { method: 'POST', body: { kind: 'music', note: 'Н' .repeat(300) } }, admin);
r = await call(base, '/api/typing?chat=' + dmId, {}, v1);
const noteLen = ((r.d.music || []).find(x => x.uid === adminId) || {}).note || '';
ok(r.status === 200 && noteLen.length === 80, 'строка статуса обрезана до 80 знаков (пришло ' + noteLen.length + ')');

// ── статус не пишется в базу: сервер слеп и лёгок
const dbTxt = fs.readFileSync(path.join(dir, 'db.json'), 'utf8');
ok(!dbTxt.includes('Тест-трек') && !dbTxt.includes('musicNow'),
  'статус живёт только в памяти: в базе его нет');

// ── music-off гасит статус
r = await call(base, '/api/typing', { method: 'POST', body: { kind: 'music-off' } }, admin);
ok(r.status === 200, 'music-off принят');
r = await call(base, '/api/typing?chat=' + dmId, {}, v1);
ok(r.status === 200 && (r.d.music || []).length === 0, 'после music-off статус погас');
r = await call(base, '/api/sync', {}, v1);
ok(r.status === 200 && (r.d.music || []).length === 0, 'синхронизация тоже без статуса');

// ── прежние сигналы «пишет/загружает» не пострадали
r = await call(base, '/api/typing', { method: 'POST', body: { chat: dmId, kind: 'type' } }, admin);
ok(r.status === 200 && Array.isArray(r.d.typing), '«пишет» по-прежнему работает с чатом');
r = await call(base, '/api/typing', { method: 'POST', body: { kind: 'type' } }, admin);
ok(r.status === 403, '«пишет» без чата отклоняется (403) — музыка теперь исключение');
r = await call(base, '/api/typing', { method: 'POST', body: { chat: dmId, kind: '' } }, admin);
ok(r.status === 200, 'гашение «пишет» пустым kind на месте');

// ── чужие плейлисты по-прежнему только публичные (этап А не сломан)
r = await call(base, '/api/music', { method: 'POST', body: { pub: [{ id: 'p1', name: 'Пуб', vis: 'pub', tracks: [{ id: 't1', url: 'https://example.com/a.mp3', title: 'А', cover: '' }] }], priv: 'ENC', key: 'KEY' } }, admin);
ok(r.status === 200, 'сохранение списков владельца принято');
r = await call(base, '/api/music/' + adminId, {}, v1);
ok(r.status === 200 && r.d.pub.length === 1 && r.d.priv === undefined && r.d.key === undefined,
  'у чужого аватара сервер отдаёт ТОЛЬКО публичные списки');

// ── метки клиента: меню, карточка «вместе», чужое окно, статус-бит
const appJs = readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const indexHtml = readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const css = readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
ok(indexHtml.includes('data-plus="music"') && indexHtml.includes('Моя музыка'),
  'первое меню «+»: плашка «Моя музыка» на месте');
ok(!appJs.includes('data-ng-music'), 'из списка игр плитка музыки убрана (музыка — не игра)');
ok(appJs.includes("if (p.k === 'mus-together')") && appJs.includes('data-mus-join') && css.includes('.mus-card'),
  'письмо «слушать вместе» рисуется карточкой с кнопкой «Слушать»');
ok(appJs.includes('function musicPlayOnce(') && appJs.includes('data-mus-ts'),
  'якорь «вместе»: трек стартует с позиции предложившего (позиция + время отправки)');
ok(!appJs.includes('async function musicTogether(') && appJs.includes('id="mus-vis"') && appJs.includes('musVisSet'),
  'pkg3-92: кнопки «🎧 вместе» нет — видимость «слушаю» включает тумблер, писем он не шлёт');
ok(appJs.includes('async function openMusicOf(') && appJs.includes('data-mus-of'),
  'у чужого аватара — кнопка «🎵 музыка»: окно публичных списков, только чтение');
ok(appJs.includes('function musicStatusKick(') && appJs.includes("kind: 'music'") && appJs.includes("kind: 'music-off'"),
  'плеер сам ставит и снимает статус «🎵 слушает» на play/pause');
ok(appJs.includes('function musicStatusNote(') && appJs.includes('const pub = !!pl'),
  'название трека уходит в статус ТОЛЬКО из публичного плейлиста');
ok(appJs.includes('function musicLine(') && appJs.includes('🎵 слушает'),
  'шапка и список участников показывают «🎵 слушает»');
ok(css.includes('.mus-of-tr'), 'окно чужой музыки оформлено');

console.log('\n  итог: ' + good + ' ✓, ' + bad + ' провалов');
process.exit(bad ? 1 : 0);
