// test/ui108.mjs — pkg3-108: три правки владельца по удобству телефона.
//
//   1. После отправки письма клавиатура НЕ прячется (убирает её только касание
//      свободного места): кнопка «отправить» больше не отнимает фокус у поля.
//   2. Шторка со списком чатов закрывается и касанием справа от неё, и
//      смахиванием влево (а не только крестиком).
//   3. Плашка «реакция · ответ · комментарий · правка · удаление» больше не
//      прячется за полем ввода: лента поднимается так, чтобы плашку было видно.
//   Плюс смайлы: в наборах реакций были ПУСТЫЕ строки (пустые кнопки), а имена
//   файлов картинок строились с ошибкой для одиночных смайлов (❤️ → 2764-fe0f).
//
// Проверки читают настоящие файлы программы; отдельных зависимостей нет.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUB = join(HERE, '..', 'public');
const read = p => readFileSync(p, 'utf8');
const html = read(join(PUB, 'index.html'));
const css = read(join(PUB, 'styles.css'));
const app = read(join(PUB, 'app.js'));
const api = read(join(HERE, '..', 'lib', 'api.js'));

let good = 0, bad = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ПРОВАЛ: ') + m); if (c) good++; else bad++; };

console.log('\n══════════════════════════════════════════════════');
console.log('  pkg3-108: клавиатура, шторка чатов, плашка под сообщением, смайлы');
console.log('══════════════════════════════════════════════════\n');

// ─────────────────────────── 1. клавиатура не прячется после отправки
console.log('  1. Отправка не прячет клавиатуру');
ok(/function noFocusSteal\(el\)/.test(app), 'кнопка отправки умеет «не забирать фокус» (noFocusSteal)');
ok(/noFocusSteal\(\$\('#btn-send'\)\);\s*\n\s*noFocusSteal\(\$\('#thread-send'\)\);/.test(app),
  'правило повешено на ОБЕ кнопки отправки (чат и комментарии)');
ok(/addEventListener\('mousedown', e => e\.preventDefault\(\)\)/.test(app),
  'нажатие на кнопку отменяется на «нажатии мыши» — фокус остаётся в поле, click приходит');
ok(/const keepKeyboard = document\.activeElement === textarea;/.test(app),
  'отправка запоминает, что человек писал именно в этом поле');
