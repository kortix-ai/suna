import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import { deleteChromeConnection, listChromeConnections, updateChromeConnection, type ChromeConnection } from './chrome';

type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];
let next: { status: number; body: unknown } = { status: 200, body: {} };

beforeEach(() => {
  calls = [];
  next = { status: 200, body: {} };
  globalThis.fetch = mock(async (input: unknown, init: RequestInit = {}) => {
    calls.push({
      url: String(input instanceof Request ? input.url : input),
      method: init.method ?? 'GET',
      body: init.body,
    });
    return new Response(next.status === 204 ? null : JSON.stringify(next.body), {
      status: next.status,
      headers: next.status === 204 ? {} : { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
const last = () => calls[calls.length - 1]!;

const chrome: ChromeConnection = {
  id: 'b1',
  name: 'Chrome · Work',
  brand: 'Chrome',
  os: 'macOS',
  profileLabel: 'Work',
  extensionVersion: '1.0.0',
  accessMode: 'always',
  tabScope: 'own',
  online: true,
  lastSeenAt: '2026-10-12T10:00:00Z',
  createdAt: '2026-10-12T09:00:00Z',
  activeSessions: [{ sessionId: 's1', projectId: 'p1', title: 'Research' }],
};

test('listChromeConnections GETs /chrome/connections and returns the array', async () => {
  next = { status: 200, body: [chrome] };
  const out = await listChromeConnections();
  expect(last().method).toBe('GET');
  expect(last().url).toBe('http://test.local/chrome/connections');
  expect(out).toEqual([chrome]);
});

test('updateChromeConnection PATCHes only the given fields to /chrome/connections/:id', async () => {
  next = { status: 200, body: { ...chrome, name: 'Home' } };
  const out = await updateChromeConnection('b/1', { name: 'Home' });
  expect(last().method).toBe('PATCH');
  expect(last().url).toBe('http://test.local/chrome/connections/b%2F1');
  expect(JSON.parse(String(last().body))).toEqual({ name: 'Home' });
  expect(out.name).toBe('Home');
});

test('deleteChromeConnection DELETEs /chrome/connections/:id and accepts 204', async () => {
  next = { status: 204, body: null };
  await deleteChromeConnection('b1');
  expect(last().method).toBe('DELETE');
  expect(last().url).toBe('http://test.local/chrome/connections/b1');
});

test('a failed request rejects with the API error', async () => {
  next = { status: 404, body: { error: 'Not found', code: 'chrome_not_found' } };
  await expect(deleteChromeConnection('nope')).rejects.toBeDefined();
});
