// test/ui120.mjs — pkg3-120: две правки к окну музыки и чат с плеером.
//
// Владелец:
//   1) «пропала бегущая строка на длинных треках, которая двигалась взад-вперёд,
//      чтобы прочитать всё название, и не видно, с какого ресурса играет трек.
//      Надо бы вернуть»;
//   2) «при скидывании ссылки Яндекс.Музыки на альбом или трек пусть ссылка ведёт
//      себя как в „Моей музыке“: превращается в плеер Яндекса, и его можно
//      слушать прямо в чате».
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
const i120 = css.indexOf('pkg3-120');

console.log('\n══════════════════════════════════════════════════');
console.log('  pkg3-120: бегущая строка и источник трека,');
console.log('            ссылка Яндекс.Музыки — плеер в чате');
console.log('══════════════════════════════════════════════════\n');

console.log('  1. «Моя музыка»: бегущая строка в строках списка, название в окне — с переносом');
// pkg3-121: владелец уточнил — строка едет В СПИСКЕ (плейлист и результаты поиска),
// а справа от обложки название читается переносом.
ok(/<div class="mus-viz mus-nowbox" id="mus-viz"><div class="mus-nowcol"><div class="mus-nowt" id="mus-now-title">/.test(app),
  'справа от обложки — обычное название (с переносом), а не бегущая строка');
