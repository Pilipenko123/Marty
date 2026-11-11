/* Неподключённый лабораторный браузерный HTTP для owner-read-transport.
 * Не включать в обычном приложении и не использовать для настоящих файлов:
 * отсутствуют аудит, установка, доверенная привязка и проверки на Windows. */
(function(g) {
  'use strict';
  const ID=/^[a-f0-9]{32}$/, TOKEN=/^[a-f0-9]{48}$/;
  const MAX_RESPONSE=512*1024, MAX_PACKET=360000;
  function abortError(){const e=new Error('Операция остановлена');e.name='AbortError';return e;}
  function validateSignal(s){
    if(s!==undefined && (!s || typeof s.aborted!=='boolean' || typeof s.addEventListener!=='function' || typeof s.removeEventListener!=='function'))throw new Error('Неверный сигнал остановки');
    if(s && s.aborted)throw abortError();
  }
  function createOwnerHttp({deviceId,getToken,prefix='',timeoutMs=15000}={}) {
    if(typeof deviceId!=='string' || !ID.test(deviceId) || typeof getToken!=='function'
      || typeof prefix!=='string' || (prefix!=='' && !/^\/(?:[A-Za-z0-9_-]+)(?:\/[A-Za-z0-9_-]+)*$/.test(prefix))
      || !Number.isInteger(timeoutMs) || timeoutMs<100 || timeoutMs>60000
      || !g.location || g.location.protocol!=='https:' || typeof g.location.origin!=='string'
      || typeof g.fetch!=='function' || typeof g.AbortController!=='function' || typeof g.URL!=='function')throw new Error('Неверные параметры подключения');
    let origin;try{origin=new g.URL(g.location.origin);}catch(_){throw new Error('Неверный адрес сайта');}
    if(origin.protocol!=='https:' || origin.origin!==g.location.origin || origin.username || origin.password)throw new Error('Неверный адрес сайта');
    // Привязка к origin, а не к base href страницы или адресу из пакета.
    const root=origin.origin+prefix+'/api/pc-lab/devices/'+deviceId;
    // Один экземпляр привязан к первой сессии. Выход/смена пользователя должны
    // отменять операции и уничтожать экземпляр; проверка ниже — лишь подстраховка.
    let session=null;
    async function request(action,requestId,packet,signal){
      validateSignal(signal);
      if(typeof requestId!=='string' || !ID.test(requestId))throw new Error('Неверный запрос');
      if(action==='request' && (typeof packet!=='string' || !packet || packet.length>MAX_PACKET))throw new Error('Неверный пакет');
      const token=getToken();
      if(typeof token!=='string' || !TOKEN.test(token))throw new Error('Нет действующей сессии');
      if(session===null)session=token;
      if(token!==session)throw new Error('Сессия изменилась');
      const controller=new g.AbortController();
      let timer,stopped=false;
      let rejectStop;
      const stop=new Promise((_,reject)=>{rejectStop=reject;});
      const stopWith=e=>{if(stopped)return;stopped=true;controller.abort();rejectStop(e);};
      const onAbort=()=>stopWith(abortError());
      if(signal)signal.addEventListener('abort',onAbort,{once:true});
      timer=g.setTimeout(()=>stopWith(new Error('Нет ответа сервера')),timeoutMs);
      if(signal && signal.aborted)onAbort();
      const perform=async()=>{
        if(stopped)throw abortError();
        const isGet=action==='result';
        const url=root+'/'+action+(isGet?'?requestId='+requestId:'');
        const init={method:isGet?'GET':'POST',headers:{Authorization:'Bearer '+token},signal:controller.signal,
          redirect:'error',mode:'same-origin',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer'};
        if(!isGet){init.headers['Content-Type']='application/json';init.body=JSON.stringify(action==='request'?{requestId,packet}:{requestId});}
        const res=await g.fetch(url,init);
        if(stopped)throw abortError();
        if(!res || res.status!==200 || res.redirected || res.type==='opaqueredirect')throw new Error('Сервер не принял запрос');
        if(!res.headers || !/^application\/json(?:\s*;|\s*$)/i.test(res.headers.get('content-type')||''))throw new Error('Неверный ответ сервера');
        const declared=res.headers.get('content-length');
        if(declared && (!/^\d+$/.test(declared) || Number(declared)>MAX_RESPONSE))throw new Error('Ответ слишком большой');
        if(!res.body || typeof res.body.getReader!=='function')throw new Error('Неверный ответ сервера');
        const reader=res.body.getReader(), chunks=[];let size=0,complete=false;
        try {
          while(true){
            const part=await reader.read();if(stopped)throw abortError();
            if(part.done){complete=true;break;}
            if(!(part.value instanceof Uint8Array))throw new Error('Неверный ответ сервера');
            size+=part.value.byteLength;if(size>MAX_RESPONSE)throw new Error('Ответ слишком большой');chunks.push(part.value);
          }
          const bytes=new Uint8Array(size);let pos=0;for(const chunk of chunks){bytes.set(chunk,pos);pos+=chunk.byteLength;}
          let parsed;try{parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch(_){throw new Error('Неверный ответ сервера');}
          if(getToken()!==session)throw new Error('Сессия изменилась');
          return parsed;
        } finally {
          if(!complete)try{Promise.resolve(reader.cancel()).catch(()=>{});}catch(_){}
          try{reader.releaseLock();}catch(_){}
        }
      };
      try{return await Promise.race([perform(),stop]);}
      finally{g.clearTimeout(timer);if(signal)signal.removeEventListener('abort',onAbort);controller.abort();}
    }
    return Object.freeze({
      sendRequest({deviceId:id,requestId,packet,signal}={}){if(id!==deviceId)throw new Error('Неверное устройство');return request('request',requestId,packet,signal);},
      getResult({deviceId:id,requestId,signal}={}){if(id!==deviceId)throw new Error('Неверное устройство');return request('result',requestId,null,signal);},
      acknowledge({deviceId:id,requestId,signal}={}){if(id!==deviceId)throw new Error('Неверное устройство');return request('ack',requestId,null,signal);}
    });
  }
  const exported=Object.freeze({createOwnerHttp,MAX_RESPONSE});
  if(typeof module!=='undefined' && module.exports)module.exports=exported;
  else g.SegaLocalOwnerHttp=exported;
})(typeof globalThis!=='undefined'?globalThis:window);
