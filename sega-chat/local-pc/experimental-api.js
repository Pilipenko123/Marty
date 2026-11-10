'use strict';
// ЛАБОРАТОРНЫЙ режим: вызывается только createApi(...,{localPcExperimental:true})
// на файловом хранилище. Обычный server.js этот режим НЕ включает. Не использовать
// с настоящими файлами до проверки Windows, устойчивой привязки и всей защиты.
const crypto = require('node:crypto');
const { createRelay, digest, MAX_PACKET } = require('./relay');
const { MAX_FUTURE, CLOCK_SKEW } = require('./secure-channel');
const ID = /^[a-f0-9]{32}$/, HASH = /^[a-f0-9]{64}$/;
const J = (status,json) => ({status,json});
const E = (status,error) => J(status,{error});

function createExperimentalApi() {
  const relay = createRelay(), loaded = new Map(), failures = new Map();
  function all(db) {
    return (db.users || []).flatMap(user => (Array.isArray(user.localPcDevices) ? user.localPcDevices : []).map(record => ({user,record})));
  }
  function find(db,id) { return all(db).find(x => x.record && x.record.id === id) || null; }
  function ensure(owner, rec) {
    if (!loaded.has(rec.id)) {
      relay.register(owner, rec.id, rec.tokenHash);
      loaded.set(rec.id, owner);
    } else if (loaded.get(rec.id) !== owner) throw new Error('Неверное подключение');
  }
  function badLogin(ip) {
    const now = Date.now(), key = String(ip || 'unknown');
    for (const [k,v] of failures) if (now - v.at > 600000) failures.delete(k);
    if (!failures.has(key) && failures.size >= 2000) return true;
    const r = failures.get(key) || { n:0, at:now };
    r.n++; failures.set(key,r);
    return r.n > 30;
  }
  function packetValid(packet, dev, direction, requestId) {
    if (typeof packet !== 'string' || packet.length > MAX_PACKET) return false;
    try {
      const p = JSON.parse(packet), now = Date.now();
      return !!p && typeof p === 'object' && !Array.isArray(p) && Object.keys(p).sort().join(',') === 'b,c,d,e,i,n,v'
        && p.v === 1 && p.c === dev && p.d === direction && p.i === requestId
        && Number.isSafeInteger(p.e) && p.e >= now - CLOCK_SKEW && p.e <= now + MAX_FUTURE
        && typeof p.n === 'string' && /^[A-Za-z0-9_-]{16}$/.test(p.n)
        && typeof p.b === 'string' && /^[A-Za-z0-9_-]{22,349547}$/.test(p.b);
    } catch (_) { return false; }
  }
  function agent(req, db, save) {
    const h = String(req.headers.authorization || '');
    const m = /^Local ([a-f0-9]{32}):([a-f0-9]{64})$/.exec(h);
    const found = m && find(db, m[1]);
    const isClaim = req.path === '/api/pc-lab/agent/claim' && req.method === 'POST';
    const rec = found && found.record;
    const claimHash = rec && isClaim && rec.state === 'active' ? rec.claimHash : rec && rec.tokenHash;
    const expectedHash = HASH.test(claimHash || '') ? claimHash : '0'.repeat(64);
    const gotHash = digest(m ? m[2] : '0'.repeat(64));
    const ok = crypto.timingSafeEqual(Buffer.from(expectedHash,'hex'), Buffer.from(gotHash,'hex'));
    if (!m || !found || !ok || (found.user.bannedUntil && found.user.bannedUntil > Date.now())) {
      return E(badLogin(req.ip) ? 429 : 401, 'Подключение недоступно');
    }
    try {
      if (isClaim) {
        const hash = (req.body || {}).tokenHash;
        if (typeof hash !== 'string' || !HASH.test(hash) || hash === expectedHash) return E(400,'Неверные данные подключения');
        if (rec.state === 'active') {
          if (Date.now() <= rec.claimUntil && hash === rec.tokenHash) return J(200,{ok:true});
          return E(401,'Подключение недоступно');
        }
        if (rec.state !== 'pending' || Date.now() > rec.claimUntil) return E(401,'Код подключения истёк');
        rec.claimHash = rec.tokenHash; rec.tokenHash = hash; rec.state = 'active';
        save();
        return J(200,{ok:true});
      }
      if (rec.state !== 'active') return E(401,'Подключение ещё не завершено');
      ensure(found.user.id, rec);
      if (req.path === '/api/pc-lab/agent/poll' && req.method === 'POST') return J(200,{job:relay.next(m[1],m[2])});
      if (req.path === '/api/pc-lab/agent/reply' && req.method === 'POST') {
        const b = req.body || {};
        if (!ID.test(String(b.requestId || '')) || !packetValid(b.packet, m[1], 'response', b.requestId)) return E(400,'Неверный пакет');
        relay.reply(m[1],m[2],b.requestId,b.claim,b.packet);
        return J(200,{ok:true});
      }
      return E(404,'Не найдено');
    } catch (_) {
      return E(409,'Запрос не выполнен или устарел');
    }
  }
  function owner(req, db, me, save) {
    const list = Array.isArray(me.localPcDevices) ? me.localPcDevices : [];
    if (req.path === '/api/pc-lab/devices' && req.method === 'GET') {
      try {
        return J(200,{devices:list.map(d => {
          if (d.state !== 'active') return {id:d.id,title:d.title,wrappedKey:d.wrappedKey,online:false,state:Date.now()>d.claimUntil?'expired':'pending'};
          ensure(me.id,d); return {id:d.id,title:d.title,wrappedKey:d.wrappedKey,online:relay.status(me.id,d.id).online,state:'active'};
        })});
      } catch (_) { return E(503,'Подключение временно недоступно'); }
    }
    if (req.path === '/api/pc-lab/devices' && req.method === 'POST') {
      const b = req.body || {}, id = b.id, tokenHash = b.tokenHash, wrappedKey = b.wrappedKey, title = typeof b.title === 'string' ? b.title.trim() : '';
      if (typeof id !== 'string' || !ID.test(id) || typeof tokenHash !== 'string' || !HASH.test(tokenHash)
          || typeof wrappedKey !== 'string' || !/^[A-Za-z0-9+/_=-]{40,2048}$/.test(wrappedKey)
          || !title || title.length > 80 || /[\x00-\x1f\x7f]/.test(title)) return E(400,'Неверные данные подключения');
      if (list.length >= 3 || find(db,id)) return E(409,'Не удалось добавить подключение');
      const rec = {id,tokenHash,wrappedKey,title,state:'pending',claimUntil:Date.now()+600000};
      me.localPcDevices = list.concat([rec]); save();
      return J(200,{ok:true});
    }
    const match = /^\/api\/pc-lab\/devices\/([a-f0-9]{32})\/(request|result|ack|revoke)$/.exec(req.path);
    if (!match) return E(404,'Не найдено');
    const [,id,action] = match, rec = list.find(d => d.id === id);
    if (!rec) return E(404,'Подключение не найдено');
    try {
      if (action === 'revoke' && req.method === 'POST') {
        if (loaded.has(id)) { relay.revoke(me.id,id); loaded.delete(id); }
        me.localPcDevices = list.filter(d => d.id !== id); save();
        return J(200,{ok:true});
      }
      if (rec.state !== 'active') return E(409,'Подключение ещё не завершено');
      ensure(me.id,rec);
      if (action === 'request' && req.method === 'POST') {
        const b = req.body || {};
        if (typeof b.requestId !== 'string' || !ID.test(b.requestId) || !packetValid(b.packet,id,'request',b.requestId)) return E(400,'Неверный пакет');
        relay.request(me.id,id,b.requestId,b.packet);
        return J(200,{ok:true});
      }
      if (action === 'result' && req.method === 'GET') {
        const requestId = String(req.query.get('requestId') || '');
        if (!ID.test(requestId)) return E(400,'Неверный запрос');
        return J(200,relay.result(me.id,id,requestId));
      }
      if (action === 'ack' && req.method === 'POST') {
        const requestId = (req.body || {}).requestId;
        if (typeof requestId !== 'string' || !ID.test(requestId)) return E(400,'Неверный запрос');
        relay.acknowledge(me.id,id,requestId);
        return J(200,{ok:true});
      }
      return E(404,'Не найдено');
    } catch (_) { return E(409,'Запрос не выполнен или устарел'); }
  }
  return {agent,owner};
}
module.exports = { createExperimentalApi };
