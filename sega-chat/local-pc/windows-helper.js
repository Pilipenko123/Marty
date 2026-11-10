'use strict';
// Только лабораторный оркестратор для тестов с явно переданными зависимостями.
// Прямой запуск запрещён до аудита, Windows-проверки и безопасных границ.
// Этот файл не создаёт ни хранилище, ни файловый доступ, ни сетевой клиент;
// импортирующий код обязан явно предоставить зависимости и не использовать реальные файлы.
async function runHelper({platform=process.platform, vault, wizard, coordinator, runnerFactory, onStatus=()=>{}}={}) {
  if(platform!=='win32') throw new Error('Помощник работает только на Windows');
  if (!vault || typeof vault.load!=='function' || typeof wizard!=='function'
      || !coordinator || typeof coordinator.prepare!=='function' || typeof coordinator.tick!=='function'
      || typeof runnerFactory!=='function' || typeof onStatus!=='function') {
    throw new Error('Помощник пока недоступен');
  }
  const previous=await vault.load();
  if(!previous) {
    const chosen=await wizard();
    if(!chosen)return 'cancelled';
    await coordinator.prepare(chosen.code,chosen.folder);
  }
  const runner=runnerFactory({coordinator,onStatus});
  if(!runner || typeof runner.start!=='function' || typeof runner.stop!=='function') throw new Error('Помощник пока недоступен');
  const stop=()=>{try{Promise.resolve(runner.stop()).catch(()=>{});}catch(_){}};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try { await runner.start(); return 'stopped'; }
  finally { process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop); }
}
if(require.main===module) {
  // Без обходного флага: черновик нельзя случайно запустить на чьих-либо файлах.
  console.error('Помощник ещё в разработке и пока недоступен.');
  process.exitCode=1;
}
module.exports={runHelper};
