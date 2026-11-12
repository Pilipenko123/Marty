// Фальшивые облачные серверы только на localhost. Никакой настоящий Диск или
// синхронизация не проверяются. Обрезанный ответ может содержать корректный JSON,
// но незавершённое тело нельзя принимать за подтверждённую операцию.
import assert from 'node:assert/strict';
import http from 'node:http';
import {createRequire} from 'node:module';
const {trashPath,httpJSON:googleHttp}=createRequire(import.meta.url)('../lib/gdrive');
const {removePath,httpJSON:yandexHttp}=createRequire(import.meta.url)('../lib/yadisk');
let base,mode='',calls=[];
const server=http.createServer((req,res)=>{
  const u=new URL(req.url,base);calls.push({method:req.method,path:u.pathname});
  const json=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
  const cut=(status,value)=>{
    const body=JSON.stringify(value);res.writeHead(status,{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)+37});
    res.write(body);setTimeout(()=>res.destroy(),20);
  };
  if(u.pathname==='/general'){
    if(mode==='general-cut')return cut(200,{ok:true});
    if(mode==='chunked-cut'){res.writeHead(200,{'Content-Type':'application/json'});res.write('{"ok":true}');setTimeout(()=>res.destroy(),20);return;}
    if(mode==='large'){res.writeHead(200,{'Content-Type':'application/json'});res.end(Buffer.alloc(2*1024*1024+1,32));return;}
    if(mode==='slow'){res.writeHead(200,{'Content-Type':'application/json'});res.write('{');const timer=setInterval(()=>res.write(' '),25);res.on('close',()=>clearInterval(timer));return;}
    if(mode==='slow-ok'){res.writeHead(200,{'Content-Type':'application/json'});res.write('{');const timer=setTimeout(()=>res.end('\"ok\":true}'),40);res.on('close',()=>clearTimeout(timer));return;}
    return json(200,{ok:true});
  }
  if(u.pathname==='/drive/v3/files/fileID'){
    if(mode==='google-cut')return cut(200,{id:'fileID',trashed:true});
    if(mode==='google-403-cut')return cut(403,{error:{message:'fake secret'}});
    return json(200,{id:'fileID',trashed:true});
  }
  if(u.pathname==='/v1/disk/resources'){
    if(mode==='yandex-204'){res.writeHead(204);return res.end();}
    if(mode==='yandex-403-cut')return cut(403,{message:'fake secret'});
    const link={href:base+'/v1/disk/operations?id=op123',method:'GET',templated:false};
    if(mode==='yandex-delete-cut')return cut(202,link);
    return json(202,link);
  }
  if(u.pathname==='/v1/disk/operations'){
    if(mode==='yandex-poll-cut')return cut(200,{status:'success'});
    return json(200,{status:'success'});
  }
  res.writeHead(404);res.end();
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${server.address().port}`;
async function bounded(p){let timer;try{return await Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('ожидание ответа зависло')),2000);})]);}finally{clearTimeout(timer);}}
try{
  mode='normal';assert.equal((await bounded(trashPath('TEST-SECRET','google:/fileID',{apiBase:base}))).ok,true);
  mode='yandex-204';assert.equal((await bounded(removePath('TEST-SECRET','disk:/file',{apiBase:base}))).ok,true);
  mode='normal';assert.equal((await bounded(removePath('TEST-SECRET','disk:/file',{apiBase:base}))).ok,true);
  // Общие HTTP-клиенты применяются и к другим маршрутам, поэтому проверяем
  // полное тело, два вида обрыва и ограничение размера для каждого из них.
  for(const client of [googleHttp,yandexHttp]){
    mode='normal';assert.deepEqual((await bounded(client(base+'/general'))).json,{ok:true});
    // Каждый байт сбрасывает таймаут бездействия сокета, но не должен
    // удерживать запрос вечно. Ответ никогда не завершится сам.
    mode='slow';await assert.rejects(bounded(client(base+'/general',{timeout:160})),e=>!/ожидание ответа зависло/.test(e.message));
    mode='slow-ok';assert.deepEqual((await bounded(client(base+'/general',{timeout:500}))).json,{ok:true});
    for(const state of ['general-cut','chunked-cut','large']){
      mode=state;await assert.rejects(bounded(client(base+'/general')),e=>state==='large'?/большой ответ/.test(e.message):/прерван/.test(e.message),state);
    }
  }
  for(const test of ['google-cut','google-403-cut','yandex-delete-cut','yandex-403-cut','yandex-poll-cut']){
    mode=test;calls=[];const operation=test.startsWith('google')?trashPath('TEST-SECRET','google:/fileID',{apiBase:base}):removePath('TEST-SECRET','disk:/file',{apiBase:base});
    await assert.rejects(bounded(operation),e=>e.status===502 && /не подтвердил/.test(e.message) && /перед повторной попыткой/.test(e.message) && !e.message.includes('SECRET'),test);
    assert.equal(calls.filter(x=>x.method==='PATCH'||x.method==='DELETE').length,1,test+' нельзя повторять изменение');
    if(test==='yandex-delete-cut'||test==='yandex-403-cut')assert.equal(calls.filter(x=>x.path==='/v1/disk/operations').length,0);
    if(test==='yandex-poll-cut')assert.equal(calls.filter(x=>x.path==='/v1/disk/operations').length,1);
  }
}finally{server.closeAllConnections?.();await new Promise(r=>server.close(r));}
console.log('local-pc-cloud-response-truncation: обрыв тела и отсутствие повтора проверены на локальном HTTP; настоящие облака не проверены');
