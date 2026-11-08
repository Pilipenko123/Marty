// test/ui133.mjs — pkg3-146: «Новая папка» и «Переименовать» на Яндекс.Диске.
//
// Жалоба владельца: кнопки активны, а папка не создаётся и ничего не
// переименовывается. Причина — двойная косая в КОРНЕ Диска: клиент склеивал
// «disk:/» + «/» + имя = «disk://Новая папка», а живой Яндекс отвечает на это
// «400 Invalid path». Внутри папок («disk:/Музыка/…») путь был правильный,
// поэтому поломка выглядела странно.
//
// Здесь проверяем обе половины починки:
//   • клиент больше не строит двойную косую (dkJoin);
//   • сервер сам схлопывает лишние косые (старые экраны в кэше браузера
//     продолжают работать) и отправляет Яндексу чистый путь.
// Игрушечный Яндекс придирчив, как настоящий: любой путь с «//» — 400.
import { BUILD } from './build.mjs';
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
console.log('  pkg3-146: создание папки и переименование на Диске');
console.log('══════════════════════════════════════════════════\n');

/* ── 1. Клиент: как он строит путь ─────────────────────────────────────── */
console.log('  1. Клиент собирает путь без двойной косой');
const appJs = read('public/app.js');
const grab = (src, name) => {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) return '';
  let d = 0, j = i;
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (!d) break; } }
  return src.slice(i, j + 1);
};
const fnSrc = ['dkNorm', 'dkJoin', 'dkParent', 'dkRoot', 'drvKindOf', 'drvSlotOf']
  .map(n => grab(appJs, n)).filter(Boolean).join('\n');
let F = null;
try { F = new Function(fnSrc + '; return {dkNorm, dkJoin, dkParent, dkRoot};')(); } catch (e) { F = null; }
const join = (a, b) => (F ? F.dkJoin(a, b) : '—');
ok(!!F, 'правила пути в клиенте читаются');
ok(join('disk:/', 'Новая папка') === 'disk:/Новая папка', `в корне Диска: «${join('disk:/', 'Новая папка')}» — без двойной косой`);
ok(!join('disk:/', 'Новая папка').includes('//'), 'и двойной косой нет вовсе');
ok(join('disk:/Музыка', 'Альбом') === 'disk:/Музыка/Альбом', 'внутри папки путь по-прежнему обычный');
ok(join('disk2:/', 'Второй диск') === 'disk2:/Второй диск', 'у второго Яндекс-Диска тоже');
ok(join('google:/root', 'Папка') === 'google:/root/Папка', 'у Google — свой корень, тоже без косой');
ok(join('disk:/', ' имя ') === 'disk:/имя', 'пробелы по краям имени не мешают');
ok(F && F.dkParent('disk:/файл.mp3') === 'disk:/', 'родитель файла в корне — корень');
ok(join(F.dkParent('disk:/Музыка/файл.mp3'), 'новое.mp3') === 'disk:/Музыка/новое.mp3', 'переименование внутри папки собирается верно');
ok(join(F.dkParent('disk:/файл.mp3'), 'новое.mp3') === 'disk:/новое.mp3', 'и переименование в корне — тоже (это и было сломано)');
ok(/return dkNorm\(base \+ '\/' \+ tail\)/.test(appJs), 'причина закрыта в самом dkJoin, а не заплаткой в одном месте');

/* ── 2. Сервер: путь с лишними косыми приводится к норме ───────────────── */
console.log('\n  2. Сервер прощает лишние косые (старый экран в кэше)');
const yd = await import('../lib/yadisk.js').then(m => m.default || m);
ok(yd.safePath('disk://Новая папка') === 'disk:/Новая папка', '«disk://Новая папка» → «disk:/Новая папка»');
ok(yd.safePath('disk://') === 'disk:/', '«disk://» → корень');
ok(yd.safePath('disk:///a//b') === 'disk:/a/b', 'несколько косых подряд схлопываются');
ok(yd.safePath('disk2://x') === 'disk2:/x', 'у второго диска номер не теряется');
ok(yd.safePath('disk:/Новая папка') === 'disk:/Новая папка', 'нормальный путь не портится');
ok(yd.safePath('http://x') === null && yd.safePath('disk:/../x') === null, 'чужая схема и «..» по-прежнему отбрасываются');

