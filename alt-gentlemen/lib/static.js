'use strict';
/** Отдача страницы чата. Файлы читаются один раз и остаются в памяти. */

const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.json': 'application/json; charset=utf-8'
};

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
      .replace('window.ALTG_BASE = ""', `window.ALTG_BASE = ${JSON.stringify(base)}`));
  }
  return {
    status: 200,
    headers: { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' },
    body
  };
}

module.exports = { serveStatic, splitBase, PUBLIC_DIR };
