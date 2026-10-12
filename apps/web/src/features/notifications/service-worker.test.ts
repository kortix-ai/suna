import { beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `public/sw.js` runs in a service worker, which bun does not have. The file
 * reads one global, `self`, so the test hands it a fake one: the event
 * listeners it registers, `registration.showNotification`, and `clients`.
 */

const ORIGIN = 'https://app.example.test';
const source = readFileSync(join(import.meta.dir, '../../../public/sw.js'), 'utf8');

type Handler = (event: Record<string, unknown>) => void;
type FakeClient = {
  url: string;
  focused: boolean;
  focus: () => Promise<FakeClient>;
  navigate: (url: string) => Promise<FakeClient | null>;
  postMessage: (message: unknown) => void;
};
type Shown = { title: string; options: Record<string, unknown> };

let handlers: Record<string, Handler>;
let shown: Shown[];
/** The notifications on screen by tag: a same-tag notification replaces the last. */
let onScreen: Map<string, { data: unknown }>;
let opened: string[];
let navigated: string[];
let focusedUrls: string[];
let posted: { url: string; message: unknown }[];
let windows: FakeClient[];
/**
 * A notification click grants one window-interaction token. `focus` and
 * `openWindow` each spend it, as in Chrome, and a second spend in the same
 * click rejects. `navigate` spends nothing.
 */
let token = false;
function spendToken() {
  if (!token) throw new DOMException('Not allowed to open a window.', 'InvalidAccessError');
  token = false;
}

function client(url: string, focused = false, navigate?: FakeClient['navigate']): FakeClient {
  const fake: FakeClient = {
    url,
    focused,
    focus: async () => {
      spendToken();
      focusedUrls.push(fake.url);
      return fake;
    },
    navigate:
      navigate ??
      (async (next) => {
        navigated.push(next);
        return fake;
      }),
    postMessage: (message) => posted.push({ url: fake.url, message }),
  };
  return fake;
}

beforeEach(() => {
  handlers = {};
  shown = [];
  onScreen = new Map();
  opened = [];
  navigated = [];
  focusedUrls = [];
  posted = [];
  windows = [];
  token = false;
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, handler: Handler) => {
      handlers[type] = handler;
    },
    skipWaiting: () => undefined,
    registration: {
      showNotification: async (title: string, options: Record<string, unknown>) => {
        shown.push({ title, options });
        if (typeof options.tag === 'string') onScreen.set(options.tag, { data: options.data });
      },
      getNotifications: async ({ tag }: { tag: string }) => {
        const notification = onScreen.get(tag);
        return notification ? [notification] : [];
      },
    },
    clients: {
      claim: async () => undefined,
      matchAll: async () => windows,
      openWindow: async (url: string) => {
        spendToken();
        opened.push(url);
        return null;
      },
    },
  };
  new Function('self', source)(self);
});

async function push(data: unknown) {
  const waits: Promise<unknown>[] = [];
  handlers.push({
    data: {
      json: () => {
        if (data instanceof Error) throw data;
        return data;
      },
    },
    waitUntil: (promise: Promise<unknown>) => waits.push(promise),
  });
  await Promise.all(waits);
}

async function click(url: unknown) {
  const waits: Promise<unknown>[] = [];
  let closed = false;
  token = true;
  handlers.notificationclick({
    notification: { data: { url }, close: () => (closed = true) },
    waitUntil: (promise: Promise<unknown>) => waits.push(promise),
  });
  await Promise.all(waits);
  return closed;
}

/** The time `sw.js` stamped on the nth notification it showed. */
const shownAt = (index: number) => (shown[index].options.data as { at: unknown }).at;

const message = {
  title: 'Release notes',
  body: 'The agent has a question.',
  tag: 'question:ses-b',
  url: '/projects/p1/sessions/ses-b?notification=n1',
  notificationId: 'n1',
  kind: 'question',
  type: 'question',
  projectId: 'p1',
  sessionId: 'ses-b',
  triggerSlug: null,
};

