// test/music94.mjs — pkg3-94: пузырёк честно исчезает при развороте, крестик
// закрывает ВСЁ (окно, пузырёк, музыку, статус), «Свернуть» — шторка-язычок.
// Набор меток клиента/стилей (сервер выпуска не менялся).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let good = 0, bad = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ПРОВАЛ: ') + m); if (c) good++; else bad++; };

console.log('\n══════════════════════════════════════════════════');
console.log('  pkg3-94: пузырёк исчезает при развороте, крестик закрывает всё, шторка');
console.log('══════════════════════════════════════════════════\n');

const appJs = read('public/app.js');
const css = read('public/styles.css');
const sw = read('public/sw.js');
const apiJs = read('lib/api.js');
const pkg = read('package.json');
const readme = read('README.md');

console.log('  1. Пузырёк исчезает при разворачивании окна');
ok(!css.includes('.music-fab.on{') && !appJs.includes("fab.classList.toggle('on', true);"),
  'старое правило «.on = показывать» убрано: именно оно держало пузырёк поверх окна');
ok(appJs.includes('!S.musFabHidden && !S.musOpen'),
  'видимость пузырька решают только .auth: окно открыто — пузырька нет');
ok(appJs.includes('const fr = fab.getBoundingClientRect();\n  musicFabSync();'),
  'габарит пузырька берётся ПОКА он виден, затем пузырёк гаснет ДО перелёта');
ok(appJs.includes('if (!musWasOpen) musExpandAnim(); else musicFabSync();'),
  'повторные перерисовки окна не запускают перелёт и не оставляют пузырёк');

console.log('\n  2. Крестик «Закрыть» закрывает всё');
ok(appJs.includes('function musCloseFull(') && appJs.includes('if (MUS.widget) musWidgetStop();') && appJs.includes('if (a && !a.paused) a.pause();'),
  'крестик останавливает музыку: файл-плеер и виджет Яндекса');
ok(appJs.includes('S.musFabHidden = true;'), 'крестик прячет пузырёк совсем');
ok(appJs.includes('musStopFollow(true);'), '«Слушаю с …» завершается тихо вместе с закрытием');
ok(appJs.includes("kind: 'music', note: musicStatusNote(), sync: musicStatusSync()") && appJs.includes("{ kind: 'music-off' }"),
  'трансляция статуса гаснет: остановленный плеер шлёт music-off');

console.log('\n  3. «Свернуть» — шторка-язычок');
ok(appJs.includes("mb.className = 'mus-shutter';") && appJs.includes('box.insertBefore(mb, box.firstChild)'),
  'кнопка вставляется первым элементом окна музыки (поверх кромки)');
ok(css.includes('.mus-shutter{position:absolute;top:6px;left:50%') && css.includes('.modal-box{position:relative}'),
  'pkg3-95: шторка видна ПОЛНОСТЬЮ, ровно по центру верхней кромки окна');
ok(appJs.includes('if (mb) mb.remove();'), 'у прочих модалок шторка не остаётся');
ok(appJs.includes('mb.addEventListener(\'click\', () => musMinimize());'), 'шторка сворачивает окно в пузырёк перелётом');

console.log('\n  4. Инварианты выпуска');
ok(appJs.includes("const BUILD = 'pkg3-100';") && apiJs.includes("const BUILD = 'pkg3-100';"), 'BUILD pkg3-100 совпадает в клиенте и на сервере');
ok(sw.includes("const STATIC_CACHE = 'sega-static-v93';"), 'кэш статики поднят до v93');
ok(pkg.includes('node test/music94.mjs'), 'тест music94 включён в цепочку npm test');
ok(readme.includes('| pkg3-94 |'), 'в журнале README есть строка выпуска pkg3-94');
const deps = JSON.parse(pkg).dependencies;
ok(Object.keys(deps).length === 1 && deps['web-push'], 'зависимость по-прежнему одна: web-push');
ok(apiJs.includes("'/api/music/follow-href'") && appJs.includes('function musApplySync('),
  'механики pkg3-92/93 (якорь, тумблер, перелёт) не пострадали');

console.log('\n  pkg3-94: ' + good + ' ✓' + (bad ? ', ' + bad + ' ПРОВАЛОВ' : ', провалов нет'));
process.exit(bad ? 1 : 0);
