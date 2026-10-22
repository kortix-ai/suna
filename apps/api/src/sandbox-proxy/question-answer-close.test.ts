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

const realBackend = await import('./backend');
mock.module('./backend', () => ({ ...realBackend, markSandboxUsed: async () => undefined }));
const realSurface = await import('../projects/surface');
mock.module('../projects/surface', () => ({
  ...realSurface,
  clearOpenQuestions: async (sessionId: string, scope: unknown) => {
    closed.push({ sessionId, scope });
    return 1;
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

const state = { requestBody: undefined } as unknown as ForwardState;
const respond = (method: string, path: string, status: number, port?: number) =>
  respondFromUpstream(request(method, path, port), state, new Response('true', { status }), 'stall-key');

beforeEach(() => {
  closed.length = 0;
});

describe('a question answered through the proxy', () => {
  test('a reply the runtime took closes that stored question', async () => {
    const response = await respond('POST', '/question/que_1/reply', 200);
    expect(response.status).toBe(200);
    expect(closed).toEqual([{ sessionId: SESSION_ID, scope: { requestId: 'que_1' } }]);
  });

  test('a dismissal closes it, and so does a runtime that holds no such question (404)', async () => {
    await respond('POST', '/proxy/4096/question/que_2/reject', 200);
    await respond('POST', '/question/que_3/reply', 404);
    expect(closed.map((call) => call.scope)).toEqual([{ requestId: 'que_2' }, { requestId: 'que_3' }]);
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
