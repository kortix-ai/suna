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
 *   2. When no `ready` snapshot exists, the session is marked `error`
 *      with the explicit "still building" message — no provider create
 *      is ever attempted, no env-var name is plumbed through.
 *
 *   3. The fire-and-forget `ensureBuildForLatestCommit` always runs, so
 *      the next session attempt sees the new commit once it lands.
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
let ensureBuildCalls: any[] = [];

mock.module('../shared/db', () => ({
  db: {
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
  ensureBuildForLatestCommit: async (project: any, opts: any) => {
    ensureBuildCalls.push({ projectId: project.projectId, branch: opts.branch, source: opts.source });
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
  ensureBuildCalls = [];
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
    expect(ensureBuildCalls).toHaveLength(1);
    expect(ensureBuildCalls[0].source).toBe('session-start');
  });

  test('fails the session with explicit message when no ready snapshot exists (no fallback)', async () => {
    latestReadyResult = null;

    await callProvision();
    await flush();

    expect(providerCreateCalls).toHaveLength(0);
    expect(sessionStatus.status).toBe('error');
    const lastError = sessionStatus.metadata?.lastError ?? '';
    expect(lastError).toContain('still building');
    // ensureBuildForLatestCommit must still run so the user's *next*
    // attempt finds a ready snapshot (or at least a building one).
    expect(ensureBuildCalls).toHaveLength(1);
  });
});
