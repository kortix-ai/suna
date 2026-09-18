/**
 * The prompt inbox routes — POST/GET/DELETE/retry on
 * `/v1/projects/:projectId/sessions/:sessionId/prompts`.
 *
 * Driven through the real Hono app, because every claim here is about a
 * RESPONSE and about which durable row the handler names. The database is
 * mocked to a table the handler's writes actually mutate, so "the delete only
 * touches a deletable row" and "retry clears the failure" are falsifiable
 * here. The real SQL runs against real Postgres in
 * `src/__tests__/integration-prompt-inbox.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';
import * as realAccess from '../lib/access';
import * as realLifecycle from '../session-lifecycle';
import * as realEngine from '../session-lifecycle/engine';

const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const ACCOUNT_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '55555555-5555-4555-8555-555555555555';
const PROMPT_ID = '66666666-6666-4666-8666-666666666666';
const WIRE_ID = 'msg_0198f3a1b2c4AbCdEfGhIjKlMn';

type CommandRow = {
  commandId: string;
  commandType: string;
  idempotencyKey: string | null;
  sessionId: string | null;
  status: string;
  attempts: number;
  payload: Record<string, unknown>;
  result: Record<string, unknown>;
  lastError: string | null;
  createdAt: Date;
  availableAt: Date;
};

let commandTable: CommandRow[] = [];
let sessionMetadata: Record<string, unknown> | null = {};
let enqueued: Array<Record<string, unknown>> = [];
let drains: Array<Record<string, unknown>> = [];
let enqueueResult: { deduped: boolean; row: CommandRow } | null = null;
let billingOk = true;
let enqueueDelayMs = 0;
let enqueueSettledAtMs = 0;

function row(overrides: Partial<CommandRow> = {}): CommandRow {
  return {
    commandId: PROMPT_ID,
    commandType: 'continue_session',
    idempotencyKey: `prompt:${SESSION_ID}:q_1`,
    sessionId: SESSION_ID,
    status: 'queued',
    attempts: 0,
    payload: { text: 'say hi', clientMessageId: 'q_1', wireMessageId: WIRE_ID },
    result: {},
    lastError: null,
    createdAt: new Date('2026-08-18T00:00:00.000Z'),
    availableAt: new Date('2026-08-18T00:00:00.000Z'),
    ...overrides,
  };
}

// A deliberately small database stand-in: the handler's WHERE clauses are
// re-expressed here as row predicates the mock applies, and its writes mutate
// `commandTable`, so an UPDATE that forgets its status guard changes an answer
// below.
// A settable read delay, so a test can prove WHERE a handler stamps its
// `observed_at` relative to the read — a stamp taken after a slow read lands
// measurably later than one taken before it.
let dbReadDelayMs = 0;
const afterReadDelay = <T>(value: () => T): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(value()), dbReadDelayMs));
// The same for UPDATEs, plus the instant the last one settled, so a test can
// prove a handler stamps `observed_at` after its writes rather than before.
let dbWriteDelayMs = 0;
let writeSettledAtMs = 0;
function afterWriteDelay<T>(apply: () => T): Promise<T> {
  const settle = () => {
    const value = apply();
    writeSettledAtMs = Date.now();
    return value;
  };
  if (dbWriteDelayMs <= 0) return Promise.resolve().then(settle);
  return new Promise((resolve) => setTimeout(() => resolve(settle()), dbWriteDelayMs));
}
/** Runs once, inside the next UPDATE, after its WHERE matched and before its
 *  SET applies. A throw fails that statement; a row edit lands between that
 *  statement's match and the next statement's. */
let onCommandUpdate: (() => void) | null = null;

const queryMock = {
  select: () => ({
    from: (table: unknown) => ({
      where: (predicate: unknown) => {
        const stage = {
          orderBy: () => stage,
          limit: (n: number) => afterReadDelay(() => stage.rows().slice(0, n)),
          rows: () => {
            if (String(table) === 'project_sessions') {
              return [{ metadata: sessionMetadata, accountId: ACCOUNT_ID }];
            }
            return commandTable.filter((r) => predicateOf(predicate)(r));
          },
          // biome-ignore lint/suspicious/noThenProperty: awaitable query builder.
          then: (resolve: (rows: unknown[]) => unknown) =>
            afterReadDelay(() => stage.rows()).then(resolve),
        };
        return stage;
      },
    }),
  }),
  update: () => ({
    set: (values: Record<string, unknown>) => ({
      where: (predicate: unknown) => {
        const apply = () => {
          const hit = commandTable.filter((r) => predicateOf(predicate)(r));
          const hook = onCommandUpdate;
          onCommandUpdate = null;
          hook?.();
          for (const r of hit) applyValues(r, values);
          return hit;
        };
        return {
          returning: () => afterWriteDelay(apply),
          // biome-ignore lint/suspicious/noThenProperty: awaitable query builder.
          then: (resolve: (v: unknown) => unknown) => afterWriteDelay(apply).then(resolve),
        };
      },
    }),
  }),
  delete: () => ({
    where: (predicate: unknown) => ({
      returning: async () => {
        const hit = commandTable.filter((r) => predicateOf(predicate)(r));
        commandTable = commandTable.filter((r) => !hit.includes(r));
        return hit;
      },
    }),
  }),
};

const databaseMock = {
  ...queryMock,
  transaction: async <T>(callback: (tx: typeof queryMock) => Promise<T>): Promise<T> =>
    callback(queryMock),
};

/**
 * Apply an UPDATE's SET clause the way Postgres would.
 *
 * The handlers MERGE jsonb (`payload || '{"remintOnDelivery": true}'::jsonb`,
 * `result - 'held'`) rather than replacing it, and that is load-bearing:
 * `retryInboxPrompt` replaces `result` on purpose while preserving `payload`,
 * which is what keeps a "send now" from delivering a stale wire id. Assigning
 * the SQL node verbatim would wipe the column and every assertion below reads
 * through it.
 */
function applyValues(r: CommandRow, values: Record<string, unknown>) {
  for (const [key, value] of Object.entries(values)) {
    const patch = jsonbPatch(value);
    if (!patch) {
      (r as Record<string, unknown>)[key] = value;
      continue;
    }
    const current = ((r as Record<string, unknown>)[key] ?? {}) as Record<string, unknown>;
    const next = { ...current, ...patch.merge };
    for (const dropped of patch.remove) delete next[dropped];
    (r as Record<string, unknown>)[key] = next;
  }
}

/** The jsonb literals a `col || '{…}'::jsonb - 'key'` expression applies. */
function jsonbPatch(
  value: unknown,
): { merge: Record<string, unknown>; remove: string[] } | null {
  if (!value || typeof value !== 'object' || !('queryChunks' in (value as object))) return null;
  const rendered = render(value);
  const merge = [...rendered.matchAll(/'(\{[^']*\})'::jsonb/g)]
    .map((m) => JSON.parse(m[1]) as Record<string, unknown>)
    .reduce<Record<string, unknown>>((acc, one) => Object.assign(acc, one), {});
  const remove = [...rendered.matchAll(/-\s*'([a-zA-Z_]+)'/g)].map((m) => m[1]);
  return { merge, remove };
}

