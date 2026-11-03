// test/ui119.mjs — pkg3-119: четыре правки по следам 118-го.
//
// Владелец (после «великолепно»):
//   1) на телефоне левая плашка с контактами — тоже со скруглёнными углами;
//   2) знак SEGA-CHAT в этой плашке в экономном режиме — серо-белый, в той же
//      тональности, что и оригинал (а не чёрный);
//   3) в светлой теме в окне «Моя музыка» не виден текст справа от обложки;
//   4) музыка участника группы не должна попадать в статус ГРУППОВОГО чата —
//      достаточно его личного статуса.
//
// Проверяем по исходникам: браузера в песочнице нет, вид оценивает владелец.

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
const near = frag => { const i = css.indexOf(frag); if (i < 0) return ''; const j = css.indexOf('}', i); return css.slice(i, j + 1); };
const i119 = css.indexOf('pkg3-119');

console.log('\n══════════════════════════════════════════════════');
console.log('  pkg3-119: телефонная плашка, знак в экономе,');
console.log('            текст у обложки, статус группы');
console.log('══════════════════════════════════════════════════\n');

console.log('  1. Телефон: левая плашка — карточка со скруглением');
const mobRail = near('#rail{\n    inset:calc(8px + env(safe-area-inset-top))');
ok(mobRail !== '', 'правило для телефонной плашки есть');
ok(/border-radius:var\(--r\)/.test(mobRail), 'углы скруглены так же, как на ПК (--r)');
ok(/border:1\.5px solid var\(--glow-line\)/.test(mobRail), 'и своя светящаяся рамка');
ok(/inset:calc\(8px \+ env\(safe-area-inset-top\)\) auto 8px 8px/.test(mobRail),
  'плашка отступает от краёв экрана — видно, что это карточка (и не лезет под «бровь»)');
ok(/box-shadow:var\(--glow-ring\),var\(--glow-halo\),var\(--shadow-soft\)/.test(mobRail), 'с ореолом и мягкой тенью');
const iZero = css.indexOf('#rail{border:0;border-right:1px solid var(--glow-line);border-radius:0');
ok(i119 > 0 && iZero > 0 && i119 < css.indexOf('#rail{\n    inset:calc(8px'), 'новое правило идёт последним — оно и побеждает');
ok(/@media \(max-width:900px\)\{[\s\S]{0,400}inset:calc\(8px/.test(css), 'правило включается только на телефоне');

console.log('\n  2. Экономный режим: знак — серо-белый, как в обычном виде');
const ecoLogo = near(':root[data-eco="1"] .rail-brand .logo{');
ok(/brightness\(0\) invert\(1\)/.test(ecoLogo), 'знак по-прежнему светлый (белый фильтр), а не чёрный');
ok(/opacity\(\.8\d\)/.test(ecoLogo), 'чуть приглушён — «серо-белый»');
ok(!/:root\[data-eco="1"\] \.rail-brand \.logo\{filter:brightness\(0\) opacity/.test(css), 'прежняя чёрная перекраска убрана');
const ecoHead = near(':root[data-eco="1"] #rail .rail-head{\n  background:linear-gradient(180deg,#4b5661');
ok(ecoHead !== '', 'плашка с логотипом в экономе остаётся тёмно-серой — знак на ней читается');
ok(/:root\[data-eco="1"\] \.rail-brand \.word\{color:#eef1f4\}/.test(css), 'слово CHAT — светло-серое');
ok(/:root\[data-eco="1"\] \.rail-brand \.sep\{background-color:#eef1f4\}/.test(css), 'разделитель — того же тона');
ok(/:root\[data-eco="1"\] \.lock-box\{border-color:#eef1f4\}/.test(css), 'овал — того же тона');

console.log('\n  3. Светлая тема: текст справа от обложки читается');
const nowt = near('.mus-v105 .mus-nowt{');
ok(/color:var\(--text\)/.test(nowt), 'название трека берёт цвет из темы (а не жёстко белый)');
ok(!/#f2f2f2/.test(nowt), 'прежнего белого в этом правиле нет');
ok(!/\.mus-v105 \.mus-nowt\{[^}]*color:#f2f2f2/.test(css), 'белый цвет не вернётся другим правилом');

console.log('\n  4. Статус группового чата больше не рассказывает про музыку');
ok(!app.includes('function musicLine('), 'функция сборки музыкальной строки для статуса удалена');
ok(!/\[typingLine\(c\), musicLine\(c\)\]/.test(app), 'в шапке группы больше нет подмешивания музыки');
ok(/const act = typingLine\(c\);/.test(app), 'в статусе группы остаётся только «пишет…» / «загружает…»');
ok(app.includes('const MUS_EQ =') && (app.match(/MUS_EQ \+/g) || []).length >= 3,
  'личные плашки «слушает» у участников остались (список чатов, личный чат, участники)');
ok(app.includes("+ 'слушает'"), 'и они по-прежнему подписаны «слушает»');
ok(app.includes('data-mus-follow='), 'по плашке по-прежнему можно «слушать вместе»');

console.log('\n  5. Отметки выпуска');
const b2 = (/const BUILD = '([^']+)'/.exec(app) || [])[1];
const cache = (/const STATIC_CACHE = '([^']+)'/.exec(sw) || [])[1];
ok(b2 === BUILD, `отметка выпуска в клиенте и в тестах одна (${BUILD})`);
ok(((/const BUILD = '([^']+)'/.exec(api) || [])[1]) === BUILD, 'BUILD в lib/api.js тот же');
ok(new RegExp('\\| ' + BUILD + ' \\|').test(read(join(ROOT, 'README.md'))), `в журнале README есть строка ${BUILD}`);
ok(cache !== 'sega-static-v111', `кэш оформления поднят (${cache}) — устройства получат правки`);

console.log(`\n  ИТОГ: ${good} ✓, ${bad ? bad + ' провалов' : 'провалов нет'}\n`);
process.exit(bad ? 1 : 0);
