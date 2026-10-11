/**
 * The per-session fan-out regression behind KRTX-532.
 *
 * `GET /v1/projects/:id/reminders` (and any list that gates rows through
 * `loadVisibleSession`) used to run the full session read — session row +
 * share subject + session grants + the service-account owner probe — ONCE PER
 * DISTINCT SESSION, issued in parallel (`Promise.all`). Prod measured 64 db
 * statements for one list request (133 requests / 8,469 statements in 24 h);
 * against a 5-connection per-task pool that single request saturates the pool
 * and queues every concurrent statement on the task, which is how a route's
 * p95 inflates fleet-wide (KRTX-532 telemetry: victim statements queue
 * 0.5–1 s each during burst minutes).
 *
 * The batched helper `loadVisibleSessionsForList` must resolve N sessions with
 * a BOUNDED statement count: one rows read, one subject read, one grants
 * read, plus at most one memoized owner probe per distinct `created_by`.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { getTableName, type Table } from 'drizzle-orm';

// ─── A counting fake db, keyed by table name ───────────────────────────────
let statements = 0;
const results = new Map<string, unknown[][]>();

function serve(table: Table): unknown[] {
  statements += 1;
  const queue = results.get(getTableName(table));
  return queue?.shift() ?? [];
}

function makeChain(): any {
  const chain: any = {};
  let table: Table | null = null;
  for (const method of ['where', 'limit', 'orderBy']) {
    chain[method] = () => chain;
  }
  chain.from = (t: Table) => {
    table = t;
    return chain;
  };
  chain.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve(table ? serve(table) : []));
  return chain;
}

mock.module('../../../shared/db', () => ({
  db: { select: () => makeChain(), insert: () => makeChain(), update: () => makeChain(), delete: () => makeChain() },
  hasDatabase: true,
}));

// `authorize` (the trigger-session probe) must never run in these fixtures:
// they use non-trigger sessions. Fail the test loudly if it does.
mock.module('../../../iam/authorize', () => ({
  authorize: async () => {
    throw new Error('authorize() must not run for non-trigger list fixtures');
  },
}));

// Under `bun test` ttlMemo bypasses caching unless a memoizer opts in with
// `enableInTests` — correct hygiene for most suites, but the property under
// test here IS the deduplication: the owner probe must collapse to one
// statement per distinct key. This mock keeps the real semantics (in-flight
// sharing, negative results never cached, the clear/invalidate API) with a
// tiny Map, so the assertions measure production behavior.
mock.module('../../../shared/ttl-memo', () => ({
  ttlMemo: (opts: any) => {
    const cache = new Map<string, Promise<unknown>>();
    const memo: any = (...args: unknown[]) => {
      const key = opts.keyFn(...args);
      const hit = cache.get(key);
      if (hit) return hit;
      const entry = opts.loader(...args).then(
        (value: unknown) => {
          if (opts.shouldCache && !opts.shouldCache(value, ...args)) cache.delete(key);
          return value;
        },
        (err: unknown) => {
          cache.delete(key); // rejections are never cached — the next caller retries
          throw err;
        },
      );
      cache.set(key, entry);
      return entry;
    };
    memo.clear = () => cache.clear();
    memo.invalidate = (key: string) => cache.delete(key);
    memo.invalidateByPrefix = (prefix: string) => {
      for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key);
    };
    return memo;
  },
}));

const { loadVisibleSession, loadVisibleSessionsForList, sessionOwnerIsMachine } = await import(
  '../session-visibility'
);

const PROJECT = { projectId: 'p1', accountId: 'a1' } as any;
const loaded = {
  row: PROJECT,
  userId: 'human-1',
  effectiveRole: 'manager' as const,
  adminBypass: false,
  actor: null,
};

function sessionRow(sessionId: string, overrides: Record<string, unknown> = {}) {
  return {
    sessionId,
    projectId: 'p1',
    accountId: 'a1',
    visibility: 'project',
    createdBy: 'human-1',
    origin: null,
    initiatorType: null,
    metadata: {},
    ...overrides,
  } as any;
}

beforeEach(() => {
  statements = 0;
  results.clear();
});

describe('loadVisibleSessionsForList (KRTX-532 pool-saturation regression)', () => {
  test('N sessions resolve with a bounded statement count, not N full session reads', async () => {
    const ids = Array.from({ length: 30 }, (_, i) => `sess-${String(i).padStart(2, '0')}`);
    results.set('project_sessions', [ids.map((id) => sessionRow(id, { createdBy: 'svc-agent-1' }))]);
    results.set('account_group_members', [[]]);
    results.set('project_session_grants', [[]]);
    results.set('service_accounts', [[{ serviceAccountId: 'svc-agent-1' }]]);

    const visible = await loadVisibleSessionsForList(loaded, ids, null, null);

    expect(visible.size).toBe(30);
    const first = visible.get('sess-00')!;
    expect(first.row.sessionId).toBe('sess-00');
    expect(first.isOwner).toBe(false);
    expect(first.canManageLifecycle).toBe(true);
    expect(first.ownerIsMachine).toBe(true);
    expect(first.canManageSharing).toBe(true);
    // THE REGRESSION: 30 sessions used to cost 30 × (3 reads + owner probe)
    // ≈ 120 statements issued in one parallel fan-out. Batched, the whole list
    // costs one read per shared input plus one memoized owner probe per
    // distinct creator: 4 statements total for this fixture.
    expect(statements).toBe(4);
  });

  test('invisible sessions are excluded, not errors', async () => {
    results.set('project_sessions', [[
      sessionRow('mine', { createdBy: 'human-1' }),
      sessionRow('theirs-private', { visibility: 'private', createdBy: 'human-2' }),
    ]]);
    results.set('account_group_members', [[]]);
    results.set('project_session_grants', [[]]);

    const visible = await loadVisibleSessionsForList(loaded, ['mine', 'theirs-private'], null, null);

    expect([...visible.keys()]).toEqual(['mine']);
    expect(visible.get('mine')!.isOwner).toBe(true);
  });

  test('empty and duplicate inputs: zero statements, one entry per distinct session', async () => {
    const none = await loadVisibleSessionsForList(loaded, [], null, null);
    expect(none.size).toBe(0);
    expect(statements).toBe(0);

    results.set('project_sessions', [[sessionRow('one')]]);
    results.set('account_group_members', [[]]);
    results.set('project_session_grants', [[]]);
    const dupes = await loadVisibleSessionsForList(loaded, ['one', 'one', 'one'], null, null);
    expect(dupes.size).toBe(1);
    // rows + subject + grants; isOwner short-circuits the owner probe.
    expect(statements).toBe(3);
  });

  test('the single-session path still answers the full shape', async () => {
    results.set('project_sessions', [[sessionRow('one')]]);
    results.set('account_group_members', [[]]);
    results.set('project_session_grants', [[]]);

    const one = await loadVisibleSession(loaded, 'one', null, null);
    expect(one).not.toBeNull();
    expect(one!.row.sessionId).toBe('one');
    expect(one!.isOwner).toBe(true);
    expect(one!.canManageLifecycle).toBe(true);
    expect(one!.ownerIsMachine).toBe(false);

    expect(await loadVisibleSession(loaded, 'missing', null, null)).toBeNull();
  });

  test('owner probe dedupes across creators via the TTL memo', async () => {
    const ids = ['a', 'b', 'c'];
    results.set('project_sessions', [[
      sessionRow('a', { createdBy: 'svc-1' }),
      sessionRow('b', { createdBy: 'svc-2' }),
      sessionRow('c', { createdBy: 'svc-1' }),
    ]]);
    results.set('account_group_members', [[]]);
    results.set('project_session_grants', [[]]);
    results.set('service_accounts', [[{ serviceAccountId: 'svc-1' }], [{ serviceAccountId: 'svc-2' }]]);

    const visible = await loadVisibleSessionsForList(loaded, ids, null, null);
    expect(visible.size).toBe(3);
    expect(visible.get('c')!.ownerIsMachine).toBe(true);
    // rows + subject + grants + exactly TWO distinct-creator probes (the TTL
    // memo answers the repeated svc-1 without a second statement).
    expect(statements).toBe(5);
    // …and the memo answers a later call with zero further statements.
    expect(await sessionOwnerIsMachine('a1', 'svc-1')).toBe(true);
    expect(statements).toBe(5);
  });
});
