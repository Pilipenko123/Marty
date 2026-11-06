'use strict';
/**
 * SEGA-CHAT · минимальный SMTP-клиент БЕЗ сторонних зависимостей
 * (правило проекта: новых рантайм-зависимостей npm не добавляем).
 *
 * Умеет два режима: implicit TLS (порт 465) и STARTTLS (587/25).
 * Настройка — переменными окружения:
 *   SEGA_SMTP_HOST, SEGA_SMTP_PORT, SEGA_SMTP_USER, SEGA_SMTP_PASS, SEGA_SMTP_FROM
 * Без них почта выключена, а восстановление честно говорит «почта не настроена».
 * Письма несекретные: код привязки почты и ссылка восстановления (секретов в них нет).
 *
 * pkg3-135 — ПОЧИНКА: на порту 587 (STARTTLS) отправка не работала вообще, и
 * владелец видел «почтовый сервер не ответил». Причина: после перехода на TLS
 * клиент ждал НОВОЕ приветствие «220», а по RFC 3207 сервер его не присылает —
 * обе стороны просто молчат до таймаута. Теперь после TLS сразу уходит EHLO,
 * как и положено. Проверка в test/ui135.mjs: игрушечный сервер с STARTTLS.
 *
 * pkg3-135 — ДИАГНОСТИКА: check() проходит соединение по шагам (связь → TLS →
 * вход → готовность) и возвращает, где именно застряло, с ответом сервера и
 * подсказкой. Раньше человек видел одно «не удалось отправить письмо» и не знал,
 * что чинить.
 */
const net = require('net');
const tls = require('tls');

function cfg() {
  return {
    host: String(process.env.SEGA_SMTP_HOST || '').trim(),
    port: Number(process.env.SEGA_SMTP_PORT || 587),
    user: String(process.env.SEGA_SMTP_USER || ''),
    pass: String(process.env.SEGA_SMTP_PASS || ''),
    from: String(process.env.SEGA_SMTP_FROM || process.env.SEGA_SMTP_USER || ''),
    // pkg3-135: только для проверок на своём стенде (самоподписанный сертификат).
    insecure: String(process.env.SEGA_SMTP_INSECURE || '') === '1',
    // pkg3-135: разрешить работу совсем без TLS (локальная пересылка писем).
    plain: String(process.env.SEGA_SMTP_PLAIN || '') === '1'
  };
}
const enabled = () => !!cfg().host && !!cfg().from;
const b64 = s => Buffer.from(s, 'utf8').toString('base64');

/** Понятная человеку подсказка к коду ошибки SMTP или к сетевому сбою. */
function hintFor(text) {
  const s = String(text || '');
  const num = Number((s.match(/(?:^|\s)([245]\d{2})(?:\s|:|$)/) || [])[1] || 0);
  if (num === 535 || num === 534 || num === 530) {
    return 'Сервер не принял логин или пароль. У Яндекса, Mail.ru и Gmail обычный пароль от почты не подходит — '
      + 'нужен «пароль приложения» (Яндекс: id.yandex.ru → Безопасность → Пароли приложений; у Gmail — «Пароли приложений» в аккаунте Google).';
  }
  if (num === 550 || num === 553 || num === 501) {
    return 'Сервер не разрешает отправку с этого адреса: SEGA_SMTP_FROM должен совпадать с ящиком, под которым входим (SEGA_SMTP_USER).';
  }
  if (num === 504 || num === 502 || num === 500) {
    return 'Сервер не умеет AUTH LOGIN. Попробуйте порт 465 (там всё иначе) или другой почтовый сервер.';
  }
  if (num === 421 || num === 450 || num === 451 || num === 452) {
    return 'Сервер временно не хочет принимать письма — попробуйте позже.';
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(s)) return 'Такого адреса сервера нет: проверьте SEGA_SMTP_HOST (например, smtp.yandex.ru).';
  if (/ECONNREFUSED/i.test(s)) return 'Сервер отказал в соединении: скорее всего неверный порт (465 — SSL, 587 — STARTTLS) или сервер закрыт для этого адреса.';
  if (/ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EADDRNOTAVAIL|не ответил|не установилось/i.test(s)) {
    return 'Соединение не установилось. Провайдеры часто закрывают исходящие порты 25 и 587 — попробуйте 465 (SSL). '
      + 'Нажмите «Проверить почтовый сервер»: покажем, какие порты у этого сервера вообще отвечают. '
      + 'Если не отвечает ни один — это закрытые порты у хостера: напишите в поддержку сервера, где живёт чат.';
  }
  if (/CERT|self.signed|SSL|TLS/i.test(s) && !/STARTTLS/i.test(s)) {
    return 'Не удалось установить защищённое соединение: проверьте, что порт соответствует режиму (465 — сразу SSL, 587 — STARTTLS).';
  }
  return '';
}

