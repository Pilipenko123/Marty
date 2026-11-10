// Остановка только на заглушках и временных данных; не проверка Windows.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createReadService}=require('../local-pc/read-service.js');
const {createWindowsFolderProvider}=require('../local-pc/windows-safe-folder.js');
const {createFolder}=require('../local-pc/folder.js');
const channel=require('../local-pc/secure-channel.js');
const device='a'.repeat(32), secret=new Uint8Array(crypto.randomBytes(32)), expiry=Date.now()+60000;
const payload=new TextEncoder().encode(JSON.stringify({op:'list',path:''}));
const request=async(n)=>{const id=n.toString(16).padStart(32,'0');return {id,packet:await channel.seal(secret,device,'request',id,expiry,payload)}};
const decode=async(id,packet)=>JSON.parse(new TextDecoder().decode(await channel.open(secret,packet,{channel:device,direction:'response',request:id,expires:expiry})));
let calls=0, entered, release, abortSeen=0;
let enteredPromise=new Promise(resolve=>{entered=resolve});
const folder={
  async list(_path,signal) {
    calls++;entered();
    if(calls===1) return new Promise((resolve,reject)=>{
      release=()=>resolve([{name:'временный'}]);
      signal.addEventListener('abort',()=>{abortSeen++;reject(Object.assign(new Error('остановлено'),{name:'AbortError'}))},{once:true});
    });
    return [{name:'повтор'}];
  },
  async read(){throw new Error('не используется')}
};
const service=createReadService({folder,secret,deviceId:device});
const first=await request(1), already=new AbortController();already.abort();
await assert.rejects(service.handle(first.id,first.packet,already.signal),e=>e.name==='AbortError');assert.equal(calls,0);
await assert.rejects(service.handle(first.id,first.packet,{}),/сигнал/);
const ac=new AbortController();const reading=service.handle(first.id,first.packet,ac.signal);
await enteredPromise;ac.abort();await assert.rejects(reading,e=>e.name==='AbortError');assert.equal(abortSeen,1);
const retry=await service.handle(first.id,first.packet);
assert.equal((await decode(first.id,retry)).items[0].name,'повтор');assert.equal(calls,2);

// Два ожидателя одного запроса: остановка второго не прерывает первый и не
// выполняет чтение повторно. Запоминание ответа остаётся в памяти процесса.
let concurrentCalls=0, ready;
const readyPromise=new Promise(resolve=>{ready=resolve});
let finish;
const cfolder={async list(){concurrentCalls++;ready();return new Promise(r=>{finish=r})},async read(){}};
const concurrent=createReadService({folder:cfolder,secret,deviceId:device});
const second=await request(2), original=concurrent.handle(second.id,second.packet);
await readyPromise;
const waiterAbort=new AbortController();const duplicate=concurrent.handle(second.id,second.packet,waiterAbort.signal);
await new Promise(resolve=>setImmediate(resolve));waiterAbort.abort();
await assert.rejects(duplicate,e=>e.name==='AbortError');assert.equal(concurrentCalls,1);
finish([{name:'один ответ'}]);const result=await original;
assert.equal((await decode(second.id,result)).items[0].name,'один ответ');
assert.equal(await concurrent.handle(second.id,second.packet),result);assert.equal(concurrentCalls,1);

// Если внешний обработчик игнорирует отмену, вызывающий процесс не ждёт его,
// но он может продолжить работу: отдельная реальная проверка ещё необходима.
let unsafeDone, ignoredStarted, ignoredCalls=0;
const ignoredReady=new Promise(resolve=>{ignoredStarted=resolve});
const ignoreFolder={async list(){if(++ignoredCalls>1)return [{name:'свежий'}];ignoredStarted();return new Promise(r=>{unsafeDone=r})},async read(){}};
const ignored=createReadService({folder:ignoreFolder,secret,deviceId:device});
const third=await request(3), stop=new AbortController(), ignoredCall=ignored.handle(third.id,third.packet,stop.signal);
await ignoredReady;stop.abort();await assert.rejects(ignoredCall,e=>e.name==='AbortError');unsafeDone([]);
await new Promise(resolve=>setImmediate(resolve)); // завершение игнорировавшего отмену обработчика
const afterIgnored=await ignored.handle(third.id,third.packet);
assert.equal((await decode(third.id,afterIgnored)).items[0].name,'свежий');assert.equal(ignoredCalls,2);

// Windows-мост останавливает поддельный процесс и не запускает его, если уже
// была отмена. Настоящее завершение PowerShell на Windows ещё не проверено.
let spawned=0,killed=0;
function hangingProcess(){
  spawned++;const p=new EventEmitter();p.stdin=new PassThrough();p.stdout=new PassThrough();p.stderr=new PassThrough();
  p.stdin.resume();p.kill=()=>{killed++;p.emit('close',1);};return p;
}
const win=createWindowsFolderProvider({platform:'win32',spawnProcess:hangingProcess,timeoutMs:1000});
const wfolder=await win.folder('C:\\Папка',{dev:'1',ino:'2'});
const precancelled=new AbortController();precancelled.abort();
await assert.rejects(wfolder.list('',precancelled.signal),e=>e.name==='AbortError');assert.equal(spawned,0);
const inProgress=new AbortController();const windowsCall=wfolder.read('тест.txt',0,4,null,inProgress.signal);
assert.equal(spawned,1);inProgress.abort();await assert.rejects(windowsCall,e=>e.name==='AbortError');assert.equal(killed,1);

// Старый изолированный провайдер проверяет отмену до обращения к файлу.
const root=await fs.mkdtemp(path.join(os.tmpdir(),'sega-cancel-'));
try {
  await fs.writeFile(path.join(root,'file'),'test');const local=await createFolder(root);
  await assert.rejects(local.list('',precancelled.signal),e=>e.name==='AbortError');
  await assert.rejects(local.read('file',0,4,null,precancelled.signal),e=>e.name==='AbortError');
} finally {await fs.rm(root,{recursive:true,force:true});}
console.log('local-pc-cancel: отмена чтения, повтора и заглушки Windows проверена; реальная Windows не проверена');
