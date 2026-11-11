/* Неподключённый черновик административного окна. Доверенный сервер обязан
 * сам проверять роль, идентификаторы и актуальность решения. Это окно не
 * доставляет уведомления и не подключает настоящие папки. */
(function(g){
  'use strict';
  const disposers=new WeakMap();
  const idRx=/^[a-f0-9]{32}$/;
  const control=/[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
  function disposeAdminAccessView(root){const dispose=disposers.get(root);if(dispose)dispose();}
  function createAdminAccessView(doc,{listRequests,decide,onClose}={}){
    if(!doc || !g.AbortController || typeof listRequests!=='function' || typeof decide!=='function' || typeof onClose!=='function')throw new Error('Неполные действия окна');
    const root=doc.createElement('section');root.className='local-pc-admin-access';root.setAttribute('role','dialog');root.setAttribute('aria-modal','true');root.setAttribute('aria-label','Запросы личных папок');
    const title=doc.createElement('h2');title.textContent='Запросы личных папок';root.appendChild(title);
    const note=doc.createElement('p');note.textContent='Черновик: функция папки ещё не работает. Разрешение не включает синхронизацию и не даёт доступ к файлам других людей.';root.appendChild(note);
    const status=doc.createElement('p');status.setAttribute('role','status');status.setAttribute('aria-live','polite');root.appendChild(status);
    const pendingTitle=doc.createElement('h3');pendingTitle.textContent='Ожидают решения';root.appendChild(pendingTitle);
    const pending=doc.createElement('ul');pending.className='local-pc-admin-list';pending.setAttribute('aria-label','Ожидают решения');root.appendChild(pending);
    const approvedTitle=doc.createElement('h3');approvedTitle.textContent='Разрешено';root.appendChild(approvedTitle);
    const approved=doc.createElement('ul');approved.className='local-pc-admin-list';approved.setAttribute('aria-label','Разрешено');root.appendChild(approved);
    const refresh=doc.createElement('button');refresh.type='button';refresh.dataset.action='refresh';refresh.textContent='Обновить';root.appendChild(refresh);
    const close=doc.createElement('button');close.type='button';close.dataset.action='close';close.textContent='Закрыть';root.appendChild(close);
    let disposed=false,busy=false,epoch=0,active=null;
    function cancel(){epoch++;if(active){active.abort();active=null;}}
    function controls(){refresh.disabled=disposed || busy;close.disabled=disposed;for(const b of root.querySelectorAll('[data-decision]'))b.disabled=disposed || busy;}
    function live(n,signal){return !disposed && n===epoch && !signal.aborted;}
    function sanitize(text){return text.replace(control,'').trim() || 'Без имени';}
    function validList(value){
      if(!value || typeof value!=='object' || Array.isArray(value) || !Array.isArray(value.requests) || !Array.isArray(value.approved)
        || value.requests.length+value.approved.length>5000)throw Error('Неверный список');
      const seen=new Set(),requests=new Set();
      function check(items){return items.map(x=>{
        if(!x || typeof x!=='object' || Array.isArray(x) || typeof x.userId!=='string' || !x.userId || x.userId.length>200 || /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(x.userId)
          || typeof x.name!=='string' || x.name.length>200 || typeof x.requestId!=='string' || !idRx.test(x.requestId)
          || !Number.isSafeInteger(x.requestedAt) || x.requestedAt<=0 || seen.has(x.userId) || requests.has(x.requestId))throw Error('Неверный список');
        seen.add(x.userId);requests.add(x.requestId);return {userId:x.userId,name:sanitize(x.name),requestId:x.requestId};
      });}
      return {requests:check(value.requests),approved:check(value.approved)};
    }
    function clear(){pending.replaceChildren();approved.replaceChildren();}
    function empty(list,text){const li=doc.createElement('li');li.className='local-pc-admin-empty';li.textContent=text;list.appendChild(li);}
    function render(data){
      clear();const renderedAt=epoch;
      function row(item,list,isPending){
        const li=doc.createElement('li'),identity=doc.createElement('div');identity.className='local-pc-admin-identity';
        const name=doc.createElement('bdi');name.textContent=item.name;identity.appendChild(name);
        const id=doc.createElement('small');id.className='local-pc-admin-id';id.dir='ltr';id.textContent='ID: '+item.userId;identity.appendChild(id);li.appendChild(identity);
        if(isPending){
          const actions=doc.createElement('div');actions.className='local-pc-admin-actions';
          for(const [decision,label] of [['approve','Разрешить'],['deny','Отклонить']]){
            const button=doc.createElement('button');button.type='button';button.dataset.decision=decision;button.textContent=label;
            button.setAttribute('aria-label',label+' заявку пользователя '+item.name+' (ID: '+item.userId+')');
            button.addEventListener('click',()=>{if(!button.disabled && renderedAt===epoch)act(item,decision);});actions.appendChild(button);
          }
          li.appendChild(actions);
        }
        list.appendChild(li);
      }
      for(const item of data.requests)row(item,pending,true);
      for(const item of data.approved)row(item,approved,false);
      if(!data.requests.length)empty(pending,'Нет ожидающих заявок.');
      if(!data.approved.length)empty(approved,'Пока никому не разрешено.');
    }
    async function load(n,signal,success){
      const response=await listRequests(signal);
      if(!live(n,signal))return false;
      const data=validList(response);render(data);
      status.textContent=success || (data.requests.length?'Выберите решение по заявке.':'Список обновлён.');return true;
    }
    async function refreshList(){
      if(disposed || busy)return;cancel();const n=epoch;active=new g.AbortController();const signal=active.signal;
      busy=true;clear();controls();status.textContent='Обновляем список…';
      try{await load(n,signal,'');}
      catch(_){if(live(n,signal)){clear();status.textContent='Не удалось получить список. Обновите его перед решением.';}}
      finally{if(live(n,signal)){active=null;busy=false;controls();}}
    }
    async function act(item,decision){
      if(disposed || busy)return;cancel();const n=epoch;active=new g.AbortController();const signal=active.signal;
      busy=true;controls();status.textContent='Отправляем решение…';
      try{
        const result=await decide({userId:item.userId,requestId:item.requestId,decision},signal);
        if(!live(n,signal))return;
        if(!result || result.state!==(decision==='approve'?'approved':'denied'))throw Error('Решение не подтверждено');
        // На повторную отправку по старому списку полагаться нельзя.
        clear();status.textContent='Решение принято. Обновляем список…';
        await load(n,signal,'Решение принято. Список обновлён.');
      }catch(_){if(live(n,signal)){clear();status.textContent='Не удалось подтвердить состояние. Обновите список перед повторным решением.';}}
      finally{if(live(n,signal)){active=null;busy=false;controls();}}
    }
    function dispose(){if(disposed)return;disposed=true;cancel();controls();}
    disposers.set(root,dispose);refresh.addEventListener('click',()=>{if(!refresh.disabled)refreshList();});
    close.addEventListener('click',()=>{if(disposed)return;dispose();try{Promise.resolve(onClose()).catch(()=>{});}catch(_){}});
    controls();Promise.resolve().then(()=>{if(!disposed)refreshList();});return root;
  }
  const exported=Object.freeze({createAdminAccessView,disposeAdminAccessView});
  if(typeof module!=='undefined' && module.exports)module.exports=exported;else g.SegaLocalAdminAccessView=exported;
})(typeof globalThis!=='undefined'?globalThis:window);
