'use strict';
// ЗАГОТОВКА: запускает окно Windows и возвращает выбранное только процессу.
// Не открывать доступ к папке без дальнейшей проверки всей системы на Windows.
const path=require('node:path');
const {spawn}=require('node:child_process');
function showWizard({platform=process.platform,spawnProcess=spawn}={}) {
  if(platform!=='win32') return Promise.reject(new Error('Подключение доступно только на Windows'));
  return new Promise((resolve,reject)=>{
    let child, done=false, size=0; const chunks=[];
    const finish=(err,value)=>{if(done)return;done=true;if(err)reject(new Error('Не удалось открыть окно подключения'));else resolve(value)};
    try { child=spawnProcess('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'windows-wizard.ps1')],{stdio:['ignore','pipe','pipe'],windowsHide:true}); }
    catch (_) { return finish(true); }
    child.on('error',()=>finish(true));
    child.stdout.on('data',b=>{size+=b.length;if(size>16384){try{child.kill()}catch(_){}finish(true);return;}chunks.push(Buffer.from(b));});
    child.stderr.on('data',()=>{});
    child.on('close',code=>{
      if(code!==0)return finish(true);
      try {
        const r=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if(r && r.ok===false)return finish(null,null);
        if(!r || r.ok!==true || typeof r.code!=='string' || typeof r.folder!=='string')return finish(true);
        return finish(null,{code:r.code,folder:r.folder});
      } catch (_) {return finish(true)}
    });
  });
}
module.exports={showWizard};
