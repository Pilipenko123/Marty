// Только подбор имени в памяти; файлы не создаются и конфликты не разрешаются.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {suggestConflictName,suggestGroupConflictNames,MAX_MEMBERS}=require('../local-pc/conflict-name.js');
const {planSync}=require('../local-pc/sync-plan.js');
const l={type:'file',hash:'1'.repeat(64),size:10};
const r={type:'file',hash:'2'.repeat(64),size:12};
const args={path:'документы/отчёт.txt',left:l,right:r,leftNames:['отчёт.txt'],rightNames:['отчёт.txt'],leftComplete:true,rightComplete:true};
const suggest=overrides=>suggestConflictName({...args,...overrides});
const first=suggest({});
assert.equal(first.original,args.path);
assert.equal(first.alternate,'документы/отчёт (другая версия).txt');
assert.deepEqual(first.left,l); assert.deepEqual(first.right,r);
assert.notEqual(first.left,l); assert.notEqual(first.right,r);
const base={path:args.path,type:'file',hash:'3'.repeat(64),size:11};
const parentEntry={path:'документы',type:'dir'};
const pending=planSync({enabled:true,online:true,peerOnline:true,baseConfirmed:true,leftComplete:true,rightComplete:true,
  base:[parentEntry,base],left:[parentEntry,{path:args.path,...l}],right:[parentEntry,{path:args.path,...r}]});
assert.deepEqual(pending.map(x=>[x.type,x.path]),[['conflict',args.path]]);
assert.equal(first.left.hash,l.hash); assert.equal(first.right.hash,r.hash);
assert.equal(suggest({leftNames:['отчёт.txt','ОТЧЁТ (ДРУГАЯ ВЕРСИЯ).TXT']}).alternate,'документы/отчёт (другая версия - 2).txt');
assert.equal(suggest({rightNames:['отчёт.txt','отче\u0308т (другая версия).txt']}).alternate,'документы/отчёт (другая версия - 2).txt');
assert.equal(suggest({path:'архив',leftNames:['архив'],rightNames:['архив']}).alternate,'архив (другая версия)');
assert.equal(suggest({path:'.env',leftNames:['.env'],rightNames:['.env']}).alternate,'.env (другая версия)');
const big='я'.repeat(240)+'.txt';
const long=suggest({path:big,leftNames:[big],rightNames:[big]}).alternate;
assert(long.length<=255); assert(long.endsWith('.txt'));assert(long.includes('(другая версия)'));
const emoji='😀'.repeat(120)+'.txt';
const emojiName=suggest({path:emoji,leftNames:[emoji],rightNames:[emoji]}).alternate;
assert(emojiName.length<=255);assert.equal(Buffer.from(emojiName).toString('utf8'),emojiName);
for(const overrides of [
  {leftComplete:false},{rightComplete:false},{leftNames:[]},{rightNames:null},
  {left:{...l,type:'dir'}},{right:{...r,hash:'x'}},{right:{...l}},
  {path:'../секрет'},{path:'C:/секрет'},{path:''},
  {leftNames:['отчёт.txt','папка/файл']},{leftNames:['отчёт.txt','CON']},
  {leftNames:['отчёт.txt','\ud800']}
]) assert.throws(()=>suggest(overrides));
const taken=['отчёт.txt','отчёт (другая версия).txt'];
for(let i=2;i<=500;i++) taken.push('отчёт (другая версия - '+i+').txt');
assert.equal(suggest({leftNames:taken}).alternate,'документы/отчёт (другая версия - 501).txt');
const hugeExtension='a.'+'x'.repeat(253);
assert.throws(()=>suggest({path:hugeExtension,leftNames:[hugeExtension],rightNames:[hugeExtension]}),/расширением/);
const parent=Array(17).fill('a'.repeat(240)).join('/');
assert.throws(()=>suggest({path:parent+'/a.txt',leftNames:['a.txt'],rightNames:['a.txt']}),/Неверный путь/);
// Список одной стороны с неоднозначными именами нельзя считать корректным.
assert.throws(()=>suggest({leftNames:['отчёт.txt','ОТЧЁТ.TXT']}),/неоднозначны/);
assert.throws(()=>suggest({rightNames:['отчёт.txt','отче\u0308т.txt']}),/неоднозначны/);
assert.throws(()=>suggest({leftNames:['отчёт.txt','отчёт.txt']}),/неоднозначны/);

// Модель группы: четыре ПК, два условных облака, несколько различных версий.
// Все списки и версии фиктивные; нет сохранения и нет настоящей синхронизации.
const v3={type:'file',hash:'3'.repeat(64),size:13},v4={type:'file',hash:'4'.repeat(64),size:14};
const make=(id,kind,file,names=['отчёт.txt'])=>({id,kind,online:true,complete:true,file,names:[...names]});
const members=[make('a1','pc',l),make('a2','pc',r),make('a3','pc',r),make('a4','pc',v3),
  make('a5','google',l),make('a6','yandex',v4,['отчёт.txt','отче\u0308т (другая версия).txt','отчёт (другая версия - 2).txt'])];
const group=arr=>suggestGroupConflictNames({path:'документы/отчёт.txt',members:arr});
const inputBefore=JSON.stringify(members),g=group(members);
assert.deepEqual(g,{original:'документы/отчёт.txt',variants:[
  {path:'документы/отчёт.txt',version:l,members:['a1','a5']},
  {path:'документы/отчёт (другая версия - 3).txt',version:r,members:['a2','a3']},
  {path:'документы/отчёт (другая версия - 4).txt',version:v3,members:['a4']},
  {path:'документы/отчёт (другая версия - 5).txt',version:v4,members:['a6']}
]});
assert.deepEqual(group([...members].reverse()),g);assert.equal(JSON.stringify(members),inputBefore);
assert.equal(new Set(g.variants.map(x=>x.path.normalize('NFC').toLowerCase())).size,4);
assert.notEqual(g.variants[0].version,l);assert(!('execute' in g));
for(let i=0;i<members.length;i++){
  for(const patch of [{online:false},{complete:false},{names:[]},{file:{type:'dir'}},{kind:'unknown'}]){
    const bad=members.map((m,n)=>n===i?{...m,...patch}:m);assert.throws(()=>group(bad));
  }
}
assert.throws(()=>group([members[0]]));assert.throws(()=>group([members[0],members[0]]));
assert.throws(()=>group(members.map(m=>({...m,file:l}))),/совпадают/);
assert.throws(()=>group([...members.slice(0,5),{...members[5],names:['отчёт.txt','ОТЧЁТ.TXT']}]),/неоднозначны/);
assert.throws(()=>group(Array.from({length:MAX_MEMBERS+1},(_,i)=>make('id'+i,'pc',i%2?l:r))));
const groupBig=Array.from({length:MAX_MEMBERS},(_,i)=>make('id'+String(i).padStart(2,'0'),'pc',{type:'file',hash:i.toString(16).padStart(64,'0'),size:i}));
const allVersions=group(groupBig);assert.equal(allVersions.variants.length,MAX_MEMBERS);
assert.equal(new Set(allVersions.variants.map(x=>x.path)).size,MAX_MEMBERS);
assert.throws(()=>suggestGroupConflictNames({path:'../секрет',members}));
console.log('local-pc-conflict-name: имена нескольких версий и столкновения проверены в памяти; файлы не менялись');
