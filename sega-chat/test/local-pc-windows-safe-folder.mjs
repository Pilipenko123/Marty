// Проверка границы ввода/вывода с поддельным процессом. Не доказывает работу
// системных дескрипторов и защиты от гонок на настоящей Windows.
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
const {createWindowsFolderProvider}=createRequire(import.meta.url)('../local-pc/windows-safe-folder.js');
assert.throws(()=>createWindowsFolderProvider({platform:'linux'}));
let invocation=null, requests=[], bad=false, fail=false, duplicate=false, hashResult=null, readResult=null, listResult=null;
function spawnFake(name,args,opts){
  invocation={name,args,opts};const p=new EventEmitter();p.stdin=new PassThrough();p.stdout=new PassThrough();p.stderr=new PassThrough();p.kill=()=>{};
  const chunks=[];p.stdin.on('data',c=>chunks.push(c));p.stdin.on('end',()=>{
    const r=JSON.parse(Buffer.concat(chunks).toString());requests.push(r);
    if(fail){p.stderr.write('личный путь');p.emit('close',1);return;}
    let result;
    if(r.op==='identity')result={root:r.root,dev:'7',ino:'123'};
    else if(r.op==='list' || r.op==='listFailOnSkipped') {
      const item={name:'песня.mp3',dir:false,size:3,modified:'2026-01-01T00:00:00.000Z'};
      result=listResult || {items:bad?[{name:'../постороннее',dir:false,size:1,modified:''}]:duplicate?[item,{...item,name:'ПЕСНЯ.MP3'}]:[item]};
    }
    else if(r.op==='hashLocked')result=hashResult || {hash:'b'.repeat(64),size:3,modified:'2026-01-01T00:00:00.000Z',version:'a'.repeat(64)};
    else result=readResult || {data:bad?'AA?':'AQID',size:3,modified:'2026-01-01T00:00:00.000Z',version:'a'.repeat(64)};
    p.stdout.write(JSON.stringify({ok:true,result}));p.emit('close',0);
  });return p;
}
const provider=createWindowsFolderProvider({platform:'win32',spawnProcess:spawnFake,timeoutMs:1000});
await assert.rejects(provider.anchor('C:\\'));
await assert.rejects(provider.anchor('\\\\server\\share'));
const beforeRoots=requests.length;
for(const root of ['C:\\Личное\\..\\Другое','C:\\Личное\\.\\Другое','C:\\Личное\\\\Другое','C:\\Личное/Другое','C:\\Личное\\CON','C:\\Личное:поток']){
  await assert.rejects(provider.anchor(root));await assert.rejects(provider.folder(root,{dev:'7',ino:'123'}));
}
assert.equal(requests.length,beforeRoots); // ни один неоднозначный путь не отправлен процессу
const a=await provider.anchor('C:\\Личное\\');assert.deepEqual(a,{root:'C:\\Личное',dev:'7',ino:'123'});
assert.equal(invocation.name,'powershell.exe');assert(!invocation.args.join(' ').includes('Личное'));
const folder=await provider.folder(a.root,a);
assert.equal(folder.hashFile,undefined); // по умолчанию не включено
assert.throws(()=>createWindowsFolderProvider({platform:'win32',enableLockedHash:'yes'}));
for(const opts of [{timeoutMs:0},{timeoutMs:60001},{timeoutMs:Infinity},{timeoutMs:'1000'},{spawnProcess:null}])assert.throws(()=>createWindowsFolderProvider({platform:'win32',...opts}));
const hashProvider=createWindowsFolderProvider({platform:'win32',spawnProcess:spawnFake,timeoutMs:1000,enableLockedHash:true});
const hashFolder=await hashProvider.folder(a.root,a);
assert.deepEqual(await hashFolder.hashFile('песня.mp3'),{hash:'b'.repeat(64),size:3,modified:'2026-01-01T00:00:00.000Z',version:'a'.repeat(64)});
assert.equal(requests.at(-1).op,'hashLocked');assert.equal(requests.at(-1).root,a.root);
let previousCalls=requests.length;await assert.rejects(hashFolder.hashFile('../секрет'));await assert.rejects(hashFolder.hashFile(''));assert.equal(requests.length,previousCalls);
for(const invalid of [
  {hash:'bad',size:3,modified:'date',version:'a'.repeat(64)},
  {hash:'b'.repeat(64),size:8*1024*1024+1,modified:'date',version:'a'.repeat(64)},
  {hash:'b'.repeat(64),size:3,modified:'',version:'a'.repeat(64)},
  {hash:'b'.repeat(64),size:3,modified:'date',version:'bad'},
  {hash:'b'.repeat(64),size:3,modified:'date',version:'a'.repeat(64),extra:1}
]) {hashResult=invalid;await assert.rejects(hashFolder.hashFile('песня.mp3'));}
hashResult=null;
const stopped=new AbortController();stopped.abort();previousCalls=requests.length;
await assert.rejects(hashFolder.hashFile('песня.mp3',stopped.signal),e=>e.name==='AbortError');assert.equal(requests.length,previousCalls);
assert.equal((await folder.list(''))[0].name,'песня.mp3');
assert.equal((await folder.listFailOnSkipped(''))[0].name,'песня.mp3');
assert.equal(requests.at(-1).op,'listFailOnSkipped');
duplicate=true;await assert.rejects(folder.listFailOnSkipped(''),/Имена совпадают/);await assert.rejects(folder.list(''),/Имена совпадают/);duplicate=false;
const validEntry={name:'песня.mp3',dir:false,size:3,modified:'2026-01-01T00:00:00.000Z'};
for(const invalid of [{...validEntry,extra:1},{...validEntry,modified:''},{...validEntry,modified:'x'.repeat(101)},
  {...validEntry,dir:true,size:3},{...validEntry,name:'../x'}]){
  listResult={items:[invalid]};await assert.rejects(folder.list(''));await assert.rejects(folder.listFailOnSkipped(''));
}
listResult={items:[{...validEntry,name:'x'.repeat(255)}]};
const deep=Array(16).fill('a'.repeat(240)).join('/');assert(deep.length<4096);
await assert.rejects(folder.list(deep)); // корректное имя элемента, но общий путь слишком длинный
listResult=null;
const got=await folder.read('песня.mp3',0,4);assert.deepEqual([...got.data],[1,2,3]);assert.match(got.version,/^[a-f0-9]{64}$/);
// Корректный base64, но слишком короткое содержимое не является успехом.
const validRead={data:'AQID',size:3,modified:'2026-01-01T00:00:00.000Z',version:'a'.repeat(64)};
for(const invalid of [{...validRead,data:''},{...validRead,data:'AQI='},{...validRead,data:'AQIDBA=='},
  {...validRead,data:'AQI?'},{...validRead,modified:''},{...validRead,modified:'x'.repeat(101)},
  {...validRead,extra:true},{...validRead,version:'b'.repeat(64)}]){
  readResult=invalid;await assert.rejects(folder.read('песня.mp3',0,4,'a'.repeat(64)));
}
readResult={...validRead,data:'AgM='};assert.deepEqual([...(await folder.read('песня.mp3',1,4,'a'.repeat(64))).data],[2,3]);
readResult={...validRead,data:''};assert.equal((await folder.read('песня.mp3',3,4)).data.length,0);
assert.equal((await folder.read('песня.mp3',5,4)).data.length,0);readResult=null;
assert.equal(requests.at(-1).root,'C:\\Личное'); assert.equal(requests.at(-1).dev,'7');
const calls=requests.length;
await assert.rejects(folder.read('../тайна',0,4));await assert.rejects(folder.list('диск/../другое'));
await assert.rejects(folder.read('песня.mp3',0,131073));assert.equal(requests.length,calls);
// Вся цепочка результата подключена только к поддельному процессу.
const req=createRequire(import.meta.url),{createRelay,digest}=req('../local-pc/relay.js');
const {createReadService}=req('../local-pc/read-service.js');
const {createOwnerReadTransport}=req('../local-pc/owner-read-transport.js');
const {checkOwnerFile}=req('../local-pc/owner-file-check.js');
const deviceId='1'.repeat(32),token='2'.repeat(64),secret=Uint8Array.from(crypto.randomBytes(32));
const relay=createRelay();relay.register('owner',deviceId,digest(token));
const agent=createReadService({folder:hashFolder,hashFile:hashFolder.hashFile,secret,deviceId});
const owner=createOwnerReadTransport({secret,deviceId,
  async sendRequest({requestId,packet}){relay.request('owner',deviceId,requestId,packet);const job=relay.next(deviceId,token);
    const result=await agent.handle(job.requestId,job.packet);relay.reply(deviceId,token,requestId,job.claim,result);return {ok:true};},
  async getResult({requestId}){return relay.result('owner',deviceId,requestId);},
  async acknowledge({requestId}){relay.acknowledge('owner',deviceId,requestId);return {ok:true};}
});
hashResult={hash:crypto.createHash('sha256').update(Buffer.from([1,2,3])).digest('hex'),size:3,modified:'2026-01-01T00:00:00.000Z',version:'a'.repeat(64)};
const j=await owner.prepareFileHash('песня.mp3');await owner.submit(j);const marked=await owner.receive(j);
const assembled=await checkOwnerFile({allowed:true,size:marked.size,expectedHash:marked.hash,expectedVersion:marked.version,expectedModified:marked.modified,
  async read({offset,length,version}){const part=await owner.prepareRead('песня.mp3',offset,length,version);await owner.submit(part);return owner.receive(part);}});