/** The handler passes drizzle SQL nodes; the mock reads the ids and statuses
 *  the route bound into them and re-applies them as a predicate. */
function predicateOf(predicate: unknown): (r: CommandRow) => boolean {
  const rendered = render(predicate);
  const ids = [...rendered.matchAll(/"([0-9a-f-]{36})"/g)].map((m) => m[1]);
  const statuses = [...rendered.matchAll(/"(queued|running|succeeded|failed|dead_lettered)"/g)].map(
    (m) => m[1],
  );
  // The jsonb markers the inbox's own SQL tests for. They are string chunks
  // rather than bound parameters, so they are matched on the rendered text.
  const wantsForwarded = rendered.includes("->>'status' = 'forwarded'");
  const excludesStopPaused = rendered.includes("->>'stop_paused', '') <> 'true'");
  const wantsStopPaused = rendered.includes("->>'stop_paused', '') = 'true'");
  const wantsHeld = rendered.includes("->>'held', '') = 'true'");
  return (r) => {
    if (ids.length > 0) {
      const wanted = new Set(ids);
      if (!wanted.has(r.commandId) && !wanted.has(r.sessionId ?? '')) return false;
      if (wanted.has(r.commandId) === false && wanted.has(r.sessionId ?? '') === false) return false;
      // Both a session scope and a command scope may be present; every bound id
      // must match one of the row's own ids.
      for (const id of wanted) {
        if (id !== r.commandId && id !== r.sessionId) return false;
      }
    }
    if (wantsHeld && r.result?.held !== true) return false;
    if (wantsStopPaused && r.result?.stop_paused !== true) return false;
    if (excludesStopPaused && r.result?.stop_paused === true) return false;
    const forwarded = r.result?.status === 'forwarded';
    if (statuses.length > 0) {
      const wanted = new Set(statuses);
      // `listInboxPrompts`: NOT succeeded, OR forwarded. The forwarded arm is
      // what keeps a prompt OpenCode already holds on the user's screen.
      if (rendered.includes('<>')) {
        return !wanted.has(r.status) || (wantsForwarded && forwarded);
      }
      return wanted.has(r.status) && (!wantsForwarded || forwarded);
    }
    return !wantsForwarded || forwarded;
  };
}

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
  return '';
}

mock.module('../../shared/db', () => ({ db: databaseMock, hasDatabase: true }));

let billingCalls = 0;

mock.module('../../billing/services/billing-gate', () => ({
  checkBillingActive: async () => {
    billingCalls += 1;
    return billingOk
      ? { ok: true }
      : {
          ok: false,
          message: 'out of credits',
          reason: 'no_credits',
          balance: 0,
          billingModel: 'credits',
          hasSubscription: false,
          billingState: 'drained',
        };
  },
}));

mock.module('../session-lifecycle', () => ({
  ...realLifecycle,
  enqueueContinueSessionCommand: async (input: Record<string, unknown>) => {
    if (enqueueDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, enqueueDelayMs));
    enqueueSettledAtMs = Date.now();
    enqueued.push(input);
    if (enqueueResult) return enqueueResult;
    const created = row({
      payload: {
        text: input.text,
        clientMessageId: input.clientMessageId,
        wireMessageId: input.wireMessageId,
        parts: input.parts,
        overrides: input.overrides,
      },
    });
    commandTable.push(created);
    return { row: created, deduped: false };
  },
  drainSessionLifecycleQueue: async (input: Record<string, unknown>) => {
    drains.push(input);
    return { claimed: 0, succeeded: 0, failed: 0, queued: 0 };
  },
}));

let loadedProject: { row: { accountId: string; projectId: string }; userId: string } | null = null;
let visibleSession: Record<string, unknown> | null = null;
let loadProjectCalls: Array<{ projectId: string; action: string }> = [];
let capabilityCalls: string[] = [];

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
    capabilityCalls.push(action);
  },
  loadVisibleSession: async () => visibleSession,
}));

// The prompt route re-authorizes the AGENT on every send (agents are
// deny-by-default for a project member — see lib/agent-access.ts). That gate
// reads the resource-grant map from Postgres, which this suite mocks away, so
// stub it here exactly as the access layer above is stubbed. Without it the
// handler throws before enqueueing and every assertion below sees an empty
// queue. `agentCalls` keeps the gate observable: it must still RUN.
const agentAccessCalls: Array<{ requested: unknown; sessionAgent: unknown }> = [];
mock.module('../lib/agent-access', () => ({
  resolveAndAuthorizeAgent: async (
    _c: unknown,
    _loaded: unknown,
    _projectId: string,
    requested?: unknown,
    sessionAgent?: unknown,
  ) => {
    agentAccessCalls.push({ requested, sessionAgent });
    return { agentName: 'kortix', accessible: ['kortix'], memberTier: false };
  },
  // Declared even though this suite never calls it: `warm-sessions.ts` imports
  // it, and that module is pulled in with the rest of the app. A `mock.module`
  // REPLACES the module, so any exported name an importer expects and the stub
  // omits fails the whole isolate with
  // `SyntaxError: Export named '…' not found`.
  canUseAnyAgent: async () => true,
}));

// The DELETE cancel arm reads and edits the RUNTIME's transcript. `null` is an
// unresolvable box (the cancel answers `unreachable`); a test that needs the
// cancel to reach a verdict points it at `runtimeFetch` below, whose message
// list the cancel's own DELETEs mutate.
let opencodeEndpoint: { endpoint: { url: string; headers: Record<string, string> }; opencodeSessionId: string } | null =
  null;
/** Runs once, inside the cancel's endpoint lookup — after it read the row
 *  forwarded, before it reaches a verdict. */
let onResolveEndpoint: (() => void) | null = null;
mock.module('../session-lifecycle/engine', () => ({
  ...realEngine,
  resolveSessionOpencodeEndpoint: async () => {
    const hook = onResolveEndpoint;
    onResolveEndpoint = null;
    hook?.();
    return opencodeEndpoint;
  },
}));

type RuntimeMessage = {
  info: { id: string; role: string; parentID?: string };
  parts: Array<{ id: string }>;
};
let runtimeMessages: RuntimeMessage[] = [];
/** Runs inside a runtime message DELETE, before it answers — the seam a test
 *  uses to start a second request at an exact point of the first. */
let onRuntimeMessageDelete: (() => Promise<void>) | null = null;
const realFetch = globalThis.fetch;
const runtimeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = init?.method ?? 'GET';
  if (method === 'GET' && url.pathname.endsWith('/message')) {
    return Response.json(runtimeMessages);
  }
  const whole = url.pathname.match(/\/message\/([^/]+)$/);
  if (method === 'DELETE' && whole) {
    const id = decodeURIComponent(whole[1]);
    const held = runtimeMessages.some((m) => m.info.id === id);
    runtimeMessages = runtimeMessages.filter((m) => m.info.id !== id);
    const hook = onRuntimeMessageDelete;
    onRuntimeMessageDelete = null;
    if (hook) await hook();
    return new Response(null, { status: held ? 200 : 404 });
  }
  return new Response(null, { status: 404 });
}) as typeof fetch;

