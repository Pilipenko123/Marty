'use strict';
// Лабораторный клиент для исходящего TLS-соединения. Не устанавливает и не
// запускает службу. Сервер в обычном режиме не содержит включённого API.
const https = require('node:https');
const ID = /^[a-f0-9]{32}$/, TOKEN = /^[a-f0-9]{64}$/;
const MAX_RESPONSE = 512 * 1024;

function createAgentClient({ baseUrl, deviceId, token, service, ca, timeoutMs = 15000 }) {
  let root;
  try { root = new URL(baseUrl); } catch (_) { throw new Error('Неверный адрес сервера'); }
  if (root.protocol !== 'https:' || root.username || root.password || root.search || root.hash || !root.hostname
      || !ID.test(deviceId) || !TOKEN.test(token) || !service || typeof service.handle !== 'function'
      || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) throw new Error('Неверные параметры подключения');
  const prefix = root.pathname.replace(/\/+$/, '');
  if (prefix && !/^\/[A-Za-z0-9/_-]+$/.test(prefix)) throw new Error('Неверный адрес сервера');
  function post(path, body, signal) {
    const payload = Buffer.from(JSON.stringify(body || {}));
    return new Promise((resolve, reject) => {
      let req, settled=false;
      const finish=(err,result)=>{if(settled)return;settled=true;clearTimeout(timer);if(err)reject(err);else resolve(result);};
      // Это предел всего запроса, а не только простоя сокета: сервер не может
      // бесконечно удерживать помощник редкими байтами ответа.
      const timer=setTimeout(()=>{const e=new Error('Нет ответа сервера');if(req)req.destroy();finish(e);},timeoutMs);
      try {
        req = https.request({ protocol:'https:', hostname:root.hostname, port:root.port || 443,
          method:'POST', path:prefix + path, ca, signal,
          headers:{ 'Content-Type':'application/json', 'Content-Length':payload.length,
            'Authorization':'Local ' + deviceId + ':' + token } }, res => {
          // Перенаправления не следуем и не дочитываем бесконечное тело ошибки.
          if (res.statusCode !== 200) {
            const e = new Error('Сервер отказал в подключении (' + res.statusCode + ')');
            e.status = res.statusCode; res.destroy(); finish(e); return;
          }
          const chunks = []; let size = 0, ended=false;
          res.on('data', part => {
            size += part.length;
            if (size > MAX_RESPONSE) {res.destroy();finish(new Error('Ответ слишком большой'));return;}
            chunks.push(part);
          });
          res.on('error',err=>finish(err));
          res.on('close',()=>{if(!ended)finish(new Error('Ответ сервера прерван'));});
          res.on('end',()=>{
            ended=true;
            try { finish(null,JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
            catch (_) { finish(new Error('Неверный ответ сервера')); }
          });
        });
        req.on('error',err=>finish(err));
        req.end(payload);
      } catch(err) { if(req)req.destroy();finish(err); }
    });
  }
  async function step(signal) {
    const response = await post('/api/pc-lab/agent/poll', {}, signal);
    if (!response || typeof response !== 'object' || !Object.hasOwn(response,'job')) throw new Error('Неверный ответ сервера');
    const job = response.job;
    if (job === null) return false;
    if (!job || typeof job !== 'object' || !ID.test(job.requestId || '') || !ID.test(job.claim || '') || typeof job.packet !== 'string') throw new Error('Неверный запрос');
    const packet = await service.handle(job.requestId,job.packet);
    if (typeof packet!=='string' || !packet || Buffer.byteLength(packet,'utf8')>360000) throw new Error('Неверный ответ помощника');
    const accepted=await post('/api/pc-lab/agent/reply',{requestId:job.requestId,claim:job.claim,packet},signal);
    if (!accepted || accepted.ok !== true) throw new Error('Сервер не подтвердил ответ');
    return true;
  }
  async function claim(newTokenHash, signal) {
    if (typeof newTokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(newTokenHash)) throw new Error('Неверные параметры подключения');
    const response = await post('/api/pc-lab/agent/claim', {tokenHash:newTokenHash}, signal);
    if (!response || response.ok !== true) throw new Error('Не получилось завершить подключение');
  }
  return Object.freeze({ step, claim });
}
module.exports = { createAgentClient };
