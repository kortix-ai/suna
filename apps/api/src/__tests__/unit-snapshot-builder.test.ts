/**
 * Unit coverage for the builder helpers introduced when we ripped out the
 * DAYTONA_SNAPSHOT env-var fallback:
 *
 *   - getLatestReadySnapshot: returns the most recent ready row for
 *     (project, branch, provider). Drops failed/queued/building rows.
 *
 *   - ensureBuildForLatestCommit: fire-and-forget contract — never throws
 *     synchronously, classifies the (project, commit) state into one of
 *     four buckets so the session-start path knows whether it kicked off
 *     a fresh build or hit a "already-ready / already-building" cache.
 *
 *   - pruneOldSnapshots: retains the N most-recent ready rows per
 *     (project, branch) and only removes the Daytona-side image when
 *     no surviving DB row still references it (content-hash dedupe
 *     means two branches can share one snapshotId).
 *
 * We mock the DB layer with a minimal in-memory shim that supports the
 * exact query shapes the helpers use. Anything more elaborate would
 * couple the test to query-builder internals.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { projectRuntimeSnapshots } from '@kortix/db';

process.env.NODE_ENV = 'test';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_ID = '22222222-2222-4222-8222-222222222222';
const BRANCH = 'main';

interface Row {
  snapshotRowId: string;
  accountId: string;
  projectId: string;
  provider: 'daytona';
  commitSha: string;
  branch: string;
  snapshotId: string | null;
  status: 'queued' | 'building' | 'ready' | 'failed';
  error: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

let rows: Row[] = [];
let daytonaDeleteCalls: string[];
let daytonaDeleteByIdCalls: string[];
let daytonaSnapshotCreateCalls: any[];
let hiddenDaytonaSnapshots: Set<string>;
let omittedFromDaytonaList: Set<string>;

function makeRow(overrides: Partial<Row> = {}): Row {
  const id = overrides.snapshotRowId ?? `row-${rows.length}`;
  return {
    snapshotRowId: id,
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    provider: 'daytona',
    commitSha: overrides.commitSha ?? `commit-${id}`,
    branch: overrides.branch ?? BRANCH,
    snapshotId: overrides.snapshotId ?? `kortix-snap-1111-${id}`,
    status: overrides.status ?? 'ready',
    error: overrides.error ?? null,
    metadata: overrides.metadata ?? { runtimeFingerprint: 'runtime-current' },
    createdAt: overrides.createdAt ?? new Date(2026, 0, 1),
    updatedAt: overrides.updatedAt ?? overrides.createdAt ?? new Date(2026, 0, 1),
    ...overrides,
  };
}

// Minimal shim that emulates the drizzle query surface the helpers use.
// The helpers do not exercise arbitrary chained operators — they only do:
//   - .select().from(t).where(...).orderBy(...).limit(...)
//   - .select().from(t).where(...).limit(...)
//   - .delete(t).where(inArray(snapshotRowId, [...]))
// The shim ignores the actual WHERE expression and exposes its own
// per-select-call filter hook so tests can model query sequences
// (pruneOldSnapshots issues multiple selects in one call).
let selectCallCount = 0;
let filterByCall: Array<(row: Row) => boolean> = [];
let nextSort: ((a: Row, b: Row) => number) | null = null;

function setFilter(fn: (row: Row) => boolean) { filterByCall = [fn]; }
function setFilterSequence(...fns: Array<(row: Row) => boolean>) { filterByCall = fns; }
function setSort(fn: (a: Row, b: Row) => number) { nextSort = fn; }

function currentFilter(): (row: Row) => boolean {
  return filterByCall[Math.min(selectCallCount - 1, filterByCall.length - 1)] ?? (() => true);
}

function makeOrderByThenable(table: unknown, filter: (row: Row) => boolean) {
  // pruneOldSnapshots awaits `.orderBy(...)` directly (no .limit). The
  // other helpers chain `.limit(n)` on top. Both shapes must work, so
  // the returned object is both awaitable AND chainable.
  const runAll = () => {
    if (table !== projectRuntimeSnapshots) return [];
    const filtered = rows.filter(filter);
    if (nextSort) filtered.sort(nextSort);
    return filtered;
  };
  return {
    then: (resolve: (rows: Row[]) => unknown, reject?: (err: unknown) => unknown) => {
      try { return Promise.resolve(runAll()).then(resolve, reject); }
      catch (err) { return Promise.reject(err); }
    },
    limit: async (n: number) => runAll().slice(0, n),
  };
}

mock.module('../shared/db', () => ({
  db: {
    select: () => {
      selectCallCount += 1;
      const filter = currentFilter();
      return {
        from: (table: unknown) => ({
          where: (_predicate: unknown) => {
            const runAll = () => table === projectRuntimeSnapshots ? rows.filter(filter) : [];
            return {
              then: (resolve: (rows: Row[]) => unknown, reject?: (err: unknown) => unknown) => {
                try { return Promise.resolve(runAll()).then(resolve, reject); }
                catch (err) { return Promise.reject(err); }
              },
              orderBy: (_order: unknown) => makeOrderByThenable(table, filter),
              limit: async (n: number) => {
                if (table !== projectRuntimeSnapshots) return [];
                return rows.filter(filter).slice(0, n);
              },
            };
          },
        }),
      };
    },
    insert: (table: unknown) => ({
      values: async (values: any) => {
        if (table !== projectRuntimeSnapshots) return [];
        const dup = rows.find(
          (r) =>
            r.projectId === values.projectId &&
            r.commitSha === values.commitSha &&
            r.provider === values.provider,
        );
        if (dup) throw new Error('unique violation');
        rows.push(
          makeRow({
            snapshotRowId: `row-${rows.length}`,
            accountId: values.accountId,
            projectId: values.projectId,
            provider: values.provider,
            commitSha: values.commitSha,
            branch: values.branch ?? BRANCH,
            status: values.status ?? 'queued',
            snapshotId: null,
            metadata: values.metadata ?? {},
          }),
        );
        return [];
      },
    }),
    update: (_table: unknown) => ({
      set: (_patch: any) => ({
        where: async (_predicate: unknown) => [],
      }),
    }),
    delete: (_table: unknown) => ({
      // pruneOldSnapshots uses inArray on snapshotRowId — we don't model
      // that predicate; the test verifies behavior via call counts.
      where: (_predicate: unknown) => ({
        then: (resolve: (value: undefined) => unknown, reject?: (err: unknown) => unknown) =>
          Promise.resolve(undefined).then(resolve, reject),
        returning: async () => [],
      }),
    }),
  },
}));

mock.module('../shared/daytona', () => ({
  getDaytona: () => ({
    snapshot: {
      create: async (...args: any[]) => { daytonaSnapshotCreateCalls.push(args); },
      // SDK signature: get(name) → Snapshot, delete(snapshot) → void.
      // The shim returns a stub object keyed on name so the test can
      // assert prune called delete with the expected snapshotId.
      get: async (name: string) => {
        if (hiddenDaytonaSnapshots.has(name)) throw new Error('snapshot not found');
        return { id: `daytona-${name}`, name, state: 'active' };
      },
      delete: async (snapshot: { name: string }) => {
        daytonaDeleteCalls.push(snapshot.name);
      },
    },
  }),
  isDaytonaConfigured: () => true,
  listDaytonaSnapshots: async () =>
    rows
      .filter((row) => row.snapshotId)
      .filter((row) => !hiddenDaytonaSnapshots.has(row.snapshotId!))
      .filter((row) => !omittedFromDaytonaList.has(row.snapshotId!))
      .map((row) => ({
        id: `daytona-${row.snapshotId}`,
        name: row.snapshotId!,
        state: 'active',
        createdAt: row.createdAt.toISOString(),
      })),
  deleteDaytonaSnapshotById: async (id: string) => {
    daytonaDeleteByIdCalls.push(id);
    return true;
  },
}));

mock.module('../projects/git', () => ({
  grepRepoFiles: async () => [],
  searchRepoFileNames: async () => [],
  resolveCommitSha: async (_project: any, ref: string) => `head-of-${ref}`,
  resolveTreeOid: async () => 'tree-oid',
  readRepoFile: async () => 'FROM ubuntu:24.04\n',
  materializeRepoContext: async () => '/tmp/fake-context',
  materializeRepoCheckoutTar: async () => ({ archivePath: '/tmp/fake-checkout.tar.gz', bytes: 1 }),
}));

mock.module('../projects/triggers', () => ({
  readManifest: async () => null,
}));

mock.module('../snapshots/runtime-fingerprint', () => ({
  buildRuntimeArtifactFingerprint: async () => 'runtime-current',
}));

mock.module('../config', () => ({
  SANDBOX_VERSION: 'test-snapshot-version',
}));

const builder = await import('../snapshots/builder');
const { computeSnapshotHash, formatSnapshotName } = await import('../snapshots/hash');

function expectedSnapshotName(): string {
  const hash = computeSnapshotHash({
    dockerfile: 'FROM ubuntu:24.04\n',
    contextTreeOid: 'tree-oid',
    runtimeFingerprint: 'runtime-current',
    spec: {},
  });
  return formatSnapshotName(PROJECT_ID, hash.contentHash);
}

beforeEach(() => {
  rows = [];
  daytonaDeleteCalls = [];
  daytonaDeleteByIdCalls = [];
  daytonaSnapshotCreateCalls = [];
  hiddenDaytonaSnapshots = new Set();
  omittedFromDaytonaList = new Set();
  filterByCall = [() => true];
  nextSort = null;
  selectCallCount = 0;
});

afterEach(() => {
  rows = [];
});

describe('getLatestReadySnapshot', () => {
  test('returns the most recently created ready row for the branch', async () => {
    rows = [
      makeRow({ snapshotRowId: 'old', status: 'ready', createdAt: new Date(2026, 0, 1) }),
      makeRow({ snapshotRowId: 'newer', status: 'ready', createdAt: new Date(2026, 0, 5) }),
      makeRow({ snapshotRowId: 'failed', status: 'failed', createdAt: new Date(2026, 0, 6) }),
    ];
    setFilter((r) => r.projectId === PROJECT_ID && r.branch === BRANCH && r.provider === 'daytona' && r.status === 'ready');
    setSort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const result = await builder.getLatestReadySnapshot(PROJECT_ID, BRANCH);
    expect(result?.snapshotRowId).toBe('newer');
  });

  test('returns null when no ready row exists for the branch', async () => {
    rows = [
      makeRow({ snapshotRowId: 'building', status: 'building' }),
      makeRow({ snapshotRowId: 'queued', status: 'queued' }),
      makeRow({ snapshotRowId: 'failed', status: 'failed' }),
    ];
    setFilter((r) => r.status === 'ready');
    const result = await builder.getLatestReadySnapshot(PROJECT_ID, BRANCH);
    expect(result).toBeNull();
  });

  test('ignores ready rows when Daytona no longer has the snapshot active', async () => {
    rows = [
      makeRow({ snapshotRowId: 'stale', status: 'ready', snapshotId: 'kortix-snap-1111-stale' }),
    ];
    hiddenDaytonaSnapshots = new Set(['kortix-snap-1111-stale']);
    setFilter((r) => r.status === 'ready');

    const result = await builder.getLatestReadySnapshot(PROJECT_ID, BRANCH);

    expect(result).toBeNull();
  });

  test('ignores ready rows from an old runtime fingerprint', async () => {
    rows = [
      makeRow({
        snapshotRowId: 'stale-newer',
        status: 'ready',
        metadata: { runtimeFingerprint: 'runtime-old' },
        createdAt: new Date(2026, 0, 5),
      }),
      makeRow({
        snapshotRowId: 'current-older',
        status: 'ready',
        metadata: { runtimeFingerprint: 'runtime-current' },
        createdAt: new Date(2026, 0, 1),
      }),
    ];
    setFilter((r) => r.status === 'ready');
    setSort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const result = await builder.getLatestReadySnapshot(PROJECT_ID, BRANCH);
    expect(result?.snapshotRowId).toBe('current-older');
  });

  test('falls back to the newest retained ready row when the runtime is outdated', async () => {
    rows = [
      makeRow({
        snapshotRowId: 'stale-newer',
        status: 'ready',
        metadata: { runtimeFingerprint: 'runtime-old' },
        createdAt: new Date(2026, 0, 5),
      }),
      makeRow({
        snapshotRowId: 'stale-older',
        status: 'ready',
        metadata: { runtimeFingerprint: 'runtime-older' },
        createdAt: new Date(2026, 0, 1),
      }),
    ];
    setFilter((r) => r.status === 'ready');
    setSort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const result = await builder.getLatestReadySnapshot(PROJECT_ID, BRANCH);
    expect(result?.snapshotRowId).toBe('stale-newer');
  });
});

describe('getReadySnapshotForCommit', () => {
  test('returns a current-runtime ready row for the commit regardless of branch', async () => {
    rows = [
      makeRow({
        snapshotRowId: 'same-commit-other-branch',
        commitSha: 'head-of-feature',
        branch: 'main',
        status: 'ready',
        snapshotId: 'kortix-snap-1111-shared',
        metadata: { runtimeFingerprint: 'runtime-current' },
      }),
    ];
    setFilter((r) => r.projectId === PROJECT_ID && r.commitSha === 'head-of-feature' && r.provider === 'daytona');

    const result = await builder.getReadySnapshotForCommit(PROJECT_ID, 'head-of-feature');
    expect(result?.snapshotRowId).toBe('same-commit-other-branch');
    expect(result?.snapshotId).toBe('kortix-snap-1111-shared');
  });

  test('returns null for stale-runtime ready rows', async () => {
    rows = [
      makeRow({
        snapshotRowId: 'stale-commit',
        commitSha: 'head-of-feature',
        branch: 'main',
        status: 'ready',
        metadata: { runtimeFingerprint: 'runtime-old' },
      }),
    ];
    setFilter((r) => r.projectId === PROJECT_ID && r.commitSha === 'head-of-feature' && r.provider === 'daytona');

    const result = await builder.getReadySnapshotForCommit(PROJECT_ID, 'head-of-feature');
    expect(result).toBeNull();
  });
});

describe('ensureBuildForLatestCommit', () => {
  test('returns already-ready when the branch tip is already built', async () => {
    rows = [
      makeRow({
        commitSha: 'head-of-main',
        status: 'ready',
        snapshotId: 'kortix-snap-1111-ready',
      }),
    ];
    setFilter((r) => r.commitSha === 'head-of-main' && r.status !== 'failed');

    const result = await builder.ensureBuildForLatestCommit(
      { projectId: PROJECT_ID, repoUrl: 'r', defaultBranch: BRANCH, manifestPath: 'm' },
      { branch: BRANCH, accountId: ACCOUNT_ID, source: 'session-start' },
    );
    expect(result.status).toBe('already-ready');
    expect(result.commitSha).toBe('head-of-main');
  });

  test('returns already-building when a non-failed row already exists', async () => {
    rows = [makeRow({ commitSha: 'head-of-main', status: 'building', snapshotId: null, updatedAt: new Date() })];
    setFilter((r) => r.commitSha === 'head-of-main' && r.status !== 'failed');

    const result = await builder.ensureBuildForLatestCommit(
      { projectId: PROJECT_ID, repoUrl: 'r', defaultBranch: BRANCH, manifestPath: 'm' },
      { branch: BRANCH, accountId: ACCOUNT_ID, source: 'manual' },
    );
    expect(result.status).toBe('already-building');
  });

  test('recovers an active provider snapshot from a fresh building row', async () => {
    rows = [
      makeRow({
        commitSha: 'head-of-main',
        status: 'building',
        snapshotId: expectedSnapshotName(),
        updatedAt: new Date(),
      }),
    ];
    setFilter((r) => r.commitSha === 'head-of-main' && r.status !== 'failed');

    const result = await builder.ensureBuildForLatestCommit(
      { projectId: PROJECT_ID, repoUrl: 'r', defaultBranch: BRANCH, manifestPath: 'm' },
      { branch: BRANCH, accountId: ACCOUNT_ID, source: 'manual' },
    );
    expect(result.status).toBe('already-ready');
    expect(daytonaSnapshotCreateCalls).toHaveLength(0);
  });

  test('starts a non-destructive rebuild when the branch tip has an outdated ready row', async () => {
    rows = [
      makeRow({
        commitSha: 'head-of-main',
        status: 'ready',
        snapshotId: 'kortix-snap-1111-old-runtime',
        metadata: { runtimeFingerprint: 'runtime-old' },
      }),
    ];
    setFilter((r) => r.commitSha === 'head-of-main' && r.status !== 'failed');

    const result = await builder.ensureBuildForLatestCommit(
      { projectId: PROJECT_ID, repoUrl: 'r', defaultBranch: BRANCH, manifestPath: 'm' },
      { branch: BRANCH, accountId: ACCOUNT_ID, source: 'manual' },
    );
    expect(result.status).toBe('started');
    expect(result.commitSha).toBe('head-of-main');
  });

  test('starts a rebuild when the ready DB row is missing from Daytona', async () => {
    rows = [
      makeRow({
        commitSha: 'head-of-main',
        status: 'ready',
        snapshotId: 'kortix-snap-1111-missing',
      }),
    ];
    hiddenDaytonaSnapshots = new Set(['kortix-snap-1111-missing']);
    setFilter((r) => r.commitSha === 'head-of-main' && r.status !== 'failed');

    const result = await builder.ensureBuildForLatestCommit(
      { projectId: PROJECT_ID, repoUrl: 'r', defaultBranch: BRANCH, manifestPath: 'm' },
      { branch: BRANCH, accountId: ACCOUNT_ID, source: 'session-start' },
    );
    expect(result.status).toBe('started');
    expect(result.commitSha).toBe('head-of-main');
  });

  test('returns started when no row exists for the head commit', async () => {
    rows = []; // No existing row.
    setFilter(() => false); // Nothing matches the lookup.

    const result = await builder.ensureBuildForLatestCommit(
      { projectId: PROJECT_ID, repoUrl: 'r', defaultBranch: BRANCH, manifestPath: 'm' },
      { branch: BRANCH, accountId: ACCOUNT_ID, source: 'project-create' },
    );
    expect(result.status).toBe('started');
    expect(result.commitSha).toBe('head-of-main');
  });
});

describe('pruneOldSnapshots', () => {
  test('keeps the N most recent ready rows and deletes the rest', async () => {
    const baseDate = new Date(2026, 0, 1).getTime();
    rows = Array.from({ length: 8 }, (_, i) =>
      makeRow({
        snapshotRowId: `row-${i}`,
        commitSha: `c${i}`,
        snapshotId: `kortix-snap-1111-c${i}`,
        status: 'ready',
        createdAt: new Date(baseDate + i * 86400_000),
      }),
    );
    // Query 1 enumerates ready rows; queries 2..N are the per-snapshotId
    // reference checks — each must return 0 surviving refs so the
    // Daytona delete fires for all 3 expired snapshots.
    setFilterSequence(
      (r) => r.projectId === PROJECT_ID && r.branch === BRANCH && r.provider === 'daytona' && r.status === 'ready',
      () => false,
      () => false,
      () => false,
    );
    setSort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const result = await builder.pruneOldSnapshots(PROJECT_ID, BRANCH, 'daytona', 5);

    // 8 ready rows, retain 5 → 3 expired.
    expect(result.deletedRows).toBe(3);
    // No other branches reference these snapshotIds → all 3 deleted from Daytona.
    expect(result.deletedDaytonaSnapshots).toBe(3);
    expect(daytonaDeleteCalls).toHaveLength(3);
  });

  test('no-op when row count is at or below the retention limit', async () => {
    rows = Array.from({ length: 3 }, (_, i) =>
      makeRow({ snapshotRowId: `r${i}`, status: 'ready' }),
    );
    setFilter((r) => r.status === 'ready');
    setSort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const result = await builder.pruneOldSnapshots(PROJECT_ID, BRANCH, 'daytona', 5);

    expect(result.deletedRows).toBe(0);
    expect(daytonaDeleteCalls).toHaveLength(0);
  });

  test('preserves Daytona snapshot when another DB row still references it (cross-branch dedupe)', async () => {
    // Two branches built identical Dockerfiles → same snapshotId.
    const SHARED = 'kortix-snap-1111-shared';
    rows = [
      // Main branch: 6 ready rows, the oldest two share `SHARED` with the
      // feature-branch row below.
      ...Array.from({ length: 6 }, (_, i) =>
        makeRow({
          snapshotRowId: `m${i}`,
          commitSha: `cm${i}`,
          snapshotId: i < 2 ? SHARED : `kortix-snap-1111-cm${i}`,
          status: 'ready',
          branch: BRANCH,
          createdAt: new Date(2026, 0, i + 1),
        }),
      ),
      // Feature branch retains a row pointing to SHARED — pruning main
      // must NOT delete the Daytona snapshot or the feature branch's
      // session boot would break.
      makeRow({
        snapshotRowId: 'feature-keep',
        branch: 'feature',
        commitSha: 'cf1',
        snapshotId: SHARED,
        status: 'ready',
      }),
    ];

    // pruneOldSnapshots issues two distinct selects:
    //   1) enumerate ready rows for (PROJECT, 'main', 'daytona')
    //   2) for each unique expired snapshotId, check if any surviving
    //      row still references it (any branch in the project)
    // Use setFilterSequence to drive each query independently.
    setFilterSequence(
      // Query 1: ready rows on main.
      (r) => r.projectId === PROJECT_ID && r.branch === BRANCH && r.provider === 'daytona' && r.status === 'ready',
      // Query 2: any row in project that references SHARED.
      (r) => r.projectId === PROJECT_ID && r.provider === 'daytona' && r.snapshotId === SHARED,
    );
    setSort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const result = await builder.pruneOldSnapshots(PROJECT_ID, BRANCH, 'daytona', 5);

    // 6 ready on main, retain 5 → 1 expired DB row.
    expect(result.deletedRows).toBe(1);
    // That expired row's snapshotId is still referenced by the feature
    // branch row → Daytona delete must NOT be called.
    expect(result.deletedDaytonaSnapshots).toBe(0);
    expect(daytonaDeleteCalls).toHaveLength(0);
  });
});

describe('reconcileDaytonaSnapshots', () => {
  test('does not delete provider snapshots referenced by in-progress DB rows', async () => {
    rows = [
      makeRow({
        snapshotRowId: 'building-row',
        commitSha: 'head-of-main',
        snapshotId: 'kortix-snap-1111-building',
        status: 'building',
        metadata: { runtimeFingerprint: 'runtime-current' },
      }),
    ];
    setFilter(() => true);

    const result = await builder.reconcileDaytonaSnapshots();

    expect(result.orphansDeleted).toBe(0);
    expect(result.deadRowsCleared).toBe(0);
    expect(daytonaDeleteByIdCalls).toHaveLength(0);
  });

  test('keeps ready rows omitted from the Daytona list when get-by-name is still active', async () => {
    rows = [
      makeRow({
        snapshotRowId: 'ready-row',
        snapshotId: 'kortix-snap-1111-list-omitted',
        status: 'ready',
        metadata: { runtimeFingerprint: 'runtime-current' },
      }),
    ];
    omittedFromDaytonaList = new Set(['kortix-snap-1111-list-omitted']);
    setFilter(() => true);

    const result = await builder.reconcileDaytonaSnapshots();

    expect(result.deadRowsCleared).toBe(0);
    expect(result.evicted).toBe(0);
    expect(daytonaDeleteByIdCalls).toHaveLength(0);
  });
});

describe('getProjectSandboxHealth', () => {
  const allForBranch = (r: Row) =>
    r.projectId === PROJECT_ID && r.branch === BRANCH && r.provider === 'daytona';

  test('first build: only a building row, no ready snapshot ever', async () => {
    // Fresh updatedAt so the in-flight build isn't treated as a stale orphan.
    rows = [makeRow({ snapshotRowId: 'b', status: 'building', metadata: {}, updatedAt: new Date() })];
    setFilter(allForBranch);
    setSort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const h = await builder.getProjectSandboxHealth(PROJECT_ID, BRANCH);
    expect(h.firstBuild).toBe(true);
    expect(h.healthy).toBe(false);
    expect(h.building).toBe(true);
    expect(h.readyCount).toBe(0);
  });

  test('existing ready snapshot rebuilding in place reads as healthy + updating, NOT first build', async () => {
    // Non-destructive rebuild: row stays `ready` (old runtime) with a
    // rebuildStartedAt marker. Must not regress to "building first sandbox".
    rows = [
      makeRow({
        snapshotRowId: 'ready-rebuilding',
        status: 'ready',
        snapshotId: 'snap-old',
        metadata: { runtimeFingerprint: 'runtime-old', rebuildStartedAt: Date.now() },
        createdAt: new Date(2026, 0, 3),
      }),
    ];
    setFilter(allForBranch);
    setSort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const h = await builder.getProjectSandboxHealth(PROJECT_ID, BRANCH);
    expect(h.firstBuild).toBe(false);
    expect(h.healthy).toBe(true);
    expect(h.readyCount).toBe(1);
    expect(h.bootableCount).toBe(0); // old runtime → needs a rebuild to boot HEAD
    expect(h.runtimeOutdated).toBe(true);
    expect(h.building).toBe(true); // rebuildStartedAt marker surfaces as building
  });

  test('current-runtime ready snapshot is bootable + healthy', async () => {
    rows = [
      makeRow({ snapshotRowId: 'r', status: 'ready', metadata: { runtimeFingerprint: 'runtime-current' } }),
    ];
    setFilter(allForBranch);
    setSort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const h = await builder.getProjectSandboxHealth(PROJECT_ID, BRANCH);
    expect(h.healthy).toBe(true);
    expect(h.bootableCount).toBe(1);
    expect(h.runtimeOutdated).toBe(false);
    expect(h.firstBuild).toBe(false);
  });

  test('failed latest build with no ready snapshot surfaces a failure', async () => {
    rows = [
      makeRow({
        snapshotRowId: 'f',
        status: 'failed',
        snapshotId: null,
        error: 'failed to solve: exit code: 1',
        metadata: { errorCategory: 'dockerfile' },
        createdAt: new Date(2026, 0, 4),
      }),
    ];
    setFilter(allForBranch);
    setSort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const h = await builder.getProjectSandboxHealth(PROJECT_ID, BRANCH);
    expect(h.failure?.category).toBe('dockerfile');
    expect(h.failure?.fixableByAgent).toBe(true);
    expect(h.healthy).toBe(false);
    expect(h.readyCount).toBe(0);
  });
});
