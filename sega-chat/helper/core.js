'use strict';
/**
 * SEGA-CHAT · ядро синхронизации папок (этап 1).
 *
 * Только встроенные модули Node. Правила общие для помощника Windows и
 * будущих мостов Яндекс/Google: путь канонический, решение принимает журнал
 * версий, а не «у кого дата новее». Сервер не получает ключ папки.
 */

const crypto = require('crypto');

const PROTOCOL_VERSION = 1;
const MAX_PATH = 1024;
const MAX_COMPONENT = 255;
const MAX_DEPTH = 32;
const MAX_EVENT_BYTES = 1024 * 1024;
const DEFAULT_IGNORES = Object.freeze([
  '.git', 'node_modules', '.sega-sync', '.sega-tmp-*',
  'Thumbs.db', 'desktop.ini', '.DS_Store', '~$*', '*.tmp', '*.part', '*.crdownload'
]);
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

class SyncError extends Error {
  constructor(code, message) { super(message); this.name = 'SyncError'; this.code = code; }
}
const fail = (code, message) => { throw new SyncError(code, message); };

/** Канонический путь внутри папки. Никаких дисков, UNC, потоков NTFS и '..'. */
function normalizePath(raw, opts = {}) {
  if (typeof raw !== 'string') fail('path-type', 'Путь должен быть строкой');
  const s = raw.normalize('NFC');
  if (!s && opts.allowRoot) return '';
  if (!s) fail('path-empty', 'Пустой путь к файлу');
  if (s.length > MAX_PATH) fail('path-long', 'Путь слишком длинный');
  if (s.includes('\\')) fail('path-backslash', 'В пути нужна прямая косая черта');
  if (s.startsWith('/') || /^[a-z]:/i.test(s)) fail('path-absolute', 'Путь должен быть внутри выбранной папки');
  if (/[\x00-\x1f\x7f]/.test(s)) fail('path-control', 'В пути есть управляющий символ');
  const parts = s.split('/');
  if (parts.length > MAX_DEPTH) fail('path-deep', 'Слишком глубокая папка');
  for (const part of parts) {
    if (!part || part === '.' || part === '..') fail('path-segment', 'Небезопасная часть пути');
    if (part.length > MAX_COMPONENT) fail('path-component', 'Имя файла слишком длинное');
    if (part.includes(':')) fail('path-stream', 'Потоки и диски в пути запрещены');
    if (/[ .]$/.test(part)) fail('path-windows', 'Windows не сохраняет имя с пробелом или точкой в конце');
    if (RESERVED.test(part)) fail('path-reserved', 'Это служебное имя Windows');
    if (/[<>"|?*]/.test(part)) fail('path-char', 'Недопустимый символ в имени файла');
  }
  return parts.join('/');
}

/** Ключ для поиска конфликтов регистра Windows (Ёжик / ёжик). */
function pathKey(raw) { return normalizePath(raw).toLowerCase(); }

function detectCollisions(paths) {
  const seen = new Map();
  for (const raw of paths || []) {
    const key = pathKey(raw);
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push(normalizePath(raw));
  }
  return [...seen.values()].filter(list => list.length > 1);
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function ignoreMatcher(patterns) {
  const list = (patterns || DEFAULT_IGNORES).map(String);
  const regs = list.map(p => new RegExp('^' + p.split('*').map(escapeRe).join('.*') + '$', 'i'));
  return rel => {
    const path = normalizePath(rel, { allowRoot: true });
    if (!path) return false;
    return path.split('/').some(part => regs.some(re => re.test(part)));
  };
}

function isFingerprint(f) {
  return !!f && typeof f.hash === 'string' && /^[a-f0-9]{64}$/.test(f.hash)
    && Number.isSafeInteger(f.size) && f.size >= 0 && Number.isFinite(f.mtimeMs);
}

/**
 * Решение по трём версиям: local — сейчас на диске, base — последняя
 * синхронизированная, incoming — пришедшая. mtime не участвует в выборе.
 * Возвращает action: create/update/noop/keep-local/conflict/confirm-delete/
 * confirm-restore. Ни одна ветка не удаляет файл.
 */
function classifyChange(input) {
  const local = input && input.local || null;
  const base = input && input.base || null;
  const incoming = input && input.incoming || null;
  if (!incoming) fail('event-empty', 'Нет пришедшей версии');
  if (incoming.deleted) {
    if (!local) return { action: 'noop', reason: 'already-absent' };
    if (!isFingerprint(local)) fail('local-bad', 'Неизвестна локальная версия');
    return { action: 'confirm-delete', reason: 'delete-needs-approval' };
  }
  if (!isFingerprint(incoming)) fail('incoming-bad', 'Неизвестна пришедшая версия');
  if (local && !isFingerprint(local)) fail('local-bad', 'Неизвестна локальная версия');
  if (base && base.deleted) {
    if (!local) return { action: 'create', reason: 'deleted-before' };
  }
  if (!local) {
    if (base && !base.deleted) return { action: 'confirm-restore', reason: 'local-delete-unconfirmed' };
    return { action: 'create', reason: 'new-file' };
  }
  if (local.hash === incoming.hash) return { action: 'noop', reason: 'same-content' };
  if (incoming.baseHash && local.hash !== incoming.baseHash) return { action: 'conflict', reason: 'remote-base-mismatch' };
  if (base && !base.deleted && base.hash === incoming.hash) return { action: 'keep-local', reason: 'local-is-ahead' };
  if (base && !base.deleted && base.hash === local.hash) return { action: 'update', reason: 'local-unchanged' };
  return { action: 'conflict', reason: base ? 'both-changed' : 'unknown-local-version' };
}

/** Детерминированное имя конфликтной копии: повтор события не плодит файлы. */
function conflictName(rel, deviceLabel, eventId, exists) {
  const path = normalizePath(rel);
  const label = String(deviceLabel || 'компьютер').normalize('NFC')
    .replace(/[\x00-\x1f\x7f\\/:*?"<>|]/g, '').trim().slice(0, 32) || 'компьютер';
  const id = String(eventId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 12) || 'копия';
  const slash = path.lastIndexOf('/');
  const dir = slash < 0 ? '' : path.slice(0, slash + 1);
  const name = path.slice(slash + 1);
  const compound = /(\.tar\.(?:gz|bz2|xz|zst|lzma))$/i.exec(name);
  const dot = name.lastIndexOf('.');
  const ext = compound ? compound[1] : (dot > 0 && name.length - dot <= 17 ? name.slice(dot) : '');
  const stem = ext ? name.slice(0, name.length - ext.length) : name;
  const suffix = ' (конфликт ' + label + ' ' + id + ')';
  const taken = exists || (() => false);
  for (let n = 0; n < 1000; n++) {
    const candidate = normalizePath(dir + stem + suffix + (n ? ' ' + (n + 1) : '') + ext);
    if (!taken(candidate)) return candidate;
  }
  return fail('conflict-full', 'Слишком много конфликтных копий этого файла');
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  return '{' + Object.keys(value).sort().filter(k => value[k] !== undefined)
    .map(k => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}

function eventContext(event) {
  if (!event || typeof event.id !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(event.id)) fail('event-id', 'Неверная метка события');
  if (typeof event.folderId !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(event.folderId)) fail('event-folder', 'Неверная метка папки');
  if (typeof event.deviceId !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(event.deviceId)) fail('event-device', 'Неверная метка компьютера');
  if (event.op !== 'put' && event.op !== 'delete' && event.op !== 'mkdir') fail('event-op', 'Неизвестное действие');
  const keyRev = event.keyRev === undefined ? 1 : event.keyRev;
  if (!Number.isSafeInteger(keyRev) || keyRev < 1 || keyRev > 1000000) fail('event-key-rev', 'Неверная версия ключа папки');
  const p = normalizePath(event.path);
  // Имя файла не показываем серверу даже в контексте: только контрольная сумма пути.
  return { v: PROTOCOL_VERSION, folderId: event.folderId, eventId: event.id, deviceId: event.deviceId, op: event.op, keyRev,
    pathHash: crypto.createHash('sha256').update(p, 'utf8').digest('hex') };
}

/** AES-256-GCM. Контекст привязан к папке/событию: чужой конверт не подойдёт. */
function sealEvent(key, event) {
  if (!Buffer.isBuffer(key) || key.length !== 32) fail('key-length', 'Ключ папки должен быть 32 байта');
  const ctx = eventContext(event);
  const plain = Buffer.from(canonicalJson(event), 'utf8');
  if (plain.length > MAX_EVENT_BYTES) fail('event-large', 'Событие слишком большое');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(canonicalJson(ctx), 'utf8'));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { v: PROTOCOL_VERSION, alg: 'A256GCM', context: ctx, iv: iv.toString('base64'), ct: Buffer.concat([body, cipher.getAuthTag()]).toString('base64') };
}

function openEvent(key, envelope) {
  if (!Buffer.isBuffer(key) || key.length !== 32) fail('key-length', 'Ключ папки должен быть 32 байта');
  if (!envelope || envelope.v !== PROTOCOL_VERSION || envelope.alg !== 'A256GCM') fail('envelope-version', 'Неизвестный формат события');
  const ctx = envelope.context;
  if (!ctx || ctx.v !== PROTOCOL_VERSION || typeof ctx.folderId !== 'string' || typeof ctx.eventId !== 'string'
    || typeof ctx.deviceId !== 'string' || (ctx.op !== 'put' && ctx.op !== 'delete' && ctx.op !== 'mkdir')
    || !Number.isSafeInteger(ctx.keyRev) || ctx.keyRev < 1
    || typeof ctx.pathHash !== 'string' || !/^[a-f0-9]{64}$/.test(ctx.pathHash)) fail('envelope-context', 'Повреждён контекст события');
  const iv = Buffer.from(String(envelope.iv || ''), 'base64');
  const raw = Buffer.from(String(envelope.ct || ''), 'base64');
  if (iv.length !== 12 || raw.length < 17 || raw.length > MAX_EVENT_BYTES + 16) fail('envelope-size', 'Повреждён конверт события');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(canonicalJson(ctx), 'utf8'));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  let plain;
  try { plain = Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]); }
  catch (e) { return fail('envelope-auth', 'Событие повреждено или ключ не подходит'); }
  let event;
  try { event = JSON.parse(plain.toString('utf8')); } catch (e) { return fail('event-json', 'Событие повреждено'); }
  const actual = eventContext(event);
  if (canonicalJson(actual) !== canonicalJson(ctx)) fail('event-context', 'Событие не соответствует конверту');
  return event;
}

const CHUNK_PLAIN = 512 * 1024;
function chunkAAD(folderId, eventId, index) {
  return Buffer.from('sega-sync-chunk-v1|' + folderId + '|' + eventId + '|' + index, 'utf8');
}
function sealChunk(key, folderId, eventId, index, plain) {
  if (!Buffer.isBuffer(key) || key.length !== 32) fail('key-length', 'Ключ папки должен быть 32 байта');
  const b = Buffer.isBuffer(plain) ? plain : Buffer.from(plain);
  if (b.length > CHUNK_PLAIN) fail('chunk-large', 'Кусок файла слишком большой');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(chunkAAD(folderId, eventId, index));
  const body = Buffer.concat([c.update(b), c.final()]);
  return { v: 1, iv: iv.toString('base64'), ct: Buffer.concat([body, c.getAuthTag()]).toString('base64') };
}
function openChunk(key, folderId, eventId, index, envelope) {
  if (!Buffer.isBuffer(key) || key.length !== 32) fail('key-length', 'Ключ папки должен быть 32 байта');
  if (!envelope || envelope.v !== 1) fail('chunk-version', 'Неизвестный формат куска');
  const iv = Buffer.from(String(envelope.iv || ''), 'base64');
  const raw = Buffer.from(String(envelope.ct || ''), 'base64');
  if (iv.length !== 12 || raw.length < 17 || raw.length > CHUNK_PLAIN + 16) fail('chunk-size', 'Повреждён кусок файла');
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAAD(chunkAAD(folderId, eventId, index));
  d.setAuthTag(raw.subarray(raw.length - 16));
  try { return Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]); }
  catch (e) { return fail('chunk-auth', 'Кусок файла повреждён или ключ не подходит'); }
}

