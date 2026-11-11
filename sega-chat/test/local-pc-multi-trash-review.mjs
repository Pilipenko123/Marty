import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {reviewGroupDeletions}=createRequire(import.meta.url)('../local-pc/multi-trash-review');
const hash=n=>n.toString(16).padStart(64,'0');
const file=(path,n=1)=>({path,type:'file',hash:hash(n),size:n});
const dir=path=>({path,type:'dir'});
const base=[dir('docs'),dir('docs/sub'),file('docs/sub/a'),file('b')];
const kinds=['pc','pc','pc','pc','google','yandex'];
const build=()=>kinds.map((kind,i)=>({id:`m${i+1}`,kind,online:true,complete:true,snapshot:base.map(x=>({...x}))}));
const run=(members,changes={})=>reviewGroupDeletions({enabled:true,baseConfirmed:true,base,members,...changes});
const drop=(m,path)=>{m.snapshot=m.snapshot.filter(e=>e.path!==path && !e.path.startsWith(path+'/'));};
const members=build();drop(members[0],'b');
assert.deepEqual(run(members),{candidates:[{path:'b',entryType:'file',missingOn:['m1'],presentOn:[
  {id:'m2',kind:'pc'},{id:'m3',kind:'pc'},{id:'m4',kind:'pc'},{id:'m5',kind:'google'},{id:'m6',kind:'yandex'}]}],conflicts:[]});
// Одно дерево — одна сводка; нет отдельных предложений для его потомков.
const tree=build();drop(tree[1],'docs');
assert.deepEqual(run(tree).candidates,[{path:'docs',entryType:'dir',missingOn:['m2'],presentOn:[
  {id:'m1',kind:'pc'},{id:'m3',kind:'pc'},{id:'m4',kind:'pc'},{id:'m5',kind:'google'},{id:'m6',kind:'yandex'}]}]);
const conflict=build();drop(conflict[0],'docs');conflict[4].snapshot=conflict[4].snapshot.map(e=>e.path==='docs/sub/a'?file(e.path,2):e);
assert.deepEqual(run(conflict),{candidates:[],conflicts:[{path:'docs'}]});
const added=build();drop(added[0],'docs');added[5].snapshot.push(file('docs/sub/новый',2));
assert.deepEqual(run(added),{candidates:[],conflicts:[{path:'docs'}]});
const edited=build();drop(edited[2],'b');edited[4].snapshot=edited[4].snapshot.map(e=>e.path==='b'?file('b',2):e);
assert.deepEqual(run(edited),{candidates:[],conflicts:[{path:'b'}]});
const nested=build();drop(nested[0],'docs/sub');drop(nested[2],'b');
assert.deepEqual(run(nested).candidates.map(x=>x.path),['b','docs/sub']);
assert.equal(run(nested).candidates.find(x=>x.path==='docs/sub').entryType,'dir');
// Удаление одного файла не маскирует конфликт другого.
const mixed=build();drop(mixed[0],'b');drop(mixed[1],'docs/sub/a');
mixed[5].snapshot=mixed[5].snapshot.map(e=>e.path==='docs/sub/a'?file(e.path,8):e);
assert.deepEqual(run(mixed).candidates.map(x=>x.path),['b']);assert.deepEqual(run(mixed).conflicts,[{path:'docs/sub/a'}]);
const noTargets=build();noTargets.forEach(m=>drop(m,'b'));assert.deepEqual(run(noTargets),{candidates:[],conflicts:[]});
const oneTarget=build();oneTarget.slice(0,-1).forEach(m=>drop(m,'b'));
assert.deepEqual(run(oneTarget).candidates[0].presentOn,[{id:'m6',kind:'yandex'}]);
assert.deepEqual(run(oneTarget).candidates[0].missingOn,['m1','m2','m3','m4','m5']);
const additions=build();additions[0].snapshot.push(file('new'));assert.deepEqual(run(additions),{candidates:[],conflicts:[]});
assert.deepEqual(run(build()),{candidates:[],conflicts:[]});
const offline=build();drop(offline[0],'b');offline[4].online=false;assert.throws(()=>run(offline));
const incomplete=build();drop(incomplete[0],'b');incomplete[5].complete=false;assert.throws(()=>run(incomplete));
assert.throws(()=>run(members,{enabled:false}));assert.throws(()=>run(members,{baseConfirmed:false}));
assert.throws(()=>run(members,{base:undefined}));assert.throws(()=>run([members[0],members[0]]));
assert.throws(()=>run(build().map((m,i)=>i===1?{...m,snapshot:[file('../bad')]}:m)));
// Сводка — не операции и не разрешение. Исходные данные остаются нетронутыми.
const result=run(members);assert.equal('type' in result.candidates[0],false);assert.equal('execute' in result.candidates[0],false);
assert.equal(base.length,4);assert.equal(members[4].snapshot.length,4);
console.log('local-pc-multi-trash-review: обзор удаления и конфликтов группы на фиктивных данных; настоящие корзины и синхронизация не проверены');
