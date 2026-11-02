// test/ui109.mjs — pkg3-109: три пожелания владельца.
//
//   1. Меню «+» больше не сливается с фоном: своя подложка, синяя рамка,
//      заголовок «Быстрые действия», пункты-карточки; на телефоне список чатов
//      под меню приглушается, и видно: меню открыто.
//   2. На телефоне окно «Моя музыка» — настоящий плеер: разворот на весь экран,
//      список треков прокручивается внутри, кнопки и перемотка всегда на виду.
//   3. Место под обложку вдвое ниже и разделено по вертикали: слева обложка
//      трека, справа живая картинка. Играет музыка — картинка движется, пауза —
//      стоит неподвижный кадр.
//
// Проверки читают настоящие файлы программы; отдельных зависимостей нет.

import { readFileSync, statSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { BUILD } from './build.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PUB = join(ROOT, 'public');
const read = p => readFileSync(p, 'utf8');
const html = read(join(PUB, 'index.html'));
const css = read(join(PUB, 'styles.css'));
const app = read(join(PUB, 'app.js'));
const api = read(join(ROOT, 'lib', 'api.js'));
const sw = read(join(PUB, 'sw.js'));

let good = 0, bad = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ПРОВАЛ: ') + m); if (c) good++; else bad++; };
const size = p => (existsSync(p) ? statSync(p).size : -1);

console.log('\n══════════════════════════════════════════════════');
console.log('  pkg3-109: меню «+», плеер на телефоне, обложка с живой картинкой');
console.log('══════════════════════════════════════════════════\n');

// ─────────────────────────── 1. меню «+» стало контрастным
console.log('  1. Меню «+» видно сразу');
const pmCss = (/\.plus-menu\{[^}]*\}/.exec(css) || [''])[0];
ok(/\.plus-menu\{/.test(pmCss), 'правило меню «+» на месте');
ok(/\.rail-search\{[^}]*position:relative/s.test(css), 'меню привязано к строке поиска — падает прямо под кнопку «+», а не в случайное место');
ok(/background:var\(--bg\)/.test(pmCss), 'у меню своя подложка (серый фон приложения, а не цвет колонки)');
ok(/border:2px solid var\(--accent\)/.test(pmCss), 'заметная синяя рамка вокруг меню');
ok(/box-shadow:0 24px 52px/.test(pmCss), 'глубокая тень — меню «висит» над списком, а не растворяется в нём');
ok(/<div class="pm-head">Быстрые действия<\/div>/.test(html), 'в меню появился заголовок «Быстрые действия»');
const plusItems = ['data-plus="game"', 'data-plus="group"', 'data-plus="invite"', 'data-plus="section"', 'data-plus="music"'];
ok(plusItems.every(x => html.includes(x)), 'все пять пунктов меню на месте');
ok(/\.plus-menu button\{[^}]*background:var\(--panel\)/s.test(css), 'пункты меню — карточки-строки, а не прозрачный текст');
ok(/\.plus-menu button:hover[^{]*\{[^}]*background:var\(--accent-soft\)/s.test(css), 'наведение подсвечивает пункт');
ok(/#btn-plus\[aria-expanded="true"\]\{[^}]*background:#16386e/s.test(css), 'кнопка «+» выглядит нажатой, пока меню открыто');
const railBody = html.slice(html.indexOf('<aside id="rail">'), html.indexOf('</aside>'));
ok(/<div id="plus-scrim" aria-hidden="true"><\/div>/.test(railBody), 'приглушение #plus-scrim живёт внутри шторки чатов');
ok(/#plus-scrim\{display:none\}/.test(css), 'на компьютере приглушения нет (меню и так контрастное)');
const mobileCss = css.split('@media (max-width:900px){').slice(1).join('');
ok(/#plus-scrim\.on\{opacity:1;pointer-events:auto\}/.test(mobileCss), 'на телефоне приглушение включается вместе с меню');
ok(/sc\.classList\.toggle\('on', !!open\);/.test(app), 'открытие/закрытие меню включает и гасит приглушение');
ok(/\$\('#plus-scrim'\)\.addEventListener\('click', \(\) => plusMenu\(false\)\);/.test(app), 'касание приглушённого места закрывает меню');

// ─────────────────────────── 2. «Моя музыка» на телефоне — плеер
console.log('\n  2. Окно «Моя музыка» на телефоне — как плеер');
ok(/function modal\(title, html, opts\)/.test(app), 'окно умеет получать свою пометку (третьим доводом)');
ok(/md\.classList\.add\(opts\.cls\)/.test(app) && /md\.classList\.remove\('mus-modal'\)/.test(app),
  'пометка ставится окну музыки и снимается у прочих окон');
ok(/\{ cls: 'mus-modal' \}\)/.test(app), 'окно «Моя музыка» открывается с этой пометкой');
ok(/#modal\.mus-modal \.modal-box\{[^}]*height:100dvh/s.test(css), 'на телефоне окно музыки занимает весь экран');
ok(/#modal\.mus-modal \.modal-body\{[^}]*overflow:hidden/s.test(css), 'внутри окна прокручивается только список, а не всё окно');
ok(/#modal\.mus-modal \.modal-body > \.mus-wrap\.mus-v105\{[^}]*flex-flow:column nowrap/s.test(css),
  'окно разложено колонкой без переноса: обложка → список → кнопки (pkg3-111)');
ok(/#modal\.mus-modal \.mus-list\{flex:1 1 0/.test(css), 'список треков забирает остаток высоты (pkg3-111)');
ok(/#modal\.mus-modal \.mus-list\{[^}]*min-height:0/s.test(css), 'список треков занимает всё свободное место (и может ужаться)');
ok(/#modal\.mus-modal \.mus-list\{[^}]*overflow-y:auto/s.test(css), 'длинный список прокручивается внутри себя');
ok(/#modal\.mus-modal \.mus-playbig\{width:(60|62)px/.test(css) && /#modal\.mus-modal \.mus-skip\{width:60px/.test(css),
  'кнопки ▶/❚❚ и перемотка остаются на виду и стали удобнее для пальца');
ok(!/^\s*\.modal-box\{[^}]*height:100dvh/m.test(css), 'прочие окна (настройки, приглашения) не тронуты');

// ─────────────────────────── 3. обложка: вдвое ниже и две половины
console.log('\n  3. Обложка: половина высоты, две половины по вертикали');
ok(/<div class="mus-cov-left" id="mus-cover-img"><\/div>/.test(app), 'слева — половина под обложку трека');
ok(/<div class="mus-viz" id="mus-viz"><img class="mus-viz-still" src="img\/music-viz-still.png" alt=""><\/div>/.test(app),
  'справа — половина под живую картинку (неподвижный кадр лежит под анимацией)');
const boxAt = app.indexOf('<div class="mus-coverbox">');
ok(boxAt > 0 && !app.includes('id="mus-cover-cap"'), 'подписи «Сейчас играет» под блоком нет (pkg3-111: по просьбе владельца убрана как дублирование)');
const covCss = (/\.mus-v105 \.mus-coverbox\{[^}]*\}/.exec(css) || [''])[0];
ok(/grid-template-columns:1fr 1fr/.test(covCss), 'блок делится на две равные половины по вертикали');
ok(/aspect-ratio:2\/1/.test(covCss), 'высота блока — половина ширины (было 1/1 — квадрат во весь экран)');
ok(/max-height:26vh/.test(covCss) && !/max-height:44vh/.test(covCss), 'потолок высоты снижен с 44vh до 26vh — место стало вдвое ниже');
ok(!/aspect-ratio:1\/1/.test(covCss), 'прежняя квадратная обложка не вернулась');
ok(/\.mus-v105 \.mus-cov-left img[^{]*\{[^}]*object-fit:cover/.test(css.replace(/\s+/g, ' ')),
  'обложка заполняет свою половину без искажений');

// ─────────────────────────── 4. живая картинка: движется вместе со звуком
console.log('\n  4. Живая картинка: движется, пока играет музыка');
const gif = join(PUB, 'img', 'music-viz.gif');
const webp = join(PUB, 'img', 'music-viz.webp');
const still = join(PUB, 'img', 'music-viz-still.png');
ok(existsSync(gif) && existsSync(webp) && existsSync(still), 'картинки на месте: gif, лёгкая webp-анимация и неподвижный кадр');
ok(size(gif) > 1000 && size(gif) < 400 * 1024, `gif не тяжелее 400 КБ (${Math.round(size(gif) / 1024)} КБ)`);
ok(size(webp) > 1000 && size(webp) < 120 * 1024, `webp-анимация лёгкая (${Math.round(size(webp) / 1024)} КБ) — её и получат телефоны`);
ok(size(still) > 1000 && size(still) < 60 * 1024, `неподвижный кадр лёгкий (${Math.round(size(still) / 1024)} КБ)`);
const gifBuf = readFileSync(gif);
ok(gifBuf.slice(0, 6).toString() === 'GIF89a', 'gif — настоящий GIF');
const gw = gifBuf.readUInt16LE(6), gh = gifBuf.readUInt16LE(8);
ok(gw === gh && gw >= 160, `кадр квадратный ${gw}×${gh} — ровно по размеру половины блока`);
ok(/const MUS_VIZ_ANIM = '<picture class="mus-viz-anim">'/.test(app), 'живая картинка вставляется как <picture>');
ok(/<source srcset="img\/music-viz\.webp" type="image\/webp">/.test(app) && /<img src="img\/music-viz\.gif"/.test(app),
  'сначала лёгкая webp-анимация, запасной путь — gif для старых устройств');
ok(/function musVizSync\(\)/.test(app), 'есть отдельная сверка «играет / стоит» (musVizSync)');
ok(/const playing = !!a && !a\.paused && !a\.ended && !MUS\.widget && !S\.eco;/.test(app),
  'картинка движется только когда звук действительно играет (и не в эконом-режиме)');
ok(/else if \(anim\) anim\.remove\(\);/.test(app),
  'на паузе анимация убирается совсем — картинка честно замирает и не крутится вхолостую');
ok(/MUS\.a\.addEventListener\('play', musVizSync\)/.test(app) && /MUS\.a\.addEventListener\('pause', musVizSync\)/.test(app)
  && /MUS\.a\.addEventListener\('ended', musVizSync\)/.test(app),
  'сверка срабатывает на «играть», «пауза» и «трек кончился»');
ok(/musVizSync\(\);\s+\/\/ pkg3-109: картинка оживает вместе со звуком/.test(app),
  'и на каждом тике звука — переключение трека не оставляет картинку в неверном виде');
ok(/musicNowUi\(\); musicTickUi\(\); musVizSync\(\);/.test(app), 'при открытии окна картинка сразу в верном состоянии');

// ─────────────────────────── 5. отметки выпуска
console.log('\n  5. Отметки выпуска');
const b2 = /const BUILD = '([^']+)'/.exec(app)[1];
const cache = /const STATIC_CACHE = '([^']+)'/.exec(sw)[1];
ok(b2 === BUILD, `отметка выпуска совпадает в сервере и клиенте (${BUILD})`);
ok(/const BUILD = '([^']+)'/.exec(api)[1] === BUILD, 'BUILD в lib/api.js тот же');
ok(new RegExp('\\| ' + BUILD + ' \\|').test(read(join(ROOT, 'README.md'))), `в журнале README есть строка выпуска ${BUILD}`);
ok(cache !== 'sega-static-v101', `кэш оформления поднят (${cache}) — устройства получат новый вид`);
ok(readdirSync(join(PUB, 'img')).some(f => f === 'music-viz.webp'), 'картинки лежат в public/img и уедут вместе с программой');

console.log(`\n  ИТОГ: ${good} ✓, ${bad ? bad + ' провалов' : 'провалов нет'}\n`);
process.exit(bad ? 1 : 0);
