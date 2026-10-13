#!/usr/bin/env node
'use strict';
/**
 * pkg3-51: перенос истории на этот сервер из РЕЗЕРВНОЙ КОПИИ, лежащей в бакете
 * Yandex Object Storage. Обходной путь для случая, когда облачная функция
 * не запускается и штатный канал «запасной → основной» (import-from-yandex.js)
 * недоступен.
 *
 * Что нужно для работы (два предмета, оба добываются мышкой в консоли Яндекса):
 *
 *   1. ФАЙЛ КОПИИ. Бакет `sega-chat-code` → папка `backups/` → файл вида
 *      `sega-chat-2026-10-13-053415.sbgz` (в имени — дата и время всемирное).
 *      Скачать его на свой компьютер, затем скопировать на этот сервер,
 *      например из PowerShell:
 *        scp "C:\Users\имя\Downloads\sega-chat-2026-10-13-053415.sbgz" root@АДРЕС:/root/
 *
 *   2. СЕКРЕТ МЕССЕНДЖЕРА (serverSecret) — 64 шестнадцатеричных символа.
 *      Копия зашифрована именно им. Лежит в облачной таблице, в строке
 *      pk='meta', sk='root', колонка `d` (это JSON, секрет — четвёртое поле).
 *      В консоли Yandex Cloud: Yandex Database → ваша база → SQL-консоль:
 *        SELECT d FROM sega_chat WHERE pk = 'meta' AND sk = 'root';
 *
 * Запуск (служба должна быть остановлена — см. обёртку import-backup.sh):
 *   SEGA_BACKUP_SECRET=СЕКРЕТ node cloud-vps/import-from-backup.js --file /root/имя.sbgz
 *   node cloud-vps/import-from-backup.js --file /root/имя.sbgz --inspect   ← только посмотреть
 *
 * Безопасность:
 *   • в Яндексе ничего не меняется — файл копии только читается;
 *   • своя база этого сервера заменяется лишь с флагом --force, а перед
 *     заменой делается страховочный файл db.json.before-import-…;
 *   • секрет можно передать переменной окружения, чтобы он не попал в историю
 *     команд (аргумент --secret тоже работает, но виден в `ps`).
 */

const fs = require('fs');
const path = require('path');

/* ── аргументы и окружение ─────────────────────────────────────────── */

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

// разбор аргументов: --file/--secret/--data-dir со значением, --force/--inspect
// без значения, а «голое» имя файла можно дать и без --file
const opts = { file: '', secret: '', dataDir: '', force: false, inspect: false };
{
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    const t = a[i];
    if (t === '--file') opts.file = a[++i] || '';
    else if (t === '--secret') opts.secret = a[++i] || '';
    else if (t === '--data-dir') opts.dataDir = a[++i] || '';
    else if (t === '--force') opts.force = true;
    else if (t === '--inspect') opts.inspect = true;
    else if (!t.startsWith('--') && !opts.file) opts.file = t;
  }
}

const FILE = opts.file || process.env.SEGA_BACKUP_FILE || fileEnv.SEGA_BACKUP_FILE || '';
const SECRET = (opts.secret || process.env.SEGA_BACKUP_SECRET || fileEnv.SEGA_BACKUP_SECRET || '').trim();
const DATA_DIR = opts.dataDir || process.env.DATA_DIR || fileEnv.DATA_DIR || '/opt/sega-chat/data';
const FORCE = opts.force;
const INSPECT = opts.inspect;

const log = (m) => console.log('  ' + m);
const die = (m) => { console.error('Беда: ' + m); process.exit(1); };

/* ── поиск модулей программы (скрипт могут запустить и из /tmp) ─────── */

function lib(name) {
  const roots = [
    path.join(__dirname, '..'),
    '/opt/sega-chat/code',
    process.cwd()
  ];
  for (const r of roots) {
    const p = path.join(r, 'lib', name);
    if (fs.existsSync(p)) return require(p);
  }
  die('не нашёл lib/' + name + ' (искал рядом со скриптом, в /opt/sega-chat/code и в текущей папке).');
}

/* ── основная работа ───────────────────────────────────────────────── */

