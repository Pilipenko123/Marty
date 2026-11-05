'use strict';
/**
 * pkg3-126: Google Диск — второй диск в разделе «Мои диски».
 *
 * Чем отличается от Яндекса (lib/yadisk.js) и почему так:
 *   • Вход — обычный OAuth Google: владелец создаёт своё приложение в Google
 *     Cloud, кладёт client_id и client_secret в /opt/sega/keys/google-oauth.json
 *     (права 600). Сервер просит ТОЛЬКО право «видеть файлы»
 *     (drive.readonly) — писать и удалять он не может, и это честно сказано в
 *     интерфейсе.
 *   • Токены (access + refresh) хранятся в карточке участника ЗАШИФРОВАННЫМИ,
 *     ключ выводится из client_secret и живёт только в памяти процесса.
 *   • Файлы НЕ копируются на сервер: сервер отдаёт браузеру короткий адрес со
 *     своим пропуском (/api/gdrive/stream), а сам в этот момент переливает байты
 *     из Google. Так сделано потому, что Google не даёт «временных ссылок» на
 *     файл, как Яндекс: скачать можно только с заголовком Authorization.
 *   • Пути: `google:/<id файла или папки>`, корень — `google:/root`. Поэтому
 *     ссылка `sega-disk://…` и вся логика прав из 125-го работают без переделки:
 *     сервер смотрит на начало пути и выбирает нужный диск.
 *
 * Внешних зависимостей нет: только встроенные модули Node.
 */

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { URL, URLSearchParams } = require('url');

const DEF_AUTH_BASE = 'https://accounts.google.com';
const DEF_TOKEN_BASE = 'https://oauth2.googleapis.com';
const DEF_API_BASE = 'https://www.googleapis.com';
const DEF_KEYS_PATH = '/opt/sega/keys/google-oauth.json';
const DEF_REDIRECT = 'https://segachat.pilpro.ru/api/gdrive/callback';
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

const trim = s => String(s || '').replace(/\/+$/, '');

/** Настройки читаются на каждый вызов: владелец может положить файл ключей без
 * перезапуска сервера. Адреса переопределяются в тестах (игрушечный Google). */
function cfg() {
  return {
    authBase: trim(process.env.GDRIVE_AUTH_BASE || DEF_AUTH_BASE),
    tokenBase: trim(process.env.GDRIVE_TOKEN_BASE || DEF_TOKEN_BASE),
    apiBase: trim(process.env.GDRIVE_API_BASE || DEF_API_BASE),
    keysPath: String(process.env.GDRIVE_KEYS || DEF_KEYS_PATH),
    redirect: String(process.env.GDRIVE_REDIRECT || DEF_REDIRECT)
  };
}

/** Файл ключей приложения Google: {"client_id":"…","client_secret":"…"}.
 * Принимаются и «человеческие» имена — так проще сохранить то, что показал
 * Google Cloud. Нет файла или он кривой — null (маршруты скажут «ключей нет»). */
function loadKeys(keysPath) {
  const p = String(keysPath || cfg().keysPath);
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const id = String(j.client_id || j.clientId || j.id || '').trim();
    const secret = String(j.client_secret || j.clientSecret || j.secret || '').trim();
    if (!id || !secret) return null;
    return { clientId: id, clientSecret: secret };
  } catch (e) { return null; }
}

/** Что сказать владельцу, когда ключей нет (окно подключения показывает это). */
const KEYS_HINT = 'Google Диск требует своего приложения в Google Cloud. Шаги: '
  + 'console.cloud.google.com → новый проект → «APIs & Services» → включить '
  + '«Google Drive API» → «OAuth consent screen» (тип External, добавьте себя в '
  + 'Test users) → «Credentials» → «Create credentials» → «OAuth client ID» → '
  + 'тип «Web application», в «Authorized redirect URIs» вписать '
  + 'https://segachat.pilpro.ru/api/gdrive/callback → скопировать client_id и '
  + 'client_secret в файл /opt/sega/keys/google-oauth.json вида '
  + '{"client_id":"…","client_secret":"…"} и выполнить chmod 600 на него.';

/** Ключ шифрования токенов: производный от client_secret (в базу не попадает). */
function tokenKey(clientSecret) {
  return crypto.createHash('sha256').update('sega-chat-gdrive-v1:' + String(clientSecret)).digest();
}