/** Ошибка с подсказкой: message остаётся прежним, hint — рядом для интерфейса. */
function fail(text) {
  const e = new Error(text);
  e.hint = hintFor(text);
  return e;
}

/**
 * Один сеанс SMTP. opts.steps — куда складывать пройденные шаги (для check()).
 * Возвращает обещание: resolve({steps}) после QUIT, reject(Error с .hint).
 */
function session(opts) {
  const o = opts || {};
  const c = cfg();
  const steps = o.steps || [];
  const step = (name, ok, detail) => steps.push({ step: name, ok: !!ok, detail: String(detail || '') });
  return new Promise((resolve, reject) => {
    if (!enabled()) return reject(fail('почта не настроена'));
    const timeout = Number(o.timeoutMs || 12000);   // pkg3-136: 12 с вместо 20 — понятнее и быстрее
    let finished = false;
    let sock = null, buf = '', tlsReady = false, sawStarttls = false, upgraded = false;
    const queue = [];
    const timer = setTimeout(() => finish(fail(c.host + ':' + c.port + ' не ответил за ' + Math.round(timeout / 1000) + ' с')), timeout);

    function finish(err) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (sock) { try { sock.destroy(); } catch (e) {} }
      if (err) { if (!err.hint) err.hint = hintFor(err.message); reject(err); } else resolve({ steps });
    }
    function send(line) { try { sock.write(line + '\r\n'); } catch (e) { finish(fail(e.message)); } }
    function expect(code, next) { queue.push({ code, next }); }

    function attach(s) {
      sock = s;
      sock.setEncoding('utf8');
      sock.on('data', chunk => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\r\n')) >= 0) {
          const ln = buf.slice(0, i); buf = buf.slice(i + 2);
          if (/STARTTLS/i.test(ln)) sawStarttls = true;
          if (!/^\d{3}[- ]/.test(ln)) continue;
          if (ln[3] === '-') continue;              // многострочный ответ: ждём последнюю строку
          const code = Number(ln.slice(0, 3));
          const item = queue.shift();
          if (!item) continue;
          if (item.code !== code) {
            return finish(fail('почтовый сервер ответил ' + code + ': ' + ln.slice(4).trim()));
          }
          try { item.next(code, ln.slice(4).trim()); } catch (e) { finish(fail(e.message)); }
        }
      });
      sock.on('error', e => finish(fail(c.host + ':' + c.port + ' — ' + (e.code ? e.code + (e.message ? ' · ' + e.message : '') : e.message))));
      sock.on('close', () => { if (!finished && !upgraded) finish(fail(c.host + ':' + c.port + ' закрыл соединение')); });
    }

    /** EHLO → (STARTTLS) → AUTH. greeted=false сразу после TLS: приветствия не будет. */
    function handshake(greeted) {
      queue.length = 0;
      const ehlo = () => {
        send('EHLO sega-chat');
        expect(250, () => {
          if (!tlsReady && sawStarttls) {
            send('STARTTLS');
            expect(220, () => {
              const plain = sock;
              plain.removeAllListeners('data');
              plain.removeAllListeners('error');
              plain.removeAllListeners('close');
              upgraded = true;
              const t = tls.connect({
                socket: plain,
                servername: /^\d+\.\d+\.\d+\.\d+$/.test(c.host) ? undefined : c.host,
                rejectUnauthorized: c.insecure ? false : true
              }, () => {
                tlsReady = true;
                sawStarttls = false;
                // pkg3-135: ВОТ ЗДЕСЬ БЫЛА ПОЛОМКА. По RFC 3207 после TLS сервер
                // приветствие не присылает — клиент сразу говорит EHLO.
                handshake(false);
              });
              attach(t);
            });
          } else if (!tlsReady && !c.plain) {
            finish(fail('сервер не предложил STARTTLS — письмо ушло бы открытым текстом, отказался'));
          } else auth();
        });
      };
      if (greeted) expect(220, ehlo); else ehlo();
    }

    function auth() {
      if (!c.user) { step('вход', true, 'без входа (сервер без авторизации)'); return after(); }
      send('AUTH LOGIN');
      expect(334, () => {
        send(b64(c.user));
        expect(334, () => {
          send(b64(c.pass));
          expect(235, () => {
            step('вход', true, 'принят логин ' + c.user);
            after();
          });
        });
      });
    }

    function after() {
      if (o.onlyCheck) { send('QUIT'); return finish(null); }
      mail();
    }

    function mail() {
      send('MAIL FROM:<' + c.from + '>');
      expect(250, () => {
        send('RCPT TO:<' + o.to + '>');
        expect(250, () => {
          send('DATA');
          expect(354, () => {
            const head = 'From: ' + c.from + '\r\nTo: ' + o.to + '\r\n'
              + 'Subject: =?UTF-8?B?' + b64(o.subject || '') + '?=\r\n'
              + 'MIME-Version: 1.0\r\n'
              + 'Content-Type: text/plain; charset=utf-8\r\n'
              + 'Content-Transfer-Encoding: 8bit\r\n\r\n';
            const body = head + String(o.text || '').replace(/\r?\n/g, '\r\n') + '\r\n.';
            send(body);
            expect(250, () => { send('QUIT'); finish(null); });
          });
        });
      });
    }

    step('связь', true, 'подключаемся к ' + c.host + ':' + c.port + (c.port === 465 ? ' (SSL)' : ' (STARTTLS)'));
    if (c.port === 465) {
      attach(tls.connect({
        host: c.host, port: c.port, servername: c.host,
        rejectUnauthorized: c.insecure ? false : true
      }, () => { tlsReady = true; handshake(true); }));
    } else {
      attach(net.connect(c.port, c.host, () => handshake(true)));
    }
  });
}

