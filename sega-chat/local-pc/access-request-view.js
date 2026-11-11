/* Пробное неподключённое окно запроса. Разрешение решает только сервер;
 * обработчики ниже передаёт оболочка. Нет настоящего подключения и скачивания. */
(function(g){
  'use strict';
  const disposers=new WeakMap();
  function disposeAccessRequestView(root){const f=disposers.get(root);if(f)f();}
  function createAccessRequestView(doc,{getStatus,requestAccess,onClose}={}){
    if(!doc || !g.AbortController || typeof getStatus!=='function' || typeof requestAccess!=='function' || typeof onClose!=='function')throw new Error('Неполные действия окна');
    const root=doc.createElement('section');root.className='local-pc-access-request';root.setAttribute('role','dialog');root.setAttribute('aria-modal','true');root.setAttribute('aria-label','Запрос доступа к личной папке');
    const title=doc.createElement('h2');title.textContent='Личная папка на ПК';root.appendChild(title);
    const intro=doc.createElement('p');intro.textContent='Можно будет выбрать папку на своём компьютере и открывать её с других устройств. Синхронизацию с несколькими ПК и папкой Google или Яндекс Диска нужно будет включить отдельно.';root.appendChild(intro);
    const details=doc.createElement('p');details.textContent='После включения синхронизации изменения распространяются между подключёнными копиями. Удалённые файлы и папки должны попадать в корзины устройств и облачного диска. Другим людям менять файлы можно только с вашего разрешения.';root.appendChild(details);
    const draft=doc.createElement('p');draft.textContent='Черновик: подключение пока не работает. Сначала запросите разрешение администратора; запрос сам по себе не выбирает папку и не запускает синхронизацию.';root.appendChild(draft);
    const status=doc.createElement('p');status.setAttribute('role','status');status.setAttribute('aria-live','polite');root.appendChild(status);
    const ask=doc.createElement('button');ask.type='button';ask.dataset.action='request';ask.textContent='Запросить подключение моей папки';root.appendChild(ask);
    const refresh=doc.createElement('button');refresh.type='button';refresh.dataset.action='refresh';refresh.textContent='Проверить статус';root.appendChild(refresh);
    const close=doc.createElement('button');close.type='button';close.dataset.action='close';close.textContent='Закрыть';root.appendChild(close);
    const messages={none:'Разрешение администратора ещё не запрошено.',pending:'Запрос отправлен. Ожидаем решения администратора.',approved:'Администратор разрешил функцию. Подключение пока не готово.',denied:'Администратор отклонил запрос. Можно обратиться повторно.',revoked:'Разрешение отозвано. Можно обратиться повторно.'};
    let disposed=false,epoch=0,controller=null,current=null,busy=false;
    function controls(){ask.disabled=disposed || busy || !['none','denied','revoked'].includes(current);refresh.disabled=disposed || busy;close.disabled=disposed;}
    function cancel(){epoch++;if(controller){controller.abort();controller=null;}}
    async function run(submit){
      if(disposed || busy)return;cancel();const n=epoch;controller=new g.AbortController();const signal=controller.signal;busy=true;controls();status.textContent=submit?'Отправляем запрос…':'Проверяем статус…';
      try{
        const result=await (submit?requestAccess(signal):getStatus(signal));
        if(disposed || n!==epoch || signal.aborted)return;
        if(!result || typeof result!=='object' || !Object.prototype.hasOwnProperty.call(messages,result.state))throw new Error('Неверное состояние');
        current=result.state;status.textContent=messages[current];
      }catch(_){if(!disposed && n===epoch && !signal.aborted){current=null;status.textContent='Не удалось подтвердить статус. Проверьте его перед повторным запросом.';}}
      finally{if(!disposed && n===epoch){controller=null;busy=false;controls();}}
    }
    function dispose(){if(disposed)return;disposed=true;cancel();controls();}
    disposers.set(root,dispose);ask.addEventListener('click',()=>{if(!ask.disabled)run(true);});refresh.addEventListener('click',()=>{if(!refresh.disabled)run(false);});
    close.addEventListener('click',()=>{if(disposed)return;dispose();try{Promise.resolve(onClose()).catch(()=>{});}catch(_){}});
    controls();run(false);return root;
  }
  const exported=Object.freeze({createAccessRequestView,disposeAccessRequestView});
  if(typeof module!=='undefined' && module.exports)module.exports=exported;else g.SegaLocalAccessRequestView=exported;
})(typeof globalThis!=='undefined'?globalThis:window);
