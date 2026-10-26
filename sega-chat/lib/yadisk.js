'use strict';
/**
 * pkg3-90: Яндекс.Диск — облачное хранилище «Моей музыки» (вариант А).
 *
 * Как это работает и почему это безопасно:
 *   • Файлы лежат на Яндекс.Диске владельца. Сервер НЕ скачивает и НЕ хранит
 *     музыку: он только спрашивает у Яндекса список аудиофайлов и выдаёт
 *     браузеру короткоживущую неугадываемую ссылку (href) на каждый трек.
 *     Звук идёт с серверов Яндекса прямо в браузер — VPS не тратит ни диск,
 *     ни трафик на сами песни.
 *   • Доступ к Диску — по OAuth-токену владельца. Токен хранится в карточке
 *     участника ЗАШИФРОВАННЫМ (AES-256-GCM); ключ шифрования выводится из
 *     пароля OAuth-приложения, который лежит на сервере в отдельном файле
 *     (/opt/sega/keys/yandex-oauth.json, права 600). Утёк db.json — токены
 *     без этого файла не открыть. Серверу дано право «Чтение всего Диска»
 *     (cloud_api:disk.read) — писать и удалять он не может.
 *   • Секреты приложения (client_id/client_secret) НИКОГДА не отдаются
 *     браузеру и не пишутся в базу: файл читается только на сервере.
 *   • Внешних зависимостей нет: только встроенные модули Node (https, http,
 *     fs, crypto). Адреса Яндекса и путь к файлу ключей переопределяются
 *     переменными окружения — это используют тесты (подставляют локальный
 *     «игрушечный» Яндекс) и запасная площадка.
 */

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { URL, URLSearchParams } = require('url');

const DEF_OAUTH_BASE = 'https://oauth.yandex.ru';
const DEF_API_BASE = 'https://cloud-api.yandex.net';
const DEF_KEYS_PATH = '/opt/sega/keys/yandex-oauth.json';
const DEF_REDIRECT = 'https://segachat.pilpro.ru/api/yadisk/callback';

/** Настройки читаются на каждый вызов: владелец может положить файл ключей,
 * не перезапуская сервер, и всё сразу заработает. */
function cfg() {
  const trim = s => String(s || '').replace(/\/+$/, '');
  return {
    oauthBase: trim(process.env.YADISK_OAUTH_BASE || DEF_OAUTH_BASE),
    apiBase: trim(process.env.YADISK_API_BASE || DEF_API_BASE),
    keysPath: String(process.env.YADISK_KEYS || DEF_KEYS_PATH),
    redirect: String(process.env.YADISK_REDIRECT || DEF_REDIRECT)
  };
}

/** Файл ключей OAuth-приложения: {"client_id":"…","client_secret":"…"}.
 * Принимаются и «человеческие» имена полей (clientId/secret/password), чтобы
 * владелец мог сохранить то, что показал сайт Яндекса, почти без правок.
 * Нет файла или он кривой — null: маршруты честно скажут «ключей нет». */
function loadKeys(keysPath) {
  const p = String(keysPath || cfg().keysPath);
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const id = String(j.client_id || j.clientId || j.id || '').trim();
    const secret = String(j.client_secret || j.clientSecret || j.secret || j.password || '').trim();
    if (!id || !secret) return null;
    return { clientId: id, clientSecret: secret };
  } catch (e) { return null; }
}

/** Ключ шифрования токенов: выводится из пароля приложения. Сам пароль в базу
 * не попадает — только производный ключ, и тот живёт в памяти процесса. */
function tokenKey(clientSecret) {
  return crypto.createHash('sha256').update('sega-chat-yadisk-v1:' + String(clientSecret)).digest();
}

