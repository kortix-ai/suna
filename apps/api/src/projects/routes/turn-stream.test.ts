/**
 * Characterization pins for POST /v1/projects/:projectId/turn-stream.
 *
 * Driven through the real Hono app (the same hermetic pattern as
 * `session-runtime-turn.test.ts`) because every claim here is about a RESPONSE
 * — the exact body and status each `kind` produces. The database is mocked, but
 * the mock executes each rendered WHERE the way Postgres would over
 * column-keyed rows (see `matches` below), so the IDOR scoping predicates are
 * falsifiable too. These pins exist to hold a restructure of the route's
 * dispatch (the monolithic kind callback → per-kind handlers) to
 * byte-identical responses: they pass against the pre-refactor callback and
 * must keep passing against the extracted handlers unchanged.
 *
 * Collaborators with real side effects (turn relay, sandbox turn lifecycle,
 * queue promotion, transcript mirror, push, title retry) are recorded fakes;
 * the pure classifiers between them (`turnCompletionAllowsQueuePromotion`,
 * `turnEndPushType`) stay REAL so the pins answer the behavior, not a stub.
 *
 * The real-SQL behavior of the lifecycle writes is covered by
 * `src/__tests__/integration-sandbox-turn-lifecycle.test.ts` (needs a live
 * Postgres — DB-suite lane, not this one).
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { projectSessions, sessionSandboxes } from '@kortix/db';
import { Hono } from 'hono';
import * as realRelay from '../../channels/turn-relay';
import * as realPush from '../../notifications/session-push';
import * as realAccess from '../lib/access';
import * as realMirror from '../lib/session-transcript-capture';
import { childIdleGraceMs } from '../sandbox-deadline';
import * as realLifecycle from '../sandbox-turn-lifecycle';
import * as realSessionLifecycle from '../session-lifecycle';
import * as realReconcile from '../session-lifecycle/forwarded-strand-reconcile';
import * as realStore from '../session-lifecycle/store';
import * as realTitle from '../session-title-generate';

const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const ACCOUNT_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '55555555-5555-4555-8555-555555555555';
const SANDBOX_ID = '66666666-6666-4666-8666-666666666666';

/** Rows keyed by DB COLUMN name — the mock projects through the column each
 *  selected field was bound to, so a projection naming the wrong column reads
 *  the wrong value here. */
type Row = Record<string, unknown>;

function sessionRow(overrides: Row = {}): Row {
  return {
    session_id: SESSION_ID,
    project_id: PROJECT_ID,
    account_id: ACCOUNT_ID,
    created_by: USER_ID,
    metadata: {},
    opencode_session_id: null,
    ...overrides,
  };
}

function sandboxRow(overrides: Row = {}): Row {
  return {
    sandbox_id: SANDBOX_ID,
    session_id: SESSION_ID,
    project_id: PROJECT_ID,
    account_id: ACCOUNT_ID,
    status: 'active',
    metadata: {},
    ...overrides,
  };
}

/** Render a drizzle SQL node to a stable string — `col:<name>` for columns,
 *  `$<json>` for bound parameters — so the WHERE evaluator follows the handler
 *  rather than restating it. */
function render(node: unknown): string {
  if (node == null) return '';
  if (Array.isArray(node)) return node.map(render).join('');
  if (typeof node === 'string') return node;
  if (typeof node !== 'object') return String(node);
  const n = node as Record<string, unknown>;
  if ('encoder' in n && 'value' in n) return `$${JSON.stringify(n.value)}`;
  if (typeof n.name === 'string' && n.table) return `col:${n.name}`;
  if ('queryChunks' in n) return render(n.queryChunks);
  if ('value' in n) return String(n.value);
  return `?${(n.constructor as { name?: string } | undefined)?.name ?? 'unknown'}`;
}

const PARAM = /\$("(?:\\.|[^"\\])*")/g;
const params = (text: string): unknown[] =>
  [...text.matchAll(PARAM)].map((match) => JSON.parse(match[1]) as unknown);

