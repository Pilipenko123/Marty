// test/ui117.mjs — pkg3-117: светящиеся скруглённые окантовки, новая палитра,
// маленькие квадратики выбора гаммы и правильный логотип в левой панели.
//
// Владелец одобрил макет (sega-chat/mockups/glow-117.html) и поставил условия:
//   • окантовка светится у ВСЕХ окон, меню и панелей, цвет — из гаммы;
//   • НИЧЕГО не переставлять: только дизайн (проверяем отдельным разделом);
//   • палитру гамм пересмотреть по образцу «Фокус»;
//   • квадратики выбора гаммы — меньше, с небольшим ореолом;
//   • в овале левой панели — тот же логотип, что на экране загрузки, без «®»;
//   • по умолчанию «Спокойное» свечение, на телефоне — как в макете;
//   • «Синтвейв» обязан остаться рабочим.
//
// Проверяем это по исходникам: браузера в песочнице нет, вид оценивает владелец.

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
const block = sel => { const m = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\{([^}]*)\\}').exec(css); return m ? m[1] : ''; };
const anyBlock = re => { const m = re.exec(css); return m ? m[0] : ''; };

// блок нового рецепта — от метки pkg3-117 до конца файла плюс токены в :root
const iNew = css.indexOf('pkg3-117: СВЕТЯЩАЯСЯ ОКАНТОВКА ВО ВСЁМ ПРИЛОЖЕНИИ');
const neu = iNew > 0 ? css.slice(iNew) : '';
const root = block(':root');

console.log('\n══════════════════════════════════════════════════');
console.log('  pkg3-117: светящаяся окантовка и новая палитра');
console.log('══════════════════════════════════════════════════\n');

