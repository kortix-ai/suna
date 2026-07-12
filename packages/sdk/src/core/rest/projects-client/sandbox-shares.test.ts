import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import { createSandboxShare, listSandboxShares, revokeSandboxShare } from './sandbox-shares';

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

test('listSandboxShares hits /p/share with the sandbox_id query param, not a project path', async () => {
  nextResponse = {
    status: 200,
    body: { shares: [{ url: 'https://x/y', port: 8000, token: 'tok1', expiresAt: '2026-01-01' }] },
  };
  const result = await listSandboxShares('SB1');
  expect(last().url).toBe('http://test.local/p/share?sandbox_id=SB1');
  expect(last().method).toBe('GET');
  expect(result).toHaveLength(1);
  expect(result[0].token).toBe('tok1');
});

test('listSandboxShares defaults to an empty array when the response has no shares', async () => {
  nextResponse = { status: 200, body: {} };
  const result = await listSandboxShares('SB1');
  expect(result).toEqual([]);
});

test('createSandboxShare posts sandbox_id/port/ttl/label to /p/share', async () => {
  nextResponse = { status: 200, body: { url: 'https://x/y', expiresAt: '2026-01-01', label: 'demo' } };
  const result = await createSandboxShare({ sandboxId: 'SB1', port: 8000, ttl: '1h', label: 'demo' });
  expect(last().url).toBe('http://test.local/p/share');
  expect(last().method).toBe('POST');
  expect(last().body).toEqual({ sandbox_id: 'SB1', port: 8000, ttl: '1h', label: 'demo' });
  expect(result.url).toBe('https://x/y');
});

test('createSandboxShare throws with the server error message on failure', async () => {
  nextResponse = { status: 500, body: { error: 'boom' } };
  await expect(createSandboxShare({ sandboxId: 'SB1', port: 8000 })).rejects.toThrow('boom');
});

test('revokeSandboxShare deletes by token with the sandbox_id query param', async () => {
  nextResponse = { status: 200, body: { ok: true } };
  await revokeSandboxShare('SB1', 'TOK1');
  expect(last().url).toBe('http://test.local/p/share/TOK1?sandbox_id=SB1');
  expect(last().method).toBe('DELETE');
});

test('revokeSandboxShare throws on failure', async () => {
  nextResponse = { status: 500, body: { error: 'nope' } };
  await expect(revokeSandboxShare('SB1', 'TOK1')).rejects.toThrow('nope');
});
