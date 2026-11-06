'use strict';
//
// pkg3-131: документы Google (Docs, Sheets, Slides) внутри чата.
//
// У «документов Google» нет файла: их нельзя скачать потоком (поэтому в архиве
// папки они честно попадают в «что-не-вошло»). Зато Google умеет ЭКСПОРТ:
// документ — в HTML, таблицу — в CSV, презентацию — в текст. Здесь мы
// превращаем этот экспорт в то, что можно безопасно показать в окне чата:
//   • html — вычищенный по белому списку (никаких <script>, <style>, on…,
//     javascript:-ссылок и чужих картинок);
//   • sheet — строки таблицы (разбор CSV с кавычками и запятыми внутри);
//   • slide — обычный текст.
// Никаких новых зависимостей: только регулярные выражения и здравый смысл.

const GDOC_RE = /^application\/vnd\.google-apps\.(document|spreadsheet|presentation|drawing)/;

/** Что это за документ: doc / sheet / slide / drawing (или '' — обычный файл). */
function kindOf(mime) {
  const m = String(mime || '');
  const hit = GDOC_RE.exec(m);
  return hit ? hit[1] : '';
}

/** Во что экспортировать: у каждого вида свой понятный формат. */
function exportMime(mime) {
  const k = kindOf(mime);
  if (k === 'spreadsheet') return 'text/csv';
  if (k === 'presentation') return 'text/plain';
  if (k === 'drawing') return 'image/png';
  return 'text/html';
}

/** Подпись вида для окна. */
function kindTitle(mime) {
  const k = kindOf(mime);
  if (k === 'spreadsheet') return 'Таблица Google';
  if (k === 'presentation') return 'Презентация Google';
  if (k === 'drawing') return 'Рисунок Google';
  return 'Документ Google';
}

/** Ссылка «открыть в Google» — только для настоящих «документов Google». */
function openUrl(id, mime) {
  const k = kindOf(mime);
  const safe = String(id || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!safe) return '';
  if (k === 'spreadsheet') return 'https://docs.google.com/spreadsheets/d/' + safe + '/edit';
  if (k === 'presentation') return 'https://docs.google.com/presentation/d/' + safe + '/edit';
  if (k === 'drawing') return 'https://docs.google.com/drawings/d/' + safe + '/edit';
  if (k === 'document') return 'https://docs.google.com/document/d/' + safe + '/edit';
  return '';
}

/* ── Безопасный HTML ────────────────────────────────────────────────────── */

const OK_TAGS = new Set([
  'p', 'br', 'div', 'span', 'b', 'strong', 'i', 'em', 'u', 's', 'sub', 'sup',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
  'table', 'thead', 'tbody', 'tr', 'td', 'th', 'caption', 'colgroup', 'col',
  'a', 'hr', 'img', 'small', 'mark', 'del', 'ins'
]);
const OK_STYLE = /^(font-weight|font-style|text-decoration|text-align|color|background-color|font-size|line-height|white-space|vertical-align|margin-left|padding-left)$/i;
const OK_VALUE = /^[#a-z0-9\s.,%()+-]{1,60}$/i;
const OK_HOST = /^https:\/\/[a-z0-9.-]*\.(googleusercontent\.com|google\.com|gstatic\.com)\//i;

/* ── pkg3-146: раскодирование «сущностей» HTML ────────────────────────────
 * Google в экспорте пишет кириллицу числами: &#1058;&#1080;… Раньше эти
 * последовательности попадали на экран как «иероглифы» (жалоба владельца со
 * скриншотом). Теперь сущности раскодируются, а потом текст снова
 * экранируется — на экран попадают буквы, а не коды.
 */
const NAMED_ENT = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  mdash: '—', ndash: '–', laquo: '«', raquo: '»', hellip: '…', copy: '©',
  reg: '®', deg: '°', times: '×', divide: '÷', euro: '€', trade: '™',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•', middot: '·'
};
function decodeEntities(raw) {
  return String(raw || '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,9});/g, (all, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const num = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(num) || num <= 0 || num > 0x10ffff) return all;
      try { return String.fromCodePoint(num); } catch (e) { return all; }
    }
    const hit = NAMED_ENT[body.toLowerCase()];
    return hit == null ? all : hit;
  });
}

