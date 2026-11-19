/* WH Reg service worker — phone notifications only (no offline caching here).
 * Shows the clock-in / clock-out reminders, the owner's daily summary and other alerts,
 * and opens the app on the right page when one is tapped. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let m = {};
  try { m = event.data ? event.data.json() : {}; } catch (_) { m = { title: 'WH Reg', body: event.data ? event.data.text() : '' }; }
  const base = self.registration.scope;
  event.waitUntil(self.registration.showNotification(m.title || 'WH Reg', {
    body: m.body || '',
    icon: base + 'icons/icon-192.png',
    badge: base + 'icons/icon-192.png',
    tag: m.kind === 'CLOCK_IN_REMINDER' || m.kind === 'CLOCK_OUT_REMINDER' || m.kind === 'DAILY_SUMMARY' ? m.kind : 'n' + (m.id || Date.now()),
    renotify: true,
    requireInteraction: m.kind === 'CLOCK_IN_REMINDER' || m.kind === 'CLOCK_OUT_REMINDER',
    vibrate: [200, 100, 200],
    data: { kind: m.kind || '', id: m.id || null },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const kind = (event.notification.data && event.notification.data.kind) || '';
  const url = self.registration.scope + (kind ? '?open=' + encodeURIComponent(kind) : '');
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (w.url.startsWith(self.registration.scope)) {
        await w.focus();
        w.postMessage({ type: 'open-notification', kind });
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
