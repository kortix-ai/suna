import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../config';
import { requestProjectConnector, requestProjectSecret } from './setup-links';

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

test('requestProjectSecret posts names/labels/descriptions/scope to secret-requests', async () => {
  nextResponse = {
    status: 200,
    body: { kind: 'secret', url: 'https://app.local/secret-intake/tok', names: ['STRIPE_KEY'], scope: 'runtime', expires_at: '2026-01-01' },
  };
  const result = await requestProjectSecret('P1', { names: ['STRIPE_KEY'], scope: 'runtime' });
  expect(last().url).toContain('/projects/P1/secret-requests');
  expect(last().method).toBe('POST');
  expect(last().body).toMatchObject({ names: ['STRIPE_KEY'], scope: 'runtime' });
  expect(result.url).toContain('/secret-intake/');
});

test('requestProjectSecret throws on failure', async () => {
  nextResponse = { status: 400, body: { message: 'names is required' } };
  await expect(requestProjectSecret('P1', { names: [] })).rejects.toThrow();
});

test('requestProjectConnector posts slug to connect-requests', async () => {
  nextResponse = {
    status: 200,
    body: { kind: 'connector', url: 'https://app.local/connect/tok', slug: 'github', app: 'github', expires_at: '2026-01-01' },
  };
  const result = await requestProjectConnector('P1', { slug: 'github' });
  expect(last().url).toContain('/projects/P1/connect-requests');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({ slug: 'github', expires_in_minutes: undefined });
  expect(result.slug).toBe('github');
});
