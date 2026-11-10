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
      const req = https.request({ protocol:'https:', hostname:root.hostname, port:root.port || 443,
        method:'POST', path:prefix + path, ca, timeout:timeoutMs, signal,
        headers:{ 'Content-Type':'application/json', 'Content-Length':payload.length,
          'Authorization':'Local ' + deviceId + ':' + token } }, res => {
        // Перенаправления не следуем: токен никогда не отправляется другому сайту.
        if (res.statusCode !== 200) {
          res.resume();
          const e = new Error('Сервер отказал в подключении (' + res.statusCode + ')');
          e.status = res.statusCode; reject(e); return;
        }
        const chunks = []; let size = 0;
        res.on('data', part => { size += part.length; if (size > MAX_RESPONSE) { res.destroy(new Error('Ответ слишком большой')); return; } chunks.push(part); });
        res.on('error',reject);
        res.on('end',()=>{
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch (_) { reject(new Error('Неверный ответ сервера')); }
        });
      });
      req.on('timeout', () => req.destroy(new Error('Нет ответа сервера')));
      req.on('error',reject);
      req.end(payload);
    });
  }
  async function step(signal) {
    const response = await post('/api/pc-lab/agent/poll', {}, signal);
    if (!response || typeof response !== 'object' || !Object.hasOwn(response,'job')) throw new Error('Неверный ответ сервера');
    const job = response.job;
    if (job === null) return false;
    if (!job || typeof job !== 'object' || !ID.test(job.requestId || '') || !ID.test(job.claim || '') || typeof job.packet !== 'string') throw new Error('Неверный запрос');
    const packet = await service.handle(job.requestId,job.packet);
    await post('/api/pc-lab/agent/reply',{requestId:job.requestId,claim:job.claim,packet},signal);
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
