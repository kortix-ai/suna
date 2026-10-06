import { describe, expect, test } from 'bun:test';
import { CAPTURE_TOOLS, MAX_TEXT, captureError, isCaptureTool, runCaptureTool } from './capture';
import type { Host } from './connectors';

const A = '01a10000-0000-7000-8000-000000000001';
const U = '01a10000-0000-7000-8000-000000000002';

/** A host that answers from a route table and records every call. */
function host(routes: Record<string, (query: Record<string, unknown>, body: unknown) => { status: number; body: unknown }>) {
  const calls: Array<{ method: string; path: string; query?: Record<string, unknown>; body?: unknown }> = [];
  const h: Host = {
    async call(method, path, opts) {
      calls.push({ method, path, query: opts?.query, body: opts?.body });
      const handler = routes[`${method} ${path}`];
      const r = handler ? handler(opts?.query ?? {}, opts?.body) : { status: 404, body: { error: 'Not found' } };
      return { status: r.status, body: JSON.stringify(r.body) };
    },
    text: (value, isError = false) => ({ content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) }),
    apiResult: (r) => ({ content: [{ type: 'text', text: `HTTP ${r.status}\n${r.body}` }], isError: r.status >= 400 }),
    input: (message) => new Error(message),
    arg: (input, key) => {
      const v = input[key];
      if (typeof v !== 'string' || !v) throw new Error(`${key} is required`);
      return v;
    },
    optionalArg: (input, key) => (typeof input[key] === 'string' && input[key] ? (input[key] as string) : undefined),
    projectId: () => '',
    readSandboxFile: async () => ({ content: [] }),
  };
  return { h, calls };
}
const json = (r: { content: Array<{ type: string; text?: string }> }) => JSON.parse(r.content[0]!.text!);

describe('the Capture tools', () => {
  test('nine tools, every one read-only except the export, each with an object schema', () => {
    expect(CAPTURE_TOOLS.map((t) => t.name)).toEqual([
      'capture_accounts', 'capture_search', 'capture_timeline', 'capture_frame', 'capture_episodes', 'capture_episode', 'capture_workflows', 'capture_workflow', 'capture_export',
    ]);
    for (const t of CAPTURE_TOOLS) {
      expect(t.inputSchema.type).toBe('object');
      expect(t.annotations.readOnlyHint).toBe(t.name !== 'capture_export');
      expect(isCaptureTool(t.name)).toBe(true);
    }
    expect(isCaptureTool('capture_ask')).toBe(false);
  });

  test('search maps to the REST route: kinds joined, limit capped at 50, scope passed, long snippets cut', async () => {
    const { h, calls } = host({ [`GET /v1/accounts/${A}/capture/search`]: () => ({ status: 200, body: { q: 'refund', hits: [{ kind: 'screen', id: 'f1', snippet: 'x'.repeat(1000) }] } }) });
    const r = await runCaptureTool('capture_search', { account_id: A, query: 'refund', kinds: ['screen', 'audio'], scope: 'account', limit: 500 }, h);
    expect(calls[0]!.query).toMatchObject({ q: 'refund', kinds: 'screen,audio', scope: 'account', limit: 50 });
    expect(json(r).hits[0].snippet.length).toBe(MAX_TEXT + 1);
  });

  test('Capture off and a forbidden scope come back as errors the agent can act on', async () => {
    expect(captureError({ status: 403, body: JSON.stringify({ code: 'capture_disabled', error: 'off' }) })).toContain('Kortix Capture is off');
    expect(captureError({ status: 403, body: JSON.stringify({ code: 'capture_forbidden', error: 'Only Capture admins and viewers can read another member' }) })).toContain('omit user_id and scope');
    const { h } = host({ [`GET /v1/accounts/${A}/capture/episodes`]: () => ({ status: 403, body: { code: 'capture_forbidden', error: 'No' } }) });
    const r = await runCaptureTool('capture_episodes', { account_id: A, scope: 'account' }, h);
    expect(r.isError).toBe(true);
  });

  test('bad ids are refused before any call', async () => {
    const { h, calls } = host({});
    await expect(runCaptureTool('capture_episode', { account_id: A, episode_id: 'nope' }, h)).rejects.toThrow('episode_id must be a UUID');
    await expect(runCaptureTool('capture_search', { account_id: 'x', query: 'q' }, h)).rejects.toThrow('account_id must be a UUID');
    expect(calls).toEqual([]);
  });

  test('a workflow lists its people with their email from the account member directory; episodes page by cursor', async () => {
    const { h, calls } = host({
      [`GET /v1/accounts/${A}/capture/workflows/${U}`]: () => ({ status: 200, body: { workflow_id: U, name: 'Refund', people: [{ user_id: U, runs: 4 }] } }),
      [`GET /v1/accounts/${A}/members`]: () => ({ status: 200, body: [{ user_id: U, email: 'member@example.test' }] }),
      [`GET /v1/accounts/${A}/capture/episodes`]: () => ({ status: 200, body: { episodes: [{ episode_id: 'e1', user_id: U }], next_before: '2026-09-01T00:00:00.000Z' } }),
    });
    expect(json(await runCaptureTool('capture_workflow', { account_id: A, workflow_id: U }, h)).people).toEqual([{ user_id: U, runs: 4, email: 'member@example.test' }]);
    const page = json(await runCaptureTool('capture_episodes', { account_id: A, cursor: '2026-09-02T00:00:00.000Z', limit: 1000 }, h));
    expect(page.next_cursor).toBe('2026-09-01T00:00:00.000Z');
    // A person's own episodes need no directory read.
    expect(page.episodes[0].email).toBeUndefined();
    expect(calls.at(-1)!.query).toMatchObject({ before: '2026-09-02T00:00:00.000Z', limit: 100 });
  });

  test('the timeline needs a window, drops OCR boxes and cuts on-screen text', async () => {
    const { h } = host({
      [`GET /v1/accounts/${A}/capture/timeline/items`]: () => ({ status: 200, body: { frames: [{ frame_id: 'f', ocr_text: 'y'.repeat(900), ocr_boxes: [1] }], actions: [], audio: [] } }),
    });
    await expect(runCaptureTool('capture_timeline', { account_id: A }, h)).rejects.toThrow('from and to are required');
    const t = json(await runCaptureTool('capture_timeline', { account_id: A, from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z' }, h));
    expect(t.frames[0]).toEqual({ frame_id: 'f', text: `${'y'.repeat(MAX_TEXT)}…` });
  });
});
