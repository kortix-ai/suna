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
};

let handlers: Record<string, Handler>;
let shown: { title: string; options: Record<string, unknown> }[];
let opened: string[];
let navigated: string[];
let focusedUrls: string[];
let windows: FakeClient[];

function client(url: string, focused = false, navigate?: FakeClient['navigate']): FakeClient {
  const fake: FakeClient = {
    url,
    focused,
    focus: async () => {
      focusedUrls.push(fake.url);
      return fake;
    },
    navigate:
      navigate ??
      (async (next) => {
        navigated.push(next);
        return fake;
      }),
  };
  return fake;
}

beforeEach(() => {
  handlers = {};
  shown = [];
  opened = [];
  navigated = [];
  focusedUrls = [];
  windows = [];
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, handler: Handler) => {
      handlers[type] = handler;
    },
    skipWaiting: () => undefined,
    registration: {
      showNotification: async (title: string, options: Record<string, unknown>) => {
        shown.push({ title, options });
      },
    },
    clients: {
      claim: async () => undefined,
      matchAll: async () => windows,
      openWindow: async (url: string) => {
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
  handlers.notificationclick({
    notification: { data: { url }, close: () => (closed = true) },
    waitUntil: (promise: Promise<unknown>) => waits.push(promise),
  });
  await Promise.all(waits);
  return closed;
}

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
    await push(message);
    expect(shown).toEqual([
      {
        title: 'Release notes',
        options: {
          body: 'The agent has a question.',
          tag: 'question:ses-b',
          data: { url: `${ORIGIN}/projects/p1/sessions/ses-b?notification=n1` },
          icon: '/favicon.svg',
        },
      },
    ]);
  });

  test('stays silent when a focused tab already shows that page', async () => {
    windows = [client(`${ORIGIN}/projects/p1/sessions/ses-b`, true)];
    await push(message);
    expect(shown).toHaveLength(0);
  });

  test('still shows when the tab on that page is not focused, or the focused tab is elsewhere', async () => {
    windows = [client(`${ORIGIN}/projects/p1/sessions/ses-b`, false)];
    await push(message);
    windows = [client(`${ORIGIN}/projects/p1/sessions/ses-a`, true)];
    await push(message);
    expect(shown).toHaveLength(2);
  });

  test('a url on another origin opens the app root instead', async () => {
    await push({ ...message, url: 'https://elsewhere.example.test/phish' });
    expect(shown[0].options.data).toEqual({ url: `${ORIGIN}/` });
  });

  test('an unreadable message still shows a notification', async () => {
    await push(new SyntaxError('not json'));
    expect(shown[0].title).toBe('Kortix');
    expect(shown[0].options).toMatchObject({ body: '', data: { url: `${ORIGIN}/` } });
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

  test('focuses a tab already on the page without reloading it', async () => {
    windows = [client(`${ORIGIN}/projects/p1`), client(`${ORIGIN}/projects/p1/sessions/ses-b`)];
    await click(target);
    expect(focusedUrls).toEqual([`${ORIGIN}/projects/p1/sessions/ses-b`]);
    expect(navigated).toEqual([]);
    expect(opened).toEqual([]);
  });

  test('focuses and navigates another tab of the app', async () => {
    windows = [client('https://elsewhere.example.test/x'), client(`${ORIGIN}/projects/p1`)];
    await click(target);
    expect(focusedUrls).toEqual([`${ORIGIN}/projects/p1`]);
    expect(navigated).toEqual([target]);
    expect(opened).toEqual([]);
  });

  test('opens a window when the tab refuses to navigate', async () => {
    windows = [
      client(`${ORIGIN}/projects/p1`, false, async () => {
        throw new TypeError('not controlled');
      }),
    ];
    await click(target);
    expect(opened).toEqual([target]);
  });

  test('never navigates to another origin', async () => {
    await click('https://elsewhere.example.test/phish');
    expect(opened).toEqual([`${ORIGIN}/`]);
  });
});
