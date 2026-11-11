/* Экспериментальный браузерный разбор ЗАШИФРОВАННОГО чтения. Не отправляет
 * запросы, не подтверждает результат, не сохраняет файлы и не подключён к UI.
 * Не использовать для реальных папок до аудита и проверки на Windows. */
(function(g) {
  'use strict';
  const crypto=g.crypto && g.crypto.subtle ? g.crypto : (typeof require==='function' ? require('node:crypto').webcrypto : null);
  const channel=typeof module!=='undefined' && module.exports ? require('./secure-channel') : g.SegaLocalSecureChannel;
  const paths=typeof module!=='undefined' && module.exports ? require('./path-rules') : g.SegaLocalPathRules;
  const MAX_READ=128*1024, MAX_ITEMS=5000, LIFETIME=60000;
  const HASH=/^[a-f0-9]{64}$/, ID=/^[a-f0-9]{32}$/;
  const encode=new TextEncoder(), decode=new TextDecoder('utf-8',{fatal:true});
  function keys(value) {return value && typeof value==='object' && !Array.isArray(value) ? Object.keys(value).sort().join(',') : '';}
  function bytesFromBase64(s) {
    if(typeof s!=='string' || s.length>Math.ceil(MAX_READ/3)*4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s)) throw new Error('Неверный ответ файла');
    let raw;try{raw=g.atob(s);}catch(_){throw new Error('Неверный ответ файла');}
    if(g.btoa(raw)!==s)throw new Error('Неверный ответ файла');
    return Uint8Array.from(raw,ch=>ch.charCodeAt(0));
  }
  function createOwnerReadClient({secret,deviceId,clock=Date.now}={}) {
    if(!crypto || !channel || !paths || !(secret instanceof Uint8Array) || secret.length!==32 || typeof deviceId!=='string' || !ID.test(deviceId) || typeof clock!=='function') throw new Error('Неверные данные подключения');
    const key=new Uint8Array(secret), jobs=new WeakMap();
    function time() {const now=clock();if(!Number.isSafeInteger(now) || now<1 || now>Number.MAX_SAFE_INTEGER-LIFETIME)throw new Error('Неверное время');return now;}
    async function make(spec) {
      const requestId=[...crypto.getRandomValues(new Uint8Array(16))].map(n=>n.toString(16).padStart(2,'0')).join('');
      const expires=time()+LIFETIME;
      const packet=await channel.seal(key,deviceId,'request',requestId,expires,encode.encode(JSON.stringify(spec)));
      const job=Object.freeze({requestId,packet,expires});jobs.set(job,{spec,accepted:null});return job;
    }
    async function list(path='') {paths.partsOf(path);return make({op:'list',path});}
    async function read(path,offset=0,length=MAX_READ,version=null) {
      if(!paths.partsOf(path).length || !Number.isSafeInteger(offset) || offset<0 || !Number.isSafeInteger(length) || length<1 || length>MAX_READ
        || (version!==null && (typeof version!=='string' || !HASH.test(version))) || (offset>0 && version===null)) throw new Error('Неверный запрос файла');
      const request={op:'read',path,offset,length};if(version!==null)request.version=version;return make(request);
    }
    async function accept(job,packet) {
      const record=job && jobs.get(job);
      if(!record)throw new Error('Неизвестный запрос');
      if(record.accepted!==null && record.accepted!==packet)throw new Error('Ответ уже проверен');
      const raw=await channel.open(key,packet,{channel:deviceId,direction:'response',request:job.requestId,expires:job.expires},time());
      let response;try{response=JSON.parse(decode.decode(raw));}catch(_){throw new Error('Неверный ответ');}
      let result;
      if(keys(response)==='error,ok' && response.ok===false && typeof response.error==='string') {
        // Не переносим произвольную ошибку удалённого источника в интерфейс.
        result={ok:false,error:'Не удалось открыть файл или папку'};
      } else if(record.spec.op==='list') {
        if(keys(response)!=='items,ok' || response.ok!==true || !Array.isArray(response.items) || response.items.length>MAX_ITEMS)throw new Error('Неверный ответ папки');
        const names=new Set(), items=[];
        for(const x of response.items) {
          if(keys(x)!=='dir,modified,name,size' || typeof x.name!=='string' || paths.partsOf(x.name).length!==1 || typeof x.dir!=='boolean'
            || !Number.isSafeInteger(x.size) || x.size<0 || (x.dir && x.size!==0) || typeof x.modified!=='string' || !x.modified || x.modified.length>100)throw new Error('Неверный ответ папки');
          paths.partsOf(record.spec.path ? record.spec.path+'/'+x.name : x.name);
          const folded=x.name.normalize('NFC').toLowerCase();if(names.has(folded))throw new Error('Неверный ответ папки');names.add(folded);
          items.push({name:x.name,dir:x.dir,size:x.size,modified:x.modified});
        }
        result={ok:true,items};
      } else {
        const q=record.spec;
        if(keys(response)!=='data,modified,ok,size,version' || response.ok!==true || !Number.isSafeInteger(response.size) || response.size<0
           || typeof response.version!=='string' || !HASH.test(response.version) || (q.version && q.version!==response.version)
           || typeof response.modified!=='string' || !response.modified || response.modified.length>100)throw new Error('Неверный ответ файла');
        const data=bytesFromBase64(response.data);
        if(data.length!==Math.min(q.length,Math.max(0,response.size-q.offset)))throw new Error('Неверный ответ файла');
        result={ok:true,data,size:response.size,modified:response.modified,version:response.version};
      }
      // Параллельные ответы с одним номером не могут подменять проверенный.
      if(record.accepted!==null && record.accepted!==packet)throw new Error('Ответ уже проверен');
      record.accepted=packet;
      return result;
    }
    return Object.freeze({list,read,accept});
  }
  const exported=Object.freeze({createOwnerReadClient,MAX_READ,MAX_ITEMS,LIFETIME});
  if(typeof module!=='undefined' && module.exports)module.exports=exported;
  else g.SegaLocalOwnerRead=exported;
})(typeof globalThis!=='undefined'?globalThis:window);
