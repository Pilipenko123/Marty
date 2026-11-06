// test/ui145.mjs — pkg3-145: документы и файлы на всё окно, возврат в папку,
//                  и документы Google больше не открываются «иероглифами».
//
// Владелец после 144-го: «документы открываются не на белом фоне, а на фоне темы
// мессенджера… и по-моему там иероглифами открывается» + «чтобы документы и файлы
// открывались на всё окно браузера, хоть на ПК, хоть на телефоне, а при закрытии
// оставалось открытым окно, где этот документ или файл лежит».
//
// Причина «иероглифов» найдена в коде: Google отдаёт документ в HTML-экспорте
// УПАКОВАННЫМ в ZIP, а сервер читал байты архива как текст. Здесь проверяем
// распаковку по-настоящему (образец архива собирается прямо в тесте), а окно
// просмотра рисуем в jsdom: открыть документ → закрыть → вернуться в папку.
import { BUILD } from './build.mjs';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let good = 0, bad = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ПРОВАЛ: ') + m); if (c) good++; else bad++; };

console.log('\n══════════════════════════════════════════════════');
console.log('  pkg3-145: документы и файлы на всё окно, назад в папку');
console.log('══════════════════════════════════════════════════\n');

const gdrive = (await import(pathToFileURL(path.join(ROOT, 'lib/gdrive.js')).href)).default;
const gdocs = (await import(pathToFileURL(path.join(ROOT, 'lib/gdocs.js')).href)).default;

/** Собрать настоящий ZIP (сжатие deflate) — как тот, что отдаёт Google. */
function makeZip(files) {
  const locals = [], centrals = [];
  let off = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const raw = Buffer.from(f.text, 'utf8');
    const comp = zlib.deflateRawSync(raw);
    const crc = zlib.crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(8, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(8, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38); ch.writeUInt32LE(off, 42);
    centrals.push(ch, name);
    off += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16); eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, eocd]);
}

/* ── 1. Иероглифы: архив Google Docs распаковывается ────────────────────── */
console.log('  1. Документ из упаковки читается по-русски');
const DOC_HTML = '<html><head><meta charset="utf-8"></head><body><h1>Отпуск в Сочи</h1><p>Проверка раскладки и кириллицы</p></body></html>';
const zip = makeZip([
  { name: 'images/картинка.png', text: 'PNGDATA' },
  { name: 'Отпуск.html', text: DOC_HTML }
]);
const dec = gdrive.decodeExport(zip);
ok(dec.zipped === true, 'архив узнан по подписи PK');
ok(dec.unzipped === true, 'архив распакован встроенным zlib — без новых библиотек');
ok(/Отпуск в Сочи/.test(dec.text), 'русский текст читается (а не «иероглифы»)');
ok(!/\uFFFD/.test(dec.text), 'битых символов в тексте нет');
const html = gdocs.safeHtml(dec.text);
ok(/<h1>Отпуск в Сочи<\/h1>/.test(html) && /Проверка раскладки/.test(html), 'из архива достаётся нормальный HTML документа');
ok(/entries\.find\(x => \/\\\.html\?\$\/i\.test\(x\.name\)\)/.test(read('lib/gdrive.js')), 'в архиве выбирается файл .html, а не первый попавшийся');
ok(/\.find\(x => \/\\\.html\?\$\/i\.test\(x\.name\)\)/.test(read('lib/gdrive.js')), 'картинки из архива не подсовываются вместо текста');

const plain = gdrive.decodeExport(Buffer.from(DOC_HTML, 'utf8'));
ok(plain.zipped === false && /Отпуск в Сочи/.test(plain.text), 'обычный (не упакованный) экспорт читается как раньше');
const broken = gdrive.decodeExport(Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5]));
ok(broken.zipped === true && broken.unzipped === false && broken.text === '', 'битый архив не выдаёт мусор — отдаёт пустой текст');
ok(/проверка|Распаковка|pkg3-145/.test(read('lib/gdrive.js')), 'в коде есть отметка выпуска про распаковку');
ok(/decodeExport\(Buffer\.concat\(chunks\)\)/.test(read('lib/gdrive.js')), 'экспорт распаковывается сразу, а не «как получится»');
ok(/exDoc\.zipped && !exDoc\.unzipped/.test(read('lib/api.js')) && /распаковать не удалось/.test(read('lib/api.js')),
  'если распаковать не вышло — честный отказ вместо мусора на экране');