/* ── 3. Живой сервер против придирчивого Яндекса ───────────────────────── */
const TOK = 'y0_AgAAAAB133token-for-root-ops';
const TREE = [
  { path: 'disk:/', type: 'dir' },
  { path: 'disk:/Музыка', type: 'dir' },
  { path: 'disk:/старое.txt', type: 'file', size: 4 },
  { path: 'disk:/Музыка/альбом', type: 'dir' }
];
const seen = [];       // что реально ушло к Яндексу
const badPaths = [];   // пути с двойной косой (их быть не должно)

const mock = http.createServer((rq, rs) => {
  const u = new URL(rq.url, 'http://mock');
  const chunks = [];
  rq.on('data', c => chunks.push(c));
  rq.on('end', () => {
    const jsend = (code, obj) => { rs.writeHead(code, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify(obj)); };
    const given = [];
    for (const k of ['path', 'from', 'to']) {
      const v = u.searchParams.get(k);
      if (v != null) given.push(v);
    }
    for (const g of u.searchParams.keys()) void g;
    // придирчивость живого Яндекса: двойная косая в пути — сразу 400
    for (const p of given) {
      if (p.includes('//')) { badPaths.push(p); return jsend(400, { message: 'Invalid path', error: 'FieldValidationError' }); }
    }
    const p = String(u.searchParams.get('path') || '');

    if (u.pathname === '/v1/disk' || u.pathname === '/v1/disk/') return jsend(200, { total_space: 1000, used_space: 10 });
    if (u.pathname === '/v1/disk/resources/files') return jsend(200, { items: [], limit: 200, offset: 0 });
    if (u.pathname === '/v1/disk/resources' && rq.method === 'GET') {
      const inside = x => x.path !== p && x.path.startsWith(p === 'disk:/' ? 'disk:/' : p + '/')
        && x.path.slice(p === 'disk:/' ? 6 : p.length + 1).indexOf('/') === -1;
      const items = TREE.filter(inside).map(x => ({
        name: x.path.split('/').pop(), path: x.path, type: x.type, size: x.size || 0,
        mime_type: x.type === 'dir' ? 'application/vnd.yandex-folders' : 'text/plain',
        media_type: undefined, modified: '2026-11-05T00:00:00Z', preview: '', md5: 'x', resource_id: 'r'
      }));
      return jsend(200, { name: 'Диск', path: p, type: 'dir', _embedded: { path: p, items, limit: 100, offset: 0, total: items.length } });
    }
    if (u.pathname === '/v1/disk/resources' && rq.method === 'PUT') {
      seen.push({ op: 'mkdir', path: p });
      TREE.push({ path: p, type: 'dir' });
      return jsend(201, { name: p.split('/').pop(), path: p });
    }
    if (u.pathname === '/v1/disk/resources' && rq.method === 'DELETE') {
      seen.push({ op: 'del', path: p });
      const i = TREE.findIndex(x => x.path === p);
      if (i >= 0) TREE.splice(i, 1);
      rs.writeHead(204); return rs.end();
    }
    if (u.pathname === '/v1/disk/resources/move' && rq.method === 'POST') {
      const from = String(u.searchParams.get('from') || '');
      const to = p;
      seen.push({ op: 'move', from, to });
      const it = TREE.find(x => x.path === from);
      if (!it) return jsend(404, { message: 'Resource not found', error: 'DiskNotFoundError' });
      it.path = to;
      return jsend(201, { ok: true });
    }
    if (u.pathname === '/v1/disk/resources/upload') {
      seen.push({ op: 'upload', path: p });
      return jsend(200, { href: 'https://uploader.disk.yandex.ru/x', method: 'PUT', ttl: 300 });
    }
    jsend(404, { message: 'не найдено' });
  });
});
await new Promise(r => mock.listen(0, '127.0.0.1', r));
const mockBase = 'http://127.0.0.1:' + mock.address().port;

