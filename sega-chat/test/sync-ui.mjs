// pkg3-154: окно «Папка с ПК» в чате — jsdom, без настоящего сервера.
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readSrc } from './build.mjs';
let good = 0, bad = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ПРОВАЛ: ') + m); if (c) good++; else bad++; };
const dom = new JSDOM(readSrc('public/index.html'), { url: 'https://chat.example/', runScripts: 'outside-only', pretendToBeVisual: true });
const w = dom.window;
w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
w.scrollTo = () => {};
const calls = [];
const devices = [{ id: 'device-ui-000001', name: '<img src=x onerror=alert(1)>', pub: 'AA==', revoked: false, lastSeen: Date.now(), status: null }];
w.fetch = async (url, opts = {}) => {
  const u = String(url); calls.push({ u, body: opts.body });
  let data = { ok: true };
  if (u.endsWith('/api/sync/devices')) data = { devices };
  else if (u.endsWith('/api/sync/folders')) data = { folders: [] };
  else if (u.endsWith('/api/sync/shares')) data = { incoming: [], outgoing: [] };
  else if (u.endsWith('/api/sync/pair/init')) data = { code: 'test-code-12345678', expiresAt: Date.now() + 600000 };
  else if (u.endsWith('/api/drives')) data = { drives: [], soon: [] };
  return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => data, text: async () => JSON.stringify(data) };
};
w.eval(readSrc('public/app.js') + '\n' + readSrc('public/folder-sync.js') + '\n;window.t={S,openFolderSync};');
const q = s => w.document.querySelector(s);
const tick = () => new Promise(r => setTimeout(r, 40));
console.log('\n  Синхронизация папок · окно в чате\n');
try {
  ok(readSrc('public/index.html').includes('data-plus="foldsync"'), 'в меню «+» есть пункт «Папка с ПК»');
  ok(readSrc('public/index.html').includes('src="folder-sync.js"'), 'скрипт окна подключён после app.js');
  ok(typeof w.t.openFolderSync === 'function', 'окно доступно из клиента');
  w.t.S.me = { id: 'user-ui-00000001', name: 'Я' };
  w.t.S.token = 'token';
  w.t.S.priv = {};
  await w.t.openFolderSync();
  await tick();
  ok(q('#modal-title').textContent === 'Папка с ПК', 'окно открылось с правильным заголовком');
  ok(q('#modal-body').textContent.includes('Скачать помощник Windows'), 'кнопка скачивания помощника на месте');
  ok(q('#modal-body').textContent.includes('Как установить'), 'инструкция по установке на месте');
  ok(q('[data-foldsync]') || readSrc('public/app.js').includes('data-foldsync'), 'строка «Папка с ПК» есть в боковой панели');
  ok(!q('#modal-body').innerHTML.includes('<img src=x'), 'имя компьютера экранировано, XSS не проходит');
  ok(q('#modal-body').textContent.includes('&lt;img') || q('#modal-body').innerHTML.includes('&lt;img'), 'опасное имя показано как текст');
  q('#sync-pair-code').click();
  await tick();
  ok(calls.some(c => c.u.endsWith('/api/sync/pair/init')), 'кнопка запросила код подключения');
  ok(q('#sync-code-value') && q('#sync-code-value').textContent === 'test-code-12345678', 'код показан отдельным элементом для копирования');
  ok(q('#modal-body').textContent.includes('10 минут'), 'срок действия кода объяснён');
  q('#sync-create').click();
  await tick();
  ok(!calls.some(c => c.u.endsWith('/api/sync/folders') && c.body), 'пустая форма не создаёт папку на сервере');
  ok(q('#sync-folder-name') && q('#sync-folder-dev'), 'форма создания папки на месте');
  ok(q('[href$="/api/sync/download"]'), 'ссылка скачивания ведёт на серверный архив');
} catch (e) { ok(false, 'неожиданная ошибка: ' + (e.stack || e)); }
finally { dom.window.close(); }
console.log(`\n  ИТОГ: ${good} ✓, ${bad ? bad + ' провалов' : 'провалов нет'}\n`);
process.exit(bad ? 1 : 0);
