import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { projectSessions, sessionSandboxes } from '@kortix/db';

let sandboxCandidates: any[] = [];
let branchCandidates: any[] = [];
let providerStops: string[] = [];
let cacheInvalidations: string[] = [];
let branchDeletes: string[] = [];
let updateCalls: Array<{ table: unknown; updates: Record<string, unknown> }> = [];
const fakeConfig = { KORTIX_SANDBOX_AUTOSTOP_MINUTES: 15 };

mock.module('../config', () => ({
  config: fakeConfig,
  SANDBOX_VERSION: 'test',
  KORTIX_MARKUP: 1,
  PLATFORM_FEE_MARKUP: 0,
  getToolCost: () => 0,
}));

const fakeDb = {
  select: () => ({
    from: (table: unknown) => ({
      where: () => ({
        limit: async () => {
          if (table === sessionSandboxes) return sandboxCandidates;
          return [];
        },
      }),
      innerJoin: () => ({
        where: () => ({
          limit: async () => branchCandidates,
        }),
      }),
    }),
  }),
  update: (table: unknown) => ({
    set: (updates: Record<string, unknown>) => ({
      where: async () => {
        updateCalls.push({ table, updates });
      },
    }),
  }),
};

mock.module('../shared/db', () => ({
  hasDatabase: true,
  db: fakeDb,
}));

mock.module('../shared/effect', () => ({
  sharedConfig: fakeConfig,
  sharedDb: fakeDb,
  sharedSupabase: {},
  sharedFetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
  sharedSleep: async () => {},
  runSharedTimeout: () => ({}) as never,
  runSharedInterval: () => ({}) as never,
  stopSharedTimer: () => {},
}));

mock.module('../platform/providers', () => ({
  WarmRuntimeUnavailableError: class WarmRuntimeUnavailableError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'WarmRuntimeUnavailableError';
    }
  },
  getProvider: () => ({
    stop: async (externalId: string) => {
      providerStops.push(externalId);
    },
  }),
}));

mock.module('../sandbox-proxy', () => ({
  invalidateProviderCache: (externalId: string) => {
    cacheInvalidations.push(externalId);
  },
}));

mock.module('../projects/git', () => ({
  grepRepoFiles: async () => [],
  searchRepoFileNames: async () => [],
  archiveRepoSubtree: async () => undefined,
  deleteRemoteSessionBranch: async (_project: unknown, branchName: string) => {
    branchDeletes.push(branchName);
    return true;
  },
  createRemoteSessionBranch: async () => undefined,
  listRepoFiles: async () => [],
  loadProjectConfig: async () => ({}),
  readRepoFile: async () => '',
  listBranches: async () => [],
  listCommits: async () => ({ entries: [], nextCursor: null }),
  getCommit: async () => null,
  getCommitDiff: async () => null,
  getFileHistory: async () => ({ entries: [], nextCursor: null }),
  getFileAtRef: async () => null,
  resolveCommitSha: async () => 'a'.repeat(40),
  resolveTreeOid: async () => 'b'.repeat(40),
  materializeRepoContext: async () => '/tmp/fake-snapshot-context',
  resolveBranchTip: async () => 'a'.repeat(40),
  getBranchDiff: async () => ({ files: [], diff: '' }),
  getDiffBetweenShas: async () => ({ files: [], diff: '' }),
  previewMerge: async () => ({ canMerge: true, conflicts: [] }),
  mergeBranches: async () => ({ mergedSha: 'a'.repeat(40) }),
  commitFileToBranch: async () => ({ commitSha: 'a'.repeat(40) }),
  getMergeBase: async () => 'a'.repeat(40),
  diffStat: async () => ({ files: [], additions: 0, deletions: 0 }),
  invalidateProjectMirror: () => {},
}));

mock.module('../billing/services/compute-metering', () => ({
  tickRunningComputeCharges: async () => ({ settled: 0 }),
}));

mock.module('../snapshots/builder', () => ({
  reconcileStaleBuilds: async () => ({ checked: 0, closedReady: 0, closedFailed: 0 }),
}));

mock.module('../snapshots/quota-gc', () => ({
  reconcileSnapshotQuota: async () => ({ namespaceCount: 0, eligible: 0, deleted: 0, dryRun: false }),
}));

mock.module('../projects/sandbox-reaper', () => ({
  reapAndReconcileSandboxes: async () => ({
    candidates: 0,
    stopped: 0,
    reconciled: 0,
    billingClosed: 0,
    skipped: 0,
    errors: 0,
  }),
  reconcileOrphanComputeSessions: async () => ({ checked: 0, closed: 0, errors: 0 }),
  reconcileStuckActiveSessions: async () => ({ candidates: 0, reconciled: 0, billingClosed: 0, errors: 0 }),
  reapOrphanProviderBoxes: async () => ({ listed: 0, orphans: 0, stopped: 0, errors: 0 }),
  countBillingInvariantViolations: async () => 0,
}));

const {
  hasOpenPullRequestMarker,
  postgresTimestampParam,
  sweepExpiredSessionBranches,
} = await import('../projects/maintenance');

beforeEach(() => {
  sandboxCandidates = [];
  branchCandidates = [];
  providerStops = [];
  cacheInvalidations = [];
  branchDeletes = [];
  updateCalls = [];
  process.env.KORTIX_SANDBOX_IDLE_TTL = '3600000';
  process.env.KORTIX_BRANCH_RETENTION_DAYS = '90';
});

describe('project maintenance', () => {
  test('detects open PR metadata before branch GC', () => {
    expect(hasOpenPullRequestMarker({ open_pr: true })).toBe(true);
    expect(hasOpenPullRequestMarker({ pull_request: { state: 'open' } })).toBe(true);
    expect(hasOpenPullRequestMarker({ github_pull_request: { state: 'closed' } })).toBe(false);
    expect(hasOpenPullRequestMarker({})).toBe(false);
  });

  test('formats raw SQL timestamp parameters as strings', () => {
    expect(postgresTimestampParam(new Date('2026-05-15T21:08:13.000Z')))
      .toBe('2026-05-15T21:08:13.000Z');
  });

  test('deletes expired session branches and records branch GC metadata', async () => {
    branchCandidates = [
      {
        sessionId: 'session-old',
        branchName: 'session-old',
        baseRef: 'main',
        metadata: { existing: true },
        projectId: '00000000-0000-4000-a000-000000000201',
        repoUrl: 'https://github.com/kortix-ai/project.git',
        defaultBranch: 'main',
        manifestPath: 'kortix.toml',
      },
      {
        sessionId: 'session-pr',
        branchName: 'session-pr',
        baseRef: 'main',
        metadata: { pull_request: { state: 'open' } },
        projectId: '00000000-0000-4000-a000-000000000201',
        repoUrl: 'https://github.com/kortix-ai/project.git',
        defaultBranch: 'main',
        manifestPath: 'kortix.toml',
      },
    ];

    const now = new Date('2026-05-15T00:00:00Z');
    const result = await sweepExpiredSessionBranches(now);

    expect(result).toEqual({ candidates: 2, deleted: 1, skipped: 1, errors: 0 });
    expect(branchDeletes).toEqual(['session-old']);

    const sessionUpdate = updateCalls.find((call) => call.table === projectSessions);
    expect(sessionUpdate?.updates.metadata).toEqual({
      existing: true,
      branch_gc: {
        deleted_at: now.toISOString(),
        branch_name: 'session-old',
        remote_deleted: true,
      },
    });
  });
});
