// pkg3-157: personalizable transparent doodles on chess/checkers boards.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readSrc } from './build.mjs';

const app = readSrc('public/app.js');
const css = readSrc('public/styles.css');
const sw = readSrc('public/sw.js');
const api = readSrc('lib/api.js');
const crack = readSrc('public/img/board-mark-crack.svg');
const doodle = readSrc('public/img/board-mark-doodle.svg');
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const ok = (condition, message) => { assert.ok(condition, message); console.log('  ✓ ' + message); };
console.log('\n  pkg3-157 · рисунки на досках шахмат и шашек\n');
const render = app.slice(app.indexOf('function renderBoard()'), app.indexOf('function sbBoardHtml('));
ok(render.includes('rules === \'chess\' || rules === \'checkers\''), 'инструмент добавляется только к шахматам и шашкам');
ok(render.includes('id="gm-board-mark"') && render.includes('>⋯</button>'), 'кнопка ⋯ добавлена рядом с кнопкой выхода');
ok(render.indexOf('id="gm-leave"') < render.indexOf('id="gm-board-mark"'), 'кнопка ⋯ следует за кнопкой «Сдаться/Покинуть»');
ok(app.includes("['off', 'Без рисунка', '']") && app.includes("['crack', 'Трещина'") && app.includes("['doodle', 'Рисунок'"), 'меню предлагает отключение, трещину и рисунок');
ok(app.includes("localStorage.setItem(GAME_BOARD_MARK_KEY, next)"), 'выбор сохраняется только локально на этом устройстве');
ok(render.includes('class="board-mark"') && render.includes('${cells}${boardMarkSrc ?'), 'декорация добавляется поверх клеток прозрачным слоем');
ok(/\.board-mark\{[^}]*right:1\.5%;top:1\.5%/.test(css), 'изображение закреплено в правом верхнем углу доски');
ok(/\.board-mark\{[^}]*z-index:2/.test(css) && /\.pcimg,\.ckd\{z-index:3;\}/.test(css), 'контур находится ниже шахматных фигур и шашек');
ok(/\.board-mark\{[^}]*pointer-events:none/.test(css), 'изображение не перехватывает ходы мышью и касанием');
for (const [name, svg] of [['трещина', crack], ['рисунок', doodle]]) {
  ok(svg.includes('viewBox="0 0 100 100"') && !/fill="#fff|fill="white"/i.test(svg), name + ' — SVG без белой подложки');
  ok(/stroke="#080808"/.test(svg), name + ' нарисован чёрным контуром');
}
ok(sw.includes("const STATIC_CACHE = 'sega-static-v151'"), 'кэш оформления повышен до v151');
ok(api.includes("const BUILD = 'pkg3-157'") && app.includes("const BUILD = 'pkg3-157'"), 'BUILD синхронно обновлён в сервере и клиенте');
ok(pkg.scripts.test.includes('node test/boardmarks157.mjs'), 'тест включён в npm test');
console.log('\n  ИТОГ: 16 ✓, провалов нет\n');