/** Непрозрачный блок для сервера: состояние помощника и названия файлов внутри
 * шифруются ключом папки. Формат тот же, что aesEncryptBytes в браузере. */
function sealOpaque(key, value) {
  if (!Buffer.isBuffer(key) || key.length !== 32) fail('key-length', 'Ключ папки должен быть 32 байта');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plain = Buffer.from(JSON.stringify(value), 'utf8');
  if (plain.length > MAX_EVENT_BYTES) fail('opaque-large', 'Состояние слишком большое');
  const ct = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  return Buffer.concat([iv, ct]).toString('base64');
}
function openOpaque(key, blob) {
  if (!Buffer.isBuffer(key) || key.length !== 32) fail('key-length', 'Ключ папки должен быть 32 байта');
  const raw = Buffer.from(String(blob || ''), 'base64');
  if (raw.length < 29 || raw.length > MAX_EVENT_BYTES + 28) fail('opaque-size', 'Повреждённое состояние');
  const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(raw.length - 16));
  try {
    const plain = Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]);
    return JSON.parse(plain.toString('utf8'));
  } catch (e) { return fail('opaque-auth', 'Состояние повреждено или ключ не подходит'); }
}

/** Пара ключей компьютера P-256. Открытая точка — как в переписке SEGA-CHAT. */
function generateDeviceKeys() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  return { pub: raw.toString('base64'), priv: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
}
function publicKeyFromRaw(raw) {
  const b = Buffer.from(String(raw || ''), 'base64');
  if (b.length !== 65 || b[0] !== 4) fail('pub-format', 'Неверный открытый ключ компьютера');
  return crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b.subarray(1, 33).toString('base64url'), y: b.subarray(33).toString('base64url') }, format: 'jwk' });
}
function pairKey(privPem, pubRaw) {
  try {
    const priv = crypto.createPrivateKey(privPem);
    const pub = publicKeyFromRaw(pubRaw);
    const shared = crypto.diffieHellman({ privateKey: priv, publicKey: pub });
    if (shared.length !== 32) fail('pair-length', 'Неверная длина общего ключа');
    return shared;
  } catch (e) { if (e instanceof SyncError) throw e; return fail('pair-fail', 'Ключи компьютера не подошли'); }
}
function sealFor(privPem, pubRaw, keyBytes) {
  const k = pairKey(privPem, pubRaw);
  if (!Buffer.isBuffer(keyBytes) || keyBytes.length !== 32) fail('key-length', 'Ключ папки должен быть 32 байта');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', k, iv);
  return Buffer.concat([iv, c.update(keyBytes), c.final(), c.getAuthTag()]).toString('base64');
}
function openFor(privPem, pubRaw, blob) {
  const k = pairKey(privPem, pubRaw);
  const raw = Buffer.from(String(blob || ''), 'base64');
  if (raw.length !== 60) fail('wrap-size', 'Повреждённая свёртка ключа');
  const d = crypto.createDecipheriv('aes-256-gcm', k, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(44));
  try { return Buffer.concat([d.update(raw.subarray(12, 44)), d.final()]); }
  catch (e) { return fail('wrap-auth', 'Ключ папки не открылся'); }
}

module.exports = {
  PROTOCOL_VERSION, MAX_PATH, MAX_COMPONENT, MAX_DEPTH, MAX_EVENT_BYTES, DEFAULT_IGNORES, CHUNK_PLAIN,
  SyncError, normalizePath, pathKey, detectCollisions, ignoreMatcher, isFingerprint,
  classifyChange, conflictName, canonicalJson, eventContext, sealEvent, openEvent, sealChunk, openChunk,
  sealOpaque, openOpaque, generateDeviceKeys, publicKeyFromRaw, pairKey, sealFor, openFor
};