/** Запечатать объект токена в строку для базы (AES-256-GCM, iv+tag внутри). */
function sealToken(key, obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return 'v1.' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

/** Распечатать токен. Не открывается (сменились ключи приложения, битая
 * строка) — null: участник просто считается неподключённым. */
function openToken(key, blob) {
  try {
    const s = String(blob || '');
    if (!s.startsWith('v1.')) return null;
    const raw = Buffer.from(s.slice(3), 'base64');
    if (raw.length < 29) return null;
    const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    const txt = Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
    const o = JSON.parse(txt);
    return (o && typeof o.access_token === 'string' && o.access_token) ? o : null;
  } catch (e) { return null; }
}

/** Маленький HTTP-клиент без зависимостей. Отвечает {status, json, text} при
 * ЛЮБОМ коде ответа (4xx/5xx — не исключение: маршрут сам решит, что сказать);
 * исключение — только когда Яндекс вовсе не откликся (сеть/таймаут). */
function httpJSON(urlStr, opts = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error('Неверный адрес запроса')); }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return reject(new Error('Только https/http'));
    const mod = u.protocol === 'https:' ? https : http;
    const headers = Object.assign({}, opts.headers || {});
    let body = null;
    if (opts.form) {
      body = new URLSearchParams(opts.form).toString();
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = mod.request(u, {
      method: opts.method || (body ? 'POST' : 'GET'),
      headers,
      timeout: Number(opts.timeout || 10000)
    }, res => {
      const chunks = [];
      let size = 0;
      res.on('data', c => {
        size += c.length;
        if (size > 2 * 1024 * 1024) { req.destroy(); reject(new Error('Слишком большой ответ')); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* не JSON — маршруты посмотрят на text */ }
        resolve({ status: res.statusCode || 0, json, text });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('Яндекс не отвечает (таймаут)')); });
    req.on('error', e => reject(new Error('Яндекс не отвечает: ' + (e.message || e))));
    if (body) req.write(body);
    req.end();
  });
}

/** Ссылка на страницу согласия Яндекса. Собирается ТОЛЬКО из своего oauthBase
 * (боевой oauth.yandex.ru либо тестовый стенд) — клиент не может подсунуть
 * свой адрес. state — одноразовая метка сервера (защита от подделки ответа). */
function buildAuthUrl(keys, state, c) {
  const conf = c || cfg();
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: String(keys.clientId),
    state: String(state),
    redirect_uri: conf.redirect
  });
  return conf.oauthBase + '/authorize?' + q.toString();
}

/** Обмен кода согласия на токены (POST /token). */
async function exchangeCode(keys, code, c) {
  const conf = c || cfg();
  const r = await httpJSON(conf.oauthBase + '/token', {
    form: {
      grant_type: 'authorization_code', code: String(code),
      client_id: keys.clientId, client_secret: keys.clientSecret
    }
  });
  return tokenFromResponse(r);
}

/** Продление токена, когда срок старого подходит к концу. */
async function refreshTokens(keys, refreshToken, c) {
  const conf = c || cfg();
  const r = await httpJSON(conf.oauthBase + '/token', {
    form: {
      grant_type: 'refresh_token', refresh_token: String(refreshToken),
      client_id: keys.clientId, client_secret: keys.clientSecret
    }
  });
  return tokenFromResponse(r);
}

function tokenFromResponse(r) {
  const j = r.json || {};
  if (r.status !== 200 || !j.access_token) {
    const why = j.error_description || j.error || ('код ответа ' + r.status);
    const e = new Error('Яндекс отказал в доступе: ' + why);
    e.status = r.status;
    e.yerror = String(j.error || '');
    throw e;
  }
  return {
    access_token: String(j.access_token),
    refresh_token: j.refresh_token ? String(j.refresh_token) : '',
    expires_at: Date.now() + (Math.max(60, Number(j.expires_in) || 3600) - 60) * 1000,
    scope: String(j.scope || '')
  };
}

/** Путь к файлу на Диске: принимаем «disk:/Музыка/трек.mp3» и «/Музыка/трек.mp3»,
 * всё остальное (пусто, «..», чужие схемы, мусор) — отбраковываем. */
function safePath(raw) {
  const p = String(raw || '');
  if (!p || p.length > 4096) return null;
  if (p.includes('..') || p.includes('\u0000')) return null;
  if (/[\r\n]/.test(p)) return null;
  let norm = p;
  if (norm.startsWith('/')) norm = 'disk:' + norm;
  if (!/^disk:\/[^\s]/.test(norm) && norm !== 'disk:/') {
    // допускаем только форму disk:/… — никаких http:, data: и прочего
    return null;
  }
  return norm;
}

