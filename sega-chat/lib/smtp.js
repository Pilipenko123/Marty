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
function hintFor(text, port) {
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
    // pkg3-137: если человек уже на 465, совет «попробуйте 465» звучит издевательски
    const head = Number(port || 0) === 465
      ? 'Соединение не установилось на порту 465 (SSL) — значит дело не в выборе порта и не в пароле.'
      : 'Соединение не установилось. Провайдеры часто закрывают исходящие порты 25 и 587 — попробуйте 465 (SSL).';
    return head + ' Нажмите «Проверить почтовый сервер»: покажем, какие порты у этого сервера отвечают '
      + 'и есть ли у сервера интернет. Если не отвечает ни один — это закрытые порты у хостера: '
      + 'напишите в поддержку сервера, где живёт чат (готовый текст — там же).';
  }
  if (/CERT|self.signed|SSL|TLS/i.test(s) && !/STARTTLS/i.test(s)) {
    return 'Не удалось установить защищённое соединение: проверьте, что порт соответствует режиму (465 — сразу SSL, 587 — STARTTLS).';
  }
  return '';
}

/** Ошибка с подсказкой: message остаётся прежним, hint — рядом для интерфейса. */
function fail(text, port) {
  const e = new Error(text);
  e.hint = hintFor(text, port);
  return e;
}

/**
 * pkg3-137: адрес за адресом, а не «как получится».
 * У VPS часто есть IPv6-адрес без рабочего маршрута: тогда соединение молча
 * висит до таймаута, хотя IPv4 у того же сервера открыт. Поэтому: сначала
 * IPv4, потом IPv6, и каждый адрес получает свою долю срока. В отчёте видно,
 * какой именно адрес ответил, а какой промолчал.
 */
function isIpAddress(h) {
  const x = String(h || '').trim();
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(x) || x.includes(':');
}
function fmtAddr(a) { return a.address + (a.family === 6 ? ' (IPv6)' : ' (IPv4)'); }
function sortAddresses(list) {
  return (list || []).slice().sort((a, b) => (a.family === 6 ? 1 : 0) - (b.family === 6 ? 1 : 0));
}
/** Имя → список адресов (IPv4 первыми). Для числового адреса — он сам. */
async function addresses(host) {
  const h = String(host || '').trim();
  if (!h) return [];
  if (isIpAddress(h)) return [{ address: h, family: h.includes(':') ? 6 : 4 }];
  try {
    const list = await require('dns').promises.lookup(h, { all: true });
    const seen = new Set(), out = [];
    for (const x of list) {
      if (seen.has(x.address)) continue;
      seen.add(x.address);
      out.push({ address: x.address, family: x.family });
    }
    return sortAddresses(out);
  } catch (e) { return []; }
}

/** Соединение с конкретным адресом — без повторного DNS, чтобы адрес был виден. */
function connectTo(addr, port, ms, o) {
  const opts = o || {};
  return new Promise(resolve => {
    let sock = null, done = false;
    const finish = r => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (!r.ok && sock) { try { sock.destroy(); } catch (e) {} }
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, error: 'нет ответа за ' + (ms / 1000).toFixed(1) + ' с' }), ms);
    try {
      if (opts.tls) {
        sock = tls.connect({
          host: addr.address, port: Number(port),
          servername: opts.servername,
          rejectUnauthorized: !!opts.strict
        });
        sock.once('secureConnect', () => finish({ ok: true, sock }));
      } else {
        sock = net.connect(Number(port), addr.address);
        sock.once('connect', () => finish({ ok: true, sock }));
      }
    } catch (e) { return finish({ ok: false, error: e.code || e.message }); }
    // pkg3-137: код ошибки достаточно — адрес и так виден в отчёте
    sock.on('error', e => finish({ ok: false, error: e.code || e.message || 'сбой соединения' }));
  });
}

/**
 * Один сеанс SMTP. opts.steps — куда складывать пройденные шаги (для check()).
 * Возвращает обещание: resolve({steps}) после QUIT, reject(Error с .hint).
 */
