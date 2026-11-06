// test/ui130.mjs — pkg3-141: папка с Диска скачивается одним архивом ZIP.
//
// Проверяем не «на слово», а по-настоящему: скачиваем архив с живого сервера,
// сами разбираем ZIP (центральный каталог → куски → распаковка) и сверяем байты
// с тем, что лежит на игрушечном Диске. Плюс: имена с кириллицей и вложенными
// папками, пустая папка, чужая папка без «Поделиться», подделанная ссылка,
// документы Google (их нельзя скачать файлом — они попадают в «что-не-вошло»).
import { BUILD } from './build.mjs';
import { crc32, safeEntryName, isCompressible } from '../lib/zip.js';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let good = 0, bad = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ПРОВАЛ: ') + m); if (c) good++; else bad++; };
const hex = (n = 16) => crypto.randomBytes(n).toString('hex');
const wait = ms => new Promise(r => setTimeout(r, ms));

console.log('\n══════════════════════════════════════════════════');
console.log('  pkg3-141: папка одним архивом (ZIP)');
console.log('══════════════════════════════════════════════════\n');

/* ── 1. Сам писатель архива: без сервера, мелкие правила ────────────────── */
console.log('  1. Писатель архива');
ok(crc32(Buffer.from('123456789')) === 0xCBF43926, 'контрольная сумма совпадает с эталоном (CRC-32 = CBF43926)');
ok(safeEntryName('Фото/отпуск/море.jpg') === 'Фото/отпуск/море.jpg', 'вложенный путь с кириллицей сохраняется как есть');
ok(safeEntryName('../../etc/passwd') === 'etc/passwd', 'выход из папки через «..» не проходит');
ok(safeEntryName('имя\\с_косой.txt') === 'имя-с_косой.txt', 'обратная косая в имени не ломает путь');
ok(safeEntryName('') === '' && safeEntryName('..') === '', 'пустое имя и «..» отбрасываются');
ok(isCompressible('трек.mp3') === false && isCompressible('клип.mp4') === false, 'музыку и видео не сжимаем зря — они уже сжаты');
ok(isCompressible('заметки.txt') === true, 'а текст сжимаем');

/* ── 2. Живой сервер на игрушечных Дисках ──────────────────────────────── */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sega-m130-'));
const dataDir = path.join(dir, 'data');
const keysPath = path.join(dir, 'google-oauth.json');
fs.writeFileSync(keysPath, JSON.stringify({ client_id: 'cid130.apps.googleusercontent.com', client_secret: 'sec130' }));
const YD_TOK = 'y0_AgAAAAB130token-folder-zip';

const MP3A = Buffer.from('MP3-A-первый файл '.repeat(40));
const MP3B = Buffer.from('MP3-B-второй файл '.repeat(40));
const MP3C = Buffer.from('MP3-C-в-подпапке '.repeat(40));
const TXT = Buffer.from('заметки: это текст, он должен сжаться\n'.repeat(50), 'utf8');
const GBYTES = Buffer.from('SOUND-google-file-130 '.repeat(20));

// дерево игрушечного Яндекса
const YD = [
  { path: 'disk:/Музыка', type: 'dir' },
  { path: 'disk:/Музыка/a.mp3', type: 'file', size: MP3A.length, mime: 'audio/mpeg', media: 'audio', body: MP3A },
  { path: 'disk:/Музыка/b.mp3', type: 'file', size: MP3B.length, mime: 'audio/mpeg', media: 'audio', body: MP3B },
  { path: 'disk:/Музыка/заметки.txt', type: 'file', size: TXT.length, mime: 'text/plain', body: TXT },
  { path: 'disk:/Музыка/Альбом', type: 'dir' },
  { path: 'disk:/Музыка/Альбом/c.mp3', type: 'file', size: MP3C.length, mime: 'audio/mpeg', media: 'audio', body: MP3C },
  { path: 'disk:/Музыка/Пустая папка', type: 'dir' },
  { path: 'disk:/Пусто', type: 'dir' },
  { path: 'disk:/Секрет', type: 'dir' },
  { path: 'disk:/Секрет/тайна.txt', type: 'file', size: 5, mime: 'text/plain', body: Buffer.from('тайна') }
];
const G_FILES = [
  { id: 'gf130a', name: 'g-трек.mp3', mimeType: 'audio/mpeg', size: String(GBYTES.length), parents: ['root'], body: GBYTES },
  { id: 'gf130doc', name: 'Мой документ', mimeType: 'application/vnd.google-apps.document', parents: ['root'] }
];

