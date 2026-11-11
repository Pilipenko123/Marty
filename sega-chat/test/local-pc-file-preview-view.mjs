// Только jsdom и фиктивные данные в памяти: нет настоящего браузера, Windows,
// скачивания, декодирования изображения браузером или реальных прав доступа.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';
import {createRequire} from 'node:module';
const {createFilePreview,disposeFilePreview,MAX_BYTES}=createRequire(import.meta.url)('../local-pc/file-preview-view.js');
const dom=new JSDOM('<!doctype html><body><div id="folder">Содержимое папки</div></body>'),doc=dom.window.document;
const tick=()=>new Promise(r=>setTimeout(r,5));
async function until(fn){for(let i=0;i<100;i++){if(fn())return;await tick();}assert.fail('Окно не завершило действие');}
let closes=0,requests=[],created=[],revoked=[],returned=[];
const png=Uint8Array.from([137,80,78,71,13,10,26,10,1]),jpg=Uint8Array.from([255,216,255,0]),webp=Uint8Array.from([82,73,70,70,0,0,0,0,87,69,66,80]);
let sources={'один.png':png,'два.jpg':jpg,'три.webp':webp,'текст.txt':new TextEncoder().encode('Привет! <script>опасность</script>')};
const opts={files:['один.png','текст.txt','два.jpg','три.webp'],index:0,load:async(name,signal)=>{requests.push({name,signal});const b=Uint8Array.from(sources[name]);returned.push(b);return b;},
  onClose(){closes++;},createUrl(blob){created.push(blob);return 'blob:test/'+created.length;},revokeUrl(url){revoked.push(url);}};
const view=createFilePreview(doc,opts);doc.body.appendChild(view);const action=n=>view.querySelector(`[data-action="${n}"]`),title=()=>view.querySelector('h2').textContent;
await until(()=>!!view.querySelector('img'));assert.equal(title(),'один.png');assert.equal(created[0].type,'image/png');assert(returned[0].every(x=>x===0));
assert.equal(action('previous').disabled,true);assert.equal(action('next').disabled,false);
assert.throws(()=>createFilePreview(doc,opts),/уже открыт/);
// Стрелки на клавиатуре переходят только по фото, пропуская документы.
doc.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}));
await until(()=>title()==='два.jpg' && created.length===2);assert.equal(created[1].type,'image/jpeg');assert.deepEqual(revoked,['blob:test/1']);
// Телефонный жест: смахивание влево — следующее фото, вправо — предыдущее.
function swipe(startX,endX,startY=30,endY=30){
  const a=new dom.window.Event('touchstart',{bubbles:true});Object.defineProperty(a,'touches',{value:[{clientX:startX,clientY:startY}]});view.dispatchEvent(a);
  const b=new dom.window.Event('touchend',{bubbles:true});Object.defineProperty(b,'changedTouches',{value:[{clientX:endX,clientY:endY}]});view.dispatchEvent(b);
}
swipe(200,50);await until(()=>title()==='три.webp' && created.length===3);assert.equal(created[2].type,'image/webp');assert.equal(action('next').disabled,true);
swipe(200,50);assert.equal(title(),'три.webp');swipe(50,200);await until(()=>title()==='два.jpg' && created.length===4);
// Вертикальный жест не перелистывает.
swipe(50,120,0,150);await tick();assert.equal(title(),'два.jpg');
// Повреждённое изображение не показывает страницу с ошибкой и освобождает URL.
view.querySelector('img').dispatchEvent(new dom.window.Event('error'));assert.match(view.querySelector('[role=status]').textContent,/Не удалось показать фотографию/);
assert(!view.querySelector('img'));assert(revoked.includes('blob:test/4'));
action('close').click();assert.equal(closes,1);assert.equal(doc.body.contains(view),false);assert(doc.querySelector('#folder'));assert.equal(action('close').disabled,true);
const count=requests.length;doc.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));assert.equal(requests.length,count);

// Русский текст и HTML-код отображаются именно текстом на белом «листе».
const text=createFilePreview(doc,{...opts,index:1});doc.body.appendChild(text);await until(()=>!!text.querySelector('pre'));
assert.equal(text.querySelector('pre').textContent,'Привет! <script>опасность</script>');assert.equal(text.querySelector('script'),null);
assert.equal(text.querySelectorAll('iframe,object,embed,a[download]').length,0);
assert.equal(text.querySelector('[data-action=next]').disabled,true);
doc.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));assert.equal(text.querySelector('h2').textContent,'текст.txt');
doc.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));assert.equal(doc.body.contains(text),false);assert.equal(closes,2);

