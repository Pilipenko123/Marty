/* Неподключённый просмотр пробных данных в памяти. Не скачивает файлы и не
 * проверяет права, подлинность источника или безопасность Windows. load должен
 * предоставлять только разрешённые и проверенные байты, не сохранять файл и
 * передавать владение буфером окну. */
(function(g){
  'use strict';
  const paths=typeof module!=='undefined' && module.exports?require('./path-rules'):g.SegaLocalPathRules;
  const disposers=new WeakMap(),activeDocs=new WeakMap(),MAX_BYTES=8*1024*1024;
  const TEXT=/\.(?:txt|md|csv|json|log|xml|yaml|yml|ini|html|css|js)$/i;
  const IMAGE=/\.(?:png|jpe?g|gif|webp)$/i;
  function disposeFilePreview(root){const f=disposers.get(root);if(f)f();}
  function clearBytes(bytes){try{if(bytes instanceof Uint8Array)bytes.fill(0);}catch(_){}}
  function imageType(bytes){
    if(bytes.length>=8 && [137,80,78,71,13,10,26,10].every((n,i)=>bytes[i]===n))return 'image/png';
    if(bytes.length>=3 && bytes[0]===255 && bytes[1]===216 && bytes[2]===255)return 'image/jpeg';
    if(bytes.length>=6 && (String.fromCharCode(...bytes.subarray(0,6))==='GIF87a' || String.fromCharCode(...bytes.subarray(0,6))==='GIF89a'))return 'image/gif';
    if(bytes.length>=12 && String.fromCharCode(...bytes.subarray(0,4))==='RIFF' && String.fromCharCode(...bytes.subarray(8,12))==='WEBP')return 'image/webp';
    return null;
  }
  function extensionMatches(name,type){
    if(type==='image/png')return /\.png$/i.test(name);
    if(type==='image/jpeg')return /\.jpe?g$/i.test(name);
    if(type==='image/gif')return /\.gif$/i.test(name);
    if(type==='image/webp')return /\.webp$/i.test(name);
    return false;
  }
  function decodeText(bytes){
    let encoding='utf-8',offset=0;
    if(bytes.length>=3 && bytes[0]===239 && bytes[1]===187 && bytes[2]===191)offset=3;
    else if(bytes.length>=2 && bytes[0]===255 && bytes[1]===254){encoding='utf-16le';offset=2;}
    else if(bytes.length>=2 && bytes[0]===254 && bytes[1]===255){encoding='utf-16be';offset=2;}
    let text;try{text=new TextDecoder(encoding,{fatal:true}).decode(bytes.subarray(offset));}catch(_){throw new Error('Неверный текст');}
    // Не показываем очевидные двоичные данные под видом текста.
    if(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(text))throw new Error('Неверный текст');
    return text;
  }
  function createFilePreview(doc,{files,index=0,load,onClose,createUrl,revokeUrl}={}){
    if(!paths || !g.AbortController || !doc || !doc.defaultView || !Array.isArray(files) || !files.length || files.length>5000
      || !Number.isInteger(index) || index<0 || index>=files.length || typeof load!=='function' || typeof onClose!=='function')throw new Error('Неверные параметры просмотра');
    if(activeDocs.has(doc))throw new Error('Просмотр уже открыт');
    const names=[],seen=new Set();
    for(const name of files){
      if(typeof name!=='string' || paths.partsOf(name).length!==1)throw new Error('Неверное имя файла');
      const folded=name.normalize('NFC').toLowerCase();if(seen.has(folded))throw new Error('Имена совпадают');seen.add(folded);names.push(name);
    }
    const nativeUrl=doc.defaultView.URL;
    const makeUrl=createUrl || (nativeUrl && typeof nativeUrl.createObjectURL==='function' ? blob=>nativeUrl.createObjectURL(blob) : null);
    const dropUrl=revokeUrl || (nativeUrl && typeof nativeUrl.revokeObjectURL==='function' ? url=>nativeUrl.revokeObjectURL(url) : null);
    if((createUrl!==undefined && typeof createUrl!=='function') || (revokeUrl!==undefined && typeof revokeUrl!=='function') || (!!makeUrl!==!!dropUrl))throw new Error('Неверные параметры просмотра');
    const root=doc.createElement('section');root.className='local-file-preview';root.setAttribute('role','dialog');root.setAttribute('aria-modal','true');root.setAttribute('aria-label','Просмотр файла');
    const head=doc.createElement('header'),title=doc.createElement('h2');title.className='local-file-preview-title';head.appendChild(title);
    function button(action,text){const b=doc.createElement('button');b.type='button';b.dataset.action=action;b.textContent=text;head.appendChild(b);return b;}
    const prev=button('previous','← Предыдущее фото'),next=button('next','Следующее фото →'),close=button('close','Закрыть');root.appendChild(head);
    const status=doc.createElement('p');status.className='local-file-preview-status';status.setAttribute('role','status');status.setAttribute('aria-live','polite');root.appendChild(status);
    const content=doc.createElement('div');content.className='local-file-preview-content';root.appendChild(content);
    let disposed=false,current=index,epoch=0,active=null,url=null,touch=null;
    function clearUrl(){if(url!==null){try{dropUrl(url);}catch(_){}url=null;}}
    function cancel(){epoch++;if(active){active.abort();active=null;}}
    function adjacent(step){if(!IMAGE.test(names[current]))return -1;for(let i=current+step;i>=0 && i<names.length;i+=step)if(IMAGE.test(names[i]))return i;return -1;}
    function controls(){prev.disabled=disposed || adjacent(-1)<0;next.disabled=disposed || adjacent(1)<0;close.disabled=disposed;}
    function live(n){return !disposed && n===epoch;}
    async function show(which){
      if(disposed || which<0 || which>=names.length)return;
      cancel();const n=epoch,controller=new g.AbortController();active=controller;current=which;
      clearUrl();content.replaceChildren();title.textContent=names[current];controls();
      const isText=TEXT.test(names[current]),isImage=IMAGE.test(names[current]);
      if(!isText && !isImage){status.textContent='Не удалось показать этот файл текстом. Формат пока не поддерживается.';active=null;return;}
      status.textContent='Открываем файл…';let bytes;
      try {
        bytes=await Promise.resolve().then(()=>{if(!live(n) || controller.signal.aborted)throw new Error('Просмотр закрыт');return load(names[which],controller.signal);});
        if(!live(n) || controller.signal.aborted)return;
        if(!(bytes instanceof Uint8Array) || bytes.byteLength>MAX_BYTES)throw new Error('Неверные данные');
        if(isText){
          const text=decodeText(bytes),paper=doc.createElement('pre');paper.className='local-file-preview-paper';paper.textContent=text;content.appendChild(paper);status.textContent='';
        }else{
          const type=imageType(bytes);
          if(!type || !extensionMatches(names[current],type) || !makeUrl || !dropUrl)throw new Error('Неверное изображение');
          const objectUrl=makeUrl(new doc.defaultView.Blob([bytes],{type}));
          if(!live(n) || controller.signal.aborted){try{dropUrl(objectUrl);}catch(_){}return;}
          if(typeof objectUrl!=='string' || !objectUrl.startsWith('blob:')){try{dropUrl(objectUrl);}catch(_){}throw new Error('Неверная ссылка');}
          url=objectUrl;const image=doc.createElement('img');image.alt=names[current];image.className='local-file-preview-image';
          image.addEventListener('error',()=>{if(live(n)){clearUrl();content.replaceChildren();status.textContent='Не удалось показать фотографию.';}});
          image.src=url;content.appendChild(image);status.textContent='';
        }
      }catch(_){if(live(n) && !controller.signal.aborted)status.textContent=isText?'Не удалось показать документ текстом. Формат или кодировка не поддерживается.':'Не удалось показать фотографию.';}
      finally {clearBytes(bytes);if(live(n))active=null;}
    }
    function move(step){const target=adjacent(step);if(!disposed && target>=0)show(target);}
    function keydown(event){if(disposed || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)return;
      if(event.key==='ArrowLeft' && adjacent(-1)>=0){event.preventDefault();move(-1);}
      if(event.key==='ArrowRight' && adjacent(1)>=0){event.preventDefault();move(1);}
      if(event.key==='Escape'){event.preventDefault();finish();}}
    function touchStart(event){const t=event.touches && event.touches.length===1 && event.touches[0];touch=t?{x:t.clientX,y:t.clientY}:null;}
    function touchEnd(event){const t=event.changedTouches && event.changedTouches.length===1 && event.changedTouches[0];if(!touch || !t)return;
      const dx=t.clientX-touch.x,dy=t.clientY-touch.y;touch=null;
      if(Math.abs(dx)>=50 && Math.abs(dx)>Math.abs(dy)*1.5)move(dx<0?1:-1);}
    function dispose(){if(disposed)return;disposed=true;cancel();clearUrl();doc.removeEventListener('keydown',keydown);root.removeEventListener('touchstart',touchStart);root.removeEventListener('touchend',touchEnd);content.replaceChildren();controls();if(activeDocs.get(doc)===root)activeDocs.delete(doc);}
    function finish(){if(disposed)return;dispose();root.remove();try{Promise.resolve(onClose()).catch(()=>{});}catch(_){}}
    disposers.set(root,dispose);activeDocs.set(doc,root);doc.addEventListener('keydown',keydown);root.addEventListener('touchstart',touchStart,{passive:true});root.addEventListener('touchend',touchEnd,{passive:true});
    prev.addEventListener('click',()=>move(-1));next.addEventListener('click',()=>move(1));close.addEventListener('click',finish);show(index);
    return root;
  }
  const exported=Object.freeze({createFilePreview,disposeFilePreview,MAX_BYTES});
  if(typeof module!=='undefined' && module.exports)module.exports=exported;else g.SegaLocalFilePreview=exported;
})(typeof globalThis!=='undefined'?globalThis:window);
