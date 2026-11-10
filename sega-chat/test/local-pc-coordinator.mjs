// Только логика запуска с поддельным хранилищем и сервером; не Windows/DPAPI.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const pairing=require('../local-pc/pairing.js');
const {createCoordinator,anchorFolder}=require('../local-pc/agent-coordinator.js');
const trustedUrl='https://chat.example';
const {createFolder}=require('../local-pc/folder.js'); // только временная папка теста
const channel=require('../local-pc/secure-channel.js');
const subtle=crypto.webcrypto.subtle;
const keys=await subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
const generated=await pairing.create({url:'https://chat.example',userId:'a'.repeat(18),privateKey:keys.privateKey,publicKey:keys.publicKey});
const initial=pairing.parse(generated.code);
const root=await fs.mkdtemp(path.join(os.tmpdir(),'sega-coordinator-'));
let saved=null, activeHash=null, calls=0, claims=0, failSave=false, loseClaim=false;
const copy=o=>o?JSON.parse(JSON.stringify(o)):null;
const vault={async load(){return copy(saved)},async save(x){if(failSave) throw new Error('Хранилище недоступно');saved=copy(x)}};
const factory=({token,service})=>({
  async step(){calls++; if (!activeHash || crypto.createHash('sha256').update(token).digest('hex')!==activeHash) {const e=new Error('нет доступа');e.status=401;throw e;} return false;},
  async claim(h){claims++; assert(saved && saved.state==='pending'); assert.equal(token,initial.token); if(activeHash && activeHash!==h) throw new Error('already claimed');activeHash=h;if(loseClaim){loseClaim=false;throw new Error('потерян ответ')}},
});
try {
  assert.throws(()=>createCoordinator({vault}),/лабораторные зависимости/);
  assert.throws(()=>createCoordinator({vault,transportFactory:factory,folderFactory:createFolder}),/лабораторные зависимости/);
  assert.throws(()=>createCoordinator({vault,transportFactory:factory,folderFactory:createFolder,anchor:anchorFolder}),/адрес/);
  assert.throws(()=>createCoordinator({vault,transportFactory:factory,folderFactory:createFolder,anchor:anchorFolder,trustedUrl:'http://chat.example'}),/защищённый/);
  // Адрес из кода и адрес подтверждения не могут заменить независимо заданный.
  let vaultLoads=0, anchors=0;
  const untouched=createCoordinator({vault:{async load(){vaultLoads++;return null},async save(){throw new Error('не должно сохраняться')}},transportFactory:factory,folderFactory:createFolder,
    anchor:async p=>{anchors++;return anchorFolder(p)},trustedUrl});
  const alien=JSON.parse(Buffer.from(generated.code,'base64url').toString('utf8'));alien.u='https://evil.example';
  const alienCode=Buffer.from(JSON.stringify(alien)).toString('base64url');
  await assert.rejects(untouched.prepare(alienCode,root),/адрес/i);
  await assert.rejects(untouched.prepare(generated.code,root,'https://evil.example'),/адрес/i);
  assert.equal(vaultLoads,0);assert.equal(anchors,0);assert.equal(calls,0);assert.equal(claims,0);
  const c=createCoordinator({vault,transportFactory:factory,folderFactory:createFolder,anchor:anchorFolder,trustedUrl});
  await assert.rejects(c.prepare(generated.code,root,'https://other.example'));
  assert.equal(saved,null);
  failSave=true;
  await assert.rejects(c.prepare(generated.code,root,'https://chat.example'));
  assert.equal(saved,null); assert.equal(claims,0); assert.equal(calls,0);
  failSave=false;
  await c.prepare(generated.code,root,'https://chat.example');
  assert.equal(saved.state,'pending'); assert.equal(saved.setupToken,initial.token); assert.equal(claims,0);
  await assert.rejects(c.prepare(generated.code,root,'https://chat.example'));
  loseClaim=true;
  await assert.rejects(c.tick(),/потерян ответ/);
  assert.equal(saved.state,'pending'); assert(activeHash);
  // Новый запуск после потери ответа: уже действующий токен проходит без новой привязки.
  const restart=createCoordinator({vault,transportFactory:factory,folderFactory:createFolder,anchor:anchorFolder,trustedUrl});
  assert.equal(await restart.tick(),false);
  assert.equal(saved.state,'active'); assert.equal(saved.setupToken,undefined); assert.equal(claims,1);
  assert.equal(await restart.tick(),false);
  // Подмена адреса в сохранённых настройках не должна начинать сетевой запрос
  // или проверять файлы, даже когда учётные данные и папка иначе правильные.
  let unsafeCalls=0;
  const alienSaved={...saved,url:'https://evil.example'};
  const alienRestart=createCoordinator({vault:{async load(){return copy(alienSaved)},async save(){}},
    anchor:async()=>{unsafeCalls++;throw new Error('не должно открываться')},
    folderFactory:async()=>{unsafeCalls++;throw new Error('не должно открываться')},
    transportFactory:()=>{unsafeCalls++;throw new Error('не должно соединяться')},trustedUrl});
  await assert.rejects(alienRestart.tick(),/адрес/i);assert.equal(unsafeCalls,0);
  // Сохранённый транспорт обязан читать через объект текущего опроса, а не
  // через объект, захваченный при первом запуске; вне опроса доступа нет.
  const config=copy(saved), seen=[];let sequence=0, requestNo=100, serviceRef=null, changed=false, transports=0;
  async function ask(service) {
    const id=(requestNo++).toString(16).padStart(32,'0'), expires=Date.now()+30000;
    const packet=await channel.seal(initial.secret,initial.deviceId,'request',id,expires,new TextEncoder().encode('{"op":"list","path":""}'));
    const reply=await service.handle(id,packet);
    const plain=await channel.open(initial.secret,reply,{channel:initial.deviceId,direction:'response',request:id,expires});
    return JSON.parse(new TextDecoder().decode(plain));
  }
  const fakeAnchor=async()=>({root:config.folder,dev:config.rootDevice,ino:changed?'999':config.rootInode});
  const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}};
  const memoryVault=state=>({async load(){return copy(state)},async save(x){Object.assign(state,copy(x));if(x.setupToken===undefined)delete state.setupToken}});
  const fakeFolder=async()=>({async list(){return []},async read(){}});
  // Если создание транспорта ещё выполняется, отмена не должна запускать опрос
  // после его завершения; параллельный тик не допускается.
  let releaseFactory=deferred(), factoryEntered=deferred(), factoryCalls=0, fakePolls=0, passedSignal;
  const delayed=createCoordinator({vault:memoryVault(copy(config)),anchor:fakeAnchor,folderFactory:fakeFolder,trustedUrl,
    transportFactory:async({signal})=>{passedSignal=signal;if(++factoryCalls===1){factoryEntered.resolve();await releaseFactory.promise;}
      return {async step(){fakePolls++;return false}}}});
  const stopFactory=new AbortController(), delayedTick=delayed.tick(stopFactory.signal);
  await factoryEntered.promise;assert.equal(passedSignal,stopFactory.signal);
  await assert.rejects(delayed.tick(),/уже обрабатывается/);
  stopFactory.abort();releaseFactory.resolve();await assert.rejects(delayedTick,e=>e.name==='AbortError');assert.equal(fakePolls,0);
  assert.equal(await delayed.tick(),false);assert.equal(factoryCalls,2);assert.equal(fakePolls,1);
  await assert.rejects(delayed.tick({aborted:false}),/сигнал/);
  // Внешний транспорт может проигнорировать отмену: тик не возвращает успех
  // после его позднего ответа, но до ответа вынужден оставаться занятым.
  let polled=deferred(), finishPoll=deferred();
  const slow=createCoordinator({vault:memoryVault(copy(config)),anchor:fakeAnchor,folderFactory:fakeFolder,trustedUrl,
    transportFactory:()=>({async step(){polled.resolve();await finishPoll.promise;return true}})});
  const stopPoll=new AbortController(), slowTick=slow.tick(stopPoll.signal);await polled.promise;stopPoll.abort();
  await assert.rejects(slow.tick(),/уже обрабатывается/);finishPoll.resolve();
  await assert.rejects(slowTick,e=>e.name==='AbortError');
  // В режиме незавершённой привязки неверный ответ не подтверждает подключение.
  const pendingState={...config,state:'pending',setupToken:initial.token};let pendingSaves=0,pendingClaims=0;
  const pendingVault={async load(){return copy(pendingState)},async save(){pendingSaves++}};
  const invalid=createCoordinator({vault:pendingVault,anchor:fakeAnchor,folderFactory:fakeFolder,trustedUrl,
    transportFactory:()=>({async step(){},async claim(){pendingClaims++}})});
  await assert.rejects(invalid.tick(),/Неверный ответ опроса/);
  assert.equal(pendingSaves,0);assert.equal(pendingClaims,0);assert.equal(pendingState.state,'pending');
  // Если отмена пришла при создании транспорта привязки, claim не запускается.
  let secondFactory=deferred(), releaseSecond=deferred(), countFactories=0;
  const pending=createCoordinator({vault:pendingVault,anchor:fakeAnchor,folderFactory:fakeFolder,trustedUrl,
    transportFactory:async()=>{if(++countFactories===1)return {async step(){const e=new Error('нет доступа');e.status=401;throw e}};
      secondFactory.resolve();await releaseSecond.promise;return {async claim(){pendingClaims++}}}});
  const stopClaim=new AbortController(), pendingTick=pending.tick(stopClaim.signal);await secondFactory.promise;
  stopClaim.abort();releaseSecond.resolve();await assert.rejects(pendingTick,e=>e.name==='AbortError');
  assert.equal(pendingClaims,0);assert.equal(pendingSaves,0);
  // Остановку после уже начатого claim нельзя считать его отменой на сервере,
  // но она не должна запускать сохранение активных настроек в этом опросе.
  let claimStarted=deferred(), finishClaim=deferred();countFactories=0;
  const claiming=createCoordinator({vault:pendingVault,anchor:fakeAnchor,folderFactory:fakeFolder,trustedUrl,
    transportFactory:()=>++countFactories===1?{async step(){const e=new Error();e.status=401;throw e}}:
      {async claim(){pendingClaims++;claimStarted.resolve();await finishClaim.promise}}});
  const stopDuringClaim=new AbortController(), claimTick=claiming.tick(stopDuringClaim.signal);await claimStarted.promise;
  stopDuringClaim.abort();finishClaim.resolve();await assert.rejects(claimTick,e=>e.name==='AbortError');
  assert.equal(pendingClaims,1);assert.equal(pendingSaves,0);
  // Уже начатое сохранение может завершиться после остановки: не притворяемся,
  // что оно было отменено, и не запускаем дополнительный опрос до перезапуска.
  let saveStarted=deferred(), finishSave=deferred(), actualState=copy(pendingState), actualPolls=0;
  const duringSave=createCoordinator({vault:{async load(){return copy(actualState)},async save(x){saveStarted.resolve();await finishSave.promise;actualState=copy(x)}},
    anchor:fakeAnchor,folderFactory:fakeFolder,trustedUrl,transportFactory:()=>({async step(){actualPolls++;return false}})});
  const stopSave=new AbortController(), saveTick=duringSave.tick(stopSave.signal);await saveStarted.promise;
  stopSave.abort();finishSave.resolve();await assert.rejects(saveTick,e=>e.name==='AbortError');
  assert.equal(actualState.state,'active');assert.equal(actualState.setupToken,undefined);assert.equal(actualPolls,1);
  assert.equal(await duringSave.tick(),false);assert.equal(actualPolls,2);

  const changingFolders=async()=>{const n=++sequence;return {async list(){return [{name:'состояние-'+n}]},async read(){throw new Error('не используется')}}};
  const reuseTransport=({service})=>{transports++;serviceRef=service;return {async step(){const x=await ask(service);assert.equal(x.ok,true);seen.push(x.items[0].name);return true;}}};
  const dynamic=createCoordinator({vault:{async load(){return copy(config)},async save(){}},anchor:fakeAnchor,folderFactory:changingFolders,transportFactory:reuseTransport,trustedUrl});
  await dynamic.tick();await dynamic.tick();
  assert.deepEqual(seen,['состояние-1','состояние-2']);assert.equal(transports,1);
  assert.equal((await ask(serviceRef)).ok,false); // вне проверенного опроса папка закрыта
  changed=true;await assert.rejects(dynamic.tick(),/папка изменилась/);
  assert.equal((await ask(serviceRef)).ok,false);
  // Подмена корня папки не должна начинать сетевой запрос.
  await fs.rename(root,root+'-original'); await fs.mkdir(root);
  const oldCalls=calls;
  await assert.rejects(restart.tick(),/папка изменилась/); assert.equal(calls,oldCalls);
  await fs.rm(root,{recursive:true,force:true}); await fs.rename(root+'-original',root);
  // Повреждённая запись не должна подключаться.
  saved.key='bad'; const broken=createCoordinator({vault,transportFactory:factory,folderFactory:createFolder,anchor:anchorFolder,trustedUrl});
  await assert.rejects(broken.tick(),/повреждены/);
  console.log('local-pc-coordinator: сохранение до привязки, потеря ответа, повтор и подмена корня проверены без Windows');
} finally { await fs.rm(root,{recursive:true,force:true}); await fs.rm(root+'-original',{recursive:true,force:true}); }
