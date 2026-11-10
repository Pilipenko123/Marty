'use strict';

// Черновик выбора имени для двух версий одного файла. НИЧЕГО не создаёт,
// не копирует, не перемещает в корзину и не разрешает конфликт самостоятельно.
// Проверка имён здесь не заменяет сравнение и атомарное создание в Windows.
const {partsOf, MAX_ENTRIES} = require('./folder');
const HASH = /^[a-f0-9]{64}$/;
const MAX_ATTEMPTS = 10000;

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
/**
 * Имя предлагается лишь по полным спискам ОБЕИХ сторон. Исходный файл должен
 * находиться в обоих списках. Снимки и флаги подтверждения не проверяются этим
 * модулем; проверять их и резервировать имя при создании обязан исполнитель.
 * Вариант сохраняет левую версию под исходным именем, правую — под новым.
 */
function suggestConflictName({path, left, right, leftNames, rightNames, leftComplete, rightComplete} = {}) {
  if (leftComplete!==true || rightComplete!==true) throw new Error('Списки папок не подтверждены');
  if (typeof path!=='string' || !wellFormed(path)) throw new Error('Неверный путь');
  const parts=partsOf(path);
  if (!parts.length) throw new Error('Неверный путь');
  const name=parts[parts.length-1], parent=parts.slice(0,-1).join('/');
  const l=version(left), r=version(right);
  if (l.hash===r.hash && l.size===r.size) throw new Error('Версии совпадают');
  if (!Array.isArray(leftNames) || !Array.isArray(rightNames) || leftNames.length>MAX_ENTRIES || rightNames.length>MAX_ENTRIES) throw new Error('Неполный или слишком большой список папки');
  const occupied=new Set();
  for (const list of [leftNames,rightNames]) {
    if (!list.includes(name)) throw new Error('Файл отсутствует в списке папки');
    for (const n of list) { checkName(n); occupied.add(folded(n)); }
  }
  const dot=name.lastIndexOf('.');
  const ext=dot>0 ? name.slice(dot) : '', stem=dot>0 ? name.slice(0,dot) : name;
  // Учёт UTF-16 нужен для лимита компонента в Windows; при усечении не
  // разрываем суррогатную пару и не отбрасываем расширение.
  const available=Math.min(255,4096-(parent ? parent.length+1 : 0));
  for(let i=1;i<=MAX_ATTEMPTS;i++) {
    const suffix=' (другая версия'+(i===1?'':' - '+i)+')';
    const prefix=trimToUnits(stem,available-suffix.length-ext.length);
    if (!prefix) throw new Error('Не удалось подобрать имя с исходным расширением');
    const candidate=prefix+suffix+ext;
    checkName(candidate);
    if (!occupied.has(folded(candidate))) {
      return {original:path,alternate:parent ? parent+'/'+candidate : candidate,left:l,right:r};
    }
  }
  throw new Error('Не удалось подобрать свободное имя');
}
module.exports={suggestConflictName};
