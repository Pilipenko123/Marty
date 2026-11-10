'use strict';

// Только лабораторный кандидат снимка, не подключён к реальным файлам или сети.
// Две проверки списков и меток НЕ создают атомарный снимок и не доказывают
// отсутствие пропусков, подмен или изменений. Не использовать для удаления,
// записи, установки общей базы или доступа к настоящим пользовательским файлам.
const crypto=require('node:crypto');
const {isDeepStrictEqual}=require('node:util');
const {partsOf}=require('./folder');
const {validateSignal,checkAborted}=require('./abort');
const {MAX_ITEMS}=require('./sync-plan');
const CHUNK=128*1024, MAX_BYTES=256*1024*1024;
const revisionRx=/^[a-f0-9]{64}$/;

// Экспериментальный контракт зависимостей (существующие файловые провайдеры НЕ
// реализуют его): list(path, signal) возвращает {complete:true, revision,
// entries:[{name,type:'dir'} | {name,type:'file',size,revision}]}. complete
// сообщает вызывающая сторона, а не доказывает этот модуль. revision — метка
// версии каталога или файла. read(path,offset,length,revision,signal) возвращает
// {data:Buffer,size,version}. Метки не заменяют проверку содержимого и не
// обязательно позволяют обнаружить замену или повторное создание объекта.
async function snapshotCandidate({enabled, list, read, signal, maxItems=MAX_ITEMS, maxBytes=MAX_BYTES}={}) {
  if(enabled!==true) throw new Error('Синхронизация не включена');
  if(typeof list!=='function' || typeof read!=='function' || !Number.isSafeInteger(maxItems) || maxItems<0 || maxItems>MAX_ITEMS
    || !Number.isSafeInteger(maxBytes) || maxBytes<0 || maxBytes>MAX_BYTES) throw new Error('Неверные параметры снимка');
  validateSignal(signal);checkAborted(signal);
  async function inventory() {
    const pending=[''], records=[], directoryVersions=[], names=new Set();
    let bytes=0;
    while(pending.length) {
      checkAborted(signal);
      const parent=pending.pop(), page=await list(parent,signal);
      checkAborted(signal);
      if(!page || page.complete!==true || typeof page.revision!=='string' || !revisionRx.test(page.revision) || !Array.isArray(page.entries)) throw new Error('Список папки не подтверждён');
      directoryVersions.push({path:parent,revision:page.revision});
      for(const item of page.entries) {
        checkAborted(signal);
        if(!item || typeof item.name!=='string' || partsOf(item.name).length!==1 || !['dir','file'].includes(item.type)) throw new Error('Неверный элемент папки');
        const path=parent ? parent+'/'+item.name : item.name;
        partsOf(path);
        const folded=path.normalize('NFC').toLowerCase();
        if(names.has(folded))throw new Error('Имена файлов совпадают');
        names.add(folded);
        if(records.length>=maxItems)throw new Error('Слишком много элементов');
        if(item.type==='dir') {records.push({path,type:'dir'});pending.push(path);}
        else {
          if(!Number.isSafeInteger(item.size) || item.size<0 || typeof item.revision!=='string' || !revisionRx.test(item.revision)
            || item.size>maxBytes-bytes)throw new Error('Неверный размер или версия файла');
          bytes+=item.size;
          records.push({path,type:'file',size:item.size,revision:item.revision});
        }
      }
    }
    const byPath=(a,b)=>a.path<b.path?-1:a.path>b.path?1:0;
    records.sort(byPath);directoryVersions.sort(byPath);
    return {records,directoryVersions};
  }
  const first=await inventory(), result=[];
  for(const item of first.records) {
    checkAborted(signal);
    if(item.type==='dir'){result.push({path:item.path,type:'dir'});continue;}
    const hash=crypto.createHash('sha256');let offset=0;
    // Пустой файл тоже читается, чтобы проверить его метку и размер.
    do {
      checkAborted(signal);
      const length=item.size===0?1:Math.min(CHUNK,item.size-offset);
      const part=await read(item.path,offset,length,item.revision,signal);
      checkAborted(signal);
      if(!part || !Buffer.isBuffer(part.data) || part.size!==item.size || part.version!==item.revision
        || part.data.length!==Math.min(length,item.size-offset))throw new Error('Файл изменился или прочитан не полностью');
      hash.update(part.data);offset+=part.data.length;
    } while(offset<item.size);
    result.push({path:item.path,type:'file',size:item.size,hash:hash.digest('hex')});
  }
  const last=await inventory();
  checkAborted(signal);
  if(!isDeepStrictEqual(first,last))throw new Error('Папка изменилась во время проверки');
  return result;
}
module.exports={snapshotCandidate,CHUNK,MAX_BYTES};
