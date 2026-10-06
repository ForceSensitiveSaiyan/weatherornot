// Only for morning notifications. It doesn't cache anything, so the game is
// always the latest version.

self.addEventListener('push', (event) => {
  let message = {};
  try {
    message = event.data?.json() ?? {};
  } catch { /* show the plain version */ }
  event.waitUntil(self.registration.showNotification(message.title ?? 'WeatherOrNot', {
    body: message.body ?? 'Your results are in.',
    icon: '/icon-192.png',
    tag: message.tag,
    data: { url: message.url ?? '/' },
  }));
});

// Tapping it opens the game, reusing an open tab if there is one.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url ?? '/', self.location.origin).href;
  event.waitUntil((async () => {
    const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const tab = tabs.find((c) => new URL(c.url).origin === self.location.origin);
    if (tab) {
      await tab.focus();
      return tab.navigate(url).catch(() => {});
    }
    return self.clients.openWindow(url);
  })());
});
