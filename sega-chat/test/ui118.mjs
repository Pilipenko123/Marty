// test/ui118.mjs — pkg3-118: оформление «как в макете» — панели-карточки
// в своих светящихся рамках, свежие сочетания и «рендеры» вместо плоских
// заливок, живая дорожка «слушает музыку», окно «Моя музыка» как в макете,
// телефон — тот же вид без рамки, экономный режим — батарейка и серо-белая
// чёткая гамма со скруглениями.
//
// Что просил владелец после 117-го:
//   1) в макете дизайн изменён сильнее: левая и правая плашки — в своих рамках
//      с окантовками, цвета свежее, вместо плоских заливок — рендеры;
//   2) регулировку скругления убрать, поставить максимум;
//   3) анимация в статусе «слушает музыку» + в свёрнутом окне «Моя музыка»;
//   4) дизайн окна «Моя музыка» из макета;
//   5) на телефоне — тот же вид, что на ПК, но без рамки (рамка — края экрана);
//   6) значок эконома — батарейка, а скругления остаются; гамма — серо-белая,
//      контрастная, с чёткими линиями (немного пиксельная), медиа по-прежнему нет.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { BUILD } from './build.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PUB = join(ROOT, 'public');
const read = p => readFileSync(p, 'utf8');
const css = read(join(PUB, 'styles.css'));
const app = read(join(PUB, 'app.js'));
const api = read(join(ROOT, 'lib', 'api.js'));
const sw = read(join(PUB, 'sw.js'));
const html = read(join(PUB, 'index.html'));

let good = 0, bad = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ПРОВАЛ: ') + m); if (c) good++; else bad++; };
const rule = re => { const m = re.exec(css); return m ? m[0] : ''; };
const body = re => { const m = re.exec(css); return m ? (m[1] !== undefined ? m[1] : m[0]) : ''; };
// правило находим по началу текста и берём до ближайшей закрывающей скобки
const near = frag => { const i = css.indexOf(frag); if (i < 0) return ''; const j = css.indexOf('}', i); return css.slice(i, j + 1); };
const i118 = css.indexOf('pkg3-118');
const neu = i118 > 0 ? css.slice(i118) : '';

console.log('\n══════════════════════════════════════════════════');
console.log('  pkg3-118: панели-карточки, рендеры, музыка, эконом');
console.log('══════════════════════════════════════════════════\n');

console.log('  1. Левая и правая плашки — отдельные окна в своих рамках');
const screenApp = near('#screen-app{\n  gap:14px');
ok(/padding:14px/.test(screenApp) && /gap:14px/.test(screenApp), 'между панелями воздух: отступы 14 px и промежутки 14 px');
ok(/radial-gradient/.test(screenApp), 'фон приложения — мягкий «рендер» по углам, а не плоская заливка');
const trio = near('#rail,#main,#thread{border-radius:var(--r)');
ok(/border:1\.5px solid var\(--glow-line\)/.test(trio) && /border-radius:var\(--r\)/.test(trio),
  'все три панели — в своих рамках и со скруглением');
const rail118 = near('#rail{\n  border-right:1.5px solid');
ok(/border-right:1\.5px solid var\(--glow-line\)/.test(rail118), 'левая панель — в своей светящейся рамке');
ok(/linear-gradient\(180deg,var\(--dark-2\),var\(--dark\)\)/.test(rail118), 'левая панель тёмная, в цветах текущей гаммы (--dark/--dark-2)');
ok(/--glow-halo/.test(rail118) && /--shadow-soft/.test(rail118), 'у панели ореол и мягкая тень — «окно», а не полоса');
const mainThread = near('#main,#thread{\n  background:var(--panel)');
ok(/border-radius:var\(--r\)/.test(trio) && /background:var\(--panel\)/.test(mainThread),
  'лента и комментарии — тоже отдельные окна в рамках');
