// Исключительно фиктивные общие ID и снимки в памяти, не настоящие переименования.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {reviewGroupRenames,MAX_ITEMS}=createRequire(import.meta.url)('../local-pc/multi-rename-review');
const id=n=>n.toString(16).padStart(32,'0'),hash=n=>n.toString(16).padStart(64,'0');
const dir=(path,n)=>({objectId:id(n),path,type:'dir'});
const file=(path,n,h=1)=>({objectId:id(n),path,type:'file',size:h,hash:hash(h)});
const base=[dir('docs',1),dir('docs/sub',2),file('docs/sub/a.txt',3),file('plain.txt',4),dir('empty',5)];
const kinds=['pc','pc','pc','pc','google','yandex'];
const build=()=>kinds.map((kind,i)=>({id:`m${i+1}`,kind,online:true,complete:true,snapshot:base.map(x=>({...x}))}));
const opts=members=>({enabled:true,baseConfirmed:true,base,members});
const run=members=>reviewGroupRenames(opts(members));
const rename=(m,from,to)=>{m.snapshot=m.snapshot.map(e=>e.path===from || e.path.startsWith(from+'/')?{...e,path:to+e.path.slice(from.length)}:e);};
assert.deepEqual(run(build()),[]);
for(let i=0;i<kinds.length;i++){
  const m=build();rename(m[i],'plain.txt','renamed.txt');const output=run(m);
  assert.deepEqual(output,[{objectId:id(4),type:'file',from:'plain.txt',to:'renamed.txt',renamedBy:[`m${i+1}`],
    waitingOn:m.filter((_,n)=>n!==i).map(x=>x.id),state:'candidate'}]);
}
const same=build();rename(same[0],'plain.txt','renamed.txt');rename(same[5],'plain.txt','renamed.txt');
assert.deepEqual(run(same)[0].renamedBy,['m1','m6']);assert.equal(run(same)[0].state,'candidate');
const every=build();every.forEach(m=>rename(m,'plain.txt','renamed.txt'));assert.equal(run(every)[0].waitingOn.length,0);
const folder=build();rename(folder[0],'docs','papers');
assert.deepEqual(run(folder),[{objectId:id(1),type:'dir',from:'docs',to:'papers',renamedBy:['m1'],waitingOn:['m2','m3','m4','m5','m6'],state:'candidate'}]);
const empty=build();rename(empty[4],'empty','newempty');assert.equal(run(empty)[0].type,'dir');assert.equal(run(empty)[0].state,'candidate');
// Разные имена, удаление, редактирование, занятие старого или нового имени —
// конфликт. Здесь не реализуется ни выбор победителя, ни восстановление версий.
const divergent=build();rename(divergent[0],'plain.txt','one.txt');rename(divergent[4],'plain.txt','two.txt');assert.equal(run(divergent)[0].state,'conflict');assert.equal(run(divergent)[0].to,null);
const deleted=build();rename(deleted[0],'plain.txt','new.txt');deleted[2].snapshot=deleted[2].snapshot.filter(e=>e.objectId!==id(4));assert.equal(run(deleted)[0].state,'conflict');
const edited=build();rename(edited[0],'plain.txt','new.txt');edited[3].snapshot=edited[3].snapshot.map(e=>e.objectId===id(4)?file('plain.txt',4,7):e);assert.equal(run(edited)[0].state,'conflict');
const newOccupied=build();rename(newOccupied[0],'plain.txt','new.txt');newOccupied[4].snapshot.push(file('NEW.txt',8));assert.equal(run(newOccupied)[0].state,'conflict');
const oldOccupied=build();rename(oldOccupied[0],'plain.txt','new.txt');oldOccupied[0].snapshot.push(file('plain.txt',8));assert.equal(run(oldOccupied)[0].state,'conflict');
const alreadyInBase=build(),originalBase=[...base,file('new.txt',8)];
for(const m of alreadyInBase)m.snapshot=m.snapshot.filter(x=>x.path!=='plain.txt'); // подмена для явного сценария
alreadyInBase[0].snapshot.push(file('new.txt',4));alreadyInBase[0].snapshot=alreadyInBase[0].snapshot.filter(x=>x.objectId!==id(8));
assert.equal(reviewGroupRenames({...opts(alreadyInBase),base:originalBase})[0].state,'conflict');
const caseOnly=build();rename(caseOnly[0],'plain.txt','PLAIN.txt');assert.equal(run(caseOnly)[0].state,'conflict');
const move=build();rename(move[0],'plain.txt','docs/plain.txt');assert.equal(run(move)[0].state,'conflict');
const folderEdited=build();rename(folderEdited[0],'docs','papers');folderEdited[4].snapshot=folderEdited[4].snapshot.map(e=>e.objectId===id(3)?file(e.path,3,3):e);assert.equal(run(folderEdited)[0].state,'conflict');
const folderAdded=build();rename(folderAdded[0],'docs','papers');folderAdded[5].snapshot.push(file('docs/sub/new.txt',9));assert.equal(run(folderAdded)[0].state,'conflict');
const folderRenamedChild=build();rename(folderRenamedChild[0],'docs','papers');rename(folderRenamedChild[1],'docs/sub','docs/other');assert.equal(run(folderRenamedChild)[0].state,'conflict');assert.equal(run(folderRenamedChild).length,1);
const folderRemovedChild=build();rename(folderRemovedChild[0],'docs','papers');folderRemovedChild[1].snapshot=folderRemovedChild[1].snapshot.filter(e=>e.objectId!==id(3));assert.equal(run(folderRemovedChild)[0].state,'conflict');
const absent=build();absent[0].snapshot=absent[0].snapshot.filter(e=>e.objectId!==id(4));assert.deepEqual(run(absent),[]);
// Совпадение хеша НЕ устанавливает идентичность: новый ID на новом пути не
// распознаётся как переименование, даже если содержимое совпадает.
const unknown=build();unknown[0].snapshot=unknown[0].snapshot.filter(e=>e.objectId!==id(4));unknown[0].snapshot.push(file('new.txt',9));assert.deepEqual(run(unknown),[]);
for(const patch of [{online:false},{complete:false},{kind:'other'},{id:'../id'}]){const x=build();Object.assign(x[0],patch);assert.throws(()=>run(x));}
assert.throws(()=>reviewGroupRenames({...opts(build()),enabled:false}));assert.throws(()=>reviewGroupRenames({...opts(build()),baseConfirmed:false}));assert.throws(()=>run([build()[0]]));
const duplicate=build();duplicate[0].snapshot.push(file('extra',4));assert.throws(()=>run(duplicate));
const badId=build();badId[0].snapshot[0].objectId='bad';assert.throws(()=>run(badId));
const truncated=build();truncated[0].snapshot=truncated[0].snapshot.filter(e=>e.path!=='docs');assert.throws(()=>run(truncated));
assert.throws(()=>reviewGroupRenames({...opts(build()),base:Array(MAX_ITEMS+1).fill(file('a',1))}));
assert(!('execute' in run(folder)[0]));assert.equal(base[0].path,'docs');
console.log('local-pc-multi-rename-review: обзор имён, дерева и конфликтов на фиктивных ID; реального переименования нет');