async function session(opts) {
  const o = opts || {};
  const c = cfg();
  const steps = o.steps || [];
  const step = (name, ok, detail) => steps.push({ step: name, ok: !!ok, detail: String(detail || '') });
  if (!enabled()) throw fail('почта не настроена');
  const timeout = Number(o.timeoutMs || 12000);   // pkg3-136: 12 с вместо 20 — понятнее и быстрее
  const mode = c.port === 465 ? 'SSL' : 'STARTTLS';
  const sni = isIpAddress(c.host) ? undefined : c.host;

  // pkg3-137: подключаемся по адресам, IPv4 первым (см. addresses()).
  // pkg3-137: хватит двух адресов IPv4 и двух IPv6 — не надо перебирать все
  const list = (await addresses(c.host)).slice(0, 4);
  if (!list.length) throw fail(c.host + ' — имя сервера не находится');
  const per = Math.max(2000, Math.floor(timeout / list.length));
  const startedAt = Date.now();
  const tried = [];
  let sock = null, via = null;
  for (const a of list) {
    const r = await connectTo(a, c.port, per, { tls: c.port === 465, servername: sni, strict: !c.insecure });
    if (r.ok) { sock = r.sock; via = a; break; }
    tried.push({ address: a.address, family: a.family, detail: r.error });
  }
  if (!sock) {
    const refused = tried.length > 0 && tried.every(t => /ECONNREFUSED/.test(t.detail));
    const e = fail(refused
      ? c.host + ':' + c.port + ' — ECONNREFUSED · сервер не слушает этот порт'
      : c.host + ':' + c.port + ' не ответил за ' + Math.max(1, Math.round((Date.now() - startedAt) / 1000)) + ' с'
        + (tried.length > 1 ? ' (пробовали ' + tried.map(t => fmtAddr(t) + ' — ' + t.detail).join('; ') + ')' : ''), c.port);
    e.tried = tried;
    throw e;
  }
  step('связь', true, 'подключились к ' + c.host + ':' + c.port + ' (' + mode + ') · ' + fmtAddr(via));

  return new Promise((resolve, reject) => {
    let finished = false;
    let buf = '', tlsReady = false, sawStarttls = false, upgraded = false;
    // sock — уже подключённый сокет (см. выше: адрес за адресом)
    const queue = [];
    const timer = setTimeout(() => finish(fail(c.host + ':' + c.port + ' не ответил за ' + Math.round(timeout / 1000) + ' с', c.port)), timeout);

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
      sock.on('error', e => finish(fail(c.host + ':' + c.port + ' — ' + (e.code ? e.code + (e.message ? ' · ' + e.message : '') : e.message), c.port)));
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

    attach(sock);
    if (c.port === 465) tlsReady = true;   // сертификат уже проверен в connectTo()
    handshake(true);
  });
}

/**
 * pkg3-136: «а сервер вообще слышно?» — быстрая проверка одного порта.
 * Нужна, когда в ответ на письмо приходит «соединение не установилось»:
 * без этого человек не понимает, ошибочный это адрес, закрытый порт или
 * что-то ещё. Учётные данные здесь не отправляются — только приветствие.
 * Сертификат не проверяем: мы не передаём ничего секретного.
 */
/** Один адрес: молчит ли порт и что он отвечает. Секретов здесь нет — только приветствие. */
function greetProbe(addr, port, ms, host) {
  return new Promise(resolve => {
    const started = Date.now();
    let sock = null, done = false, buf = '';
    const finish = (ok, detail) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (sock) { try { sock.destroy(); } catch (e) {} }
      resolve({ ok: !!ok, detail: String(detail || ''), ms: Date.now() - started });
    };
    const timer = setTimeout(() => finish(false, 'нет ответа за ' + (ms / 1000).toFixed(1) + ' с'), ms);
    try {
      sock = Number(port) === 465
        ? tls.connect({
            host: addr.address, port: Number(port), rejectUnauthorized: false,
            servername: isIpAddress(host) ? undefined : host
          })
        : net.connect(Number(port), addr.address);
    } catch (e) { return finish(false, e.code || e.message); }
    sock.setEncoding('utf8');
    sock.on('data', chunk => {
      buf += chunk;
      const m = /^(\d{3})([^\r\n]*)/m.exec(buf);
      if (m) finish(true, 'сервер ответил ' + m[1] + (m[2] ? ' · ' + m[2].trim() : ''));
    });
    sock.on('error', e => finish(false, e.code || e.message || 'сбой соединения'));
    sock.on('timeout', () => finish(false, 'молчит'));
  });
}

