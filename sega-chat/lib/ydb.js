'use strict';
/**
 * Крошечный клиент Yandex Database (режим Document API, совместимый с DynamoDB).
 * Никаких внешних библиотек — только http/https/crypto из Node.js.
 *
 * Авторизация — любым из трёх способов:
 *   1) IAM-токен из переменной YDB_IAM_TOKEN или из окружения облачной функции;
 *   2) сервис метаданных (внутри Cloud Functions / контейнера / виртуальной машины);
 *   3) статические ключи сервисного аккаунта (подпись AWS Signature V4) —
 *      удобно, чтобы подключиться к облачной базе с домашнего компьютера.
 */

const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

const SERVICE = 'dynamodb';
const TARGET_PREFIX = 'DynamoDB_20120810.';

const sha256 = (x) => crypto.createHash('sha256').update(x).digest('hex');
const hmac = (key, x) => crypto.createHmac('sha256', key).update(x).digest();

class YdbError extends Error {
  constructor(type, message, status) {
    super(message || type);
    this.type = String(type || '').split('#').pop();
    this.status = status;
  }
  get conditionFailed() { return this.type === 'ConditionalCheckFailedException'; }
  get notFound() { return this.type === 'ResourceNotFoundException'; }
}

class Ydb {
  /**
   * @param {object} o
   * @param {string} o.endpoint  адрес Document API базы
   * @param {string} [o.iamToken] готовый IAM-токен
   * @param {string} [o.accessKeyId] / [o.secretAccessKey] статические ключи
   * @param {string} [o.region] по умолчанию ru-central1
   */
  constructor(o = {}) {
    this.endpoint = String(o.endpoint || process.env.YDB_ENDPOINT || '').replace(/\/+$/, '');
    if (!this.endpoint) throw new Error('Не задан адрес базы (YDB_ENDPOINT)');
    this.url = new URL(this.endpoint);
    this.region = o.region || process.env.YDB_REGION || 'ru-central1';
    this.accessKeyId = o.accessKeyId || process.env.YDB_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID || null;
    this.secretAccessKey = o.secretAccessKey || process.env.YDB_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY || null;
    this._token = o.iamToken || process.env.YDB_IAM_TOKEN || null;
    this._tokenExp = this._token ? Infinity : 0;
    this.timeout = Number(o.timeout || 15000);
    this.insecure = this.url.protocol === 'http:';
  }

  setToken(token, expiresInSec) {
    this._token = token || null;
    this._tokenExp = token ? Date.now() + (Number(expiresInSec || 3600) - 60) * 1000 : 0;
  }

