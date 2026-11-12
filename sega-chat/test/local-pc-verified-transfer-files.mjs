// Тестовый адаптер поверх локальных временных файлов на текущей ОС. Не является
// Windows-исполнителем, аудитом путей, проверкой корзины или гарантией fsync.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {transferToStage}=require('../local-pc/verified-transfer');
const {createFolder}=require('../local-pc/folder');
const sum=b=>crypto.createHash('sha256').update(b).digest('hex'),version='a'.repeat(64);
const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'sega-transfer-files-'));
// Эксклюзивное создание тестового файла не является безопасным адаптером для
// реальных папок: здесь мы не проверяем атаки на каталог, ACL, ссылки или гонки.
async function stageAt(name,{corrupt=false,failWrite=false,failCleanup=false}={}){
  const target=path.join(tmp,name),handle=await fs.open(target,'wx+');let offset=0,closed=false;
  const close=async()=>{if(!closed){closed=true;await handle.close();}};
  return {target,close,stage:{
    async write(input){
      const bytes=Buffer.from(input);if(corrupt && bytes.length)bytes[0]^=1;
      let n=0;while(n<bytes.length){const result=await handle.write(bytes,n,bytes.length-n,offset+n);if(result.bytesWritten<=0)throw Error('неполная запись');n+=result.bytesWritten;}
      offset+=n;if(failWrite)throw Error('имитация ошибки записи');
    },
    async verify(){
      const stat=await handle.stat(),bytes=Buffer.alloc(stat.size);let n=0;
      while(n<bytes.length){const result=await handle.read(bytes,n,bytes.length-n,n);if(!result.bytesRead)throw Error('неполная проверка');n+=result.bytesRead;}
      return {size:bytes.length,hash:sum(bytes)};
    },
    async abort(){if(failCleanup)throw Error('имитация сбоя очистки');await close();await fs.unlink(target);}
  }};
}
try {
  const sourcePath=path.join(tmp,'исходник.bin'),original=Buffer.alloc(128*1024+23,71);await fs.writeFile(sourcePath,original);
  const source=await fs.open(sourcePath,'r');
  try {
    async function read(offset,length,expected){
      if(expected!==null)assert.equal(expected,version);
      const stat=await source.stat(),data=Buffer.alloc(Math.min(length,Math.max(0,stat.size-offset)));
      let n=0;while(n<data.length){const part=await source.read(data,n,data.length-n,offset+n);if(!part.bytesRead)break;n+=part.bytesRead;}
      return {data:data.subarray(0,n),size:stat.size,version};
    }
    const args={allowed:true,size:original.length,hash:sum(original),read,chunkSize:64*1024};
    let s=await stageAt('good.stage');const result=await transferToStage({...args,stage:s.stage});
    assert.equal(result.hash,sum(original));assert.deepEqual(await fs.readFile(s.target),original);assert.deepEqual(await fs.readFile(sourcePath),original);await s.close();
    // Не позволяем тестовому адаптеру открыть уже существующий путь вместо
    // временной области: ранее созданный файл и исходник остаются нетронутыми.
    const existing=path.join(tmp,'занято');await fs.writeFile(existing,'не перезаписывать');
    await assert.rejects(stageAt('занято'),e=>e.code==='EEXIST');assert.equal(await fs.readFile(existing,'utf8'),'не перезаписывать');
    s=await stageAt('network.stage');let reads=0;
    await assert.rejects(transferToStage({...args,stage:s.stage,read:async(...a)=>{if(++reads===2)throw Error('обрыв связи');return read(...a);}}),/обрыв связи/);
    await assert.rejects(fs.access(s.target),e=>e.code==='ENOENT');assert.deepEqual(await fs.readFile(sourcePath),original);
    s=await stageAt('corrupt.stage',{corrupt:true});await assert.rejects(transferToStage({...args,stage:s.stage}),/Временная копия/);
    await assert.rejects(fs.access(s.target),e=>e.code==='ENOENT');assert.deepEqual(await fs.readFile(sourcePath),original);
    // Демонстрация ограничения: лживый verify может сообщить правильный хеш,
    // не прочитав область. Модуль не способен проверить честность адаптера.
    s=await stageAt('lying.stage',{corrupt:true});s.stage.verify=async()=>({size:original.length,hash:sum(original)});
    await transferToStage({...args,stage:s.stage});assert.notDeepEqual(await fs.readFile(s.target),original);await s.close();
    s=await stageAt('write-fail.stage',{failWrite:true});await assert.rejects(transferToStage({...args,stage:s.stage}),/ошибки записи/);
    await assert.rejects(fs.access(s.target),e=>e.code==='ENOENT');assert.deepEqual(await fs.readFile(sourcePath),original);
    s=await stageAt('cleanup-fail.stage',{failWrite:true,failCleanup:true});
    await assert.rejects(transferToStage({...args,stage:s.stage}),e=>e instanceof AggregateError && e.errors.length===2);
    assert((await fs.stat(s.target)).size>0);assert.deepEqual(await fs.readFile(sourcePath),original);await s.close();
    // Связка с реальным читателем лабораторной папки на временных файлах.
    // Она не доказывает безопасность folder.js: путь может быть подменён,
    // а тест работает лишь на текущей ОС без сетевого доступа и публикации.
    const folder=await createFolder(tmp);
    s=await stageAt('folder.stage');
    await transferToStage({...args,stage:s.stage,read:(offset,length,expected,signal)=>folder.read('исходник.bin',offset,length,expected,signal)});
    assert.deepEqual(await fs.readFile(s.target),original);await s.close();
    // Источник действительно меняется между чтениями при прежнем размере.
    // Метка версии должна остановить передачу, а временный файл удалиться.
    s=await stageAt('folder-changed.stage');let folderReads=0;
    const edited=Buffer.from(original);edited[0]^=1;
    await assert.rejects(transferToStage({...args,stage:s.stage,read:async(offset,length,expected,signal)=>{
      if(++folderReads===2)await fs.writeFile(sourcePath,edited);
      return folder.read('исходник.bin',offset,length,expected,signal);
    }}),/изменился/);
    assert.equal(folderReads,2);await assert.rejects(fs.access(s.target),e=>e.code==='ENOENT');
    assert.deepEqual(await fs.readFile(sourcePath),edited);
    // Исчезновение пути между частями тоже не должно оставлять копию.
    await fs.writeFile(sourcePath,original);s=await stageAt('folder-missing.stage');folderReads=0;
    await assert.rejects(transferToStage({...args,stage:s.stage,read:async(offset,length,expected,signal)=>{
      if(++folderReads===2)await fs.rename(sourcePath,path.join(tmp,'переименован.bin'));
      return folder.read('исходник.bin',offset,length,expected,signal);
    }}),e=>e.code==='ENOENT');
    assert.equal(folderReads,2);await assert.rejects(fs.access(s.target),e=>e.code==='ENOENT');
    assert.deepEqual(await fs.readFile(path.join(tmp,'переименован.bin')),original);
    // Пустой источник тоже проходит чтение и проверку временного файла.
    const emptyPath=path.join(tmp,'empty.source');await fs.writeFile(emptyPath,Buffer.alloc(0));
    s=await stageAt('empty.stage');const empty=await transferToStage({allowed:true,size:0,hash:sum(Buffer.alloc(0)),stage:s.stage,
      read:async()=>({data:await fs.readFile(emptyPath),size:0,version})});
    assert.equal(empty.size,0);assert.equal((await fs.stat(s.target)).size,0);await s.close();
  } finally {await source.close();}
} finally {await fs.rm(tmp,{recursive:true,force:true});}
console.log('local-pc-verified-transfer-files: временные файлы текущей ОС, ошибки и очистка; Windows и реальная публикация не проверены');
