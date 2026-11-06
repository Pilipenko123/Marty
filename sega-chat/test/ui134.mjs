// test/ui134.mjs — pkg3-135: второй Яндекс-Диск не даёт создавать папки.
//
// Жалоба владельца: «на одном яндекс диске работает создание папок, а на втором
// нет». В 133 починили двойную косую (одна причина), серверную склейку путей
// проверили отдельно — она верна. Значит, второй Диск просто НЕ ДАЁТ ПИСАТЬ, а
// приложение молчало: отказ по правам пряталось за кодом 409 и исчезало
// трёхсекундным тостом.
//
// Здесь два Яндекс-Диска: первому запись разрешена, второму — нет (как в жизни:
// вход выдан «только на чтение» либо аккаунт не разрешает менять файлы). Проверяем:
//   • отказ второго диска приходит кодом 403 и словами «нет права записи», а не
//     «Диск отказал»;
//   • первый диск в том же прогоне продолжает работать — поломки нет;
//   • в отказе видно, о каком диске речь («[Диск 2]»);
//   • к Яндексу уходят токены своих дисков (второй не ходит с первым);
//   • «Проверить запись» создаёт служебную папку и убирает её: на первом диске
//     «разрешено», на втором — «запрещено» с текстом Яндекса;
//   • у клиента отказ показывается окном с кнопкой проверки, а не тостом;
//   • прочие коды Яндекса объясняются по-человечески.
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
console.log('  pkg3-135: второй Яндекс-Диск — права записи');
console.log('══════════════════════════════════════════════════\n');

