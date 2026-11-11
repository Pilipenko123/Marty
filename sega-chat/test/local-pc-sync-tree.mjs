// Только представление переданных состояний; не проверка дисков или Windows.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {syncTreeStatuses}=createRequire(import.meta.url)('../local-pc/sync-status.js');
const flags={online:true,peerOnline:true,enabled:true,scanned:true,scanVerified:true,treeComplete:true};
const d=(path,extra={})=>({path,type:'dir',state:'synced',verified:true,...extra});
const f=(path,extra={})=>({path,type:'file',state:'synced',verified:true,...extra});
const build=(items,extra={})=>syncTreeStatuses({...flags,items,...extra});
const status=(tree,path)=>tree.items.find(x=>x.path===path).status;
let entries=[d('docs'),d('docs/empty'),d('docs/nested'),f('docs/nested/a'),f('другой')];
let tree=build(entries);assert.equal(tree.overall.state,'synced');
for(const x of tree.items)assert.equal(x.status.icon,'check');
assert.equal(build([]).overall.state,'synced');
entries=[d('docs'),d('docs/empty'),d('docs/nested'),f('docs/nested/a',{state:'pending'}),f('другой')];
tree=build(entries);
assert.equal(status(tree,'docs').state,'pending');assert.equal(status(tree,'docs/nested').state,'pending');
assert.equal(status(tree,'docs/empty').state,'synced');assert.equal(status(tree,'другой').state,'synced');
assert.equal(tree.overall.state,'pending');assert.equal(status(tree,'docs').canForce,true);
// Отдельный измеренный ход файла не подменяет ход целой папки или всего окна.
entries=[d('docs'),f('docs/a',{state:'running',progress:{done:25,total:100}}),f('другой')];
tree=build(entries,{progress:{done:60,total:100}});
assert.equal(status(tree,'docs/a').percent,25);assert.equal(status(tree,'docs').state,'running');
assert.equal(status(tree,'docs').percent,undefined);assert.equal(tree.overall.percent,60);
assert.equal(status(tree,'другой').state,'synced');assert.equal(status(tree,'docs').canForce,false);
assert.equal(build(entries).overall.percent,undefined);
entries=[d('docs'),f('docs/a',{verified:false}),f('другой')];tree=build(entries);
assert.equal(status(tree,'docs').state,'checking');assert.equal(status(tree,'docs/a').state,'checking');
assert.equal(status(tree,'другой').icon,'check');assert.equal(tree.overall.state,'checking');
tree=build([d('docs',{verified:false}),f('docs/a')]);assert.equal(status(tree,'docs').state,'checking');assert.equal(status(tree,'docs/a').state,'synced');
for(const change of [{treeComplete:false},{treeComplete:undefined},{scanVerified:false},{scanned:false}]) {
  tree=build([d('docs'),f('docs/a')],change);
  assert.equal(tree.overall.state,'checking');assert(tree.items.every(x=>x.status.state==='checking'));
}
assert.equal(build([],{treeComplete:false}).overall.state,'checking');
tree=build([d('docs'),f('docs/a',{state:'pending'})],{treeComplete:false});
assert.equal(status(tree,'docs').state,'pending');assert.equal(tree.overall.state,'pending');
tree=build([d('docs'),f('docs/a',{state:'running'})],{online:false});
assert.equal(tree.overall.label,'Нет соединения');assert(tree.items.every(x=>x.status.label==='Нет соединения' && x.status.canForce===false));
tree=build([d('docs'),f('docs/a',{state:'running'})],{peerOnline:false});assert(tree.items.every(x=>x.status.state==='peer-offline'));
tree=build([d('docs'),f('docs/a',{state:'pending'})],{enabled:false});assert(tree.items.every(x=>x.status.state==='disabled' && x.status.canForce===false));
// Ошибка/конфликт/неизвестное состояние не маскируются зелёной галочкой.
tree=build([d('docs'),f('docs/a',{state:'error'}),f('docs/b',{state:'running'}),d('free'),f('free/c',{state:'error'})]);
assert.equal(status(tree,'docs').state,'error');assert.equal(status(tree,'docs').canForce,false);
assert.equal(tree.overall.canForce,false);assert.equal(status(tree,'free').canForce,true);
tree=build([d('docs'),f('docs/a',{state:'conflict'}),f('docs/b',{state:'error'})]);assert.equal(status(tree,'docs').state,'conflict');
tree=build([d('docs'),f('docs/a',{state:'unexpected'}),f('docs/b',{state:'conflict'})]);assert.equal(status(tree,'docs').state,'checking');assert.equal(tree.overall.state,'checking');
for(const bad of [null,[f('../x')],[f('x'),f('x')],[f('X'),f('x')],[f('x/y')],[f('x'),f('x/y')],[{path:'x',type:'link',state:'synced',verified:true}]]) {
  assert.throws(()=>build(bad));
}
// Полученные подписи не изменяют вход и независимы от порядка списка.
entries=[f('docs/a',{state:'pending'}),d('docs'),f('другой')];const original=JSON.stringify(entries);tree=build(entries);
assert.equal(status(tree,'docs').state,'pending');assert.equal(JSON.stringify(entries),original);
// Много независимых папок обрабатываются без полного обхода каждого поддерева.
const many=[];for(let i=0;i<6000;i++){const name='folder'+String(i).padStart(5,'0');many.push(d(name),f(name+'/file',{state:i===420?'pending':'synced'}));}
tree=build(many);assert.equal(tree.items.length,12000);assert.equal(status(tree,'folder00420').state,'pending');
assert.equal(status(tree,'folder00421').state,'synced');assert.equal(tree.overall.state,'pending');
assert.throws(()=>build(Array.from({length:20001},(_,i)=>f('f'+i))),/список/);
console.log('local-pc-sync-tree: состояния вложенных папок и ограничения проверены в памяти, без интерфейса и Windows');
