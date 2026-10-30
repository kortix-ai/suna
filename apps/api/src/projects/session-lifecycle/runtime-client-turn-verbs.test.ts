// Every runtime call of the session lifecycle goes to a Kortix route. Bun
// mocks are process-global; run this file in isolation (`bun test --isolate`).
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import * as realOpencodeMapping from '../opencode-mapping';

const forwarded: Array<{ method: string; path: string; query: string; body: unknown; headers: Headers }> = [];
let forwardStatus = 202;
let forwardBody: unknown = { message_id: 'msg_1' };
/** Answers per forwarded path, before the defaults above. */
let forwardAnswers: Record<string, () => Response> = {};

mock.module('../../sandbox-proxy/forward', () => ({
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

const { SteerNotTaken, postPrompt, readRuntimeMessage, readSessionMessageTip, retractRuntimeMessage } = await import('./runtime-client');
const { __resetRuntimeCapabilitiesMemo } = await import('./runtime-fetch');

const fetched: string[] = [];
let pages: Record<string, unknown> = {};
/** Direct steer POSTs: the box answers what `steerAnswer` returns. */
const steered: Array<{ headers: Record<string, string>; body: unknown }> = [];
let steerAnswer: () => Response = () => Response.json({ message_id: 'msg_s', steered: true }, { status: 202 });
/** A Kortix verb that answers 404 for the resource. */
const resourceMissing = () =>
  Response.json({ error: 'message not found' }, { status: 404, headers: { 'X-Kortix-Turn-Verb': '1' } });

beforeEach(() => {
  __resetRuntimeCapabilitiesMemo();
  forwarded.length = 0;
  fetched.length = 0;
  forwardStatus = 202;
  forwardBody = { message_id: 'msg_1' };
  forwardAnswers = {};
  pages = {};
  steered.length = 0;
  steerAnswer = () => Response.json({ message_id: 'msg_s', steered: true }, { status: 202 });
  globalThis.fetch = (async (url: unknown, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const target = String(url);
    if (target.endsWith('/steer')) {
      steered.push({ headers: init?.headers ?? {}, body: JSON.parse(init?.body ?? 'null') });
      return steerAnswer();
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
  test('the Kortix prompt route gets the Kortix body and the caller\'s key', async () => {
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
    expect(forwarded[0]!.headers.get('Idempotency-Key')).toBe('idem-1');
  });

  test('a duplicate reads as deduplicated; a 404 for the session is a failure, sent once', async () => {
    forwardStatus = 200;
    forwardBody = { deduplicated: true };
    expect(await deliver()).toBe('deduplicated');
    forwarded.length = 0;
    forwardAnswers['/kortix/runtime/sessions/ses_1/prompt'] = resourceMissing;
    expect(await deliver()).toBe('failed');
    expect(forwarded.map((f) => f.path)).toEqual(['/kortix/runtime/sessions/ses_1/prompt']);
  });

  // The proxy's access gates throw their 403. Read as "unreachable", a refused
  // prompt waited out the whole runtime-down ladder (~13 min) and dead-lettered
  // as "the session's machine could not be reached".
  test("a 403 the proxy throws is a refusal, not a down box; a throw that is not the proxy's answer stays unreachable", async () => {
    const { HTTPException } = await import('hono/http-exception');
    const { PromptDeliveryRefused } = await import('./prompt-delivery-refusal');
    const route = '/kortix/runtime/sessions/ses_1/prompt';
    forwardAnswers[route] = () => {
      throw new HTTPException(403, { message: 'Not authorized to access this session' });
    };
    const refused = await deliver().catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(PromptDeliveryRefused);
    expect(refused).toMatchObject({ status: 403, message: 'Not authorized to access this session' });

    forwardAnswers[route] = () => {
      throw new HTTPException(503, { message: 'upstream down' });
    };
    expect(await deliver()).toBe('unreachable');

    forwardAnswers[route] = () => {
      throw new TypeError('fetch failed');
    };
    expect(await deliver()).toBe('unreachable');
  });
});

describe('session runtime reads', () => {
  test('the tip read uses the Kortix transcript route', async () => {
    pages['/kortix/runtime/messages/ses_1?limit=8'] = {
      messages: [{ info: { id: 'msg_a', role: 'user', time: { created: 1 } }, parts: [] }],
      has_more: true,
      first_message_id: 'msg_a',
    };
    const tip = await readSessionMessageTip(session, { limit: 8 });
    expect(tip?.map((m) => m.id)).toEqual(['msg_a']);
    expect(fetched).toEqual(['GET /kortix/runtime/messages/ses_1?limit=8']);
  });

  test('a full read pages backwards on before until has_more is false', async () => {
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

  // The landing proof: a held message is any body, an unheld one null, an unanswered read a throw.
  test('one message read answers the message, null when the runtime holds none, and throws when it cannot say', async () => {
    const path = '/kortix/runtime/messages/ses_1/msg_a';
    pages[path] = { info: { id: 'msg_a', role: 'user' }, parts: [] };
    expect(await readRuntimeMessage(session, 'msg_a')).toEqual({ info: { id: 'msg_a', role: 'user' }, parts: [] });
    pages[path] = resourceMissing;
    expect(await readRuntimeMessage(session, 'msg_a')).toBeNull();
    pages[path] = () => new Response('down', { status: 503 });
    await expect(readRuntimeMessage(session, 'msg_a')).rejects.toThrow('runtime message read failed (503)');
    expect(fetched.filter((call) => call !== 'GET /kortix/health').every((call) => call === `GET ${path}`)).toBe(true);
  });

  test('a box with the session-log actions answers the read from its own log', async () => {
    pages['/kortix/health'] = { capabilities: ['runtime.turns.v1', 'runtime.actions.v1'] };
    const path = '/kortix/runtime/log/messages/msg_a';
    pages[path] = { message_id: 'msg_a', role: 'user', blocks: [] };
    expect(await readRuntimeMessage(session, 'msg_a')).toEqual({ message_id: 'msg_a', role: 'user', blocks: [] });
    pages[path] = resourceMissing;
    expect(await readRuntimeMessage(session, 'msg_a')).toBeNull();
    expect(fetched.filter((call) => call !== 'GET /kortix/health')).toEqual([`GET ${path}`, `GET ${path}`]);
  });
});

describe('retractRuntimeMessage (R7.1)', () => {
  const retractPath = '/kortix/runtime/messages/ses_1/msg_a/retract';

  test('the runtime decides: retracted, gone, read, refused', async () => {
    pages[retractPath] = () => Response.json({ retracted: true }, { headers: { 'X-Kortix-Turn-Verb': '1' } });
    expect(await retractRuntimeMessage(session, 'msg_a')).toEqual({ outcome: 'retracted' });
    expect(fetched).toEqual([`POST ${retractPath}`]);

    pages[retractPath] = resourceMissing;
    expect(await retractRuntimeMessage(session, 'msg_a')).toEqual({ outcome: 'gone' });
    pages[retractPath] = () =>
      Response.json({ code: 'message_read', error: 'a model call read this message' }, { status: 409, headers: { 'X-Kortix-Turn-Verb': '1' } });
    expect(await retractRuntimeMessage(session, 'msg_a')).toEqual({ outcome: 'read' });
    pages[retractPath] = () => Response.json({ code: 'RUNTIME_NOT_READY' }, { status: 503, headers: { 'X-Kortix-Turn-Verb': '1' } });
    expect(await retractRuntimeMessage(session, 'msg_a')).toEqual({ outcome: 'refused', status: 503, detail: '{"code":"RUNTIME_NOT_READY"}' });
    // A 409 that is not "read" is a refusal, not a read.
    pages[retractPath] = () => Response.json({ error: 'other' }, { status: 409, headers: { 'X-Kortix-Turn-Verb': '1' } });
    expect((await retractRuntimeMessage(session, 'msg_a')).outcome).toBe('refused');
    expect(fetched.every((call) => call === `POST ${retractPath}`)).toBe(true);
  });
});

describe('postPrompt steer (R10)', () => {
  const steer = () =>
    postPrompt('ext-1', 'ses_1', 'also this', 'user-1', 'sess-1', 'idem-1:steer', {
      parts: [{ type: 'text', text: 'also this' }],
      wireMessageId: 'msg_s',
      steer: true,
    });
  const notTaken = async () => {
    try {
      await steer();
    } catch (error) {
      return error instanceof SteerNotTaken ? error.reason : error;
    }
    return 'taken';
  };

  test('posts the prompt body straight to the box with the service-call mark, never through the proxy', async () => {
    expect(await steer()).toBe('accepted');
    expect(forwarded).toHaveLength(0);
    expect(steered).toHaveLength(1);
    expect(steered[0]!.headers['X-Kortix-Service-Call']).toBe('1');
    expect(steered[0]!.body).toMatchObject({ message_id: 'msg_s', parts: [{ type: 'text', text: 'also this' }] });
    steerAnswer = () => Response.json({ deduplicated: true }, { status: 200 });
    expect(await steer()).toBe('deduplicated');
  });

  test('409 no_active_turn is turn_ended; any other 409 is a plain failure; 501 is unsupported', async () => {
    steerAnswer = () => Response.json({ code: 'no_active_turn' }, { status: 409 });
    expect(await notTaken()).toBe('turn_ended');
    steerAnswer = () => Response.json({ error: 'busy' }, { status: 409 });
    expect(await notTaken()).toBe('taken');
    steerAnswer = () => Response.json({ code: 'feature_not_supported' }, { status: 501 });
    expect(await notTaken()).toBe('unsupported');
  });
});
