/**
 * GET /v1/projects/:projectId/sessions/:sessionId/turn — server truth about
 * which turns are running, read from the LIFECYCLE AUTHORITY
 * (`session_sandboxes.metadata.activeTurns`) and decorated from the
 * `kortix.session_turns` ledger.
 *
 * Driven through the real Hono app (not asserted against the source) because
 * every claim here is about a RESPONSE. The database is mocked, but the mock is
 * not a canned-row stub: it holds two tables of COLUMN-KEYED rows and executes
 * each query the way Postgres would — it evaluates the handler's rendered WHERE
 * clause, sorts by the handler's rendered ORDER BY, slices by its LIMIT, and
 * reads each output field from the COLUMN that field was projected onto. So the
 * predicate, the ordering and the projection are all falsifiable here: mutate
 * any of the three in the handler and cases below change answer.
 *
 * The real SQL still runs against real Postgres in
 * `src/__tests__/integration-session-turn-read.test.ts` — this file covers the
 * gates and the response shape in the hermetic default lane.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { sessionSandboxes, sessionTurns } from '@kortix/db';
import { Hono } from 'hono';
import * as realAccess from '../lib/access';

const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const ACCOUNT_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '55555555-5555-4555-8555-555555555555';

/** One `session_sandboxes.metadata.activeTurns` entry, exactly as
 *  `beginSandboxTurn` and `initialSandboxTurnMetadata` write it. */
function authorityTurn(overrides: {
  token: string;
  state?: 'delivering' | 'active';
  opencodeSessionId?: string | null;
  messageId?: string | null;
  startedAtMs?: number | null;
}) {
  return {
    token: overrides.token,
    state: overrides.state ?? 'active',
    opencodeSessionId: overrides.opencodeSessionId ?? null,
    messageId: overrides.messageId ?? null,
    ...(overrides.startedAtMs === null
      ? {}
      : { startedAtMs: overrides.startedAtMs ?? 1_755_000_000_000 }),
  };
}

/** A `kortix.session_turns` row, keyed by COLUMN name — the mock projects each
 *  selected field out of these by the column the handler bound it to, so a
 *  projection that names the wrong column returns the wrong value here. */
function ledgerRow(overrides: {
  turn_token: string;
  state?: 'delivering' | 'active' | 'ended';
  message_id?: string | null;
  opencode_session_id?: string | null;
  started_at?: Date;
  accepted_at?: Date | null;
  end_reason?: string | null;
  ended_at?: Date | null;
}): Record<string, unknown> {
  return {
    session_id: SESSION_ID,
    state: 'active',
    message_id: null,
    opencode_session_id: null,
    started_at: new Date('2026-08-17T00:00:00.000Z'),
    accepted_at: null,
    end_reason: null,
    ended_at: null,
    ...overrides,
  };
}

/** Render a drizzle SQL node to a stable string — `col:<name>` for columns,
 *  `$<json>` for bound parameters. Both the WHERE evaluator and the ORDER BY
 *  comparator below read THIS, so they follow the handler rather than restate
 *  it. */
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

/**
 * Evaluate the handler's rendered WHERE against one column-keyed row. Handles
 * exactly the operators drizzle renders for this route (`=`, `<>`, `in`, joined
 * by `and`) and THROWS on anything else, so a predicate this mock cannot
 * honestly execute fails the test instead of silently matching everything.
 */
