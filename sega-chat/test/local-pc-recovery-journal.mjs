// Модель и имитация перезапуска. Нет настоящего диска, API или операций.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {createRecoveryJournal}=createRequire(import.meta.url)('../local-pc/recovery-journal');
const initial={id:'1'.repeat(32),kind:'trash',state:'prepared'};
let disk=JSON.stringify(initial);
const save=async record=>{disk=JSON.stringify(record);};
const open=()=>createRecoveryJournal({record:JSON.parse(disk),save});
let j=open();assert.deepEqual(j.inspect(),{state:'prepared',next:'stop'});
await j.markUncertain();j=open();assert.deepEqual(j.inspect(),{state:'uncertain',next:'inspect-target'});
// После обрыва нет автоматического повторного удаления.
await assert.rejects(j.markUncertain(),/недоступен/);
await j.markObserved();j=open();assert.deepEqual(j.inspect(),{state:'confirmed',next:'stop'});
await assert.rejects(j.markObserved(),/недоступен/);
for(const kind of ['copy','rename','trash']){
  const r={...initial,kind};const x=createRecoveryJournal({record:r,save:async()=>{}});
  r.state='confirmed';assert.equal(x.inspect().state,'prepared');await x.markUncertain();
  assert.equal(x.inspect().next,'inspect-target');
}
for(const record of [null,{}, {...initial,state:'done'}, {...initial,id:'x'}, {...initial,kind:'delete'}, {...initial,path:'secret'}])
  assert.throws(()=>createRecoveryJournal({record,save}),/Повреждён/);
// Сохранение могло пройти, но ответ потерялся. Ни старое, ни новое состояние
// нельзя считать достоверным, пока хранилище отдельно не проверено.
let stored=initial;
const bad=createRecoveryJournal({record:initial,save:async r=>{stored=r;throw Error('ответ потерян');}});
await assert.rejects(bad.markUncertain(),/ответ потерян/);
assert.deepEqual(bad.inspect(),{state:'unknown',next:'stop'});await assert.rejects(bad.markUncertain(),/недоступен/);
assert.equal(createRecoveryJournal({record:stored,save}).inspect().next,'inspect-target');
const unknownConfirmation=createRecoveryJournal({record:{...initial,state:'uncertain'},save:async()=>{throw Error('сбой подтверждения');}});
await assert.rejects(unknownConfirmation.markObserved(),/сбой подтверждения/);
assert.deepEqual(unknownConfirmation.inspect(),{state:'unknown',next:'stop'});
await assert.rejects(unknownConfirmation.markObserved(),/недоступен/);
let release;const pending=new Promise(r=>release=r);
const concurrent=createRecoveryJournal({record:initial,save:()=>pending});
const first=concurrent.markUncertain();assert.equal(concurrent.inspect().state,'saving');
await assert.rejects(concurrent.markUncertain(),/недоступен/);release();await first;
assert.equal(concurrent.inspect().state,'uncertain');
console.log('local-pc-recovery-journal: учебная модель обрыва и перезапуска в памяти, реальных операций и устойчивого хранения нет');
