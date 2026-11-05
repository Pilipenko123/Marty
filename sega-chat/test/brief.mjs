// test/brief.mjs — сторож БРИФА (появился 05.11.2026).
//
// Беда, которую он лечит: бриф для нового агента живёт в корне репозитория и
// руками обновляется в каждом выпуске. Забыть легко — и следующая сессия
// начинается с неверных чисел (так и вышло к 122-му: в брифе оставались
// pkg3-108, 3003 проверки и кэш v101, хотя в коде было 122, 3644 и v115).
//
// Набор сверяет документ с кодом и с журналом выпусков:
//   • названы ли в брифе текущий BUILD и текущий STATIC_CACHE;
//   • тот же ли номер выпуска в первой строке;
//   • есть ли в журнале брифа (раздел 12) строка текущего выпуска;
//   • не старше ли дата «актуален на …» последнего выпуска в README;
//   • на месте ли раздел 14 («как держать бриф актуальным») и версия брифа.
//
// Красный результат этого набора лечится ПРАВКОЙ БРИФА, а не правкой теста.
// Если брифа рядом нет (на сервер ставится только папка sega-chat), набор
// честно пропускается и печатает об этом — зелёным не притворяется.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { BUILD, ROOT, readSrc } from './build.mjs';

const BRIEF = join(ROOT, '..', 'БРИФ-ДЛЯ-НОВОГО-АГЕНТА.md');

let good = 0, bad = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ПРОВАЛ: ') + m); if (c) good++; else bad++; };

console.log('\n══════════════════════════════════════════════════');
console.log('  БРИФ ДЛЯ НОВОГО АГЕНТА — сверка с кодом');
console.log('══════════════════════════════════════════════════');

if (!existsSync(BRIEF)) {
  console.log('\n  пропущено: рядом нет файла брифа (установленная копия без корня репозитория)');
  console.log('\n  ИТОГ: 0 ✓, провалов нет (пропущено)\n');
  process.exit(0);
}

const brief = readFileSync(BRIEF, 'utf8');
const readme = readSrc('README.md');
const sw = readSrc('public/sw.js');
const pkg = readSrc('package.json');

const cache = (/const STATIC_CACHE = '([^']+)'/.exec(sw) || [])[1];
const firstLine = brief.split('\n')[0];

// Даты в формате ДД.ММ.ГГГГ → метка времени (для сравнения «не старше»).
const stamp = (d, m, y) => Date.UTC(Number(y), Number(m) - 1, Number(d));
const briefDate = (() => {
  const m = /актуален на (\d{1,2})\.(\d{2})\.(\d{4})/.exec(firstLine);
  return m ? { at: stamp(m[1], m[2], m[3]), text: `${m[1]}.${m[2]}.${m[3]}` } : null;
})();
const lastRelease = (() => {
  const re = /^\|\s*\*{0,2}(pkg3-\d+)\*{0,2}\s*\|\s*(\d{1,2})\.(\d{2})\.(\d{4})\s*\|/gm;
  let best = null, m;
  while ((m = re.exec(readme))) {
    const at = stamp(m[2], m[3], m[4]);
    const num = Number((/pkg3-(\d+)/.exec(m[1]) || [])[1] || 0);
    // при равной дате берём выпуск с бо́льшим номером, а не первую строку файла
    if (!best || at > best.at || (at === best.at && num > best.num)) {
      best = { at, num, build: m[1], text: `${m[2]}.${m[3]}.${m[4]}` };
    }
  }
  return best;
})();

console.log('\n  1. Отметки выпуска');
ok(brief.length > 30000, `бриф на месте и не обрезан (${brief.length} знаков)`);
ok(firstLine.includes(BUILD), `в первой строке назван текущий выпуск (${BUILD})`);
ok(!!cache && brief.includes(cache), `в брифе назван текущий кэш оформления (${cache})`);
const cacheSection = (brief.match(/STATIC_CACHE` в `public\/sw\.js`[\s\S]{0,400}/) || [''])[0];
ok(!!cache && cacheSection.includes(cache), 'номер кэша обновлён в правилах (раздел 4, п. 4), а не только в журнале');

console.log('\n  2. Журнал');
const journalRow = new RegExp('^\\|\\s*\\*{0,2}' + BUILD + '\\*{0,2}\\s*\\|', 'm');
ok(journalRow.test(brief), `в журнале брифа (раздел 12) есть строка ${BUILD}`);

console.log('\n  3. Дата');
ok(!!briefDate, 'в первой строке есть дата «актуален на ДД.ММ.ГГГГ»');
ok(!!briefDate && !!lastRelease && briefDate.at >= lastRelease.at,
  briefDate && lastRelease
    ? `бриф не старше последнего выпуска (бриф ${briefDate.text}, выпуск ${lastRelease.build} от ${lastRelease.text})`
    : 'не удалось сравнить даты');
console.log('\n  4. Порядок ведения');
ok(/^## 14\./m.test(brief), 'раздел 14 «как держать бриф актуальным» на месте');
ok(/Версия брифа:/.test(brief), 'у брифа есть свой номер версии');
ok(brief.includes('test/brief.mjs'), 'бриф знает про этот сторож и про ожидаемые числа');
ok(pkg.includes('node test/brief.mjs'), 'сторож включён в цепочку npm test');
ok(((/const BUILD = '([^']+)'/.exec(readSrc('public/app.js')) || [])[1]) === BUILD,
  'номер выпуска в клиенте тот же (дом42 тоже проверяет, здесь — для полноты)');

console.log(`\n  ИТОГ: ${good} ✓, ${bad ? bad + ' провалов' : 'провалов нет'}\n`);
process.exit(bad ? 1 : 0);
