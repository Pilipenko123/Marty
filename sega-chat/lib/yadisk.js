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
    redirect: String(process.env.YADISK_REDIRECT || DEF_REDIRECT),
    // pkg3-130: в тестах «раздающий» адрес Яндекса — игрушечный сервер;
    // на живом сервере эта настройка пуста и работает только белый список.
    cdnBase: String(process.env.YADISK_CDN_BASE || '').replace(/\/+$/, '')
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
  let deadline;
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
      // Частичное тело после успешных заголовков — неопределённый результат,
      // а не окончательный ответ Яндекса. Ошибка req при этом не гарантирована.
      const incomplete = () => reject(new Error('Ответ Яндекса прерван'));
      res.on('aborted', incomplete);
      res.on('error', incomplete);
      res.on('close', () => { if (!res.complete) incomplete(); });
      res.on('data', c => {
        size += c.length;
        if (size > 2 * 1024 * 1024) { req.destroy(); reject(new Error('Слишком большой ответ')); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        if (!res.complete) return incomplete();
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* не JSON — маршруты посмотрят на text */ }
        resolve({ status: res.statusCode || 0, json, text });
      });
    });
    // Таймаут сокета отсчитывает бездействие; медленный поток может
    // постоянно его сбрасывать. Ограничиваем и полное время запроса.
    deadline = setTimeout(() => req.destroy(new Error('Яндекс не ответил вовремя')), Number(opts.timeout || 10000));
    req.on('timeout', () => { req.destroy(new Error('Яндекс не отвечает (таймаут)')); });
    req.on('error', e => reject(new Error('Яндекс не отвечает: ' + (e.message || e))));
    if (body) req.write(body);
    req.end();
  }).finally(() => clearTimeout(deadline));
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

/**
 * pkg3-121: знает ли Яндекс наше приложение. Спрашиваем у Яндекса ту же
 * страницу согласия, на которую уводим человека, и смотрим ответ: живое
 * приложение отдаёт 200/302, удалённое или чужой client_id — 400 и текст
 * «Неизвестно приложение с таким client_id». Так приложение может показать
 * СВОЮ подсказку вместо чужой страницы с ошибкой 400.
 */
async function probeAuth(keys, c) {
  const conf = c || cfg();
  if (!keys || !keys.clientId) return { ok: false, status: 0, reason: 'keys' };
  const url = buildAuthUrl(keys, 'sega-probe-' + Date.now().toString(36), conf);
  let r;
  try { r = await httpJSON(url, { timeout: 8000 }); }
  catch (e) { return { ok: false, status: 0, reason: 'net', text: String(e.message || e) }; }
  const text = String(r.text || '');
  const unknown = r.status === 400 || /Неизвестно приложение|Unknown (application|client)/i.test(text);
  if (unknown) return { ok: false, status: r.status, reason: 'unknown-app' };
  if (r.status >= 200 && r.status < 400) return { ok: true, status: r.status, reason: '' };
  return { ok: false, status: r.status, reason: 'status' };
}

/** Путь к файлу на Диске: принимаем «disk:/Музыка/трек.mp3» и «/Музыка/трек.mp3»,
 * всё остальное (пусто, «..», чужие схемы, мусор) — отбраковываем.
 * pkg3-129: второй диск того же вида живёт под своим началом — «disk2:/…».
 * Номер диска сохраняем (он нужен для токена и для прав), а к самому Яндексу
 * ходим путём без номера — см. apiPath(). */
function safePath(raw) {
  const p = String(raw || '');
  if (!p || p.length > 4096) return null;
  if (p.includes('..') || p.includes('\u0000')) return null;
  if (/[\r\n]/.test(p)) return null;
  let norm = p;
  if (norm.startsWith('/')) norm = 'disk:' + norm;
  const m = /^(disk\d*):(\/.*)$/.exec(norm);
  if (!m) return null;                      // никаких http:, data: и прочего
  // pkg3-133: лишние косые схлопываем («disk://Новая папка» → «disk:/Новая
  // папка»). Так живые Яндекс-запросы не отвергаются с «Invalid path», даже
  // если старый экран в браузере собрал путь с двойной косой.
  const rest = m[2].replace(/\/{2,}/g, '/');
  // как и раньше: либо корень «disk:/», либо путь, начинающийся с имени
  // (пробелы ВНУТРИ имени — обычное дело: «Новая папка»)
  if (rest !== '/' && !/^\/[^\s]/.test(rest)) return null;
  return m[1] + ':' + rest;
}

