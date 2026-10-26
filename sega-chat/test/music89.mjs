/**
 * pkg3-89: «Моя музыка» — починка окна: кнопки снова живые.
 *
 * Беда pkg3-88, найденная владельцем: окно «Моя музыка» открывалось, список и
 * кнопка «▶» работали, НО «Добавить», «▶ / ⏸», перемотка, громкость, «вместе»,
 * «правка» и «×» молчали. Причина: цикл навешивания слушателей был написан как
 * `for (const b of $('#modal [data-mus-edit]'))` — ОДИН доллар вместо двух.
 * `$` отдаёт один элемент (или null), а `for…of` по элементу падает с
 * TypeError — и всё, что стояло в openMusic НИЖЕ этой строки, оставалось без
 * слушателей. Та же болезнь с выпуска 82 жила в окне результатов «Сталкера»
 * (чипы забегов соло). Лечение: три строки переведены на `$$`.
 *
 * Поэтому тест двойной:
 *   1) «умная вставка» по-прежнему понимает ссылки Яндекс.Музыки, включая
 *      новые формы: плейлист через /users/<логин>/playlists/<номер> (именно её
 *      даёт «Поделиться» из приложения) и зеркала домена (m.music.yandex.ru,
 *      music.yandex.com и региональные) — плеер при этом собирается ВСЕГДА
 *      только на https://music.yandex.ru/iframe/;
 *   2) СТАТИЧЕСКИЙ СТОРОЖ: в public/app.js больше НЕТ ни одного цикла
 *      `for (… of $(…) )` — класс ошибки, из-за которой кнопки молчали,
 *      не должен вернуться ни в музыке, ни в «Сталкере», ни где ещё.
 *
 * Запуск: node test/music89.mjs
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const MP = require(path.join(ROOT, 'public', 'music-paste.js'));

const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const appJs = read('public/app.js');
const apiJs = read('lib/api.js');
const pasteJs = read('public/music-paste.js');
const css = read('public/styles.css');
const sw = read('public/sw.js');
const html = read('public/index.html');
const pkg = read('package.json');
const readme = read('README.md');
const dom42 = read('test/dom42.mjs');
const sound80 = read('test/sound80.mjs');
const games81 = read('test/games81.mjs');

let good = 0, bad = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ПРОВАЛ: ') + m); if (c) good++; else bad++; };
void crypto;

console.log('\n  Моя музыка pkg3-89: ссылки Яндекса новых форм');

// ── 1. Плейлист через /users/<логин>/playlists/<номер> — так «Поделиться» ──
let r = MP.parsePaste('https://music.yandex.ru/users/sasha.pilipenko/playlists/1016');
ok(r.kind === 'widget' && r.what === 'playlist', 'ссылка «Поделиться» на плейлист (/users/…/playlists/…) стала виджетом');
ok(r.what === 'playlist' && r.ids && r.ids.join('/') === 'sasha.pilipenko/1016', 'логин и номер плейлиста взяты верно: ' + (r.ids || []).join('/'));
ok(r.url === 'https://music.yandex.ru/iframe/#playlist/sasha.pilipenko/1016/', 'адрес плеера собран на белом домене: ' + r.url);

r = MP.parsePaste('https://music.yandex.ru/users/sasha.pilipenko/playlists/1016/?si=abc123');
ok(r.kind === 'widget' && r.what === 'playlist', 'хвост /?si=… и косая черта не мешают понять плейлист');

r = MP.parsePaste('https://music.yandex.ru/users/sasha.pilipenko/playlists');
ok(r.kind === 'page' && /Яндекс\.Музыки/.test(r.hint), '«/users/…/playlists» БЕЗ номера — честное «это страница, плеер не собирается»');

// ── 2. Зеркала домена: приложение и регионы дают не только music.yandex.ru ──
r = MP.parsePaste('https://m.music.yandex.ru/album/31462411/track/128746321');
ok(r.kind === 'widget' && r.what === 'track', 'мобильное зеркало m.music.yandex.ru понято как трек');
r = MP.parsePaste('https://music.yandex.com/track/128746321');
ok(r.kind === 'widget' && r.what === 'track', 'международный music.yandex.com понятен как трек');
r = MP.parsePaste('https://music.yandex.by/artist/32145');
ok(r.kind === 'widget' && r.what === 'artist', 'региональное зеркало music.yandex.by понято как артист');
for (const h of ['m.music.yandex.ru', 'music.yandex.com', 'music.yandex.by', 'music.yandex.kz', 'music.yandex.uz']) {
  const q = MP.parsePaste('https://' + h + '/album/5736287/track/67063213');
  if (!(q.kind === 'widget' && q.url.indexOf('https://music.yandex.ru/iframe/#track/67063213/') === 0)) {
    ok(false, 'зеркало ' + h + ' должно давать плеер на music.yandex.ru');
    break;
  }
  if (h === 'music.yandex.uz') ok(true, 'все пять зеркал дают плеер ВСЕГДА на music.yandex.ru (белый список не расширен)');
}
ok(Array.isArray(MP.Y_MIRRORS) && MP.Y_MIRRORS.indexOf('m.music.yandex.ru') >= 0, 'список зеркал экспортирован модулем (Y_MIRRORS)');

// ── 3. Регрессии 88-го: ничего из понятного раньше не сломалось ──
r = MP.parsePaste('https://music.yandex.ru/album/31462411/track/128746321?si=q8');
ok(r.kind === 'widget' && r.what === 'track', 'прежняя форма ссылки на трек работает');
r = MP.parsePaste('<iframe src="https://music.yandex.ru/iframe/#track/128746321/" width="100%"></iframe>');
ok(r.kind === 'widget' && r.from === 'iframe', '«код плеера» с <iframe> работает');
r = MP.parsePaste('https://cdn.example.com/songs/track.mp3');
ok(r.kind === 'file', 'прямая ссылка на файл по-прежнему файл');
r = MP.parsePaste('https://vk.com/wall-123_456');
ok(r.kind === 'page' && r.hint.length > 20, 'страница VK по-прежнему не трек, с объяснением');
r = MP.parsePaste('https://music.yandex.ru/track/128746321/light');
ok(r.kind === 'widget' && /light\/$/.test(r.url), 'облегчённый плеер (/light) собирается как прежде');
r = MP.parsePaste('https://music.yandex.ru.evil.com/track/1');
ok(r.kind !== 'widget', 'подделка music.yandex.ru.evil.com по-прежнему отбрасывается');

console.log('\n  Главная починка: циклы навешивания кнопок');

// ── 4. СТОРОЖ: for…of по ОДИНОЧНОМУ $ не должен вернуться никогда ──
const BAD_LOOP = /for\s*\(\s*(?:const|let|var)\s+[A-Za-z_$][\w$]*\s+of\s+\$\(/;
ok(!BAD_LOOP.test(appJs), 'в public/app.js нет ни одного цикла for…of по одиночному $ (класс беды pkg3-88)');
ok(appJs.includes("for (const b of $$('#modal [data-mus-edit]'))"), 'кнопки «правка» треков обходятся через $$ (список)');
ok(appJs.includes("for (const b of $$('#modal [data-mus-del]'))"), 'кнопки «×» треков обходятся через $$ (список)');
ok(appJs.includes("for (const chip of $$('#modal [data-coins-run]'))"), 'чипы забегов «Сталкера» обходятся через $$ (список)');
ok(appJs.includes("for (const b of $$('#modal [data-mus-play]'))"), 'кнопки «▶» треков по-прежнему через $$');
ok(!BAD_LOOP.test(pasteJs), 'в public/music-paste.js циклов по одиночному $ нет');

// ── 5. Слушатели плеера на месте: добавить, стоп, вместе ──
ok(appJs.includes("const addTr = $('#mus-add-tr');"), 'обработчик «Добавить» на месте');
ok(appJs.includes("if (tog) tog.addEventListener('click', () => {"), 'обработчик «▶ / ⏸» на месте');
ok(appJs.includes('if (MUS.widget) { musWidgetStop(); return; }'), '«■ стоп» для виджета Яндекса не потерялся');
ok(appJs.includes("const tgb = $('#mus-together');"), 'обработчик «🎧 вместе» на месте');
ok(appJs.indexOf("for (const b of $$('#modal [data-mus-edit]'))") < appJs.indexOf("const addTr = $('#mus-add-tr');"),
  'цикл правки треков стоит РАНЬШЕ обработчика «Добавить» — падение цикла больше не обесточит добавление');

console.log('\n  Метки выпуска и кэш');

// ── 6. BUILD, кэш, стили, цепочка тестов ──
ok(appJs.includes("const BUILD = 'pkg3-89';") && apiJs.includes("const BUILD = 'pkg3-89';"), 'BUILD pkg3-89 в обоих файлах');
ok(sw.includes("const STATIC_CACHE = 'sega-static-v82';"), 'кэш статики поднят до v82');
ok(dom42.includes('sega-static-v82') && sound80.includes('sega-static-v82') && games81.includes('sega-static-v82'),
  'три набора тестов ждут именно v82');
ok(css.includes('.mus-ctl .mini.primary{width:auto;margin-top:0}'), 'кнопка «▶ / ⏸» больше не растягивается на всю строку (⏮ не остаётся одна)');
ok(css.includes('.mus-add .mini.primary{width:100%;margin-top:0}'), '«Добавить» осталась широкой, но без лишнего отступа');
ok(css.includes('button.primary{width:100%;'), 'общее правило широкой кнопки не тронуто — прочие окна выглядят как прежде');
ok(pkg.includes('node test/music89.mjs') && pkg.includes('node test/music88.mjs'), 'цепочка тестов включает оба музыкальных набора');
ok(html.indexOf('src="music-paste.js"') < html.indexOf('src="app.js"'), 'модуль разбора ссылок подключён раньше app.js');
ok(readme.includes('| pkg3-89 |'), 'в журнале README есть строка выпуска pkg3-89');

console.log('\n  Итог: ' + good + ' ✓, ' + bad + ' провалов\n');
process.exit(bad ? 1 : 0);
