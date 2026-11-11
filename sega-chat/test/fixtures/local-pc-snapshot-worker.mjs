// Подпроцесс test/local-pc-http.mjs: секреты передаются только по IPC.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createOwnerHttp}=require('../../local-pc/owner-http.js');
const {createOwnerReadTransport}=require('../../local-pc/owner-read-transport.js');
const {createOwnerSnapshotTransfer}=require('../../local-pc/owner-snapshot-transfer.js');
function message(){return new Promise(resolve=>process.once('message',resolve));}
try {
  const {base,token,deviceId,secret}=await message();
  globalThis.location=new URL(base);
  const nativeFetch=globalThis.fetch;globalThis.fetch=(url,options)=>nativeFetch(new URL(url,base),options);
  const http=createOwnerHttp({deviceId,getToken:()=>token,timeoutMs:5000});
  const transport=createOwnerReadTransport({secret:Uint8Array.from(secret),deviceId,...http,
    async sendRequest(args){const result=await http.sendRequest(args);process.send({step:'poll'});const reply=await message();assert.equal(reply.step,'processed');return result;}
  });
  const transfer=createOwnerSnapshotTransfer({transport,timeoutMs:10000,cleanupTimeoutMs:2000,pollMs:5});
  assert.equal(await transfer.transfer({path:'своё.txt',confirmDownload:()=>false}),null);
  const result=await transfer.transfer({path:'своё.txt',confirmDownload:()=>true});
  assert.equal(Buffer.from(result.data).toString(),'Личные данные');
  process.send({step:'done'});process.disconnect();
} catch(e){console.error(e);process.exitCode=1;process.disconnect();}