/**
 * pkg3-137: проверка порта по КАЖДОМУ адресу сервера (IPv4 первым).
 * Раньше «не ответил» был один на всех — и нельзя было понять, это сеть
 * хостера, неверное имя или сломанный IPv6 на самом сервере.
 */
async function probePort(host, port, timeoutMs) {
  const started = Date.now();
  const limit = Math.max(1200, Math.min(6000, Number(timeoutMs) || 3500));
  const mode = Number(port) === 465 ? 'SSL' : 'STARTTLS';
  const list = (await addresses(host)).slice(0, 4);
  const tried = [];
  if (!list.length) {
    return { port: Number(port), mode, ok: false, detail: 'имя не находится', ms: Date.now() - started, via: '', tried: [] };
  }
  const per = Math.max(1200, Math.floor(limit / list.length));
  for (const a of list) {
    const r = await greetProbe(a, Number(port), per, host);
    tried.push({ address: a.address, family: a.family, ok: r.ok, detail: r.detail, ms: r.ms });
    if (r.ok) {
      return { port: Number(port), mode, ok: true, detail: r.detail, ms: Date.now() - started, via: fmtAddr(a), tried };
    }
  }
  const detail = tried.length > 1
    ? tried.map(t => fmtAddr(t) + ': ' + t.detail).join('; ')
    : tried[0].detail;
  return { port: Number(port), mode, ok: false, detail, ms: Date.now() - started, via: '', tried };
}

/** Внешний IPv4 самого сервера — хос­теру нужен именно адрес, а не имя машины. */
function serverAddress() {
  // pkg3-139: на арендованном VPS адрес может быть не на интерфейсе (NAT, облако) —
  // тогда его можно задать руками: SEGA_SERVER_IP=1.2.3.4
  const env = String(process.env.SEGA_SERVER_IP || '').trim();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(env)) return env;
  try {
    const nets = require('os').networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const a of nets[name] || []) {
        if (a && a.family === 'IPv4' && !a.internal && !/^169\.254\./.test(a.address)) return a.address;
      }
    }
  } catch (e) {}
  return '';
}

/** «А интернет у сервера вообще есть?» — 443 до двух посторонних хостов. */
function tcpOpen(addr, port, ms) {
  return new Promise(resolve => {
    const started = Date.now();
    let sock = null, done = false;
    const finish = (ok, detail) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (sock) { try { sock.destroy(); } catch (e) {} }
      resolve({ ok: !!ok, detail: String(detail || ''), ms: Date.now() - started });
    };
    const timer = setTimeout(() => finish(false, 'нет ответа за ' + (ms / 1000).toFixed(1) + ' с'), ms);
    try { sock = net.connect(Number(port), addr.address); } catch (e) { return finish(false, e.code || e.message); }
    sock.once('connect', () => finish(true, 'отвечает'));
    sock.on('error', e => finish(false, e.code || e.message || 'сбой'));
  });
}

/**
 * pkg3-137: контрольная проверка сети — по HTTPS-порту 443 до посторонних
 * хостов. Если 443 открывается, а почтовые порты нет, то виноват не чат и не
 * пароль: закрыты именно почтовые порты. Это и есть аргумент для поддержки.
 */
async function probeNet(timeoutMs, targets) {
  const limit = Math.max(1000, Math.min(4000, Number(timeoutMs) || 2500));
  const list = targets && targets.length ? targets : [
    { target: '1.1.1.1:443', host: '1.1.1.1', port: 443 },
    { target: 'api.github.com:443', host: 'api.github.com', port: 443 }
  ];
  const items = await Promise.all(list.map(async t => {
    const started = Date.now();
    const name = t.target || (t.host + ':' + (t.port || 443));
    const addrs = await addresses(t.host);
    if (!addrs.length) return { target: name, ok: false, detail: 'имя не находится', ms: Date.now() - started };
    const r = await tcpOpen(addrs[0], t.port || 443, limit);
    return {
      target: name, ok: r.ok,
      detail: r.ok ? 'отвечает · ' + fmtAddr(addrs[0]) : r.detail,
      ms: Date.now() - started
    };
  }));
  return { ok: items.some(x => x.ok), items };
}

