// pkg3-158: board skins belong to the game and are synchronized to both players.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readSrc } from './build.mjs';

const app = readSrc('public/app.js');
const api = readSrc('lib/api.js');
const css = readSrc('public/styles.css');
const sw = readSrc('public/sw.js');
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const skins = ['wood', 'antique', 'splatter', 'cracked', 'neon'];
let good = 0;
const ok = (condition, message) => { assert.ok(condition, message); good++; console.log('  ✓ ' + message); };
console.log('\n  pkg3-158 · общие скины шахматной и шашечной доски\n');
const rules = app.slice(app.indexOf('const GAME_BOARD_SKINS'), app.indexOf('const gameIcon ='));
ok(skins.every(id => rules.includes(`id: '${id}'`)), 'меню содержит все пять вариантов из примеров');
ok(rules.includes("'/board-skin'") || rules.includes("'/board-skin'"), 'клиент отправляет общий выбор на сервер');
ok(app.includes('data-board-skin="${boardSkin}"'), 'выбранный стиль назначается всей доске');
ok(app.includes("role === 'player' && (rules === 'chess' || rules === 'checkers')"), 'кнопка выбора доступна игрокам в шахматах и шашках');
ok(app.includes("ctrlL.push(`<button class=\"mini danger\" id=\"gm-leave\"")
  && app.indexOf('id="gm-leave"') < app.indexOf('id="gm-board-skin"'), '⋯ находится сразу справа от «Сдаться»');
ok(app.includes("api('/api/games/' + encodeURIComponent(c.id) + '/board-skin'"), 'клик сохраняет стиль у партии, не в localStorage');
ok(app.includes('await sync(false);') && app.includes('(c.game || {}).boardSkin || \'wood\''), 'изменение сервера заставляет обновить доску у всех клиентов');
ok(api.includes("pathname.endsWith('/board-skin')") && api.includes("(chat.roles || {})[me.id] !== 'player'"), 'сервер разрешает изменение только игроку партии');
ok(api.includes("['wood', 'antique', 'splatter', 'cracked', 'neon'].includes(skin)"), 'сервер валидирует список стилей');
ok(api.includes('roles: c.roles || null, game: c.game || null'), 'сервер синхронизирует стиль через обычную карточку игры');
for (const id of skins) {
  const file = ({ wood: 'board-skin-wood.png', antique: 'board-skin-antique.png', splatter: 'board-skin-splatter.png', cracked: 'board-skin-cracked.png', neon: 'board-skin-neon-preview.png' })[id];
  ok(fs.statSync(new URL('../public/img/' + file, import.meta.url)).size > 10000, `изображение «${id}» упаковано в приложение`);
}
ok(/\.board\[data-board-skin="wood"\][^{]*\{[^}]*board-skin-wood\.png/.test(css)
  && /\.board\[data-board-skin="cracked"\][^{]*\{[^}]*board-skin-cracked\.png/.test(css), 'деревянные скины лежат фоном всей доски');
ok(css.includes('.board[data-board-skin="neon"] .sq.dark') && css.includes('.board[data-board-skin="neon"] .sq.light'), 'неоновые плитки выровнены по клеткам 8×8');
ok(!fs.existsSync(new URL('../public/img/board-mark-crack.svg', import.meta.url))
  && !fs.existsSync(new URL('../public/img/board-mark-doodle.svg', import.meta.url)), 'прежние отдельные накладки удалены');
ok(sw.includes("const STATIC_CACHE = 'sega-static-v152'"), 'кэш статики повышен до v152');
ok(api.includes("const BUILD = 'pkg3-158'") && app.includes("const BUILD = 'pkg3-158'"), 'BUILD совпадает в клиенте и на сервере');
ok(pkg.scripts.test.includes('node test/boardskins158.mjs'), 'проверка скинов включена в npm test');
console.log(`\n  ИТОГ: ${good} ✓, провалов нет\n`);
