// test/music107.mjs — pkg3-107: спасение звука при светомузыке.
// Урок владельца: включил шкалы — музыка тут же пропала, а шкалы прыгают.
// Причина: привязка элемента к AudioContext необратима; спящий контекст держит
// звук взаперти. Проверяем проводку лечения: побудка на жестах, сторож сна,
// сторож глухоты, пересоздание элемента и честная подпись.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

let good = 0, bad = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ПРОВАЛ: ') + m); if (c) good++; else bad++; };

console.log('\n══════════════════════════════════════════════════');
console.log('  pkg3-107: светомузыка не должна съедать звук');
console.log('══════════════════════════════════════════════════\n');

const appJs = read('public/app.js');
const apiJs = read('lib/api.js');
const swJs = read('public/sw.js');

console.log('  1. Побудка контекста на жестах');
ok(appJs.includes('function musVizWake()'), 'musVizWake() существует');
ok(/function musVizWake\(\)[\s\S]{0,220}MUSVIZ\.ctx\.resume\(\)/.test(appJs), 'побудка зовёт resume() у спящего контекста');
const startIdx = appJs.indexOf('function musStartStream(');
const startBody = appJs.slice(startIdx, startIdx + 700);
ok(startBody.includes('musVizWake();'), 'старт трека (жест) будит контекст');
ok(/if \(a\.paused\) \{ musVizWake\(\); a\.play\(\)/.test(appJs), 'кнопка ▶ в окне будит контекст перед play()');

console.log('\n  2. Сторож сна: 3 с спящего контекста — спасение звука');
ok(/MUSVIZ\.zzz = \(MUSVIZ\.zzz \|\| 0\) \+ 1;/.test(appJs), 'счётчик спящих кадров ведётся');
ok(appJs.includes("if (MUSVIZ.zzz >= 180) { musVizRescue('suspended'); return; }"), 'после ~3 с сна зовётся musVizRescue');
ok(/MUSVIZ\.zzz % 60 === 1\) musVizWake\(\)/.test(appJs), 'спящий контекст будят каждую секунду');

console.log('\n  3. Сторож глухоты: труба гарантирует CORS — нули 10 с означают беду');
ok(/String\(a\.currentSrc \|\| ''\)\.indexOf\('\/api\/musstream'\) !== -1/.test(appJs), 'глухота измеряется только на пути через трубу');
ok(appJs.includes("if (MUSVIZ.dead >= 600) { musVizRescue('deaf'); return; }"), '10 с сплошных нулей спектра — тоже спасение');
ok(/MUSVIZ\.calm = 0;\s*\n\s*MUSVIZ\.dead = 0;/.test(appJs), 'живой спектр гасит счётчик глухоты');

console.log('\n  4. Спасение: светомузыка гаснет, звук возвращается новым элементом');
ok(appJs.includes('function musVizRescue(why) {'), 'musVizRescue() существует');
const rescIdx = appJs.indexOf('function musVizRescue(why) {');
const rescBody = appJs.slice(rescIdx, rescIdx + 2200);
ok(rescBody.includes('MUSVIZ.ctx = null') && rescBody.includes('MUSVIZ.src = null'), 'граф обнуляется — следующее включение построит его заново');
ok(rescBody.includes('MUS.a = null;') && rescBody.includes('musicAudio()'), 'звуковой элемент ПЕРЕСОЗДАЁТСЯ (привязка к графу необратима)');
ok(rescBody.includes('musVizSet(false)') && rescBody.includes('musVizUi()'), 'светомузыка честно выключается на устройстве');
ok(rescBody.includes("a.crossOrigin = 'anonymous'") && rescBody.includes('/api/musstream'), 'на новом элементе crossOrigin ставится только для трубы');
ok(rescBody.includes('wasPlaying') && rescBody.includes('currentTime = t'), 'трек продолжается с того же места');
ok(rescBody.includes('toast('), 'владелец видит объяснение, а не молчаливую тишину');

console.log('\n  5. Подпись на канвасе больше не врёт');
ok(appJs.includes('браузер усыпил звук — бужу'), 'спящий контекст подписан честно');
ok(!appJs.includes('дышим в такт невозможности: звук идёт как шёл'), 'старой лживой подписи при спящем контексте нет');
ok(appJs.includes('источник не открыл байты'), 'честное «дыхание» для источников без CORS сохранено (сторож 106)');

console.log('\n  6. Метки выпуска');
ok(appJs.includes("const BUILD = 'pkg3-107';") && apiJs.includes("const BUILD = 'pkg3-107';"), 'BUILD pkg3-107 совпадает в клиенте и на сервере');
ok(swJs.includes("const STATIC_CACHE = 'sega-static-v100';"), 'кэш оформления поднят до sega-static-v100');
ok(read('package.json').includes('node test/music107.mjs'), 'тест music107 в цепочке npm test');

console.log('\n──────────────────────────────────────────────────');
console.log('  pkg3-107: ' + good + ' ✓, ' + bad + ' ПРОВАЛОВ');
console.log('──────────────────────────────────────────────────\n');
process.exit(bad ? 1 : 0);
