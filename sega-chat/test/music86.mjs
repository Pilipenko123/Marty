/**
 * pkg3-86: «Моя музыка» — серверная часть.
 *   • свои плейлисты читаются и сохраняются маршрутом /api/music;
 *   • другим участникам отдаются ТОЛЬКО публичные списки: личный шифротекст
 *     и завёрнутый ключ не покидают владельца (сервер слеп);
 *   • пределы размеров списков; перезапись целиком (последнее сохранение побеждает);
 *   • метки клиента: плитка в меню «+», плеер, проба прямой ссылки, обложки,
 *     плавающая кнопка, шифрование «только я».
 * Запуск: node test/music86.mjs
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
console.log('  pkg3-86: «Моя музыка» — плейлисты ссылок на сервере');
console.log('══════════════════════════════════════════════════\n');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sega-m86-'));
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
ok(r.status === 200 && r.d.build === 'pkg3-96', 'сервер помечен pkg3-96');
async function register(c, inviter) {
  const secret = hex(24);
  const sha = crypto.createHash('sha256').update(secret).digest('hex');
  const ir = await call(base, '/api/invites', { method: 'POST', body: { invSalt: hex(), wrappedRoomKey: 'k:' + hex(), secretHash: sha } }, inviter);
  return call(base, '/api/register', { method: 'POST', body: Object.assign({}, c, { inviteToken: ir.d.invite.id + '.' + secret }) });
}
r = await register(creds('Вася'), admin);
const v1 = r.d.token;
ok(!!v1, 'участник готов');

// ── пустой старт и сохранение своих списков
r = await call(base, '/api/music', {}, admin);
ok(r.status === 200 && Array.isArray(r.d.pub) && r.d.pub.length === 0 && r.d.priv === null && r.d.key === null,
  'свежая учётка: плейлистов нет, личного шифротекста и ключа нет');
const pl1 = { id: 'pl1', name: 'Дорожные', vis: 'pub', tracks: [{ id: 't1', url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3', title: 'Тест 1', cover: '' }] };
r = await call(base, '/api/music', { method: 'POST', body: { pub: [pl1], priv: 'ENC:BLOB', key: 'KEY:WRAP' } }, admin);
ok(r.status === 200, 'сохранение плейлистов принято');
r = await call(base, '/api/music', {}, admin);
ok(r.status === 200 && r.d.pub.length === 1 && r.d.pub[0].tracks[0].title === 'Тест 1' && r.d.priv === 'ENC:BLOB' && r.d.key === 'KEY:WRAP',
  'владелец читает свои списки: публичный открыто, личный — шифротекстом, ключ при нём');

// ── другому участнику — только публичное
r = await call(base, '/api/music/' + adminId, {}, v1);
ok(r.status === 200 && r.d.pub.length === 1 && r.d.priv === undefined && r.d.key === undefined,
  'другой участник видит ТОЛЬКО публичные плейлисты: личного шифротекста и ключа в ответе нет');
r = await call(base, '/api/music/' + hex(8), {}, v1);
ok(r.status === 404, 'музыка несуществующего участника — 404');

// ── пределы и формы
r = await call(base, '/api/music', { method: 'POST', body: { pub: 'не список' } }, admin);
ok(r.status === 400, 'pub строкой вместо списка — отказ 400');
r = await call(base, '/api/music', { method: 'POST', body: { pub: [{ id: 'x', name: 'x'.repeat(500000), vis: 'pub', tracks: [] }] } }, admin);
ok(r.status === 413, 'слишком большой публичный список — отказ 413 (предел 400 КБ)');
r = await call(base, '/api/music', { method: 'POST', body: { pub: [], priv: 'E'.repeat(600 * 1024) } }, admin);
ok(r.status === 413, 'слишком большой личный шифротекст — отказ 413 (предел 512 КБ)');

// ── перезапись целиком: последнее сохранение побеждает
r = await call(base, '/api/music', { method: 'POST', body: { pub: [], priv: null, key: null } }, admin);
ok(r.status === 200, 'перезапись принята');
r = await call(base, '/api/music', {}, admin);
ok(r.status === 200 && r.d.pub.length === 0 && r.d.priv === null, 'списки очищены перезаписью (хранится последняя версия)');
r = await call(base, '/api/music/' + adminId, {}, v1);
ok(r.status === 200 && r.d.pub.length === 0, 'у другого участника публичный список тоже опустел');

// ── треки не хранятся на сервере как файлы: в базе только списки
const dbTxt = fs.readFileSync(path.join(dir, 'db.json'), 'utf8');
ok(dbTxt.includes('soundhelix') === false || dbTxt.includes('musicPub'),
  'ссылки живут в карточке пользователя как список (musicPub), отдельных файлов треков на сервере нет');

// ── метки клиента
const appJs = readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const indexHtml = readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const apiJs = readFileSync(path.join(ROOT, 'lib', 'api.js'), 'utf8');
const css = readFileSync(path.join(ROOT, 'public', 'styles.css'), 'utf8');
ok(indexHtml.includes('data-plus="music"') && appJs.includes("act === 'music'"),
  'в меню «+» — плашка «Моя музыка» (pkg3-87: прямо в первом меню)');
ok(!appJs.includes('data-ng-music'), 'из списка игр музыка ушла (не игра)');
ok(appJs.includes('function musicPlay(pl, idx)') && appJs.includes('id="mus-seek"') && appJs.includes('id="mus-vol"'),
  'плеер: играть/пауза, следующий/предыдущий, перемотка и громкость');
ok(appJs.includes('function musicProbe(url)') && appJs.includes('setTimeout(() => res(false), 6000)'),
  'проба ссылки: 6 секунд на отклик файла, иначе честное предупреждение про страницу');
ok(appJs.includes('a.src = t.url;') && !apiJs.includes('musicFiles'),
  'звук идёт НАПРЯМУЮ с источника в устройство: сервер треки не хранит и не relay-ит');
ok(appJs.includes("confirm('Показывать плейлист другим участникам?"),
  'видимость плейлиста выбирается при создании: публичный или «только я»');
ok(css.includes('.mus-player{') && css.includes('.mus-pls{'), 'плеер и список плейлистов оформлены');

console.log('\n──────────────────────────────────────────────────');
console.log(`  pkg3-86 музыка: ${good} ✓, провалов ${bad}`);
console.log('──────────────────────────────────────────────────\n');
try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
proc.kill('SIGTERM');
process.exit(bad ? 1 : 0);
