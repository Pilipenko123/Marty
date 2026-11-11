// Поддельный PowerShell и память Node. Никакая Windows и реальные файлы не проверяются.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createWindowsFolderProvider}=require('../local-pc/windows-safe-folder.js');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const version='a'.repeat(64),modified='2026-11-05T00:00:00.000Z',input=Buffer.from('файл в памяти');
let output={data:input.toString('base64'),size:input.length,hash:hash(input),version,modified};
let calls=0,kills=0,defer=false,release,entered;
function spawnFake(){
  calls++;const p=new EventEmitter();p.stdin=new PassThrough();p.stdout=new PassThrough();p.stderr=new PassThrough();p.kill=()=>{kills++;};
  const chunks=[];p.stdin.on('data',b=>chunks.push(b));p.stdin.on('end',()=>{
    const request=JSON.parse(Buffer.concat(chunks).toString());assert.equal(request.op,'snapshotLocked');
    function send(){p.stdout.write(JSON.stringify({ok:true,result:output}));p.emit('close',0);}
    if(defer){release=send;if(entered)entered();}else send();
  });return p;
}
const make=(extra={})=>createWindowsFolderProvider({platform:'win32',spawnProcess:spawnFake,timeoutMs:1000,...extra});
const no=await make().folder('C:\\test',{dev:'1',ino:'2'});assert.equal(no.captureSnapshot,undefined);
for(const options of [{enableLockedSnapshot:'yes'},{snapshotTtlMs:0},{snapshotTtlMs:60001}])assert.throws(()=>make(options));
const provider=make({enableLockedSnapshot:true,snapshotTtlMs:5000});
const folder=await provider.folder('C:\\test',{dev:'1',ino:'2'}),other=await provider.folder('C:\\other',{dev:'1',ino:'3'});
const before=calls;await assert.rejects(folder.captureSnapshot('../secret'));await assert.rejects(folder.captureSnapshot(''));assert.equal(calls,before);
const snap=await folder.captureSnapshot('file.txt');assert.deepEqual(snap.info(),{hash:hash(input),size:input.length,version,modified});
await assert.rejects(other.captureSnapshot('file.txt'),/уже выполняется/);assert.equal(calls,before+1);
const first=await snap.read(0,4);assert.deepEqual(first.data,input.subarray(0,4));first.data.fill(0);
// Изменение мнимого источника после создания не меняет сохранённую в памяти
// копию; сборка по частям сравнивается с отметкой именно этой копии.
const {checkOwnerFile}=require('../local-pc/owner-file-check.js');const info=snap.info();
output={data:Buffer.from('changed').toString('base64'),size:7,hash:hash(Buffer.from('changed')),version,modified};
const verified=await checkOwnerFile({allowed:true,size:info.size,expectedHash:info.hash,expectedVersion:info.version,expectedModified:info.modified,
  async read({offset,length}){return {ok:true,...await snap.read(offset,length)};},chunkSize:4});
