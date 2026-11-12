// ТОЛЬКО тест: обычная запись без атомарности и fsync, не хранилище продукта.
'use strict';
const fs=require('node:fs/promises');
const {createRecoveryJournal}=require('../../local-pc/recovery-journal');
const [filename,phase]=process.argv.slice(2);
const record={id:'a'.repeat(32),kind:'trash',state:'prepared'};
async function pause(label){
  if(phase===label){process.send(label);await new Promise(()=>{});}
}
(async()=>{
  await fs.writeFile(filename,JSON.stringify(record));
  const journal=createRecoveryJournal({record,save:r=>fs.writeFile(filename,JSON.stringify(r))});
  await pause('prepared');
  await journal.markUncertain();await pause('uncertain');
  // Это лишь фиктивное подтверждение; реальных операций и наблюдений нет.
  await journal.markObserved();await pause('confirmed');
  process.exitCode=0;
})().catch(err=>{console.error(err);process.exitCode=1;});
