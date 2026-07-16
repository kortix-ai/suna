// WS3-P0-c trigger-run integration test: a `trigger:cron` follow-up prompt
// driven all the way through `continueSession()` -> `postAcpPrompt()` ->
// `consumeHeadlessAcpSse()`, now wired onto the shared `sse-core` parser.
//
// Exercises, end to end, exactly what the brief's adjudications call for:
//   1. The prompt lifecycle stays byte-identical: initialize -> session/load
//      -> session/prompt, in that order, over the daemon-bridge POST path.
//   2. A poison SSE frame (`id: 2`, malformed `data:`) sandwiched between two
//      valid frames does NOT kill the run — event 1 (a plain notification)
//      and event 3 (a permission request) both still arrive; only event 2 is
//      silently skipped. Before WS3-P0-c this would have thrown out of
//      `consumeHeadlessAcpSse` and failed the whole delivery attempt.
//   3. The permission auto-answer flow (`selectHeadlessPermissionOption`,
//      "allow once") fires for the event-3 permission request and posts the
//      response back over the daemon bridge — unaffected by the poison frame
//      that preceded it in the same stream.
//
// Mocking follows the same "throwing-stub for anything unreached" pattern as
// `continue-session-deleted-guard.test.ts` in this directory.
import { describe, expect, mock, test } from 'bun:test';
import { projectSessions, projects } from '@kortix/db';

const SESSION_ID = 'sess-trigger-run-1';
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
const insertedEnvelopes: Array<{ direction: string; envelope: Record<string, unknown>; streamEventId: number | null }> = [];
const postedRequests: Array<{ jsonrpc?: string; method?: string; id?: unknown; result?: unknown }> = [];

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
    update: () => ({
      set: () => ({
        where: async () => {
          throw new Error('db.update: not expected — session is already running, no revival needed');
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
    runtime_id: 'rt-1',
    runtime_session_id: 'acp-sess-1',
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
      // A stream that never self-closes: it delivers its three fixed events
      // and then hangs (no further `enqueue`, no `close()`) until the
      // caller's `AbortSignal` cancels the reader — exactly mirroring a real
      // long-lived SSE connection that stays open until the daemon side (or
      // the client) tears it down. This makes the `Promise.race` in
      // `postAcpPrompt` deterministic: the stream side can NEVER win the
      // race on its own, only `session/prompt`'s POST can settle it.
      const permissionRequest = {
        jsonrpc: '2.0',
        id: 99,
        method: 'session/request_permission',
        params: { options: [{ optionId: 'allow_once', kind: 'allow_once' }] },
      };
      const body_ = new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder();
          // event 1: an ordinary notification, no `id` field in the envelope
          // — delivered, but not a "request" the headless side must answer.
          controller.enqueue(enc.encode('id: 1\ndata: {"jsonrpc":"2.0","method":"session/update","params":{}}\n\n'));
          // event 2: POISON — malformed data:, must be skipped, not fatal.
          controller.enqueue(enc.encode('id: 2\ndata: not-json\n\n'));
          // event 3: a permission request the headless side must auto-answer.
          controller.enqueue(enc.encode(`id: 3\ndata: ${JSON.stringify(permissionRequest)}\n\n`));
        },
      });
      return { ok: true, status: 200, body: body_ } as unknown as Response;
    }
    const text = body ? new TextDecoder().decode(body) : '{}';
    const parsed = JSON.parse(text) as { method?: string; id?: unknown; result?: unknown };
    postedRequests.push(parsed);
    if (parsed.method === 'initialize') {
      return jsonResponse({ jsonrpc: '2.0', id: parsed.id, result: { protocolVersion: 1 } });
    }
    if (parsed.method === 'session/load') {
      return jsonResponse({ jsonrpc: '2.0', id: parsed.id, result: { sessionId: 'acp-sess-1' } });
    }
    if (parsed.method === 'session/prompt') {
      return jsonResponse({ jsonrpc: '2.0', id: parsed.id, result: { stopReason: 'end_turn' } });
    }
    // Anything else is a response the headless side posts back to the agent
    // (the permission-request answer) — the real daemon accepts these
    // fire-and-forget with 202, no body.
    return { ok: true, status: 202, json: async () => { throw new Error('202 has no body'); } } as unknown as Response;
  },
}));

const { continueSession } = await import('../engine');

describe('WS3-P0-c trigger-run: continueSession -> postAcpPrompt over the shared sse-core', () => {
  test('a trigger:cron follow-up delivers, auto-answers the permission request, and survives the poison frame', async () => {
    const outcome = await continueSession({
      source: 'trigger:cron',
      sessionId: SESSION_ID,
      text: 'run the nightly check',
      userId: USER_ID,
    });

    expect(outcome).toBe('delivered');

    // Prompt lifecycle stays byte-identical: initialize -> session/load ->
    // session/prompt, in that exact order, over the daemon-bridge POST path.
    const lifecycleMethods = postedRequests.map((r) => r.method).filter(Boolean);
    expect(lifecycleMethods).toEqual(['initialize', 'session/load', 'session/prompt']);

    // The permission auto-answer flow fired for event 3's request (id 99)
    // and selected the one-turn grant, unaffected by the poison frame that
    // preceded it in the same stream.
    const permissionResponse = postedRequests.find((r) => r.id === 99);
    expect(permissionResponse).toEqual({
      jsonrpc: '2.0',
      id: 99,
      result: { outcome: { outcome: 'selected', optionId: 'allow_once' } },
    });

    // Event 1 (notification) and event 3 (permission request) were both
    // persisted; event 2 (poison) was skipped entirely — never reached
    // `onEnvelope`, so it never generated a persisted row.
    const agentToClientEventIds = insertedEnvelopes
      .filter((e) => e.direction === 'agent_to_client' && e.streamEventId !== null)
      .map((e) => e.streamEventId)
      .sort((a, b) => (a as number) - (b as number));
    expect(agentToClientEventIds).toEqual([1, 3]);
  });
});
