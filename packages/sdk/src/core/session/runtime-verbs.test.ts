import { describe, expect, test } from 'bun:test';
import { ApiError } from '../http/api/errors';
import { createRuntimeVerbs } from './runtime-verbs';

const RUNTIME = 'http://api.test/v1/p/sbx_1/8000';

type Answer = { status?: number; body?: unknown; contentType?: string };

function fakeRuntime(routes: Record<string, Answer | ((request: Request) => Answer)>) {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const fetch = (async (request: Request) => {
    const url = new URL(request.url);
    const path = `${url.pathname.replace('/v1/p/sbx_1/8000', '')}${url.search}`;
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

  test('compact() summarizes the root with the given model, else the runtime default model', async () => {
    const { fetch, requests } = fakeRuntime({
      'POST /session/ses_root/summarize': { body: true },
      'GET /global/config': { body: { model: 'kortix/claude-sonnet' } },
    });
    const verbs = createRuntimeVerbs({ runtimeUrl: RUNTIME, rootId: 'ses_root', fetch });
    expect(await verbs.compact({ providerID: 'anthropic', modelID: 'claude' })).toEqual({ providerID: 'anthropic', modelID: 'claude' });
    expect(await verbs.compact()).toEqual({ providerID: 'kortix', modelID: 'claude-sonnet' });
    expect(requests.map((r) => [r.method, r.path, r.body])).toEqual([
      ['POST', '/session/ses_root/summarize', { providerID: 'anthropic', modelID: 'claude' }],
      ['GET', '/global/config', null],
      ['POST', '/session/ses_root/summarize', { providerID: 'kortix', modelID: 'claude-sonnet' }],
    ]);
  });

  test('compact() without a model anywhere throws MODEL_REQUIRED instead of guessing', async () => {
    for (const config of [{ body: {} }, { status: 404, body: { error: 'not found' } }]) {
      const { fetch, requests } = fakeRuntime({ 'GET /global/config': config });
      const verbs = createRuntimeVerbs({ runtimeUrl: RUNTIME, rootId: 'ses_root', fetch });
      const error = await verbs.compact().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe('MODEL_REQUIRED');
      expect(requests.some((r) => r.path.endsWith('/summarize'))).toBe(false);
    }
  });
});
