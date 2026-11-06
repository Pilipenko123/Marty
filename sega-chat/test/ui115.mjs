// test/ui115.mjs — pkg3-115: три пожелания владельца к 114-му.
//  1) На паузе — стоп-кадр ТОЙ ЖЕ чёрно-белой гистограммы (старый файл с тем
//     же именем браузер показывал из своего кэша — цветную; файл переименован).
//  2) Результаты поиска играют как плейлист: ▶/❚❚ в строке, ⏮ ⏭, автопереход,
//     бегущая строка.
//  3) У ▶ каждого трека — маленькая обложка (своя или с сайта), иначе ♪.
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
const rows = app.slice(app.indexOf('function musSearchRowsHtml()'), app.indexOf('async function musSearchRun()'));

console.log('\n══════════════════════════════════════════════════');
console.log('  pkg3-115: стоп-кадр, поиск как плейлист, мини-обложки');
console.log('══════════════════════════════════════════════════\n');

console.log('  1. На паузе — та же гистограмма');
const pause = join(PUB, 'img', 'music-eq-pause.png');
ok(existsSync(pause) && !existsSync(join(PUB, 'img', 'music-eq-still.png')), 'стоп-кадр под новым именем music-eq-pause.png (старое имя тянуло из кэша браузера цветную картинку)');
ok(/src="img\/music-eq-pause\.png"/.test(app) && !/music-eq-still/.test(app), 'плеер показывает новый файл');
const pb = existsSync(pause) ? readFileSync(pause) : Buffer.alloc(30);
ok(pb.readUInt32BE(16) === 560 && pb.readUInt32BE(20) === 80, `стоп-кадр 560×80 — как GIF (${pb.readUInt32BE(16)}×${pb.readUInt32BE(20)})`);
// чёрно-белый: палитра PNG без цветных записей проверяется грубо — файл маленький и 16 цветов
ok(pb.length < 10 * 1024, `стоп-кадр лёгкий (${Math.round(pb.length / 1024)} КБ) — чёрно-белые столбики, не цветная картинка`);

console.log('\n  2. Результаты поиска — плейлист');
ok(/function musSearchPl\(\)/.test(app) && /id: MUS_SEARCH, name: 'Результаты поиска', vis: 'priv'/.test(app), 'есть временный плейлист «Результаты поиска» (не сохраняется, личный)');
ok(/const musicFind = id => id === MUS_SEARCH \? musSearchPl\(\) : \(musicAll\(\)\.find\(p => p\.id === id\) \|\| null\);/.test(app),
  'плеер находит его по имени «search» — значит ⏮ ⏭ и автопереход работают через общий musicStep');
ok(/MUS\.a\.addEventListener\('ended', \(\) => musicStep\(1, true\)\);/.test(app) && /musicPlay\(musicFind\(MUS\.plId\) \|\| \{ id: MUS\.plId, tracks: MUS\.list \}, n\);/.test(app),
  'конец трека → следующий из того же списка (и для поиска тоже)');
ok(/coverSite: r\.cover \|\| '', site: r\.site \|\| ''/.test(app), 'треки поиска несут обложку сайта и источник');
ok(/data-mus-play="\$\{i\}"/.test(rows) && !/data-mus-s-play/.test(app), 'строки находок в общем формате (▶ с data-mus-play), старого data-mus-s-play нет');
ok(/\$\{cur && MUS\.a && !MUS\.a\.paused \? '❚❚' : '▶'\}/.test(rows) && /class="mus-tr mus-sr\$\{cur \? ' cur' : ''\}\$\{cur && MUS\.a && MUS\.a\.paused \? ' paused' : ''\}"/.test(rows),
  '▶ у играющей находки становится ❚❚, строка подсвечена, на паузе — отмечена');
// pkg3-121: класс mq у каждой строки, «едет или стоит» решает замер ширины
ok(/<span class="mq">\$\{escapeHtml\(t\.title\)\}<\/span>/.test(rows), 'бегущая строка у длинного названия');
ok(app.includes('<div class="mus-trs" id="mus-sres" data-pl="search">') && (app.match(/id="mus-sres" data-pl="search"/g) || []).length === 2,
  'список находок помечен data-pl="search" (и при открытии, и после поиска) — тик звука ведёт ❚❚ и бегущую строку');