const { projectsApp } = await import('../lib/app');
await import('./r8');

function app() {
  const application = new Hono<{ Variables: { userId: string; authType: string } }>();
  application.use('*', async (c, next) => {
    c.set('userId', USER_ID);
    c.set('authType', 'pat');
    await next();
  });
  application.route('/v1/projects', projectsApp);
  return application;
}

const base = (sessionId = SESSION_ID) =>
  `/v1/projects/${PROJECT_ID}/sessions/${sessionId}/prompts`;

function post(body: unknown, sessionId = SESSION_ID) {
  return app().request(base(sessionId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const validBody = {
  client_message_id: 'q_1',
  message_id: WIRE_ID,
  parts: [{ type: 'text', text: 'say hi' }],
};

beforeEach(() => {
  billingCalls = 0;
  commandTable = [];
  sessionMetadata = {};
  enqueued = [];
  drains = [];
  enqueueResult = null;
  billingOk = true;
  dbReadDelayMs = 0;
  dbWriteDelayMs = 0;
  writeSettledAtMs = 0;
  onCommandUpdate = null;
  opencodeEndpoint = null;
  onResolveEndpoint = null;
  runtimeMessages = [];
  onRuntimeMessageDelete = null;
  globalThis.fetch = runtimeFetch;
  enqueueDelayMs = 0;
  enqueueSettledAtMs = 0;
  loadProjectCalls = [];
  capabilityCalls = [];
  agentAccessCalls.length = 0;
  loadedProject = { row: { accountId: ACCOUNT_ID, projectId: PROJECT_ID }, userId: USER_ID };
  visibleSession = { row: { sessionId: SESSION_ID, metadata: {} } };
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('POST .../prompts', () => {
  // The route used to run a connector pre-flight here and answer 409
  // CONNECTOR_CONNECTION_REQUIRED / 503 CONNECTOR_REQUIREMENTS_UNRESOLVED. Both
  // are gone: a turn is never refused for an unconnected connector, because
  // that refusal could not be cleared from the product (a `user`-strategy
  // connector had no connect flow, so the card had no button and the composer
  // span on "Thinking"). The connector CALL denies and carries a connect link.
  //
  // This test is the guard on that: no connector state may hold a prompt.
  test('queues the prompt even when the project has an unconnected connector', async () => {
    const response = await post(validBody);
    expect(response.status).toBe(202);
    expect(enqueued).toHaveLength(1);
  });
  test('queues the prompt and answers 202 with the row it created', async () => {
    const response = await post(validBody);
    expect(response.status).toBe(202);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      prompt_id: PROMPT_ID,
      state: 'queued',
      message_id: WIRE_ID,
      deduped: false,
      observed_at: expect.any(String),
    });
  });

  test('carries the client-minted wire id, the parts and the overrides into the payload', async () => {
    await post({
      ...validBody,
      overrides: { agent: 'build', model: { providerID: 'p', modelID: 'm' }, directory: '/workspace' },
    });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].wireMessageId).toBe(WIRE_ID);
    expect(enqueued[0].clientMessageId).toBe('q_1');
    expect(enqueued[0].parts).toEqual([{ type: 'text', text: 'say hi' }]);
    expect(enqueued[0].overrides).toEqual({
      agent: 'build',
      model: { providerID: 'p', modelID: 'm' },
      variant: null,
      directory: '/workspace',
    });
    // The legacy text field still carries the flattened prompt: the title
    // generator and every pre-inbox reader read it.
    expect(enqueued[0].text).toBe('say hi');
  });

  // A producer that KNOWS its client-minted id is stale asks for the re-mint.
  // The localStorage migration is the case that needs it: the id it mints is
  // minted at page load, against a transcript this tab may not have read yet,
  // for a message the user typed before the last reload. The server re-mints
  // against the live root before delivering, which is the only place that can
  // be right — see `remintWireMessageId`.
  test('persists explicit placement and rejects unsupported locations', async () => {
    for (const placement of ['transcript', 'composer']) {
      expect((await post({ ...validBody, placement })).status).toBe(202);
      expect(enqueued.at(-1)?.placement).toBe(placement);
    }
    expect((await post({ ...validBody, placement: 'sidebar' })).status).toBe(400);
  });

  test('remint_on_delivery is carried into the payload', async () => {
    await post({ ...validBody, remint_on_delivery: true });
    expect(enqueued[0].remintOnDelivery).toBe(true);
  });

  test('remint_on_delivery is absent by default, so an ordinary send keeps its id', async () => {
    await post(validBody);
    expect(enqueued[0].remintOnDelivery).toBeUndefined();
  });

  test('the idempotency key is the submission name, so a repeat POST is one row', async () => {
    await post(validBody);
    expect(enqueued[0].idempotencyKey).toBe(`prompt:${SESSION_ID}:q_1`);

    enqueueResult = { deduped: true, row: row({ status: 'running', result: { delivery_started_at: new Date().toISOString() } }) };
    const repeat = await post(validBody);
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toEqual({
      prompt_id: PROMPT_ID,
      state: 'delivering',
      message_id: WIRE_ID,
      deduped: true,
      observed_at: expect.any(String),
    });
  });

  /**
   * The queue's freshness protocol (JAY-728): every server answer about the
   * inbox carries `observed_at` from the SERVER clock — after the write here,
   * before the read on GET — so a client ranks snapshots on one clock and a
   * read issued before this POST can never erase the row it confirmed.
   */
  test('stamps observed_at AFTER the write, on the server clock', async () => {
    enqueueDelayMs = 50;
    const response = await post(validBody);
    const body = (await response.json()) as Record<string, unknown>;
    const observed = Date.parse(String(body.observed_at));
    expect(Number.isFinite(observed)).toBe(true);
    // A stamp taken at handler entry would predate the (slow) write's settle
    // instant; the contract is the write's place on the server clock.
    expect(observed).toBeGreaterThanOrEqual(enqueueSettledAtMs);
  });

  test('kicks a targeted drain for the row it just enqueued', async () => {
    await post(validBody);
    expect(drains).toEqual([{ idempotencyKey: `prompt:${SESSION_ID}:q_1` }]);
  });

  test('re-authorizes the agent on EVERY send, not just at session create', async () => {
    // A prompt can switch agent mid-session via `overrides.agent`. Gating only
    // at create would let a member send their first message as the agent they
    // hold and every one after it as any other agent in the manifest.
    visibleSession = { row: { sessionId: SESSION_ID, metadata: {}, agentName: 'kortix' } };
    await post(validBody);
    expect(agentAccessCalls).toEqual([{ requested: null, sessionAgent: 'kortix' }]);

    agentAccessCalls.length = 0;
    await post({ ...validBody, overrides: { agent: 'other-agent' } });
    // The REQUESTED agent is what gets checked; the session's own agent is only
    // the fallback for a send that names none.
    expect(agentAccessCalls).toEqual([{ requested: 'other-agent', sessionAgent: 'kortix' }]);
  });

  test('rejects a message id OpenCode cannot order', async () => {
    // A badly-shaped id sorts below the transcript and OpenCode reads the
    // prompt as already answered — the turn silently never runs.
    for (const messageId of ['msg_TOOSHORT', 'cm_12', `${WIRE_ID}extra`, 'msg_ZZZZZZZZZZZZAbCdEfGhIjKlMn']) {
      const response = await post({ ...validBody, message_id: messageId });
      expect(response.status).toBe(400);
    }
    expect(enqueued).toEqual([]);
  });

  test('rejects an empty part list and a missing client id', async () => {
    expect((await post({ ...validBody, parts: [] })).status).toBe(400);
    expect((await post({ ...validBody, client_message_id: '' })).status).toBe(400);
    expect(enqueued).toEqual([]);
  });

  test('404s a session that is not visible, before enqueueing anything', async () => {
    visibleSession = null;
    expect((await post(validBody)).status).toBe(404);
    expect(enqueued).toEqual([]);
  });

  test('402s when the account cannot spend', async () => {
    billingOk = false;
    const response = await post(validBody);
    expect(response.status).toBe(402);
    expect(enqueued).toEqual([]);
  });

  test('409s a session the user deleted', async () => {
    visibleSession = { row: { sessionId: SESSION_ID, metadata: { deletedAt: '2026-08-17T00:00:00Z' } } };
    const response = await post(validBody);
    expect(response.status).toBe(409);
    expect(enqueued).toEqual([]);
  });

  test('400s a non-UUID session id before any load', async () => {
    expect((await post(validBody, 'not-a-uuid')).status).toBe(400);
    expect(loadProjectCalls).toEqual([]);
  });

  // Guard: passes before `restore` existed. A new send is the documented way
  // out of a Stop hold, and `restore` must not change that for every other POST.
  test('a plain send releases the session hold', async () => {
    const other = '77777777-7777-4777-8777-777777777777';
    commandTable = [row({ commandId: other, result: { held: true } })];
    const response = await post(validBody);
    expect(response.status).toBe(202);
    expect(commandTable.find((r) => r.commandId === other)?.result.held).toBeUndefined();
  });

  // Guard: `held` means something only on a restore.
  test('`held` without `restore` is ignored — the send still releases the hold and is due', async () => {
    const other = '77777777-7777-4777-8777-777777777777';
    commandTable = [row({ commandId: other, result: { held: true } })];
    await post({ ...validBody, held: true });
    expect(commandTable.find((r) => r.commandId === other)?.result.held).toBeUndefined();
    expect(commandTable.find((r) => r.commandId === PROMPT_ID)?.result.held).toBeUndefined();
    expect(drains).toEqual([{ idempotencyKey: `prompt:${SESSION_ID}:q_1` }]);
  });

  /**
   * Undo of a removed row. The row was deleted, so the undo is a fresh POST
   * under the same client id — and a fresh POST released the whole session's
   * Stop hold, so Stop → remove → Undo resumed the queue. A restore puts back
   * ONE row with the held bit it was removed with, and touches nothing else.
   */
  test('restore of a HELD row re-creates it held, with no other held row to inherit from', async () => {
    const sibling = '77777777-7777-4777-8777-777777777777';
    commandTable = [row({ commandId: sibling, result: {} })];
    const before = Date.now();
    const response = await post({ ...validBody, restore: true, held: true });
    expect(response.status).toBe(202);
    const restored = commandTable.find((r) => r.commandId === PROMPT_ID);
    // The same markers the Stop hold writes on a queued row.
    expect(restored?.result.held).toBe(true);
    expect(restored?.payload.remintOnDelivery).toBe(true);
    expect(restored?.availableAt.getTime()).toBeGreaterThan(before + 60_000);
    // Born not due: the enqueue itself carries the hold horizon, so no drain
    // can claim the row before the held marker lands.
    expect((enqueued[0].availableAt as Date).getTime()).toBeGreaterThan(before + 60_000);
    // Scoped to the restored row: the sibling is neither held nor moved.
    expect(commandTable.find((r) => r.commandId === sibling)?.result).toEqual({});
    // A held row is not due, so nothing is kicked.
    expect(drains).toEqual([]);
  });

  test('a held restore answers the state its hold wrote, stamped after that write', async () => {
    // The response is the client's first read of the restored row. Stamped
    // before the hold, it would name the row `queued` at an instant a list
    // read could already show it held.
    dbWriteDelayMs = 20;
    const response = await post({ ...validBody, restore: true, held: true });
    expect(response.status).toBe(202);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.state).toBe('waiting');
    expect(writeSettledAtMs).toBeGreaterThan(0);
    expect(Date.parse(String(body.observed_at))).toBeGreaterThanOrEqual(writeSettledAtMs);
  });

  test('restore of an unheld row leaves the rest of a held queue held, and is due now', async () => {
    const other = '77777777-7777-4777-8777-777777777777';
    commandTable = [row({ commandId: other, result: { held: true } })];
    const response = await post({ ...validBody, restore: true, held: false });
    expect(response.status).toBe(202);
    expect(commandTable.find((r) => r.commandId === other)?.result.held).toBe(true);
    const restored = commandTable.find((r) => r.commandId === PROMPT_ID);
    expect(restored?.result.held).toBeUndefined();
    expect(enqueued[0].availableAt).toBeUndefined();
    expect(drains).toEqual([{ idempotencyKey: `prompt:${SESSION_ID}:q_1` }]);
  });

  /**
   * A held restore is two statements: the insert at the hold horizon, then the
   * held marker. When the marker failed, the row stayed neither held (a release
   * does not free it) nor due (nothing delivers it), and every later prompt of
   * the session waited behind it as `older_prompt_pending`. A retried undo
   * deduped onto that row before the hold branch, so it never healed.
   */
  test('a held restore whose hold write fails takes its row back out, so a retried undo re-creates it held', async () => {
    onCommandUpdate = () => {
      throw new Error('hold write failed');
    };
    const failed = await post({ ...validBody, restore: true, held: true });
    expect(failed.status).toBe(500);
    expect(commandTable.filter((r) => r.commandId === PROMPT_ID)).toEqual([]);
    expect(drains).toEqual([]);

    const retried = await post({ ...validBody, restore: true, held: true });
    expect(retried.status).toBe(202);
    const restored = commandTable.filter((r) => r.commandId === PROMPT_ID);
    expect(restored).toHaveLength(1);
    expect(restored[0].result.held).toBe(true);
  });

  // Guard: dedupe answers before either hold decision runs.
  test('a restore that dedupes onto an existing row changes no hold', async () => {
    const other = '77777777-7777-4777-8777-777777777777';
    commandTable = [row({ commandId: other, result: { held: true } })];
    enqueueResult = { deduped: true, row: row({ commandId: other, result: { held: true } }) };
    const response = await post({ ...validBody, restore: true, held: false });
    expect(response.status).toBe(200);
    expect(commandTable.find((r) => r.commandId === other)?.result.held).toBe(true);
    expect(drains).toEqual([]);
  });

  test('restore and held must be booleans', async () => {
    expect((await post({ ...validBody, restore: 'yes' })).status).toBe(400);
    expect((await post({ ...validBody, restore: true, held: 1 })).status).toBe(400);
    expect(enqueued).toEqual([]);
  });
});