assert.deepEqual(Buffer.from(verified.data),input);
output={data:input.toString('base64'),size:input.length,hash:hash(input),version,modified};
assert.deepEqual((await snap.read(0,4)).data,input.subarray(0,4));
assert.deepEqual((await snap.read(input.length+1,1)).data,Buffer.alloc(0));
for(const [off,len] of [[-1,1],[0,0],[0,131073],[0,1.5]])await assert.rejects(snap.read(off,len));
const stopped=new AbortController();stopped.abort();await assert.rejects(snap.read(0,1,stopped.signal),e=>e.name==='AbortError');
snap.dispose();snap.dispose();assert.throws(()=>snap.info(),/закрыта/);await assert.rejects(snap.read(0,1),/закрыта/);
const corrupts=[
  {...output,data:'AA??'}, {...output,data:'YR=='}, {...output,hash:'b'.repeat(64)},
  {...output,size:8*1024*1024+1}, {...output,modified:''}, {...output,version:'bad'}, {...output,extra:true}
];
for(const x of corrupts){output=x;await assert.rejects(folder.captureSnapshot('file.txt'));}
output={data:input.toString('base64'),size:input.length,hash:hash(input),version,modified};
const expiredProvider=make({enableLockedSnapshot:true,snapshotTtlMs:100}),expiredFolder=await expiredProvider.folder('C:\\test',{dev:'1',ino:'2'});
const exp=await expiredFolder.captureSnapshot('file.txt');await new Promise(r=>setTimeout(r,150));assert.throws(()=>exp.info(),/закрыта|истёк/);
const next=await expiredFolder.captureSnapshot('file.txt');next.dispose();
// Связь новой сессии с Windows-мостом и шифрованным обменом проверяется
// только с поддельным PowerShell, никаких настоящих файлов не открываем.
const {createSnapshotSession}=require('../local-pc/snapshot-session.js');
const {createReadService}=require('../local-pc/read-service.js');
const {createOwnerReadTransport}=require('../local-pc/owner-read-transport.js');
const {createRelay,digest}=require('../local-pc/relay.js');
const id='1'.repeat(32),token='2'.repeat(64),secret=Uint8Array.from(crypto.randomBytes(32));
const relay=createRelay();relay.register('owner',id,digest(token));
const session=createSnapshotSession({enabled:true,capture:folder.captureSnapshot,ttlMs:4000});
const agent=createReadService({secret,deviceId:id,folder,snapshotSession:session});
const owner=createOwnerReadTransport({secret,deviceId:id,
  async sendRequest({requestId,packet}){relay.request('owner',id,requestId,packet);const job=relay.next(id,token);
    const answer=await agent.handle(requestId,job.packet);relay.reply(id,token,requestId,job.claim,answer);return {ok:true};},
  async getResult({requestId}){return relay.result('owner',id,requestId);},
  async acknowledge({requestId}){relay.acknowledge('owner',id,requestId);return {ok:true};}
});
const opened=await owner.prepareSnapshotOpen('file.txt');await owner.submit(opened);const mark=await owner.receive(opened);
const combined=await checkOwnerFile({allowed:true,size:mark.size,expectedHash:mark.hash,expectedVersion:mark.version,expectedModified:mark.modified,
  async read({offset,length,version}){const req=await owner.prepareSnapshotRead(mark.snapshotId,offset,length,version);await owner.submit(req);const part=await owner.receive(req);
    const {data,size,modified,version:v}=part;return {ok:true,data,size,modified,version:v};}});
assert.deepEqual(Buffer.from(combined.data),input);
const closeJob=await owner.prepareSnapshotClose(mark.snapshotId);await owner.submit(closeJob);assert.equal((await owner.receive(closeJob)).ok,true);
// Ожидающее создание резервирует единственное место, отмена не выдаёт копию;
// остановка ОС процесса здесь только имитируется.
defer=true;const ready=new Promise(r=>{entered=r;}),abort=new AbortController();
const waiting=folder.captureSnapshot('file.txt',abort.signal);await ready;
await assert.rejects(other.captureSnapshot('file.txt'),/уже выполняется/);abort.abort();
await assert.rejects(waiting,e=>e.name==='AbortError');assert(kills>0);release();defer=false;
const after=await folder.captureSnapshot('file.txt');after.dispose();
// Граница размера и потоковый лимит на ответ. Высокие расходы памяти в этом
// тесте ограничены тестовыми данными; это не тест настоящих больших файлов.
const large=Buffer.alloc(8*1024*1024,7);output={data:large.toString('base64'),size:large.length,hash:hash(large),version,modified};
const max=await folder.captureSnapshot('max.bin');assert.equal(max.info().size,large.length);assert.equal((await max.read(large.length-1,1)).data[0],7);max.dispose();
output={...output,data:'x'.repeat(12*1024*1024+1)};await assert.rejects(folder.captureSnapshot('huge.bin'));
console.log('local-pc-windows-snapshot: память, предел, срок, отказ и подмена проверены с заглушкой; реальная Windows не проверена');
