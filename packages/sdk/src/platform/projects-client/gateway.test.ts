import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../config';
import {
  createGatewayKey,
  deleteGatewayBudget,
  getGatewayBudgets,
  getGatewayKeys,
  getGatewayOverview,
  listGatewayLogs,
  revokeGatewayKey,
  setGatewayBudget,
} from './gateway';

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

test('listGatewayLogs builds the query string from limit/offset/ok', async () => {
  nextResponse = { status: 200, body: { logs: [], next_offset: null } };
  await listGatewayLogs('P1', { limit: 10, offset: 20, ok: false });
  expect(last().url).toContain('/projects/P1/gateway/logs?');
  expect(last().url).toContain('limit=10');
  expect(last().url).toContain('offset=20');
  expect(last().url).toContain('ok=false');
});

test('getGatewayOverview omits the days param when not provided', async () => {
  nextResponse = {
    status: 200,
    body: { window_days: 7, requests: 0, errors: 0, total_cost: 0, input_tokens: 0, output_tokens: 0 },
  };
  await getGatewayOverview('P1');
  expect(last().url).toBe('http://test.local/projects/P1/gateway/overview');
});

test('getGatewayBudgets hits the budgets collection', async () => {
  nextResponse = {
    status: 200,
    body: { project_spend: { requests: 0, cost: 0 }, budgets: [], members: [] },
  };
  const result = await getGatewayBudgets('P1');
  expect(last().url).toContain('/projects/P1/gateway/budgets');
  expect(result.budgets).toEqual([]);
});

test('setGatewayBudget PUTs the budget input', async () => {
  nextResponse = { status: 200, body: { ok: true } };
  await setGatewayBudget('P1', { scope: 'project', limit_usd: 100, period: 'month', action: 'block' });
  expect(last().method).toBe('PUT');
  expect(last().body).toEqual({ scope: 'project', limit_usd: 100, period: 'month', action: 'block' });
});

test('deleteGatewayBudget deletes by budget id', async () => {
  nextResponse = { status: 200, body: { ok: true } };
  await deleteGatewayBudget('P1', 'B1');
  expect(last().url).toContain('/projects/P1/gateway/budgets/B1');
  expect(last().method).toBe('DELETE');
});

test('createGatewayKey posts a name and revokeGatewayKey deletes by id', async () => {
  nextResponse = { status: 200, body: { key_id: 'k1', name: 'ci', key_prefix: 'sk_', secret_key: 'sk_full' } };
  await createGatewayKey('P1', 'ci');
  expect(last().url).toContain('/projects/P1/gateway/keys');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({ name: 'ci' });

  nextResponse = { status: 200, body: { ok: true } };
  await revokeGatewayKey('P1', 'k1');
  expect(last().url).toContain('/projects/P1/gateway/keys/k1');
  expect(last().method).toBe('DELETE');
});

test('getGatewayKeys returns the keys list', async () => {
  nextResponse = { status: 200, body: { keys: [], gateway_url: 'https://gw.local' } };
  const result = await getGatewayKeys('P1');
  expect(result.gateway_url).toBe('https://gw.local');
});
