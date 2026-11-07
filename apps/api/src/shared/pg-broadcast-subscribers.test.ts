import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';

// Characterizes how every LISTEN channel hands its payload to subscribers: a
// throwing subscriber never takes the listener down, a null handler is a
// no-op, and a malformed payload is dropped. The real module runs against a
// fake postgres client that only records the `listen` callbacks.
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';

const realPostgres = await import('postgres');
const listeners = new Map<string, (payload: string) => void>();
mock.module('postgres', () => ({
  default: () => ({
    listen: async (channel: string, cb: (payload: string) => void) => {
      listeners.set(channel, cb);
    },
    notify: async () => {},
    end: async () => {},
  }),
}));

const broadcast = await import('./pg-broadcast');
const UUID = '11111111-1111-4111-8111-111111111111';

function fire(channel: string, payload: string): void {
  const cb = listeners.get(channel);
  if (!cb) throw new Error(`no LISTEN on ${channel}`);
  cb(payload);
}

beforeAll(async () => {
  expect(await broadcast.startConfigBaseMoveBroadcast()).toBe(true);
});

afterAll(async () => {
  await broadcast.stopConfigBaseMoveBroadcast();
  mock.module('postgres', () => realPostgres);
});

const boom = () => {
  throw new Error('subscriber failed');
};

describe('pg-broadcast subscriber isolation', () => {
  test('registers every channel in order', () => {
    expect([...listeners.keys()]).toEqual([
      broadcast.BASE_MOVE_CHANNEL,
      broadcast.TUNNEL_FORWARD_CHANNEL,
      broadcast.LIFECYCLE_COMMAND_SETTLED_CHANNEL,
      broadcast.LIFECYCLE_COMMAND_DUE_CHANNEL,
      broadcast.SESSION_PROMPTS_CHANGED_CHANNEL,
      broadcast.SESSION_CHANGED_CHANNEL,
      broadcast.IAM_CACHE_BUST_CHANNEL,
      broadcast.CHROME_COMMAND_CHANNEL,
      broadcast.SPACE_ACCESS_BUST_CHANNEL,
      broadcast.SESSION_LIST_BUST_CHANNEL,
    ]);
  });

  test('base move: a throwing subscriber does not stop later ones; non-uuid dropped', () => {
    const seen: string[] = [];
    const transport = broadcast.configBaseMoveTransport();
    transport.subscribe(boom);
    transport.subscribe((id) => seen.push(id));
    fire(broadcast.BASE_MOVE_CHANNEL, 'not-a-uuid');
    expect(seen).toEqual([]);
    expect(() => fire(broadcast.BASE_MOVE_CHANNEL, UUID)).not.toThrow();
    expect(seen).toEqual([UUID]);
  });

  test('session changed: throwing subscriber isolated, unsubscribe during delivery honored by the snapshot', () => {
    const seen: string[] = [];
    let unsubB = () => {};
    broadcast.onSessionChanged(boom);
    broadcast.onSessionChanged(() => {
      seen.push('a');
      unsubB();
    });
    unsubB = broadcast.onSessionChanged(() => seen.push('b'));
    fire(broadcast.SESSION_CHANGED_CHANNEL, 'nope');
    expect(seen).toEqual([]);
    expect(() => fire(broadcast.SESSION_CHANGED_CHANNEL, UUID)).not.toThrow();
    // The snapshot was taken before `a` ran, so `b` still runs once.
    expect(seen).toEqual(['a', 'b']);
    seen.length = 0;
    fire(broadcast.SESSION_CHANGED_CHANNEL, UUID);
    expect(seen).toEqual(['a']);
  });

  test('lifecycle command due: nonfinite dropped, throw swallowed, null handler no-op', () => {
    const seen: number[] = [];
    broadcast.onLifecycleCommandDue((ms) => seen.push(ms));
    fire(broadcast.LIFECYCLE_COMMAND_DUE_CHANNEL, 'abc');
    fire(broadcast.LIFECYCLE_COMMAND_DUE_CHANNEL, '1234');
    expect(seen).toEqual([1234]);
    broadcast.onLifecycleCommandDue(boom);
    expect(() => fire(broadcast.LIFECYCLE_COMMAND_DUE_CHANNEL, '5')).not.toThrow();
    broadcast.onLifecycleCommandDue(null);
    expect(() => fire(broadcast.LIFECYCLE_COMMAND_DUE_CHANNEL, '5')).not.toThrow();
  });

  const uuidChannels: Array<[string, string, (h: ((p: string) => void) | null) => void]> = [
    ['session prompts changed', 'kortix_session_prompts_changed', (h) => broadcast.onSessionPromptsChanged(h)],
    ['space access bust', 'kortix_space_access_bust', (h) => broadcast.onSpaceAccessBustNotify(h)],
    ['session list bust', 'kortix_session_list_bust', (h) => broadcast.onSessionListBustNotify(h)],
  ];
  for (const [name, channel, register] of uuidChannels) {
    test(`${name}: non-uuid dropped, throw swallowed, null handler no-op`, () => {
      const seen: string[] = [];
      register((p) => seen.push(p));
      fire(channel, 'nope');
      fire(channel, UUID);
      expect(seen).toEqual([UUID]);
      register(boom);
      expect(() => fire(channel, UUID)).not.toThrow();
      register(null);
      expect(() => fire(channel, UUID)).not.toThrow();
    });
  }

  const rawChannels: Array<[string, string, (h: ((p: string) => void) | null) => void]> = [
    ['iam cache bust', 'kortix_iam_cache_bust', (h) => broadcast.onIamCacheBust(h)],
    ['chrome command', 'kortix_chrome_cmd', (h) => broadcast.onChromeCommand(h)],
    ['tunnel forward', 'kortix_tunnel_rpc_forward', (h) => h && broadcast.onTunnelForwardNotify(h)],
  ];
  for (const [name, channel, register] of rawChannels) {
    test(`${name}: payload passed through unvalidated, throw swallowed`, () => {
      const seen: string[] = [];
      register((p) => seen.push(p));
      fire(channel, 'free-form');
      expect(seen).toEqual(['free-form']);
      register(boom);
      expect(() => fire(channel, 'free-form')).not.toThrow();
    });
  }
});