function sealToken(key, obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return 'g1.' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

function openToken(key, blob) {
  try {
    const s = String(blob || '');
    if (!s.startsWith('g1.')) return null;
    const raw = Buffer.from(s.slice(3), 'base64');
    if (raw.length < 29) return null;
    const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    const txt = Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
    const o = JSON.parse(txt);
    return (o && typeof o.access_token === 'string' && o.access_token) ? o : null;
  } catch (e) { return null; }
}

/** Маленький HTTP-клиент без зависимостей: отвечает {status, json} на любой код;
 * исключение — только когда Google вовсе не откликнулся. */
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
    const req = mod.request(u, { method: opts.method || (body ? 'POST' : 'GET'), headers, timeout: Number(opts.timeout || 10000) }, res => {
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
        try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
        resolve({ status: res.statusCode || 0, json, text });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('Google не ответил вовремя')); });
    req.on('error', e => reject(e));
    if (body) req.write(body);
    req.end();
  });
}

/** Человеческий текст ошибки Google (по-русски, без английских простыней). */
function googleErrorText(r) {
  const j = (r && r.json) || {};
  const err = j.error && (j.error.message || j.error.status || j.error);
  const code = (r && r.status) || 0;
  if (code === 401) return 'Google больше не пускает: доступ отозван — подключите Диск заново';
  if (code === 403) return 'Google отказал в доступе к этому файлу (права только на чтение)';
  if (code === 404) return 'Google не нашёл этот файл — возможно, он удалён или лежит в корзине';
  if (typeof err === 'string' && err) return 'Google ответил: ' + err.slice(0, 160);
  return 'Google ответил кодом ' + code;
}

/** Адрес страницы согласия Google. state — наша подпись (кто именно входит). */
function buildAuthUrl(state, c) {
  const conf = c || cfg();
  const keys = loadKeys(conf.keysPath);
  if (!keys) { const e = new Error(KEYS_HINT); e.status = 409; throw e; }
  const q = new URLSearchParams({
    client_id: keys.clientId,
    redirect_uri: conf.redirect,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state: String(state || '')
  });
  return conf.authBase + '/o/oauth2/v2/auth?' + q.toString();
}

/** Обменять код на токены. */
async function exchangeCode(code, c) {
  const conf = c || cfg();
  const keys = loadKeys(conf.keysPath);
  if (!keys) { const e = new Error(KEYS_HINT); e.status = 409; throw e; }
  const r = await httpJSON(conf.tokenBase + '/token', {
    form: {
      code: String(code || ''),
      client_id: keys.clientId,
      client_secret: keys.clientSecret,
      redirect_uri: conf.redirect,
      grant_type: 'authorization_code'
    }
  });
  const j = r.json || {};
  if (r.status !== 200 || !j.access_token) { const e = new Error(googleErrorText(r)); e.status = r.status; throw e; }
  return {
    access_token: j.access_token,
    refresh_token: j.refresh_token || '',
    expires_at: Date.now() + (Math.max(60, Number(j.expires_in) || 3600) - 60) * 1000,
    scope: String(j.scope || '')
  };
}

/** Обновить просроченный токен по refresh_token. */
async function refreshTokens(refreshToken, c) {
  const conf = c || cfg();
  const keys = loadKeys(conf.keysPath);
  if (!keys) { const e = new Error(KEYS_HINT); e.status = 409; throw e; }
  const r = await httpJSON(conf.tokenBase + '/token', {
    form: {
      refresh_token: String(refreshToken || ''),
      client_id: keys.clientId,
      client_secret: keys.clientSecret,
      grant_type: 'refresh_token'
    }
  });
  const j = r.json || {};
  if (r.status !== 200 || !j.access_token) { const e = new Error(googleErrorText(r)); e.status = r.status; throw e; }
  return {
    access_token: j.access_token,
    refresh_token: String(refreshToken || ''),
    expires_at: Date.now() + (Math.max(60, Number(j.expires_in) || 3600) - 60) * 1000
  };
}

/* ── пути ─────────────────────────────────────────────────────────────────── */
const PREFIX = 'google:';
/** `google:/<id>`; корень — `google:/root`. Чужие и опасные пути — пустая строка. */
function safePath(p) {
  let s = String(p == null ? '' : p).trim();
  if (!s.startsWith(PREFIX)) return '';
  s = s.slice(PREFIX.length).replace(/^\/+/, '').replace(/\/+$/, '');
  if (s === '' || s === 'root') return 'google:/root';
  if (!/^[A-Za-z0-9_-]{2,200}$/.test(s)) return '';
  return 'google:/' + s;
}
/** Идентификатор файла/папки из пути (для запросов к Google). */
function idOf(p) {
  const s = safePath(p);
  if (!s) return '';
  const id = s.slice(PREFIX.length + 1);
  return id === 'root' ? 'root' : id;
}
function isGooglePath(p) { return String(p || '').startsWith(PREFIX); }

