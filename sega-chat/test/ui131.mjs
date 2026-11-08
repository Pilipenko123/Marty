// test/ui131.mjs — pkg3-146: документы Google (Docs, Sheets, Slides) в окне чата.
//
// У «документов Google» нет файла: их нельзя скачать потоком (в архиве папки они
// идут в «что-не-вошло»). Теперь их открывают в окне: сервер берёт у Google
// экспорт и превращает его в безопасный вид — HTML по белому списку, строки
// таблицы, текст презентации. Проверяем на живом сервере с игрушечным Google:
//   • докладка: заголовок, абзацы, список, ссылка, картинка;
//   • таблица: кавычки, запятые внутри ячейки, «хвостовой» перевод строки;
//   • презентация: текст;
//   • вредное вычищается: <script>, on…, javascript:-, чужие картинки, iframe;
//   • обычный файл — честный отказ (его качают, а не открывают в окне);
//   • чужой документ без «Поделиться» — 404, после — открывается;
//   • огромный документ обрезается, а не съедает память VPS.
import { BUILD } from './build.mjs';
import { kindOf, exportMime, openUrl, safeHtml, csvRows } from '../lib/gdocs.js';
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
console.log('  pkg3-146: документы Google в окне чата');
console.log('══════════════════════════════════════════════════\n');

/* ── 1. Правила без сервера ─────────────────────────────────────────────── */
console.log('  1. Правила документов');
const M_DOC = 'application/vnd.google-apps.document';
const M_SHEET = 'application/vnd.google-apps.spreadsheet';
const M_SLIDE = 'application/vnd.google-apps.presentation';
ok(kindOf(M_DOC) === 'document' && kindOf(M_SHEET) === 'spreadsheet' && kindOf(M_SLIDE) === 'presentation', 'виды Google узнаются');
ok(kindOf('audio/mpeg') === '' && kindOf(M_DOC.replace('document', 'folder')) === '', 'обычный файл и папка — не документы');
ok(exportMime(M_DOC) === 'text/html' && exportMime(M_SHEET) === 'text/csv' && exportMime(M_SLIDE) === 'text/plain', 'каждому виду — свой формат экспорта');
ok(openUrl('ABC123_-x', M_SHEET) === 'https://docs.google.com/spreadsheets/d/ABC123_-x/edit', 'ссылка «Открыть в Google» ведёт в нужный сервис');
ok(openUrl('../../evil', M_DOC).indexOf('..') < 0, 'в ссылку не пролезает ничего постороннего');

const dirty = `<html><head><style>p{color:red}</style></head><body>
<h1>Заголовок</h1><p style="font-weight:700">Жирный <b>текст</b></p>
<script>alert('взлом')</script><p onclick="steal()">клик</p>
<a href="javascript:alert(1)">плохая</a><a href="https://example.com/x">хорошая</a>
<img src="https://lh3.googleusercontent.com/ok"><img src="http://evil.example/x.png">
<iframe src="https://evil.example"></iframe></body></html>`;
const clean = safeHtml(dirty);
ok(/<h1>Заголовок<\/h1>/.test(clean), 'заголовок и абзацы сохраняются');
ok(!/<script/i.test(clean) && !/alert/.test(clean), 'скрипты выброшены вместе с содержимым');
ok(!/onclick/i.test(clean) && !/style="[^"]*color:red/.test(clean), 'обработчики и стили со страницы выброшены');
ok(!/javascript:/i.test(clean), 'ссылка с javascript: не проходит');
ok(/href="https:\/\/example\.com\/x"/.test(clean) && /rel="noopener noreferrer"/.test(clean), 'обычная ссылка осталась и стала безопасной');
ok(/src="https:\/\/lh3\.googleusercontent\.com\/ok"/.test(clean), 'картинка с разрешённого домена осталась');
ok(!/evil\.example/.test(clean) && !/iframe/i.test(clean), 'чужая картинка и iframe не прошли');
ok(/font-weight: 700/.test(clean), 'жирность из оформления сохранена (это не опасный стиль)');

