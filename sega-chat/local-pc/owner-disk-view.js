/* Неподключённый черновик окна локального диска. Сам не скачивает и не пишет
 * файлы. Переданные действия и права должны отдельно проверяться; это не UI
 * готового продукта и не защита настоящих файлов. */
(function(g){
  'use strict';
  const paths=typeof module!=='undefined' && module.exports?require('./path-rules'):g.SegaLocalPathRules;
  const previews=typeof module!=='undefined' && module.exports?require('./file-preview-view'):g.SegaLocalFilePreview;
  const disposers=new WeakMap();
  function disposeOwnerDiskView(root){const fn=disposers.get(root);if(fn)fn();}
  function createOwnerDiskView(doc,{listDirectory,transfer,confirmDownload,onClose,loadPreview,createPreviewUrl,revokePreviewUrl,isOnline=()=>!(doc && doc.defaultView && doc.defaultView.navigator && doc.defaultView.navigator.onLine===false)}={}){
    if(!paths || !g.AbortController || !doc || typeof listDirectory!=='function' || !transfer || typeof transfer.transfer!=='function'
      || typeof confirmDownload!=='function' || typeof onClose!=='function' || typeof isOnline!=='function'
      || (loadPreview!==undefined && (typeof loadPreview!=='function' || !previews)))throw new Error('Неполные действия окна');
    const root=doc.createElement('section');root.className='local-pc-disk-view';root.setAttribute('role','dialog');root.setAttribute('aria-modal','true');root.setAttribute('aria-label','Мой локальный диск');
    const header=doc.createElement('header'),title=doc.createElement('h2');title.textContent='Мой локальный диск';header.appendChild(title);
    const note=doc.createElement('p');note.textContent='Черновик: подключение и скачивание ещё не готовы. Проверка файла не сохраняет его на устройство.';header.appendChild(note);
    const toolbar=doc.createElement('div');toolbar.className='local-pc-disk-toolbar';
    function button(action,text){const b=doc.createElement('button');b.type='button';b.dataset.action=action;b.textContent=text;toolbar.appendChild(b);return b;}
    const back=button('back','← Назад'),open=button('open','Открыть папку'),close=button('close','Закрыть');header.appendChild(toolbar);
    const location=doc.createElement('p');location.className='local-pc-disk-location';header.appendChild(location);root.appendChild(header);
    const status=doc.createElement('p');status.className='local-pc-disk-status';status.setAttribute('role','status');status.setAttribute('aria-live','polite');root.appendChild(status);
    const list=doc.createElement('ul');list.className='local-pc-disk-items';root.appendChild(list);
    let disposed=false,currentPath='',items=[],active=null,epoch=0,opened=false,preview=null;
    function label(){location.textContent=currentPath?'Мой локальный диск / '+currentPath:'Мой локальный диск';}
    function cancel(){epoch++;if(active){active.abort();active=null;}}
    function enabled(isBusy){
      open.disabled=disposed || isBusy;back.disabled=disposed || !currentPath;close.disabled=disposed;
      for(const b of list.querySelectorAll('button'))b.disabled=disposed || isBusy;
    }
    function live(n){return !disposed && n===epoch;}
    function offline(){try{return isOnline()===false;}catch(_){return false;}}
    function errorText(){return offline()?'Нет соединения':'Не удалось открыть. Попробуйте ещё раз.';}
    function validItems(raw,parent){
      if(!Array.isArray(raw) || raw.length>5000)throw new Error('Неверный список');
      const seen=new Set();return raw.map(x=>{
        if(!x || typeof x!=='object' || Array.isArray(x) || Object.keys(x).sort().join(',')!=='dir,modified,name,size'
          || typeof x.name!=='string' || paths.partsOf(x.name).length!==1 || typeof x.dir!=='boolean'
          || !Number.isSafeInteger(x.size) || x.size<0 || (x.dir && x.size!==0) || typeof x.modified!=='string' || !x.modified || x.modified.length>100)throw new Error('Неверный список');
        const path=parent?parent+'/'+x.name:x.name;paths.partsOf(path);
        const key=x.name.normalize('NFC').toLowerCase();if(seen.has(key))throw new Error('Имена совпадают');seen.add(key);
        return {name:x.name,dir:x.dir,size:x.size,modified:x.modified,path};
      });
    }
    function render(){
      list.replaceChildren();label();
      for(const item of items){
        const row=doc.createElement('li'),b=doc.createElement('button');b.type='button';b.className='local-pc-disk-item';b.dataset.action=item.dir?'directory':'file';
        const icon=doc.createElement('span');icon.className='local-pc-disk-icon';icon.setAttribute('aria-hidden','true');icon.textContent=item.dir?'📁':'📄';
        const name=doc.createElement('span');name.className='local-pc-disk-name';name.textContent=item.name;
        const type=doc.createElement('span');type.className='local-pc-disk-type';type.textContent=item.dir?'Папка':'Файл';
        b.append(icon,name,type);b.setAttribute('aria-label',(item.dir?'Открыть папку ':loadPreview?'Открыть файл ':'Получить файл ')+item.name);
        b.addEventListener('click',()=>{if(disposed || b.disabled || preview)return;if(item.dir)navigate(item.path);else if(loadPreview)openPreview(item);else getFile(item.path);});row.appendChild(b);
        if(!item.dir && loadPreview){const save=doc.createElement('button');save.type='button';save.dataset.action='get-file';save.className='local-pc-disk-get';save.textContent='Скачать';
          save.setAttribute('aria-label','Скачать файл '+item.name);save.addEventListener('click',()=>{if(!disposed && !save.disabled && !preview)getFile(item.path);});row.appendChild(save);}
        list.appendChild(row);
      }
      enabled(false);
    }
    async function navigate(target){
      if(disposed || preview)return;cancel();if(offline()){enabled(false);status.textContent='Нет соединения';return;}
      const n=epoch,controller=new g.AbortController();active=controller;enabled(true);status.textContent='Открываем папку…';
      try {
        const result=await listDirectory(target,controller.signal);
        if(!live(n) || controller.signal.aborted)return;
        const checked=validItems(result,target);if(!live(n))return;
        currentPath=target;items=checked;opened=true;render();status.textContent=items.length?'Выберите файл или папку.':'Папка пуста.';
      } catch(_) {if(live(n) && !controller.signal.aborted)status.textContent=errorText();}
      finally {if(live(n)){active=null;enabled(false);}}
    }
    function closePreview(){if(!preview)return;previews.disposeFilePreview(preview);preview.remove();preview=null;root.removeAttribute('aria-hidden');}
    function openPreview(item){
      if(disposed || preview)return;if(offline()){status.textContent='Нет соединения';return;}
      cancel();const parent=currentPath,files=items.filter(x=>!x.dir).map(x=>x.name),index=files.indexOf(item.name);
      try {
        preview=previews.createFilePreview(doc,{files,index,
          load:(name,signal)=>loadPreview(parent?parent+'/'+name:name,signal),
          createUrl:createPreviewUrl,revokeUrl:revokePreviewUrl,
          onClose(){preview=null;root.removeAttribute('aria-hidden');if(!disposed){enabled(false);status.textContent='Выберите файл или папку.';}}});
        root.setAttribute('aria-hidden','true');enabled(true);doc.body.appendChild(preview);
      } catch(_) {closePreview();enabled(false);status.textContent=errorText();}
    }
    async function getFile(path){
      if(disposed || preview)return;cancel();if(offline()){enabled(false);status.textContent='Нет соединения';return;}
      const n=epoch,controller=new g.AbortController();active=controller;enabled(true);status.textContent='Ожидаем подтверждения…';let result;
      try {
        const consent=await confirmDownload('Скачать файл на устройство?');
        if(!live(n) || controller.signal.aborted)return;
        if(consent!==true){status.textContent='Скачивание отменено.';return;}
        status.textContent='Проверяем файл…';
        result=await transfer.transfer({path,signal:controller.signal,confirmDownload:()=>true,onProgress:p=>{
          if(!live(n) || controller.signal.aborted || !p || !Number.isSafeInteger(p.received) || !Number.isSafeInteger(p.total) || p.received<0 || p.total<0 || p.received>p.total)return;
          status.textContent=p.verified?'Файл проверен.':'Проверяем файл: '+p.received+' из '+p.total+' байт.';
        }});
        if(!live(n) || controller.signal.aborted)return;
        if(!result || !(result.data instanceof Uint8Array) || !Number.isSafeInteger(result.size) || result.data.length!==result.size)throw new Error('Неверный файл');
        status.textContent='Файл проверен. Скачивание пока не подключено.';
      } catch(_) {if(live(n) && !controller.signal.aborted)status.textContent=errorText();}
      finally {
        // Нельзя гарантировать очистку всех копий или памяти браузера.
        try{if(result && result.data instanceof Uint8Array)result.data.fill(0);}catch(_){}
        if(live(n)){active=null;enabled(false);}
      }
    }
    const win=doc.defaultView;
    function onOffline(){if(disposed || !offline())return;cancel();closePreview();enabled(false);status.textContent='Нет соединения';}
    function onOnline(){if(disposed || offline())return;if(status.textContent==='Нет соединения')status.textContent='Соединение восстановлено. Откройте папку ещё раз.';}
    if(win && typeof win.addEventListener==='function'){win.addEventListener('offline',onOffline);win.addEventListener('online',onOnline);}
    function dispose(){if(disposed)return;disposed=true;cancel();closePreview();if(win && typeof win.removeEventListener==='function'){win.removeEventListener('offline',onOffline);win.removeEventListener('online',onOnline);}enabled(false);}
    disposers.set(root,dispose);label();back.disabled=true;status.textContent=offline()?'Нет соединения':'Нажмите «Открыть папку».';
    open.addEventListener('click',()=>{if(!disposed && !open.disabled)navigate(opened?currentPath:'');});
    back.addEventListener('click',()=>{if(!disposed && !back.disabled)navigate(currentPath.split('/').slice(0,-1).join('/'));});
    close.addEventListener('click',()=>{if(disposed)return;dispose();try{Promise.resolve(onClose()).catch(()=>{});}catch(_){}});
    return root;
  }
  const exported=Object.freeze({createOwnerDiskView,disposeOwnerDiskView});
  if(typeof module!=='undefined' && module.exports)module.exports=exported;else g.SegaLocalOwnerDiskView=exported;
})(typeof globalThis!=='undefined'?globalThis:window);
