/* Лабораторное управление запросом чтения. Само не отправляет HTTP, не пишет
 * файлы и не запускается в мессенджере. Переданные обработчики и их защита
 * целиком зависят от вызывающего кода. Не применять к реальным файлам. */
(function(g) {
  'use strict';
  const readerModule=typeof module!=='undefined' && module.exports ? require('./owner-read-client') : g.SegaLocalOwnerRead;
  const channel=typeof module!=='undefined' && module.exports ? require('./secure-channel') : g.SegaLocalSecureChannel;
  function keys(x){return x && typeof x==='object' && !Array.isArray(x)?Object.keys(x).sort().join(','):'';}
  function checkSignal(s){
    if(s!==undefined && (!s || typeof s.aborted!=='boolean' || typeof s.addEventListener!=='function' || typeof s.removeEventListener!=='function'))throw new Error('Неверный сигнал остановки');
    if(s && s.aborted){const e=new Error('Операция остановлена');e.name='AbortError';throw e;}
  }
  function copy(result) {
    if(!result.ok)return {ok:false,error:result.error};
    if(Array.isArray(result.items))return {ok:true,items:result.items.map(x=>({...x}))};
    return {ok:true,data:new Uint8Array(result.data),size:result.size,modified:result.modified,version:result.version};
  }
  function createOwnerReadTransport({secret,deviceId,clock=Date.now,sendRequest,getResult,acknowledge}={}) {
    if(!readerModule || !channel || typeof sendRequest!=='function' || typeof getResult!=='function' || typeof acknowledge!=='function')throw new Error('Не заданы действия подключения');
    const reader=readerModule.createOwnerReadClient({secret,deviceId,clock}), jobs=new WeakMap();
    async function prepare(jobPromise){const job=await jobPromise;jobs.set(job,{phase:'prepared',busy:false,result:null});return job;}
    async function prepareList(path=''){return prepare(reader.list(path));}
    async function prepareRead(path,offset=0,length=readerModule.MAX_READ,version=null){return prepare(reader.read(path,offset,length,version));}
    function checkTime(job){
      const now=clock();
      if(!Number.isSafeInteger(now) || now<1 || job.expires<now-channel.CLOCK_SKEW || job.expires>now+channel.MAX_FUTURE)throw new Error('Срок запроса истёк');
    }
    async function locked(job,signal,fn){
      checkSignal(signal);const state=job && jobs.get(job);
      if(!state)throw new Error('Неизвестный запрос');
      if(state.busy)throw new Error('Запрос уже обрабатывается');
      checkTime(job);state.busy=true;
      try{return await fn(state);}finally{state.busy=false;}
    }
    async function call(fn,args,signal){
      checkSignal(signal);
      try {const result=await fn({...args,signal});checkSignal(signal);return result;}
      catch(e){checkSignal(signal);if(e && e.name==='AbortError')throw e;throw new Error('Не удалось связаться с компьютером');}
    }
    async function submit(job,signal){return locked(job,signal,async state=>{
      if(state.phase!=='prepared')return;
      const result=await call(sendRequest,{deviceId,requestId:job.requestId,packet:job.packet},signal);
      checkTime(job);
      if(keys(result)!=='ok' || result.ok!==true)throw new Error('Запрос не подтверждён');
      state.phase='submitted';
    });}
    async function receive(job,signal){return locked(job,signal,async state=>{
      if(state.phase==='prepared')throw new Error('Запрос ещё не отправлен');
      if(state.phase==='done')return copy(state.result);
      if(state.phase==='submitted') {
        const response=await call(getResult,{deviceId,requestId:job.requestId},signal);
        checkTime(job);
        if(keys(response)==='ready' && response.ready===false)return null;
        if(keys(response)!=='packet,ready' || response.ready!==true || typeof response.packet!=='string')throw new Error('Неверный ответ сервера');
        const checked=await reader.accept(job,response.packet);
        checkSignal(signal);checkTime(job);
        state.result=copy(checked);state.phase='verified';
      }
      // На ошибке/отмене проверенный результат остаётся в памяти, чтобы можно
      // было повторить подтверждение без повторного чтения файла.
      const confirmation=await call(acknowledge,{deviceId,requestId:job.requestId},signal);
      checkTime(job);
      if(keys(confirmation)!=='ok' || confirmation.ok!==true)throw new Error('Ответ не подтверждён');
      state.phase='done';return copy(state.result);
    });}
    return Object.freeze({prepareList,prepareRead,submit,receive});
  }
  const exported=Object.freeze({createOwnerReadTransport});
  if(typeof module!=='undefined' && module.exports)module.exports=exported;
  else g.SegaLocalOwnerTransport=exported;
})(typeof globalThis!=='undefined'?globalThis:window);
