'use strict';
/**
 * SEGA-CHAT · pkg3-64: минимальный SMTP-клиент БЕЗ сторонних зависимостей
 * (правило проекта: новых рантайм-зависимостей npm не добавляем).
 * Умеет два режима: implicit TLS (порт 465) и STARTTLS (587/25).
 * Настройка — переменными окружения:
 *   SEGA_SMTP_HOST, SEGA_SMTP_PORT, SEGA_SMTP_USER, SEGA_SMTP_PASS, SEGA_SMTP_FROM
 * Без них почта выключена, а восстановление честно говорит «почта не настроена».
 * Письма несекретные: код привязки почты и ссылка восстановления (секретов в них нет).
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
  };
}
const enabled = () => !!cfg().host && !!cfg().from;
const b64 = s => Buffer.from(s, 'utf8').toString('base64');

/** Отправить одно письмо. resolve(true) — принято, reject(Error) — сбой. */
function sendMail(to, subject, text, timeoutMs) {
  return new Promise((resolve, reject) => {
    const c = cfg();
    if (!enabled()) return reject(new Error('почта не настроена'));
    if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return reject(new Error('непохоже на адрес почты'));
    let finished = false;
    const timer = setTimeout(() => finish(new Error('почтовый сервер не ответил вовремя')), Number(timeoutMs || 20000));
    function finish(err) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (sock) { try { sock.destroy(); } catch (e) {} }
      if (err) reject(err); else resolve(true);
    }
    let sock = null;
    let buf = '';
    let tlsReady = false;
    let sawStarttls = false;
    const queue = [];           // ожидаемые коды ответов по порядку
    function send(line) { try { sock.write(line + '\r\n'); } catch (e) { finish(e); } }
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
          if (ln[3] === '-') continue;      // многострочный ответ: ждём завершающую строку
          const code = Number(ln.slice(0, 3));
          const item = queue.shift();
          if (!item) continue;
          if (item.code !== code) return finish(new Error('почтовый сервер ответил ' + code + ': ' + ln.slice(4).trim()));
          try { item.next(); } catch (e) { finish(e); }
        }
      });
      sock.on('error', e => finish(e));
    }
    function handshake() {
      queue.length = 0;
      expect(220, () => {
        send('EHLO sega-chat');
        expect(250, () => {
          if (!tlsReady && sawStarttls) {
            send('STARTTLS');
            expect(220, () => {
              const plain = sock;
              plain.removeAllListeners('data');
              plain.removeAllListeners('error');
              attach(tls.connect({ socket: plain, servername: c.host }, () => { tlsReady = true; handshake(); }));
            });
          } else auth();
        });
      });
    }
    function auth() {
      if (!c.user) return mail();
      send('AUTH LOGIN');
      expect(334, () => {
        send(b64(c.user));
        expect(334, () => {
          send(b64(c.pass));
          expect(235, mail);
        });
      });
    }
    function mail() {
      send('MAIL FROM:<' + c.from + '>');
      expect(250, () => {
        send('RCPT TO:<' + to + '>');
        expect(250, () => {
          send('DATA');
          expect(354, () => {
            const head = 'From: ' + c.from + '\r\nTo: ' + to + '\r\n'
              + 'Subject: =?UTF-8?B?' + b64(subject) + '?=\r\n'
              + 'Content-Type: text/plain; charset=utf-8\r\n\r\n';
            const body = head + String(text).replace(/\r?\n/g, '\r\n') + '\r\n.';
            send(body);
            expect(250, () => { send('QUIT'); finish(null); });
          });
        });
      });
    }
    if (c.port === 465) attach(tls.connect({ host: c.host, port: c.port, servername: c.host }, () => { tlsReady = true; handshake(); }));
    else attach(net.connect(c.port, c.host, () => handshake()));
  });
}

module.exports = { sendMail, enabled };
