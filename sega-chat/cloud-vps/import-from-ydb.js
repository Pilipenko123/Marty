#!/usr/bin/env node
'use strict';
/**
 * pkg3-51: перенос ЖИВОЙ базы из Yandex Database на этот сервер.
 *
 * Зачем нужен, если есть import-from-yandex.js: штатный переезд спрашивает
 * слепок у облачной ФУНКЦИИ (/api/standby/export). Если функция в Яндексе не
 * запускается (авария региона), а сама база цела, этот скрипт читает строки
 * таблицы напрямую через Document API — тем же клиентом (lib/ydb.js), которым
 * программа пользуется в облаке. Ничего не теряется: берётся самое свежее
 * состояние, а не последняя резервная копия.
 *
 * Что нужно (три значения из консоли Yandex Cloud):
 *   1. YDB_ENDPOINT  — адрес Document API базы (Yandex Database → sega-chat-db →
 *      «Обзор», строка «Document API эндпоинт»; он же виден в переменных
 *      окружения функции sega-chat);
 *   2. YDB_ACCESS_KEY_ID и 3. YDB_SECRET_ACCESS_KEY — постоянный ключ
 *      сервисного аккаунта sega-chat-sa («Создать новый ключ» → «Access key»).
 *      ПОСЛЕ переноса этот ключ нужно удалить в консоли — см. памятку в конце.
 *
 * Запуск (служба должна быть остановлена — см. обёртку import-ydb.sh):
 *   YDB_ENDPOINT=… YDB_ACCESS_KEY_ID=… YDB_SECRET_ACCESS_KEY=… \
 *     node cloud-vps/import-from-ydb.js [--data-dir /opt/sega-chat/data] [--force]
 *   тот же запуск с --inspect — только посмотреть, что в базе, ничего не меняя.
 *
 * Скрипт ЧИТАЕТ облачную базу и ничего в ней не пишет: переписка в Яндексе
 * остаётся нетронутой, поэтому перенос можно повторять.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

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

const opts = { dataDir: '', force: false, inspect: false, saveCopy: false };
{
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    const t = a[i];
    if (t === '--data-dir') opts.dataDir = a[++i] || '';
    else if (t === '--force') opts.force = true;
    else if (t === '--inspect') opts.inspect = true;
    else if (t === '--save-copy') opts.saveCopy = true;
  }
}

const fileEnv = loadEnvFile();
const pick = (name, def) => process.env[name] || fileEnv[name] || def || '';
const ENDPOINT = pick('YDB_ENDPOINT');
const TABLE = pick('YDB_TABLE', 'sega_chat');
const KEY_ID = pick('YDB_ACCESS_KEY_ID');
const SECRET_KEY = pick('YDB_SECRET_ACCESS_KEY');
const REGION = pick('YDB_REGION', 'ru-central1');
const DATA_DIR = opts.dataDir || pick('DATA_DIR', '/opt/sega-chat/data');

const log = (m) => console.log('  ' + m);
const die = (m) => { console.error('Беда: ' + m); process.exit(1); };

function lib(name) {
  const roots = [path.join(__dirname, '..'), '/opt/sega-chat/code', process.cwd()];
  for (const r of roots) {
    const p = path.join(r, 'lib', name);
    if (fs.existsSync(p)) return require(p);
  }
  die('не нашёл lib/' + name + ' рядом со скриптом, в /opt/sega-chat/code или в текущей папке.');
}

(async () => {
  if (!ENDPOINT) die('не задан YDB_ENDPOINT (адрес Document API базы из консоли Yandex Cloud).');
  if (!/^https?:\/\//.test(ENDPOINT)) die('YDB_ENDPOINT должен начинаться с https:// (пришло: ' + ENDPOINT.slice(0, 40) + '…).');
  if (!KEY_ID || !SECRET_KEY) {
    console.error('Беда: не заданы YDB_ACCESS_KEY_ID и YDB_SECRET_ACCESS_KEY.');
    console.error('Как достать: Yandex Cloud → IAM → Сервисные аккаунты → sega-chat-sa →');
    console.error('«Создать новый ключ» → «Access key». Секрет показывается один раз — скопируйте его.');
    process.exit(1);
  }
  // ключи Яндекса — всегда латиница/цифры и несколько служебных знаков; если
  // при копировании закрались кавычки, пробел или кириллица, скажем об этом
  // сразу и по-человечески, вместо малопонятной ошибки сетевого слоя
  if (!/^[\x21-\x7e]+$/.test(KEY_ID) || !/^[\x21-\x7e]+$/.test(SECRET_KEY)) {
    die('в ключе попались лишние символы (кавычки, пробел, перенос строки или не латиница) — скопируйте оба ключа целиком ещё раз.');
  }

  const { createYdbStore } = lib('store-ydb.js');
  const { rowsToPayload } = lib('rows2db.js');
  const { createFileStore } = lib('store-file.js');
  const backup = lib('backup.js');

  log('подключаюсь к облачной базе: ' + ENDPOINT.replace(/^https?:\/\//, '').slice(0, 70) + '…');
  log('таблица: ' + TABLE);

  const ystore = createYdbStore({
    endpoint: ENDPOINT, table: TABLE, region: REGION,
    accessKeyId: KEY_ID, secretAccessKey: SECRET_KEY
  });

  let dump;
  try {
    dump = await ystore.dumpAll();          // только чтение: Scan по всей таблице
  } catch (e) {
    const m = String(e && e.message || e);
    if (/чужой ключ|AccessDenied|UnrecognizedClient|InvalidAccessKeyId|SignatureDoesNotMatch|403/i.test(m)) {
      die('ключ не подошёл или у него нет прав на базу: ' + m);
    }
    if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|timeout|getaddrinfo/i.test(m)) {
      die('облачная база не отвечает (сеть или авария в Яндексе): ' + m);
    }
    if (/ResourceNotFound|нет таблицы/i.test(m)) {
      die('таблица ' + TABLE + ' в этой базе не найдена — проверьте YDB_TABLE и адрес.');
    }
    die('база не открылась: ' + m);
  }
  const rows = dump.rows || [];
  if (!rows.length) die('в облачной таблице пусто — переносить нечего (проверьте, та ли база).');
  log('прочитано строк: ' + rows.length + (dump.counts ? '  ·  состав: ' + JSON.stringify(dump.counts) : ''));

  const conv = rowsToPayload(rows);
  const cdb = conv.db;
  if (!cdb || !cdb.serverSecret) die('в прочитанных строках нет базы мессенджера (нет строки meta/root).');
  if (!(cdb.users || []).length) die('в облачной базе ноль участников — переносить нечего.');
  log('в облачной базе: участников ' + cdb.users.length + ', чатов ' + (cdb.chats || []).length
    + ', сообщений ' + (cdb.messages || []).length + ', архивов ' + (cdb.archives || []).length);
  log('секрет мессенджера прочитан вместе с базой: ' + (cdb.serverSecret ? 'да' : 'нет')
    + ' — старые шифры участников будут читаться');

  if (opts.inspect) {
    log('это был осмотр (--inspect): на этом сервере ничего не изменено, в облаке тоже.');
    process.exit(0);
  }

  // страховка: не затереть переписку этого сервера
  const dbFile = path.join(DATA_DIR, 'db.json');
  let mine = 0;
  if (fs.existsSync(dbFile)) {
    try { mine = (JSON.parse(fs.readFileSync(dbFile, 'utf8')).users || []).length; } catch (e) {}
    if (mine > 0 && !opts.force) {
      console.error('Беда: на этом сервере уже есть переписка (' + mine + ' уч.).');
      console.error('Перенос поверх неё возможен только с флагом --force (прежняя база этого сервера');
      console.error('будет заменена, но сперва сделаем её страховочный файл).');
      process.exit(1);
    }
    const safety = dbFile + '.before-import-' + new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(dbFile, safety);
    log('страховка прежней базы этого сервера: ' + safety);
  }

  // локальная копия на случай, если потом понадобится откатиться
  if (opts.saveCopy) {
    try {
      const payload = {
        app: 'SEGA-CHAT', format: backup.FORMAT, createdAt: Date.now(),
        build: null, store: 'ydb', table: TABLE, counts: dump.counts || null,
        db: null, rows, files: null
      };
      const gz = zlib.gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'), { level: 9 });
      const blob = backup.encrypt(gz, cdb.serverSecret);
      const name = path.join(DATA_DIR, '..', backup.stampName().replace('.sbgz', '-vps.sbgz'));
      fs.writeFileSync(name, blob);
      log('местная копия сохранена: ' + name + ' (' + blob.length + ' байт)');
    } catch (e) {
      log('местную копию сохранить не удалось (' + (e && e.message || e) + ') — перенос продолжается');
    }
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const store = createFileStore({ dataDir: DATA_DIR });
  await store.open();
  const res = await store.restoreFiles({ db: cdb, files: conv.files || {} });
  await store.close();

  const db2 = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
  log('готово: участников ' + db2.users.length + ', чатов ' + db2.chats.length
    + ', сообщений ' + db2.messages.length + ', архивов ' + (db2.archives || []).length
    + ', соседних файлов записано ' + res.written);
  log('в облаке ничего не менялось — база только читалась.');
  log('теперь: systemctl start sega-chat  (обёртка import-ydb.sh делает это сама)');
  log('и не забудьте удалить постоянный ключ сервисного аккаунта в консоли Яндекса.');
})().catch(e => { console.error('Беда: ' + (e && e.message || e)); process.exit(1); });
