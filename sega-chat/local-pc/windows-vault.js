'use strict';
// Лабораторная обёртка DPAPI. Секреты передаются только через stdin/stdout,
// не в командной строке. Реальная работа на Windows ещё не проверена.
const path = require('node:path');
const {spawn} = require('node:child_process');
const MAX = 65536;
function createWindowsVault({platform = process.platform, spawnProcess = spawn, timeoutMs = 15000} = {}) {
  if (platform !== 'win32') throw new Error('Защищённое хранилище доступно только на Windows');
  if (typeof spawnProcess!=='function' || !Number.isInteger(timeoutMs) || timeoutMs<1 || timeoutMs>60000) throw new Error('Неверные настройки хранилища');
  const script=path.join(__dirname,'windows-vault.ps1');
  function run(mode, content) {
    return new Promise((resolve,reject)=>{
      let done=false, size=0, chunks=[];
      const finish=(error,result)=>{if(done)return;done=true;clearTimeout(timer); if(error)reject(new Error('Не удалось открыть защищённое хранилище Windows'));else resolve(result)};
      let child;
      try { child=spawnProcess('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-Mode',mode],{stdio:['pipe','pipe','pipe'],windowsHide:true}); }
      catch (_) { reject(new Error('Не удалось открыть защищённое хранилище Windows')); return; }
      const timer=setTimeout(()=>{try{child.kill()}catch(_){}finish(true)},timeoutMs);
      child.on('error',()=>finish(true));
      child.stdout.on('data',chunk=>{size+=chunk.length;if(size>MAX){try{child.kill()}catch(_){}finish(true);return;}chunks.push(Buffer.from(chunk));});
      child.stderr.on('data',()=>{}); // никогда не копируем возможно чувствительный текст в логи
      child.stdin.on('error',()=>finish(true));
      child.on('close',code=>{
        if(code!==0)return finish(true);
        try { finish(null,JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (_) { finish(true); }
      });
      child.stdin.end(content || '');
    });
  }
  return Object.freeze({
    async load(){
      const r=await run('load');
      if(r && r.exists===false && Object.keys(r).join(',')==='exists')return null;
      if(!r || r.exists!==true || Object.keys(r).sort().join(',')!=='data,exists' || !r.data || typeof r.data!=='object' || Array.isArray(r.data))throw new Error('Не удалось открыть защищённое хранилище Windows');
      return r.data;
    },
    async save(data){
      let content;
      try {
        if(!data || typeof data!=='object' || Array.isArray(data))throw new Error();
        content=JSON.stringify(data);
        const parsed=JSON.parse(content);
        if(!parsed || typeof parsed!=='object' || Array.isArray(parsed) || Buffer.byteLength(content)>16384)throw new Error();
      } catch (_) {throw new Error('Не удалось открыть защищённое хранилище Windows');}
      const r=await run('save',content);
      if(!r || r.ok!==true || Object.keys(r).join(',')!=='ok')throw new Error('Не удалось открыть защищённое хранилище Windows');
    }
  });
}
module.exports={createWindowsVault};
