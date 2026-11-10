'use strict';

// Предварительное представление статуса. Только получив реальные проверенные
// состояния от будущего помощника, интерфейс сможет пользоваться этой функцией.
// Отсутствующее состояние не превращается в «всё синхронизировано».
function syncStatus({ online, peerOnline, scanned, items } = {}) {
  if (online !== true) return { state:'offline', label:'Нет соединения', icon:'none', force:'Нет соединения', canForce:false };
  if (peerOnline !== true) return { state:'peer-offline', label:'Компьютер недоступен', icon:'none', force:'Компьютер недоступен', canForce:false };
  if (scanned !== true || !Array.isArray(items)) return { state:'checking', label:'Проверка синхронизации', icon:'sync', force:'Синхронизировать принудительно', canForce:false };
  const list = items;
  if (list.some(x => !x || !['synced','pending','running','conflict','error'].includes(x.state))) return { state:'checking', label:'Проверка синхронизации', icon:'sync', force:'Синхронизировать принудительно', canForce:false };
  if (list.some(x => x.state === 'conflict')) return { state:'conflict', label:'Нужно разобраться с изменениями', icon:'warning', force:'Синхронизировать принудительно', canForce:true };
  if (list.some(x => x.state === 'error')) return { state:'error', label:'Не удалось синхронизировать', icon:'warning', force:'Синхронизировать принудительно', canForce:true };
  if (list.some(x => x.state === 'running')) return { state:'running', label:'Идёт синхронизация', icon:'sync', force:'Идёт синхронизация', canForce:false };
  if (list.some(x => x.state === 'pending')) return { state:'pending', label:'Ожидает синхронизации', icon:'sync', force:'Синхронизировать принудительно', canForce:true };
  if (list.some(x => x.verified !== true)) return { state:'checking', label:'Проверка синхронизации', icon:'sync', force:'Синхронизировать принудительно', canForce:false };
  return { state:'synced', label:'Синхронизировано', icon:'check', force:'Синхронизировано', canForce:false };
}
module.exports = { syncStatus };