(async () => {
  const backup = lib('backup.js');
  const { rowsToPayload } = lib('rows2db.js');
  const { createFileStore } = lib('store-file.js');

  if (!FILE) die('не указан файл копии. Пример: --file /root/sega-chat-2026-10-13-053415.sbgz');
  if (!fs.existsSync(FILE)) die('файла ' + FILE + ' нет на этом сервере.');
  if (!SECRET) {
    console.error('Беда: не передан секрет мессенджера (serverSecret, 64 шестнадцатеричных символа).');
    console.error('Как достать: Yandex Cloud → Yandex Database → SQL-консоль →');
    console.error("  SELECT d FROM sega_chat WHERE pk = 'meta' AND sk = 'root';");
    console.error('В ответе найдите "serverSecret":"…" и скопируйте 64 символа между кавычками.');
    console.error('Запуск: SEGA_BACKUP_SECRET=ЭТИ_64_СИМВОЛА node ' + path.basename(__filename) + ' --file ' + FILE);
    process.exit(1);
  }
  if (!/^[0-9a-fA-F]{32,128}$/.test(SECRET)) {
    die('секрет похож не на тот: нужно 64 шестнадцатеричных символа (пришло ' + SECRET.length + ').');
  }

  const buf = fs.readFileSync(FILE);
  log('файл копии: ' + FILE + ' (' + buf.length + ' байт)');
  if (buf.length < 40) die('файл слишком короткий — похоже, скачался не целиком.');

  // 1. сначала только смотрим, что внутри: секрет подходит, копия наша, дата
  let head;
  try {
    head = backup.inspect(buf, SECRET);
  } catch (e) {
    const msg = String(e && e.message || e);
    if (/поддерживаемый|Unsupported|auth|tag|decrypt|неверно/i.test(msg) || msg.includes('Unable to authenticate')) {
      die('секрет не подошёл — копия не открылась. Проверьте, что скопировали ровно 64 символа serverSecret из той же базы.');
    }
    if (msg.includes('не копия SEGA-CHAT')) die(msg + ' (файл повреждён или это не .sbgz).');
    die('копия не открылась: ' + msg);
  }
  const when = head.createdAt ? new Date(head.createdAt).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '?';
  log('копия опознана: ' + (head.format || '?'));
  log('сделана: ' + when + '  ·  выпуск ' + (head.build || '?') + '  ·  источник ' + (head.store || '?') + (head.table ? '/' + head.table : ''));
  log('записей в копии: ' + head.rows + (head.counts ? '  ·  состав: ' + JSON.stringify(head.counts) : ''));

  if (INSPECT) {
    log('это был осмотр (--inspect): на сервере ничего не изменено.');
    process.exit(0);
  }

  // 2. страховка: не затереть собственную переписку этого сервера
  const dbFile = path.join(DATA_DIR, 'db.json');
  let mine = 0;
  if (fs.existsSync(dbFile)) {
    try { mine = (JSON.parse(fs.readFileSync(dbFile, 'utf8')).users || []).length; } catch (e) {}
    if (mine > 0 && !FORCE) {
      console.error('Беда: на этом сервере уже есть переписка (' + mine + ' уч.).');
      console.error('Перенос поверх неё возможен только с флагом --force (база этого сервера будет заменена,');
      console.error('но сперва сделаем страховочную копию файла db.json).');
      process.exit(1);
    }
  }
  if (fs.existsSync(dbFile)) {
    const safety = dbFile + '.before-import-' + new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(dbFile, safety);
    log('страховка прежней базы: ' + safety);
  }

  // 3. распаковываем и превращаем облачные строки в домашнюю базу
  const payload = backup.open(buf, SECRET);
  const conv = Array.isArray(payload.rows) && payload.rows.length
    ? rowsToPayload(payload.rows)
    : { db: payload.db, files: payload.files || {} };
  if (!conv.db || !conv.db.serverSecret) die('в копии нет базы (пустой файл или копия другого мессенджера).');
  const users = (conv.db.users || []).length;
  if (!users) die('в копии ноль участников — переносить нечего.');

  // 4. кладём на диск этого сервера
  const store = createFileStore({ dataDir: DATA_DIR });
  await store.open();
  const res = await store.restoreFiles({ db: conv.db, files: conv.files || {} });
  await store.close();

  const db2 = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
  log('готово: участников ' + db2.users.length + ', чатов ' + db2.chats.length
    + ', сообщений ' + db2.messages.length + ', архивов ' + (db2.archives || []).length
    + ', соседних файлов записано ' + res.written);
  log('секрет мессенджера переехал вместе с базой: ' + (db2.serverSecret === conv.db.serverSecret ? 'да' : 'НЕТ — беда')
    + ' (старые сообщения участников будут читаться)');
  if (conv.stats) log('разобрано разделов таблицы: ' + conv.stats.pks + ', документов: ' + conv.stats.docs);
  log('в Яндексе ничего не менялось — копия только читалась.');
  log('теперь: systemctl start sega-chat  (обёртка import-backup.sh делает это сама)');
})().catch(e => { console.error('Беда: ' + (e && e.message || e)); process.exit(1); });
