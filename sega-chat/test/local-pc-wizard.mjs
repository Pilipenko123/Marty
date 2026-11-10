// Заглушка процесса: реальная форма Windows здесь не проверяется.
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const {showWizard}=createRequire(import.meta.url)('../local-pc/windows-wizard.js');
await assert.rejects(showWizard({platform:'linux'}));
let response={ok:false}, cmd=null, failed=false;
function fake(name,args,opts){
  cmd={name,args,opts};const p=new EventEmitter();p.stdout=new PassThrough();p.stderr=new PassThrough();p.kill=()=>{};
  process.nextTick(()=>{if(failed){p.stderr.write('секрет в ошибке');p.emit('close',1)}else{p.stdout.write(JSON.stringify(response));p.emit('close',0)}});return p;
}
assert.equal(await showWizard({platform:'win32',spawnProcess:fake}),null);
response={ok:true,code:'секрет',folder:'C:\\Папка'};
assert.deepEqual(await showWizard({platform:'win32',spawnProcess:fake}),{code:'секрет',folder:'C:\\Папка'});
assert(!cmd.args.join(' ').includes('секрет'));assert.equal(cmd.opts.stdio[0],'ignore');
response={ok:true,code:13,folder:'C:\\Папка'};await assert.rejects(showWizard({platform:'win32',spawnProcess:fake}));
failed=true;await assert.rejects(showWizard({platform:'win32',spawnProcess:fake}),e=>!e.message.includes('секрет'));
const source=fs.readFileSync(new URL('../local-pc/windows-wizard.ps1',import.meta.url),'utf8');
assert.match(source,/FolderBrowserDialog/);assert.match(source,/UseSystemPasswordChar/);assert.match(source,/Проверьте данные/);
console.log('local-pc-wizard: отмена, выбор и отсутствие кода в аргументах проверены; сама форма Windows не проверена');