/** Evaluate the rendered WHERE against one column-keyed row: the `=`, `<>` and
 *  `in` operators joined by `and`, exactly what this route renders. Anything
 *  else throws, so a predicate the mock cannot honestly execute fails loudly. */
function matches(where: string, row: Row): boolean {
  const body = where.startsWith('(') && where.endsWith(')') ? where.slice(1, -1) : where;
  return body.split(' and ').every((clause) => {
    const eq = /^col:(\w+) = (.+)$/.exec(clause);
    if (eq) return row[eq[1]] === params(eq[2])[0];
    const ne = /^col:(\w+) <> (.+)$/.exec(clause);
    if (ne) return row[ne[1]] !== params(ne[2])[0];
    const inList = /^col:(\w+) in (.+)$/.exec(clause);
    if (inList) return params(inList[2]).includes(row[inList[1]]);
    throw new Error(`mock cannot evaluate the predicate: ${clause}`);
  });
}

function project(projection: Record<string, unknown>, rows: Row[]): Row[] {
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(projection).map(([field, column]) => [
        field,
        row[render(column).replace(/^col:/, '')],
      ]),
    ),
  );
}

let sandboxTable: Row[] = [];
let sessionTable: Row[] = [];
let queryCount = 0;
let pinUpdates: Array<{ values: Row; where: string }> = [];

/** Drizzle's builder is thenable at every stage — `.where(...)` alone is
 *  awaitable and `.where(...).limit(1)` must be too — so the mock returns a
 *  stage that carries `.limit` and resolves on await. */
function selectStage(projection: Record<string, unknown>, table: unknown, predicate: unknown) {
  const resolve = (limit: number) => {
    const where = render(predicate);
    const which =
      table === sessionSandboxes ? sandboxTable : table === projectSessions ? sessionTable : null;
    if (!which) throw new Error('query reads a table this route has no business reading');
    queryCount++;
    return Promise.resolve(
      project(
        projection,
        which.filter((row) => matches(where, row)),
      ).slice(0, limit),
    );
  };
  return {
    limit: (n: number) => ({
      // biome-ignore lint/suspicious/noThenProperty: The Drizzle query mock must be awaitable.
      then: (onFulfilled: never, onRejected: never) => resolve(n).then(onFulfilled, onRejected),
    }),
    // biome-ignore lint/suspicious/noThenProperty: The Drizzle query mock must be awaitable.
    then: (onFulfilled: never, onRejected: never) =>
      resolve(Number.POSITIVE_INFINITY).then(onFulfilled, onRejected),
  };
}

const databaseMock = {
  select: (projection: Record<string, unknown>) => ({
    from: (table: unknown) => ({
      where: (predicate: unknown) => selectStage(projection, table, predicate),
    }),
  }),
  update: (_table: unknown) => ({
    set: (values: Row) => ({
      where: (predicate: unknown) => ({
        returning: (projection: Record<string, unknown>) => {
          const where = render(predicate);
          pinUpdates.push({ values, where });
          queryCount++;
          const matched = sessionTable.filter((row) => matches(where, row));
          return Promise.resolve(project(projection, matched));
        },
      }),
    }),
  }),
};

// ── Recorded collaborators. Every fake pushes to its log SYNCHRONOUSLY on
//    invocation, so assertions after `await response` see fire-and-forget
//    calls that start before the route returned. ─────────────────────────────

let loadedProject: { row: { accountId: string; projectId: string }; userId: string } | null = {
  row: { accountId: ACCOUNT_ID, projectId: PROJECT_ID },
  userId: USER_ID,
};
let loadProjectCalls: Array<{ projectId: string; action: string }> = [];
let capabilityCalls: Array<{ accountId: string; projectId: string; action: string }> = [];

let completeResult: realLifecycle.SandboxTurnCompletionResult = {
  outcome: 'closed',
  activeTurnCount: 0,
  closedTurnCount: 2,
};
let completeCalls: Array<{
  sessionId: string;
  status: string;
  identity: unknown;
  error: unknown;
  graceMs: number | undefined;
}> = [];
let unidentifiedCauseCalls: Array<{ sessionId: string; ocId: string | null; cause: unknown }> = [];
let adoptCalls: Array<{ sandboxId: string; identity: unknown }> = [];
let adoptOutcome: string;
let acceptCalls: Array<{ target: unknown; token: string; identity: unknown }> = [];
let abandonCalls: Array<{ target: unknown; token: string }> = [];

