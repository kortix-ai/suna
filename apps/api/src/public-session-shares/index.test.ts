import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

const SHARE_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const WORKER_EXTERNAL_ID = 'worker-ext';
const ENVIRONMENT_EXTERNAL_ID = 'env-ext';

let selectResults: Array<Array<Record<string, unknown>>> = [];
let discoveryExternalIds: string[] = [];
let endpointExternalIds: string[] = [];
let fetchUrls: string[] = [];
let mirror: Record<string, unknown> | null = null;
let mirrorReads = 0;

mock.module('../projects/lib/session-transcript-mirror', () => ({
  readSessionTranscriptMirror: async () => { mirrorReads++; return mirror; },
}));
const originalFetch = globalThis.fetch;

mock.module('../shared/db', () => ({
  db: {
    select: () => ({
      from: () => {
        const rows = selectResults.shift() ?? [];
        const query = {
          leftJoin: () => query,
          innerJoin: () => query,
          where: () => query,
          limit: async () => rows,
        };
        return query;
      },
    }),
  },
}));

mock.module('../projects/opencode-mapping', () => ({
  listSandboxOpencodeSessions: async (externalId: string) => {
    discoveryExternalIds.push(externalId);
    return { ok: true, sessions: [{ id: 'runtime-session' }] };
  },
  resolveRootSessionId: () => 'runtime-session',
  sandboxOpencodeEndpoint: async (externalId: string) => {
    endpointExternalIds.push(externalId);
    return { url: `https://${externalId}.test`, headers: {} };
  },
}));

const { publicSessionSharesApp } = await import('./index');

beforeEach(() => {
  selectResults = [
    [
      {
        shareId: SHARE_ID,
        sessionId: SESSION_ID,
        projectId: '33333333-3333-4333-8333-333333333333',
        accountId: '44444444-4444-4444-8444-444444444444',
        resourceType: 'preview',
        label: 'Pi preview',
        port: 3000,
        path: '/',
        filePath: null,
        mode: 'view',
        allowWebsocket: false,
        expiresAt: null,
        revokedAt: null,
        workerExternalId: WORKER_EXTERNAL_ID,
        workerStatus: 'active',
        environmentSessionId: SESSION_ID,
        environmentExternalId: ENVIRONMENT_EXTERNAL_ID,
        environmentStatus: 'active',
      },
    ],
    [],
    [{ opencodeSessionId: 'runtime-session' }],
  ];
  mirror = null;
  mirrorReads = 0;
  discoveryExternalIds = [];
  endpointExternalIds = [];
  fetchUrls = [];
  globalThis.fetch = mock(async (input: RequestInfo | URL) => {
    fetchUrls.push(String(input));
    return new Response(
      JSON.stringify([
        {
          info: { role: 'assistant' },
          parts: [{ type: 'text', text: 'worker transcript' }],
        },
      ]),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('public session share transcript routing', () => {
  test('routes Pi transcript discovery and messages through the worker runtime', async () => {
    const response = await publicSessionSharesApp.request(`/${SHARE_ID}/messages`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      available: true,
      message_count: 1,
      messages: [{ text: 'worker transcript' }],
    });
    expect(discoveryExternalIds).toEqual([WORKER_EXTERNAL_ID]);
    expect(endpointExternalIds).toEqual([WORKER_EXTERNAL_ID]);
    expect(fetchUrls).toHaveLength(1);
    expect(fetchUrls[0]).toStartWith(`https://${WORKER_EXTERNAL_ID}.test/session/`);
    expect(JSON.stringify({ discoveryExternalIds, endpointExternalIds, fetchUrls })).not.toContain(
      ENVIRONMENT_EXTERNAL_ID,
    );
  });

  test('keeps one-runtime OpenCode transcript routing on the session sandbox', async () => {
    const runtimeExternalId = 'opencode-ext';
    const baseRow = selectResults[0]?.[0] ?? {};
    selectResults[0] = [
      {
        ...baseRow,
        workerExternalId: runtimeExternalId,
        workerStatus: 'active',
        environmentSessionId: null,
        environmentExternalId: null,
        environmentStatus: null,
      },
    ];

    const response = await publicSessionSharesApp.request(`/${SHARE_ID}/messages`);

    expect(response.status).toBe(200);
    expect(discoveryExternalIds).toEqual([runtimeExternalId]);
    expect(endpointExternalIds).toEqual([runtimeExternalId]);
    expect(fetchUrls).toHaveLength(1);
    expect(fetchUrls[0]).toStartWith(`https://${runtimeExternalId}.test/session/`);
  });
});


test.each(['stopped', 'absent'])('reads a sanitized durable transcript when the worker is %s', async (state) => {
  selectResults[0][0] = { ...selectResults[0][0], workerExternalId: state === 'absent' ? null : WORKER_EXTERNAL_ID, workerStatus: 'stopped', environmentSessionId: null, environmentExternalId: null, environmentStatus: null };
  mirror = { opencode_session_id: 'runtime-session', captured_at: '2026-09-08T00:00:00.000Z', total: 1, head_complete: true, messages: [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: 'saved conversation' }, { type: 'tool', tool: 'bash', state: { status: 'completed', input: 'private command', output: 'private output' } }, { type: 'reasoning', text: 'private reasoning' }] }] };
  const response = await publicSessionSharesApp.request(`/${SHARE_ID}/messages`);
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({ available: true, source: 'mirror', captured_at: '2026-09-08T00:00:00.000Z', complete: true, messages: [{ text: 'saved conversation', tools: [{ tool: 'bash', status: 'completed' }], reasoning_omitted: true }] });
  expect(JSON.stringify(body)).not.toContain('private');
  expect(discoveryExternalIds).toEqual([]);
  expect(endpointExternalIds).toEqual([]);
  expect(fetchUrls).toEqual([]);
  expect(mirrorReads).toBe(1);
});

test('revoked shares cannot read the durable transcript', async () => {
  selectResults[0][0].revokedAt = new Date();
  const response = await publicSessionSharesApp.request(`/${SHARE_ID}/messages`);
  expect(response.status).toBe(410);
  expect(mirrorReads).toBe(0);
});


test('a mirror from a different conversation cannot replace the pinned root', async () => {
  selectResults[0][0].workerStatus = 'stopped';
  mirror = { opencode_session_id: 'other-root', messages: [], total: 0, head_complete: true };
  const response = await publicSessionSharesApp.request(`/${SHARE_ID}/messages`);
  expect(response.status).toBe(503);
});

test('an expired share cannot read the durable transcript', async () => {
  selectResults[0][0].expiresAt = new Date(0);
  const response = await publicSessionSharesApp.request(`/${SHARE_ID}/messages`);
  expect(response.status).toBe(410);
  expect(mirrorReads).toBe(0);
});

test('personal connector bindings still deny the durable transcript', async () => {
  selectResults[1] = [{ connectionId: 'personal-connection' }];
  const response = await publicSessionSharesApp.request(`/${SHARE_ID}/messages`);
  expect(response.status).toBe(403);
  expect(mirrorReads).toBe(0);
});
