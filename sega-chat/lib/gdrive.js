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
// pkg3-128: право на запись. Было «только смотреть» (drive.readonly) — теперь
// полный доступ к Диску, чтобы можно было создавать папки, загружать файлы,
// переименовывать и убирать в корзину. Старые входы остаются «только чтение»,
// пока человек не войдёт заново.
const SCOPE = 'https://www.googleapis.com/auth/drive';
const SCOPE_READONLY = 'https://www.googleapis.com/auth/drive.readonly';
const SCOPE_META_READONLY = 'https://www.googleapis.com/auth/drive.metadata.readonly';

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
    // pkg3-128: изменение файла (переименовать, убрать в корзину, создать папку)
    // шлём JSON-телом; адрес загрузки Google отдаёт в заголовке Location —
    // поэтому заголовки ответа теперь тоже возвращаются.
    if (opts.json !== undefined) {
      body = JSON.stringify(opts.json);
      if (!headers['Content-Type']) headers['Content-Type'] = 'application/json; charset=UTF-8';
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
        resolve({ status: res.statusCode || 0, json, text, headers: res.headers || {} });
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
  if (code === 403) {
    // pkg3-128: самая частая беда — вход был «только смотреть». Говорим прямо,
    // что делать, вместо английского «insufficientPermissions».
    const why = String((j.error && Array.isArray(j.error.errors) && j.error.errors[0] && j.error.errors[0].reason) || '')
      + ' ' + String((j.error && j.error.message) || '');
    if (/insufficient/i.test(why) || /permission/i.test(why)) {
      return 'Google не дал право менять файлы: вход был «только смотреть». Отключите Google Диск и войдите заново';
    }
    return 'Google отказал в доступе к этому файлу';
  }
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

/** pkg3-128: что разрешено нашему входу в Google.
 * 'yes' — можно менять файлы, 'no' — только смотреть (старый вход), 'unknown' —
 * права не записаны (вход 126-го выпуска): решаем по ответу Google. */
function scopeWrite(scope) {
  const list = String(scope || '').split(/\s+/).filter(Boolean);
  if (!list.length) return 'unknown';
  if (list.includes(SCOPE)) return 'yes';
  if (list.includes(SCOPE_READONLY) || list.includes(SCOPE_META_READONLY)) return 'no';
  return 'unknown';
}

/* ── пути ─────────────────────────────────────────────────────────────────── */
const PREFIX = 'google:';
/** `google:/<id>`; корень — `google:/root`. Чужие и опасные пути — пустая строка.
 * pkg3-129: второй Google-диск живёт под `google2:/<id>` — номер диска храним
 * в начале пути (он нужен для токена), а к Google ходим по одному id. */
const PRE_RE = /^(google\d*):/;
/** `google:/<id>` вместе с номером диска: «google2:/<id>» остаётся собой. */
function safePath(p) {
  let s = String(p == null ? '' : p).trim();
  const m = PRE_RE.exec(s);
  if (!m) return '';
  const head = m[1];
  s = s.slice(m[0].length).replace(/^\/+/, '').replace(/\/+$/, '');
  if (s === '' || s === 'root') return head + ':/root';
  if (!/^[A-Za-z0-9_-]{2,200}$/.test(s)) return '';
  return head + ':/' + s;
}
/** Идентификатор файла/папки из пути (для запросов к Google). */
function idOf(p) {
  const s = safePath(p);
  if (!s) return '';
  const id = s.replace(PRE_RE, '').replace(/^\/+/, '');
  return id === 'root' ? 'root' : id;
}
function isGooglePath(p) { return PRE_RE.test(String(p || '')); }
/** Номер диска Google из пути: 1, если номера нет. */
function slotOf(p) {
  const m = PRE_RE.exec(String(p || ''));
  const n = m && m[1].length > 6 ? Number(m[1].slice(6)) : 1;
  return Number.isInteger(n) && n > 0 ? n : 1;
}

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
const gdocs = require('./gdocs.js');   // pkg3-131: документы Google

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
  // pkg3-132 (поломка 130–131): раньше здесь стояло `pageToken: … || undefined`.
  // В параметрах запроса undefined превращается в СТРОКУ «undefined», и к Google
  // уходил pageToken=undefined — живой Google отвечал 400 «Invalid Value», и
  // диск не открывался вовсе. Теперь параметр добавляется только когда он есть.
  if (o.pageToken) q.set('pageToken', String(o.pageToken));
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
        // pkg3-131: у «документов Google» файла нет — их открывают в окне экспортом
        gdoc: dir ? '' : gdocs.kindOf(mime),
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
        // pkg3-129: родитель остаётся на ТОМ ЖЕ диске (google2:/…), иначе «↑»
        // уводил бы на первый Google-диск
        const head = (PRE_RE.exec(p) || ['google:'])[0];
        if (par) parent = head + '/' + par;
      }
    } catch (e) { parent = ''; }
  }
  return {
    path: p, items, limit: pageSize, offset: 0, total: items.length, parent, name: folderName,
    // pkg3-130: «дальше» — для обхода всей папки в архив (у Google нет offset)
    nextPageToken: String(r.json.nextPageToken || '')
  };
}

