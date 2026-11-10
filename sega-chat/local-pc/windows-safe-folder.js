'use strict';
// Экспериментальный мост к windows-safe-folder.ps1/.cs; не включён в помощник.
// Реальное поведение системных дескрипторов ещё НЕ проверено на Windows 10.
const path=require('node:path');
const {spawn}=require('node:child_process');
const {partsOf,MAX_ENTRIES}=require('./folder');
const {abortError,validateSignal,checkAborted}=require('./abort');
const MAX_READ=128*1024, MAX_RESPONSE=512*1024;
function createWindowsFolderProvider({platform=process.platform,spawnProcess=spawn,timeoutMs=30000}={}) {
  if(platform!=='win32') throw new Error('Доступно только на Windows');
  function rootPath(root) {
    if(typeof root!=='string' || root.length>4096 || !/^[a-zA-Z]:\\/.test(root)) throw new Error('Выберите локальную папку');
    const r=path.win32.normalize(root).replace(/\\+$/,'');
    if(!/^[a-zA-Z]:\\.+/.test(r)) throw new Error('Выберите папку, не весь диск');
    return r;
  }
  function identity(id) {
    if(!id || typeof id.dev!=='string' || !/^\d+$/.test(id.dev) || typeof id.ino!=='string' || !/^[1-9]\d*$/.test(id.ino))throw new Error('Не удалось проверить папку');
    return {dev:id.dev,ino:id.ino};
  }
  function call(body,signal) {
    validateSignal(signal);checkAborted(signal);
    return new Promise((resolve,reject)=>{
      let child,done=false,size=0,chunks=[],timer;
      const onAbort=()=>{finish('aborted');try{child.kill()}catch(_){}};
      const finish=(err,result)=>{if(done)return;done=true;clearTimeout(timer);if(signal)signal.removeEventListener('abort',onAbort);if(err)reject(err==='aborted'?abortError():new Error('Не удалось безопасно открыть папку или файл'));else resolve(result);};
      try { child=spawnProcess('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'windows-safe-folder.ps1')],{stdio:['pipe','pipe','pipe'],windowsHide:true}); }
      catch (_) { finish(true);return; }
      timer=setTimeout(()=>{finish(true);try{child.kill()}catch(_){}},timeoutMs);
      child.on('error',()=>finish(true));
      child.stdout.on('data',b=>{size+=b.length;if(size>MAX_RESPONSE){try{child.kill()}catch(_){}finish(true);return;}chunks.push(Buffer.from(b));});
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
      const items=out.items.map(x=>{
        if(!x || typeof x.name!=='string' || partsOf(x.name).length!==1 || typeof x.dir!=='boolean'
           || !Number.isSafeInteger(x.size) || x.size<0 || typeof x.modified!=='string')throw new Error('Неверный ответ');
        return {name:x.name,dir:x.dir,size:x.size,modified:x.modified};
      });
      if(op==='listFailOnSkipped') {
        const names=new Set();
        for(const item of items) {
          const folded=item.name.normalize('NFC').toLowerCase();
          if(names.has(folded))throw new Error('Имена совпадают');
          names.add(folded);
        }
      }
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
      if(typeof out.data!=='string' || out.data.length>Math.ceil(length/3)*4 || typeof out.version!=='string' || !/^[a-f0-9]{64}$/.test(out.version)
         || !Number.isSafeInteger(out.size) || out.size<0 || typeof out.modified!=='string' || (expectedVersion && out.version!==expectedVersion))throw new Error('Неверный ответ');
      const data=Buffer.from(out.data,'base64');
      if(data.toString('base64')!==out.data || data.length>length || data.length>Math.max(0,out.size-offset))throw new Error('Неверный ответ');
      return {data,size:out.size,modified:out.modified,version:out.version};
    }
    return Object.freeze({list,listFailOnSkipped,read});
  }
  return Object.freeze({anchor,folder});
}
module.exports={createWindowsFolderProvider};
