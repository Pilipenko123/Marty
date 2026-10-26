/* pkg3-88: «умная вставка» для «Моей музыки».
 *
 * Человек копирует то, что дал ему сайт Яндекс.Музыки, — а сайты дают разное:
 * готовый «код плеера» (кусочек HTML с <iframe>), ссылку на трек/альбом/
 * плейлист/артиста, а то и просто адрес страницы другого музыкального сайта.
 * Этот модуль ОДИН раз разбирает вставленный текст и говорит приложению, что
 * именно в руках:
 *
 *   kind = 'widget' — из этого получается встроенный плеер Яндекс.Музыки
 *                     (поле url уже готово и безопасно: только music.yandex.ru);
 *   kind = 'file'   — прямая ссылка на аудиофайл, играется нашим плеером;
 *   kind = 'page'   — адрес СТРАНИЦЫ (или чужого плеера): играть нечего,
 *                     в hint лежит объяснение простыми словами;
 *   kind = 'none'   — в тексте нет ни ссылок, ни кода.
 *
 * Модуль «чистый»: ни сети, ни DOM, ни ключей — только разбор строки. Поэтому
 * его можно проверить тестом как обычную функцию (test/music88.mjs) и не
 * бояться, что он что-то куда-то отправит.
 *
 * Важно про приватность: ссылка на виджет хранится в плейлисте так же, как
 * обычная ссылка на файл, — в ПУБЛИЧНОМ плейлисте открыто, в плейлисте
 * «только я» внутри шифротекста. Сервер по-прежнему не видит содержимого
 * личных списков.
 */
