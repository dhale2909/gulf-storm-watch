// Service worker for Daniel's Storm Page: shows storm alerts delivered by browser push.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  // A push with no payload is the "Send me a test" ping from the subscriber service.
  const isTest = !e.data;
  if (isTest) d = { title: "Daniel's Storm Page: test", body: 'Test notification. Storm alerts will reach this device.' };
  e.waitUntil(self.registration.showNotification(d.title || "Daniel's Storm Page", {
    body: d.body || 'Open the page for the latest reading.', icon: 'icon-192.png', badge: 'icon-192.png',
    tag: isTest ? 'storm-test' : 'storm-alert', renotify: true, data: { url: d.url || './' }, // a test never replaces a real alert in the tray
  }));
});
// The browser renewed or dropped this device's subscription: register the new one, or alerts would stop silently.
// The service keeps one registration per device and prunes the old address on its next failed send.
const PUSH_API = 'https://storm-page-push.daniel-48f.workers.dev';
const VAPID_PUBLIC = 'BNbw4rWNN4JtPg4hBoEUyy5aKS0KDOB6IN_1-EMfXGFumWS99_SOzOi5BDlAArQUIomdfb811-0E-9i4BNh9iL0';
const b64 = (s) => Uint8Array.from(atob((s + '='.repeat((4 - (s.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
self.addEventListener('pushsubscriptionchange', (e) => {
  e.waitUntil((async () => {
    const sub = e.newSubscription || await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(VAPID_PUBLIC) });
    await fetch(`${PUSH_API}/subscribe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sub) });
    if (e.oldSubscription && e.oldSubscription.endpoint !== sub.endpoint) {
      await fetch(`${PUSH_API}/unsubscribe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: e.oldSubscription.endpoint }) }).catch(() => {});
    }
  })().catch(() => {}));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './', self.location.href).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const open = list.find((c) => c.url.startsWith(self.registration.scope));
    return open ? open.focus() : self.clients.openWindow(url);
  }));
});
