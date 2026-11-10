/* Зашифрованный конверт для будущего обмена. Не открывает сеть и не хранит
 * ключ. Один и тот же файл можно использовать в браузере и в Node.js.
 * Защита от повторного применения запросов, связывание устройств и хранение
 * ключа отдельно НЕ реализованы: этот модуль сам по себе не является каналом. */
(function (g) {
  'use strict';
  const c = g.crypto && g.crypto.subtle ? g.crypto : (typeof require === 'function' ? require('node:crypto').webcrypto : null);
  const encoder = new TextEncoder();
  const ID = /^[a-f0-9]{32}$/;
  const MAX_PLAIN = 256 * 1024;
  const MAX_FUTURE = 120000;
  const CLOCK_SKEW = 30000;
  function encode(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return g.btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function decode(text) {
    if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) throw new Error('Неверный пакет');
    const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - text.length % 4) % 4);
    const bytes = Uint8Array.from(g.atob(b64), x => x.charCodeAt(0));
    if (encode(bytes) !== text) throw new Error('Неверный пакет');
    return bytes;
  }
  function metadata(channel, direction, request, expires) {
    if (!ID.test(channel) || !ID.test(request) || !['request','response'].includes(direction) || !Number.isSafeInteger(expires) || expires < 1) throw new Error('Неверные данные пакета');
    return encoder.encode(JSON.stringify(['sega-local-v1', channel, direction, request, expires]));
  }
  async function key(raw, channel, direction) {
    if (!(raw instanceof Uint8Array) || raw.length !== 32) throw new Error('Неверный ключ');
    const ikm = await c.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
    return c.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:encoder.encode('SEGA-CHAT local folder v1'),info:encoder.encode(channel + ':' + direction)}, ikm, {name:'AES-GCM',length:256}, false, ['encrypt','decrypt']);
  }
  async function seal(raw, channel, direction, request, expires, plain) {
    if (!c || !(plain instanceof Uint8Array) || plain.length > MAX_PLAIN) throw new Error('Неверные данные пакета');
    const aad = metadata(channel, direction, request, expires);
    const iv = c.getRandomValues(new Uint8Array(12));
    const encrypted = await c.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad,tagLength:128}, await key(raw, channel, direction), plain);
    return JSON.stringify({v:1,c:channel,d:direction,i:request,e:expires,n:encode(iv),b:encode(new Uint8Array(encrypted))});
  }
  async function open(raw, packet, expected, now = Date.now()) {
    if (!c || typeof packet !== 'string' || packet.length > 360000 || !expected || !Number.isSafeInteger(now)) throw new Error('Неверный пакет');
    let o;
    try { o = JSON.parse(packet); } catch (_) { throw new Error('Неверный пакет'); }
    if (!o || typeof o !== 'object' || Array.isArray(o) || Object.keys(o).sort().join(',') !== 'b,c,d,e,i,n,v' || o.v !== 1) throw new Error('Неверный пакет');
    if (o.c !== expected.channel || o.d !== expected.direction || o.i !== expected.request || (expected.expires !== undefined && o.e !== expected.expires)) throw new Error('Пакет не относится к запросу');
    const aad = metadata(o.c, o.d, o.i, o.e);
    if (o.e < now - CLOCK_SKEW || o.e > now + MAX_FUTURE) throw new Error('Пакет просрочен');
    const iv = decode(o.n), bytes = decode(o.b);
    if (iv.length !== 12 || bytes.length < 16 || bytes.length > MAX_PLAIN + 16) throw new Error('Неверный пакет');
    try { return new Uint8Array(await c.subtle.decrypt({name:'AES-GCM',iv,additionalData:aad,tagLength:128}, await key(raw, o.c, o.d), bytes)); }
    catch (_) { throw new Error('Не удалось проверить пакет'); }
  }
  const exported = Object.freeze({seal,open,MAX_PLAIN,MAX_FUTURE,CLOCK_SKEW});
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  else g.SegaLocalSecureChannel = exported;
})(typeof globalThis !== 'undefined' ? globalThis : window);
