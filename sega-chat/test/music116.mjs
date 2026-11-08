// test/music116.mjs — pkg3-116: два пожелания владельца к 115-му.
//  1) Полоса-гистограмма живёт ТОЛЬКО со звуком: появляется с первой секунды
//     воспроизведения, исчезает ровно в конце трека. Не заиграло — полосы нет.
//  2) Трек, который не удалось воспроизвести, пропускается: включается следующий
//     по списку; перебрали весь список — честная остановка с причиной.
//  3) На телефоне выехавшая клавиатура больше НЕ сдвигает окно «Моя музыка»
//     вниз (была чёрная полоса сверху).
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

let good = 0, bad = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ПРОВАЛ: ') + m); if (c) good++; else bad++; };

const iMob = css.indexOf('pkg3-109/110: ТЕЛЕФОН');
const mob = iMob > 0 ? css.slice(iMob) : '';
const viz = app.slice(app.indexOf('const MUS_VIZ_FROM'), app.indexOf('function musVizSync()'));
const fit = app.slice(app.indexOf('function musKbOpen()'), app.indexOf('function musSbarSync()'));
const dead = app.slice(app.indexOf('function musTrackDead('), app.indexOf('/** pkg3-95: строки плейлиста'));

console.log('\n══════════════════════════════════════════════════');
console.log('  pkg3-116: гистограмма со звуком, пропуск битых треков, клавиатура');
console.log('══════════════════════════════════════════════════\n');

console.log('  1. Гистограмма — только во время звучания');
ok(/const MUS_VIZ_FROM = 1;/.test(app), 'порог «первая секунда» задан числом (MUS_VIZ_FROM = 1)');
ok(/a\.currentTime >= MUS_VIZ_FROM/.test(viz), 'полоса включается не раньше первой секунды воспроизведения');
ok(/!MUS\.dead/.test(viz) && /!a\.ended/.test(viz), 'отказавший трек и конец трека гасят полосу');
ok(/if \(!has\) return 'off';/.test(viz) && /return \(!a\.paused && !S\.eco\) \? 'on' : 'still';/.test(viz),
  'три состояния сохранены: пусто / движется / стоп-кадр на паузе');
ok(/function musVizArm\(\)/.test(app) && /MUS\.vizTimer = setTimeout\(\(\) => \{ MUS\.vizTimer = 0; musVizSync\(\); \}, 1200\);/.test(app),
  'будильник на 1,2 с — полоса не «залипает», если браузер не прислал тик вовремя');
ok(/MUS\.a\.addEventListener\('playing', \(\) => \{ MUS\.fails = 0; MUS\.dead = false; musVizArm\(\); \}\);/.test(app),
  'как только звук пошёл — отказы прощены, полоса разбужена');
ok(/musVizArm\(\);\s*\n\s*musicNowUi\(\); musicFabSync\(\); musRowsRerender\(\); musicTickUi\(\);/.test(app),
  'запуск трека взводит будильник заново (у каждого трека своя первая секунда)');

console.log('\n  2. Битый трек пропускается, включается следующий');
ok(/function musTrackDead\(viaProxy, track, reason\)/.test(app), 'есть отдельная обработка «трек не заиграл»');
ok(/musStartStream\(musicAudio\(\), t\.url, p => musTrackDead\(p, t\), \{ pod: t\.site === 'podcasts' \}\);/.test(app),
  'плеер зовёт её вместо простой подсказки');
ok(/const next = \(MUS\.idx \+ 1\) % n;/.test(dead), 'следующий трек берётся по кругу — список не обрывается на последнем');
ok(/musicPlay\(musicFind\(MUS\.plId\) \|\| \{ id: MUS\.plId, tracks: MUS\.list \}, next, \{ keepFails: true \}\);/.test(dead),
  'запуск идёт через общий musicPlay, счётчик отказов сохраняется');
ok(/if \(!n \|\| MUS\.fails \+ 2 > n\)/.test(dead),
  'защита от вечного перебора: перебрали весь список — останавливаемся');
ok(/MUS\.idx = -1;/.test(dead) && /toast\(reason \|\| musDeadMsg\(viaProxy\), true\);/.test(dead),
  'после полного круга — «стоп» и честная причина отказа');