const ydItem = x => ({
  name: x.path.split('/').pop(), path: x.path, type: x.type,
  size: x.type === 'dir' ? 0 : x.size,
  mime_type: x.type === 'dir' ? 'application/vnd.yandex-folders' : x.mime,
  media_type: x.media, modified: '2026-11-05T00:00:00Z', preview: '', md5: 'x', resource_id: 'r'
});

const mock = http.createServer((rq, rs) => {
  const u = new URL(rq.url, 'http://mock');
  const chunks = [];
  rq.on('data', c => chunks.push(c));
  rq.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let form = null;
    if (raw && !raw.startsWith('{')) { form = {}; for (const [k, v] of new URLSearchParams(raw)) form[k] = v; }
    else { try { form = raw ? JSON.parse(raw) : null; } catch (e) { form = null; } }
    const jsend = (code, obj) => { rs.writeHead(code, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify(obj)); };
    const auth = String(rq.headers.authorization || '');
    const token = auth.replace(/^(OAuth|Bearer)\s+/i, '');

    // байты файла «с Диска»
    if (u.pathname.startsWith('/get/')) {
      const p = 'disk:/' + decodeURIComponent(u.pathname.slice(5));
      const f = YD.find(x => x.path === p && x.type === 'file');
      if (!f) { rs.writeHead(404); return rs.end('нет'); }
      rs.writeHead(200, { 'Content-Type': f.mime, 'Content-Length': String(f.body.length) });
      return rs.end(f.body);
    }
    if (u.pathname === '/v1/disk/resources' && rq.method === 'GET') {
      if (token !== YD_TOK) return jsend(401, { message: 'нет токена' });
      const p = String(u.searchParams.get('path') || 'disk:/');
      const limit = Number(u.searchParams.get('limit') || 200);
      const offset = Number(u.searchParams.get('offset') || 0);
      const inside = x => x.path.startsWith(p === 'disk:/' ? 'disk:/' : p + '/') && x.path !== p
        && (x.path.slice(p === 'disk:/' ? 6 : p.length + 1).indexOf('/') === -1);
      const all = YD.filter(inside);
      const page = all.slice(offset, offset + limit);
      return jsend(200, {
        name: p.split('/').pop(), path: p, type: 'dir',
        _embedded: { path: p, items: page.map(ydItem), limit, offset, total: all.length }
      });
    }
    if (u.pathname === '/v1/disk/resources/files') {
      if (token !== YD_TOK) return jsend(401, { message: 'нет токена' });
      return jsend(200, { items: YD.filter(x => x.type === 'file').map(ydItem), limit: 200, offset: 0 });
    }
    if (u.pathname === '/v1/disk/resources/download') {
      if (token !== YD_TOK) return jsend(401, { message: 'нет токена' });
      const p = String(u.searchParams.get('path') || '');
      const f = YD.find(x => x.path === p && x.type === 'file');
      if (!f) return jsend(404, { message: 'не найдено', error: 'DiskNotFoundError' });
      return jsend(200, { href: mockBase + '/get/' + encodeURIComponent(p.split('/').slice(1).join('/')), method: 'GET', ttl: 300 });
    }
    if (u.pathname === '/v1/disk' || u.pathname === '/v1/disk/') {
      if (token !== YD_TOK) return jsend(401, { message: 'нет токена' });
      return jsend(200, { total_space: 1000, used_space: 10, trash_size: 0 });
    }
    // ── Google ──
    if (rq.method === 'POST' && u.pathname === '/token') {
      return jsend(200, { access_token: 'gtok130', refresh_token: 'rt130', expires_in: 3600, scope: 'https://www.googleapis.com/auth/drive' });
    }
    if (u.pathname === '/drive/v3/about') return jsend(200, { storageQuota: { limit: '1000', usage: '1' } });
    if (rq.method === 'GET' && u.pathname === '/drive/v3/files') {
      const q = String(u.searchParams.get('q') || '');
      const m = /'([^']+)' in parents/.exec(q);
      const list = (m && m[1] === 'root') ? G_FILES : G_FILES;
      return jsend(200, { files: list.map(f => ({ id: f.id, name: f.name, mimeType: f.mimeType, size: f.size, parents: f.parents })), nextPageToken: '' });
    }
    const fm = /^\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname);
    if (fm) {
      const f = G_FILES.find(x => x.id === fm[1]);
      if (!f) return jsend(404, { error: { message: 'нет' } });
      if (u.searchParams.get('alt') === 'media') {
        rs.writeHead(200, { 'Content-Type': f.mimeType, 'Content-Length': String(f.body.length) });
        return rs.end(f.body);
      }
      return jsend(200, { id: f.id, name: f.name, mimeType: f.mimeType, size: f.size, parents: ['root'] });
    }
    jsend(404, { error: { message: 'не найдено' } });
  });
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
const base = 'http://127.0.0.1:' + port;
const proc = spawn(process.execPath, ['server.js'], {
  cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
  env: Object.assign({}, process.env, {
    STORE: 'file', DATA_DIR: dataDir, HOST: '127.0.0.1', HTTPS: '', PRESENCE_EVERY: '0',
    NEW_INVITE_DELAY: '0', INVITE_COOLDOWN_MS: '0', PORT: String(port),
    YADISK_OAUTH_BASE: mockBase, YADISK_API_BASE: mockBase, YADISK_CDN_BASE: mockBase,
    GDRIVE_AUTH_BASE: mockBase, GDRIVE_TOKEN_BASE: mockBase, GDRIVE_API_BASE: mockBase,
    GDRIVE_KEYS: keysPath, GDRIVE_REDIRECT: base + '/api/gdrive/callback'
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
const join = async (name) => {
  const secret = hex(24);
  const sha = crypto.createHash('sha256').update(secret).digest('hex');
  const ir = await call('/api/invites', { method: 'POST', body: { invSalt: hex(), wrappedRoomKey: 'k:' + hex(), secretHash: sha } }, admin);
  const rr = await call('/api/register', { method: 'POST', body: Object.assign({}, creds(name), { inviteToken: ir.d.invite.id + '.' + secret }) });
  return { token: rr.d.token, id: rr.d.user.id };
};
const A = await join('Вася');
const K = await join('Клава');
await call('/api/dm', { method: 'POST', body: { peer: K.id } }, A.token);
r = await call('/api/yadisk/token', { method: 'POST', body: { token: YD_TOK, slot: 1 } }, A.token);
ok(r.status === 200, 'Яндекс-Диск подключён к стенду');

/* ── 3. Мини-распаковщик ZIP: читаем то, что реально отдал сервер ──────── */
function unzip(buf) {
  // ищем «конец центрального каталога» с хвоста
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('это не ZIP: нет конца каталога');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOff = buf.readUInt32LE(eocd + 16);
  const out = [];
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('испорчен центральный каталог');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    // локальный заголовок: имя может быть другой длины в хвосте — считаем по нему
    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error('нет локального заголовка: ' + name);
    const lnLen = buf.readUInt16LE(localOff + 26);
    const leLen = buf.readUInt16LE(localOff + 28);
    const dataOff = localOff + 30 + lnLen + leLen;
    const rawData = buf.slice(dataOff, dataOff + csize);
    let data = Buffer.alloc(0);
    if (method === 0) data = rawData;
    else if (method === 8) data = zlib.inflateRawSync(rawData);
    else throw new Error('неизвестный способ сжатия: ' + method);
    out.push({
      name, method, flags, crc, csize, usize, data,
      crcOk: crc32(data) === crc && data.length === usize,
      utf8: !!(flags & 0x0800)
    });
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}
async function fetchZip(url) {
  const res = await fetch(base + url);
  const buf = Buffer.from(await res.arrayBuffer());
  return { res, buf };
}

/* ── 4. Своя папка: считаем, потом качаем ────────────────────────────── */
console.log('\n  2. Своя папка: «сколько и чего»');
r = await call('/api/yadisk/folder-zip?path=' + encodeURIComponent('disk:/Музыка'), {}, A.token);
ok(r.status === 200, 'сервер посчитал папку');
ok(r.d.files === 4, `в папке 4 файла (${r.d.files})`);
ok(r.d.dirs === 2, `и 2 подпапки вместе с пустой (${r.d.dirs})`);
ok(r.d.bytes === MP3A.length + MP3B.length + TXT.length + MP3C.length, 'общий вес сложен из самих файлов');
ok(r.d.name === 'Музыка.zip', `архив называется по папке (${r.d.name})`);
ok(typeof r.d.url === 'string' && r.d.url.startsWith('/api/yadisk/zip?t='), 'выдана недолгая ссылка на архив');

console.log('\n  3. Что внутри архива');
const z1 = await fetchZip(r.d.url);
ok(z1.res.status === 200, 'архив скачался (200)');
ok(/^application\/zip/.test(z1.res.headers.get('content-type') || ''), 'тип ответа — application/zip');
const cd1 = z1.res.headers.get('content-disposition') || '';
ok(/filename\*=UTF-8''/.test(cd1) && decodeURIComponent(cd1.split("UTF-8''")[1]) === 'Музыка.zip', 'браузер видит имя «Музыка.zip» (кириллица в UTF-8)');
ok(z1.buf.slice(0, 2).toString() === 'PK', 'это правда ZIP (начинается с PK)');
let files = [];
try { files = unzip(z1.buf); } catch (e) { console.log('   ошибка разбора:', e.message); }
ok(files.length === 6, `записей в каталоге 6 — 4 файла и 2 папки (${files.length})`);
const byName = n => files.find(x => x.name === n) || {};
ok(!!byName('Музыка/a.mp3'), 'файл из папки лежит внутри архива под её именем');
ok(!!byName('Музыка/Альбом/c.mp3'), 'вложенная папка сохранилась');
ok(!!byName('Музыка/Пустая папка/'), 'пустая папка тоже попала в архив');
ok(files.every(x => x.crcOk), 'у каждой записи сходится контрольная сумма и размер');
ok(files.every(x => x.utf8), 'имена помечены как UTF-8 — кириллица не превратится в кракозябры');
ok(byName('Музыка/a.mp3').data.equals(MP3A), 'байты первого файла совпадают до последнего байта');
ok(byName('Музыка/Альбом/c.mp3').data.equals(MP3C), 'и байты файла из подпапки тоже');
ok(byName('Музыка/заметки.txt').data.equals(TXT), 'текстовый файл распаковался без потерь');
ok(byName('Музыка/a.mp3').method === 0, 'музыка уложена без сжатия (она и так сжата)');
ok(byName('Музыка/заметки.txt').method === 8 && byName('Музыка/заметки.txt').csize < TXT.length, 'а текст сжат — архив меньше исходника');

console.log('\n  4. Ссылка и границы');
r = await fetch(base + '/api/yadisk/zip?t=' + encodeURIComponent('подделка.подпись'));
ok(r.status === 403, 'подделанная ссылка не пускает');
r = await call('/api/yadisk/folder-zip?path=' + encodeURIComponent('disk:/Пусто'), {}, A.token);
ok(r.status === 400 && /нет файлов/i.test(r.d.error || ''), 'пустая папка: честный отказ, а не архив на 0 байт');
r = await call('/api/yadisk/folder-zip?path=' + encodeURIComponent('disk:/../../etc'), {}, A.token);
ok(r.status === 400 || r.status === 404, 'путь с «..» не превращается в чужой архив');
r = await call('/api/yadisk/folder-zip?of=' + A.id + '&path=' + encodeURIComponent('disk:/Музыка'), {}, K.token);
ok(r.status === 404, 'чужая папка без «Поделиться» не собирается');
r = await call('/api/yadisk/share-file', { method: 'POST', body: { path: 'disk:/Музыка', name: 'Музыка', kind: 'folder', perm: 'read' } }, A.token);
ok(r.status === 200, 'владелец открыл папку участнице');
r = await call('/api/yadisk/folder-zip?path=' + encodeURIComponent('disk:/Музыка') + '&of=' + A.id, {}, K.token);
ok(r.status === 200 && r.d.files === 4, 'теперь архив собирается для неё');
const z2 = await fetchZip(r.d.url);
const kFiles = unzip(z2.buf);
ok(kFiles.length === 6 && kFiles.every(x => x.crcOk), 'и архив участницы целый');
r = await call('/api/yadisk/folder-zip?of=' + A.id + '&path=' + encodeURIComponent('disk:/Секрет'), {}, K.token);
ok(r.status === 404, 'а неоткрытую соседнюю папку — нет');

console.log('\n  5. Google-Диск');
async function gconnect(user) {
  const a = await call('/api/gdrive/auth?slot=1', {}, user.token);
  const st = (new URL(a.d.url)).searchParams.get('state');
  const res = await fetch(base + '/api/gdrive/callback?state=' + encodeURIComponent(st) + '&code=g1code');
  return res.text();
}
ok(/Google Диск подключён/.test(await gconnect(A)), 'Google-Диск подключён к стенду');
r = await call('/api/yadisk/folder-zip?path=' + encodeURIComponent('google:/root'), {}, A.token);
ok(r.status === 200 && r.d.files === 1, `в Google-папке 1 скачиваемый файл (${r.d.files})`);
ok(Array.isArray(r.d.skipped) && r.d.skipped.some(x => /документ Google/.test(x.why || '')), 'документ Google честно назван в списке «не вошло»');
const z3 = await fetchZip(r.d.url);
const gFiles = unzip(z3.buf);
const gTrack = gFiles.find(x => /g-трек\.mp3$/.test(x.name)) || {};
ok(!!gTrack.name && gTrack.data.equals(GBYTES), 'файл из Google пришёл в архив байт в байт');
ok(!!gFiles.find(x => /что-не-вошло\.txt$/.test(x.name)), 'в архиве есть записка «что не вошло»');
const note = (gFiles.find(x => /что-не-вошло\.txt$/.test(x.name)) || {}).data;
ok(!!note && /Мой документ/.test(note.toString('utf8')), 'в записке назван документ Google');

/* ── 6. Клиент и отметки выпуска ─────────────────────────────────────── */
console.log('\n  6. Клиент и отметки выпуска');
const appJs = read('public/app.js');
ok(/data-dsk-act="dlfolder"/.test(appJs), 'в проводнике есть кнопка «⬇ Папку»');
ok(/async function diskDownloadFolder\(/.test(appJs) && /\/api\/yadisk\/folder-zip/.test(appJs), 'клиент спрашивает у сервера архив папки');
ok(/if \(it\.dir\) return diskDownloadFolder\(it\.path/.test(appJs), '«Скачать» на папке больше не отговаривается, а собирает архив');
ok(/diskSaveUrl\(r\.url, r\.name/.test(appJs), 'скачивание идёт обычной ссылкой (вход в заголовке тут не нужен)');
ok((/const BUILD = '([^']+)'/.exec(appJs) || [])[1] === BUILD && BUILD === 'pkg3-141', `отметка выпуска одна (${BUILD})`);
ok(((/const BUILD = '([^']+)'/.exec(read('lib/api.js')) || [])[1]) === BUILD, 'BUILD в lib/api.js тот же');
ok((/const STATIC_CACHE = '([^']+)'/.exec(read('public/sw.js')) || [])[1] === 'sega-static-v135', 'кэш оформления поднят до v124');
ok(/\| pkg3-141 \|/.test(read('README.md')), 'в журнале README есть строка pkg3-141');
ok(read('package.json').includes('node test/ui130.mjs'), 'тест ui130 включён в цепочку npm test');
ok(!/require\('(archiver|jszip|adm-zip|yazl)'\)/.test(read('lib/zip.js')), 'архив собирается без новых зависимостей');
ok(/cap: zipLib\.MAX_ZIP/.test(read('lib/api.js')), 'у потока архива свой потолок — сервер не оборвёт его на 300 МБ');
ok(/location \^~ \/api\/yadisk\/zip/.test(read('cloud-vps/setup.sh')) && /proxy_buffering off/.test(read('cloud-vps/setup.sh')),
  'nginx на VPS не копит архив у себя и не рвёт долгую сборку');

console.log(`\n  ИТОГ: ${good} ✓, ${bad ? bad + ' провалов' : 'провалов нет'}\n`);
process.exit(bad ? 1 : 0);