let relayEndResult = true;
let relayEndCalls: Array<{ sessionId: string; status: string; errorInfo: unknown }> = [];
let stepRelayCalls: Array<{ sessionId: string; text: string; opts: unknown }> = [];
let stepRelayResult: { ok: boolean; reason?: string } = { ok: true };
let answerRelayCalls: Array<{ sessionId: string; text: string; blocks: unknown; card: unknown }> =
  [];
let answerRelayResult: { ok: boolean; reason?: string } = { ok: true };

let promoteResult: string | null = null;
let promoteCalls: string[] = [];
let drainCalls: Array<{ idempotencyKey: string; coalesce: boolean }> = [];
let reconcileCalls: Array<Record<string, unknown>> = [];
let mirrorCalls: string[] = [];
let pushCalls: Array<Record<string, unknown>> = [];
let titleCalls: Array<Record<string, unknown>> = [];

/** Ordered log of the three AWAITED settlement steps — the side-effect order
 *  the `end` kind must keep exactly. */
const awaitedOrder: string[] = [];

mock.module('../../shared/db', () => ({
  db: databaseMock,
  hasDatabase: true,
  transaction: async () => {},
  afterCommit: () => {},
}));
mock.module('../lib/access', () => ({
  ...realAccess,
  loadProjectForUser: async (_c: unknown, projectId: string, action: string) => {
    loadProjectCalls.push({ projectId, action });
    return loadedProject;
  },
  assertProjectCapability: async (
    _c: unknown,
    _userId: string,
    accountId: string,
    projectId: string,
    action: string,
  ) => {
    capabilityCalls.push({ accountId, projectId, action });
  },
}));
mock.module('../sandbox-turn-lifecycle', () => ({
  ...realLifecycle,
  completeSandboxTurn: async (
    sessionId: string,
    status: 'idle' | 'error',
    identity?: Partial<{ opencodeSessionId: string; messageId: string }> | null,
    error?: unknown,
    graceMs?: number,
  ) => {
    awaitedOrder.push('complete');
    completeCalls.push({ sessionId, status, identity, error, graceMs });
    return completeResult;
  },
  recordUnidentifiedTurnCause: async (
    sessionId: string,
    ocId: string | null,
    cause: { name: string; message: string | null },
  ) => {
    unidentifiedCauseCalls.push({ sessionId, ocId, cause });
    return 'recorded';
  },
  adoptRuntimeSandboxTurn: async (sandboxId: string, identity: unknown) => {
    adoptCalls.push({ sandboxId, identity });
    return adoptOutcome;
  },
  acceptSandboxTurn: async (target: unknown, token: string, identity: unknown) => {
    acceptCalls.push({ target, token, identity });
    return true;
  },
  abandonSandboxTurn: async (target: unknown, token: string) => {
    abandonCalls.push({ target, token });
    return true;
  },
}));
mock.module('../../channels/turn-relay', () => ({
  ...realRelay,
  relayTurnEnd: async (sessionId: string, status: string, errorInfo: unknown) => {
    awaitedOrder.push('relay');
    relayEndCalls.push({ sessionId, status, errorInfo });
    return relayEndResult;
  },
  relayTurnStepDetailed: async (sessionId: string, text: string, opts: unknown) => {
    stepRelayCalls.push({ sessionId, text, opts });
    return stepRelayResult;
  },
  relayTurnAnswerDetailed: async (
    sessionId: string,
    text: string,
    blocks: unknown,
    card: unknown,
  ) => {
    answerRelayCalls.push({ sessionId, text, blocks, card });
    return answerRelayResult;
  },
}));
mock.module('../../notifications/session-push', () => ({
  ...realPush,
  notifySessionEvent: async (event: Record<string, unknown>) => {
    pushCalls.push(event);
    return { delivered: 0, failed: 0 };
  },
}));
mock.module('../session-title-generate', () => ({
  ...realTitle,
  generateSessionTitleFromFirstPrompt: async (input: Record<string, unknown>) => {
    titleCalls.push(input);
  },
}));
mock.module('../session-lifecycle/forwarded-strand-reconcile', () => ({
  ...realReconcile,
  reconcileForwardedTurnsAtEnd: async (input: Record<string, unknown>) => {
    reconcileCalls.push(input);
    return {} as never;
  },
}));
mock.module('../lib/session-transcript-capture', () => ({
  ...realMirror,
  captureSessionTranscriptMirror: async (sessionId: string) => {
    mirrorCalls.push(sessionId);
    return {} as never;
  },
}));
mock.module('../session-lifecycle/store', () => ({
  ...realStore,
  promoteNextInboxRow: async (sessionId: string) => {
    awaitedOrder.push('promote');
    promoteCalls.push(sessionId);
    return promoteResult;
  },
}));
mock.module('../session-lifecycle', () => ({
  ...realSessionLifecycle,
  drainSessionLifecycleQueue: async (input: { idempotencyKey: string; coalesce: boolean }) => {
    drainCalls.push(input);
  },
}));

