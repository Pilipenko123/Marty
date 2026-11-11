import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const {runHelper}=createRequire(import.meta.url)('../local-pc/windows-helper.js');
await assert.rejects(runHelper({platform:'linux'}));
await assert.rejects(runHelper({platform:'win32'}),/недоступен/);
let accessed=0;
await assert.rejects(runHelper({platform:'win32',vault:{async load(){accessed++;}}}),/недоступен/);
assert.equal(accessed,0); // отсутствие зависимостей не открывает хранилище
const launched=spawnSync(process.execPath,[fileURLToPath(new URL('../local-pc/windows-helper.js',import.meta.url))],{encoding:'utf8'});
assert.equal(launched.status,1);assert.match(launched.stderr,/ещё в разработке/);assert.equal(launched.stdout,'');
let prepared=0, started=0, wizard=0, stopped=0;
const vault={async load(){return null}}, coordinator={async prepare(code,folder){prepared++;assert.equal(code,'secret');assert.equal(folder,'C:\\folder')},async tick(){}};
const runnerFactory=()=>({async start(){started++},async stop(){stopped++}});
assert.equal(await runHelper({platform:'win32',vault,coordinator,runnerFactory,wizard:async()=>{wizard++;return null}}),'cancelled');
assert.equal(prepared,0);assert.equal(started,0);
assert.equal(await runHelper({platform:'win32',vault,coordinator,runnerFactory,wizard:async()=>{wizard++;return {code:'secret',folder:'C:\\folder'}}}),'stopped');
assert.equal(prepared,1);assert.equal(started,1);
assert.equal(await runHelper({platform:'win32',vault:{async load(){return {configured:true}}},coordinator,runnerFactory,wizard:async()=>{throw new Error('unexpected')}}),'stopped');
assert.equal(prepared,1);assert.equal(started,2);assert.equal(stopped,0);
for(const invalid of [undefined,false,'',0,[]]) {
  await assert.rejects(runHelper({platform:'win32',vault:{async load(){return invalid}},coordinator,runnerFactory,wizard:async()=>{wizard++;return null}}),/повреждены/);
}
assert.equal(prepared,1);assert.equal(started,2);assert.equal(wizard,2);
console.log('local-pc-helper: отмена и повторный запуск проверены с заглушками, не на Windows');
