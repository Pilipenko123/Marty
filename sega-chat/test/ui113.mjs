// test/ui113.mjs — pkg3-113: по скриншотам владельца к 112-му.
// Телефон: список раздулся на весь экран (кнопки ▶ ⏮ ⏭, громкость и тумблер
// ушли вниз за экран), полосы прокрутки не видно, одна строка — огромным
// шрифтом. Причины: (а) iPhone не понимает height:100% у обёртки внутри
// flex-ребёнка — колонка не знала своей высоты и росла по содержимому (в 111-м
// это скрывал потолок 220px у внутреннего списка, снятый в 112-м); (б) iPhone
// прячет полосу прокрутки, стили ::-webkit-scrollbar не помогают; (в) iPhone
// «раздувает» шрифт в широкой строке без переносов.
// Плюс пожелания: кнопки и низ — как на ПК; обложка и название в одной рамке
// без деления пополам; картинка вписана целиком без обрезки.
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
const win = app.slice(app.indexOf("modal('Моя музыка'"), app.indexOf('<span class="hidden" id="mus-now">'));
const rule = (sel, src) => (new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\{([^}]*)\\}').exec(src) || ['', ''])[1];

console.log('\n══════════════════════════════════════════════════');
console.log('  pkg3-113: телефон — список не раздувается, кнопки как на ПК');
console.log('══════════════════════════════════════════════════\n');

console.log('  1. Высота колонки задана надёжно (без height:100%)');
const body = rule('#modal.mus-modal .modal-body', mob);
ok(/display:flex;flex-direction:column/.test(body) && /min-height:0/.test(body) && /overflow:hidden/.test(body),
  'тело окна — flex-колонка с min-height:0 (растягивает обёртку на свою высоту)');
const wrap = rule('#modal.mus-modal .modal-body > .mus-wrap.mus-v105', mob);
ok(/flex:1 1 auto;min-height:0/.test(wrap) && /height:auto/.test(wrap) && !/height:100%/.test(wrap),
  'обёртка плеера растягивается как flex-ребёнок, height:100% больше не используется');
ok(/flex-flow:column nowrap/.test(wrap), 'колонка без переноса сохранена');
const lw = rule('#modal.mus-modal .mus-listwrap', mob);
ok(/flex:1 1 0;min-height:0/.test(lw) && /flex-flow:row nowrap/.test(lw), 'обёртка списка — единственный тянущийся блок, внутри список и полоса рядом');
ok(/#modal\.mus-modal \.mus-listwrap \.mus-list\{flex:1 1 0;min-width:0;min-height:0;height:auto;max-height:none\}/.test(mob),
  'список внутри обёртки может ужиматься до нуля и прокручивается сам');
ok(win.includes('<div class="mus-listwrap"><div class="mus-list" id="mus-list">${listHtml}</div><div class="mus-sbar none" id="mus-sbar" aria-hidden="true"><i></i></div></div>'),
  'разметка: обёртка → список + своя полоса');

console.log('\n  2. Постоянная полоса прокрутки на телефоне — своя');
ok(/function musSbarSync\(\)/.test(app), 'есть расчёт бегунка (musSbarSync)');
ok(/const need = sh > ch \+ 2;\s+bar\.classList\.toggle\('none', !need\);/.test(app), 'когда всё влезает — бегунка нет (дорожка остаётся)');
ok(/const h = Math\.max\(24, Math\.round\(th \* ch \/ sh\)\);/.test(app) && /const top = Math\.round\(\(th - h\) \* \(list\.scrollTop \/ \(sh - ch\)\)\);/.test(app),
  'высота и положение бегунка — из прокрутки списка, не короче 24px');
