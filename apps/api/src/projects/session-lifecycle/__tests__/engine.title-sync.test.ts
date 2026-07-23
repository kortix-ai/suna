// Headless-ingest wiring for the ACP title-sync pipeline (`engine.ts`'s
// `postAcpPrompt`): the same two call sites as `routes/acp.ts` (see
// `../../routes/acp.title-sync.test.ts`), but reached through
// `continueSession()` for Slack replies / scheduled triggers instead of the
// interactive browser POST/SSE path.
//   - a harness `session_info_update` title, delivered over the headless SSE
//     stream (`consumeHeadlessAcpSse`), calls `persistHarnessSessionTitle`;
//   - the `session/prompt` request built inside `postEnvelope` calls
//     `persistFallbackSessionTitle` with the first text block;
//   - a user-set `custom_name` blocks both — proven here end to end through
//     the REAL (unmocked) `../lib/acp-session-title` + `../lib/acp-envelope`
//     modules against a fake db, mirroring `postAcpPrompt.session-new-persist
//     .test.ts`'s "real module, fake db" idiom (as opposed to
//     `acp.title-sync.test.ts`'s mock-the-module idiom) so the no-op
//     guard itself is exercised through the wiring, not just asserted by call
//     args.
//
// Mocking follows `postAcpPrompt.trigger-run.test.ts`: `runtime_session_id`
// is pre-set so delivery takes the `session/load` branch (no `session/new`
// identity-mint noise), and the SSE stream never self-closes on its own —
// only `session/prompt`'s POST response settles the `Promise.race` in
// `postAcpPrompt`.
import { describe, expect, mock, test } from 'bun:test';
import { projectSessions, projects } from '@kortix/db';

const SESSION_ID = 'sess-engine-title-sync-1';
const ACCOUNT_ID = 'acct-1';
const PROJECT_ID = 'proj-1';
const USER_ID = 'automation-user-1';

let sessionRow: Record<string, unknown> = {
  accountId: ACCOUNT_ID,
  projectId: PROJECT_ID,
  status: 'running',
  metadata: {},
  sandboxProvider: 'daytona',
  baseRef: null,
  agentName: null,
};
const updateCalls: Array<{ set: Record<string, unknown> }> = [];
let streamEnvelopes: Array<{ id: number; envelope: Record<string, unknown> }> = [];
let promptText = 'first prompt text';

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

mock.module('../../../config', () => ({ config: {} }));

mock.module('../../../shared/db', () => ({
  db: {
    select: (_proj?: unknown) => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            if (table === projectSessions) return [sessionRow];
            if (table === projects) return [{ projectId: PROJECT_ID, accountId: ACCOUNT_ID }];
            return [];
          },
        }),
      }),
    }),
    update: (_table: unknown) => ({
      set: (set: Record<string, unknown>) => ({
        where: async () => {
          updateCalls.push({ set });
        },
      }),
    }),
    insert: (_table: unknown) => ({
      values: (_v: Record<string, unknown>) => ({
        onConflictDoNothing: async () => {},
      }),
    }),
  },
}));

mock.module('../../routes/shared', () => ({
  openSession: async () => ({
    stage: 'ready',
    sandbox: { external_id: 'sbx-1' },
    runtime_protocol: 'acp',
    runtime_id: 'rt-1',
    runtime_session_id: 'acp-sess-1', // pre-set -> session/load branch, no identity mint
  }),
}));

mock.module('../../lib/sessions', () => ({
  createProjectSession: async () => {
    throw new Error('createProjectSession: not expected in this test');
  },
}));
mock.module('../actor', () => ({
  resolveProjectAutomationActor: async () => {
    throw new Error(
      'resolveProjectAutomationActor: not expected — command.userId is supplied directly',
    );
  },
}));
mock.module('../backpressure', () => ({
  sessionBackpressureState: async () => ({ shouldQueue: false, reason: null }),
}));
mock.module('../store', () => ({
  claimCreateSessionCommand: async () => {
    throw new Error('not expected in this test');
  },
  claimDueLifecycleCommands: async () => {
    throw new Error('not expected in this test');
  },
  markCommandFailed: async () => {
    throw new Error('not expected in this test');
  },
  markCommandQueued: async () => {
    throw new Error('not expected in this test');
  },
  markCommandSucceeded: async () => {
    throw new Error('not expected in this test');
  },
  resultFromExistingCommand: () => {
    throw new Error('not expected in this test');
  },
}));

