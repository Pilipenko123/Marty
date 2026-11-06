// test/ui146.mjs — pkg3-146: пять замечаний владельца после 145-го.
//
//   1) «почему некоторые файлы открываются, а некоторые скачиваются?» — теперь
//      сперва вопрос «Скачать этот файл на устройство?»;
//   2) «документы по-прежнему открываются иероглифами» — Google пишет кириллицу
//      кодами &#1058;&#1080;…, и они попадали на экран; теперь раскодируются;
//   3) «диаграмма памяти врёт» — «Мои чаты» считались только по моим сообщениям
//      и моим загрузкам; плюс в круге не было служебной доли, а о диске сервера
//      не говорилось ничего;
//   4) листание фотографий стрелками/смахиванием, не закрывая просмотр;
//   5) окно Диска и папка на телефоне — на весь экран.
import { BUILD } from './build.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let good = 0, bad = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ПРОВАЛ: ') + m); if (c) good++; else bad++; };
const wait = ms => new Promise(r => setTimeout(r, ms));

console.log('\n══════════════════════════════════════════════════');
console.log('  pkg3-146: скачать-спросить, иероглифы, память, листание, телефон');
console.log('══════════════════════════════════════════════════\n');

const appJs = read('public/app.js');
const css = read('public/styles.css');
const gdocs = (await import(pathToFileURL(path.join(ROOT, 'lib/gdocs.js')).href)).default;

