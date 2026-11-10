'use strict';

// Только расчёт. Модуль не копирует и не удаляет файлы и не обращается к сети.
// Базой может быть только ранее подтверждённое одинаковое состояние обеих сторон.
const { partsOf } = require('./folder');
const { isDeepStrictEqual } = require('node:util');
const MAX_ITEMS = 20000;
const hashRx = /^[0-9a-f]{64}$/;

function parseSnapshot(input) {
  if (!Array.isArray(input) || input.length > MAX_ITEMS) throw new Error('Неполный или слишком большой список файлов');
  const out = new Map(), folded = new Set();
  for (const entry of input) {
    if (!entry || typeof entry.path !== 'string' || !entry.path || !partsOf(entry.path).length) throw new Error('Неверный путь');
    if (entry.type !== 'file' && entry.type !== 'dir') throw new Error('Неверный тип файла');
    if (entry.type === 'file' && (typeof entry.hash !== 'string' || !hashRx.test(entry.hash) || !Number.isSafeInteger(entry.size) || entry.size < 0)) throw new Error('Нет надёжной проверки файла');
    const fold = entry.path.normalize('NFC').toLowerCase();
    if (out.has(entry.path) || folded.has(fold)) throw new Error('Имена файлов совпадают без учёта регистра');
    folded.add(fold);
    out.set(entry.path, entry.type === 'dir' ? { type:'dir' } : { type:'file', hash:entry.hash, size:entry.size });
  }
  for (const p of out.keys()) {
    const i = p.lastIndexOf('/');
    if (i !== -1 && (!out.has(p.slice(0, i)) || out.get(p.slice(0, i)).type !== 'dir')) throw new Error('Неполный список папок');
  }
  return out;
}
function same(a, b) {
  if (!a || !b) return !a && !b;
  return a.type === b.type && (a.type === 'dir' || (a.hash === b.hash && a.size === b.size));
}
// Отсортированный по кодовым единицам индекс позволяет рассматривать только
// потомков проверяемой папки, а не заново обходить все 20 000 элементов для
// каждого удаления. Заблокированные поддеревья не пересекаются.
function descendantsStart(ordered, prefix) {
  let lo = 0, hi = ordered.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (ordered[mid] < prefix) lo = mid + 1; else hi = mid; }
  return lo;
}
function unchangedTree(a, b, root, ordered) {
  if (!same(a.get(root), b.get(root))) return false;
  const prefix = root + '/';
  for (let i = descendantsStart(ordered,prefix); i < ordered.length && ordered[i].startsWith(prefix); i++) {
    const p = ordered[i];
    if (!same(a.get(p), b.get(p))) return false;
  }
  return true;
}
// Предварительное ожидаемое состояние целой папки, включая пустые каталоги.
// Это только описание для повторной проверки, не разрешение что-либо удалять.
function treeExpectation(map, root, ordered) {
  const items=[{path:root,...map.get(root)}], prefix=root+'/';
  for (let i=descendantsStart(ordered,prefix);i<ordered.length && ordered[i].startsWith(prefix);i++) {
    const p=ordered[i], item=map.get(p);
    if(item)items.push({path:p,...item});
  }
  return items;
}
function hasBlockedParent(p, blocked) {
  let i = p.lastIndexOf('/');
  while (i !== -1) {
    if (blocked.has(p.slice(0, i))) return true;
    i = p.lastIndexOf('/', i - 1);
  }
  return false;
}
function expect(entry) { return entry ? { ...entry } : null; }

/**
 * left/right/base — полные снимки, только при установленной связи. Возвращает
 * предварительные операции с проверяемыми ожиданиями; они НЕ выполняются здесь.
 * До исполнения потребуется повторно проверить оба файла и все вложения папки,
 * а также гарантировать перемещение в настоящую корзину Windows и восстановление
 * после обрыва. Спорные изменения никогда не разрешаются перезаписью.
 */
