'use strict';
/**
 * pkg3-129: несколько дисков у одного человека.
 *
 * Раньше у участника было по одному диску каждого вида: Яндекс и Google. Этого
 * мало — у людей бывает личный Диск и рабочий, два Google-аккаунта и т. п.
 *
 * Как это сделано БЕЗ переделки путей (важно: пути уже лежат в письмах, в
 * плейлистах и в базе, их нельзя ломать):
 *   • первый Яндекс-Диск по-прежнему `disk:/…`, первый Google — `google:/<id>`;
 *   • второй диск того же вида — `disk2:/…` и `google2:/<id>`;
 *   • третий — `disk3:` / `google3:`.
 * То есть к старому пути дописывается только цифра. Всё, что знало `disk:` и
 * `google:` (ссылки 124-го, плейлисты, права), продолжает работать как было.
 *
 * Функции здесь чистые (без сети и без базы): их зовут и сервер, и клиент —
 * клиент получает такой же разбор через `public/app.js` (там своя копия правил,
 * потому что браузер не может требовать серверный файл).
 */

const MAX_SLOTS = 3;   // больше трёх дисков одного вида не даём: память VPS 550 МБ
const RE = /^(disk|google)(\d*):/;

/** Разобрать путь: { kind, slot, prefix, rest, word }. null — если это не наш путь. */
function parsePath(raw) {
  const s = String(raw == null ? '' : raw);
  const m = RE.exec(s);
  if (!m) return null;
  const kind = m[1] === 'disk' ? 'yandex' : 'google';
  const slot = m[2] ? Number(m[2]) : 1;
  if (!Number.isInteger(slot) || slot < 1 || slot > MAX_SLOTS) return null;
  return { kind, slot, prefix: prefixFor(kind, slot), rest: s.slice(m[0].length), word: m[1] };
}

/** Начало пути для диска: 'disk:', 'disk2:', 'google:', 'google2:'. */
function prefixFor(kind, slot) {
  const base = kind === 'google' ? 'google' : 'disk';
  const n = Math.min(MAX_SLOTS, Math.max(1, Number(slot) || 1));
  return base + (n > 1 ? String(n) : '') + ':';
}

/** Имя диска в интерфейсе и в ответах сервера: 'yandex', 'yandex2', 'google2'. */
function driveId(kind, slot) {
  const base = kind === 'google' ? 'google' : 'yandex';
  const n = Math.min(MAX_SLOTS, Math.max(1, Number(slot) || 1));
  return base + (n > 1 ? String(n) : '');
}

/** Обратно: 'google2' → { kind: 'google', slot: 2 }. */
function fromId(id) {
  const m = /^(yandex|google)(\d*)$/.exec(String(id == null ? '' : id));
  if (!m) return null;
  const slot = m[2] ? Number(m[2]) : 1;
  if (!Number.isInteger(slot) || slot < 1 || slot > MAX_SLOTS) return null;
  return { kind: m[1] === 'google' ? 'google' : 'yandex', slot };
}

/** Путь без номера диска — в том виде, в каком его понимает сам Яндекс/Google. */
function canon(raw) {
  const it = parsePath(raw);
  if (!it) return '';
  return (it.kind === 'google' ? 'google:' : 'disk:') + it.rest;
}

function isGoogle(raw) { return /^google\d*:/.test(String(raw == null ? '' : raw)); }
function isYandex(raw) { return /^disk\d*:/.test(String(raw == null ? '' : raw)); }

/** Номер диска из пути (для токена): 1, если номера нет. */
function slotOf(raw) {
  const it = parsePath(raw);
  return it ? it.slot : 1;
}

module.exports = { MAX_SLOTS, parsePath, prefixFor, driveId, fromId, canon, isGoogle, isYandex, slotOf };
