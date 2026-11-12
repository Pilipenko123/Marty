'use strict';
// ЛАБОРАТОРНЫЙ режим: вызывается только createApi(...,{localPcExperimental:true})
// на файловом хранилище. Обычный server.js этот режим НЕ включает. Не использовать
// с настоящими файлами до проверки Windows, устойчивой привязки и всей защиты.
const crypto = require('node:crypto');
const { createRelay, digest, MAX_PACKET } = require('./relay');
const { MAX_FUTURE, CLOCK_SKEW } = require('./secure-channel');
const ID = /^[a-f0-9]{32}$/, HASH = /^[a-f0-9]{64}$/;
// Отозванные номера сохраняются без токенов и ключей, чтобы случайное повторное
// использование того же кода не оживило старый ПК. При заполнении отказать в
// новых регистрациях, но по-прежнему позволять отзыв существующих устройств.
const MAX_DEVICE_RECORDS = 1024;
// Только ограничение лабораторного прототипа на учётную запись. Глобальный
// предел реле и доступная память отдельно ограничивают одновременную работу;
// это не обещание вместимости или максимального числа устройств продукта.
const MAX_ACTIVE_DEVICES = 32;
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
  // Разрешение относится только к этой лаборатории, не выдаёт доступ к
  // настоящим папкам. Полученные от клиента роли/идентификаторы не доверяются:
  // me и db должны быть предоставлены аутентифицирующим API из серверной базы.
  function access(user) {
    const rec=user && user.localPcAccess;
    if (rec === undefined || rec === null) return null;
    if (!rec || typeof rec!=='object' || Array.isArray(rec) || typeof rec.id!=='string' || !ID.test(rec.id)
      || !['pending','approved','denied','revoked'].includes(rec.state)
      || !Number.isSafeInteger(rec.requestedAt) || rec.requestedAt<=0
      || (rec.state!=='pending' && (typeof rec.by!=='string' || !rec.by || !Number.isSafeInteger(rec.decidedAt) || rec.decidedAt<=0))) return false;
    return rec;
  }
  function permitted(user) { const a=access(user);return !!a && a.state==='approved'; }
  function clearDevices(user) {
    const devices=Array.isArray(user.localPcDevices)?user.localPcDevices:[];
    for(const d of devices) if(d && typeof d.id==='string' && loaded.get(d.id)===user.id) {
      relay.revoke(user.id,d.id);loaded.delete(d.id);
    }
    // Старые коды и токены не оживают, даже если впоследствии разрешат заново.
    user.localPcDevices=devices.map(d=>d && ID.test(d.id || '')?{id:d.id,state:'revoked'}:d);
  }
  function accessRoutes(req,db,me,save) {
    if(req.path==='/api/pc-lab/access' && req.method==='GET') {
      const a=access(me);return a===false?E(503,'Состояние разрешения повреждено'):J(200,{state:a?a.state:'none'});
    }
    if(req.path==='/api/pc-lab/access/request' && req.method==='POST') {
      const a=access(me);if(a===false)return E(503,'Состояние разрешения повреждено');
      if(a && (a.state==='pending' || a.state==='approved'))return J(200,{state:a.state});
      clearDevices(me); // Старые лабораторные коды не должны пережить новое разрешение.
      me.localPcAccess={id:crypto.randomBytes(16).toString('hex'),state:'pending',requestedAt:Date.now()};save();
      return J(200,{state:'pending'});
    }
    if(req.path==='/api/pc-lab/access/admin' && req.method==='GET') {
      if(me.isAdmin!==true)return E(403,'Только для администратора');
      const requests=[],approved=[];
      for(const u of db.users || []) {
        const a=access(u);
        // Повреждённое состояние нельзя незаметно исключить: иначе опрос
        // ошибочно покажет, что ожидающих заявок или разрешений нет.
        if(a===false)return E(503,'Состояние разрешения повреждено');
        if(!a || (a.state!=='pending' && a.state!=='approved'))continue;
        const record={userId:u.id,name:u.name,requestId:a.id,requestedAt:a.requestedAt};
        (a.state==='pending'?requests:approved).push(record);
      }
      return J(200,{requests,approved});
    }
    if(req.path==='/api/pc-lab/access/decision' && req.method==='POST') {
      if(me.isAdmin!==true)return E(403,'Только для администратора');
      const b=req.body || {}, target=typeof b.userId==='string' && (db.users || []).find(u=>u.id===b.userId);
      if(!target || typeof b.requestId!=='string' || !ID.test(b.requestId) || !['approve','deny','revoke'].includes(b.decision))return E(400,'Неверное решение');
      const a=access(target);
      if(a===false)return E(503,'Состояние разрешения повреждено');
      if(!a || a.id!==b.requestId || (b.decision==='revoke'?a.state!=='approved':a.state!=='pending'))return E(409,'Запрос устарел или уже рассмотрен');
      if(b.decision==='revoke')clearDevices(target);
      target.localPcAccess={...a,state:b.decision==='approve'?'approved':b.decision==='deny'?'denied':'revoked',by:me.id,decidedAt:Date.now()};save();
      return J(200,{state:target.localPcAccess.state});
    }
    return E(404,'Не найдено');
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
    if (!m || !found || rec.state === 'revoked' || !ok || !permitted(found.user) || (found.user.bannedUntil && found.user.bannedUntil > Date.now())) {
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
    if(req.path.startsWith('/api/pc-lab/access'))return accessRoutes(req,db,me,save);
    // Отзыв своих подключений разрешён и после отзыва администратором; всё
    // остальное, включая старые привязки, закрыто без явного разрешения.
    const ownRevoke=req.method==='POST' && /^\/api\/pc-lab\/devices\/[a-f0-9]{32}\/revoke$/.test(req.path);
    if(!permitted(me) && !ownRevoke)return E(403,'Нужно разрешение администратора');
    const list = Array.isArray(me.localPcDevices) ? me.localPcDevices : [];
    if (req.path === '/api/pc-lab/devices' && req.method === 'GET') {
      try {
        return J(200,{devices:list.filter(d=>d && d.state!=='revoked').map(d => {
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
      if (list.length >= MAX_DEVICE_RECORDS || list.filter(d=>d && d.state!=='revoked').length >= MAX_ACTIVE_DEVICES || find(db,id)) return E(409,'Не удалось добавить подключение');
      const rec = {id,tokenHash,wrappedKey,title,state:'pending',claimUntil:Date.now()+600000};
      me.localPcDevices = list.concat([rec]); save();
      return J(200,{ok:true});
    }
    const match = /^\/api\/pc-lab\/devices\/([a-f0-9]{32})\/(request|result|ack|revoke)$/.exec(req.path);
    if (!match) return E(404,'Не найдено');
    const [,id,action] = match, rec = list.find(d => d && d.id === id && d.state!=='revoked');
    if (!rec) return E(404,'Подключение не найдено');
    try {
      if (action === 'revoke' && req.method === 'POST') {
        if (loaded.has(id)) { relay.revoke(me.id,id); loaded.delete(id); }
        // Сохраняем только номер; прежние токены и обёрнутый ключ удаляются из
        // текущей записи. Исторические резервные копии при этом не очищаются.
        me.localPcDevices = list.map(d => d && d.id === id ? {id,state:'revoked'} : d); save();
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
module.exports = { createExperimentalApi, MAX_DEVICE_RECORDS, MAX_ACTIVE_DEVICES };
