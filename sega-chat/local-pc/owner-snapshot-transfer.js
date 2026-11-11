/* Неподключённый эксперимент ручного получения копии в памяти. Никакого
 * скачивания или записи нет. Не использовать для настоящих файлов до аудита,
 * Windows-проверок и подключения настоящего согласия/прав. */
(function(g){
  'use strict';
  const fileCheck=typeof module!=='undefined' && module.exports?require('./owner-file-check'):g.SegaLocalOwnerFileCheck;
  const paths=typeof module!=='undefined' && module.exports?require('./path-rules'):g.SegaLocalPathRules;
  const ID=/^[a-f0-9]{32}$/, HASH=/^[a-f0-9]{64}$/;
  function abortError(){const e=new Error('Операция остановлена');e.name='AbortError';return e;}
  function validate(s){
    if(s!==undefined && (!s || typeof s.aborted!=='boolean' || typeof s.addEventListener!=='function' || typeof s.removeEventListener!=='function'))throw new Error('Неверный сигнал остановки');
    if(s && s.aborted)throw abortError();
  }
  function waitFor(promise,signal){
    if(!signal)return promise;
    return new Promise((resolve,reject)=>{
      let done=false;
      function finish(ok,value){if(done)return;done=true;signal.removeEventListener('abort',stop);if(ok)resolve(value);else reject(value);}
      function stop(){finish(false,abortError());}
      signal.addEventListener('abort',stop,{once:true});
      Promise.resolve(promise).then(x=>finish(true,x),e=>finish(false,e));if(signal.aborted)stop();
    });
  }
  function delay(ms,signal){
    validate(signal);
    return new Promise((resolve,reject)=>{
      let done=false,timer;
      function finish(stopped){if(done)return;done=true;g.clearTimeout(timer);signal.removeEventListener('abort',onAbort);if(stopped)reject(abortError());else resolve();}
      function onAbort(){finish(true);}
      signal.addEventListener('abort',onAbort,{once:true});timer=g.setTimeout(()=>finish(false),ms);if(signal.aborted)onAbort();
    });
  }
  function keys(x){return x && typeof x==='object' && !Array.isArray(x)?Object.keys(x).sort().join(','):'';}
  function createOwnerSnapshotTransfer({transport,timeoutMs=15000,cleanupTimeoutMs=3000,pollMs=250,maxAttempts=3,chunkSize}={}) {
    if(!fileCheck || !paths || !g.AbortController || !transport || !['prepareSnapshotOpen','prepareSnapshotRead','prepareSnapshotClose','submit','receive'].every(x=>typeof transport[x]==='function')
      || !Number.isInteger(timeoutMs) || timeoutMs<100 || timeoutMs>120000 || !Number.isInteger(cleanupTimeoutMs) || cleanupTimeoutMs<100 || cleanupTimeoutMs>30000
      || !Number.isInteger(pollMs) || pollMs<1 || pollMs>2000 || !Number.isInteger(maxAttempts) || maxAttempts<1 || maxAttempts>5
      || (chunkSize!==undefined && (!Number.isInteger(chunkSize) || chunkSize<1 || chunkSize>fileCheck.MAX_CHUNK)))throw new Error('Неверные параметры передачи');
    let busy=false;
    async function invoke(fn,signal){validate(signal);return waitFor(Promise.resolve().then(()=>{validate(signal);return fn();}),signal);}
    async function perform(job,signal){
      let errors=0;
      for(;;){
        try{await invoke(()=>transport.submit(job,signal),signal);break;}
        catch(e){validate(signal);if(e && e.name==='AbortError')throw e;if(++errors>=maxAttempts)throw new Error('Не удалось отправить запрос');await delay(pollMs,signal);}
      }
      errors=0;
      for(;;){
        let response;
        try {response=await invoke(()=>transport.receive(job,signal),signal);}
        catch(e){validate(signal);if(e && e.name==='AbortError')throw e;if(++errors>=maxAttempts)throw new Error('Не удалось получить ответ');await delay(pollMs,signal);continue;}
        validate(signal);errors=0;
        if(response===null){await delay(pollMs,signal);continue;}
        if(!response || response.ok!==true)throw new Error('Не удалось открыть файл');
        return response;
      }
    }
    async function transfer({path,confirmDownload,onProgress=()=>{},signal}={}){
      validate(signal);
      if(typeof path!=='string' || !paths.partsOf(path).length || typeof confirmDownload!=='function' || typeof onProgress!=='function')throw new Error('Неверные параметры передачи');
      if(busy)throw new Error('Передача уже выполняется');busy=true;
      let workController=null,timer=null,externalStop=null,timedOut=false,snapshotId=null,closeJob=null,closed=false,data=null,completed=false;
      function report(received,total,verified){
        const value=onProgress({received,total,verified});
        if(value && typeof value.then==='function'){Promise.resolve(value).catch(()=>{});throw new Error('Неверный обработчик состояния');}
      }
      async function close(signalForClose){
        if(closed || !snapshotId)return;
        if(!closeJob)closeJob=await invoke(()=>transport.prepareSnapshotClose(snapshotId),signalForClose);
        const reply=await perform(closeJob,signalForClose);
        if(keys(reply)!=='ok,snapshotId' || reply.snapshotId!==snapshotId)throw new Error('Копия не закрыта');
        closed=true;
      }
      try {
        const decision=await invoke(()=>confirmDownload(),signal);
        validate(signal);
        if(decision!==true)return null;
        workController=new g.AbortController();
        if(signal){externalStop=()=>workController.abort();signal.addEventListener('abort',externalStop,{once:true});if(signal.aborted)externalStop();}
        timer=g.setTimeout(()=>{timedOut=true;workController.abort();},timeoutMs);
        const work=workController.signal;
        const openJob=await invoke(()=>transport.prepareSnapshotOpen(path),work);
        const info=await perform(openJob,work);
        if(typeof info.snapshotId==='string' && ID.test(info.snapshotId))snapshotId=info.snapshotId;
        if(keys(info)!=='hash,modified,ok,size,snapshotId,version' || !snapshotId || !Number.isSafeInteger(info.size) || info.size<0 || info.size>fileCheck.MAX_FILE
          || typeof info.hash!=='string' || !HASH.test(info.hash) || typeof info.version!=='string' || !HASH.test(info.version)
          || typeof info.modified!=='string' || !info.modified || info.modified.length>100)throw new Error('Неверный ответ файла');
        report(0,info.size,false);validate(work);
        const result=await fileCheck.checkOwnerFile({allowed:true,size:info.size,expectedHash:info.hash,expectedVersion:info.version,expectedModified:info.modified,signal:work,chunkSize,
          async read({offset,length,version,signal:readSignal}){
            const job=await invoke(()=>transport.prepareSnapshotRead(snapshotId,offset,length,version),readSignal);
            const part=await perform(job,readSignal);
            if(keys(part)!=='data,modified,ok,size,snapshotId,version' || part.snapshotId!==snapshotId)throw new Error('Неверный ответ файла');
            const {data,size,modified,version:v}=part;
            // Саму часть и её длину/версию повторно проверяет checkOwnerFile.
            if(!(data instanceof Uint8Array) || size!==info.size || v!==info.version || modified!==info.modified
              || data.byteLength!==Math.min(length,Math.max(0,info.size-offset)))throw new Error('Неверный ответ файла');
            report(offset+data.byteLength,info.size,false);validate(readSignal);
            return {ok:true,data,size,modified,version:v};
          }
        });
        data=result.data;validate(work);await close(work);validate(work);
        report(info.size,info.size,true);validate(work);
        completed=true;return {data,size:info.size,version:info.version,modified:info.modified};
      } catch(error){
        if(data)data.fill(0);
        if(snapshotId && !closed){
          const cleanup=new g.AbortController(), cleanupTimer=g.setTimeout(()=>cleanup.abort(),cleanupTimeoutMs);
          try{await close(cleanup.signal);}catch(_){throw new Error('Не удалось закрыть временную копию');}finally{g.clearTimeout(cleanupTimer);}
        }
        if(timedOut && !(signal && signal.aborted))throw new Error('Время ожидания истекло');
        throw error;
      } finally {
        if(!completed && data)data.fill(0);
        if(timer!==null)g.clearTimeout(timer);
        if(signal && externalStop)signal.removeEventListener('abort',externalStop);
        busy=false;
      }
    }
    return Object.freeze({transfer});
  }
  const exported=Object.freeze({createOwnerSnapshotTransfer});
  if(typeof module!=='undefined' && module.exports)module.exports=exported;
  else g.SegaLocalOwnerSnapshotTransfer=exported;
})(typeof globalThis!=='undefined'?globalThis:window);
