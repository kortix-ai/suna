// W5 E4: a daemon that lists `runtime.turns.v1` gets the Kortix turn routes,
// an older one keeps OpenCode's REST spelling. Bun mocks are process-global;
// run this file in isolation (`bun test --isolate`).
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import * as realOpencodeMapping from '../opencode-mapping';

const forwarded: Array<{ method: string; path: string; query: string; body: unknown; headers: Headers }> = [];
let forwardStatus = 202;
let forwardBody: unknown = { message_id: 'msg_1' };
/** Answers per forwarded path, before the defaults above. */
let forwardAnswers: Record<string, () => Response> = {};

mock.module('../../sandbox-proxy/routes/preview', () => ({
  forwardToSandbox: async (
    _externalId: string,
    _port: number,
    _access: unknown,
    method: string,
    path: string,
    query: string,
    headers: Headers,
    body: ArrayBuffer | undefined,
  ) => {
    forwarded.push({
      method,
      path,
      query,
      headers,
      body: body ? JSON.parse(new TextDecoder().decode(body)) : null,
    });
    const scripted = forwardAnswers[path];
    return scripted ? scripted() : Response.json(forwardBody, { status: forwardStatus });
  },
}));

mock.module('../opencode-mapping', () => ({
  ...realOpencodeMapping,
  sandboxOpencodeEndpoint: async () => ({ url: 'https://daemon.test', headers: {} }),
}));

const { postPrompt, readSessionMessageTip, removeRuntimeMessage } = await import('./runtime-client');
const { __resetRuntimeTurnVerbsMemo } = await import('./runtime-fetch');

let capabilities: string[] = [];
const fetched: string[] = [];
let pages: Record<string, unknown> = {};
let healthReads = 0;
/** A daemon rolled back in place: its catch-all answers a Kortix route it no longer has. */
const routeMissing = () => Response.json({ error: 'not found' }, { status: 404 });
/** A Kortix verb that exists and answers 404 for the resource. */
const resourceMissing = () =>
  Response.json({ error: 'message not found' }, { status: 404, headers: { 'X-Kortix-Turn-Verb': '1' } });

beforeEach(() => {
  __resetRuntimeTurnVerbsMemo();
  capabilities = [];
  forwarded.length = 0;
  fetched.length = 0;
  forwardStatus = 202;
  forwardBody = { message_id: 'msg_1' };
  forwardAnswers = {};
  pages = {};
  healthReads = 0;
  globalThis.fetch = (async (url: unknown, init?: { method?: string }) => {
    const target = String(url);
    if (target.endsWith('/kortix/health')) {
      healthReads++;
      return Response.json({ capabilities });
    }
    const path = target.replace('https://daemon.test', '');
    fetched.push(`${init?.method ?? 'GET'} ${path}`);
    const page = pages[path];
    if (typeof page === 'function') return (page as () => Response)();
    return page === undefined ? new Response(null, { status: 200 }) : Response.json(page);
  }) as typeof fetch;
});

const session = { endpoint: { url: 'https://daemon.test', headers: {} }, opencodeSessionId: 'ses_1', externalId: 'ext-1' };
const deliver = () =>
  postPrompt('ext-1', 'ses_1', 'hello', 'user-1', 'sess-1', 'idem-1', {
    parts: [{ type: 'text', text: 'hello' }],
    overrides: { model: { providerID: 'kortix', modelID: 'anthropic/claude' }, variant: 'high' },
    wireMessageId: 'msg_1',
    noReply: true,
  });

describe('postPrompt', () => {
  test('a daemon with runtime.turns.v1 gets the Kortix prompt route and body', async () => {
    capabilities = ['runtime.turns.v1'];
    expect(await deliver()).toBe('accepted');
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toMatchObject({
      method: 'POST',
      path: '/kortix/runtime/sessions/ses_1/prompt',
      query: '',
      body: {
        message_id: 'msg_1',
        parts: [{ type: 'text', text: 'hello' }],
        model: 'kortix/anthropic/claude',
        variant: 'high',
        directory: '/workspace',
        no_reply: true,
      },
    });
    expect(forwarded[0]!.headers.get('Idempotency-Key')).toBe('idem-1:kortix');
  });

  test('an older daemon gets prompt_async with ?directory= and {providerID, modelID}', async () => {
    forwardStatus = 204;
    forwardBody = null;
    expect(await deliver()).toBe('accepted');
    expect(forwarded[0]).toMatchObject({
      path: '/session/ses_1/prompt_async',
      query: '?directory=%2Fworkspace',
      body: {
        messageID: 'msg_1',
        model: { providerID: 'kortix', modelID: 'anthropic/claude' },
        noReply: true,
      },
    });
  });

  test('a duplicate on the Kortix route reads as deduplicated', async () => {
    capabilities = ['runtime.turns.v1'];
    forwardStatus = 200;
    forwardBody = { deduplicated: true };
    expect(await deliver()).toBe('deduplicated');
  });
});