const { projectsApp } = await import('../lib/app');
await import('./turn-stream');

type Caller = {
  authType: string;
  sessionId?: string;
  sandboxId?: string;
  accountId?: string;
  apiKeyType?: string;
};

function buildApp(caller: Caller) {
  const app = new Hono<{
    Variables: {
      userId: string;
      authType: string;
      sessionId?: string;
      sandboxId?: string;
      accountId?: string;
      apiKeyType?: string;
    };
  }>();
  app.use('*', async (c, next) => {
    c.set('userId', USER_ID);
    c.set('authType', caller.authType);
    if (caller.sessionId !== undefined) c.set('sessionId', caller.sessionId);
    if (caller.sandboxId !== undefined) c.set('sandboxId', caller.sandboxId);
    if (caller.accountId !== undefined) c.set('accountId', caller.accountId);
    if (caller.apiKeyType !== undefined) c.set('apiKeyType', caller.apiKeyType);
    await next();
  });
  app.route('/v1/projects', projectsApp);
  return app;
}

/** A project PAT holder: project membership, no sandbox credential. */
const patCaller: Caller = { authType: 'pat' };
/** The session-scoped PAT a sandbox carries: sessionId === sandboxId. */
const sandboxCaller: Caller = {
  authType: 'pat',
  sessionId: SANDBOX_ID,
  sandboxId: SANDBOX_ID,
  accountId: ACCOUNT_ID,
};

