// Только подбор имени в памяти; файлы не создаются и конфликты не разрешаются.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {suggestConflictName}=require('../local-pc/conflict-name.js');
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
console.log('local-pc-conflict-name: имена для версий в памяти, столкновения и ограничения проверены; файлы не менялись');
