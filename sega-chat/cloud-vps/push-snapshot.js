#!/usr/bin/env node
'use strict';
/**
 * pkg3-51: отправка шифрованного слепка базы на запасной сервер.
 * Крутится по расписанию (каждые 5 минут) на основном сервере.
 *
 * Куда слать и с каким ключом — в файле /opt/sega-chat/.env:
 *   SEGA_STANDBY_URL    адрес запасного сервера (тот, что открываете в браузере)
 *   SEGA_STANDBY_TOKEN  общий секрет приёмника
 * Пока переменных нет — скрипт вежливо пропускает ход (это не ошибка).
 *
 * Слепок шифруется секретом самой базы (AES-256-GCM), поэтому по дороге
 * он не читается никем, включая запасной сервер: там он просто лежит
 * зашифрованным блоком до часа переезда.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function loadEnvFile() {
  const candidates = [
    process.env.SEGA_ENV_FILE,
    path.join(__dirname, '..', '..', '.env'),
    '/opt/sega-chat/.env'
  ].filter(Boolean);
  for (const f of candidates) {
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
    const out = {};
    for (const line of text.split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (!m) continue;
      out[m[1]] = m[2].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
    }
    return out;
  }
  return {};
}

const fileEnv = loadEnvFile();
const URL_ = process.env.SEGA_STANDBY_URL || fileEnv.SEGA_STANDBY_URL || '';
const TOKEN = process.env.SEGA_STANDBY_TOKEN || fileEnv.SEGA_STANDBY_TOKEN || '';
const DATA_DIR = process.env.DATA_DIR || fileEnv.DATA_DIR || '/opt/sega-chat/data';

const log = (m) => console.log(new Date().toISOString() + ' push-snapshot: ' + m);

(async () => {
  if (!URL_ || !TOKEN) { log('пропуск: не заданы SEGA_STANDBY_URL/SEGA_STANDBY_TOKEN в .env'); return; }
  const base = URL_.replace(/\/+$/, '');
  const { createFileStore } = require(path.join(__dirname, '..', 'lib', 'store-file.js'));
  const backup = require(path.join(__dirname, '..', 'lib', 'backup.js'));

  const store = createFileStore({ dataDir: DATA_DIR });
  const db = await store.load();
  const BUILD = (/const BUILD = '([^']+)'/.exec(
    fs.readFileSync(path.join(__dirname, '..', 'lib', 'api.js'), 'utf8')) || [])[1] || '?';
  const snap = await backup.makeSnapshot({ store, db, build: BUILD, secret: db.serverSecret });
  const blob = snap.blob;

  // сперва убеждаемся, что приёмник живой и принимает наш ключ
  const ping = await fetch(base + '/api/standby/ping?token=' + encodeURIComponent(TOKEN), {
    signal: AbortSignal.timeout(30000)
  });
  if (!ping.ok) { log('приёмник ответил ' + ping.status + ' — слепок не отправлен'); process.exitCode = 1; return; }

  const id = crypto.createHash('sha256').update(blob).digest('hex').slice(0, 32);
  const CH = 3 * 1024 * 1024;
  const parts = Math.max(1, Math.ceil(blob.length / CH));
  for (let i = 0; i < parts; i++) {
    const r = await fetch(base + '/api/standby/receive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: TOKEN, id, i, data: blob.subarray(i * CH, (i + 1) * CH).toString('base64') }),
      signal: AbortSignal.timeout(60000)
    });
    if (!r.ok) { log('кусок ' + i + ' не принят: ' + r.status + ' ' + (await r.text()).slice(0, 120)); process.exitCode = 1; return; }
  }
  const fin = await fetch(base + '/api/standby/receive', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: TOKEN, id, fin: true, parts, sha256: snap.sha256 }),
    signal: AbortSignal.timeout(60000)
  });
  const d = await fin.json().catch(() => ({}));
  if (!fin.ok || !d.ok) { log('сборка не подтверждена: ' + fin.status + ' ' + JSON.stringify(d).slice(0, 120)); process.exitCode = 1; return; }
  log('ок: строк ' + snap.rows + ', байт ' + blob.length + ', отпечаток совпал');
})().catch(e => { log('беда: ' + (e && e.message || e)); process.exitCode = 1; });
