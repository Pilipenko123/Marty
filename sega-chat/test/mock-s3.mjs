/**
 * Заглушка Yandex Object Storage для проверок без облака.
 *
 * Повторяет ровно то, чем пользуется мессенджер:
 *   PUT/GET/HEAD/DELETE объекта и список (ListObjectsV2) с префиксом.
 * Авторизация — как в настоящем хранилище: заголовок «Authorization: Bearer …».
 * Без токена или с чужим токеном отвечает 403 AccessDenied.
 *
 * Список отдаёт маленькими страницами нарочно — чтобы проверка ловила
 * ошибки дочитывания.
 */

import http from 'node:http';

const PAGE = 5;

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function startMockS3(opts = {}) {
  const bucket = opts.bucket || 'test-bucket';
  const token = opts.token || 'test-iam-token';
  const objects = new Map();          // key -> { body, contentType, lastModified }
  const counters = { calls: 0, byMethod: {}, puts: 0, gets: 0, deletes: 0, lists: 0 };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      counters.calls++;
      counters.byMethod[req.method] = (counters.byMethod[req.method] || 0) + 1;

      const xmlError = (code, message, status) => {
        const t = '<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>' + esc(code)
          + '</Code><Message>' + esc(message) + '</Message></Error>';
        res.writeHead(status, { 'Content-Type': 'application/xml', 'Content-Length': Buffer.byteLength(t) });
        res.end(t);
      };
      const xml = (t, status = 200, headers = {}) => {
        res.writeHead(status, Object.assign({ 'Content-Type': 'application/xml', 'Content-Length': Buffer.byteLength(t) }, headers));
        res.end(t);
      };

      // --- авторизация: только Bearer, как в настоящем Object Storage
      const auth = String(req.headers['authorization'] || '');
      if (!auth.startsWith('Bearer ')) return xmlError('AccessDenied', 'нет токена', 403);
      if (auth.slice(7).trim() !== token) return xmlError('AccessDenied', 'чужой токен', 403);

      const u = new URL(req.url, 'http://x');
      const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (!parts.length || parts[0] !== bucket) return xmlError('NoSuchBucket', 'нет такого бакета', 404);
      const key = parts.slice(1).join('/');

      // --- список объектов
      if (req.method === 'GET' && !key) {
        counters.lists++;
        if (u.searchParams.get('list-type') !== '2') return xmlError('NotImplemented', 'ждём list-type=2', 501);
        const prefix = u.searchParams.get('prefix') || '';
        const from = Number(u.searchParams.get('continuation-token')) || 0;
        const maxKeys = Number(u.searchParams.get('max-keys')) || PAGE;
        let keys = [...objects.keys()].filter(k => k.startsWith(prefix)).sort();
        const page = keys.slice(from, from + Math.min(maxKeys, PAGE));
        const next = from + page.length < keys.length ? String(from + page.length) : null;
        const contents = page.map(k => {
          const o = objects.get(k);
          return '<Contents><Key>' + esc(k) + '</Key><LastModified>' + o.lastModified + '</LastModified>'
            + '<Size>' + o.body.length + '</Size><StorageClass>STANDARD</StorageClass></Contents>';
        }).join('');
        return xml('<?xml version="1.0" encoding="UTF-8"?>\n<ListBucketResult>'
          + '<Name>' + esc(bucket) + '</Name><Prefix>' + esc(prefix) + '</Prefix>'
          + '<KeyCount>' + page.length + '</KeyCount><MaxKeys>' + maxKeys + '</MaxKeys>'
          + '<IsTruncated>' + (next ? 'true' : 'false') + '</IsTruncated>'
          + (next ? '<NextContinuationToken>' + esc(next) + '</NextContinuationToken>' : '')
          + contents + '</ListBucketResult>');
      }

      if (req.method === 'PUT') {
        // серверная копия объекта (x-amz-copy-source)
        const src = req.headers['x-amz-copy-source'];
        if (src) {
          const from = decodeURIComponent(String(src).replace(/^\/?[^/]+\//, ''));
          if (!objects.has(from)) return xmlError('NoSuchKey', 'нет исходного объекта', 404);
          const o = objects.get(from);
          objects.set(key, { body: Buffer.from(o.body), contentType: o.contentType, lastModified: new Date().toISOString() });
          counters.puts++;
          return xml('<?xml version="1.0" encoding="UTF-8"?>\n<CopyObjectResult><LastModified>'
            + objects.get(key).lastModified + '</LastModified><ETag>"copy"</ETag></CopyObjectResult>');
        }
        objects.set(key, {
          body, contentType: req.headers['content-type'] || 'application/octet-stream',
          lastModified: new Date().toISOString()
        });
        counters.puts++;
        res.writeHead(200, { ETag: '"mock"' });
        return res.end();
      }

      if (req.method === 'GET') {
        counters.gets++;
        const o = objects.get(key);
        if (!o) return xmlError('NoSuchKey', 'нет такого объекта', 404);
        res.writeHead(200, {
          'Content-Type': o.contentType, 'Content-Length': o.body.length,
          'Last-Modified': o.lastModified, ETag: '"mock"'
        });
        return res.end(o.body);
      }

      if (req.method === 'HEAD') {
        const o = objects.get(key);
        if (!o) { res.writeHead(404); return res.end(); }
        res.writeHead(200, {
          'Content-Type': o.contentType, 'Content-Length': o.body.length,
          'Last-Modified': o.lastModified
        });
        return res.end();
      }

      if (req.method === 'DELETE') {
        counters.deletes++;
        objects.delete(key);
        res.writeHead(204);
        return res.end();
      }

      return xmlError('MethodNotAllowed', 'заглушка не умеет ' + req.method, 405);
    });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        endpoint: `http://127.0.0.1:${port}`,
        bucket, token, objects, counters,
        close: () => new Promise(r => server.close(r))
      });
    });
  });
}
