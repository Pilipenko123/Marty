'use strict';
/**
 * pkg3-108: СМАЙЛЫ ВСЕГДА НА МЕСТЕ.
 *
 * Раньше картинки смайлов (Twemoji) брались устройством НАПРЯМУЮ с чужого CDN
 * (cdn.jsdelivr.net). В сети владельца часть чужих адресов не открывается —
 * так уже было с подкастами (cdn.radio-t.com) и потоком Jamendo (mp3d). Когда
 * картинка не приходит, в панели реакций остаётся пустая кнопка: «смайл не
 * загрузился». Теперь порядок такой:
 *
 *   1) ВСЕ смайлы меню и наборов реакций ЛЕЖАТ ВНУТРИ ПРОГРАММЫ
 *      (public/img/emoji/<код>.svg, 50 файлов Twemoji, CC-BY) — они не зависят
 *      ни от чужой сети, ни от нашего сервера вовсе;
 *   2) смайл, которого внутри нет (человек вставил редкий значок в письмо),
 *      НАШ сервер один раз забирает у источника и ДЕРЖИТ КОПИЮ В ПАМЯТИ;
 *   3) если и источника нет — устройство покажет сам символ системным значком
 *      (этим занимается клиент, см. segaEmoFail в public/app.js).
 *
 *   устройство  →  GET /api/emoji/<код>.svg  (наш сервер)
 *   сервер      →  файл внутри программы ИЛИ копия в памяти (один раз в сеть)
 *
 * Дальше смайлы приходят мгновенно с нашего же сервера, кэшируются браузером
 * (Cache-Control immutable) и служебным воркером — работают даже без сети.
 *
 * Честные границы (важно для безопасности):
 *  - маршрут ОТКРЫТЫЙ: <img> не умеет прикладывать заголовок входа. Поэтому он
 *    отдаёт ТОЛЬКО файлы смайлов по строгому образцу кода (1f600, 2764,
 *    1f468-200d-2764-fe0f-200d-1f468) — ни путей, ни чужих адресов, ни имён
 *    файлов с точками, ни «..»;
 *  - память ограничена: не больше CACHE_MAX картинок (при потолке 700 и
 *    ~2 КБ на файл это ~1,4 МБ — VPS с 550 МБ это переживает);
 *  - картинка проверяется: страница с ошибкой вместо <svg> не принимается;
 *  - источник можно подменить переменной окружения EMOJI_CDN_BASE (так тесты
 *    подставляют игрушечный сайт и проверяют кэш, отказ и потолок).
 *
 * Зависимостей нет: только встроенные https/http.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

/** Готовая пачка смайлов внутри программы: чужая сеть для них не нужна вовсе. */
const LOCAL_DIR = path.join(__dirname, '..', 'public', 'img', 'emoji');

/** Код смайла: только шестнадцатеричные группы через дефис (как в Twemoji). */
const CODE_RE = /^[0-9a-f]{1,6}(?:-[0-9a-f]{1,6}){0,8}$/;

/** Откуда берём картинки. Порядок важен: первый живой источник и выигрывает. */
const DEFAULT_BASES = [
  'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/svg/',
  'https://unpkg.com/twemoji@14.0.2/assets/svg/'
];

const MAX_BYTES = 32 * 1024;      // один смайл — крошечный файл; больше — не картинка
const CACHE_MAX = 700;            // потолок памяти (≈1,4 МБ)
const DOWNLOAD_TIMEOUT = 6000;

const cache = new Map();

/** Список источников: файл настройки может переопределить (тесты, свой CDN). */
function bases() {
  const extra = String(process.env.EMOJI_CDN_BASE || '').trim();
  if (!extra) return DEFAULT_BASES;
  return extra.split(',').map(b => b.trim()).filter(Boolean)
    .map(b => (b.endsWith('/') ? b : b + '/'));
}

/** Годится ли код: пускаем только шестнадцатеричные группы через дефис. */
function isValidCode(code) {
  return typeof code === 'string' && code.length <= 60 && CODE_RE.test(code);
}

/** Скачать один файл (с одним-двумя переходами — CDN любит перенаправлять). */
function download(url, depth = 0) {
  return new Promise((resolve, reject) => {
    let mod;
    try { mod = new URL(url).protocol === 'http:' ? http : https; }
    catch (e) { return reject(new Error('плохой адрес источника')); }
    const req = mod.get(url, {
      headers: { 'User-Agent': 'SEGA-CHAT/108 (emoji)', 'Accept': 'image/svg+xml,image/*' }
    }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (depth >= 3) return reject(new Error('слишком много переходов'));
        let next;
        try { next = new URL(res.headers.location, url).toString(); } catch (e) { return reject(new Error('плохой переход')); }
        return download(next, depth + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('источник ответил ' + res.statusCode)); }
      const chunks = [];
      let size = 0;
      res.on('data', c => {
        size += c.length;
        if (size > MAX_BYTES) { req.destroy(); reject(new Error('источник отдал слишком большой файл')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ buf: Buffer.concat(chunks), type: res.headers['content-type'] || 'image/svg+xml' }));
      res.on('error', reject);
    });
    req.setTimeout(DOWNLOAD_TIMEOUT, () => { req.destroy(); reject(new Error('источник не ответил')); });
    req.on('error', reject);
  });
}

/** Смайл, который лежит внутри программы (или null). */
function fromBundle(code) {
  try {
    const buf = fs.readFileSync(path.join(LOCAL_DIR, code + '.svg'));
    return /<svg[\s>]/i.test(buf.slice(0, 400).toString('utf8')) ? buf : null;
  } catch (e) { return null; }
}

/** Взять смайл: из памяти, из папки программы или (первый раз) у источника. */
async function get(code) {
  if (!isValidCode(code)) {
    const e = new Error('нет такого смайла');
    e.code = 'bad';
    throw e;
  }
  const hit = cache.get(code);
  if (hit) return hit;
  const bundled = fromBundle(code);              // 1) внутри программы — сеть не нужна
  if (bundled) {
    const rec = { buf: bundled, type: 'image/svg+xml' };
    remember(code, rec);
    return rec;
  }
  let lastErr = null;
  for (const base of bases()) {
    try {
      const got = await download(base + code + '.svg');
      // Источник мог ответить страницей ошибки с кодом 200 — такую «картинку» не берём.
      if (!/<svg[\s>]/i.test(got.buf.slice(0, 400).toString('utf8'))) throw new Error('источник отдал не картинку');
      const rec = { buf: got.buf, type: /svg/.test(String(got.type)) ? String(got.type) : 'image/svg+xml' };
      remember(code, rec);
      return rec;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('смайл не получен');
}

/** Положить картинку в память, соблюдая потолок (старейшая — на выход). */
function remember(code, rec) {
  if (cache.size >= CACHE_MAX) {
    const first = cache.keys().next();
    if (!first.done) cache.delete(first.value);
  }
  cache.set(code, rec);
}

/** Сколько картинок уже в памяти (для самопроверок и тестов). */
function size() { return cache.size; }

/** Опустошить память (тесты). */
function clearCache() { cache.clear(); }

module.exports = { get, isValidCode, size, clearCache, CODE_RE, CACHE_MAX, MAX_BYTES, LOCAL_DIR, fromBundle };
