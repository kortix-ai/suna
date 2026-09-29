import { describe, expect, test } from 'bun:test';

import { callSandbox, page, type Sandbox } from './index';

const ctx = (dispatch: (r: Request) => Promise<Response>, deadlineInMs: number) =>
  ({ authorization: 'Bearer x', origin: 'http://api.test', headers: new Headers(), dispatch, deadline: Date.now() + deadlineInMs }) as Parameters<typeof callSandbox>[0];

describe('callSandbox', () => {
  test('a sandbox that stays not ready to the deadline answers with the actionable text, not the raw 503', async () => {
    const seen: string[] = [];
    const dispatch = async (r: Request) => {
      const url = new URL(r.url);
      seen.push(`${r.method} ${url.pathname}`);
      if (url.pathname.endsWith('/start')) return Response.json({ reason: 'runtime_updating', runtime_url: '/v1/p/ext1/8000' });
      return new Response('{"error":"sandbox not ready","retry":true}', { status: 503 });
    };
    const sandbox: Sandbox = { session: '/v1/projects/p/sessions/s', base: '/v1/p/ext1/8000' };
    // The budget ends 5 s before the deadline: attempt, wake, 2 s sleep, attempt, then the text.
    const r = await callSandbox(ctx(dispatch, 6_500), sandbox, 'GET', '/file');
    expect(r.status).toBe(504);
    expect(r.body).toBe('The sandbox is still starting (reason runtime_updating). Call again; it keeps booting.');
    expect(seen).toEqual(['GET /v1/p/ext1/8000/file', 'POST /v1/projects/p/sessions/s/start', 'GET /v1/p/ext1/8000/file']);
  });

  test('a resolved sandbox skips the session lookup: only the daemon call goes out', async () => {
    const seen: string[] = [];
    const dispatch = async (r: Request) => {
      seen.push(new URL(r.url).pathname);
      return new Response('{"ok":true}', { status: 200 });
    };
    const sandbox: Sandbox = { session: '/v1/projects/p/sessions/s', base: '/v1/p/ext1/8000' };
    for (let i = 0; i < 3; i++) await callSandbox(ctx(dispatch, 60_000), sandbox, 'POST', '/kortix/env-rpc', { body: {} });
    expect(seen).toEqual(Array(3).fill('/v1/p/ext1/8000/kortix/env-rpc'));
  });
});

describe('page', () => {
  const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`);
  test('limit cuts and names the offset that continues; the last page has no note', () => {
    expect(page(lines, 0, 3, 'lines')).toBe('line 0\nline 1\nline 2\n… 7 more lines; call again with offset=3');
    expect(page(lines, 8, 3, 'lines')).toBe('line 8\nline 9');
  });
  test('the character cap cuts on an item boundary', () => {
    const big = Array.from({ length: 5 }, () => 'x'.repeat(20_000));
    expect(page(big, 0, undefined, 'entries')).toEndWith('… 3 more entries; call again with offset=2');
  });
  test('an offset past the end says how many there are', () => {
    expect(page(lines, 10, undefined, 'lines')).toBe('Nothing at offset 10: 10 lines in all.');
  });
});
