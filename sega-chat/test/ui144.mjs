// test/ui144.mjs — pkg3-145: диски открываются как папки Windows.
//
// Владелец: «Хочется, чтобы диски открывались как папки Windows, что на ПК, что
// на телефоне. Я имею в виду по структуре, по цвету и шрифту» (со скриншотом
// проводника Windows). Значит: жёлтые значки папок вместо эмодзи, белое окно,
// шрифт Segoe UI на компьютере, столбцы «Название · Дата изменения · Тип ·
// Размер», папки сверху, сортировка по щелчку на заголовке — и то же окно на
// телефоне (только без лишних столбцов).
//
// Проверяем не только слова: разметку окна рисуем по-настоящему в jsdom
// (index.html + app.js) и смотрим на живые строки. Нет jsdom — честно говорим,
// что часть проверок пропущена, а не притворяемся зелёными.
import { BUILD } from './build.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let good = 0, bad = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ПРОВАЛ: ') + m); if (c) good++; else bad++; };

console.log('\n══════════════════════════════════════════════════');
console.log('  pkg3-145: «Мои диски» — как папка в проводнике Windows');
console.log('══════════════════════════════════════════════════\n');

const appJs = read('public/app.js');
const css = read('public/styles.css');

/** Блок @media … честным подсчётом скобок (так же, как в dom42). */
function mediaBlock(text, query) {
  const at = text.indexOf('@media ' + query + '{');
  if (at < 0) return '';
  const i = text.indexOf('{', at);
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    if (text[j] === '{') depth++;
    else if (text[j] === '}' && --depth === 0) return text.slice(i, j + 1);
  }
  return '';
}

/* ── 1. Порядок и имена в коде ──────────────────────────────────────────── */
console.log('  1. Значки, столбцы и шрифт');
ok(/const WXP_SVG_FOLDER/.test(appJs) && /#ffcf4d/.test(appJs) && /#e0a012/.test(appJs),
  'папка нарисована жёлтым значком Windows (SVG, а не эмодзи)');
