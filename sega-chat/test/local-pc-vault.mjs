// Проверка обёртки с поддельным процессом, НЕ проверка DPAPI/PowerShell.
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const {createWindowsVault}=createRequire(import.meta.url)('../local-pc/windows-vault.js');
assert.throws(()=>createWindowsVault({platform:'linux'}));
for(const timeoutMs of [0,-1,60001,Infinity]) assert.throws(()=>createWindowsVault({platform:'win32',timeoutMs}));
let saved=null, command=null, shouldFail=false, hang=false, killed=false, rawOutput=null, spawned=0;
function spawnFake(name,args,opts) {
  spawned++;command={name,args,opts};
  const p=new EventEmitter(); p.stdin=new PassThrough();p.stdout=new PassThrough();p.stderr=new PassThrough();
  p.kill=()=>{killed=true;};
  const chunks=[];p.stdin.on('data',c=>chunks.push(c));p.stdin.on('end',()=>{
    if(hang)return;
    if(shouldFail){p.stderr.write('секрет из ошибки');p.emit('close',1);return;}
    if(rawOutput!==null){p.stdout.write(rawOutput);p.emit('close',0);return;}
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
// Ошибка чтения или странный ответ не превращаются в «настроек нет».
for(const text of ['{}','null','false','{"exists":false,"data":{}}','{"exists":true,"data":null}',
  '{"exists":true,"data":[],"extra":1}','{"exists":true,"data":{},"extra":1}','не JSON']) {
  rawOutput=text;await assert.rejects(v.load(),/Не удалось/);
}
for(const text of ['{}','{"ok":true,"extra":1}','{"ok":false}']) {
  rawOutput=text;await assert.rejects(v.save(data),/Не удалось/);
}
rawOutput=null;
const cyclic={};cyclic.self=cyclic;
const before=spawned;
for(const invalid of [null,undefined,false,[],cyclic,{x:1n},{toJSON(){throw new Error('секрет из toJSON')}}]) {
  await assert.rejects(v.save(invalid),e=>!e.message.includes('секрет'));
}
assert.equal(spawned,before);
shouldFail=true;
await assert.rejects(v.load(),e=>!e.message.includes('секрет из ошибки'));
shouldFail=false;hang=true;
await assert.rejects(v.load());assert(killed);
const src=fs.readFileSync(new URL('../local-pc/windows-vault.ps1',import.meta.url),'utf8');
assert.match(src,/ProtectedData\]::Protect/);assert.match(src,/DataProtectionScope\]::CurrentUser/);
assert.match(src,/SetAccessRuleProtection\(\$true, \$false\)/);assert.match(src,/\[System\.IO\.File\]::Replace/);
const loadSection=src.split("if ($Mode -eq 'load') {")[1].split('$text = [Console]::In.ReadToEnd()')[0];
assert.match(loadSection,/\[System\.IO\.File\]::GetAttributes/);
assert.match(loadSection,/FileNotFoundException/);assert.match(loadSection,/DirectoryNotFoundException/);
assert.match(loadSection,/FileAttributes\]::Directory/);assert.match(loadSection,/FileAttributes\]::ReparsePoint/);
assert.doesNotMatch(loadSection,/\[System\.IO\.File\]::Exists/);
console.log('local-pc-vault: передача данных через канал и обработка отказов проверены с поддельным процессом; DPAPI на Windows не проверен');
