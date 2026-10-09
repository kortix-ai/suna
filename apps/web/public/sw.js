/*
 * Kortix service worker: Web Push only (KRTX-1742).
 *
 * The API encrypts one JSON message per notification:
 *   { title, body, tag, url, notificationId, kind, type, projectId, sessionId, triggerSlug }
 * `url` is an app path ("/projects/<id>/sessions/<id>?notification=<id>"). It
 * resolves against this origin, and any other origin falls back to "/".
 *
 * No fetch handler: nothing is cached and every request goes to the network.
 * Tested by apps/web/src/features/notifications/service-worker.test.ts.
 */

/** The app path a message or a notification points at, on this origin only. */
function appUrl(path) {
  const origin = self.location.origin;
  try {
    const url = new URL(typeof path === 'string' && path ? path : '/', origin);
    return url.origin === origin ? url : new URL('/', origin);
  } catch {
    return new URL('/', origin);
  }
}

function windowClients() {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true });
}

// A new version takes over at once, and `claim` lets `navigate` reach tabs
// that loaded before this worker was registered.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let message = {};
  try {
    message = (event.data && event.data.json()) || {};
  } catch {
    message = {};
  }
  const url = appUrl(message.url);
  event.waitUntil(
    windowClients().then((clients) => {
      // The focused tab already shows this page: it raises its own alert.
      const onScreen = clients.some(
        (client) => client.focused && new URL(client.url).pathname === url.pathname,
      );
      if (onScreen) return undefined;
      return self.registration.showNotification(message.title || 'Kortix', {
        body: message.body || '',
        tag: message.tag || undefined,
        data: { url: url.href },
        icon: '/favicon.svg',
      });
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = appUrl(event.notification.data && event.notification.data.url);
  event.waitUntil(
    windowClients().then(async (clients) => {
      const sameOrigin = clients.filter((client) => new URL(client.url).origin === url.origin);
      const onPage = sameOrigin.find((client) => new URL(client.url).pathname === url.pathname);
      if (onPage) return onPage.focus();
      const client = sameOrigin[0];
      if (client) {
        try {
          const focused = await client.focus();
          const navigated = await (focused || client).navigate(url.href);
          if (navigated) return navigated;
        } catch {
          // An uncontrolled tab refuses `navigate`: open a new window instead.
        }
      }
      return self.clients.openWindow(url.href);
    }),
  );
});
