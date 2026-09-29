/* SEGA-CHAT Web Push worker. It never receives message plaintext. */
'use strict';
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) { data = { body: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(data.title || 'SEGA-CHAT', {
    body: data.body || 'Новое сообщение', icon: './logo.png', badge: './favicon.png',
    tag: data.tag || 'sega-chat', data: { url: data.url || './' }, renotify: true
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if ('focus' in c) return c.focus();
    return clients.openWindow(event.notification.data.url);
  }));
});