const csv = csvRows('Товар,Цена\n"Кофе, молотый",250\n"Чай ""Люкс""",180\n\n');
ok(csv.rows.length === 3, 'таблица разобрана построчно (пустая строка в конце не считается)');
ok(csv.rows[1][0] === 'Кофе, молотый', 'запятая внутри кавычек не рвёт ячейку');
ok(csv.rows[2][0] === 'Чай "Люкс"', 'удвоенные кавычки вернулись одной');
ok(csv.cols === 2, 'число столбцов посчитано');

/* ── 2. Стенд ───────────────────────────────────────────────────────────── */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sega-m131-'));
const dataDir = path.join(dir, 'data');
const keysPath = path.join(dir, 'google-oauth.json');
fs.writeFileSync(keysPath, JSON.stringify({ client_id: 'cid131.apps.googleusercontent.com', client_secret: 'sec131' }));

const DOC_HTML = `<!DOCTYPE html><html><head><title>Служебная записка</title></head><body>
<h1>Служебная записка</h1><p>Привет, это документ Google.</p>
<ul><li>первый пункт</li><li>второй пункт</li></ul>
<p onclick="alert(1)">строка с обработчиком</p><script>alert('нет')</script>
<a href="javascript:alert(1)">плохая ссылка</a></body></html>`;
const SHEET_CSV = 'Товар,Цена\n"Кофе, молотый",250\n"Чай ""Люкс""",180\n';
const SLIDE_TXT = 'Слайд 1\nМорской бой\n\nСлайд 2\nПравила';
const BIG_DOC = 'Ж' + 'очень длинный документ '.repeat(220000);   // больше 4 МБ

