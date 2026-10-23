/* UpCircuit service worker — Web Push for circuit-limit alerts. No fetch caching on purpose (market data must never be stale). */
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) { event.waitUntil(self.clients.claim()); });

self.addEventListener('push', function (event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { title: 'UpCircuit alert', body: event.data ? event.data.text() : '' }; }
  var title = data.title || 'UpCircuit alert';
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    vibrate: [200, 100, 200],
    tag: data.tag || undefined,
    renotify: !!data.tag,
    data: { url: data.url || '/terminal' }
  }));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var target = new URL((event.notification.data && event.notification.data.url) || '/terminal', self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (wins) {
    for (var i = 0; i < wins.length; i++) {
      var w = wins[i];
      if (new URL(w.url).origin === self.location.origin && 'focus' in w) {
        if ('navigate' in w) w.navigate(target);
        return w.focus();
      }
    }
    return self.clients.openWindow(target);
  }));
});
