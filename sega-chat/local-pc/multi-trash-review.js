'use strict';

// Только сводка возможного удаления в фиксированной группе из переданных
// снимков. НЕ операции, НЕ разрешение, НЕ подтверждение удаления в корзину.
// Не вызывать настоящие файловые или облачные API по данным этой сводки.
// Полноту, происхождение отсутствия, историю, членство и свежесть данных
// необходимо будет независимо доказать в будущем исполнителе.
const {analyzeMultiSync}=require('./multi-sync-analysis');
const {parseSnapshot}=require('./sync-plan');
const {isDeepStrictEqual}=require('node:util');
function reviewGroupDeletions(options={}){
  const analysis=analyzeMultiSync(options);
  const base=parseSnapshot(options.base);
  const maps=options.members.map(member=>parseSnapshot(member.snapshot));
  const candidates=[],conflicts=[];
  for(const item of analysis){
    if(item.state==='conflict'){conflicts.push({path:item.path});continue;}
    const old=base.get(item.path);
    if(!old)continue; // Новые элементы нельзя воспринимать как удаление.
    const missing=[],present=[];
    for(let i=0;i<maps.length;i++){
      const m=options.members[i];
      if(maps[i].has(item.path))present.push({id:m.id,kind:m.kind});
      else missing.push(m.id);
    }
    // Только случаи, когда изменение представляет собой отсутствие на одной
    // или более сторонах, а хотя бы одна копия всё ещё есть. Остальные случаи
    // (в том числе изменение и конфликт) не являются кандидатами удаления.
    if(!missing.length || !present.length || item.changedBy.some(id=>!missing.includes(id)))continue;
    candidates.push({path:item.path,entryType:old.type,missingOn:missing,presentOn:present});
  }
  return {candidates,conflicts};
}
// Только повторный расчёт ранее замеченной сводки на новых входных данных.
// Замыкание хранит собственную копию ожидаемой базы и состава группы, а не
// доверяет последующей мутации аргументов. Это не доказательство их истинности,
// истории удаления или защиты от замены объекта между проверкой и действием.
// НЕЛЬЗЯ использовать результат для реальной операции в корзине.
function createDeletionRecheck(options={}){
  const initial=reviewGroupDeletions(options),base=parseSnapshot(options.base);
  const members=options.members.map(m=>({id:m.id,kind:m.kind})).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  const candidates=initial.candidates.map(c=>Object.freeze({path:c.path,entryType:c.entryType,
    missingOn:Object.freeze([...c.missingOn]),presentOn:Object.freeze(c.presentOn.map(m=>Object.freeze({...m})))}));
  Object.freeze(candidates);
  const conflicts=Object.freeze(initial.conflicts.map(c=>Object.freeze({...c})));
  function isCurrent(candidate,current){
    // Сначала всегда проверяем новые флаги и снимки, даже если кандидат неверен.
    const now=reviewGroupDeletions(current);
    const currentBase=parseSnapshot(current.base);
    const currentMembers=current.members.map(m=>({id:m.id,kind:m.kind})).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
    if(!isDeepStrictEqual(base,currentBase) || !isDeepStrictEqual(members,currentMembers))return false;
    return candidates.some(c=>isDeepStrictEqual(c,candidate)) && now.candidates.some(c=>isDeepStrictEqual(c,candidate));
  }
  return Object.freeze({candidates,conflicts,isCurrent});
}
module.exports={reviewGroupDeletions,createDeletionRecheck};
