// test/ui148.mjs — pkg3-148: вес фотографий из писем и размер программы.
//
// Владелец после 147-го сказал две вещи:
//   1) «всё равно не показывает объём, занятый фотографиями» — потому что фото
//      не загружается файлом: клиент сжимает снимок и кладёт его ВНУТРЬ письма,
//      письмо шифруется целиком, и сервер видел только размер письма. Теперь
//      устройство, расшифровавшее письмо, сообщает серверу одну необязательную
//      мелочь: «в этом письме фото на N байт, штук M» (ни текста, ни снимка).
//      Сервер вычитает этот вес из «Писем» и прибавляет к «Фотографиям».
//   2) «хочется видеть, сколько занимает само программное обеспечение со всеми
//      обновлениями» — сервер считает папку программы: код, библиотеки и историю
//      обновлений (`.git`), и показывает это в пульте.
import { BUILD } from './build.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let good = 0, bad = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ПРОВАЛ: ') + m); if (c) good++; else bad++; };

console.log('\n══════════════════════════════════════════════════');
console.log('  pkg3-148: фотографии в письмах и размер программы');
console.log('══════════════════════════════════════════════════\n');

const appJs = read('public/app.js');
const apiJs = read('lib/api.js');

/* ── 1. Как считается вес фото в письме ─────────────────────────────────── */
console.log('  1. Вес фотографии из письма');
ok(/function attPhotoStats\(p\) \{/.test(appJs), 'есть расчёт веса фото в письме');
ok(/if \(!a \|\| a\.kind !== 'image' \|\| !a\.data\) return null;/.test(appJs), 'берётся только картинка внутри письма');
ok(/return \{ ph: bytes, pn: 1 \};/.test(appJs), 'наружу уходит только вес и число — без самого снимка');
ok(/const phStat = attPhotoStats\(payload\);/.test(appJs), 'при отправке письма с фото вес считается сразу');
ok(/Object\.assign\(\{ blob, chat: c\.id, parent: parent \|\| null, quote: quote \|\| null, payload \}, phStat \|\| \{\}\)/.test(appJs),
  'и уходит на сервер вместе с письмом (ph/pn)');

/* ── 2. Досчёт для старых писем ─────────────────────────────────────────── */
console.log('\n  2. Досчёт для уже отправленных писем');
ok(/async function attReport\(force\)/.test(appJs), 'есть тихий досчёт по расшифрованным письмам');
ok(/api\('\/api\/messages\/att', \{ method: 'POST', body: \{ items \} \}\)/.test(appJs), 'он отправляется пачками на сервер');
ok(/const ATT_DONE_KEY = 'sega\.attReported\.v1';/.test(appJs), 'сделанное помнится на устройстве (без повторов)');
ok(/if \(attTimer\) return;/.test(appJs) && /setTimeout\(\(\) => \{ attTimer = 0; attReport\(\)/.test(appJs),
  'после расшифровки пачки писем досчёт запускается сам, с задержкой');
ok(/await attReport\(true\);/.test(appJs), 'перед показом пульта памяти сводка досчитывается');

/* ── 3. Сервер: письмо хранит метку и раскладывает её ───────────────────── */
console.log('\n  3. Сервер');
ok(/pathname === '\/api\/messages\/att' && method === 'POST'/.test(apiJs), 'есть приём отчёта о фото в письмах');
ok(/if \(!chat \|\| !isMember\(chat, me\.id\)\) continue;/.test(apiJs), 'принимается только от участника чата');
ok(/if \(\(m\.ph \|\| 0\) === ph && \(m\.pn \|\| 0\) === \(pn \|\| 1\)\) continue;/.test(apiJs),
  'повторный такой же отчёт ничего не переписывает');
ok(/const phIn = \{ bytes: 0, count: 0 \};/.test(apiJs), 'сводка собирает вес фото из писем');
ok(/cats\.messages\.bytes = Math\.max\(0, cats\.messages\.bytes - phIn\.bytes\);/.test(apiJs),
  'и вычитает его из «Писем» — двойного счёта нет');
ok(/cats\.photos\.bytes \+= phIn\.bytes;/.test(apiJs) && /cats\.photos\.inline = \{ bytes: phIn\.bytes, count: phIn\.count \};/.test(apiJs),
  'а прибавляет к «Фотографиям», отдельно помечая «внутри писем»');
ok(/const ph = Math\.max\(0, Math\.min\(60 \* MB, Math\.floor\(Number\(b\.ph\) \|\| 0\)\)\);/.test(apiJs),
  'вес при отправке ограничен разумными пределами');

/* ── 4. Размер программы ────────────────────────────────────────────────── */
console.log('\n  4. Размер самой программы');
ok(/function programBreakdown\(\)/.test(apiJs), 'сервер считает папку программы');
ok(/if \(path2\.resolve\(full\) === skip\) continue;/.test(apiJs), 'папка с данными в неё не попадает (не двойной счёт)');
ok(/ent\.name === 'node_modules' \? 'libs' : \(ent\.name === '\.git' \? 'git' : ''\)/.test(apiJs),
  'библиотеки и история обновлений считаются отдельно');
ok(/program: programBreakdown\(\)/.test(apiJs), 'сводка отдаёт размер программы клиенту');
ok(/progCache\.data && Date\.now\(\) - progCache\.ts < 10 \* 60 \* 1000/.test(apiJs),
  'итог держится 10 минут — обход тяжёлый');
ok(/Программа \(код, библиотеки, история обновлений\): /.test(appJs), 'в пульте есть строка про программу');
ok(/история обновлений \$\{stMB\(pr\.git\)\}/.test(appJs), 'и отдельно — история обновлений');

/* ── 5. Окно «Фотографии» ───────────────────────────────────────────────── */
console.log('\n  5. Честные подписи и окно «Фотографии»');
ok(/photos: 'Фотографии \(в письмах и файлом\)'/.test(appJs), 'сектор называется «Фотографии (в письмах и файлом)»');
ok(/function stInlinePhotoHtml\(d\)/.test(appJs), 'под легендой есть строка «Фотографии в письмах»');
ok(/Фотографии в письмах: \$\{stMB\(inl\.bytes\)\} \(\$\{inl\.count\} шт\.\)/.test(appJs), 'с весом и числом снимков');
ok(/Внутри писем: \$\{stMB\(inl\.bytes\)\} \(\$\{inl\.count\} фото\)/.test(appJs),
  'и в окне «Фотографии» сказано, что часть снимков лежит в переписке');

/* ── 5б. Музыка с Дисков: два пути и старый номер ──────────────────────── */
console.log('\n  5б. Музыка с Дисков');
ok(/await startIt\(musProxyHref\(href, ticket\.t\)\)/.test(appJs),
  'если прямая ссылка не сработала — используем поток через сервер, а не JSON');
ok(/problems\.push\('прямая ссылка: '/.test(appJs) && /problems\.push\('через сервер: '/.test(appJs),
  'в отказе видны обе причины по-русски');
ok(/за 12 секунд звук не пошёл/.test(appJs), 'зависшая ссылка не держит очередь: 12 секунд и дальше');
ok(/function resolvedSlot\(u, kind, slot\)/.test(apiJs), 'сервер умеет играть файл с единственного диска, даже если номер в пути старый');
ok(/return live\.length === 1 \? live\[0\]\.slot : n;/.test(apiJs), 'подмена только когда диск этого вида ровно один');

/* ── 6. Отметки выпуска ─────────────────────────────────────────────────── */
console.log('\n  6. Отметки выпуска');
const cache = (/const STATIC_CACHE = '([^']+)'/.exec(read('public/sw.js')) || [])[1];
ok(((/const BUILD = '([^']+)'/.exec(appJs) || [])[1]) === BUILD && /^pkg3-\d{3}$/.test(BUILD),
  `отметка выпуска одна (${BUILD})`);
ok(((/const BUILD = '([^']+)'/.exec(apiJs) || [])[1]) === BUILD, 'BUILD в lib/api.js тот же');
ok(/^sega-static-v\d+$/.test(cache) && Number(cache.split('-v')[1]) >= 142, `кэш оформления поднят (${cache})`);
ok(/\| pkg3-148 \|/.test(read('README.md')), 'в журнале README есть строка pkg3-148');
ok(read('package.json').includes('node test/ui148.mjs'), 'тест ui148 включён в цепочку npm test');

/* ── 7. Живая проверка в jsdom ──────────────────────────────────────────── */
console.log('\n  7. Живая проверка: расчёт веса и отправка отчёта');
let JSDOM = null;
try { ({ JSDOM } = await import('jsdom')); } catch (e) {}
if (!JSDOM) {
  console.log('  ⚠ пропущено: нет jsdom (`npm install`)');
} else {
  process.on('unhandledRejection', () => {});
  const dom = new JSDOM(read('public/index.html'), { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const calls = [];
  w.fetch = async (url, opts) => {
    calls.push({ url: String(url), body: opts && opts.body ? String(opts.body) : '' });
    return { ok: true, status: 200, headers: { get: () => 'application/json' },
      json: async () => ({ saved: 1 }), text: async () => '{}' };
  };
  w.matchMedia = w.matchMedia || (q => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  let loadErr = null;
  try {
    w.eval(appJs + '\n;window.__sega={S,MUS,attPhotoStats,attReport,attDoneSet,attDoneSave,stInlinePhotoHtml,stLegendHtml,stDiskHtml,ST_LABEL,musicStartDiskTrack};');
  } catch (e) { loadErr = e; }
  const sega = w.__sega;
  ok(!loadErr && !!sega, 'клиент загружается' + (loadErr ? ' (' + loadErr.message + ')' : ''));
  if (sega) {
    const st = sega.attPhotoStats({ att: { kind: 'image', data: 'x'.repeat(1234) } });
    ok(st && st.ph === 1234 && st.pn === 1, 'вес снимка в письме посчитан');
    ok(sega.attPhotoStats({ att: { kind: 'file', data: 'x'.repeat(10) } }) === null, 'файл (не картинка) не считается фото');
    ok(sega.attPhotoStats({ text: 'привет' }) === null, 'обычный текст — не фото');

    sega.S.me = { id: 'u1' };
    sega.S.plain = new Map([
      ['m1', { text: '', att: { kind: 'image', data: 'a'.repeat(2000) } }],
      ['m2', { text: 'просто текст' }],
      ['tmp1', { att: { kind: 'image', data: 'b'.repeat(50) } }]
    ]);
    sega.attDoneSave(new Set());
    const saved = await sega.attReport(true);
    const attCall = calls.find(c => c.url.includes('/api/messages/att'));
    ok(!!attCall, 'отчёт ушёл на сервер');
    const body = attCall ? JSON.parse(attCall.body) : { items: [] };
    ok(body.items.length === 1 && body.items[0].id === 'm1' && body.items[0].ph === 2000,
      'в отчёт попало только письмо с фото (и не черновик tmp)');
    ok(saved >= 0, 'досчёт не падает');

    const legend = sega.stLegendHtml({
      cats: { messages: { bytes: 1, count: 1 }, photos: { bytes: 2 * 1048576, count: 4, inline: { bytes: 1048576, count: 3 } },
        media: { bytes: 0, count: 0 }, files: { bytes: 0, count: 0 }, other: { bytes: 0, count: 0 } }, free: 1
    });
    ok(/Фотографии \(в письмах и файлом\)/.test(legend), 'в легенде фото подписаны честно');
    const line = sega.stInlinePhotoHtml({ cats: { photos: { bytes: 2 * 1048576, count: 4, inline: { bytes: 1048576, count: 3 } } } });
    ok(/Фотографии в письмах: 1\.0 МБ \(3 шт\.\)/.test(line), 'строка «в том числе в письмах» с весом и числом');
    ok(sega.stInlinePhotoHtml({ cats: { photos: { bytes: 0, count: 0 } } }) === '', 'нет фото в письмах — строки нет');

    // pkg3-148: музыка с Диска — прямая ссылка не сработала, играем через сервер
    calls.length = 0;
    const musicFetch = async (url, opts) => {
      const u = String(url);
      calls.push({ url: u, body: opts && opts.body ? String(opts.body) : '' });
      if (u.includes('/api/yadisk/href')) {
        return { ok: true, status: 200, headers: { get: () => 'application/json' },
          json: async () => ({ href: 'https://audio.yandex.net/track.mp3' }), text: async () => '' };
      }
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ t: 'ticket148' }), text: async () => '{}' };
    };
    w.fetch = musicFetch;
    sega.S.me = { id: 'u1' };
    sega.S.drives = [];
    // в jsdom нет настоящего <audio> — подставляем простой двойник
    sega.MUS.a = { src: '', paused: true, pause() {}, load() {}, play() { return this.src.startsWith('https:') ? Promise.reject(new Error('прямой адрес недоступен')) : Promise.resolve(); },
      addEventListener() {}, removeEventListener() {}, currentTime: 0 };
    const trk = { kind: 'disk', path: 'disk2:/Музыка/трек.mp3', title: 'трек', diskOf: 'u1' };
    sega.MUS.list = [trk]; sega.MUS.idx = 0;
    try { await sega.musicStartDiskTrack(trk); } catch (e) { /* отказы проверяем ниже */ }
    const src = String(sega.MUS.a.src || '');
    ok(src.includes('/api/musstream?t=ticket148'), 'плеер перешёл на настоящий поток через сервер');
    ok(calls.some(c => c.url.includes('/api/yadisk/href') && c.url.includes(encodeURIComponent('disk2:/Музыка/трек.mp3'))), 'и попросил именно тот файл');

    const disk = sega.stDiskHtml({
      used: 1, disk: { total: 4e10, used: 1e10, free: 3e10 },
      folder: { bytes: 5 * 1048576, files: 10, db: 3 * 1048576, uploads: 1048576, archives: 0, other: 0 },
      program: { bytes: 120 * 1048576, total: 120 * 1048576, code: 20 * 1048576, libs: 80 * 1048576, git: 20 * 1048576 }
    });
    ok(/Программа \(код, библиотеки, история обновлений\): 120\.0 МБ/.test(disk), 'в пульте видно размер программы');
    ok(/код 20\.0 МБ/.test(disk) && /библиотеки 80\.0 МБ/.test(disk) && /история обновлений 20\.0 МБ/.test(disk),
      'и из чего она состоит');
  }
  try { dom.window.close(); } catch (e) {}
}

console.log(`\n  ИТОГ: ${good} ✓, ${bad ? bad + ' провалов' : 'провалов нет'}\n`);
process.exit(bad ? 1 : 0);