/** Все аудиофайлы Диска (для панели «🅖 Google Диск» в «Моей музыке»).
 * pkg3-127: ищем по типу, как это делает Яндекс, — папки не обходим. */
async function listAudio(token, o = {}, c) {
  const conf = c || cfg();
  const limit = Math.min(200, Math.max(1, Number(o.limit) || 200));
  const q = new URLSearchParams({
    q: "mimeType contains 'audio/' and trashed = false",
    fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime)',
    pageSize: String(limit),
    orderBy: 'name',
    includeItemsFromAllDrives: 'true',
    supportsAllDrives: 'true'
  });
  if (o.pageToken) q.set('pageToken', String(o.pageToken).slice(0, 2048));
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
  return { items, limit, offset: 0, nextPageToken: String(r.json.nextPageToken || ''), more: !!r.json.nextPageToken };
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
    gdoc: dir ? '' : gdocs.kindOf(x.mimeType),
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
/**
 * pkg3-131: экспорт «документа Google» (Docs → HTML, Sheets → CSV, Slides → текст).
 * Файла у таких документов нет, поэтому единственный способ показать их —
 * попросить у Google готовый вид. Читаем потоком и обрываем на потолке, чтобы
 * огромный документ не съел память VPS.
 */
const EXPORT_CAP = 4 * 1024 * 1024;
/**
 * pkg3-145: Google отдаёт «Документ Google» в формате HTML УПАКОВАННЫМ в ZIP
 * (внутри html и картинки). Раньше байты архива читались как текст — на экране
 * получались «иероглифы» (жалоба владельца). Здесь архив распаковывается
 * встроенным zlib, без новых зависимостей.
 */
