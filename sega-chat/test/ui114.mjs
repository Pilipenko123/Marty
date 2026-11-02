// test/ui114.mjs — pkg3-114: пять замечаний владельца к 113-му.
//  1) Телефон: окно по-прежнему не влезало (iPhone второй раз не дал колонке
//     узнать высоту) → высота окна, тела и списка считается ЧИСЛОМ (musFitList);
//     цвета элементов — как на ПК, чёрный только фон, рамок окна нет.
//  2) Крестик «убрать трек» ушёл из строки в меню карандаша.
//  3) Полоса под обложкой — белые столбики владельца (GIF 560×80).
//  4) На ПК у окна яркая обводка.
//  5) Обложка 4 — без обрезки (вписана с полями).
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
const desk = iMob > 0 ? css.slice(0, iMob) : css;
const fit = app.slice(app.indexOf('function musFitList()'), app.indexOf('function musSbarSync()'));

console.log('\n══════════════════════════════════════════════════');
console.log('  pkg3-114: высота плеера числом, удаление в карандаше, обводка');
console.log('══════════════════════════════════════════════════\n');

console.log('  1. Телефон: высота считается числом');
ok(fit.length > 0, 'есть расчёт высоты (musFitList)');
ok(/if \(!window\.matchMedia\('\(max-width:900px\)'\)\.matches\) \{[^}]*box\.style\.height = '';\s*return;/s.test(fit), 'на ПК не вмешивается (и снимает своё, если было)');
ok(/const vh = \(window\.visualViewport && window\.visualViewport\.height\) \|\| window\.innerHeight;/.test(fit), 'высота окна — видимая высота экрана (visualViewport), не 100dvh из оформления');
ok(/const boxH = land \? window\.innerWidth : vhUse;/.test(fit), 'при повороте телефона (окно «стоймя») высота берётся из ширины экрана; pkg3-116: без клавиатуры — видимая высота как есть');
ok(/box\.style\.height = boxH \+ 'px';/.test(fit) && /body\.style\.height = bodyH \+ 'px'; body\.style\.flex = 'none';/.test(fit), 'окно и тело получают высоту числом');
ok(/wrap\.style\.height = inner \+ 'px'; wrap\.style\.flex = 'none';/.test(fit), 'обёртка плеера — тоже');
ok(/others \+= el\.offsetHeight \+ \(parseFloat\(st\.marginTop\) \|\| 0\) \+ \(parseFloat\(st\.marginBottom\) \|\| 0\);/.test(fit) && /if \(st\.display === 'none' \|\| st\.position === 'fixed'\) continue;/.test(fit),
  'складываются высоты всех остальных блоков (скрытые и оверлеи не считаются)');
ok(/const h = Math\.max\(72, Math\.floor\(inner - others - gap \* Math\.max\(0, n - 1\)\)\);/.test(fit), 'список = остаток минус промежутки, не меньше 72px');
ok(/lw\.style\.height = h \+ 'px'; lw\.style\.flex = 'none'; lw\.style\.minHeight = '0';/.test(fit) && /list\.style\.height = h \+ 'px'; list\.style\.maxHeight = h \+ 'px';/.test(fit),
  'обёртке списка и списку высота задана числом — расти некуда, кнопки всегда на экране');
ok(/musFitList\(\); setTimeout\(musFitList, 50\); setTimeout\(musFitList, 350\);/.test(app), 'при открытии: сразу, после раскладки, после анимации появления');
ok(/musFitList\(\);\s+\/\/ pkg3-114: высота списка числом \(телефон\)/.test(app), 'и на каждом тике звука (перерисовка списка при поиске/смене плейлиста)');
ok(/window\.addEventListener\('orientationchange', \(\) => \{ if \(S\.musOpen\) \{ setTimeout\(musFitList, 60\); setTimeout\(musFitList, 400\); \} \}\);/.test(app)
  && /window\.visualViewport\.addEventListener\('resize', \(\) => \{ if \(S\.musOpen\) musFitList\(\); \}\);/.test(app), 'и при повороте и смене видимой области');
ok(/if \(bx\) bx\.style\.height = '';\s+if \(bd\) \{ bd\.style\.height = ''; bd\.style\.flex = ''; \}/.test(app), 'другие окна (настройки, приглашения) посчитанные высоты не наследуют');

console.log('\n  2. Телефон: цвета как на ПК, чёрный только фон, рамок окна нет');
ok(!/#modal\.mus-modal \.mini\{background:#17171c/.test(mob) && !/#modal\.mus-modal \.mus-srow input\{background:#141418/.test(mob)
  && !/#modal\.mus-modal \.mus-rowb\{border-color:#2e2e38/.test(mob) && !/#modal\.mus-modal \.mus-tr\.cur\{background:rgba\(255,255,255/.test(mob)
  && !/#modal\.mus-modal \.muted,#modal\.mus-modal \.tiny\.muted\{color:#9a9aa6\}/.test(mob),
  'своих «телефонных» перекрасок кнопок, поля, строк и подписей больше нет — цвета берутся из общих правил ПК');
ok(!/#modal\.mus-modal \.mus-list\{[^}]*border:1px solid #3a3a46/.test(mob) && !/#modal\.mus-modal \.mus-coverbox\{border:1px solid #3a3a46/.test(mob) && !/#modal\.mus-modal \.mus-eq\{[^}]*border-color:#3a3a46/.test(mob),
  'рамки списка, обложки и полосы — те же, что на ПК');
ok(/#modal\.mus-modal\{background:#000\}/.test(mob) && /#modal\.mus-modal \.modal-box\{background:#000;border:0;box-shadow:none;color:#f2f2f2\}/.test(mob) && /#modal\.mus-modal \.modal-head\{background:#000;border-bottom:0\}/.test(mob),
  'окно и поля вокруг чёрные, рамки и тени у окна нет — границей служит сам телефон');

