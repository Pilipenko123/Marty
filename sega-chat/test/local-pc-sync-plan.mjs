// Тестирует только расчёт изменений, не работу Windows или настоящей корзины.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { planSync, confirmSyncBase } = createRequire(import.meta.url)('../local-pc/sync-plan.js');
const file = (path, n) => ({ path, type:'file', hash: String(n).repeat(64), size:n });
const dir = path => ({ path, type:'dir' });
const planFlags={enabled:true,online:true,peerOnline:true,baseConfirmed:true,leftComplete:true,rightComplete:true};
const plan = (base,left,right,overrides={}) => planSync({...planFlags,base,left,right,...overrides});
const f = file('a.txt', 1), f2 = file('a.txt', 2), f3 = file('a.txt', 3);
assert.deepEqual(plan([], [], []), []);
assert.deepEqual(plan([f], [f], [f]), []);
assert.deepEqual(plan([], [f], []), [{type:'copy',from:'left',to:'right',path:'a.txt',source:{type:'file',hash:'1'.repeat(64),size:1},target:null,replaceToTrash:false}]);
assert.equal(plan([], [], [f])[0].from, 'right');
assert.equal(plan([f], [f2], [f])[0].replaceToTrash, true);
assert.equal(plan([f], [f2], [f])[0].target.hash, f.hash);
assert.equal(plan([f], [f], [f2])[0].from, 'right');
assert.deepEqual(plan([f], [f2], [f2]), []);
assert.equal(plan([f], [f2], [f3])[0].type, 'conflict');
assert.equal(plan([], [f], [f2])[0].type, 'conflict');
assert.deepEqual(plan([f], [], [f]), [{type:'trash',side:'right',missingOn:'left',path:'a.txt',expected:{type:'file',hash:f.hash,size:1},tree:false}]);
assert.equal(plan([f],[f],[])[0].missingOn,'right');
assert.equal(plan([f], [f], [])[0].side, 'left');
assert.equal(plan([f], [], [f2])[0].type, 'conflict');
assert.deepEqual(plan([f], [], []), []);
const d = dir('docs'), x = file('docs/x.txt',1), x2 = file('docs/x.txt',2), y = file('docs/y.txt',3);
assert.deepEqual(plan([d,x], [], [d,x]).map(a=>[a.type,a.path,a.side,a.tree]), [['trash','docs','right',true]]);
const folderTrash=plan([d,x],[],[d,x])[0];
assert.equal(folderTrash.missingOn,'left');assert.deepEqual(folderTrash.expectedTree,[d,x]);
const reverseTrash=plan([d,x],[d,x],[])[0];
assert.equal(reverseTrash.missingOn,'right');assert.deepEqual(reverseTrash.expectedTree,[d,x]);
assert.deepEqual(plan([d,x], [], [d,x2]).map(a=>[a.type,a.path]), [['conflict','docs']]);
assert.deepEqual(plan([d,x], [], [d,x,y]).map(a=>[a.type,a.path]), [['conflict','docs']]);
assert.deepEqual(plan([], [d,x], []).map(a=>[a.type,a.path]), [['mkdir','docs'],['copy','docs/x.txt']]);
assert.deepEqual(plan([], [d,x], [d,y]).map(a=>[a.type,a.path]), [['copy','docs/x.txt'],['copy','docs/y.txt']]);
assert.equal(plan([], [file('docs',1)], [d,x])[0].type,'conflict');
// Без включения, связи, подтверждённой базы и полного списка ОБЕИХ сторон
// план не строится, даже если передан пустой список вместо недоступного ПК.
for(const key of Object.keys(planFlags)) {
  assert.throws(()=>plan([f],[],[f],{[key]:false}),/не подтверждены/);
  assert.throws(()=>plan([f],[],[f],{[key]:undefined}),/не подтверждены/);
  assert.throws(()=>plan([f],[],[f],{[key]:'true'}),/не подтверждены/);
}
assert.throws(()=>planSync({base:[f],left:[],right:[f]}),/не подтверждены/);
assert.throws(()=>plan([f], null, [f]), /Неполный/); // нет связи не означает удаление
assert.throws(()=>plan([], [x], []), /Неполный список папок/);
assert.throws(()=>plan([], [file('../x',1)], []), /Неверный путь/);
assert.throws(()=>plan([], [file('X',1)], [file('x',1)]), /регистром/);
assert.throws(()=>plan([], [{path:'a',type:'file',hash:'x',size:1}], []), /проверки/);
assert.throws(()=>plan([], [f,f], []), /совпадают/);
// Похожие имена рядом с границей префикса не являются содержимым папки.
const near = dir('docs-'), nearFile = file('docs-/x',1);
assert.deepEqual(plan([d,x,near,nearFile], [], [d,x,near,file('docs-/x',2)])
  .map(a=>[a.type,a.path]), [['trash','docs'],['conflict','docs-']]);
