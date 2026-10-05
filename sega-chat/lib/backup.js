'use strict';
/**
 * Резервная копия мессенджера в облачном хранилище Yandex Cloud.
 *
 * Что происходит по кнопке «Сохранить копию в облако»:
 *   1. из базы (Yandex Database) вычитываются ВСЕ записи подряд — участники,
 *      чаты, сообщения, вложения, архивы;
 *   2. они упаковываются в один JSON и сжимаются (gzip);
 *   3. сжатый блок дополнительно шифруется секретом мессенджера (AES-256-GCM),
 *      поэтому даже тот, кто доберётся до файла копии, не прочитает его;
 *   4. файл кладётся в приватный бакет Object Storage, рядом с программой;
 *   5. копия тут же перечитывается обратно и сверяется контрольная сумма —
 *      чтобы «сохранилось» означало именно «сохранилось».
 *
 * Старые копии подчищаются: хранятся последние BACKUP_KEEP штук.
 *
 * Переменные окружения:
 *   CODE_BUCKET    имя бакета (обязательно)
 *   BACKUP_PREFIX  «папка» внутри бакета, по умолчанию backups/
 *   BACKUP_KEEP    сколько копий держать, по умолчанию 10
 *   S3_ENDPOINT    только для проверок вне облака
 */

const zlib = require('zlib');
const crypto = require('crypto');
const { createS3, S3Error } = require('./s3');

const FORMAT = 'sega-chat-cloud-backup-v1';
const MAGIC = Buffer.from('SEGABK01', 'ascii');   // 8 байт: «это наша копия»
const IV_LEN = 12;
const TAG_LEN = 16;
const MAX_RAW = 60 * 1024 * 1024;                // предел «сырого» дампа (60 МБ)

function config() {
  return {
    bucket: String(process.env.CODE_BUCKET || process.env.S3_BUCKET || ''),
    endpoint: String(process.env.S3_ENDPOINT || 'https://storage.yandexcloud.net'),
    prefix: String(process.env.BACKUP_PREFIX || 'backups/'),
    keep: Math.max(1, Number(process.env.BACKUP_KEEP || 10))
  };
}

/** Настроен ли вообще уход копий в облако. */
function enabled() { return !!config().bucket; }

function s3(over = {}) {
  const c = config();
  return createS3(Object.assign({ bucket: c.bucket, endpoint: c.endpoint }, over));
}

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

function keyFromSecret(secret) {
  return crypto.createHmac('sha256', String(secret || '')).update('sega-chat-backup-v1').digest();
}

function encrypt(buf, secret) {
  const iv = crypto.randomBytes(IV_LEN);
  const c = crypto.createCipheriv('aes-256-gcm', keyFromSecret(secret), iv);
  const data = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), data]);
}

function decrypt(buf, secret) {
  if (!Buffer.isBuffer(buf) || buf.length < MAGIC.length + IV_LEN + TAG_LEN) throw new Error('файл слишком короткий');
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('это не копия SEGA-CHAT');
  const iv = buf.subarray(MAGIC.length, MAGIC.length + IV_LEN);
  const tag = buf.subarray(MAGIC.length + IV_LEN, MAGIC.length + IV_LEN + TAG_LEN);
  const data = buf.subarray(MAGIC.length + IV_LEN + TAG_LEN);
  const d = crypto.createDecipheriv('aes-256-gcm', keyFromSecret(secret), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]);
}

/** Честно посчитать записи в копии: в облачном режиме это строки таблицы,
 *  в файловом — сущности базы (пользователи, сообщения, чаты и т. д.). */
function countRecords(head) {
  if (!head || typeof head !== 'object') return 0;
  if (Array.isArray(head.rows) && head.rows.length) return head.rows.length;
  let n = 0;
  const d = head.db;
  if (d && typeof d === 'object') {
    for (const k of Object.keys(d)) if (Array.isArray(d[k])) n += d[k].length;
  }
  return n;
}

/** Проверить файл копии, не распаковывая его до конца (для «скачал — убедился»). */
function inspect(buf, secret) {
  const gz = decrypt(buf, secret);
  const json = zlib.gunzipSync(gz).toString('utf8');
  const head = JSON.parse(json);
  return {
    format: head.format || null, createdAt: head.createdAt || null, build: head.build || null,
    store: head.store || null, rows: countRecords(head),
    counts: head.counts || null, bytes: buf.length
  };
}

/** Имя файла копии: sega-chat-2026-10-03-142503.sbgz (время всемирное). */
function stampName(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return 'sega-chat-' + d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate())
    + '-' + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + '.sbgz';
}

