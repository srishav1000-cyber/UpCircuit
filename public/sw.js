/* UpCircuit service worker v2 — Web Push for circuit-limit and live rule alerts (with delivery ACK). No fetch caching on purpose (market data must never be stale). */
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) { event.waitUntil(self.clients.claim()); });

/* Delivery ACK: alerts from the daemon carry { delivery_id, ack }. Once the OS banner has been handed to the system we POST the local display time to
   /api/alerts/ack so the server can show end-to-end latency and prove the closed-app push arrived. Retries cover the (rare) race where the ACK beats the
   delivery row's insert; failures are silent — an ACK must never block or break the notification itself. */
var ACK_RETRY_MS = [1200, 3500, 8000];
function sendAck(data, receivedAt, displayedAt) {
  var body = JSON.stringify({ delivery_id: data.delivery_id, ack: data.ack, received_at: receivedAt, displayed_at: displayedAt });
  function attempt(i) {
    return fetch('/api/alerts/ack', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true, credentials: 'omit', cache: 'no-store' })
      .then(function (r) {
        if (r.ok || (r.status !== 404 && r.status < 500) || i >= ACK_RETRY_MS.length) return;
        return new Promise(function (res) { setTimeout(res, ACK_RETRY_MS[i]); }).then(function () { return attempt(i + 1); });
      })
      .catch(function () {
        if (i >= ACK_RETRY_MS.length) return;
        return new Promise(function (res) { setTimeout(res, ACK_RETRY_MS[i]); }).then(function () { return attempt(i + 1); });
      });
  }
  return attempt(0);
}

self.addEventListener('push', function (event) {
  var receivedAt = Date.now();
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { title: 'UpCircuit alert', body: event.data ? event.data.text() : '' }; }
  var title = data.title || 'UpCircuit alert';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-72.png',
      vibrate: [200, 100, 200],
      tag: data.tag || undefined,
      renotify: !!data.tag,
      timestamp: typeof data.sent_at === 'number' ? data.sent_at : undefined,
      data: { url: data.url || '/terminal' }
    }).then(function () {
      var displayedAt = Date.now();                       // the OS accepted the banner → this device clock is "displayed_at"
      if (data.delivery_id && data.ack) return sendAck(data, receivedAt, displayedAt);
    })
  );
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
