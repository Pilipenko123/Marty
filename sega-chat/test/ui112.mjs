// test/ui112.mjs — pkg3-112: шесть замечаний владельца к окну «Моя музыка»:
//  1) на ПК в плейлисте две полосы прокрутки → одна;
//  2) на телефоне список обведён, полоса прокрутки постоянная;
//  3) окно музыки на телефоне не ложится набок (замок ориентации + запасной
//     разворот оформлением);
//  4) квадратной живой картинки рядом с обложкой нет — там название трека;
//  5) узкая полоса-эквалайзер во всю ширину между обложкой и перемоткой:
//     играет — движется, пауза — стоп-кадр, нет трека/стоп/кончился — пусто;
//  6) касание по стандартной обложке — выбор из четырёх обложек владельца.
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
const size = p => existsSync(p) ? statSync(p).size : 0;

let good = 0, bad = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ПРОВАЛ: ') + m); if (c) good++; else bad++; };
const iMob = css.indexOf('pkg3-109/110: ТЕЛЕФОН');
const mob = iMob > 0 ? css.slice(iMob) : '';
const win = app.slice(app.indexOf("modal('Моя музыка'"), app.indexOf('<span class="hidden" id="mus-now">'));
const at = c => win.indexOf(c);

console.log('\n══════════════════════════════════════════════════');
console.log('  pkg3-112: «Моя музыка» — полоса-эквалайзер, обложки, одна прокрутка');
console.log('══════════════════════════════════════════════════\n');

console.log('  1. ПК: одна полоса прокрутки в плейлисте');
ok(/\.mus-trs\{[^}]*overflow:auto/.test(css), 'источник задвоения на месте: внутренний список .mus-trs прокручивался сам');
ok(/\.mus-v105 \.mus-list \.mus-trs\{max-height:none;min-height:0;overflow:visible;margin-bottom:0\}/.test(css),
  'внутри рамки списка прокрутки больше нет — прокручивается только рамка (.mus-list)');