/** Ссылки Google показываем только с его раздающих доменов. */
function safeGoogleUrl(raw) {
  const href = String(raw || '');
  if (!href) return '';
  return /^https:\/\/[a-z0-9.-]*\.(googleusercontent\.com|googleapis\.com|gstatic\.com)\//i.test(href) ? href : '';
}

/** Тип файла для интерфейса: audio / image / video / doc / other. */
function mediaOf(mime) {
  const m = String(mime || '').toLowerCase();
  if (/^audio\//.test(m)) return 'audio';
  if (/^image\//.test(m)) return 'image';
  if (/^video\//.test(m)) return 'video';
  if (m === 'application/vnd.google-apps.folder') return 'dir';
  if (m) return 'doc';
  return 'other';
}

const FOLDER_MIME = 'application/vnd.google-apps.folder';

/** Сколько места занято и свободно (у Google может быть «без ограничений»). */
async function aboutSpace(token, c) {
  const conf = c || cfg();
  const r = await httpJSON(conf.apiBase + '/drive/v3/about?fields=storageQuota(limit,usage)', {
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }
  });
  if (r.status !== 200 || !r.json) { const e = new Error(googleErrorText(r)); e.status = r.status; throw e; }
  const q = r.json.storageQuota || {};
  const total = Math.max(0, Number(q.limit) || 0);
  const used = Math.max(0, Number(q.usage) || 0);
  return { total, used, free: total ? Math.max(0, total - used) : 0 };
}

/** Содержимое папки: и папки, и файлы любых типов. */
async function listFolder(token, googlePath, o = {}, c) {
  const conf = c || cfg();
  const p = safePath(googlePath) || 'google:/root';
  const id = idOf(p);
  const pageSize = Math.min(200, Math.max(1, Number(o.limit) || 200));
  const q = new URLSearchParams({
    q: `'${id}' in parents and trashed = false`,
    // fields обязателен: без него Google отдаёт только id и name
    fields: 'files(id,name,mimeType,size,modifiedTime,thumbnailLink),nextPageToken',
    pageSize: String(pageSize),
    orderBy: 'folder,name',
    includeItemsFromAllDrives: 'true',
    supportsAllDrives: 'true'
  });
  const r = await httpJSON(conf.apiBase + '/drive/v3/files?' + q.toString(), {
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }
  });
  if (r.status !== 200 || !r.json) { const e = new Error(googleErrorText(r)); e.status = r.status; throw e; }
  const files = Array.isArray(r.json.files) ? r.json.files : [];
  const items = files
    .filter(x => x && typeof x.id === 'string')
    .map(x => {
      const dir = x.mimeType === FOLDER_MIME;
      const mime = String(x.mimeType || '');
      return {
        path: 'google:/' + x.id,
        name: String(x.name || 'файл').slice(0, 300),
        dir,
        // у «документов Google» размера нет вовсе
        size: Math.max(0, Number(x.size) || 0),
        mime,
        media: dir ? 'dir' : mediaOf(mime),
        preview: safeGoogleUrl(x.thumbnailLink),
        modified: String(x.modifiedTime || '')
      };
    });
  items.sort((a, b) => (b.dir ? 1 : 0) - (a.dir ? 1 : 0) || a.name.localeCompare(b.name, 'ru'));
  // pkg3-126: чтобы кнопка «↑» работала, узнаём родителя самой папки и её имя.
  // У Google нет «пути строкой», как у Яндекса, — только ссылки на родителей.
  let parent = '', folderName = '';
  if (id !== 'root') {
    try {
      const mr = await httpJSON(conf.apiBase + '/drive/v3/files/' + encodeURIComponent(id) + '?fields=name,parents&supportsAllDrives=true', {
        headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }
      });
      if (mr.status === 200 && mr.json) {
        folderName = String(mr.json.name || '');
        const par = Array.isArray(mr.json.parents) ? mr.json.parents[0] : '';
        if (par) parent = 'google:/' + par;
      }
    } catch (e) { parent = ''; }
  }
  return { path: p, items, limit: pageSize, offset: 0, total: items.length, parent, name: folderName };
}

