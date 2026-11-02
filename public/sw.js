// Receives pushes from the server and shows them, also when Velcord is closed.
// (iPhone requires that every push shows a notification.)
function report(kind, msg) {
  return fetch('/api/client-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, msg: 'sw: ' + msg }),
  }).catch(() => {});
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: 'Velcord', body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'Velcord';
  event.waitUntil((async () => {
    try {
      await self.registration.showNotification(title, {
        body: data.body || '',
        tag: data.tag || 'velcord',
        renotify: true,
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        data: { url: data.url || '/app' },
      });
      await report('push', 'received and shown: ' + title);
    } catch (e) {
      await report('push-error', String(e && e.message || e));
    }
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/app';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) { await c.focus(); return; }
    }
    await self.clients.openWindow(url);
  })());
});
