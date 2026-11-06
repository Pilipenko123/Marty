// test/ui111.mjs — pkg3-111: «Моя музыка» на телефоне — чёрный плеер до краёв
// экрана, по пожеланиям владельца после скриншота 110-го:
//  • кнопка «Найти» была во всю ширину (общее правило button.primary{width:100%}
//    + flex:0 0 auto из 110-го) и выдавливала «⋯» за край — теперь короткая,
//    поле поиска тянется, подсказка «найти трек»;
//  • текста под строкой поиска и подписи под обложкой нет;
//  • перемотка переехала выше плейлиста; ⏮ ⏭ размером с ▶;
//  • фон чёрный, без рамок; обложка по умолчанию — файл владельца;
//  • бегущая строка ходит туда-обратно и не показывает пустоту.
import { readFileSync, existsSync, statSync } from 'node:fs';
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

let good = 0, bad = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ПРОВАЛ: ') + m); if (c) good++; else bad++; };
const iMob = css.indexOf('pkg3-109/110: ТЕЛЕФОН');
const mob = iMob > 0 ? css.slice(iMob) : '';
const win = app.slice(app.indexOf("modal('Моя музыка'"), app.indexOf('<span class="hidden" id="mus-now">'));

console.log('\n══════════════════════════════════════════════════');
console.log('  pkg3-111: телефон — «Моя музыка» как чёрный плеер');
console.log('══════════════════════════════════════════════════\n');

console.log('  1. Строка поиска: поле длинное, «Найти» короткая, «⋯» на экране');
ok(/button\.primary\{width:100%/.test(css), 'источник беды 110-го на месте: общее правило делает любую «главную» кнопку во всю ширину');
ok(/\.mus-v105 \.mus-srow \.mini\.primary\{width:auto;margin-top:0;[^}]*flex:0 0 auto\}/.test(css),
  '«Найти» в окне музыки — короткая (width:auto), без верхнего отступа, не растягивается');
ok(/\.mus-v105 \.mus-srow input\{flex:1 1 auto;min-width:0;margin-top:0\}/.test(css), 'поле поиска тянется на всю оставшуюся ширину');
ok(win.includes('placeholder="найти трек"'), 'подсказка в поле — «найти трек»');
ok(!win.includes('Поиск музыки: введите'), 'длинной подсказки в поле больше нет');
ok(win.includes('id="mus-dots-btn"') && /<button class="mini primary" id="mus-sq-go">Найти<\/button>\s*<button class="mini mus-dotsbtn" id="mus-dots-btn"/.test(win),
  'порядок в строке: поле → «Найти» → «⋯»');

console.log('\n  2. Лишние тексты убраны');
ok(!win.includes('Отметьте сайты в «⋯»'), 'подсказки под строкой поиска нет');
ok(/\.mus-v105 \.mus-sqbar:empty\{display:none\}/.test(css), 'пустая строка состояния поиска не занимает места (появляется только «Найдено: N» / «Спрашиваю сайты…»)');
ok(!app.includes('id="mus-cover-cap"') && !app.includes("getElementById('mus-cover-cap')"), 'подписи «Сейчас играет» под обложкой нет ни в разметке, ни в коде');
ok(!/Сейчас ничего не играет/.test(app), 'и её запасного текста тоже');

console.log('\n  3. Порядок блоков: обложка → перемотка → плейлист → кнопки');
const at = c => win.indexOf(c);
ok(at('class="mus-coverbox"') > 0 && at('class="mus-progline"') > at('class="mus-coverbox"'), 'перемотка стоит под обложкой');
ok(at('class="mus-plhead"') > at('class="mus-progline"') && at('id="mus-list"') > at('class="mus-plhead"'), 'плейлист — ниже перемотки');
ok(at('class="mus-three"') > at('id="mus-list"') && at('class="mus-foot"') > at('class="mus-three"'), 'три кнопки и громкость — в самом низу');
ok((win.match(/id="mus-seek"/g) || []).length === 1, 'ползунок перемотки один');

