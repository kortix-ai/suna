// End-to-end (module-level) proof of the background-refresh backoff for the
// KRTX-2590 prod pattern: a session whose durable env-sync record matches the
// current signature but whose BOX is gone (suspended, stopped, deleted — the
// edge answers `502 upstream unreachable: Failed to connect` / `404 This
// sandbox URL is not active`) re-scheduled a detached background refresh on
// EVERY prompt, because a failed refresh updates neither the memo nor the
// durable record. One cron-prompted dead session produced a steady
// ~16 warnings/hour (351 in 26 h, one sandbox) of failed pushes that can
// never succeed while the box is down — a dead box's env is re-applied by its
// own boot-time sync the moment it comes back.
//
// The fix under test: a background refresh that fails with a
// BOX-UNREACHABLE outcome arms a per-sandbox backoff so later prompts stop
// re-scheduling it for the same window the staleness self-heal already uses;
// the backoff clears on the next successful push (and only an unreachable
// failure arms it — a 409 from the daemon's in-flight gate must keep
// retrying at prompt rate).
//
// Same `mock.module` + `globalThis.fetch` interception pattern as the sibling
// `sandbox-env-sync.durable-skip.test.ts` (isolated per file via
// `bun test --isolate`).
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import { applyEnvSyncDurableWrite } from '../../__tests__/helpers/env-sync-durable-fake';
import * as realSecrets from '../secrets';
import { ENV_SYNC_RECORD_VERSION } from './env-sync-durable-state';
import * as realSecretGrant from './secret-grant';

const PROJECT_ROW = {
  repoUrl: 'https://example.test/acme/repo.git',
  defaultBranch: 'main',
  manifestPath: 'kortix.yaml',
  metadata: null as Record<string, unknown> | null,
};

const SESSION_ROW = {
  createdBy: 'user-1',
  agentName: 'support',
  secretsAllowlist: null as string[] | null,
};

let snapshotEnv: Record<string, string> = { EXAMPLE: 'v1' };
let snapshotNames: string[] = ['EXAMPLE'];
let snapshotRevision = 'rev-1';
let snapshotCapabilitiesJson = '{"version":1,"capabilities":[]}';

let durableConfig: Record<string, unknown> | null = null;
let tokenPerson: string | null = 'creator';

mock.module('../../shared/db', () => ({
  hasDatabase: true,
  db: {
    select: (columns: Record<string, unknown>) => ({
      from: () => ({
        where: () => {
          if ('onBehalfOf' in columns) {
            const rows = [{ onBehalfOf: tokenPerson }];
            return { limit: async () => rows };
          }
          const wantsSession = 'createdBy' in columns;
          const wantsSandboxConfig = !wantsSession && Object.keys(columns).length === 1 && 'config' in columns;
          const rows = wantsSession
            ? [SESSION_ROW]
            : wantsSandboxConfig
              ? [{ config: durableConfig }]
              : [PROJECT_ROW];
          return {
            limit: async () => rows,
            then: (resolve: (value: typeof rows) => unknown, reject?: (reason: unknown) => unknown) =>
              Promise.resolve(rows).then(resolve, reject),
          };
        },
      }),
    }),
    update: () => ({
      set: (patch: { config?: unknown }) => ({
        where: async () => {
          durableConfig = applyEnvSyncDurableWrite(durableConfig, patch.config);
        },
      }),
    }),
  },
}));

mock.module('./secret-grant', () => ({
  ...realSecretGrant,
  resolveSessionSecretGrant: async () => 'all' as const,
}));

mock.module('../secrets', () => ({
  ...realSecrets,
  listProjectSecretsSnapshotForUser: async () => ({
    env: snapshotEnv,
    names: snapshotNames,
    revision: snapshotRevision,
    capabilitiesJson: snapshotCapabilitiesJson,
  }),
}));

mock.module('./network-secret-boundary', () => ({
  resolveSessionNetworkBoundary: async () => [],
}));

/** Every daemon POST the machinery ATTEMPTED, successful or not — the leak
 *  under test is doomed attempts, not their outcomes. */
let attempts = 0;
/** Failures the fake fetch answers in order; a call with an empty queue succeeds. */
let queuedFailures: Error[] = [];

const ORIGINAL_FETCH = globalThis.fetch;
(globalThis as { fetch: unknown }).fetch = async (_url: unknown, init?: { body?: string }) => {
  const body = init?.body ? (JSON.parse(init.body) as { revision?: number }) : {};
  attempts += 1;
  const failure = queuedFailures.shift();
  if (failure) throw failure;
  return Response.json({
    ok: true,
    revision: body.revision,
    exported: 1,
    managed: 1,
    withheld: 0,
    agent_env_written: true,
    opencode: 'ok',
  });
};

const {
  syncSandboxEnvForPrompt,
  __resetPromptModelSignatureCacheForTests,
  __resetBackgroundEnvRefreshForTests,
  __pendingBackgroundEnvRefreshesForTests,
  __backgroundRefreshBackoffForTests,
  ENV_SYNC_BACKGROUND_REFRESH_STALE_MS,
} = await import('./sandbox-env-sync');

