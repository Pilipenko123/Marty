'use strict';
/**
 * Переезд базы из облачного формата в домашний (pkg3-51).
 *
 * Резервная копия, сделанная сервером на Yandex Database, внутри держит
 * «сырые строки таблицы» (pk, sk, куски d). Файловому серверу (VPS) нужен
 * обычный db.json плюс соседние файлы (архивы, фоны, иконки, куски вложений).
 * Этот модуль собирает из строк ровно то, что умеет восстанавливать
 * файловое хранилище: { db, files }.
 *
 * Секреты и ключи переезжают вместе с базой (они внутри зашифрованного
 * слепка), поэтому после переезда основной сервер продолжает понимать
 * все прежние сообщения участников.
 */

const { emptyDb } = require('./model');

/** Значения колонок приходят обёрнутыми, как в Document API: {S:'…'} / {N:1}. */
const str = (v) => (v && v.S !== undefined ? String(v.S) : v && v.N !== undefined ? String(v.N) : '');
const num = (v) => (v && v.N !== undefined ? Number(v.N) : v && v.S !== undefined ? Number(v.S) : 0);

/**
 * Собрать документы из строк с кусками: sk вида «имя» или «имя#2».
 * Порядок строк из копии произвольный — куски расставляем по номерам.
 * Возвращает Map: sk -> значение (разобранный JSON) либо колонки строки.
 */
function assembleDocs(rows) {
  const map = new Map();
  for (const r of rows) {
    const sk = String(r.sk || '');
    const h = sk.lastIndexOf('#');
    // хвост «#1», «#2» — это куски; а вот «#0» куском не бывает (нумерация
    // кусков с единицы): у вложений такой хвост — часть собственного имени
    // («up-ид-номер»), поэтому его не отрезаем
    const tail = h > 0 ? sk.slice(h + 1) : '';
    const isPart = h > 0 && /^\d+$/.test(tail) && Number(tail) >= 1;
    const base = isPart ? sk.slice(0, h) : sk;
    const idx = isPart ? Number(sk.slice(h + 1)) : 0;
    let d = map.get(base);
    if (!d) { d = { k: 1, parts: new Map(), item: r.item }; map.set(base, d); }
    if (idx === 0) { d.k = num((r.item || {}).k) || 1; d.item = r.item; }
    d.parts.set(idx, str((r.item || {}).d));
  }
  const out = new Map();
  for (const [sk, d] of map) {
    if (!d.parts.has(0)) continue;                 // осиротевшие куски без головы — мимо
    let text = '';
    for (let i = 0; i < d.k; i++) text += d.parts.get(i) || '';
    let value = null;
    try { value = JSON.parse(text); } catch (e) { value = null; }
    out.set(sk, { value, item: d.item });
  }
  return out;
}

/**
 * @param {Array<{pk:string, sk:string, item:object}>} rows строки из копии
 * @returns {{db: object, files: object, stats: object}} начинка для restoreFiles
 */
