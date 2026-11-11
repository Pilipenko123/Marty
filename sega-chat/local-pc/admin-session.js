/* Лабораторная сборка индикатора и окна под одну сессию. НЕ подключена к
 * приложению, не проверяет роль сама и не доставляет push. Вход/выход, роль,
 * размещение DOM и немедленный вызов dispose обеспечивает будущая оболочка. */
(function(g){
  'use strict';
  const TOKEN=/^[a-f0-9]{48}$/;
  function createAdminSession(doc,{getToken,createAccessHttp,createMonitor,createIndicator,createAdminView,disposeAdminView}={}){
    if(!doc || typeof getToken!=='function' || typeof createAccessHttp!=='function' || typeof createMonitor!=='function'
      || typeof createIndicator!=='function' || typeof createAdminView!=='function' || typeof disposeAdminView!=='function')throw Error('Неполные параметры сессии');
    const root=doc.createElement('div');root.className='local-pc-admin-session';
    let started=false,ended=false,token=null,indicator=null,dialog=null;
    function closeDialog(){
      const old=dialog;dialog=null;if(!old)return;
      try{disposeAdminView(old);}finally{old.replaceChildren();old.remove();}
    }
    function dispose(){
      if(ended)return;ended=true;token=null;
      try{if(indicator)indicator.dispose();}finally{try{closeDialog();}finally{root.replaceChildren();}}
    }
    function current(){
      if(ended || !started || token===null)return false;
      let actual;try{actual=getToken();}catch(_){dispose();return false;}
      if(actual!==token){dispose();return false;}
      return true;
    }
    function ensure(){if(!current())throw Error('Сессия недоступна');}
    function start(){
      if(ended || started)return false;
      let t;try{t=getToken();}catch(_){dispose();return false;}
      if(typeof t!=='string' || !TOKEN.test(t)){dispose();return false;}
      token=t;started=true;
      try{
        // Геттер повторно проверяется и при старте и при завершении каждого
        // запроса HTTP-клиента; старый объект не может взять токен нового входа.
        const http=createAccessHttp({getToken:()=>current()?token:null});
        const listRequests=async signal=>{ensure();const data=await http.listRequests(signal);ensure();return data;};
        const decide=async (input,signal)=>{ensure();const data=await http.decide(input,signal);ensure();return data;};
        indicator=createIndicator(doc,{createMonitor,listRequests,onOpen:()=>{
          ensure();if(dialog)return;
          const view=createAdminView(doc,{listRequests,decide,onClose:()=>{closeDialog();if(current() && indicator)indicator.refresh();}});
          dialog=view;root.appendChild(view);
        }});
        root.appendChild(indicator.root);indicator.start();return true;
      }catch(_){dispose();return false;}
    }
    // Позволяет хозяину явно проверить текущую сессию, но не заменяет
    // немедленный dispose при выходе: сама по себе смена токена DOM не очистит.
    function checkSession(){return current();}
    function refresh(){if(!current() || !indicator)return false;return indicator.refresh();}
    return Object.freeze({root,start,dispose,checkSession,refresh});
  }
  const exported=Object.freeze({createAdminSession});
  if(typeof module!=='undefined' && module.exports)module.exports=exported;else g.SegaLocalAdminSession=exported;
})(typeof globalThis!=='undefined'?globalThis:window);
