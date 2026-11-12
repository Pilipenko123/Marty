// Имитированный fetch в VM: не настоящий браузер и не проверка прав сервера.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const code=fs.readFileSync(new URL('../local-pc/access-http.js',import.meta.url),'utf8');
const token='a'.repeat(48),other='b'.repeat(48),rid='c'.repeat(32),seen=[];
const response=(data,options={})=>new Response(typeof data==='string'?data:JSON.stringify(data),{status:200,headers:{'content-type':'application/json'},...options});
let handler=async (url,opt)=>{seen.push({url,opt});return response({state:'none'});};
const ctx=vm.createContext({location:new URL('https://local.example'),URL,AbortController,TextDecoder,Uint8Array,setTimeout,clearTimeout,fetch:(...a)=>handler(...a)});
vm.runInContext(code,ctx);const {createAccessHttp,MAX_RESPONSE}=ctx.SegaLocalAccessHttp;
const client=createAccessHttp({getToken:()=>token,timeoutMs:500});
assert.equal((await client.getStatus()).state,'none');assert.equal(seen[0].url,'https://local.example/api/pc-lab/access');
assert.equal(seen[0].opt.method,'GET');assert.equal(seen[0].opt.headers.Authorization,'Bearer '+token);
assert.equal(seen[0].opt.redirect,'error');assert.equal(seen[0].opt.mode,'same-origin');assert.equal(seen[0].opt.credentials,'omit');
handler=async(url,opt)=>{seen.push({url,opt});return response({state:'pending'});};
assert.equal((await client.requestAccess()).state,'pending');assert.equal(seen.at(-1).url,'https://local.example/api/pc-lab/access/request');
assert.equal(seen.at(-1).opt.body,'{}');assert.equal(seen.at(-1).opt.method,'POST');
handler=async(url,opt)=>{seen.push({url,opt});return response({state:'approved'});};
assert.equal((await client.decide({userId:'alice',requestId:rid,decision:'approve',extra:'not sent'})).state,'approved');
assert.deepEqual(JSON.parse(seen.at(-1).opt.body),{userId:'alice',requestId:rid,decision:'approve'});
for(const bad of [{userId:'alice',requestId:'x',decision:'approve'},{userId:'alice',requestId:rid,decision:'revoke'}, {userId:'\n',requestId:rid,decision:'approve'}])await assert.rejects(client.decide(bad));
handler=async()=>response({requests:[],approved:[]});assert.equal((await client.listRequests()).requests.length,0);
for(const bad of ['https://other','//evil','/../x','/x?y','/x%2f','/x/','/x\\evil'])assert.throws(()=>createAccessHttp({getToken:()=>token,prefix:bad}));
const prev=ctx.location;ctx.location=new URL('http://local.example');assert.throws(()=>createAccessHttp({getToken:()=>token}));ctx.location=prev;
assert.throws(()=>createAccessHttp({getToken:()=>token,timeoutMs:1}));
await assert.rejects(createAccessHttp({getToken:()=>token+'\n'}).getStatus(),/сессии/);
for(const make of [()=>new Response('{}',{status:403}),()=>response('{}',{headers:{'content-type':'text/html'}}),()=>response('{'),
  ()=>response('{}',{headers:{'content-type':'application/json','content-length':String(MAX_RESPONSE+1)}}),()=>response('x'.repeat(MAX_RESPONSE+1)),
  ()=>response('[]'),()=>response({state:'unknown'})]){
  handler=async()=>make();await assert.rejects(client.getStatus());
}
// Только подтверждённые HTTP 401/403 помечаются как отказ в доступе.
for(const code of [401,403]){
  handler=async()=>new Response('{}',{status:code});
  await assert.rejects(client.listRequests(),e=>e.code==='ACCESS_DENIED' && !e.message.includes(token));
}
handler=async()=>new Response('{}',{status:503});await assert.rejects(client.listRequests(),e=>e.code!=='ACCESS_DENIED');
handler=async()=>response({state:'pending'});await assert.rejects(client.decide({userId:'alice',requestId:rid,decision:'approve'}));
handler=async()=>response({requests:'wrong',approved:[]});await assert.rejects(client.listRequests());
// Время ожидания ограничено даже если fetch игнорирует сигнал остановки.
handler=async()=>new Promise(()=>{});let t=Date.now();await assert.rejects(createAccessHttp({getToken:()=>token,timeoutMs:100}).getStatus(),/Нет ответа/);assert(Date.now()-t<2000);
const stop=new AbortController(),task=createAccessHttp({getToken:()=>token,timeoutMs:1000}).getStatus(stop.signal);setTimeout(()=>stop.abort(),20);
await assert.rejects(task,e=>e.name==='AbortError');const already=new AbortController();already.abort();await assert.rejects(client.getStatus(already.signal),e=>e.name==='AbortError');
// Потеря ответа после отправки не запускает повтор POST.
let sent=0;handler=async()=>{sent++;throw Error('отключение');};await assert.rejects(client.requestAccess());assert.equal(sent,1);
// Результат предыдущей сессии нельзя отдать новой; переход не делает второй запрос.
let current=token,release,started;const begun=new Promise(r=>{started=r;});sent=0;
handler=async()=>{sent++;started();await new Promise(r=>{release=r;});return response({state:'pending'});};
const session=createAccessHttp({getToken:()=>current,timeoutMs:1000});const pending=session.getStatus();await begun;current=other;release();
await assert.rejects(pending,/Сессия изменилась/);await assert.rejects(session.getStatus(),/Сессия изменилась/);assert.equal(sent,1);
console.log('local-pc-access-http-unit: origin, сессия, ошибки, лимит, таймаут и отсутствие повторов проверены в VM; браузер не проверен');
