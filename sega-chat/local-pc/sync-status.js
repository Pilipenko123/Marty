'use strict';

// Предварительное представление статуса. Только получив реальные проверенные
// состояния от будущего помощника, интерфейс сможет пользоваться этой функцией.
// Отсутствующее состояние не превращается в «всё синхронизировано».
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
  if (list.some(x => x.state === 'conflict')) return { state:'conflict', label:'Нужно разобраться с изменениями', icon:'warning', force:'Синхронизировать принудительно', canForce:true };
  if (list.some(x => x.state === 'error')) return { state:'error', label:'Не удалось синхронизировать', icon:'warning', force:'Синхронизировать принудительно', canForce:true };
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
  return syncStatus({online,peerOnline,enabled,scanned,scanVerified,items:[item],progress:item && item.progress});
}
module.exports = { syncStatus, syncItemStatus };
