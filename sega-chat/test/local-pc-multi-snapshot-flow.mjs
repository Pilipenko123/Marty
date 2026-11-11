// Соединение двух лабораторных моделей через фальшивые данные в памяти.
// Метки, полнота, общая база и состояние сети здесь искусственные. Никакой
// настоящей файловой системы, облачного API и изменения файлов нет.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {snapshotCandidate}=require('../local-pc/snapshot-candidate');
const {analyzeMultiSync}=require('../local-pc/multi-sync-analysis');
const {reviewGroupDeletions}=require('../local-pc/multi-trash-review');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const rev='a'.repeat(64);
function source(input){
  const files=new Map(Object.entries(input).map(([p,v])=>[p,Buffer.from(v)]));
  return {
    async list(path){
      const prefix=path?path+'/':'';
      const children=new Map();
      for(const [p,b] of files){
        if(!p.startsWith(prefix))continue;
        const rest=p.slice(prefix.length),slash=rest.indexOf('/');
        if(slash!==-1)children.set(rest.slice(0,slash),{name:rest.slice(0,slash),type:'dir'});
        else children.set(rest,{name:rest,type:'file',size:b.length,revision:sha(b)});
      }
      return {complete:true,revision:rev,entries:[...children.values()]};
    },
    async read(path,offset,length,version){
      const b=files.get(path);if(!b)throw Error('файл отсутствует');
      return {data:Buffer.from(b.subarray(offset,offset+length)),size:b.length,version:sha(b)};
    }
  };
}
async function snap(files){return snapshotCandidate({enabled:true,...source(files)});}
const original={'docs/note.txt':'old','other.txt':'other'};
const base=await snap(original);
const entries=[['pc1','pc'],['pc2','pc'],['pc3','pc'],['pc4','pc'],['cloud','google']];
async function group(variants={},kind='google'){
  return Promise.all(entries.map(async([id,k])=>({id,kind:id==='cloud'?kind:k,online:true,complete:true,snapshot:await snap(variants[id]||original)})));
}
const options=members=>({enabled:true,baseConfirmed:true,base,members});
for(const cloud of ['google','yandex']){
  let members=await group({},cloud);
  assert.deepEqual(analyzeMultiSync(options(members)),[]);
  members=await group({pc2:{...original,'docs/note.txt':'changed'}},cloud);
  assert.deepEqual(analyzeMultiSync(options(members)),[{path:'docs/note.txt',state:'changed',changedBy:['pc2']}]);
  members=await group({pc1:{'other.txt':'other'}},cloud);
  assert.deepEqual(reviewGroupDeletions(options(members)).candidates,[{path:'docs',entryType:'dir',missingOn:['pc1'],presentOn:entries.slice(1).map(([id,k])=>({id,kind:id==='cloud'?cloud:k}))}]);
  members=await group({pc1:{'other.txt':'other'},cloud:{...original,'docs/note.txt':'cloud changed'}},cloud);
  assert.deepEqual(analyzeMultiSync(options(members)),[{path:'docs',state:'conflict',changedBy:['pc1','cloud']}]);
  assert.deepEqual(reviewGroupDeletions(options(members)),{candidates:[],conflicts:[{path:'docs'}]});
  members=await group({pc1:{'other.txt':'other','docs/renamed.txt':'old'}},cloud);
  assert.deepEqual(reviewGroupDeletions(options(members)),{candidates:[],conflicts:[{path:'docs/note.txt'}]});
  // На уровне анализа не разрешаем незавершённого или отключённого участника.
  for(const patch of [{online:false},{complete:false}]){
    const failed=members.map(m=>m.id==='pc3'?{...m,...patch}:m);
    assert.throws(()=>reviewGroupDeletions(options(failed)),/недоступен|не подтверждён/);
  }
}
// Сбой при получении даже одного снимка не превращается в пустой снимок.
const broken=source(original);broken.read=async()=>{throw Error('обрыв чтения');};
await assert.rejects(snapshotCandidate({enabled:true,...broken}),/обрыв чтения/);
const incomplete=source(original);incomplete.list=async()=>({complete:false,revision:rev,entries:[]});
await assert.rejects(snapshotCandidate({enabled:true,...incomplete}),/не подтверждён/);
console.log('local-pc-multi-snapshot-flow: связка двух лабораторных моделей на фальшивых данных, настоящей синхронизации нет');
