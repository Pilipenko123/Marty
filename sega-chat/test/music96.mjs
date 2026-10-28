// test/music96.mjs — pkg3-96: строки плейлиста живут вместе с плеером:
// ❚❚ и бегущая строка переезжают на новый трек сразу, без сворачивания окна.
// Набор меток клиента/стилей (сервер выпуска не менялся).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let good = 0, bad = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ПРОВАЛ: ') + m); if (c) good++; else bad++; };

console.log('\n══════════════════════════════════════════════════');
console.log('  pkg3-96: ❚❚ и бегущая строка переезжают на новый трек сразу');
console.log('══════════════════════════════════════════════════\n');

const appJs = read('public/app.js');
const css = read('public/styles.css');
const sw = read('public/sw.js');
const apiJs = read('lib/api.js');
const pkg = read('package.json');
const readme = read('README.md');

console.log('  1. Список следует за плеером');
ok(appJs.includes('<div class="mus-trs" data-pl="${pl.id}">'),
  'список треков помнит, какой плейлист нарисован (data-pl)');
ok(appJs.includes("const rowsBox = document.querySelector('#modal .mus-trs[data-pl]');") && appJs.includes("row.classList.toggle('cur', isCur);"),
  'каждый тик плеера переставляет метку текущей строки на настоящий трек');
ok(appJs.includes("if (pb) pb.textContent = isCur && !a.paused && !a.ended ? '❚❚' : '▶';"),
  '❚❚ живёт ровно на текущей строке, на остальных всегда ▶');
ok(appJs.includes('musicNowUi(); musicFabSync(); musRowsRerender(); musicTickUi();'),
  'сразу после старта трека список помечен без ожидания первого тика');
ok(appJs.includes("row.classList.toggle('paused', !!(a.paused || a.ended));"),
  'на паузе бегущая строка замирает у текущей строки');

console.log('\n  2. Бегущая строка заготовлена у каждого трека');
ok(css.includes('.mus-tr .mq{display:inline-block;white-space:nowrap;max-width:100%}'),
  'mq-обёртка есть у каждой строки списка');
ok(css.includes('.mus-tr.cur .mq{padding-left:100%;animation:mus-mq 9s linear infinite}'),
  'едет и отъезжает справа только текущая строка');
ok(css.includes('.mus-tr.cur.paused .mq{animation-play-state:paused}'),
  'пауза останавливает строку');
ok(appJs.includes("mq-s") && css.includes('.mus-tr.cur .mq.mq-s{animation:none;padding-left:0}'),
  'короткие названия (до 24 знаков) стоят на месте и видны целиком; длинные едут');

console.log('\n  3. Инварианты выпуска');
ok(appJs.includes("const BUILD = 'pkg3-96';") && apiJs.includes("const BUILD = 'pkg3-96';"), 'BUILD pkg3-96 совпадает в клиенте и на сервере');
ok(sw.includes("const STATIC_CACHE = 'sega-static-v89';"), 'кэш статики поднят до v89');
ok(pkg.includes('node test/music96.mjs'), 'тест music96 включён в цепочку npm test');
ok(readme.includes('| pkg3-96 |'), 'в журнале README есть строка выпуска pkg3-96');
const deps = JSON.parse(pkg).dependencies;
ok(Object.keys(deps).length === 1 && deps['web-push'], 'зависимость по-прежнему одна: web-push');
ok(appJs.includes('function musRowsRerender(') && appJs.includes('S.musFabEarned') && appJs.includes('function musCloseFull('),
  'механики 93–95 (перерисовка, пузырёк по заслугам, крестик) не пострадали');

console.log('\n  pkg3-96: ' + good + ' ✓' + (bad ? ', ' + bad + ' ПРОВАЛОВ' : ', провалов нет'));
process.exit(bad ? 1 : 0);
