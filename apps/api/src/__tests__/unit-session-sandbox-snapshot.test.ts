/**
 * Pins the "no DAYTONA_SNAPSHOT fallback" contract for session-sandbox.
 *
 * The provisioning IIFE used to fall back to `config.DAYTONA_SNAPSHOT`
 * when the per-project builder threw, which silently shipped sandboxes
 * built off the wrong image. The user's instruction is "it should never
 * ever ever do that." This test guards that:
 *
 *   1. When a `ready` snapshot exists for the project's default branch,
 *      session boot uses *that* snapshot id (not any env-derived name).
 *
 *   2. When no `ready` snapshot exists, provisioning starts or joins the
 *      project snapshot build and waits for a ready image instead of failing
 *      immediately.
 *
 *   3. If the snapshot still does not become ready inside the wait budget,
 *      the session is marked `error` with the explicit "still building"
 *      message — no provider create is attempted, no env-var fallback is used.
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { projectSessions, sessionSandboxes } from '@kortix/db';

const SANDBOX_ID = '11111111-2222-4222-8222-222222222222';
const PROJECT_ID = '11111111-2222-4222-8222-333333333333';
const ACCOUNT_ID = '11111111-2222-4222-8222-444444444444';
const USER_ID = '11111111-2222-4222-8222-555555555555';

let providerCreateCalls: any[] = [];
let providerRemoveCalls: any[] = [];
let sandboxRow: any = null;
let sessionStatus: { status: string; error?: string | null; metadata?: any } = { status: 'provisioning' };
let projectSessionStatus: { status: string; error?: string | null } = { status: 'provisioning' };
let latestReadyResult: { snapshotId: string | null; commitSha: string } | null = null;
let readyForCommitResult: { snapshotId: string | null; commitSha: string } | null = null;
let ensureBuildCalls: any[] = [];
let completeBuildOnEnsure = false;

process.env.KORTIX_SESSION_SNAPSHOT_READY_WAIT_MS = '1';
process.env.KORTIX_SESSION_SNAPSHOT_READY_POLL_MS = '1';

mock.module('../shared/db', () => ({
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            if (table === projectSessions) return [projectSessionStatus];
            return [];
          },
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: any) => ({
        returning: async () => {
          if (table === sessionSandboxes) {
            sandboxRow = { ...values };
            return [sandboxRow];
          }
          return [];
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (patch: any) => ({
        where: async () => {
          if (table === sessionSandboxes) {
            sessionStatus = {
              status: patch.status ?? sessionStatus.status,
              error: patch.error ?? sessionStatus.error,
              metadata: patch.metadata ?? sessionStatus.metadata,
            };
            if (sandboxRow) Object.assign(sandboxRow, patch);
          } else if (table === projectSessions) {
            projectSessionStatus = {
              status: patch.status ?? projectSessionStatus.status,
              error: patch.error ?? projectSessionStatus.error,
            };
          }
        },
      }),
    }),
  },
}));

mock.module('../repositories/api-keys', () => ({
  createApiKey: async () => ({ secretKey: 'fake-token', apiKey: { keyId: 'k1' } }),
}));

mock.module('../repositories/account-tokens', () => ({
  createAccountToken: async () => ({ secretKey: 'fake-executor-token', token: { tokenId: 'executor-token-1' } }),
}));

mock.module('../platform/providers', () => {
  const fakeProvider = {
    name: 'daytona',
    provisioning: { async: false, stages: [{ id: 'creating', progress: 50, message: '...' }] },
    create: async (opts: any) => {
      providerCreateCalls.push(opts);
      return { externalId: 'ext-1', baseUrl: 'http://fake', metadata: {} };
    },
    remove: async (id: string) => { providerRemoveCalls.push(id); },
    start: async () => {},
    stop: async () => {},
    getStatus: async () => 'running',
    getProvisioningStatus: async () => null,
    resolveEndpoint: async () => ({ url: '', headers: {} }),
    ensureRunning: async () => {},
  };
  return {
    getProvider: () => fakeProvider,
  };
});

mock.module('../snapshots/builder', () => ({
  getLatestReadySnapshot: async () => latestReadyResult,
  getReadySnapshotForCommit: async () => readyForCommitResult,
  getSnapshotForCommit: async () => null,
  ensureBuildForLatestCommit: async (project: any, opts: any) => {
    ensureBuildCalls.push({ projectId: project.projectId, branch: opts.branch, source: opts.source });
    if (completeBuildOnEnsure) {
      readyForCommitResult = {
        snapshotId: 'kortix-snap-built-after-wait',
        commitSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      };
    }
    return { status: 'started', commitSha: 'aaaaaaaa' };
  },
}));

mock.module('../config', () => ({
  config: {
    getDefaultProvider: () => 'daytona' as const,
    // Intentionally no DAYTONA_SNAPSHOT — if any code path tries to read
    // it, the test will catch the regression immediately.
  },
}));

mock.module('../platform/services/sandbox-init-state', () => ({
  buildSandboxInitAttemptMetadata: (meta: any) => ({ ...(meta ?? {}), initStatus: 'attempt' }),
  buildSandboxInitFailureMetadata: (meta: any, err: any) => ({
    ...(meta ?? {}),
    initStatus: 'failed',
    lastError: (err as Error).message,
  }),
  buildSandboxInitSuccessMetadata: (meta: any) => ({ ...(meta ?? {}), initStatus: 'ready' }),
  retrySandboxProvisionCreate: async (provider: any, input: any, callbacks: any) => {
    await callbacks.onAttemptStart?.(1);
    const result = await provider.create(input);
    return { result, attempts: 1 };
  },
  SANDBOX_INIT_MAX_ATTEMPTS: 3,
}));

// Drain microtasks until the fire-and-forget IIFE settles.
async function flush() {
  for (let i = 0; i < 25; i += 1) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

const { provisionSessionSandbox } = await import('../platform/services/session-sandbox');

function callProvision() {
  return provisionSessionSandbox({
    sandboxId: SANDBOX_ID,
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    userId: USER_ID,
    provider: 'daytona',
    extraEnvVars: {},
    gitProject: {
      projectId: PROJECT_ID,
      repoUrl: 'https://github.com/o/r.git',
      defaultBranch: 'main',
      manifestPath: 'kortix.toml',
      gitAuthToken: 'fake-gh-token',
    },
    baseRef: 'main',
  });
}

beforeEach(() => {
  providerCreateCalls = [];
  providerRemoveCalls = [];
  sandboxRow = null;
  sessionStatus = { status: 'provisioning' };
  projectSessionStatus = { status: 'provisioning' };
  latestReadyResult = null;
  readyForCommitResult = null;
  ensureBuildCalls = [];
  completeBuildOnEnsure = false;
});

describe('provisionSessionSandbox snapshot resolution', () => {
  test('boots from latest ready snapshot when one exists; never reads any env var', async () => {
    latestReadyResult = {
      snapshotId: 'kortix-snap-aaaa-1234567890ab',
      commitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    };

    await callProvision();
    await flush();

    expect(providerCreateCalls).toHaveLength(1);
    expect(providerCreateCalls[0].snapshot).toBe('kortix-snap-aaaa-1234567890ab');
    expect(providerCreateCalls[0].envVars).toMatchObject({
      KORTIX_TOKEN: 'fake-token',
      KORTIX_EXECUTOR_TOKEN: 'fake-executor-token',
    });
    expect(ensureBuildCalls).toHaveLength(1);
    expect(ensureBuildCalls[0].source).toBe('session-start');
  });

  test('boots from a ready commit snapshot even when the branch row is absent', async () => {
    latestReadyResult = null;
    readyForCommitResult = {
      snapshotId: 'kortix-snap-feature-commit-built-on-main',
      commitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    };

    await callProvision();
    await flush();

    expect(providerCreateCalls).toHaveLength(1);
    expect(providerCreateCalls[0].snapshot).toBe('kortix-snap-feature-commit-built-on-main');
    expect(projectSessionStatus.status).toBe('running');
  });

  test('waits for a snapshot kicked by ensureBuildForLatestCommit before provider create', async () => {
    latestReadyResult = null;
    completeBuildOnEnsure = true;

    await callProvision();
    await flush();

    expect(ensureBuildCalls).toHaveLength(1);
    expect(providerCreateCalls).toHaveLength(1);
    expect(providerCreateCalls[0].snapshot).toBe('kortix-snap-built-after-wait');
    expect(projectSessionStatus.status).toBe('running');
  });

  test('fails the session with explicit message when no ready snapshot appears (no fallback)', async () => {
    latestReadyResult = null;

    await callProvision();
    await flush();

    expect(providerCreateCalls).toHaveLength(0);
    expect(sessionStatus.status).toBe('error');
    const lastError = sessionStatus.metadata?.lastError ?? '';
    expect(lastError).toContain('still building');
    expect(ensureBuildCalls).toHaveLength(1);
  });
});
