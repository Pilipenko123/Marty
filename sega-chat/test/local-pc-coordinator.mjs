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
  const c=createCoordinator({vault,transportFactory:factory,folderFactory:createFolder,anchor:anchorFolder});
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
  const restart=createCoordinator({vault,transportFactory:factory,folderFactory:createFolder,anchor:anchorFolder});
  assert.equal(await restart.tick(),false);
  assert.equal(saved.state,'active'); assert.equal(saved.setupToken,undefined); assert.equal(claims,1);
  assert.equal(await restart.tick(),false);
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
  const changingFolders=async()=>{const n=++sequence;return {async list(){return [{name:'состояние-'+n}]},async read(){throw new Error('не используется')}}};
  const reuseTransport=({service})=>{transports++;serviceRef=service;return {async step(){const x=await ask(service);assert.equal(x.ok,true);seen.push(x.items[0].name);return true;}}};
  const dynamic=createCoordinator({vault:{async load(){return copy(config)},async save(){}},anchor:fakeAnchor,folderFactory:changingFolders,transportFactory:reuseTransport});
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
  saved.key='bad'; const broken=createCoordinator({vault,transportFactory:factory,folderFactory:createFolder,anchor:anchorFolder});
  await assert.rejects(broken.tick(),/повреждены/);
  console.log('local-pc-coordinator: сохранение до привязки, потеря ответа, повтор и подмена корня проверены без Windows');
} finally { await fs.rm(root,{recursive:true,force:true}); await fs.rm(root+'-original',{recursive:true,force:true}); }
