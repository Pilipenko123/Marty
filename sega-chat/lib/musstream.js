'use strict';
/**
 * pkg3-101: ПРОСЛУШИВАНИЕ ЧЕРЕЗ СЕРВЕР (запасной путь звука).
 *
 * Зачем. Поиск музыки (97–100) даёт прямые ссылки на потоки чужих сайтов.
 * Звук с них устройство тянет НАПРЯМУЮ. Но стрим-хост Jamendo (mp3d.jamendo.com)
 * в сети владельца НЕ ОТКРЫВАЕТСЯ: скачивание виснет, пока не включишь VPN,
 * хотя с VPS тот же адрес отвечает 200 audio/mpeg (замерено владельцем 28.10).
 * Запасная ссылка на тот же хост не лечит: закрыт весь хост, а не одна ссылка.
 * Поэтому сервер умеет ПРОТЯНУТЬ звук через себя: устройство слушает наш
 * /api/musstream, а сервер читает поток у источника и передаёт байты дальше.
 *
 * Честные границы (важно для безопасности и памяти):
 *  - это НЕ открытый прокси: пропускаются ТОЛЬКО https-ссылки на белые домены
 *    источников поиска (jamendo.com, archive.org, wikimedia.org, ccmixter.org,
 *    yapfiles.ru) — suffix-список, как в mussearch; переходы (301/302/…) тоже
 *    проверяются по списку на каждом шаге, не больше трёх шагов;
 *  - маршрут доступен ТОЛЬКО вошедшему участнику и под дросселем (api.js);
 *  - байты НЕ накапливаются в памяти: поток трубой идёт из сокета источника в
 *    сокет ответа (pipe), VPS с 550 МБ это переживает; одновременно держим не
 *    больше MAX_STREAMS потоков, лишним честно говорим «подождите»;
 *  - отвечиваем Range (перемотку): заголовок Range уходит источнику, его
 *    206/Content-Range возвращаем как есть;
 *  - обрыв слушателя (закрыл окно) немедленно обрывает чтение у источника;
 *  - потолок байт на один поток ставит server.js (PIPE_CAP), здесь — времена
 *    и переходы.
 *
 * Зависимостей нет: только встроенные https/http.
 */

const https = require('https');
const http = require('http');
const mussearch = require('./mussearch.js');   // pkg3-105: хозяева подкаст-звука из лент

/** Белые домены источников поиска: их звук разрешено тянуть через сервер.
 * Зеркало этого списка живёт в клиенте (public/app.js, MUS_PROXY_HOSTS) —
 * клиент по нему решает, куда переключаться при отказе прямой ссылки. */
const ALLOW = ['jamendo.com', 'archive.org', 'wikimedia.org', 'ccmixter.org', 'yapfiles.ru'];

/** Тестовая добавка: игрушечные источники на 127.0.0.1:port (env MUSSTREAM_EXTRA_HOSTS).
 * В живой сборке env не ставится, список пуст и ни на что не влияет. */
