'use strict';
// Лабораторный хеш источника. Не включён в обычный сервер и не защищает пути
// Windows: read передаётся вызывающим кодом и пока проверяется лишь заглушками.
// Метаданные не являются снимком: источник может незаметно подменить данные.
const crypto=require('node:crypto');
const {partsOf}=require('./path-rules');
const {validateSignal,checkAborted}=require('./abort');
const MAX_FILE=8*1024*1024, CHUNK=128*1024, HASH=/^[a-f0-9]{64}$/;
function createFileHashCandidate({enabled,read}={}){
  if(enabled!==true || typeof read!=='function')throw new Error('Проверка источника не включена');
  let busy=false;
  async function hashFile(path,signal){
    validateSignal(signal);checkAborted(signal);
    if(typeof path!=='string' || !partsOf(path).length)throw new Error('Неверный путь');
    if(busy)throw new Error('Проверка уже выполняется');
    busy=true;
    try {
      let offset=0,size=null,version=null,modified=null;
      const hash=crypto.createHash('sha256');
      do {
        checkAborted(signal);
        const length=size===null?CHUNK:Math.min(CHUNK,size-offset);
        const part=await read(path,offset,length,version,signal);
        checkAborted(signal);
        if(!part || typeof part!=='object')throw new Error('Файл изменился или прочитан не полностью');
        const {data,size:currentSize,version:currentVersion,modified:currentModified}=part;
        if(!Buffer.isBuffer(data) || !Number.isSafeInteger(currentSize) || currentSize<0 || currentSize>MAX_FILE
          || typeof currentVersion!=='string' || !HASH.test(currentVersion) || typeof currentModified!=='string' || !currentModified || currentModified.length>100
          || (size!==null && (size!==currentSize || version!==currentVersion || modified!==currentModified))
          || data.length!==Math.min(length,Math.max(0,currentSize-offset)))throw new Error('Файл изменился или прочитан не полностью');
        if(size===null){size=currentSize;version=currentVersion;modified=currentModified;}
        hash.update(data);offset+=data.length;
      } while(offset<size);
      checkAborted(signal);
      return {size,version,modified,hash:hash.digest('hex')};
    } finally {busy=false;}
  }
  return Object.freeze({hashFile});
}
module.exports={createFileHashCandidate,MAX_FILE,CHUNK};
