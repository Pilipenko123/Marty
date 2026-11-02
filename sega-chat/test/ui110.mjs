// test/ui110.mjs — pkg3-110: починка телефонной раскладки окна «Моя музыка».
//
// Что случилось в 109-м (скриншот владельца): контейнер окна .mus-wrap получал
// из общего правила `.mus-wrap{display:flex;flex-wrap:wrap}`, а в мобильном
// блоке задавалось только `flex-direction:column`. Содержимое не влезало по
// высоте, и браузер раскладывал его В КОЛОНКИ: правая часть (кнопки «Найти» и
// «⋯», три кнопки плеера, громкость) уезжала за правый край экрана и
// обрезалась, а подсказка шла одной длинной строкой.
//
// Теперь проверяем три вещи: (1) переноса в колонки нет, (2) раскладка —
// сетка с заранее известными строками, (3) ни один блок не может стать шире
// экрана. Плюс отметки выпуска.

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

// мобильный блок плеера — от метки до конца файла (он лежит последним)
const iMob = css.indexOf('pkg3-109/110: ТЕЛЕФОН');
const mob = iMob > 0 ? css.slice(iMob) : '';
// общий «резиновый» контейнер, из-за которого всё поехало
const wrapBase = (/\.mus-wrap\{[^}]*\}/.exec(css) || [''])[0];

console.log('\n══════════════════════════════════════════════════');
console.log('  pkg3-110: телефон — окно музыки влезает в экран');
console.log('══════════════════════════════════════════════════\n');

console.log('  1. Причина дефекта 109-го (перенос в колонки)');
ok(iMob > 0, 'мобильный блок плеера на месте и лежит в конце файла (перекрывает общие правила)');
ok(/flex-wrap:wrap/.test(wrapBase), 'общий контейнер .mus-wrap действительно «резиновый» (flex-wrap:wrap) — источник дефекта');
ok(/#modal\.mus-modal \.modal-body > \.mus-wrap\.mus-v105\{[^}]*flex-wrap:nowrap/s.test(mob),
  'у плеера перенос запрещён прямо (flex-wrap:nowrap) — вторая колонка справа больше не появляется');
ok(/#modal\.mus-modal \.modal-body > \.mus-wrap\.mus-v105\{[^}]*display:grid/s.test(mob),
  'раскладка плеера — сетка, а не «резиновая лента»');
ok(/#modal\.mus-modal \.modal-body > \.mus-wrap\.mus-v105\{[^}]*grid-template-rows:auto auto auto auto auto minmax\(0,1fr\) auto auto auto/s.test(mob),
  'строки заданы заранее: четыре «свои», список забирает остаток (minmax(0,1fr)), ниже — три кнопки и громкость');
ok(/#modal\.mus-modal \.modal-body > \.mus-wrap\.mus-v105\{[^}]*height:100%/s.test(mob),
  'сетка занимает всю высоту окна (иначе список не сможет прокручиваться внутри)');

console.log('\n  2. Ни один блок не шире экрана');
ok(/#modal\.mus-modal \.mus-wrap\.mus-v105 > \*\{[^}]*min-width:0/s.test(mob),
  'всем блокам окна разрешено ужиматься (min-width:0)');
ok(/#modal\.mus-modal \.mus-wrap\.mus-v105 > \*\{[^}]*max-width:100%/s.test(mob),
  'шире окна блоки не становятся (max-width:100%)');
ok(/#modal\.mus-modal \.modal-body\{[^}]*overflow:hidden/s.test(mob),
  'внутри окна прокручивается только список (overflow:hidden у тела окна)');
