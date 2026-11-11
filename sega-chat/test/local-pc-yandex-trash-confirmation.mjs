// Локальная имитация HTTP Яндекса, не настоящий Диск и не синхронизация.
import assert from 'node:assert/strict';
import http from 'node:http';
import {createRequire} from 'node:module';
const {removePath}=createRequire(import.meta.url)('../lib/yadisk');
let mode='204',requests=[],apiBase='',polls=0,attackerBase='',leaked=0;
const attacker=http.createServer((req,res)=>{leaked++;res.writeHead(200);res.end('{}');});
const server=http.createServer((req,res)=>{
  const u=new URL(req.url,apiBase);requests.push({method:req.method,url:u,auth:req.headers.authorization});
  function json(status,body){res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));}
  if(u.pathname==='/v1/disk/resources'){
    if(mode==='lost-delete'){req.socket.destroy();return;}
    if(mode==='403'){json(403,{});return;}
    if(mode==='503'){json(503,{});return;}
    if(mode==='204'){res.writeHead(204);res.end();return;}
    if(mode==='200'){json(200,{});return;}
    let link={href:apiBase+'/v1/disk/operations?id=op123',method:'GET',templated:false};
    if(mode==='path')link.href=apiBase+'/v1/disk/operations/op123';
    if(mode==='evil')link.href=attackerBase+'/v1/disk/operations?id=op123';
    if(mode==='evil-user')link.href=apiBase.replace('://','://evil@')+'/v1/disk/operations?id=op123';
    if(mode==='bad-path')link.href=apiBase+'/v1/disk/resources?id=op123';
    if(mode==='duplicate')link.href+='&id=other';
    if(mode==='extra')link.href+='&other=1';
    if(mode==='fragment')link.href+='#fragment';
    if(mode==='method')link.method='POST';
    if(mode==='template')link.templated=true;
    if(mode==='missing')link={};
    if(mode==='protocol')link.href=link.href.replace('http:', 'https:');
    if(mode==='id-characters')link.href=apiBase+'/v1/disk/operations?id=%2F';
    json(202,link);return;
  }
  if(u.pathname==='/v1/disk/operations' || u.pathname==='/v1/disk/operations/op123'){
    polls++;
    if(mode==='lost-poll'){req.socket.destroy();return;}
    if(mode==='redirect-poll'){res.writeHead(302,{location:'http://127.0.0.1:1/'});res.end();return;}
    if(mode==='bad-json'){res.writeHead(200);res.end('not json');return;}
    if(mode==='failed'){json(200,{status:'failed'});return;}
    if(mode==='weird'){json(200,{status:'unknown'});return;}
    json(200,{status:mode==='pending'||(mode==='progress'&&polls<2)?'in-progress':'success'});return;
  }
  res.writeHead(404);res.end();
});
await new Promise(r=>attacker.listen(0,'127.0.0.1',r));attackerBase=`http://127.0.0.1:${attacker.address().port}`;
await new Promise(r=>server.listen(0,'127.0.0.1',r));apiBase=`http://127.0.0.1:${server.address().port}`;
const c={apiBase};
async function run(which){mode=which;requests=[];polls=0;return removePath('TEST-Y','disk:/Фото/папка',c);}
try {
  assert.equal((await run('204')).ok,true);assert.equal(requests.length,1);
  for(const which of ['query','path','progress']){
    assert.equal((await run(which)).ok,true);assert.equal(requests.filter(r=>r.method==='DELETE').length,1);
    assert.equal(polls,which==='progress'?2:1);
    for(const r of requests){assert.equal(r.auth,'OAuth TEST-Y');if(r.method==='DELETE')assert.equal(r.url.searchParams.get('permanently'),'false');}
  }
  for(const which of ['evil','evil-user','bad-path','duplicate','extra','fragment','method','template','missing','protocol','id-characters','lost-delete','503','200',
    'failed','pending','weird','bad-json','lost-poll','redirect-poll']){
    await assert.rejects(run(which),e=>e.status===502 && /не подтвердил/.test(e.message) && /перед повторной попыткой/.test(e.message),which);
    assert.equal(requests.filter(r=>r.method==='DELETE').length,1,`удаление не должно повторяться: ${which}`);
    if(['evil','evil-user','bad-path','duplicate','extra','fragment','method','template','missing','protocol','id-characters'].includes(which))assert.equal(polls,0,which);
    if(which==='pending')assert.equal(polls,3);
  }
  assert.equal(leaked,0,'токен нельзя отправлять по адресу другого origin');
  await assert.rejects(run('403'),e=>e.status===403);
  mode='204';requests=[];await assert.rejects(removePath('TEST-Y','disk:/',c));assert.equal(requests.length,0);
} finally {await new Promise(r=>server.close(r));await new Promise(r=>attacker.close(r));}
console.log('local-pc-yandex-trash-confirmation: 204, 202 и статусы, сбои и проверка адреса испытаны на фальшивом HTTP; настоящая корзина не проверена');