/**
 * pkg3-136: «а сервер вообще слышно?» — быстрая проверка одного порта.
 * Нужна, когда в ответ на письмо приходит «соединение не установилось»:
 * без этого человек не понимает, ошибочный это адрес, закрытый порт или
 * что-то ещё. Учётные данные здесь не отправляются — только приветствие.
 * Сертификат не проверяем: мы не передаём ничего секретного.
 */
function probePort(host, port, timeoutMs) {
  const limit = Math.max(1200, Math.min(6000, Number(timeoutMs) || 3500));
  const mode = Number(port) === 465 ? 'SSL' : 'STARTTLS';
  return new Promise(resolve => {
    const started = Date.now();
    let done = false, buf = '';
    let sock = null;
    const finish = (ok, detail) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock && sock.destroy(); } catch (e) {}
      resolve({ port: Number(port), mode, ok: !!ok, detail: String(detail || ''), ms: Date.now() - started });
    };
    const timer = setTimeout(() => finish(false, 'нет ответа за ' + (limit / 1000).toFixed(1) + ' с'), limit);
    try {
      sock = Number(port) === 465
        ? tls.connect({
            host, port: Number(port), rejectUnauthorized: false,
            servername: /^\d+\.\d+\.\d+\.\d+$/.test(host) ? undefined : host
          })
        : net.connect(Number(port), host);
    } catch (e) { return finish(false, e.message); }
    sock.setEncoding('utf8');
    sock.on('data', chunk => {
      buf += chunk;
      const m = /^(\d{3})([^\r\n]*)/m.exec(buf);
      if (m) finish(true, 'сервер ответил ' + m[1] + (m[2] ? ' · ' + m[2].trim() : ''));
    });
    sock.on('error', e => finish(false, (e.code || '') + (e.code && e.message ? ' · ' : '') + (e.message || 'сбой соединения')));
    sock.on('timeout', () => finish(false, 'молчит'));
  });
}

/** Имя сервера → адреса (A/AAAA). Без этого «не отвечает» ничего не объясняет. */
async function resolveHost(host) {
  const dns = require('dns').promises;
  try {
    const list = await dns.lookup(String(host), { all: true });
    return { ok: true, addresses: list.map(x => ({ address: x.address, family: x.family })) };
  } catch (e) {
    return { ok: false, error: e.code || e.message, addresses: [] };
  }
}

/** Отправить одно письмо. resolve(true) — принято, reject(Error) — сбой. */
async function sendMail(to, subject, text, timeoutMs) {
  if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw fail('непохоже на адрес почты');
  await session({ to, subject, text, timeoutMs });
  return true;
}

/**
 * pkg3-135: проверка почты без отправки письма. Возвращает
 *   { ok, config: {host,port,user,from}, steps: [{step, ok, detail}], error, hint }
 * Шаги: связь → TLS → вход. Владелец за одно нажатие видит, где застряло.
 */
