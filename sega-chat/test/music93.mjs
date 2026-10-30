// test/music93.mjs — pkg3-93: пузырёк тянется по-настоящему, «Свернуть» и
// «Закрыть» разведены, перелёт окно↔пузырёк поверх экрана, ▶→❚❚ и бегущая строка.
// Набор меток клиента/стилей (сервер выпуска не менялся).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let good = 0, bad = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ПРОВАЛ: ') + m); if (c) good++; else bad++; };

console.log('\n══════════════════════════════════════════════════');
console.log('  pkg3-93: пузырёк-путешественник, «Свернуть»/«Закрыть», перелёт, бегущая строка');
console.log('══════════════════════════════════════════════════\n');

const appJs = read('public/app.js');
const css = read('public/styles.css');
const sw = read('public/sw.js');
const apiJs = read('lib/api.js');
const pkg = read('package.json');
const readme = read('README.md');

console.log('  1. Пузырёк перемещается, а не растягивается');
ok(appJs.includes('document.addEventListener(\'pointermove\', move') && appJs.includes('document.removeEventListener(\'pointermove\', move)'),
  'перетаскивание слушает ВЕСЬ документ (события не теряются на кнопке)');
ok(appJs.includes("fab.style.right = 'auto'; fab.style.bottom = 'auto';"),
  'снимаются ОБА якоря (right и bottom) — пузырёк едет, а не растягивается');
ok(appJs.includes("if (e.cancelable) e.preventDefault();"),
  'нажатие гасит фокус/прокрутку — палец ведёт пузырёк, а не страницу');
ok(css.includes('.music-fab{position:fixed;right:14px;bottom:76px'),
  'по умолчанию пузырёк стоит НАД кнопкой отправки сообщения');
ok(appJs.includes("localStorage.setItem('sega.musFabPos.v1'"), 'выбранное место запоминается между сеансами');

console.log('\n  2. «Свернуть» и «Закрыть» — разные кнопки');
ok(appJs.includes('function musAddMinBtn(') && appJs.includes("mb.textContent = 'Свернуть';") && appJs.includes('box.insertBefore(mb, box.firstChild)'),
  'pkg3-94: «Свернуть» — шторка-язычок по центру верхней кромки окна музыки');
ok(appJs.includes("if (mb) mb.remove();"), 'у прочих модалок «Свернуть» не остаётся');
ok(appJs.includes('function musCloseFull(') && appJs.includes('S.musFabHidden = true'),
  'крестик закрывает окно СОВСЕМ: пузырёк исчезает');
ok(appJs.includes("if (document.querySelector('#modal-body .mus-wrap')) musMinimize(); else hide($('#modal'));"),
  'клик мимо окна = свернуть в пузырёк (прочие модалки закрываются как прежде)');
ok(appJs.includes('!S.musFabHidden && !S.musOpen'),
  'при открытом окне пузырька нет: окно и пузырёк — один предмет в двух видах');

console.log('\n  3. Перелёт видно целиком');
ok(appJs.includes('function musFly(') && css.includes('.mus-fly{'),
  'летит плашка-двойник поверх всего экрана (z-index выше модалки) — видно, КУДА улетело окно');
ok(appJs.includes("d.textContent = '🎵 Моя музыка';"), 'плашка-двойник подписана как пузырёк');
ok(appJs.includes('box.style.opacity = \'0\';') && appJs.includes("box.style.opacity = '';"),
  'окно проявляется только когда плашка долетела (иллюзия разворота из пузырька)');
ok(appJs.includes('const fr = fab.getBoundingClientRect();') && appJs.includes('if (!fr.width || !box.animate) return;'),
  'pkg3-94: открыли через меню «+» без пузырька — габарит нулевой, перелёт не рисуется');

console.log('\n  4. Текущий трек в списке');
ok(appJs.includes("'❚❚'") && appJs.includes("pb.textContent = isCur && !a.paused && !a.ended ? '❚❚' : '▶';"),
  'pkg3-96: у играющего трека значок ▶ живьём становится ❚❚ ровно на текущей строке');
ok(css.includes('@keyframes mus-mq') && appJs.includes('class="mq${'),
  'pkg3-96: бегущая строка заготовлена у каждого трека, едет у текущего — читается целиком');
ok(css.includes('.mus-tr.cur.paused .mq{animation-play-state:paused}'),
  'на паузе бегущая строка замирает');
ok(appJs.includes('if (MUS.plId === pl.id && MUS.idx === i && !musicIsWidget((pl.tracks || [])[i]))'),
  'нажатие на текущий трек — пауза/продолжить, а не перезапуск');

console.log('\n  5. Инварианты выпуска');
ok(appJs.includes("const BUILD = 'pkg3-105';") && apiJs.includes("const BUILD = 'pkg3-105';"), 'BUILD pkg3-105 совпадает в клиенте и на сервере');
ok(sw.includes("const STATIC_CACHE = 'sega-static-v98';"), 'кэш статики поднят до v93');
ok(pkg.includes('node test/music93.mjs'), 'тест music93 включён в цепочку npm test');
ok(readme.includes('| pkg3-93 |'), 'в журнале README есть строка выпуска pkg3-93');
const deps = JSON.parse(pkg).dependencies;
ok(Object.keys(deps).length === 1 && deps['web-push'], 'зависимость по-прежнему одна: web-push');
ok(appJs.includes("kind: 'music', note: musicStatusNote(), sync: musicStatusSync()") && apiJs.includes("'/api/music/follow-href'"),
  'механики pkg3-92 (якорь, тумблер, «Слушаю с …») не пострадали');

console.log('\n  pkg3-93: ' + good + ' ✓' + (bad ? ', ' + bad + ' ПРОВАЛОВ' : ', провалов нет'));
process.exit(bad ? 1 : 0);