/** Достать дату из имени копии; если имя «чужое» — берём дату из хранилища. */
function atFromKey(key, fallback) {
  const m = /(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(String(key));
  if (!m) return fallback ? Date.parse(fallback) || null : null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

/**
 * Сделать копию и положить её в бакет.
 * @returns {Promise<object>} { key, bytes, rawBytes, gzBytes, rows, counts, at, verify }
 */
async function createBackup(opts) {
  const { store, db, build } = opts;
  const c = config();
  if (!c.bucket) throw new Error('Облачное хранилище не настроено: у функции нет переменной CODE_BUCKET');
  const client = opts.s3 || s3();

  // сначала сбрасываем в базу всё, что накопилось в памяти «тёплого» экземпляра,
  // иначе в копию не попадут самые свежие сообщения
  if (typeof store.flush === 'function') { try { await store.flush(db); } catch (e) {} }
  if (typeof store.dumpAll !== 'function') throw new Error('Хранилище не умеет выгружать копию');

  const dump = await store.dumpAll();
  const payload = {
    app: 'SEGA-CHAT',
    format: FORMAT,
    createdAt: Date.now(),
    build: build || null,
    store: store.name || null,
    table: dump.table || null,
    counts: dump.counts || null,
    db: dump.db || null,          // файловый режим: база целиком
    rows: dump.rows || [],        // облачный режим: сырые записи таблицы
    files: dump.files || null     // файловый режим: соседние файлы (архивы и пр.)
  };
  const raw = Buffer.from(JSON.stringify(payload), 'utf8');
  if (raw.length > MAX_RAW) {
    throw new Error('База слишком большая для одной копии (' + Math.round(raw.length / 1048576) + ' МБ) — сначала разгрузите архивы');
  }
  const gz = zlib.gzipSync(raw, { level: 9 });
  const blob = encrypt(gz, db.serverSecret);

  const at = Date.now();
  const key = c.prefix + await freeName(client, c.prefix, stampName(new Date(at)));
  await client.put(key, blob, 'application/octet-stream');

  // самопроверка: читаем обратно и сверяем отпечаток
  let verify = false;
  try {
    const back = await client.get(key);
    verify = !!back && sha256(back) === sha256(blob);
  } catch (e) { verify = false; }

  await trim(client, c);

  return {
    key, at, bytes: blob.length, rawBytes: raw.length, gzBytes: gz.length,
    rows: countRecords(payload), counts: dump.counts || null, verify,
    sha256: sha256(blob)
  };
}

/**
 * Подобрать свободное имя: две копии, сделанные в одну секунду, не должны
 * затирать друг друга — вторая получит хвост «-2», третья «-3» и т. д.
 */
async function freeName(client, prefix, base) {
  const stem = base.replace(/\.sbgz$/, '');
  for (let i = 0; i < 20; i++) {
    const name = (i ? stem + '-' + (i + 1) : stem) + '.sbgz';
    let exists = null;
    try { exists = await client.head(prefix + name); } catch (e) { exists = null; }
    if (!exists) return name;
  }
  return stem + '-' + Date.now() + '.sbgz';
}

/** Оставить только последние keep копий. */
async function trim(client, c) {
  try {
    const all = await client.list(c.prefix);
    const mine = all.filter(x => /\.sbgz$/.test(x.key));
    const age = (x) => atFromKey(x.key, x.lastModified) || 0;
    mine.sort((a, b) => age(b) - age(a));
    for (const extra of mine.slice(c.keep)) {
      await client.del(extra.key).catch(() => {});
    }
  } catch (e) { /* чистка не должна ронять создание копии */ }
}

async function listBackups(client) {
  const c = config();
  const cl = client || s3();
  const all = await cl.list(c.prefix);
  return all.filter(x => /\.sbgz$/.test(x.key)).map(x => ({
    key: x.key,
    name: x.key.split('/').pop(),
    bytes: x.size,
    at: atFromKey(x.key, x.lastModified)
  })).sort((a, b) => (b.at || 0) - (a.at || 0));
}

async function readBackup(key, client) {
  const c = config();
  const cl = client || s3();
  const buf = await cl.get(safeKey(key, c.prefix));
  return buf;
}

async function deleteBackup(key, client) {
  const c = config();
  const cl = client || s3();
  await cl.del(safeKey(key, c.prefix));
  return true;
}

/** Не выпускаем запрос за пределы «папки» копий и отрезаем всякие ../ */
function safeKey(key, prefix) {
  const tail = String(key || '').replace(/^\/+/, '');
  const bare = tail.split('/').pop() || '';
  // ни точек-путей, ни пустого имени: копия всегда лежит ровно в папке prefix
  if (!bare || bare === '.' || bare === '..' || bare.includes('..')) throw new Error('Неверное имя копии');
  if (!/^[\w.\-]+$/.test(bare)) throw new Error('Неверное имя копии');
  return (prefix || '') + bare;
}

module.exports = {
  FORMAT, config, enabled, s3, createBackup, listBackups, readBackup, deleteBackup,
  encrypt, decrypt, inspect, sha256, safeKey, stampName, atFromKey, countRecords, S3Error
};
