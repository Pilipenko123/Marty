'use strict';
// Учебный журнал одной условной операции. Не исполнитель и не разрешение
// действовать: нет доверенной базы, блокировки процессов, fsync или Windows.
// save обязана сохранять ВСЮ запись до успешного возврата; это не проверяется.
// После любой ошибки сохранения дальнейшая работа этого экземпляра запрещена:
// неизвестно, сохранились ли новые данные. Запись не содержит пути или секреты.
const ID=/^[a-f0-9]{32}$/;
const states=new Set(['prepared','uncertain','confirmed']);
function valid(record){
  return !!record && typeof record==='object' && !Array.isArray(record)
    && Object.keys(record).sort().join(',')==='id,kind,state'
    && typeof record.id==='string' && ID.test(record.id)
    && ['copy','rename','trash'].includes(record.kind) && states.has(record.state);
}
function createRecoveryJournal({record,save}={}){
  if(!valid(record) || typeof save!=='function')throw new Error('Повреждён журнал');
  let current=Object.freeze({...record}),busy=false,poisoned=false;
  function inspect(){
    // Даже confirmed — только запись о заявленном наблюдении, а не проверка.
    if(poisoned)return {state:'unknown',next:'stop'};
    if(busy)return {state:'saving',next:'stop'};
    return {state:current.state,next:current.state==='uncertain'?'inspect-target':'stop'};
  }
  async function change(from,to){
    if(poisoned || busy || current.state!==from)throw new Error('Переход журнала недоступен');
    busy=true;
    const next=Object.freeze({...current,state:to});
    try {await save(next);current=next;}
    catch(error){poisoned=true;throw error;}
    finally {busy=false;}
  }
  // Требуется сохранить uncertain ДО потенциального внешнего действия. Даже
  // если оно не было выполнено, после перезапуска надо проверять назначение,
  // а не повторять операцию. Метод не вызывает внешние API.
  const markUncertain=()=>change('prepared','uncertain');
  // Лишь отметка вызывающего кода: модуль не доказывает само наблюдение.
  const markObserved=()=>change('uncertain','confirmed');
  return Object.freeze({inspect,markUncertain,markObserved});
}
module.exports={createRecoveryJournal};