describe('sw.js push', () => {
  test('shows the message with its tag and the absolute session url', async () => {
    const before = Date.now();
    await push(message);
    expect(shown).toEqual([
      {
        title: 'Release notes',
        options: {
          body: 'The agent has a question.',
          tag: 'question:ses-b',
          renotify: false,
          data: { url: `${ORIGIN}/projects/p1/sessions/ses-b?notification=n1`, at: shownAt(0) },
          icon: '/favicon.svg',
        },
      },
    ]);
    expect(shownAt(0)).toBeGreaterThanOrEqual(before);
  });

  // Safari removes the subscription after 3 pushes that show no notification.
  test('shows the message even when a focused tab shows that page', async () => {
    windows = [client(`${ORIGIN}/projects/p1/sessions/ses-b`, true)];
    await push(message);
    expect(shown).toHaveLength(1);
  });

  test('shows the message whichever tab is open or focused', async () => {
    windows = [client(`${ORIGIN}/projects/p1/sessions/ses-b`, false)];
    await push(message);
    windows = [client(`${ORIGIN}/projects/p1/sessions/ses-a`, true)];
    await push(message);
    expect(shown).toHaveLength(2);
  });

  test('a later event with the same tag alerts again: the replacement is not silent', async () => {
    const url = `${ORIGIN}/projects/p1/sessions/ses-b`;
    onScreen.set('question:ses-b', { data: { url, at: Date.now() - 60_000 } });
    await push(message);
    // A notification from an older worker carries no time: it is an earlier event too.
    onScreen.set('question:ses-b', { data: { url } });
    await push(message);
    expect(shown.map((entry) => entry.options.renotify)).toEqual([true, true]);
  });

  test("the same event's second copy (the open tab's, or the push's) replaces the first quietly", async () => {
    await push(message);
    await push(message);
    expect(shown.map((entry) => entry.options.renotify)).toEqual([false, false]);
  });

  test('a url on another origin opens the app root instead', async () => {
    await push({ ...message, url: 'https://elsewhere.example.test/phish' });
    expect(shown[0].options.data).toEqual({ url: `${ORIGIN}/`, at: shownAt(0) });
    expect(typeof shownAt(0)).toBe('number');
  });

  test('an unreadable message still shows a notification, with no tag and no renotify', async () => {
    await push(new SyntaxError('not json'));
    expect(shown[0].title).toBe('Kortix');
    expect(shown[0].options).toMatchObject({ body: '', tag: undefined, renotify: false, data: { url: `${ORIGIN}/` } });
  });

  test('registers no fetch handler', () => {
    expect(Object.keys(handlers).sort()).toEqual(['activate', 'install', 'notificationclick', 'push']);
  });
});

describe('sw.js notificationclick', () => {
  const target = `${ORIGIN}/projects/p1/sessions/ses-b?notification=n1`;

  test('closes the notification and opens a window when no tab is open', async () => {
    expect(await click(target)).toBe(true);
    expect(opened).toEqual([target]);
  });

  test('focuses a tab already on the page and tells it which notification it opened', async () => {
    windows = [client(`${ORIGIN}/projects/p1`), client(`${ORIGIN}/projects/p1/sessions/ses-b`)];
    await click(target);
    expect(focusedUrls).toEqual([`${ORIGIN}/projects/p1/sessions/ses-b`]);
    expect(posted).toEqual([
      { url: `${ORIGIN}/projects/p1/sessions/ses-b`, message: { type: 'kortix:notification-open', url: target } },
    ]);
    expect(navigated).toEqual([]);
    expect(opened).toEqual([]);
  });

  test('navigates another tab of the app, then focuses it', async () => {
    windows = [client('https://elsewhere.example.test/x'), client(`${ORIGIN}/projects/p1`)];
    await click(target);
    expect(navigated).toEqual([target]);
    expect(focusedUrls).toEqual([`${ORIGIN}/projects/p1`]);
    expect(opened).toEqual([]);
    expect(posted).toEqual([]);
  });

  test('opens a window when the tab refuses to navigate: focus did not spend the click', async () => {
    windows = [
      client(`${ORIGIN}/projects/p1`, false, async () => {
        throw new TypeError('not controlled');
      }),
    ];
    await click(target);
    expect(opened).toEqual([target]);
    expect(focusedUrls).toEqual([]);
    expect(posted).toEqual([]);
  });

  test('never navigates to another origin', async () => {
    await click('https://elsewhere.example.test/phish');
    expect(opened).toEqual([`${ORIGIN}/`]);
  });
});