/** Все аудиофайлы Диска (для панели «🅖 Google Диск» в «Моей музыке»).
 * pkg3-127: ищем по типу, как это делает Яндекс, — папки не обходим. */
async function listAudio(token, o = {}, c) {
  const conf = c || cfg();
  const limit = Math.min(200, Math.max(1, Number(o.limit) || 200));
  const q = new URLSearchParams({
    q: "mimeType contains 'audio/' and trashed = false",
    fields: 'files(id,name,mimeType,size,modifiedTime)',
    pageSize: String(limit),
    orderBy: 'name',
    includeItemsFromAllDrives: 'true',
    supportsAllDrives: 'true'
  });
  const r = await httpJSON(conf.apiBase + '/drive/v3/files?' + q.toString(), {
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }
  });
  if (r.status !== 200 || !r.json) { const e = new Error(googleErrorText(r)); e.status = r.status; throw e; }
  const items = (Array.isArray(r.json.files) ? r.json.files : []).map(x => ({
    path: 'google:/' + x.id,
    name: String(x.name || 'трек').slice(0, 300),
    size: Math.max(0, Number(x.size) || 0),
    mime: String(x.mimeType || ''),
    media: 'audio',
    modified: String(x.modifiedTime || '')
  }));
  items.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  return { items, limit, offset: 0, more: false };
}

/** Метаданные одного файла (для карточки и проверки, что он существует). */
async function fileMeta(token, googlePath, c) {
  const conf = c || cfg();
  const id = idOf(googlePath);
  if (!id) { const e = new Error('Неверный путь к файлу на Google Диске'); e.status = 400; throw e; }
  const q = new URLSearchParams({ fields: 'id,name,mimeType,size,modifiedTime,thumbnailLink', supportsAllDrives: 'true' });
  const r = await httpJSON(conf.apiBase + '/drive/v3/files/' + encodeURIComponent(id) + '?' + q.toString(), {
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }
  });
  if (r.status !== 200 || !r.json) { const e = new Error(googleErrorText(r)); e.status = r.status; throw e; }
  const x = r.json;
  const dir = x.mimeType === FOLDER_MIME;
  return {
    path: 'google:/' + x.id,
    name: String(x.name || 'файл').slice(0, 300),
    dir,
    size: Math.max(0, Number(x.size) || 0),
    mime: String(x.mimeType || ''),
    media: dir ? 'dir' : mediaOf(x.mimeType),
    preview: safeGoogleUrl(x.thumbnailLink),
    modified: String(x.modifiedTime || '')
  };
}

/** Родители файла — по ним проверяем, лежит ли файл внутри открытой папки
 * (у Google путь строкой не существует, только ссылки на родителей). */
async function parentsOf(token, fileId, c) {
  const conf = c || cfg();
  const id = String(fileId || '').replace(/^google:\/?/, '');
  if (!/^[A-Za-z0-9_-]{2,200}$/.test(id)) return [];
  const q = new URLSearchParams({ fields: 'id,parents', supportsAllDrives: 'true' });
  const r = await httpJSON(conf.apiBase + '/drive/v3/files/' + encodeURIComponent(id) + '?' + q.toString(), {
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }
  });
  if (r.status !== 200 || !r.json) { const e = new Error(googleErrorText(r)); e.status = r.status; throw e; }
  return Array.isArray(r.json.parents) ? r.json.parents : [];
}

/** Адрес, по которому сервер сам забирает байты файла (нужен заголовок входа —
 * поэтому браузеру отдаём не его, а свой пропуск /api/gdrive/stream). */
function mediaUrl(googlePath, c) {
  const conf = c || cfg();
  const id = idOf(googlePath);
  if (!id || id === 'root') { const e = new Error('Неверный путь к файлу на Google Диске'); e.status = 400; throw e; }
  return conf.apiBase + '/drive/v3/files/' + encodeURIComponent(id) + '?alt=media&supportsAllDrives=true';
}

module.exports = {
  cfg, loadKeys, KEYS_HINT, tokenKey, sealToken, openToken, httpJSON,
  buildAuthUrl, exchangeCode, refreshTokens,
  safePath, idOf, isGooglePath, pathOf: p => 'google:/' + idOf(p),
  aboutSpace, listFolder, listAudio, fileMeta, parentsOf, mediaOf, mediaUrl, safeGoogleUrl,
  googleErrorText, FOLDER_MIME, PREFIX
};
