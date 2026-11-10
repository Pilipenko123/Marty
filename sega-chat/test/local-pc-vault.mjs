// Проверка обёртки с поддельным процессом, НЕ проверка DPAPI/PowerShell.
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const {createWindowsVault}=createRequire(import.meta.url)('../local-pc/windows-vault.js');
assert.throws(()=>createWindowsVault({platform:'linux'}));
let saved=null, command=null, shouldFail=false, hang=false, killed=false;
function spawnFake(name,args,opts) {
  command={name,args,opts};
  const p=new EventEmitter(); p.stdin=new PassThrough();p.stdout=new PassThrough();p.stderr=new PassThrough();
  p.kill=()=>{killed=true;};
  const chunks=[];p.stdin.on('data',c=>chunks.push(c));p.stdin.on('end',()=>{
    if(hang)return;
    if(shouldFail){p.stderr.write('секрет из ошибки');p.emit('close',1);return;}
    if(args.at(-1)==='save'){saved=JSON.parse(Buffer.concat(chunks).toString('utf8'));p.stdout.write('{"ok":true}');}
    else p.stdout.write(JSON.stringify(saved?{exists:true,data:saved}:{exists:false}));
    p.emit('close',0);
  });
  return p;
}
const v=createWindowsVault({platform:'win32',spawnProcess:spawnFake,timeoutMs:100});
assert.equal(await v.load(),null);
const data={secret:'очень личный секрет',path:'C:\\Фото'};
await v.save(data);assert.deepEqual(await v.load(),data);
assert.equal(command.name,'powershell.exe'); assert(command.args.includes('-NonInteractive'));
assert(!command.args.join(' ').includes(data.secret));
assert(!JSON.stringify(command.opts).includes(data.secret));
shouldFail=true;
await assert.rejects(v.load(),e=>!e.message.includes('секрет из ошибки'));
shouldFail=false;hang=true;
await assert.rejects(v.load());assert(killed);
const src=fs.readFileSync(new URL('../local-pc/windows-vault.ps1',import.meta.url),'utf8');
assert.match(src,/ProtectedData\]::Protect/);assert.match(src,/DataProtectionScope\]::CurrentUser/);
assert.match(src,/SetAccessRuleProtection\(\$true, \$false\)/);assert.match(src,/\[System\.IO\.File\]::Replace/);
console.log('local-pc-vault: передача данных через канал и обработка отказов проверены с поддельным процессом; DPAPI на Windows не проверен');
