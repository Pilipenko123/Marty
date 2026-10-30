// test/music95.mjs — pkg3-95: пузырёк зарабатывается сворачиванием, крестик и
// шторка на своих местах, окно вмещается без внешней полосы, ❚❚/строка сразу.
// Набор меток клиента/стилей (сервер выпуска не менялся).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let good = 0, bad = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ПРОВАЛ: ') + m); if (c) good++; else bad++; };

console.log('\n══════════════════════════════════════════════════');
console.log('  pkg3-95: пузырёк по заслугам, шторка видна, окно вмещается, ❚❚ сразу');
console.log('══════════════════════════════════════════════════\n');

const appJs = read('public/app.js');
const css = read('public/styles.css');
const sw = read('public/sw.js');
const apiJs = read('lib/api.js');
const pkg = read('package.json');
const readme = read('README.md');

console.log('  1. Пузырёк не живёт сам по себе');
ok(appJs.includes('musFabEarned: false') && appJs.includes('!!S.token && S.musFabEarned && !S.musFabHidden && !S.musOpen'),
  'при первом открытии чата пузырька нет: видимость требует «заработан»');
ok(appJs.includes('S.musFabEarned = true;'), 'первое сворачивание шторкой зарабатывает пузырёк на сеанс');
ok(appJs.includes('S.musFabHidden = true;') && appJs.includes('if (MUS.widget) musWidgetStop();'),
  'крестик по-прежнему закрывает всё: окно, пузырёк, музыку (файл и виджет)');
ok(appJs.includes('function musStartFollow(') && appJs.includes('openMusic();'),
  '«Слушаю вместе» открывает окно; пузырёк появится, только если окно свернуть');

console.log('\n  2. ❚❚ и бегущая строка — сразу при старте трека');
ok(appJs.includes('function musRowsRerender(') && appJs.includes('musicNowUi(); musicFabSync(); musRowsRerender();'),
  'запуск трека перерисовывает список открытого окна: текущая строка получает ❚❚ и mq');
ok(appJs.includes("pb.textContent = isCur && !a.paused && !a.ended ? '❚❚' : '▶';"),
  'pkg3-96: живой значок паузы стоит ровно на текущей строке и обновляется тикером');
ok(css.includes('@keyframes mus-mq') && css.includes('.mus-tr.cur.paused .mq{animation-play-state:paused}'),
  'бегущая строка едет у текущего трека и замирает на паузе');
ok(appJs.includes('if (MUS.plId === pl.id && MUS.idx === i && !musicIsWidget((pl.tracks || [])[i]))'),
  'нажатие на текущий трек — пауза/продолжить');

console.log('\n  3. Окно вмещается, шторка видна');
ok(css.includes('#modal .modal-box{max-height:calc(100vh - 28px);display:flex;flex-direction:column;overflow:hidden}'),
  'окно музыки не выше окна мессенджера: внешней полосы прокрутки нет');
ok(css.includes('.mus-trs{flex:0 1 auto;min-height:60px;overflow:auto}') && css.includes('.mus-pls{flex:0 1 auto;min-height:60px;overflow:auto}'),
  'списки треков и плейлистов скроллятся внутри — их полосы сохранены');
ok(css.includes('.mus-shutter{position:absolute;top:6px;left:50%'),
  'шторка «Свернуть» видна полностью, ровно по центру верхней кромки');
ok(appJs.includes('box.insertBefore(mb, box.firstChild)'), 'шторка — первый элемент окна музыки');

console.log('\n  4. Инварианты выпуска');
ok(appJs.includes("const BUILD = 'pkg3-107';") && apiJs.includes("const BUILD = 'pkg3-107';"), 'BUILD pkg3-107 совпадает в клиенте и на сервере');
ok(sw.includes("const STATIC_CACHE = 'sega-static-v100';"), 'кэш статики поднят до v93');
ok(pkg.includes('node test/music95.mjs'), 'тест music95 включён в цепочку npm test');
ok(readme.includes('| pkg3-95 |'), 'в журнале README есть строка выпуска pkg3-95');
const deps = JSON.parse(pkg).dependencies;
ok(Object.keys(deps).length === 1 && deps['web-push'], 'зависимость по-прежнему одна: web-push');
ok(apiJs.includes("'/api/music/follow-href'") && appJs.includes('function musFly(') && appJs.includes('function musCloseFull('),
  'механики 92–94 (якорь, перелёт, крестик) не пострадали');

console.log('\n  pkg3-95: ' + good + ' ✓' + (bad ? ', ' + bad + ' ПРОВАЛОВ' : ', провалов нет'));
process.exit(bad ? 1 : 0);