function matches(where: string, row: Record<string, unknown>): boolean {
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

/** Sort by the handler's rendered ORDER BY, not by a canned comparator: change
 *  `desc(endedAt)` to `asc(endedAt)` in the route and this comparator flips
 *  with it, so the ordering cases below fail on the behavior. */
function compare(orderBy: string[], a: Record<string, unknown>, b: Record<string, unknown>) {
  for (const term of orderBy) {
    const parsed = /^col:(\w+)( desc| asc)?$/.exec(term);
    if (!parsed) throw new Error(`mock cannot evaluate the ordering: ${term}`);
    const [left, right] = [a[parsed[1]], b[parsed[1]]];
    const rank = (value: unknown) => (value instanceof Date ? value.getTime() : null);
    const [l, r] = [rank(left), rank(right)];
    if (l === r) continue;
    // Postgres sorts NULL as GREATER than every non-null value, so its default
    // is NULLS FIRST on DESC and NULLS LAST on ASC — verified against real
    // Postgres: `select v from (values (1,'2026-01-01'::timestamptz),
    // (2,null::timestamptz)) t(v,e) order by e desc` returns row 2 first.
    // Ranking NULL LAST on DESC instead is what let a mutant that drops the
    // `state = 'ended'` filter off the terminal read survive this lane: the
    // still-open row it wrongly returns carries `ended_at = NULL`.
    const key = (value: number | null) => value ?? Number.POSITIVE_INFINITY;
    if (parsed[2] === ' desc') return key(r) - key(l);
    return key(l) - key(r);
  }
  return 0;
}

type RecordedQuery = { table: 'sandboxes' | 'turns'; where: string; orderBy: string[] };

let sandboxTable: Array<Record<string, unknown>> = [];
let turnTable: Array<Record<string, unknown>> = [];
/** Every `select()` the handler issued, in order. Lets a test assert that NO
 *  query ran, and inspect each predicate and ordering. */
let queries: RecordedQuery[] = [];

function execute(
  projection: Record<string, unknown>,
  table: unknown,
  predicate: unknown,
  orderBy: unknown[],
  limit: number | null,
) {
  const which = table === sessionSandboxes ? 'sandboxes' : table === sessionTurns ? 'turns' : null;
  if (!which) throw new Error('query reads a table this route has no business reading');

  const where = render(predicate);
  // Scope first: a query that does not bind THIS session's id is not reading
  // this session's state, whatever else it gets right.
  if (!where.includes(`col:session_id = $${JSON.stringify(SESSION_ID)}`)) {
    throw new Error(`query is not scoped to the session: ${where}`);
  }
  const order = orderBy.map(render);
  queries.push({ table: which, where, orderBy: order });

  const rows = (which === 'sandboxes' ? sandboxTable : turnTable).filter((row) =>
    matches(where, row),
  );
  if (order.length) rows.sort((a, b) => compare(order, a, b));
  const columns = Object.entries(projection).map(
    ([field, column]) => [field, render(column).replace(/^col:/, '')] as const,
  );
  return (limit === null ? rows : rows.slice(0, limit)).map((row) =>
    Object.fromEntries(columns.map(([field, column]) => [field, row[column]])),
  );
}

/** Drizzle's builder is thenable at every stage: `.where(...)` is awaitable on
 *  its own, and so is `.orderBy(...).limit(n)`. The mock has to be too. */
function stage(
  projection: Record<string, unknown>,
  table: unknown,
  predicate: unknown,
  orderBy: unknown[],
  limit: number | null,
): PromiseLike<Array<Record<string, unknown>>> & {
  orderBy: (...order: unknown[]) => ReturnType<typeof stage>;
  limit: (n: number) => ReturnType<typeof stage>;
} {
  return {
    orderBy: (...order: unknown[]) => stage(projection, table, predicate, order, limit),
    limit: (n: number) => stage(projection, table, predicate, orderBy, n),
    // biome-ignore lint/suspicious/noThenProperty: The Drizzle query mock must be awaitable.
    then: (resolve, reject) => {
      // `execute` throws synchronously when the handler asks something this
      // mock refuses to fake; awaiting must surface that as a rejection.
      try {
        return Promise.resolve(execute(projection, table, predicate, orderBy, limit)).then(
          resolve,
          reject,
        );
      } catch (error) {
        return Promise.reject(error).then(resolve, reject);
      }
    },
  };
}

const databaseMock = {
  select: (projection: Record<string, unknown>) => ({
    from: (table: unknown) => ({
      where: (predicate: unknown) => stage(projection, table, predicate, [], null),
    }),
  }),
};

let loadedProject: { row: { accountId: string; projectId: string }; userId: string } | null = {
  row: { accountId: ACCOUNT_ID, projectId: PROJECT_ID },
  userId: USER_ID,
};
let visibleSession: Record<string, unknown> | null = { row: { sessionId: SESSION_ID } };
let loadProjectCalls: Array<{ projectId: string; action: string }> = [];
let capabilityCalls: Array<{ accountId: string; projectId: string; action: string }> = [];
/** The third argument the handler hands `loadVisibleSession` — the CALLER's
 *  Kortix session id, which drives the KaaB sibling-session gate. */
let visibleSessionCallerIds: Array<string | null> = [];

mock.module('../../shared/db', () => ({ db: databaseMock, hasDatabase: true }));
/** Every read-path reconcile the handler kicked off (session-lifecycle/
 *  turn-read-reconcile.ts). Recorded, never awaited by the handler — the read
 *  answers from the authority as it stands and the NEXT read sees the result. */
let reconcileCalls: Array<{ box: Record<string, unknown>; turns: Array<Record<string, unknown>> }> =
  [];
mock.module('../session-lifecycle/turn-read-reconcile', () => ({
  reconcileStaleTurnsOnRead: async (box: Record<string, unknown>, turns: Array<Record<string, unknown>>) => {
    reconcileCalls.push({ box, turns });
    return { probed: 0, ended: 0, skipped: 'none' };
  },
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
  loadVisibleSession: async (_loaded: unknown, _sessionId: string, callerSessionId: unknown) => {
    visibleSessionCallerIds.push((callerSessionId ?? null) as string | null);
    return visibleSession;
  },
}));

const { projectsApp } = await import('../lib/app');
await import('./r8');

/** `c.get('sessionId')` is OVERLOADED: a Kortix project-session id under a
 *  connector token, the SUPABASE AUTH session id under a browser JWT. The
 *  caller decides which by its `authType`, so tests set both. */
function buildApp(caller: { authType: string; sessionId?: string } = { authType: 'pat' }) {
  const app = new Hono<{ Variables: { userId: string; authType: string; sessionId?: string } }>();
  app.use('*', async (c, next) => {
    c.set('userId', USER_ID);
    c.set('authType', caller.authType);
    if (caller.sessionId !== undefined) c.set('sessionId', caller.sessionId);
    await next();
  });
  app.route('/v1/projects', projectsApp);
  return app;
}

function getTurn(sessionId = SESSION_ID, caller?: { authType: string; sessionId?: string }) {
  return buildApp(caller).request(`/v1/projects/${PROJECT_ID}/sessions/${sessionId}/turn`);
}

/** A running box holding the given `activeTurns` entries. */
const SANDBOX_ID = '66666666-6666-4666-8666-666666666666';
const EXTERNAL_ID = 'ext-box-1';

function runningBox(...turns: Array<ReturnType<typeof authorityTurn>>) {
  return {
    session_id: SESSION_ID,
    sandbox_id: SANDBOX_ID,
    provider: 'daytona',
    external_id: EXTERNAL_ID,
    status: 'active',
    metadata: { activeTurns: Object.fromEntries(turns.map((turn) => [turn.token, turn])) },
  };
}

const ISO_UTC_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('GET /v1/projects/:projectId/sessions/:sessionId/turn', () => {
  beforeEach(() => {
    sandboxTable = [];
    turnTable = [];
    queries = [];
    loadProjectCalls = [];
    capabilityCalls = [];
    visibleSessionCallerIds = [];
    reconcileCalls = [];
    loadedProject = { row: { accountId: ACCOUNT_ID, projectId: PROJECT_ID }, userId: USER_ID };
    visibleSession = { row: { sessionId: SESSION_ID } };
  });

  test('rejects a non-UUID session id with 400 before any DB read', async () => {
    const response = await getTurn('not-a-uuid');
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid session id' });
    // The shape check is the cheapest gate there is; running it after the
    // project load would spend a query to reject a string.
    expect(queries).toEqual([]);
    expect(loadProjectCalls).toEqual([]);
  });

  test('404s when the project is not loadable for the caller', async () => {
    loadedProject = null;
    const response = await getTurn();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
    expect(queries).toEqual([]);
  });

  test('404s when the session is not visible to the caller', async () => {
    visibleSession = null;
    const response = await getTurn();
    expect(response.status).toBe(404);
    // Visibility is what stops a caller reading a SIBLING session's turn state,
    // so it must gate the reads, not merely decorate the response.
    expect(queries).toEqual([]);
  });

  test('reads through a read-tier project load, not a session-mutation one', async () => {
    await getTurn();
    expect(loadProjectCalls).toEqual([{ projectId: PROJECT_ID, action: 'read' }]);
  });

  test('requires PROJECT_SESSION_READ', async () => {
    await getTurn();
    expect(capabilityCalls).toEqual([
      { accountId: ACCOUNT_ID, projectId: PROJECT_ID, action: 'project.session.read' },
    ]);
  });

  test('passes a browser caller NO session id to the visibility gate', async () => {
    // A Supabase JWT's `c.get('sessionId')` is the BROWSER LOGIN's id, not a
    // Kortix project session. Every KaaB isolation guard reads a non-null
    // caller session as "a sandbox acting for one end-user, narrow it", so
    // handing it that value makes `isSessionTargetVisibleToCaller` refuse a
    // signed-in human reaching a sibling `origin='backend'` session — a 404 on
    // a session the same user's GET /sessions list returns, because
    // project-sessions.ts:273 goes through `callerKortixSessionId`.
    await getTurn(SESSION_ID, {
      authType: 'supabase',
      sessionId: 'e2b1d6a0-supabase-auth-session',
    });
    expect(visibleSessionCallerIds).toEqual([null]);
  });

  test('passes a connector caller its Kortix session id to the visibility gate', async () => {
    // The other half of the same contract: a session-bound agent MUST still be
    // narrowed to its own session, so the value cannot simply be dropped.
    await getTurn(SESSION_ID, { authType: 'pat', sessionId: SESSION_ID });
    expect(visibleSessionCallerIds).toEqual([SESSION_ID]);
  });

  test('returns { turns: [] } when the session has no box and no ledger rows', async () => {
    const response = await getTurn();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ turns: [] });
    // `last_ended` is OMITTED, not null: its absence is the only signal that
    // this session has never run a turn.
    expect(Object.hasOwn(body, 'last_ended')).toBe(false);
  });

  test('asks the LIFECYCLE AUTHORITY first, and the ledger only after it', async () => {
    // Liveness is answered by `session_sandboxes.metadata.activeTurns`, which
    // is written in the same statement that grants the turn. The ledger row is
    // a best-effort SECOND round trip whose failure is swallowed, so a ledger
    // read cannot be the thing that decides "is a turn running".
    sandboxTable = [runningBox(authorityTurn({ token: 't-live' }))];
    await getTurn();
    expect(queries[0].table).toBe('sandboxes');
    expect(queries.slice(1).every((q) => q.table === 'turns')).toBe(true);
  });

  test('reports a turn the authority holds but the ledger never recorded', async () => {
    // THE BOOT PROMPT. `initialSandboxTurnMetadata` writes the turn straight
    // into `activeTurns` and issues no ledger INSERT at all; the first
    // `session_turns` row appears only when the daemon confirms acceptance,
    // 18.9s (daytona) / 24.5s (platinum) later. A ledger-only read answers
    // "idle" for that whole window. The same hole opens for any turn whose
    // swallowed INSERT never landed.
    sandboxTable = [
      runningBox(
        authorityTurn({
          token: 't-boot',
          state: 'delivering',
          messageId: 'msg_boot',
          startedAtMs: Date.parse('2026-08-17T00:00:00.000Z'),
        }),
      ),
    ];
    const body = await (await getTurn()).json();
    expect(body).toEqual({
      turns: [
        {
          turn_token: 't-boot',
          state: 'delivering',
          message_id: 'msg_boot',
          opencode_session_id: null,
          started_at: '2026-08-17T00:00:00.000Z',
          accepted_at: null,
        },
      ],
    });
  });

  test('does NOT report an open ledger row the authority no longer holds', async () => {
    // A swallowed settle on a box that keeps running leaves `state='active'`
    // for ever: `settleOrphanedSandboxTurns` only closes rows whose sandbox has
    // stopped, and the reaper reconciles from the authority, which no longer
    // names the token. Serving that row as live is permanent phantom-busy —
    // the exact failure this endpoint exists to end.
    sandboxTable = [runningBox()];
    turnTable = [
      ledgerRow({ turn_token: 't-stale', state: 'active' }),
      ledgerRow({
        turn_token: 't-done',
        state: 'ended',
        end_reason: 'completed',
        ended_at: new Date('2026-08-17T00:00:09.000Z'),
      }),
    ];
    const body = await (await getTurn()).json();
    expect(body.turns).toEqual([]);
    expect(body.last_ended.turn_token).toBe('t-done');
  });

  test('ignores the authority of a box that is no longer running', async () => {
    // Same predicate `settleOrphanedSandboxTurns` uses to close every row left
    // open on a stopped box: a box that is not active or provisioning holds no
    // live turn, whatever its metadata still says.
    sandboxTable = [{ ...runningBox(authorityTurn({ token: 't-orphan' })), status: 'stopped' }];
    const body = await (await getTurn()).json();
    expect(body.turns).toEqual([]);
  });

  test('reports EVERY concurrent turn, newest start first', async () => {
    // `activeTurns` is token-keyed precisely so concurrent prompts do not
    // clobber each other, and `beginSandboxTurn` merges into it with no
    // single-turn guard. A trigger-delivered prompt and a web prompt are both
    // genuinely live; answering with only one of them makes the older turn
    // look idle to anything reconciling by `message_id`.
    sandboxTable = [
      runningBox(
        authorityTurn({
          token: 't-trigger',
          messageId: 'msg_A',
          startedAtMs: Date.parse('2026-08-17T12:00:00.000Z'),
        }),
        authorityTurn({
          token: 't-web',
          state: 'delivering',
          messageId: 'msg_B',
          startedAtMs: Date.parse('2026-08-17T12:00:02.000Z'),
        }),
      ),
    ];
    const body = await (await getTurn()).json();
    expect(body.turns.map((t: { turn_token: string }) => t.turn_token)).toEqual([
      't-web',
      't-trigger',
    ]);
    expect(body.turns.map((t: { message_id: string }) => t.message_id)).toEqual(['msg_B', 'msg_A']);
  });

  test('decorates a live turn with accepted_at from its ledger row', async () => {
    sandboxTable = [
      runningBox(
        authorityTurn({
          token: 't-live',
          opencodeSessionId: 'ses_root',
          messageId: 'msg_1',
          startedAtMs: Date.parse('2026-08-17T00:00:00.000Z'),
        }),
      ),
    ];
    turnTable = [
      ledgerRow({
        turn_token: 't-live',
        accepted_at: new Date('2026-08-17T00:00:01.000Z'),
        // A different instant in `ended_at`: a projection that reads the wrong
        // column returns THIS, so the assertion below is projection-sensitive.
        ended_at: new Date('2026-08-17T09:09:09.000Z'),
      }),
    ];
    const body = await (await getTurn()).json();
    expect(body.turns).toEqual([
      {
        turn_token: 't-live',
        state: 'active',
        message_id: 'msg_1',
        opencode_session_id: 'ses_root',
        started_at: '2026-08-17T00:00:00.000Z',
        accepted_at: '2026-08-17T00:00:01.000Z',
      },
    ]);
  });

  test('takes state from the authority, never from the ledger row', async () => {
    // `acceptSandboxTurn` promotes the authority entry in statement one and
    // UPSERTs the ledger in statement two. When that second write is swallowed
    // the row still says `delivering` for a turn OpenCode has accepted.
    sandboxTable = [runningBox(authorityTurn({ token: 't-live', state: 'active' }))];
    turnTable = [ledgerRow({ turn_token: 't-live', state: 'delivering' })];
    const body = await (await getTurn()).json();
    expect(body.turns[0].state).toBe('active');
  });

  test('reads the ledger only for the tokens the authority named', async () => {
    sandboxTable = [runningBox(authorityTurn({ token: 't-live' }))];
    turnTable = [
      ledgerRow({ turn_token: 't-live' }),
      ledgerRow({ turn_token: 't-someone-else', state: 'active' }),
    ];
    const body = await (await getTurn()).json();
    expect(body.turns.map((t: { turn_token: string }) => t.turn_token)).toEqual(['t-live']);
    expect(queries[1].where).toContain('col:turn_token in');
  });

  test('falls back to the ledger start when the authority record carries none', async () => {
    // A legacy `activeTurn` record from a pre-`activeTurns` deploy has no
    // `startedAtMs`. The ledger row is then the only place the start instant
    // exists.
    sandboxTable = [
      {
        session_id: SESSION_ID,
        status: 'active',
        metadata: {
          activeTurn: { token: 't-legacy', state: 'active', opencodeSessionId: 'ses_root' },
        },
      },
    ];
    turnTable = [
      ledgerRow({ turn_token: 't-legacy', started_at: new Date('2026-08-17T00:00:04.000Z') }),
    ];
    const body = await (await getTurn()).json();
    expect(body.turns[0].started_at).toBe('2026-08-17T00:00:04.000Z');
  });

  test('reports a live turn with a null started_at rather than hiding it', async () => {
    // Neither source carries a start instant. The turn is still RUNNING, and
    // dropping it because one field is unknown would reintroduce the phantom
    // idle this endpoint exists to kill.
    sandboxTable = [
      {
        session_id: SESSION_ID,
        status: 'active',
        metadata: { activeTurn: { token: 't-legacy', state: 'active' } },
      },
    ];
    const body = await (await getTurn()).json();
    expect(body.turns).toEqual([
      {
        turn_token: 't-legacy',
        state: 'active',
        message_id: null,
        opencode_session_id: null,
        started_at: null,
        accepted_at: null,
      },
    ]);
  });

  test('does not run the terminal read while a turn is live', async () => {
    // The settled row is irrelevant while a turn is running, and the response
    // omits `last_ended` in that case — so paying for that index scan would buy
    // nothing.
    sandboxTable = [runningBox(authorityTurn({ token: 't-live' }))];
    await getTurn();
    expect(queries.map((q) => q.table)).toEqual(['sandboxes', 'turns']);
    expect(queries[1].where).toContain('col:turn_token in');
  });

  test('returns the NEWEST settled turn as last_ended', async () => {
    // Ordering is load-bearing: a session accumulates terminal rows and "some
    // ended turn" is not the question. The two rows differ ONLY by ended_at, so
    // this fails on `asc(endedAt)` and on dropping the term.
    turnTable = [
      ledgerRow({
        turn_token: 't-older',
        state: 'ended',
        end_reason: 'completed',
        ended_at: new Date('2026-08-17T00:00:03.000Z'),
      }),
      ledgerRow({
        turn_token: 't-newest',
        state: 'ended',
        end_reason: 'runtime_gone',
        ended_at: new Date('2026-08-17T00:00:09.000Z'),
      }),
    ];
    const response = await getTurn();
    expect(await response.json()).toEqual({
      turns: [],
      last_ended: {
        turn_token: 't-newest',
        end_reason: 'runtime_gone',
        ended_at: '2026-08-17T00:00:09.000Z',
      },
    });
  });

  test('never serves a still-open row as last_ended, whose NULL ended_at sorts FIRST', async () => {
    // `state = 'ended'` is the term that keeps a RUNNING turn out of the
    // history slot, and it is load-bearing precisely because an open row has
    // `ended_at = NULL`, which Postgres sorts FIRST under `desc(ended_at)`.
    // Drop that term from the terminal read and the open row wins the LIMIT 1.
    sandboxTable = [runningBox()];
    turnTable = [
      ledgerRow({ turn_token: 't-open', state: 'active', ended_at: null }),
      ledgerRow({
        turn_token: 't-done',
        state: 'ended',
        end_reason: 'completed',
        ended_at: new Date('2026-08-17T00:00:09.000Z'),
      }),
    ];
    const body = await (await getTurn()).json();
    expect(body.last_ended.turn_token).toBe('t-done');
    expect(queries.at(-1)?.where).toContain(`col:state = $${JSON.stringify('ended')}`);
  });

  test('breaks a settled tie on the newest START', async () => {
    // `ended_at` is nullable, so it cannot order the terminal read on its own.
    turnTable = [
      ledgerRow({
        turn_token: 't-first',
        state: 'ended',
        started_at: new Date('2026-08-17T00:00:01.000Z'),
      }),
      ledgerRow({
        turn_token: 't-second',
        state: 'ended',
        started_at: new Date('2026-08-17T00:00:07.000Z'),
      }),
    ];
    const body = await (await getTurn()).json();
    expect(body.last_ended.turn_token).toBe('t-second');
  });

  test('serializes timestamps as UTC ISO-8601 instants', async () => {
    // JSON has no Date type, so "emitted a Date, not a string" is NOT
    // falsifiable on the wire — `c.json(new Date(x))` and
    // `c.json(x.toISOString())` are byte identical. What IS falsifiable, and
    // what the SDK type promises, is the FORMAT: a UTC ISO-8601 instant with
    // milliseconds. A Date's default `toString()`, a unix epoch number, and the
    // driver's own "2026-08-17 12:34:56+00" all fail this.
    sandboxTable = [
      runningBox(
        authorityTurn({ token: 't-live', startedAtMs: Date.parse('2026-08-17T12:34:56.789Z') }),
      ),
    ];
    turnTable = [
      ledgerRow({ turn_token: 't-live', accepted_at: new Date('2026-08-17T12:34:57.000Z') }),
    ];
    const body = await (await getTurn()).json();
    expect(body.turns[0].started_at).toMatch(ISO_UTC_MS);
    expect(body.turns[0].accepted_at).toMatch(ISO_UTC_MS);
    expect(body.turns[0].started_at).toBe('2026-08-17T12:34:56.789Z');
    expect(body.turns[0].accepted_at).toBe('2026-08-17T12:34:57.000Z');
  });

  test('serializes ended_at as a UTC ISO-8601 instant too', async () => {
    turnTable = [
      ledgerRow({
        turn_token: 't-done',
        state: 'ended',
        end_reason: 'completed',
        ended_at: new Date('2026-08-17T12:34:58.250Z'),
      }),
    ];
    const body = await (await getTurn()).json();
    expect(body.last_ended.ended_at).toMatch(ISO_UTC_MS);
    expect(body.last_ended.ended_at).toBe('2026-08-17T12:34:58.250Z');
  });

  // ── Bounded server-truth reconcile on the read path ─────────────────────
  //
  // The web is server-truth-first: an `active` record IS "Gathering thoughts".
  // When the daemon's turn-end relay is lost, the read path itself asks the
  // runtime (session-lifecycle/turn-read-reconcile.ts) — fire-and-forget, so
  // THIS read answers from the authority as it stands and the NEXT one sees the
  // result. The route's only job here: hand the reconcile the box identity and
  // the authority's records, and only for a running box.

  test('kicks off the read-path reconcile with the box identity and the authority turns', async () => {
    sandboxTable = [
      runningBox(
        authorityTurn({ token: 't-live', opencodeSessionId: 'ses_root', messageId: 'msg_1', startedAtMs: 1_755_000_000_000 }),
      ),
    ];
    const response = await getTurn();
    expect(response.status).toBe(200);
    expect(reconcileCalls).toEqual([
      {
        box: { sandboxId: SANDBOX_ID, provider: 'daytona', externalId: EXTERNAL_ID },
        turns: [
          {
            token: 't-live',
            state: 'active',
            opencodeSessionId: 'ses_root',
            messageId: 'msg_1',
            startedAtMs: 1_755_000_000_000,
          },
        ],
      },
    ]);
  });

  test('answers from the authority as it stands — the reconcile never changes THIS response', async () => {
    sandboxTable = [runningBox(authorityTurn({ token: 't-live' }))];
    const body = (await (await getTurn()).json()) as { turns: Array<{ turn_token: string }> };
    expect(body.turns.map((turn) => turn.turn_token)).toEqual(['t-live']);
  });

  test('does not kick off the reconcile when no turn is live', async () => {
    sandboxTable = [runningBox()];
    await getTurn();
    expect(reconcileCalls).toEqual([]);
  });

  test('does not kick off the reconcile for a box that is no longer running', async () => {
    sandboxTable = [{ ...runningBox(authorityTurn({ token: 't-stale' })), status: 'stopped' }];
    await getTurn();
    expect(reconcileCalls).toEqual([]);
  });

  test('carries a null end_reason and a null ended_at through as null', async () => {
    turnTable = [
      ledgerRow({ turn_token: 't-unsettled', state: 'ended', end_reason: null, ended_at: null }),
    ];
    const body = await (await getTurn()).json();
    expect(body).toEqual({
      turns: [],
      last_ended: { turn_token: 't-unsettled', end_reason: null, ended_at: null },
    });
  });
});
