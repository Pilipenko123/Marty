/* Неподключённый запрос списка для лабораторного окна; не подтверждает полноту
 * папки и не должен использоваться для удаления или синхронизации. */
(function(g){
  'use strict';
  const paths=typeof module!=='undefined' && module.exports?require('./path-rules'):g.SegaLocalPathRules;
  function abortError(){const e=new Error('Операция остановлена');e.name='AbortError';return e;}
  function validate(s){if(s!==undefined && (!s || typeof s.aborted!=='boolean' || typeof s.addEventListener!=='function' || typeof s.removeEventListener!=='function'))throw new Error('Неверный сигнал');if(s && s.aborted)throw abortError();}
  function waitFor(promise,signal){return new Promise((resolve,reject)=>{
    let done=false;function finish(ok,v){if(done)return;done=true;signal.removeEventListener('abort',stop);if(ok)resolve(v);else reject(v);}
    function stop(){finish(false,abortError());}signal.addEventListener('abort',stop,{once:true});Promise.resolve(promise).then(v=>finish(true,v),e=>finish(false,e));if(signal.aborted)stop();
  });}
  function delay(ms,signal){validate(signal);return new Promise((resolve,reject)=>{
    let done=false,timer;function finish(aborted){if(done)return;done=true;g.clearTimeout(timer);signal.removeEventListener('abort',stop);if(aborted)reject(abortError());else resolve();}
    function stop(){finish(true);}signal.addEventListener('abort',stop,{once:true});timer=g.setTimeout(()=>finish(false),ms);if(signal.aborted)stop();
  });}
  function createOwnerListRequest({transport,timeoutMs=10000,pollMs=250,maxAttempts=3}={}){
    if(!paths || !g.AbortController || !transport || !['prepareList','submit','receive'].every(x=>typeof transport[x]==='function')
      || !Number.isInteger(timeoutMs) || timeoutMs<100 || timeoutMs>120000 || !Number.isInteger(pollMs) || pollMs<1 || pollMs>2000
      || !Number.isInteger(maxAttempts) || maxAttempts<1 || maxAttempts>5)throw new Error('Неверные параметры');
    let busy=false;
    async function list(path='',signal){
      validate(signal);paths.partsOf(path);if(busy)throw new Error('Запрос уже выполняется');busy=true;
      const controller=new g.AbortController(),local=controller.signal;let timedOut=false;
      const onAbort=()=>controller.abort();if(signal){signal.addEventListener('abort',onAbort,{once:true});if(signal.aborted)onAbort();}
      const timer=g.setTimeout(()=>{timedOut=true;controller.abort();},timeoutMs);
      async function invoke(fn){validate(local);return waitFor(Promise.resolve().then(()=>{validate(local);return fn();}),local);}
      try {
        const job=await invoke(()=>transport.prepareList(path));let errors=0;
        for(;;){try{await invoke(()=>transport.submit(job,local));break;}catch(e){validate(local);if(e && e.name==='AbortError')throw e;if(++errors>=maxAttempts)throw new Error('Не удалось отправить запрос');await delay(pollMs,local);}}
        errors=0;
        for(;;){
          let response;try{response=await invoke(()=>transport.receive(job,local));}catch(e){validate(local);if(e && e.name==='AbortError')throw e;if(++errors>=maxAttempts)throw new Error('Не удалось получить ответ');await delay(pollMs,local);continue;}
          validate(local);errors=0;if(response===null){await delay(pollMs,local);continue;}
          if(!response || response.ok!==true || !Array.isArray(response.items) || response.items.length>5000)throw new Error('Не удалось открыть папку');
          return response.items.map(x=>({...x}));
        }
      }catch(e){if(timedOut && !(signal && signal.aborted))throw new Error('Время ожидания истекло');throw e;}
      finally{g.clearTimeout(timer);if(signal)signal.removeEventListener('abort',onAbort);busy=false;}
    }
    return Object.freeze({list});
  }
  const exported=Object.freeze({createOwnerListRequest});
  if(typeof module!=='undefined' && module.exports)module.exports=exported;else g.SegaLocalOwnerListRequest=exported;
})(typeof globalThis!=='undefined'?globalThis:window);
