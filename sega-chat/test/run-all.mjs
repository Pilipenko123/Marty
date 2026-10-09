/**
 * Прогон полного набора проверок во всех режимах работы:
 *   1) данные в файлах (мессенджер на своём компьютере);
 *   2) данные в Yandex Database (запуск сервера вручную, база в облаке);
 *   3) облачная функция целиком — событие Yandex Cloud Functions, адрес с приставкой.
 *
 * Запуск: node test/run-all.mjs
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { startMock } from './mock-ydb.mjs';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const require = createRequire(import.meta.url);

const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function waitReady(base, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(base + '/api/state'); if (r.ok) return true; } catch (e) {}
    await wait(250);
  }
  throw new Error('сервер не поднялся: ' + base);
}

function runOne(file, base, extraEnv) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [file], {
      cwd: ROOT, stdio: 'inherit', env: Object.assign({}, process.env, { BASE: base }, extraEnv || {})
    });
    p.on('exit', code => resolve(code || 0));
  });
}
function runFlow(base, title, extraEnv) {
  console.log('\n══════════════════════════════════════════════════');
  console.log('  ' + title);
  console.log('══════════════════════════════════════════════════');
  return runOne('test-flow.mjs', base, extraEnv);
}
/** pkg3-45: сценарий приглашений идёт на ОТДЕЛЬНОМ сервере с пустой базой —
 * ему нужна чистая комната, чтобы считать основателей и ссылки с нуля. */
function runInvites(base, title, extraEnv) {
  console.log('\n──────────────────────────────────────────────────');
  console.log('  ' + title + ' · приглашения');
  console.log('──────────────────────────────────────────────────');
  return runOne('test/invites.mjs', base, extraEnv);
}

/** Сервер, который притворяется Yandex Cloud Functions: HTTP -> событие -> ответ. */
function startFunctionEmulator(handler, functionId) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks);
      const isJson = String(req.headers['content-type'] || '').includes('json');
      const event = {
        httpMethod: req.method,
        url: req.url,
        headers: Object.assign({}, req.headers),
        queryStringParameters: Object.fromEntries(new URL(req.url, 'http://x').searchParams),
        body: raw.length ? (isJson ? raw.toString('utf8') : raw.toString('base64')) : '',
        isBase64Encoded: raw.length ? !isJson : false,
        requestContext: { identity: { sourceIp: '127.0.0.1' } }
      };
      try {
        const out = await handler(event, { token: {} });
        const body = out.isBase64Encoded ? Buffer.from(out.body, 'base64') : Buffer.from(out.body || '', 'utf8');
        res.writeHead(out.statusCode, Object.assign({}, out.headers, { 'Content-Length': body.length }));
        res.end(body);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(e && e.message || e) }));
      }
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({
    port: server.address().port, close: () => new Promise(x => server.close(x))
  })));
}

