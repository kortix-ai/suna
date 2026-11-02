import { beforeEach, describe, expect, test } from 'bun:test';
import { ApiError } from '../http/api/errors';
import { __resetRuntimeActionsMemo } from './runtime-actions';
import { createRuntimeVerbs } from './runtime-verbs';

beforeEach(() => __resetRuntimeActionsMemo());

const RUNTIME = 'http://api.test/v1/p/sbx_1/8000';

type Answer = { status?: number; body?: unknown; contentType?: string };

function fakeRuntime(routes: Record<string, Answer | ((request: Request) => Answer)>) {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const fetch = (async (request: Request) => {
    const url = new URL(request.url);
    const path = `${url.pathname.replace('/v1/p/sbx_1/8000', '')}${url.search}`;
    // A box from before the session-log actions: its health lists none of them.
    if (path === '/kortix/health' && !routes['GET /kortix/health']) return Response.json({ capabilities: ['runtime.turns.v1'] });
    const body = request.body ? JSON.parse(await request.text()) : null;
    requests.push({ method: request.method, path, body });
    const route = routes[`${request.method} ${path}`];
    const answer = typeof route === 'function' ? route(request) : (route ?? { status: 404, body: { error: 'not found' } });
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
      status: answer.status ?? 200,
      headers: { 'content-type': answer.contentType ?? 'application/json' },
    });
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

const message = (id: string) => ({ info: { id, role: 'user', sessionID: 'ses_root' }, parts: [] });

describe('session runtime verbs', () => {
  test('messages() reads the Kortix transcript route of the session root', async () => {
    const { fetch, requests } = fakeRuntime({
      'GET /kortix/runtime/messages/ses_root?limit=2&before=msg_9': {
        body: { messages: [message('msg_1'), message('msg_2')], has_more: true },
      },
    });
    const verbs = createRuntimeVerbs({ runtimeUrl: RUNTIME, rootId: 'ses_root', fetch });
    const page = await verbs.messages({ limit: 2, before: 'msg_9' });
    expect(page.messages.map((m) => m.info.id)).toEqual(['msg_1', 'msg_2']);
    expect(page.hasMore).toBe(true);
    expect(requests).toHaveLength(1);
  });

  test('messages() falls back to the pre-W3 route on a daemon without /kortix/runtime', async () => {
    const { fetch, requests } = fakeRuntime({
      'GET /kortix/runtime/messages/ses_root': { status: 404, body: { error: 'not found' } },
      'GET /kortix/opencode/messages/ses_root': { body: { messages: [message('msg_1')], has_more: false } },
    });
    const verbs = createRuntimeVerbs({ runtimeUrl: RUNTIME, rootId: 'ses_root', fetch });
    const page = await verbs.messages();
    expect(page).toEqual({ messages: [message('msg_1')] as never, hasMore: false });
    expect(requests.map((r) => r.path)).toEqual([
      '/kortix/runtime/messages/ses_root',
      '/kortix/opencode/messages/ses_root',
    ]);
  });

  test('messages() pages backwards past the 200-message page for a larger limit', async () => {
    const page = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => message(`msg_${from + i}`));
    const { fetch, requests } = fakeRuntime({
      'GET /kortix/runtime/messages/ses_root?limit=200': { body: { messages: page(100, 300), has_more: true } },
      'GET /kortix/runtime/messages/ses_root?limit=50&before=msg_100': { body: { messages: page(50, 100), has_more: true } },
    });
    const verbs = createRuntimeVerbs({ runtimeUrl: RUNTIME, rootId: 'ses_root', fetch });
    const result = await verbs.messages({ limit: 250 });
    expect(result.messages.map((m) => m.info.id)).toEqual(page(50, 300).map((m) => m.info.id));
    expect(result.hasMore).toBe(true);
    expect(requests.map((r) => r.path)).toEqual([
      '/kortix/runtime/messages/ses_root?limit=200',
      '/kortix/runtime/messages/ses_root?limit=50&before=msg_100',
    ]);
  });

  test('messages() of another conversation in the session (a subagent child)', async () => {
    const { fetch } = fakeRuntime({
      'GET /kortix/runtime/messages/ses_child?limit=5': { body: { messages: [], has_more: false } },
    });
    const verbs = createRuntimeVerbs({ runtimeUrl: RUNTIME, rootId: 'ses_root', fetch });
    expect((await verbs.messages({ conversationId: 'ses_child', limit: 5 })).messages).toEqual([]);
  });

  test('messages() throws an ApiError with the status on a failed read', async () => {
    const { fetch } = fakeRuntime({
      'GET /kortix/runtime/messages/ses_root': { status: 502, body: { error: 'upstream unreachable' } },
    });
    const verbs = createRuntimeVerbs({ runtimeUrl: RUNTIME, rootId: 'ses_root', fetch });
    const error = await verbs.messages().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(502);
    expect((error as ApiError).message).toContain('upstream unreachable');
  });

  test('pending() reads statuses, permission requests and questions in one call', async () => {
    const { fetch } = fakeRuntime({
      'GET /session/status': { body: { ses_root: { type: 'busy' } } },
      'GET /permission': { body: [{ id: 'per_1', sessionID: 'ses_root', permission: 'bash', patterns: ['ls'], metadata: {}, always: ['ls'] }] },
      'GET /question': { body: [] },
    });
    const verbs = createRuntimeVerbs({ runtimeUrl: RUNTIME, rootId: 'ses_root', fetch });
    const pending = await verbs.pending();
    expect(pending.statuses).toEqual({ ses_root: { type: 'busy' } });
    expect(pending.permissions.map((p) => p.id)).toEqual(['per_1']);
    expect(pending.questions).toEqual([]);
  });

  test('answerPermission() and answerQuestion() post the reply; a null answer rejects the question', async () => {
    const { fetch, requests } = fakeRuntime({
      'POST /permission/per_1/reply': { body: true },
      'POST /question/que_1/reply': { body: true },
      'POST /question/que_2/reject': { body: true },
    });
    const verbs = createRuntimeVerbs({ runtimeUrl: RUNTIME, rootId: 'ses_root', fetch });
    await verbs.answerPermission('per_1', 'always', 'fine');
    await verbs.answerQuestion('que_1', [['Yes']]);
    await verbs.answerQuestion('que_2', null);
    expect(requests.map((r) => [r.method, r.path, r.body])).toEqual([
      ['POST', '/permission/per_1/reply', { reply: 'always', message: 'fine' }],
      ['POST', '/question/que_1/reply', { answers: [['Yes']] }],
      ['POST', '/question/que_2/reject', null],
    ]);
  });

  test('an unknown request id throws with the runtime message', async () => {
    const { fetch } = fakeRuntime({
      'POST /permission/per_x/reply': { status: 404, body: { name: 'NotFoundError', data: { message: 'no such request' } } },
    });
    const verbs = createRuntimeVerbs({ runtimeUrl: RUNTIME, rootId: 'ses_root', fetch });
    await expect(verbs.answerPermission('per_x', 'once')).rejects.toThrow('no such request');
  });

  test.each(['busy', 'retry'])('compact() refuses a %s root before submitting compaction', async (type) => {
    const { fetch, requests } = fakeRuntime({
      'GET /session/status': { body: { ses_root: { type } } },
      'POST /session/ses_root/summarize': { body: true },
    });
    const verbs = createRuntimeVerbs({ runtimeUrl: RUNTIME, rootId: 'ses_root', fetch });
    await expect(verbs.compact({ providerID: 'kortix', modelID: 'test-model' }))
      .rejects.toThrow('This session is busy. Wait for the current turn to finish, then run compact again.');
    expect(requests.map((request) => request.path)).toEqual(['/session/status']);
  });

  test('compact() accepts an omitted idle root status', async () => {
    const { fetch } = fakeRuntime({
      'GET /session/status': { body: {} },
      'POST /session/ses_root/summarize': { body: true },
    });
    const verbs = createRuntimeVerbs({ runtimeUrl: RUNTIME, rootId: 'ses_root', fetch });
    expect(await verbs.compact({ providerID: 'kortix', modelID: 'test-model' }))
      .toEqual({ providerID: 'kortix', modelID: 'test-model' });
  });

  test('compact() does not submit when reading status fails', async () => {
    const { fetch, requests } = fakeRuntime({
      'GET /session/status': { status: 503, body: { error: 'runtime unavailable' } },
    });
    const verbs = createRuntimeVerbs({ runtimeUrl: RUNTIME, rootId: 'ses_root', fetch });
    await expect(verbs.compact({ providerID: 'kortix', modelID: 'test-model' }))
      .rejects.toThrow('Reading the session status failed: runtime unavailable');
    expect(requests.map((request) => request.path)).toEqual(['/session/status']);
  });

  test('compact() translates a raced turn timeout without replaying the summary', async () => {
    const { fetch, requests } = fakeRuntime({
      'GET /session/status': { body: {} },
      'POST /session/ses_root/summarize': {
        status: 504,
        body: { code: 'LONG_TURN_PROXY_TIMEOUT', error: 'internal ALB prompt_async SSE diagnostic' },
      },
    });
    const verbs = createRuntimeVerbs({ runtimeUrl: RUNTIME, rootId: 'ses_root', fetch });
    await expect(verbs.compact({ providerID: 'kortix', modelID: 'model' })).rejects.toThrow(
      'Compaction has not finished. Check the session status before trying again.',
    );
    expect(requests.filter((r) => r.method === 'POST')).toHaveLength(1);
  });

  test('compact() summarizes the root with the given model, else the model the runtime state document names', async () => {
    const { fetch, requests } = fakeRuntime({
      'GET /session/status': { body: { ses_root: { type: 'idle' }, ses_child: { type: 'busy' } } },
      'POST /session/ses_root/summarize': { body: true },
      'GET /kortix/runtime/state': { body: { schema: 'kortix.runtime.v1', config: { known: true, value: { model: 'kortix/claude-sonnet' } } } },
    });
    const verbs = createRuntimeVerbs({ runtimeUrl: RUNTIME, rootId: 'ses_root', fetch });
    expect(await verbs.compact({ providerID: 'anthropic', modelID: 'claude' })).toEqual({ providerID: 'anthropic', modelID: 'claude' });
    expect(await verbs.compact()).toEqual({ providerID: 'kortix', modelID: 'claude-sonnet' });
    expect(requests.map((r) => [r.method, r.path, r.body])).toEqual([
      ['GET', '/session/status', null],
      ['POST', '/session/ses_root/summarize', { providerID: 'anthropic', modelID: 'claude' }],
      ['GET', '/kortix/runtime/state', null],
      ['GET', '/session/status', null],
      ['POST', '/session/ses_root/summarize', { providerID: 'kortix', modelID: 'claude-sonnet' }],
    ]);
  });

  test('compact() without a model anywhere throws MODEL_REQUIRED instead of guessing', async () => {
    for (const state of [
      { body: { config: { known: true, value: { model: null } } } },
      { body: { config: { known: false, value: null } } },
      { status: 404, body: { error: 'not found' } },
    ]) {
      const { fetch, requests } = fakeRuntime({ 'GET /session/status': { body: {} }, 'GET /kortix/runtime/state': state });
      const verbs = createRuntimeVerbs({ runtimeUrl: RUNTIME, rootId: 'ses_root', fetch });
      const error = await verbs.compact().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe('MODEL_REQUIRED');
      expect(requests.some((r) => r.path.endsWith('/summarize'))).toBe(false);
    }
  });
});

