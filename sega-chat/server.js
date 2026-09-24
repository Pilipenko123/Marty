#!/usr/bin/env node
/**
 * SEGA-CHAT — запуск мессенджера на своём компьютере.
 * Без внешних зависимостей: нужен только Node.js 18 или новее.
 *
 * Обычный запуск (данные в папке data):        node server.js
 * С шифрованием канала для телефона:           HTTPS=1 node server.js
 * С хранением в облачной базе Yandex Cloud:    STORE=ydb YDB_ENDPOINT=… node server.js
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const { createApi } = require('./lib/api');
const { serveStatic, splitBase } = require('./lib/static');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const MAX_BODY = 12 * 1024 * 1024;

const store = String(process.env.STORE || 'file').toLowerCase() === 'ydb'
  ? require('./lib/store-ydb').createYdbStore()
  : require('./lib/store-file').createFileStore({ dataDir: DATA_DIR });

const app = createApi(store);

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('too-large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('bad-json')); }
    });
    req.on('error', reject);
  });
}

function send(res, out) {
  const headers = Object.assign({ 'Cache-Control': 'no-store' }, out.headers || {});
  let body = out.body;
  if (body === undefined) {
    body = Buffer.from(JSON.stringify(out.json === undefined ? {} : out.json));
    headers['Content-Type'] = 'application/json; charset=utf-8';
  }
  headers['Content-Length'] = body.length;
  res.writeHead(out.status || 200, headers);
  res.end(body);
}

const handler = async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const { base, path: pathname } = splitBase(url.pathname);
  try {
    if (pathname.startsWith('/api/')) {
      const body = (req.method === 'POST' || req.method === 'PUT') ? await readBody(req) : {};
      const out = await app.handle({
        method: req.method, path: pathname, query: url.searchParams,
        headers: req.headers, body,
        ip: (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim()
      });
      send(res, out);
    } else {
      send(res, serveStatic(pathname, base));
    }
  } catch (e) {
    if (!res.headersSent) {
      const msg = e.message === 'too-large' ? 'Файл слишком большой'
        : (e.message === 'bad-json' ? 'Некорректный запрос' : 'Ошибка сервера');
      send(res, { status: e.message === 'too-large' ? 413 : 500, json: { error: msg } });
    }
    if (!['too-large', 'bad-json'].includes(e.message)) console.error(e);
  }
};

// Необязательный HTTPS: нужен, чтобы чат открывался с телефона по локальной сети
// (браузеры дают доступ к шифрованию только на https или на localhost).
function httpsOptions() {
  if (process.env.HTTPS !== '1') return null;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const key = path.join(DATA_DIR, 'key.pem'), cert = path.join(DATA_DIR, 'cert.pem');
  if (!fs.existsSync(key) || !fs.existsSync(cert)) {
    console.log('  Создаю самоподписанный сертификат…');
    const { execFileSync } = require('child_process');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3650',
      '-keyout', key, '-out', cert, '-subj', '/CN=sega-chat'], { stdio: 'ignore' });
  }
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

(async () => {
  await store.open();
  const db = await store.load();

  let tls = null;
  try { tls = httpsOptions(); } catch (e) { console.error('Не удалось включить HTTPS (нужен openssl):', e.message); }
  const server = tls ? require('https').createServer(tls, handler) : http.createServer(handler);
  const scheme = tls ? 'https' : 'http';

  const bye = async () => { try { await store.close(); } catch (e) {} process.exit(0); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);

  server.listen(PORT, HOST, () => {
    const nets = require('os').networkInterfaces();
    const lan = Object.values(nets).flat().filter(n => n && n.family === 'IPv4' && !n.internal).map(n => n.address);
    const limit = app.config.STORAGE_LIMIT;
    const used = db.stats.bytes + db.users.reduce((a, u) => a + (u.avatarLen || 0), 0);
    console.log('');
    console.log('  ╔════════════════════════════════╗');
    console.log('  ║        S E G A - C H A T       ║');
    console.log('  ╚════════════════════════════════╝');
    console.log('');
    console.log('  Мессенджер запущен. Открывайте в браузере:');
    console.log('    • на этом компьютере: ' + scheme + '://localhost:' + PORT);
    lan.forEach(a => console.log('    • в этой Wi-Fi сети:  ' + scheme + '://' + a + ':' + PORT));
    if (!tls) console.log('      (с телефона по сети — запустите с HTTPS=1, см. README)');
    console.log('');
    console.log('  Память: лимит ' + (limit / 1024 / 1024).toFixed(0) + ' МБ, занято '
      + (used / 1024 / 1024).toFixed(2) + ' МБ · чатов: ' + db.chats.length);
    console.log('  Хранилище: ' + (store.name === 'ydb' ? 'Yandex Database (' + store.table + ')' : store.dbFile));
    console.log('  Остановить: Ctrl + C');
    console.log('');
  });
})();
