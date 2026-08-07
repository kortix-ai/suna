// Unit test for the session-resurrection race fix in provisionSessionSandbox.
//
// Background: provisioning runs in a detached (fire-and-forget) IIFE. Before
// this fix, the finish-of-provisioning writes were unconditional: if a user
// deleted the session while the box was still being created, deleteSession()
// would flip session_sandboxes to 'archived' and project_sessions to
// 'stopped' — but the still-running provisioning IIFE would later land its
// "success" writes anyway, flipping project_sessions BACK to 'running' and
// opening a compute-metering row for a session the user just deleted.
//
// The fix makes both finish-of-provisioning writes conditional:
//   1. session_sandboxes finish update: WHERE status != 'archived' RETURNING.
//      No row back → the session was deleted mid-provision: remove the
//      just-created provider box and stop (no flip, no metering).
//   2. project_sessions status flip: WHERE status IN (queued, branching,
//      provisioning) — never clobbers a 'stopped' (deleted, or explicitly
//      stopped) or already-'running' (won by the separate stopped→running
//      resume path in routes/shared.ts) session.
//
// This test drives the REAL provisionSessionSandbox with every external
// dependency mocked (provider, snapshot builder, token minting, billing,
// LLM-gateway entitlement) so it can run fully offline, deterministic, and
// fast. The DB is a lightweight fake that records every update() call and
// compiles its WHERE condition to real SQL text via drizzle's PgDialect (no
// live Postgres needed) so the test asserts on the actual guard clauses, not
// just on the mock's own bookkeeping.
//
// Run this file in its own `bun test <file>` invocation (as CI does per
// file). `provisionSessionSandbox` and its dependencies (providers, billing,
// snapshot builder) are heavily mocked here; other suites mock the SAME
// resolved modules with different shapes (or exercise the real ones), and
// `bun:test`'s `mock.module` + ES module cache are process-global rather than
// file-scoped — batching many files into one `bun test a b c...` invocation
// can leak mocks/cached module instances across files. See the same caveat
// documented in ../../projects/sandbox-reaper.test.ts.
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { projectSessions, sessionSandboxes } from '@kortix/db';
import { PgDialect } from 'drizzle-orm/pg-core';
import { PROVISIONING_SESSION_STATUSES } from '../../projects/lib/session-status';
import * as realProviders from '../providers';
import * as realComputeMetering from '../../billing/services/compute-metering';

const dialect = new PgDialect();

const SANDBOX_ID = '00000000-0000-4000-a000-00000000a001';
const ACCOUNT_ID = '00000000-0000-4000-a000-00000000a002';
const PROJECT_ID = '00000000-0000-4000-a000-00000000a003';
const USER_ID = '00000000-0000-4000-a000-00000000a004';
const EXTERNAL_ID = 'ext-daytona-1';

// ── mutable test state, reset in beforeEach ─────────────────────────────────
let updateCalls: Array<{
  table: unknown;
  updates: Record<string, unknown>;
  sql: string;
  params: unknown[];
}> = [];
let scenario: {
  archiveBeforeFinish: boolean;
  projectSessionStatusAtCheck: string;
  projectSessionMetadataAtCheck: Record<string, unknown>;
} = {
  archiveBeforeFinish: false,
  projectSessionStatusAtCheck: 'provisioning',
  projectSessionMetadataAtCheck: {},
};
let removedIds: string[] = [];
let stoppedIds: string[] = [];
let onRemoved: (() => void) | null = null;
let computeSessionsOpened: Array<{ sandboxId: string; accountId: string }> = [];
let onComputeOpened: (() => void) | null = null;
let recordedEvents: Array<{ outcome: string }> = [];
let identityConflict = false;
let recoveryPlaceholder = false;
let providerCreateCalls = 0;
let providerFallbackEnabled = false;
let providerNamesRequested: string[] = [];
let providerCreateErrors: Record<string, string | undefined> = {};
let imageRequests: Array<Record<string, unknown>> = [];
let accountTokenCreateCalls: Array<Record<string, unknown>> = [];
let serviceAccountCreateCalls: Array<Record<string, unknown>> = [];

function compile(condition: unknown): { sql: string; params: unknown[] } {
  try {
    return dialect.sqlToQuery(condition as Parameters<typeof dialect.sqlToQuery>[0]);
  } catch {
    return { sql: '', params: [] };
  }
}

// A resolved Promise with `.returning()` bolted on so it satisfies both the
// plain-await + `.catch()` call sites and the `.returning()` call sites drizzle
// query builders support.
function updateResult(rows: unknown[]) {
  const p = Promise.resolve(undefined) as Promise<undefined> & {
    returning: () => Promise<unknown[]>;
  };
  p.returning = async () => rows;
  return p;
}

