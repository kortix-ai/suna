/**
 * Characterization tests for the session-open orchestrator (`openSession`).
 *
 * These pin the response ENVELOPE of each orchestration branch at the handler
 * level — the payload `/start` serves a polling client — so a structural split
 * of `routes/shared.ts` (KRTX-274) is provably behavior-preserving. The file
 * imports `openSession` through `./shared` (the facade path every consumer
 * uses) before and after the split; if an envelope field moves, these fail.
 *
 * The six branches are the ones `runOpenSession` serves without touching a
 * real provider or database: a stopped-wake replay, a wake cooldown, a
 * terminal stamped failure, a hibernated resume, an in-place recovery claim
 * on a removed box, OpenCode booting, and the ready hand-off. `db`,
 * `getProvider`, `ensureOpencodeSessionPin`, and the recovery collaborators
 * are scripted per test; the projection/fence modules under test stay real.
 */
import type { sessionSandboxes } from '@kortix/db';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as realOpencodeMapping from '../../services/sessions/opencode-mapping';
import * as realProviders from '../../platform/providers';
import * as realRuntimeIdentity from '../../services/sandboxes/runtime-identity';
import * as realRuntimeWakeFence from '../../services/sessions/lifecycle/runtime-wake-fence';
import * as realConfigReleases from '../../config-releases/enabled';

/** Scriptable statement results, shifted in program order. */
let selectQueue: unknown[][] = [];
let updateQueue: unknown[][] = [];
let updateCalls = 0;

/**
 * A thenable drizzle chain: `.where()` returns the builder (`.limit()` may
 * follow), an awaited bare chain resolves the next scripted result, and
 * `.returning()` resolves its own. Shifts happen in program order.
 */
function statement(queue: unknown[][]): {
  from: () => ReturnType<typeof statement>;
  where: () => ReturnType<typeof statement>;
  limit: () => ReturnType<typeof statement>;
  set: () => ReturnType<typeof statement>;
  returning: () => Promise<unknown[]>;
  then: <T>(onFulfilled: (value: unknown[]) => T) => Promise<T>;
} {
  const builder = {
    from: () => builder,
    where: () => builder,
    limit: () => builder,
    set: () => builder,
    returning: () => Promise.resolve(queue.shift() ?? []),
    then: <T>(onFulfilled: (value: unknown[]) => T) =>
      Promise.resolve(queue.shift() ?? []).then(onFulfilled),
  } as ReturnType<typeof statement>;
  return builder;
}

mock.module('../../lib/db', () => ({
  db: {
    select: () => statement(selectQueue),
    update: () => {
      updateCalls += 1;
      return statement(updateQueue);
    },
    delete: () => statement(updateQueue),
    insert: () => statement(updateQueue),
    execute: async () => [],
  },
  transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
  afterCommit: async (fn: () => unknown) => fn(),
  hasDatabase: true,
}));

/** A provider whose `getStatus` answers from a per-test queue. */
let providerStatuses: string[] = [];
let recoverInPlaceResult: 'running' | 'recovering' | 'unavailable' = 'unavailable';
mock.module('../../platform/providers', () => ({
  ...realProviders,
  getProvider: (name: string) => ({
    getStatus: async () => providerStatuses.shift() ?? 'unknown',
    recoverInPlace: async () => recoverInPlaceResult,
    start: async () => {},
    stop: async () => {},
    name,
  }),
}));

let recoveryClaims: Array<Record<string, unknown>> = [];
let recoveryAcceptedRows: Array<Record<string, unknown>> = [];
mock.module('../../services/sandboxes/runtime-identity', () => ({
  ...realRuntimeIdentity,
  claimInPlaceRuntimeRecovery: async (row: Record<string, unknown>) =>
    recoveryClaims.shift() ?? null,
  markInPlaceRuntimeRecoveryAccepted: async (
    claim: Record<string, unknown>,
    recovery: string,
  ) => recoveryAcceptedRows.shift() ?? null,
  retireUnmaterializedRuntime: async () => {},
  parkEstablishedRuntime: async (row: Record<string, unknown>) => ({ ...row, status: 'stopped' }),
  preserveEstablishedRuntime: async (row: Record<string, unknown>) => ({ ...row, status: 'stopped' }),
}));

/** The detached wake fence is stubbed: the resume test pins the CLAIM, not the poll. */
let wakeStarted = 0;
mock.module('../../services/sessions/lifecycle/runtime-wake-fence', () => ({
  ...realRuntimeWakeFence,
  executeClaimedRuntimeWake: async () => {
    wakeStarted += 1;
    return 'cancelled';
  },
}));

/** The daemon round trip is scripted; every branch below decides off its answer. */
let pinResults: Array<Record<string, unknown>> = [];
mock.module('../../services/sessions/opencode-mapping', () => ({
  ...realOpencodeMapping,
  ensureOpencodeSessionPin: async () => pinResults.shift() ?? { pin: null, changed: false, reason: 'not_ready' },
}));

