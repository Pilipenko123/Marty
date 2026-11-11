'use strict';

// Предварительное представление статуса. Только получив реальные проверенные
// состояния от будущего помощника, интерфейс сможет пользоваться этой функцией.
// Отсутствующее состояние не превращается в «всё синхронизировано».
const {partsOf}=require('./folder');
const {MAX_ITEMS}=require('./sync-plan');
function percentage(progress) {
  if (!progress || !Number.isSafeInteger(progress.done) || !Number.isSafeInteger(progress.total)
      || progress.done < 0 || progress.total <= 0 || progress.done > progress.total) return null;
  // Точное целочисленное деление, даже если умножение на 100 превысило бы
  // безопасный предел обычного Number. Это прогресс передачи, не гарантия
  // проверки, сохранения или завершения синхронизации.
  return Number((BigInt(progress.done) * 100n) / BigInt(progress.total));
}
function syncStatus({ online, peerOnline, enabled, scanned, scanVerified, items, progress } = {}) {
  if (online !== true) return { state:'offline', label:'Нет соединения', icon:'none', force:'Нет соединения', canForce:false };
  if (peerOnline !== true) return { state:'peer-offline', label:'Компьютер недоступен', icon:'none', force:'Компьютер недоступен', canForce:false };
  if (enabled !== true) return { state:'disabled', label:'Синхронизация выключена', icon:'none', force:'Включите синхронизацию', canForce:false };
  if (scanned !== true || !Array.isArray(items)) return { state:'checking', label:'Проверка синхронизации', icon:'sync', force:'Синхронизировать принудительно', canForce:false };
  const list = items;
  if (list.some(x => !x || !['synced','pending','running','conflict','error'].includes(x.state))) return { state:'checking', label:'Проверка синхронизации', icon:'sync', force:'Синхронизировать принудительно', canForce:false };
  const running=list.some(x=>x.state==='running');
  if (list.some(x => x.state === 'conflict')) return { state:'conflict', label:'Нужно разобраться с изменениями', icon:'warning', force:running?'Идёт синхронизация':'Синхронизировать принудительно', canForce:!running };
  if (list.some(x => x.state === 'error')) return { state:'error', label:'Не удалось синхронизировать', icon:'warning', force:running?'Идёт синхронизация':'Синхронизировать принудительно', canForce:!running };
  if (list.some(x => x.state === 'running')) {
    const percent=percentage(progress);
    const status={ state:'running', label:percent===null ? 'Идёт синхронизация' : `Идёт синхронизация · передано ${percent}%`, icon:'sync', force:'Идёт синхронизация', canForce:false };
    if (percent!==null) status.percent=percent;
    return status;
  }
  if (list.some(x => x.state === 'pending')) return { state:'pending', label:'Ожидает синхронизации', icon:'sync', force:'Синхронизировать принудительно', canForce:true };
  // Даже пустой список не доказывает, что обе папки проверены полностью:
  // отдельное подтверждение относится ко всему сканированию, не к элементам.
  if (scanVerified !== true || list.some(x => x.verified !== true)) return { state:'checking', label:'Проверка синхронизации', icon:'sync', force:'Синхронизировать принудительно', canForce:false };
  return { state:'synced', label:'Синхронизировано', icon:'check', force:'Синхронизировано', canForce:false };
}
// Для отдельной строки нельзя считать галочку по соседним элементам. Если
// работа ещё не началась, кнопка этой строки может быть доступна независимо от
// другой строки, которая уже выполняется.
function syncItemStatus({online,peerOnline,enabled,scanned,scanVerified,item} = {}) {
  // Отдельная папка не доказывает состояние потомков. Для галочки папки
  // вызывайте syncTreeStatuses с полным деревом; не распознанный тип — проверка.
  const entries=item && item.type==='file' ? [item] : item && item.type==='dir'
    ? [item,{state:'synced',verified:false}] : [null];
  return syncStatus({online,peerOnline,enabled,scanned,scanVerified,items:entries,progress:item && item.type==='file' && item.progress});
}

// Состояния дерева по переданным данным; ни связь, ни полноту, ни реальное
// выполнение эта модель не проверяет. Реальные изменения могут произойти после
// расчёта, а флаги может ошибочно выставить вызывающий код. Модуль не запускает
// синхронизацию и не гарантирует безопасность принудительного повтора.
function syncTreeStatuses({online,peerOnline,enabled,scanned,scanVerified,treeComplete,items,progress} = {}) {
  if(!Array.isArray(items) || items.length>MAX_ITEMS)throw new Error('Неверный список состояния');
  const nodes=new Map(), folded=new Set(), priority={synced:0,checking:1,pending:2,running:3,error:4,conflict:5,invalid:6};
  for(const item of items) {
    if(!item || typeof item.path!=='string' || !item.path || !partsOf(item.path).length || !['file','dir'].includes(item.type)) throw new Error('Неверный список состояния');
    const fold=item.path.normalize('NFC').toLowerCase();
    if(folded.has(fold))throw new Error('Имена файлов совпадают');
    folded.add(fold);
    let state=['synced','pending','running','error','conflict'].includes(item.state) ? item.state : 'invalid';
    if(state==='synced' && item.verified!==true)state='checking';
    nodes.set(item.path,{item,rank:priority[state],running:item.state==='running'});
  }
  for(const [path] of nodes) {
    const i=path.lastIndexOf('/');
    if(i!==-1 && (!nodes.has(path.slice(0,i)) || nodes.get(path.slice(0,i)).item.type!=='dir')) throw new Error('Неполный список папок');
  }
  // Каждый элемент передаёт обобщённое состояние непосредственному родителю.
  // Без рекурсии и полного повторного обхода для каждой папки.
  const ordered=[...nodes.keys()].sort((a,b)=>b.length-a.length);
  for(const path of ordered) {
    const i=path.lastIndexOf('/');
    if(i!==-1) {
      const parent=nodes.get(path.slice(0,i)), child=nodes.get(path);
      parent.rank=Math.max(parent.rank,child.rank);
      parent.running=parent.running || child.running;
    }
  }
  const states=['synced','checking','pending','running','error','conflict','invalid'];
  const flags={online,peerOnline,enabled,scanned,scanVerified:scanVerified===true && treeComplete===true};
  function summarize(rank,measured,running) {
    const state=states[rank];
    const item=state==='checking'?{state:'synced',verified:false}:state==='invalid'?null:{state,verified:state==='synced'};
    const entries=running && state!=='running' ? [item,{state:'running'}] : [item];
    return syncStatus({...flags,items:entries,progress:measured});
  }
  let highest=0, anyRunning=false;
  const result=items.map(item=>{
    const node=nodes.get(item.path);highest=Math.max(highest,node.rank);anyRunning=anyRunning || node.running;
    // Ход целой папки должен быть измерен отдельно, а не выведен из файла.
    return {path:item.path,status:summarize(node.rank,item.type==='file'?item.progress:undefined,node.running)};
  });
  return {overall:summarize(highest,progress,anyRunning),items:result};
}
module.exports = { syncStatus, syncItemStatus, syncTreeStatuses };
