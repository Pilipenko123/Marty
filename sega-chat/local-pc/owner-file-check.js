/* Неподключённый лабораторный сбор файла в памяти браузера. Ничего не скачивает,
 * не пишет на диск и не доказывает, что ожидаемый хеш получен из доверенного
 * источника. Не использовать для настоящих файлов до завершения защиты. */
(function(g){
  'use strict';
  const crypto=g.crypto && g.crypto.subtle ? g.crypto : (typeof require==='function' ? require('node:crypto').webcrypto : null);
  const MAX_FILE=8*1024*1024, MAX_CHUNK=128*1024, HASH=/^[a-f0-9]{64}$/;
  function abortError(){const e=new Error('Операция остановлена');e.name='AbortError';return e;}
  function validateSignal(s){
    if(s!==undefined && (!s || typeof s.aborted!=='boolean' || typeof s.addEventListener!=='function' || typeof s.removeEventListener!=='function'))throw new Error('Неверный сигнал остановки');
    if(s && s.aborted)throw abortError();
  }
  function waitFor(promise,signal){
    if(!signal)return promise;
    return new Promise((resolve,reject)=>{
      let finished=false;
      function finish(ok,value){if(finished)return;finished=true;signal.removeEventListener('abort',stop);if(ok)resolve(value);else reject(value);}
      function stop(){finish(false,abortError());}
      signal.addEventListener('abort',stop,{once:true});
      Promise.resolve(promise).then(v=>finish(true,v),e=>finish(false,e));
      if(signal.aborted)stop();
    });
  }
  function keys(value){return value && typeof value==='object' && !Array.isArray(value)?Object.keys(value).sort().join(','):'';}
  /** read({offset,length,version,signal}) должен предоставлять проверенную часть
   * из owner-read-transport. expectedHash и size должны приходить независимо из
   * доверенного источника, который ещё не создан. allowed обязан означать
   * разрешение для этой операции, а не просто доступность файла. */
  async function checkOwnerFile({allowed,size,expectedHash,expectedVersion=null,expectedModified=null,read,signal,chunkSize=MAX_CHUNK}={}){
    if(allowed!==true)throw new Error('Передача не разрешена');
    if(!crypto || !Number.isSafeInteger(size) || size<0 || size>MAX_FILE || typeof expectedHash!=='string' || !HASH.test(expectedHash)
      || (expectedVersion!==null && (typeof expectedVersion!=='string' || !HASH.test(expectedVersion)))
      || (expectedModified!==null && (typeof expectedModified!=='string' || !expectedModified || expectedModified.length>100))
      || typeof read!=='function' || !Number.isSafeInteger(chunkSize) || chunkSize<1 || chunkSize>MAX_CHUNK)throw new Error('Неверные данные файла');
    validateSignal(signal);
    const result=new Uint8Array(size);let offset=0,version=expectedVersion,modified=expectedModified;
    try {
      do {
        validateSignal(signal);
        const length=size===0?1:Math.min(chunkSize,size-offset);
        const part=await waitFor(Promise.resolve().then(()=>{validateSignal(signal);return read({offset,length,version,signal});}),signal);
        validateSignal(signal);
        if(keys(part)!=='data,modified,ok,size,version')throw new Error('Файл изменился или передан не полностью');
        const {ok,data,size:partSize,version:partVersion,modified:partModified}=part;
        if(ok!==true || !(data instanceof Uint8Array) || partSize!==size || typeof partVersion!=='string' || !HASH.test(partVersion)
          || (version!==null && version!==partVersion) || typeof partModified!=='string' || !partModified || partModified.length>100
          || (modified!==null && modified!==partModified) || data.byteLength!==Math.min(length,size-offset))throw new Error('Файл изменился или передан не полностью');
        if(version===null)version=partVersion;if(modified===null)modified=partModified;
        result.set(data,offset);offset+=data.byteLength;
      } while(offset<size);
      validateSignal(signal);
      const hashed=await waitFor(crypto.subtle.digest('SHA-256',result),signal);
      validateSignal(signal);
      const hash=Array.from(new Uint8Array(hashed),n=>n.toString(16).padStart(2,'0')).join('');
      if(hash!==expectedHash)throw new Error('Содержимое файла не совпадает');
      // Возвращается только память, а не опубликованный или сохранённый файл.
      return {data:result,size,version,modified};
    } catch(e){result.fill(0);throw e;}
  }
  const exported=Object.freeze({checkOwnerFile,MAX_FILE,MAX_CHUNK});
  if(typeof module!=='undefined' && module.exports)module.exports=exported;
  else g.SegaLocalOwnerFileCheck=exported;
})(typeof globalThis!=='undefined'?globalThis:window);
