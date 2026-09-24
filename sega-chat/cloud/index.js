'use strict';
/**
 * Точка входа для Yandex Cloud Functions.
 *
 * Одна функция отдаёт и страницу чата, и все запросы к нему; данные лежат
 * в Yandex Database. Между вызовами «тёплый» экземпляр сохраняет справочник
 * участников и чатов, поэтому обычный опрос новых сообщений стоит один
 * маленький запрос к базе.
 *
 * Обязательные переменные окружения функции:
 *   YDB_ENDPOINT — адрес Document API базы
 * Необязательные:
 *   YDB_TABLE (по умолчанию sega_chat), STORAGE_LIMIT, MAX_MEMBERS, PRESENCE_EVERY
 *   YDB_DEBUG=1 — подробности работы с базой в журнал функции
 */

const { createApi } = require('../lib/api');
const { createYdbStore } = require('../lib/store-ydb');
const { serveStatic, splitBase } = require('../lib/static');

let store = null, app = null;

function boot() {
  if (!app) {
    store = createYdbStore();
    app = createApi(store);
  }
  return app;
}

function pickQuery(event, tail) {
  const q = new URLSearchParams(tail || '');
  const src = event.queryStringParameters || event.params || null;
  if (src) for (const [k, v] of Object.entries(src)) if (typeof v === 'string') q.set(k, v);
  return q;
}

function lowerHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h || {})) out[String(k).toLowerCase()] = Array.isArray(v) ? v[0] : v;
  return out;
}

module.exports.handler = async function (event, context) {
  const api = boot();

  // токен сервисного аккаунта функции — им же ходим в базу
  const tok = context && context.token;
  if (tok && tok.access_token) store.client.setToken(tok.access_token, tok.expires_in);

  const raw = String(event.url || event.path || event.requestPath || '/');
  const qmark = raw.indexOf('?');
  const rawPath = qmark >= 0 ? raw.slice(0, qmark) : raw;
  const { base, path: pathname } = splitBase(decodeURI(rawPath));
  const headers = lowerHeaders(event.headers);
  const method = String(event.httpMethod || (event.requestContext && event.requestContext.httpMethod) || 'GET').toUpperCase();

  let out;
  try {
    if (pathname.startsWith('/api/')) {
      let body = {};
      if (event.body) {
        const text = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : String(event.body);
        if (text.trim()) { try { body = JSON.parse(text); } catch (e) { body = {}; } }
      }
      out = await api.handle({
        method, path: pathname, query: pickQuery(event, qmark >= 0 ? raw.slice(qmark + 1) : ''),
        headers, body,
        ip: (headers['x-forwarded-for'] || (event.requestContext && event.requestContext.identity
          && event.requestContext.identity.sourceIp) || '').split(',')[0].trim()
      });
    } else {
      out = serveStatic(pathname, base);
    }
  } catch (e) {
    console.error(e);
    out = { status: 500, json: { error: 'Ошибка сервера' } };
  }

  const resHeaders = Object.assign(
    { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' },
    out.headers || {}
  );
  let body, isBase64Encoded = false;
  if (out.body !== undefined) {
    if (String(resHeaders['Content-Type'] || '').startsWith('text/') || resHeaders['Content-Disposition']) {
      body = out.body.toString('utf8');
    } else {
      body = out.body.toString('base64'); isBase64Encoded = true;
    }
  } else {
    body = JSON.stringify(out.json === undefined ? {} : out.json);
    resHeaders['Content-Type'] = 'application/json; charset=utf-8';
  }
  return { statusCode: out.status || 200, headers: resHeaders, body, isBase64Encoded };
};