// UTF-8 и UTF-16 с меткой отображаются; неверная кодировка/двоичные данные
// дают понятную надпись, а не попытку интерпретировать исполняемый документ.
async function checkText(name,data,expected){
  const owned=Uint8Array.from(data);const v=createFilePreview(doc,{files:[name],load:async()=>owned,onClose(){}});doc.body.appendChild(v);
  await until(()=>!!v.querySelector('pre') || v.querySelector('[role=status]').textContent.startsWith('Не удалось'));
  if(expected!==null)assert.equal(v.querySelector('pre').textContent,expected);
  else {assert.equal(v.querySelector('pre'),null);assert.match(v.textContent,/Не удалось показать документ текстом/);}
  assert(owned.every(n=>n===0));disposeFilePreview(v);v.remove();
}
await checkText('a.txt',Buffer.from('Привет мир','utf8'),'Привет мир');
await checkText('a.txt',Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from('Привет','utf16le')]),'Привет');
const le=Buffer.from('Привет','utf16le');const be=Buffer.alloc(le.length);for(let i=0;i<le.length;i+=2){be[i]=le[i+1];be[i+1]=le[i];}
await checkText('a.txt',Buffer.concat([Buffer.from([0xfe,0xff]),be]),'Привет');
await checkText('a.txt',Buffer.from([0xff,0x80,0x90]),null);
await checkText('a.txt',Buffer.from([0,1,2,3]),null);
await checkText('a.txt',Buffer.alloc(MAX_BYTES+1,65),null);
let unsupportedLoads=0;const unsupported=createFilePreview(doc,{files:['документ.docx'],load:async()=>{unsupportedLoads++;},onClose(){}});doc.body.appendChild(unsupported);
assert.match(unsupported.textContent,/Формат пока не поддерживается/);assert.equal(unsupportedLoads,0);disposeFilePreview(unsupported);unsupported.remove();
// Внешняя ссылка вместо blob запрещена, даже если заголовок изображения похож.
let badUrlRevoked=0;
const unsafeUrl=createFilePreview(doc,{files:['a.png'],load:async()=>Uint8Array.from(png),onClose(){},createUrl:()=> 'https://outside.example/file',revokeUrl(){badUrlRevoked++;}});
doc.body.appendChild(unsafeUrl);await until(()=>unsafeUrl.textContent.includes('Не удалось показать фотографию'));assert.equal(unsafeUrl.querySelector('img'),null);assert.equal(badUrlRevoked,1);disposeFilePreview(unsafeUrl);unsafeUrl.remove();
const fakeImage=createFilePreview(doc,{files:['подмена.png'],load:async()=>new TextEncoder().encode('<html>'),onClose(){},createUrl:()=>{throw Error('must not call')},revokeUrl(){}});
doc.body.appendChild(fakeImage);await until(()=>fakeImage.textContent.includes('Не удалось показать фотографию'));assert.equal(fakeImage.querySelector('img'),null);disposeFilePreview(fakeImage);fakeImage.remove();

// Закрытие и переключение отменяют зависимость и блокируют запоздавшие ответы.
let releaseFirst,firstSignal;const staleBytes=Uint8Array.from(png),freshBytes=Uint8Array.from(jpg);let staleUrls=0;
const stale=createFilePreview(doc,{files:['a.png','b.jpg'],load:(name,signal)=>{
  if(name==='a.png'){firstSignal=signal;return new Promise(r=>{releaseFirst=r;});}return Promise.resolve(freshBytes);
},onClose(){},createUrl:()=>{staleUrls++;return 'blob:test/new';},revokeUrl(){}});doc.body.appendChild(stale);
await until(()=>!!releaseFirst);stale.querySelector('[data-action=next]').click();await until(()=>stale.querySelector('h2').textContent==='b.jpg' && !!stale.querySelector('img'));
assert.equal(firstSignal.aborted,true);releaseFirst(staleBytes);await tick();assert(staleBytes.every(x=>x===0));assert.equal(staleUrls,1);assert.equal(stale.querySelector('h2').textContent,'b.jpg');
disposeFilePreview(stale);disposeFilePreview(stale);stale.remove();
let releaseLate,lateSignal;const lateBytes=Uint8Array.from(png);
const late=createFilePreview(doc,{files:['a.png'],load:(_n,signal)=>{lateSignal=signal;return new Promise(r=>{releaseLate=r;});},onClose(){},createUrl:()=>{throw Error('late')},revokeUrl(){}});
doc.body.appendChild(late);await until(()=>!!releaseLate);late.querySelector('[data-action=close]').click();assert(lateSignal.aborted);releaseLate(lateBytes);await tick();assert(lateBytes.every(x=>x===0));assert.equal(late.querySelector('img'),null);
// Если окно закрыли до начала отложенного чтения, обработчик не вызывается.
let neverStarted=0;
const immediately=createFilePreview(doc,{files:['a.txt'],load:async()=>{neverStarted++;return new Uint8Array();},onClose(){}});
doc.body.appendChild(immediately);immediately.querySelector('[data-action=close]').click();await tick();assert.equal(neverStarted,0);
assert.throws(()=>createFilePreview(doc,{files:['../bad'],load(){},onClose(){}}));
assert.throws(()=>createFilePreview(doc,{files:['x.txt','X.txt'],load(){},onClose(){}}));
assert.throws(()=>createFilePreview(doc,{files:[],load(){},onClose(){}}));
const css=fs.readFileSync(new URL('../local-pc/file-preview-view.css',import.meta.url),'utf8');assert.match(css,/position:\s*fixed/);assert.match(css,/inset:\s*0/);assert.match(css,/background:\s*#fff/);assert.match(css,/@media/);
// Проверка загрузки без require и Buffer.
const ctx=vm.createContext({AbortController,TextDecoder,Uint8Array});
for(const f of ['path-rules.js','file-preview-view.js'])vm.runInContext(fs.readFileSync(new URL('../local-pc/'+f,import.meta.url),'utf8'),ctx);
const vmView=ctx.SegaLocalFilePreview.createFilePreview(doc,{files:['a.txt'],load:async()=>new TextEncoder().encode('Текст'),onClose(){}});
doc.body.appendChild(vmView);await until(()=>!!vmView.querySelector('pre'));assert.equal(vmView.querySelector('pre').textContent,'Текст');ctx.SegaLocalFilePreview.disposeFilePreview(vmView);
dom.window.close();
console.log('local-pc-file-preview-view: текст, белый фон, фото, клавиши, жесты и отмена проверены в jsdom; настоящий браузер и Windows не проверены');
