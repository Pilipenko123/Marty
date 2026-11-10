// Сквозной опыт без настоящего HTTP, UI, Windows и записи на ПК.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const req=createRequire(import.meta.url);
const {createFolder} = req('../local-pc/folder.js');
const {createRelay,digest} = req('../local-pc/relay.js');
const secure = req('../local-pc/secure-channel.js');
const {createReadService,MAX_READ} = req('../local-pc/read-service.js');
const root=await fs.mkdtemp(path.join(os.tmpdir(),'sega-local-flow-'));
try {
  await fs.writeFile(path.join(root,'тайна.txt'),'Только моё');
  const now=2_000_000, expiry=now+30_000, id='1'.repeat(32), token='2'.repeat(64), secret=new Uint8Array(crypto.randomBytes(32));
  const relay=createRelay({clock:()=>now}); relay.register('owner',id,digest(token));
  const agent=createReadService({folder:await createFolder(root),secret,deviceId:id,clock:()=>now});
  async function roundTrip(no, data) {
    const rid=no.toString(16).padStart(32,'0');
    const p=await secure.seal(secret,id,'request',rid,expiry,new TextEncoder().encode(JSON.stringify(data)));
    assert(!p.includes('тайна'));
    relay.request('owner',id,rid,p);
    const job=relay.next(id,token); assert.equal(job.packet,p);
    const response=await agent.handle(job.requestId,job.packet);
    assert.equal(await agent.handle(job.requestId,job.packet),response);
    assert(!response.includes('тайна')); assert(!response.includes('Только моё'));
    relay.reply(id,token,rid,job.claim,response);
    const result=relay.result('owner',id,rid);
    const plain=await secure.open(secret,result.packet,{channel:id,direction:'response',request:rid,expires:expiry},now);
    return JSON.parse(new TextDecoder().decode(plain));
  }
  const list=await roundTrip(1,{op:'list',path:''});
  assert.equal(list.ok,true); assert.equal(list.items[0].name,'тайна.txt');
  const file=await roundTrip(2,{op:'read',path:'тайна.txt',offset:0,length:MAX_READ});
  assert.equal(Buffer.from(file.data,'base64').toString(),'Только моё');
  assert.equal((await roundTrip(3,{op:'read',path:'../тайна.txt',offset:0,length:10})).ok,false);
  assert.equal((await roundTrip(4,{op:'delete',path:'тайна.txt'})).ok,false);
  assert.equal(await fs.readFile(path.join(root,'тайна.txt'),'utf8'),'Только моё');
  await fs.writeFile(path.join(root,'большой.bin'), Buffer.alloc(MAX_READ+99,7));
  const first=await roundTrip(5,{op:'read',path:'большой.bin',offset:0,length:MAX_READ});
  assert.equal(first.ok,true); assert.match(first.version,/^[a-f0-9]{64}$/);
  const second=await roundTrip(6,{op:'read',path:'большой.bin',offset:MAX_READ,length:MAX_READ,version:first.version});
  assert.equal(second.ok,true); assert.equal(Buffer.from(second.data,'base64').length,99);
  assert.equal((await roundTrip(7,{op:'read',path:'большой.bin',offset:1,length:5})).ok,false);
  await fs.writeFile(path.join(root,'большой.bin'), Buffer.alloc(MAX_READ+100,8));
  assert.equal((await roundTrip(8,{op:'read',path:'большой.bin',offset:MAX_READ,length:MAX_READ,version:first.version})).ok,false);

  const rid='5'.repeat(32), p=await secure.seal(secret,id,'request',rid,expiry,new TextEncoder().encode('{"op":"list","path":""}'));
  const changed=JSON.parse(p); changed.b=(changed.b[0]==='A'?'B':'A')+changed.b.slice(1);
  await assert.rejects(agent.handle(rid,JSON.stringify(changed)));
  await assert.rejects(agent.handle('6'.repeat(32),p));
  assert.throws(()=>relay.request('other',id,'7'.repeat(32),p));
  relay.revoke('owner',id);
  assert.throws(()=>relay.next(id,token));
  console.log('local-pc-encrypted-flow: список и чтение в памяти через шифрованные сообщения, без HTTP/Windows');
} finally { await fs.rm(root,{recursive:true,force:true}); }
