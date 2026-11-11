'use strict';

// Черновик имён для версий файлов. НИЧЕГО не создаёт и не разрешает конфликт.
// Переданные версии и списки не доказывают полноту, идентичность или историю;
// сравнение имён не заменяет атомарное создание и проверку на Windows/в облаке.
const {partsOf, MAX_ENTRIES} = require('./folder');
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_ATTEMPTS = 10000, MAX_MEMBERS = 32;

function wellFormed(s) {
  for (let i=0;i<s.length;i++) {
    const n=s.charCodeAt(i);
    if (n>=0xd800 && n<=0xdbff) {
      if (++i>=s.length || s.charCodeAt(i)<0xdc00 || s.charCodeAt(i)>0xdfff) return false;
    } else if (n>=0xdc00 && n<=0xdfff) return false;
  }
  return true;
}
function checkName(name) {
  if (typeof name!=='string' || !wellFormed(name) || partsOf(name).length!==1) throw new Error('Неверное имя файла');
}
function version(file) {
  if (!file || file.type!=='file' || typeof file.hash!=='string' || !HASH.test(file.hash)
      || !Number.isSafeInteger(file.size) || file.size<0) throw new Error('Версия файла не проверена');
  return {type:'file',hash:file.hash,size:file.size};
}
function folded(s) { return s.normalize('NFC').toLowerCase(); }
function trimToUnits(s, max) {
  let out='';
  for (const ch of s) { if(out.length+ch.length>max) break; out+=ch; }
  return out;
}
function target(path){
  if (typeof path!=='string' || !wellFormed(path)) throw new Error('Неверный путь');
  const parts=partsOf(path);
  if (!parts.length) throw new Error('Неверный путь');
  return {name:parts[parts.length-1],parent:parts.slice(0,-1).join('/')};
}
function addNames(list,name,occupied){
  if (!Array.isArray(list) || list.length>MAX_ENTRIES) throw new Error('Неполный или слишком большой список папки');
  if (!list.includes(name)) throw new Error('Файл отсутствует в списке папки');
  const seen=new Set();
  for(const n of list){
    checkName(n);const key=folded(n);
    // Разные имена одного каталога, совпадающие в нашей модели сравнения,
    // делают источник неоднозначным. Между участниками совпадения допустимы.
    if(seen.has(key))throw new Error('Имена в списке папки неоднозначны');
    seen.add(key);occupied.add(key);
  }
}
function nextName({name,parent},occupied){
  const dot=name.lastIndexOf('.');
  const ext=dot>0 ? name.slice(dot) : '', stem=dot>0 ? name.slice(0,dot) : name;
  // UTF-16 для предварительного лимита; суррогатные пары не разрываются.
  const available=Math.min(255,4096-(parent ? parent.length+1 : 0));
  for(let i=1;i<=MAX_ATTEMPTS;i++) {
    const suffix=' (другая версия'+(i===1?'':' - '+i)+')';
    const prefix=trimToUnits(stem,available-suffix.length-ext.length);
    if (!prefix) throw new Error('Не удалось подобрать имя с исходным расширением');
    const candidate=prefix+suffix+ext;
    checkName(candidate);
    const key=folded(candidate);
    if (!occupied.has(key)) {occupied.add(key);return parent ? parent+'/'+candidate : candidate;}
  }
  throw new Error('Не удалось подобрать свободное имя');
}
/** Только предположение для двух сторон, не выполнение и не проверка флагов. */
function suggestConflictName({path, left, right, leftNames, rightNames, leftComplete, rightComplete} = {}) {
  if (leftComplete!==true || rightComplete!==true) throw new Error('Списки папок не подтверждены');
  const t=target(path),l=version(left),r=version(right);
  if (l.hash===r.hash && l.size===r.size) throw new Error('Версии совпадают');
  const occupied=new Set();addNames(leftNames,t.name,occupied);addNames(rightNames,t.name,occupied);
  return {original:path,alternate:nextName(t,occupied),left:l,right:r};
}
/**
 * Условная группа из 2–32 участников с файлом в каждом переданном списке.
 * Одна запись на заявленную версию (хеш+размер), для всех разных версий
 * предлагаются непересекающиеся имена. Для воспроизводимости исходное имя
 * присваивается версии первого ID по сортировке; это не решение о перезаписи
 * оригиналов и не указание, как разрешать реальный конфликт. Отсутствие файла,
 * конфликт папки с файлом и неполные/недоступные участники не обрабатываются.
 */
function suggestGroupConflictNames({path,members}={}){
  const t=target(path);
  if(!Array.isArray(members) || members.length<2 || members.length>MAX_MEMBERS)throw Error('Неверный состав группы');
  const occupied=new Set(),ids=new Set(),validated=[];
  for(const m of members){
    if(!m || typeof m.id!=='string' || !ID.test(m.id) || ids.has(m.id) || !['pc','google','yandex'].includes(m.kind)
      || m.online!==true || m.complete!==true)throw Error('Участник недоступен или список не подтверждён');
    ids.add(m.id);addNames(m.names,t.name,occupied);validated.push({id:m.id,file:version(m.file)});
  }
  validated.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  const groups=new Map();
  for(const m of validated){
    const key=m.file.hash+':'+m.file.size;
    if(!groups.has(key))groups.set(key,{version:m.file,members:[]});
    groups.get(key).members.push(m.id);
  }
  if(groups.size<2)throw Error('Версии совпадают');
  const variants=[];
  for(const group of groups.values())variants.push({path:variants.length===0?path:nextName(t,occupied),version:group.version,members:group.members});
  return {original:path,variants};
}
module.exports={suggestConflictName,suggestGroupConflictNames,MAX_MEMBERS};