ok(/if \(!opts \|\| !opts\.keepFails\) MUS\.fails = 0;/.test(app), 'запуск трека руками обнуляет счётчик отказов');
ok(/MUS\.dead = true;\s*\n\s*musVizSync\(\);/.test(dead), 'на отказе полоса гаснет сразу, без пустого кадра');
ok(/«' \+ name\.slice\(0, 70\) \+ '» не проигрался — включаю следующий'/.test(dead),
  'человеку видно, ЧТО не проигралось и что включён следующий');
ok(/function musTrackDead\(viaProxy, track, reason\)/.test(app) && /toast\(reason \|\| musDeadMsg\(viaProxy\), true\);/.test(dead),
  'причину можно передать словами — для трека с Яндекс.Диска она своя');
// pkg3-148: у Диска теперь два пути, и в отказе видны обе причины
ok(/musTrackDead\(false, t, 'Трек с Диска не заиграл — ' \+ problems\.join/.test(app),
  'файл с Диска не отдался — тоже пропуск и переход к следующему (с двумя причинами)');

console.log('\n  3. Клавиатура не сдвигает окно вниз (телефон)');
ok(/#modal\.mus-modal\{padding:0;overflow:hidden;align-items:flex-start\}/.test(mob),
  'верх окна прибит к верху экрана — центрирование по вертикали больше не сдвигает его вниз');
ok(/html\.mus-lock,html\.mus-lock body\{overflow:hidden;height:100%;overscroll-behavior:none\}/.test(css),
  'пока окно музыки открыто, страница не прокручивается (клавиатура не «тянет» документ)');
ok(/function musKbOpen\(\)/.test(app) && /vv\.height < \(MUS\.vvBase \|\| window\.innerHeight \|\| vv\.height\) - 80/.test(app),
  'клавиатура узнаётся по уменьшению видимой высоты экрана');
ok(/ae\.closest\('#modal\.mus-modal'\)/.test(app), '…и только если поле в фокусе принадлежит окну музыки');
ok(/const kb = !land && musKbOpen\(\);/.test(fit), 'в расчёте высоты есть отдельная ветка «клавиатура выехала»');
ok(/const vhUse = kb \? \(MUS\.fitH \|\| MUS\.vvBase \|\| vh\) : vh;/.test(fit),
  'высота окна при клавиатуре берётся прежняя — окно не сжимается и не съезжает');
ok(/if \(!kb\) \{ MUS\.vvBase = vh; MUS\.fitH = land \? 0 : vh; \}/.test(fit), 'без клавиатуры высота запоминается заново');
ok(/MUS\.fitH = 0; MUS\.vvBase = 0;/.test(app) && /musLockScroll\(true\);/.test(app), 'открытие окна: свежие высоты и запрет прокрутки страницы');
ok(/const kbWrap = document\.querySelector\('#modal\.mus-modal \.mus-wrap'\);\s*\n\s*if \(kbWrap\) kbWrap\.addEventListener\('focusin'/.test(app),
  'касание поля поиска пересчитывает высоты, но не двигает окно');
ok((app.match(/musLockScroll\(false\);/g) || []).length === 3,
  'прокрутка возвращается на место и при сворачивании, и при закрытии, и когда окна нет');

console.log('\n  4. Отметки выпуска');
const b2 = /const BUILD = '([^']+)'/.exec(app)[1];
const cache = /const STATIC_CACHE = '([^']+)'/.exec(sw)[1];
ok(b2 === BUILD && /const BUILD = '([^']+)'/.exec(api)[1] === BUILD, `отметка выпуска совпадает в клиенте и сервере (${BUILD})`);
ok(new RegExp('\\| ' + BUILD + ' \\|').test(read(join(ROOT, 'README.md'))), `в журнале README есть строка ${BUILD}`);
ok(cache !== 'sega-static-v108' && /^sega-static-v\d+$/.test(cache), `кэш оформления поднят (${cache})`);
ok(!/"dependencies":\s*\{[^}]*"(?!web-push)[a-z@][^"]*"/.test(read(join(ROOT, 'package.json'))), 'новых рантайм-зависимостей нет');

console.log(`\n  ИТОГ: ${good} ✓, ${bad ? bad + ' провалов' : 'провалов нет'}\n`);
process.exit(bad ? 1 : 0);
