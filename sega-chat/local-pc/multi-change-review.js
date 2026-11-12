'use strict';
// Сочетание двух лабораторных обзоров, не план и НЕ разрешение на действие.
// Общие objectId, полнота, состав и база предполагаются извне и не доказаны.
// Никогда не выполнять удаление/переименование по этому результату.
const {reviewGroupRenames}=require('./multi-rename-review');
const {reviewGroupDeletions}=require('./multi-trash-review');
function reviewGroupChanges(options={}){
  // Сначала проверяются все гипотетические ID и доступность всех участников.
  const renames=reviewGroupRenames(options);
  const deletions=reviewGroupDeletions(options);
  // Любое выявленное переименование (даже конфликтующее) задерживает все
  // остальные кандидаты удаления. Слишком осторожно, но здесь нет истории,
  // чтобы надёжно установить, связаны ли изменения. Появление новых путей
  // также откладывает кандидаты в самом обзоре удалений.
  // Даже если имя и содержимое совпадают, другой ID может означать замену
  // объекта. Анализ удаления по путям этого не замечает: задерживаем все
  // удаления, пока нет доверенной истории и правил идентичности.
  const baseIds=new Map(options.base.map(item=>[item.path,item.objectId]));
  const replaced=options.members.some(member=>member.snapshot.some(item=>
    baseIds.has(item.path) && baseIds.get(item.path)!==item.objectId));
  if(renames.length || replaced){
    const conflicts=new Set(deletions.conflicts.map(x=>x.path));
    for(const item of deletions.candidates)conflicts.add(item.path);
    deletions.candidates=[];
    deletions.conflicts=[...conflicts].sort().map(path=>({path}));
  }
  return {renames,deletions};
}
module.exports={reviewGroupChanges};
