'use strict';
/**
 * Крошечный клиент Yandex Object Storage (облачное хранилище).
 *
 * Зачем он нужен: программа мессенджера и её резервные копии живут в одном
 * облаке, в приватном бакете. Функция кладёт туда копии сама, без участия
 * человека.
 *
 * Авторизация — IAM-токеном сервисного аккаунта (заголовок
 * «Authorization: Bearer …»). Это официальный рекомендуемый способ Yandex
 * Object Storage: в отличие от статических ключей, он не требует подписывать
 * запросы (AWS Signature V4) и не хранит в коде никаких секретов. Токен
 * функция получает из сервиса метаданных — см. lib/iam.js.
 *
 * Никаких внешних библиотек: только http/https из Node.js.
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');
const { iamToken } = require('./iam');

const DEFAULT_ENDPOINT = 'https://storage.yandexcloud.net';

class S3Error extends Error {
  constructor(code, message, status) {
    super(message || code);
    this.code = String(code || 'HttpError');
    this.status = status;
  }
  get notFound() { return this.code === 'NoSuchKey' || this.code === 'NoSuchBucket' || this.status === 404; }
  get denied() { return this.status === 403 || this.code === 'AccessDenied'; }
}

/** Ключ объекта -> безопасный путь в URL (косая черта разделяет «папки»). */
function encodeKey(key) {
  return String(key).split('/').map(encodeURIComponent).join('/');
}

/** Очень маленький разбор XML-ответа ListObjectsV2: нам нужны всего три поля. */
function parseList(xml) {
  const out = [];
  const re = /<Contents>([\s\S]*?)<\/Contents>/g;
  let m;
  while ((m = re.exec(xml))) {
    const chunk = m[1];
    const pick = (tag) => {
      const t = new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>').exec(chunk);
      return t ? t[1] : '';
    };
    out.push({
      key: decodeXml(pick('Key')),
      size: Number(pick('Size')) || 0,
      lastModified: pick('LastModified')
    });
  }
  const trunc = /<IsTruncated>true<\/IsTruncated>/.test(xml);
  const next = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml);
  return { items: out, truncated: trunc, token: next ? decodeXml(next[1]) : null };
}

function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

function errorFrom(status, text) {
  const code = /<Code>([\s\S]*?)<\/Code>/.exec(text || '');
  const msg = /<Message>([\s\S]*?)<\/Message>/.exec(text || '');
  let c = code ? decodeXml(code[1]) : 'HttpError';
  let m = msg ? decodeXml(msg[1]) : ('HTTP ' + status);
  if (!code) {
    // Yandex иногда отвечает JSON (например, при неверном токене)
    try { const j = JSON.parse(text); c = j.code || j.__type || c; m = j.message || m; } catch (e) {}
  }
  return new S3Error(c, m, status);
}

