import { test, expect, beforeEach } from 'bun:test';
import { configureKortix } from '../http/config';
import { createKortixSession } from './session';

let refreshCalls: string[] = [];
let refreshStatus = 200;
let clock = Date.parse('2026-08-26T10:00:00Z');

beforeEach(() => {
  refreshCalls = [];
  refreshStatus = 200;
  clock = Date.parse('2026-08-26T10:00:00Z');
  configureKortix({
    backendUrl: 'http://backend.local/v1',
    getToken: async () => null,
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      refreshCalls.push(body.refresh_token);
      if (refreshStatus !== 200) return Response.json({ error: 'invalid_grant', error_description: 'dead' }, { status: refreshStatus });
      const n = refreshCalls.length;
      return Response.json({
        session: { access_token: `at_${n}`, refresh_token: `rt_${n}`, token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(clock / 1000) + 3600 },
        user: { id: 'u1', email: 'a@b' },
      });
    },
  });
});

const fresh = () => ({ access_token: 'at_0', refresh_token: 'rt_0', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(clock / 1000) + 3600 });

test('getToken returns the stored token while it is fresh and never calls refresh', async () => {
  const s = createKortixSession({ now: () => clock });
  await s.set(fresh(), { id: 'u1' });
  expect(await s.getToken()).toBe('at_0');
  expect(refreshCalls).toEqual([]);
  expect(s.user()).toEqual({ id: 'u1' });
});

test('getToken refreshes once, 60s before expiry, and concurrent callers share the rotation', async () => {
  const s = createKortixSession({ now: () => clock });
  await s.set(fresh());
  clock += 3600 * 1000 - 30 * 1000; // 30s before expiry → inside the skew
  const [a, b, c] = await Promise.all([s.getToken(), s.getToken(), s.getToken()]);
  expect([a, b, c]).toEqual(['at_1', 'at_1', 'at_1']);
  expect(refreshCalls).toEqual(['rt_0']);
  expect(s.current()!.refresh_token).toBe('rt_1');
});

test('a dead refresh token signs out (storage cleared, onChange(null))', async () => {
  const changes: unknown[] = [];
  const store = new Map<string, string>();
  const storage = { get: () => store.get('k') ?? null, set: (v: string) => void store.set('k', v), remove: () => void store.delete('k') };
  const s = createKortixSession({ now: () => clock, storage, onChange: (v) => changes.push(v) });
  await s.set(fresh());
  expect(store.has('k')).toBe(true);
  clock += 3600 * 1000;
  refreshStatus = 400;
  expect(await s.getToken()).toBeNull();
  expect(store.has('k')).toBe(false);
  expect(changes.at(-1)).toBeNull();
});

test('load() hydrates from storage so a new process resumes the session', async () => {
  const store = new Map<string, string>();
  store.set('k', JSON.stringify({ session: fresh(), user: { id: 'u1' } }));
  const s = createKortixSession({ now: () => clock, storage: { get: () => store.get('k') ?? null, set: (v) => void store.set('k', v), remove: () => void store.delete('k') } });
  expect(await s.getToken()).toBe('at_0');
  expect(s.user()).toEqual({ id: 'u1' });
  await s.clear();
  expect(await s.getToken()).toBeNull();
  expect(store.has('k')).toBe(false);
});

/**
 * `subscribe` — the replacement for `supabase.auth.onAuthStateChange`.
 *
 * A React provider needs to react to sign-in, refresh and sign-out, and it
 * needs to STOP reacting when it unmounts. The existing `onChange` option is a
 * single callback fixed at construction, which a provider cannot use: the last
 * component to mount would silently replace the listener of every earlier one.
 */
test('subscribe fans out to every listener and unsubscribes cleanly', async () => {
  const seenA: Array<string | null> = [];
  const seenB: Array<string | null> = [];
  const session = createKortixSession();

  const offA = session.subscribe((s) => seenA.push(s?.access_token ?? null));
  const offB = session.subscribe((s) => seenB.push(s?.access_token ?? null));

  await session.set({ access_token: 'at1', refresh_token: 'rt1', expires_at: Math.floor(Date.now() / 1000) + 3600 } as never);
  expect(seenA).toEqual(['at1']);
  expect(seenB).toEqual(['at1']);

  // One listener leaving must not disturb the other — the bug a single
  // `onChange` slot guarantees.
  offA();
  await session.clear();
  expect(seenA).toEqual(['at1']);
  expect(seenB).toEqual(['at1', null]);

  offB();
  await session.set({ access_token: 'at2', refresh_token: 'rt2', expires_at: Math.floor(Date.now() / 1000) + 3600 } as never);
  expect(seenB).toEqual(['at1', null]);
});

test('a throwing listener cannot break the others or the session write', async () => {
  const seen: string[] = [];
  const session = createKortixSession();
  session.subscribe(() => {
    throw new Error('listener blew up');
  });
  session.subscribe((s) => seen.push(s?.access_token ?? 'null'));

  await session.set({ access_token: 'at1', refresh_token: 'rt1', expires_at: Math.floor(Date.now() / 1000) + 3600 } as never);
  expect(seen).toEqual(['at1']);
  expect(session.current()?.access_token).toBe('at1');
});

