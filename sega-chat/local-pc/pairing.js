/* ЗАГОТОВКА связывания ПК: ещё не подключена к окнам или установщику.
 * Код настройки содержит ключ доступа и его нельзя печатать в логе или
 * передавать другим людям. Сервер его не получает; в базу идёт только хеш
 * токена и обёрнутый личным ключом шифротекст. Лабораторный сервер проверяет срок и допускает только первый секрет ПК,
 * но при потере питания его сохранение ещё не гарантировано. */
(function (g) {
  'use strict';
  const c = g.crypto && g.crypto.subtle ? g.crypto : (typeof require === 'function' ? require('node:crypto').webcrypto : null);
  const enc = new TextEncoder(), dec = new TextDecoder('utf-8', {fatal:true});
  const ID = /^[a-f0-9]{32}$/, USER = /^[a-f0-9]{18}$/, TOKEN = /^[a-f0-9]{64}$/;
  function b64(bytes) {
    let s = ''; for (let i=0;i<bytes.length;i+=0x8000) s += String.fromCharCode(...bytes.subarray(i,i+0x8000));
    return g.btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  }
  function unb64(s) {
    if (typeof s !== 'string' || !/^[A-Za-z0-9_-]+$/.test(s) || s.length % 4 === 1) throw new Error('Неверный код подключения');
    const raw = g.atob(s.replace(/-/g,'+').replace(/_/g,'/') + '='.repeat((4-s.length%4)%4));
    const out = Uint8Array.from(raw,x=>x.charCodeAt(0));
    if (b64(out) !== s) throw new Error('Неверный код подключения');
    return out;
  }
  function hex(b) { return [...b].map(x=>x.toString(16).padStart(2,'0')).join(''); }
  function validateUrl(input) {
    let u;
    try { u = new URL(input); } catch (_) { throw new Error('Неверный адрес мессенджера'); }
    if (u.protocol !== 'https:' || !u.hostname || u.username || u.password || u.search || u.hash || !/^\/[A-Za-z0-9/_-]*$/.test(u.pathname)) throw new Error('Нужен защищённый адрес мессенджера');
    return u.origin + u.pathname.replace(/\/+$/, '');
  }
  function aad(userId, id) {
    if (typeof userId !== 'string' || !USER.test(userId) || typeof id !== 'string' || !ID.test(id)) throw new Error('Неверная учётная запись');
    return enc.encode(JSON.stringify(['sega-local-wrap-v1',userId,id]));
  }
  async function wrapKey(privateKey, publicKey, userId, id) {
    const info = aad(userId,id);
    const bits = await c.subtle.deriveBits({name:'ECDH', public:publicKey},privateKey,256);
    const master = await c.subtle.importKey('raw',bits,'HKDF',false,['deriveKey']);
    return c.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:info,info:enc.encode('personal device key')},master,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  }
  async function create({url,userId,privateKey,publicKey}) {
    if (!c || !privateKey || !publicKey) throw new Error('Нужны личные ключи');
    const base=validateUrl(url), id=hex(c.getRandomValues(new Uint8Array(16)));
    const token=hex(c.getRandomValues(new Uint8Array(32))), secret=c.getRandomValues(new Uint8Array(32));
    const iv=c.getRandomValues(new Uint8Array(12)), meta=aad(userId,id);
    const encrypted=new Uint8Array(await c.subtle.encrypt({name:'AES-GCM',iv,additionalData:meta},await wrapKey(privateKey,publicKey,userId,id),secret));
    const wrapped=new Uint8Array(iv.length+encrypted.length); wrapped.set(iv); wrapped.set(encrypted,iv.length);
    const tokenHash=hex(new Uint8Array(await c.subtle.digest('SHA-256',enc.encode(token))));
    const code=b64(enc.encode(JSON.stringify({v:1,u:base,i:id,t:token,k:b64(secret)})));
    return { registration:{id,tokenHash,wrappedKey:b64(wrapped)}, code };
  }
  function parse(code, trustedUrl) {
    if (typeof code !== 'string' || code.length > 4096) throw new Error('Неверный код подключения');
    let o; try { o=JSON.parse(dec.decode(unb64(code.trim()))); } catch (_) { throw new Error('Неверный код подключения'); }
    if (!o || typeof o !== 'object' || Array.isArray(o) || Object.keys(o).sort().join(',') !== 'i,k,t,u,v'
        || o.v !== 1 || typeof o.i !== 'string' || !ID.test(o.i) || typeof o.t !== 'string' || !TOKEN.test(o.t)) throw new Error('Неверный код подключения');
    const url=validateUrl(o.u);
    if (trustedUrl !== undefined && url !== validateUrl(trustedUrl)) throw new Error('Адрес мессенджера не совпадает');
    const secret=unb64(o.k); if (secret.length !== 32) throw new Error('Неверный код подключения');
    return {url,deviceId:o.i,token:o.t,secret};
  }
  async function recover({userId,deviceId,wrappedKey,privateKey,publicKey}) {
    const meta=aad(userId,deviceId), raw=unb64(wrappedKey);
    if (raw.length !== 60) throw new Error('Неверный ключ подключения');
    try {
      const k=await wrapKey(privateKey,publicKey,userId,deviceId);
      const out=new Uint8Array(await c.subtle.decrypt({name:'AES-GCM',iv:raw.subarray(0,12),additionalData:meta},k,raw.subarray(12)));
      if (out.length !== 32) throw new Error();
      return out;
    } catch (_) { throw new Error('Не удалось открыть ключ подключения'); }
  }
  const exported=Object.freeze({create,parse,recover});
  if (typeof module !== 'undefined' && module.exports) module.exports=exported;
  else g.SegaLocalPairing=exported;
})(typeof globalThis !== 'undefined' ? globalThis : window);