assert.deepEqual([...assembled.data],[1,2,3]);hashResult=null;
bad=true;await assert.rejects(folder.list(''));await assert.rejects(folder.listFailOnSkipped(''));await assert.rejects(folder.read('песня.mp3',0,4));
bad=false;fail=true;await assert.rejects(hashFolder.hashFile('песня.mp3'),e=>!e.message.includes('личный путь'));
await assert.rejects(folder.list(''),e=>!e.message.includes('личный путь'));
await assert.rejects(folder.listFailOnSkipped(''),e=>!e.message.includes('личный путь'));
const cs=fs.readFileSync(new URL('../local-pc/windows-safe-folder.cs',import.meta.url),'utf8');
assert.match(cs,/OPEN_REPARSE/);assert.match(cs,/GetFinalPathNameByHandleW/);assert.match(cs,/SHARE_READ \| SHARE_WRITE/);
assert.match(cs,/Id\(RootInfo\)!=ino/);assert.match(cs,/Ссылка или неверный тип/);
assert.match(cs,/public static SnapshotResult SnapshotLocked/);assert.match(cs,/public static HashResult HashLocked/);assert.match(cs,/MAX_HASH_FILE = 8 \* 1024 \* 1024/);
assert.match(cs,/public static ListResult ListFailOnSkipped/);assert.match(cs,/if\(failOnSkipped\)throw/);
console.log('local-pc-windows-safe-folder: вход и обработка ошибок проверены с заглушкой; реальная Windows и гонки не проверены');