/** Путь в том виде, в каком его понимает сам Яндекс: без номера диска. */
function apiPath(p) {
  return String(p || '').replace(/^disk\d*:/, 'disk:');
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


/** pkg3-124: содержимое ОДНОЙ папки Диска — и папки, и файлы ЛЮБЫХ типов.
 * До этого сервер умел только плоский список музыки (listAudio): «Мои диски»
 * должны показывать весь Диск — фото, видео, документы, а не только треки. */
async function listFolder(token, diskPath, o = {}, c) {
  const conf = c || cfg();
  const p = apiPath(safePath(diskPath) || 'disk:/');
  const limit = Math.min(200, Math.max(1, Number(o.limit) || 100));
  const offset = Math.max(0, Number(o.offset) || 0);
  // pkg3-91 (урок listAudio): параметр fields НЕ передаём — на живом Яндексе
  // ответ с fields приходил кодом 200 и без списка. Без него items на месте.
  const q = new URLSearchParams({ path: p, limit: String(limit), offset: String(offset) });
  const r = await httpJSON(conf.apiBase + '/v1/disk/resources?' + q.toString(), {
    headers: { Authorization: 'OAuth ' + token, Accept: 'application/json' }
  });
  const emb = (r.json || {})._embedded;
  if (r.status !== 200 || !emb || !Array.isArray(emb.items)) {
    const e = new Error(diskErrorText(r));
    e.status = r.status;
    throw e;
  }
  const items = emb.items
    .filter(x => x && typeof x.path === 'string')
    .map(x => ({
      path: x.path,
      name: String(x.name || x.path.split('/').pop() || '').slice(0, 300),
      dir: x.type === 'dir',
      size: Math.max(0, Number(x.size) || 0),
      mime: String(x.mime_type || ''),
      media: mediaOf(x),
      // pkg3-125: готовое превью Яндекса (подписанная ссылка). Берём ТОЛЬКО
      // с раздающих доменов Яндекса — как и ссылки на скачивание.
      preview: safeYandexUrl(x.preview),
      modified: String(x.modified || '')
    }));
  // папки — первыми, внутри — по имени (регистр не важен), как в проводнике
  items.sort((a, b) => (b.dir ? 1 : 0) - (a.dir ? 1 : 0) || a.name.localeCompare(b.name, 'ru'));
  return { path: p, items, limit, offset, total: Math.max(0, Number(emb.total) || items.length) };
}

/** Тип файла для интерфейса: audio / image / video / doc / other. */
function mediaOf(x) {
  const mt = String(x.media_type || '');
  const mime = String(x.mime_type || '');
  if (mt === 'audio' || /^audio\//.test(mime)) return 'audio';
  if (mt === 'image' || /^image\//.test(mime)) return 'image';
  if (mt === 'video' || /^video\//.test(mime)) return 'video';
  if (mt === 'document' || /^(application|text)\//.test(mime)) return 'doc';
  return 'other';
}

/** Адрес Яндекса из ответа API — или пусто. Один белый список на всё:
 * браузер получает только ссылки с доменов Яндекса (pkg3-90/124/125). */
/** pkg3-130: годится ли ссылка на файл (белый список + настройка стенда). */
function isSafeHref(href, conf) {
  const s = String(href || '');
  const c = conf || cfg();
  if (c.cdnBase && s.startsWith(c.cdnBase + '/')) return true;
  return /^https:\/\/[a-z0-9.-]*\.(yandex\.net|yandex\.ru|disk\.yandex\.[a-z]+|yadi\.sk)\//i.test(s);
}

function safeYandexUrl(raw) {
  const href = String(raw || '');
  if (!href) return '';
  return /^https:\/\/[a-z0-9.-]*\.(yandex\.net|yandex\.ru|disk\.yandex\.[a-z]+|yadi\.sk)\//i.test(href) ? href : '';
}

/** pkg3-125: сколько места на Диске занято и свободно (для строки в проводнике). */
async function diskInfo(token, c) {
  const conf = c || cfg();
  const r = await httpJSON(conf.apiBase + '/v1/disk/', {
    headers: { Authorization: 'OAuth ' + token, Accept: 'application/json' }
  });
  if (r.status !== 200 || !r.json) { const e = new Error(diskErrorText(r)); e.status = r.status; throw e; }
  const total = Math.max(0, Number(r.json.total_space) || 0);
  const used = Math.max(0, Number(r.json.used_space) || 0);
  return { total, used, free: Math.max(0, total - used) };
}

/** pkg3-125: папка на Диске (PUT /v1/disk/resources). */
async function mkdir(token, diskPath, c) {
  const conf = c || cfg();
  const p = apiPath(safePath(diskPath));
  if (!p || p === 'disk:/') { const e = new Error('Неверный путь папки'); e.status = 400; throw e; }
  const q = new URLSearchParams({ path: p });
  const r = await httpJSON(conf.apiBase + '/v1/disk/resources?' + q.toString(), {
    method: 'PUT', headers: { Authorization: 'OAuth ' + token }
  });
  if (r.status !== 201 && r.status !== 200) { const e = new Error(writeErrorText(r, 'mkdir')); e.status = r.status; throw e; }
  return { ok: true, path: p };
}

/**
 * pkg3-134: «а можно ли вообще менять файлы на ЭТОМ диске?» Создаём служебную
 * папку и сразу убираем её. Нужно, когда у человека два Диска и один из них
 * почему-то не даёт создавать папки: так ответ Яндекса виден словами.
 */
async function writeCheck(token, c) {
  const conf = c || cfg();
  const name = '.sega-проверка-' + Math.random().toString(36).slice(2, 8);
  const p = 'disk:/' + name;
  try {
    await mkdir(token, p, conf);
  } catch (e) {
    return { canWrite: false, status: Number(e.status) || 0, error: e.message || String(e), cleaned: true };
  }
  let cleaned = true;
  try { await removePath(token, p, conf); } catch (e) { cleaned = false; }
  return { canWrite: true, status: 200, error: '', cleaned };
}

// Адрес статуса приходит в ответе удалённого сервиса. Прежде чем посылать по
// нему токен, разрешаем только тот же настроенный origin и документированные
// формы пути операции; никаких redirect, дополнительных параметров или userinfo.
function operationUrl(link, apiBase) {
  if (!link || link.method !== 'GET' || link.templated !== false || typeof link.href !== 'string' || link.href.length > 2048) return '';
  try {
    const base = new URL(apiBase), u = new URL(link.href);
    if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || u.origin !== base.origin || u.username || u.password || u.hash) return '';
    const id = '[A-Za-z0-9_-]{1,512}';
    if (u.pathname === '/v1/disk/operations') {
      const entries = [...u.searchParams];
      if (entries.length !== 1 || entries[0][0] !== 'id' || !(new RegExp('^' + id + '$')).test(entries[0][1])) return '';
    } else if (!(new RegExp('^/v1/disk/operations/' + id + '$')).test(u.pathname) || u.search) return '';
    return u.href;
  } catch (_) { return ''; }
}
// Только чтение статуса; ссылке извне нельзя доверять токен до проверки origin.
async function confirmOperation(link, conf, token, unknown) {
  const operation = operationUrl(link, conf.apiBase);
  if (!operation) throw unknown();
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise(resolve => setTimeout(resolve, 250));
    let result;
    try { result = await httpJSON(operation, { headers: { Authorization: 'OAuth ' + token }, timeout: 2000 }); }
    catch (_) { throw unknown(); }
    if (result.status !== 200 || !result.json) throw unknown();
    if (result.json.status === 'success') return;
    if (result.json.status !== 'in-progress') throw unknown();
  }
  throw unknown();
}
function unknownTrashResult() {
  const e = new Error('Яндекс не подтвердил перенос в корзину. Проверьте состояние файла и корзину перед повторной попыткой.');
  e.status = 502; return e;
}
/** Убрать в корзину, не удаляя навсегда. 202 — только начало операции; ждём
 * несколько ответов о статусе и не запускаем удаление повторно. Это не механизм
 * синхронизации и не защита от замены файла или изменения содержимого папки. */
async function removePath(token, diskPath, c) {
  const conf = c || cfg();
  const p = apiPath(safePath(diskPath));
  if (!p || p === 'disk:/') { const e = new Error('Корень Диска удалить нельзя'); e.status = 400; throw e; }
  const q = new URLSearchParams({ path: p, permanently: 'false' });
  let r;
  try {
    r = await httpJSON(conf.apiBase + '/v1/disk/resources?' + q.toString(), {
      method: 'DELETE', headers: { Authorization: 'OAuth ' + token }
    });
  } catch (_) { throw unknownTrashResult(); }
  if (r.status === 204) return { ok: true, path: p };
  if (r.status === 202) {
    await confirmOperation(r.json, conf, token, unknownTrashResult);
    return { ok: true, path: p };
  }
  if ((r.status < 400) || r.status >= 500 || r.status === 408 || r.status === 429) throw unknownTrashResult();
  const e = new Error(writeErrorText(r, 'del')); e.status = r.status; throw e;
}

/** pkg3-125: переименовать/перенести (POST /v1/disk/resources/move). */
async function movePath(token, fromPath, toPath, c) {
  const conf = c || cfg();
  const from = apiPath(safePath(fromPath)), to = apiPath(safePath(toPath));
  if (!from || !to || from === 'disk:/' || to === 'disk:/') { const e = new Error('Неверный путь для переименования'); e.status = 400; throw e; }
  const q = new URLSearchParams({ from: from, path: to, overwrite: 'false' });
  const unknown = () => { const e = new Error('Яндекс не подтвердил переименование. Проверьте оба пути перед повторной попыткой.'); e.status = 502; return e; };
  let r;
  try {
    r = await httpJSON(conf.apiBase + '/v1/disk/resources/move?' + q.toString(), {
      method: 'POST', headers: { Authorization: 'OAuth ' + token }
    });
  } catch (_) { throw unknown(); }
  if (r.status === 201) return { ok: true, path: to };
  if (r.status === 202) {
    await confirmOperation(r.json, conf, token, unknown);
    return { ok: true, path: to };
  }
  if (r.status < 400 || r.status >= 500 || r.status === 408 || r.status === 429) throw unknown();
  const e = new Error(writeErrorText(r, 'rename')); e.status = r.status; throw e;
}

/** pkg3-125: адрес для загрузки файла. Сам файл идёт с устройства ПРЯМО в
 * Яндекс — через VPS не течёт (память 550 МБ бережём). */
async function uploadUrl(token, diskPath, o = {}, c) {
  const conf = c || cfg();
  const p = apiPath(safePath(diskPath));
  if (!p || p === 'disk:/') { const e = new Error('Неверный путь файла'); e.status = 400; throw e; }
  const q = new URLSearchParams({ path: p, overwrite: o.overwrite === false ? 'false' : 'true' });
  const r = await httpJSON(conf.apiBase + '/v1/disk/resources/upload?' + q.toString(), {
    headers: { Authorization: 'OAuth ' + token, Accept: 'application/json' }
  });
  const j = r.json || {};
  const href = safeYandexUrl(j.href);
  if (r.status !== 200 || !href) { const e = new Error(diskErrorText(r)); e.status = r.status; throw e; }
  return { href, method: String(j.method || 'PUT') };
}

/** Временная ссылка на скачивание/проигрывание одного файла. */
async function downloadHref(token, diskPath, c) {
  const conf = c || cfg();
  const p = apiPath(safePath(diskPath));
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
  if (!isSafeHref(href, conf)) {
    const e = new Error('Яндекс вернул подозрительную ссылку — не отдаём её браузеру');
    e.status = 502;
    throw e;
  }
  return { href, ttl: String(j.ttl || ''), path: p };
}

/**
 * pkg3-134: ошибка ПРАВКИ (создание, переименование, удаление, загрузка).
 * У Яндекса отказ по правам и отказ по месту приходят разными кодами, а человеку
 * нужно не «403», а что делать дальше. Текст ошибки сервера сохраняем — по нему
 * видно, что именно ответил Диск.
 */
function writeErrorText(r, what) {
  const j = (r && r.json) || {};
  const raw = String(j.message || j.description || j.error || '').slice(0, 200);
  const tail = raw ? ' (Яндекс: ' + raw + ')' : '';
  const act = what === 'del' ? 'удалять' : what === 'rename' ? 'переименовывать' : what === 'upload' ? 'загружать файлы' : 'создавать папки';
  if (r.status === 401) return 'Вход на Диск больше не действует — отключите диск и подключите заново' + tail;
  if (r.status === 403) {
    if (/read.?only|insufficient|access|forbidden/i.test(raw) || !raw) {
      return 'Яндекс не разрешает ' + act + ' на этом диске: у этого входа нет права записи. ' +
        'Отключите диск в «Моих дисках» и подключите заново (или вставьте токен, выданный с полными правами)' + tail;
    }
    return 'Яндекс отказал в правке: ' + act + ' нельзя' + tail;
  }
  if (r.status === 409) return 'На Диске уже есть объект с таким именем или папка занята' + tail;
  if (r.status === 423) return 'Файл сейчас занят другой программой — попробуйте позже' + tail;
  if (r.status === 507 || /quota|space/i.test(raw)) return 'На этом Диске не осталось свободного места' + tail;
  if (r.status === 404) return 'Яндекс не нашёл эту папку — возможно, её переместили или удалили' + tail;
  if (r.status === 400) return 'Яндекс не принял имя или путь' + tail;
  return 'Яндекс.Диск ответил ошибкой ' + r.status + tail;
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
  listAudio, listFolder, mediaOf, downloadHref, safePath, httpJSON, probeAuth, writeCheck, writeErrorText,
  diskInfo, mkdir, removePath, movePath, uploadUrl, safeYandexUrl
};
