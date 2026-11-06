// test/ui147.mjs — pkg3-147: где лежат фотографии из чатов и почему
// в пульте памяти за них отвечал нулевой сектор «Фотографии».
//
// Правда про путь фотографии:
//   • клиент сжимает снимок в JPEG (resizeImage 1800 px) и кладёт его прямо
//     ВНУТРЬ письма (data-URL), а письмо шифруется целиком;
//   • значит на сервере фотография живёт в базе (data/db.json) вместе с письмом,
//     а не отдельным файлом вложений;
//   • отдельными файлами на сервер попадают только видео, музыка и документы
//     (uploadChunked → /api/upload/…).
// Отсюда и правка: подписи секторов стали честными («Письма (текст и фото
// внутри)», «Фото, загруженные файлом»), под кругом появилось объяснение и
// разбивка папки с данными: база / файлы вложений / архивы / прочее.
import { BUILD } from './build.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let good = 0, bad = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ПРОВАЛ: ') + m); if (c) good++; else bad++; };

console.log('\n══════════════════════════════════════════════════');
console.log('  pkg3-147: где фотографии и честные доли памяти');
console.log('══════════════════════════════════════════════════\n');

const appJs = read('public/app.js');
const apiJs = read('lib/api.js');

/* ── 1. Путь фотографии: внутрь письма, а не файлом ─────────────────────── */
console.log('  1. Фотография из чата едет внутри письма');
const attach = (/async function attachFile\(file, key\) \{[\s\S]*?\n\}/.exec(appJs) || [''])[0];
ok(/resizeImage\(file, 1800, 0\.82\)/.test(attach), 'снимок сжимается в JPEG 1800 px');
ok(/S\[key\] = \{ kind: 'image', data, name: file\.name \|\| 'фото'/.test(attach),
  'и кладётся в письмо как картинка (data-URL)');
ok(!/uploadChunked\(/.test(attach), 'обычное фото при отправке не грузится файлом на сервер');
ok(/kind, pending: true, file, name: file\.name \|\| kind, size: file\.size, mime/.test(attach),
  'файлом (через облако) уходят видео, музыка и документы');
ok(/if \(file\.size > 25 \* 1024 \* 1024\) return tooBigToast\(file, kind\)/.test(attach),
  'и у них есть предел 25 МБ');

/* ── 2. Сервер: разбивка папки с данными ────────────────────────────────── */
console.log('\n  2. Сервер объясняет, где мегабайты');
ok(/function dirBreakdown\(/.test(apiJs), 'есть разбивка папки с данными по смыслу');
ok(/else if \(\/\^db\\\.json\/\.test\(ent\.name\)\) out\.db \+= size;/.test(apiJs), 'база с письмами считается отдельно');
ok(/else if \(\/\^upmeta-\/\.test\(ent\.name\)\) out\.meta \+= size;/.test(apiJs), 'служебные описания загрузок — отдельно');
ok(/else if \(\/\^up-\/\.test\(ent\.name\)\) out\.uploads \+= size;/.test(apiJs), 'файлы вложений — отдельно');
ok(/if \(inArch\) out\.archives \+= size;/.test(apiJs), 'архивы чатов — отдельно');
ok(/folder: dirBreakdown\(\)/.test(apiJs), 'сводка отдаёт эту разбивку клиенту');
ok(/out\.bytes = out\.total;/.test(apiJs), 'и по-прежнему одно общее число размера папки');

/* ── 3. Подписи секторов говорят правду ─────────────────────────────────── */
console.log('\n  3. Подписи в пульте памяти');
const label = (/const ST_LABEL = \{[\s\S]*?\};/.exec(appJs) || [''])[0];
ok(/messages: 'Письма \(текст и фото внутри\)'/.test(label), '«Письма (текст и фото внутри)»');
ok(/photos: 'Фото, загруженные файлом'/.test(label), '«Фото, загруженные файлом»');
ok(/media: 'Видео и музыка'/.test(label) && /files: 'Документы и файлы'/.test(label),
  'видео/музыка и документы подписаны по-человечески');
ok(/other: 'Служебное \(аватары, копии, архивы, фоны\)'/.test(label), 'служебное перечислено полностью');

/* ── 4. Объяснение прямо в окне памяти ──────────────────────────────────── */
console.log('\n  4. Объяснение рядом с диаграммой');
ok(/Фотографии из чатов отправляются внутри письма/.test(appJs),
  'написано: фотографии летят внутри письма');
ok(/поэтому они входят в «Письма»/.test(appJs), 'и поэтому входят в долю «Письма»');
ok(/Отдельно файлами на сервер загружаются видео, музыка и документы/.test(appJs),
  'и что именно грузится файлами');
ok(/база с письмами \(и фото внутри них\) — /.test(appJs), 'под кругом видно размер базы с письмами');
ok(/файлы вложений \(видео, музыка, документы\) — /.test(appJs), 'и размер файлов вложений');
ok(/архивы чатов — /.test(appJs), 'и размер архивов');
ok(/Из них: /.test(appJs), 'всё это собрано в одну строку «Из них: …»');

/* ── 5. Отметки выпуска ─────────────────────────────────────────────────── */
console.log('\n  5. Отметки выпуска');
const cache = (/const STATIC_CACHE = '([^']+)'/.exec(read('public/sw.js')) || [])[1];
ok(((/const BUILD = '([^']+)'/.exec(appJs) || [])[1]) === BUILD && /^pkg3-1[4-9][0-9]$/.test(BUILD),
  `отметка выпуска одна (${BUILD})`);
ok(((/const BUILD = '([^']+)'/.exec(apiJs) || [])[1]) === BUILD, 'BUILD в lib/api.js тот же');
ok(/^sega-static-v\d+$/.test(cache) && Number(cache.split('-v')[1]) >= 141, `кэш оформления поднят (${cache})`);
ok(/\| pkg3-147 \|/.test(read('README.md')), 'в журнале README есть строка pkg3-147');
ok(read('package.json').includes('node test/ui147.mjs'), 'тест ui147 включён в цепочку npm test');

/* ── 6. Живая проверка окна памяти ──────────────────────────────────────── */
console.log('\n  6. Живая проверка: окно памяти');
let JSDOM = null;
try { ({ JSDOM } = await import('jsdom')); } catch (e) {}
if (!JSDOM) {
  console.log('  ⚠ пропущено: нет jsdom (`npm install`)');
} else {
  process.on('unhandledRejection', () => {});
  const dom = new JSDOM(read('public/index.html'), { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.fetch = async () => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({}), text: async () => '{}' });
  w.matchMedia = w.matchMedia || (q => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  let loadErr = null;
  try { w.eval(appJs + '\n;window.__sega={stLegendHtml,stDonutHtml,stDiskHtml,ST_LABEL};'); } catch (e) { loadErr = e; }
  const sega = w.__sega;
  ok(!loadErr && !!sega, 'клиент загружается' + (loadErr ? ' (' + loadErr.message + ')' : ''));
  if (sega) {
    const fake = {
      used: 12 * 1048576, limit: 4096 * 1048576, percent: 1, free: 4000 * 1048576,
      cats: {
        messages: { bytes: 8 * 1048576, count: 120 }, photos: { bytes: 0, count: 0 },
        media: { bytes: 2 * 1048576, count: 3 }, files: { bytes: 1048576, count: 2 },
        other: { bytes: 1048576, count: 4 }
      },
      disk: { total: 40 * 1073741824, used: 12 * 1073741824, free: 28 * 1073741824 },
      folder: { bytes: 12 * 1048576, total: 12 * 1048576, files: 30, db: 9 * 1048576, uploads: 2 * 1048576, meta: 1024, archives: 512 * 1024, other: 512 * 1024 }
    };
    const legend = sega.stLegendHtml(fake);
    ok(/Письма \(текст и фото внутри\)/.test(legend), 'легенда: письма явно с фото внутри');
    ok(/Фото, загруженные файлом/.test(legend), 'легенда: фото файлом — отдельная строка');
    const disk = sega.stDiskHtml(fake);
    ok(/база с письмами \(и фото внутри них\) — 9\.0 МБ/.test(disk), 'видно: база с письмами 9 МБ');
    ok(/файлы вложений \(видео, музыка, документы\) — 2\.0 МБ/.test(disk), 'видно: файлы вложений 2 МБ');
    ok(/архивы чатов — 0\.5 МБ/.test(disk), 'видно: архивы 0.5 МБ');
    ok(/Из них: /.test(disk), 'всё собрано в строку «Из них»');
    const bare = sega.stDiskHtml({ disk: fake.disk, used: fake.used });
    ok(!/Из них: /.test(bare), 'без разбивки строка не рисуется (старые данные не ломают окно)');
    const donut = sega.stDonutHtml(fake.cats, fake.free, 1);
    ok((donut.match(/<circle/g) || []).length === 5, 'круг рисует все непустые доли (фото нулевое — не рисуется)');
  }
  try { dom.window.close(); } catch (e) {}
}

console.log(`\n  ИТОГ: ${good} ✓, ${bad ? bad + ' провалов' : 'провалов нет'}\n`);
process.exit(bad ? 1 : 0);