/** Значение атрибута — наружу без кавычек, чтобы нельзя было вырваться из него. */
function attrValue(raw, isUrl) {
  let v = String(raw == null ? '' : raw)
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/[\u0000-\u001f\u007f"'<>`]/g, '')
    .trim();
  if (!v) return '';
  if (isUrl) {
    if (!OK_HOST.test(v)) return '';
    return v.replace(/[\s()]/g, encodeURIComponent ? v.replace(/["'()\s]/g, '') : v);
  }
  return v;
}

function escText(s) {
  // pkg3-146: сначала раскодируем HTML-сущности (Google пишет кириллицу кодами
  // вида &#1058;&#1080;), потом экранируем. Иначе браузер показывает сами коды —
  // это и были «иероглифы» в документах со скриншота владельца.
  return decodeEntities(String(s)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function rebuildOpenTag(name, rawAttrs) {
  const keep = [];
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let m;
  let skipAll = false;
  while ((m = re.exec(rawAttrs))) {
    const key = m[1].toLowerCase();
    const val = m[3] != null ? m[3] : (m[4] != null ? m[4] : (m[5] != null ? m[5] : ''));
    if (key === 'style') {
      const cleaned = [];
      for (const part of String(val).split(';')) {
        const i = part.indexOf(':');
        if (i < 0) continue;
        const prop = part.slice(0, i).trim();
        const v = part.slice(i + 1).trim();
        if (!OK_STYLE.test(prop) || !OK_VALUE.test(v)) continue;
        if (/url\s*\(|expression\s*\(|javascript:/i.test(v)) continue;
        cleaned.push(prop.toLowerCase() + ': ' + v);
      }
      if (cleaned.length) keep.push('style="' + cleaned.join('; ') + '"');
      continue;
    }
    if (key === 'href') {
      const href = attrValue(val, false);
      if (/^https?:\/\/[a-z0-9.-]+/i.test(href) || /^mailto:[^\s]+$/i.test(href)) {
        keep.push('href="' + href.replace(/"/g, '%22') + '"');
        keep.push('rel="noopener noreferrer"');
        keep.push('target="_blank"');
      } else skipAll = true;
      continue;
    }
    if (key === 'src') {
      const src = attrValue(val, true);
      if (src) keep.push('src="' + src + '"');
      continue;
    }
    if (key === 'colspan' || key === 'rowspan' || key === 'width' || key === 'height') {
      if (/^\d{1,4}$/.test(String(val).trim())) keep.push(key + '="' + String(val).trim() + '"');
      continue;
    }
    if (key === 'alt' || key === 'title' || key === 'id' || key === 'class') keep.push(key + '="' + escText(val).replace(/"/g, '') + '"');
  }
  if (skipAll) return '';
  return '<' + name + (keep.length ? ' ' + keep.join(' ') : '') + '>';
}

/**
 * Вычистить HTML экспорта Google до безопасного «читаемого» вида.
 * Разрешены только безобидные теги и несколько свойств оформления.
 */
function safeHtml(raw) {
  let s = String(raw || '');
  // 1. целиком выбрасываем опасные блоки вместе с содержимым
  s = s.replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|iframe|object|embed|noscript|template|svg|math)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(script|style|iframe|object|embed|noscript|template)\b[^>]*>/gi, '');
  // 2. если это полная страница — берём только тело
  const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(s);
  if (body) s = body[1];
  s = s.replace(/<(!DOCTYPE|head)\b[\s\S]*?<\/head\s*>/gi, '');
  // 3. по одному тегу: разрешённые — переписываем, прочие — выбрасываем
  let out = '';
  let last = 0;
  const VOID = new Set(['br', 'hr', 'img', 'col']);
  const dropped = [];       // открытые теги, которые мы выбросили: их закрытие тоже не нужно
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let m;
  while ((m = tagRe.exec(s))) {
    out += escText(s.slice(last, m.index));
    last = m.index + m[0].length;
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    const attrs = m[3] || '';
    const selfClose = VOID.has(name) || /\/\s*$/.test(attrs);
    if (closing) {
      if (dropped.length && dropped[dropped.length - 1] === name) { dropped.pop(); continue; }
      if (!OK_TAGS.has(name)) continue;
      out += '</' + name + '>';
      continue;
    }
    if (!OK_TAGS.has(name)) { if (!selfClose) dropped.push(name); continue; }
    const open = rebuildOpenTag(name, attrs.replace(/\/\s*$/, ''));
    // картинка без разрешённого адреса не нужна вовсе, а ссылка — остаётся текстом
    if (!open || (name === 'img' && !/\ssrc="/.test(open))) { if (!selfClose) dropped.push(name); continue; }
    out += open;
  }
  out += escText(s.slice(last));
  // 4. пустые «обёртки» от выброшенных тегов не оставляем
  out = out.replace(/<div(\s[^>]*)?>\s*<\/div>/gi, '')
    .replace(/(\s*<br\s*\/?>\s*){3,}/gi, '<br><br>');
  return out.trim();
}

/* ── Таблица из CSV ─────────────────────────────────────────────────────── */

/**
 * Разбор CSV по правилам RFC 4180: кавычки, удвоенные кавычки внутри, переводы
 * строк внутри кавычек. Разделитель — запятая (Google отдаёт именно её).
 */
function csvRows(text, o = {}) {
  const maxRows = Math.min(2000, Math.max(1, Number(o.maxRows) || 400));
  const maxCols = Math.min(200, Math.max(1, Number(o.maxCols) || 40));
  const maxCell = 2000;
  const s = String(text || '').replace(/\r\n?/g, '\n');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  let truncated = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else if (cell.length < maxCell) cell += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ',') {
      row.push(cell);
      cell = '';
      if (row.length > maxCols) { row.length = maxCols; }
      continue;
    }
    if (c === '\n') {
      row.push(cell);
      cell = '';
      rows.push(row.slice(0, maxCols));
      row = [];
      if (rows.length >= maxRows) { truncated = true; break; }
      continue;
    }
    if (cell.length < maxCell) cell += c;
  }
  if (!truncated && (cell.length || row.length)) {
    row.push(cell);
    rows.push(row.slice(0, maxCols));
  }
  // «хвостовой» перевод строки не должен превращаться в пустую строку таблицы
  while (rows.length && rows[rows.length - 1].every(x => !String(x).trim())) rows.pop();
  const cols = rows.reduce((n, r) => Math.max(n, r.length), 0);
  return { rows, cols, truncated };
}

module.exports = { GDOC_RE, kindOf, exportMime, kindTitle, openUrl, safeHtml, csvRows, decodeEntities };