const EXTRA = String(process.env.MUSSTREAM_EXTRA_HOSTS || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

const UA = 'SEGA-CHAT/101 (https://segachat.pilpro.ru; private messenger; stream proxy)';
/** Что считаем звуком: обычные аудио-типы и сырые байты. Пустой тип пропускаем
 * (источник промолчал о типе) — плеер сам разберётся. */
const CT_OK = /^(audio\/|application\/octet-stream|binary\/octet-stream|video\/mp4)/;
const MAX_HOPS = 3;              // не больше трёх переходов подряд
const RESP_TIMEOUT = 10000;      // 10 с на ответ источника (как в mussearch)
const IDLE_TIMEOUT = 20000;      // 20 с тишины в сокете — обрываем
const MAX_STREAMS = 6;           // потолок одновременных потоков (бережём VPS)

let active = 0;

/** Проходима ли ссылка через сервер: https (или тестовый хост) и белый домен. */
function hostOk(u) {
  const h = String(u.hostname || '').toLowerCase();
  const hp = u.port ? h + ':' + u.port : h;
  if (EXTRA.includes(h) || EXTRA.includes(hp)) return true;   // только тесты
  if (u.protocol !== 'https:') return false;
  // pkg3-105: помимо белого списка источников — хозяева звука, которых сервер
  // сам увидел в <enclosure> прочитанных RSS-лент подкастов (не открытый прокси:
  // хозяина нельзя «заказать» ссылкой, он приходит только из ленты).
  return ALLOW.some(d => h === d || h.endsWith('.' + d)) || mussearch.podHostOk(h);
}

function denied(msg) { const e = new Error(msg); e.code = 'denied'; return e; }
function busy(msg) { const e = new Error(msg); e.code = 'busy'; return e; }

/**
 * Открыть поток у источника.
 * @param {string} url прямая ссылка на звук
 * @param {{range?: string}} opts range — заголовок перемотки от слушателя
 * @returns {Promise<{status:number, headers:Object, stream:import('stream').Readable, abort:Function}>}
 * Ошибки: code 'denied' (не белый домен / не https / кривой переход),
 *         code 'busy' (потолок одновременных потоков),
 *         code 'up' + status (источник ответил не звуком),
 *         без code — сеть/таймаут.
 */
function openStream(url, opts = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = fn => arg => { if (!settled) { settled = true; fn(arg); } };
    const done = finish(resolve), fail = finish(reject);
    if (active >= MAX_STREAMS) return fail(busy('Сейчас через сервер слушает слишком много людей — попробуйте через минуту'));
    let u;
    try { u = new URL(url); } catch (e) { return fail(denied('Кривая ссылка на трек')); }
    if (!hostOk(u)) return fail(denied('Этот сайт не пропускается через сервер'));
    let hops = 0;
    const tryOnce = cur => {
      const mod = cur.protocol === 'http:' ? http : https;
      const headers = { 'User-Agent': UA, Accept: '*/*' };
      if (opts.range) headers.Range = String(opts.range).slice(0, 200);
      const rq = mod.request(cur, { headers, timeout: RESP_TIMEOUT }, rs => {
        const st = rs.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(st) && rs.headers.location && hops < MAX_HOPS) {
          hops++;
          let nu = null;
          try { nu = new URL(rs.headers.location, cur); } catch (e) { rs.destroy(); return fail(new Error('Источник позвал по кривому адресу')); }
          rs.destroy();
          if (!hostOk(nu)) return fail(denied('Источник позвал на чужой сайт — не пускаем'));
          return tryOnce(nu);
        }
        if (st !== 200 && st !== 206) {
          rs.destroy();
          const e = new Error('Источник ответил ошибкой ' + st); e.code = 'up'; e.status = st;
          return fail(e);
        }
        // честность: страница (text/html) вместо звука через трубу не пойдёт —
        // скажем по-человечески, а не отдадим плееру разметку
        const ct = String(rs.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (st === 200 && ct && !CT_OK.test(ct)) {
          rs.destroy();
          const e = new Error('Источник отдал страницу вместо звука'); e.code = 'up'; e.status = st;
          return fail(e);
        }
        const hOut = {};
        if (rs.headers['content-type']) hOut['Content-Type'] = rs.headers['content-type'];
        if (rs.headers['content-length']) hOut['Content-Length'] = rs.headers['content-length'];
        if (rs.headers['content-range']) hOut['Content-Range'] = rs.headers['content-range'];
        hOut['Accept-Ranges'] = rs.headers['accept-ranges'] || 'none';
        active++;
        rs.socket && rs.socket.setTimeout(IDLE_TIMEOUT, () => rs.destroy());   // тишина в сокете — обрыв
        rs.on('close', () => { active = Math.max(0, active - 1); });
        done({ status: st, headers: hOut, stream: rs, abort: () => { try { rs.destroy(); } catch (e) {} } });
      });
      rq.on('timeout', () => { rq.destroy(new Error('Источник молчит')); });
      rq.on('error', e => fail(new Error(e && e.message ? e.message : 'Источник не открылся')));
      rq.end();
    };
    tryOnce(u);
  });
}

module.exports = { openStream, hostOk, ALLOW, MAX_STREAMS };
