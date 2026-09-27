/**
 * GET /:projectId/branches returned every remote branch — 977KB on a busy
 * prod project, dominated by thousands of auto-created session branches. The
 * server now caps the list and accepts `q`/`limit`/`include_session_branches`
 * (absent = include); this proves the SDK forwards an explicit value either way.
 */
import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import { listProjectBranches } from './git-history';

let calls: { url: string }[] = [];

beforeEach(() => {
  calls = [];
  globalThis.fetch = mock(async (url: unknown) => {
    calls.push({ url: String(url) });
    return new Response(JSON.stringify({ default_branch: 'main', branches: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
const last = () => calls[calls.length - 1]!;

test('no options: no query string (server applies its own default limit)', async () => {
  await listProjectBranches('P1');
  expect(last().url).toBe('http://test.local/projects/P1/branches');
});

test('forwards q, limit, and includeSessionBranches as query params', async () => {
  await listProjectBranches('P1', { q: 'feature', limit: 100, includeSessionBranches: true });
  const url = new URL(last().url);
  expect(url.pathname).toBe('/projects/P1/branches');
  expect(url.searchParams.get('q')).toBe('feature');
  expect(url.searchParams.get('limit')).toBe('100');
  expect(url.searchParams.get('include_session_branches')).toBe('true');
});

test('includeSessionBranches: false reaches the wire (the server includes them by default)', async () => {
  await listProjectBranches('P1', { includeSessionBranches: false });
  const url = new URL(last().url);
  expect(url.searchParams.get('include_session_branches')).toBe('false');
});