function post(caller: Caller, body: unknown) {
  return buildApp(caller).request(`/v1/projects/${PROJECT_ID}/turn-stream`, {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

const END_RESPONSE = {
  ok: true,
  turn_completion: { outcome: 'closed', active_turn_count: 0, closed_turn_count: 2 },
  queue_promoted: true,
  promoted_prompt_id: 'prompt-1',
};

describe('POST /v1/projects/:projectId/turn-stream — characterization', () => {
  beforeEach(() => {
    sandboxTable = [];
    sessionTable = [];
    queryCount = 0;
    pinUpdates = [];
    loadedProject = { row: { accountId: ACCOUNT_ID, projectId: PROJECT_ID }, userId: USER_ID };
    loadProjectCalls = [];
    capabilityCalls = [];
    completeResult = { outcome: 'closed', activeTurnCount: 0, closedTurnCount: 2 };
    completeCalls = [];
    unidentifiedCauseCalls = [];
    adoptCalls = [];
    adoptOutcome = 'adopted';
    acceptCalls = [];
    abandonCalls = [];
    relayEndResult = true;
    relayEndCalls = [];
    stepRelayCalls = [];
    stepRelayResult = { ok: true };
    answerRelayCalls = [];
    answerRelayResult = { ok: true };
    promoteResult = 'prompt-1';
    promoteCalls = [];
    drainCalls = [];
    reconcileCalls = [];
    mirrorCalls = [];
    pushCalls = [];
    titleCalls = [];
    awaitedOrder.length = 0;
  });

  test('invalid JSON body is a 400 before any read', async () => {
    const response = await post(patCaller, '{not json');
    // The zod-openapi body validator intercepts malformed JSON before the
    // handler: a 400 plain-text body, no content type.
    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toBeNull();
    expect(await response.text()).toBe('Malformed JSON in request body');
    expect(queryCount).toBe(0);
  });

  test('missing session_id is a 400 before any read', async () => {
    const response = await post(patCaller, { kind: 'end' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'session_id is required' });
    expect(queryCount).toBe(0);
  });

  test('an unknown session is a 404 for a PAT caller', async () => {
    sessionTable = [];
    const response = await post(patCaller, { session_id: SESSION_ID, kind: 'end' });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
  });

  // ── The settlement pin: the `end` response, its awaited side-effect order,
  //    and the fields of turn_completion — byte for byte. ────────────────────

  test('kind=end settles, promotes the queue, relays, and returns the pinned body', async () => {
    sessionTable = [sessionRow({ metadata: { title_source: 'First prompt' } })];
    const response = await post(patCaller, { session_id: SESSION_ID, kind: 'end' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(END_RESPONSE);
    // Awaited order: settlement write → durable queue promotion → relay.
    expect(awaitedOrder).toEqual(['complete', 'promote', 'relay']);
    expect(completeCalls).toEqual([
      { sessionId: SESSION_ID, status: 'idle', identity: {}, error: undefined, graceMs: undefined },
    ]);
    expect(promoteCalls).toEqual([SESSION_ID]);
    expect(drainCalls).toEqual([{ idempotencyKey: 'prompt-1', coalesce: false }]);
    expect(relayEndCalls).toEqual([
      { sessionId: SESSION_ID, status: 'idle', errorInfo: undefined },
    ]);
    // A promoted queue means the session is still running: no completion push.
    expect(pushCalls).toEqual([]);
    // The transcript is final at turn end: the server mirrors it once.
    expect(mirrorCalls).toEqual([SESSION_ID]);
    // Turn end is the title retry point for a session with a stored source.
    expect(titleCalls).toEqual([
      {
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
        accountId: ACCOUNT_ID,
        userId: USER_ID,
        firstPromptText: 'First prompt',
      },
    ]);
    // Lifecycle kinds need project membership only: no connector.write gate.
    expect(capabilityCalls).toEqual([]);
    expect(loadProjectCalls).toEqual([{ projectId: PROJECT_ID, action: 'read' }]);
  });

  test('kind=end with an identity mismatch skips the relay and reports ok:false', async () => {
    completeResult = { outcome: 'identity_mismatch', activeTurnCount: 1, closedTurnCount: 0 };
    sessionTable = [sessionRow()];
    const response = await post(patCaller, {
      session_id: SESSION_ID,
      kind: 'end',
      turn_message_id: 'msg_old',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: false,
      turn_completion: { outcome: 'identity_mismatch', active_turn_count: 1, closed_turn_count: 0 },
      queue_promoted: false,
      promoted_prompt_id: null,
    });
    // The ledger refused to close its own turn; the channel relay must agree.
    expect(relayEndCalls).toEqual([]);
    expect(promoteCalls).toEqual([]);
  });

  test('kind=turn_end aliases the same settlement without a status field', async () => {
    completeResult = { outcome: 'already_closed', activeTurnCount: 1, closedTurnCount: 0 };
    promoteResult = null;
    sessionTable = [sessionRow()];
    const response = await post(patCaller, { session_id: SESSION_ID, kind: 'turn_end' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      turn_completion: { outcome: 'already_closed', active_turn_count: 1, closed_turn_count: 0 },
      queue_promoted: false,
      promoted_prompt_id: null,
    });
    expect(completeCalls[0]?.status).toBe('idle');
    expect(relayEndCalls).toEqual([
      { sessionId: SESSION_ID, status: 'idle', errorInfo: undefined },
    ]);
  });

  test('kind=end carries status=error and the structured error to the settlement write, and pushes', async () => {
    sessionTable = [sessionRow()];
    const response = await post(patCaller, {
      session_id: SESSION_ID,
      kind: 'end',
      status: 'error',
      error_name: 'OutOfCredits',
      error_message: 'credit balance exhausted',
      error_status: 402,
      error_retryable: false,
      error_provider: 'anthropic',
      opencode_session_id: 'oc_root',
      turn_message_id: 'msg_1',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(END_RESPONSE);
    expect(completeCalls[0]?.status).toBe('error');
    expect(completeCalls[0]?.identity).toEqual({
      opencodeSessionId: 'oc_root',
      messageId: 'msg_1',
    });
    expect(completeCalls[0]?.error).toEqual({
      name: 'OutOfCredits',
      message: 'credit balance exhausted',
      statusCode: 402,
      isRetryable: false,
      providerID: 'anthropic',
    });
    // The turn ended closed with no promoted prompt: an error completion push.
    expect(pushCalls).toEqual([{ type: 'error', sessionId: SESSION_ID, projectId: PROJECT_ID }]);
  });

  test('an unnamed memory-guard abort attaches its cause to the turn it stopped', async () => {
    completeResult = { outcome: 'no_active_turn', activeTurnCount: 0, closedTurnCount: 0 };
    promoteResult = null;
    sessionTable = [sessionRow()];
    const response = await post(patCaller, {
      session_id: SESSION_ID,
      kind: 'end',
      status: 'error',
      error_name: 'SandboxMemoryGuard',
      error_message: 'sandbox memory at 97%',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      turn_completion: { outcome: 'no_active_turn', active_turn_count: 0, closed_turn_count: 0 },
      queue_promoted: false,
      promoted_prompt_id: null,
    });
    expect(unidentifiedCauseCalls).toEqual([
      {
        sessionId: SESSION_ID,
        ocId: null,
        cause: { name: 'SandboxMemoryGuard', message: 'sandbox memory at 97%' },
      },
    ]);
  });

  test('a child session settles with the short child grace and skips root-only work', async () => {
    completeResult = { outcome: 'closed', activeTurnCount: 0, closedTurnCount: 1 };
    promoteResult = null;
    sessionTable = [sessionRow({ metadata: { spawned_by_session: 'parent-1' } })];
    const response = await post(patCaller, { session_id: SESSION_ID, kind: 'end' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      turn_completion: { outcome: 'closed', active_turn_count: 0, closed_turn_count: 1 },
      queue_promoted: false,
      promoted_prompt_id: null,
    });
    expect(completeCalls[0]?.graceMs).toBe(childIdleGraceMs());
    expect(reconcileCalls).toEqual([]);
    expect(mirrorCalls).toEqual([]);
    expect(promoteCalls).toEqual([]);
    expect(pushCalls).toEqual([]);
    // The relay still runs for a child; only the root-session work is skipped.
    expect(relayEndCalls).toEqual([
      { sessionId: SESSION_ID, status: 'idle', errorInfo: undefined },
    ]);
  });

  // ── One 403 pin per sandbox-token wall. ───────────────────────────────────

  test('kind=initial_turn_claim requires a sandbox token', async () => {
    sessionTable = [sessionRow()];
    const response = await post(patCaller, { session_id: SESSION_ID, kind: 'initial_turn_claim' });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'initial_turn_claim requires a sandbox token' });
  });

  test('kind=turn_abandoned requires a sandbox token', async () => {
    sessionTable = [sessionRow()];
    const response = await post(patCaller, {
      session_id: SESSION_ID,
      kind: 'turn_abandoned',
      turn_token: 't-1',
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'turn_abandoned requires a sandbox token' });
    expect(abandonCalls).toEqual([]);
  });

  test('kind=turn_accepted requires a sandbox token', async () => {
    sessionTable = [sessionRow()];
    const response = await post(patCaller, {
      session_id: SESSION_ID,
      kind: 'turn_accepted',
      turn_token: 't-1',
      opencode_session_id: 'oc_1',
      turn_message_id: 'msg_1',
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'turn_accepted requires a sandbox token' });
    expect(acceptCalls).toEqual([]);
  });

  test('kind=turn_begin requires a sandbox token', async () => {
    sessionTable = [sessionRow()];
    const response = await post(patCaller, {
      session_id: SESSION_ID,
      kind: 'turn_begin',
      opencode_session_id: 'oc_1',
      turn_message_id: 'msg_1',
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'turn_begin requires a sandbox token' });
    expect(adoptCalls).toEqual([]);
  });

  // ── The sandbox-credential path. ──────────────────────────────────────────

  test('a session-scoped sandbox token adopts a box-initiated turn', async () => {
    sandboxTable = [sandboxRow()];
    sessionTable = [sessionRow()];
    const response = await post(sandboxCaller, {
      session_id: SESSION_ID,
      kind: 'turn_begin',
      opencode_session_id: 'oc_1',
      turn_message_id: 'msg_1',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, outcome: 'adopted' });
    expect(adoptCalls).toEqual([
      { sandboxId: SANDBOX_ID, identity: { opencodeSessionId: 'oc_1', messageId: 'msg_1' } },
    ]);
    // The sandbox path authorizes from the box, never through project load.
    expect(loadProjectCalls).toEqual([]);
    expect(capabilityCalls).toEqual([]);
  });

  test('a sandbox token scoped to another project is refused before kind dispatch', async () => {
    // The wall fires in the sleeve, before any kind handler runs — `end` proves
    // it: no settlement write may run for an out-of-scope box.
    sandboxTable = [];
    sessionTable = [sessionRow()];
    const response = await post(sandboxCaller, { session_id: SESSION_ID, kind: 'end' });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'sandbox token is not scoped to this project' });
    expect(completeCalls).toEqual([]);
  });

  test('a sandbox token scoped to another session is refused after the project scope check', async () => {
    // The box exists for THIS project but its row binds a different session.
    sandboxTable = [sandboxRow({ session_id: 'other-session' })];
    sessionTable = [sessionRow()];
    const response = await post(sandboxCaller, { session_id: SESSION_ID, kind: 'end' });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'sandbox token is not scoped to this session' });
    expect(completeCalls).toEqual([]);
  });

  test('the sandbox-scoped initial_turn_claim returns the delivering prompt', async () => {
    sandboxTable = [
      sandboxRow({
        metadata: {
          activeTurns: {
            't-boot': { state: 'delivering', messageId: 'msg_boot' },
            't-live': { state: 'active', messageId: 'msg_live' },
          },
        },
      }),
    ];
    sessionTable = [sessionRow({ metadata: { initial_prompt: '  Ship the report  ' } })];
    const response = await post(sandboxCaller, {
      session_id: SESSION_ID,
      kind: 'initial_turn_claim',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      initial_turn: { prompt: 'Ship the report', turn_token: 't-boot', message_id: 'msg_boot' },
    });
  });

  test('the initial_turn_claim with nothing to deliver returns a null turn', async () => {
    sandboxTable = [sandboxRow()];
    sessionTable = [sessionRow({ metadata: { initial_prompt: 'Ship the report' } })];
    const response = await post(sandboxCaller, {
      session_id: SESSION_ID,
      kind: 'initial_turn_claim',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, initial_turn: null });
  });

  test('the sandbox token accepts its pre-created delivering turn', async () => {
    sandboxTable = [sandboxRow()];
    sessionTable = [sessionRow()];
    const response = await post(sandboxCaller, {
      session_id: SESSION_ID,
      kind: 'turn_accepted',
      turn_token: 't-boot',
      opencode_session_id: 'oc_1',
      turn_message_id: 'msg_1',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(acceptCalls).toEqual([
      {
        target: { sandboxId: SANDBOX_ID },
        token: 't-boot',
        identity: { opencodeSessionId: 'oc_1', messageId: 'msg_1' },
      },
    ]);
  });

  test('the sandbox token abandons only the token-bound delivering record', async () => {
    sandboxTable = [sandboxRow()];
    sessionTable = [sessionRow()];
    const response = await post(sandboxCaller, {
      session_id: SESSION_ID,
      kind: 'turn_abandoned',
      turn_token: 't-boot',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(abandonCalls).toEqual([{ target: { sandboxId: SANDBOX_ID }, token: 't-boot' }]);
  });

  // ── The opencode root-session pin. ───────────────────────────────────────

  test('kind=opencode_session pins the canonical root id', async () => {
    sessionTable = [sessionRow()];
    const response = await post(patCaller, {
      session_id: SESSION_ID,
      kind: 'opencode_session',
      opencode_session_id: 'oc_root',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(pinUpdates).toHaveLength(1);
    expect(pinUpdates[0]?.values.opencodeSessionId).toBe('oc_root');
  });

  test('kind=opencode_session without an id is a 400', async () => {
    sessionTable = [sessionRow()];
    const response = await post(patCaller, { session_id: SESSION_ID, kind: 'opencode_session' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'opencode_session_id is required' });
    expect(pinUpdates).toEqual([]);
  });

  // ── The content relay kinds. ─────────────────────────────────────────────

  test('kind=step relays the text and returns the relay verdict', async () => {
    stepRelayResult = { ok: true };
    sessionTable = [sessionRow()];
    const response = await post(patCaller, {
      session_id: SESSION_ID,
      kind: 'step',
      text: 'looking into it',
      detail: 'reading files',
      output: 'ls -la',
      sources: [
        { url: 'https://example.test/a', text: 'a' },
        { url: 'https://x', text: '' },
      ],
      blocks: [{ type: 'text', text: 'hi' }],
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(stepRelayCalls).toEqual([
      {
        sessionId: SESSION_ID,
        text: 'looking into it',
        opts: {
          detail: 'reading files',
          outputForPrev: 'ls -la',
          sourcesForPrev: [{ url: 'https://example.test/a', text: 'a' }],
        },
      },
    ]);
    // step posts content to the project's connector: connector.write required.
    expect(capabilityCalls).toEqual([
      { accountId: ACCOUNT_ID, projectId: PROJECT_ID, action: 'project.connector.write' },
    ]);
  });

  test('kind=answer relays the final message with the card the server built', async () => {
    answerRelayResult = { ok: false, reason: 'no_open_turn' };
    sessionTable = [sessionRow()];
    const response = await post(patCaller, {
      session_id: SESSION_ID,
      kind: 'answer',
      text: 'all done',
      form: { fields: [{ id: 'summary', label: 'Summary' }] },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: false, reason: 'no_open_turn' });
    expect(answerRelayCalls).toHaveLength(1);
    expect(answerRelayCalls[0]?.sessionId).toBe(SESSION_ID);
    expect(answerRelayCalls[0]?.text).toBe('all done');
    // A form spec is server-built into a card; a null card means the spec was
    // rejected upstream with its own body, not silently dropped here.
    expect(answerRelayCalls[0]?.card).toBeTruthy();
  });

  test('empty text is a 400 before the relay', async () => {
    sessionTable = [sessionRow()];
    const response = await post(patCaller, { session_id: SESSION_ID, kind: 'step', text: '   ' });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'text is required' });
    expect(stepRelayCalls).toEqual([]);
  });

  test('an unparseable form spec is a 400 with the invalid_form reason', async () => {
    sessionTable = [sessionRow()];
    const response = await post(patCaller, {
      session_id: SESSION_ID,
      kind: 'answer',
      text: 'all done',
      form: {},
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      reason: 'invalid_form',
      error: 'the form needs at least one field with an id and a label',
    });
    expect(answerRelayCalls).toEqual([]);
  });

  test('an unknown kind falls through to the step relay behind the connector gate', async () => {
    sessionTable = [sessionRow()];
    const response = await post(patCaller, {
      session_id: SESSION_ID,
      kind: 'something_new',
      text: 'hello',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(stepRelayCalls).toEqual([{ sessionId: SESSION_ID, text: 'hello', opts: {} }]);
    expect(capabilityCalls).toEqual([
      { accountId: ACCOUNT_ID, projectId: PROJECT_ID, action: 'project.connector.write' },
    ]);
  });
});
