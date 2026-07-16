// WS3-P0-c: engine.ts's hand-rolled `call()` used to trust ANY truthy POST
// response body as a successful JSON-RPC response — it only guarded against
// `null` (the 202/204 fire-and-forget case), then read `.error`/`.result`
// unconditionally. `AcpClient.request()` (packages/sdk/src/acp/client.ts)
// has always validated the response SHAPE first via `isAcpResponseEnvelope`
// (`'id' in value && ('result' in value || 'error' in value) && !('method' in
// value)`) before trusting either field. `engine.ts`'s `call()` now uses the
// same shared predicate, closing that gap: a malformed daemon response
// (missing both `result` and `error`) now throws a precise error instead of
// silently returning `result: undefined` as a false "success".
//
// This test proves the guard actually fires by making the very first ACP
// call (`initialize`) return a malformed envelope. `postAcpPrompt`'s own
// try/catch turns that into a `false` delivery outcome immediately (no
// retries inside `postAcpPrompt` itself) — but `continueSession`'s
// `deliverWithRetry` wrapper still retries once for real (fixed 1500ms
// interval, not overridable from the call site), so this test pays that one
// real sleep to observe the true end-to-end outcome rather than mocking the
// retry loop away.
import { describe, expect, mock, test } from 'bun:test';
import { projectSessions, projects } from '@kortix/db';

const SESSION_ID = 'sess-malformed-response-1';
const ACCOUNT_ID = 'acct-1';
const PROJECT_ID = 'proj-1';

const sessionRow: Record<string, unknown> = {
  accountId: ACCOUNT_ID,
  projectId: PROJECT_ID,
  status: 'running',
  metadata: {},
  sandboxProvider: 'daytona',
  baseRef: null,
  agentName: null,
};

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
          throw new Error('db.update: not expected — session is already running');
        },
      }),
    }),
    insert: () => ({
      values: () => ({
        onConflictDoNothing: async () => {},
      }),
    }),
  },
}));

// `openSession` reports 'failed' from its second call onward so
// `deliverWithRetry`'s single real retry short-circuits to 'failed' instead
// of looping for the full 45s deadline.
let openCalls = 0;
mock.module('../../routes/shared', () => ({
  openSession: async () => {
    openCalls += 1;
    if (openCalls > 1) {
      return { stage: 'failed', sandbox: null, runtime_protocol: null, runtime_id: null, runtime_session_id: null };
    }
    return {
      stage: 'ready',
      sandbox: { external_id: 'sbx-1' },
      runtime_protocol: 'acp',
      runtime_id: 'rt-1',
      runtime_session_id: 'acp-sess-1',
    };
  },
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

const postedMethods: string[] = [];

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
      throw new Error('GET /acp stream: not expected in this test');
    }
    const text = body ? new TextDecoder().decode(body) : '{}';
    const parsed = JSON.parse(text) as { method?: string; id?: unknown };
    if (parsed.method) postedMethods.push(parsed.method);
    // Every lifecycle call gets the SAME malformed shape back: neither
    // `result` nor `error` — the exact envelope `isAcpResponseEnvelope`
    // rejects. Discriminates old vs. new `call()` precisely: WITHOUT the
    // guard, `envelope.result` silently reads as `undefined` and every call
    // "succeeds" (no `.error`), so the driver presses all the way through
    // initialize -> session/load -> session/prompt before finally failing on
    // the unrelated `typeof completed?.stopReason !== 'string'` check. WITH
    // the guard, `call('initialize', ...)` throws immediately and NOTHING
    // past `initialize` is ever posted.
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: parsed.id }) } as unknown as Response;
  },
}));

const { continueSession } = await import('../engine');

describe('WS3-P0-c: call() rejects a malformed JSON-RPC response via isAcpResponseEnvelope', () => {
  test('a response missing both result and error fails delivery at the FIRST malformed call, not three calls later', async () => {
    const outcome = await continueSession({
      source: 'trigger:cron',
      sessionId: SESSION_ID,
      text: 'run the nightly check',
      userId: 'automation-user-1',
    });

    expect(outcome === 'failed' || outcome === 'pending').toBe(true);
    expect(openCalls).toBeGreaterThanOrEqual(2);
    // The discriminating assertion: only `initialize` was ever posted for
    // EACH attempt — `session/load`/`session/prompt` never fire, proving the
    // guard rejected the malformed response immediately rather than letting
    // it silently propagate as a false "success".
    expect(postedMethods.every((m) => m === 'initialize')).toBe(true);
    expect(postedMethods.length).toBeGreaterThanOrEqual(1);
  }, 10_000);
});
