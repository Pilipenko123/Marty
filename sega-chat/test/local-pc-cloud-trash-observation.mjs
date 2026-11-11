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
    if(mode==='lost'){req.socket.destroy();return;}
    if(mode==='server-error'){res.writeHead(503);res.end();return;}
    if(mode==='redirect'){res.writeHead(302,{Location:'/not-followed'});res.end();return;}
    if(u.pathname==='/v1/disk/resources'){
      res.writeHead(mode==='async'?202:204,{'Content-Type':'application/json'});res.end();return;
    }
    if(u.pathname==='/drive/v3/files/fakeID'){
      res.writeHead(200,{'Content-Type':'application/json'});
      const body=mode==='bad-json'?'not json':JSON.stringify(mode==='missing-id'?{trashed:true}:mode==='missing-trashed'?{id:'fakeID'}:{id:mode==='wrong-id'?'otherID':'fakeID',trashed:mode==='string'?'true':mode!=='false'});res.end(body);return;
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
  // 202 без достоверной ссылки — неподтверждённый исход, не успех.
  mode='async';await assert.rejects(removePath('TEST-Y','disk:/file',c),e=>e.status===502 && /не подтвердил/.test(e.message));
  // Неоднозначные ответы Google и обрыв после отправки не объявляем успехом;
  // запрос не повторяется автоматически, исход требует перепроверки вручную.
  for(const state of ['false','string','missing-id','missing-trashed','wrong-id','bad-json','lost','server-error','redirect']){
    mode=state;const before=requests.length;
    await assert.rejects(trashPath('TEST-G','google:/fakeID',c),e=>e.status===502 && /не подтвердил/.test(e.message) && /перед повторной попыткой/.test(e.message));
    assert.equal(requests.length,before+1,`повтор или перенаправление: ${state}`);
  }
} finally {await new Promise(r=>server.close(r));}
console.log('local-pc-cloud-trash-observation: форма запросов и ограничения ответов проверены на фальшивом HTTP, настоящие облака не проверены');