describe('GET .../prompts', () => {
  async function list() {
    const response = await app().request(base());
    expect(response.status).toBe(200);
    return (await response.json()) as { prompts: Array<Record<string, unknown>> };
  }

  test('stamps observed_at BEFORE the read — an answer is as fresh as when it was asked', async () => {
    commandTable = [row()];
    dbReadDelayMs = 50;
    const response = await app().request(base());
    const done = Date.now();
    const body = (await response.json()) as Record<string, unknown>;
    const observed = Date.parse(String(body.observed_at));
    expect(Number.isFinite(observed)).toBe(true);
    // The inbox read alone took 50ms; a stamp taken after it settles would sit
    // at `done`. Captured before the read, it sits at least the delay earlier.
    expect(observed).toBeLessThanOrEqual(done - 25);
  });

  test('serves a queued prompt with its wire id and text', async () => {
    commandTable = [row()];
    const body = await list();
    expect(body.prompts).toEqual([
      {
        prompt_id: PROMPT_ID,
        client_message_id: 'q_1',
        message_id: WIRE_ID,
        // The id the client painted under — the same while nothing re-minted.
        wire_message_id: WIRE_ID,
        client_sent_at_ms: null,
        state: 'queued',
        reason: null,
        text: 'say hi',
        full_text: 'say hi',
        placement: 'composer',
        attempts: 0,
        runtime_retries: 0,
        last_error: null,
        // Only a failed row names a cause.
        failure_code: null,
        // A text-only prompt names no files. The list is always present so a
        // client never has to distinguish "no attachments" from "old server".
        attachments: [],
        created_at: '2026-08-18T00:00:00.000Z',
        available_at: '2026-08-18T00:00:00.000Z',
      },
    ]);
  });

  test('an admitted delivery reads `delivering`, and an admission-refused claim stays `waiting`', async () => {
    commandTable = [
      row({ commandId: PROMPT_ID, status: 'running', result: { delivery_started_at: new Date().toISOString() } }),
      row({
        commandId: '77777777-7777-4777-8777-777777777777',
        status: 'running',
        result: { admission_reason: 'older_prompt_pending' },
      }),
    ];
    const body = await list();
    expect(body.prompts.map((p) => [p.state, p.reason])).toEqual([
      ['delivering', null],
      ['waiting', 'older_prompt_pending'],
    ]);
  });

  test('a row parked on a DOWN runtime reads `queued`, names the runtime, and counts its retries', async () => {
    // Before: an unreachable box dead-lettered the prompt on its FIRST attempt
    // and the row read `failed` — a manual retry offered for work the server was
    // already going to do. It is queued, because it IS in line.
    commandTable = [
      row({
        status: 'queued',
        result: { delivery_blocked: 'runtime_unreachable', runtime_retries: 2 },
        lastError: 'delivery outcome: unreachable',
      }),
    ];
    const body = await list();
    expect(body.prompts[0].state).toBe('queued');
    expect(body.prompts[0].reason).toBe('runtime_unreachable');
    expect(body.prompts[0].runtime_retries).toBe(2);
  });

  test('an ordinary row reports zero runtime retries', async () => {
    commandTable = [row({ status: 'queued' })];
    const body = await list();
    expect((await list()).prompts[0].runtime_retries).toBe(0);
    expect(body.prompts[0].reason).toBeNull();
  });

  test('a dead-lettered row reads `failed` and carries its error', async () => {
    commandTable = [row({ status: 'dead_lettered', lastError: 'delivery outcome: failed' })];
    const body = await list();
    expect(body.prompts[0].state).toBe('failed');
    expect(body.prompts[0].last_error).toBe('the session refused it');
  });

  test('a failed row names its cause by the code its producer persisted; a live row names none', async () => {
    commandTable = [
      row({
        status: 'dead_lettered',
        lastError: 'Create the required connections before continuing this session.',
        result: { failure_code: 'connector_required' },
      }),
      row({
        commandId: '77777777-7777-4777-8777-777777777777',
        status: 'dead_lettered',
        lastError: 'delivery outcome: failed',
      }),
      row({ commandId: '88888888-8888-4888-8888-888888888888', status: 'queued' }),
    ];
    const body = await list();
    expect(body.prompts.map((p) => [p.state, p.failure_code])).toEqual([
      ['failed', 'connector_required'],
      // Written before codes were persisted.
      ['failed', 'unknown'],
      ['queued', null],
    ]);
  });

  test('a FORWARDED row is still listed, as `delivering`', async () => {
    // `succeeded` normally means "gone from the inbox — it IS the transcript".
    // A forwarded row is the exception: OpenCode has the message and has not
    // run it yet, so dropping it here is what left the composer with nothing
    // between the send and the turn.
    commandTable = [
      row({
        status: 'succeeded',
        result: { status: 'forwarded', forwarded_message_id: WIRE_ID },
      }),
    ];
    const body = await list();
    expect(body.prompts).toHaveLength(1);
    expect([body.prompts[0].state, body.prompts[0].reason]).toEqual(['delivering', 'forwarded']);
  });

  test('a CONFIRMED row disappears — the ledger said a turn consumed it', async () => {
    commandTable = [row({ status: 'succeeded', result: { status: 'delivered' } })];
    expect((await list()).prompts).toEqual([]);
  });

  test('a STOP-PAUSED forwarded row reads `waiting`, held on the user', async () => {
    // Stop paused it; only the user's next send or "send now" releases it.
    commandTable = [
      row({
        status: 'succeeded',
        result: { status: 'forwarded', stop_paused: true, held: true },
      }),
    ];
    const body = await list();
    expect([body.prompts[0].state, body.prompts[0].reason]).toEqual(['waiting', 'held']);
  });

  test('a row that was GIVEN UP ON reads `failed`, whatever markers it carries', async () => {
    // `deadLetter` (redelivery.ts) gives up on a row that is still marked
    // forwarded. Reading the marker first made that row read `delivering` for
    // ever: filtered out of the strip, counted as live work, and outside the
    // sweep's scan — no retry, no remove, nothing that could close it.
    commandTable = [
      row({
        status: 'dead_lettered',
        lastError: 'prompt redelivery exhausted after abandoned',
        result: { status: 'forwarded', forwarded_message_id: WIRE_ID },
      }),
    ];
    const body = await list();
    expect(body.prompts[0].state).toBe('failed');
  });

  test('reads through the read tier and the session-read leaf', async () => {
    await list();
    expect(loadProjectCalls).toEqual([{ projectId: PROJECT_ID, action: 'read' }]);
    expect(capabilityCalls).toEqual(['project.session.read']);
  });
});

