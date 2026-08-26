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