/**
 * pkg3-137: готовый текст в поддержку хостера. Владелец не должен сам
 * сочинять «у меня не работает почта»: в письме уже есть имя сервера, адреса,
 * порты, время ответа и что при этом работает.
 */
function supportTicket(c, dns, ports, net) {
  const L = [];
  const ip = serverAddress();
  let when = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' (UTC)';
  try { when = new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Yekaterinburg' }); } catch (e) {}
  L.push('Здравствуйте!');
  L.push('');
  // pkg3-139: хостеру нужны адрес сервера, дата и факты — иначе письмо читают
  // как «у меня что-то не работает» и отвечают «это не наша зона».
  L.push('С сервера (VPS ' + (require('os').hostname() || '') + (ip ? ', IP ' + ip : '') + ') не уходят письма:'
    + ' не открываются исходящие порты почтовых серверов.');
  L.push('Проверено ' + when + ' из самого чата SEGA-CHAT. Сервер почты: ' + c.host + ':' + c.port + '.');
  L.push('');
  if (dns && dns.ok) {
    L.push('Имя ' + c.host + ' находится: ' + (dns.addresses || []).map(fmtAddr).join(', '));
  } else {
    L.push('Имя ' + c.host + ' не находится (' + ((dns && dns.error) || '') + ')');
  }
  L.push('');
  (ports || []).forEach(p => {
    if (p.ok) { L.push('  ' + String(p.port) + ' (' + p.mode + ') — открыт: ' + p.detail); return; }
    // pkg3-139: по одному адресу на строку. Раньше адреса печатались дважды —
    // в самой ошибке и в квадратных скобках, и письмо выглядело как сбой программы.
    const refused = (p.tried || []).length > 0 && p.tried.every(t => /ECONNREFUSED/.test(t.detail));
    L.push('  ' + String(p.port) + ' (' + p.mode + ') — ' + (refused ? 'закрыт (сервер отказал в соединении)' : 'нет ответа'));
    (p.tried || []).forEach(t => L.push('      ' + fmtAddr(t) + ' — ' + t.detail));
  });
  const netItems = (net && net.items) || [];
  if (net && net.ok) {
    L.push('');
    L.push('Интернет при этом работает (значит, заблокированы именно почтовые порты):');
    netItems.forEach(i => L.push('  ' + i.target + ' — ' + (i.ok ? 'отвечает' : i.detail)));
  }
  L.push('');
  L.push('Пожалуйста, откройте исходящие TCP-порты 465 и 587 (если можно — и 25)'
    + (ip ? ' для адреса ' + ip : '') + ' к внешним серверам.');
  L.push('Если по правилам хостера это невозможно, подскажите, пожалуйста, ваш SMTP-релей:'
    + ' адрес, порт и нужен ли отдельный логин. Подойдёт и любой порт, кроме 25/465/587'
    + ' (например 2525), если у вас есть такой релей.');
  return L.join('\n');
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
 * pkg3-136/137: полная проверка почты — то, что видит владелец по кнопке
 * «Проверить почтовый сервер». Отвечает на вопрос «что именно не так»:
 *   • находит ли имя сервера (DNS) и по каким адресам;
 *   • отвечает ли вообще 465 (SSL), 587 (STARTTLS), 25 и порт из .env —
 *     отдельно по IPv4 и IPv6;
 *   • есть ли у сервера интернет (443 до посторонних хостов);
 *   • проходит ли вход с текущими логином и паролем (check());
 *   • готовый текст в поддержку хостера (ticket), если порты закрыты.
 * Возвращает { ok, config, dns, ports, net, steps, error, hint, advice, ticket }.
 * opts.netTargets — только для проверок: подменить внешние хосты на свои.
 */
async function checkAll(timeoutMs, opts) {
  const o = opts || {};
  const c = cfg();
  const conf = {
    host: c.host, port: c.port, configured: enabled(),
    from: c.from, user: c.user ? c.user.replace(/^(.)[^@]*/, '$1***') : ''
  };
  if (!enabled()) {
    return {
      ok: false, config: conf, dns: null, ports: [], net: { ok: false, items: [] }, steps: [],
      error: 'почта не настроена',
      hint: 'Задайте SEGA_SMTP_HOST, SEGA_SMTP_PORT, SEGA_SMTP_USER, SEGA_SMTP_PASS, SEGA_SMTP_FROM в .env и перезапустите службу.',
      advice: 'Без этих переменных кнопка привязки почты честно отвечает «почта не настроена».',
      ticket: ''
    };
  }
  const dns = await resolveHost(c.host);
  const probeMs = Math.min(Number(timeoutMs) || 3500, 4000);
  // проверяем и общепринятые порты, и тот, что задан в .env (бывает 2525 и другие)
  // pkg3-139: 2525 — обходной порт, который есть у SendGrid/Mailgun и подобных;
  // если хостер закрыл только 25/465/587, это единственный шанс остаться на SMTP
  const candidates = Array.from(new Set([465, 587, 25, 2525, Number(c.port) || 587]));
  // pkg3-137: порты и «есть ли интернет» — параллельно, чтобы кнопка не думала дольше
  const [ports, net] = await Promise.all([
    dns.ok ? Promise.all(candidates.map(p => probePort(c.host, p, probeMs))) : Promise.resolve([]),
    probeNet(Math.min(probeMs, 2500), o.netTargets)
  ]);
  const full = dns.ok ? await check(timeoutMs) : { ok: false, steps: [], error: 'имя сервера не найдено', hint: '' };
  const open = ports.filter(p => p.ok).map(p => p.port);
  const netOk = !!(net && net.ok);
  let advice = '';
  let hint = full.hint || '';
  let ticket = '';
  if (!dns.ok) {
    advice = 'Имя «' + c.host + '» не находится (' + (dns.error || '') + '). Проверьте SEGA_SMTP_HOST — например, smtp.yandex.ru.';
  } else if (!open.length) {
    // pkg3-137: раньше здесь был один и тот же совет. Теперь он зависит от того,
    // есть ли у сервера интернет вообще: это два разных разговора с хостером.
    advice = 'Ни 465, ни 587, ни 25 не отвечают — сервер почты недоступен с этого сервера. '
      + 'Чаще всего так бывает, когда хостер закрывает исходящую почту: напишите в поддержку '
      + '(Sprintbox и подобные) — готовый текст ниже, кнопка «Скопировать для поддержки».'
      + (netOk
          ? ' Сеть при этом жива (443 открывается), значит закрыты именно почтовые порты — дело не в пароле и не в настройках чата.'
          : ' Причём 443 не открывается тоже — тогда проверьте сеть и фаервол самого сервера.');
    hint = hint || 'Порты закрыты — это не ошибка настроек в чате, а сеть хостера.';
    ticket = supportTicket(c, dns, ports, net);
  } else if (!open.includes(c.port) && open.includes(2525)) {
    advice = 'Почтовые порты 25/465/587 закрыты, но 2525 отвечает. У SendGrid, Mailgun и подобных сервисов'
      + ' есть почта через порт 2525 — попросите у хостера релей или подключите такой сервис'
      + ' и поставьте в .env SEGA_SMTP_PORT=2525.';
  } else if (!open.includes(c.port)) {
    advice = 'На порту ' + c.port + ' сервер молчит, а отвечает на ' + open.join(' и ') + '. '
      + 'Поставьте в .env SEGA_SMTP_PORT=' + open[0] + (open[0] === 465 ? ' (это SSL, порт 587 — STARTTLS)' : '') + ' и перезапустите службу.';
  } else if (!full.ok) {
    advice = 'Порты открыты, значит дело не в сети. Смотрите шаги ниже и ответ сервера: ' + (full.error || '');
  } else {
    advice = 'Всё в порядке: сервер отвечает и вход принят — письма должны уходить.';
  }
  return {
    ok: !!full.ok, config: conf, dns, ports, net, steps: full.steps || [],
    error: full.error || '', hint, advice, ticket
  };
}

module.exports = { sendMail, enabled, check, checkAll, probePort, probeNet, resolveHost, hintFor, addresses, sortAddresses, serverAddress };