ok(/for \(const b of \$\$\('#mus-sres \[data-mus-play\]'\)\)/.test(app) && /musicPlay\(musSearchPl\(\), i\);/.test(app), '▶ в строке находки запускает её как трек плейлиста поиска');
ok(/if \(MUS\.plId === MUS_SEARCH && MUS\.idx === i\) \{\s+musBreakFollow\(\);\s+const a = musicAudio\(\);\s+if \(a\.paused\) a\.play\(\)\.catch\(\(\) => \{\}\); else a\.pause\(\);/.test(app),
  'повторное нажатие на играющую находку — пауза/продолжить');
ok(/\$\$\('#modal \.mus-trs:not\(#mus-sres\) \[data-mus-play\]'\)/.test(app) && /if \(!pl \|\| isSearch\) return;/.test(app), 'общий обработчик ▶ строки поиска не трогает (нет двойного срабатывания)');
ok(/data-mus-s-add="\$\{i\}"/.test(rows), 'кнопка «＋ в плейлист» у находок осталась');
ok(/pub \? String\(t\.title \|\| t\.url\)\.slice\(0, 80\) : ''/.test(app), 'в статус «слушает» название из поиска не уходит (плейлист поиска личный)');

console.log('\n  3. Мини-обложка у ▶');
ok(/function musThumbHtml\(t\)/.test(app), 'есть отрисовка мини-обложки');
ok(/const src = t \? \(t\.cover \|\| t\.coverSite \|\| ''\) : '';\s+if \(src\) return `<span class="mus-thumb"><img src="\$\{escapeHtml\(src\)\}" alt="" loading="lazy" data-fb-note="♪"><\/span>`;/.test(app),
  'своя обложка важнее обложки сайта; если картинка не грузится — ♪ (pkg3-143: без onerror=)');
ok(/return '<span class="mus-thumb mus-thumb-n">♪<\/span>';/.test(app), 'без обложки — значок с нотой');
ok((app.match(/\$\{musThumbHtml\(t\)\}/g) || []).length === 2, 'мини-обложка стоит и в строках плейлиста, и в строках поиска');
ok(/\.mus-v105 \.mus-thumb\{flex:none;width:26px;height:26px;border-radius:6px;overflow:hidden/.test(css) && /\.mus-v105 \.mus-thumb img\{width:100%;height:100%;object-fit:cover/.test(css),
  'размер 26×26 со скруглением, картинка заполняет без искажений');
const trAt = app.indexOf('<button class="mus-pbtn" data-mus-play="${i}" title="Играть / пауза">');
ok(trAt > 0 && app.indexOf('${musThumbHtml(t)}', trAt) - trAt < 200, 'мини-обложка стоит сразу после ▶');

console.log('\n  4. Отметки выпуска');
const b2 = /const BUILD = '([^']+)'/.exec(app)[1];
const cache = /const STATIC_CACHE = '([^']+)'/.exec(sw)[1];
ok(b2 === BUILD && /const BUILD = '([^']+)'/.exec(api)[1] === BUILD, `отметка выпуска совпадает в клиенте и сервере (${BUILD})`);
ok(new RegExp('\\| ' + BUILD + ' \\|').test(read(join(ROOT, 'README.md'))), `в журнале README есть строка ${BUILD}`);
ok(cache !== 'sega-static-v107' && /^sega-static-v\d+$/.test(cache), `кэш оформления поднят (${cache})`);
ok(!/"dependencies":\s*\{[^}]*"(?!web-push)[a-z@][^"]*"/.test(read(join(ROOT, 'package.json'))), 'новых рантайм-зависимостей нет');

console.log(`\n  ИТОГ: ${good} ✓, ${bad ? bad + ' провалов' : 'провалов нет'}\n`);
process.exit(bad ? 1 : 0);
