// test/ui125.mjs — pkg3-125: проводник «как в Windows», папки в чат с правами,
// свободное место, превью фото/видео, окно «Моя музыка» по чужой ссылке и
// список тех, кто слушает вместе с вами.
//
// Проверяем не только слова в исходниках: поднимаем живой сервер с игрушечным
// Яндекс.Диском и правда открываем папку «на чтение» и «на изменение», пробуем
// из неё выйти, а потом смотрим, кто присоединился к прослушиванию.
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
console.log('  pkg3-125: проводник как в Windows, папки в чат');
console.log('            с правами, место на диске, превью, синхрон');
console.log('══════════════════════════════════════════════════\n');

// ─────────────── игрушечный Яндекс.Диск ───────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sega-m125-'));
const keysPath = path.join(dir, 'yandex-oauth.json');
fs.writeFileSync(keysPath, JSON.stringify({ client_id: 'ID125', client_secret: 'SECRET125' }));

const PHOTO_ITEMS = [
  { name: 'beach.jpg', path: 'disk:/Фото/beach.jpg', type: 'file', size: 204800, mime_type: 'image/jpeg', media_type: 'image', preview: 'https://downloader.disk.yandex.ru/preview/beach' },
  { name: 'clip.mp4', path: 'disk:/Фото/clip.mp4', type: 'file', size: 9437184, mime_type: 'video/mp4', media_type: 'video', preview: 'https://downloader.disk.yandex.ru/preview/clip' }
];
const ROOT_ITEMS = [{ name: 'Фото', path: 'disk:/Фото', type: 'dir' }];

