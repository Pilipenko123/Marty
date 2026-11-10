// Только логика запуска с поддельным хранилищем и сервером; не Windows/DPAPI.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const pairing=require('../local-pc/pairing.js');
const {createCoordinator}=require('../local-pc/agent-coordinator.js');
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
  const c=createCoordinator({vault,transportFactory:factory});
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
  const restart=createCoordinator({vault,transportFactory:factory});
  assert.equal(await restart.tick(),false);
  assert.equal(saved.state,'active'); assert.equal(saved.setupToken,undefined); assert.equal(claims,1);
  assert.equal(await restart.tick(),false);
  // Подмена корня папки не должна начинать сетевой запрос.
  await fs.rename(root,root+'-original'); await fs.mkdir(root);
  const oldCalls=calls;
  await assert.rejects(restart.tick(),/папка изменилась/); assert.equal(calls,oldCalls);
  await fs.rm(root,{recursive:true,force:true}); await fs.rename(root+'-original',root);
  // Повреждённая запись не должна подключаться.
  saved.key='bad'; const broken=createCoordinator({vault,transportFactory:factory});
  await assert.rejects(broken.tick(),/повреждены/);
  console.log('local-pc-coordinator: сохранение до привязки, потеря ответа, повтор и подмена корня проверены без Windows');
} finally { await fs.rm(root,{recursive:true,force:true}); await fs.rm(root+'-original',{recursive:true,force:true}); }