/* ── 1. «Иероглифы»: коды &#1058; превращаются в буквы ──────────────────── */
console.log('  1. Документы: коды вместо букв');
ok(gdocs.decodeEntities('&#1058;&#1080;&#1087;') === 'Тип', 'decodeEntities: числовые коды → русские буквы');
ok(gdocs.decodeEntities('&#x422;&#x438;&#x43f;') === 'Тип', 'и шестнадцатеричные коды тоже');
ok(gdocs.decodeEntities('&laquo;КОН&raquo;') === '«КОН»', 'именованные сущности (кавычки-ёлочки)');
ok(gdocs.decodeEntities('&unknown; &#0;') === '&unknown; &#0;', 'неизвестные коды остаются как есть, а не ломают текст');
const decoded = gdocs.safeHtml('<html><body><p>&#1058;&#1080;&#1087;&#1086;&#1074;&#1086;&#1081; &#1076;&#1086;&#1075;&#1086;&#1074;&#1086;&#1088;</p></body></html>');
ok(/Типовой договор/.test(decoded) && !/&#1058;/.test(decoded), 'в окно уходит «Типовой договор», а не коды');
const escSrc = gdocs.safeHtml('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
ok(!/<script/i.test(escSrc) && /alert\(1\)/.test(escSrc), 'экранированный текст остаётся текстом, а не тегом');
ok(!/<script/i.test(gdocs.safeHtml('<p><script>alert(1)</script></p>')), 'настоящий <script> по-прежнему выбрасывается');
ok(/&amp;/.test(gdocs.safeHtml('<p>А &amp; Б</p>')), 'амперсанд экранируется один раз, без двойного «&amp;amp;»');

/* ── 2. Файл без просмотра: сперва спрашиваем ───────────────────────────── */
console.log('\n  2. «Скачать этот файл?» вместо молчаливого скачивания');
ok(/function diskAskDownload\(/.test(appJs), 'есть отдельный вопрос про скачивание');
ok(/Скачать «' \+ name \+ '»'/.test(appJs) && /на устройство\?/.test(appJs), 'в вопросе назван файл и слово «устройство»');
ok(/return diskAskDownload\(it\);/.test(appJs), 'двойной клик по файлу без просмотра ведёт в вопрос, а не в скачивание');
ok(!/return diskDownloadFile\(it, st\.of\);\n\}/.test(appJs), 'молчаливого скачивания из проводника больше нет');

/* ── 3. Память сервера: честные доли и правда о диске ───────────────────── */
console.log('\n  3. Диаграмма памяти');
ok(/other: '#9db2c9'/.test(appJs) && /Служебное \(аватары, копии, /.test(appJs), 'в легенде появилась доля «Служебное»');
ok(/catOf\('messages'\) \+ catOf\('photos'\)/.test(appJs), 'круг считает все доли — сумма сходится с занятым местом');
ok(/function stDiskHtml\(/.test(appJs) && /Диск сервера: занято/.test(appJs), 'внизу показан настоящий диск сервера');
ok(/папка с данными/.test(appJs), 'и сколько реально занимает папка с данными');
const apiJs = read('lib/api.js');
ok(/myChats = mine/.test(apiJs) && /c\.members\.includes\(meId\)/.test(apiJs),
  '«Мои чаты» — все чаты, где человек состоит');
ok(/cats\.other\.bytes = Math\.max\(0, u\.bytes - catSum\)/.test(apiJs), 'служебная доля считается на сервере');
ok(/function dirBytes\(/.test(apiJs) && /function diskSpace\(/.test(apiJs),
  'сервер меряет папку с данными и весь диск (statfs)');
ok(/cats\.messages\.bytes \+= \(m\.bytes \|\| 0\) \+ MSG_ROW_OVERHEAD;/.test(apiJs)
  && !/if \(m\.uid !== meId \|\| m\.svc\) continue;/.test(apiJs),
  'сообщения считаются по чатам, а не только свои');

/* ── 4. Фотографии листаются ────────────────────────────────────────────── */
console.log('\n  4. Листание фотографий');
ok(/function diskViewPhotoAt\(/.test(appJs) && /function dkvPhotoStep\(/.test(appJs), 'просмотр фото умеет переключаться');
ok(/data-dkv-step="-1"/.test(appJs) && /data-dkv-step="1"/.test(appJs), 'в полосе есть стрелки ‹ ›');
ok(/ArrowRight/.test(appJs) && /ArrowLeft/.test(appJs), 'на ПК листаются клавишами ← →');
ok(/touchstart/.test(appJs) && /Math\.abs\(dx\) < 40/.test(appJs), 'на телефоне — смахиванием');
ok(/\.dkv-count\{/.test(css) && /\.dkv-bar-photo\{/.test(css), 'счётчик «3 / 12» оформлен');

/* ── 5. Телефон: окно Диска во весь экран ───────────────────────────────── */
console.log('\n  5. Телефон — во весь экран');
const phone = (() => {
  // блоков @media (max-width:760px) может быть несколько — берём все
  let out = '';
  let at = css.indexOf('@media (max-width:760px){');
  while (at >= 0) {
    const i = css.indexOf('{', at);
    let depth = 0;
    for (let j = i; j < css.length; j++) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}' && --depth === 0) { out += css.slice(i, j + 1); break; }
    }
    at = css.indexOf('@media (max-width:760px){', at + 1);
  }
  return out;
})();
ok(!!phone && /#modal\.dsk-modal\{padding:0/.test(phone), 'окно Диска на телефоне без полей вокруг');
ok(!!phone && /#modal\.dsk-modal \.modal-box\{max-width:100%;width:100%;height:100dvh/.test(phone),
  'и занимает весь экран по высоте');

/* ── 6. Живая проверка в jsdom ──────────────────────────────────────────── */
console.log('\n  6. Живая проверка: галерея, вопрос, легенда');
let JSDOM = null;
try { ({ JSDOM } = await import('jsdom')); } catch (e) {}
if (!JSDOM) {
  console.log('  ⚠ пропущено: нет jsdom (`npm install`)');
} else {
  process.on('unhandledRejection', () => {});
  const dom = new JSDOM(read('public/index.html'), { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.fetch = async () => ({ ok: true, status: 200, headers: { get: () => 'application/json' },
    json: async () => ({ href: 'https://x/photo.jpg', media: 'image' }), text: async () => '{}' });
  w.matchMedia = w.matchMedia || (q => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  w.confirm = () => false;
  let loadErr = null;
  try {
    w.eval(appJs + '\n;window.__sega={S,diskState,renderDiskWindow,dkViewerBack,diskViewFile,dkvPhotoStep,diskAskDownload,diskOpenItem,stLegendHtml,stDonutHtml,stDiskHtml,ST_LABEL};');
  } catch (e) { loadErr = e; }
  const sega = w.__sega;
  ok(!loadErr && !!sega, 'клиент загружается' + (loadErr ? ' (' + loadErr.message + ')' : ''));
  if (sega) {
    const d = w.document;
    const st = sega.diskState();
    Object.assign(st, { drive: 'yandex', path: 'disk:/Фото', of: '', perm: 'write', loading: false, err: '', sel: -1, sort: { key: 'name', dir: 1 } });
    st.items = [
      { name: 'a.jpg', path: 'disk:/Фото/a.jpg', dir: false, media: 'image', size: 100, preview: 'p' },
      { name: 'b.jpg', path: 'disk:/Фото/b.jpg', dir: false, media: 'image', size: 200, preview: 'p' },
      { name: 'c.jpg', path: 'disk:/Фото/c.jpg', dir: false, media: 'image', size: 300, preview: 'p' },
      { name: 'док.docx', path: 'disk:/Фото/док.docx', dir: false, media: 'doc', size: 400 }
    ];
    sega.renderDiskWindow();
    await sega.diskViewFile(st.items[0], '');
    await wait(30);
    const counter = () => (d.querySelector('.dkv-count') ? d.querySelector('.dkv-count').textContent : '');
    const alt = () => (d.querySelector('#modal.dsk-view img') ? d.querySelector('#modal.dsk-view img').getAttribute('alt') : '');
    ok(!!d.querySelector('#modal.dsk-view'), 'фото открылось на весь экран');
    ok(counter() === '1 / 3' && alt() === 'a.jpg', `счётчик и первое фото (${counter()}, ${alt()})`);
    sega.dkvPhotoStep(1);
    await wait(30);
    ok(counter() === '2 / 3' && alt() === 'b.jpg', 'кнопка › листает вперёд, просмотр не закрывается');
    ok(!d.querySelector('#modal .disk-win.dsk'), 'папка не открывается заново при листании');
    d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await wait(30);
    ok(counter() === '3 / 3', 'стрелка → на клавиатуре листает');
    d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    await wait(30);
    ok(counter() === '2 / 3', 'стрелка ← возвращает назад');
    // смахивание пальцем
    const swipe = (from, to) => {
      const ev1 = new w.Event('touchstart', { bubbles: true });
      Object.defineProperty(ev1, 'touches', { value: [{ clientX: from }] });
      (d.querySelector('.dkv-stage') || d.body).dispatchEvent(ev1);
      const ev2 = new w.Event('touchend', { bubbles: true });
      Object.defineProperty(ev2, 'changedTouches', { value: [{ clientX: to }] });
      (d.querySelector('.dkv-stage') || d.body).dispatchEvent(ev2);
    };
    swipe(300, 120);
    await wait(30);
    ok(counter() === '3 / 3', 'смахивание влево — следующее фото');
    swipe(120, 320);
    await wait(30);
    ok(counter() === '2 / 3', 'смахивание вправо — предыдущее');
    d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    ok(!!d.querySelector('#modal .disk-win.dsk') && !d.querySelector('#modal.dsk-view'),
      'Esc по-прежнему возвращает в папку');

    // файл без просмотра: сперва вопрос, скачивания без согласия нет
    w.confirm = () => false;
    const asked = [];
    const prevConfirm = w.confirm;
    w.confirm = (msg) => { asked.push(msg); return false; };
    const res = await sega.diskOpenItem(st.items[3]);
    ok(asked.length === 1 && /Скачать «док\.docx»/.test(asked[0]), `спросили: «${asked[0].split('\n')[0]}…»`);
    ok(res === null, 'отказ — файл не скачивается');

    // легенда памяти: служебная доля и правда о диске
    const fake = {
      cats: { messages: { bytes: 1048576, count: 10 }, photos: { bytes: 2097152, count: 3 }, media: { bytes: 0, count: 0 },
        files: { bytes: 0, count: 0 }, other: { bytes: 524288, count: 1 } },
      free: 10485760, disk: { total: 42949672960, used: 12884901888, free: 30064771072 },
      folder: { bytes: 3145728, files: 42 }
    };
    const legend = sega.stLegendHtml(fake);
    ok(/Служебное/.test(legend) && /Фото/.test(legend), 'в легенде есть и фото, и служебная доля');
    const donut = sega.stDonutHtml(fake.cats, fake.free, 30);
    ok((donut.match(/<circle/g) || []).length >= 3, 'круг рисует все непустые доли');
    const diskLine = sega.stDiskHtml(fake);
    ok(/Диск сервера: занято/.test(diskLine) && /папка с данными/.test(diskLine) && /42 файлов/.test(diskLine),
      'под кругом — настоящий диск сервера и размер папки с данными');
  }
  try { dom.window.close(); } catch (e) {}
}

/* ── 7. Отметки выпуска ─────────────────────────────────────────────────── */
console.log('\n  7. Отметки выпуска');
const cache = (/const STATIC_CACHE = '([^']+)'/.exec(read('public/sw.js')) || [])[1];
ok(((/const BUILD = '([^']+)'/.exec(appJs) || [])[1]) === BUILD && /^pkg3-1[4-9][0-9]$/.test(BUILD), `отметка выпуска одна (${BUILD})`);
ok(((/const BUILD = '([^']+)'/.exec(apiJs) || [])[1]) === BUILD, 'BUILD в lib/api.js тот же');
ok(/^sega-static-v\d+$/.test(cache) && Number(cache.split('-v')[1]) >= 141, `кэш оформления поднят (${cache})`);
ok(/\| pkg3-146 \|/.test(read('README.md')), 'в журнале README есть строка pkg3-146');
ok(read('package.json').includes('node test/ui146.mjs'), 'тест ui146 включён в цепочку npm test');

console.log(`\n  ИТОГ: ${good} ✓, ${bad ? bad + ' провалов' : 'провалов нет'}\n`);
process.exit(bad ? 1 : 0);
