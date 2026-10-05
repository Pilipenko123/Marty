/**
 * Проверка модуля локальной памяти (public/local-cache.js) на память-бэкенде.
 * Запуск: node test/test-local-cache.mjs
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createLocalCache } = require('../public/local-cache.js');

let bad = 0, good = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ПРОВАЛ: ') + m); if (c) good++; else bad++; };

function memBackend(opts = {}) {
  const st = { kv: new Map(), msg: new Map(), chat: new Map(), user: new Map() };
  const failPut = opts.failPut || null;
  const wrap = (fn) => (...a) => Promise.resolve().then(() => fn(...a));
  return {
    st,
    get: wrap((s, k) => (st[s].has(k) ? st[s].get(k) : null)),
    put: wrap((s, k, v) => { if (failPut && s === failPut[0] && failPut[1] === 'put') throw quotaErr(); st[s].set(k, v); }),
    del: wrap((s, k) => { st[s].delete(k); }),
    delMany: wrap((s, keys) => { keys.forEach(k => st[s].delete(k)); }),
    putAll: wrap((s, items) => { if (failPut && s === failPut[0] && failPut[1] === 'putAll') throw quotaErr(); items.forEach(it => st[s].set(it.key, it.value)); }),
    all: wrap((s) => [...st[s].values()]),
    clear: wrap((s) => { st[s].clear(); })
  };
}
function quotaErr() { const e = new Error('quota'); e.name = 'QuotaExceededError'; return e; }

const FP_A = 'user-a:key1';
const FP_B = 'user-b:key2';
const msg = (id, seq, extra = {}) => Object.assign({ id, chat: 'c1', seq, uid: 'u1', ts: 1, blob: 'b:' + id }, extra);

console.log('\n══════════════════════════════════════════════════');
console.log('  Локальная память: модуль local-cache.js');
console.log('══════════════════════════════════════════════════');

// ── холодный старт: кэша нет
{
  const c = createLocalCache(memBackend());
  ok((await c.peek(FP_A)) === null, 'на холодном устройстве кэш отсутствует');
  const empty = await c.loadAll();
  ok(empty && empty.messages.length === 0, 'loadAll без кэша отдаёт пустые списки (без падения)');
}

// ── снимок и чтение
{
  const b = memBackend();
  const c = createLocalCache(b);
  const saved = await c.saveAll(FP_A, {
    messages: [msg('m1', 1), msg('m2', 2), msg('m3', 3)],
    chats: [{ id: 'c1', kind: 'group', members: ['u1'] }],
    users: [{ id: 'u1', name: 'Админ' }],
    meta: { me: 'user-a', seq: 3, gen: 7, chg: 9, rsince: 5 }
  });
  ok(saved === true, 'снимок сохранён');
  const meta = await c.peek(FP_A);
  ok(meta && meta.seq === 3 && meta.gen === 7, 'meta-запись читается (seq=3, gen=7)');
  const all = await c.loadAll();
  ok(all.messages.length === 3 && all.chats.length === 1 && all.users.length === 1, 'снимок читается целиком');
  ok((await c.peek(FP_B)) === null, 'чужой отпечаток (другой пользователь) кэш не видит');
}

// ── дельта: новинки, правки, удаления
{
  const b = memBackend();
  const c = createLocalCache(b);
  await c.saveAll(FP_A, {
    messages: [msg('m1', 1), msg('m3', 3)],
    chats: [{ id: 'c1', kind: 'group', members: ['u1'] }],
    users: [{ id: 'u1', name: 'Админ' }],
    meta: { me: 'user-a', seq: 3, gen: 7, chg: 1, rsince: 0 }
  });
  const applied = await c.applySync(FP_A, {
    messages: [msg('m4', 4), Object.assign(msg('m1', 1), { rev: 2, editedAt: 77 })],
    gone: ['m3'],
    chats: [{ id: 'c1', kind: 'group', members: ['u1', 'u2'] }],
    users: [{ id: 'u2', name: 'Поля' }],
    meta: { me: 'user-a', seq: 4, gen: 7, chg: 2, rsince: 0 }
  });
  ok(applied === true, 'дельта применена');
  const all = await c.loadAll();
  const ids = all.messages.map(m => m.id).sort();
  ok(JSON.stringify(ids) === JSON.stringify(['m1', 'm4']), 'удаление и новинка учтены: ' + ids.join(','));
  ok(all.messages.find(m => m.id === 'm1').rev === 2, 'правка сообщения легла поверх старой записи');
  ok(all.chats[0].members.length === 2 && all.users.length === 2, 'справочники обновлены');
  ok((await c.peek(FP_A)).seq === 4, 'meta продвинулась до seq=4');
}

// ── смена поколения: сообщения перечитываются с нуля
{
  const b = memBackend();
  const c = createLocalCache(b);
  await c.saveAll(FP_A, { messages: [msg('m1', 1), msg('m2', 2)], chats: [], users: [], meta: { seq: 2, gen: 7 } });
  await c.applySync(FP_A, { resync: true, messages: [msg('n1', 1)], chats: [], users: [], meta: { seq: 1, gen: 8 } });
  const all = await c.loadAll();
  ok(all.messages.length === 1 && all.messages[0].id === 'n1', 'resync вычистил старые сообщения и положил новые');
}

// ── квота браузера: тихое отключение, чат не падает
{
  const b = memBackend({ failPut: ['kv', 'put'] });
  const c = createLocalCache(b, { log: () => {} });
  const r = await c.saveAll(FP_A, { messages: [msg('m1', 1)], chats: [], users: [], meta: { seq: 1 } });
  ok(r === false, 'при переполнении квоты сохранение тихо отклонено');
  ok(c.disabled === true, 'кэш помечен отключённым');
  ok((await c.peek(FP_A)) === null, 'после отключения кэш не отдаётся');
  ok((await c.applySync(FP_A, { messages: [], gone: [], meta: {} })) === false, 'отключённый кэш не роняет вызовы');
}

// ── очистка
{
  const b = memBackend();
  const c = createLocalCache(b);
  await c.saveAll(FP_A, { messages: [msg('m1', 1)], chats: [{ id: 'c1' }], users: [{ id: 'u1' }], meta: { seq: 1 } });
  await c.clear();
  ok((await c.peek(FP_A)) === null && b.st.msg.size === 0, 'очистка стирает и meta, и сообщения');
}

// ── разовая ошибка бэкенда: не отключает кэш, но видна в диагностике
{
  let boom = true;
  const b = memBackend();
  const rawGet = b.get;
  b.get = (st, k) => { if (boom && st === 'kv') { boom = false; return Promise.reject(new Error('SQLite error: disk I/O')); } return rawGet(st, k); };
  const c = createLocalCache(b, { log: () => {} });
  const meta = await c.peek(FP_A);
  ok(meta === null, 'разовая ошибка чтения отдана как «кэша нет», без падения');
  ok(c.disabled === false, 'разовая ошибка НЕ отключает кэш навсегда');
  ok(String(c.lastError || '').includes('disk I/O'), 'последняя ошибка доступна для диагностики: ' + c.lastError);
  const saved = await c.saveAll(FP_A, { messages: [msg('m1', 1)], chats: [], users: [], meta: { seq: 1 } });
  ok(saved === true && (await c.peek(FP_A)) !== null, 'после разовой ошибки кэш снова пишет и читает');
}

// ── квота: причина отключения доступна UI
{
  const b = memBackend({ failPut: ['kv', 'put'] });
  const c = createLocalCache(b, { log: () => {} });
  await c.saveAll(FP_A, { messages: [], chats: [], users: [], meta: { seq: 1 } });
  ok(c.disabled === true && String(c.disabledReason).includes('квота'), 'причина отключения доступна: ' + c.disabledReason);
}

console.log('\n──────────────────────────────────────────────────');
console.log(`  Локальная память: ${good} ✓, провалов ${bad}`);
console.log('──────────────────────────────────────────────────\n');
process.exit(bad ? 1 : 0);
