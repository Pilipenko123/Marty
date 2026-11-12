/* Только неподключённый лабораторный клиент заявок. Относительные маршруты
 * того же HTTPS-сайта, роль и права проверяются только сервером. Нельзя
 * использовать с настоящими файлами или считать это рабочим уведомлением. */
(function(g){
  'use strict';
  const TOKEN=/^[a-f0-9]{48}$/,ID=/^[a-f0-9]{32}$/,MAX_RESPONSE=512*1024;
  function abortError(){const e=new Error('Операция остановлена');e.name='AbortError';return e;}
  function signalOk(s){
    if(s!==undefined && (!s || typeof s.aborted!=='boolean' || typeof s.addEventListener!=='function' || typeof s.removeEventListener!=='function'))throw new Error('Неверный сигнал');
    if(s && s.aborted)throw abortError();
  }
  function createAccessHttp({getToken,prefix='',timeoutMs=15000}={}){
    if(typeof getToken!=='function' || typeof prefix!=='string' || (prefix!=='' && !/^\/(?:[A-Za-z0-9_-]+)(?:\/[A-Za-z0-9_-]+)*$/.test(prefix))
      || !Number.isInteger(timeoutMs) || timeoutMs<100 || timeoutMs>60000 || !g.location || g.location.protocol!=='https:'
      || typeof g.location.origin!=='string' || typeof g.fetch!=='function' || typeof g.AbortController!=='function' || typeof g.URL!=='function')throw new Error('Неверные параметры подключения');
    let origin;try{origin=new g.URL(g.location.origin);}catch(_){throw new Error('Неверный адрес сайта');}
    if(origin.protocol!=='https:' || origin.origin!==g.location.origin || origin.username || origin.password)throw new Error('Неверный адрес сайта');
    const base=origin.origin+prefix+'/api/pc-lab/access';let session=null;
    async function request(path,method,body,signal){
      signalOk(signal);
      const token=getToken();if(typeof token!=='string' || !TOKEN.test(token))throw new Error('Нет действующей сессии');
      if(session===null)session=token;if(token!==session)throw new Error('Сессия изменилась');
      const controller=new g.AbortController();let timer,stopped=false,rejectStop;
      const stop=new Promise((_,reject)=>{rejectStop=reject;});
      function stopWith(e){if(stopped)return;stopped=true;controller.abort();rejectStop(e);}
      const onAbort=()=>stopWith(abortError());
      if(signal)signal.addEventListener('abort',onAbort,{once:true});
      timer=g.setTimeout(()=>stopWith(new Error('Нет ответа сервера')),timeoutMs);
      if(signal && signal.aborted)onAbort();
      async function perform(){
        if(stopped)throw abortError();
        const init={method,headers:{Authorization:'Bearer '+token},signal:controller.signal,redirect:'error',mode:'same-origin',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer'};
        if(method==='POST'){init.headers['Content-Type']='application/json';init.body=JSON.stringify(body);}
        const res=await g.fetch(base+path,init);if(stopped)throw abortError();
        if(!res || res.redirected || res.type==='opaqueredirect')throw new Error('Сервер не подтвердил запрос');
        if(res.status===401 || res.status===403){
          const e=new Error('Сервер отклонил доступ');e.code='ACCESS_DENIED';throw e;
        }
        if(res.status!==200)throw new Error('Сервер не подтвердил запрос');
        if(!res.headers || !/^application\/json(?:\s*;|\s*$)/i.test(res.headers.get('content-type')||''))throw new Error('Неверный ответ сервера');
        const declared=res.headers.get('content-length');
        if(declared && (!/^\d+$/.test(declared) || Number(declared)>MAX_RESPONSE))throw new Error('Ответ слишком большой');
        if(!res.body || typeof res.body.getReader!=='function')throw new Error('Неверный ответ сервера');
        const reader=res.body.getReader(),chunks=[];let size=0,complete=false;
        try{
          while(true){
            const part=await reader.read();if(stopped)throw abortError();if(part.done){complete=true;break;}
            if(!(part.value instanceof Uint8Array))throw new Error('Неверный ответ сервера');
            size+=part.value.byteLength;if(size>MAX_RESPONSE)throw new Error('Ответ слишком большой');chunks.push(part.value);
          }
          const bytes=new Uint8Array(size);let i=0;for(const chunk of chunks){bytes.set(chunk,i);i+=chunk.byteLength;}
          let result;try{result=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch(_){throw new Error('Неверный ответ сервера');}
          if(getToken()!==session)throw new Error('Сессия изменилась');
          if(!result || typeof result!=='object' || Array.isArray(result))throw new Error('Неверный ответ сервера');
          return result;
        }finally{
          if(!complete)try{Promise.resolve(reader.cancel()).catch(()=>{});}catch(_){}
          try{reader.releaseLock();}catch(_){}
        }
      }
      try{return await Promise.race([perform(),stop]);}
      finally{g.clearTimeout(timer);if(signal)signal.removeEventListener('abort',onAbort);controller.abort();}
    }
    return Object.freeze({
      async getStatus(signal){const result=await request('','GET',null,signal);if(!['none','pending','approved','denied','revoked'].includes(result.state))throw new Error('Неверный ответ сервера');return {state:result.state};},
      async requestAccess(signal){const result=await request('/request','POST',{},signal);if(!['pending','approved'].includes(result.state))throw new Error('Неверный ответ сервера');return {state:result.state};},
      async listRequests(signal){const result=await request('/admin','GET',null,signal);if(!Array.isArray(result.requests) || !Array.isArray(result.approved) || result.requests.length+result.approved.length>5000)throw new Error('Неверный ответ сервера');return result;},
      async decide(input,signal){
        if(!input || typeof input!=='object' || typeof input.userId!=='string' || !input.userId || input.userId.length>200 || /[\x00-\x1f\x7f-\x9f]/.test(input.userId)
          || typeof input.requestId!=='string' || !ID.test(input.requestId) || !['approve','deny'].includes(input.decision))throw new Error('Неверное решение');
        const body={userId:input.userId,requestId:input.requestId,decision:input.decision};
        const result=await request('/decision','POST',body,signal);
        if(result.state!==(body.decision==='approve'?'approved':'denied'))throw new Error('Неверный ответ сервера');return {state:result.state};
      }
    });
  }
  const exported=Object.freeze({createAccessHttp,MAX_RESPONSE});
  if(typeof module!=='undefined' && module.exports)module.exports=exported;else g.SegaLocalAccessHttp=exported;
})(typeof globalThis!=='undefined'?globalThis:window);