function createS3(opts = {}) {
  const bucket = String(opts.bucket || process.env.S3_BUCKET || process.env.CODE_BUCKET || '');
  const endpoint = String(opts.endpoint || process.env.S3_ENDPOINT || DEFAULT_ENDPOINT).replace(/\/+$/, '');
  const timeout = Number(opts.timeout || 20000);
  const fixedToken = opts.token || null;
  let u = null;
  try { u = new URL(endpoint); } catch (e) { throw new Error('Неверный адрес хранилища: ' + endpoint); }

  if (!bucket) throw new Error('Не задано имя бакета (переменная CODE_BUCKET)');

  function raw(method, path, query, body, headers) {
    return new Promise((resolve, reject) => {
      const qs = query && Object.keys(query).length
        ? '?' + Object.entries(query).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&')
        : '';
      const h = Object.assign({}, headers || {});
      if (body) h['Content-Length'] = Buffer.byteLength(body);
      const mod = u.protocol === 'http:' ? http : https;
      const req = mod.request({
        protocol: u.protocol, host: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443),
        method, path: path + qs, headers: h, timeout
      }, res => {
        const chunks = [];
        res.on('data', d => chunks.push(d));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buffer: Buffer.concat(chunks) }));
      });
      req.on('timeout', () => req.destroy(new Error('хранилище не отвечает')));
      req.on('error', reject);
      req.end(body || undefined);
    });
  }

  async function send(method, path, query, body, headers) {
    const auth = fixedToken || await iamToken({ timeout: 4000 });
    const h = Object.assign({ 'Authorization': 'Bearer ' + auth }, headers || {});
    let res;
    try {
      res = await raw(method, path, query, body, h);
    } catch (e) {
      // одноразовый сетевой сбой — пробуем ещё раз с новым токеном
      const auth2 = fixedToken || await iamToken({ timeout: 4000 });
      res = await raw(method, path, query, body, Object.assign({ 'Authorization': 'Bearer ' + auth2 }, headers || {}));
    }
    return res;
  }

  const url = (key) => '/' + encodeURIComponent(bucket) + (key ? '/' + encodeKey(key) : '');

  const api = {
    bucket, endpoint, S3Error,

    /** Положить объект. body — Buffer или строка. */
    async put(key, body, contentType) {
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body == null ? '' : body));
      const res = await send('PUT', url(key), null, buf, {
        'Content-Type': contentType || 'application/octet-stream'
      });
      if (res.status < 200 || res.status >= 300) throw errorFrom(res.status, res.buffer.toString('utf8'));
      return { key, bytes: buf.length, etag: String(res.headers.etag || '').replace(/"/g, '') };
    },

    /** Прочитать объект целиком. Несуществующий объект -> null. */
    async get(key) {
      const res = await send('GET', url(key), null, null, null);
      if (res.status === 404) return null;
      if (res.status < 200 || res.status >= 300) throw errorFrom(res.status, res.buffer.toString('utf8'));
      return res.buffer;
    },

    /** Прочитать диапазон байт объекта — чтобы выдавать большие копии по кусочкам. */
    async getRange(key, off, len) {
      const res = await send('GET', url(key), null, null, { Range: `bytes=${off}-${off + len - 1}` });
      if (res.status === 404) return null;
      if (res.status !== 206 && res.status !== 200) throw errorFrom(res.status, res.buffer.toString('utf8'));
      return res.buffer;
    },

    /** Только метаданные (размер, дата). Несуществующий -> null. */
    async head(key) {
      const res = await send('HEAD', url(key), null, null, null);
      if (res.status === 404) return null;
      if (res.status < 200 || res.status >= 300) throw errorFrom(res.status, '');
      return {
        key,
        size: Number(res.headers['content-length']) || 0,
        lastModified: res.headers['last-modified'] || null
      };
    },

    async del(key) {
      const res = await send('DELETE', url(key), null, null, null);
      if (res.status === 404) return true;
      if (res.status < 200 || res.status >= 300) throw errorFrom(res.status, res.buffer.toString('utf8'));
      return true;
    },

    /** Скопировать объект внутри бакета (серверная копия, без скачивания). */
    async copy(fromKey, toKey) {
      const res = await send('PUT', url(toKey), null, null, {
        'x-amz-copy-source': '/' + bucket + '/' + encodeKey(fromKey)
      });
      if (res.status < 200 || res.status >= 300) throw errorFrom(res.status, res.buffer.toString('utf8'));
      return { key: toKey };
    },

    /** Список объектов с префиксом; дочитывает страницы сам. */
    async list(prefix, limit) {
      const out = [];
      let token = null;
      do {
        const query = { 'list-type': '2' };
        if (prefix) query.prefix = prefix;
        if (token) query['continuation-token'] = token;
        const res = await send('GET', url(''), query, null, null);
        if (res.status === 404) return out;
        if (res.status < 200 || res.status >= 300) throw errorFrom(res.status, res.buffer.toString('utf8'));
        const page = parseList(res.buffer.toString('utf8'));
        for (const it of page.items) out.push(it);
        token = page.truncated ? page.token : null;
        if (limit && out.length >= limit) return out.slice(0, limit);
      } while (token);
      return out;
    },

    /** Жив ли бакет и есть ли к нему доступ. */
    async ping() {
      const res = await send('GET', url(''), { 'list-type': '2', 'max-keys': '1' }, null, null);
      if (res.status === 404) throw new S3Error('NoSuchBucket', 'бакет «' + bucket + '» не найден', 404);
      if (res.status === 403) throw new S3Error('AccessDenied', 'нет доступа к бакету «' + bucket + '»', 403);
      if (res.status < 200 || res.status >= 300) throw errorFrom(res.status, res.buffer.toString('utf8'));
      return true;
    }
  };
  return api;
}

module.exports = { createS3, S3Error };