/* ── 1. Клиент: отказ виден и объяснён ─────────────────────────────────── */
console.log('  1. Клиент: отказ Диска — окном, а не тостом');
const appJs = read('public/app.js');
const css = read('public/styles.css');
ok(/function diskFail\(/.test(appJs), 'есть отдельное окно «Диск не дал …»');
ok(/diskFail\('создать папку'/.test(appJs), 'создание папки на отказе показывает это окно');
ok(/diskFail\('переименовать'/.test(appJs) && /diskFail\('удалить'/.test(appJs), 'переименование и удаление — тоже');
ok(/data-yd-wcheck="\$\{slot\}"/.test(appJs), 'у каждого Яндекс-Диска есть кнопка «Проверить запись»');
ok(/write-check', \{ method: 'POST', body: \{ slot: n \} \}/.test(appJs), 'кнопка вызывает проверку записи на сервере');
ok(/disk-fail-t/.test(appJs) && /\.disk-fail-t\{/.test(css), 'ответ сервера показан читаемым блоком (и в оформлении есть стиль)');
ok(/Проверить запись/.test(appJs) && /driveWriteCheck/.test(appJs), 'из окна отказа можно сразу проверить права');
const grab = (src, name) => {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) return '';
  let d = 0, j = i;
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (!d) break; } }
  return src.slice(i, j + 1);
};
const slotSrc = grab(appJs, 'drvSlotOf');
let slotOk = false;
try { const f = new Function('return (' + slotSrc + ')' )(); slotOk = f('disk2') === 2 && f('disk') === 1 && f('yandex') === 1; } catch (e) {}
ok(slotOk, 'номер диска из пометки читается верно (disk2 → 2, disk → 1)');

/* ── 2. Сервер: тексты ошибок по-человечески ───────────────────────────── */
console.log('\n  2. Сервер: что именно ответил Диск');
const yd = await import('../lib/yadisk.js').then(m => m.default || m);
const W = s => yd.writeErrorText(s, 'mkdir');
ok(/права записи/.test(W({ status: 403, json: { message: 'Forbidden' } })), '403 → «нет права записи» и что делать');
ok(/права записи/.test(W({ status: 403, json: {} })), 'даже без текста от Яндекса — то же объяснение');
ok(/места/.test(W({ status: 507, json: {} })), '507 → «не осталось свободного места»');
ok(/именем/.test(W({ status: 409, json: {} })), '409 → «уже есть объект с таким именем»');
ok(/занят/.test(W({ status: 423, json: {} })), '423 → «файл занят»');
ok(/не нашёл/.test(W({ status: 404, json: {} })), '404 → «не нашёл эту папку»');
ok(/заново/.test(W({ status: 401, json: {} })), '401 → «подключите заново»');
ok(/Forbidden/.test(W({ status: 403, json: { message: 'Forbidden' } })), 'и ответ Яндекса сохранён в скобках — видно причину');
ok(/удалять/.test(yd.writeErrorText({ status: 403, json: {} }, 'del')), 'для удаления текст про удаление, а не про папки');

/* ── 3. Живой сервер с двумя Дисками разных прав ───────────────────────── */
const TOK1 = 'y0_AgAAA134token-first-full-access';
const TOK2 = 'y0_AgAAA134token-second-read-only';
const TREE = [
  { path: 'disk:/', type: 'dir' },
  { path: 'disk:/Музыка', type: 'dir' },
  { path: 'disk:/старое.txt', type: 'file', size: 4 },
  { path: 'disk2:/', type: 'dir' },
  { path: 'disk2:/Музыка', type: 'dir' },
  { path: 'disk2:/старое.txt', type: 'file', size: 4 }
];
// права второго диска «переключаемы»: так видно, что дело ТОЛЬКО в правах
const st = { ro2: true };
const seen = [];        // что ушло к Яндексу: {op, path, tok}

const mock = http.createServer((rq, rs) => {
  const u = new URL(rq.url, 'http://mock');
  rq.on('data', () => {});
  rq.on('end', () => {
    const jsend = (code, obj) => { rs.writeHead(code, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify(obj)); };
    const auth = String(rq.headers.authorization || '').replace(/^OAuth\s+/i, '');
    const p = String(u.searchParams.get('path') || u.searchParams.get('from') || '');
    const isBad = auth === TOK2 && st.ro2;      // второй диск без права записи
    // Живой Яндекс получает путь БЕЗ пометки диска (у каждого диска свой корень),
    // а в ответе отдаёт «disk:/…». В стенде склеиваем пометку обратно по токену —
    // так в журнале видно, какой Диск и каким токеном трогали.
    const pre = auth === TOK2 ? 'disk2:' : 'disk:';
    const logical = x => {
      const bare = String(x).replace(/^disk\d*:/, '');   // Яндекс видит путь без номера диска
      return pre + (bare === '/' || bare === '' ? '/' : (bare.startsWith('/') ? bare : '/' + bare));
    };
    const treeOf = () => TREE.filter(x => x.path.startsWith(pre));
    const unmock = x => Object.assign({}, x, { path: x.path.replace(/^disk2:/, 'disk:') });

    if (u.pathname === '/v1/disk' || u.pathname === '/v1/disk/') {
      return jsend(200, { total_space: 1000, used_space: 10 });
    }
    if (u.pathname === '/v1/disk/resources/files') return jsend(200, { items: [], limit: 200, offset: 0 });
    if (u.pathname === '/v1/disk/resources' && rq.method === 'GET') {
      const want = logical(p);
      const base0 = want === 'disk:/' || want === 'disk2:/' ? 6 : want.length + 1;
      const items = treeOf().filter(x => x.path !== want && x.path.startsWith(base0 === 6 ? pre + '/' : want + '/')
        && x.path.slice(base0).indexOf('/') === -1).map(unmock)
        .map(x => Object.assign(x, { name: x.path.split('/').pop(), mime_type: x.type === 'dir' ? 'application/vnd.yandex-folders' : 'text/plain', modified: '2026-11-05T00:00:00Z', resource_id: 'r' }));
      return jsend(200, { name: 'Диск', path: p, type: 'dir', _embedded: { path: p, items, limit: 100, offset: 0, total: items.length } });
    }
    if (u.pathname === '/v1/disk/resources' && rq.method === 'PUT') {
      seen.push({ op: 'mkdir', path: logical(p), tok: auth });
      if (isBad) return jsend(403, { message: 'Forbidden', description: 'insufficient rights', error: 'ForbiddenError' });
      return jsend(201, { name: p.split('/').pop(), path: p });
    }
    if (u.pathname === '/v1/disk/resources' && rq.method === 'DELETE') {
      seen.push({ op: 'del', path: logical(p), tok: auth });
      if (isBad) return jsend(403, { message: 'Forbidden', error: 'ForbiddenError' });
      return jsend(204);
    }
    if (u.pathname === '/v1/disk/resources/move' && rq.method === 'POST') {
      const to = p;
      seen.push({ op: 'move', path: logical(to), tok: auth });
      if (isBad) return jsend(403, { message: 'Forbidden', error: 'ForbiddenError' });
      return jsend(201, { ok: true });
    }
    if (u.pathname === '/v1/disk/resources/upload') {
      seen.push({ op: 'upload', path: logical(p), tok: auth });
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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sega-m134-'));
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
r = await call('/api/yadisk/token', { method: 'POST', body: { token: TOK1, slot: 1 } }, admin);
ok(r.status === 200, 'первый Яндекс-Диск подключён (полные права)');
r = await call('/api/yadisk/token', { method: 'POST', body: { token: TOK2, slot: 2 } }, admin);
ok(r.status === 200, 'второй Яндекс-Диск подключён (только чтение)');
r = await call('/api/drives', {}, admin);
const dl = (r.d && (r.d.drives || r.d.list)) || [];
ok(dl.filter(x => String(x.id || '').indexOf('yandex') === 0 && x.connected).length >= 2, 'сервер видит оба Диска подключёнными');

console.log('\n  3. Первый Диск: создание папок работает (как и было)');
r = await call('/api/yadisk/op', { method: 'POST', body: { op: 'mkdir', path: 'disk:/Папка-1' } }, admin);
ok(r.status === 200 && r.d.path === 'disk:/Папка-1', `папка на первом Диске создаётся (${r.status})`);
ok(r.d && r.d.slot === 1, `в ответе видно, что работали с Диском 1 (slot=${r.d && r.d.slot})`);
ok(seen.some(x => x.op === 'mkdir' && x.path === 'disk:/Папка-1' && x.tok === TOK1), 'к Яндексу ушёл токен ПЕРВОГО диска');
r = await call('/api/yadisk/op', { method: 'POST', body: { op: 'mkdir', path: 'disk:/Музыка/Альбом' } }, admin);
ok(r.status === 200, 'и внутри папки первого Диска — тоже');

console.log('\n  4. Второй Диск: отказ объяснён, а не проглочен');
r = await call('/api/yadisk/op', { method: 'POST', body: { op: 'mkdir', path: 'disk2:/Папка-2' } }, admin);
ok(r.status === 403, `создание папки на втором Диске честно отвечает 403 (было бы 409 «Диск отказал») — пришло ${r.status}`);
const msg2 = String((r.d && r.d.error) || '');
ok(/права записи/.test(msg2), 'в ошибке сказано: «у этого входа нет права записи»');
ok(/\[Диск 2\]/.test(msg2), 'и видно, о каком диске речь — «[Диск 2]»');
ok(!/Диск отказал/.test(msg2), 'прежняя бессмысленная формулировка убрана');
ok(seen.some(x => x.op === 'mkdir' && x.path === 'disk2:/Папка-2' && x.tok === TOK2), 'запрос ушёл с токеном ВТОРОГО диска (слоты не перепутаны)');
ok(!seen.some(x => x.op === 'mkdir' && x.path === 'disk2:/Папка-2' && x.tok === TOK1), 'и никогда с токеном первого');
r = await call('/api/yadisk/op', { method: 'POST', body: { op: 'rename', path: 'disk2:/старое.txt', to: 'disk2:/новое.txt' } }, admin);
ok(r.status === 403 && /права записи/.test(String(r.d && r.d.error)), 'переименование на втором — такой же внятный отказ');
r = await call('/api/yadisk/op', { method: 'POST', body: { op: 'del', path: 'disk2:/Музыка' } }, admin);
ok(r.status === 403, 'и удаление тоже');
r = await call('/api/yadisk/op', { method: 'POST', body: { op: 'mkdir', path: 'disk:/Ещё одна' } }, admin);
ok(r.status === 200, 'первый Диск после этого продолжает работать — поломки нет');

console.log('\n  5. «Проверить запись» — правда словами (по одному нажатию)');
const seenBefore = seen.length;
r = await call('/api/yadisk/write-check', { method: 'POST', body: { slot: 1 } }, admin);
ok(r.status === 200 && r.d.canWrite === true, `на первом Диске: запись разрешена (${r.status})`);
ok(r.d && r.d.slot === 1 && r.d.drive === 'yandex', 'в ответе номер диска и вид');
const mk1 = seen.slice(seenBefore).filter(x => x.op === 'mkdir').pop() || {};
ok(/^disk:\/\.sega-проверка-/.test(String(mk1.path)), `служебная папка создаётся с отдельным именем: «${mk1.path}»`);
ok(seen.slice(seenBefore).some(x => x.op === 'del' && x.path === mk1.path), 'и сразу убирается — мусора на Диске не остаётся');
ok(r.d && r.d.cleaned !== false, 'сервер подтверждает, что убрал её');
r = await call('/api/yadisk/write-check', { method: 'POST', body: { slot: 2 } }, admin);
ok(r.status === 200 && r.d.canWrite === false, 'на втором Диске: запись запрещена — вот и ответ на жалобу');
ok(/права записи/.test(String(r.d && r.d.error)), `и причина названа: «${String(r.d && r.d.error).slice(0, 60)}…»`);
ok(seen.slice(seenBefore).filter(x => x.op === 'mkdir').every(x => x.path.indexOf('.sega-проверка') > 0), 'проверка не создаёт ничего, кроме служебной папки');
r = await call('/api/yadisk/write-check', { method: 'POST', body: { slot: 3 } }, admin);
ok(r.status === 409, 'неподключённый третий диск отвечает 409, а не выдумкой');
ok(/не подключён/.test(String(r.d && r.d.error)), 'с понятным текстом');

console.log('\n  6. Дело только в правах: дали запись — сразу заработало');
st.ro2 = false;      // «владелец переподключил диск и дал права записи»
r = await call('/api/yadisk/write-check', { method: 'POST', body: { slot: 2 } }, admin);
ok(r.status === 200 && r.d.canWrite === true, 'проверка второго Диска теперь говорит «разрешено»');
r = await call('/api/yadisk/op', { method: 'POST', body: { op: 'mkdir', path: 'disk2:/Папка-2' } }, admin);
ok(r.status === 200 && r.d.path === 'disk2:/Папка-2', 'и папка на втором Диске создаётся');
r = await call('/api/yadisk/op', { method: 'POST', body: { op: 'mkdir', path: 'disk2:/Музыка/Альбом 2' } }, admin);
ok(r.status === 200, 'внутри папки второго Диска — тоже');
r = await call('/api/yadisk/op', { method: 'POST', body: { op: 'rename', path: 'disk2:/старое.txt', to: 'disk2:/новое.txt' } }, admin);
ok(r.status === 200 && r.d.path === 'disk2:/новое.txt', 'переименование на втором Диске — тоже');
r = await call('/api/yadisk/upload-url?path=' + encodeURIComponent('disk2:/Папка-2/файл.txt'), {}, admin);
ok(r.status === 200 && r.d && !!r.d.href, 'и адрес загрузки для второго Диска выдаётся');
ok(seen.filter(x => x.path.indexOf('disk2:') === 0).every(x => x.tok === TOK2), 'за весь прогон ни один запрос по второму Диску не ушёл с первым токеном');
r = await call('/api/yadisk/list?path=' + encodeURIComponent('disk2:/'), {}, admin);
ok(r.status === 200, 'список второго Диска по-прежнему читается');

console.log('\n  7. Отметки выпуска');
ok((/const BUILD = '([^']+)'/.exec(appJs) || [])[1] === BUILD && BUILD === 'pkg3-135', `отметка выпуска одна (${BUILD})`);
ok(((/const BUILD = '([^']+)'/.exec(read('lib/api.js')) || [])[1]) === BUILD, 'BUILD в lib/api.js тот же');
ok((/const STATIC_CACHE = '([^']+)'/.exec(read('public/sw.js')) || [])[1] === 'sega-static-v129', 'кэш оформления поднят до v128');
ok(/\| pkg3-135 \|/.test(read('README.md')), 'в журнале README есть строка pkg3-135');
ok(read('package.json').includes('node test/ui134.mjs'), 'тест ui134 включён в цепочку npm test');

console.log(`\n  ИТОГ: ${good} ✓, ${bad ? bad + ' провалов' : 'провалов нет'}\n`);
process.exit(bad ? 1 : 0);
