// Проверяет конверт, а не привязку устройств, защиту от повторов или сеть.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import vm from 'node:vm';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const c = createRequire(import.meta.url)('../local-pc/secure-channel.js');
const id='a'.repeat(32), request='b'.repeat(32), now=1_000_000, expires=now+60000;
const raw = new Uint8Array(crypto.randomBytes(32)), text = new TextEncoder().encode('Личная папка');
const packet = await c.seal(raw,id,'request',request,expires,text);
const decoded = await c.open(raw,packet,{channel:id,direction:'request',request,expires},now);
assert.equal(new TextDecoder().decode(decoded),'Личная папка');
assert(!packet.includes('Личная папка'));
assert.notEqual(await c.seal(raw,id,'request',request,expires,text), packet);
await assert.rejects(c.open(new Uint8Array(crypto.randomBytes(32)),packet,{channel:id,direction:'request',request},now));
await assert.rejects(c.open(raw,packet,{channel:id,direction:'response',request},now));
await assert.rejects(c.open(raw,packet,{channel:id,direction:'request',request:'d'.repeat(32)},now));
await assert.rejects(c.open(raw,packet,{channel:id,direction:'request',request,expires:expires+1},now));
await assert.rejects(c.open(raw,packet,{channel:id,direction:'request',request},expires+c.CLOCK_SKEW+1));
await assert.rejects(c.open(raw,packet,{channel:id,direction:'request',request},now-c.MAX_FUTURE));
const o=JSON.parse(packet); o.b=(o.b[0]==='A'?'B':'A')+o.b.slice(1);
await assert.rejects(c.open(raw,JSON.stringify(o),{channel:id,direction:'request',request},now));
const o2=JSON.parse(packet); o2.e++; // метаданные проверяются шифрованием
await assert.rejects(c.open(raw,JSON.stringify(o2),{channel:id,direction:'request',request},now));
await assert.rejects(c.seal(raw,id,'request',request,expires,new Uint8Array(c.MAX_PLAIN+1)));
await assert.rejects(c.seal(new Uint8Array(10),id,'request',request,expires,text));
// С тем же кодом в окружении без CommonJS — аналог браузера.
const sandbox = {crypto:crypto.webcrypto, TextEncoder, Uint8Array, btoa, atob, Date, JSON, Error, Number};
vm.runInNewContext(fs.readFileSync(new URL('../local-pc/secure-channel.js',import.meta.url),'utf8'), sandbox);
const browser = sandbox.SegaLocalSecureChannel;
assert.equal(new TextDecoder().decode(await browser.open(raw,packet,{channel:id,direction:'request',request},now)),'Личная папка');
const reply = await browser.seal(raw,id,'response',request,expires,text);
assert.equal(new TextDecoder().decode(await c.open(raw,reply,{channel:id,direction:'response',request},now)),'Личная папка');
console.log('local-pc-secure-channel: шифрование и совместимость конверта Node/браузер проверены');