/* ── 2. Полноэкранное окно и белый лист ─────────────────────────────────── */
console.log('\n  2. Окно на весь экран, документ на белом листе');
const appJs = read('public/app.js');
const css = read('public/styles.css');
ok(/#modal\.dsk-view\{background:#1c1c1e;padding:0\}/.test(css), 'просмотр открывается поверх всего, без отступов');
ok(/#modal\.dsk-view \.modal-box\{[^}]*height:100dvh/.test(css) && /width:100vw/.test(css),
  'окно просмотра занимает весь экран — и на ПК, и на телефоне');
ok(/\.dkv-sheet\{[^}]*background:#fff[^}]*color:#1b1b1b/.test(css), 'документ лежит на белом листе, текст чёрный');
ok(/\.dkv-sheet \.gd-doc\{color:#1b1b1b/.test(css), 'тёмная тема мессенджера на документ больше не влияет');
ok(/\.dkv-dark\{background:#111\}/.test(css) && /\.dkv-media-el\{/.test(css), 'фото и видео — на тёмном фоне, целиком в экране');
ok(/@media \(max-width:700px\)\{[\s\S]*\.dkv-sheet\{padding:16px 14px/.test(css), 'на телефоне лист без рамки и полей — весь экран под текст');
ok(/function dkViewerOpen\(/.test(appJs) && /cls: 'dsk-view'/.test(appJs), 'просмотр открывается отдельным полноэкранным окном');
ok(/function dkViewerBack\(/.test(appJs) && /renderDiskWindow\(\);   \/\/ окно папки рисуется заново/.test(appJs),
  'закрытие возвращает в ту же папку (проводник перерисовывается)');
ok(/data-disk-back="1" title="Вернуться в папку"/.test(appJs), 'в полосе просмотра есть кнопка «← В папку»');

/* ── 3. Живой сценарий в jsdom: документ → закрыть → папка ──────────────── */
console.log('\n  3. Открыли документ, закрыли — папка на месте');
let JSDOM = null;
try { ({ JSDOM } = await import('jsdom')); } catch (e) {}
if (!JSDOM) {
  console.log('  ⚠ пропущено: нет jsdom (`npm install`) — окно просмотра не рисуем');
} else {
  process.on('unhandledRejection', () => {});
  const dom = new JSDOM(read('public/index.html'), { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });
  w.matchMedia = w.matchMedia || (q => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  let loadErr = null;
  try {
    w.eval(appJs + '\n;window.__sega={diskState,renderDiskWindow,dkViewerOpen,dkViewerBack,dkViewerBar,gdDocBodyHtml,gdSheetHtml};');
  } catch (e) { loadErr = e; }
  const sega = w.__sega;
  ok(!loadErr && !!sega, 'клиент загружается' + (loadErr ? ' (' + loadErr.message + ')' : ''));
  if (sega) {
    const d = w.document;
    const st = sega.diskState();
    Object.assign(st, { drive: 'yandex', path: 'disk:/Отпуск', of: '', perm: 'write', loading: false, err: '', sel: -1, sort: { key: 'name', dir: 1 } });
    st.items = [{ name: 'Отпуск', path: 'disk:/Отпуск/Док', dir: true, size: 0, modified: '' }];
    sega.renderDiskWindow();
    ok(!!d.querySelector('#modal .disk-win.dsk.wxp'), 'окно папки открыто');
    ok(d.querySelector('#modal-title').textContent === '☁ Мои диски', 'в заголовке — папка');

    // так же, как это делает diskViewDoc: полноэкранный просмотр документа
    const body = `<div class="dkv dkv-paper">${sega.dkViewerBar('Документ Google · только смотреть', '')}`
      + `<div class="dkv-body"><div class="dkv-sheet gd-doc">${sega.gdDocBodyHtml({ kind: 'document', html: '<h1>Отпуск в Сочи</h1><p>Первый абзац</p>' })}</div></div>`
      + '<div class="dkv-foot">Документ открыт только для чтения.</div></div>';
    sega.dkViewerOpen('Отпуск в Сочи', body);
    ok(d.querySelector('#modal').classList.contains('dsk-view'), 'документ открылся полноэкранным окном');
    ok(!d.querySelector('#modal').classList.contains('dsk-modal'), 'широкий класс папки не мешает полноэкранному виду');
    ok(d.querySelector('.dkv-sheet').textContent.includes('Отпуск в Сочи'), 'текст документа виден на листе');
    ok(!!d.querySelector('.dkv-bar [data-disk-back]'), 'в полосе есть «← В папку»');

    // «крестик» окна — назад в папку
    d.querySelector('#modal-close').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    ok(!d.querySelector('#modal').classList.contains('dsk-view'), 'крестик закрыл полноэкранный просмотр');
    ok(!!d.querySelector('#modal .disk-win.dsk.wxp'), 'и вернул в ту же папку (а не в чат)');
    ok(d.querySelector('#modal').classList.contains('dsk-modal'), 'окно папки снова обычное, широкое');

    // кнопка «← В папку»
    sega.dkViewerOpen('Отпуск в Сочи', body);
    d.querySelector('.dkv-bar [data-disk-back]').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    ok(!d.querySelector('#modal').classList.contains('dsk-view') && !!d.querySelector('#modal .disk-win.dsk'),
      'кнопка «← В папку» тоже возвращает в папку');

    // Esc
    sega.dkViewerOpen('Отпуск в Сочи', body);
    d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    ok(!d.querySelector('#modal').classList.contains('dsk-view') && !!d.querySelector('#modal .disk-win.dsk'),
      'Esc тоже возвращает в папку');

    // фото: тёмный просмотр на весь экран
    sega.dkViewerOpen('beach.jpg', `<div class="dkv dkv-dark">${sega.dkViewerBar('beach.jpg', '<button class="wxp-tool" data-disk-dl-url="x" data-disk-dl-name="beach.jpg">⬇ Скачать</button>')}<div class="dkv-body dkv-stage"><img class="dkv-media-el" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt=""></div></div>`);
    ok(!!d.querySelector('#modal.dsk-view .dkv-dark .dkv-media-el'), 'фото открылось на всё окно');
    ok(!!d.querySelector('#modal.dsk-view [data-disk-dl-url]'), 'и кнопка «Скачать» рядом');
    d.querySelector('#modal-close').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    ok(!!d.querySelector('#modal .disk-win.dsk'), 'после фото — снова папка');

    // таблица Google — тоже на белом листе
    const sheetBody = `<div class="dkv dkv-paper">${sega.dkViewerBar('Таблица Google', '')}<div class="dkv-body"><div class="dkv-sheet">${sega.gdSheetHtml({ rows: [['Месяц', 'Сумма'], ['Май', '1200']] })}</div></div></div>`;
    sega.dkViewerOpen('Смета', sheetBody);
    ok(/Месяц/.test(d.querySelector('.dkv-sheet').textContent) && !!d.querySelector('.dkv-sheet .gd-sheet'),
      'таблица Google тоже показывается на листе');
    d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    ok(!!d.querySelector('#modal .disk-win.dsk'), 'и из таблицы возвращаемся в папку');
  }
  try { dom.window.close(); } catch (e) {}
}

/* ── 4. Отметки выпуска ─────────────────────────────────────────────────── */
console.log('\n  4. Отметки выпуска');
const cache = (/const STATIC_CACHE = '([^']+)'/.exec(read('public/sw.js')) || [])[1];
ok(((/const BUILD = '([^']+)'/.exec(appJs) || [])[1]) === BUILD && BUILD === 'pkg3-145', `отметка выпуска одна (${BUILD})`);
ok(((/const BUILD = '([^']+)'/.exec(read('lib/api.js')) || [])[1]) === BUILD, 'BUILD в lib/api.js тот же');
ok(cache === 'sega-static-v139', `кэш оформления поднят (${cache})`);
ok(/\| pkg3-145 \|/.test(read('README.md')), 'в журнале README есть строка pkg3-145');
ok(read('package.json').includes('node test/ui145.mjs'), 'тест ui145 включён в цепочку npm test');

console.log(`\n  ИТОГ: ${good} ✓, ${bad ? bad + ' провалов' : 'провалов нет'}\n`);
process.exit(bad ? 1 : 0);