const rowSrc = (appJs.slice(appJs.indexOf('function diskRowHtml('), appJs.indexOf('/** Перерисовать окно диска.')));
ok(!/📁|DK_ICON/.test(rowSrc) && /dkWxpIcon\(kind\)/.test(rowSrc), 'в строке проводника только новые значки, эмодзи-папки не осталось');
ok(/function dkWxpIcon\(/.test(appJs) && /wxpSheet\(/.test(appJs),
  'у каждого вида файла свой значок-лист с цветной плашкой');
ok(/class="wxp-cols"/.test(appJs) && (appJs.match(/data-dsk-sort="/g) || []).length === 4,
  'в окне четыре столбца с заголовками');
ok(/Название<span class="wxp-arrow"/.test(appJs) && /Дата изменения<span/.test(appJs)
  && /Тип<span/.test(appJs) && /Размер<span/.test(appJs), 'столбцы названы как в Windows');
ok(/function dkSortItems\(/.test(appJs) && /fa !== fb/.test(appJs),
  'папки всегда сверху, остальное — по выбранному столбцу');
ok(/function dkWhen\(/.test(appJs) && /dkWhen\(it\.modified\)/.test(appJs),
  'видна дата изменения файла (её отдают и Яндекс, и Google)');
ok(/function dkTypeName\(/.test(appJs) && /Папка с файлами/.test(appJs) && /-изображение/.test(appJs),
  'тип подписан по-человечески: «Папка с файлами», «JPG-изображение»');
ok(/modal\('☁ Мои диски', `.+`/s.test(appJs), 'окно по-прежнему называется «☁ Мои диски»');

/* ── 2. Цвет, шрифт и телефон ───────────────────────────────────────────── */
console.log('\n  2. Цвет, шрифт, телефон');
ok(/\.dsk\.wxp\{/.test(css), 'у окна Диска своё оформление .dsk.wxp');
ok(/font-family:"Segoe UI Variable Text","Segoe UI"/.test(css), 'шрифт — тот же, что в Windows (Segoe UI)');
ok(/\.dsk\.wxp\{[^}]*background:#fff/.test(css) && /--wxp-fg:#1b1b1b/.test(css),
  'окно светлое, текст почти чёрный — как в проводнике');
ok(/--wxp-sel:#cce8ff/.test(css) && /\.dsk\.wxp \.disk-row\.sel\{background:var\(--wxp-sel\)/.test(css),
  'выделенная строка подсвечивается тем же светло-синим');
ok(/\.dsk\.wxp \.wxp-cols\{[^}]*grid-template-columns:44px minmax\(0,1fr\) 152px 168px 92px/.test(css),
  'столбцы выстроены сеткой, как в проводнике');
ok(/\.dsk\.wxp \.wxp-col\{[^}]*height:28px/.test(css), 'заголовки столбцов — плоские кнопки');
const phone = mediaBlock(css, '(max-width:700px)');
ok(!!phone && /\.dsk\.wxp \.wxp-col\[data-dsk-sort="date"\]/.test(phone)
  && /\.dsk\.wxp \.wxp-date,\.dsk\.wxp \.wxp-type\{display:none\}/.test(phone),
  'на телефоне лишние столбцы убираются — окно то же');
ok(!!phone && /\.dsk\.wxp \.disk-row\{grid-template-columns:40px minmax\(0,1fr\) 78px;height:44px\}/.test(phone),
  'строки на телефоне выше — палец попадает');
ok(/#modal\.dsk-modal \.modal-box\{max-width:min\(980px,96vw\)\}/.test(css),
  'окно Диска шире обычных — четыре столбца помещаются');

/* ── 3. Живой рендер окна в jsdom ───────────────────────────────────────── */
console.log('\n  3. Окно, нарисованное по-настоящему');
let JSDOM = null;
try { ({ JSDOM } = await import('jsdom')); } catch (e) {}
if (!JSDOM) {
  console.log('  ⚠ пропущено: нет jsdom (`npm install`) — живую разметку не рисуем');
} else {
  process.on('unhandledRejection', () => {});
  const dom = new JSDOM(read('public/index.html'), { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });
  w.matchMedia = w.matchMedia || (q => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  let loadErr = null;
  try {
    w.eval(appJs + '\n;window.__sega={diskState,renderDiskWindow,dkSortItems,dkWhen,dkTypeName,dkWxpIcon};');
  } catch (e) { loadErr = e; }
  const sega = w.__sega;
  ok(!loadErr && !!sega, 'клиент загружается, проводник доступен' + (loadErr ? ' (' + loadErr.message + ')' : ''));
  if (sega) {
    const st = sega.diskState();
    Object.assign(st, { drive: 'yandex', path: 'disk:/', of: '', perm: 'write', loading: false, err: '', sel: -1, sort: { key: 'name', dir: 1 } });
    st.items = [
      { name: 'Фото', path: 'disk:/Фото', dir: true, size: 0, modified: '' },
      { name: 'song.mp3', path: 'disk:/song.mp3', dir: false, size: 3145728, media: 'audio', modified: '2026-11-05T10:00:00Z' },
      { name: 'beach.jpg', path: 'disk:/beach.jpg', dir: false, size: 204800, media: 'image', modified: '2026-11-04T08:30:00Z' },
      { name: 'notes.txt', path: 'disk:/notes.txt', dir: false, size: 10, media: 'doc', modified: '2026-11-01T08:30:00Z' }
    ];
    sega.renderDiskWindow();
    const d = w.document;
    const names = () => [...d.querySelectorAll('#disk-list .wxp-name')].map(x => x.textContent);
    ok(!!d.querySelector('#modal .disk-win.dsk.wxp'), 'окно открылось в светлом оформлении проводника');
    ok(d.querySelectorAll('#disk-list .disk-row').length === 4, 'в списке четыре строки');
    ok(d.querySelectorAll('.wxp-cols .wxp-col').length === 4, 'заголовки столбцов на месте');
    ok([...d.querySelectorAll('.wxp-col')].map(x => x.textContent.replace(/[▴▾]/g, '')).join('|') === 'Название|Дата изменения|Тип|Размер',
      'столбцы читаются как в Windows: Название · Дата изменения · Тип · Размер');
    ok(names().join(' / ') === 'Фото / beach.jpg / notes.txt / song.mp3', `папка сверху, дальше по имени (${names().join(' / ')})`);
    ok(d.querySelectorAll('#disk-list .wxp-ic svg').length === 4, 'у каждой строки свой значок (SVG)');
    ok(/ffcf4d/.test(d.querySelector('#disk-list .wxp-ic svg').outerHTML), 'у папки жёлтый значок, как в проводнике');
    ok([...d.querySelectorAll('#disk-list .wxp-type')].map(x => x.textContent).join(' / ')
      === 'Папка с файлами / JPG-изображение / TXT-файл / MP3-файл', 'типы подписаны по-русски');
    ok(d.querySelector('#disk-list .wxp-date').textContent === '—', 'у папки даты нет — прочерк');
    ok([...d.querySelectorAll('#disk-list .wxp-date')].slice(1).every(x => /^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}$/.test(x.textContent)),
      'у файлов видна дата изменения');
    ok(/Элементов: 4/.test(d.querySelector('.wxp-status').textContent), 'внизу написано, сколько элементов');
    ok(!!d.querySelector('#dsk-up') && !!d.querySelector('#disk-refresh') && !!d.querySelector('.wxp-addr .dk-crumb'),
      'сверху стрелка «наверх», «обновить» и адресная строка с крошками');
    ok(/Новая папка/.test(d.querySelector('.wxp-tools').textContent), 'панель действий на месте (новая папка, загрузка, удалить)');
    ok(d.querySelector('#modal').classList.contains('dsk-modal'), 'окно помечено широким — столбцы не сжимаются');

    // щелчок по заголовку столбца — сортировка, повторный — наоборот
    const click = el => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    click(d.querySelector('[data-dsk-sort="size"]'));
    ok(names().join(' / ') === 'Фото / notes.txt / beach.jpg / song.mp3', `по размеру от меньшего (${names().join(' / ')})`);
    click(d.querySelector('[data-dsk-sort="size"]'));
    ok(names().join(' / ') === 'Фото / song.mp3 / beach.jpg / notes.txt', `повторный щелчок переворачивает порядок (${names().join(' / ')})`);
    click(d.querySelector('[data-dsk-sort="date"]'));
    ok(names().join(' / ') === 'Фото / notes.txt / beach.jpg / song.mp3', `по дате — от старых к новым (${names().join(' / ')})`);
    click(d.querySelector('[data-dsk-sort="date"]'));
    ok(names().join(' / ') === 'Фото / song.mp3 / beach.jpg / notes.txt', 'и повторный щелчок ставит свежие сверху');
    ok(names()[0] === 'Фото', 'папка остаётся сверху при любой сортировке');

    // выбор строки — светло-синяя подсветка, как в проводнике
    click(d.querySelectorAll('#disk-list .disk-row')[1]);
    ok(!!d.querySelector('#disk-list .disk-row.sel'), 'щелчок по строке выделяет её');

    // сама функция сортировки — отдельно, без окна
    const items = [{ name: 'б', dir: false, size: 1, modified: '2026-01-01' }, { name: 'а', dir: false, size: 9, modified: '2026-02-02' }, { name: 'Папка', dir: true, size: 0 }];
    ok(sega.dkSortItems(items, 'name', 1)[0].name === 'Папка', 'dkSortItems: папки всегда первыми');
    ok(sega.dkSortItems(items, 'size', -1).map(x => x.name).join(',') === 'Папка,а,б', 'dkSortItems: по размеру от большего');
    ok(sega.dkSortItems(items, 'date', 1).map(x => x.name).join(',') === 'Папка,б,а', 'dkSortItems: по дате от старых');
    ok(sega.dkTypeName({ name: 'a.mp3', media: 'audio' }) === 'MP3-файл' && sega.dkTypeName({ dir: true }) === 'Папка с файлами',
      'dkTypeName: «MP3-файл» и «Папка с файлами»');
    ok(sega.dkWhen('') === '—' && /^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}$/.test(sega.dkWhen('2026-11-05T10:00:00Z')),
      'dkWhen: пустая дата — прочерк, иначе дата и время');
  }
  try { dom.window.close(); } catch (e) {}
}

/* ── 4. Отметки выпуска ─────────────────────────────────────────────────── */
console.log('\n  4. Отметки выпуска');
const appBuild = (/const BUILD = '([^']+)'/.exec(appJs) || [])[1];
const cache = (/const STATIC_CACHE = '([^']+)'/.exec(read('public/sw.js')) || [])[1];
ok(appBuild === BUILD && BUILD === 'pkg3-145', `отметка выпуска одна (${BUILD})`);
ok(((/const BUILD = '([^']+)'/.exec(read('lib/api.js')) || [])[1]) === BUILD, 'BUILD в lib/api.js тот же');
ok(cache === 'sega-static-v139', `кэш оформления поднят (${cache}) — устройства получат новое окно`);
ok(/\| pkg3-145 \|/.test(read('README.md')), 'в журнале README есть строка pkg3-145');
ok(read('package.json').includes('node test/ui144.mjs'), 'тест ui144 включён в цепочку npm test');

console.log(`\n  ИТОГ: ${good} ✓, ${bad ? bad + ' провалов' : 'провалов нет'}\n`);
process.exit(bad ? 1 : 0);