describe('session runtime verbs on a box with the session-log actions (runtime.actions.v1)', () => {
  // Each test runs against its own runtime URL: the capability read is kept per URL.
  let n = 0;
  const actionsBox = (routes: Record<string, Answer | ((request: Request) => Answer)>) => {
    const runtimeUrl = `http://api.test/v1/p/sbx_${++n}/8000`;
    const prefix = `/v1/p/sbx_${n}/8000`;
    const requests: Array<{ method: string; path: string; body: unknown }> = [];
    const all: Record<string, Answer | ((request: Request) => Answer)> = {
      'GET /kortix/health': { body: { capabilities: ['runtime.turns.v1', 'runtime.actions.v1', 'session.compact'] } },
      ...routes,
    };
    const fetch = (async (request: Request) => {
      const url = new URL(request.url);
      const path = `${url.pathname.replace(prefix, '')}${url.search}`;
      const body = request.body ? JSON.parse(await request.text()) : null;
      requests.push({ method: request.method, path, body });
      const route = all[`${request.method} ${path}`];
      const answer = typeof route === 'function' ? route(request) : (route ?? { status: 404, body: { error: 'not found' } });
      return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
        status: answer.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof globalThis.fetch;
    return { verbs: createRuntimeVerbs({ runtimeUrl, rootId: 'ses_root', fetch }), requests, runtimeUrl, fetch };
  };

  test('answers go to the action routes; the capability is read once per runtime', async () => {
    const box = actionsBox({
      'POST /kortix/runtime/permissions/perm_1/reply': { body: { ok: true } },
      'POST /kortix/runtime/questions/que_1/reply': { body: { ok: true } },
      'POST /kortix/runtime/questions/que_2/reject': { body: { ok: true } },
    });
    await box.verbs.answerPermission('perm_1', 'always', 'fine');
    await box.verbs.answerQuestion('que_1', [['Yes']]);
    // A second verbs object for the same runtime reads no second health.
    await createRuntimeVerbs({ runtimeUrl: box.runtimeUrl, rootId: 'ses_root', fetch: box.fetch }).answerQuestion('que_2', null);
    expect(box.requests.map((r) => [r.method, r.path, r.body])).toEqual([
      ['GET', '/kortix/health', null],
      ['POST', '/kortix/runtime/permissions/perm_1/reply', { reply: 'always', message: 'fine' }],
      ['POST', '/kortix/runtime/questions/que_1/reply', { answers: [['Yes']] }],
      ['POST', '/kortix/runtime/questions/que_2/reject', null],
    ]);
  });

  test('a refused answer throws with the runtime message and status', async () => {
    const box = actionsBox({ 'POST /kortix/runtime/permissions/perm_x/reply': { status: 404, body: { error: 'unknown permission request' } } });
    const error = await box.verbs.answerPermission('perm_x', 'once').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect((error as ApiError).message).toContain('unknown permission request');
  });

  test('pendingRequests() reads the pending route', async () => {
    const pending = {
      statuses: { ses_root: 'busy' },
      permissions: [{ id: 'perm_1', thread_id: 'ses_root', call_id: 'call_1', payload: { permission: 'bash', patterns: ['ls'], always: ['ls'], metadata: {} }, asked_at: '2026-10-30T00:00:00.000Z' }],
      questions: [],
    };
    const box = actionsBox({ 'GET /kortix/runtime/pending': { body: pending } });
    expect(await box.verbs.pendingRequests()).toEqual(pending as never);
  });

  test('compact() posts the compact route after the pending statuses say the root is idle', async () => {
    const box = actionsBox({
      'GET /kortix/runtime/pending': { body: { statuses: { ses_root: 'idle', ses_child: 'busy' }, permissions: [], questions: [] } },
      'POST /kortix/runtime/sessions/ses_root/compact': { status: 202, body: { ok: true } },
    });
    expect(await box.verbs.compact({ providerID: 'kortix', modelID: 'm' })).toEqual({ providerID: 'kortix', modelID: 'm' });
    expect(box.requests.filter((r) => r.method === 'POST').map((r) => [r.path, r.body])).toEqual([
      ['/kortix/runtime/sessions/ses_root/compact', null],
    ]);
  });

  test('compact() translates a turn that outran the proxy into a plain message, without the proxy diagnostic', async () => {
    const box = actionsBox({
      'GET /kortix/runtime/pending': { body: { statuses: {}, permissions: [], questions: [] } },
      'POST /kortix/runtime/sessions/ses_root/compact': { status: 504, body: { code: 'LONG_TURN_PROXY_TIMEOUT', error: 'ALB prompt_async SSE' } },
    });
    const error = await box.verbs.compact({ providerID: 'kortix', modelID: 'm' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('LONG_TURN_PROXY_TIMEOUT');
    expect((error as ApiError).message).toBe('Compaction has not finished. Check the session status before trying again.');
    expect(box.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
  });

  test.each(['busy', 'compacting'])('compact() refuses a %s root and posts nothing', async (status) => {
    const box = actionsBox({
      'GET /kortix/runtime/pending': { body: { statuses: { ses_root: status }, permissions: [], questions: [] } },
    });
    const error = await box.verbs.compact({ providerID: 'kortix', modelID: 'm' }).catch((e: unknown) => e);
    expect((error as ApiError).code).toBe('SESSION_BUSY');
    expect(box.requests.some((r) => r.method === 'POST')).toBe(false);
  });
});

describe('pendingRequests() on a box without the session-log actions', () => {
  test('reads the compatibility lists and answers them as pending records', async () => {
    const { fetch } = fakeRuntime({
      'GET /session/status': { body: { ses_root: { type: 'retry', attempt: 1, message: 'rate limited', next: 1 } } },
      'GET /permission': { body: [{ id: 'per_1', sessionID: 'ses_root', permission: 'bash', patterns: ['ls'], metadata: { command: 'ls' }, always: ['ls *'], tool: { messageID: 'msg_1', callID: 'call_1' } }] },
      'GET /question': { body: [{ id: 'que_1', sessionID: 'ses_child', questions: [{ question: 'Which?', header: 'Pick', options: [] }] }] },
    });
    const verbs = createRuntimeVerbs({ runtimeUrl: 'http://api.test/v1/p/sbx_old/8000', rootId: 'ses_root', fetch: rewrite(fetch, '/v1/p/sbx_old/8000') });
    expect(await verbs.pendingRequests()).toEqual({
      statuses: { ses_root: 'busy' },
      permissions: [{ id: 'per_1', thread_id: 'ses_root', call_id: 'call_1', payload: { permission: 'bash', patterns: ['ls'], always: ['ls *'], metadata: { command: 'ls' } }, asked_at: '' }],
      questions: [{ id: 'que_1', thread_id: 'ses_child', payload: { questions: [{ question: 'Which?', header: 'Pick', options: [] }] }, asked_at: '' }],
    });
  });
});

/** Serve another runtime URL's requests from a fake built for RUNTIME. */
function rewrite(fetch: typeof globalThis.fetch, prefix: string): typeof globalThis.fetch {
  return (async (request: Request) =>
    fetch(new Request(request.url.replace(prefix, '/v1/p/sbx_1/8000'), request))) as typeof globalThis.fetch;
}

describe('liveLog()', () => {
  test("a box with the session-log actions answers a page of its own log", async () => {
    const page = { generation: 3, thread_id: 'ses_root', messages: [{ message_id: 'msg_1', seq: 4 }], has_more: true };
    const { fetch, requests } = fakeRuntime({
      'GET /kortix/health': { body: { capabilities: ['runtime.actions.v1'] } },
      'GET /kortix/runtime/log?thread=ses_child&before_seq=9&limit=5': { body: page },
    });
    const verbs = createRuntimeVerbs({ runtimeUrl: RUNTIME, rootId: 'ses_root', fetch });
    expect(await verbs.liveLog({ thread: 'ses_child', before_seq: 9, limit: 5 })).toEqual(page as never);
    expect(requests.map((r) => r.path)).toEqual(['/kortix/health', '/kortix/runtime/log?thread=ses_child&before_seq=9&limit=5']);
  });

  test('an older box answers null: the caller reads the stored log', async () => {
    const { fetch, requests } = fakeRuntime({});
    const verbs = createRuntimeVerbs({ runtimeUrl: RUNTIME, rootId: 'ses_root', fetch });
    expect(await verbs.liveLog()).toBeNull();
    expect(requests).toEqual([]);
  });
});