(function (glob) {
  'use strict';

  const Y_HOST = 'music.yandex.ru';
  /** pkg3-89: зеркала домена Яндекс.Музыки. Ссылка из приложения или из другого
   * региона может прийти с них — понимаем её так же, как с основного домена,
   * но встроенный плеер собираем ВСЕГДА только на music.yandex.ru. */
  const Y_MIRRORS = ['m.music.yandex.ru', 'music.yandex.com', 'music.yandex.by', 'music.yandex.kz', 'music.yandex.uz'];
  /** Что Яндекс умеет показывать встроенным плеером. */
  const WHAT = { track: 'трек', album: 'альбом', playlist: 'плейлист', artist: 'артист' };
  /** Расширения, по которым ссылка похожа на сам файл, а не на страницу. */
  const AUDIO_EXT = /\.(mp3|m4a|m4b|aac|ogg|oga|opus|wav|wave|flac|webm)([?#]|$)/i;
  /** Сайты, откуда люди чаще всего приносят «нерабочие» ссылки-страницы. */
  const PAGE_HOSTS = [
    Y_HOST, 'vk.com', 'vk.ru', 'm.vk.com', 'ok.ru', 'youtube.com', 'm.youtube.com',
    'music.youtube.com', 'youtu.be', 'spotify.com', 'open.spotify.com', 'music.apple.com',
    'soundcloud.com', 'my.mail.ru', 'music.mail.ru', '101.ru', 'skysound.org',
    'hitmoz.org', 'ru.hitmoz.org', 'muzofond.fm', 'zvuки.com', 'zvuki.ru', 'rutube.ru',
    'audius.co', 'deezer.com', 'bandcamp.com', 't.me', 'telegram.me'
  ];
  /** Высота встроенного плеера по типу — чтобы не гадать пиксели вручную. */
  const FRAME_H = { track: 180, album: 480, playlist: 420, artist: 420 };

  /** Текст из буфера обмена приходит «грязным»: HTML-экранирование, неразрывные
   * пробелы, переносы. Приводим к виду, из которого уже можно доставать ссылки. */
  function clean(text) {
    return String(text === undefined || text === null ? '' : text)
      .replace(/&amp;/gi, '&')
      .replace(/&#0*38;/g, '&')
      .replace(/&#x26;/gi, '&')
      .replace(/\\u0026/gi, '&')
      .replace(/\\&/g, '&')
      .replace(/[\u00a0\u2007\u202f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Все src из тегов <iframe> в порядке появления (Яндекс даёт именно тег). */
  function iframeSrcs(html) {
    const out = [];
    const re = /<iframe\b[^>]*>/gi;
    let m;
    while ((m = re.exec(html))) {
      const s = /\bsrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(m[0]);
      if (!s) continue;
      const u = clean(s[2] || s[3] || s[4] || '');
      if (u) out.push(u);
    }
    return out;
  }

  /** Все http(s)-ссылки в тексте. Хвостовую пунктуацию («ссылка.») отрезаем. */
  function links(text) {
    const out = [];
    const re = /https?:\/\/[^\s"'<>()[\]]+/gi;
    let m;
    while ((m = re.exec(text))) {
      const u = m[0].replace(/[.,;:!?\u00bb\u201d]+$/, '');
      if (u) out.push(u);
    }
    return out;
  }

  function parts(u) {
    try {
      const p = new URL(u);
      if (p.protocol !== 'https:' && p.protocol !== 'http:') return null;
      return {
        url: p,
        host: p.hostname.toLowerCase().replace(/^www\./, ''),
        path: p.pathname.replace(/\/{2,}/g, '/'),
        hash: p.hash || '',
        https: p.protocol === 'https:'
      };
    } catch (e) {
      return null;
    }
  }

  const isYandex = p => !!p && (p.host === Y_HOST || Y_MIRRORS.indexOf(p.host) >= 0);

  /** Собрать канонический адрес встроенного плеера: только https, только
   * music.yandex.ru, только /iframe/ и только понятный тип. Всё остальное
   * (чужие домены, javascript:, данные в параметрах) отбрасывается — в разметку
   * приложения попадает лишь ссылка из этого белого списка. */
  function widgetUrl(what, ids, light) {
    if (!WHAT[what]) return null;
    const list = (ids || []).map(s => String(s).trim()).filter(s => s && /^[A-Za-z0-9_.@-]+$/.test(s));
    if (!list.length) return null;
    return 'https://' + Y_HOST + '/iframe/#' + what + '/' + list.join('/') + '/' + (light ? 'light/' : '');
  }

  /** Разобрать адрес, который уже ведёт на встроенный плеер (/iframe/#track/…). */
  function widgetFromIframe(p) {
    if (!isYandex(p) || !p.https) return null;
    const path = p.path.replace(/\/+$/, '');
    if (path !== '/iframe' && path.indexOf('/iframe/') !== 0) return null;
    // части могут лежать и за решёткой, и (реже) прямо в пути
    const raw = (p.hash ? p.hash.replace(/^#\/?/, '') : path.replace(/^\/iframe\/?/, ''));
    const segs = raw.split('/').map(s => s.split('?')[0]).filter(Boolean);
    if (!segs.length) return null;
    const what = segs[0].toLowerCase();
    if (!WHAT[what]) return null;
    const light = segs[segs.length - 1].toLowerCase() === 'light';
    const ids = segs.slice(1, light ? segs.length - 1 : segs.length).map(s => s.toLowerCase() === 'light' ? '' : s).filter(Boolean);
    const url = widgetUrl(what, ids, light);
    return url ? { what, ids, light, url } : null;
  }

  /** Обычная страница Яндекс.Музыки → тот же встроенный плеер.
   * /album/5736287/track/67063213 → трек; /playlist/sasha.pilipenko/1016 → плейлист. */
  function widgetFromPage(p) {
    if (!isYandex(p)) return null;
    const segs = p.path.split('/').filter(Boolean);
    if (!segs.length) return null;
    const a = segs[0].toLowerCase();
    const light = /(^|[?&\/])light(\/|$)/i.test(p.path + p.hash);
    if (a === 'album' && segs[1] && segs[2] === 'track' && segs[3]) {
      const url = widgetUrl('track', [segs[3]], light);
      return url ? { what: 'track', ids: [segs[3]], light, url, from: 'page' } : null;
    }
    if (a === 'album' && segs[1]) {
      const url = widgetUrl('album', [segs[1]], light);
      return url ? { what: 'album', ids: [segs[1]], light, url, from: 'page' } : null;
    }
    if (a === 'playlist' && segs[1] && segs[2]) {
      const url = widgetUrl('playlist', [segs[1], segs[2]], light);
      return url ? { what: 'playlist', ids: [segs[1], segs[2]], light, url, from: 'page' } : null;
    }
    // pkg3-89: «Поделиться» из приложения Яндекс.Музыки даёт адрес плейлиста
    // через /users/<логин>/playlists/<номер> — раньше он считался «страницей».
    if (a === 'users' && segs[1] && segs[2] === 'playlists' && segs[3]) {
      const url = widgetUrl('playlist', [segs[1], segs[3]], light);
      return url ? { what: 'playlist', ids: [segs[1], segs[3]], light, url, from: 'page' } : null;
    }
    if (a === 'artist' && segs[1]) {
      const url = widgetUrl('artist', [segs[1]], light);
      return url ? { what: 'artist', ids: [segs[1]], light, url, from: 'page' } : null;
    }
    if (a === 'track' && segs[1]) {
      const url = widgetUrl('track', [segs[1]], light);
      return url ? { what: 'track', ids: [segs[1]], light, url, from: 'page' } : null;
    }
    return null;
  }

  /** Человекочитаемое имя для подписи трека, если название не ввели. */
  function widgetTitle(w) {
    return 'Яндекс.Музыка · ' + (WHAT[w.what] || 'плеер');
  }

  function res(kind, extra) {
    return Object.assign({ kind, hint: '' }, extra || {});
  }

  /** Главная функция: что за текст вставили. */
  function parsePaste(text) {
    const t = clean(text);
    if (!t) return res('none', { hint: 'Поле пустое — вставьте код плеера или ссылку.' });

    // 1) «Код плеера» от Яндекс.Музыки — это <iframe src="…">
    if (/<iframe\b/i.test(t)) {
      const srcs = iframeSrcs(t);
      for (const s of srcs) {
        const w = widgetFromIframe(parts(s));
        if (w) return res('widget', { url: w.url, what: w.what, ids: w.ids, light: w.light, from: 'iframe', orig: s, title: widgetTitle(w), h: FRAME_H[w.what] || 200 });
      }
      const first = srcs.length ? parts(srcs[0]) : null;
      return res('page', {
        url: srcs[0] || '', host: first ? first.host : '',
        hint: srcs.length
          ? 'Это код плеера другого сайта (' + (first ? first.host : 'неизвестного') + '). SEGA-CHAT умеет встраивать только плеер Яндекс.Музыки — скопируйте «код плеера» именно там, либо добавьте прямую ссылку на файл (…/track.mp3).'
          : 'В тексте есть <iframe>, но адрес плеера найти не удалось. Скопируйте код целиком.'
      });
    }

    // 2) Ссылки в тексте
    const ls = links(t);
    if (!ls.length) {
      return res('none', { hint: 'В тексте нет ни ссылки, ни кода плеера. Вставьте адрес вида https://…' });
    }
    let firstPage = null, foreign = null;
    for (const u of ls) {
      const p = parts(u);
      if (!p) continue;
      if (!p.https) {
        if (!foreign) foreign = { host: p.host, note: 'http' };
        continue;
      }
      const w = widgetFromIframe(p) || widgetFromPage(p);
      if (w) return res('widget', { url: w.url, what: w.what, ids: w.ids, light: !!w.light, from: w.from === 'page' ? 'page' : 'link', orig: u, title: widgetTitle(w), h: FRAME_H[w.what] || 200 });
      if (AUDIO_EXT.test(p.path + p.hash)) return res('file', { url: u, host: p.host });
      if (isYandex(p)) {
        // страница Яндекса, из которой плеер не собирается (главная, поиск, «моё»)
        if (!firstPage) firstPage = { host: p.host, url: u, note: 'yandex-other' };
        continue;
      }
      if (!firstPage) firstPage = { host: p.host, url: u, note: PAGE_HOSTS.indexOf(p.host) >= 0 ? 'known' : 'other' };
    }
    if (foreign) {
      return res('page', {
        url: '', host: foreign.host,
        hint: 'Ссылка начинается с http:// — небезопасно. Откройте трек по https:// и скопируйте адрес заново.'
      });
    }
    if (firstPage) {
      const host = firstPage.host || 'сайта';
      const hint = firstPage.note === 'yandex-other'
        ? 'Это страница Яндекс.Музыки, из которой встроенный плеер не собирается (' + host + '). Откройте нужный трек, альбом или плейлист и возьмите «Поделиться → Код плеера» либо ссылку на трек.'
        : 'Это адрес СТРАНИЦЫ ' + host + ', а не музыкального файла: играть нечего. Нужен либо «код плеера» Яндекс.Музыки, либо прямая ссылка на файл (…/track.mp3, .ogg, .m4a).';
      return res('page', { url: firstPage.url, host, hint });
    }
    return res('none', { hint: 'Не удалось понять, что это за ссылка. Вставьте «код плеера» Яндекс.Музыки или прямую ссылку на файл.' });
  }

  /** Подпись для списка треков: «трек», «альбом», «плейлист», «артист». */
  function whatRu(what) { return WHAT[what] || 'плеер'; }

  const MP = { clean, iframeSrcs, links, parsePaste, widgetTitle, whatRu, widgetUrl, Y_HOST, Y_MIRRORS, WHAT, FRAME_H, AUDIO_EXT, PAGE_HOSTS };
  glob.MP = MP;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = MP;
  }
})(typeof window !== 'undefined' ? window : globalThis);
