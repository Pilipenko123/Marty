// Проверка границы ввода/вывода с поддельным процессом. Не доказывает работу
// системных дескрипторов и защиты от гонок на настоящей Windows.
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const {createWindowsFolderProvider}=createRequire(import.meta.url)('../local-pc/windows-safe-folder.js');
assert.throws(()=>createWindowsFolderProvider({platform:'linux'}));
let invocation=null, requests=[], bad=false, fail=false, duplicate=false;
function spawnFake(name,args,opts){
  invocation={name,args,opts};const p=new EventEmitter();p.stdin=new PassThrough();p.stdout=new PassThrough();p.stderr=new PassThrough();p.kill=()=>{};
  const chunks=[];p.stdin.on('data',c=>chunks.push(c));p.stdin.on('end',()=>{
    const r=JSON.parse(Buffer.concat(chunks).toString());requests.push(r);
    if(fail){p.stderr.write('личный путь');p.emit('close',1);return;}
    let result;
    if(r.op==='identity')result={root:r.root,dev:'7',ino:'123'};
    else if(r.op==='list' || r.op==='listFailOnSkipped') {
      const item={name:'песня.mp3',dir:false,size:3,modified:'2026-01-01T00:00:00.000Z'};
      result={items:bad?[{name:'../постороннее',dir:false,size:1,modified:''}]:duplicate?[item,{...item,name:'ПЕСНЯ.MP3'}]:[item]};
    }
    else result={data:bad?'AA?':'AQID',size:3,modified:'2026-01-01T00:00:00.000Z',version:'a'.repeat(64)};
    p.stdout.write(JSON.stringify({ok:true,result}));p.emit('close',0);
  });return p;
}
const provider=createWindowsFolderProvider({platform:'win32',spawnProcess:spawnFake,timeoutMs:1000});
await assert.rejects(provider.anchor('C:\\'));
await assert.rejects(provider.anchor('\\\\server\\share'));
const a=await provider.anchor('C:\\Личное');assert.deepEqual(a,{root:'C:\\Личное',dev:'7',ino:'123'});
assert.equal(invocation.name,'powershell.exe');assert(!invocation.args.join(' ').includes('Личное'));
const folder=await provider.folder(a.root,a);
assert.equal((await folder.list(''))[0].name,'песня.mp3');
assert.equal((await folder.listFailOnSkipped(''))[0].name,'песня.mp3');
assert.equal(requests.at(-1).op,'listFailOnSkipped');
duplicate=true;await assert.rejects(folder.listFailOnSkipped(''),/Имена совпадают/);duplicate=false;
const got=await folder.read('песня.mp3',0,4);assert.deepEqual([...got.data],[1,2,3]);assert.match(got.version,/^[a-f0-9]{64}$/);
assert.equal(requests.at(-1).root,'C:\\Личное'); assert.equal(requests.at(-1).dev,'7');
const calls=requests.length;
await assert.rejects(folder.read('../тайна',0,4));await assert.rejects(folder.list('диск/../другое'));
await assert.rejects(folder.read('песня.mp3',0,131073));assert.equal(requests.length,calls);
bad=true;await assert.rejects(folder.list(''));await assert.rejects(folder.listFailOnSkipped(''));await assert.rejects(folder.read('песня.mp3',0,4));
bad=false;fail=true;await assert.rejects(folder.list(''),e=>!e.message.includes('личный путь'));
await assert.rejects(folder.listFailOnSkipped(''),e=>!e.message.includes('личный путь'));
const cs=fs.readFileSync(new URL('../local-pc/windows-safe-folder.cs',import.meta.url),'utf8');
assert.match(cs,/OPEN_REPARSE/);assert.match(cs,/GetFinalPathNameByHandleW/);assert.match(cs,/SHARE_READ \| SHARE_WRITE/);
assert.match(cs,/Id\(RootInfo\)!=ino/);assert.match(cs,/Ссылка или неверный тип/);
assert.match(cs,/public static ListResult ListFailOnSkipped/);assert.match(cs,/if\(failOnSkipped\)throw/);
console.log('local-pc-windows-safe-folder: вход и обработка ошибок проверены с заглушкой; реальная Windows и гонки не проверены');
