'use strict';
// Цикл экспериментального помощника. Сам не запускается и не устанавливается.
// Статус сети не является подтверждением синхронизации файлов.
function createAgentRunner({coordinator,onStatus=()=>{},idleMs=2000,maxRetryMs=30000}={}) {
  if (!coordinator || typeof coordinator.tick !== 'function' || typeof onStatus !== 'function'
      || !Number.isInteger(idleMs) || idleMs<1 || !Number.isInteger(maxRetryMs) || maxRetryMs<idleMs
      || maxRetryMs>2147483647) throw new Error('Неверные настройки помощника');
  let controller=null, running=null, current='';
  function emit(status) { if(current===status)return;current=status;try{onStatus(status)}catch(_){} }
  function wait(ms,signal) {
    return new Promise(resolve=>{
      if(signal.aborted)return resolve();
      const timer=setTimeout(done,ms);
      function done(){clearTimeout(timer);signal.removeEventListener('abort',done);resolve()}
      signal.addEventListener('abort',done,{once:true});
      if(signal.aborted)done();
    });
  }
  function start() {
    if(running)throw new Error('Помощник уже работает');
    controller=new AbortController(); const signal=controller.signal;
    running=Promise.resolve().then(async()=>{
      let delay=idleMs; emit('connecting');
      try {
        while(!signal.aborted) {
          try {
            const completed=await coordinator.tick(signal);
            if(signal.aborted)break;
            if(completed!==true && completed!==false)throw new Error('Опрос не подтверждён');
            delay=idleMs; emit('online');
          } catch(e) {
            if(signal.aborted)break;
            if(e && e.status===401){emit('revoked');break;}
            if(e && e.code==='LOCAL_FOLDER_CHANGED'){emit('folder-changed');break;}
            emit('offline'); delay=Math.min(maxRetryMs,Math.max(idleMs,delay*2));
          }
          await wait(delay,signal);
        }
      } finally { emit('stopped');controller=null;running=null; }
    });
    return running;
  }
  async function stop(){const active=running;if(controller)controller.abort();if(active)await active;}
  return Object.freeze({start,stop});
}
module.exports={createAgentRunner};