function rowsToPayload(rows) {
  const byPk = new Map();
  for (const r of rows || []) {
    const pk = String(r.pk || '');
    if (!byPk.has(pk)) byPk.set(pk, []);
    byPk.get(pk).push(r);
  }

  const files = {};
  const db = emptyDb();
  const stats = { pks: 0, docs: 0, skipped: 0 };

  // ── общая запись: секреты, комната, приглашения, политика, журнал
  const meta = (byPk.get('meta') || []).find(r => String(r.sk) === 'root');
  if (meta && meta.item) {
    let core = {};
    try { core = JSON.parse(str(meta.item.d) || '{}'); } catch (e) { core = {}; }
    db.version = core.version || 3;
    db.createdAt = core.createdAt || Date.now();
    db.room = core.room || null;
    if (core.serverSecret) db.serverSecret = core.serverSecret;
    db.upBytes = Number(core.upBytes) || 0;
    if (Array.isArray(core.invites)) db.invites = core.invites;
    if (core.invitePolicy && typeof core.invitePolicy === 'object') {
      db.invitePolicy = Object.assign({ globalOff: false, blockedUsers: [], blockedChats: [] }, core.invitePolicy);
    }
    if (Array.isArray(core.adminLog)) db.adminLog = core.adminLog;
    if (typeof core.emergencyRegUntil === 'number') db.emergencyRegUntil = core.emergencyRegUntil;
    if (Array.isArray(core.bonds)) db.bonds = core.bonds;
    if (Array.isArray(core.bondReqs)) db.bondReqs = core.bondReqs;
    db.dmSaved49 = !!core.dmSaved49;
    db.seq = num(meta.item.seq);
    db.gen = num(meta.item.gen);
    db.chg = num(meta.item.chg);
    var presence = (() => { try { return JSON.parse(str(meta.item.pres) || '{}'); } catch (e) { return {}; } })();
  } else {
    var presence = {};
  }

  // ── справочник: участники, чаты, индекс архивов
  const users = assembleDocs(byPk.get('user') || []);
  const avatars = assembleDocs(byPk.get('av') || []);
  db.users = [...users.values()].map(d => d.value).filter(Boolean);
  for (const u of db.users) {
    const av = avatars.get(u.id);
    u.avatar = av && av.value ? av.value.a || null : null;
    const p = presence[u.id] || {};
    u.lastSeen = p.s || 0;
    u.activeAt = p.a || 0;
  }
  db.chats = [...assembleDocs(byPk.get('chat') || []).values()].map(d => d.value).filter(Boolean);
  db.archives = [...assembleDocs(byPk.get('arcidx') || []).values()].map(d => d.value).filter(Boolean)
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

  // ── сессии, чтобы никого не разлогинивать при переезде
  db.sessions = {};
  for (const [token, d] of assembleDocs(byPk.get('sess') || [])) {
    if (d.value && typeof d.value === 'object') db.sessions[token] = d.value;
  }

  // ── сообщения всех чатов
  db.messages = [];
  for (const [pk, rowsOfPk] of byPk) {
    if (!pk.startsWith('m#')) continue;
    for (const d of assembleDocs(rowsOfPk).values()) {
      if (d.value && typeof d.value === 'object' && d.value.id) db.messages.push(d.value);
    }
  }
  db.messages.sort((a, b) => (a.seq || 0) - (b.seq || 0));

  // ── журнал мелких изменений (реакции, правки, удаления)
  db.changes = [];
  for (const r of byPk.get('chg') || []) {
    const sk = String(r.sk || '');
    const bar = sk.indexOf('|');
    if (bar < 0) continue;
    const rk = Number(sk.slice(0, bar));
    const id = sk.slice(bar + 1);
    let v = {};
    try { v = JSON.parse(str((r.item || {}).d) || '{}'); } catch (e) { v = {}; }
    db.changes.push({ i: id, c: v.c, r: rk, d: v.x ? 1 : 0 });
  }
  db.changes.sort((a, b) => a.r - b.r);
  if (db.changes.length > 200) db.changes = db.changes.slice(-200);

  // ── соседние файлы: архивы, фоны, иконки, куски вложений
  for (const [file, d] of assembleDocs(byPk.get('arc') || [])) {
    if (d.value && typeof d.value.t === 'string') files['archives/' + file] = d.value.t;
  }
  for (const [id, d] of assembleDocs(byPk.get('wall') || [])) {
    files['wall-' + id + '.txt'] = d.value ? String(d.value.w || '') : '';
  }
  for (const [id, d] of assembleDocs(byPk.get('cicon') || [])) {
    files['cicon-' + id + '.txt'] = d.value ? String(d.value.w || '') : '';
  }
  for (const [id, d] of assembleDocs(byPk.get('upmeta') || [])) {
    if (d.value) files['upmeta-' + id + '.json'] = JSON.stringify(d.value);
  }
  for (const [sk, d] of assembleDocs(byPk.get('up') || [])) {
    const h = sk.lastIndexOf('#');
    if (h < 0 || !d.value || typeof d.value.d !== 'string') continue;
    files['up-' + sk.slice(0, h) + '-' + sk.slice(h + 1) + '.txt'] = d.value.d;
  }

  for (const pk of byPk.keys()) stats.pks++;
  stats.docs = db.users.length + db.chats.length + db.messages.length + db.archives.length;
  stats.files = Object.keys(files).length;
  return { db, files, stats };
}

module.exports = { rowsToPayload, assembleDocs };
