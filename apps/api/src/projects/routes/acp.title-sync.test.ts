/**
 * Route-level wiring for the ACP title-sync pipeline (`routes/acp.ts`):
 *   - a harness `session_info_update` title, delivered over the SSE stream,
 *     calls `persistHarnessSessionTitle` with the extracted {title, updatedAt};
 *   - the first text block of a `session/prompt` POST calls
 *     `persistFallbackSessionTitle` with the derived fallback title;
 *   - neither call ever breaks the response the client receives, even if the
 *     persist call throws.
 *
 * Mocking idiom mirrors `acp.envelope-persistence.test.ts` (mock.module +
 * dynamic-import; `../lib/access` / `../runtime-inspection` / `../lib/sandbox-env-sync`
 * / `../lib/acp-session-identity` / `../../shared/db` stubbed, global `fetch`
 * stands in for the daemon-bridge upstream). Extraction correctness itself
 * (which envelope shapes carry a title) is pinned in `../lib/acp-envelope.test.ts`
 * against real persisted envelope fixtures — this file only pins that the
 * route calls through with the right arguments at the right two sites.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { sessionSandboxes } from '@kortix/db';

const PROJECT_ID = '11111111-2222-4333-8444-555555555555';
const SESSION_ID = 'sess-title-sync-1';
const EXTERNAL_ID = 'sbx-ext-title-sync-1';

type HarnessTitleCall = { projectSessionId: string; projectId: string; title: string; updatedAt: string | null };
type FallbackTitleCall = { projectSessionId: string; projectId: string; title: string };

let harnessTitleCalls: HarnessTitleCall[] = [];
let fallbackTitleCalls: FallbackTitleCall[] = [];
let harnessTitleShouldThrow = false;
let fallbackTitleShouldThrow = false;
let upstreamResponse: Response | null = null;

mock.module('../lib/access', () => ({
  loadProjectForUser: async (_c: unknown, projectId: string) => {
    if (projectId !== PROJECT_ID) return null;
    return { userId: 'user-1', row: { projectId: PROJECT_ID } };
  },
  loadVisibleSession: async (_loaded: unknown, sessionId: string) => {
    if (sessionId !== SESSION_ID) return null;
    return { row: {} };
  },
}));

mock.module('../runtime-inspection', () => ({
  sandboxRuntimeEndpoint: async () => ({
    url: 'https://box.example',
    headers: { 'content-type': 'application/json' },
    serviceKey: 'svc-key',
  }),
  inspectSandboxRuntime: async () => ({
    runtime: 'acp',
    runtimeReady: true,
    acpServerId: 'acp-server-1',
    acpHarness: null,
    bootError: null,
  }),
}));

mock.module('../lib/sandbox-env-sync', () => ({
  syncSandboxEnvForPrompt: async () => {},
}));

mock.module('../lib/acp-session-identity', () => ({
  persistAcpSessionIdentity: async () => {},
}));

mock.module('../lib/acp-session-title', () => ({
  persistHarnessSessionTitle: async (_deps: unknown, input: HarnessTitleCall) => {
    harnessTitleCalls.push(input);
    if (harnessTitleShouldThrow) throw new Error('boom: harness title persist failed');
    return true;
  },
  persistFallbackSessionTitle: async (_deps: unknown, input: FallbackTitleCall) => {
    fallbackTitleCalls.push(input);
    if (fallbackTitleShouldThrow) throw new Error('boom: fallback title persist failed');
    return true;
  },
}));

mock.module('../../shared/db', () => ({
  db: {
    select: (_proj?: unknown) => ({
      from: (_table: unknown) => ({
        where: (_cond: unknown) => ({
          limit: async () => [{ externalId: EXTERNAL_ID }],
        }),
      }),
    }),
    insert: (_table: unknown) => ({
      values: (_v: unknown) => ({
        onConflictDoNothing: async () => {},
      }),
    }),
  },
}));

const { projectsApp } = await import('../lib/app');
await import('./acp');

const realFetch = globalThis.fetch;

beforeEach(() => {
  harnessTitleCalls = [];
  fallbackTitleCalls = [];
  harnessTitleShouldThrow = false;
  fallbackTitleShouldThrow = false;
  upstreamResponse = null;
  globalThis.fetch = (async (_url: unknown, _init: unknown) => {
    if (!upstreamResponse) throw new Error('no upstream response stubbed');
    return upstreamResponse.clone();
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  mock.restore();
});

function postAcp(body: Record<string, unknown>) {
  return projectsApp.request(`/${PROJECT_ID}/sessions/${SESSION_ID}/acp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function getAcpStream() {
  return projectsApp.request(`/${PROJECT_ID}/sessions/${SESSION_ID}/acp`, {
    method: 'GET',
    headers: { accept: 'text/event-stream' },
  });
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function sseResponse(raw: string) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(raw));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function drain(body: ReadableStream<Uint8Array> | null) {
  if (!body) return;
  const reader = body.getReader();
  while (true) {
    const { done } = await reader.read();
    if (done) break;
  }
}

describe('harness title sync (SSE-delivered session_info_update)', () => {
  test('a real claude-agent-acp session_info_update calls persistHarnessSessionTitle with the extracted title/updatedAt', async () => {
    upstreamResponse = sseResponse(
      'id: 42\ndata: {"jsonrpc":"2.0","method":"session/update","params":{"update":'
      + '{"title":"Reply with exactly: ACP_PONG","updatedAt":"2026-07-12T02:30:47.426Z","sessionUpdate":"session_info_update"}}}\n\n',
    );
    const res = await getAcpStream();
    await drain(res.body);
    expect(harnessTitleCalls).toEqual([{
      projectSessionId: SESSION_ID,
      projectId: PROJECT_ID,
      title: 'Reply with exactly: ACP_PONG',
      updatedAt: '2026-07-12T02:30:47.426Z',
    }]);
  });

  test('a codex-shaped session_info_update (threadStatus only, no title) never calls persistHarnessSessionTitle', async () => {
    upstreamResponse = sseResponse(
      'id: 1\ndata: {"jsonrpc":"2.0","method":"session/update","params":{"update":'
      + '{"_meta":{"codex":{"threadStatus":{"type":"active","activeFlags":[]}}},"sessionUpdate":"session_info_update"}}}\n\n',
    );
    const res = await getAcpStream();
    await drain(res.body);
    expect(harnessTitleCalls).toHaveLength(0);
  });

  test('a non-title SSE event (agent_message_chunk) never calls persistHarnessSessionTitle', async () => {
    upstreamResponse = sseResponse(
      'id: 2\ndata: {"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hi"}}}}\n\n',
    );
    const res = await getAcpStream();
    await drain(res.body);
    expect(harnessTitleCalls).toHaveLength(0);
  });

  test('a title-persist failure is swallowed — the SSE response still streams through, not 500', async () => {
    harnessTitleShouldThrow = true;
    upstreamResponse = sseResponse(
      'id: 3\ndata: {"jsonrpc":"2.0","method":"session/update","params":{"update":'
      + '{"title":"T","updatedAt":null,"sessionUpdate":"session_info_update"}}}\n\n',
    );
    const res = await getAcpStream();
    expect(res.status).toBe(200);
    await drain(res.body); // must not throw
  });
});

describe('fallback title sync (POST session/prompt)', () => {
  test('a real session/prompt request calls persistFallbackSessionTitle with the first text block', async () => {
    upstreamResponse = jsonResponse({ jsonrpc: '2.0', id: 3, result: {} });
    await postAcp({
      id: 3,
      method: 'session/prompt',
      params: { prompt: [{ text: 'Reply with exactly: ACP_PONG', type: 'text' }], sessionId: 'ses_abc' },
      jsonrpc: '2.0',
    });
    expect(fallbackTitleCalls).toEqual([{
      projectSessionId: SESSION_ID,
      projectId: PROJECT_ID,
      title: 'Reply with exactly: ACP_PONG',
    }]);
  });

  test('a non-prompt method (tools/list) never calls persistFallbackSessionTitle', async () => {
    upstreamResponse = jsonResponse({ jsonrpc: '2.0', id: 1, result: {} });
    await postAcp({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(fallbackTitleCalls).toHaveLength(0);
  });

  test('a fallback-persist failure is swallowed — the POST response is still returned, not 502', async () => {
    fallbackTitleShouldThrow = true;
    upstreamResponse = jsonResponse({ jsonrpc: '2.0', id: 3, result: {} });
    const res = await postAcp({
      id: 3,
      method: 'session/prompt',
      params: { prompt: [{ text: 'hello', type: 'text' }] },
      jsonrpc: '2.0',
    });
    expect(res.status).toBe(200);
  });
});
