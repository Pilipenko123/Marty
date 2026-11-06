'use strict';
/** Отдача страницы чата. Файлы читаются один раз и остаются в памяти. */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  // pkg3-79: карты «Золотой лихорадки» — jpg; без своей строки браузер получал «application/octet-stream»
  // и при запрете распознавания типа отказывался показывать картинку (пустое поле)
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.json': 'application/json; charset=utf-8'
};

/**
 * pkg3-135: строгий CSP. Встроенные <script> в index.html разрешаем по отпечатку
 * (sha256), потому что они нужны ДО загрузки app.js (тема, сторож недогрузки).
 * Обработчики-атрибуты (onerror=, onclick=) из разметки убраны — под запретом.
 * Картинки: свои, data:, blob: и внешние https (смайлы с CDN и обложки).
 */
function cspFor(html) {
  const hashes = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    if (/\bsrc\s*=/i.test(m[1])) continue;          // внешний файл — обычный 'self'
    hashes.push("'sha256-" + crypto.createHash('sha256').update(m[2], 'utf8').digest('base64') + "'");
  }
  return [
    "default-src 'self'",
    "script-src 'self'" + (hashes.length ? ' ' + hashes.join(' ') : ''),
    "style-src 'self' 'unsafe-inline'",              // в разметке много style="…"
    "img-src 'self' data: blob: https:",
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'"
  ].join('; ');
}
const cspCache = new Map();

let names = new Set();
try { names = new Set(fs.readdirSync(PUBLIC_DIR)); } catch (e) {}
const cache = new Map();

/**
 * Облачная функция может отвечать по адресу вида /<id-функции>/… —
 * отделяем такую приставку, чтобы страница и запросы находили друг друга.
 */
function splitBase(pathname) {
  const seg = pathname.split('/').filter(Boolean);
  if (seg.length && seg[0] !== 'api' && !names.has(seg[0])) {
    return { base: '/' + seg[0], path: '/' + seg.slice(1).join('/') };
  }
  return { base: '', path: pathname || '/' };
}

function serveStatic(pathname, base) {
  const rel = (!pathname || pathname === '/') ? '/index.html' : pathname;
  const full = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!full.startsWith(PUBLIC_DIR) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    return { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: Buffer.from('Не найдено') };
  }
  const ext = path.extname(full);
  let body = cache.get(full);
  if (!body) { body = fs.readFileSync(full); cache.set(full, body); }
  if (ext === '.html' && base) {
    body = Buffer.from(body.toString('utf8')
      .replace('<base href="/">', `<base href="${base}/">`)
      .replace('window.SEGA_BASE = ""', `window.SEGA_BASE = ${JSON.stringify(base)}`));
  }
  // картинки не меняются между выпусками — пусть браузер держит их у себя
  const cacheHeader = (ext === '.png' || ext === '.ico') ? 'public, max-age=604800' : 'no-cache';
  const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cacheHeader };
  if (ext === '.html') {
    const key = crypto.createHash('sha256').update(body).digest('hex');
    let csp = cspCache.get(key);
    if (!csp) { csp = cspFor(body.toString('utf8')); cspCache.set(key, csp); }
    headers['Content-Security-Policy'] = csp;
  }
  return { status: 200, headers, body };
}

module.exports = { serveStatic, splitBase, PUBLIC_DIR, cspFor };
