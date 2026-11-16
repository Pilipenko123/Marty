// pkg3-156: сообщения, ходы и присутствие должны обновляться без 7-секундного ожидания.
import assert from 'node:assert/strict';
import { readSrc } from './build.mjs';
import fs from 'node:fs';

const app = readSrc('public/app.js');
const api = readSrc('lib/api.js');
const sw = readSrc('public/sw.js');
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const ok = (condition, message) => {
  assert.ok(condition, message);
  console.log('  ✓ ' + message);
};
console.log('\n  pkg3-156 · отзывчивость сообщений и присутствия\n');
ok(/FAST_MS[^\n]*\|\| 2500/.test(app), 'видимая лента опрашивается каждые 2,5 секунды по умолчанию');
ok(/GAME_MS[^\n]*\|\| 2500/.test(app), 'ходы игр опрашиваются каждые 2,5 секунды по умолчанию');
ok(/function pollMode\(\) \{ return \(!!S\.token && !document\.hidden\) \|\| Date\.now\(\) < wakeUntil \? 'awake' : 'asleep'; \}/.test(app), 'видимая вкладка не уходит в медленный режим при бездействии');
const renderAt = app.indexOf('  renderAll();\n  if (freshAll.length');
const ringAt = app.indexOf('const ring = () => { playGameSounds(freshAll); notifyNewMessages(freshAll); };');
ok(renderAt >= 0 && ringAt > renderAt, 'звук/уведомление запускаются только после перерисовки сообщения или хода');
ok(app.includes("requestAnimationFrame(() => setTimeout(ring, 0))"), 'для видимой вкладки звук откладывается за кадр отрисовки');
ok(/pathname === '\/api\/logout'[\s\S]{0,500}me\.activeAt = 0;[\s\S]{0,100}store\.touchPresence\(me, true\)/.test(api), 'явный выход сразу снимает статус «в сети»');
ok(sw.includes('silent: wins.length > 0'), 'системный push без звука, если приложение уже открыто в фоне');
ok(sw.includes("if (wins.some(c => c.visibilityState === 'visible')) return;"), 'видимая вкладка получает сообщение без дублирующего push-уведомления');
ok(sw.includes("const STATIC_CACHE = 'sega-static-v150'"), 'кэш сервис-воркера повышен до v150');
ok(pkg.scripts.test.includes('node test/realtime156.mjs'), 'сторож включён в npm test');
console.log('\n  ИТОГ: 10 ✓, провалов нет\n');