  /** IAM-токен из сервиса метаданных — работает внутри облака без ключей. */
  async metadataToken() {
    if (this._token && Date.now() < this._tokenExp) return this._token;
    const body = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '169.254.169.254', path: '/computeMetadata/v1/instance/service-accounts/default/token',
        headers: { 'Metadata-Flavor': 'Google' }, timeout: 4000
      }, res => {
        const c = []; res.on('data', d => c.push(d));
        res.on('end', () => res.statusCode === 200 ? resolve(Buffer.concat(c).toString()) : reject(new Error('метаданные: HTTP ' + res.statusCode)));
      });
      req.on('timeout', () => req.destroy(new Error('метаданные недоступны')));
      req.on('error', reject);
      req.end();
    });
    const t = JSON.parse(body);
    this.setToken(t.access_token, t.expires_in);
    return this._token;
  }

  async authHeaders(payload, amzTarget) {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:\-]|\.\d{3}/g, '');   // 20240101T101010Z
    const dateStamp = amzDate.slice(0, 8);
    const headers = {
      'content-type': 'application/x-amz-json-1.0',
      'host': this.url.host,
      'x-amz-date': amzDate,
      'x-amz-target': TARGET_PREFIX + amzTarget
    };

    if (this.accessKeyId && this.secretAccessKey) {
      const canonicalHeaders = Object.keys(headers).sort().map(k => k + ':' + headers[k] + '\n').join('');
      const signedHeaders = Object.keys(headers).sort().join(';');
      const canonicalRequest = ['POST', this.url.pathname, '', canonicalHeaders, signedHeaders, sha256(payload)].join('\n');
      const scope = `${dateStamp}/${this.region}/${SERVICE}/aws4_request`;
      const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
      let k = hmac('AWS4' + this.secretAccessKey, dateStamp);
      k = hmac(k, this.region); k = hmac(k, SERVICE); k = hmac(k, 'aws4_request');
      const signature = crypto.createHmac('sha256', k).update(toSign).digest('hex');
      headers['authorization'] = `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${scope}, `
        + `SignedHeaders=${signedHeaders}, Signature=${signature}`;
    } else {
      const token = (this._token && Date.now() < this._tokenExp) ? this._token : await this.metadataToken();
      headers['authorization'] = 'Bearer ' + token;
    }
    return headers;
  }

  async call(action, body, attempt = 0) {
    const payload = JSON.stringify(body);
    const headers = await this.authHeaders(payload, action);
    headers['content-length'] = Buffer.byteLength(payload);

    let res;
    try {
      res = await this._send(payload, headers);
    } catch (e) {
      if (attempt < 2) return this.call(action, body, attempt + 1);
      throw e;
    }
    if (res.status >= 200 && res.status < 300) return res.text ? JSON.parse(res.text) : {};

    let type = 'HttpError', message = res.text && res.text.slice(0, 300);
    try { const j = JSON.parse(res.text); type = j.__type || j.code || type; message = j.message || j.Message || message; } catch (e) {}
    const err = new YdbError(type, message, res.status);
    const retryable = res.status >= 500 || err.type === 'ThrottlingException'
      || err.type === 'ProvisionedThroughputExceededException' || err.type === 'RequestLimitExceeded';
    if (retryable && attempt < 3) {
      await new Promise(r => setTimeout(r, 120 * Math.pow(2, attempt)));
      return this.call(action, body, attempt + 1);
    }
    throw err;
  }

  _send(payload, headers) {
    return new Promise((resolve, reject) => {
      const mod = this.insecure ? http : https;
      const req = mod.request({
        protocol: this.url.protocol, host: this.url.hostname,
        port: this.url.port || (this.insecure ? 80 : 443),
        path: this.url.pathname + this.url.search, method: 'POST', headers, timeout: this.timeout
      }, res => {
        const c = [];
        res.on('data', d => c.push(d));
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(c).toString('utf8') }));
      });
      req.on('timeout', () => req.destroy(new Error('база не отвечает')));
      req.on('error', reject);
      req.end(payload);
    });
  }

  // ------------------------------------------------------------ сахар
  put(TableName, Item, extra) { return this.call('PutItem', Object.assign({ TableName, Item }, extra)); }
  get(TableName, Key, extra) { return this.call('GetItem', Object.assign({ TableName, Key, ConsistentRead: true }, extra)); }
  del(TableName, Key, extra) { return this.call('DeleteItem', Object.assign({ TableName, Key }, extra)); }
  update(TableName, Key, extra) { return this.call('UpdateItem', Object.assign({ TableName, Key }, extra)); }

  /** Query со сквозной постраничной выборкой. */
  async queryAll(TableName, params) {
    const out = [];
    let start = null;
    do {
      const r = await this.call('Query', Object.assign({ TableName, ConsistentRead: true }, params,
        start ? { ExclusiveStartKey: start } : {}));
      for (const it of (r.Items || [])) out.push(it);
      start = r.LastEvaluatedKey && Object.keys(r.LastEvaluatedKey).length ? r.LastEvaluatedKey : null;
    } while (start);
    return out;
  }

  async ensureTable(name) {
    try {
      const d = await this.call('DescribeTable', { TableName: name });
      if (((d.Table || {}).TableStatus || 'ACTIVE') === 'ACTIVE') return false;
    } catch (e) {
      if (!(e instanceof YdbError) || !e.notFound) throw e;
    }
    try {
      await this.call('CreateTable', {
        TableName: name,
        AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }, { AttributeName: 'sk', AttributeType: 'S' }],
        KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }],
        BillingMode: 'PAY_PER_REQUEST'
      });
    } catch (e) {
      // таблицу мог создать соседний экземпляр функции — это нормально
      if (!(e instanceof YdbError) || (e.type !== 'ResourceInUseException' && e.type !== 'TableAlreadyExistsException')) throw e;
    }
    for (let i = 0; i < 30; i++) {
      try {
        const d = await this.call('DescribeTable', { TableName: name });
        if (((d.Table || {}).TableStatus || 'ACTIVE') === 'ACTIVE') return true;
      } catch (e) { if (!(e instanceof YdbError) || !e.notFound) throw e; }
      await new Promise(r => setTimeout(r, 500));
    }
    throw new Error('таблица ' + name + ' так и не появилась');
  }
}

// значения AttributeValue <-> JS
const S = (v) => ({ S: String(v) });
const N = (v) => ({ N: String(v) });
const str = (a) => (a && a.S !== undefined) ? a.S : null;
const num = (a) => (a && a.N !== undefined) ? Number(a.N) : 0;

module.exports = { Ydb, YdbError, S, N, str, num };
