// Обычное завершение тестовой записи, принудительная остановка процесса и
// повторное чтение файла. Не проверяет выключение питания или надёжность ФС.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fork} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const {createRecoveryJournal}=createRequire(import.meta.url)('../local-pc/recovery-journal');
const worker=fileURLToPath(new URL('./fixtures/local-pc-journal-worker.cjs',import.meta.url));
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'sega-recovery-process-'));
async function stopAt(phase){
  const file=path.join(dir,phase+'.json');
  const child=fork(worker,[file,phase],{stdio:['ignore','ignore','pipe','ipc']});
  let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});
  try {
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('Рабочий процесс не достиг этапа')),10000);
      child.once('message',message=>{clearTimeout(timer);message===phase?resolve():reject(Error('Неверный этап'));});
      child.once('exit',()=>{clearTimeout(timer);reject(Error('Процесс завершился до остановки: '+stderr));});
      child.once('error',error=>{clearTimeout(timer);reject(error);});
    });
    const exited=new Promise(resolve=>child.once('exit',resolve));child.kill();await exited;
    const record=JSON.parse(await fs.readFile(file,'utf8'));
    const restored=createRecoveryJournal({record,save:async()=>{throw Error('не должен вызываться');}});
    return restored.inspect();
  } finally {if(child.exitCode===null && child.signalCode===null)child.kill();}
}
try {
  assert.deepEqual(await stopAt('prepared'),{state:'prepared',next:'stop'});
  assert.deepEqual(await stopAt('uncertain'),{state:'uncertain',next:'inspect-target'});
  assert.deepEqual(await stopAt('confirmed'),{state:'confirmed',next:'stop'});
  // Оборванный или повреждённый JSON нельзя считать новым пустым журналом.
  const file=path.join(dir,'corrupt.json');await fs.writeFile(file,'{"id":');
  await assert.rejects(async()=>createRecoveryJournal({record:JSON.parse(await fs.readFile(file,'utf8')),save:async()=>{}}),SyntaxError);
} finally {await fs.rm(dir,{recursive:true,force:true});}
console.log('local-pc-recovery-process: остановка процесса и чтение временной записи; надёжность при сбое питания не проверена');