// ── Concurrency: hydration and in-flight refreshes ──────────────────────────
//
// Persistent storage on React Native and servers (AsyncStorage, a file, a DB
// row) resolves on a later macrotask. Every caller that arrives while that
// read is pending must wait for the SAME hydration, not read a half-loaded
// store. And a refresh that was in flight when the host called `clear()` or
// `set()` must not write its older result over the newer state.

/** Storage whose `get` resolves on a later macrotask, like AsyncStorage. */
function slowStorage(initial: string | null) {
  const box = { value: initial, reads: 0 };
  return {
    box,
    storage: {
      get: () => {
        box.reads += 1;
        // The value is read when the call is made, as a real async store does.
        const value = box.value;
        return new Promise<string | null>((resolve) => setTimeout(() => resolve(value), 1));
      },
      set: (v: string) => {
        box.value = v;
      },
      remove: () => {
        box.value = null;
      },
    },
  };
}

/** A refresh endpoint that answers only when the test releases it. */
function gatedRefresh() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  configureKortix({
    backendUrl: 'http://backend.local/v1',
    getToken: async () => null,
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      refreshCalls.push(body.refresh_token);
      await gate;
      return Response.json({
        session: { access_token: 'at_refreshed', refresh_token: 'rt_refreshed', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(clock / 1000) + 3600 },
        user: { id: 'u_refreshed' },
      });
    },
  });
  return { release: () => release() };
}

test('concurrent getToken() calls during async hydration all resolve to the stored token', async () => {
  const { box, storage } = slowStorage(JSON.stringify({ session: fresh(), user: null }));
  const s = createKortixSession({ now: () => clock, storage });
  const tokens = await Promise.all([s.getToken(), s.getToken(), s.getToken()]);
  expect(tokens).toEqual(['at_0', 'at_0', 'at_0']);
  // One hydration, shared by every caller.
  expect(box.reads).toBe(1);
});

test('a storage read that fails is retried by the next call instead of pinning an empty session', async () => {
  let failNext = true;
  const stored = JSON.stringify({ session: fresh(), user: null });
  const storage = {
    get: async () => {
      if (failNext) {
        failNext = false;
        throw new Error('storage unavailable');
      }
      return stored;
    },
    set: () => {},
    remove: () => {},
  };
  const s = createKortixSession({ now: () => clock, storage });
  await expect(s.getToken()).rejects.toThrow('storage unavailable');
  expect(await s.getToken()).toBe('at_0');
});

test('clear() during hydration is not overwritten by the stored session', async () => {
  const { box, storage } = slowStorage(JSON.stringify({ session: fresh(), user: null }));
  const s = createKortixSession({ now: () => clock, storage });
  const hydrating = s.load();
  await s.clear();
  await hydrating;
  expect(s.current()).toBeNull();
  expect(await s.getToken()).toBeNull();
  expect(box.value).toBeNull();
});

test('clear() during an in-flight refresh stays signed out', async () => {
  const { release } = gatedRefresh();
  const store = new Map<string, string>();
  const storage = { get: () => store.get('k') ?? null, set: (v: string) => void store.set('k', v), remove: () => void store.delete('k') };
  const s = createKortixSession({ now: () => clock, storage });
  await s.set(fresh(), { id: 'u1' });
  clock += 3600 * 1000; // expired → getToken refreshes
  const pending = s.getToken();
  await new Promise((r) => setTimeout(r, 1));
  expect(refreshCalls).toEqual(['rt_0']);

  await s.clear();
  release();
  await pending;

  expect(s.current()).toBeNull();
  expect(s.user()).toBeNull();
  expect(store.has('k')).toBe(false);
});

test('set() of a new session during an in-flight refresh keeps the new session', async () => {
  const { release } = gatedRefresh();
  const s = createKortixSession({ now: () => clock });
  await s.set(fresh(), { id: 'u1' });
  clock += 3600 * 1000;
  const pending = s.getToken();
  await new Promise((r) => setTimeout(r, 1));

  const next = { access_token: 'at_B', refresh_token: 'rt_B', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(clock / 1000) + 3600 };
  await s.set(next, { id: 'u2' });
  release();
  await pending;

  expect(s.current()?.access_token).toBe('at_B');
  expect(s.user()).toEqual({ id: 'u2' });
  expect(await s.getToken()).toBe('at_B');
});

test('a refresh started after set() is not cancelled by the older refresh settling', async () => {
  // The older refresh's `finally` must not clear the NEWER in-flight slot.
  const { release } = gatedRefresh();
  const s = createKortixSession({ now: () => clock });
  await s.set(fresh());
  clock += 3600 * 1000;
  const first = s.refresh();
  await new Promise((r) => setTimeout(r, 1));
  const expired = { access_token: 'at_B', refresh_token: 'rt_B', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(clock / 1000) - 10 };
  await s.set(expired);
  const second = s.refresh();
  const third = s.refresh();
  release();
  await Promise.all([first, second, third]);
  // One rotation for the old token, one shared rotation for the new token.
  expect(refreshCalls).toEqual(['rt_0', 'rt_B']);
});