const UNREACHABLE = Object.assign(new Error('env sync failed: 502 upstream unreachable: Failed to connect'), {
  name: 'EnvSyncHttpError',
});
const DAEMON_BUSY = Object.assign(new Error('env sync failed: 409 env sync already running'), {
  name: 'EnvSyncHttpError',
});

function prompt(externalId = 'ext-1') {
  return syncSandboxEnvForPrompt({
    projectId: 'proj-1',
    sessionId: 'sess-1',
    externalId,
    serviceKey: 'svc-key',
    previewUrl: 'https://sandbox.test',
    providerHeaders: {},
    providerName: 'daytona',
  });
}

/** Age the durable confirmation past the self-heal threshold and cold the
 *  memo, so the NEXT prompt takes the `skip + scheduleBackgroundRefresh`
 *  branch exactly as a replica that never pushed this session would. */
function armStaleSkipBranch(signature: unknown): void {
  durableConfig = {
    envSyncSignature: signature,
    envSyncAppliedAtMs: Date.now() - ENV_SYNC_BACKGROUND_REFRESH_STALE_MS - 5_000,
    envSyncRecordVersion: ENV_SYNC_RECORD_VERSION,
  };
  __resetPromptModelSignatureCacheForTests();
}

afterAll(() => {
  (globalThis as { fetch: unknown }).fetch = ORIGINAL_FETCH;
});

beforeEach(() => {
  __resetPromptModelSignatureCacheForTests();
  __resetBackgroundEnvRefreshForTests();
  attempts = 0;
  queuedFailures = [];
  durableConfig = null;
  tokenPerson = 'creator';
  snapshotEnv = { EXAMPLE: 'v1' };
  snapshotNames = ['EXAMPLE'];
  snapshotRevision = 'rev-1';
  snapshotCapabilitiesJson = '{"version":1,"capabilities":[]}';
  PROJECT_ROW.metadata = null;
});

afterEach(async () => {
  await Promise.all(__pendingBackgroundEnvRefreshesForTests());
});

describe('background refresh backoff on an unreachable box', () => {
  test('a refresh that found the box gone is not re-scheduled by every later prompt', async () => {
    await prompt(); // sync push, persists the durable record
    expect(attempts).toBe(1);
    const signature = durableConfig?.envSyncSignature;

    armStaleSkipBranch(signature);
    queuedFailures = [UNREACHABLE];
    await prompt();
    await Promise.all(__pendingBackgroundEnvRefreshesForTests());
    expect(attempts).toBe(2); // the doomed refresh ran once

    // The KRTX-2590 leak: the NEXT prompt on the same dead sandbox must NOT
    // schedule another doomed push. Before the backoff this re-fired on every
    // prompt — 351 failed pushes in 26 h from one sandbox.
    armStaleSkipBranch(signature);
    await prompt();
    await Promise.all(__pendingBackgroundEnvRefreshesForTests());
    expect(attempts).toBe(2);
  });

  test('the backoff expires: a later prompt self-heals again', async () => {
    await prompt();
    const signature = durableConfig?.envSyncSignature;

    armStaleSkipBranch(signature);
    queuedFailures = [UNREACHABLE];
    await prompt();
    await Promise.all(__pendingBackgroundEnvRefreshesForTests());
    expect(attempts).toBe(2);

    // Time passes (the seam lets a test move the window instead of waiting).
    __backgroundRefreshBackoffForTests().set('ext-1', Date.now() - 1);
    armStaleSkipBranch(signature);
    await prompt();
    await Promise.all(__pendingBackgroundEnvRefreshesForTests());
    expect(attempts).toBe(3); // the self-heal is back on
  });

  test('a successful push clears the backoff of a box that came back', async () => {
    await prompt();
    const signature = durableConfig?.envSyncSignature;

    armStaleSkipBranch(signature);
    queuedFailures = [UNREACHABLE];
    await prompt();
    await Promise.all(__pendingBackgroundEnvRefreshesForTests());
    expect(attempts).toBe(2);

    // The box is reachable again and the next prompt pushes for real.
    snapshotEnv = { EXAMPLE: 'v2' };
    snapshotNames = ['EXAMPLE'];
    snapshotRevision = 'rev-2';
    await prompt();
    expect(attempts).toBe(3);

    // The stale-skip branch is live again for the new signature.
    armStaleSkipBranch(durableConfig?.envSyncSignature);
    await prompt();
    await Promise.all(__pendingBackgroundEnvRefreshesForTests());
    expect(attempts).toBe(4);
  });

  test('a daemon-side refusal (409 in-flight) does NOT arm the backoff', async () => {
    await prompt();
    const signature = durableConfig?.envSyncSignature;

    armStaleSkipBranch(signature);
    queuedFailures = [DAEMON_BUSY];
    await prompt();
    await Promise.all(__pendingBackgroundEnvRefreshesForTests());
    expect(attempts).toBe(2);

    // A busy daemon is a transient the next prompt must retry — the loop this
    // suite exists to close is the DEAD-box one, not contention.
    armStaleSkipBranch(signature);
    await prompt();
    await Promise.all(__pendingBackgroundEnvRefreshesForTests());
    expect(attempts).toBe(3);
  });
});
