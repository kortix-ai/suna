import { beforeEach, describe, expect, mock, test } from 'bun:test';

/**
 * `web-push.ts` against a fake browser: a service worker container whose
 * push manager keeps one subscription, and an SDK that records each call.
 */

const calls: { op: string; arg?: unknown }[] = [];
let failRegister: Error | null = null;
const KEY = new Uint8Array(65).map((_, index) => (index === 0 ? 4 : index));
const KEY_B64URL = Buffer.from(KEY).toString('base64url');

mock.module('@kortix/sdk', () => ({
  getWebPushPublicKey: async () => ({ public_key: KEY_B64URL }),
  registerWebPushSubscription: async (input: unknown) => {
    if (failRegister) throw failRegister;
    calls.push({ op: 'register', arg: input });
    return { ok: true };
  },
  unregisterWebPushSubscription: async (endpoint: string) => {
    calls.push({ op: 'unregister', arg: endpoint });
    return { deleted: true };
  },
}));

const warnings: unknown[][] = [];
mock.module('@/lib/logger', () => ({
  logger: { warn: (...args: unknown[]) => warnings.push(args), error: () => {}, info: () => {} },
}));

type FakeSubscription = {
  endpoint: string;
  options: { applicationServerKey: ArrayBuffer | null };
  unsubscribe: () => Promise<boolean>;
  toJSON: () => PushSubscriptionJSON;
};

let current: FakeSubscription | null = null;
let endpointForNext = 'https://fcm.googleapis.com/fcm/send/abc';

function fakeSubscription(endpoint: string, key: ArrayBuffer | null): FakeSubscription {
  return {
    endpoint,
    options: { applicationServerKey: key },
    unsubscribe: async () => {
      calls.push({ op: 'browser-unsubscribe', arg: endpoint });
      current = null;
      return true;
    },
    toJSON: () => ({ endpoint, keys: { p256dh: 'BPublicKey', auth: 'authSecret' } }),
  };
}

const registration = {
  pushManager: {
    getSubscription: async () => current,
    subscribe: async (options: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }) => {
      calls.push({ op: 'browser-subscribe', arg: options });
      current = fakeSubscription(endpointForNext, options.applicationServerKey.slice().buffer);
      return current;
    },
  },
};

const world = globalThis as { window?: unknown; navigator?: unknown };
let userAgent = 'Mozilla/5.0 Chrome/142.0.0.0 Safari/537.36';
world.window = { PushManager: function PushManager() {} };
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    get userAgent() {
      return userAgent;
    },
    serviceWorker: {
      register: async (url: string) => {
        calls.push({ op: 'sw-register', arg: url });
        return registration;
      },
      getRegistration: async () => registration,
    },
  },
});

const {
  base64UrlToBytes,
  deliverable,
  hasWebPushSubscription,
  stopWebPush,
  subscriptionInput,
  syncWebPush,
  wantsWebPush,
  webPushSupported,
} = await import('./web-push');

beforeEach(() => {
  calls.length = 0;
  current = null;
  failRegister = null;
  endpointForNext = 'https://fcm.googleapis.com/fcm/send/abc';
  userAgent = 'Mozilla/5.0 Chrome/142.0.0.0 Safari/537.36';
});

