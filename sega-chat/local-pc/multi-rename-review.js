'use strict';
// Исключительно обзор на фиктивных снимках: НЕ переименовывает и не выдаёт
// разрешение на файловую или облачную операцию. Идентификаторы общей группы,
// флаги полноты и базы здесь ПРЕДПОЛАГАЮТСЯ, а не проверяются. Пока не существует
// их безопасного получения/хранения для Windows и облачных дисков.
const {parseSnapshot}=require('./sync-plan');
const {MAX_MEMBERS}=require('./multi-sync-analysis');
const MAX_ITEMS=2000, ID=/^[a-f0-9]{32}$/, MEMBER=/^[a-zA-Z0-9_-]{1,64}$/;
const folded=p=>p.normalize('NFC').toLowerCase();
const parent=p=>p.includes('/')?p.slice(0,p.lastIndexOf('/')):'';
function same(a,b){return !!a && !!b && a.type===b.type && (a.type==='dir' || a.hash===b.hash && a.size===b.size);}
function lowerBound(paths,prefix){let a=0,b=paths.length;while(a<b){const m=(a+b)>>>1;if(paths[m]<prefix)a=m+1;else b=m;}return a;}
function subtreePaths(sorted,root){
  const prefix=root+'/',out=[root];let i=lowerBound(sorted,prefix);
  while(i<sorted.length && sorted[i].startsWith(prefix))out.push(sorted[i++]);
  return out;
}
function snapshot(input){
  if(!Array.isArray(input) || input.length>MAX_ITEMS)throw Error('Неверный размер снимка');
  const parsed=parseSnapshot(input),byId=new Map(),byPath=new Map(),byFold=new Map();
  for(const item of input){
    if(typeof item.objectId!=='string' || !ID.test(item.objectId) || byId.has(item.objectId))throw Error('Неверный идентификатор объекта');
    const entry={objectId:item.objectId,path:item.path,...parsed.get(item.path)};
    byId.set(entry.objectId,entry);byPath.set(entry.path,entry);byFold.set(folded(entry.path),entry);
  }
  return {byId,byPath,byFold,paths:[...byPath.keys()].sort()};
}
function reviewGroupRenames({enabled,baseConfirmed,base,members}={}){
  if(enabled!==true || baseConfirmed!==true || !Array.isArray(members) || members.length<2 || members.length>MAX_MEMBERS)
    throw Error('Группа или общая база не подтверждена');
  const B=snapshot(base),ids=new Set(),maps=[];
  for(const member of members){
    if(!member || typeof member.id!=='string' || !MEMBER.test(member.id) || ids.has(member.id)
      || !['pc','google','yandex'].includes(member.kind) || member.online!==true || member.complete!==true)
      throw Error('Участник недоступен или снимок не подтверждён');
    ids.add(member.id);maps.push(snapshot(member.snapshot));
  }
  const results=[],blocked=new Set();
  for(const path of B.paths){
    let p=path.lastIndexOf('/'),skip=false;
    while(p!==-1){if(blocked.has(path.slice(0,p))){skip=true;break;}p=path.lastIndexOf('/',p-1);}
    if(skip)continue;
    const old=B.byPath.get(path),now=maps.map(m=>m.byId.get(old.objectId));
    const renamed=now.map((e,i)=>e && e.path!==path?i:-1).filter(i=>i!==-1);
    if(!renamed.length)continue; // Одно отсутствие не объявляется переименованием.
    const destinations=new Set(renamed.map(i=>now[i].path));
    const to=destinations.size===1?[...destinations][0]:null;
    let conflict=!to || parent(to)!==parent(path) || (to && folded(to)===folded(path));
    const previouslyAtTarget=to && B.byFold.get(folded(to));
    if(previouslyAtTarget && previouslyAtTarget.objectId!==old.objectId)conflict=true;
    if(now.some(e=>!e || !same(old,e)))conflict=true;
    for(let i=0;i<maps.length;i++){
      const m=maps[i],atOld=m.byFold.get(folded(path));
      if(atOld && atOld.objectId!==old.objectId)conflict=true;
      if(to){const atNew=m.byFold.get(folded(to));if(atNew && atNew.objectId!==old.objectId)conflict=true;}
    }
    if(old.type==='dir'){
      blocked.add(path);
      const expected=subtreePaths(B.paths,path);
      for(let i=0;i<maps.length;i++){
        const memberRoot=now[i];if(!memberRoot || memberRoot.type!=='dir'){conflict=true;continue;}
        const actual=subtreePaths(maps[i].paths,memberRoot.path);
        if(actual.length!==expected.length){conflict=true;continue;}
        for(const bp of expected){
          const original=B.byPath.get(bp),entry=maps[i].byId.get(original.objectId);
          const wanted=memberRoot.path+bp.slice(path.length);
          if(!entry || entry.path!==wanted || !same(original,entry)){conflict=true;break;}
        }
      }
    }
    results.push({objectId:old.objectId,type:old.type,from:path,to,renamedBy:renamed.map(i=>members[i].id),
      waitingOn:now.map((e,i)=>e && e.path===path?members[i].id:null).filter(Boolean),state:conflict?'conflict':'candidate'});
  }
  return results;
}
module.exports={reviewGroupRenames,MAX_ITEMS};