const FILES = {
  doc131: { name: 'Служебная записка', mimeType: M_DOC, exportText: DOC_HTML },
  sheet131: { name: 'Цены', mimeType: M_SHEET, exportText: SHEET_CSV },
  slide131: { name: 'Презентация', mimeType: M_SLIDE, exportText: SLIDE_TXT },
  big131: { name: 'Огромный документ', mimeType: M_DOC, exportText: BIG_DOC },
  audio131: { name: 'просто трек.mp3', mimeType: 'audio/mpeg', size: '42' }
};
const exported = [];   // какие запросы на экспорт были: { id, mime }

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

    if (rq.method === 'POST' && u.pathname === '/token') {
      return jsend(200, { access_token: 'gtok131', refresh_token: 'rt131', expires_in: 3600, scope: 'https://www.googleapis.com/auth/drive' });
    }
    if (u.pathname === '/drive/v3/about') return jsend(200, { storageQuota: { limit: '1000', usage: '1' } });
    if (rq.method === 'GET' && u.pathname === '/drive/v3/files') {
      const list = ['doc131', 'sheet131', 'slide131', 'audio131'].map(id => Object.assign({ id, parents: ['root'] }, FILES[id]));
      return jsend(200, { files: list, nextPageToken: '' });
    }
    const ex = /^\/drive\/v3\/files\/([^/]+)\/export$/.exec(u.pathname);
    if (ex) {
      const f = FILES[ex[1]];
      if (!f || f.exportText == null) return jsend(403, { error: { message: 'fileNotExportable' } });
      exported.push({ id: ex[1], mime: String(u.searchParams.get('mimeType') || '') });
      const body = Buffer.from(f.exportText, 'utf8');
      rs.writeHead(200, { 'Content-Type': String(u.searchParams.get('mimeType') || 'text/plain') + '; charset=utf-8', 'Content-Length': String(body.length) });
      return rs.end(body);
    }
    const fm = /^\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname);
    if (fm) {
      const f = FILES[fm[1]];
      if (!f) return jsend(404, { error: { message: 'notFound' } });
      if (u.searchParams.get('alt') === 'media') {
        rs.writeHead(200, { 'Content-Type': f.mimeType, 'Content-Length': '4' });
        return rs.end('ABCD');
      }
      return jsend(200, { id: fm[1], name: f.name, mimeType: f.mimeType, size: f.size, parents: ['root'] });
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
{
  const a = await call('/api/gdrive/auth?slot=1', {}, A.token);
  const st = (new URL(a.d.url)).searchParams.get('state');
  const html = await (await fetch(base + '/api/gdrive/callback?state=' + encodeURIComponent(st) + '&code=g1code')).text();
  ok(/Google Диск подключён/.test(html), 'Google-Диск подключён к стенду');
}

/* ── 3. Проводник знает про документы ─────────────────────────────────── */
console.log('\n  2. Документы видны в проводнике');
r = await call('/api/yadisk/list?path=' + encodeURIComponent('google:/root'), {}, A.token);
const items = (r.d && r.d.items) || [];
const byName = n => items.find(x => x.name === n) || {};
ok(items.length >= 4, `список папки получен (${items.length})`);
ok(byName('Служебная записка').gdoc === 'document', 'у документа есть пометка «document»');
ok(byName('Цены').gdoc === 'spreadsheet' && byName('Презентация').gdoc === 'presentation', 'у таблицы и презентации — свои пометки');
ok(byName('просто трек.mp3').gdoc === undefined || byName('просто трек.mp3').gdoc === '', 'у обычного файла пометки нет');

/* ── 4. Документ в окне ────────────────────────────────────────────────── */
console.log('\n  3. Документ Google в окне');
r = await call('/api/gdrive/doc?path=' + encodeURIComponent('google:/doc131'), {}, A.token);
ok(r.status === 200, 'документ открылся (200)');
ok(r.d.kind === 'document' && r.d.kindTitle === 'Документ Google', 'сервер говорит, что это документ');
ok(r.d.name === 'Служебная записка', 'имя документа сохранено');
ok(/Привет, это документ Google/.test(String(r.d.html || '')), 'текст документа пришёл');
ok(/<ul><li>первый пункт<\/li><li>второй пункт<\/li><\/ul>/.test(String(r.d.html || '')), 'список остался списком');
ok(!/<script/i.test(String(r.d.html)) && !/alert/.test(String(r.d.html)), 'скрипт из документа не дошёл до окна');
ok(!/onclick/i.test(String(r.d.html)), 'обработчик нажатия вычищен');
ok(!/javascript:/i.test(String(r.d.html)), 'опасная ссылка вычищена');
ok(r.d.openInGoogle === 'https://docs.google.com/document/d/doc131/edit', 'есть ссылка «Открыть в Google»');
ok(r.d.perm === 'write', 'свой документ — можно и править (в Google)');
ok(exported.some(x => x.id === 'doc131' && x.mime === 'text/html'), 'у Google запрошен именно HTML-экспорт');

console.log('\n  4. Таблица и презентация');
r = await call('/api/gdrive/doc?path=' + encodeURIComponent('google:/sheet131'), {}, A.token);
ok(r.status === 200 && r.d.kind === 'spreadsheet', 'таблица открылась');
ok(Array.isArray(r.d.rows) && r.d.rows.length === 3, 'строки таблицы пришли (3)');
ok(r.d.rows[0][0] === 'Товар' && r.d.rows[0][1] === 'Цена', 'первая строка — заголовки');
ok(r.d.rows[1][0] === 'Кофе, молотый' && r.d.rows[1][1] === '250', 'запятая в ячейке не развалила строку');
ok(r.d.rows[2][0] === 'Чай "Люкс"', 'кавычки в ячейке вернулись одной парой');
ok(exported.some(x => x.id === 'sheet131' && x.mime === 'text/csv'), 'у Google запрошен CSV');
ok(r.d.openInGoogle.indexOf('spreadsheets') > 0, 'ссылка ведёт в таблицы Google');

r = await call('/api/gdrive/doc?path=' + encodeURIComponent('google:/slide131'), {}, A.token);
ok(r.status === 200 && r.d.kind === 'presentation', 'презентация открылась');
ok(/Морской бой/.test(String(r.d.text || '')), 'текст презентации пришёл');
ok(exported.some(x => x.id === 'slide131' && x.mime === 'text/plain'), 'у Google запрошен текст');

console.log('\n  5. Отказы и границы');
r = await call('/api/gdrive/doc?path=' + encodeURIComponent('google:/audio131'), {}, A.token);
ok(r.status === 400 && /обычный файл/i.test(r.d.error || ''), 'обычный файл в окно документа не отдаётся');
r = await call('/api/gdrive/doc?path=' + encodeURIComponent('disk:/Музыка'), {}, A.token);
ok(r.status === 400, 'яндексовый путь в документы Google не пускается');
r = await call('/api/gdrive/doc?of=' + A.id + '&path=' + encodeURIComponent('google:/doc131'), {}, K.token);
ok(r.status === 404, 'чужой документ без «Поделиться» не открывается');
r = await call('/api/gdrive/doc?path=' + encodeURIComponent('google:/no-such'), {}, A.token);
ok(r.status === 404, 'несуществующий документ — 404, а не «ошибка сервера»');
r = await call('/api/gdrive/doc?path=' + encodeURIComponent('google:/big131'), {}, A.token);
ok(r.status === 200 && r.d.truncated === true, 'огромный документ обрезан, а не проглочен целиком');
ok(String(r.d.html || '').length > 1000 && String(r.d.html || '').length < 5 * 1024 * 1024, 'в окно ушло начало документа, а не мегабайты');

r = await call('/api/yadisk/share-file', { method: 'POST', body: { path: 'google:/doc131', name: 'Служебная записка', kind: 'file' } }, A.token);
ok(r.status === 200, 'владелец поделился документом');
r = await call('/api/gdrive/doc?of=' + A.id + '&path=' + encodeURIComponent('google:/doc131'), {}, K.token);
ok(r.status === 200 && /Привет, это документ Google/.test(String(r.d.html || '')), 'после «Поделиться» документ открывается и участнице');
ok(r.d.perm === 'read', 'и она видит пометку «только смотреть»');

/* ── 6. Клиент и отметки выпуска ─────────────────────────────────────── */
console.log('\n  6. Клиент и отметки выпуска');
const appJs = read('public/app.js');
ok(/async function diskViewDoc\(/.test(appJs), 'в клиенте есть окно документа');
ok(/if \(it\.gdoc\) return diskViewDoc\(it, st\.of\)/.test(appJs), 'двойной клик по документу открывает окно, а не скачивание');
ok(/if \(it\.gdoc\) \{ toast\('Документ Google не скачивается файлом/.test(appJs), 'и «Скачать» на документе честно объясняет, что скачивать нечего');
ok(/\/api\/gdrive\/doc' \+ q/.test(appJs), 'клиент спрашивает документ у сервера');
ok(/gd-sheet/.test(appJs) && /gd-pre/.test(appJs), 'таблица и презентация показываются по-своему');
ok(/Открыть в Google/.test(appJs), 'в окне есть кнопка «Открыть в Google»');
ok(/GDOC_RU/.test(appJs) && /Документ Google/.test(appJs), 'в списке у документа человеческая подпись');
ok(/\.gd-doc/.test(read('public/styles.css')), 'стили окна документа на месте');
ok((/const BUILD = '([^']+)'/.exec(appJs) || [])[1] === BUILD && /^pkg3-1\d\d$/.test(BUILD), `отметка выпуска одна (${BUILD})`);
ok(((/const BUILD = '([^']+)'/.exec(read('lib/api.js')) || [])[1]) === BUILD, 'BUILD в lib/api.js тот же');
ok((/const STATIC_CACHE = '([^']+)'/.exec(read('public/sw.js')) || [])[1] === 'sega-static-v146', 'кэш оформления поднят до v125');
ok(/\| pkg3-146 \|/.test(read('README.md')), 'в журнале README есть строка pkg3-146');
ok(read('package.json').includes('node test/ui131.mjs'), 'тест ui131 включён в цепочку npm test');
ok(!/require\('(sanitize-html|dompurify|jsdom|papaparse|marked)'\)/.test(read('lib/gdocs.js')), 'документы разбираются без новых зависимостей');

console.log(`\n  ИТОГ: ${good} ✓, ${bad ? bad + ' провалов' : 'провалов нет'}\n`);
process.exit(bad ? 1 : 0);
