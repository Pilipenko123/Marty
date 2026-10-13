#!/usr/bin/env node
'use strict';
/**
 * pkg3-51: переезд базы с запасного сервера (Yandex Cloud) на основной (VPS).
 * Запускается ОДИН РАЗ в вечер переезда, служба при этом остановлена:
 *   systemctl stop sega-chat && node cloud-vps/import-from-yandex.js && systemctl start sega-chat
 * (или одной командой: bash cloud-vps/import.sh)
 *
 * Как это устроено честно:
 *   1. запасной сервер собирает слепок базы СЕЙЧАС и шифрует его ОДНОРАЗОВЫМ
 *      ключом, который придуман здесь и живёт считанные секунды;
 *   2. слепок едет по HTTPS и кладётся в память этого процесса;
 *   3. здесь слепок расшифровывается одноразовым ключом, а внутри него лежит
 *      база вместе с её собственным секретом — поэтому все сообщения
 *      участников продолжают читаться как ни в чём не бывало;
 *   4. облачные строки таблицы превращаются в домашний формат (db.json + файлы).
 *
 * Защита от случайности: если на этом сервере уже есть своя переписка
 * (пользователи в базе), перенос начнётся только с флагом --force.
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
const URL_ = (process.env.SEGA_STANDBY_URL || fileEnv.SEGA_STANDBY_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.SEGA_STANDBY_TOKEN || fileEnv.SEGA_STANDBY_TOKEN || '';
const DATA_DIR = process.env.DATA_DIR || fileEnv.DATA_DIR || '/opt/sega-chat/data';
const FORCE = process.argv.includes('--force');

const log = (m) => console.log('  ' + m);

(async () => {
  if (!URL_ || !TOKEN) { console.error('Беда: в .env нет SEGA_STANDBY_URL или SEGA_STANDBY_TOKEN.'); process.exit(1); }
  const backup = require(path.join(__dirname, '..', 'lib', 'backup.js'));
  const { rowsToPayload } = require(path.join(__dirname, '..', 'lib', 'rows2db.js'));
  const { createFileStore } = require(path.join(__dirname, '..', 'lib', 'store-file.js'));

  // страховка: не затереть собственную переписку
  const dbFile = path.join(DATA_DIR, 'db.json');
  if (fs.existsSync(dbFile) && !FORCE) {
    let users = 0;
    try { users = (JSON.parse(fs.readFileSync(dbFile, 'utf8')).users || []).length; } catch (e) {}
    if (users > 0) {
      console.error('Беда: на этом сервере уже есть переписка (' + users + ' уч.).');
      console.error('Перенос поверх неё возможен только с флагом --force (старая база этого сервера будет заменена).');
      process.exit(1);
    }
  }

  const transferKey = crypto.randomBytes(32).toString('hex');
  log('запрашиваю слепок у ' + URL_ + ' …');
  const chunks = [];
  let i = 0, meta = null;
  for (;;) {
    const u = URL_ + '/api/standby/export?token=' + encodeURIComponent(TOKEN)
      + '&key=' + transferKey + '&i=' + i + '&size=' + (2 * 1024 * 1024);
    const r = await fetch(u, { signal: AbortSignal.timeout(120000) });
    if (!r.ok) {
      console.error('Беда: запасной сервер ответил ' + r.status + ' ' + (await r.text()).slice(0, 200));
      process.exit(1);
    }
    const d = await r.json();
    meta = d;
    chunks.push(Buffer.from(d.data, 'base64'));
    if (d.done) break;
    if (++i > 200) { console.error('Беда: слишком много кусков — прервано.'); process.exit(1); }
  }
  const blob = Buffer.concat(chunks);
  const sha = crypto.createHash('sha256').update(blob).digest('hex');
  if (sha !== meta.sha256) { console.error('Беда: отпечаток слепка не совпал — перенос прерван.'); process.exit(1); }
  log('слепок получен: ' + blob.length + ' байт, отпечаток совпал');

  const payload = backup.open(blob, transferKey);   // расшифровка одноразовым ключом
  const conv = Array.isArray(payload.rows) && payload.rows.length
    ? rowsToPayload(payload.rows)
    : { db: payload.db, files: payload.files || {} };
  if (!conv.db || !conv.db.serverSecret) { console.error('Беда: в слепке нет базы.'); process.exit(1); }

  const store = createFileStore({ dataDir: DATA_DIR });
  await store.open();
  const res = await store.restoreFiles({ db: conv.db, files: conv.files || {} });
  await store.close();

  const db2 = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
  log('готово: участников ' + db2.users.length + ', чатов ' + db2.chats.length
    + ', сообщений ' + db2.messages.length + ', файлов ' + res.written);
  log('теперь: systemctl start sega-chat  (или bash cloud-vps/import.sh уже сделал это)');
})().catch(e => { console.error('Беда: ' + (e && e.message || e)); process.exit(1); });