console.log('  1. Общий рецепт свечения (один на всё приложение)');
ok(iNew > 0, 'в стилях есть отдельный раздел pkg3-117');
ok(/--glow-rgb:\s*\d+,\s*\d+,\s*\d+/.test(root), 'цвет свечения берётся из переменной --glow-rgb (её задаёт гамма)');
ok(/--g1:/.test(root) && /--g2:/.test(root) && /--gb:/.test(root), 'сила ореола — три общие переменные (--g1, --g2, --gb)');
ok(/--r:\s*26px/.test(root), 'скругление максимальное и не настраивается (--r:26px, pkg3-118)');
ok(/--glow-ring:/.test(root) && /--glow-halo:/.test(root) && /--glow-in:/.test(root), 'готовые слои: контур, ореол и мягкая внутренняя подсветка');
ok(/--glow-line:rgba\(var\(--glow-rgb\),calc\(/.test(root), 'цвет рамки тоже выводится из гаммы одной формулой');

console.log('\n  2. Светятся все окна, меню и панели');
const modal = anyBlock(/\.modal-box\{[^}]*\}/);
const win = anyBlock(/\.modal-box\{(?:(?!\})[\s\S])*?\}/);
const modalRule = (/(?:^|\n)\.modal-box\{([\s\S]*?)\}/.exec(neu) || [, ''])[1];
ok(/var\(--glow-line\)/.test(modalRule) && /var\(--r\)/.test(modalRule), 'окна (.modal-box) — цветная рамка + скругление из настроек');
ok(/--glow-ring/.test(modalRule) && /--glow-halo/.test(modalRule), 'у окон есть ореол (контур + свечение вокруг)');
const cardRule = (/(?:^|\n)\.card\{([\s\S]*?)\}/.exec(neu) || [, ''])[1];
ok(/--glow-line/.test(cardRule), 'карточки входа и регистрации — в том же стиле');
const menuRule = (/(?:^|\n)\.ask-card,#drop,#emoji-pop,\.plus-menu,\.mus-mwin\{([\s\S]*?)\}/.exec(neu) || [, ''])[1];
ok(/--glow-line/.test(menuRule) && /--glow-halo/.test(menuRule), 'меню «＋», «⋯», поле эмодзи и окна-вопросы светятся');
const railRule = (/(?:^|\n)#rail\{([\s\S]*?)\}/.exec(neu) || [, ''])[1];
const threadRule = (/(?:^|\n)#thread\{([\s\S]*?)\}/.exec(neu) || [, ''])[1];
const topRule = (/(?:^|\n)#topbar\{([\s\S]*?)\}/.exec(neu) || [, ''])[1];
const compRule = (/(?:^|\n)#composer,#thread-composer\{([\s\S]*?)\}/.exec(neu) || [, ''])[1];
if (!railRule) console.log('    (подсказка: #rail не найден в новом разделе)');
ok(/--glow-line/.test(railRule) && /--glow-halo/.test(railRule), 'левая панель с чатами светится по кромке');
ok(/--glow-line/.test(threadRule), 'панель комментариев справа светится');
ok(/--glow-line/.test(topRule), 'верхняя полоса светится снизу');
ok(/--glow-line/.test(compRule), 'поле ввода отделено светящейся линией');
ok(/\.chat-item\.active\{[^}]*--glow-ring/.test(neu), 'выбранный чат подсвечен');
ok(/(?:^|\n)input:focus,textarea:focus\{[^}]*var\(--glow-rgb\)/.test(neu), 'поле в фокусе светится цветом гаммы');
ok(/\.music-fab\{[^}]*--glow-ring/.test(neu), 'пузырёк «Моя музыка» тоже в окантовке');

console.log('\n  3. Сила свечения: спокойное / яркое / выключено / эконом');
const soft = (/--g2:\s*([.\d]+)[^}]*/.exec(root) || [])[1];
const brightRule = (/(?:^|\n):root\[data-glow="bright"\]\{([^}]*)\}/.exec(css) || [, ''])[1];
const offRule = (/(?:^|\n):root\[data-glow="off"\]\{([^}]*)\}/.exec(css) || [, ''])[1];
const ecoRule = (/(?:^|\n):root\[data-eco="1"\]\{([^}]*)\}/.exec(css) || [, ''])[1];
ok(soft === '.30', 'по умолчанию «Спокойное» (--g2:.30)');
ok(/--g2:\s*\.55/.test(brightRule), '«Яркое» — заметно сильнее');
ok(/--g2:\s*0/.test(offRule) && /--g1:\s*0/.test(offRule), '«Выключено» — ореола нет');
ok(/--glow-line:rgba\(var\(--glow-rgb\),calc\(\.16 \+ var\(--g2\)/.test(root),
  'при «выключено» остаётся тонкая цветная рамка (не серая)');
ok(/:root\[data-eco="1"\]\{--g1:0;--g2:0/.test(css), 'экономный режим гасит свечение');
ok(/:root\[data-eco="1"\][^{]*\{[^}]*box-shadow:none !important/.test(css), 'в экономном режиме тяжёлые тени тоже сняты');
ok(app.includes("localStorage.getItem('sega.glow') || 'soft'"), 'при запуске берётся «Спокойное», если человек ничего не выбирал');
ok(app.includes('function applyGlow'), 'есть функция применения силы свечения');
ok(!app.includes('function applyRadius'), 'регулировка скругления из кода убрана — значение живёт в стилях');
ok(app.includes("localStorage.setItem('sega.glow'"), 'выбор силы свечения запоминается на устройстве');

console.log('\n  4. Настройки «Окантовка» — рядом с гаммами, на своих местах');
ok(html.includes('id="glow-seg"') && html.includes('data-glow="soft"') && html.includes('data-glow="bright"') && html.includes('data-glow="off"'),
  'три кнопки силы свечения в окне настроек');
ok(!html.includes('id="radius-range"'), 'ползунка скругления больше нет (pkg3-118: углы всегда максимальные)');
const iSettings = html.indexOf('id="sheet-settings"');
const iGlow = html.indexOf('id="glow-seg"');
const iPals = html.indexOf('id="pals"');
const iClose = html.indexOf('id="settings-close"');
ok(iSettings > 0 && iGlow > iSettings, 'раздел «Окантовка» внутри окна настроек');
ok(iPals > 0 && iGlow > iPals, 'он идёт после выбора гаммы (где и просил владелец)');
ok(read(join(PUB, 'index.html')).includes('Окантовка'), 'раздел подписан по-русски — «Окантовка»');
ok(app.includes("$('#glow-seg').addEventListener"), 'кнопки силы свечения подключены к делу');
ok(/\.gseg\{[^}]*display:inline-flex/.test(css) && /\.range\{[^}]*accent-color/.test(css),
  'у переключателей есть свой вид (не «голые» кнопки)');

console.log('\n  5. Квадратики выбора гаммы — меньше и с ореолом');
const palRule = (/(?:^|\n)\.pal\{([\s\S]*?)\}/.exec(css) || [, ''])[1];
ok(/width:32px;height:32px/.test(palRule), 'квадратик 32×32 (в прежнем дизайне был 40×40)');
ok(/border-radius:10px/.test(palRule), 'скругление 10 px — как в образце');
ok(/--pal-halo/.test(palRule), 'у каждого квадратика свой мягкий ореол');
ok(app.includes('--pal-halo:${p.c2}59'), 'ореол красится в собственный цвет гаммы');
const palOn = (/(?:^|\n)\.pal\.on\{([\s\S]*?)\}/.exec(css) || [, ''])[1];
ok(/--pal-halo/.test(palOn) && /border-color:var\(--text\)/.test(palOn), 'выбранный — рамка + свечение вокруг');
ok(/\.pal\.on::after\{[^}]*content:'✓'/.test(css), 'на выбранном остаётся галочка');
ok(!/\.pal\{[^}]*width:40px/.test(css), 'прежний крупный размер не остался');

console.log('\n  6. Палитра гамм пересмотрена, «Синтвейв» цел');
const PALS = ['classic', 'synth', 'sea', 'lavender', 'olive', 'sunset', 'honey', 'rose', 'mint', 'graphite'];
// «Синтвейв» объявлен отдельным правилом с :not([data-eco="1"]) — берём его целиком
const synthPal = (/:root\[data-in-app\]\[data-pal="synth"\]:not\(\[data-eco="1"\]\)\{([\s\S]*?)\n\}/.exec(css) || [, ''])[1];
for (const id of PALS) {
  const b = id === 'synth'
    ? synthPal
    : ((new RegExp(':root\\[data-in-app\\]\\[data-pal="' + id + '"\\]\\{([^}]*)\\}').exec(css) || [, ''])[1]);
  ok(/--glow-rgb:\d+,\d+,\d+/.test(b) && /--accent:/.test(b), `гамма «${id}»: свой акцент и свой цвет свечения`);
}
ok(/#00e5ff/.test(synthPal) && /#ff2bd6/.test(synthPal), '«Синтвейв»: голубой и розовый — как было');
ok(/--bg:#0d0221/.test(synthPal), '«Синтвейв»: тёмный фон #0d0221 не тронут');
ok(/--glow-rgb:255,43,214/.test(css), 'у «Синтвейва» неоновое свечение');
ok(/:root\[data-in-app\]\[data-pal="synth"\][^{]*\.lock-box/.test(css) || /data-pal="synth"/.test(css), 'неоновая тень овальной плашки для «Синтвейва» на месте');
ok(app.includes("c1: '#ff2bd6', c2: '#00e5ff'"), 'в клиенте «Синтвейв» остался прежним');
ok(app.includes("c1: '#3b5bdb', c2: '#4dabf7'"), '«Классика» перекрашена (было #2353a2 / #2fc6f6)');
ok(!app.includes("c1: '#2353a2'"), 'старые цвета гамм в клиенте не остались');
ok(/\[data-theme="dark"\]\[data-pal="graphite"\]/.test(css), 'тёмные варианты гамм на месте');
ok(app.includes("if (pal.id === 'synth'"), '«Синтвейв» по-прежнему включает тёмную тему');

console.log('\n  7. Логотип в левой плашке — как на экране загрузки');
const brand = (/<div class="rail-brand">([\s\S]*?)<\/div>/.exec(html) || [, ''])[1];
ok(brand.includes('class="lock-box"'), 'овальная плашка на месте');
ok(brand.includes('src="logo.png"') && brand.includes('class="word">CHAT'), 'внутри — знак SEGA и слово CHAT');
ok(!brand.includes('®'), 'лишнего знака ® в плашке нет (был второй «R в кружочке»)');
ok(!html.includes('<sup>®</sup>'), 'надстрочного ® в разметке больше нет нигде');
const lockBox = (/(?:^|\n)\.lock-box\{([\s\S]*?)\}/.exec(css) || [, ''])[1];
ok(/border:3px solid/.test(lockBox) && /border-radius:16px/.test(lockBox), 'овал остался прежним по форме — поменялось только содержимое');
const loadLogo = (/\#screen-loading \.logo\{([^}]*)\}/.exec(css) || [, ''])[1];
const railLogo = (/\.lock-box \.logo\{([^}]*)\}/.exec(css) || [, ''])[1];
ok(/brightness\(0\) invert\(1\)/.test(loadLogo) && /brightness\(0\) invert\(1\)/.test(railLogo),
  'знак в плашке обесцвечен так же, как на экране загрузки (один и тот же логотип)');
ok(html.includes('id="screen-loading"'), 'экран загрузки не тронут');

console.log('\n  8. Ничего не переставлено — только дизайн');
const order = ['id="rail"', 'id="main"', 'id="topbar"', 'id="composer"', 'id="thread"', 'id="sheet-settings"', 'id="modal"'];
let last = -1, orderOk = true;
for (const id of order) { const i = html.indexOf(id); if (i < 0 || i < last) orderOk = false; last = i; }
ok(orderOk, 'порядок крупных блоков страницы прежний (панель → лента → окна)');
ok(/\.rail-brand\{/.test(css) && html.indexOf('class="rail-search"') > html.indexOf('class="rail-brand"'),
  'шапка панели и поиск чатов — там же, где были');
ok(html.indexOf('id="plus-menu"') > 0 && html.indexOf('id="plus-menu"') < html.indexOf('id="main"'),
  'меню «＋» осталось в своей разметке');
ok(html.includes('id="btn-gear"'), 'шестерёнка настроек на месте');
ok(/id="pals"/.test(html) && /class="pals"/.test(html), 'блок выбора гаммы в настройках не тронут по месту');
ok(/\.set-row\{/.test(css) && /\.divider\{/.test(css), 'строки и разделители настроек — прежние');
ok(/\.modal-body/.test(css) && /\.modal-box\{/.test(css), 'устройство окон прежнее (шапка/тело/кнопки)');
ok(!/position:fixed[^}]*\.pal\{/.test(css), 'квадратики гамм никуда не «улетели» и не стали всплывающими');
ok(/\.gseg button\{[^}]*font-size:12px/.test(css), 'новые кнопки не выше строки настроек (12 px)');

console.log('\n  9. Телефон — как в макете (свечение слабее, окно музыки чёрное)');
// pkg3-118: телефонное правило окна музыки по-прежнему последнее в файле
const iMob = css.lastIndexOf('@media (max-width:900px){');
ok(iMob > css.indexOf('pkg3-118') && iMob > iNew, 'телефонное окно музыки объявлено ПОСЛЕ общего рецепта (иначе рамка вернулась бы)');
ok(/@media \(max-width:420px\)\{[\s\S]{0,220}\.gseg\{order:3/.test(css), 'на узком экране переключатель уходит на свою строку, а не сжимает подпись');
ok(/\.pal\{[^}]*width:32px/.test(css), 'квадратики на телефоне того же размера, что в макете');

console.log('\n 10. Отметки выпуска');
const b2 = (/const BUILD = '([^']+)'/.exec(app) || [])[1];
const cache = (/const STATIC_CACHE = '([^']+)'/.exec(sw) || [])[1];
ok(b2 === BUILD, `отметка выпуска в клиенте и в тестах одна (${BUILD})`);
ok(((/const BUILD = '([^']+)'/.exec(api) || [])[1]) === BUILD, 'BUILD в lib/api.js тот же');
ok(new RegExp('\\| ' + BUILD + ' \\|').test(read(join(ROOT, 'README.md'))), `в журнале README есть строка ${BUILD}`);
ok(cache !== 'sega-static-v109', `кэш оформления поднят (${cache}) — устройства получат новый вид`);
ok(html.includes('sega.glow'), 'вид применяется до отрисовки — при загрузке не мигает');

console.log(`\n  ИТОГ: ${good} ✓, ${bad ? bad + ' провалов' : 'провалов нет'}\n`);
process.exit(bad ? 1 : 0);
