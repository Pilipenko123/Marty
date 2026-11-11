/* Неподключённая лабораторная модель индикатора заявок. Не Web Push, не
 * уведомление в рабочем приложении. Получает список от доверенного клиента;
 * сервер обязан проверять администратора и хранить сами заявки. */
(function(g){
  'use strict';
  const ID=/^[a-f0-9]{32}$/,MAX_ITEMS=5000;
  function createAdminRequestMonitor({listRequests,onUpdate,intervalMs=60000}={}){
    if(typeof listRequests!=='function' || typeof onUpdate!=='function' || !g.AbortController || typeof g.setTimeout!=='function' || typeof g.clearTimeout!=='function'
      || !Number.isInteger(intervalMs) || intervalMs<30000 || intervalMs>300000)throw new Error('Неверные параметры наблюдения');
    let running=false,epoch=0,timer=null,active=null,known=null,state='stopped',failures=0;
    function publish(value){try{Promise.resolve(onUpdate(Object.freeze(value))).catch(()=>{});}catch(_){}}
    function clearTimer(){if(timer!==null){g.clearTimeout(timer);timer=null;}}
    function valid(response){
      if(!response || typeof response!=='object' || !Array.isArray(response.requests) || response.requests.length>MAX_ITEMS)throw new Error('Неверный список заявок');
      const ids=new Set(),users=new Set();
      for(const x of response.requests){
        if(!x || typeof x!=='object' || typeof x.requestId!=='string' || !ID.test(x.requestId) || typeof x.userId!=='string' || !x.userId || x.userId.length>200
          || ids.has(x.requestId) || users.has(x.userId))throw new Error('Неверный список заявок');
        ids.add(x.requestId);users.add(x.userId);
      }
      return ids;
    }
    function schedule(ms){if(!running || timer!==null)return;timer=g.setTimeout(()=>{timer=null;kick();},ms);}
    function kick(){
      if(!running || active)return false;clearTimer();
      const controller=new g.AbortController(),generation=epoch,run={controller,generation};active=run;
      Promise.resolve().then(()=>{
        if(!running || generation!==epoch || controller.signal.aborted)throw new Error('Остановлено');
        return listRequests(controller.signal);
      }).then(response=>{
        if(!running || generation!==epoch || controller.signal.aborted)return;
        const next=valid(response);let newlySeen=0;
        if(known)for(const id of next)if(!known.has(id))newlySeen++;
        const changed=state!=='ready' || !known || known.size!==next.size || newlySeen>0;
        known=next;failures=0;state='ready';
        // Первый снимок отражает уже ожидающие заявки, но не объявляет их новыми.
        if(changed)publish({state:'ready',count:next.size,newlySeen});
      }).catch(()=>{
        if(!running || generation!==epoch || controller.signal.aborted)return;
        failures=Math.min(failures+1,8);
        // После ошибки нельзя утверждать, что ожидающих заявок нет.
        if(state!=='unavailable'){state='unavailable';publish({state:'unavailable',count:null,newlySeen:0});}
      }).finally(()=>{
        if(active===run)active=null;
        if(!running)return;
        // Если старое действие завершилось уже после stop/start, оно не
        // доставляет событие и не задаёт отсчёт для нового сеанса наблюдения.
        if(generation!==epoch){schedule(0);return;}
        schedule(Math.min(intervalMs*Math.pow(2,failures),900000));
      });
      return true;
    }
    function start(){if(running)return;running=true;epoch++;state='starting';kick();}
    function stop(){if(!running)return;running=false;epoch++;clearTimer();if(active)active.controller.abort();known=null;state='stopped';failures=0;}
    // Ручной запрос не перекрывает уже выполняющийся и не отправляет решений.
    function refresh(){return kick();}
    return Object.freeze({start,stop,refresh});
  }
  const exported=Object.freeze({createAdminRequestMonitor,MAX_ITEMS});
  if(typeof module!=='undefined' && module.exports)module.exports=exported;else g.SegaLocalAdminRequestMonitor=exported;
})(typeof globalThis!=='undefined'?globalThis:window);
