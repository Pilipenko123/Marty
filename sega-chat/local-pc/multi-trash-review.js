'use strict';

// Только сводка возможного удаления в фиксированной группе из переданных
// снимков. НЕ операции, НЕ разрешение, НЕ подтверждение удаления в корзину.
// Не вызывать настоящие файловые или облачные API по данным этой сводки.
// Полноту, происхождение отсутствия, историю, членство и свежесть данных
// необходимо будет независимо доказать в будущем исполнителе.
const {analyzeMultiSync}=require('./multi-sync-analysis');
const {parseSnapshot}=require('./sync-plan');
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
module.exports={reviewGroupDeletions};
