'use strict';
// Прототип обработчика для чтения. НЕТ сети, установки или доступа на запись.
// Не подключать к внешним запросам до завершения привязки, защиты путей на
// Windows, ограничения прав и проверки всего протокола на Windows 10.
const crypto = require('node:crypto');
const channel = require('./secure-channel');
const {validateSignal,checkAborted,waitFor} = require('./abort');
const {partsOf} = require('./path-rules');
const {MAX_FILE:MAX_HASH_FILE} = require('./file-hash-candidate');
const MAX_READ = 128 * 1024;
const MAX_REPLIES = 500;

function createReadService({ folder, secret, deviceId, clock = Date.now, hashFile }) {
  if (!folder || typeof folder.list !== 'function' || typeof folder.read !== 'function' || !(secret instanceof Uint8Array) || secret.length !== 32 || !/^[a-f0-9]{32}$/.test(deviceId) || (hashFile!==undefined && typeof hashFile!=='function')) throw new Error('Неверное подключение');
  const key = new Uint8Array(secret); // вызывающий код не может заменить ключ во время работы
  const replies = new Map();
  async function execute(request,signal) {
    checkAborted(signal);
    if (!request || typeof request !== 'object' || Array.isArray(request) || typeof request.path !== 'string') throw new Error('Некорректный запрос');
    if (request.op === 'list' && Object.keys(request).sort().join(',') === 'op,path') {
      const items = await folder.list(request.path,signal);
      checkAborted(signal);
      return {ok:true, items};
    }
    const keys = Object.keys(request).sort().join(',');
    // Отдельная возможность, не включается по умолчанию. Даже успешный ответ
    // не гарантирует атомарный снимок и не подтверждает происхождение файла.
    if(request.op==='hash' && keys==='op,path' && hashFile && partsOf(request.path).length) {
      const r=await hashFile(request.path,signal);checkAborted(signal);
      if(!r || Object.keys(r).sort().join(',')!=='hash,modified,size,version' || !Number.isSafeInteger(r.size) || r.size<0 || r.size>MAX_HASH_FILE
        || typeof r.hash!=='string' || !/^[a-f0-9]{64}$/.test(r.hash) || typeof r.version!=='string' || !/^[a-f0-9]{64}$/.test(r.version)
        || typeof r.modified!=='string' || !r.modified || r.modified.length>100)throw new Error('Неверный результат');
      return {ok:true,size:r.size,version:r.version,modified:r.modified,hash:r.hash};
    }
    if (request.op === 'read' && (keys === 'length,offset,op,path' || keys === 'length,offset,op,path,version')
        && Number.isSafeInteger(request.offset) && request.offset >= 0
        && Number.isSafeInteger(request.length) && request.length > 0 && request.length <= MAX_READ
        && (request.offset === 0 || typeof request.version === 'string')
        && (request.version === undefined || (typeof request.version === 'string' && /^[a-f0-9]{64}$/.test(request.version)))) {
      const r = await folder.read(request.path, request.offset, request.length, request.version || null,signal);
      checkAborted(signal);
      return {ok:true, data:r.data.toString('base64'), size:r.size, modified:r.modified, version:r.version};
    }
    throw new Error('Операция не разрешена');
  }
  async function handle(requestId, packet, signal) {
    validateSignal(signal);checkAborted(signal);
    const now = clock();
    for (const [id, r] of replies) if (r.exp + channel.CLOCK_SKEW < now) replies.delete(id);
    const plain = await channel.open(key, packet, {channel:deviceId, direction:'request', request:requestId}, now);
    checkAborted(signal);
    const envelope = JSON.parse(packet); // после проверки подлинности
    const fingerprint = crypto.createHash('sha256').update(packet).digest('hex');
    const old = replies.get(requestId);
    if (old) {
      if (old.fingerprint !== fingerprint) throw new Error('Номер запроса уже использован');
      return waitFor(old.response,signal);
    }
    if (replies.size >= MAX_REPLIES) throw new Error('Слишком много запросов');
    // Размещаем обещание до первой операции, чтобы повтор параллельного запроса
    // не выполнил действие дважды. Разрешены только чтение, список и явно включённый хеш.
    const response = (async () => {
      let out;
      try {
        const payload = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(plain));
        out = await execute(payload,signal);
      } catch (e) {
        checkAborted(signal);
        if(e && e.name==='AbortError')throw e;
        out = {ok:false, error:'Не удалось открыть файл или папку'};
      }
      checkAborted(signal);
      let data = new TextEncoder().encode(JSON.stringify(out));
      if (data.length > channel.MAX_PLAIN) data = new TextEncoder().encode(JSON.stringify({ok:false,error:'В папке слишком много элементов'}));
      const sealed=await channel.seal(key, deviceId, 'response', requestId, envelope.e, data);
      checkAborted(signal);
      return sealed;
    })();
    replies.set(requestId, { exp:envelope.e, fingerprint, response });
    // Сбой/отмена не превращаются в вечный неудачный ответ. Возможен повтор
    // чтения с тем же идентификатором; для записи это не годится.
    response.catch(()=>{if(replies.get(requestId)?.response===response)replies.delete(requestId);});
    return waitFor(response,signal);
  }
  return Object.freeze({handle});
}
module.exports = { createReadService, MAX_READ };
