import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { createKortix } from '../../client/kortix';
import { configureKortix } from '../../http/config';
import { ApiError } from '../../http/api-client';
import * as root from '../../../index';
import { createArtifactLiveTicket, signalArtifactLiveAgent } from './artifact-live';

const originalFetch = globalThis.fetch;
const backendUrl = 'https://artifact-live.example/v1';
const live = `${backendUrl}/workspaces/project-a/artifacts/artifact-a/live`;
let calls: { url: string; method: string; body: unknown; authorization: string | null }[] = [];
let reply: () => Response;
let errors: unknown[] = [];

beforeEach(() => {
  calls = [];
  errors = [];
  reply = () => Response.json({ ticket: 'ticket-a', expires_at: '2026-11-04T00:01:00.000Z' });
  configureKortix({ backendUrl, getToken: async () => 'session-token', onError: (error) => errors.push(error) });
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined,
      authorization: new Headers(init?.headers).get('authorization'),
    });
    return reply();
  }) as unknown as typeof fetch;
});
afterEach(() => { globalThis.fetch = originalFetch; });

test('createArtifactLiveTicket posts to /live/ticket with the bearer and returns the ticket', async () => {
  expect(await createArtifactLiveTicket('project-a', 'artifact-a')).toEqual({ ticket: 'ticket-a', expires_at: '2026-11-04T00:01:00.000Z' });
  expect(calls).toEqual([{ url: `${live}/ticket`, method: 'POST', body: undefined, authorization: 'Bearer session-token' }]);
});

test('a refused or failed ticket rejects with the HTTP status and never reaches onError (reconnects would repeat it)', async () => {
  for (const [status, body] of [[403, { error: 'Artifact comments are off', code: 'feature_disabled' }], [500, { error: 'Internal error' }]] as const) {
    reply = () => Response.json(body, { status });
    const error = await createArtifactLiveTicket('project-a', 'artifact-a').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(status);
  }
  expect(errors).toEqual([]);
});

test('signalArtifactLiveAgent posts the signal to /live/agent and resolves on 204', async () => {
  reply = () => new Response(null, { status: 204 });
  const signal = { status: 'editing' as const, thread_id: '30000000-0000-4000-8000-000000000001' };
  expect(await signalArtifactLiveAgent('project-a', 'artifact-a', signal)).toBeUndefined();
  expect(await signalArtifactLiveAgent('project-a', 'artifact-a', { status: 'writing', quote: 'Churn fell' })).toBeUndefined();
  expect(calls.map(({ url, method, body }) => ({ url, method, body }))).toEqual([
    { url: `${live}/agent`, method: 'POST', body: signal },
    { url: `${live}/agent`, method: 'POST', body: { status: 'writing', quote: 'Churn fell' } },
  ]);
});

test('a person token is refused with 403 and the status reaches the caller', async () => {
  reply = () => Response.json({ error: 'Only an agent session can signal focus' }, { status: 403 });
  const error = await signalArtifactLiveAgent('project-a', 'artifact-a', { status: 'idle' }).catch((caught: unknown) => caught);
  expect((error as ApiError).status).toBe(403);
});

test('the project facade binds the project id: artifacts.live.ticket, .signal and .connect', async () => {
  const handle = createKortix({ backendUrl, getToken: async () => 'session-token' }).project('project-a');
  expect(await handle.artifacts.live.ticket('artifact-a')).toEqual({ ticket: 'ticket-a', expires_at: '2026-11-04T00:01:00.000Z' });
  reply = () => new Response(null, { status: 204 });
  await handle.artifacts.live.signal('artifact-a', { status: 'reading', thread_id: '30000000-0000-4000-8000-000000000001' });
  expect(calls.map(({ url }) => url)).toEqual([`${live}/ticket`, `${live}/agent`]);

  const urls: string[] = [];
  class Socket {
    constructor(url: string) { urls.push(url); }
    send() {}
    close() {}
    addEventListener() {}
  }
  reply = () => Response.json({ ticket: 'ticket-b', expires_at: '2026-11-04T00:01:00.000Z' });
  const connection = handle.artifacts.live.connect('artifact-a', { view: 'page', webSocket: Socket });
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 5));
  connection.close();
  expect(urls).toEqual([`wss://artifact-live.example/v1/workspaces/project-a/artifacts/artifact-a/live?ticket=ticket-b`]);
  expect(calls.at(-1)?.url).toBe(`${live}/ticket`);
});

test('the root entry exports the live functions', () => {
  expect(typeof root.createArtifactLiveConnection).toBe('function');
  expect(typeof root.createArtifactLiveTicket).toBe('function');
  expect(typeof root.signalArtifactLiveAgent).toBe('function');
});
