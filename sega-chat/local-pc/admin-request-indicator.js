/* Неподключённый опытный индикатор при открытом приложении. Это не push и не
 * проверка прав: администратор и заявка проверяются сервером. Хозяин обязан
 * останавливать компонент при выходе/смене сессии и заново создавать его. */
(function(g){
  'use strict';
  function createAdminRequestIndicator(doc,{createMonitor,listRequests,onOpen}={}){
    if(!doc || !g.AbortController || typeof createMonitor!=='function' || typeof listRequests!=='function' || typeof onOpen!=='function')throw Error('Неполные действия индикатора');
    const root=doc.createElement('section');root.className='local-pc-admin-indicator';root.setAttribute('aria-label','Заявки личных папок');
    const label=doc.createElement('strong');label.textContent='Заявки личных папок';root.appendChild(label);
    const status=doc.createElement('p');status.setAttribute('role','status');status.setAttribute('aria-live','polite');root.appendChild(status);
    const open=doc.createElement('button');open.type='button';open.dataset.action='open';open.textContent='Открыть заявки';root.appendChild(open);
    const refresh=doc.createElement('button');refresh.type='button';refresh.dataset.action='refresh';refresh.textContent='Обновить';root.appendChild(refresh);
    const error=doc.createElement('p');error.className='local-pc-admin-indicator-error';error.setAttribute('role','status');error.setAttribute('aria-live','polite');root.appendChild(error);
    let running=false,disposed=false,epoch=0,opening=null;
    function controls(){open.disabled=!running || disposed || !!opening;refresh.disabled=!running || disposed;}
    function update(v){
      if(!running || disposed)return;
      if(v && v.state==='ready' && Number.isSafeInteger(v.count) && v.count>=0 && v.count<=5000){
        status.textContent='Ожидают решения по последней проверке: '+v.count+'.';
      }else status.textContent='Не удалось проверить заявки. Количество неизвестно.';
    }
    const monitor=createMonitor({listRequests,onUpdate:update});
    if(!monitor || typeof monitor.start!=='function' || typeof monitor.stop!=='function' || typeof monitor.refresh!=='function')throw Error('Неверный наблюдатель');
    function stop(){
      if(!running)return;running=false;epoch++;monitor.stop();
      if(opening){opening.abort();opening=null;}
      status.textContent='Наблюдение остановлено.';error.textContent='';controls();
    }
    function start(){
      if(disposed || running)return;running=true;epoch++;error.textContent='';status.textContent='Проверяем заявки…';controls();
      try{monitor.start();}catch(_){status.textContent='Не удалось проверить заявки. Количество неизвестно.';}
    }
    function refreshNow(){if(!running || disposed)return false;try{return monitor.refresh()===true;}catch(_){status.textContent='Не удалось проверить заявки. Количество неизвестно.';return false;}}
    function dispose(){if(disposed)return;stop();disposed=true;status.textContent='Наблюдение остановлено.';error.textContent='';controls();}
    open.addEventListener('click',()=>{
      if(!running || disposed || opening)return;
      const controller=new g.AbortController(),n=epoch;opening=controller;error.textContent='';controls();
      const live=()=>running && !disposed && epoch===n && opening===controller && !controller.signal.aborted;
      Promise.resolve().then(()=>{if(live())return onOpen(controller.signal);}).catch(()=>{if(live())error.textContent='Не удалось открыть список заявок. Попробуйте ещё раз.';}).finally(()=>{if(live()){opening=null;controls();}});
    });
    refresh.addEventListener('click',()=>{if(!refresh.disabled)refreshNow();});
    status.textContent='Наблюдение остановлено.';controls();
    return Object.freeze({root,start,stop,refresh:refreshNow,dispose});
  }
  const exported=Object.freeze({createAdminRequestIndicator});
  if(typeof module!=='undefined' && module.exports)module.exports=exported;else g.SegaLocalAdminRequestIndicator=exported;
})(typeof globalThis!=='undefined'?globalThis:window);