function unzipFirstEntry(buf) {
  try {
    const zlib = require('node:zlib');
    let eocd = -1;
    const from = Math.max(0, buf.length - 66000);
    for (let i = buf.length - 22; i >= from; i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return null;
    const count = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16);
    const entries = [];
    for (let n = 0; n < count && p >= 0 && p + 46 <= buf.length; n++) {
      if (buf.readUInt32LE(p) !== 0x02014b50) break;
      const method = buf.readUInt16LE(p + 10);
      const csize = buf.readUInt32LE(p + 20);
      const usize = buf.readUInt32LE(p + 24);
      const nlen = buf.readUInt16LE(p + 28);
      const elen = buf.readUInt16LE(p + 30);
      const clen = buf.readUInt16LE(p + 32);
      const lho = buf.readUInt32LE(p + 42);
      const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
      entries.push({ name, method, csize, usize, lho });
      p += 46 + nlen + elen + clen;
    }
    if (!entries.length) return null;
    const file = entries.find(x => /\.html?$/i.test(x.name)) || entries.find(x => !/\/$/.test(x.name));
    if (!file || file.usize > 16 * 1024 * 1024 || file.lho + 30 > buf.length) return null;
    const nl = buf.readUInt16LE(file.lho + 26);
    const el = buf.readUInt16LE(file.lho + 28);
    const start = file.lho + 30 + nl + el;
    if (start > buf.length) return null;
    const data = buf.slice(start, start + (file.csize || buf.length - start));
    if (file.method === 0) return data;
    if (file.method === 8) return zlib.inflateRawSync(data, { maxOutputLength: 16 * 1024 * 1024 });
    return null;
  } catch (e) { return null; }
}
/** Экспорт → текст. Архив распаковываем, обычный текст отдаём как есть. */
function decodeExport(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || '');
  const zipped = b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
  if (zipped) {
    const inner = unzipFirstEntry(b);
    if (inner) return { text: inner.toString('utf8').replace(/^\uFEFF/, ''), zipped, unzipped: true };
    return { text: '', zipped, unzipped: false };
  }
  return { text: b.toString('utf8').replace(/^\uFEFF/, ''), zipped, unzipped: false };
}

async function exportFile(token, googlePath, mimeType, c) {
  const conf = c || cfg();
  const id = idOf(googlePath);
  if (!id || id === 'root') { const e = new Error('Неверный путь к документу Google'); e.status = 400; throw e; }
  const url = conf.apiBase + '/drive/v3/files/' + encodeURIComponent(id) + '/export?mimeType=' + encodeURIComponent(mimeType);
  let r;
  try {
    r = await fetch(url, { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(25000) });
  } catch (e) {
    const err = new Error('Google не ответил на экспорт документа — попробуйте ещё раз');
    err.status = 502;
    throw err;
  }
  if (r.status !== 200) {
    let j = null;
    try { j = await r.json(); } catch (e) { j = null; }
    const err = new Error(googleErrorText({ status: r.status, json: j }));
    err.status = r.status;
    throw err;
  }
  const chunks = [];
  let total = 0;
  let truncated = false;
  try {
    const reader = r.body && r.body.getReader ? r.body.getReader() : null;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > EXPORT_CAP) {
          truncated = true;
          const over = total - EXPORT_CAP;
          chunks.push(Buffer.from(value).slice(0, Math.max(0, value.length - over)));
          try { await reader.cancel(); } catch (e) { /* уже закрыт */ }
          break;
        }
        chunks.push(Buffer.from(value));
      }
    } else {
      const buf = Buffer.from(await r.arrayBuffer());
      total = buf.length;
      truncated = total > EXPORT_CAP;
      chunks.push(buf.slice(0, EXPORT_CAP));
    }
  } catch (e) {
    const err = new Error('Документ оборвался при чтении — попробуйте ещё раз');
    err.status = 502;
    throw err;
  }
  // pkg3-145: не «читать байты как текст», а распаковать, если это архив.
  // Если документ был обрезан по размеру (truncated) и распаковать не вышло —
  // честно говорим об этом вызывающему коду, чтобы человек увидел объяснение,
  // а не мусор на экране.
  // обрезанный по размеру документ не выбрасываем: обычный HTML показываем
  // началом (как и раньше), а обрезанный архив честно не распакуется — тогда
  // /api/gdrive/doc скажет «нажмите „Открыть в Google“»
  const decoded = decodeExport(Buffer.concat(chunks));
  return { text: decoded.text, bytes: total, truncated, mime: mimeType, zipped: !!decoded.zipped, unzipped: !!decoded.unzipped };
}

function mediaUrl(googlePath, c) {
  const conf = c || cfg();
  const id = idOf(googlePath);
  if (!id || id === 'root') { const e = new Error('Неверный путь к файлу на Google Диске'); e.status = 400; throw e; }
  return conf.apiBase + '/drive/v3/files/' + encodeURIComponent(id) + '?alt=media&supportsAllDrives=true';
}

/** pkg3-128: имя файла или папки, приведённое к безопасному виду.
 * Косые черты и управляющие знаки не пропускаем, точку в начале убираем. */
