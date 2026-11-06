/**
 * A client's answer to an agent question closes its stored copy (KRTX-1739).
 *
 * Web, mobile, the SDK and the CLI answer through the session proxy
 * (`POST /question/:id/reply|reject`), straight to the runtime. Nothing told
 * the API, so the stored question kept counting as waiting on a person until
 * the turn ended. The proxy now closes it once the runtime took the answer (or
 * said it holds no such question). `mock.module` is process-global: run with
 * `--isolate`.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ForwardRequest, ForwardState } from './forward/context';

const SESSION_ID = '55555555-5555-4555-8555-555555555555';
const closed: Array<{ sessionId: string; scope: unknown }> = [];
const decided: Array<{ sessionId: string; requestId: string; reply: string; decidedBy: string | null }> = [];

const realBackend = await import('./backend');
mock.module('./backend', () => ({ ...realBackend, markSandboxUsed: async () => undefined }));
const realSurface = await import('../projects/surface');
mock.module('../projects/surface', () => ({
  ...realSurface,
  clearOpenQuestions: async (sessionId: string, scope: unknown) => {
    closed.push({ sessionId, scope });
    return 1;
  },
  closeRepliedPermission: async (input: { sessionId: string; requestId: string; reply: string; decidedBy: string | null }) => {
    decided.push(input);
    return true;
  },
}));

const { respondFromUpstream } = await import('./forward/upstream');

function request(method: string, remainingPath: string, upstreamPort = 8000): ForwardRequest {
  return {
    sandboxId: 'ext-question-close',
    port: upstreamPort,
    // A sandbox-authored principal: no preview-use deadline write on an app port.
    access: { kind: 'principal', sandboxAuthored: true },
    method,
    remainingPath,
    queryString: '',
    incomingHeaders: new Headers(),
    origin: 'http://localhost:3000',
    redirectPrefix: '',
    publicOrigin: undefined,
    originMode: undefined,
    ptl: { mark: () => undefined, log: () => ({ marks: [] }) },
    record: { sessionId: SESSION_ID },
    userId: 'user-1',
    ingressRequest: { port: upstreamPort, path: remainingPath, transport: 'http' },
    upstreamPort,
    sandboxAuthored: true,
    promptDelivery: false,
    serviceKey: null,
    isSseEventStreamRequest: false,
    prefetchedIngress: null,
    promptDedupeKey: null,
    turnIdentity: null,
    turn: { accept: async () => undefined, abandon: async () => undefined },
  } as unknown as ForwardRequest;
}

const stateWith = (body?: unknown) =>
  ({ requestBody: body === undefined ? undefined : new TextEncoder().encode(JSON.stringify(body)).buffer }) as unknown as ForwardState;
const respond = (method: string, path: string, status: number, port?: number, body?: unknown) =>
  respondFromUpstream(request(method, path, port), stateWith(body), new Response('true', { status }), 'stall-key');

beforeEach(() => {
  closed.length = 0;
  decided.length = 0;
});

describe('a question answered through the proxy', () => {
  test('a reply the runtime took closes that stored question', async () => {
    const response = await respond('POST', '/question/que_1/reply', 200);
    expect(response.status).toBe(200);
    expect(closed).toEqual([{ sessionId: SESSION_ID, scope: { requestId: 'que_1', keepParked: false } }]);
  });

  test('a dismissal closes it; a runtime that holds no such question (404) closes it unless it parked', async () => {
    await respond('POST', '/proxy/4096/question/que_2/reject', 200);
    await respond('POST', '/question/que_3/reply', 404);
    // A parked question still waits for its answer from the stored card.
    expect(closed.map((call) => call.scope)).toEqual([{ requestId: 'que_2', keepParked: false }, { requestId: 'que_3', keepParked: true }]);
  });

  test('a reply the runtime refused keeps it open', async () => {
    await respond('POST', '/question/que_4/reply', 500);
    await respond('POST', '/question/que_4/reply', 400);
    expect(closed).toEqual([]);
  });

  test('another call, or the same path on an app port, closes nothing', async () => {
    await respond('GET', '/question', 200);
    await respond('POST', '/session/ses_1/abort', 200);
    await respond('POST', '/question/que_5/reply', 200, 3000);
    expect(closed).toEqual([]);
  });
});

describe('a permission request answered through the proxy', () => {
  test('a reply the runtime took records the decision and who made it', async () => {
    await respond('POST', '/permission/perm_1/reply', 200, undefined, { reply: 'always' });
    await respond('POST', '/kortix/runtime/permissions/perm_2/reply', 200, undefined, { reply: 'reject' });
    expect(decided).toEqual([
      { sessionId: SESSION_ID, requestId: 'perm_1', reply: 'always', decidedBy: 'user-1' },
      { sessionId: SESSION_ID, requestId: 'perm_2', reply: 'reject', decidedBy: 'user-1' },
    ]);
  });

  test('a parked request (404), a refused reply, or a body without a reply records nothing', async () => {
    await respond('POST', '/permission/perm_3/reply', 404, undefined, { reply: 'once' });
    await respond('POST', '/permission/perm_3/reply', 500, undefined, { reply: 'once' });
    await respond('POST', '/permission/perm_3/reply', 200, undefined, { reply: 'sometimes' });
    expect(decided).toEqual([]);
  });
});
