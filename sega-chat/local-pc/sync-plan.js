'use strict';

// Только расчёт. Модуль не копирует и не удаляет файлы и не обращается к сети.
// Базой может быть только ранее подтверждённое одинаковое состояние обеих сторон.
const { partsOf } = require('./folder');
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
function under(p, parent) { return p.startsWith(parent + '/'); }
function unchangedTree(a, b, root) {
  const keys = new Set([...a.keys(), ...b.keys()].filter(p => p === root || under(p, root)));
  for (const p of keys) if (!same(a.get(p), b.get(p))) return false;
  return true;
}
function expect(entry) { return entry ? { ...entry } : null; }

/**
 * left/right/base — полные снимки, только при установленной связи. Возвращает
 * предварительные операции с проверяемыми ожиданиями; они НЕ выполняются здесь.
 * До исполнения потребуется повторно проверить оба файла и все вложения папки,
 * а также гарантировать перемещение в настоящую корзину Windows и восстановление
 * после обрыва. Спорные изменения никогда не разрешаются перезаписью.
 */
function planSync({ base, left, right }) {
  const B = parseSnapshot(base), L = parseSnapshot(left), R = parseSnapshot(right);
  // Нельзя молча объединять имена, которые Windows считает одним путём.
  const spellings = new Map();
  for (const map of [B, L, R]) for (const p of map.keys()) {
    const fold = p.normalize('NFC').toLowerCase();
    if (spellings.has(fold) && spellings.get(fold) !== p) throw new Error('Имена файлов различаются только регистром');
    spellings.set(fold, p);
  }
  const paths = [...new Set([...B.keys(), ...L.keys(), ...R.keys()])]
    .sort((a,b) => a.split('/').length - b.split('/').length || a.localeCompare(b, 'ru'));
  const actions = [], blocked = [];
  for (const p of paths) {
    if (blocked.some(parent => under(p, parent))) continue;
    const baseEntry = B.get(p), l = L.get(p), r = R.get(p);
    // Удаление целой папки распространяем только если её ВЕСЬ состав не менялся.
    if (baseEntry && baseEntry.type === 'dir' && (!l || !r)) {
      if (!l && !r) { blocked.push(p); continue; }
      const surviving = l ? L : R, side = l ? 'left' : 'right';
      if (same(baseEntry, surviving.get(p)) && unchangedTree(B, surviving, p)) {
        actions.push({ type:'trash', side, path:p, expected:expect(baseEntry), tree:true });
      } else {
        actions.push({ type:'conflict', path:p, reason:'Папка удалена на одном компьютере, но изменена на другом' });
      }
      blocked.push(p); continue;
    }
    if (same(l, r)) continue;
    // Разные типы и одновременные правки требуют сохранения обеих версий.
    if (l && r && l.type !== r.type) {
      actions.push({ type:'conflict', path:p, reason:'Файл и папка имеют одинаковое имя' });
      blocked.push(p); continue;
    }
    const lc = !same(l, baseEntry), rc = !same(r, baseEntry);
    if (lc && rc) {
      actions.push({ type:'conflict', path:p, reason:'Одновременные изменения' });
      if ((l && l.type === 'dir') || (r && r.type === 'dir') || (baseEntry && baseEntry.type === 'dir')) blocked.push(p);
      continue;
    }
    const from = lc ? 'left' : 'right', to = lc ? 'right' : 'left';
    const source = lc ? l : r, target = lc ? r : l;
    if (!source) {
      if (target) actions.push({ type:'trash', side:to, path:p, expected:expect(target), tree:false });
    } else if (source.type === 'dir') {
      if (target) { actions.push({ type:'conflict', path:p, reason:'Нельзя заменить папку автоматически' }); blocked.push(p); }
      else actions.push({ type:'mkdir', side:to, path:p });
    } else {
      // Замена должна сперва положить старую версию в корзину; если корзина
      // недоступна, исполнитель обязан остановиться без потери файла.
      actions.push({ type:'copy', from, to, path:p, source:expect(source), target:expect(target), replaceToTrash:!!target });
    }
  }
  return actions;
}
module.exports = { planSync, MAX_ITEMS };
