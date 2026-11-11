import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {reviewGroupDeletions,createDeletionRecheck}=createRequire(import.meta.url)('../local-pc/multi-trash-review');
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
// Без данных об идентичности перенос или переименование выглядит как потеря
// старого пути и появление нового. Не выдавать такое за кандидат удаления.
const renamed=build();drop(renamed[0],'b');renamed[0].snapshot.push(file('renamed',1));
assert.deepEqual(run(renamed),{candidates:[],conflicts:[{path:'b'}]});
const renamedTree=build();drop(renamedTree[1],'docs');renamedTree[1].snapshot.push(dir('papers'),dir('papers/sub'),file('papers/sub/a'));
assert.deepEqual(run(renamedTree),{candidates:[],conflicts:[{path:'docs'}]});
// Даже независимое добавление задерживает другие удаления: это ограничение
// опыта, а не желаемое поведение будущего продукта.
const unrelatedNew=build();drop(unrelatedNew[0],'b');unrelatedNew[3].snapshot.push(file('unrelated'));
assert.deepEqual(run(unrelatedNew),{candidates:[],conflicts:[{path:'b'}]});
const beforeRename=createDeletionRecheck({enabled:true,baseConfirmed:true,base,members:(()=>{const m=build();drop(m[0],'b');return m;})()});
assert.equal(beforeRename.isCurrent(beforeRename.candidates[0],{enabled:true,baseConfirmed:true,base,members:renamed}),false);
assert.deepEqual(run(build()),{candidates:[],conflicts:[]});
const offline=build();drop(offline[0],'b');offline[4].online=false;assert.throws(()=>run(offline));
const incomplete=build();drop(incomplete[0],'b');incomplete[5].complete=false;assert.throws(()=>run(incomplete));
assert.throws(()=>run(members,{enabled:false}));assert.throws(()=>run(members,{baseConfirmed:false}));
assert.throws(()=>run(members,{base:undefined}));assert.throws(()=>run([members[0],members[0]]));
assert.throws(()=>run(build().map((m,i)=>i===1?{...m,snapshot:[file('../bad')]}:m)));
// Проверяем прежнюю сводку на свежих данных. Это НЕ разрешение на корзину.
const options=m=>({enabled:true,baseConfirmed:true,base:base.map(x=>({...x})),members:m});
const makeReview=()=>{const m=build();drop(m[0],'docs');return createDeletionRecheck(options(m));};
const fresh=()=>{const m=build();drop(m[0],'docs');return m;};
const saved=makeReview(),candidate=saved.candidates[0];assert(Object.isFrozen(candidate));assert(Object.isFrozen(candidate.presentOn[0]));
assert(saved.isCurrent(candidate,options(fresh())));assert.equal(saved.conflicts.length,0);
const editedChild=fresh();editedChild[4].snapshot=editedChild[4].snapshot.map(x=>x.path==='docs/sub/a'?file(x.path,9):x);
assert.equal(saved.isCurrent(candidate,options(editedChild)),false);
const newChild=fresh();newChild[5].snapshot.push(file('docs/sub/new',3));assert.equal(saved.isCurrent(candidate,options(newChild)),false);
const restored=fresh();restored[0].snapshot=base.map(x=>({...x}));assert.equal(saved.isCurrent(candidate,options(restored)),false);
const extraDeletion=fresh();drop(extraDeletion[1],'docs');assert.equal(saved.isCurrent(candidate,options(extraDeletion)),false);
const changeGroup=fresh();changeGroup[5].id='newcloud';assert.equal(saved.isCurrent(candidate,options(changeGroup)),false);
const changeKind=fresh();changeKind[5].kind='google';assert.equal(saved.isCurrent(candidate,options(changeKind)),false);
const reordered=fresh();reordered.reverse();assert.equal(saved.isCurrent(candidate,options(reordered)),false); // осторожный отказ
const changedBase=options(fresh());changedBase.base=changedBase.base.map(x=>x.path==='b'?file('b',7):x);
assert.equal(saved.isCurrent(candidate,changedBase),false);
const reorderBase=options(fresh());reorderBase.base.reverse();assert(saved.isCurrent(candidate,reorderBase));
const unrelated=fresh();unrelated[2].snapshot=unrelated[2].snapshot.map(x=>x.path==='b'?file('b',3):x);
assert(saved.isCurrent(candidate,options(unrelated))); // независимое изменение вне дерева
const replaced=fresh();replaced[3].snapshot=replaced[3].snapshot.filter(x=>x.path!=='docs' && !x.path.startsWith('docs/'));replaced[3].snapshot.push(file('docs',5));
assert.equal(saved.isCurrent(candidate,options(replaced)),false);
assert.equal(saved.isCurrent({...candidate,path:'b'},options(fresh())),false);
const noConnection=fresh();noConnection[4].online=false;assert.throws(()=>saved.isCurrent(candidate,options(noConnection)));
const partial=fresh();partial[5].complete=false;assert.throws(()=>saved.isCurrent(candidate,options(partial)));
assert.throws(()=>saved.isCurrent(candidate,{...options(fresh()),enabled:false}));
// Любой участник, включая обе условные облачные стороны, может стать
// недоступным либо изменить папку после первого анализа.
for(let i=0;i<kinds.length;i++){
  const setup=build();drop(setup[i],'docs');const review=createDeletionRecheck(options(setup)),c=review.candidates[0];
  const next=build();drop(next[i],'docs');assert(review.isCurrent(c,options(next)));
  const j=(i+1)%kinds.length;next[j].snapshot=next[j].snapshot.map(x=>x.path==='docs/sub/a'?file(x.path,10):x);
  assert.equal(review.isCurrent(c,options(next)),false);
  next[j].online=false;assert.throws(()=>review.isCurrent(c,options(next)));
}
// Входной объект может измениться: сохранённая база не должна поменяться вместе с ним.
const input=options(fresh()),anchored=createDeletionRecheck(input),original=anchored.candidates[0];
input.base.find(x=>x.path==='b').hash=hash(10);assert.equal(anchored.isCurrent(original,input),false);
assert(anchored.isCurrent(original,options(fresh())));
// Неверный флаг complete=true невозможно отличить от подлинного удаления по
// одним спискам: этот тест демонстрирует принципиальный предел модели.
const falselyComplete=build();drop(falselyComplete[0],'docs');
assert.equal(createDeletionRecheck(options(falselyComplete)).candidates.length,1);
// Сводка — не операции и не разрешение. Исходные данные остаются нетронутыми.
const result=run(members);assert.equal('type' in result.candidates[0],false);assert.equal('execute' in result.candidates[0],false);
assert.equal(base.length,4);assert.equal(members[4].snapshot.length,4);
console.log('local-pc-multi-trash-review: обзор удаления и конфликтов группы на фиктивных данных; настоящие корзины и синхронизация не проверены');
