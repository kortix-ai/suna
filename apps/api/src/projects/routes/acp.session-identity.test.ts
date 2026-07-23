/**
 * `POST /:projectId/sessions/:sessionId/acp` — the INTERACTIVE ACP
 * session-identity write site (WS3-P1-a). Pins that a `session/new` RESPONSE
 * (not the request) still triggers exactly one call to the shared
 * `persistAcpSessionIdentity()` write path, with the interactive shape:
 * `runtimeId === sessionId` (per `resolveAcpTarget`) and `opts.projectId` set
 * (the interactive site's extra WHERE-clause scoping, preserved verbatim from
 * before the WS3-P1-a extraction). Also pins that methods OTHER than
 * `session/new` (e.g. `session/load`, `session/prompt`) never call it — the
 * pre-extraction code only ever intercepted the `session/new` response.
 *
 * `../lib/access` and `../runtime-inspection` are mocked (real infra calls —
 * sandbox ingress, service keys); `../../shared/db` is mocked for the
 * `sessionSandboxes` lookup `resolveAcpTarget` needs plus the envelope
 * insert; `../lib/acp-session-identity` is mocked to observe call-site
 * wiring precisely (the module's own behavior is pinned separately in
 * `../lib/acp-session-identity.test.ts`). Global `fetch` stands in for the
 * daemon-bridge upstream. Mock-before-dynamic-import, mirroring
 * `agent-config-runtime-profiles-gate.test.ts`.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { sessionSandboxes } from '@kortix/db';

const PROJECT_ID = '11111111-2222-4333-8444-555555555555';
const SESSION_ID = 'sess-interactive-1';
const EXTERNAL_ID = 'sbx-ext-1';

let insertedEnvelopes: Array<{ direction: string; envelope: unknown }> = [];
let persistCalls: Array<{ identity: unknown; opts: unknown }> = [];
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

mock.module('../../shared/db', () => ({
  db: {
    select: (_proj?: unknown) => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            if (table === sessionSandboxes) return [{ externalId: EXTERNAL_ID }];
            return [];
          },
        }),
      }),
    }),
    insert: (_table: unknown) => ({
      values: (v: { direction: string; envelope: unknown }) => ({
        onConflictDoNothing: async () => {
          insertedEnvelopes.push(v);
        },
      }),
    }),
  },
}));

mock.module('../lib/acp-session-identity', () => ({
  persistAcpSessionIdentity: async (_deps: unknown, identity: unknown, opts?: unknown) => {
    persistCalls.push({ identity, opts });
  },
}));

// The session/prompt scenario below exercises `isAcpPromptEnvelope` ->
// `syncSandboxEnvForPrompt` — irrelevant to session-identity persistence and
// heavy (secrets/agents/sandbox-ingress lookups), so it's stubbed to a no-op.
mock.module('../lib/sandbox-env-sync', () => ({
  syncSandboxEnvForPrompt: async () => {},
}));

const { projectsApp } = await import('../lib/app');
await import('./acp');

const realFetch = globalThis.fetch;

beforeEach(() => {
  insertedEnvelopes = [];
  persistCalls = [];
  upstreamResponse = null;
  globalThis.fetch = (async (_url: unknown, _init: unknown) => {
    if (!upstreamResponse) throw new Error('no upstream response stubbed');
    return upstreamResponse;
  }) as typeof fetch;
});

function postAcp(body: Record<string, unknown>) {
  return projectsApp.request(`/${PROJECT_ID}/sessions/${SESSION_ID}/acp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST .../acp — interactive session-identity write site', () => {
  test('a session/new RESPONSE calls persistAcpSessionIdentity once, with the interactive shape', async () => {
    upstreamResponse = new Response(
      JSON.stringify({ jsonrpc: '2.0', id: 1, result: { sessionId: 'harness-minted-abc' } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

    const res = await postAcp({ jsonrpc: '2.0', id: 1, method: 'session/new', params: {} });

    expect(res.status).toBe(200);
    expect(persistCalls).toHaveLength(1);
    expect(persistCalls[0]).toEqual({
      identity: {
        projectSessionId: SESSION_ID,
        // resolveAcpTarget pins runtimeId === sessionId for the interactive
        // path today — see acp-session-identity.ts's RuntimeSessionIdentity
        // doc comment.
        runtimeId: SESSION_ID,
        acpSessionId: 'harness-minted-abc',
      },
      opts: { projectId: PROJECT_ID },
    });

    // Response body/status pass through untouched by the extraction.
    const body = await res.json();
    expect(body).toEqual({ jsonrpc: '2.0', id: 1, result: { sessionId: 'harness-minted-abc' } });
  });

  test('the write fires on the RESPONSE, not the request — a request the harness rejects (no result.sessionId) never persists', async () => {
    upstreamResponse = new Response(
      JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'boom' } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

    const res = await postAcp({ jsonrpc: '2.0', id: 1, method: 'session/new', params: {} });

    expect(res.status).toBe(200);
    expect(persistCalls).toHaveLength(0);
  });

  test('a session/load response never calls persistAcpSessionIdentity — only session/new does', async () => {
    upstreamResponse = new Response(
      JSON.stringify({ jsonrpc: '2.0', id: 2, result: { sessionId: 'harness-minted-abc' } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

    const res = await postAcp({ jsonrpc: '2.0', id: 2, method: 'session/load', params: { sessionId: 'harness-minted-abc' } });

    expect(res.status).toBe(200);
    expect(persistCalls).toHaveLength(0);
  });

  test('a session/prompt response never calls persistAcpSessionIdentity', async () => {
    upstreamResponse = new Response(
      JSON.stringify({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

    const res = await postAcp({ jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: 'harness-minted-abc', prompt: [] } });

    expect(res.status).toBe(200);
    expect(persistCalls).toHaveLength(0);
  });
});

describe('teardown', () => {
  test('restore real fetch', () => {
    globalThis.fetch = realFetch;
    expect(true).toBe(true);
  });
});