ok(/#modal\.mus-modal \.modal-box\{[^}]*width:100%/s.test(mob), 'окно музыки занимает всю ширину');
ok(/#modal\.mus-modal \.modal-box\{[^}]*height:100dvh/s.test(mob), 'окно музыки занимает всю высоту экрана');

console.log('\n  3. Строка поиска, подсказка и список');
ok(/#modal\.mus-modal \.mus-srow\{[^}]*flex-wrap:nowrap/s.test(mob), 'строка поиска не переносится вбок');
ok(/#modal\.mus-modal \.mus-srow input\{[^}]*flex:1 1 0/s.test(mob),
  'поле поиска тянется по остатку (flex:1 1 0), а не по своей «врождённой» ширине');
ok(/#modal\.mus-modal \.mus-srow \.mini\{[^}]*flex:0 0 auto/s.test(mob),
  'кнопки «Найти» и «⋯» остаются на экране и не сжимаются');
ok(/#modal\.mus-modal \.mus-sqbar\{[^}]*white-space:normal/s.test(mob),
  'подсказка снова переносится по словам, а не уезжает одной строкой за край');
ok(/#modal\.mus-modal \.mus-sqbar\{[^}]*-webkit-line-clamp:2/s.test(mob),
  'высота подсказки ограничена двумя строками («дальше многоточие»)');
ok(/#modal\.mus-modal \.mus-sqbar\{[^}]*max-height:2\.9em/s.test(mob), 'подсказка не растягивает окно по высоте');
ok(/#modal\.mus-modal \.mus-list\{[^}]*min-height:0/s.test(mob), 'список может ужаться до нуля — кнопки не выдавливаются');
ok(/#modal\.mus-modal \.mus-list\{[^}]*overflow-y:auto/s.test(mob), 'длинный список прокручивается внутри себя');
ok(/#modal\.mus-modal \.mus-list\{[^}]*overflow-x:hidden/s.test(mob), 'список не прокручивается вбок');

console.log('\n  4. Обложка, перемотка, кнопки, громкость');
ok(/#modal\.mus-modal \.mus-coverbox\{[^}]*max-height:22dvh/s.test(mob), 'обложка ужата до 22% высоты экрана');
ok(/#modal\.mus-modal \.mus-coverbox\{[^}]*width:100%/s.test(mob), 'обложка занимает ширину окна и не шире');
ok(/#modal\.mus-modal \.mus-three\{[^}]*gap:20px/s.test(mob), 'три кнопки плеера вписаны в свою строку');
ok(/#modal\.mus-modal \.mus-playbig\{width:60px;height:60px/.test(mob) && /#modal\.mus-modal \.mus-skip\{width:44px/.test(mob),
  'кнопки плеера удобного размера для пальца');
ok(/#modal\.mus-modal \.mus-foot\{[^}]*flex-wrap:nowrap/s.test(mob), 'низ окна (громкость и тумблер) не разъезжается');
ok(/#modal\.mus-modal \.mus-foot input\[type=range\]\{[^}]*min-width:40px/s.test(mob),
  'ползунок громкости не сжимается в ноль');
ok(/#modal\.mus-modal \.mus-sw-t\{[^}]*text-overflow:ellipsis/s.test(mob),
  'длинная подпись тумблера обрезается многоточием, а не вылезает за край');
ok(/max-height:640px/.test(mob) && /#modal\.mus-modal \.mus-coverbox\{max-height:16dvh\}/.test(mob),
  'на низком экране обложка ужимается, кнопки остаются на виду');
ok(/max-height:480px/.test(mob) && /#modal\.mus-modal \.mus-sqbar,\s*#modal\.mus-modal \.mus-cover-cap\{display:none\}/.test(mob),
  'на очень низком экране (телефон боком) подсказка и подпись убираются — плеер влезает целиком');
ok(mob.includes('#plus-scrim{display:block'), 'меню «+» по-прежнему приглушает список чатов на телефоне');

console.log('\n  5. Разметка окна не изменилась и не потеряла блоки');
for (const part of ['mus-srow', 'mus-sqbar', 'mus-coverbox', 'mus-list', 'mus-progline', 'mus-three', 'mus-foot']) {
  ok(app.includes(`class="${part}`) || app.includes(`${part}"`), `блок .${part} на месте в окне музыки`);
}
ok(/\{ cls: 'mus-modal' \}\)/.test(app), 'пометка окна музыки (mus-modal) на месте');
ok(!/\.modal-body > \.mus-wrap\.mus-v105\{[^}]*display:flex;flex-direction:column/s.test(css),
  'прежняя «резиновая» колонка из 109-го убрана');

console.log('\n  6. Отметки выпуска');
const b2 = /const BUILD = '([^']+)'/.exec(app)[1];
const cache = /const STATIC_CACHE = '([^']+)'/.exec(sw)[1];
ok(b2 === BUILD, `отметка выпуска совпадает в клиенте и в тестах (${BUILD})`);
ok(/const BUILD = '([^']+)'/.exec(api)[1] === BUILD, 'BUILD в lib/api.js тот же');
ok(new RegExp('\\| ' + BUILD + ' \\|').test(read(join(ROOT, 'README.md'))), `в журнале README есть строка ${BUILD}`);
ok(cache !== 'sega-static-v102', `кэш оформления поднят (${cache}) — телефон получит исправленный вид, а не старый`);
ok(html.includes('id="plus-scrim"'), 'приглушение меню «+» в разметке на месте');

console.log(`\n  ИТОГ: ${good} ✓, ${bad ? bad + ' провалов' : 'провалов нет'}\n`);
process.exit(bad ? 1 : 0);