mock.module('../../config', () => ({
  config: {
    ALLOWED_SANDBOX_PROVIDERS: ['daytona', 'e2b'],
    KORTIX_URL: 'http://localhost:8008',
    LLM_GATEWAY_PROXY_PORT: undefined,
    LLM_GATEWAY_PROXY_TARGET: undefined,
    LLM_GATEWAY_BASE_URL: undefined,
  },
}));

mock.module('../../shared/db', () => ({
  db: {
    insert: (table: unknown) => ({
      values: (v: Record<string, unknown>) => {
        const result = {
          returning: async () => (identityConflict && table === sessionSandboxes ? [] : [{ ...v }]),
          onConflictDoNothing: () => result,
        };
        return result;
      },
    }),
    select: (_proj: unknown) => ({
      from: (table: unknown) => ({
        where: (_cond: unknown) => ({
          limit: async (_n: number) => {
            if (table === projectSessions) {
              return [{
                status: scenario.projectSessionStatusAtCheck,
                metadata: scenario.projectSessionMetadataAtCheck,
              }];
            }
            return [];
          },
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (updates: Record<string, unknown>) => ({
        where: (condition: unknown) => {
          const { sql, params } = compile(condition);
          updateCalls.push({ table, updates, sql, params });
          const isSessionSandboxesFinish =
            table === sessionSandboxes && 'externalId' in updates && 'config' in updates;
          if (isSessionSandboxesFinish) {
            return updateResult(scenario.archiveBeforeFinish ? [] : [{ sandboxId: SANDBOX_ID }]);
          }
          const isRecoveryClaim =
            table === sessionSandboxes &&
            updates.provider === 'daytona' &&
            updates.status === 'provisioning' &&
            'config' in updates;
          if (isRecoveryClaim) {
            const claimed = recoveryPlaceholder;
            recoveryPlaceholder = false;
            return updateResult(
              claimed
                ? [{
                    sandboxId: SANDBOX_ID,
                    sessionId: SANDBOX_ID,
                    accountId: ACCOUNT_ID,
                    projectId: PROJECT_ID,
                    provider: 'daytona',
                    externalId: null,
                    status: 'provisioning',
                    baseUrl: null,
                    config: {},
                    metadata: { identityRecoveryAuthorizedAt: new Date().toISOString() },
                  }]
                : [],
            );
          }
          return updateResult([{ ok: true }]);
        },
      }),
    }),
  },
}));

// Spread the real module: `mock.module` replaces it WHOLESALE, so a stub that
// lists exports by hand deletes every export it omits — the failure surfaces in
// whatever unrelated file imports the missing name next, attributed to no test.
mock.module('../providers', () => ({
  ...realProviders,
  getProvider: (name: string) => {
    providerNamesRequested.push(name);
    return {
    name,
    provisioning: { async: true, stages: [{ id: 'boot', progress: 50, message: 'Booting…' }] },
    create: async (_opts: unknown) => {
      providerCreateCalls += 1;
      if (providerCreateErrors[name]) throw new Error(providerCreateErrors[name]);
      return {
        externalId: name === 'daytona' ? EXTERNAL_ID : `ext-${name}-1`,
        baseUrl: 'https://sandbox.test',
        metadata: {},
      };
    },
    remove: async (externalId: string) => {
      removedIds.push(externalId);
      onRemoved?.();
    },
    start: async () => {},
    stop: async (externalId: string) => {
      stoppedIds.push(externalId);
    },
    getStatus: async () => 'running',
    resolveEndpoint: async () => ({ url: '', headers: {} }),
    resolveProxyEndpoint: async () => ({ url: '', headers: {} }),
  }},
  WarmRuntimeUnavailableError: class WarmRuntimeUnavailableError extends Error {},
  SandboxTemplateNotFoundError: class SandboxTemplateNotFoundError extends Error {},
}));

mock.module('./runtime-settings', () => ({
  providerFallbackSetting: () => ({ enabled: providerFallbackEnabled }),
}));

mock.module('./provider-balancer', () => ({
  selectProvider: async () => 'e2b',
}));

mock.module('../../snapshots/builder', () => ({
  DEFAULT_SANDBOX_SLUG: 'default',
  ensureSandboxImage: async (_gitProject: unknown, opts: Record<string, unknown>) => {
    imageRequests.push(opts);
    return {
      snapshotName: 'snap-test-1',
      slug: 'default',
      contentHash: 'hash-1',
      isDefault: true,
      built: false,
    };
  },
  ensureMetaSandboxImage: async (opts: Record<string, unknown>) => {
    imageRequests.push(opts);
    return {
      snapshotName: 'snap-meta-1',
      slug: 'meta',
      contentHash: 'meta-hash-1',
      isDefault: false,
      built: false,
    };
  },
  deleteSandboxImage: async () => {},
  resolveTemplate: async (_project: unknown, _slug: unknown) => ({}),
}));

let onProviderEvent: (() => void) | null = null;
mock.module('./provider-events', () => ({
  recordProviderEvent: (e: { outcome: string }) => {
    recordedEvents.push(e);
    onProviderEvent?.();
  },
}));

// Spread the real module: `mock.module` replaces it WHOLESALE, so a stub that
// lists exports by hand deletes every export it omits — the failure surfaces in
// whatever unrelated file imports the missing name next, attributed to no test.
mock.module('../../billing/services/compute-metering', () => ({
  ...realComputeMetering,
  startComputeSession: async (input: { sandboxId: string; accountId: string; provider: string }) => {
    computeSessionsOpened.push(input);
    onComputeOpened?.();
  },
}));

mock.module('../../repositories/api-keys', () => ({
  createApiKey: async (_opts: unknown) => ({ secretKey: 'sbx-key-1' }),
}));

mock.module('../../repositories/account-tokens', () => ({
  createAccountToken: async (opts: Record<string, unknown>) => {
    accountTokenCreateCalls.push(opts);
    return { secretKey: 'exec-tok-1' };
  },
}));

mock.module('../../repositories/service-accounts', () => ({
  ensureAgentServiceAccount: async (opts: Record<string, unknown>) => {
    serviceAccountCreateCalls.push(opts);
    return null;
  },
}));

mock.module('../../shared/account-limits', () => ({
  accountEntitledToLlmGateway: async (_accountId: string) => false,
}));

mock.module('../../projects/triggers', () => ({
  readManifest: async () => null,
}));

mock.module('../../projects/agents', () => ({
  resolveAgentGrant: async (_agentName: string, _gitProject: unknown) => null,
}));

mock.module('../../llm-gateway/enablement', () => ({
  projectLlmGatewayEnabled: (_metadata: unknown) => false,
}));

mock.module('../../shared/session-failure-notifier', () => ({
  notifySessionProvisioningFailed: async () => {},
}));

const { provisionSessionSandbox } = await import('./session-sandbox');

function waitFor(setResolver: (resolve: () => void) => void, timeoutMs = 2000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('waitFor timed out')), timeoutMs);
    setResolver(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

beforeEach(() => {
  updateCalls = [];
  scenario = {
    archiveBeforeFinish: false,
    projectSessionStatusAtCheck: 'provisioning',
    projectSessionMetadataAtCheck: {},
  };
  removedIds = [];
  stoppedIds = [];
  onRemoved = null;
  computeSessionsOpened = [];
  onComputeOpened = null;
  recordedEvents = [];
  onProviderEvent = null;
  identityConflict = false;
  recoveryPlaceholder = false;
  providerCreateCalls = 0;
  providerFallbackEnabled = false;
  providerNamesRequested = [];
  providerCreateErrors = {};
  imageRequests = [];
  accountTokenCreateCalls = [];
  serviceAccountCreateCalls = [];
});

function baseOpts() {
  return {
    sandboxId: SANDBOX_ID,
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    userId: USER_ID,
    provider: 'daytona' as const,
    gitProject: { defaultBranch: 'main' } as unknown as Parameters<
      typeof provisionSessionSandbox
    >[0]['gitProject'],
    metadata: {},
  };
}

describe('provisionSessionSandbox — mid-provision delete race', () => {
  test('meta sessions receive a bounded project grant without a standing service-account ceiling', async () => {
    await provisionSessionSandbox({
      ...baseOpts(),
      agentName: 'meta',
      sandboxSlug: 'meta',
    });

    expect(accountTokenCreateCalls).toHaveLength(1);
    expect(accountTokenCreateCalls[0]).toMatchObject({
      accountId: ACCOUNT_ID,
      userId: USER_ID,
      projectId: PROJECT_ID,
      sessionId: SANDBOX_ID,
      agentGrant: {
        agent: 'meta',
        connectors: [],
        env: [],
      },
      serviceAccountId: null,
    });
    const grant = accountTokenCreateCalls[0]?.agentGrant as { kortixCli?: unknown };
    const kortixCli = grant.kortixCli;
    expect(Array.isArray(kortixCli)).toBe(true);
    if (!Array.isArray(kortixCli)) throw new Error('meta grant must be an action allowlist');
    expect(kortixCli).toEqual([
      'project.read',
      'project.goal.read',
      'project.goal.write',
      'project.task.read',
      'project.task.write',
      'project.cr.open',
      'project.session.read',
      'project.session.start',
      'project.file.read',
      'project.gitops.read',
    ]);
    for (const forbidden of [
      'project.write',
      'project.delete',
      'project.cr.merge',
      'project.session.stop',
      'project.session.bindings.write',
      'project.members.manage',
      'project.trigger.create',
      'project.trigger.update',
      'project.trigger.delete',
      'project.gateway.keys.manage',
      'project.secret.write',
      'project.connector.write',
      'project.connector.connections.manage',
      'project.gitops.push',
      'project.gitops.merge',
      'project.review.submit',
      'project.review.act',
    ]) {
      expect(kortixCli).not.toContain(forbidden);
    }
    expect(serviceAccountCreateCalls).toHaveLength(0);
  });

  test('session starts request the OpenCode runtime image', async () => {
    const opened = waitFor((resolve) => {
      onComputeOpened = resolve;
    });

    await provisionSessionSandbox(baseOpts());
    await opened;

    expect(imageRequests[0]).toMatchObject({ source: 'session-start' });
    expect(imageRequests[0]).not.toHaveProperty('requireCurrentRuntime');
  });

  test('E2B success records only provider-neutral lifecycle metadata and E2B billing attribution', async () => {
    const opened = waitFor((resolve) => {
      onComputeOpened = resolve;
    });

    await provisionSessionSandbox({ ...baseOpts(), provider: 'e2b' });
    await opened;

    const finishCall = updateCalls.find(
      (call) => call.table === sessionSandboxes && 'externalId' in call.updates && 'config' in call.updates,
    );
    expect(finishCall?.updates.metadata).toMatchObject({
      providerExternalId: 'ext-e2b-1',
      runtimeArtifact: { provider: 'e2b', artifactType: 'e2b_template' },
    });
    expect(finishCall?.updates.metadata).not.toHaveProperty('daytonaSandboxId');
    expect(computeSessionsOpened[0]).toMatchObject({ provider: 'e2b' });
  });

  test('an explicitly selected E2B provider never fails over to another provider', async () => {
    providerFallbackEnabled = true;
    providerCreateErrors.e2b = 'E2B unavailable';
    const failed = waitFor((resolve) => {
      onProviderEvent = resolve;
    });

    await provisionSessionSandbox({ ...baseOpts(), provider: 'e2b' });
    await failed;

    expect(providerNamesRequested).toEqual(['e2b']);
    expect(providerCreateCalls).toBe(3);
    expect(
      updateCalls.some(
        (call) => call.table === sessionSandboxes && call.updates.provider === 'daytona',
      ),
    ).toBe(false);
  });

  test('capacity failure records one attempt and provider-neutral failure metadata', async () => {
    providerCreateErrors.e2b = '500: Failed to place sandbox';
    const failed = waitFor((resolve) => {
      onProviderEvent = resolve;
    });

    await provisionSessionSandbox({ ...baseOpts(), provider: 'e2b' });
    await failed;

    expect(providerCreateCalls).toBe(1);
    const terminal = updateCalls.find(
      (call) =>
        call.table === sessionSandboxes &&
        call.updates.status === 'error' &&
        (call.updates.metadata as Record<string, unknown>)?.failureCategory === 'provider-capacity',
    );
    expect(terminal?.updates.metadata).toMatchObject({
      initAttempts: 1,
      initMaxAttempts: 1,
      failureCategory: 'provider-capacity',
      errorMessage: 'The sandbox provider is at capacity right now. Try again in a minute.',
    });
  });

  test('automatic selection may use the admin-enabled one-shot provider fallback', async () => {
    providerFallbackEnabled = true;
    providerCreateErrors.e2b = 'E2B unavailable';
    const opened = waitFor((resolve) => {
      onComputeOpened = resolve;
    });
    const { provider: _provider, ...automaticOpts } = baseOpts();

    await provisionSessionSandbox(automaticOpts);
    await opened;

    expect(providerNamesRequested).toEqual(['e2b', 'daytona']);
    expect(providerCreateCalls).toBe(4);
    expect(
      updateCalls.some(
        (call) => call.table === sessionSandboxes && call.updates.provider === 'daytona',
      ),
    ).toBe(true);
  });

  test('authoritative row conflict fails closed before a second provider sandbox can be created', async () => {
    identityConflict = true;

    await expect(provisionSessionSandbox(baseOpts())).rejects.toMatchObject({
      name: 'RuntimeIdentityConflictError',
    });

    expect(providerCreateCalls).toBe(0);
    expect(removedIds).toEqual([]);
    expect(computeSessionsOpened).toEqual([]);
    expect(recordedEvents).toEqual([]);
  });

  test('provider-loss placeholder is reclaimed without inserting a second logical row', async () => {
    identityConflict = true;
    recoveryPlaceholder = true;
    const opened = waitFor((resolve) => { onComputeOpened = resolve; });

    await provisionSessionSandbox(baseOpts());
    await opened;

    expect(providerCreateCalls).toBe(1);
    expect(removedIds).toEqual([]);
    expect(computeSessionsOpened).toHaveLength(1);
  });

  test('legacy recovery placeholder authorization is single-use under concurrent allocation', async () => {
    identityConflict = true;
    recoveryPlaceholder = true;
    const opened = waitFor((resolve) => { onComputeOpened = resolve; });

    const results = await Promise.allSettled([
      provisionSessionSandbox(baseOpts()),
      provisionSessionSandbox(baseOpts()),
    ]);
    await opened;

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { name: 'RuntimeIdentityConflictError' },
    });
    expect(providerCreateCalls).toBe(1);
    expect(computeSessionsOpened).toHaveLength(1);
  });

  test('nothing raced it: flips to running, guarded WHERE clauses are the expected shape, opens compute metering', async () => {
    const opened = waitFor((resolve) => {
      onComputeOpened = resolve;
    });
    await provisionSessionSandbox(baseOpts());
    await opened;

    expect(removedIds).toEqual([]);
    expect(computeSessionsOpened).toHaveLength(1);
    expect(computeSessionsOpened[0].sandboxId).toBe(SANDBOX_ID);
    expect(computeSessionsOpened[0].accountId).toBe(ACCOUNT_ID);

    // The session_sandboxes finish update is guarded by `status != 'archived'`.
    const finishCall = updateCalls.find(
      (c) => c.table === sessionSandboxes && 'externalId' in c.updates && 'config' in c.updates,
    );
    expect(finishCall).toBeTruthy();
    expect(finishCall?.sql).toContain('<>');
    expect(finishCall?.params).toContain('archived');

    // The project_sessions running-flip is guarded by `status IN (queued, branching, provisioning)`.
    const flipCall = updateCalls.find(
      (c) => c.table === projectSessions && c.updates.status === 'running',
    );
    expect(flipCall).toBeTruthy();
    expect(flipCall?.sql).toContain('in (');
    expect(flipCall?.params).toEqual([SANDBOX_ID, ...PROVISIONING_SESSION_STATUSES]);
  });

  test('deleted mid-provision: session_sandboxes row is already archived when the finish write lands — removes the box, never flips to running, never opens metering', async () => {
    scenario.archiveBeforeFinish = true;
    // Still 'provisioning' at the early stopped-check (line ~463): the delete
    // happens in the gap AFTER that check and BEFORE the finish write — the
    // exact race window this fix closes.
    scenario.projectSessionStatusAtCheck = 'provisioning';

    const eventRecorded = waitFor((resolve) => {
      onProviderEvent = resolve;
    });
    await provisionSessionSandbox(baseOpts());
    await eventRecorded;

    expect(removedIds).toEqual([EXTERNAL_ID]);
    expect(computeSessionsOpened).toEqual([]);

    // The guarded finish update was attempted (and, per the mock, returned no
    // rows because the row was already 'archived') — but no project_sessions
    // running-flip was ever attempted off the back of it.
    const finishCall = updateCalls.find(
      (c) => c.table === sessionSandboxes && 'externalId' in c.updates && 'config' in c.updates,
    );
    expect(finishCall).toBeTruthy();
    const flipCall = updateCalls.find(
      (c) => c.table === projectSessions && c.updates.status === 'running',
    );
    expect(flipCall).toBeUndefined();

    expect(recordedEvents.some((e) => e.outcome === 'stopped')).toBe(true);
  });

  test('manual stop racing provider create stops and preserves the sandbox instead of removing it', async () => {
    scenario.projectSessionStatusAtCheck = 'stopped';
    const eventRecorded = waitFor((resolve) => { onProviderEvent = resolve; });
    await provisionSessionSandbox(baseOpts());
    await eventRecorded;

    expect(removedIds).toEqual([]);
    expect(stoppedIds).toEqual([EXTERNAL_ID]);
    expect(computeSessionsOpened).toEqual([]);
    const preserved = updateCalls.find(
      (c) => c.table === sessionSandboxes && c.updates.status === 'stopped',
    );
    expect(preserved?.updates.externalId).toBe(EXTERNAL_ID);
    expect(preserved?.updates.metadata).toMatchObject({ stoppedDuringProvisioning: true });
  });
});
