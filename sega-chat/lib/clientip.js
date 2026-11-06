'use strict';
/**
 * pkg3-135: «откуда пришёл запрос» — без доверия тому, что прислал клиент.
 *
 * Раньше сервер брал ПЕРВОЕ значение заголовка X-Forwarded-For. Но его целиком
 * может прислать сам клиент: nginx дописывает настоящий адрес В КОНЕЦ, а начало
 * остаётся поддельным. В итоге ограничение «25 попыток входа за 10 минут»
 * обходилось одной строкой в curl — будто каждый раз заходит новый человек.
 *
 * Теперь правило простое:
 *   • если соединение пришло НЕ из локальной сети (значит перед нами не наш
 *     прокси) — верим только настоящему адресу соединения, заголовок игнорируем;
 *   • если соединение из локальной сети (наш nginx) — берём ПОСЛЕДНЕЕ значение
 *     заголовка: его дописал прокси, подделать его клиент не может;
 *   • в облачной функции своего адреса соединения может не быть вовсе — тогда
 *     берём последнее значение заголовка, иначе sourceIp от платформы.
 */

/** Локальный ли адрес: 127.0.0.1, ::1, 10/8, 172.16/12, 192.168/16, fc00::/7. */
function isPrivate(ip) {
  const s = String(ip || '').replace(/^::ffff:/i, '').trim();
  if (!s) return false;
  if (s === '::1' || s === '127.0.0.1') return true;
  if (/^127\./.test(s)) return true;
  if (/^10\./.test(s)) return true;
  if (/^192\.168\./.test(s)) return true;
  const m = /^172\.(\d{1,3})\./.exec(s);
  if (m) { const n = Number(m[1]); if (n >= 16 && n <= 31) return true; }
  if (/^f[cd][0-9a-f]{2}:/i.test(s)) return true;
  return false;
}

function norm(ip) {
  const s = String(ip || '').trim().replace(/^::ffff:/i, '');
  // у IPv6 в скобках бывает порт: [::1]:1234
  const m = /^\[([^\]]+)\](?::\d+)?$/.exec(s);
  return m ? m[1] : s;
}

/**
 * Выбрать адрес клиента.
 * opts.headers — заголовки запроса; opts.remote — адрес соединения (может быть пустым);
 * opts.sourceIp — адрес от платформы (облачная функция).
 */
function clientIp(opts) {
  const o = opts || {};
  const headers = o.headers || {};
  const remote = norm(o.remote || '');
  const chain = String(headers['x-forwarded-for'] || headers['X-Forwarded-For'] || '')
    .split(',').map(s => norm(s)).filter(Boolean);
  // соединение напрямую с клиентом: заголовку не верим вовсе
  if (remote && !isPrivate(remote)) return remote;
  // соединение от нашего прокси: настоящий адрес — последний в цепочке
  if (chain.length) return chain[chain.length - 1];
  // своего адреса нет или он локальный (облачная функция): верим платформе
  if (o.sourceIp) return norm(o.sourceIp) || remote || 'unknown';
  if (remote) return remote;
  return 'unknown';
}

module.exports = { clientIp, isPrivate, norm };
