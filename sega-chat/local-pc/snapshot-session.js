'use strict';
// Неподключённый эксперимент с одной временной копией на экземпляр. Поставщик
// обязан предоставить независимую копию, синхронное dispose и ограничение её
// размера. Здесь нет настоящих прав, установки, восстановления или Windows.
const crypto=require('node:crypto');
const {performance}=require('node:perf_hooks');
const {partsOf}=require('./path-rules');
const {validateSignal,checkAborted}=require('./abort');
const MAX_FILE=8*1024*1024, MAX_READ=128*1024, ID=/^[a-f0-9]{32}$/, HASH=/^[a-f0-9]{64}$/;
function createSnapshotSession({enabled,capture,ttlMs=20000}={}){
  if(enabled!==true || typeof capture!=='function' || !Number.isInteger(ttlMs) || ttlMs<100 || ttlMs>60000)throw new Error('Копия недоступна');
  let active=null,lastClosed=null,busy=false,poisoned=false;
  function healthy(){if(poisoned)throw new Error('Не удалось очистить копию');}
  function dispose(snapshot){
    try {
      if(!snapshot || typeof snapshot.dispose!=='function')throw new Error('Нет очистки');
      // Контракт синхронный, чтобы не считать ещё не завершённую очистку успехом.
      const result=snapshot.dispose();
      if(result!==undefined){if(result && typeof result.then==='function')Promise.resolve(result).catch(()=>{});throw new Error('Неверная очистка');}
    } catch(_){poisoned=true;throw new Error('Не удалось очистить копию');}
  }
  function closeRecord(record){
    if(active!==record)return;
    active=null;clearTimeout(record.timer);
    dispose(record.snapshot);lastClosed=record.id;
  }
  function expire(){if(active && performance.now()>=active.expires)closeRecord(active);}
  function idValid(id){return typeof id==='string' && ID.test(id);}
  function metadata(info){
    if(!info || Object.keys(info).sort().join(',')!=='hash,modified,size,version' || !Number.isSafeInteger(info.size) || info.size<0 || info.size>MAX_FILE
      || typeof info.hash!=='string' || !HASH.test(info.hash) || typeof info.version!=='string' || !HASH.test(info.version)
      || typeof info.modified!=='string' || !info.modified || info.modified.length>100)throw new Error('Неверная копия');
    return {size:info.size,hash:info.hash,version:info.version,modified:info.modified};
  }
  async function open(path,signal){
    validateSignal(signal);checkAborted(signal);healthy();expire();
    if(typeof path!=='string' || !partsOf(path).length)throw new Error('Неверный путь');
    if(busy || active)throw new Error('Копия уже открыта');
    busy=true;let snapshot=null,adopted=false;
    try {
      snapshot=await capture(path,signal);checkAborted(signal);
      if(!snapshot || typeof snapshot.info!=='function' || typeof snapshot.read!=='function' || typeof snapshot.dispose!=='function')throw new Error('Неверная копия');
      const info=metadata(snapshot.info()),id=crypto.randomBytes(16).toString('hex');
      if(id===lastClosed)throw new Error('Не удалось открыть копию');
      const record={id,info,snapshot,expires:performance.now()+ttlMs,timer:null};
      record.timer=setTimeout(()=>{try{closeRecord(record);}catch(_){}},ttlMs);record.timer.unref?.();
      active=record;adopted=true;return {snapshotId:id,...info};
    } finally {
      try {if(snapshot && !adopted)dispose(snapshot);} finally {busy=false;}
    }
  }
  async function read(id,offset,length,signal){
    validateSignal(signal);checkAborted(signal);healthy();expire();
    if(!idValid(id) || !Number.isSafeInteger(offset) || offset<0 || !Number.isSafeInteger(length) || length<1 || length>MAX_READ)throw new Error('Неверный запрос');
    if(busy || !active || active.id!==id)throw new Error('Копия недоступна');
    const record=active;busy=true;
    try {
      const part=await record.snapshot.read(offset,length,signal);
      checkAborted(signal);healthy();expire();
      if(active!==record)throw new Error('Срок копии истёк');
      if(!part || Object.keys(part).sort().join(',')!=='data,modified,size,version' || !Buffer.isBuffer(part.data)
        || part.size!==record.info.size || part.version!==record.info.version || part.modified!==record.info.modified
        || part.data.length!==Math.min(length,Math.max(0,record.info.size-offset))) {
        closeRecord(record);throw new Error('Неверная копия');
      }
      return {data:Buffer.from(part.data),size:record.info.size,version:record.info.version,modified:record.info.modified};
    } finally {busy=false;}
  }
  function close(id){
    healthy();expire();if(!idValid(id))throw new Error('Неверный запрос');
    if(busy)throw new Error('Копия занята');
    if(active && active.id===id){closeRecord(active);return;}
    if(id===lastClosed)return;
    throw new Error('Копия недоступна');
  }
  function disposeAll(){
    healthy();if(busy)throw new Error('Копия занята');if(active)closeRecord(active);
  }
  return Object.freeze({open,read,close,disposeAll});
}
module.exports={createSnapshotSession,MAX_FILE,MAX_READ};