const mock = http.createServer((rq, rs) => {
  const u = new URL(rq.url, 'http://mock');
  const jsend = (code, obj) => { rs.writeHead(code, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify(obj)); };
  if (u.pathname === '/v1/disk/') {
    return jsend(200, { total_space: 20 * 1024 ** 3, used_space: 7 * 1024 ** 3 });
  }
  if (rq.method === 'GET' && u.pathname === '/v1/disk/resources/files') {
    return jsend(200, { items: [] });
  }
  if (rq.method === 'GET' && u.pathname === '/v1/disk/resources') {
    const p = String(u.searchParams.get('path') || 'disk:/');
    const items = p === 'disk:/' ? ROOT_ITEMS : p === 'disk:/Фото' ? PHOTO_ITEMS : [];
    return jsend(200, { path: p, type: 'dir', _embedded: { items, total: items.length } });
  }
  if (rq.method === 'PUT' && u.pathname === '/v1/disk/resources') return jsend(201, {});
  if (rq.method === 'DELETE' && u.pathname === '/v1/disk/resources') { rs.writeHead(204); return rs.end(); }
  if (rq.method === 'POST' && u.pathname === '/v1/disk/resources/move') return jsend(201, {});
  if (rq.method === 'GET' && u.pathname === '/v1/disk/resources/upload') {
    return jsend(200, { href: 'https://uploader.disk.yandex.ru/put/abc?sign=125', method: 'PUT' });
  }
  if (rq.method === 'GET' && u.pathname === '/v1/disk/resources/download') {
    const p = String(u.searchParams.get('path') || '');
    return jsend(200, { href: 'https://mock-cdn.yandex.net/get/' + encodeURIComponent(p) + '?sig=125', ttl: '1800' });
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

let r = await call('/api/setup', { method: 'POST', body: Object.assign({}, creds('Владелец'), { codeProofSalt: hex(), codeProof: hex(32), codeSalt: hex(), wrappedKeyByCode: 'k:' + hex() }) });
ok(r.status === 200, 'мессенджер настроен');
const admin = r.d.token;
const join = async (name) => {
  const secret = hex(24);
  const sha = crypto.createHash('sha256').update(secret).digest('hex');
  const ir = await call('/api/invites', { method: 'POST', body: { invSalt: hex(), wrappedRoomKey: 'k:' + hex(), secretHash: sha } }, admin);
  const rr = await call('/api/register', { method: 'POST', body: Object.assign({}, creds(name), { inviteToken: ir.d.invite.id + '.' + secret }) });
  return { token: rr.d.token, id: rr.d.user.id };
};
const A = await join('Вася');    // владелец Диска
const B = await join('Клава');   // в общем чате с Васей
const C = await join('Гость');   // посторонний
r = await call('/api/dm', { method: 'POST', body: { peer: B.id } }, A.token);
ok(r.status === 200, 'личный чат Вася↔Клава создан');
await call('/api/yadisk/token', { method: 'POST', body: { token: 'y0_AgAAAAB125token-with-dots_and-dashes' } }, A.token);

console.log('\n  1. Сколько свободного места на диске');
r = await call('/api/yadisk/space', {}, A.token);
ok(r.status === 200 && r.d.total > 0, 'место на Диске спрашивается у Яндекса');
ok(r.d.free === r.d.total - r.d.used, '«свободно» = всего минус занято (13 ГБ из 20 ГБ)');
r = await call('/api/yadisk/list?path=' + encodeURIComponent('disk:/'), {}, A.token);
ok(r.status === 200 && r.d.space && r.d.space.total > 0, 'место приходит вместе со списком папки — лишний запрос не нужен');
r = await call('/api/yadisk/space', {}, B.token);
ok(r.status === 409, 'у кого Диск не подключён — честный отказ, а не пустые нули');

console.log('\n  2. Превью фото и видео видно сразу');
r = await call('/api/yadisk/list?path=' + encodeURIComponent('disk:/Фото'), {}, A.token);
ok(r.status === 200 && r.d.items.length === 2, 'папка с фото прочитана');
ok(r.d.items.every(x => typeof x.preview === 'string' && x.preview.startsWith('https://')), 'у фото и видео есть готовая картинка-превью');
ok(r.d.items.some(x => x.media === 'video' && x.preview), 'у видео превью — кадр из ролика (плюс значок ▶ в окне)');
const mockBad = 'javascript:alert(1)';
const yd = await import(path.join(ROOT, 'lib/yadisk.js'));
ok(yd.safeYandexUrl('https://downloader.disk.yandex.ru/preview/x') !== '', 'ссылки Яндекса пропускаются');
ok(yd.safeYandexUrl(mockBad) === '' && yd.safeYandexUrl('https://зло.example/x') === '', 'чужие и опасные ссылки отбрасываются (не SSRF)');

console.log('\n  3. Папка «в чат»: только чтение');
r = await call('/api/yadisk/share-file', { method: 'POST', body: { path: 'disk:/Фото', name: 'Фото', kind: 'folder', perm: 'read' } }, A.token);
ok(r.status === 200, 'папку можно открыть участникам чата (а не только файл)');
r = await call('/api/yadisk/shared-list?of=' + A.id + '&path=' + encodeURIComponent('disk:/Фото'), {}, B.token);
ok(r.status === 200 && Array.isArray(r.d.items) && r.d.items.length === 2, 'Клава видит содержимое открытой ей папки');
ok(r.d.perm === 'read' && r.d.root === 'disk:/Фото', 'окно знает право («только чтение») и корень папки');
r = await call('/api/yadisk/file?of=' + A.id + '&path=' + encodeURIComponent('disk:/Фото'), {}, B.token);
ok(r.status === 200 && r.d.dir === true && r.d.perm === 'read', 'карточка папки в переписке открывает её, а не скачивает');
r = await call('/api/yadisk/file?of=' + A.id + '&path=' + encodeURIComponent('disk:/Фото/beach.jpg'), {}, B.token);
ok(r.status === 200 && String(r.d.href || '').includes('yandex.net'), 'файл внутри открытой папки открывается свежей ссылкой');
r = await call('/api/yadisk/op', { method: 'POST', body: { op: 'mkdir', of: A.id, path: 'disk:/Фото/Новая папка' } }, B.token);
ok(r.status === 403, 'при чтении создать папку нельзя — отказ понятный');
r = await call('/api/yadisk/upload-url?of=' + A.id + '&path=' + encodeURIComponent('disk:/Фото/new.jpg'), {}, B.token);
ok(r.status === 403, 'при чтении и загружать нельзя');

console.log('\n  4. Папка «в чат»: можно менять содержимое');
r = await call('/api/yadisk/share-file', { method: 'POST', body: { path: 'disk:/Фото', name: 'Фото', kind: 'folder', perm: 'write' } }, A.token);
ok(r.status === 200, 'право можно поднять до «менять содержимое»');
r = await call('/api/yadisk/op', { method: 'POST', body: { op: 'mkdir', of: A.id, path: 'disk:/Фото/Новая папка' } }, B.token);
ok(r.status === 200, 'Клава создаёт папку ВНУТРИ открытой ей папки');
r = await call('/api/yadisk/op', { method: 'POST', body: { op: 'rename', of: A.id, path: 'disk:/Фото/Новая папка', to: 'disk:/Фото/Другая' } }, B.token);
ok(r.status === 200, 'переименование внутри папки проходит');
r = await call('/api/yadisk/op', { method: 'POST', body: { op: 'del', of: A.id, path: 'disk:/Фото/Другая' } }, B.token);
ok(r.status === 200, 'удаление внутри папки проходит (файл уходит в корзину Диска)');
r = await call('/api/yadisk/op', { method: 'POST', body: { op: 'del', of: A.id, path: 'disk:/Фото' } }, B.token);
ok(r.status === 403, 'саму открытую папку удалить нельзя');
r = await call('/api/yadisk/op', { method: 'POST', body: { op: 'mkdir', of: A.id, path: 'disk:/Чужое' } }, B.token);
ok(r.status === 403 || r.status === 404, 'за пределы открытой папки не выйти');
r = await call('/api/yadisk/op', { method: 'POST', body: { op: 'rename', of: A.id, path: 'disk:/Фото/beach.jpg', to: 'disk:/украдено.jpg' } }, B.token);
ok(r.status === 403, 'перенести файл из открытой папки наружу нельзя');
r = await call('/api/yadisk/op', { method: 'POST', body: { op: 'mkdir', of: A.id, path: 'disk:/Фото/../Секрет' } }, B.token);
ok(r.status === 403 || r.status === 400, 'через «..» из папки тоже не выбраться');
r = await call('/api/yadisk/shared-list?of=' + A.id + '&path=' + encodeURIComponent('disk:/Фото'), {}, C.token);
ok(r.status === 404, 'посторонний (не из чата) папку не видит');
r = await call('/api/yadisk/upload-url?of=' + A.id + '&path=' + encodeURIComponent('disk:/Фото/new.jpg'), {}, B.token);
ok(r.status === 200 && String(r.d.href || '').includes('yandex') && r.d.method === 'PUT', 'загрузка идёт по ссылке Яндекса — файл не течёт через VPS');

console.log('\n  5. Синхронное прослушивание: видно, кто присоединился');
r = await call('/api/music/follow', { method: 'POST', body: { owner: A.id, on: true } }, B.token);
ok(r.status === 200, 'Клава отмечается «слушаю вместе с Васей»');
r = await call('/api/music/followers', {}, A.token);
ok(r.status === 200 && Array.isArray(r.d.followers) && r.d.followers.length === 1, 'Вася видит список присоединившихся');
ok(r.d.followers[0].uid === B.id && r.d.followers[0].name === 'Клава', 'видно ИМЯ, а не просто «кто-то слушает»');
r = await call('/api/music/followers', {}, B.token);
ok(r.status === 200 && r.d.followers.length === 0, 'у самой Клавы список пуст — она догоняет, а не ведёт');
r = await call('/api/music/follow', { method: 'POST', body: { owner: A.id, on: false } }, B.token);
r = await call('/api/music/followers', {}, A.token);
ok(r.status === 200 && r.d.followers.length === 0, 'пауза/перемотка/закрытое окно — присоединившийся пропадает из списка');
r = await call('/api/music/follow', { method: 'POST', body: { owner: A.id, on: true } }, C.token);
ok(r.status === 404, 'посторонний к чужому прослушиванию не подключается');

console.log('\n  6. Клиент: окно-проводник и плеер');
const appJs = read('public/app.js');
const css = read('public/styles.css');
ok(/addEventListener\('dblclick'[\s\S]{0,300}data-dsk-i/.test(appJs) && /function diskOpenItem/.test(appJs), 'двойной клик по строке открывает папку или файл, как в проводнике');
ok(/data-dsk-act="open"/.test(appJs) && /data-dsk-act="share"/.test(appJs) && /data-dsk-act="dl"/.test(appJs), 'на панели есть «Открыть», «Поделиться», «Скачать»');
ok(/data-dsk-act="mkdir"/.test(appJs) && /data-dsk-act="upload"/.test(appJs) && /data-dsk-act="rename"/.test(appJs) && /data-dsk-act="del"/.test(appJs), 'и «Новая папка», «Загрузить», «Переименовать», «Удалить»');
ok(/Поделиться/.test(appJs) && !/В чат<\/button>/.test(appJs), 'кнопка «В чат» переименована в «Поделиться»');
ok(/Свободно \$\{dkSize\(st\.space\.free\)\} из/.test(appJs) && /dsk-space/.test(css), 'в окне видна строка «Свободно … из …»');
ok(/disk-thumb/.test(appJs) && /loading="lazy"/.test(appJs) && /disk-thumb-play/.test(appJs) && /\.disk-thumb\{/.test(css), 'превью фото и видео — сразу сеткой картинок, у видео значок ▶');
ok(/kind: it\.dir \? 'folder' : 'file'/.test(appJs) && /name="dkperm"/.test(appJs), 'окно «Поделиться» спрашивает чат и, для папки, право');
ok(/musicPlayOnce\(r\.href/.test(appJs) && /openMusic\(\);   \/\/ pkg3-125: трек по чужой ссылке/.test(appJs), 'трек по чужой ссылке играет в окне «Моя музыка»');
ok(/musSyncPanelHtml/.test(appJs) && /Синхронно с «/.test(appJs), 'у догоняющего вместо плейлиста — «Синхронно с «имя»» и текущий трек');
ok(/musFollowersPoll/.test(appJs) && /Слушают вместе с вами/.test(appJs), 'в плеере владельца видно, кто слушает вместе');
ok(/musRerenderIfOpen/.test(appJs) && /musStopFollow\(true\);\s+\/\/ «Слушаю с …» тоже заканчивается тихо/.test(appJs), 'закрытие окна музыки снимает синхрон');
ok(/\/api\/music\/follow/.test(appJs) && /on: false/.test(appJs), 'уход из синхрона сообщается серверу — владелец видит уход');

console.log('\n  6б. Путь на Диске (беда 125-го: пустое окно и «Неверный путь»)');
const normSrc = (/function dkNorm\(p\) \{[\s\S]*?\n\}/.exec(appJs) || [''])[0];
let dkNorm = null;
try { dkNorm = new Function(normSrc + '; return dkNorm;')(); } catch (e) { dkNorm = null; }
ok(!!dkNorm && dkNorm('disk:/') === 'disk:/', 'корень «disk:/» больше не превращается в «disk:»');
ok(!!dkNorm && dkNorm('disk:') === 'disk:/' && dkNorm('') === 'disk:/', 'пустой путь и «disk:» читаются как корень');
ok(!!dkNorm && dkNorm('disk:/Фото/') === 'disk:/Фото' && dkNorm('disk://Фото//x') === 'disk:/Фото/x', 'двойные и хвостовые косые убираются');
ok(/st\.path = dkNorm\(path\)/.test(appJs) && /replace\(\/\^\(disk\|google\):\\\//.test(appJs) && /function dkParent/.test(appJs), 'проводник и хлебные крошки живут по одному правилу пути');
ok(/\.dsk \.dsk-tools \.mini\{width:auto/.test(css), '«Открыть» не растягивается на всю ширину панели');

console.log('\n  7. Отметки выпуска');
const b2 = (/const BUILD = '([^']+)'/.exec(appJs) || [])[1];
const cache = (/const STATIC_CACHE = '([^']+)'/.exec(read('public/sw.js')) || [])[1];
ok(b2 === BUILD, `отметка выпуска в клиенте и в тестах одна (${BUILD})`);
ok(((/const BUILD = '([^']+)'/.exec(read('lib/api.js')) || [])[1]) === BUILD, 'BUILD в lib/api.js тот же');
ok(/\| pkg3-125 \|/.test(read('README.md')), `в журнале README есть строка ${BUILD}`);
ok(cache === 'sega-static-v129', `кэш оформления поднят (${cache}) — устройства получат новые окна`);
ok(read('package.json').includes('node test/ui125.mjs'), 'тест ui125 включён в цепочку npm test');

console.log(`\n  ИТОГ: ${good} ✓, ${bad ? bad + ' провалов' : 'провалов нет'}\n`);
process.exit(bad ? 1 : 0);   // тест держит живой сервер и игрушечный Яндекс — выходим сами