mock.module('../../../sandbox-proxy/routes/preview', () => ({
  forwardToSandbox: async (
    _externalId: string,
    _port: number,
    _principal: unknown,
    method: string,
    _path: string,
    _query: string,
    _headers: Headers,
    body: ArrayBuffer | undefined,
  ) => {
    if (method === 'GET') {
      // Never self-closes — matches trigger-run.test.ts's driver: only
      // session/prompt's POST can settle the Promise.race in postAcpPrompt.
      const body_ = new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder();
          for (const { id, envelope } of streamEnvelopes) {
            controller.enqueue(enc.encode(`id: ${id}\ndata: ${JSON.stringify(envelope)}\n\n`));
          }
        },
      });
      return { ok: true, status: 200, body: body_ } as unknown as Response;
    }
    const text = body ? new TextDecoder().decode(body) : '{}';
    const parsed = JSON.parse(text) as { method?: string; id?: unknown };
    if (parsed.method === 'initialize') {
      return jsonResponse({ jsonrpc: '2.0', id: parsed.id, result: { protocolVersion: 1 } });
    }
    if (parsed.method === 'session/load') {
      return jsonResponse({ jsonrpc: '2.0', id: parsed.id, result: { sessionId: 'acp-sess-1' } });
    }
    if (parsed.method === 'session/prompt') {
      return jsonResponse({ jsonrpc: '2.0', id: parsed.id, result: { stopReason: 'end_turn' } });
    }
    return {
      ok: true,
      status: 202,
      json: async () => {
        throw new Error('202 has no body');
      },
    } as unknown as Response;
  },
}));

const { continueSession } = await import('../engine');

function runOnce() {
  return continueSession({
    source: 'trigger:cron',
    sessionId: SESSION_ID,
    text: promptText,
    userId: USER_ID,
  });
}

describe('engine.ts headless title-sync wiring', () => {
  test('a harness session_info_update over the headless SSE stream persists the harness title', async () => {
    sessionRow = { ...sessionRow, metadata: {} };
    updateCalls.length = 0;
    streamEnvelopes = [
      {
        id: 1,
        envelope: {
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            update: {
              sessionUpdate: 'session_info_update',
              title: 'Fix the login bug',
              updatedAt: '2026-07-21T10:00:00.000Z',
            },
          },
        },
      },
    ];

    const outcome = await runOnce();
    expect(outcome).toBe('delivered');

    const titleWrite = updateCalls.find(
      (c) => (c.set.metadata as Record<string, unknown>)?.title_source === 'harness',
    );
    expect(titleWrite).toBeDefined();
    expect(titleWrite!.set.metadata).toEqual({
      name: 'Fix the login bug',
      title_source: 'harness',
      title_updated_at: '2026-07-21T10:00:00.000Z',
    });
  });

  test('the fallback title fires on the first prompt and never again once the row has a title', async () => {
    sessionRow = { ...sessionRow, metadata: {} };
    updateCalls.length = 0;
    streamEnvelopes = []; // no harness title on this run — pure fallback path
    promptText = 'first prompt text';

    const first = await runOnce();
    expect(first).toBe('delivered');
    const fallbackWrite = updateCalls.find(
      (c) => (c.set.metadata as Record<string, unknown>)?.title_source === 'fallback',
    );
    expect(fallbackWrite).toBeDefined();
    expect(fallbackWrite!.set.metadata).toEqual({
      name: 'first prompt text',
      title_source: 'fallback',
    });

    // Simulate the row now carrying what was just persisted, then send a
    // second prompt — the fallback module's own idempotency guard (already
    // unit-pinned in acp-session-title.test.ts) must make this a no-op, and
    // that no-op must actually reach through the wiring, not just be
    // theoretically true of the module in isolation.
    sessionRow = {
      ...sessionRow,
      metadata: fallbackWrite!.set.metadata as Record<string, unknown>,
    };
    updateCalls.length = 0;
    promptText = 'a later prompt text';

    const second = await runOnce();
    expect(second).toBe('delivered');
    expect(updateCalls).toHaveLength(0);
  });

  test('a user-set custom_name blocks both the harness and fallback writes', async () => {
    sessionRow = { ...sessionRow, metadata: { custom_name: 'My renamed session' } };
    updateCalls.length = 0;
    streamEnvelopes = [
      {
        id: 1,
        envelope: {
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            update: {
              sessionUpdate: 'session_info_update',
              title: 'A harness title',
              updatedAt: '2026-07-21T10:00:00.000Z',
            },
          },
        },
      },
    ];
    promptText = 'this prompt must never become the title';

    const outcome = await runOnce();
    expect(outcome).toBe('delivered');
    expect(updateCalls).toHaveLength(0);
  });
});
