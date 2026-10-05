/* SEGA-CHAT Web Push worker. It never receives message plaintext. */
'use strict';
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) { data = { body: event.data ? event.data.text() : '' }; }
  event.waitUntil((async () => {
    const wins = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    // будим открытые окна: даже спящее («тихий час») окно просыпается и досинхронизируется
    await Promise.all(wins.map(c => c.postMessage({ t: 'wake' }).catch(() => {})));
    // окно прямо перед человеком — уведомление не нужно: чат сам покажет и озвучит
    if (wins.some(c => c.visibilityState === 'visible')) return;
    return self.registration.showNotification(data.title || 'SEGA-CHAT', {
      body: data.body || 'Новое сообщение', icon: './icon-192.png', badge: './favicon.png',
      tag: data.tag || 'sega-chat', data: { url: data.url || './' }, renotify: true
    });
  })());
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if ('focus' in c) return c.focus();
    return clients.openWindow(event.notification.data.url);
  }));
});

/* Кэш статики для быстрого холодного старта: страница, стили, скрипт, иконки.
   Стратегия «кэш сразу + обновление в фоне»: открытие чата не ждёт сеть,
   а свежая версия прилетает к следующему запуску. */
const STATIC_CACHE = 'sega-static-v11';
const STATIC_RE = /(\.css|\.js|\.png|\.svg|\.webmanifest|\.ico)$|^\/$|index\.html$/;
/* Новый воркер встаёт на вахту сразу (не ждёт закрытия вкладок) и вычищает
   старые кэши, чтобы друзья получили свежий app.js при первой же загрузке. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== STATIC_CACHE).map(k => caches.delete(k)));
    await clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;      // CDN-эмодзи не кэшируем здесь
  if (!STATIC_RE.test(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(STATIC_CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    const fresh = fetch(req).then(res => {
      if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
      return res;
    }).catch(() => null);
    return hit || (await fresh) || Response.error();
  })());
});