ok(/if \(keepKeyboard\) \{ try \{ textarea\.focus\(\{ preventScroll: true \}\)/.test(app),
  'после отправки поле возвращает фокус (без прыжка ленты)');
ok(/function hideKeyboard\(\)/.test(app), 'есть отдельное «убрать клавиатуру» для касания свободного места');
ok(/if \(!msgEl\) \{ solo\(null\); hideKeyboard\(\); \}/.test(app),
  'касание ПУСТОГО места в ленте убирает клавиатуру');

// ─────────────────────────── 2. шторка списка чатов
console.log('\n  2. Шторка чатов: закрытие касанием справа и смахиванием влево');
ok(/<div id="rail-scrim" aria-hidden="true"><\/div>/.test(html), 'в разметке появилось затемнение #rail-scrim');
const railEnd = html.indexOf('</aside>');
const scrimAt = html.indexOf('id="rail-scrim"');
ok(scrimAt > railEnd && scrimAt > 0, 'затемнение стоит ПОСЛЕ шторки (закрывает только место справа от неё)');
ok(/#rail-scrim\{display:none\}/.test(css), 'на широком экране затемнения нет (компьютер не меняется)');
const mobileCss = css.split('@media (max-width:900px){').slice(1).join('');
ok(/#rail-scrim\.on\{opacity:1;pointer-events:auto\}/.test(mobileCss),
  'на телефоне затемнение появляется вместе со шторкой и ловит касание');
ok(/\$\('#rail-scrim'\)\.addEventListener\('click', closeRail\);/.test(app),
  'касание справа от шторки закрывает её');
ok(/function openRail\(\)/.test(app) && /function closeRail\(\)/.test(app),
  'открытие и закрытие шторки собраны в две функции (затемнение не забывается)');
ok(!/\$\('#rail'\)\.classList\.add\('open'\)/.test(app) && !/\$\('#rail'\)\.classList\.remove\('open'\)/.test(app),
  'прямых переключений шторки в обход функций больше нет');
ok(/function railSwipe\(\)/.test(app), 'есть смахивание шторки пальцем');
ok(/rail\.addEventListener\('touchmove'/.test(app) && /dx < -Math\.min\(80, wide \* 0\.25\)\) closeRail\(\)/.test(app),
  'смахивание влево закрывает шторку (короткий сдвиг возвращает на место)');
ok(/Math\.abs\(dx\) < Math\.abs\(dy\)\) return;/.test(app),
  'вертикальная прокрутка списка чатов при этом не ломается');

// ─────────────────────────── 3. плашка под сообщением всегда видна
console.log('\n  3. Плашка под последним сообщением не прячется за полем ввода');
ok(/function keepMsgVisible\(el\)/.test(app), 'есть сдвиг ленты keepMsgVisible');
ok(/box\.scrollTop \+= d;/.test(app), 'лента действительно прокручивается');
ok(/const bottom = Math\.min\(b\.bottom, cr && cr\.top > b\.top \? cr\.top : b\.bottom\) - 10;/.test(app),
  'граница видимости — верх поля ввода (плашка не уходит под него)');
const keepCalls = (app.match(/keepMsgVisible\(msgEl\)/g) || []).length;
ok(keepCalls >= 2, `сдвиг вызывается и для плашки инструментов, и для касания по медиа (${keepCalls} места)`);
ok(/\(el\.querySelector\('\.tools'\) \|\| el\)\.appendChild\(box\);\s*\n\s*keepMsgVisible\(el\);/.test(app),
  'выбор реакции на телефоне тоже поднимает ленту');

// ─────────────────────────── 4. смайлы
console.log('\n  4. Смайлы всегда загружаются');
const grab = re => (re.exec(app) || [null, ''])[1];
const rxCsv = grab(/const RX_SET = \[([^\]]*)\];/);
const msRxCsv = grab(/const MS_RX_SET = \[([^\]]*)\];/);
const emoCsv = grab(/const EMOJIS = '([^']*)'\.split/);
const parse = csv => (csv.match(/'[^']*'/g) || []).map(x => x.slice(1, -1));
const RX = parse(rxCsv), MSRX = parse(msRxCsv), EMO = (emoCsv || '').split(' ').filter(Boolean);
ok(RX.length >= 10 && RX.every(e => e.length > 0), `набор реакций в чате без пустых кнопок (${RX.length} смайлов)`);
ok(MSRX.length >= 6 && MSRX.every(e => e.length > 0), `набор реакций на телефоне без пустых кнопок (${MSRX.length} смайлов)`);
ok(EMO.length >= 40 && EMO.every(e => e.length > 0), `меню «смайлик» без пустых кнопок (${EMO.length} смайлов)`);
ok([...RX, ...MSRX, ...EMO].every(e => /\p{Extended_Pictographic}/u.test(e)), 'в наборах только настоящие смайлы (ни букв, ни пустых мест)');

// имя файла по правилам Twemoji — разбираем настоящую функцию
function cutFunction(src, name) {
  const at = src.indexOf('function ' + name + '(');
  if (at < 0) return null;
  let i = src.indexOf('{', at), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(at, j + 1);
  }
  return null;
}
const twSrc = cutFunction(app, 'twCode');
ok(!!twSrc, 'функция имени файла twCode на месте');
let twCode = null;
try { eval('twCode = ' + twSrc); } catch (e) { twCode = null; }
ok(!!twCode, 'функция имени файла читается');
if (twCode) {
  ok(twCode('❤️') === '2764', '❤️ просит файл 2764 (раньше просился несуществующий 2764-fe0f)');
  ok(twCode('☕') === '2615' && twCode('😀') === '1f600', 'обычные смайлы не меняются');
  ok(twCode('👨‍👩‍👦') === '1f468-200d-1f469-200d-1f466', 'склейка из нескольких знаков остаётся склейкой');
}
const bundled = new Set(readdirSync(join(PUB, 'img', 'emoji')).filter(f => f.endsWith('.svg')).map(f => f.slice(0, -4)));
const need = [...new Set([...RX, ...MSRX, ...EMO])];
const missing = twCode ? need.filter(e => !bundled.has(twCode(e))) : need;
ok(!!twCode && missing.length === 0,
  `у каждого смайла меню и наборов есть картинка внутри программы (${bundled.size} файлов, не хватает: ${missing.length})`);
ok(/const EMO_SRC = '\/api\/emoji\/';/.test(app), 'картинки смайлов берутся у НАШЕГО сервера');
ok(/src="\$\{BASE\}\$\{EMO_SRC\}\$\{cp\}\.svg"/.test(app), 'адрес картинки — /api/emoji/<код>.svg');
ok(/data-emo-fb="\$\{TW_URL\}/.test(app), 'запасной путь — чужой CDN (если наш сервер не ответил)');
ok(/window\.segaEmoFail = segaEmoFail;/.test(app) && /img\.replaceWith\(document\.createTextNode\(alt\)\)/.test(app),
  'последний запасной путь — сам символ системным значком (пустой кнопки не бывает)');
ok(/twEmo\(escapeHtml\(em\), \{ eager: true \}\)/.test(app) && /twEmo\(escapeHtml\(e\), \{ eager: true \}\)/.test(app),
  'смайлы панелей реакций и меню грузятся сразу (не «лениво» за краем экрана)');
ok(/pathname\.startsWith\('\/api\/emoji\/'\)/.test(api), 'серверный маршрут смайлов зарегистрирован');

// ─────────────────────────── 5. отметки выпуска
console.log('\n  5. Отметки выпуска');
const b1 = /const BUILD = '([^']+)'/.exec(api)[1];
const b2 = /const BUILD = '([^']+)'/.exec(app)[1];
const cache = /const STATIC_CACHE = '([^']+)'/.exec(read(join(PUB, 'sw.js')))[1];
ok(b1 === b2, `отметка выпуска совпадает в сервере и клиенте (${b1})`);
const readme = read(join(HERE, '..', 'README.md'));
ok(readme.includes('| ' + b1 + ' |'), `в журнале README есть строка этого выпуска (${b1})`);
ok(cache === 'sega-static-v101', `кэш оформления поднят (${cache}) — устройства сами получат новый клиент`);

console.log(`\n  ИТОГ: ${good} ✓, ${bad ? bad + ' провалов' : 'провалов нет'}\n`);
process.exit(bad ? 1 : 0);