async function check(timeoutMs) {
  const c = cfg();
  const conf = { host: c.host, port: c.port, user: c.user ? c.user.replace(/^(.)[^@]*/, '$1***') : '', from: c.from, configured: enabled() };
  if (!enabled()) return { ok: false, config: conf, steps: [], error: 'почта не настроена', hint: 'Задайте SEGA_SMTP_HOST, SEGA_SMTP_PORT, SEGA_SMTP_USER, SEGA_SMTP_PASS, SEGA_SMTP_FROM в .env и перезапустите службу.' };
  const steps = [];
  try {
    await session({ onlyCheck: true, steps, timeoutMs: timeoutMs || 12000 });
    steps.push({ step: 'готовность', ok: true, detail: 'сервер принял вход, письма можно отправлять' });
    return { ok: true, config: conf, steps, error: '', hint: '' };
  } catch (e) {
    steps.push({ step: 'ошибка', ok: false, detail: e.message });
    return { ok: false, config: conf, steps, error: e.message, hint: e.hint || '' };
  }
}

/**
 * pkg3-136: полная проверка почты — то, что видит владелец по кнопке
 * «Проверить почтовый сервер». Отвечает на вопрос «что именно не так»:
 *   • находит ли имя сервера (DNS);
 *   • отвечает ли вообще 465 (SSL), 587 (STARTTLS), 25 — параллельно и быстро;
 *   • проходит ли вход с текущими логином и паролем (check()).
 * Возвращает { ok, config, dns, ports, steps, error, hint, advice }.
 */
async function checkAll(timeoutMs) {
  const c = cfg();
  const conf = {
    host: c.host, port: c.port, configured: enabled(),
    from: c.from, user: c.user ? c.user.replace(/^(.)[^@]*/, '$1***') : ''
  };
  if (!enabled()) {
    return {
      ok: false, config: conf, dns: null, ports: [], steps: [],
      error: 'почта не настроена',
      hint: 'Задайте SEGA_SMTP_HOST, SEGA_SMTP_PORT, SEGA_SMTP_USER, SEGA_SMTP_PASS, SEGA_SMTP_FROM в .env и перезапустите службу.',
      advice: 'Без этих переменных кнопка привязки почты честно отвечает «почта не настроена».'
    };
  }
  const dns = await resolveHost(c.host);
  const probeMs = Math.min(Number(timeoutMs) || 3500, 4000);
  // проверяем и общепринятые порты, и тот, что задан в .env (бывает 2525 и другие)
  const candidates = Array.from(new Set([465, 587, 25, Number(c.port) || 587]));
  const ports = dns.ok
    ? await Promise.all(candidates.map(p => probePort(c.host, p, probeMs)))
    : [];
  const full = dns.ok ? await check(timeoutMs) : { ok: false, steps: [], error: 'имя сервера не найдено', hint: '' };
  const open = ports.filter(p => p.ok).map(p => p.port);
  let advice = '';
  let hint = full.hint || '';
  if (!dns.ok) {
    advice = 'Имя «' + c.host + '» не находится (' + (dns.error || '') + '). Проверьте SEGA_SMTP_HOST — например, smtp.yandex.ru.';
  } else if (!open.length) {
    advice = 'Ни 465, ни 587, ни 25 не отвечают — сервер почты недоступен с этого сервера. '
      + 'Чаще всего так бывает, когда хостер закрывает исходящую почту: напишите в поддержку (Sprintbox и подобные) '
      + 'или возьмите почтовый сервис, у которого открыт 465. Проверить руками: '
      + '`for p in 465 587 25; do timeout 5 bash -c "echo > /dev/tcp/' + c.host + '/$p" 2>/dev/null && echo "$p открыт" || echo "$p закрыт"; done`';
    hint = hint || 'Порты закрыты — это не ошибка настроек в чате, а сеть хостера.';
  } else if (!open.includes(c.port)) {
    advice = 'На порту ' + c.port + ' сервер молчит, а отвечает на ' + open.join(' и ') + '. '
      + 'Поставьте в .env SEGA_SMTP_PORT=' + open[0] + (open[0] === 465 ? ' (это SSL, порт 587 — STARTTLS)' : '') + ' и перезапустите службу.';
  } else if (!full.ok) {
    advice = 'Порты открыты, значит дело не в сети. Смотрите шаги ниже и ответ сервера: ' + (full.error || '');
  } else {
    advice = 'Всё в порядке: сервер отвечает и вход принят — письма должны уходить.';
  }
  return {
    ok: !!full.ok, config: conf, dns, ports, steps: full.steps || [],
    error: full.error || '', hint, advice
  };
}

module.exports = { sendMail, enabled, check, checkAll, probePort, resolveHost, hintFor };
