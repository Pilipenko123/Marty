'use strict';

// Изолированный прототип почтового ящика для ЗАШИФРОВАННЫХ сообщений.
// НЕ зарегистрирован в API и НЕ открывает сетевых портов. Вызывающий код
// обязан установить владельца по настоящей сессии, сохранить хеш токена ПК,
// восстановить подключения после перезапуска и отдельно шифровать сообщения.
const crypto = require('node:crypto');
const MAX_PACKET = 512 * 1024;
const MAX_PENDING = 8;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_DEVICES = 100;
const MAX_AGE = 60_000;
const LEASE = 10_000;
const ONLINE_AGE = 30_000;
const ID = /^[a-f0-9]{32}$/;
const TOKEN = /^[a-f0-9]{64}$/;
const digest = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

function createRelay(options = {}) {
  const clock = options.clock || Date.now;
  const devices = new Map();
  let bytes = 0;
  const fail = message => { throw new Error(message); };
  function validatePacket(packet) {
    if (typeof packet !== 'string' || !packet || Buffer.byteLength(packet, 'utf8') > MAX_PACKET) fail('Некорректный пакет');
  }
  function requireOwner(owner, id) {
    const d = devices.get(id);
    if (!d || typeof owner !== 'string' || !owner || d.owner !== owner) fail('Подключение не найдено');
    return d;
  }
  function requireAgent(id, token) {
    const d = devices.get(id);
    if (!d || typeof token !== 'string' || !TOKEN.test(token)) fail('Подключение не найдено');
    const supplied = Buffer.from(digest(token), 'hex'), expected = Buffer.from(d.tokenHash, 'hex');
    if (!crypto.timingSafeEqual(supplied, expected)) fail('Подключение не найдено');
    return d;
  }
  function reap() {
    const now = clock();
    for (const d of devices.values()) for (const [id, r] of d.requests) {
      if (now >= r.created + MAX_AGE) { bytes -= r.bytes; d.requests.delete(id); }
    }
  }
  function register(owner, id, tokenHash) {
    if (typeof owner !== 'string' || !owner || owner.length > 200 || typeof id !== 'string' || !ID.test(id) || typeof tokenHash !== 'string' || !TOKEN.test(tokenHash)) fail('Неверные данные подключения');
    if (devices.has(id) || devices.size >= MAX_DEVICES) fail('Не удалось добавить подключение');
    devices.set(id, { owner, tokenHash, seen:null, requests:new Map() });
  }
  function revoke(owner, id) {
    const d = requireOwner(owner, id);
    for (const r of d.requests.values()) bytes -= r.bytes;
    devices.delete(id);
  }
  function status(owner, id) {
    const d = requireOwner(owner, id);
    return { online:d.seen !== null && clock() - d.seen < ONLINE_AGE };
  }
  function request(owner, id, requestId, packet) {
    reap();
    const d = requireOwner(owner, id);
    if (typeof requestId !== 'string' || !ID.test(requestId)) fail('Неверный номер запроса');
    validatePacket(packet);
    const prior = d.requests.get(requestId);
    if (prior) {
      if (prior.packet !== packet) fail('Номер запроса уже использован');
      return; // повтор после обрыва безопасен
    }
    const n = Buffer.byteLength(packet, 'utf8');
    if (d.requests.size >= MAX_PENDING || bytes + n > MAX_TOTAL_BYTES) fail('Слишком много ожидающих запросов');
    d.requests.set(requestId, { packet, created:clock(), bytes:n, claim:'', lease:0, response:null });
    bytes += n;
  }
  function next(id, token) {
    reap();
    const d = requireAgent(id, token);
    const now = clock(); d.seen = now;
    for (const [requestId, r] of d.requests) {
      if (r.response !== null || (r.claim && r.lease > now)) continue;
      r.claim = crypto.randomBytes(16).toString('hex');
      r.lease = now + LEASE;
      return { requestId, claim:r.claim, packet:r.packet };
    }
    return null;
  }
  function reply(id, token, requestId, claim, packet) {
    reap();
    const d = requireAgent(id, token);
    const r = d.requests.get(requestId);
    validatePacket(packet);
    if (!r || typeof claim !== 'string' || !ID.test(claim) || r.claim !== claim) fail('Запрос устарел');
    // Повтор ответа после обрыва допустим только с тем же содержимым.
    if (r.response !== null) {
      if (r.response !== packet) fail('Ответ уже отправлен');
      return;
    }
    if (clock() >= r.lease) fail('Запрос устарел');
    const n = Buffer.byteLength(packet, 'utf8');
    if (bytes + n > MAX_TOTAL_BYTES) fail('Слишком много ожидающих запросов');
    r.response = packet; r.bytes += n; bytes += n; d.seen = clock();
  }
  function result(owner, id, requestId) {
    reap();
    const r = requireOwner(owner, id).requests.get(requestId);
    if (!r) fail('Запрос истёк');
    return r.response === null ? { ready:false } : { ready:true, packet:r.response };
  }
  return Object.freeze({ register, revoke, status, request, next, reply, result });
}
module.exports = { createRelay, digest, MAX_PACKET, MAX_PENDING, MAX_TOTAL_BYTES, MAX_DEVICES, MAX_AGE, LEASE, ONLINE_AGE };