(async () => {
  let failed = 0;

  // ── 1. файловое хранилище
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sega-file-'));
  const srv1 = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
    env: Object.assign({}, process.env, { PORT: '8791', HOST: '127.0.0.1', DATA_DIR: dir, STORE: 'file', HTTPS: '' })
  });
  await waitReady('http://127.0.0.1:8791');
  failed += await runFlow('http://127.0.0.1:8791', 'Режим 1: данные в файлах (свой компьютер)',
    { DATA_FILE: path.join(dir, 'db.json') });
  srv1.kill('SIGTERM');

  // pkg3-45: приглашения — свой сервер и своя пустая база
  const dir1b = fs.mkdtempSync(path.join(os.tmpdir(), 'sega-inv-'));
  const srv1b = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
    env: Object.assign({}, process.env, { PORT: '8795', HOST: '127.0.0.1', DATA_DIR: dir1b, STORE: 'file', HTTPS: '' })
  });
  await waitReady('http://127.0.0.1:8795');
  failed += await runInvites('http://127.0.0.1:8795', 'Режим 1', {});
  srv1b.kill('SIGTERM');

  // ── 2. сервер + облачная база
  const mock = await startMock();
  const ydbEnv = {
    STORE: 'ydb', YDB_ENDPOINT: mock.endpoint, YDB_TABLE: 'sega_chat',
    YDB_ACCESS_KEY_ID: mock.accessKeyId, YDB_SECRET_ACCESS_KEY: mock.secretAccessKey,
    PRESENCE_EVERY: '0'
  };
  const srv2 = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
    env: Object.assign({}, process.env, ydbEnv, { PORT: '8792', HOST: '127.0.0.1', HTTPS: '' })
  });
  await waitReady('http://127.0.0.1:8792');
  const before = mock.counters.calls;
  failed += await runFlow('http://127.0.0.1:8792', 'Режим 2: данные в Yandex Database (подпись, куски, счётчики)',
    { STORE_CHECKED_ELSEWHERE: '1' });
  {
    const rows = [...(mock.tables.get('sega_chat') || new Map()).values()];
    const text = JSON.stringify(rows);
    const okEnc = rows.length > 0 && !text.includes('пингвин') && !text.includes('Партия в бридж');
    console.log('  ' + (okEnc ? '✓' : '✗ ПРОВАЛ:') + ` в облачной базе только шифротекст (${rows.length} записей)`);
    if (!okEnc) failed++;
  }
  srv2.kill('SIGTERM');
  console.log(`\n  обращений к базе за прогон: ${mock.counters.calls - before}`);

  // pkg3-45: приглашения на облачной базе — своя таблица в той же заглушке
  const srv2b = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
    env: Object.assign({}, process.env, ydbEnv, { PORT: '8796', HOST: '127.0.0.1', HTTPS: '', YDB_TABLE: 'sega_inv' })
  });
  await waitReady('http://127.0.0.1:8796');
  failed += await runInvites('http://127.0.0.1:8796', 'Режим 2', {});
  srv2b.kill('SIGTERM');
  await mock.close();

  // ── 3. облачная функция целиком
  const mock2 = await startMock();
  Object.assign(process.env, ydbEnv, { YDB_ENDPOINT: mock2.endpoint, YDB_TABLE: 'sega_chat' });
  const fn = require(path.join(ROOT, 'cloud', 'index.js'));
  const FID = 'd4e0alt0gentlemen0000';
  const emu = await startFunctionEmulator(fn.handler, FID);
  const base = `http://127.0.0.1:${emu.port}/${FID}`;
  await waitReady(base);

  // страница должна приезжать с правильной приставкой в адресе
  const page = await (await fetch(base + '/')).text();
  const okBase = page.includes(`<base href="/${FID}/">`) && page.includes(`window.SEGA_BASE = "/${FID}"`);
  console.log('\n  ' + (okBase ? '✓' : '✗ ПРОВАЛ:') + ' страница чата знает свой адрес в облаке');
  if (!okBase) failed++;
  const css = await fetch(base + '/styles.css');
  const cssText = css.ok ? await css.text() : '';
  const okCss = css.ok && (css.headers.get('content-type') || '').includes('text/css');
  console.log('  ' + (okCss ? '✓' : '✗ ПРОВАЛ:') + ' оформление отдаётся облачной функцией');
  if (!okCss) failed++;
  const okSynth = cssText.includes('[data-pal="synth"]') && cssText.includes('#00e5ff') && cssText.includes('#ff2bd6');
  console.log('  ' + (okSynth ? '✓' : '✗ ПРОВАЛ:') + ' гамма «Синтвейв» есть в стилях (неон голубой + розовый)');
  if (!okSynth) failed++;
  const appJsText = await (await fetch(base + '/app.js')).text();
  const okGameScroll = cssText.includes('grid-template-rows:auto minmax(0,1fr)')
    && cssText.includes('#main.game-mode #game-right{grid-column:2;grid-row:2;display:flex;flex-direction:column;min-width:0;min-height:0;');
  console.log('  ' + (okGameScroll ? '✓' : '✗ ПРОВАЛ:') + ' игровой чат на ПК умещается в экран: лента со своей полосой прокрутки');
  if (!okGameScroll) failed++;
  const okBoardHeal = appJsText.includes('const plainBroken') && appJsText.includes('function boardSoon')
    && !page.includes('id="mem-text"') && appJsText.includes("$('#ad-mem-main')");
  console.log('  ' + (okBoardHeal ? '✓' : '✗ ПРОВАЛ:') + ' доска рисуется только из расшифрованной истории; детали памяти — в «Управлении»');
  if (!okBoardHeal) failed++;

  // ── pkg3-42: три правки интерфейса партии
  const okNoSearch = cssText.includes('#main.game-mode .search-wrap{display:none;}')
    && appJsText.includes('function searchBarHidden') && appJsText.includes('function syncSearchVisibility');
  console.log('  ' + (okNoSearch ? '✓' : '✗ ПРОВАЛ:') + ' pkg3-42: на телефоне в чат-игре строка поиска скрыта (и результаты гаснут вместе с ней)');
  if (!okNoSearch) failed++;
  const andCount = appJsText.split("userNameById(g.white) + ' и ' + userNameById(g.black)").length - 1;
  const okAndTitle = andCount === 2 && !appJsText.includes("userNameById(g.white) + ' против '");
  console.log('  ' + (okAndTitle ? '✓' : '✗ ПРОВАЛ:') + ' pkg3-42: в заголовках партий союз «и» вместо «против» (найдено ' + andCount + ' из 2)');
  if (!okAndTitle) failed++;
  const okHeadCtrl = appJsText.includes('class="bph-top"') && appJsText.includes('class="bph-btns"')
    && cssText.includes('.bph-top{font-weight:600;text-align:center;overflow-wrap:anywhere;')
    && cssText.includes('.bph-btns{display:flex;justify-content:center;')
    && !cssText.includes('.bph-l{') && !appJsText.includes('class="bph-l"');
  console.log('  ' + (okHeadCtrl ? '✓' : '✗ ПРОВАЛ:') + ' pkg3-43: заголовок доски — две строки (состояние, под ним кнопки); наложение исключено');
  if (!okHeadCtrl) failed++;
  const okCoords = appJsText.includes('class="bf-ranks"') && appJsText.includes('class="bf-files"')
    && cssText.includes('.board-frame{display:grid;') && cssText.includes('.board{grid-column:2;grid-row:1;}')
    && cssText.includes('.bf-ranks,.bf-files{display:none;}') && !cssText.includes('.cd-r{');
  console.log('  ' + (okCoords ? '✓' : '✗ ПРОВАЛ:') + ' pkg3-44: координаты вынесены за пределы доски и скрыты на телефоне');
  if (!okCoords) failed++;
  const okPkg44 = appJsText.includes("if (c && c.kind === 'game') { box.style.background = ''; return; }")
    && appJsText.includes('function migrateGameNotify44')
    && page.includes("sega.palDef44")
    && cssText.includes('#mem-pct{position:relative;z-index:1;');
  console.log('  ' + (okPkg44 ? '✓' : '✗ ПРОВАЛ:') + ' pkg3-44: фон не наследуется в игру, оповещения в игре по умолчанию, «Синтвейв» у всех, процент памяти читаем');
  if (!okPkg44) failed++;
  const okPkg45 = appJsText.includes('function openInviteFriend') && appJsText.includes('function openAdminInvites')
    && appJsText.includes('function openAliasEditor') && appJsText.includes('function refreshRegisterGate')
    && page.includes('id="reg-closed"') && page.includes('src="qrcode.js"')
    && cssText.includes('.qr-box{background:#fff;');
  console.log('  ' + (okPkg45 ? '✓' : '✗ ПРОВАЛ:') + ' pkg3-45: закрытая регистрация, приглашения с QR, дерево админа, псевдонимы');
  if (!okPkg45) failed++;
  const okPkg47 = appJsText.includes('function bondStateWith') && appJsText.includes('data-bond-accept')
    && appJsText.includes('id="inv-find"') && cssText.includes('.bond-btns{');
  console.log('  ' + (okPkg47 ? '✓' : '✗ ПРОВАЛ:') + ' pkg3-47: поиск по нику и запросы-согласия в «Приглашенные»');
  if (!okPkg47) failed++;
  const okNoOldCtrl = !appJsText.includes('bp-ctrl') && !cssText.includes('.bp-ctrl{');
  console.log('  ' + (okNoOldCtrl ? '✓' : '✗ ПРОВАЛ:') + ' pkg3-42: отдельная строка кнопок под доской убрана');
  if (!okNoOldCtrl) failed++;

  failed += await runFlow(base, 'Режим 3: облачная функция Yandex Cloud + Yandex Database',
    { STORE_CHECKED_ELSEWHERE: '1' });

  // сколько стоит обычный опрос новых сообщений на «тёплой» функции
  const st = await (await fetch(base + '/api/state')).json();
  const idle = mock2.counters.calls;
  await fetch(base + '/api/state');
  console.log(`\n  запросов к базе на холостой опрос: ${mock2.counters.calls - idle} (лимит чата: ${(st.limit / 1024 / 1024).toFixed(0)} МБ)`);
  console.log('  всего обращений к базе за прогон: ' + mock2.counters.calls);
  await emu.close();
  await mock2.close();

  // pkg3-45: приглашения в облачной функции — своя заглушка базы.
  // Модуль функции и её библиотеки читают окружение при загрузке, поэтому
  // сбрасываем кэш require и загружаем функцию заново под новую заглушку.
  const mock3 = await startMock();
  Object.assign(process.env, ydbEnv, { YDB_ENDPOINT: mock3.endpoint, YDB_TABLE: 'sega_inv2' });
  Object.keys(require.cache).forEach(k => { delete require.cache[k]; });
  const fn2 = require(path.join(ROOT, 'cloud', 'index.js'));
  const emu2 = await startFunctionEmulator(fn2.handler, FID);
  failed += await runInvites(`http://127.0.0.1:${emu2.port}/${FID}`, 'Режим 3',
    { STORE_CHECKED_ELSEWHERE: '1' });
  await emu2.close();
  await mock3.close();

  console.log('\n──────────────────────────────────────────────────');
  console.log(failed ? '  ЕСТЬ ПРОВАЛЫ' : '  Все режимы прошли проверку.');
  process.exit(failed ? 1 : 0);
})();
