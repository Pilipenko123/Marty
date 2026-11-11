'use strict';
// Экспериментальный мост к windows-safe-folder.ps1/.cs; не включён в помощник.
// Реальное поведение системных дескрипторов ещё НЕ проверено на Windows 10.
const path=require('node:path');
const {spawn}=require('node:child_process');
const crypto=require('node:crypto');
const {performance}=require('node:perf_hooks');
const {partsOf,MAX_ENTRIES}=require('./folder');
const {abortError,validateSignal,checkAborted}=require('./abort');
const MAX_READ=128*1024, MAX_RESPONSE=512*1024, MAX_HASH_FILE=8*1024*1024, MAX_SNAPSHOT_RESPONSE=12*1024*1024;
function createWindowsFolderProvider({platform=process.platform,spawnProcess=spawn,timeoutMs=30000,enableLockedHash=false,enableLockedSnapshot=false,snapshotTtlMs=30000}={}) {
  if(typeof spawnProcess!=='function' || !Number.isInteger(timeoutMs) || timeoutMs<100 || timeoutMs>60000
    || typeof enableLockedHash!=='boolean' || typeof enableLockedSnapshot!=='boolean' || !Number.isInteger(snapshotTtlMs) || snapshotTtlMs<100 || snapshotTtlMs>60000)throw new Error('Неверные параметры');
  if(platform!=='win32') throw new Error('Доступно только на Windows');
  function rootPath(root) {
    if(typeof root!=='string' || root.length>4096 || !/^[a-zA-Z]:\\/.test(root) || root.includes('/')) throw new Error('Выберите локальную папку');
    const r=root.replace(/\\+$/,'');
    if(!/^[a-zA-Z]:\\.+/.test(r)) throw new Error('Выберите папку, не весь диск');
    // Не нормализуем «..», «.» или пустые части в другой путь: такая папка
    // может отличаться от выбранной человеком. Это предварительный фильтр,
    // а не проверка настоящих дескрипторов или защиты от подмены.
    const parts=r.slice(3).split('\\');
    if(!parts.length || partsOf(parts.join('/')).length!==parts.length)throw new Error('Неверная папка');
    return r;
  }
  function identity(id) {
    if(!id || typeof id.dev!=='string' || !/^\d+$/.test(id.dev) || typeof id.ino!=='string' || !/^[1-9]\d*$/.test(id.ino))throw new Error('Не удалось проверить папку');
    return {dev:id.dev,ino:id.ino};
  }
  let snapshotBusy=false; // не больше одной копии или её создания на экземпляр
  function call(body,signal,maxResponse=MAX_RESPONSE) {
    validateSignal(signal);checkAborted(signal);
    return new Promise((resolve,reject)=>{
      let child,done=false,size=0,chunks=[],timer;
      const onAbort=()=>{finish('aborted');try{child.kill()}catch(_){}};
      const finish=(err,result)=>{if(done)return;done=true;chunks=[];clearTimeout(timer);if(signal)signal.removeEventListener('abort',onAbort);if(err)reject(err==='aborted'?abortError():new Error('Не удалось безопасно открыть папку или файл'));else resolve(result);};
      try { child=spawnProcess('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'windows-safe-folder.ps1')],{stdio:['pipe','pipe','pipe'],windowsHide:true}); }
      catch (_) { finish(true);return; }
      timer=setTimeout(()=>{finish(true);try{child.kill()}catch(_){}},timeoutMs);
      child.on('error',()=>finish(true));
      child.stdout.on('data',b=>{if(done)return;size+=b.length;if(size>maxResponse){try{child.kill()}catch(_){}finish(true);return;}chunks.push(Buffer.from(b));});
      child.stderr.on('data',()=>{});child.stdin.on('error',()=>finish(true));
      child.on('close',code=>{
        if(code!==0)return finish(true);
        try {const response=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!response || response.ok!==true || !response.result)return finish(true);finish(null,response.result);}catch(_){finish(true)}
      });
      if(signal) {
        signal.addEventListener('abort',onAbort,{once:true});
        if(signal.aborted){onAbort();return;}
      }
      child.stdin.end(JSON.stringify(body));
    });
  }
  async function anchor(input,signal) {
    const root=rootPath(input), out=await call({op:'identity',root},signal);
    if(typeof out.root!=='string' || rootPath(out.root).toLowerCase()!==root.toLowerCase())throw new Error('Папка изменилась');
    return {root:rootPath(out.root),...identity(out)};
  }
  async function folder(input,id) {
    const root=rootPath(input), saved=identity(id);
    async function listInternal(relative,op,signal) {
      partsOf(relative);
      const out=await call({op,root,...saved,path:relative},signal);
      if(!Array.isArray(out.items) || out.items.length>MAX_ENTRIES)throw new Error('Не удалось прочитать папку');
      const names=new Set();
      const items=out.items.map(x=>{
        if(!x || Object.keys(x).sort().join(',')!=='dir,modified,name,size' || typeof x.name!=='string' || partsOf(x.name).length!==1 || typeof x.dir!=='boolean'
           || !Number.isSafeInteger(x.size) || x.size<0 || (x.dir && x.size!==0)
           || typeof x.modified!=='string' || !x.modified || x.modified.length>100)throw new Error('Неверный ответ');
        partsOf(relative ? relative+'/'+x.name : x.name);
        const folded=x.name.normalize('NFC').toLowerCase();
        if(names.has(folded))throw new Error('Имена совпадают');names.add(folded);
        return {name:x.name,dir:x.dir,size:x.size,modified:x.modified};
      });
      return items.sort((a,b)=>Number(b.dir)-Number(a.dir)||a.name.localeCompare(b.name,'ru'));
    }
    async function list(relative='',signal) { return listInternal(relative,'list',signal); }
    // Этот отказ при известных пропусках НЕ гарантирует полный или атомарный
    // снимок: папка может измениться во время перечисления или после него.
    async function listFailOnSkipped(relative='',signal) { return listInternal(relative,'listFailOnSkipped',signal); }
    async function read(relative,offset=0,length=MAX_READ,expectedVersion=null,signal) {
      if(!partsOf(relative).length || !Number.isSafeInteger(offset) || offset<0 || !Number.isSafeInteger(length) || length<1 || length>MAX_READ
          || (expectedVersion!==null && (typeof expectedVersion!=='string' || !/^[a-f0-9]{64}$/.test(expectedVersion))))throw new Error('Неверный запрос');
      const out=await call({op:'read',root,...saved,path:relative,offset,length,version:expectedVersion},signal);
      if(!out || Object.keys(out).sort().join(',')!=='data,modified,size,version'
         || typeof out.data!=='string' || out.data.length>Math.ceil(length/3)*4 || typeof out.version!=='string' || !/^[a-f0-9]{64}$/.test(out.version)
         || !Number.isSafeInteger(out.size) || out.size<0 || typeof out.modified!=='string' || !out.modified || out.modified.length>100
         || (expectedVersion && out.version!==expectedVersion))throw new Error('Неверный ответ');
      const data=Buffer.from(out.data,'base64');
      if(data.toString('base64')!==out.data || data.length!==Math.min(length,Math.max(0,out.size-offset)))throw new Error('Неверный ответ');
      return {data,size:out.size,modified:out.modified,version:out.version};
    }
    // Не включается по умолчанию и не подключён к помощнику. Одно открытие
    // удерживается до конца вычисления, но это ещё не доказанный снимок Windows.
    async function hashFile(relative,signal) {
      if(!enableLockedHash || !partsOf(relative).length)throw new Error('Проверка файла недоступна');
      const out=await call({op:'hashLocked',root,...saved,path:relative},signal);
      if(!out || Object.keys(out).sort().join(',')!=='hash,modified,size,version' || !Number.isSafeInteger(out.size) || out.size<0 || out.size>MAX_HASH_FILE
        || typeof out.hash!=='string' || !/^[a-f0-9]{64}$/.test(out.hash) || typeof out.version!=='string' || !/^[a-f0-9]{64}$/.test(out.version)
        || typeof out.modified!=='string' || !out.modified || out.modified.length>100)throw new Error('Неверный ответ');
      return {hash:out.hash,size:out.size,modified:out.modified,version:out.version};
    }
    // Короткоживущая частная копия в памяти одного процесса. Она не является
    // доказанным снимком Windows и не сохраняется на диск. Оба метода включаются
    // отдельно и не подключены к помощнику.
    async function captureSnapshot(relative,signal) {
      if(!enableLockedSnapshot || !partsOf(relative).length)throw new Error('Проверка файла недоступна');
      validateSignal(signal);checkAborted(signal);
      if(snapshotBusy)throw new Error('Проверка уже выполняется');
      snapshotBusy=true;let bytes=null,completed=false;
      try {
        const out=await call({op:'snapshotLocked',root,...saved,path:relative},signal,MAX_SNAPSHOT_RESPONSE);
        checkAborted(signal);
        if(!out || Object.keys(out).sort().join(',')!=='data,hash,modified,size,version'
          || !Number.isSafeInteger(out.size) || out.size<0 || out.size>MAX_HASH_FILE
          || typeof out.data!=='string' || out.data.length!==Math.ceil(out.size/3)*4
          || typeof out.hash!=='string' || !/^[a-f0-9]{64}$/.test(out.hash)
          || typeof out.version!=='string' || !/^[a-f0-9]{64}$/.test(out.version)
          || typeof out.modified!=='string' || !out.modified || out.modified.length>100)throw new Error('Неверный ответ');
        bytes=Buffer.from(out.data,'base64');
        if(bytes.length!==out.size || bytes.toString('base64')!==out.data || crypto.createHash('sha256').update(bytes).digest('hex')!==out.hash)throw new Error('Неверный ответ');
        checkAborted(signal);
        const info=Object.freeze({hash:out.hash,size:out.size,modified:out.modified,version:out.version});
        const expires=performance.now()+snapshotTtlMs;let closed=false,timer;
        function dispose(){if(closed)return;closed=true;clearTimeout(timer);bytes.fill(0);bytes=null;snapshotBusy=false;}
        function ensure(){if(closed)throw new Error('Копия закрыта');if(performance.now()>=expires){dispose();throw new Error('Срок копии истёк');}}
        timer=setTimeout(dispose,snapshotTtlMs);if(typeof timer.unref==='function')timer.unref();
        const snapshot=Object.freeze({
          info(){ensure();return {...info};},
          async read(offset=0,length=MAX_READ,readSignal){
            validateSignal(readSignal);checkAborted(readSignal);ensure();
            if(!Number.isSafeInteger(offset) || offset<0 || !Number.isSafeInteger(length) || length<1 || length>MAX_READ)throw new Error('Неверный запрос');
            return {data:Buffer.from(bytes.subarray(offset,Math.min(offset+length,info.size))),size:info.size,modified:info.modified,version:info.version};
          },
          dispose
        });
        completed=true;return snapshot;
      } finally {if(!completed){if(bytes)bytes.fill(0);snapshotBusy=false;}}
    }
    const result={list,listFailOnSkipped,read};
    if(enableLockedHash)result.hashFile=hashFile;
    if(enableLockedSnapshot)result.captureSnapshot=captureSnapshot;
    return Object.freeze(result);
  }
  return Object.freeze({anchor,folder});
}
module.exports={createWindowsFolderProvider};