async function freePort() {
  const { createServer } = await import('node:net');
  return new Promise(r => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sega-m133-'));
const procs = [];
process.on('exit', () => { for (const p of procs) { try { p.kill('SIGKILL'); } catch (e) {} } try { mock.close(); } catch (e) {} });

const port = await freePort();
const base = 'http://127.0.0.1:' + port;
const proc = spawn(process.execPath, ['server.js'], {
  cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
  env: Object.assign({}, process.env, {
    STORE: 'file', DATA_DIR: path.join(dir, 'data'), HOST: '127.0.0.1', HTTPS: '', PRESENCE_EVERY: '0',
    NEW_INVITE_DELAY: '0', INVITE_COOLDOWN_MS: '0', PORT: String(port),
    YADISK_OAUTH_BASE: mockBase, YADISK_API_BASE: mockBase, YADISK_CDN_BASE: mockBase
  })
});
procs.push(proc);
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
r = await call('/api/yadisk/token', { method: 'POST', body: { token: TOK, slot: 1 } }, admin);
ok(r.status === 200, 'Яндекс-Диск подключён к стенду');

console.log('\n  3. «Новая папка» в корне (то, что не работало)');
r = await call('/api/yadisk/op', { method: 'POST', body: { op: 'mkdir', path: 'disk://Новая папка' } }, admin);
ok(r.status === 200, `папка создаётся даже со старым «двойным» путём (${r.status})`);
ok(r.d && r.d.path === 'disk:/Новая папка', `в ответе чистый путь: «${r.d && r.d.path}»`);
r = await call('/api/yadisk/op', { method: 'POST', body: { op: 'mkdir', path: 'disk:/Вторая папка' } }, admin);
ok(r.status === 200 && r.d.path === 'disk:/Вторая папка', 'и с нормальным путём — тоже');
r = await call('/api/yadisk/op', { method: 'POST', body: { op: 'mkdir', path: 'disk:/Музыка/Альбом 2' } }, admin);
ok(r.status === 200 && r.d.path === 'disk:/Музыка/Альбом 2', 'внутри папки создаётся (тут было цело и раньше)');
ok(seen.some(x => x.op === 'mkdir' && x.path === 'disk:/Новая папка'), 'к Яндексу ушёл путь без двойной косой');
ok(badPaths.length === 0, 'ни один запрос не ушёл с «//» — Яндекс бы его отверг');

console.log('\n  4. «Переименовать» — в корне и в папке');
r = await call('/api/yadisk/op', { method: 'POST', body: { op: 'rename', path: 'disk:/старое.txt', to: 'disk://новое.txt' } }, admin);
ok(r.status === 200, `файл в корне переименовывается (${r.status})`);
ok(r.d && r.d.path === 'disk:/новое.txt', `новый путь в ответе чистый: «${r.d && r.d.path}»`);
const mv1 = seen.filter(x => x.op === 'move').pop() || {};
ok(mv1.from === 'disk:/старое.txt' && mv1.to === 'disk:/новое.txt', 'Яндексу ушли оба пути без двойной косой');
r = await call('/api/yadisk/op', { method: 'POST', body: { op: 'rename', path: 'disk:/Музыка/альбом', to: 'disk:/Музыка/Альбом' } }, admin);
ok(r.status === 200, 'папка внутри переименовывается');
r = await call('/api/yadisk/list?path=' + encodeURIComponent('disk:/'), {}, admin);
ok(r.status === 200 && (r.d.items || []).some(x => x.name === 'Новая папка'), 'созданная папка сразу видна в списке');
ok(badPaths.length === 0, 'и здесь ни одного «//» к Яндексу');

console.log('\n  5. Удаление и загрузка в корень');
r = await call('/api/yadisk/op', { method: 'POST', body: { op: 'del', path: 'disk://Вторая папка' } }, admin);
ok(r.status === 200 && seen.some(x => x.op === 'del' && x.path === 'disk:/Вторая папка'), 'удаление тоже ходит чистым путём');
r = await call('/api/yadisk/upload-url?path=' + encodeURIComponent('disk://Новая папка/файл.txt'), {}, admin);
ok(r.status === 200, 'адрес загрузки выдаётся и для старого «двойного» пути');
ok(seen.some(x => x.op === 'upload' && x.path === 'disk:/Новая папка/файл.txt'), 'загрузка тоже без двойной косой');
ok(badPaths.length === 0, 'за весь прогон ни одного отвергнутого пути');

console.log('\n  6. Отметки выпуска');
ok((/const BUILD = '([^']+)'/.exec(appJs) || [])[1] === BUILD && /^pkg3-1\d\d$/.test(BUILD), `отметка выпуска одна (${BUILD})`);
ok(((/const BUILD = '([^']+)'/.exec(read('lib/api.js')) || [])[1]) === BUILD, 'BUILD в lib/api.js тот же');
ok((/const STATIC_CACHE = '([^']+)'/.exec(read('public/sw.js')) || [])[1] === 'sega-static-v146', 'кэш оформления поднят до v127');
ok(/\| pkg3-146 \|/.test(read('README.md')), 'в журнале README есть строка pkg3-146');
ok(read('package.json').includes('node test/ui133.mjs'), 'тест ui133 включён в цепочку npm test');

console.log(`\n  ИТОГ: ${good} ✓, ${bad ? bad + ' провалов' : 'провалов нет'}\n`);
process.exit(bad ? 1 : 0);
