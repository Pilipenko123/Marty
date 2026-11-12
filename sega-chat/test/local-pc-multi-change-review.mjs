// Сводки только на фиктивных ID/снимках; реальные действия не выполняются.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {reviewGroupChanges}=require('../local-pc/multi-change-review');
const {reviewGroupDeletions}=require('../local-pc/multi-trash-review');
const id=n=>n.toString(16).padStart(32,'0'),hash=n=>n.toString(16).padStart(64,'0');
const file=(path,n,h=1)=>({path,objectId:id(n),type:'file',size:h,hash:hash(h)});
const dir=(path,n)=>({path,objectId:id(n),type:'dir'});
const base=[dir('docs',1),file('docs/a',2),file('old',3),file('other',4,4)];
const kinds=['pc','pc','pc','pc','google','yandex'];
const build=()=>kinds.map((kind,i)=>({id:`m${i+1}`,kind,online:true,complete:true,snapshot:base.map(x=>({...x}))}));
const opts=m=>({enabled:true,baseConfirmed:true,base,members:m});
const rename=(m,a,b)=>{m.snapshot=m.snapshot.map(x=>x.path===a||x.path.startsWith(a+'/')?{...x,path:b+x.path.slice(a.length)}:x);};
const remove=(m,p)=>{m.snapshot=m.snapshot.filter(x=>x.path!==p && !x.path.startsWith(p+'/'));};
const run=m=>reviewGroupChanges(opts(m));
assert.deepEqual(run(build()),{renames:[],deletions:{candidates:[],conflicts:[]}});
for(let i=0;i<kinds.length;i++){
  const m=build();rename(m[i],'old','new');const result=run(m);
  assert.equal(result.renames.length,1);assert.equal(result.renames[0].state,'candidate');assert.equal(result.renames[0].renamedBy[0],`m${i+1}`);
  assert.deepEqual(result.deletions,{candidates:[],conflicts:[{path:'old'}]});
  const d=build();rename(d[i],'docs','papers');const tree=run(d);
  assert.equal(tree.renames.length,1);assert.equal(tree.renames[0].type,'dir');assert.deepEqual(tree.deletions,{candidates:[],conflicts:[{path:'docs'}]});
}
// Несвязанное удаление также задерживается при переименовании.
const concurrent=build();rename(concurrent[0],'old','new');remove(concurrent[2],'other');
assert.deepEqual(run(concurrent).deletions,{candidates:[],conflicts:[{path:'old'},{path:'other'}]});
const divergent=build();rename(divergent[0],'old','new');rename(divergent[4],'old','othername');
assert.equal(run(divergent).renames[0].state,'conflict');assert.equal(run(divergent).deletions.candidates.length,0);
// Переместили под уже существовавшее имя: нового пути нет, поэтому анализ
// только по путям может предложить удаление. Сводка с ID откладывает его.
const reuse=build();remove(reuse[0],'other');rename(reuse[0],'old','other');
assert.deepEqual(reviewGroupDeletions(opts(reuse)).candidates.map(x=>x.path),['old']);
const reviewed=run(reuse);assert.equal(reviewed.renames[0].state,'conflict');assert.equal(reviewed.deletions.candidates.length,0);
assert(reviewed.deletions.conflicts.some(x=>x.path==='old'));
// Новая идентичность на другом пути даже с тем же хешем: переименование не
// доказано, но появление нового пути не позволяет предложить удаление.
const unknown=build();remove(unknown[0],'old');unknown[0].snapshot.push(file('new',10));
assert.deepEqual(run(unknown).renames,[]);assert.deepEqual(run(unknown).deletions,{candidates:[],conflicts:[{path:'old'}]});
// И независимое добавление консервативно откладывает удаление.
const addition=build();remove(addition[0],'old');addition[5].snapshot.push(file('extra',11));assert.equal(run(addition).deletions.candidates.length,0);
// Замена объекта на прежнем пути и с теми же байтами незаметна анализу
// только по путям и хешам. ID фиктивные: это лишь консервативный сигнал.
const replacement=build();remove(replacement[0],'old');
replacement[1].snapshot=replacement[1].snapshot.map(x=>x.path==='old'?{...x,objectId:id(99)}:x);
assert.deepEqual(reviewGroupDeletions(opts(replacement)).candidates.map(x=>x.path),['old']);
assert.deepEqual(run(replacement).deletions,{candidates:[],conflicts:[{path:'old'}]});
// Даже замена другого элемента откладывает удаление без истории группы.
const unrelatedReplacement=build();remove(unrelatedReplacement[0],'old');
unrelatedReplacement[4].snapshot=unrelatedReplacement[4].snapshot.map(x=>x.path==='other'?{...x,objectId:id(100)}:x);
assert.deepEqual(run(unrelatedReplacement).deletions,{candidates:[],conflicts:[{path:'old'}]});
// Замена без удаления не создаёт ложный кандидат или конфликт удаления.
const justReplacement=build();justReplacement[2].snapshot=justReplacement[2].snapshot.map(x=>x.path==='old'?{...x,objectId:id(101)}:x);
assert.deepEqual(run(justReplacement).deletions,{candidates:[],conflicts:[]});
// Отсутствие без нового пути остаётся лишь наблюдением, не доказательством
// удаления и не правом трогать корзину, даже если флаги говорят «полный».
const deletion=build();remove(deletion[0],'old');const only=run(deletion);assert.equal(only.deletions.candidates.length,1);assert(!('execute' in only.deletions.candidates[0]));
const offline=build();rename(offline[0],'old','new');offline[5].online=false;assert.throws(()=>run(offline));
const incomplete=build();incomplete[3].complete=false;assert.throws(()=>run(incomplete));
const missingId=build();delete missingId[0].snapshot[0].objectId;assert.throws(()=>run(missingId));
assert.throws(()=>reviewGroupChanges({...opts(build()),enabled:false}));
assert.throws(()=>reviewGroupChanges({...opts(build()),baseConfirmed:false}));
console.log('local-pc-multi-change-review: сводка переименования и удаления на фиктивных снимках; настоящих операций нет');
