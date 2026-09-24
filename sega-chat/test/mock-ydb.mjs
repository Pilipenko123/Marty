/**
 * Заглушка Yandex Database (Document API) для проверок без облака.
 * Понимает ровно то подмножество, которым пользуется мессенджер, и —
 * что важно — проверяет подпись запроса, как это делает настоящая база.
 */

import http from 'node:http';
import crypto from 'node:crypto';

const sha256 = (x) => crypto.createHash('sha256').update(x).digest('hex');
const hmac = (k, x) => crypto.createHmac('sha256', k).update(x).digest();

export function startMock(opts = {}) {
  const accessKeyId = opts.accessKeyId || 'test-key';
  const secretAccessKey = opts.secretAccessKey || 'test-secret';
  const region = 'ru-central1';
  const basePath = '/ru-central1/b1gtest/etntest';
  const tables = new Map();                // имя -> Map(pk\0sk -> item)
  const counters = { calls: 0, byAction: {}, reads: 0, writes: 0 };

  const keyOf = (item) => item.pk.S + '\u0000' + item.sk.S;

  function checkSignature(req, body) {
    const auth = req.headers['authorization'] || '';
    if (auth.startsWith('Bearer ')) return auth.length > 10 ? null : 'пустой токен';
    const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]+)$/.exec(auth);
    if (!m) return 'нет подписи';
    const [, akid, dateStamp, reg, service, signedHeaders, signature] = m;
    if (akid !== accessKeyId) return 'чужой ключ';
    const canonicalHeaders = signedHeaders.split(';').map(h => h + ':' + (req.headers[h] || '') + '\n').join('');
    const canonicalRequest = ['POST', req.url.split('?')[0], '', canonicalHeaders, signedHeaders, sha256(body)].join('\n');
    const scope = `${dateStamp}/${reg}/${service}/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', req.headers['x-amz-date'], scope, sha256(canonicalRequest)].join('\n');
    let k = hmac('AWS4' + secretAccessKey, dateStamp);
    k = hmac(k, reg); k = hmac(k, service); k = hmac(k, 'aws4_request');
    const expect = crypto.createHmac('sha256', k).update(toSign).digest('hex');
    return expect === signature ? null : 'подпись не совпала';
  }

  // ---- выражения
  const val = (p, ref) => (p.ExpressionAttributeValues || {})[ref];
  const name = (p, ref) => ref.startsWith('#') ? (p.ExpressionAttributeNames || {})[ref] : ref;

  function condOk(expr, item, p) {
    if (!expr) return true;
    const m = /^attribute_(not_)?exists\((\w+)\)$/.exec(expr.trim());
    if (!m) throw new Error('заглушка не понимает условие: ' + expr);
    const has = !!item && item[m[2]] !== undefined;
    return m[1] ? !has : has;
  }

  function splitClauses(expr) {
    const out = { SET: '', ADD: '', REMOVE: '', DELETE: '' };
    const re = /\b(SET|ADD|REMOVE|DELETE)\s+/g;
    const marks = [];
    let m;
    while ((m = re.exec(expr))) marks.push({ kw: m[1], start: m.index, end: re.lastIndex });
    for (let i = 0; i < marks.length; i++) {
      const to = i + 1 < marks.length ? marks[i + 1].start : expr.length;
      out[marks[i].kw] = expr.slice(marks[i].end, to).trim();
    }
    return out;
  }

  function applyUpdate(item, p) {
    const parts = splitClauses(String(p.UpdateExpression || ''));
    const changed = {};
    if (parts.SET) {
      for (const piece of parts.SET.split(',')) {
        const [l, r] = piece.split('=').map(s => s.trim());
        if (!l) continue;
        item[name(p, l)] = val(p, r);
        changed[name(p, l)] = item[name(p, l)];
      }
    }
    if (parts.ADD) {
      for (const piece of parts.ADD.split(',')) {
        const [l, r] = piece.trim().split(/\s+/);
        const key = name(p, l);
        const delta = Number(val(p, r).N);
        item[key] = { N: String(Number(item[key] ? item[key].N : 0) + delta) };
        changed[key] = item[key];
      }
    }
    if (parts.REMOVE) for (const piece of parts.REMOVE.split(',')) delete item[name(p, piece.trim())];
    return changed;
  }

  function queryItems(map, p) {
    const kc = String(p.KeyConditionExpression || '');
    const mPk = /pk\s*=\s*(:\w+)/.exec(kc);
    if (!mPk) throw new Error('заглушка ждёт условие по pk');
    const pk = val(p, mPk[1]).S;
    let rows = [...map.values()].filter(it => it.pk.S === pk);
    const mGt = /sk\s*>\s*(:\w+)/.exec(kc);
    const mBeg = /begins_with\(sk,\s*(:\w+)\)/.exec(kc);
    if (mGt) { const s = val(p, mGt[1]).S; rows = rows.filter(it => it.sk.S > s); }
    if (mBeg) { const s = val(p, mBeg[1]).S; rows = rows.filter(it => it.sk.S.startsWith(s)); }
    rows.sort((a, b) => a.sk.S < b.sk.S ? -1 : a.sk.S > b.sk.S ? 1 : 0);
    if (p.ExclusiveStartKey) {
      const after = p.ExclusiveStartKey.sk.S;
      rows = rows.filter(it => it.sk.S > after);
    }
    // настоящая база отдаёт страницами — повторяем, чтобы проверить дочитывание
    const page = rows.slice(0, 40);
    const last = rows.length > 40 ? { pk: { S: pk }, sk: { S: page[page.length - 1].sk.S } } : null;
    const project = p.ProjectionExpression
      ? p.ProjectionExpression.split(',').map(s => s.trim())
      : null;
    const items = page.map(it => {
      if (!project) return it;
      const o = {}; for (const k of project) if (it[k] !== undefined) o[k] = it[k];
      return o;
    });
    return { Items: items, Count: items.length, LastEvaluatedKey: last };
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const reply = (code, obj) => {
        const t = JSON.stringify(obj);
        res.writeHead(code, { 'Content-Type': 'application/x-amz-json-1.0', 'Content-Length': Buffer.byteLength(t) });
        res.end(t);
      };
      const fail = (type, message, code = 400) =>
        reply(code, { __type: 'com.amazonaws.dynamodb.v20120810#' + type, message });

      const bad = checkSignature(req, body);
      if (bad) return fail('UnrecognizedClientException', bad, 403);
      if (req.url.split('?')[0] !== basePath) return fail('ResourceNotFoundException', 'нет такой базы', 404);

      const action = String(req.headers['x-amz-target'] || '').split('.').pop();
      counters.calls++;
      counters.byAction[action] = (counters.byAction[action] || 0) + 1;
      let p;
      try { p = JSON.parse(body || '{}'); } catch (e) { return fail('SerializationException', 'плохой JSON'); }

      const tname = p.TableName;
      if (action === 'CreateTable') {
        if (tables.has(tname)) return fail('ResourceInUseException', 'уже есть');
        tables.set(tname, new Map());
        return reply(200, { TableDescription: { TableName: tname, TableStatus: 'ACTIVE' } });
      }
      if (action === 'DescribeTable') {
        if (!tables.has(tname)) return fail('ResourceNotFoundException', 'нет таблицы', 400);
        return reply(200, { Table: { TableName: tname, TableStatus: 'ACTIVE' } });
      }
      const map = tables.get(tname);
      if (!map) return fail('ResourceNotFoundException', 'нет таблицы', 400);

      try {
        if (action === 'PutItem') {
          const k = keyOf(p.Item);
          if (!condOk(p.ConditionExpression, map.get(k), p)) return fail('ConditionalCheckFailedException', 'условие не выполнено');
          map.set(k, JSON.parse(JSON.stringify(p.Item)));
          counters.writes++;
          return reply(200, {});
        }
        if (action === 'GetItem') {
          counters.reads++;
          const it = map.get(keyOf(p.Key));
          return reply(200, it ? { Item: it } : {});
        }
        if (action === 'DeleteItem') {
          counters.writes++;
          map.delete(keyOf(p.Key));
          return reply(200, {});
        }
        if (action === 'UpdateItem') {
          const k = keyOf(p.Key);
          const item = map.get(k) || Object.assign({}, p.Key);
          if (!condOk(p.ConditionExpression, map.get(k), p)) return fail('ConditionalCheckFailedException', 'условие не выполнено');
          const changed = applyUpdate(item, p);
          map.set(k, item);
          counters.writes++;
          return reply(200, p.ReturnValues === 'UPDATED_NEW' ? { Attributes: changed } : {});
        }
        if (action === 'Query') {
          counters.reads++;
          return reply(200, queryItems(map, p));
        }
      } catch (e) {
        return fail('ValidationException', e.message);
      }
      return fail('UnknownOperationException', 'заглушка не умеет ' + action, 400);
    });
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        endpoint: `http://127.0.0.1:${port}${basePath}`,
        accessKeyId, secretAccessKey, counters, tables,
        close: () => new Promise(r => server.close(r))
      });
    });
  });
}