describe('DELETE .../prompts/:promptId', () => {
  function remove(promptId = PROMPT_ID) {
    return app().request(`${base()}/${promptId}`, { method: 'DELETE' });
  }

  test('removes a queued prompt AND hands back everything needed to undo it', async () => {
    // The row is hard-deleted and the UI offers an undo, so this response is
    // the only place the full body still exists. `GET /prompts`'s `text` is a
    // 2000-char preview with no parts, so undoing from THAT silently drops
    // attachments, model overrides and anything past the truncation.
    commandTable = [
      row({
        payload: {
          text: 'say hi',
          clientMessageId: 'q_1',
          wireMessageId: WIRE_ID,
          parts: [
            { type: 'text', text: 'say hi' },
            { type: 'file', mime: 'image/png', url: 'https://files.test/a.png' },
          ],
          overrides: { model: { providerID: 'anthropic', modelID: 'claude-x' } },
        },
      }),
    ];
    const response = await remove();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      removed: {
        placement: 'composer',
        prompt_id: PROMPT_ID,
        removed_message_ids: [WIRE_ID],
        client_message_id: 'q_1',
        message_id: WIRE_ID,
        parts: [
          { type: 'text', text: 'say hi' },
          { type: 'file', mime: 'image/png', url: 'https://files.test/a.png' },
        ],
        overrides: { model: { providerID: 'anthropic', modelID: 'claude-x' } },
        held: false,
      },
    });
    expect(commandTable).toEqual([]);
  });

  test('the removed prompt says whether it was HELD, so an undo can put it back held', async () => {
    commandTable = [row({ result: { held: true } })];
    const response = await remove();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { removed: Record<string, unknown> };
    expect(body.removed.held).toBe(true);
  });

  test('refuses to remove a prompt that is already on the wire', async () => {
    // Cancelling a running delivery is not possible without lying about it.
    commandTable = [row({ status: 'running' })];
    const response = await remove();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Prompt is being delivered and the runtime could not be reached to cancel it',
      code: 'prompt_cancel_unreachable',
    });
    expect(commandTable).toHaveLength(1);
  });

  test('a prompt the drain already sent or skipped is 409 already sent, not 404', async () => {
    // The row EXISTS, closed by the drain. "Not found" told the user the
    // prompt was gone when it had in fact been sent.
    for (const result of [
      { status: 'skipped', reason: 'consumed_in_band' },
      { status: 'skipped', reason: 'already_answered' },
      {},
    ]) {
      commandTable = [row({ status: 'succeeded', result })];
      const response = await remove();
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: 'Prompt was already sent',
        code: 'prompt_already_sent',
      });
      expect(commandTable).toHaveLength(1);
    }
  });

  test('a forwarded prompt the runtime already answered is 409 already sent', async () => {
    opencodeEndpoint = { endpoint: { url: 'http://box.test', headers: {} }, opencodeSessionId: 'ses_1' };
    runtimeMessages = [
      { info: { id: WIRE_ID, role: 'user' }, parts: [{ id: 'prt_1' }] },
      { info: { id: 'msg_0198f3a1b2d0AbCdEfGhIjKlMn', role: 'assistant', parentID: WIRE_ID }, parts: [] },
    ];
    commandTable = [
      row({ status: 'succeeded', result: { status: 'forwarded', forwarded_message_id: WIRE_ID } }),
    ];
    const response = await remove();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Prompt is already being answered',
      code: 'prompt_already_sent',
    });
    expect(commandTable).toHaveLength(1);
  });

  test('a running prompt that disappears while the cancel watches it is 404, not a 409', async () => {
    // Another tab removed it, or the drain requeued and a second DELETE took
    // it, while this request polled for the delivery to settle.
    commandTable = [row({ status: 'running' })];
    setTimeout(() => {
      commandTable = [];
    }, 50);
    const response = await remove();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found', code: 'prompt_not_found' });
  });

  test('a running prompt the drain closes as skipped while the cancel watches is 409 already sent', async () => {
    commandTable = [row({ status: 'running' })];
    setTimeout(() => {
      commandTable[0].status = 'succeeded';
      commandTable[0].result = { status: 'skipped', reason: 'already_answered' };
    }, 50);
    const response = await remove();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Prompt was already sent',
      code: 'prompt_already_sent',
    });
  });

  describe('two DELETEs of one delivering prompt', () => {
    const forwarded = () =>
      row({ status: 'succeeded', result: { status: 'forwarded', forwarded_message_id: WIRE_ID } });

    type Outcome = { status: number; body: Record<string, unknown> };

    function expectOneRemovalAndOneTruthfulRefusal(outcomes: Outcome[]) {
      expect(outcomes).toHaveLength(2);
      expect(outcomes.filter((o) => o.status === 200)).toHaveLength(1);
      const loser = outcomes.find((o) => o.status !== 200);
      // Never "the runtime could not be reached", and never "being answered":
      // the other request reached the runtime and removed the prompt. These
      // tips hold no assistant message, so no step read it. The loser's own
      // view (`answered` from an empty guarded delete, or a poll that found no
      // row) is stale, and the row it re-reads is gone.
      expect(loser).toEqual({ status: 404, body: { error: 'Not found', code: 'prompt_not_found' } });
      expect(commandTable).toEqual([]);
    }

    const read = async (pending: Response | Promise<Response>): Promise<Outcome> => {
      const response = await pending;
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };

    test('in lockstep: one removes it, the other answers without a false refusal', async () => {
      opencodeEndpoint = { endpoint: { url: 'http://box.test', headers: {} }, opencodeSessionId: 'ses_1' };
      runtimeMessages = [{ info: { id: WIRE_ID, role: 'user' }, parts: [{ id: 'prt_1' }] }];
      commandTable = [forwarded()];
      const outcomes = await Promise.all([read(remove()), read(remove())]);
      expectOneRemovalAndOneTruthfulRefusal(outcomes);
    });

    test('the second request runs to completion inside the first one’s runtime delete', async () => {
      // The first request has taken the runtime copy out and not yet deleted
      // its row; the second finds no runtime copy, deletes the row, and wins.
      // The first then finds nothing to delete.
      opencodeEndpoint = { endpoint: { url: 'http://box.test', headers: {} }, opencodeSessionId: 'ses_1' };
      runtimeMessages = [{ info: { id: WIRE_ID, role: 'user' }, parts: [{ id: 'prt_1' }] }];
      commandTable = [forwarded()];
      const outcomes: Outcome[] = [];
      onRuntimeMessageDelete = async () => {
        outcomes.push(await read(remove()));
      };
      outcomes.push(await read(remove()));
      expectOneRemovalAndOneTruthfulRefusal(outcomes);
    });
  });

  /**
   * The reaper hands a forwarded prompt back to the queue while the cancel
   * acts on it. A queued row is the plain delete's to remove, so neither
   * "could not be reached" nor "being answered" is true of it.
   */
  describe('a prompt that falls back into line while the cancel acts on it', () => {
    const forwarded = () =>
      row({ status: 'succeeded', result: { status: 'forwarded', forwarded_message_id: WIRE_ID } });
    const requeue = () => {
      commandTable[0].status = 'queued';
      commandTable[0].result = {};
    };

    async function expectRemoved(response: Response) {
      expect(response.status).toBe(200);
      const body = (await response.json()) as { removed: Record<string, unknown> };
      expect(body.removed.prompt_id).toBe(PROMPT_ID);
      expect(commandTable).toEqual([]);
    }

    // Guard: the cancel's `not_forwarded` exit removed this row before the arm
    // settled every exit through one delete.
    test('while the cancel watches its delivery, it is removed', async () => {
      commandTable = [row({ status: 'running' })];
      setTimeout(() => {
        commandTable[0].status = 'queued';
      }, 50);
      await expectRemoved(await remove());
    });

    test('after the runtime could not be reached, it is removed', async () => {
      commandTable = [forwarded()];
      // No endpoint: the cancel answers `unreachable`.
      onResolveEndpoint = requeue;
      await expectRemoved(await remove());
    });

    test('after its runtime copy was taken out, it is removed', async () => {
      opencodeEndpoint = { endpoint: { url: 'http://box.test', headers: {} }, opencodeSessionId: 'ses_1' };
      runtimeMessages = [{ info: { id: WIRE_ID, role: 'user' }, parts: [{ id: 'prt_1' }] }];
      commandTable = [forwarded()];
      // The cancel's guarded delete then finds no `succeeded` row: `answered`.
      onRuntimeMessageDelete = async () => requeue();
      await expectRemoved(await remove());
    });
  });

  test('refuses to remove a prompt OpenCode already has', async () => {
    // A forwarded row is `succeeded`, so the delete's status filter never
    // matches it — but "no row was removed" here is 409, not 404: OpenCode has
    // persisted that user message and is going to answer it.
    commandTable = [
      row({ status: 'succeeded', result: { status: 'forwarded', forwarded_message_id: WIRE_ID } }),
    ];
    const response = await remove();
    expect(response.status).toBe(409);
    expect(commandTable).toHaveLength(1);
  });

  test('removes a STOP-PAUSED row — the user stopped it, so it is theirs to drop', async () => {
    // It renders as a held queue row with a remove button. Answering 409 there
    // is a control that cannot work: nothing is going to deliver the row, and
    // removing it is the only way it leaves the screen.
    commandTable = [
      row({ status: 'succeeded', result: { status: 'forwarded', stop_paused: true, held: true } }),
    ];
    const response = await remove();
    expect(response.status).toBe(200);
    expect(commandTable).toHaveLength(0);
    const body = (await response.json()) as { removed: Record<string, unknown> };
    expect(body.removed.held).toBe(true);
  });

  test('404s a prompt id this session does not own', async () => {
    commandTable = [];
    const response = await remove();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found', code: 'prompt_not_found' });
  });

  test('a wire message id no inbox row carries is 404 not found', async () => {
    // The bubble's handle once the row left the list. No row under it is the
    // same outcome as no row under a prompt id.
    commandTable = [];
    const response = await remove(WIRE_ID);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found', code: 'prompt_not_found' });
  });

  // Guard: a session the caller cannot see is not a prompt outcome.
  test('a session that is not visible keeps its plain 404, with no prompt code', async () => {
    visibleSession = null;
    commandTable = [row()];
    const response = await remove();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
  });
});