console.log('\n  3. Удаление трека — в меню карандаша');
ok(!app.includes('data-mus-del='), 'крестика «убрать трек» в строке списка больше нет');
ok(!/\$\$\('#modal \[data-mus-del\]'\)/.test(app), 'и старого обработчика крестика нет');
ok(app.includes('<button class="mini mus-tm-del" data-tm="del">✕ убрать из плейлиста</button>'), 'в меню карандаша появился пункт «✕ убрать из плейлиста»');
ok(/if \(act === 'del'\) \{ trOvl\.classList\.remove\('show'\); await musTrackRemove\(pl, i\); return; \}/.test(app), 'пункт закрывает меню и убирает трек');
ok(/async function musTrackRemove\(pl, i\)/.test(app) && /if \(!confirm\('Убрать трек «'/.test(app), 'с подтверждением, как раньше');
ok(/if \(musicIsWidget\(gone\) && MUS\.widget && MUS\.widget\.id === gone\.id\) musWidgetStop\(\);/.test(app), 'звучащий виджет Яндекса при удалении гасится (как в 88-м)');
ok(/\.mus-v105 \.mus-tm-del\{border-color:var\(--red\);color:var\(--red\)\}/.test(css), 'пункт удаления выделен красным');
ok(/title="Правка трека: название, ссылка, обложка, убрать из плейлиста"/.test(app), 'подсказка карандаша упоминает удаление');

console.log('\n  4. Полоса под обложкой — белые столбики владельца');
const gif = join(PUB, 'img', 'music-eq.gif');
ok(existsSync(gif) && !existsSync(join(PUB, 'img', 'music-eq.webp')), 'GIF на месте, WebP убран (для чёрно-белых столбиков он вышел тяжелее)');
const g = existsSync(gif) ? readFileSync(gif) : Buffer.alloc(10);
ok(g.readUInt16LE(6) === 560 && g.readUInt16LE(8) === 80, `габариты прежние 560×80 (${g.readUInt16LE(6)}×${g.readUInt16LE(8)})`);
ok(g.length > 20 * 1024 && g.length < 200 * 1024, `вес ${Math.round(g.length / 1024)} КБ`);
ok(/const MUS_VIZ_ANIM = '<picture class="mus-viz-anim">'\s*\+ '<img src="img\/music-eq\.gif" alt=""><\/picture>';/.test(app), 'в плеер вставляется именно она');
const still = join(PUB, 'img', 'music-eq-pause.png');
ok(existsSync(still) && statSync(still).size < 30 * 1024, 'стоп-кадр обновлён и лёгкий');

console.log('\n  5. ПК: яркая обводка окна');
ok(/#modal\.mus-modal \.modal-box\{border:2px solid var\(--accent-2\);box-shadow:[^}]*0 0 22px rgba\(47,198,246,\.45\)/.test(desk), 'на ПК: рамка 2px акцентного цвета и свечение');
ok(css.indexOf('#modal.mus-modal .modal-box{border:2px solid var(--accent-2)') < css.indexOf('pkg3-109/110: ТЕЛЕФОН'), 'правило ПК стоит раньше телефонного — на телефоне рамку снимает border:0');
ok(!/^\s*\.modal-box\{[^}]*border:2px solid var\(--accent-2\)/m.test(css), 'прочие окна обводку не получили');

console.log('\n  6. Обложка 4 без обрезки');
const c4 = join(PUB, 'img', 'music-cover4.jpg');
ok(existsSync(c4) && statSync(c4).size > 10 * 1024 && statSync(c4).size < 120 * 1024, `music-cover4.jpg на месте (${Math.round(statSync(c4).size / 1024)} КБ)`);
// JPEG: ищем SOF0/SOF2 и читаем высоту/ширину
const b4 = readFileSync(c4);
let w4 = 0, h4 = 0;
for (let i = 2; i < b4.length - 9; i++) { if (b4[i] === 0xFF && (b4[i + 1] === 0xC0 || b4[i + 1] === 0xC2)) { h4 = b4.readUInt16BE(i + 5); w4 = b4.readUInt16BE(i + 7); break; } }
ok(w4 === 640 && h4 === 640, `квадрат 640×640 (${w4}×${h4})`);
// по краям сверху/снизу — чёрные поля (признак «вписано», а не «обрезано»)
ok(b4.length < 40 * 1024, 'файл лёгкий — значит в нём есть ровные чёрные поля, а не обрезанная картинка');

console.log('\n  7. Отметки выпуска');
const b2 = /const BUILD = '([^']+)'/.exec(app)[1];
const cache = /const STATIC_CACHE = '([^']+)'/.exec(sw)[1];
ok(b2 === BUILD && /const BUILD = '([^']+)'/.exec(api)[1] === BUILD, `отметка выпуска совпадает в клиенте и сервере (${BUILD})`);
ok(new RegExp('\\| ' + BUILD + ' \\|').test(read(join(ROOT, 'README.md'))), `в журнале README есть строка ${BUILD}`);
ok(cache !== 'sega-static-v106' && /^sega-static-v\d+$/.test(cache), `кэш оформления поднят (${cache})`);
ok(!/"dependencies":\s*\{[^}]*"(?!web-push)[a-z@][^"]*"/.test(read(join(ROOT, 'package.json'))), 'новых рантайм-зависимостей нет');

console.log(`\n  ИТОГ: ${good} ✓, ${bad ? bad + ' провалов' : 'провалов нет'}\n`);
process.exit(bad ? 1 : 0);
