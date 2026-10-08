'use strict';
/**
 * SEGA-CHAT · локальная память (pkg3-18).
 *
 * Кэш переписки на устройстве: сервер отдаёт историю зашифрованной, и на
 * устройство она ложится тем же шифротекстом — без расшифровки на диск.
 * При следующем открытии чат мгновенно рисуется из локальной копии и
 * дотягивает только новинки (дельта-синхронизация по since/gen/chg).
 *
 * Модуль не знает ни про браузер, ни про IndexedDB: ему дают «бэкенд»
 * с семью простыми методами (get/put/del/delMany/putAll/all/clear),
 * поэтому логику можно тестировать в Node на памяти.
 *
 * Правила аккуратности:
 *  — кэш пригоден только при совпадении отпечатка fp (пользователь + ключ
 *    комнаты): чужая сессия на том же браузере не увидит эту переписку;
 *  — смена «поколения» базы (gen: архивация, очистка, восстановление)
 *    перечитывает сообщения с нуля и перезаписывает кэш;
 *  — переполнение квоты браузера тихо отключает кэш: чат работает как раньше.
 */
(function (glob) {
  function createLocalCache(backend, opts) {
    const log = (opts && opts.log) || function () {};
    let disabled = false;
    let disabledReason = null;
    let lastError = null;

    /** Обёртка: любая ошибка бэкенда не должна ронять чат. */
    function guard(fn, fallback) {
      return function () {
        if (disabled) return Promise.resolve(fallback);
        const args = arguments;
        let p;
        try { p = fn.apply(null, args); } catch (e) { return Promise.resolve(fallback); }
        return Promise.resolve(p).catch(e => {
          const quota = e && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED');
          lastError = (e && (e.name + ': ' + e.message)) || String(e);
          if (quota) {
            disabled = true; disabledReason = 'квота памяти браузера исчерпана';
            log('квота браузера исчерпана — локальная память отключена');
            return Promise.resolve(backend.clear('msg'))
              .catch(() => {})
              .then(() => Promise.all([backend.clear('chat'), backend.clear('user'), backend.del('kv', 'meta')]).catch(() => {}))
              .then(() => fallback);
          }
          log('локальная память: ' + ((e && e.message) || e));
          return fallback;   // разовая ошибка браузера не отключает кэш навсегда
        });
      };
    }

    return {
      /** кэш отключён (квота или ошибка) — UI может не показывать «локальную память» */
      get disabled() { return disabled; },
      get disabledReason() { return disabledReason; },
      get lastError() { return lastError; },

      /**Meta-запись кэша, если она подходит этому пользователю и ключу. */
      peek: guard(fp => backend.get('kv', 'meta').then(m => (m && m.fp === fp ? m : null)), null),

      /** Всё содержимое кэша: сообщения, чаты, участники. */
      loadAll: guard(() => Promise.all([
        backend.all('msg'), backend.all('chat'), backend.all('user')
      ]).then(([messages, chats, users]) => ({ messages, chats, users })), null),

      /** Полная перезапись кэша снимком (холодная загрузка, ресинк). */
      saveAll: guard((fp, snap) => Promise.all([
        backend.clear('msg'), backend.clear('chat'), backend.clear('user')
      ]).then(() => Promise.all([
        backend.putAll('msg', (snap.messages || []).map(m => ({ key: m.id, value: m }))),
        backend.putAll('chat', (snap.chats || []).map(c => ({ key: c.id, value: c }))),
        backend.putAll('user', (snap.users || []).map(u => ({ key: u.id, value: u })))
      ])).then(() => backend.put('kv', 'meta', Object.assign(
        { fp: fp, at: Date.now() }, snap.meta || {}))).then(() => true), false),

      /** Дельта синхронизации: новинки, правки, удаления, справочники, meta. */
      applySync: guard((fp, d) => {
        const jobs = [];
        if (d.resync) jobs.push(backend.clear('msg'));
        return Promise.all(jobs).then(() => Promise.all([
          (d.messages && d.messages.length)
            ? backend.putAll('msg', d.messages.map(m => ({ key: m.id, value: m }))) : null,
          (d.gone && d.gone.length) ? backend.delMany('msg', d.gone) : null,
          (d.chats && d.chats.length)
            ? backend.putAll('chat', d.chats.map(c => ({ key: c.id, value: c }))) : null,
          (d.users && d.users.length)
            ? backend.putAll('user', d.users.map(u => ({ key: u.id, value: u }))) : null
        ])).then(() => backend.put('kv', 'meta', Object.assign(
          { fp: fp, at: Date.now() }, d.meta || {}))).then(() => true);
      }, false),

      /** Полная очистка (выход, кнопка «стереть кэш»). */
      clear: guard(() => Promise.all([
        backend.clear('msg'), backend.clear('chat'), backend.clear('user'), backend.del('kv', 'meta')
      ]), false)
    };
  }

  glob.createLocalCache = createLocalCache;
  // в Node (тесты) модуль доступен и через require
  if (typeof module !== 'undefined' && module.exports) module.exports = { createLocalCache };
})(typeof window !== 'undefined' ? window : globalThis);
