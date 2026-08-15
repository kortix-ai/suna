import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import { getProjectStarterSuggestions } from './starter-suggestions';

let calls: { url: string; method: string; body: unknown }[] = [];
let nextResponse: { status: number; body: unknown } = { status: 200, body: {} };

beforeEach(() => {
  calls = [];
  nextResponse = { status: 200, body: {} };
  globalThis.fetch = mock(async (url: unknown, opts: { method?: string; body?: string } = {}) => {
    calls.push({
      url: String(url),
      method: opts.method ?? 'GET',
      body: opts.body ? JSON.parse(opts.body) : undefined,
    });
    return new Response(JSON.stringify(nextResponse.body), {
      status: nextResponse.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
const last = () => calls[calls.length - 1];

test('getProjectStarterSuggestions GETs /projects/:id/starter-suggestions', async () => {
  nextResponse = {
    status: 200,
    body: {
      source: 'personalized',
      generated_at: '2026-08-15T00:00:00.000Z',
      items: [{ id: 's1', label: 'Ship a feature', prompt: 'Help me ship a feature' }],
    },
  };
  const result = await getProjectStarterSuggestions('P1');
  expect(last().url).toContain('/projects/P1/starter-suggestions');
  expect(last().method).toBe('GET');
  expect(result).toEqual({
    source: 'personalized',
    generated_at: '2026-08-15T00:00:00.000Z',
    items: [{ id: 's1', label: 'Ship a feature', prompt: 'Help me ship a feature' }],
  });
});

test('getProjectStarterSuggestions passes through the static fallback shape', async () => {
  nextResponse = {
    status: 200,
    body: { source: 'static', generated_at: null, items: [] },
  };
  const result = await getProjectStarterSuggestions('P1');
  expect(result).toEqual({ source: 'static', generated_at: null, items: [] });
});

test('getProjectStarterSuggestions throws on failure', async () => {
  nextResponse = { status: 500, body: { message: 'boom' } };
  await expect(getProjectStarterSuggestions('P1')).rejects.toBeTruthy();
});
