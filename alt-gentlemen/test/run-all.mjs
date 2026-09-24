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

function runFlow(base, title, extraEnv) {
  console.log('\n══════════════════════════════════════════════════');
  console.log('  ' + title);
  console.log('══════════════════════════════════════════════════');
  return new Promise(resolve => {
    const p = spawn(process.execPath, ['test-flow.mjs'], {
      cwd: ROOT, stdio: 'inherit', env: Object.assign({}, process.env, { BASE: base }, extraEnv || {})
    });
    p.on('exit', code => resolve(code || 0));
  });
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'altg-file-'));
  const srv1 = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'],
    env: Object.assign({}, process.env, { PORT: '8791', HOST: '127.0.0.1', DATA_DIR: dir, STORE: 'file', HTTPS: '' })
  });
  await waitReady('http://127.0.0.1:8791');
  failed += await runFlow('http://127.0.0.1:8791', 'Режим 1: данные в файлах (свой компьютер)',
    { DATA_FILE: path.join(dir, 'db.json') });
  srv1.kill('SIGTERM');

  // ── 2. сервер + облачная база
  const mock = await startMock();
  const ydbEnv = {
    STORE: 'ydb', YDB_ENDPOINT: mock.endpoint, YDB_TABLE: 'alt_chat',
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
    const rows = [...(mock.tables.get('alt_chat') || new Map()).values()];
    const text = JSON.stringify(rows);
    const okEnc = rows.length > 0 && !text.includes('пингвин') && !text.includes('Партия в бридж');
    console.log('  ' + (okEnc ? '✓' : '✗ ПРОВАЛ:') + ` в облачной базе только шифротекст (${rows.length} записей)`);
    if (!okEnc) failed++;
  }
  srv2.kill('SIGTERM');
  console.log(`\n  обращений к базе за прогон: ${mock.counters.calls - before}`);
  await mock.close();

  // ── 3. облачная функция целиком
  const mock2 = await startMock();
  Object.assign(process.env, ydbEnv, { YDB_ENDPOINT: mock2.endpoint, YDB_TABLE: 'alt_chat' });
  const fn = require(path.join(ROOT, 'cloud', 'index.js'));
  const FID = 'd4e0alt0gentlemen0000';
  const emu = await startFunctionEmulator(fn.handler, FID);
  const base = `http://127.0.0.1:${emu.port}/${FID}`;
  await waitReady(base);

  // страница должна приезжать с правильной приставкой в адресе
  const page = await (await fetch(base + '/')).text();
  const okBase = page.includes(`<base href="/${FID}/">`) && page.includes(`window.ALTG_BASE = "/${FID}"`);
  console.log('\n  ' + (okBase ? '✓' : '✗ ПРОВАЛ:') + ' страница чата знает свой адрес в облаке');
  if (!okBase) failed++;
  const css = await fetch(base + '/styles.css');
  const okCss = css.ok && (css.headers.get('content-type') || '').includes('text/css');
  console.log('  ' + (okCss ? '✓' : '✗ ПРОВАЛ:') + ' оформление отдаётся облачной функцией');
  if (!okCss) failed++;

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

  console.log('\n──────────────────────────────────────────────────');
  console.log(failed ? '  ЕСТЬ ПРОВАЛЫ' : '  Все режимы прошли проверку.');
  process.exit(failed ? 1 : 0);
})();