describe('POST .../prompts/:promptId/retry', () => {
  function retry(promptId = PROMPT_ID) {
    return app().request(`${base()}/${promptId}/retry`, { method: 'POST' });
  }

  test('puts a failed prompt back with a clean slate, its recorded wire id kept and placed again on delivery', async () => {
    // The ROW keeps the id the client painted under (`payload.wireMessageId`,
    // the undo and bubble handle). The DELIVERY does not promise it:
    // `remintOnDelivery` makes the drain re-read the transcript, drop the
    // prompt if a reply already answers it, and otherwise place the id again.
    commandTable = [
      row({
        status: 'dead_lettered',
        attempts: 5,
        lastError: 'delivery outcome: failed',
        result: { admission_reason: 'older_prompt_pending' },
      }),
    ];
    const response = await retry();
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.state).toBe('queued');
    expect(body.message_id).toBe(WIRE_ID);
    expect(body.reason).toBeNull();
    expect(commandTable[0].status).toBe('queued');
    expect(commandTable[0].attempts).toBe(0);
    expect(commandTable[0].lastError).toBeNull();
    // The DISPLAY marker is cleared — the row is no longer "waiting" — but the
    // DURABLE one survives in the payload. Clearing both is what sent a
    // promoted prompt under the id the client minted before the turn it waited
    // out: OpenCode orders by id and reads a lower one as already answered.
    expect(commandTable[0].result).toEqual({ promoted: true });
    expect(commandTable[0].payload.remintOnDelivery).toBe(true);
    expect(commandTable[0].payload.wireMessageId).toBe(WIRE_ID);
    expect(drains).toEqual([{ idempotencyKey: `prompt:${SESSION_ID}:q_1` }]);
  });

  test('clears the persisted failure code with the error, so the re-queued row names no cause', async () => {
    commandTable = [
      row({
        status: 'dead_lettered',
        attempts: 1,
        lastError: 'Out of credits. Top up to continue.',
        result: { failure_code: 'out_of_credits' },
      }),
    ];
    const response = await retry();
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect([body.state, body.last_error, body.failure_code]).toEqual(['queued', null, null]);
    expect(commandTable[0].lastError).toBeNull();
    expect(commandTable[0].result).not.toHaveProperty('failure_code');
  });

  test('stamps observed_at AFTER the write, on the server clock', async () => {
    // Same convention as POST .../prompts: a list read issued before the retry
    // carries an older stamp, so it cannot repaint the row `failed`.
    commandTable = [row({ status: 'dead_lettered', lastError: 'delivery outcome: failed' })];
    dbWriteDelayMs = 20;
    const response = await retry();
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    const observed = Date.parse(String(body.observed_at));
    expect(Number.isFinite(observed)).toBe(true);
    expect(writeSettledAtMs).toBeGreaterThan(0);
    expect(observed).toBeGreaterThanOrEqual(writeSettledAtMs);
    // The row body is unchanged beside the stamp.
    expect(body.prompt_id).toBe(PROMPT_ID);
    expect(body.state).toBe('queued');
  });

  test('a prompt that is not there is 404 not found', async () => {
    commandTable = [];
    const response = await retry();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found', code: 'prompt_not_found' });
  });

  test('a prompt that is already on the wire is 409 already sent, not 404', async () => {
    commandTable = [row({ status: 'running' })];
    const response = await retry();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Prompt was already sent',
      code: 'prompt_already_sent',
    });
  });

  test('a prompt a failed claim puts back in line during the retry is re-queued, not refused as sent', async () => {
    // The retry's update finds the row claimed. Before the route reads why,
    // the claim fails and puts the row back in line. It never went out, so
    // "already sent" is false, and the row is retryable.
    commandTable = [row({ status: 'running' })];
    onCommandUpdate = () => {
      commandTable[0].status = 'failed';
      commandTable[0].lastError = 'delivery outcome: failed';
    };
    const response = await retry();
    expect(response.status).toBe(200);
    expect(((await response.json()) as Record<string, unknown>).prompt_id).toBe(PROMPT_ID);
    expect(commandTable[0].status).toBe('queued');
    expect(commandTable[0].result).toEqual({ promoted: true });
  });

  test('a prompt the drain already closed is 409 already sent', async () => {
    commandTable = [row({ status: 'succeeded', result: { status: 'skipped', reason: 'consumed_in_band' } })];
    const response = await retry();
    expect(response.status).toBe(409);
    expect(((await response.json()) as Record<string, unknown>).code).toBe('prompt_already_sent');
  });

  test('refuses a FORWARDED row — re-sending it would post the message twice', async () => {
    // OpenCode already holds this user message. "Send now" on it would deliver
    // a second copy under a re-minted id, not hurry the first one along.
    commandTable = [
      row({ status: 'succeeded', result: { status: 'forwarded', forwarded_message_id: WIRE_ID } }),
    ];
    const response = await retry();
    expect(response.status).toBe(409);
    expect(((await response.json()) as Record<string, unknown>).code).toBe('prompt_already_sent');
    expect(commandTable[0].status).toBe('succeeded');
  });

  // Guard: a session the caller cannot see is not a prompt outcome.
  test('a session that is not visible keeps its plain 404, with no prompt code', async () => {
    visibleSession = null;
    commandTable = [row({ status: 'failed' })];
    const response = await retry();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
  });

  // Guard: retry is "send now", and send now releases the Stop hold.
  test('retry still releases the session hold', async () => {
    const other = '77777777-7777-4777-8777-777777777777';
    commandTable = [row({ status: 'failed' }), row({ commandId: other, result: { held: true } })];
    expect((await retry()).status).toBe(200);
    expect(commandTable.find((r) => r.commandId === other)?.result.held).toBeUndefined();
  });

  test('"send now" on a STOP-PAUSED row puts that row back on the queue', async () => {
    // The hold's advertised way out, on the row it is rendered on. Refusing it
    // left the user with a paper plane that 404s and a queue that stays held —
    // `handleQueueSendNow` never reaches its release when the retry returns no
    // row.
    commandTable = [
      row({ status: 'succeeded', result: { status: 'forwarded', stop_paused: true, held: true } }),
    ];
    const response = await retry();
    expect(response.status).toBe(200);
    expect(commandTable[0].status).toBe('queued');
    expect(commandTable[0].result).toEqual({ promoted: true });
    expect(commandTable[0].payload.remintOnDelivery).toBe(true);
  });

  test('"send now" on a QUEUED row is the same route, and marks it promoted', async () => {
    // The button that jumps the queue has to address the SERVER row: with the
    // queue in Postgres there is no browser-local list to reorder, and the
    // ordering gate (`older_prompt_pending`) would otherwise run the OLDEST
    // prompt after the user interrupted the turn for a different one.
    // (That the promotion actually passes the ordering gate is proven against
    // real Postgres in `integration-prompt-inbox.test.ts`.)
    commandTable = [row({ status: 'queued', result: { admission_reason: 'older_prompt_pending' } })];
    const response = await retry();
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.state).toBe('queued');
    expect(body.reason).toBeNull();
  });
});

