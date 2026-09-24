'use strict';
/**
 * Хранение в Yandex Database (бессерверный режим, Document API).
 *
 * Данные разложены по мелким записям, чтобы облачная функция при запуске
 * читала считанные килобайты, а не всю переписку:
 *
 *   ('meta','root')            общие настройки, счётчики и присутствие
 *   ('user', <id>)             карточка участника (без аватара)
 *   ('av',   <id>)             аватар (зашифрован, качается отдельно)
 *   ('chat', <id>)             чат: состав, ключи, название
 *   ('cstat',<id>)             счётчики чата: сообщений, байт, последний seq
 *   ('sess', <токен>)          сессия
 *   ('m#<чат>', <seq>|<id>)    сообщение
 *   ('mid',  <id>)             указатель «сообщение -> чат» для быстрых ссылок
 *   ('arcidx',<файл>)          запись об архиве
 *   ('arc',  <файл>)           сам архив
 *
 * Длинные записи режутся на куски: <ключ>, <ключ>#1, <ключ>#2 …
 */

const crypto = require('crypto');
const { Ydb, YdbError, S, N, str, num } = require('./ydb');
const { emptyDb } = require('./model');

const CHUNK = 48000;               // символов в одном куске
const pad = (n) => String(Math.max(0, Math.floor(Number(n) || 0))).padStart(12, '0');
const msgSk = (m) => pad(m.seq) + '|' + m.id;
const K = (pk, sk) => ({ pk: S(pk), sk: S(sk) });

