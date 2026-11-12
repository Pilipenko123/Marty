// Только локальные HTTP-заглушки: нет настоящего облака или синхронизации.
import assert from 'node:assert/strict';
import http from 'node:http';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {renameFile}=require('../lib/gdrive');
const {movePath}=require('../lib/yadisk');
let mode='',base='',other='',calls=[],leaked=0,polls=0;
const attacker=http.createServer((req,res)=>{leaked++;res.end('{}');});
const server=http.createServer((req,res)=>{
  const u=new URL(req.url,base);calls.push({method:req.method,u,auth:req.headers.authorization});
  const send=(status,data)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(data));};
  if(u.pathname==='/drive/v3/files/fileID'){
    if(mode==='lost'){req.socket.destroy();return;}
    if(mode==='cut'){res.writeHead(200,{'content-length':100});res.write('{"id":"fileID","name":"новое.txt"}');setTimeout(()=>res.destroy(),10);return;}
    if(mode==='403'||mode==='503'||mode==='429')return send(Number(mode),{});
    if(mode==='bad-json'){res.writeHead(200);res.end('bad');return;}
    if(mode==='204'){res.writeHead(204);return res.end();}
    return send(200,mode==='wrong-id'?{id:'other',name:'новое.txt'}:mode==='wrong-name'?{id:'fileID',name:'старое.txt'}:mode==='missing'?{}:{id:'fileID',name:'новое.txt'});
  }
  if(u.pathname==='/v1/disk/resources/move'){
    if(mode==='lost'){req.socket.destroy();return;}
    if(['403','503','429','200'].includes(mode))return send(Number(mode),{});
    if(mode==='201')return send(201,{href:base+'/v1/disk/resources?path=x',method:'GET',templated:false});
    const link={href:(mode==='evil'?other:base)+'/v1/disk/operations?id=abc',method:'GET',templated:false};
    if(mode==='bad-link')link.href=base+'/v1/disk/resources?id=abc';
    return send(202,mode==='missing'?{}:link);
  }
  if(u.pathname==='/v1/disk/operations'){
    polls++;
    if(mode==='lost-poll'){req.socket.destroy();return;}
    if(mode==='redirect'){res.writeHead(302,{location:other+'/leak'});return res.end();}
    return send(200,{status:mode==='pending'?'in-progress':mode==='failed'?'failed':'success'});
  }
  res.writeHead(404);res.end();
});
await new Promise(r=>attacker.listen(0,'127.0.0.1',r));other=`http://127.0.0.1:${attacker.address().port}`;
await new Promise(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${server.address().port}`;
const config={apiBase:base};
async function g(which){mode=which;calls=[];return renameFile('TEST-SECRET','google:/fileID','новое.txt',config);}
async function y(which){mode=which;calls=[];polls=0;return movePath('TEST-SECRET','disk:/старое','disk:/новое',config);}
const unknown=e=>e.status===502 && /не подтвердил переименование/.test(e.message) && /перед повторной попыткой/.test(e.message) && !e.message.includes('TEST-SECRET');
try {
  assert.equal((await g('ok')).name,'новое.txt');assert.equal(calls.length,1);assert.equal(calls[0].method,'PATCH');
  for(const state of ['wrong-id','wrong-name','missing','bad-json','204','lost','cut','503','429']){
    await assert.rejects(g(state),unknown,state);assert.equal(calls.filter(x=>x.method==='PATCH').length,1,state);
  }
  await assert.rejects(g('403'),e=>e.status===403);
  for(const state of ['201','success']){
    assert.equal((await y(state)).ok,true);assert.equal(calls.filter(x=>x.method==='POST').length,1);
    assert.equal(calls[0].u.searchParams.get('overwrite'),'false');assert.equal(polls,state==='201'?0:1);
  }
  for(const state of ['200','lost','503','429','missing','evil','bad-link','failed','pending','lost-poll','redirect']){
    await assert.rejects(y(state),unknown,state);assert.equal(calls.filter(x=>x.method==='POST').length,1,state);
    if(['missing','evil','bad-link'].includes(state))assert.equal(polls,0);
    if(state==='pending')assert.equal(polls,3);
  }
  assert.equal(leaked,0);await assert.rejects(y('403'),e=>e.status===403);
  for(const [from,to] of [['disk:/a','disk2:/b'],['disk2:/a','disk:/b'],['disk2:/a','disk4:/b'],['disk4:/a','disk4:/b'],['disk0:/a','disk0:/b'],['disk:/','disk:/b'],['disk:/a','disk:/']]){
    calls=[];await assert.rejects(movePath('TEST-SECRET',from,to,config),e=>e.status===400);assert.equal(calls.length,0);
  }
  calls=[];mode='201';assert.equal((await movePath('TEST-SECRET','disk2:/a','disk2:/b',config)).ok,true);
  assert.equal(calls[0].u.searchParams.get('from'),'disk:/a');assert.equal(calls[0].u.searchParams.get('path'),'disk:/b');
  calls=[];assert.equal((await movePath('TEST-SECRET','disk1:/a','disk:/b',config)).ok,true);assert.equal(calls.length,1);
} finally {server.closeAllConnections?.();attacker.closeAllConnections?.();await new Promise(r=>server.close(r));await new Promise(r=>attacker.close(r));}
console.log('local-pc-cloud-rename-confirmation: подтверждения и неопределённые исходы проверены локальным HTTP; реальные облака не проверены');