function cellName(raw) {
  let s = String(raw == null ? '' : raw)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\/\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  s = s.replace(/^\.+/, '').trim().slice(0, 150).trim();
  return s;
}

/** Путь НОВОГО файла или папки: `google:/<id родителя>/<имя>`.
 * У Google пути строкой нет, поэтому для «создать» имя едет прямо в пути:
 * это единственный вид пути с косой чертой, который принимает сервер. */
function newItemPath(p) {
  const s = String(p || '');
  const m0 = PRE_RE.exec(s);
  if (!m0) return null;
  const head = m0[1];
  const rest = s.slice(m0[0].length).replace(/^\/+/, '').replace(/\/+$/, '');
  const parts = rest.split('/');
  // ровно два куска: «родитель» и «имя». Лишняя косая черта — не имя, а ошибка:
  // иначе человек напишет «папка/внутри» и получит не то, что ждал.
  if (parts.length !== 2) return null;
  const parentId = parts[0];
  if (!/^[A-Za-z0-9_-]{2,200}$/.test(parentId)) return null;
  const name = cellName(parts[1]);
  if (!name) return null;
  return { parent: head + ':/' + parentId, parentId, name };
}

/** Создать папку внутри `google:/<id родителя>/<имя>`. */
async function mkdir(token, googlePath, c) {
  const conf = c || cfg();
  const np = newItemPath(googlePath);
  if (!np) { const e = new Error('Неверное имя папки: название без косой черты'); e.status = 400; throw e; }
  const q = new URLSearchParams({ supportsAllDrives: 'true', fields: 'id,name' });
  const r = await httpJSON(conf.apiBase + '/drive/v3/files?' + q.toString(), {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
    json: { name: np.name, mimeType: FOLDER_MIME, parents: [np.parentId] }
  });
  if ((r.status !== 200 && r.status !== 201) || !r.json || !r.json.id) {
    const e = new Error(googleErrorText(r)); e.status = r.status; throw e;
  }
  return { path: 'google:/' + r.json.id, name: String(r.json.name || np.name), dir: true };
}

/** Переименовать файл или папку (путь существующего предмета). */
async function renameFile(token, googlePath, newName, c) {
  const conf = c || cfg();
  const id = idOf(googlePath);
  if (!id || id === 'root') { const e = new Error('Неверный путь к файлу на Google Диске'); e.status = 400; throw e; }
  const name = cellName(newName);
  if (!name) { const e = new Error('Неверное имя: название без косой черты'); e.status = 400; throw e; }
  const q = new URLSearchParams({ supportsAllDrives: 'true', fields: 'id,name' });
  const r = await httpJSON(conf.apiBase + '/drive/v3/files/' + encodeURIComponent(id) + '?' + q.toString(), {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
    json: { name }
  });
  if (r.status !== 200 || !r.json) { const e = new Error(googleErrorText(r)); e.status = r.status; throw e; }
  return { path: 'google:/' + id, name: String(r.json.name || name) };
}

/** Убрать файл или папку в корзину Google (навсегда не удаляем — вернуть можно). */
async function trashPath(token, googlePath, c) {
  const conf = c || cfg();
  const id = idOf(googlePath);
  if (!id || id === 'root') { const e = new Error('Неверный путь к файлу на Google Диске'); e.status = 400; throw e; }
  const q = new URLSearchParams({ supportsAllDrives: 'true', fields: 'id,name,trashed' });
  const r = await httpJSON(conf.apiBase + '/drive/v3/files/' + encodeURIComponent(id) + '?' + q.toString(), {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
    json: { trashed: true }
  });
  if (r.status !== 200 || !r.json) { const e = new Error(googleErrorText(r)); e.status = r.status; throw e; }
  return { ok: true, path: 'google:/' + id };
}