function createYdbStore(opts = {}) {
  const table = opts.table || process.env.YDB_TABLE || 'sega_chat';
  const ydb = opts.client || new Ydb(opts);
  const presenceEvery = Number(opts.presenceEvery || process.env.PRESENCE_EVERY || 60000);

  let db = null;                  // переживает вызовы функции, пока экземпляр «тёплый»
  let cache = { dv: -1, sv: -1 };
  let lastSeq = {};               // чат -> последний seq (чтобы не опрашивать пустое)
  let chunkK = new Map();         // сколько кусков у записи
  let loadedFull = new Set();
  let presence = {};              // uid -> { s: заходил, a: активен }
  let presenceWritten = 0;
  let snap = null;
  let pend = null;
  let opened = false;

  const fresh = () => ({
    dropMsg: [], dropChats: [], dropUsers: [], dropSessions: [],
    avatars: new Set(), presence: false, maxSeq: {}
  });
  const ck = (pk, sk) => pk + '\u0000' + sk;

  // ------------------------------------------------------------- куски
  function slice(text) {
    const out = [];
    for (let i = 0; i < text.length; i += CHUNK) out.push(text.slice(i, i + CHUNK));
    return out.length ? out : [''];
  }
  async function putDoc(pk, sk, obj, extra) {
    const parts = slice(JSON.stringify(obj));
    const prev = chunkK.get(ck(pk, sk)) || 1;
    await Promise.all(parts.map((p, i) => ydb.put(table, Object.assign(
      { pk: S(pk), sk: S(i ? sk + '#' + i : sk), d: S(p) },
      i === 0 ? Object.assign({ k: N(parts.length) }, extra || {}) : {}
    ))));
    for (let i = parts.length; i < prev; i++) await ydb.del(table, K(pk, sk + '#' + i)).catch(() => {});
    chunkK.set(ck(pk, sk), parts.length);
  }
  async function delDoc(pk, sk) {
    const k = chunkK.get(ck(pk, sk)) || 1;
    await ydb.del(table, K(pk, sk));
    for (let i = 1; i < k; i++) await ydb.del(table, K(pk, sk + '#' + i)).catch(() => {});
    chunkK.delete(ck(pk, sk));
  }
  /** Удалить запись, число кусков которой неизвестно. */
  async function delByPrefix(pk, prefix) {
    const items = await ydb.queryAll(table, {
      KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
      ExpressionAttributeValues: { ':p': S(pk), ':s': S(prefix) },
      ProjectionExpression: 'pk, sk'
    });
    for (const it of items) await ydb.del(table, K(pk, str(it.sk)));
    chunkK.delete(ck(pk, prefix));
  }
  function parseDocs(items, pk) {
    const docs = [];
    let cur = null;
    for (const it of items) {
      const sk = str(it.sk);
      const h = sk.lastIndexOf('#');
      const isPart = h > 0 && /^\d+$/.test(sk.slice(h + 1));
      if (isPart && cur && sk.slice(0, h) === cur.sk) {
        if (cur.parts.length < cur.k) cur.parts.push(str(it.d) || '');
        continue;
      }
      if (isPart) continue;                      // осиротевший кусок — пропускаем
      if (cur) docs.push(cur);
      cur = { sk, k: num(it.k) || 1, parts: [str(it.d) || ''], item: it };
    }
    if (cur) docs.push(cur);
    return docs.map(d => {
      if (pk) chunkK.set(ck(pk, d.sk), d.k);
      let value = null;
      try { value = JSON.parse(d.parts.join('')); } catch (e) { value = null; }
      return { sk: d.sk, item: d.item, value };
    }).filter(d => d.value !== null);
  }
  const queryPk = (pk, extra) => ydb.queryAll(table, Object.assign({
    KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': S(pk) }
  }, extra || {}));

  // ------------------------------------------------------------- отпечатки
  function userDoc(u) {
    const o = {};
    for (const k of Object.keys(u)) if (k !== 'avatar' && k !== 'lastSeen' && k !== 'activeAt') o[k] = u[k];
    return o;
  }
  const userFp = (u) => JSON.stringify(userDoc(u));
  const msgFp = (m) => `${m.seq}|${m.parent || ''}|${m.quote || ''}`;
  const coreFp = () => JSON.stringify({ v: db.version, c: db.createdAt, r: db.room, s: db.serverSecret });

  function takeSnapshot() {
    return {
      users: new Map(db.users.map(u => [u.id, userFp(u)])),
      chats: new Map(db.chats.map(c => [c.id, JSON.stringify(c)])),
      archives: new Set(db.archives.map(a => a.file)),
      sessions: new Map(),
      messages: new Map(),
      stats: new Map(Object.entries(db.stats.chats).map(([k, v]) => [k, Object.assign({}, v)])),
      core: coreFp(), seq: db.seq, gen: db.gen, dv: cache.dv, sv: cache.sv
    };
  }

  // ------------------------------------------------------------- загрузка
  async function initMeta() {
    const core = { version: 3, createdAt: Date.now(), room: null, serverSecret: crypto.randomBytes(32).toString('hex') };
    try {
      await ydb.put(table, { pk: S('meta'), sk: S('root'), d: S(JSON.stringify(core)), k: N(1), seq: N(0), gen: N(0), rev: N(0), dv: N(0), sv: N(0), pres: S('{}') },
        { ConditionExpression: 'attribute_not_exists(pk)' });
    } catch (e) {
      if (!(e instanceof YdbError) || !e.conditionFailed) throw e;
    }
    return (await ydb.get(table, K('meta', 'root'))).Item;
  }

  async function loadDirectory() {
    db.users = parseDocs(await queryPk('user'), 'user').map(d => d.value);
    db.chats = parseDocs(await queryPk('chat'), 'chat').map(d => d.value);
    db.archives = parseDocs(await queryPk('arcidx'), 'arcidx').map(d => d.value)
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  }

  async function loadStats() {
    const items = await queryPk('cstat');
    const chats = {}; let bytes = 0, count = 0;
    lastSeq = {};
    for (const it of items) {
      const id = str(it.sk);
      const rec = { n: num(it.n), b: num(it.b), t: num(it.t) };
      chats[id] = rec; lastSeq[id] = num(it.ls);
      bytes += rec.b; count += rec.n;
    }
    db.stats = { bytes, count, chats };
  }

  async function load() {
    pend = fresh();
    store.dirty = false;

    // таблицу не проверяем каждый раз: если её нет, база сама скажет об этом
    let m;
    try {
      m = (await ydb.get(table, K('meta', 'root'))).Item;
    } catch (e) {
      if (!e || !e.notFound) throw e;
      await ydb.ensureTable(table);
      opened = true;
      m = null;
    }
    if (!m) m = await initMeta();

    if (!db) db = emptyDb();
    const core = JSON.parse(str(m.d) || '{}');
    db.version = core.version || 3;
    db.createdAt = core.createdAt || Date.now();
    db.room = core.room || null;
    db.serverSecret = core.serverSecret || crypto.randomBytes(32).toString('hex');
    db.seq = num(m.seq);
    db.gen = num(m.gen);
    presence = JSON.parse(str(m.pres) || '{}');

    const dv = num(m.dv), sv = num(m.sv);
    if (process.env.YDB_DEBUG) console.error(`[ydb] load dv=${dv} cache=${cache.dv} sv=${sv}/${cache.sv}`);
    if (cache.dv !== dv) { await loadDirectory(); cache.dv = dv; }
    if (cache.sv !== sv) { await loadStats(); cache.sv = sv; }

    for (const u of db.users) {
      const p = presence[u.id] || {};
      u.lastSeen = p.s || 0; u.activeAt = p.a || 0;
      delete u.avatar;                       // подгружается по требованию
    }
    db.messages = [];
    db.sessions = {};
    loadedFull = new Set();
    snap = takeSnapshot();
    return db;
  }

  // ------------------------------------------------------------- сообщения по требованию
  function addMessages(list) {
    const known = new Set(db.messages.map(m => m.id));
    for (const m of list) {
      if (known.has(m.id)) continue;
      db.messages.push(m);
      snap.messages.set(m.id, msgFp(m));
    }
    db.messages.sort((a, b) => a.seq - b.seq);
  }

  async function loadSince(chatIds, since) {
    for (const id of chatIds) {
      if (loadedFull.has(id)) continue;
      if ((lastSeq[id] || 0) <= since) continue;
      const items = await ydb.queryAll(table, {
        KeyConditionExpression: 'pk = :p AND sk > :s',
        ExpressionAttributeValues: { ':p': S('m#' + id), ':s': S(pad(since) + '|~') }
      });
      addMessages(parseDocs(items, 'm#' + id).map(d => d.value));
      if (!since) loadedFull.add(id);
    }
  }

  async function loadChats(chatIds) {
    for (const id of chatIds) {
      if (loadedFull.has(id)) continue;
      addMessages(parseDocs(await queryPk('m#' + id), 'm#' + id).map(d => d.value));
      loadedFull.add(id);
    }
  }

  async function getMessage(id) {
    const ptr = (await ydb.get(table, K('mid', id))).Item;
    if (!ptr) return null;
    const chat = str(ptr.c), seq = num(ptr.s);
    const items = await ydb.queryAll(table, {
      KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
      ExpressionAttributeValues: { ':p': S('m#' + chat), ':s': S(pad(seq) + '|' + id) }
    });
    const docs = parseDocs(items, 'm#' + chat);
    if (!docs.length) return null;
    addMessages([docs[0].value]);
    return db.messages.find(m => m.id === id) || null;
  }

  // ------------------------------------------------------------- сохранение
  async function flush(cur) {
    db = cur;
    const jobs = [];
    let dirChanged = false, statsChanged = false;

    // участники
    for (const u of db.users) {
      if (snap.users.get(u.id) !== userFp(u)) { jobs.push(() => putDoc('user', u.id, userDoc(u))); dirChanged = true; }
    }
    for (const id of snap.users.keys()) {
      if (!db.users.some(u => u.id === id)) { jobs.push(() => delDoc('user', id)); dirChanged = true; }
    }
    for (const id of pend.dropUsers) {
      delete presence[id]; pend.presence = true;
      jobs.push(() => delByPrefix('av', id));
    }
    // аватары
    for (const u of pend.avatars) {
      jobs.push(() => u.avatar ? putDoc('av', u.id, { a: u.avatar }) : delByPrefix('av', u.id));
    }
    // чаты
    for (const c of db.chats) {
      if (snap.chats.get(c.id) !== JSON.stringify(c)) { jobs.push(() => putDoc('chat', c.id, c)); dirChanged = true; }
    }
    for (const id of snap.chats.keys()) {
      if (!db.chats.some(c => c.id === id)) { jobs.push(() => delDoc('chat', id)); dirChanged = true; }
    }
    // сессии
    for (const [t, s] of Object.entries(db.sessions)) {
      if (snap.sessions.get(t) !== JSON.stringify(s)) jobs.push(() => ydb.put(table, { pk: S('sess'), sk: S(t), d: S(JSON.stringify(s)), k: N(1) }));
    }
    for (const t of snap.sessions.keys()) if (!db.sessions[t]) jobs.push(() => ydb.del(table, K('sess', t)));
    for (const t of pend.dropSessions) if (!db.sessions[t]) jobs.push(() => ydb.del(table, K('sess', t)));
    // сообщения
    for (const m of db.messages) {
      const was = snap.messages.get(m.id);
      const fp = msgFp(m);
      if (was === undefined) {
        jobs.push(() => putDoc('m#' + m.chat, msgSk(m), m));
        jobs.push(() => ydb.put(table, { pk: S('mid'), sk: S(m.id), c: S(m.chat), s: N(m.seq) }));
        pend.maxSeq[m.chat] = Math.max(pend.maxSeq[m.chat] || 0, m.seq);
      } else if (was !== fp) {
        jobs.push(() => putDoc('m#' + m.chat, msgSk(m), m));
      }
    }
    for (const m of pend.dropMsg) {
      jobs.push(() => delDoc('m#' + m.chat, msgSk(m)));
      jobs.push(() => ydb.del(table, K('mid', m.id)));
    }
    for (const id of pend.dropChats) {
      jobs.push(async () => {
        const items = await queryPk('m#' + id, { ProjectionExpression: 'pk, sk' });
        for (const it of items) {
          const sk = str(it.sk);
          await ydb.del(table, K('m#' + id, sk));
          const base = sk.split('#')[0], mid = base.split('|')[1];
          if (mid && !sk.includes('#')) await ydb.del(table, K('mid', mid));
        }
      });
    }
    // архивы
    for (const a of db.archives) if (!snap.archives.has(a.file)) { jobs.push(() => putDoc('arcidx', a.file, a)); dirChanged = true; }
    // счётчики чатов
    for (const [id, curSt] of Object.entries(db.stats.chats)) {
      const was = snap.stats.get(id) || { n: 0, b: 0, t: 0 };
      const dn = curSt.n - was.n, dbytes = curSt.b - was.b;
      const ls = pend.maxSeq[id] || 0;
      if (!dn && !dbytes && curSt.t === was.t && !ls && snap.stats.has(id)) continue;
      statsChanged = true;
      const names = { '#n': 'n', '#b': 'b', '#t': 't' };
      const values = { ':dn': N(dn), ':db': N(dbytes), ':t': N(curSt.t || 0) };
      let expr = 'SET #t = :t';
      if (ls) { names['#ls'] = 'ls'; values[':ls'] = N(ls); expr += ', #ls = :ls'; }
      expr += ' ADD #n :dn, #b :db';
      jobs.push(() => ydb.update(table, K('cstat', id), {
        UpdateExpression: expr, ExpressionAttributeNames: names, ExpressionAttributeValues: values
      }));
      lastSeq[id] = Math.max(lastSeq[id] || 0, ls);
    }
    for (const id of snap.stats.keys()) {
      if (!db.stats.chats[id]) { jobs.push(() => ydb.del(table, K('cstat', id))); statsChanged = true; delete lastSeq[id]; }
    }
    for (const id of pend.dropChats) if (!db.stats.chats[id]) jobs.push(() => ydb.del(table, K('cstat', id)));

    await runAll(jobs);

    // общая запись: счётчики, настройки, присутствие
    const names = {}, values = {};
    const sets = [], adds = [];
    adds.push('#rev :one'); names['#rev'] = 'rev'; values[':one'] = N(1);
    if (coreFp() !== snap.core) {
      sets.push('#d = :d'); names['#d'] = 'd';
      values[':d'] = S(JSON.stringify({ version: db.version, createdAt: db.createdAt, room: db.room, serverSecret: db.serverSecret }));
    }
    if (db.seq !== snap.seq) { adds.push('#seq :dseq'); names['#seq'] = 'seq'; values[':dseq'] = N(db.seq - snap.seq); }
    if (db.gen !== snap.gen) { adds.push('#gen :dgen'); names['#gen'] = 'gen'; values[':dgen'] = N(db.gen - snap.gen); }
    if (dirChanged) { adds.push('#dv :one'); names['#dv'] = 'dv'; }
    if (statsChanged) { adds.push('#sv :one'); names['#sv'] = 'sv'; }
    const wantPresence = pend.presence && Date.now() - presenceWritten > presenceEvery;
    if (wantPresence) {
      for (const u of db.users) presence[u.id] = { s: u.lastSeen || 0, a: u.activeAt || 0 };
      sets.push('#pres = :pres'); names['#pres'] = 'pres'; values[':pres'] = S(JSON.stringify(presence));
      presenceWritten = Date.now();
    }
    const expr = (sets.length ? 'SET ' + sets.join(', ') + ' ' : '') + 'ADD ' + adds.join(', ');
    const r = await ydb.update(table, K('meta', 'root'), {
      UpdateExpression: expr, ExpressionAttributeNames: names, ExpressionAttributeValues: values,
      ReturnValues: 'UPDATED_NEW'
    });
    const back = r.Attributes || {};
    if (process.env.YDB_DEBUG) console.error(`[ydb] flush dir=${dirChanged} stats=${statsChanged} back=${JSON.stringify(back)} snap.dv=${snap.dv} users=${db.users.length}`);
    if (back.seq !== undefined) db.seq = num(back.seq);
    if (back.gen !== undefined) db.gen = num(back.gen);
    // если счётчик версии сдвинулся не только нами — при следующем запросе перечитаем
    cache.dv = dirChanged ? (num(back.dv) === snap.dv + 1 ? num(back.dv) : -1) : cache.dv;
    cache.sv = statsChanged ? (num(back.sv) === snap.sv + 1 ? num(back.sv) : -1) : cache.sv;
    snap = takeSnapshot();
    pend = fresh();
    store.dirty = false;
  }

  /** Выполнить задания небольшими пачками, чтобы не открывать сотни соединений. */
  async function runAll(jobs, width = 8) {
    for (let i = 0; i < jobs.length; i += width) {
      await Promise.all(jobs.slice(i, i + width).map(f => f()));
    }
  }

  // ------------------------------------------------------------- интерфейс
  const store = {
    name: 'ydb',
    dirty: false,
    table, client: ydb,

    async open() { await ydb.ensureTable(table); opened = true; },
    load, flush, loadSince, loadChats, getMessage,

    async getSession(token) {
      const it = (await ydb.get(table, K('sess', token))).Item;
      if (!it) return null;
      let v = null;
      try { v = JSON.parse(str(it.d)); } catch (e) { return null; }
      db.sessions[token] = v;
      snap.sessions.set(token, JSON.stringify(v));
      return v;
    },
    dropSession(token) { pend.dropSessions.push(token); },
    async loadSessions() {
      for (const d of parseDocs(await queryPk('sess'), 'sess')) {
        if (db.sessions[d.sk] === undefined) db.sessions[d.sk] = d.value;
        snap.sessions.set(d.sk, JSON.stringify(d.value));
      }
    },

    dropMessages(list) { for (const m of list) pend.dropMsg.push({ id: m.id, chat: m.chat, seq: m.seq }); },
    dropChat(chatId) { pend.dropChats.push(chatId); loadedFull.add(chatId); delete lastSeq[chatId]; },
    dropUser(id) { pend.dropUsers.push(id); },

    touchPresence(u, strong) {
      pend.presence = true;
      if (strong && Date.now() - presenceWritten > presenceEvery) store.dirty = true;
    },
    touchAvatar(u) { pend.avatars.add(u); },
    async loadAvatar(u) {
      if (u.avatar !== undefined && u.avatar !== null) return;
      const docs = parseDocs(await ydb.queryAll(table, {
        KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
        ExpressionAttributeValues: { ':p': S('av'), ':s': S(u.id) }
      }), 'av');
      u.avatar = docs.length ? (docs[0].value.a || null) : null;
    },

    async putArchive(file, text) { await putDoc('arc', file, { t: text }); },
    async getArchive(file) {
      const docs = parseDocs(await ydb.queryAll(table, {
        KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
        ExpressionAttributeValues: { ':p': S('arc'), ':s': S(file) }
      }), 'arc');
      const hit = docs.find(d => d.sk === file);
      return hit ? hit.value.t : null;
    },

    async close() {}
  };
  return store;
}

module.exports = { createYdbStore };
