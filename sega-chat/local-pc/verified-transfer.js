'use strict';

// Лабораторная передача в предоставленную изолированную временную область.
// Модуль не открывает файлы, не подключён к сети и НЕ публикует результат.
// Безопасность временной области и разрешения устанавливает вызывающий код.
const crypto = require('node:crypto');
const {validateSignal,checkAborted} = require('./abort');
// Одноразовое использование только в рамках этого экземпляра модуля и только
// по идентичности объекта, не блокировка реального файла или другого процесса.
const usedStages = new WeakSet();
const MAX_CHUNK = 128 * 1024;
const HASH = /^[a-f0-9]{64}$/;

/**
 * read(offset,length,version,signal) => {data: Buffer, size, version}
 * stage.write(bytes,signal), stage.verify(signal) => {size,hash}, stage.abort()
 * stage ОБЯЗАНА быть изолированной временной областью, а не оригинальным
 * файлом. verify обязан повторно проверить реально записанные байты. Здесь
 * нет атомарного перемещения, корзины или восстановления после сбоя питания.
 * После успешного возврата область остаётся временной: публикация требует
 * повторной проверки и отдельного безопасного протокола на обоих ПК. Каждый
 * объект stage одноразовый; новая попытка требует новой изолированной области.
 * Это не предотвращает общую область за разными объектами или процессами.
 */
async function transferToStage({allowed, size, hash, read, stage, signal, chunkSize=MAX_CHUNK} = {}) {
  if (allowed !== true) throw new Error('Передача не разрешена');
  if (!Number.isSafeInteger(size) || size<0 || typeof hash!=='string' || !HASH.test(hash)
      || typeof read!=='function' || !stage || !['object','function'].includes(typeof stage) || typeof stage.write!=='function'
      || typeof stage.verify!=='function' || typeof stage.abort!=='function'
      || !Number.isSafeInteger(chunkSize) || chunkSize<1 || chunkSize>MAX_CHUNK) throw new Error('Неверные данные передачи');
  validateSignal(signal);
  // Вторая попытка не должна писать или очищать область первой — в том числе
  // пока первая ожидает очистки либо уже вернула проверенную временную копию.
  if(usedStages.has(stage))throw new Error('Временная область уже использована');
  usedStages.add(stage);
  let offset=0, version=null;
  const digest=crypto.createHash('sha256');
  try {
    checkAborted(signal);
    // Даже пустой файл проверяется у источника и получает метку версии.
    do {
      const length=size===0 ? 1 : Math.min(chunkSize,size-offset);
      const part=await read(offset,length,version,signal);
      checkAborted(signal);
      if (!part || !Buffer.isBuffer(part.data) || part.size!==size || typeof part.version!=='string' || !HASH.test(part.version)
          || (version!==null && part.version!==version) || part.data.length!==Math.min(length,size-offset)) throw new Error('Файл изменился или передан не полностью');
      if (version===null) version=part.version;
      const bytes=Buffer.from(part.data); // не зависим от последующей правки буфера источником
      digest.update(bytes);
      if (bytes.length) await stage.write(bytes,signal);
      checkAborted(signal);
      offset+=bytes.length;
    } while(offset<size);
    if (digest.digest('hex')!==hash) throw new Error('Содержимое файла не совпадает');
    const actual=await stage.verify(signal);
    checkAborted(signal);
    if (!actual || actual.size!==size || actual.hash!==hash) throw new Error('Временная копия не прошла проверку');
    return Object.freeze({size,hash,version});
  } catch (error) {
    // Ошибка очистки не должна скрываться: область может содержать обрывок.
    try { await stage.abort(); }
    catch (cleanupError) { throw new AggregateError([error,cleanupError],'Не удалось очистить временную копию'); }
    throw error;
  }
}
module.exports={transferToStage,MAX_CHUNK};
