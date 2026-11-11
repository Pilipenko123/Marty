'use strict';

// Анализ в памяти для фиксированной группы, НЕ план исполнения. Общую базу,
// состав группы, полноту и свежесть снимков этот модуль не устанавливает.
// Никакой передачи, сохранения конфликтов, изменения файлов или облака нет.
const {parseSnapshot,MAX_ITEMS}=require('./sync-plan');
const MAX_MEMBERS=32;
function same(a,b){return !a||!b?!a&&!b:a.type===b.type && (a.type==='dir'||(a.hash===b.hash && a.size===b.size));}
function key(e){return e?e.type==='dir'?'dir':`file:${e.size}:${e.hash}`:'missing';}
function analyzeMultiSync({enabled,baseConfirmed,base,members}={}){
  if(enabled!==true || baseConfirmed!==true || !Array.isArray(members) || members.length<2 || members.length>MAX_MEMBERS)
    throw new Error('Группа или общая база не подтверждена');
  const B=parseSnapshot(base),ids=new Set(),maps=[];
  for(const member of members){
    if(!member || typeof member.id!=='string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(member.id) || ids.has(member.id)
      || !['pc','google','yandex'].includes(member.kind) || member.online!==true || member.complete!==true)
      throw new Error('Участник недоступен или снимок не подтверждён');
    ids.add(member.id);maps.push(parseSnapshot(member.snapshot));
  }
  const spelling=new Map(),all=new Set();
  for(const map of [B,...maps])for(const path of map.keys()){
    const fold=path.normalize('NFC').toLowerCase();
    if(spelling.has(fold) && spelling.get(fold)!==path)throw new Error('Имена различаются только регистром или нормализацией');
    spelling.set(fold,path);all.add(path);
    if(all.size>MAX_ITEMS)throw new Error('Слишком много общих путей');
  }
  const paths=[...all].sort((a,b)=>a<b?-1:a>b?1:0);
  // Узнать, менялся ли каждый каталог, пока он существовал, за один проход
  // снизу вверх. Отсутствие дерева на удалившей стороне не считается правкой
  // вложенного файла, но правка на любой другой стороне создаёт конфликт.
  const dirtyTrees=maps.map(()=>new Set());
  for(const path of paths){
    for(let i=0;i<maps.length;i++){
      if(same(B.get(path),maps[i].get(path)))continue;
      let parent=path.lastIndexOf('/');
      while(parent!==-1){
        const p=path.slice(0,parent);
        if(maps[i].get(p)?.type==='dir')dirtyTrees[i].add(p);
        parent=p.lastIndexOf('/');
      }
    }
  }
  const result=[],blocked=new Set();
  for(const path of paths){
    let p=path.lastIndexOf('/'),skip=false;
    while(p!==-1){if(blocked.has(path.slice(0,p))){skip=true;break;}p=path.lastIndexOf('/',p-1);}
    if(skip)continue;
    const baseEntry=B.get(path),entries=maps.map(m=>m.get(path));
    const changed=entries.map((entry,i)=>same(entry,baseEntry)?-1:i).filter(i=>i!==-1);
    if(!changed.length)continue;
    const variants=new Set(changed.map(i=>key(entries[i])));
    let conflict=variants.size>1;
    // Структурные изменения каталога нельзя оценивать отдельно от детей.
    const structural=baseEntry?.type==='dir' && entries.some(e=>!e || e.type!=='dir');
    if(structural && dirtyTrees.some((dirty,i)=>entries[i]?.type==='dir' && dirty.has(path)))conflict=true;
    if(structural || entries.some(e=>e?.type==='dir') && entries.some(e=>e && e.type!=='dir'))blocked.add(path);
    result.push({path,state:conflict?'conflict':'changed',changedBy:changed.map(i=>members[i].id)});
  }
  return result;
}
module.exports={analyzeMultiSync,MAX_MEMBERS};