ok(/\.mus-v105 \.mus-list\{max-height:200px;overflow-y:auto/.test(css), 'рамка списка прокручивается как прежде');

console.log('\n  2. Телефон: список обведён, полоса прокрутки постоянная');
ok(/#modal\.mus-modal \.mus-list\{[^}]*border-radius:12px;overflow-y:auto/.test(mob) && /\.mus-v105 \.mus-list\{[^}]*border:1px solid var\(--line\)/.test(css),
  'рамка с закруглением (как на ПК), список прокручивается внутри');
ok(/#modal\.mus-modal \.mus-sbar\{display:block;flex:0 0 6px/.test(mob) && /function musSbarSync\(\)/.test(app), 'постоянная полоса прокрутки — своя, рядом со списком (pkg3-113: родную iPhone прячет)');
ok(/#modal\.mus-modal \.mus-list::-webkit-scrollbar\{display:none/.test(mob) && /#modal\.mus-modal \.mus-sbar i\{[^}]*background:var\(--accent-2\)/.test(mob),
  'родная полоса спрятана, бегунок своей — акцентного цвета, заметный');
ok(/#modal\.mus-modal \.mus-list\{[^}]*flex:1 1 0/.test(mob) || /#modal\.mus-modal \.mus-list\{flex:1 1 0/.test(mob), 'список по-прежнему забирает остаток высоты');

console.log('\n  3. Телефон: окно не ложится набок');
ok(/function musOrientLock\(on\)/.test(app) && /so\.lock\('portrait'\)\.catch\(\(\) => \{\}\)/.test(app), 'при открытии просим замок портрета (где браузер разрешает)');
ok(/musOrientLock\(true\);/.test(app), 'замок ставится при открытии окна');
ok((app.match(/musOrientLock\(false\);/g) || []).length >= 2, 'снимается и по «Свернуть», и по крестику');
ok(/function musLandSync\(\)/.test(app) && /setAttribute\('data-land', land\)/.test(app), 'запасной путь: сторона поворота пишется в data-land');
ok(/orientation:landscape\) and \(max-height:600px\)\{[^@]*:root\[data-land\] #modal\.mus-modal \.modal-box\{position:fixed;top:0;left:0;width:100dvh;height:100dvw/s.test(css),
  'в альбомной ориентации телефона окно разворачивается обратно «стоймя» (ширина = высота экрана)');
ok(/transform:rotate\(-90deg\) translateX\(-100%\)/.test(css) && /:root\[data-land="secondary"\] #modal\.mus-modal \.modal-box\{transform:rotate\(90deg\) translateY\(-100%\)\}/.test(css),
  'верх окна смотрит к физическому верху телефона при повороте в любую сторону');
ok(!/^\s*\.modal-box\{[^}]*rotate\(/m.test(css), 'прочие окна не поворачиваются');

console.log('\n  4. Справа от обложки — название трека');
// pkg3-120: блок прежний, название внутри стало бегущей строкой (.mq)
ok(win.includes('<div class="mus-viz mus-nowbox" id="mus-viz"><div class="mus-nowcol"><div class="mus-nowt" id="mus-now-title">'), 'на месте картинки — блок с названием');
ok(!win.includes('music-viz-still') && !app.includes('img/music-viz.'), 'прежней квадратной картинки в коде нет');
ok(!existsSync(join(PUB, 'img', 'music-viz.gif')) && !existsSync(join(PUB, 'img', 'music-viz.webp')), 'и файлы её убраны — программа легче');
ok(/const nt = document\.getElementById\('mus-now-title'\);\s+if \(nt\) nt\.textContent = t \? \(t\.title \|\| t\.url\) : 'Выберите трек в списке';/.test(app),
  'название обновляется вместе с треком');
ok(/\.mus-v105 \.mus-nowt\{[^}]*overflow-wrap:anywhere/.test(css) && /\.mus-v105 \.mus-nowt\{[^}]*-webkit-line-clamp:6/.test(css), 'переносится по словам, длинное — многоточие');

console.log('\n  5. Полоса-эквалайзер между обложкой и перемоткой');
ok(at('class="mus-eq"') > at('class="mus-coverbox"') && at('class="mus-progline"') > at('class="mus-eq"'), 'стоит ровно между обложкой и перемоткой');
ok(win.includes('<div class="mus-eq" id="mus-eq" data-st="off" aria-hidden="true"></div>'), 'до старта трека — пустая');
ok(/\.mus-v105 \.mus-eq\{height:40px;[^}]*border:1px solid var\(--line\);border-radius:12px;overflow:hidden/.test(css), 'узкая (40px), во всю ширину, с закруглённой рамкой');
ok(/#modal\.mus-modal \.mus-eq\{height:36px/.test(mob), 'на телефоне ещё уже (36px)');
ok(/\.mus-v105 \.mus-eq img,\.mus-v105 \.mus-eq \.mus-viz-anim\{[^}]*width:100%;height:100%;object-fit:fill\}/.test(css), 'картинка растягивается на всю полосу');
ok(/function musVizState\(\)/.test(app), 'есть расчёт состояния полосы');
ok(/const has = !!a && !!MUS\.list\[MUS\.idx\] && !MUS\.widget && !MUS\.dead && !a\.ended\s+&& a\.currentTime >= MUS_VIZ_FROM;/.test(app),
  'pkg3-116: «есть что показывать» = трек выбран, не кончился, не отказал и звучит уже хотя бы секунду');
ok(/if \(!has\) return 'off';/.test(app) && /return \(!a\.paused && !S\.eco\) \? 'on' : 'still';/.test(app), 'три состояния: пусто / движется / стоп-кадр');
ok(/box\.innerHTML = st === 'on' \? MUS_VIZ_ANIM\s*: st === 'still' \? '<img class="mus-eq-still" src="img\/music-eq-pause\.png" alt="">'\s*: '';/.test(app),
  'играет — анимация, пауза — стоп-кадр, иначе — пусто');
ok(!/music-eq\.webp/.test(app) && /<img src="img\/music-eq\.gif"/.test(app), 'полоса — GIF владельца (pkg3-114)');
ok(/try \{ a\.currentTime = 0; \} catch \(e\)[^\n]*крестик = стоп/.test(app), 'крестик = стоп: позиция сбрасывается, полоса гаснет');
for (const [f, max] of [['music-eq.gif', 200], ['music-eq-pause.png', 30]]) {
  const sz = size(join(PUB, 'img', f));
  ok(sz > 500 && sz < max * 1024, `${f} на месте и не тяжелее ${max} КБ (${Math.round(sz / 1024)} КБ)`);
}
const g = readFileSync(join(PUB, 'img', 'music-eq.gif'));
ok(g.readUInt16LE(6) === 560 && g.readUInt16LE(8) === 80, `кадр полосы 560×80 (${g.readUInt16LE(6)}×${g.readUInt16LE(8)})`);

console.log('\n  6. Выбор стандартной обложки');
ok(/const MUS_COVERS = \[/.test(app) && (app.match(/src: 'img\/music-cover\d?\.(jpg|gif)'/g) || []).length === 4, 'четыре обложки владельца в списке');
for (const f of ['music-cover.jpg', 'music-cover2.jpg', 'music-cover3.gif', 'music-cover4.jpg']) {
  const sz = size(join(PUB, 'img', f));
  ok(sz > 5000 && sz < 200 * 1024, `${f} на месте и лёгкая (${Math.round(sz / 1024)} КБ)`);
}
ok(/localStorage\.getItem\('sega\.musCover'\)/.test(app) && /localStorage\.setItem\('sega\.musCover', b\.getAttribute\('data-mus-cov'\)\)/.test(app), 'выбор хранится на устройстве');
ok(/class="mus-cov-def"/.test(app) && /if \(!covBox\.querySelector\('\.mus-cov-def'\) \|\| !covOvl\) return;/.test(app), 'выбор открывается только когда показана стандартная обложка (не своя обложка трека)');
ok(app.includes('id="mus-cov-ovl"') && app.includes('<h3>Стандартная обложка</h3>') && app.includes('${musCoverPickHtml()}'), 'окошко выбора с четырьмя картинками');
ok(/\.mus-v105 \.mus-covgrid\{display:grid;grid-template-columns:1fr 1fr/.test(css) && /\.mus-v105 \.mus-covpick\.cur\{border-color:var\(--accent-2\)/.test(css), 'картинки в две колонки, выбранная подсвечена');
// pkg3-141: запасная обложка теперь в data-fb-src (строгий CSP), смысл прежний
ok(/data-fb-src="\$\{escapeHtml\(def\)\}"/.test(app) && /img\.dataset\.fbSrc/.test(app),
  'своя обложка трека важнее; при её сбое — выбранная стандартная (pkg3-141: без onerror=)');
ok(/musicNowUi\(\);\s+covOvl\.classList\.remove\('show'\);/.test(app), 'после выбора обложка меняется сразу, окошко закрывается');

console.log('\n  7. Отметки выпуска');
const b2 = /const BUILD = '([^']+)'/.exec(app)[1];
const cache = /const STATIC_CACHE = '([^']+)'/.exec(sw)[1];
ok(b2 === BUILD && /const BUILD = '([^']+)'/.exec(api)[1] === BUILD, `отметка выпуска совпадает в клиенте и сервере (${BUILD})`);
ok(new RegExp('\\| ' + BUILD + ' \\|').test(read(join(ROOT, 'README.md'))), `в журнале README есть строка ${BUILD}`);
ok(cache !== 'sega-static-v104' && /^sega-static-v\d+$/.test(cache), `кэш оформления поднят (${cache})`);
ok(!/"dependencies":\s*\{[^}]*"(?!web-push)[a-z@][^"]*"/.test(read(join(ROOT, 'package.json'))), 'новых рантайм-зависимостей нет');

console.log(`\n  ИТОГ: ${good} ✓, ${bad ? bad + ' провалов' : 'провалов нет'}\n`);
process.exit(bad ? 1 : 0);