console.log('\n  4. Кнопки ⏮ ▶ ⏭ одного размера');
ok(/\.mus-v105 \.mus-skip\{width:58px;height:58px;border-radius:16px/.test(css) && /\.mus-v105 \.mus-playbig\{width:58px;height:58px;border-radius:16px/.test(css),
  'на компьютере: 58×58 у всех трёх');
ok(/#modal\.mus-modal \.mus-playbig\{width:58px;height:58px/.test(mob) && /#modal\.mus-modal \.mus-skip\{width:58px;height:58px/.test(mob),
  'на телефоне: 58×58 у всех трёх — как на ПК (pkg3-113)');
ok(/max-height:640px\)\{[^@]*\.mus-three \.mus-playbig,#modal\.mus-modal \.mus-three \.mus-skip\{width:52px;height:52px/s.test(mob),
  'на низком экране все три ужимаются вместе (52)');
ok(/max-height:480px\)\{[^@]*\.mus-playbig,#modal\.mus-modal \.mus-skip\{width:46px;height:46px/s.test(mob),
  'на очень низком — тоже вместе (46)');

console.log('\n  5. Чёрный плеер без рамок до краёв экрана (только телефон)');
// pkg3-118: владелец попросил на телефоне тот же вид, что на ПК, но без рамки —
// чёрный плеер 111-го стал светлым/тёмным по теме, границей служит край экрана
ok(/#modal\.mus-modal\{background:var\(--panel\)\}/.test(mob), 'поля вокруг окна — цвет панели, как на ПК');
ok(/#modal\.mus-modal \.modal-box\{background:var\(--panel\);border:0;box-shadow:none;color:var\(--text\)\}/.test(mob), 'окно без рамки и тени, текст как на ПК');
ok(/#modal\.mus-modal \.modal-head\{background:var\(--panel\);border-bottom:1px solid var\(--line-2\)\}/.test(mob), 'шапка как на ПК (тонкая линия снизу)');
ok(/#modal\.mus-modal \.mus-coverbox\{[^}]*radial-gradient/.test(mob) && !/#modal\.mus-modal \.mus-cov-left\{border-right:1px/.test(mob), 'блок обложки — одна общая закруглённая рамка с тем же рендером, что на ПК');
ok(/#modal\.mus-modal \.mus-list\{background:var\(--panel\);padding:4px;border-radius:12px/.test(mob) && !/#modal\.mus-modal \.mus-list\{[^}]*border:0/.test(mob), 'список на подложке панели, рамка — как на ПК');
ok(/#modal\.mus-modal \.mus-foot\{border-top:1px solid var\(--line\)/.test(mob), 'низ — как на ПК, с линией (pkg3-113)');
ok(/#modal\.mus-modal \.mus-srow input\{border-radius:12px;padding:9px 12px\}/.test(mob) && !/#modal\.mus-modal \.mus-srow input\{background:#141418/.test(mob), 'поле поиска — цвета как на ПК (pkg3-114), только скруглённее');
ok(!/#modal\.mus-modal \.mini\{background:#17171c/.test(mob) && !/#modal\.mus-modal \.mus-skip\{background:#17171c/.test(mob), 'все кнопки — цвета как на ПК (pkg3-114: своих «телефонных» перекрасок нет)');
ok(!/^\s*\.modal-box\{[^}]*background:#000/m.test(css) && !/^#modal \.modal-box\{[^}]*#000/m.test(css), 'прочие окна и компьютер не почернели');
const boxBase = (/\n\.modal-box\{[^}]*\}/.exec(css) || [''])[0];
ok(/background:#fff/.test(boxBase), 'общее окно по-прежнему белое');

console.log('\n  6. Обложка по умолчанию — файл владельца');
const cov = join(PUB, 'img', 'music-cover.jpg');
ok(existsSync(cov), 'public/img/music-cover.jpg на месте');
const sz = existsSync(cov) ? statSync(cov).size : 0;
ok(sz > 10 * 1024 && sz < 160 * 1024, `картинка лёгкая (${Math.round(sz / 1024)} КБ)`);
if (existsSync(cov)) { const b = readFileSync(cov); ok(b[0] === 0xFF && b[1] === 0xD8, 'это настоящий JPEG'); }
ok(/return `<img src="\$\{def\}" alt="" class="mus-cov-def"/.test(app) && /src: 'img\/music-cover\.jpg'/.test(app), 'трек без своей обложки показывает её (pkg3-112: или другую выбранную из четырёх)');
// pkg3-139: обработчик-атрибут заменён запасным адресом в data- и общим
// перехватчиком (строгий CSP без «unsafe-inline»); смысл тот же — не пустота
ok(/data-fb-src="\$\{escapeHtml\(def\)\}"/.test(app) && /img\.dataset\.fbSrc/.test(app)
  && /addEventListener\('error'/.test(app), 'если своя обложка трека не загрузилась — стандартная, а не пустота (pkg3-139: без onerror=)');
ok(!/<svg viewBox="0 0 400 400"[^>]*>[\s\S]*?musg1/.test(app.slice(app.indexOf('function musCoverBigHtml'), app.indexOf('function musSearchRenderRows'))), 'нарисованный винил со значком ♪ убран');
ok(/\.mus-v105 \.mus-cov-left img[^{]*\{[^}]*object-fit:contain/.test(css.replace(/\s+/g, ' ')), 'картинка вписана целиком без обрезки (pkg3-113)');

console.log('\n  7. Бегущая строка: туда-обратно, без пустоты');
ok(/function musMqFit\(row\)/.test(app), 'есть замер переполнения названия (musMqFit)');
ok(/const over = Math\.ceil\(mq\.scrollWidth - ti\.clientWidth\);/.test(app), 'меряется, на сколько название шире ячейки');
ok(/mq\.style\.setProperty\('--mq-shift', shift \+ 'px'\)/.test(app), 'сдвиг отдаётся оформлению через --mq-shift');
ok(/mq\.classList\.toggle\('mq-s', !shift\)/.test(app), 'влезает целиком — стоит на месте (mq-s)');
ok(/if \(isCur\) musMqFit\(row\);/.test(app), 'замер идёт у текущей строки на каждом тике звука');
ok(/\.mus-tr\.cur \.mq\{animation:mus-mq var\(--mq-dur,8s\) ease-in-out infinite alternate/.test(css), 'движение чередуется: туда — обратно');
ok(/@keyframes mus-mq\{0%,14%\{transform:translateX\(0\)\}86%,100%\{transform:translateX\(var\(--mq-shift,0px\)\)\}\}/.test(css),
  'конечная точка — ровно конец названия (не -100%), с паузами по краям');
ok(!/padding-left:100%;animation:mus-mq/.test(css), 'прежний разгон с пустого места убран');
ok(/\.mus-tr \.mq\{display:inline-block;white-space:nowrap;max-width:none\}/.test(css), 'ширина названия настоящая — иначе замер невозможен');
ok(/\.mus-tr\.cur\.paused \.mq\{animation-play-state:paused\}/.test(css), 'на паузе строка замирает (как в 96-м)');

console.log('\n  8. Раскладка 110-го не сломана, отметки выпуска');
ok(/#modal\.mus-modal \.modal-body > \.mus-wrap\.mus-v105\{[^}]*flex-flow:column nowrap/s.test(mob), 'колонка без переноса (дефект 109-го закрыт)');
ok(/#modal\.mus-modal \.mus-list\{flex:1 1 0/.test(mob), 'список — единственный тянущийся блок; появление строки загрузки поиска раскладку не ломает');
ok(/#modal\.mus-modal \.mus-wrap\.mus-v105 > \*\{min-width:0;max-width:100%;box-sizing:border-box\}/.test(mob), 'блоки не шире экрана');
const b2 = /const BUILD = '([^']+)'/.exec(app)[1];
const cache = /const STATIC_CACHE = '([^']+)'/.exec(sw)[1];
ok(b2 === BUILD && /const BUILD = '([^']+)'/.exec(api)[1] === BUILD, `отметка выпуска совпадает в клиенте и сервере (${BUILD})`);
ok(new RegExp('\\| ' + BUILD + ' \\|').test(read(join(ROOT, 'README.md'))), `в журнале README есть строка ${BUILD}`);
ok(cache !== 'sega-static-v103' && /^sega-static-v\d+$/.test(cache), `кэш оформления поднят (${cache})`);
ok(!/"dependencies":\s*\{[^}]*"(?!web-push)[a-z@][^"]*"/.test(read(join(ROOT, 'package.json'))), 'новых рантайм-зависимостей нет');

console.log(`\n  ИТОГ: ${good} ✓, ${bad ? bad + ' провалов' : 'провалов нет'}\n`);
process.exit(bad ? 1 : 0);