/** Плоский список аудиофайлов всего Диска (resources/files, media_type=audio). */
async function listAudio(token, o = {}, c) {
  const conf = c || cfg();
  const limit = Math.min(1000, Math.max(1, Number(o.limit) || 200));
  const offset = Math.max(0, Number(o.offset) || 0);
  // pkg3-91: параметра fields НЕТ. Живой Яндекс на fields=items(…) отвечает
  // кодом 200 с телом без массива items (урок первой установки pkg3-90,
  // замер с VPS владельца): запрос без fields возвращает нормальный список.
  const q = new URLSearchParams({
    media_type: 'audio',
    limit: String(limit),
    offset: String(offset)
  });
  const r = await httpJSON(conf.apiBase + '/v1/disk/resources/files?' + q.toString(), {
    headers: { Authorization: 'OAuth ' + token, Accept: 'application/json' }
  });
  return diskResult(r, limit, offset);
}

/** Временная ссылка на скачивание/проигрывание одного файла. */
async function downloadHref(token, diskPath, c) {
  const conf = c || cfg();
  const p = safePath(diskPath);
  if (!p) { const e = new Error('Неверный путь к файлу на Диске'); e.status = 400; throw e; }
  const q = new URLSearchParams({ path: p });
  const r = await httpJSON(conf.apiBase + '/v1/disk/resources/download?' + q.toString(), {
    headers: { Authorization: 'OAuth ' + token, Accept: 'application/json' }
  });
  const j = r.json || {};
  if (r.status !== 200 || !j.href) {
    const e = new Error(diskErrorText(r));
    e.status = r.status;
    throw e;
  }
  const href = String(j.href);
  // Белый список: играем только с официальных раздающих доменов Яндекса —
  // если «Яндекс» вдруг ответит чужим адресом, браузер его не получит.
  if (!/^https:\/\/[a-z0-9.-]*\.(yandex\.net|yandex\.ru|disk\.yandex\.[a-z]+|yadi\.sk)\//i.test(href)) {
    const e = new Error('Яндекс вернул подозрительную ссылку — не отдаём её браузеру');
    e.status = 502;
    throw e;
  }
  return { href, ttl: String(j.ttl || ''), path: p };
}

function diskErrorText(r) {
  const j = r.json || {};
  if (r.status === 401 || r.status === 403) return 'Диск отказал в доступе (401/403): подключите его заново';
  if (r.status === 404) return 'Файл не найден на Диске (возможно, его переместили или удалили)';
  if (r.status === 429) return 'Яндекс просит подождать: слишком много запросов (429)';
  return 'Яндекс.Диск ответил ошибкой ' + r.status + (j.message ? ': ' + j.message : '') + (j.description ? ' (' + j.description + ')' : '');
}

function diskResult(r, limit, offset) {
  // pkg3-91: код 200 без списка в теле — отдельная человеческая формулировка
  // (прежде было «ответил ошибкой 200», что сбивало с толку).
  if (r.status === 200 && r.json && !Array.isArray(r.json.items)) {
    const e = new Error('Яндекс.Диск ответил 200, но без списка в ответе — повторите попытку');
    e.status = 200;
    throw e;
  }
  if (r.status !== 200 || !r.json || !Array.isArray(r.json.items)) {
    const e = new Error(diskErrorText(r));
    e.status = r.status;
    throw e;
  }
  const items = r.json.items
    .filter(x => x && typeof x.path === 'string')
    .map(x => ({
      path: x.path,
      name: String(x.name || x.path.split('/').pop() || 'трек').slice(0, 300),
      size: Math.max(0, Number(x.size) || 0),
      mime: String(x.mime_type || ''),
      modified: String(x.modified || '')
    }));
  return { items, limit, offset };
}

module.exports = {
  cfg, loadKeys, tokenKey, sealToken, openToken,
  buildAuthUrl, exchangeCode, refreshTokens,
  listAudio, downloadHref, safePath, httpJSON
};
