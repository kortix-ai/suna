import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import { setWorkspaceModelEnablement } from './model-enablement';

let calls: { url: string; method: string; body: unknown }[] = [];
let nextResponse: { status: number; body: unknown } = { status: 200, body: {} };

beforeEach(() => {
  calls = [];
  nextResponse = { status: 200, body: { ok: true, modelOverrides: {} } };
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

test('PUTs the override map to the workspace model-enablement endpoint', async () => {
  nextResponse = { status: 200, body: { ok: true, modelOverrides: { 'glm-5.2': false } } };
  const res = await setWorkspaceModelEnablement('proj-1', { 'glm-5.2': false });
  expect(last().method).toBe('PUT');
  expect(last().url).toContain('/workspaces/proj-1/model-enablement');
  expect(last().body).toEqual({ modelOverrides: { 'glm-5.2': false } });
  expect(res).toEqual({ ok: true, modelOverrides: { 'glm-5.2': false } });
});

test('sends an empty map to drop every exception and restore the default', async () => {
  await setWorkspaceModelEnablement('proj-1', {});
  expect(last().body).toEqual({ modelOverrides: {} });
});