describe('session runtime reads', () => {
  test('the tip read and the message removal use the Kortix routes on a capable daemon', async () => {
    capabilities = ['runtime.turns.v1'];
    pages['/kortix/runtime/messages/ses_1?limit=8'] = {
      messages: [{ info: { id: 'msg_a', role: 'user', time: { created: 1 } }, parts: [] }],
      has_more: true,
      first_message_id: 'msg_a',
    };
    const tip = await readSessionMessageTip(session, { limit: 8 });
    expect(tip?.map((m) => m.id)).toEqual(['msg_a']);
    expect(await removeRuntimeMessage(session, 'msg_a')).toBe(true);
    expect(fetched).toEqual(['GET /kortix/runtime/messages/ses_1?limit=8', 'DELETE /kortix/runtime/messages/ses_1/msg_a']);
  });

  test('a full read pages backwards on before until has_more is false', async () => {
    capabilities = ['runtime.turns.v1'];
    pages['/kortix/runtime/messages/ses_1?limit=200'] = {
      messages: [{ info: { id: 'msg_c', role: 'user' }, parts: [] }],
      has_more: true,
      first_message_id: 'msg_c',
    };
    pages['/kortix/runtime/messages/ses_1?limit=200&before=msg_c'] = {
      messages: [
        { info: { id: 'msg_a', role: 'user' }, parts: [] },
        { info: { id: 'msg_b', role: 'assistant', parentID: 'msg_a' }, parts: [] },
      ],
      has_more: false,
      first_message_id: 'msg_a',
    };
    const tip = await readSessionMessageTip(session);
    expect(tip?.map((m) => m.id)).toEqual(['msg_a', 'msg_b', 'msg_c']);
  });

  test('an older daemon is read over the legacy list', async () => {
    pages['/session/ses_1/message?directory=%2Fworkspace&limit=8'] = [{ info: { id: 'msg_a', role: 'user' }, parts: [] }];
    expect((await readSessionMessageTip(session, { limit: 8 }))?.map((m) => m.id)).toEqual(['msg_a']);
    expect(fetched).toEqual(['GET /session/ses_1/message?directory=%2Fworkspace&limit=8']);
  });
});

describe('a daemon that stops serving the Kortix routes (an in-place rollback)', () => {
  test('a prompt the daemon has no route for is delivered once over prompt_async, under the legacy route\'s key', async () => {
    capabilities = ['runtime.turns.v1'];
    forwardAnswers['/kortix/runtime/sessions/ses_1/prompt'] = routeMissing;
    forwardAnswers['/session/ses_1/prompt_async'] = () => new Response(null, { status: 204 });
    expect(await deliver()).toBe('accepted');
    expect(forwarded.map((f) => f.path)).toEqual(['/kortix/runtime/sessions/ses_1/prompt', '/session/ses_1/prompt_async']);
    expect(forwarded[1]!.body).toMatchObject({ messageID: 'msg_1', model: { providerID: 'kortix', modelID: 'anthropic/claude' } });
    expect(forwarded.map((f) => f.headers.get('Idempotency-Key'))).toEqual(['idem-1:kortix', 'idem-1']);
    // The capability is read again for the next request.
    capabilities = [];
    await deliver();
    expect(healthReads).toBe(2);
    expect(forwarded.at(-1)!.path).toBe('/session/ses_1/prompt_async');
  });

  test('a message removal the daemon has no route for is sent on the legacy route', async () => {
    capabilities = ['runtime.turns.v1'];
    pages['/kortix/runtime/messages/ses_1/msg_a'] = routeMissing;
    expect(await removeRuntimeMessage(session, 'msg_a')).toBe(true);
    expect(fetched).toEqual(['DELETE /kortix/runtime/messages/ses_1/msg_a', 'DELETE /session/ses_1/message/msg_a?directory=%2Fworkspace']);
  });

  test('a Kortix verb answering 404 for the resource is taken at its word', async () => {
    capabilities = ['runtime.turns.v1'];
    pages['/kortix/runtime/messages/ses_1/msg_gone'] = resourceMissing;
    expect(await removeRuntimeMessage(session, 'msg_gone')).toBe(true);
    expect(fetched).toEqual(['DELETE /kortix/runtime/messages/ses_1/msg_gone']);
    forwardAnswers['/kortix/runtime/sessions/ses_1/prompt'] = resourceMissing;
    expect(await deliver()).toBe('failed');
    expect(forwarded.map((f) => f.path)).toEqual(['/kortix/runtime/sessions/ses_1/prompt']);
  });
});
