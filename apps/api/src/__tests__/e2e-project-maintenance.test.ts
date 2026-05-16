import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { projectSessions, sessionSandboxes } from '@kortix/db';

let sandboxCandidates: any[] = [];
let branchCandidates: any[] = [];
let providerStops: string[] = [];
let cacheInvalidations: string[] = [];
let branchDeletes: string[] = [];
let updateCalls: Array<{ table: unknown; updates: Record<string, unknown> }> = [];

mock.module('../shared/db', () => ({
  db: {
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
  },
}));

mock.module('../platform/providers', () => ({
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
  deleteRemoteSessionBranch: async (_project: unknown, branchName: string) => {
    branchDeletes.push(branchName);
    return true;
  },
}));

const {
  hasOpenPullRequestMarker,
  hibernateIdleSessionSandboxes,
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

  test('hibernates idle Daytona sandboxes and skips local Docker', async () => {
    sandboxCandidates = [
      {
        sandboxId: '00000000-0000-4000-a000-000000000001',
        sessionId: 'session-daytona',
        accountId: '00000000-0000-4000-a000-000000000101',
        provider: 'daytona',
        externalId: 'daytona-external-1',
      },
      {
        sandboxId: '00000000-0000-4000-a000-000000000002',
        sessionId: 'session-local',
        accountId: '00000000-0000-4000-a000-000000000101',
        provider: 'local_docker',
        externalId: 'local-external-1',
      },
    ];

    const result = await hibernateIdleSessionSandboxes(new Date('2026-05-15T00:00:00Z'));

    expect(result).toEqual({ candidates: 2, stopped: 1, skipped: 1, errors: 0 });
    expect(providerStops).toEqual(['daytona-external-1']);
    expect(cacheInvalidations).toEqual(['daytona-external-1']);
    expect(updateCalls.some((call) =>
      call.table === sessionSandboxes && call.updates.status === 'stopped',
    )).toBe(true);
    expect(updateCalls.some((call) =>
      call.table === projectSessions && call.updates.status === 'stopped',
    )).toBe(true);
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