const inner = dir('docs/sub'), innerFile=file('docs/sub/z',1);
assert.deepEqual(plan([d,inner,innerFile],[],[d,inner,file('docs/sub/z',2)])
  .map(a=>[a.type,a.path]), [['conflict','docs']]);
const treePlan=plan([d,inner,innerFile,near,nearFile],[],[d,inner,innerFile,near,nearFile]);
assert.deepEqual(treePlan.find(a=>a.path==='docs').expectedTree,[d,inner,innerFile]);
const mutatedFile={...innerFile};
const captured=plan([d,inner,mutatedFile],[],[d,inner,mutatedFile])[0];mutatedFile.hash='9'.repeat(64);
assert.equal(captured.expectedTree[2].hash,innerFile.hash);
// Большое количество отдельных удалённых папок не должно приводить к повторному
// полному обходу всех файлов для каждой папки; никакие операции не выполняются.
const many=[];
for(let i=0;i<6000;i++) { const p='d'+String(i).padStart(5,'0');many.push(dir(p),file(p+'/x',1)); }
const largePlan=plan(many,[],many);
assert.equal(largePlan.length,6000);
assert(largePlan.every(a=>a.type==='trash' && a.tree && a.side==='right'));
// Сравниваем результат с прямой проверкой полного дерева для разных
// вложений, удалений, дополнений и похожих префиксов имён.
let seed=8391;
const rnd=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
for(let run=0;run<80;run++) {
  const base=[], right=[], expected=new Map();
  for(let i=0;i<25;i++) {
    const p='p'+i, sub=p+'/sub', a=file(p+'/a',1), b=file(sub+'/b',1);
    base.push(dir(p),dir(sub),a,b); right.push(dir(p),dir(sub));
    const variant=rnd()%4;
    if(variant!==1)right.push(variant===2?file(p+'/a',2):a);
    right.push(b);
    if(variant===3)right.push(file(p+'/extra',3));
    expected.set(p,variant===0?'trash':'conflict');
  }
  const actions=plan(base,[],right);
  assert.equal(actions.length,expected.size);
  for(const action of actions) {
    assert.equal(action.type,expected.get(action.path));
    if(action.type==='trash') {
      assert.equal(action.missingOn,'left');
      const all=base.filter(x=>x.path===action.path || x.path.startsWith(action.path+'/'))
        .sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
      assert.deepEqual(action.expectedTree,all);
    }
  }
}

// Новую базу можно лишь предложить по одинаковым полным снимкам с обеих сторон
// после включения синхронизации и подтверждения завершения всех действий.
const flags={enabled:true,online:true,peerOnline:true,leftComplete:true,rightComplete:true,operationsComplete:true};
const confirm=(left,right,overrides={})=>confirmSyncBase({...flags,left,right,...overrides});
assert.deepEqual(confirm([x,d],[d,x]),[d,x]);
assert.deepEqual(confirm([],[]),[]);
for(const key of Object.keys(flags)) assert.throws(()=>confirm([f],[f],{[key]:false}),/не подтверждено/);
assert.throws(()=>confirm([f],[f2]),/различаются/);
assert.throws(()=>confirm([f],[]),/различаются/);
assert.throws(()=>confirm([file('X',1)],[file('x',1)]),/различаются/);
assert.throws(()=>confirm([x],[x]),/Неполный список папок/);
const original=[{...f}];const candidate=confirm(original,original); original[0].hash='2'.repeat(64);
assert.equal(candidate[0].hash,'1'.repeat(64));
console.log('local-pc-sync-plan: расчёт изменений, подтверждение кандидата базы и большие списки проверены; файлы и корзина не затронуты');
