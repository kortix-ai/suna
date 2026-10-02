/**
 * Characterization pins for the multiplexed `POST /:projectId/turn-stream`
 * relay. Every case asserts a RESPONSE or a recorded collaborator call, so the
 * per-kind extraction in `turn-stream.ts` can move code without changing a byte
 * of behavior. They pass before and after the extraction.
 *
 * The database and every side-effecting collaborator are mocked, so the pins
 * are unit-level: the projection, status and body of each kind, the four
 * sandbox-credential walls, and the `end`/`turn_end` settlement response. The
 * real SQL and the live database paths are covered by the DB suites
 * (`integration-sandbox-turn-lifecycle.test.ts`), not here.
 *
 * `mock.module` is process-global, so this file must run in its own process
 * (the repo's `--isolate` runner guarantees that).
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { projectSessions, sessionSandboxes } from '@kortix/db';
import { Hono } from 'hono';
import * as realAccess from '../lib/access';

const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const ACCOUNT_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '55555555-5555-4555-8555-555555555555';
const SANDBOX_ID = '66666666-6666-4666-8666-666666666666';

// ─── Recorded state the mocks read and write ─────────────────────────────────

let sandboxRow: Record<string, unknown> | null = null;
let ownedRow: Record<string, unknown> | null = null;
let sessionRow: Record<string, unknown> | null = null;
let updateRows: Array<{ sessionId: string }> = [];
let loadedProject: { row: { accountId: string; projectId: string }; userId: string } | null = {
  row: { accountId: ACCOUNT_ID, projectId: PROJECT_ID },
  userId: USER_ID,
};
const loadProjectCalls: Array<{ projectId: string; action: string }> = [];
const capabilityCalls: Array<{ action: string }> = [];

let completionResult = {
  outcome: 'closed' as
    | 'closed'
    | 'already_closed'
    | 'identity_mismatch'
    | 'no_active_turn'
    | 'non_terminal',
  activeTurnCount: 0,
  closedTurnCount: 1,
};
let promotedId: string | null = null;
let relayEndResult = true;
let relayEndArgs: unknown[] = [];
let stepResult: { ok: boolean; reason?: string } = { ok: true };
let answerResult: { ok: boolean; reason?: string } = { ok: true };
let formCardResult: Record<string, unknown> | null = { type: 'AdaptiveCard' };
let pushType: 'completion' | 'error' | null = null;
let abandonResult = true;
let adoptResult = 'adopted';
let causeResult = 'attached';
const order: string[] = [];

const databaseMock = {
  select: (projection: Record<string, unknown> = {}) => ({
    from: (_table: unknown) => ({
      where: () => ({
        limit: async () => {
          if ('sandboxId' in projection) return sandboxRow ? [sandboxRow] : [];
          // The session lookup projects accountId/createdBy; the owned-sandbox
          // lookup projects sessionId/metadata only.
          if ('accountId' in projection) return sessionRow ? [sessionRow] : [];
          if ('metadata' in projection) return ownedRow ? [ownedRow] : [];
          return [];
        },
      }),
    }),
  }),
  update: (_table: unknown) => ({
    set: (_values: Record<string, unknown>) => ({
      where: () => ({ returning: async () => updateRows }),
    }),
  }),
};

mock.module('../../shared/db', () => ({ db: databaseMock, hasDatabase: true }));

mock.module('../lib/access', () => ({
  ...realAccess,
  loadProjectForUser: async (_c: unknown, projectId: string, action: string) => {
    loadProjectCalls.push({ projectId, action });
    return loadedProject;
  },
  assertProjectCapability: async (
    _c: unknown,
    _userId: string,
    _accountId: string,
    _projectId: string,
    action: string,
  ) => {
    capabilityCalls.push({ action });
  },
}));

mock.module('../../channels/turn-relay', () => ({
  relayTurnStepDetailed: async () => stepResult,
  relayTurnAnswerDetailed: async () => answerResult,
  relayTurnEnd: async (...args: unknown[]) => {
    order.push('relayEnd');
    relayEndArgs = args;
    return relayEndResult;
  },
}));

mock.module('../../channels/teams/cards', () => ({
  buildFormCard: () => formCardResult,
}));

const realTurnLedger = await import('../session-turn-ledger');
const realTurnLifecycle = await import('../sandbox-turn-lifecycle');
const realStatusTransitions = await import('../session-lifecycle/status-transitions');

// Every session-status write the settle path attempts, recorded in order.
const sessionStatusWrites: Array<{
  transition: string;
  sessionId: string;
  error?: string | null;
}> = [];

mock.module('../sandbox-turn-lifecycle', () => ({
  ...realTurnLifecycle,
  abandonSandboxTurn: async () => abandonResult,
  acceptSandboxTurn: async () => true,
  adoptRuntimeSandboxTurn: async () => adoptResult,
  completeSandboxTurn: async () => {
    order.push('complete');
    return completionResult;
  },
}));

mock.module('../session-turn-ledger', () => ({
  ...realTurnLedger,
  recordUnidentifiedTurnCause: async () => causeResult,
  turnCompletionAllowsQueuePromotion: (result: { outcome: string }) =>
    result.outcome === 'closed' ||
    result.outcome === 'already_closed' ||
    result.outcome === 'no_active_turn',
}));

mock.module('../session-lifecycle', () => ({
  drainSessionLifecycleQueue: async () => {
    order.push('drain');
  },
}));

mock.module('../session-lifecycle/status-transitions', () => ({
  ...realStatusTransitions,
  transitionSession: async (
    transition: string,
    sessionId: string,
    write: { error?: string | null } = {},
  ) => {
    sessionStatusWrites.push({ transition, sessionId, error: write?.error });
    return true;
  },
}));

mock.module('../session-lifecycle/store', () => ({
  promoteNextInboxRow: async () => promotedId,
}));

mock.module('../session-lifecycle/forwarded-strand-reconcile', () => ({
  reconcileForwardedTurnsAtEnd: async () => {
    order.push('reconcile');
  },
}));

mock.module('../lib/session-transcript-capture', () => ({
  captureSessionTranscriptMirror: () => {
    order.push('mirror');
  },
}));

mock.module('../sandbox-deadline', () => ({ childIdleGraceMs: () => 1_000 }));

mock.module('../session-title-generate', () => ({
  generateSessionTitleFromFirstPrompt: async () => {
    order.push('title');
  },
}));

const triggerRunEnds: unknown[] = [];
mock.module('../lib/trigger-run-outcome', () => ({
  TRIGGER_REUSE_RETIRED_AT: 'trigger_reuse_retired_at',
  recordTriggerRunEnd: async (end: unknown) => {
    triggerRunEnds.push(end);
    return 'failed';
  },
}));

mock.module('../../notifications/session-push', () => ({
  turnEndPushType: () => pushType,
  notifySessionEvent: async () => {
    order.push('notify');
  },
}));

const { projectsApp } = await import('../lib/app');
await import('./turn-stream');

function buildApp(ctx: Record<string, unknown> = {}) {
  const app = new Hono<{ Variables: Record<string, unknown> }>();
  app.use('*', async (c, next) => {
    c.set('userId', USER_ID);
    c.set('authType', 'pat');
    for (const [key, value] of Object.entries(ctx)) c.set(key, value);
    await next();
  });
  app.route('/v1/projects', projectsApp);
  return app;
}

function post(body: unknown, ctx: Record<string, unknown> = {}) {
  return buildApp(ctx).request(`/v1/projects/${PROJECT_ID}/turn-stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const sandboxCtx = { sessionId: SANDBOX_ID, sandboxId: SANDBOX_ID, accountId: ACCOUNT_ID };
const session = (metadata: Record<string, unknown> = {}, createdBy: string | null = USER_ID) => ({
  sessionId: SESSION_ID,
  accountId: ACCOUNT_ID,
  createdBy,
  metadata,
});

beforeEach(() => {
  // A sandbox credential that is scoped to both the project and the session.
  // The two scope-refusal tests null the matching row.
  sandboxRow = { sandboxId: SANDBOX_ID, sessionId: SESSION_ID };
  ownedRow = { sessionId: SESSION_ID, metadata: {} };
  sessionRow = session();
  updateRows = [{ sessionId: SESSION_ID }];
  loadedProject = { row: { accountId: ACCOUNT_ID, projectId: PROJECT_ID }, userId: USER_ID };
  loadProjectCalls.length = 0;
  capabilityCalls.length = 0;
  completionResult = { outcome: 'closed', activeTurnCount: 0, closedTurnCount: 1 };
  promotedId = null;
  relayEndResult = true;
  relayEndArgs = [];
  stepResult = { ok: true };
  answerResult = { ok: true };
  formCardResult = { type: 'AdaptiveCard' };
  pushType = null;
  abandonResult = true;
  adoptResult = 'adopted';
  causeResult = 'attached';
  order.length = 0;
  triggerRunEnds.length = 0;
  sessionStatusWrites.length = 0;
});

describe('POST /v1/projects/:projectId/turn-stream — sleeve gates', () => {
  test('rejects an unparseable JSON body with 400', async () => {
    // Hono's `c.req.json()` turns a malformed body into an HTTPException before
    // the route's own `{ error: 'Invalid JSON body' }` fallback can run.
    const response = await post('{not json');
    expect(response.status).toBe(400);
    expect(await response.text()).toBe('Malformed JSON in request body');
  });

  test('rejects a missing session_id with 400 before any DB read', async () => {
    const response = await post({ kind: 'step', text: 'hi' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'session_id is required' });
  });

  test('404s when the project is not loadable for the caller', async () => {
    loadedProject = null;
    const response = await post({ session_id: SESSION_ID, kind: 'step', text: 'hi' });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
  });

  test('404s when the session does not belong to the project', async () => {
    sessionRow = null;
    const response = await post({ session_id: SESSION_ID, kind: 'step', text: 'hi' });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
  });

  test('reads the project at read tier and gates channel-send kinds on connector.write', async () => {
    await post({ session_id: SESSION_ID, kind: 'step', text: 'hi' });
    expect(loadProjectCalls).toEqual([{ projectId: PROJECT_ID, action: 'read' }]);
    expect(capabilityCalls).toEqual([{ action: 'project.connector.write' }]);
  });

  test('does NOT gate the lifecycle kinds on connector.write', async () => {
    await post({ session_id: SESSION_ID, kind: 'end' });
    expect(capabilityCalls).toEqual([]);
  });
});

describe('POST /v1/projects/:projectId/turn-stream — sandbox-credential walls', () => {
  // Each of the four upward-lifecycle kinds refuses a project/session PAT
  // before it validates its fields. The body is pinned to the byte.
  test('initial_turn_claim requires a sandbox token', async () => {
    const response = await post({ session_id: SESSION_ID, kind: 'initial_turn_claim' });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'initial_turn_claim requires a sandbox token' });
  });

  test('turn_abandoned requires a sandbox token', async () => {
    const response = await post({ session_id: SESSION_ID, kind: 'turn_abandoned' });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'turn_abandoned requires a sandbox token' });
  });

  test('turn_accepted requires a sandbox token', async () => {
    const response = await post({ session_id: SESSION_ID, kind: 'turn_accepted' });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'turn_accepted requires a sandbox token' });
  });

  test('turn_begin requires a sandbox token', async () => {
    const response = await post({ session_id: SESSION_ID, kind: 'turn_begin' });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'turn_begin requires a sandbox token' });
  });

  test('a sandbox credential not scoped to the project is refused', async () => {
    sandboxRow = null;
    const response = await post({ session_id: SESSION_ID, kind: 'step', text: 'hi' }, sandboxCtx);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'sandbox token is not scoped to this project' });
  });

  test('a sandbox credential not scoped to the session is refused', async () => {
    sandboxRow = { sandboxId: SANDBOX_ID, sessionId: SESSION_ID };
    ownedRow = null;
    const response = await post({ session_id: SESSION_ID, kind: 'step', text: 'hi' }, sandboxCtx);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'sandbox token is not scoped to this session' });
  });
});

describe('POST /v1/projects/:projectId/turn-stream — initial_turn_claim', () => {
  test('answers initial_turn: null when no prompt is pending', async () => {
    sessionRow = session({});
    const response = await post({ session_id: SESSION_ID, kind: 'initial_turn_claim' }, sandboxCtx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      initial_turn: null,
      runtime_session_id: null,
      opencode_session_id: null,
    });
  });

  // A daemon whose local pin file is gone (converged legacy box, rebuilt home)
  // must learn the durable pin here, or it adopts or creates a different root
  // and relays that over the pin (prod 2026-09-23: a session opened empty).
  test('returns the durable OpenCode root pin with or without a pending prompt', async () => {
    sessionRow = { ...session({}), opencodeSessionId: 'ses_durable' };
    const response = await post({ session_id: SESSION_ID, kind: 'initial_turn_claim' }, sandboxCtx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      initial_turn: null,
      // Both names: a W3 daemon reads runtime_session_id, an older one opencode_session_id.
      runtime_session_id: 'ses_durable',
      opencode_session_id: 'ses_durable',
    });
  });

  test('returns the prompt and the delivering turn token', async () => {
    sessionRow = session({ initial_prompt: '  build it  ' });
    sandboxRow = { sandboxId: SANDBOX_ID, sessionId: SESSION_ID };
    ownedRow = {
      sessionId: SESSION_ID,
      metadata: {
        activeTurns: {
          'turn-token-1': { state: 'delivering', messageId: 'msg_1' },
        },
      },
    };
    const response = await post({ session_id: SESSION_ID, kind: 'initial_turn_claim' }, sandboxCtx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      initial_turn: { prompt: 'build it', turn_token: 'turn-token-1', message_id: 'msg_1' },
      runtime_session_id: null,
      opencode_session_id: null,
    });
  });

  test('answers initial_turn: null when the delivering record has no message id', async () => {
    sessionRow = session({ initial_prompt: 'build it' });
    sandboxRow = { sandboxId: SANDBOX_ID, sessionId: SESSION_ID };
    ownedRow = {
      sessionId: SESSION_ID,
      metadata: { activeTurns: { 'turn-token-1': { state: 'delivering' } } },
    };
    const response = await post({ session_id: SESSION_ID, kind: 'initial_turn_claim' }, sandboxCtx);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      initial_turn: null,
      runtime_session_id: null,
      opencode_session_id: null,
    });
  });
});

describe('POST /v1/projects/:projectId/turn-stream — lifecycle acknowledgements', () => {
  test('turn_abandoned requires a turn_token and acknowledges the removal', async () => {
    const missing = await post({ session_id: SESSION_ID, kind: 'turn_abandoned' }, sandboxCtx);
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: 'turn_token is required' });

    abandonResult = false;
    const response = await post(
      { session_id: SESSION_ID, kind: 'turn_abandoned', turn_token: ' t1 ' },
      sandboxCtx,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: false });
  });

  test('turn_accepted requires all three identifiers', async () => {
    const response = await post(
      { session_id: SESSION_ID, kind: 'turn_accepted', turn_token: 't1' },
      sandboxCtx,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'turn_token, runtime_session_id, and turn_message_id are required',
    });
  });

  test('turn_accepted acknowledges the promoted record', async () => {
    const response = await post(
      {
        session_id: SESSION_ID,
        kind: 'turn_accepted',
        turn_token: 't1',
        opencode_session_id: 'oc1',
        turn_message_id: 'msg1',
      },
      sandboxCtx,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  test('turn_begin requires the runtime session and message ids', async () => {
    const response = await post(
      { session_id: SESSION_ID, kind: 'turn_begin', runtime_session_id: 'oc1' },
      sandboxCtx,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'runtime_session_id and turn_message_id are required',
    });
  });

  test('turn_begin accepts the W3 name and the pre-W3 name of the runtime session', async () => {
    adoptResult = 'open_turn_exists';
    for (const id of [{ runtime_session_id: 'oc1' }, { opencode_session_id: 'oc1' }]) {
      const response = await post(
        { session_id: SESSION_ID, kind: 'turn_begin', ...id, turn_message_id: 'msg1' },
        sandboxCtx,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, outcome: 'open_turn_exists' });
    }
  });

  test('turn_begin reports the adoption outcome', async () => {
    adoptResult = 'open_turn_exists';
    const response = await post(
      {
        session_id: SESSION_ID,
        kind: 'turn_begin',
        opencode_session_id: 'oc1',
        turn_message_id: 'msg1',
      },
      sandboxCtx,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, outcome: 'open_turn_exists' });
  });

  test('runtime_session requires the id, then reports whether a row was updated', async () => {
    const missing = await post({ session_id: SESSION_ID, kind: 'runtime_session' });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: 'runtime_session_id is required' });

    updateRows = [];
    const response = await post({
      session_id: SESSION_ID,
      kind: 'runtime_session',
      runtime_session_id: ' oc_root ',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: false });
  });

  test('a pre-W3 daemon pins with kind opencode_session and opencode_session_id', async () => {
    updateRows = [];
    const response = await post({
      session_id: SESSION_ID,
      kind: 'opencode_session',
      opencode_session_id: 'oc_root',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: false });
  });
});

describe('POST /v1/projects/:projectId/turn-stream — end / turn_end settlement', () => {
  test('end reports the settlement response and promotes no prompt', async () => {
    const response = await post({ session_id: SESSION_ID, kind: 'end' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      turn_completion: { outcome: 'closed', active_turn_count: 0, closed_turn_count: 1 },
      queue_promoted: false,
      promoted_prompt_id: null,
    });
  });

  test('turn_end is the alias and answers the same settlement shape', async () => {
    completionResult = { outcome: 'already_closed', activeTurnCount: 2, closedTurnCount: 0 };
    const response = await post({
      session_id: SESSION_ID,
      kind: 'turn_end',
      status: 'error',
      error_name: 'SandboxMemoryGuard',
      error_message: 'sandbox memory at 97%',
      error_status: 500,
      error_retryable: false,
      error_provider: 'anthropic',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      turn_completion: { outcome: 'already_closed', active_turn_count: 2, closed_turn_count: 0 },
      queue_promoted: false,
      promoted_prompt_id: null,
    });
    // The error detail is forwarded to the channel relay exactly as shaped.
    expect(relayEndArgs).toEqual([
      SESSION_ID,
      'error',
      {
        name: 'SandboxMemoryGuard',
        message: 'sandbox memory at 97%',
        statusCode: 500,
        isRetryable: false,
        providerID: 'anthropic',
      },
    ]);
  });

  test('end forwards a valid error_code as the error code and drops an unknown one (W5 E11)', async () => {
    await post({ session_id: SESSION_ID, kind: 'end', status: 'error', error_name: 'UnknownError', error_message: '402: pay', error_status: 402, error_code: 'credits' });
    expect((relayEndArgs[2] as { code?: string }).code).toBe('credits');
    relayEndArgs = [];
    await post({ session_id: SESSION_ID, kind: 'end', status: 'error', error_name: 'UnknownError', error_message: 'x', error_code: 'bogus' });
    expect((relayEndArgs[2] as { code?: string }).code).toBeUndefined();
  });

  // A trigger session's creator is a service account, so the turn-end push
  // reaches nobody; the end is recorded on the trigger instead.
  test('a turn end hands the run outcome to the trigger that created the session', async () => {
    const metadata = { trigger_kind: 'git', trigger_slug: 'triage' };
    sessionRow = session(metadata);
    await post({
      session_id: SESSION_ID,
      kind: 'turn_end',
      status: 'error',
      error_name: 'APIError',
      error_message: 'Payment Required: Insufficient credits.',
    });
    expect(triggerRunEnds).toEqual([
      {
        projectId: PROJECT_ID,
        accountId: ACCOUNT_ID,
        sessionId: SESSION_ID,
        metadata,
        status: 'error',
        error: {
          name: 'APIError',
          message: 'Payment Required: Insufficient credits.',
          statusCode: undefined,
          isRetryable: undefined,
          providerID: undefined,
        },
        outcome: 'closed',
        childSession: false,
      },
    ]);
  });

  test('end reports a promoted queued prompt', async () => {
    promotedId = 'prompt-9';
    const response = await post({ session_id: SESSION_ID, kind: 'end' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      queue_promoted: true,
      promoted_prompt_id: 'prompt-9',
    });
  });

  test('an identity mismatch skips the relay but still settles the ledger', async () => {
    completionResult = { outcome: 'identity_mismatch', activeTurnCount: 1, closedTurnCount: 0 };
    const response = await post({ session_id: SESSION_ID, kind: 'end' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: false,
      turn_completion: { outcome: 'identity_mismatch', active_turn_count: 1, closed_turn_count: 0 },
      queue_promoted: false,
      promoted_prompt_id: null,
    });
    expect(relayEndArgs).toEqual([]);
  });

  test('a coordinator-spawned session skips reconcile and promotion, and still saves its transcript', async () => {
    // A session another session's agent created runs in its own sandbox with
    // its own OpenCode root. Nobody may ever open it, so this turn end is the
    // only moment its history is saved: skipping it served `available: false`
    // and a loading bar to the first person who looked.
    sessionRow = session({ spawned_by_session: 'parent-1' });
    pushType = 'completion';
    const response = await post({ session_id: SESSION_ID, kind: 'end' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ queue_promoted: false });
    expect(order).toEqual(['complete', 'mirror', 'notify', 'relayEnd']);
  });

  test('the end side effects fire in the pinned order, promotion awaited before the ack', async () => {
    sessionRow = session({ title_source: 'first prompt' });
    promotedId = 'prompt-9';
    pushType = 'completion';
    await post({ session_id: SESSION_ID, kind: 'end' });
    expect(order).toEqual([
      'complete',
      'reconcile',
      'mirror',
      'drain',
      'notify',
      'title',
      'relayEnd',
    ]);
  });
});

describe('POST /v1/projects/:projectId/turn-stream — a terminal turn error parks the session', () => {
  // KRTX-1046: a session whose turn dies (`session.error`, not retryable) kept
  // `project_sessions.status = 'running'` — the sidebar's green dot and
  // `sessions ls` showed Running until the idle box was reaped ~15 min later.
  // The terminal error end must park the session row itself.
  test('a terminal error end parks the session with the cause', async () => {
    const response = await post({
      session_id: SESSION_ID,
      kind: 'end',
      status: 'error',
      error_name: 'APIError',
      error_message: '402: out of credits',
      error_status: 402,
      error_retryable: false,
    });
    expect(response.status).toBe(200);
    expect(sessionStatusWrites).toEqual([
      {
        transition: 'parkTurnError',
        sessionId: SESSION_ID,
        error: 'agent turn failed: APIError: 402: out of credits',
      },
    ]);
  });

  test('a bare error end with no detail still parks the session', async () => {
    const response = await post({ session_id: SESSION_ID, kind: 'end', status: 'error' });
    expect(response.status).toBe(200);
    expect(sessionStatusWrites).toEqual([
      { transition: 'parkTurnError', sessionId: SESSION_ID, error: 'agent turn failed' },
    ]);
  });

  test('a completed (idle) end parks nothing', async () => {
    await post({ session_id: SESSION_ID, kind: 'end' });
    expect(sessionStatusWrites).toEqual([]);
  });

  test('a retryable error (opencode is about to retry) parks nothing', async () => {
    completionResult = { outcome: 'non_terminal', activeTurnCount: 1, closedTurnCount: 0 };
    await post({
      session_id: SESSION_ID,
      kind: 'end',
      status: 'error',
      error_name: 'APIError',
      error_message: '429 rate limited',
      error_status: 429,
      error_retryable: true,
    });
    expect(sessionStatusWrites).toEqual([]);
  });

  test('an error end while a newer turn is live parks nothing', async () => {
    completionResult = { outcome: 'closed', activeTurnCount: 1, closedTurnCount: 1 };
    await post({
      session_id: SESSION_ID,
      kind: 'end',
      status: 'error',
      error_name: 'APIError',
      error_message: 'boom',
      error_retryable: false,
    });
    expect(sessionStatusWrites).toEqual([]);
  });

  test('a duplicate relay (the turn was already settled) parks nothing', async () => {
    completionResult = { outcome: 'already_closed', activeTurnCount: 0, closedTurnCount: 0 };
    await post({
      session_id: SESSION_ID,
      kind: 'end',
      status: 'error',
      error_name: 'APIError',
      error_message: 'boom',
      error_retryable: false,
    });
    expect(sessionStatusWrites).toEqual([]);
  });

  test('an aborted turn (a user stop) parks nothing', async () => {
    await post({
      session_id: SESSION_ID,
      kind: 'end',
      status: 'error',
      error_name: 'MessageAbortedError',
      error_message: 'aborted',
      error_retryable: false,
    });
    expect(sessionStatusWrites).toEqual([]);
  });
});

describe('POST /v1/projects/:projectId/turn-stream — content relay (step / answer)', () => {
  test('a missing text is refused for both channel-send kinds', async () => {
    for (const kind of ['step', 'answer', 'something_new']) {
      const response = await post({ session_id: SESSION_ID, kind });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'text is required' });
    }
  });

  test('step relays the trimmed text with the optional detail', async () => {
    const response = await post({
      session_id: SESSION_ID,
      kind: 'step',
      text: '  working  ',
      detail: ' a detail ',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  test('step carries the relay reason through on a refusal', async () => {
    stepResult = { ok: false, reason: 'no_open_turn' };
    const response = await post({ session_id: SESSION_ID, kind: 'step', text: 'hi' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: false, reason: 'no_open_turn' });
  });

  test('answer relays through the answer path and carries the refusal reason', async () => {
    answerResult = { ok: false, reason: 'slack_refused' };
    const response = await post({ session_id: SESSION_ID, kind: 'answer', text: 'done' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: false, reason: 'slack_refused' });
  });

  test('an unknown kind falls through to the step relay (deny-by-default gate)', async () => {
    const response = await post({ session_id: SESSION_ID, kind: 'execution_heartbeat', text: 'x' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(capabilityCalls).toEqual([{ action: 'project.connector.write' }]);
  });

  test('an invalid form spec is refused before any relay', async () => {
    formCardResult = null;
    const response = await post({
      session_id: SESSION_ID,
      kind: 'answer',
      text: 'x',
      form: { fields: [] },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      reason: 'invalid_form',
      error: 'the form needs at least one field with an id and a label',
    });
  });
});