function planSync({enabled,online,peerOnline,baseConfirmed,leftComplete,rightComplete,base,left,right} = {}) {
  // Явное подтверждение вызывающего кода нужно даже для пустых списков. Эти
  // флаги сами по себе не доказывают полноту и не защищают от устаревания.
  if (enabled!==true || online!==true || peerOnline!==true || baseConfirmed!==true || leftComplete!==true || rightComplete!==true) {
    throw new Error('Синхронизация или полные снимки не подтверждены');
  }
  const B = parseSnapshot(base), L = parseSnapshot(left), R = parseSnapshot(right);
  // Нельзя молча объединять имена, которые Windows считает одним путём.
  const spellings = new Map();
  for (const map of [B, L, R]) for (const p of map.keys()) {
    const fold = p.normalize('NFC').toLowerCase();
    if (spellings.has(fold) && spellings.get(fold) !== p) throw new Error('Имена файлов различаются только регистром');
    spellings.set(fold, p);
  }
  const ordered = [...new Set([...B.keys(), ...L.keys(), ...R.keys()])].sort();
  const paths = [...ordered].sort((a,b) => a.split('/').length - b.split('/').length || a.localeCompare(b, 'ru'));
  const actions = [], blocked = new Set();
  for (const p of paths) {
    if (hasBlockedParent(p, blocked)) continue;
    const baseEntry = B.get(p), l = L.get(p), r = R.get(p);
    // Удаление целой папки распространяем только если её ВЕСЬ состав не менялся.
    if (baseEntry && baseEntry.type === 'dir' && (!l || !r)) {
      if (!l && !r) { blocked.add(p); continue; }
      const surviving = l ? L : R, side = l ? 'left' : 'right';
      if (same(baseEntry, surviving.get(p)) && unchangedTree(B, surviving, p, ordered)) {
        actions.push({ type:'trash', side, missingOn:side==='left'?'right':'left', path:p,
          expected:expect(baseEntry), tree:true, expectedTree:treeExpectation(surviving,p,ordered) });
      } else {
        actions.push({ type:'conflict', path:p, reason:'Папка удалена на одном компьютере, но изменена на другом' });
      }
      blocked.add(p); continue;
    }
    if (same(l, r)) continue;
    // Разные типы и одновременные правки требуют сохранения обеих версий.
    if (l && r && l.type !== r.type) {
      actions.push({ type:'conflict', path:p, reason:'Файл и папка имеют одинаковое имя' });
      blocked.add(p); continue;
    }
    const lc = !same(l, baseEntry), rc = !same(r, baseEntry);
    if (lc && rc) {
      actions.push({ type:'conflict', path:p, reason:'Одновременные изменения' });
      if ((l && l.type === 'dir') || (r && r.type === 'dir') || (baseEntry && baseEntry.type === 'dir')) blocked.add(p);
      continue;
    }
    const from = lc ? 'left' : 'right', to = lc ? 'right' : 'left';
    const source = lc ? l : r, target = lc ? r : l;
    if (!source) {
      if (target) actions.push({ type:'trash', side:to, missingOn:from, path:p, expected:expect(target), tree:false });
    } else if (source.type === 'dir') {
      if (target) { actions.push({ type:'conflict', path:p, reason:'Нельзя заменить папку автоматически' }); blocked.add(p); }
      else actions.push({ type:'mkdir', side:to, path:p });
    } else {
      // Замена должна сперва положить старую версию в корзину; если корзина
      // недоступна, исполнитель обязан остановиться без потери файла.
      actions.push({ type:'copy', from, to, path:p, source:expect(source), target:expect(target), replaceToTrash:!!target });
    }
  }
  return actions;
}
// Сравнение с заново рассчитанным планом — только модель, не разрешение на
// выполнение. Вызывающий код должен сам предоставить ту же подтверждённую базу,
// новые полные снимки и актуальные признаки связи/согласия. Идентичное содержимое
// не доказывает, что файл не был заменён, а после проверки возможна новая гонка.
// Нельзя применять результат для настоящей корзины, записи или публикации.
function isPlanActionCurrent({action, ...snapshotOptions} = {}) {
  const current = planSync(snapshotOptions);
  if (!action || !['copy','mkdir','trash'].includes(action.type)) return false;
  return current.some(item => item.type === action.type && isDeepStrictEqual(item, action));
}
// Только предварительная проверка кандидата общей базы. Ни состояния на
// диске, ни полноту сканирования эти аргументы сами по себе не доказывают.
// Вызывающая система обязана получать подтверждения с обоих ПК, фиксировать
// изменения и атомарно сохранять базу; такой системы здесь пока нет.
function confirmSyncBase({enabled, online, peerOnline, leftComplete, rightComplete, operationsComplete, left, right} = {}) {
  if (enabled !== true || online !== true || peerOnline !== true || leftComplete !== true || rightComplete !== true || operationsComplete !== true) {
    throw new Error('Состояние синхронизации не подтверждено');
  }
  const L = parseSnapshot(left), R = parseSnapshot(right);
  if (L.size !== R.size) throw new Error('Папки ещё различаются');
  for (const [p, entry] of L) if (!same(entry, R.get(p))) throw new Error('Папки ещё различаются');
  return [...L.entries()].sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([path, entry]) => ({path, ...entry}));
}
module.exports = { planSync, isPlanActionCurrent, confirmSyncBase, MAX_ITEMS };