ok(/list0\.addEventListener\('scroll', musSbarSync, \{ passive: true \}\)/.test(app), 'бегунок едет при прокрутке');
ok(/musFitList\(\);\s+\/\/ pkg3-114: высота списка числом \(телефон\)/.test(app) && /lw\.style\.height = h \+ 'px'[^\n]*\n[\s\S]{0,200}musSbarSync\(\);/.test(app), 'и пересчитывается на тике звука вместе с высотой списка (pkg3-114)');
ok(/window\.addEventListener\('resize', \(\) => \{ if \(S\.musOpen\) musFitList\(\); \}\);/.test(app), 'и при повороте/смене размера (через пересчёт высоты, pkg3-114)');
ok(/#modal\.mus-modal \.mus-sbar\{display:block;flex:0 0 6px;width:6px;border-radius:3px;background:var\(--panel-2\);border:1px solid var\(--line\)/.test(mob), 'дорожка 6px всегда видна (цвета как на ПК)');
ok(/#modal\.mus-modal \.mus-sbar i\{[^}]*background:var\(--accent-2\);min-height:24px\}/.test(mob), 'бегунок акцентного цвета');
ok(/#modal\.mus-modal \.mus-list\{[^}]*scrollbar-width:none/.test(mob) && /#modal\.mus-modal \.mus-list::-webkit-scrollbar\{display:none/.test(mob), 'родная полоса спрятана — двух полос не будет');
ok(/\.mus-v105 \.mus-sbar\{display:none\}/.test(css), 'на ПК своя полоса не показывается — там родная');

console.log('\n  3. Кнопки, громкость и тумблер — как на ПК');
ok(/\.mus-v105 \.mus-playbig\{width:58px;height:58px/.test(css) && /#modal\.mus-modal \.mus-playbig\{width:58px;height:58px;font-size:19px\}/.test(mob), '▶: 58×58 и там и там');
ok(/\.mus-v105 \.mus-skip\{width:58px;height:58px/.test(css) && /#modal\.mus-modal \.mus-skip\{width:58px;height:58px;font-size:19px\}/.test(mob), '⏮ ⏭: 58×58 и там и там');
ok(!/#modal\.mus-modal \.mus-skip\{background:#17171c/.test(mob), 'отдельной «телефонной» раскраски ⏮ ⏭ нет — цвет как на ПК');
ok(/#modal\.mus-modal \.mus-three\{margin:4px 0;gap:18px\}/.test(mob) && /\.mus-v105 \.mus-three\{[^}]*gap:18px/.test(css), 'промежуток между кнопками одинаковый');
ok(/#modal\.mus-modal \.mus-foot\{border-top:1px solid var\(--line\);padding-top:10px;gap:10px\}/.test(mob), 'низ (громкость + тумблер) с линией и отступами как на ПК');

console.log('\n  4. Обложка и название — одна рамка, картинка целиком');
const cov = rule('.mus-v105 .mus-coverbox', css);
ok(/grid-template-columns:44% 1fr/.test(cov) && !/1fr 1fr/.test(cov), 'деления ровно пополам нет: обложка слева (44%), название справа');
ok(/border-radius:14px/.test(cov) && /border:1px solid var\(--line\)/.test(cov) && /background:#05080f/.test(cov), 'одна общая закруглённая рамка с единым фоном');
const left = rule('.mus-v105 .mus-cov-left', css);
ok(/padding:10px/.test(left) && !/border-right/.test(left) && !/background:#120b1e/.test(left), 'слева нет перегородки и своего фона, есть поля вокруг картинки');
ok(/\.mus-v105 \.mus-cov-left img,\.mus-v105 \.mus-cov-left svg\{max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain/.test(css),
  'картинка вписана целиком без обрезки');
ok(/#modal\.mus-modal \.mus-coverbox\{border-radius:14px;background:#000\}/.test(mob) && !/#modal\.mus-modal \.mus-cov-left\{border-right/.test(mob),
  'на телефоне — та же единая рамка (цвет как на ПК) на чёрном');
ok(/if \(!covBox\.querySelector\('\.mus-cov-def'\) \|\| !covOvl\) return;/.test(app), 'выбор обложки открывается касанием по всей левой части (не только по картинке)');

console.log('\n  5. iPhone не раздувает шрифт длинных названий');
ok(/\.mus-v105 \.mus-ti\{[^}]*-webkit-text-size-adjust:100%;text-size-adjust:100%\}/.test(css), 'строке названия запрещено авто-увеличение шрифта');

console.log('\n  6. Отметки выпуска');
const b2 = /const BUILD = '([^']+)'/.exec(app)[1];
const cache = /const STATIC_CACHE = '([^']+)'/.exec(sw)[1];
ok(b2 === BUILD && /const BUILD = '([^']+)'/.exec(api)[1] === BUILD, `отметка выпуска совпадает в клиенте и сервере (${BUILD})`);
ok(new RegExp('\\| ' + BUILD + ' \\|').test(read(join(ROOT, 'README.md'))), `в журнале README есть строка ${BUILD}`);
ok(cache !== 'sega-static-v105' && /^sega-static-v\d+$/.test(cache), `кэш оформления поднят (${cache})`);
ok(!/"dependencies":\s*\{[^}]*"(?!web-push)[a-z@][^"]*"/.test(read(join(ROOT, 'package.json'))), 'новых рантайм-зависимостей нет');

console.log(`\n  ИТОГ: ${good} ✓, ${bad ? bad + ' провалов' : 'провалов нет'}\n`);
process.exit(bad ? 1 : 0);
