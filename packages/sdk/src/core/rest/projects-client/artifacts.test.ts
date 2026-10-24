import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import { listArtifacts, updateArtifact } from './artifacts';

let calls: { url: string; method: string; body: unknown }[] = [];

beforeEach(() => {
  calls = [];
  globalThis.fetch = mock(async (url: unknown, opts: { method?: string; body?: string } = {}) => {
    calls.push({ url: String(url), method: opts.method ?? 'GET', body: opts.body ? JSON.parse(opts.body) : undefined });
    return new Response(JSON.stringify({ artifacts: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
const last = () => calls[calls.length - 1]!;
const BASE = 'http://test.local/projects/p1/artifacts';

test('listArtifacts filters by space, by each agent of that space (repeated), or by unbound', async () => {
  await listArtifacts('p1', { space: 'ops', agents: ['builder', 'writer'] });
  expect(last().url).toBe(`${BASE}?space=ops&agent=builder&agent=writer`);
  await listArtifacts('p1', { unbound: true, limit: 5 });
  expect(last().url).toBe(`${BASE}?limit=5&unbound=1`);
  await listArtifacts('p1', { agents: [] });
  expect(last().url).toBe(BASE);
});

test('updateArtifact sends a binding; null clears it', async () => {
  await updateArtifact('p1', 'a1', { space: 'ops', agent: null });
  expect(last()).toMatchObject({ method: 'PATCH', url: `${BASE}/a1`, body: { space: 'ops', agent: null } });
});