describe('POST .../prompts/hold', () => {
  function hold(body: unknown) {
    return app().request(`${base()}/hold`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  test('holds the session queue and answers with the rows as they now stand', async () => {
    commandTable = [row()];
    const response = await hold({ held: true });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { prompts: Array<Record<string, unknown>> };
    expect(body.prompts).toHaveLength(1);
  });

  test('Stop persists a running delivery as held across reload and Resume clears it', async () => {
    commandTable = [row({ status: 'running' })];
    await hold({ held: true });
    const reloaded = await app().request(base());
    const body = (await reloaded.json()) as { prompts: Array<Record<string, unknown>> };
    expect([body.prompts[0].state, body.prompts[0].reason]).toEqual(['waiting', 'held']);
    await hold({ held: false });
    expect(commandTable[0].result?.held).not.toBe(true);
    expect(commandTable[0].payload.stopPausedOnDelivery).toBeUndefined();
  });

  test('rejects anything but a boolean — a hold is not a guess', async () => {
    commandTable = [row()];
    expect((await hold({})).status).toBe(400);
    expect((await hold({ held: 'yes' })).status).toBe(400);
  });

  test('releasing kicks the drain so the queue moves again', async () => {
    commandTable = [row()];
    drains = [];
    await hold({ held: false });
    expect(drains).toHaveLength(1);
  });

  test('a FORWARDED row is stop-paused by the hold, and re-queued by the release', async () => {
    // The Stop button's two halves for a prompt OpenCode already has: park it
    // (it stays `succeeded`, so nothing re-delivers it while the user is
    // stopped), then put it back on the queue when the user sends anything.
    commandTable = [
      row({ status: 'succeeded', result: { status: 'forwarded', forwarded_message_id: WIRE_ID } }),
    ];
    const heldResponse = await hold({ held: true });
    expect(heldResponse.status).toBe(200);
    expect(commandTable[0].status).toBe('succeeded');
    expect(commandTable[0].result).toMatchObject({ stop_paused: true, held: true });
    const heldBody = (await heldResponse.json()) as { prompts: Array<Record<string, unknown>> };
    expect([heldBody.prompts[0].state, heldBody.prompts[0].reason]).toEqual(['waiting', 'held']);

    await hold({ held: false });
    expect(commandTable[0].status).toBe('queued');
    expect(commandTable[0].result).toEqual({});
  });
});

describe('the prompt wire schema', () => {
  test('documents failure_code as an optional, nullable string on every prompt row', () => {
    const doc = projectsApp.getOpenAPI31Document({
      openapi: '3.1.0',
      info: { title: 'projects', version: 'test' },
    });
    const pick = (value: unknown, ...keys: string[]): unknown =>
      keys.reduce<unknown>(
        (node, key) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined),
        value,
      );
    const row = pick(
      doc,
      'paths', '/{projectId}/sessions/{sessionId}/prompts', 'get', 'responses', '200',
      'content', 'application/json', 'schema', 'properties', 'prompts', 'items',
    );
    // The lookup reaches the row schema: its sibling field is there.
    expect(pick(row, 'properties', 'last_error')).toBeDefined();
    expect(pick(row, 'properties', 'failure_code')).toMatchObject({ type: ['string', 'null'] });
    expect(String(pick(row, 'properties', 'failure_code', 'description'))).toContain('`out_of_credits`');
    expect((pick(row, 'required') as string[] | undefined) ?? []).not.toContain('failure_code');
  });
});
