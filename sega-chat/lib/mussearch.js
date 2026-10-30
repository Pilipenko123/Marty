'use strict';
/**
 * pkg3-97: «Поиск музыки» — сервер спрашивает выбранные владельцем сайты
 * о треках с ПРЯМЫМИ ссылками и отдаёт находки в окно «Моя музыка».
 *
 * Почему ищет сервер, а не браузер: чужие сайты запрещают страницам
 * обращаться к ним напрямую (CORS/защита), поэтому сервер открывает страницу
 * или официальный API сайта как обычный посетитель и выхватывает названия
 * и прямые ссылки на звуковые файлы. Сервер НИЧЕГО не хранит и не качает:
 * в плейлист ложатся только название и ссылка, звук идёт с источника.
 *
 * Адаптеры (по одному на сайт) пишутся вручную и ломаются от смены дизайна
 * сайта — это честная граница выпуска. Базы адресов переопределяются
 * переменными окружения (тесты подставляют игрушечные сайты).
 *
 * Внешних зависимостей нет: только встроенные модули Node (https, http).
 */

const fs = require('fs');
const http = require('http');
const https = require('https');
const { URL, URLSearchParams } = require('url');

const UA = 'SEGA-CHAT/97 (https://segachat.pilpro.ru; private messenger)';
const AUDIO_RE = /\.(mp3|ogg|oga|m4a|wav|flac)(\?|#|$)/i;

function cfg() {
  const trim = s => String(s || '').replace(/\/+$/, '');
  return {
    yapfiles: trim(process.env.MUSSEARCH_YAPFILES_BASE || 'https://www.yapfiles.ru'),
    archive: trim(process.env.MUSSEARCH_ARCHIVE_BASE || 'https://archive.org'),
    commons: trim(process.env.MUSSEARCH_COMMONS_BASE || 'https://commons.wikimedia.org'),
    openverse: trim(process.env.MUSSEARCH_OPENVERSE_BASE || 'https://api.openverse.org'),
    ccmixter: trim(process.env.MUSSEARCH_CCMIXTER_BASE || 'https://ccmixter.org'),
    jamendo: trim(process.env.MUSSEARCH_JAMENDO_BASE || 'https://api.jamendo.com')
  };
}

const SITES = [
  { id: 'yapfiles', title: 'yapfiles.ru' },
  { id: 'archive', title: 'archive.org' },
  { id: 'commons', title: 'commons.wikimedia.org' },
  { id: 'openverse', title: 'openverse (CC-аудио)' },
  { id: 'ccmixter', title: 'ccMixter (CC)' },
  { id: 'jamendo', title: 'Jamendo (CC)' },
  { id: 'audiobooks', title: 'Аудиокниги (ru)' },
  { id: 'podcasts', title: 'Подкасты (RSS)' }
];

function get(url, timeout) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('Плохой адрес')); }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return reject(new Error('Только https/http'));
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, { headers: { 'User-Agent': UA, Accept: '*/*' }, timeout: Number(timeout || 9000) }, res => {
      const chunks = [];
      let size = 0;
      res.on('data', c => {
        size += c.length;
        if (size > 3 * 1024 * 1024) { req.destroy(); reject(new Error('Слишком большой ответ')); }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => { req.destroy(new Error('Сайт не отвечает (таймаут)')); });
    req.on('error', e => reject(new Error('Сайт не отвечает: ' + (e.message || e))));
    req.end();
  });
}
async function getJSON(url, timeout) {
  const r = await get(url, timeout);
  // pkg3-99: 429/403 — сайт просит притормозить; помечаем это особым текстом,
  // чтобы поиск поставил сайт «на отдых» и не долбил его дальше
  if (r.status === 429 || r.status === 403) throw new Error('Сайт попросил подождать (' + r.status + ')');
  if (r.status !== 200) throw new Error('Сайт ответил ' + r.status);
  try { return JSON.parse(r.text); } catch (e) { throw new Error('Сайт ответил не JSON'); }
}
/** pkg3-99: «отдых» сайта после его «подождите»: 5 минут не спрашиваем вовсе. */
const siteRest = new Map();   // siteId -> timestamp до которого молчим
const REST_MS = Number(process.env.MUSSEARCH_REST_MS || 5 * 60 * 1000);
const clean = s => String(s || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

/** Интернет-архив: официальный API поиска + метаданные набора файлов. */
async function searchArchive(q, conf, limit) {
  const qs = new URLSearchParams({
    q: 'mediatype:(audio) AND ' + q,
    rows: String(limit), page: '1', output: 'json'
  });
  qs.append('fl[]', 'identifier'); qs.append('fl[]', 'title');
  const j = await getJSON(conf.archive + '/advancedsearch.php?' + qs.toString());
  const docs = ((j || {}).response || {}).docs || [];
  const out = [];
  for (const d of docs.slice(0, limit)) {
    const ident = String(d.identifier || '');
    if (!ident || /[/"'?#]/.test(ident)) continue;
    try {
      const m = await getJSON(conf.archive + '/metadata/' + ident);
      const files = Array.isArray(m.files) ? m.files : [];
      const f = files.find(x => AUDIO_RE.test(String(x.name || ''))) || null;
      if (!f) continue;
      out.push({
        site: 'archive',
        title: clean(d.title || f.name || ident).slice(0, 120) || ident,
        url: conf.archive + '/download/' + ident + '/' + encodeURI(String(f.name)),
        cover: conf.archive + '/download/' + ident + '/__ia_thumb.jpg',   // pkg3-98: миниатюра набора (может не быть — клиент скроет)
        size: Number(f.size) || 0
      });
    } catch (e) { /* один набор не открылся — не беда, идём дальше */ }
    if (out.length >= limit) break;
  }
  return out;
}

/** Викимедиа Коммонс: официальный API, пакетное чтение прямых ссылок. */
async function searchCommons(q, conf, limit) {
  const qs = new URLSearchParams({
    action: 'query', list: 'search', srsearch: q + ' filetype:audio',
    srnamespace: '6', format: 'json', srlimit: String(limit)
  });
  const j = await getJSON(conf.commons + '/w/api.php?' + qs.toString());
  const hits = ((j || {}).query || {}).search || [];
  if (!hits.length) return [];
  const titles = hits.map(h => String(h.title || '')).filter(Boolean).slice(0, limit);
  const q2 = new URLSearchParams({
    action: 'query', prop: 'imageinfo', iiprop: 'url|size|thumburl', iiurlwidth: '96',
    titles: titles.join('|'), format: 'json'
  });
  const j2 = await getJSON(conf.commons + '/w/api.php?' + q2.toString());
  const pages = (((j2 || {}).query || {}).pages) || {};
  const out = [];
  for (const k of Object.keys(pages)) {
    const p = pages[k];
    const ii = (p.imageinfo || [])[0];
    const url = ii && String(ii.url || '');
    if (!url || !AUDIO_RE.test(url)) continue;
    out.push({
      site: 'commons',
      title: clean(String(p.title || '').replace(/^File:/, '')).slice(0, 120) || 'файл Викимедиа',
      url: url,
      cover: String(ii.thumburl || ''),   // pkg3-98: миниатюра 96 px, если у файла есть обложка
      size: Number(ii.size) || 0
    });
  }
  return out;
}

/** pkg3-100: файл ключа Jamendo {"client_id":"…"}; читаем на каждый поиск,
 * как и ключи Яндекса: положили файл — заработало без перезапуска. */
function loadJamKeys(conf) {
  const p = String(process.env.JAMENDO_KEYS || '/opt/sega/keys/jamendo.json');
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const id = String(j.client_id || j.clientId || j.id || '').trim();
    return id || null;
  } catch (e) { return null; }
}

/** Jamendo: официальный API, полноразмерное прослушивание и обложки альбомов. */
async function searchJamendo(q, conf, lim) {
  const key = loadJamKeys(conf);
  if (!key) throw new Error('ключи Jamendo не положены (файл /opt/sega/keys/jamendo.json)');
  const qs = new URLSearchParams({
    client_id: key, format: 'json', limit: String(lim), search: q,
    imagesize: '100', fields: 'audio,image,name,album_name,artist_name'
  });
  const j = await getJSON(conf.jamendo + '/v3.0/tracks/?' + qs.toString());
  const res = Array.isArray((j || {}).results) ? j.results : [];
  const out = [];
  for (const t of res) {
    const url = String(t.audio || '');
    if (!/^https?:\/\//i.test(url)) continue;
    const who = clean(t.artist_name || '');
    const nm = clean(t.name || '');
    out.push({
      site: 'jamendo',
      title: ((who ? who + ' — ' : '') + (nm || 'трек')).slice(0, 120),
      url: url,
      cover: String(t.image || ''),
      size: 0
    });
    if (out.length >= lim) break;
  }
  return out;
}

/** pkg3-104: РУССКИЕ АУДИОКНИГИ — официальный API Интернет-архива с прицелом
 * на начитки: коллекции LibriVox (librivoxaudio + книжный audio_bookspoetry) плюс всё
 * звуковое с языком rus и меткой «аудиокнига» (по живому API: 79 против 1436 наборов).
 * Живьём проверено две беды pkg3-103: (1) коллекции librivoxaudiobooks не существует —
 * настоящая librivoxaudio; (2) Solr матчит ЦЕЛЫЕ токены, поэтому «че» не находило
 * «Человек в футляре». Теперь ищем префиксом со звёздочкой (title:(че*)) и сразу в двух
 * азбуках: автор в каталоге LibriVox часто латиницей («Anton Chekhov»), а книга
 * кириллицей. why:'tag' — как у ccMixter: совпадение уже найдено поиском архива,
 * а в названии дорожки слова запроса может не быть (ищем по автору). */
const TRANSLIT = { 'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'e','ж':'zh','з':'z','и':'i','й':'y','к':'k','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r','с':'s','т':'t','у':'u','ф':'f','х':'kh','ц':'ts','ч':'ch','ш':'sh','щ':'shch','ъ':'','ы':'y','ь':'','э':'e','ю':'yu','я':'ya' };
const TRANSLIT_ALT = { 'е':'ye','ё':'yo','и':'y','ю':'u','я':'a','й':'i' };   // спорные буквы на начале слова: «Егор» = Egor или Yegor
function translitVariants(w) {
  const one = ch => (TRANSLIT[ch] !== undefined ? TRANSLIT[ch] : ch);
  const out = [Array.from(w).map(one).join('')];
  if (TRANSLIT_ALT[w[0]]) out.push(TRANSLIT_ALT[w[0]] + Array.from(w.slice(1)).map(one).join(''));
  return out.filter(Boolean);
}
async function searchAudiobooks(q, conf, limit) {
  const toks = String(q).toLowerCase().split(/[^a-zа-яё0-9]+/i).filter(t => t.length >= 2).slice(0, 4);
  if (!toks.length) return [];
  const clauses = [];
  for (const t of toks) {
    const vars = new Set([t]);
    if (/[а-яё]/.test(t)) for (const v of translitVariants(t)) vars.add(v);
    for (const v of vars) { clauses.push('title:(' + v + '*)'); clauses.push('creator:(' + v + '*)'); }
  }
  const qs = new URLSearchParams({
    q: '((collection:(librivoxaudio OR audio_bookspoetry) AND language:(rus)) OR (mediatype:(audio) AND language:(rus) AND subject:(аудиокниг*))) AND (' + clauses.join(' OR ') + ')',
    rows: '6', page: '1', output: 'json'
  });
  qs.append('fl[]', 'identifier'); qs.append('fl[]', 'title');
  const j = await getJSON(conf.archive + '/advancedsearch.php?' + qs.toString());
  const docs = ((j || {}).response || {}).docs || [];
  const out = [];
  for (const d of docs) {
    const ident = String(d.identifier || '');
    if (!ident || /[/"'?#]/.test(ident)) continue;
    try {
      const m = await getJSON(conf.archive + '/metadata/' + ident);
      const files = (Array.isArray(m.files) ? m.files : []).filter(x => AUDIO_RE.test(String(x.name || '')));
      if (!files.length) continue;
      const meta = m.metadata || {};
      const book = clean(meta.title || d.title || ident).slice(0, 80);
      const author = clean(typeof meta.creator === 'string' ? meta.creator : (Array.isArray(meta.creator) ? meta.creator[0] : '')).slice(0, 60);
      const base = (author ? author + ' — ' : '') + book;
      // главы берём полегче: _64kb/_128kb — производные копии архива, труба их тянет быстрее
      const light = f => /_(64kb|128kb|vbr)\./i.test(String(f.name || ''));
      const ordered = files.filter(light).concat(files.filter(f => !light(f)));
      for (const f of ordered.slice(0, 2)) {
        out.push({
          site: 'audiobooks',
          why: 'tag',
          title: (files.length > 1 ? base + ' — ' + clean(String(f.name || '').replace(AUDIO_RE, '')) : base).slice(0, 160),
          url: conf.archive + '/download/' + ident + '/' + encodeURI(String(f.name)),
          cover: conf.archive + '/download/' + ident + '/__ia_thumb.jpg',
          size: Number(f.size) || 0
        });
        if (out.length >= limit) break;
      }
    } catch (e) { /* одна книга не открылась — идём дальше */ }
    if (out.length >= limit) break;
  }
  return out;
}

/** pkg3-103: файл лент подкастов {"feeds":[{"title":"…","url":"https://…/feed"}]}:
 * владелец кидает туда RSS любимых передач (инструкция pkg3-103), сервер читает
 * файл на каждый поиск, как ключи Jamendo. Лент нет — источник честно «отдыхает». */
/** pkg3-105 (вариант В, согласован): пока владелец не положил свой файл лент,
 * работает проверенная лента по умолчанию (radio-t.com/podcast.rss: отвечает
 * 200, application/rss+xml). Файл /opt/sega/keys/podcasts.json УВАЖАЕТСЯ всегда:
 * есть и читается — работает он (даже пустой список = владелец выключил всё),
 * нет файла или не читается — лента по умолчанию. */
const DEFAULT_POD_FEEDS = [{ title: 'Радио-Т', url: 'https://radio-t.com/podcast.rss' }];
function podFeedsPath() { return String(process.env.PODCAST_FEEDS || '/opt/sega/keys/podcasts.json'); }
function parsePodFeeds(text) {
  let j = null;
  try { j = JSON.parse(text); } catch (e) { return null; }
  const list = Array.isArray(j) ? j : (Array.isArray(j.feeds) ? j.feeds : null);
  if (!list) return null;
  return list
    .map(x => ({ title: clean(x && x.title ? x.title : ''), url: String((x && x.url) || '').trim() }))
    .filter(x => /^https?:\/\//i.test(x.url))
    .slice(0, 12);
}
function loadPodFeeds(conf) {
  let text = null;
  try { text = fs.readFileSync(podFeedsPath(), 'utf8'); } catch (e) { text = null; }
  if (text !== null) {
    const list = parsePodFeeds(text);
    if (list) return list;   // файл есть и читается: он главный (даже пустой)
  }
  return DEFAULT_POD_FEEDS.map(x => Object.assign({}, x));
}
function hasFeeds() { return loadPodFeeds(cfg()).length > 0; }
/** pkg3-105: что сейчас работает и откуда (для «⋯» владельца): ленты + источник. */
function podFeedsInfo() {
  let text = null;
  try { text = fs.readFileSync(podFeedsPath(), 'utf8'); } catch (e) { text = null; }
  const fromFile = text !== null && parsePodFeeds(text) !== null;
  return { feeds: loadPodFeeds(cfg()), source: fromFile ? 'file' : 'default', path: podFeedsPath() };
}
/** pkg3-105: владелец правит ленты из «⋯» — сервер пишет тот же файл (права 600).
 * Пустой список = владелец выключил подкасты вовсе (файл с пустыми лентами). */
function savePodFeeds(list) {
  const feeds = (Array.isArray(list) ? list : [])
    .map(x => ({ title: clean(x && x.title ? x.title : ''), url: String((x && x.url) || '').trim() }))
    .filter(x => /^https?:\/\//i.test(x.url))
    .slice(0, 12);
  const p = podFeedsPath();
  try { fs.mkdirSync(require('path').dirname(p), { recursive: true }); } catch (e) {}
  fs.writeFileSync(p, JSON.stringify({ feeds: feeds }) + '\n', { mode: 0o600 });
  try { fs.chmodSync(p, 0o600); } catch (e) {}
  return feeds;
}
/** pkg3-105: хозяева звука подкастов, которых сервер САМ увидел в лентах.
 * Сеть владельца может держать подкаст-хостинг закрытым (как однажды Jamendo),
 * поэтому у звука есть запасной путь через сервер. Но сервер НЕ открытый прокси:
 * труба пускает лишь хозяев, которые реально пришли в <enclosure> прочитанных
 * лент (файл /opt/sega/keys/podcasts.json кладёт владелец, лента по умолчанию —
 * в коде). Запись живёт 72 часа, потолок 500 хозяев — старая вытесняется. */
const POD_HOST_TTL = 72 * 3600 * 1000;
const podHosts = new Map();
function rememberPodHost(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    if (!h) return;
    podHosts.set(h, Date.now() + POD_HOST_TTL);
    if (podHosts.size > 500) podHosts.delete(podHosts.keys().next().value);
  } catch (e) { /* кривая ссылка — не запоминаем */ }
}
/** Пускает ли труба этого хозяина как подкаст-хост (см. lib/musstream.js). */
function podHostOk(host) {
  const h = String(host || '').toLowerCase();
  const exp = podHosts.get(h);
  if (!exp) return false;
  if (exp < Date.now()) { podHosts.delete(h); return false; }
  return true;
}
const XML_ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'" };
const unxml = s => String(s).replace(/&[a-z#0-9]+;/gi, m => XML_ENT[m] !== undefined ? XML_ENT[m] : m);
/** Подкасты и интервью: RSS — стандартный формат, не соскабливание сайта:
 * из каждого <item> берём <title> и <enclosure url=…> с типом audio. */
async function searchPodcasts(q, conf, limit) {
  const feeds = loadPodFeeds(conf);
  if (!feeds.length) throw new Error('ленты подкастов не положены (файл /opt/sega/keys/podcasts.json)');
  const out = [];
  for (const f of feeds) {
    let text = '';
    try { text = (await get(f.url)).text; } catch (e) { continue; }   // лента молчит — не беда, другие работают
    const items = text.split(/<item[\s>]/i).slice(1);
    for (const it of items) {
      const em = it.match(/<enclosure\b[^>]*>/i);
      if (!em) continue;
      const tag = em[0];
      if (!/type=["']audio\//i.test(tag) && !AUDIO_RE.test(tag)) continue;
      const um = tag.match(/url=["']([^"']+)["']/i);
      if (!um) continue;
      const url = unxml(um[1]);
      if (!/^https:\/\//i.test(url)) continue;
      rememberPodHost(url);   // pkg3-105: труба узнаёт хозяина звука из ленты
      const tm = it.match(/<title[^>]*>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/title>/i);
      const ep = clean(unxml(tm ? tm[1] : ''));
      out.push({
        site: 'podcasts',
        title: ((f.title ? f.title + ' — ' : '') + (ep || 'выпуск')).slice(0, 120),
        url: url,
        cover: '',
        size: 0
      });
      if (out.length >= limit) break;
    }
    if (out.length >= limit) break;
  }
  return out;
}

/** ccMixter: официальный API сообщества CC-музыкантов, прямые download_url. */
async function searchCcmixter(q, conf, limit) {
  const qs = new URLSearchParams({ f: 'json', p: 'tags', tags: q, limit: String(limit) });
  const j = await getJSON(conf.ccmixter + '/api/query?' + qs.toString());
  const items = Array.isArray(j) ? j : [];
  const out = [];
  for (const it of items) {
    const f = ((it || {}).files || [])[0] || {};
    const url = String(f.download_url || '');
    if (!/^https:\/\//i.test(url) || !AUDIO_RE.test(url)) continue;
    const who = clean(it.user_name || '');
    out.push({
      site: 'ccmixter',
      title: (clean(it.upload_name || f.file_name || url) + (who ? ' — ' + who : '')).slice(0, 120),
      url: url,
      cover: '',
      size: Number(f.file_rawsize) || 0,
      why: 'tag'   // pkg3-99: ccMixter ищет по тегам: в названии слова запроса
                   // может не быть, но трек релевантен — фильтр это уважает
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** Openverse: официальный API CC-аудио, прямые ссылки на файлы. */
async function searchOpenverse(q, conf, limit) {
  const qs = new URLSearchParams({ q: q, page_size: String(limit) });
  const j = await getJSON(conf.openverse + '/v1/audio/?' + qs.toString());
  const res = Array.isArray((j || {}).results) ? j.results : [];
  const out = [];
  for (const r of res) {
    const url = String(r.url || '');
    if (!/^https:\/\//i.test(url)) continue;
    out.push({
      site: 'openverse',
      title: clean(r.title || url).slice(0, 120),
      url: url,
      cover: String(r.thumbnail || ''),   // pkg3-98: обложка из API
      size: 0
    });
  }
  return out;
}

/** yapfiles.ru: страница поиска → страницы файлов → прямая ссылка на mp3. */
async function searchYapfiles(q, conf, limit) {
  const page = await get(conf.yapfiles + '/search/?q=' + encodeURIComponent(q));
  if (page.status !== 200) throw new Error('Сайт ответил ' + page.status);
  const html = String(page.text || '');
  const out = [];
  // вдруг прямые ссылки видны уже на странице поиска
  for (const m of html.matchAll(/https?:\/\/[a-z0-9.-]*yapfiles\.[a-z]{2,}[^"'\s<>]*?\.(?:mp3|ogg|m4a|wav)/gi)) {
    out.push({ site: 'yapfiles', title: 'yapfiles: ' + decodeURIComponent(m[0].split('/').pop()).slice(0, 100), url: m[0], size: 0 });
    if (out.length >= limit) return out;
  }
  const pages = [];
  for (const m of html.matchAll(/href="((?:\/(?:files|file)\/\d+[^"'\s<>]*))"/gi)) {
    const u = conf.yapfiles + m[1];
    if (!pages.includes(u)) pages.push(u);
    if (pages.length >= limit) break;
  }
  for (const pu of pages) {
    try {
      const fp = await get(pu);
      if (fp.status !== 200) continue;
      const fhtml = String(fp.text || '');
      let direct = '';
      const m1 = fhtml.match(/https?:\/\/[a-z0-9.-]*yapfiles\.[a-z]{2,}[^"'\s<>]*?\.(?:mp3|ogg|m4a|wav)/i);
      if (m1) direct = m1[0];
      else {
        const m2 = fhtml.match(/href="([^"]+\.(?:mp3|ogg|m4a|wav))"/i);
        if (m2) direct = /^https?:/i.test(m2[1]) ? m2[1] : conf.yapfiles + m2[1];
      }
      if (!direct) continue;
      const mt = fhtml.match(/<title>([^<]*)<\/title>/i);
      const og = fhtml.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i) || fhtml.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:image"/i);
      const anchor = fhtml.match(new RegExp('title="([^"]{3,120})"[^>]*href="' + pu.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(conf.yapfiles.length) + '"'));
      const title = clean((anchor && anchor[1]) || (mt && mt[1]) || '').replace(/\s*[-|·]\s*yapfiles.*$/i, '').slice(0, 120);
      out.push({ site: 'yapfiles', title: title || 'yapfiles: ' + direct.split('/').pop().slice(0, 80), url: direct, cover: og ? String(og[1]) : '', size: 0 });
    } catch (e) { /* страница файла не открылась — пропускаем */ }
    if (out.length >= limit) break;
  }
  return out;
}

const ADAPTERS = { yapfiles: searchYapfiles, archive: searchArchive, commons: searchCommons, openverse: searchOpenverse, ccmixter: searchCcmixter, jamendo: searchJamendo, audiobooks: searchAudiobooks, podcasts: searchPodcasts };

const cache = new Map();   // q+'|'+sites -> { ts, payload }
const CACHE_TTL = Number(process.env.MUSSEARCH_CACHE_MS || 600000);

/** Поиск по выбранным сайтам: { results, sites } — параллельно, с кэшем 10 мин. */
async function search(q, siteIds, limit) {
  const conf = cfg();
  const lim = Math.min(20, Math.max(1, Number(limit) || 8));
  const ids = (Array.isArray(siteIds) && siteIds.length ? siteIds : SITES.map(s => s.id)).filter(id => ADAPTERS[id]);
  const key = String(q).toLowerCase() + '|' + ids.join(',') + '|' + lim;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return hit.payload;
  const now0 = Date.now();
  const active = ids.filter(id => !(siteRest.get(id) > now0));
  const resting = ids.filter(id => siteRest.get(id) > now0);
  const settled = await Promise.allSettled(active.map(id => ADAPTERS[id](String(q), conf, lim)));
  const results = [];
  const seen = new Set();
  const siteStatus = [];
  for (const id of resting) siteStatus.push({ id: id, ok: false, error: 'отдыхает: сайт просил подождать, повторим через несколько минут' });
  settled.forEach((r, i) => {
    const id = active[i];
    if (r.status === 'fulfilled') {
      siteStatus.push({ id: id, ok: true });
      for (const x of r.value || []) {
        if (!x || !x.url || seen.has(x.url)) continue;
        seen.add(x.url);
        results.push(x);
      }
    } else {
      const msg = String((r.reason && r.reason.message) || r.reason || 'сайт не ответил').slice(0, 80);
      if (/попросил подождать/.test(msg)) siteRest.set(id, Date.now() + REST_MS);   // pkg3-99: отдых
      siteStatus.push({ id: id, ok: false, error: msg });
    }
  });
  // pkg3-98: сайты ищут не только по названию (теги, описания, «похожее»),
  // поэтому находки фильтруем и сортируем по совпадению НАЗВАНИЯ со словами
  // запроса: все слова в названии — первыми, хотя бы одно — следом,
  // совсем не совпавшие — не показываем вовсе.
  const toks = String(q).toLowerCase().split(/[^a-zа-яё0-9]+/i).filter(t => t.length >= 2);
  const low = x => String((x && x.title) || '').toLowerCase();
  const score = x => !toks.length ? 1 : toks.every(t => low(x).includes(t)) ? 2 : toks.some(t => low(x).includes(t)) ? 1 : (x.why === 'tag' ? 1 : 0);
  const relevant = results.filter(x => score(x) > 0);
  relevant.sort((a, b) => score(b) - score(a));
  const payload = { results: relevant.slice(0, 30), sites: siteStatus };
  cache.set(key, { ts: Date.now(), payload: payload });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return payload;
}

/** pkg3-100: положен ли ключ Jamendo (только да/нет, без секрета) — для /api/state. */
function hasKeys() { return !!loadJamKeys(cfg()); }

module.exports = { SITES, search, cfg, AUDIO_RE, hasKeys, hasFeeds, podHostOk, podFeedsInfo, savePodFeeds };
