'use strict';
/**
 * IAM-токен сервисного аккаунта из сервиса метаданных.
 *
 * Внутри Yandex Cloud (функция, контейнер, виртуальная машина) по адресу
 * 169.254.169.254 живёт «справочная» служба: она выдаёт короткий-lived токен
 * той учётной записи, от имени которой работает программа. Токен действует
 * около 12 часов, поэтому здесь он кэшируется и обновляется заранее.
 *
 * Токен можно задать и вручную — переменная YC_IAM_TOKEN (пригодится для
 * проверки с домашнего компьютера).
 *
 * Никаких внешних библиотек: только http/crypto из Node.js.
 */

const http = require('http');

const META_HOST = process.env.YC_METADATA_HOST || '169.254.169.254';
const META_PATH = '/computeMetadata/v1/instance/service-accounts/default/token';

let cached = null;      // сам токен
let cachedExp = 0;      // до какого момента (мс) он действителен

function reset() { cached = null; cachedExp = 0; }

/** Достать IAM-токен. Бросает ошибку, если метаданные недоступны. */
async function iamToken(opts = {}) {
  const forced = opts.token || process.env.YC_IAM_TOKEN || null;
  if (forced) return forced;
  if (cached && Date.now() < cachedExp) return cached;

  const timeout = Number(opts.timeout || 4000);
  const body = await new Promise((resolve, reject) => {
    const req = http.request({
      host: META_HOST, path: META_PATH,
      headers: { 'Metadata-Flavor': 'Google' }, timeout
    }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode === 200) resolve(text);
        else reject(new Error('сервис метаданных ответил HTTP ' + res.statusCode));
      });
    });
    req.on('timeout', () => req.destroy(new Error('сервис метаданных не отвечает')));
    req.on('error', () => reject(new Error('сервис метаданных недоступен (работает только внутри Yandex Cloud)')));
    req.end();
  });

  let parsed;
  try { parsed = JSON.parse(body); } catch (e) { throw new Error('сервис метаданных вернул не JSON'); }
  if (!parsed || !parsed.access_token) throw new Error('сервис метаданных не выдал токен');
  cached = parsed.access_token;
  // обновляем на минуту раньше срока, чтобы не поймать просрочку на середине запроса
  cachedExp = Date.now() + (Math.max(60, Number(parsed.expires_in) || 3600) - 60) * 1000;
  return cached;
}

module.exports = { iamToken, reset };
