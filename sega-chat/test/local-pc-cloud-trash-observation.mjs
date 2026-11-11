// Проверка текущих облачных функций против локального фальшивого сервера.
// Это НЕ проверка настоящей корзины, API провайдера или синхронизации.
import assert from 'node:assert/strict';
import http from 'node:http';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {removePath}=require('../lib/yadisk');
const {trashPath}=require('../lib/gdrive');
const requests=[];let mode='ok';
const server=http.createServer((req,res)=>{
  const parts=[];req.on('data',c=>parts.push(c));req.on('end',()=>{
    const u=new URL(req.url,'http://example.invalid');requests.push({method:req.method,url:u,body:Buffer.concat(parts).toString()});
    if(mode==='deny'){res.writeHead(403,{'Content-Type':'application/json'});res.end('{}');return;}
    if(u.pathname==='/v1/disk/resources'){
      res.writeHead(mode==='async'?202:204,{'Content-Type':'application/json'});res.end();return;
    }
    if(u.pathname==='/drive/v3/files/fakeID'){
      res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({id:'fakeID',trashed:mode!=='false'}));return;
    }
    res.writeHead(404);res.end();
  });
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const c={apiBase:`http://127.0.0.1:${server.address().port}`};
try {
  await removePath('TEST-Y','disk:/Фото/снимок.jpg',c);
  assert.equal(requests[0].method,'DELETE');assert.equal(requests[0].url.searchParams.get('path'),'disk:/Фото/снимок.jpg');
  assert.equal(requests[0].url.searchParams.get('permanently'),'false');
  await trashPath('TEST-G','google:/fakeID',c);
  assert.equal(requests[1].method,'PATCH');assert.deepEqual(JSON.parse(requests[1].body),{trashed:true});
  const n=requests.length;await assert.rejects(removePath('TEST-Y','disk:/',c));await assert.rejects(trashPath('TEST-G','google:/root',c));assert.equal(requests.length,n);
  mode='deny';await assert.rejects(removePath('TEST-Y','disk:/file',c));await assert.rejects(trashPath('TEST-G','google:/fakeID',c));
  // Наблюдаем важные ограничения нынешних общих функций: для Яндекса 202
  // принимается как успех без наблюдения результата операции; для Google
  // возвращается ok даже когда ответ не подтвердил trashed:true. Эти функции
  // пока не годятся как доказательство завершения групповой синхронизации.
  mode='async';assert.equal((await removePath('TEST-Y','disk:/file',c)).ok,true);
  mode='false';assert.equal((await trashPath('TEST-G','google:/fakeID',c)).ok,true);
} finally {await new Promise(r=>server.close(r));}
console.log('local-pc-cloud-trash-observation: форма запросов и ограничения ответов проверены на фальшивом HTTP, настоящие облака не проверены');
