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

/** A same-tag notification shown this recently is the same event's other copy. */
const SAME_EVENT_MS = 30000;

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

/**
 * Whether a notification alerts again when it replaces `existing`, the
 * same-tag notifications on screen. A browser replaces a same-tag notification
 * silently unless `renotify` is set. An older one is an earlier event, such as
 * the last turn of this session: alert. One from the last 30 s is this event's
 * other copy (an open tab raised it, or the push did): replace it quietly.
 * `alertsAgain` in src/lib/web-notifications.ts applies the same rule.
 */
function alertsAgain(existing) {
  const now = Date.now();
  return (
    existing.length > 0 &&
    existing.every((notification) => !(notification.data && now - notification.data.at < SAME_EVENT_MS))
  );
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
  const tag = message.tag || undefined;
  // Every push shows a notification, also over a focused tab on this page:
  // Safari removes the subscription after 3 pushes that show none. The API
  // sends no push while a tab that shows its own alerts is present.
  event.waitUntil(
    (tag ? self.registration.getNotifications({ tag }) : Promise.resolve([]))
      .catch(() => [])
      .then((existing) =>
        self.registration.showNotification(message.title || 'Kortix', {
          body: message.body || '',
          tag,
          renotify: alertsAgain(existing),
          data: { url: url.href, at: Date.now() },
          icon: '/favicon.svg',
        }),
      ),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = appUrl(event.notification.data && event.notification.data.url);
  event.waitUntil(
    windowClients().then(async (clients) => {
      const sameOrigin = clients.filter((client) => new URL(client.url).origin === url.origin);
      const onPage = sameOrigin.find((client) => new URL(client.url).pathname === url.pathname);
      if (onPage) {
        // The tab keeps its state, so it never sees `?notification=<id>`: it
        // marks the notification read from this message.
        try {
          onPage.postMessage({ type: 'kortix:notification-open', url: url.href });
        } catch {
          // The tab is closing.
        }
        return onPage.focus();
      }
      const client = sameOrigin[0];
      if (client) {
        // `navigate` spends no window-interaction token. `focus` and
        // `openWindow` share the click's only one, so only one of them runs.
        // An uncontrolled tab (after Shift+Reload) rejects `navigate`.
        const navigated = await client.navigate(url.href).catch(() => undefined);
        if (navigated) return navigated.focus();
        // null: the tab navigated, but away from this origin.
        if (navigated === null) return undefined;
      }
      return self.clients.openWindow(url.href);
    }),
  );
});
