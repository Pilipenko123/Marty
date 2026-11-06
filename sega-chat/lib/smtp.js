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
  if (/ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|не ответил/i.test(s)) {
    return 'Соединение не установилось. Провайдеры часто закрывают порты 25 и 587 — попробуйте 465 (SSL).';
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
    const timeout = Number(o.timeoutMs || 20000);
    let finished = false;
    let sock = null, buf = '', tlsReady = false, sawStarttls = false, upgraded = false;
    const queue = [];
    const timer = setTimeout(() => finish(fail('почтовый сервер не ответил за ' + Math.round(timeout / 1000) + ' с')), timeout);

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
      sock.on('error', e => finish(fail(e.code ? e.code + (e.message ? ' · ' + e.message : '') : e.message)));
      sock.on('close', () => { if (!finished && !upgraded) finish(fail('почтовый сервер закрыл соединение')); });
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
                socket: plain, servername: c.host,
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

module.exports = { sendMail, enabled, check, hintFor };