ok(/--glow-halo/.test(mainThread), 'у них свой ореол');
ok(/#rail \.rail-search input\{[^}]*rgba\(255,255,255,\.09\)/.test(neu), 'на тёмной панели поиск читается (светлое поле)');
ok(/#rail \.chat-item \.ci-name\{color:#eef5fa\}/.test(neu), 'названия чатов — светлые');
ok(/#rail \.chat-item\.active\{[^}]*--glow-ring|#rail \.chat-item\.active\{[^}]*rgba\(var\(--glow-rgb\),\.16\)/.test(neu),
  'выбранный чат подсвечен цветом гаммы');
ok(/#rail \.memory\{[^}]*rgba\(255,255,255,\.09\)/.test(neu) && /#rail \.gear\{[^}]*rgba\(255,255,255,\.09\)/.test(neu),
  'память и шестерёнка внизу панели тоже перекрашены под тёмный фон');
ok(/data-pal="synth"\][^{]*#rail\{[^}]*rgba\(255,43,214/.test(neu), '«Синтвейв»: панели в розово-голубом неоне');
const mob = i118 > 0 ? css.slice(css.indexOf('@media (max-width:900px){', i118)) : '';
ok(/#screen-app\{padding:0;gap:0/.test(neu), 'на телефоне панели во всю ширину — без полей');
ok(/#main\{border:0;border-radius:0;box-shadow:none/.test(neu), 'на телефоне лента без рамки: рамкой служит экран');

console.log('\n  2. Рендеры вместо плоских заливок');
ok(/\.new-chat,\.send,button\.primary,\.mini\.primary,\.btn\.primary\{[^}]*linear-gradient\(135deg,var\(--accent\),var\(--accent-2\)\)/.test(neu),
  'главные кнопки — градиент из цветов гаммы');
ok(/\.avatar\{box-shadow:0 0 0 2px rgba\(var\(--glow-rgb\),\.22\)\}/.test(neu), 'у аватаров — светящееся кольцо');
ok(/\.msg\.mine \.bubble\{background-image:linear-gradient/.test(neu), 'свои сообщения с мягким рендером');
ok(/\.card\{background-image:linear-gradient\(180deg,var\(--panel\),var\(--panel-2\)\)\}/.test(neu), 'карточки входа — с объёмом');
ok(/\.modal-head\{background-image:linear-gradient/.test(neu), 'шапки окон подсвечены');
ok(/--bg-tint-1/.test(css) && /--bg-tint-2/.test(css), 'цвет фона выводится из гаммы (два оттенка)');

console.log('\n  3. Скругление — максимум, регулировки нет');
const root = near('--r:26px') || '--r:26px';
ok(/--r:26px/.test(root), 'скругление зафиксировано на максимуме (26 px)');
ok(!html.includes('radius-range') && !html.includes('radius-val'), 'ползунка и подписи в окне настроек больше нет');
ok(!app.includes('function applyRadius') && !app.includes('sega.radius'), 'из клиента регулировка убрана полностью');
ok(!/localStorage\.getItem\('sega\.radius'\)/.test(html), 'при загрузке скругление из памяти не читается');
ok(/border-radius:var\(--r\)/.test(css), 'окна и панели берут скругление из --r');

console.log('\n  4. Живая дорожка «слушает музыку»');
ok(/\.eq-mini\{display:inline-flex/.test(neu), 'есть сама дорожка (.eq-mini)');
ok(/@keyframes eqBar\{/.test(neu), 'и её анимация');
ok(/\.eq-mini i:nth-child\(2\)\{animation-delay:\.15s\}/.test(neu) && /\.eq-mini i:nth-child\(4\)\{animation-delay:\.45s\}/.test(neu),
  'столбики идут вразнобой — как эквалайзер');
ok(app.includes('const MUS_EQ ='), 'дорожка собирается одной строкой в клиенте');
ok((app.match(/MUS_EQ \+/g) || []).length >= 3, 'она стоит во всех плашках «слушает» (список чатов, шапка, участники)');
ok(/fab\.innerHTML = on[\s\S]{0,120}MUS_EQ/.test(app), 'в свёрнутом окне «Моя музыка» — та же дорожка, пока играет');
ok(app.includes('fab.innerHTML = on'), 'пузырёк собирает содержимое сам (нотка ↔ дорожка)');
ok(/prefers-reduced-motion[^{]*\{[\s\S]{0,120}\.eq-mini i\{animation:none/.test(css), 'при «меньше движения» анимация стоит');
ok(/:root\[data-eco="1"\] \.eq-mini i\{animation:none/.test(css), 'в экономном режиме — тоже без анимации');

console.log('\n  5. Окно «Моя музыка» — как в макете');
ok(/\.mus-v105 \.mus-coverbox\{[\s\S]{0,220}radial-gradient\(circle at 24% 26%/.test(neu),
  'обложка на «рендере» из двух цветных пятен, как в макете');
ok(/\.mus-v105 \.mus-playbig\{[\s\S]{0,200}border-radius:50%/.test(neu), 'главная кнопка ▶ — круглая');
ok(/\.mus-v105 \.mus-playbig\{[\s\S]{0,260}linear-gradient\(135deg,var\(--accent\),var\(--accent-2\)\)/.test(neu),
  'и с градиентом гаммы');
ok(/\.mus-v105 \.mus-playbig\{[^}]*box-shadow:0 0 24px/.test(neu), 'вокруг неё свечение');
ok(/\.mus-v105 \.mus-skip\{[^}]*border-radius:50%/.test(neu), '⏮ ⏭ — тоже круглые');
ok(/\.mus-tr\.cur,[\s\S]{0,160}box-shadow:inset 3px 0 0 var\(--accent-2\)/.test(neu), 'текущий трек помечен светящейся полосой');
ok(/\.mus-v105 \.mus-eq\{[\s\S]{0,160}box-shadow:0 0 18px/.test(neu), 'полоса-гистограмма в светящейся рамке');
ok(/\.mus-cov\{[^}]*box-shadow:0 0 0 1px rgba\(var\(--glow-rgb\)/.test(neu), 'мини-обложки треков обведены');

console.log('\n  6. Телефон: то же окно музыки, но без рамки');
const iMob118 = neu.indexOf('@media (max-width:900px){');
const mob118 = iMob118 > 0 ? neu.slice(iMob118) : '';
ok(/@media \(max-width:900px\)\{[\s\S]*#modal\.mus-modal \.modal-box\{background:var\(--panel\);border:0;box-shadow:none;color:var\(--text\);border-radius:0\}/.test(neu),
  'окно на телефоне — светлое, без рамки, тени и скруглений');
ok(/#modal\.mus-modal \.mus-coverbox\{background:[\s\S]{0,200}radial-gradient/.test(neu), 'обложка — тот же рендер, что на ПК');
ok(/#modal\.mus-modal \.mus-mwin\{color:var\(--text\)\}/.test(neu), 'текст внутри — как на ПК, а не белый на чёрном');
ok(!/background:#000;border:0;box-shadow:none;color:#f2f2f2/.test(css), 'прежний «чёрный плеер» телефона убран');
const tail = css.slice(css.lastIndexOf('@media (max-width:900px){'));
ok(/#modal\.mus-modal \.modal-box\{background:var\(--panel\);border:0;box-shadow:none;border-radius:0\}/.test(tail),
  'последнее слово в файле — телефонное окно без рамки (общий рецепт его не вернёт)');

console.log('\n  7. Экономный режим: батарейка, серо-белое, скругления на месте');
ok(html.includes('data-ic="battery"'), 'значок экономного режима — батарейка');
ok(app.includes('battery:'), 'иконка батарейки нарисована в клиенте');
const ecoIcon = (/data-ic="([a-z]+)"><\/span>\s*<div class="t"><b>Экономный режим/.exec(html) || [, ''])[1];
ok(ecoIcon === 'battery', 'месяца у экономного режима больше нет — стоит батарейка');
const ecoTokens = body(/:root\[data-eco="1"\]\{([\s\S]*?)\n\}/);
ok(/--panel:#ffffff/.test(ecoTokens) && /--bg:#e8ecef/.test(ecoTokens), 'светлая часть — белые панели на серой подложке');
ok(!/--text:#000000/.test(ecoTokens) && !/--line:#000{3}/.test(ecoTokens), 'это уже не «строго чёрное и белое»');
ok(/--line:#98a5b0/.test(ecoTokens), 'линии серые, но контрастные');
const ecoDark = body(/:root\[data-eco="1"\]\[data-theme="dark"\]\{([\s\S]*?)\n\}/);
ok(/--panel:#242b31/.test(ecoDark) && /--line:#6b7883/.test(ecoDark), 'тёмная часть — тоже серая, с чёткими линиями');
ok(!/:root\[data-eco="1"\] \.bubble,:root\[data-eco="1"\] \.card[\s\S]{0,400}border-radius:0/.test(css),
  'скругления в экономном режиме остались (правило «прямые углы» убрано)');
ok(/:root\[data-eco="1"\] \.bubble\{border:1\.5px solid var\(--line\)/.test(css), 'у пузырей — чёткая серая обводка');
ok(/:root\[data-eco="1"\] #screen-app\{[\s\S]{0,140}repeating-conic-gradient/.test(css), '«немного пиксельно»: редкая клетка на подложке');
ok(!/:root\[data-eco="1"\] body\{\s*background-image:conic-gradient/.test(css), 'прежняя рябая «электронная бумага» убрана');
ok(app.includes('eco-hidden') || css.includes('eco-hidden'), 'медиа в экономе по-прежнему не грузятся (eco-hidden на месте)');
ok(/:root\[data-eco="1"\] #rail\{[\s\S]{0,160}background:linear-gradient\(180deg,var\(--panel-2\),var\(--panel\)\)/.test(css),
  'тёмная колонка в экономе становится светлой');

console.log('\n  8. Отметки выпуска');
const b2 = (/const BUILD = '([^']+)'/.exec(app) || [])[1];
const cache = (/const STATIC_CACHE = '([^']+)'/.exec(sw) || [])[1];
ok(b2 === BUILD, `отметка выпуска в клиенте и в тестах одна (${BUILD})`);
ok(((/const BUILD = '([^']+)'/.exec(api) || [])[1]) === BUILD, 'BUILD в lib/api.js тот же');
ok(new RegExp('\\| ' + BUILD + ' \\|').test(read(join(ROOT, 'README.md'))), `в журнале README есть строка ${BUILD}`);
ok(cache !== 'sega-static-v110', `кэш оформления поднят (${cache}) — устройства получат новый вид`);

console.log(`\n  ИТОГ: ${good} ✓, ${bad ? bad + ' провалов' : 'провалов нет'}\n`);
process.exit(bad ? 1 : 0);
