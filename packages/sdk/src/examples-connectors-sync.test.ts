// examples/13-connectors-as-code.ts is the documented template for an
// unattended connector sync. This test holds its retry contract.
import { beforeEach, expect, mock, test } from 'bun:test';
import { syncAll } from '../examples/13-connectors-as-code';
import { ConnectorPageLimitError } from './index';

let requests: Array<Record<string, unknown>> = [];

beforeEach(() => {
  requests = [];
});

function serve(replies: Array<{ status: number; body: unknown }>) {
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push(JSON.parse(String(init?.body ?? (await request.text()))).args);
    const next = replies.shift()!;
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

const page = (cursor: string | null) => ({
  status: 200,
  body: { ok: true, output: { next_cursor: cursor }, binding: 'openapi', upstream_status: 200 },
});
const rateLimit = {
  status: 429,
  body: { ok: false, status: 'error', reason: 'upstream_429', upstream_status: 429, retry_after_seconds: 0 },
};

const options = {
  backendUrl: 'http://sync.local/v1',
  token: 'kortix_pat_synthetic',
  projectId: 'p1',
  connector: 'crm',
  action: 'list',
  args: { limit: 1 },
  cursorField: 'next_cursor',
  cursorArg: 'cursor',
};

test('syncAll survives rate limits spread over a sync: only consecutive 429s count', async () => {
  serve([page('c1'), rateLimit, page('c2'), rateLimit, page('c3'), rateLimit, page(null)]);
  const seen: unknown[] = [];
  const pages = await syncAll({ ...options, onPage: (output) => void seen.push(output) });
  expect(pages).toBe(4);
  expect(seen).toHaveLength(4);
  expect(requests).toEqual([
    { limit: 1 },
    { limit: 1, cursor: 'c1' },
    { limit: 1, cursor: 'c1' },
    { limit: 1, cursor: 'c2' },
    { limit: 1, cursor: 'c2' },
    { limit: 1, cursor: 'c3' },
    { limit: 1, cursor: 'c3' },
  ]);
});

test('syncAll gives up after 3 consecutive rate limits on one page', async () => {
  serve([page('c1'), rateLimit, rateLimit, rateLimit]);
  const error = await syncAll({ ...options, onPage: () => {} }).then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  expect(String((error as Error).message)).toContain('rate limited');
  expect(requests).toHaveLength(4);
});

test('syncAll fails with ConnectorPageLimitError past 100 pages in total, across a rate-limit resume', async () => {
  const replies: Array<{ status: number; body: unknown }> = Array.from({ length: 100 }, (_, i) => page(`c${i + 1}`));
  replies.splice(50, 0, rateLimit);
  serve(replies);
  let applied = 0;
  const error = await syncAll({ ...options, onPage: () => void (applied += 1) }).then(
    () => null,
    (e: unknown) => e,
  );
  expect(applied).toBe(100);
  expect(requests).toHaveLength(101);
  expect(error).toBeInstanceOf(ConnectorPageLimitError);
  expect((error as ConnectorPageLimitError).nextArgs).toEqual({ limit: 1, cursor: 'c100' });
});