describe('web push decisions', () => {
  test('the base64url VAPID key decodes to its 65 bytes', () => {
    expect([...base64UrlToBytes(KEY_B64URL)]).toEqual([...KEY]);
  });

  test('a subscription missing a key is not sent', () => {
    expect(subscriptionInput({ endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'p' } })).toBeNull();
    expect(subscriptionInput({ keys: { p256dh: 'p', auth: 'a' } })).toBeNull();
    expect(subscriptionInput({ endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'p', auth: 'a' } })).toEqual({
      endpoint: 'https://fcm.googleapis.com/x',
      keys: { p256dh: 'p', auth: 'a' },
    });
  });

  test('only a push service the API accepts is deliverable', () => {
    const keys = { p256dh: 'p', auth: 'a' };
    expect(deliverable({ endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys })).toBe(true);
    expect(deliverable({ endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/x', keys })).toBe(true);
    expect(deliverable({ endpoint: 'https://push.example.test/x', keys })).toBe(false);
    expect(deliverable({ endpoint: 'not a url', keys })).toBe(false);
  });

  test('subscribe only with notifications on, permission granted, and Web Push supported', () => {
    expect(wantsWebPush({ supported: true, enabled: true, permission: 'granted' })).toBe(true);
    expect(wantsWebPush({ supported: true, enabled: false, permission: 'granted' })).toBe(false);
    expect(wantsWebPush({ supported: true, enabled: true, permission: 'default' })).toBe(false);
    expect(wantsWebPush({ supported: false, enabled: true, permission: 'granted' })).toBe(false);
  });

  test('the desktop app never counts as supported', () => {
    expect(webPushSupported()).toBe(true);
    userAgent = 'Mozilla/5.0 Chrome/142.0.0.0 KortixDesktop/0.1.0';
    expect(webPushSupported()).toBe(false);
  });
});

describe('syncWebPush', () => {
  test('on: registers the worker, subscribes with the server key, and sends the subscription', async () => {
    await syncWebPush(true);
    expect(calls.map((call) => call.op)).toEqual(['sw-register', 'browser-subscribe', 'register']);
    expect(calls[0].arg).toBe('/sw.js');
    const options = calls[1].arg as { userVisibleOnly: boolean; applicationServerKey: Uint8Array };
    expect(options.userVisibleOnly).toBe(true);
    expect([...options.applicationServerKey]).toEqual([...KEY]);
    expect(calls[2].arg).toEqual({
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
      keys: { p256dh: 'BPublicKey', auth: 'authSecret' },
    });
    expect(hasWebPushSubscription()).toBe(true);
  });

  test('an existing subscription for the same key is sent again, not replaced', async () => {
    current = fakeSubscription('https://fcm.googleapis.com/fcm/send/old', KEY.slice().buffer);
    await syncWebPush(true);
    expect(calls.map((call) => call.op)).toEqual(['sw-register', 'register']);
  });

  test('a subscription made for another server key is replaced', async () => {
    current = fakeSubscription('https://fcm.googleapis.com/fcm/send/old', new Uint8Array(65).buffer);
    await syncWebPush(true);
    expect(calls.map((call) => call.op)).toEqual([
      'sw-register',
      'browser-unsubscribe',
      'browser-subscribe',
      'register',
    ]);
  });

  test('a push service the API refuses is never sent', async () => {
    endpointForNext = 'https://push.example.test/send/abc';
    await syncWebPush(true);
    expect(calls.map((call) => call.op)).not.toContain('register');
    expect(hasWebPushSubscription()).toBe(false);
  });

  test('off: unsubscribes the browser and deletes the API record', async () => {
    await syncWebPush(true);
    calls.length = 0;
    await syncWebPush(false);
    expect(calls).toEqual([
      { op: 'browser-unsubscribe', arg: 'https://fcm.googleapis.com/fcm/send/abc' },
      { op: 'unregister', arg: 'https://fcm.googleapis.com/fcm/send/abc' },
    ]);
    expect(hasWebPushSubscription()).toBe(false);
  });

  test('calls run in order: on then off ends unsubscribed', async () => {
    void syncWebPush(true);
    await syncWebPush(false);
    expect(calls.map((call) => call.op)).toEqual([
      'sw-register',
      'browser-subscribe',
      'register',
      'browser-unsubscribe',
      'unregister',
    ]);
    expect(current).toBeNull();
  });

  test('a failure never rejects, and it is logged once', async () => {
    failRegister = new Error('503');
    warnings.length = 0;
    await syncWebPush(true);
    await syncWebPush(true);
    expect(warnings).toHaveLength(1);
    expect(hasWebPushSubscription()).toBe(false);
  });

  test('sign-out in the desktop app touches nothing', async () => {
    userAgent = 'Mozilla/5.0 KortixDesktop/0.1.0';
    await stopWebPush();
    expect(calls).toEqual([]);
  });

  test('sign-out in a browser removes the subscription', async () => {
    current = fakeSubscription('https://fcm.googleapis.com/fcm/send/old', KEY.slice().buffer);
    await stopWebPush();
    expect(calls.map((call) => call.op)).toEqual(['browser-unsubscribe', 'unregister']);
  });
});