mock.module('../../config-releases/enabled', () => ({
  ...realConfigReleases,
  configReleasesEnabled: () => false,
}));

/** The guarantee wiring pulls sandbox-proxy/backend into the module graph; never load it here. */
mock.module('../../services/sandboxes/legacy-runtime-bootstrap-wiring', () => ({
  guaranteeCurrentRuntimeOnOpen: async () => ({ action: 'proceed', classification: null }),
}));

/** The ready-stage model repair must not touch anything. */
mock.module('../../services/sessions/session-model-repair', () => ({
  pinNeedsRepair: () => false,
  repairRetiredSessionModelOnOpen: async () => {},
}));

const { openSession } = await import('./shared');

/** The envelope's `observedAt` is the real clock; fixtures are relative to it. */
const NOW_MS = () => Date.now();

function row(
  status: string,
  metadata: Record<string, unknown>,
  overrides: Partial<Record<string, unknown>> = {},
): typeof sessionSandboxes.$inferSelect {
  return {
    sandboxId: 'sess-1',
    sessionId: 'sess-1',
    projectId: 'proj-1',
    accountId: 'acct-1',
    provider: 'daytona',
    externalId: 'ext-1',
    baseUrl: null,
    status,
    config: {},
    metadata,
    lastUsedAt: null,
    deadlineAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as unknown as typeof sessionSandboxes.$inferSelect;
}

const VISIBLE = {
  row: {
    status: 'active',
    sandboxProvider: 'daytona',
    baseRef: null,
    agentName: 'default',
    runtimeSessionId: null,
    accountId: 'acct-1',
    metadata: null,
  },
};
const LOADED = { row: {} as never, userId: 'user-1' };

const args = (agentName = 'default', opencodeSessionId: string | null = null) => ({
  loaded: LOADED,
  visible: { ...VISIBLE, row: { ...VISIBLE.row, agentName, runtimeSessionId: opencodeSessionId } },
  projectId: 'proj-1',
  sessionId: 'sess-1',
});

beforeEach(() => {
  selectQueue = [];
  updateQueue = [];
  updateCalls = 0;
  providerStatuses = [];
  pinResults = [];
  recoveryClaims = [];
  recoveryAcceptedRows = [];
  wakeStarted = 0;
  recoverInPlaceResult = 'unavailable';
});

describe('openSession response envelope — one pin per orchestration branch', () => {
  test('a stopped row with a wake in flight replays starting/runtime_waking without a provider call', async () => {
    const nowMs = NOW_MS();
    const wakingAt = new Date(nowMs - 10_000).toISOString();
    selectQueue = [
      [
        row('stopped', {
          runtimeWakeId: 'wake-1',
          runtimeWakeStartedAt: wakingAt,
          runtimeWakeLeaseExpiresAt: new Date(nowMs + 200_000).toISOString(),
          runtimeWakeProviderStatus: 'starting',
        }),
      ],
    ];

    const result = await openSession(args());

    expect(result.stage).toBe('starting');
    expect(result.retriable).toBe(true);
    expect(result.reason).toBe('runtime_waking');
    expect(result.agent_name).toBe('default');
    expect(result.opencode_session_id).toBeNull();
    expect(result.runtime_url).toBe('/p/ext-1/8000');
    expect(result.sandbox?.sandbox_id).toBe('sess-1');
    expect(result.sandbox?.external_id).toBe('ext-1');
    expect(result.sandbox?.status).toBe('stopped');
    // The envelope says what THIS call did: it replayed a live wake.
    expect(result.action).toBe('awaited_wake');
    expect(typeof result.observed_at).toBe('string');
    expect(result.observation).toBeDefined();
    // No provider was contacted and no wake was claimed.
    expect(providerStatuses).toEqual([]);
    expect(wakeStarted).toBe(0);
    expect(updateCalls).toBe(0);
  });

  test('a failed wake inside its cooldown answers starting/runtime_wake_cooldown, honestly retriable', async () => {
    const nowMs = NOW_MS();
    const failedAt = new Date(nowMs - 30_000).toISOString();
    selectQueue = [
      [
        row('stopped', {
          stopReason: 'runtime_wake_failed',
          runtimeWakeError: 'provider_not_running',
          runtimeWakeFailedAt: failedAt,
          runtimeStartFailedAt: failedAt,
          runtimeStartFailureCount: 1,
          runtimeStartRetryAfterAt: new Date(nowMs + 90_000).toISOString(),
        }),
      ],
    ];

    const result = await openSession(args());

    expect(result.stage).toBe('starting');
    expect(result.retriable).toBe(true);
    expect(result.reason).toBe('runtime_wake_cooldown');
    expect(result.runtime_url).toBe('/p/ext-1/8000');
    expect(result.failure?.retryable).toBe(true);
    expect(result.failure?.evidence?.attempts).toBe(1);
    expect(result.failure?.evidence?.check).toBe('provider_not_running');
    expect(result.action).toBe('cooling_down');
  });

  test('a spent attempt budget answers a terminal failed payload naming the check', async () => {
    const failedAt = new Date(NOW_MS() - 60_000).toISOString();
    selectQueue = [
      [
        row('stopped', {
          stopReason: 'runtime_wake_failed',
          runtimeWakeError: 'provider_not_running',
          runtimeStartFailedAt: failedAt,
          runtimeStartFailureCount: 5,
          runtimeStartRetryAfterAt: failedAt,
        }),
      ],
    ];

    const result = await openSession(args('agent-x'));

    expect(result.stage).toBe('failed');
    expect(result.retriable).toBe(false);
    expect(result.reason).toBe('runtime_wake_failed');
    expect(result.agent_name).toBe('agent-x');
    expect(result.failure?.evidence?.attempts).toBe(5);
    expect(result.failure?.message).toContain('5 attempts');
    // A terminal replay is still a replay: no provider call, awaited_wake.
    expect(result.action).toBe('awaited_wake');
    expect(providerStatuses).toEqual([]);
  });

  test('a hibernated box with a provider answer resumes in place and answers runtime_waking', async () => {
    const nowMs = NOW_MS();
    selectQueue = [
      [row('stopped', {})],
      // The post-resume re-read: the claim was won, the row is waking.
      [
        row('stopped', {
          runtimeWakeId: 'wake-claimed',
          runtimeWakeStartedAt: new Date(nowMs - 1_000).toISOString(),
          runtimeWakeLeaseExpiresAt: new Date(nowMs + 200_000).toISOString(),
        }),
      ],
    ];
    updateQueue = [[{ sandboxId: 'sess-1' }]]; // the claim CAS won
    providerStatuses = ['stopped'];

    const result = await openSession(args());

    expect(result.stage).toBe('starting');
    expect(result.reason).toBe('runtime_waking');
    expect(result.retriable).toBe(true);
    expect(result.sandbox?.status).toBe('stopped');
    expect(result.runtime_url).toBe('/p/ext-1/8000');
    // The claim, the detached fence, and the resumed action are all pinned.
    expect(updateCalls).toBe(1);
    expect(wakeStarted).toBe(1);
    expect(result.action).toBe('resumed');
  });

  test('a removed box recovers in place when the claim is won and the provider restores', async () => {
    const removedAt = new Date(NOW_MS() - 10 * 60_000).toISOString();
    const recovered = row('provisioning', { runtimeIdentityState: 'recovering' });
    selectQueue = [[row('active', { initSucceededAt: removedAt })]];
    providerStatuses = ['removed'];
    recoverInPlaceResult = 'recovering';
    recoveryClaims = [{ row: row('active', { initSucceededAt: removedAt }), id: 'claim-1' }];
    recoveryAcceptedRows = [recovered];

    const result = await openSession(args('default', 'oc-current'));

    expect(result.stage).toBe('starting');
    expect(result.retriable).toBe(true);
    expect(result.reason).toBe('runtime_restoring_in_place');
    expect(result.opencode_session_id).toBe('oc-current');
    expect(result.runtime_url).toBe('/p/ext-1/8000');
    expect(result.sandbox?.metadata).toEqual({ runtimeIdentityState: 'recovering' });
    expect(result.action).toBe('restored');
  });

  test('a provider-running box whose OpenCode is still booting answers starting/not_ready', async () => {
    selectQueue = [[row('active', {})]];
    providerStatuses = ['running'];
    pinResults = [{ pin: null, changed: false, reason: 'not_ready', bootPhase: 'opencode-start' }];

    const result = await openSession(args());

    expect(result.stage).toBe('starting');
    expect(result.retriable).toBe(true);
    expect(result.reason).toBe('not_ready');
    expect(result.opencode_session_id).toBeNull();
    expect(result.sandbox?.external_id).toBe('ext-1');
    expect(result.runtime_url).toBe('/p/ext-1/8000');
    // Booting answers skip the guarantee and admission phases entirely.
    expect(result.action).toBe('checked_provider');
  });

  test('a provider-running box with a resolved pin hands the runtime over ready', async () => {
    selectQueue = [[row('active', {})]];
    providerStatuses = ['running'];
    pinResults = [{ pin: 'oc-pin-1', changed: false, reason: 'unchanged', sessions: [] }];

    const result = await openSession(args());

    expect(result.stage).toBe('ready');
    expect(result.retriable).toBe(false);
    expect(result.reason).toBe('unchanged');
    expect(result.opencode_session_id).toBe('oc-pin-1');
    expect(result.runtime_url).toBe('/p/ext-1/8000');
    expect(result.sandbox?.status).toBe('active');
    expect(result.action).toBe('checked_provider');
    expect(typeof result.observed_at).toBe('string');
  });
});