/** Адрес загрузки: сервер ОТКРЫВАЕТ сеанс у Google, а файл идёт с устройства
 * ПРЯМО в Google по этому адресу. VPS не тратит ни память, ни трафик — так же,
 * как у Яндекса. Адрес живёт до окончания загрузки и привязан к одному файлу. */
async function uploadSession(token, googlePath, o = {}, c) {
  const conf = c || cfg();
  const np = newItemPath(googlePath);
  if (!np) { const e = new Error('Неверное имя файла: название без косой черты'); e.status = 400; throw e; }
  const mime = String(o.mime || 'application/octet-stream').slice(0, 120) || 'application/octet-stream';
  const size = Math.max(0, Number(o.size) || 0);
  const headers = {
    Authorization: 'Bearer ' + token,
    Accept: 'application/json',
    'X-Upload-Content-Type': mime
  };
  if (size) headers['X-Upload-Content-Length'] = String(size);
  const q = new URLSearchParams({ uploadType: 'resumable', supportsAllDrives: 'true', fields: 'id,name,size,mimeType' });
  const r = await httpJSON(conf.apiBase + '/upload/drive/v3/files?' + q.toString(), {
    method: 'POST', headers,
    json: { name: np.name, mimeType: mime, parents: [np.parentId] }
  });
  const loc = String((r.headers && (r.headers.location || r.headers.Location)) || '');
  if ((r.status !== 200 && r.status !== 201) || !loc) { const e = new Error(googleErrorText(r)); e.status = r.status || 502; throw e; }
  if (!/^https?:\/\//i.test(loc)) { const e = new Error('Google вернул неверный адрес загрузки'); e.status = 502; throw e; }
  return { url: loc, method: 'PUT', name: np.name, mime, size };
}

/** pkg3-154: обновление существующего файла Google потоком байтов.
 * Сеанс resumable открывает сервер, а сам файл помощник отправляет ПРЯМО в
 * Google по адресу из Location — без токена владельца в помощнике. */
async function updateSession(token, googlePath, o = {}, c) {
  const conf = c || cfg();
  const id = idOf(googlePath);
  if (!id || id === 'root') { const e = new Error('Неверный путь к файлу Google'); e.status = 400; throw e; }
  const mime = String(o.mime || 'application/octet-stream').slice(0, 120) || 'application/octet-stream';
  const size = Math.max(0, Number(o.size) || 0);
  const headers = { Authorization: 'Bearer ' + token, Accept: 'application/json', 'X-Upload-Content-Type': mime };
  if (size) headers['X-Upload-Content-Length'] = String(size);
  const q = new URLSearchParams({ uploadType: 'resumable', supportsAllDrives: 'true', fields: 'id,name,size,mimeType' });
  const r = await httpJSON(conf.apiBase + '/upload/drive/v3/files/' + encodeURIComponent(id) + '?' + q.toString(), {
    method: 'PATCH', headers, json: {}
  });
  const loc = String((r.headers && (r.headers.location || r.headers.Location)) || '');
  if ((r.status !== 200 && r.status !== 201) || !loc) { const e = new Error(googleErrorText(r)); e.status = r.status || 502; throw e; }
  if (!/^https?:\/\//i.test(loc)) { const e = new Error('Google вернул неверный адрес загрузки'); e.status = 502; throw e; }
  return { url: loc, method: 'PUT', mime, size };
}

module.exports = { decodeExport, unzipFirstEntry, 
  cfg, loadKeys, KEYS_HINT, tokenKey, sealToken, openToken, httpJSON,
  buildAuthUrl, exchangeCode, refreshTokens,
  safePath, idOf, isGooglePath, slotOf, pathOf: p => 'google:/' + idOf(p),
  aboutSpace, listFolder, listAudio, fileMeta, parentsOf, mediaOf, mediaUrl, safeGoogleUrl, exportFile, EXPORT_CAP,
  googleErrorText, FOLDER_MIME, PREFIX,
  SCOPE, SCOPE_READONLY, scopeWrite, cellName, newItemPath,
  mkdir, renameFile, trashPath, uploadSession, updateSession
};
