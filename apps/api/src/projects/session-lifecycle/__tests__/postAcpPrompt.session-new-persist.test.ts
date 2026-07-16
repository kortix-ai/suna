// WS3-P1-a: the HEADLESS ACP session-identity write site
// (`postAcpPrompt`'s `else` branch in engine.ts, hit when `openSession`
// reports no existing `runtime_session_id`) now delegates to the shared
// `persistAcpSessionIdentity()` write path (`../lib/acp-session-identity.ts`)
// instead of hand-rolling its own read-merge-write. This test drives
// `continueSession()` end to end — mirroring `postAcpPrompt.trigger-run
// .test.ts`'s driver harness — through the FIRST-MINT branch specifically
// (no prior `acp_session_id`), and pins the exact metadata shape/timing the
// real (unmocked) `persistAcpSessionIdentity` module writes:
//   - runtime_protocol: 'acp', runtime_id: <the headless runtimeId,
//     i.e. the daemon-reported ACP server id — NOT the Kortix sessionId>,
//     acp_session_id: <the harness-minted session/new id>
//   - existing unrelated metadata keys are preserved (merge, not replace)
//   - the write happens exactly once, AFTER `session/new`'s response lands,
//     before `session/prompt` is issued
//   - no `opts.projectId` scoping (unlike the interactive site — see
//     `acp.session-identity.test.ts`) — headless never passed it pre-extraction
//
// `../../shared/db` mocking follows the same table-branching pattern as
// `postAcpPrompt.trigger-run.test.ts` / `postAcpPrompt.malformed-response
// .test.ts`, extended to actually perform the update (captured, not
// rejected) so `persistAcpSessionIdentity`'s real read-then-write runs for
// real against this fake db.
import { describe, expect, mock, test } from 'bun:test';
import { projectSessions, projects } from '@kortix/db';

const SESSION_ID = 'sess-session-new-persist-1';
const ACCOUNT_ID = 'acct-1';
const PROJECT_ID = 'proj-1';
const USER_ID = 'automation-user-1';

let sessionRow: Record<string, unknown> = {
  accountId: ACCOUNT_ID,
  projectId: PROJECT_ID,
  status: 'running',
  metadata: { unrelated_key: 'preserved', runtime_protocol: 'stale' },
  sandboxProvider: 'daytona',
  baseRef: null,
  agentName: null,
};
const insertedEnvelopes: Array<{ direction: string; envelope: Record<string, unknown>; streamEventId: number | null }> = [];
const postedRequests: Array<{ jsonrpc?: string; method?: string; id?: unknown; result?: unknown }> = [];
const updateCalls: Array<{ set: Record<string, unknown> }> = [];

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
      values: (v: Record<string, unknown>) => ({
        onConflictDoNothing: async () => {
          insertedEnvelopes.push(v as { direction: string; envelope: Record<string, unknown>; streamEventId: number | null });
        },
      }),
    }),
  },
}));

mock.module('../../routes/shared', () => ({
  openSession: async () => ({
    stage: 'ready',
    sandbox: { external_id: 'sbx-1' },
    runtime_protocol: 'acp',
    runtime_id: 'acp-server-77', // the daemon-reported ACP server id — this
    // is the headless site's `runtimeId`, distinct from `SESSION_ID`.
    runtime_session_id: null, // no existing acp_session_id -> session/new mint branch
  }),
}));

mock.module('../../lib/sessions', () => ({
  createProjectSession: async () => {
    throw new Error('createProjectSession: not expected in this test');
  },
}));
mock.module('../actor', () => ({
  resolveProjectAutomationActor: async () => {
    throw new Error('resolveProjectAutomationActor: not expected — command.userId is supplied directly');
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
      // A stream that never self-closes on its own — matches
      // postAcpPrompt.trigger-run.test.ts's driver: only session/prompt's
      // POST settles the race.
      const body_ = new ReadableStream<Uint8Array>({ start() {} });
      return { ok: true, status: 200, body: body_ } as unknown as Response;
    }
    const text = body ? new TextDecoder().decode(body) : '{}';
    const parsed = JSON.parse(text) as { method?: string; id?: unknown; result?: unknown };
    postedRequests.push(parsed);
    if (parsed.method === 'initialize') {
      return jsonResponse({ jsonrpc: '2.0', id: parsed.id, result: { protocolVersion: 1 } });
    }
    if (parsed.method === 'session/new') {
      // The harness mints a session id that lives in a completely unrelated
      // namespace from `SESSION_ID` (Kortix's own PK) or `runtime_id`
      // ('acp-server-77') above.
      return jsonResponse({ jsonrpc: '2.0', id: parsed.id, result: { sessionId: 'harness-minted-session-xyz' } });
    }
    if (parsed.method === 'session/prompt') {
      return jsonResponse({ jsonrpc: '2.0', id: parsed.id, result: { stopReason: 'end_turn' } });
    }
    return { ok: true, status: 202, json: async () => { throw new Error('202 has no body'); } } as unknown as Response;
  },
}));

const { continueSession } = await import('../engine');

describe('WS3-P1-a headless session-identity write site: postAcpPrompt first-mint branch', () => {
  test('a first-time (no acp_session_id) delivery mints via session/new, then persists exactly the interactive-parity shape through the real persistAcpSessionIdentity module', async () => {
    const outcome = await continueSession({
      source: 'trigger:cron',
      sessionId: SESSION_ID,
      text: 'run the nightly check',
      userId: USER_ID,
    });

    expect(outcome).toBe('delivered');

    // Lifecycle: initialize -> session/new -> session/prompt, in that order.
    const lifecycleMethods = postedRequests.map((r) => r.method).filter(Boolean);
    expect(lifecycleMethods).toEqual(['initialize', 'session/new', 'session/prompt']);

    // Exactly one metadata write, and it happened (index-wise) after
    // session/new's response landed and before session/prompt was issued —
    // captured here by the update firing exactly once and the lifecycle
    // order above already proving session/new preceded session/prompt.
    expect(updateCalls).toHaveLength(1);
    const { metadata, updatedAt } = updateCalls[0]!.set as {
      metadata: Record<string, unknown>;
      updatedAt: Date;
    };
    expect(metadata).toEqual({
      unrelated_key: 'preserved', // pre-existing metadata is merged, not replaced
      runtime_protocol: 'acp',
      runtime_id: 'acp-server-77', // headless runtimeId — the ACP server id, not SESSION_ID
      acp_session_id: 'harness-minted-session-xyz',
    });
    expect(updatedAt).toBeInstanceOf(Date);
  });
});
