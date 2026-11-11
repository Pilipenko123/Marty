// Запускается только тестом local-pc-http.mjs; ключ и токен приходят по IPC.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createOwnerHttp}=require('../../local-pc/owner-http.js');
const {createOwnerReadTransport}=require('../../local-pc/owner-read-transport.js');
function message(){return new Promise(resolve=>process.once('message',resolve));}
try {
  const {base,token,deviceId,secret}=await message();
  globalThis.location=new URL(base);
  const nativeFetch=globalThis.fetch;globalThis.fetch=(url,options)=>nativeFetch(new URL(url,base),options);
  const http=createOwnerHttp({deviceId,getToken:()=>token,timeoutMs:5000});
  const transport=createOwnerReadTransport({secret:Uint8Array.from(secret),deviceId,...http});
  const job=await transport.prepareRead('своё.txt',0,100);
  await transport.submit(job);assert.equal(await transport.receive(job),null);
  process.send({step:'submitted'});const answer=await message();assert.equal(answer.step,'processed');
  const data=await transport.receive(job);assert.equal(Buffer.from(data.data).toString(),'Личные данные');
  process.send({step:'done'});process.disconnect();
} catch(e){console.error(e);process.exitCode=1;process.disconnect();}