const nowt = near('.mus-v105 .mus-nowt{\n  display:-webkit-box');
ok(/-webkit-line-clamp:6/.test(nowt) && /overflow:hidden/.test(nowt), 'название в окне ограничено шестью строками и переносится');
ok(!/\.mus-v105 \.mus-nowt \.mq\{/.test(css), 'правила «едет название в окне» больше нет');
ok(/<span class="mq">\$\{escapeHtml\(t\.title/.test(app), 'в строке плейлиста название — бегущая строка (.mq)');
ok(/<span class="mq">\$\{escapeHtml\(t\.title\)\}/.test(app), 'в результатах поиска — тоже (.mq)');
const mqRule = near('.mus-tr.cur .mq{');
ok(/animation:mus-mq var\(--mq-dur,8s\) ease-in-out infinite alternate/.test(mqRule),
  'анимация туда-обратно (alternate), длительность из --mq-dur');
ok(/@keyframes mus-mq\{0%,14%\{transform:translateX\(0\)\}86%,100%\{transform:translateX\(var\(--mq-shift,0px\)\)\}\}/.test(css),
  'ключевые кадры прежние: доехала и поехала назад');
ok(/\.mus-tr\.cur \.mq\.mq-s\{animation:none;transform:none\}/.test(css), 'короткое название стоит на месте (класс mq-s)');
ok(/function musMqFit\(row\)/.test(app), 'длину поездки считает app.js');
ok(/mq\.style\.setProperty\('--mq-shift', shift \+ 'px'\)/.test(app), 'сдвиг = насколько название шире своей ячейки');
ok(/mq\.style\.setProperty\('--mq-dur'/.test(app), 'время поездки — по длине пути');
ok(/mq\.classList\.toggle\('mq-s', !shift\)/.test(app), 'влезает целиком — класс mq-s, ползти не надо');
ok(/function musMarqueeSync\(\)[\s\S]{0,400}document\.querySelectorAll\('#modal \.mus-trs'\)/.test(app),
  'замер обходит ВСЕ списки окна музыки (плейлист, поиск, Диск)');
ok(/delete mq\.dataset\.mqShift/.test(app), 'перед замером кэш ширины сбрасывается (бейдж источника её меняет)');
ok(/musicNowUi\(\); musicTickUi\(\); musVizSync\(\); musMarqueeKick\(\);/.test(app), 'пересчёт идёт сразу после отрисовки окна');
ok(/addEventListener\('resize', \(\) => musMarqueeKick\(\)\)/.test(app), 'и после поворота телефона / изменения ширины');

console.log('\n  2. Видно, с какого ресурса играет трек');
ok(/id="mus-now-src"/.test(app), 'под названием есть строка источника');
ok(/class="mus-nowsrc tiny hidden"/.test(app), 'сначала спрятана (у трека без источника подписи нет)');
ok(/const src = document\.getElementById\('mus-now-src'\)/.test(app), 'musicNowUi её заполняет');
ok(/src\.classList\.toggle\('hidden', !ru\)/.test(app), 'нет источника — подписи не видно');
ok(/function musSourceRu\(t\)/.test(app), 'есть одна общая подпись источника');
ok(/musicIsWidget\(t\)\) return 'Яндекс\.Музыка'/.test(app), 'трек-виджет Яндекса — «Яндекс.Музыка»');
ok(/return \(t\.diskOf && S\.me && t\.diskOf !== S\.me\.id\) \? 'Диск участника' : drvName\(/.test(app),
  'файл подписан номером своего Диска или «Диск участника»');
ok(/MUS_SITE_TITLES\[t\.site\]/.test(app), 'сайт поиска — его человеческое имя (MUS_SITE_TITLES)');
ok(/u\.hostname/.test(app), 'иначе — имя сайта из самой ссылки');
const srcRule = near('.mus-v105 .mus-nowsrc{');
ok(/border:1px solid var\(--glow-line\)/.test(srcRule), 'подпись — плашка со светящейся окантовкой (как панели 118-го)');
ok(/border-radius:999px/.test(srcRule), 'скруглённая, как ярлык');
const rowBadge = /mus-badge" title="Источник, откуда взят трек">\$\{escapeHtml\(musSourceRu\(t\)\)\}/.test(app);
ok(rowBadge, 'в строке плейлиста источник тоже подписан');
ok(!/!musicIsWidget\(t\) && !musicIsDisk\(t\) && t\.site \?/.test(app),
  'подпись не привязана к одному виду источника (работает и для обычных ссылок)');

console.log('\n  3. Ссылка Яндекс.Музыки в сообщении — плеер в чате');
ok(/function ymEmbedHtml\(text\)/.test(app), 'карточку-плеер собирает ymEmbedHtml');
ok(/const r = musicParsePaste\(s\);/.test(app),
  'разбор — тем же модулем, что «умная вставка» в «Моей музыке» (белый список music.yandex.ru)');
ok(/r\.kind !== 'widget'/.test(app), 'не плеер Яндекса — карточку не рисуем (текст со ссылкой остаётся)');
ok(/data-ym="\$\{escapeHtml\(r\.url\)\}"/.test(app), 'в карточку идёт только готовый адрес встроенного плеера');
ok(/data-ym-h="\$\{h\}"/.test(app), 'высота — по типу: трек ниже, альбом выше');
ok(/Яндекс\.Музыка · \$\{escapeHtml\(what\)\}/.test(app), 'подписано, что это — трек, альбом, плейлист');
ok(/data-ym-play="1">▶ Слушать здесь/.test(app), 'есть кнопка «Слушать здесь»');
ok(/target="_blank" rel="noopener noreferrer" title="Открыть на сайте Яндекс\.Музыки"/.test(app),
  'и ссылка уйти на сайт, если хочется');
ok(/\$\{p\.text \? `<div class="btext">\$\{twEmo\(mentionize\(p\.text\)\)\}<\/div>` : ''\}\$\{ymEmbedHtml\(p\.text\)\}/.test(app),
  'в ленте карточка стоит ПОД текстом пузыря');
ok(/\$\{p\.text \? `<div class="txt">\$\{mentionize\(p\.text\)\}<\/div>` : ''\}\$\{ymEmbedHtml\(p\.text\)\}/.test(app),
  'и в открытом сообщении/комментарии тоже');
const click = app.slice(app.indexOf("const b = e.target.closest('[data-ym-play]')") - 120);
ok(/const f = document\.createElement\('iframe'\)/.test(click), 'по кнопке на месте постера появляется рамка плеера');
ok(/f\.setAttribute\('allow', 'autoplay; encrypted-media; fullscreen'\)/.test(click),
  'звуку разрешён autoplay — как у панели «Моей музыки»');
ok(/allow-scripts allow-same-origin allow-popups allow-forms allow-popups-to-escape-sandbox/.test(click),
  'песочница та же, что у встроенного плеера в окне музыки');
ok(/f\.style\.height = \(Number\(box\.getAttribute\('data-ym-h'\)\) \|\| 180\) \+ 'px'/.test(click),
  'высота берётся у карточки, по умолчанию 180');
ok(/if \(!text \|\| S\.eco\) return '';/.test(app), 'в экономном режиме медиа не грузим совсем');
ok(/:root\[data-eco="1"\] \.ym-embed\{display:none\}/.test(css), 'и карточка в экономе не показывается');
const yRule = near('.ym-embed{');
ok(/border:1\.5px solid var\(--glow-line\)/.test(yRule), 'рамка карточки — светящаяся, в тон панелям 118-го');
ok(/background:var\(--panel-2\)/.test(yRule), 'фон — панельный, из гаммы');
ok(/border-radius:calc\(var\(--r\) - 10px\)/.test(yRule), 'скругление — от максимального радиуса');
ok(/box-shadow:var\(--shadow-soft\)/.test(yRule), 'с мягкой тенью');

console.log('\n  4. Отметки выпуска');
const b2 = (/const BUILD = '([^']+)'/.exec(app) || [])[1];
const cache = (/const STATIC_CACHE = '([^']+)'/.exec(sw) || [])[1];
ok(b2 === BUILD, `отметка выпуска в клиенте и в тестах одна (${BUILD})`);
ok(((/const BUILD = '([^']+)'/.exec(api) || [])[1]) === BUILD, 'BUILD в lib/api.js тот же');
ok(new RegExp('\\| ' + BUILD + ' \\|').test(read(join(ROOT, 'README.md'))), `в журнале README есть строка ${BUILD}`);
ok(cache === 'sega-static-v144', `кэш оформления поднят (${cache}) — устройства получат правки`);
ok(i120 > 0 && i120 > css.indexOf('pkg3-119'), 'блок 120-го идёт после 119-го — его правила побеждают');

console.log(`\n  ИТОГ: ${good} ✓, ${bad ? bad + ' провалов' : 'провалов нет'}\n`);
process.exit(bad ? 1 : 0);
