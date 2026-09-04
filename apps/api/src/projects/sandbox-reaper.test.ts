import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { appRuntimes, projectSessions, sandboxComputeSessions, sessionSandboxes } from '@kortix/db';
import * as realComputeMetering from '../billing/services/compute-metering';
import * as realProviders from '../platform/providers';
import { mockConfigModule } from './reaping/test-support/mock-config';
import { __resetProbeBackoffForTests } from './reaping/box-reaper';

// ── mock state ──────────────────────────────────────────────────────────────
let candidates: any[] = [];
let appRuntimeKeepRows: any[] = [];
// `terminal` is a real provider answer (Daytona `error`, Platinum `failed`), so
// the fixture has to be able to express it — see decideReconcile.
let statusByExternal: Record<string, 'running' | 'stopped' | 'removed' | 'terminal' | 'unknown'> =
  {};
let stopErrorByExternal: Record<string, Error> = {};
let stops: string[] = [];
let stopsByProvider: Array<{ provider: string; externalId: string }> = [];
let managedBoxes: Array<{ externalId: string; createdAt: Date | null }> = [];
let e2bManagedBoxes: Array<{ externalId: string; createdAt: Date | null }> = [];
let cacheInvalidations: string[] = [];
let pausedCompute: string[] = [];
let endedCompute: string[] = [];
let updateCalls: Array<{ table: unknown; updates: Record<string, unknown> }> = [];
let stuckSessions: Array<{ sessionId: string }> = [];
let computeRows: any[] = [];
let pausedComputeWindows: Array<{
  sandboxId: string;
  windowEnd: Date | undefined;
}> = [];

let orderByExpressions: string[] = [];
let statusCalls: string[] = [];
let livenessStamps: Array<{ sandboxId: string; at: Date }> = [];
let timeoutRenewals: Array<{ provider: string; externalId: string }> = [];
let lifecycleRenewErrorByExternal: Record<string, Error> = {};
let activeTurnRenewalBySandbox: Record<string, 'renewed' | 'inactive'> = {};
let activeTurnRenewalCalls: Array<{ sandboxId: string; token: string }> = [];
let deliveringTurnObservationBySandbox: Record<string, 'active' | 'terminal' | 'unknown'> = {};
let turnObservationByToken: Record<string, 'active' | 'terminal' | 'unknown'> = {};
/** Every record this pass actually PROBED. The drip is counted from probes, so
 *  a test has to be able to tell "the daemon said nothing" from "nobody asked". */
let turnObservationCalls: Array<{ sandboxId: string; token: string }> = [];
/** Did the daemon ANSWER this token's probe at all? False = nothing came back. */
let daemonAnsweredByToken: Record<string, boolean> = {};
/** The daemon's own word for HOW the turn ended, when it reported one. */
let daemonTurnEndBySandbox: Record<string, 'completed' | 'failed' | 'abandoned'> = {};
/** The daemon's `turn_orphaned_prompt`: a user message on record with nothing
 *  answering it. Evidence about the PROMPT, not about the turn. */
let orphanedPromptByToken: Record<string, boolean> = {};
let deliveringTurnRecoveryCalls: Array<{
  sandboxId: string;
  token: string;
  observation: 'active' | 'terminal' | 'unknown';
  reason?: string;
}> = [];
let clearedTurnCalls: Array<{ sandboxId: string; token: string }> = [];
/** Prompts this pass gave back to the inbox, and the ending it blamed. */
let promptRedeliveries: Array<{
  sessionId: string;
  wireMessageId: string | null;
  turnToken: string;
  endReason: string;
}> = [];
/** Sandboxes handed the bounded `turn_unconfirmed` deadline drip this pass. */
let unconfirmedTurnDrips: string[] = [];
// Recorded separately from `clearedTurnCalls` so the ledger reason is asserted
// on its own, without every existing exact-equality assertion having to carry
// it.
let clearedTurnReasons: Array<string | undefined> = [];
let ledgerSettleStatements: string[] = [];
let huskFinalizeCalls: Array<{
  sandboxId: string;
  externalId: string;
  opencodeSessionId: string;
  messageId: string | null;
}> = [];
let huskOutcomeBySandbox: Record<string, 'finalized' | 'not_husk' | 'unreadable' | 'unconfirmed'> =
  {};
/** Records husk-finalize and turn-clear calls in the order the pass makes them,
 *  so a test can assert the husk is closed BEFORE its record is deleted. */
let lifecycleCallOrder: string[] = [];
let promotedQueueSessions: string[] = [];
let targetedQueueDrains: string[] = [];

/**
 * What the DB returns for the LAST-MOMENT deadline re-read, when it differs from
 * the value in the pass's snapshot. This is the TOCTOU: the sweep snapshots
 * candidates, then burns a multi-second provider round-trip per row, and a prompt
 * arriving inside that window extends `deadline_at` after the snapshot was taken.
 * `null` models the row being unreadable/gone.
 */
let freshDeadlineBySandbox: Record<string, Date | null> = {};
let stopClaimDeniedBySandbox: Record<string, boolean> = {};

/** Mirrors the ORDER BY the reaper asks Postgres for, so a pass over more rows
 *  than the batch actually rotates instead of re-selecting the same head:
 *  EXPIRED first, then least-recently-visited. The visit stamp is an ISO-8601
 *  UTC string, where lexicographic order IS chronological order, and a missing
 *  key sorts first (SQL `nulls first`). */
function applyOrder(rows: any[], now: Date = NOW): any[] {
  const visited = (r: any) =>
    'startedAt' in r ? String(r.startedAt ?? '') : String(r.metadata?.reaperVisitedAt ?? '');
  const expired = (r: any) =>
    r?.deadlineAt instanceof Date && r.deadlineAt.getTime() <= now.getTime() ? 0 : 1;
  return [...rows].sort((a, b) => expired(a) - expired(b) || visited(a).localeCompare(visited(b)));
}

function hasTurnAuthority(row: any): boolean {
  const states = [row.metadata?.activeTurn?.state];
  const activeTurns = row.metadata?.activeTurns;
  if (activeTurns && typeof activeTurns === 'object' && !Array.isArray(activeTurns)) {
    states.push(...Object.values(activeTurns).map((turn: any) => turn?.state));
  }
  return states.some((state) => state === 'delivering' || state === 'active');
}

/** Flatten a drizzle SQL expression to its literal text so a test can assert
 *  what the sweep actually asks Postgres to order by. */
function describeSql(expression: any): string {
  if (expression === null || expression === undefined) return '';
  if (typeof expression !== 'object') return String(expression);
  if (Array.isArray(expression)) return expression.map(describeSql).join(' ');
  if (Array.isArray(expression.queryChunks)) {
    return expression.queryChunks.map(describeSql).join(' ');
  }
  if (Array.isArray(expression.value)) return expression.value.join('');
  if (expression.value !== undefined) return String(expression.value);
  return expression.name ?? '';
}

/** Pull the BOUND VALUES out of a drizzle predicate, so the mock can answer a
 *  single-row lookup with the row that was actually asked for instead of
 *  whichever row happens to be first. Without this the reaper's atomic stop
 *  claim is answered from `candidates[0]` and a multi-row pass tests nothing. */
function sqlValues(expression: unknown): string[] {
  const out: string[] = [];
  const walk = (node: any) => {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (typeof node !== 'object') {
      out.push(String(node));
      return;
    }
    if (Array.isArray(node.queryChunks)) {
      for (const chunk of node.queryChunks) walk(chunk);
      return;
    }
    const value = node.value;
    if (typeof value === 'string' || typeof value === 'number') out.push(String(value));
  };
  walk(expression);
  return out;
}

/** A thenable that also exposes the chainable clause methods, so `await where()`
 *  and `where().orderBy().limit()` resolve to the same rows. */
function hybrid(rows: any[], throwOnGroupBy = false): any {
  const p: any = Promise.resolve(rows);
  p.limit = (n?: number) => hybrid(typeof n === 'number' ? rows.slice(0, n) : rows, throwOnGroupBy);
  p.orderBy = (...expressions: unknown[]) => {
    for (const expression of expressions) orderByExpressions.push(describeSql(expression));
    return hybrid(applyOrder(rows), throwOnGroupBy);
  };
  p.groupBy = async () => {
    if (throwOnGroupBy) throw new Error('db down');
    return rows;
  };
  return p;
}

/** The reaper stamps `reaperVisitedAt` on every row it examined in ONE batched
 *  update. It is bookkeeping, not a decision, so assertions about what the pass
 *  DID to a row filter it out — it is the only update that sets metadata alone. */
function isVisitStamp(call: { updates: Record<string, unknown> }): boolean {
  const keys = Object.keys(call.updates);
  return keys.length === 1 && keys[0] === 'metadata';
}
function isStopClaimBookkeeping(call: { updates: Record<string, unknown> }): boolean {
  return describeSql(call.updates.metadata).includes('lifecycleStopClaim');
}
const rowUpdates = () => updateCalls.filter((c) => !isVisitStamp(c) && !isStopClaimBookkeeping(c));
const visitStamps = () => updateCalls.filter(isVisitStamp);

// Mock config so the test doesn't import the real config, which calls
// process.exit on incomplete local env. Uses the COMPLETE module stand-in:
// `mock.module` is process-global in bun, so a factory returning only `{ config }`
// strips every other named export (e.g. SANDBOX_VERSION) for every sibling suite
// in the same process — which is what made this whole directory unrunnable.
// Hoisted so a test can flip `KORTIX_INSTANCE_ID` at call time (the
// instance-scope helper reads config per call, never at import).
const reaperConfigModule = mockConfigModule({
  KORTIX_SANDBOX_AUTOSTOP_MINUTES: 15,
  KORTIX_SANDBOX_TRIGGER_AUTOSTOP_MINUTES: 5,
  ALLOWED_SANDBOX_PROVIDERS: ['daytona', 'e2b'],
});
const reaperConfig = reaperConfigModule.config as Record<string, unknown>;
mock.module('../config', () => reaperConfigModule);

mock.module('../shared/db', () => ({
  db: {
    transaction: async function <T>(fn: (tx: any) => Promise<T>): Promise<T> {
      return fn(this);
    },
    // The stop writer settles this sandbox's still-open session_turns rows in
    // the same transaction that erases its turn authority (see
    // reaping/sandbox-state-sync.ts). Recorded, not ignored, so a stop that
    // silently stopped settling the ledger shows up here.
    execute: async (statement: unknown) => {
      ledgerSettleStatements.push(describeSql(statement));
    },
    select: (projection?: Record<string, unknown>) => ({
      from: (table: unknown) => {
        const isCount = !!projection && 'total' in projection;
        // The last-moment deadline re-read is the only projection that asks for
        // deadline_at ALONE, and it is keyed by sandbox_id — so answer it with
        // that row's CURRENT deadline, which is what the TOCTOU tests move under
        // the reaper's feet.
        const isDeadlineReread =
          !!projection && 'deadlineAt' in projection && Object.keys(projection).length === 1;
        const builder: any = {
          innerJoin: () => builder,
          leftJoin: () => builder,
          where: (predicate?: unknown) => {
            if (isCount) return hybrid([{ total: candidates.length }]);
            if (isDeadlineReread) {
              const asked = new Set(sqlValues(predicate));
              const id = [...asked].find((v) => v in freshDeadlineBySandbox);
              if (id) {
                const fresh = freshDeadlineBySandbox[id];
                return hybrid(fresh === null ? [] : [{ deadlineAt: fresh }]);
              }
              const row = candidates.find((c) => asked.has(c.sandboxId));
              return hybrid(row ? [{ deadlineAt: row.deadlineAt }] : []);
            }
            const predicateText = describeSql(predicate);
            const boundValues = new Set(sqlValues(predicate));
            const selectsWithoutTurnAuthority =
              predicateText.includes('activeTurn') && /\band\s+not\s*\(/i.test(predicateText);
            const selectedSandboxRows = candidates
              .filter((row) =>
                !predicateText.includes('activeTurn')
                  ? true
                  : selectsWithoutTurnAuthority
                    ? !hasTurnAuthority(row)
                    : hasTurnAuthority(row),
              )
              .filter(
                (row) =>
                  !predicateText.toLowerCase().includes('not in') ||
                  !boundValues.has(row.sandboxId),
              );
            return hybrid(
              table === sessionSandboxes
                ? selectedSandboxRows
                : table === appRuntimes
                  ? appRuntimeKeepRows
                  : table === sandboxComputeSessions
                    ? computeRows
                    : table === projectSessions
                      ? stuckSessions
                      : [],
            );
          },
        };
        return builder;
      },
    }),
    update: (table: unknown) => ({
      set: (updates: Record<string, unknown>) => ({
        // Awaitable (reconcileRowToStopped), chainable to `.returning()`
        // (reconcileStuckActiveSessions), and `.catch()`-able (the batched
        // visit stamp). Records exactly one update call whichever is used.
        where: (predicate?: unknown) => {
          let recorded = false;
          const record = () => {
            if (recorded) return;
            recorded = true;
            updateCalls.push({ table, updates });
          };
          record();
          const p: any = Promise.resolve(undefined);
          p.returning = async () => {
            if (
              describeSql(updates.metadata).includes('jsonb_set') &&
              isStopClaimBookkeeping({ updates })
            ) {
              const asked = new Set(sqlValues(predicate));
              const id = [...asked].find(
                (value) =>
                  value in freshDeadlineBySandbox ||
                  candidates.some((row) => row.sandboxId === value),
              );
              if (!id || stopClaimDeniedBySandbox[id]) return [];
              const fresh =
                id in freshDeadlineBySandbox
                  ? freshDeadlineBySandbox[id]
                  : (candidates.find((row) => row.sandboxId === id)?.deadlineAt ?? null);
              if (!fresh || fresh.getTime() > Date.now()) return [];
              return [{ sandboxId: id }];
            }
            return [{ sessionId: 'updated' }];
          };
          return p;
        },
      }),
    }),
  },
}));

// Spread the real module: `mock.module` replaces it WHOLESALE, so a stub that
// lists exports by hand deletes every export it omits — the failure surfaces in
// whatever unrelated file imports the missing name next, attributed to no test.
mock.module('../platform/providers', () => ({
  ...realProviders,
  // 60 minutes — the provider's own idle auto-stop, and therefore the ceiling
  // on how long a window may bill past its last liveness observation.
  providerAutoStopBackstopMinutes: () => 60,
  getProvider: (name: string) => ({
    getStatus: async (externalId: string) => {
      statusCalls.push(externalId);
      return statusByExternal[externalId] ?? 'unknown';
    },
    stop: async (externalId: string) => {
      stops.push(externalId);
      stopsByProvider.push({ provider: name, externalId });
      const err = stopErrorByExternal[externalId];
      if (err) throw err;
    },
    renewLifecycle: async (externalId: string) => {
      timeoutRenewals.push({ provider: name, externalId });
      const err = lifecycleRenewErrorByExternal[externalId];
      if (err) throw err;
    },
    listManagedRunningSandboxes: async () => (name === 'e2b' ? e2bManagedBoxes : managedBoxes),
  }),
}));

mock.module('../sandbox-proxy', () => ({
  invalidateProviderCache: (externalId: string) => {
    cacheInvalidations.push(externalId);
  },
}));

// Spread the real module: `mock.module` replaces it WHOLESALE, so a stub that
// lists exports by hand deletes every export it omits — the failure surfaces in
// whatever unrelated file imports the missing name next, attributed to no test.
mock.module('../billing/services/compute-metering', () => ({
  ...realComputeMetering,
  reopenComputeForSandbox: async () => undefined,
  markComputeSessionAlive: async (sandboxId: string, at: Date) => {
    livenessStamps.push({ sandboxId, at });
  },
  pauseComputeSession: async (sandboxId: string, windowEnd?: Date) => {
    pausedCompute.push(sandboxId);
    pausedComputeWindows.push({ sandboxId, windowEnd });
  },
  endComputeSession: async (sandboxId: string) => {
    endedCompute.push(sandboxId);
  },
}));

const sandboxReaper = await import('./sandbox-reaper');
const {
  decideReconcile,
  decideComputeClose,
  computeCloseWindowEnd,
  hasFailedRuntimeStart,
  reconcileOrphanComputeSessions,
  reapOrphanProviderBoxes,
  reconcileStuckActiveSessions,
  REAP_BATCH_SIZE,
  observeSandboxTurn,
} = sandboxReaper;

const reapAndReconcileSandboxes = (
  now?: Date,
  scope?: { sandboxIds?: readonly string[]; activeTurnsOnly?: boolean },
) =>
  sandboxReaper.reapAndReconcileSandboxes(
    now,
    {
      renewActiveSandboxTurn: async (sandboxId: string, token: string) => {
        activeTurnRenewalCalls.push({ sandboxId, token });
        return activeTurnRenewalBySandbox[sandboxId] ?? 'inactive';
      },
      observeSandboxTurn: async (
        _provider: unknown,
        _externalId: string,
        sandboxId?: string,
        turn?: { token?: string },
      ) => {
        turnObservationCalls.push({ sandboxId: sandboxId ?? '', token: turn?.token ?? '' });
        return {
          observation:
            (turn?.token ? turnObservationByToken[turn.token] : undefined) ??
            deliveringTurnObservationBySandbox[sandboxId ?? ''] ??
            'unknown',
          endReason: daemonTurnEndBySandbox[sandboxId ?? ''] ?? null,
          // The daemon answering AT ALL is a separate fact from what it said. The
          // default is true because the ordinary unreadable answer is a 200 from
          // an agent build that omits the turn fields; a daemon that answers
          // nothing is the explicit case each test opts into.
          daemonAnswered: daemonAnsweredByToken[turn?.token ?? ''] ?? true,
          orphanedPrompt: orphanedPromptByToken[turn?.token ?? ''] ?? false,
        };
      },
      reconcileSandboxTurnDelivery: async (
        sandboxId: string,
        token: string,
        observation: 'active' | 'terminal' | 'unknown',
        reason?: string,
      ) => {
        deliveringTurnRecoveryCalls.push({ sandboxId, token, observation, reason });
        return observation === 'active'
          ? 'active'
          : observation === 'terminal'
            ? 'inactive'
            : 'deferred';
      },
      clearSandboxTurn: async (
        sandboxId: string,
        token: string,
        _graceMs?: number,
        reason?: string,
      ) => {
        clearedTurnCalls.push({
          sandboxId,
          token,
        });
        clearedTurnReasons.push(reason);
        lifecycleCallOrder.push(`clear:${token}`);
        return true;
      },
      finalizeHuskTurn: async (target: {
        sandboxId: string;
        externalId: string;
        opencodeSessionId: string;
        messageId: string | null;
      }) => {
        huskFinalizeCalls.push(target);
        lifecycleCallOrder.push(`husk:${target.opencodeSessionId}`);
        return huskOutcomeBySandbox[target.sandboxId] ?? 'not_husk';
      },
      extendUnconfirmedTurnDeadline: async (sandboxId: string) => {
        unconfirmedTurnDrips.push(sandboxId);
        return true;
      },
      requeueAbandonedPrompt: async (input: {
        sessionId: string;
        wireMessageId: string | null;
        turnToken: string;
        endReason: string;
      }) => {
        promptRedeliveries.push(input);
        return 'requeued';
      },
      promoteNextInboxRow: async (sessionId: string) => {
        promotedQueueSessions.push(sessionId);
        return `prompt:${sessionId}`;
      },
      drainSessionLifecycleQueue: async (input: { idempotencyKey?: string }) => {
        if (input.idempotencyKey) targetedQueueDrains.push(input.idempotencyKey);
        return { claimed: 1, completed: 1, failed: 0 };
      },
    },
    scope,
  );

const HOUR = 3_600_000;

beforeEach(() => {
  candidates = [];
  appRuntimeKeepRows = [];
  statusByExternal = {};
  stopErrorByExternal = {};
  stops = [];
  stopsByProvider = [];
  managedBoxes = [];
  e2bManagedBoxes = [];
  cacheInvalidations = [];
  pausedCompute = [];
  endedCompute = [];
  updateCalls = [];
  stuckSessions = [];
  computeRows = [];
  pausedComputeWindows = [];
  orderByExpressions = [];
  statusCalls = [];
  livenessStamps = [];
  timeoutRenewals = [];
  lifecycleRenewErrorByExternal = {};
  activeTurnRenewalBySandbox = {};
  activeTurnRenewalCalls = [];
  deliveringTurnObservationBySandbox = {};
  turnObservationByToken = {};
  turnObservationCalls = [];
  daemonAnsweredByToken = {};
  daemonTurnEndBySandbox = {};
  orphanedPromptByToken = {};
  deliveringTurnRecoveryCalls = [];
  clearedTurnCalls = [];
  promptRedeliveries = [];
  clearedTurnReasons = [];
  unconfirmedTurnDrips = [];
  __resetProbeBackoffForTests();
  ledgerSettleStatements = [];
  huskFinalizeCalls = [];
  huskOutcomeBySandbox = {};
  lifecycleCallOrder = [];
  promotedQueueSessions = [];
  targetedQueueDrains = [];
  freshDeadlineBySandbox = {};
  stopClaimDeniedBySandbox = {};
});

// ── pure decision functions (the money + UX correctness lives here) ──────────
describe('decideReconcile', () => {
  test('never acts on unknown provider state', () => {
    expect(decideReconcile('unknown')).toBe('none');
  });

  test('removed → reconcile-removed', () => {
    expect(decideReconcile('removed')).toBe('reconcile-removed');
  });

  test('provider already stopped → reconcile-stopped', () => {
    expect(decideReconcile('stopped')).toBe('reconcile-stopped');
  });

  test('running is not a reconcile concern', () => {
    expect(decideReconcile('running')).toBe('none');
  });
  // Daytona `error` / Platinum `failed` used to arrive here as 'unknown' and so
  // returned 'none' forever, leaving the row `active` and its compute window
  // billing wall-clock against a box that had been dead for weeks (12 of the
  // longest-billed open prod rows were ALL in Daytona state `error`).
  test('REGRESSION: a terminal (dead) box reconciles and closes billing', () => {
    expect(decideReconcile('terminal')).toBe('reconcile-stopped');
  });
});

describe('provider-neutral turn observation', () => {
  test('passes the exact OpenCode identity through the provider endpoint', async () => {
    let requested: URL | null = null;
    const authorization = { value: null as string | null };
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        requested = new URL(request.url);
        authorization.value = request.headers.get('authorization');
        return Response.json({ turn_in_flight: true });
      },
    });
    try {
      const observation = await observeSandboxTurn(
        {
          resolveEndpoint: async () => ({
            url: `http://127.0.0.1:${server.port}`,
            headers: { Authorization: 'Bearer service-key' },
          }),
        },
        'ext-1',
        'sb-1',
        { opencodeSessionId: 'ses_root', messageId: 'msg_turn_1' },
      );

      expect(observation).toEqual({
        observation: 'active',
        endReason: null,
        daemonAnswered: true,
        orphanedPrompt: false,
      });
      expect((requested as URL | null)?.pathname).toBe('/kortix/health');
      expect((requested as URL | null)?.searchParams.get('turn')).toBe('1');
      expect((requested as URL | null)?.searchParams.get('turn_session_id')).toBe('ses_root');
      expect((requested as URL | null)?.searchParams.get('turn_message_id')).toBe('msg_turn_1');
      expect(authorization.value).toBe('Bearer service-key');
    } finally {
      server.stop(true);
    }
  });

  test('an unreachable provider endpoint is unknown, never terminal', async () => {
    expect(
      await observeSandboxTurn(
        {
          resolveEndpoint: async () => {
            throw new Error('provider unavailable');
          },
        },
        'ext-1',
      ),
    ).toEqual({
      observation: 'unknown',
      endReason: null,
      daemonAnswered: false,
      orphanedPrompt: false,
    });
  });

  // ═══ THE TWO KINDS OF `unknown` ═══
  // The reaper's drip may keep a box alive on the first and must never keep one
  // alive on the second, so the reading has to tell them apart. A build that
  // predates the turn fields answers 200 without them
  // (apps/kortix-sandbox-agent-server/src/routes/health.ts adds them only when
  // it can observe the turn) — the runtime is UP and only its account of the
  // turn is missing. Nothing coming back is the opposite fact.
  test('a 200 without the turn fields is unknown, but the daemon ANSWERED', async () => {
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ daemon: 'ok' }) });
    try {
      expect(
        await observeSandboxTurn(
          {
            resolveEndpoint: async () => ({ url: `http://127.0.0.1:${server.port}`, headers: {} }),
          },
          'ext-1',
        ),
      ).toEqual({
        observation: 'unknown',
        endReason: null,
        daemonAnswered: true,
        orphanedPrompt: false,
      });
    } finally {
      server.stop(true);
    }
  });

  test('a non-2xx is the proxy refusing, not the daemon answering', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response('bad gateway', { status: 502 }),
    });
    try {
      expect(
        await observeSandboxTurn(
          {
            resolveEndpoint: async () => ({ url: `http://127.0.0.1:${server.port}`, headers: {} }),
          },
          'ext-1',
        ),
      ).toEqual({
        observation: 'unknown',
        endReason: null,
        daemonAnswered: false,
        orphanedPrompt: false,
      });
    } finally {
      server.stop(true);
    }
  });

  // `turn_in_flight: false` is several different endings and only the daemon
  // holds the messages that tell them apart. It reports which one; the control
  // plane writes that word into session_turns.end_reason instead of guessing.
  test('carries the daemon-reported end reason through with the terminal answer', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ turn_in_flight: false, turn_end: 'failed' }),
    });
    try {
      expect(
        await observeSandboxTurn(
          {
            resolveEndpoint: async () => ({ url: `http://127.0.0.1:${server.port}`, headers: {} }),
          },
          'ext-1',
          'sb-1',
          { opencodeSessionId: 'ses_root', messageId: 'msg_turn_1' },
        ),
      ).toEqual({
        observation: 'terminal',
        endReason: 'failed',
        daemonAnswered: true,
        orphanedPrompt: false,
      });
    } finally {
      server.stop(true);
    }
  });

  test('a daemon that reports no end reason leaves it unset', async () => {
    // Every box running an agent build from before turn_end exists answers like
    // this, so it must be an ordinary case, not a parse failure.
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ turn_in_flight: false }) });
    try {
      expect(
        await observeSandboxTurn(
          {
            resolveEndpoint: async () => ({ url: `http://127.0.0.1:${server.port}`, headers: {} }),
          },
          'ext-1',
        ),
      ).toEqual({
        observation: 'terminal',
        endReason: null,
        daemonAnswered: true,
        orphanedPrompt: false,
      });
    } finally {
      server.stop(true);
    }
  });

  test('a sandbox cannot name a reason the control plane reserves for itself', async () => {
    // The box is the subject of the judgement. 'runtime_gone' is written only
    // by the stop writers, and free text would end up in the ledger column.
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ turn_in_flight: false, turn_end: 'runtime_gone' }),
    });
    try {
      expect(
        await observeSandboxTurn(
          {
            resolveEndpoint: async () => ({ url: `http://127.0.0.1:${server.port}`, headers: {} }),
          },
          'ext-1',
        ),
      ).toEqual({
        observation: 'terminal',
        endReason: null,
        daemonAnswered: true,
        orphanedPrompt: false,
      });
    } finally {
      server.stop(true);
    }
  });
});

// ── orchestration ────────────────────────────────────────────────────────────
const NOW = new Date('2026-06-21T12:00:00Z');
function candidate(over: Partial<any> = {}) {
  return {
    sandboxId: 'sb-1',
    sessionId: 'sess-1',
    accountId: 'acct-1',
    provider: 'daytona',
    externalId: 'ext-1',
    metadata: null,
    // Healthy by default: a live deadline. Tests that want a kill set it.
    deadlineAt: new Date(NOW.getTime() + HOUR),
    createdAt: new Date(NOW.getTime() - 2 * HOUR),
    ...over,
  };
}

describe('reapAndReconcileSandboxes — the one rule: deadline_at <= now', () => {
  // ═══ THE REGRESSION THIS EXISTS TO KILL ═══
  // Prod 2026-07-29: 187 running boxes, 156 with zero LLM usage_events, oldest
  // 264 HOURS. Three mechanisms — an execution lease the box renewed itself, a
  // busy probe answered by that same wedged daemon, and an activity clock the
  // lease renewal stamped — each vetoed the stop, and all three were written by
  // the subject of the judgement. The box forged the evidence used to judge it.
  test('REGRESSION: a WEDGED box with no observed turn dies at the ceiling', async () => {
    candidates = [
      candidate({
        // 264h old, exactly the observed worst case, and still claiming to be
        // busy via the metadata the old code trusted.
        createdAt: new Date(NOW.getTime() - 264 * HOUR),
        deadlineAt: new Date(NOW.getTime() - 1),
        metadata: {
          executionLeaseUntil: new Date(NOW.getTime() + 60_000).toISOString(),
          lastTurnAt: NOW.toISOString(),
        },
      }),
    ];
    statusByExternal['ext-1'] = 'running';

    const r = await reapAndReconcileSandboxes(NOW);

    expect(activeTurnRenewalCalls).toEqual([]);
    expect(r.stopped).toBe(1);
    expect(r.billingClosed).toBe(1);
    expect(stops).toEqual(['ext-1']);
    // Billing is settled against the still-active row before the flip.
    expect(pausedCompute).toEqual(['sb-1']);
    expect(cacheInvalidations).toEqual(['ext-1']);
    expect(
      updateCalls.some((c) => c.table === sessionSandboxes && c.updates.status === 'stopped'),
    ).toBe(true);
    expect(
      updateCalls.some((c) => c.table === projectSessions && c.updates.status === 'stopped'),
    ).toBe(true);
  });

  test('INSTANCE SCOPE: a box stamped by ANOTHER API instance is never probed or stopped here', async () => {
    // Shared local DB (projects/instance-scope.ts): instance A must never stop
    // instance B's boxes, however expired they look from here.
    reaperConfig.KORTIX_INSTANCE_ID = 'wt-a';
    try {
      candidates = [
        candidate({
          deadlineAt: new Date(NOW.getTime() - 1),
          metadata: { instanceId: 'primary' },
        }),
      ];
      statusByExternal['ext-1'] = 'running';

      const r = await reapAndReconcileSandboxes(NOW);

      expect(statusCalls).toEqual([]);
      expect(stops).toEqual([]);
      expect(r.stopped).toBe(0);
      expect(
        updateCalls.some((c) => c.table === sessionSandboxes && c.updates.status === 'stopped'),
      ).toBe(false);
    } finally {
      delete reaperConfig.KORTIX_INSTANCE_ID;
    }
  });

  test('INSTANCE SCOPE: own-stamped and legacy (unstamped) boxes are reaped as before', async () => {
    reaperConfig.KORTIX_INSTANCE_ID = 'wt-a';
    try {
      candidates = [
        candidate({ deadlineAt: new Date(NOW.getTime() - 1), metadata: { instanceId: 'wt-a' } }),
        candidate({
          sandboxId: 'sb-2',
          sessionId: 'sess-2',
          externalId: 'ext-2',
          deadlineAt: new Date(NOW.getTime() - 1),
          metadata: null,
        }),
      ];
      statusByExternal['ext-1'] = 'running';
      statusByExternal['ext-2'] = 'running';

      const r = await reapAndReconcileSandboxes(NOW);

      expect(stops.sort()).toEqual(['ext-1', 'ext-2']);
      expect(r.stopped).toBe(2);
    } finally {
      delete reaperConfig.KORTIX_INSTANCE_ID;
    }
  });

  test('INSTANCE SCOPE off (unset): a foreign-looking stamp changes nothing', async () => {
    candidates = [
      candidate({ deadlineAt: new Date(NOW.getTime() - 1), metadata: { instanceId: 'primary' } }),
    ];
    statusByExternal['ext-1'] = 'running';

    const r = await reapAndReconcileSandboxes(NOW);

    expect(stops).toEqual(['ext-1']);
    expect(r.stopped).toBe(1);
  });

  test('a box with an observed turn SURVIVES — its deadline is still ahead', async () => {
    candidates = [candidate({ deadlineAt: new Date(NOW.getTime() + 4 * HOUR) })];
    statusByExternal['ext-1'] = 'running';

    const r = await reapAndReconcileSandboxes(NOW);

    expect(r.skipped).toBe(1);
    expect(r.stopped).toBe(0);
    expect(stops).toEqual([]);
    expect(pausedCompute).toEqual([]);
    // The liveness stamp the merged billing clamp depends on is still written.
    expect(livenessStamps).toEqual([{ sandboxId: 'sb-1', at: NOW }]);
  });

  test('REGRESSION: an active tool-only turn renews past the one-minute deadline', async () => {
    candidates = [
      candidate({
        deadlineAt: new Date(NOW.getTime() - 1),
        metadata: {
          activeTurn: {
            token: 'turn-token',
            state: 'active',
            opencodeSessionId: 'ses_root',
            messageId: 'msg_turn_1',
          },
        },
      }),
    ];
    statusByExternal['ext-1'] = 'running';
    turnObservationByToken['turn-token'] = 'active';
    activeTurnRenewalBySandbox['sb-1'] = 'renewed';

    const r = await reapAndReconcileSandboxes(NOW);

    expect(activeTurnRenewalCalls).toEqual([{ sandboxId: 'sb-1', token: 'turn-token' }]);
    expect(r.stopped).toBe(0);
    expect(r.lifecycleRenewed).toBe(1);
    expect(timeoutRenewals).toEqual([{ provider: 'daytona', externalId: 'ext-1' }]);
  });

  test('the fast renewal lane excludes every row without durable turn authority', async () => {
    candidates = [
      candidate({
        sandboxId: 'sb-active',
        externalId: 'ext-active',
        deadlineAt: new Date(NOW.getTime() - 1),
        metadata: {
          activeTurns: {
            'turn-token': {
              token: 'turn-token',
              state: 'active',
              opencodeSessionId: 'ses_root',
              messageId: 'msg_turn_1',
            },
          },
        },
      }),
      candidate({
        sandboxId: 'sb-idle',
        externalId: 'ext-idle',
        deadlineAt: new Date(NOW.getTime() - 1),
        metadata: null,
      }),
    ];
    statusByExternal['ext-active'] = 'running';
    statusByExternal['ext-idle'] = 'running';
    turnObservationByToken['turn-token'] = 'active';
    activeTurnRenewalBySandbox['sb-active'] = 'renewed';

    const result = await reapAndReconcileSandboxes(NOW, {
      activeTurnsOnly: true,
    });

    expect(result.candidates).toBe(1);
    expect(result.lifecycleRenewed).toBe(1);
    expect(statusCalls).toEqual(['ext-active']);
    expect(stops).toEqual([]);
  });

  test('recovers an accepted prompt whose post-delivery database promotion failed', async () => {
    candidates = [
      candidate({
        deadlineAt: new Date(NOW.getTime() - 1),
        metadata: {
          activeTurn: {
            token: 'delivery-token',
            state: 'delivering',
            opencodeSessionId: 'ses_root',
            messageId: 'msg_turn_1',
          },
        },
      }),
    ];
    statusByExternal['ext-1'] = 'running';
    deliveringTurnObservationBySandbox['sb-1'] = 'active';
    activeTurnRenewalBySandbox['sb-1'] = 'renewed';

    const r = await reapAndReconcileSandboxes(NOW);

    expect(deliveringTurnRecoveryCalls).toEqual([
      { sandboxId: 'sb-1', token: 'delivery-token', observation: 'active' },
    ]);
    expect(r.stopped).toBe(0);
    expect(r.lifecycleRenewed).toBe(1);
    expect(timeoutRenewals).toEqual([{ provider: 'daytona', externalId: 'ext-1' }]);
  });

  test('never ACTS on a terminal read before the delivery grace deadline', async () => {
    // A delivering record can precede OpenCode persistence by a few seconds, so
    // inside its grace `turn_in_flight === false` proves nothing — the prompt
    // may simply not have landed yet. The record IS still probed (that answer is
    // the only evidence the drip below can be counted from); what the grace
    // suppresses is acting on it.
    candidates = [
      candidate({
        deadlineAt: new Date(NOW.getTime() + 1),
        metadata: {
          activeTurn: {
            token: 'delivery-token',
            state: 'delivering',
            opencodeSessionId: 'ses_root',
            messageId: 'msg_turn_1',
          },
        },
      }),
    ];
    statusByExternal['ext-1'] = 'running';
    deliveringTurnObservationBySandbox['sb-1'] = 'terminal';

    const r = await reapAndReconcileSandboxes(NOW);

    expect(deliveringTurnRecoveryCalls).toEqual([]);
    expect(clearedTurnCalls).toEqual([]);
    expect(huskFinalizeCalls).toEqual([]);
    expect(turnObservationCalls).toEqual([{ sandboxId: 'sb-1', token: 'delivery-token' }]);
    expect(r.stopped).toBe(0);
    expect(r.lifecycleRenewed).toBe(1);
  });

  test('promotes a delivering record the daemon confirms in flight inside its grace', async () => {
    // The repair is safe in the other direction: `turn_in_flight === true` is
    // positive proof the prompt reached OpenCode, so the record earns its
    // acceptance immediately instead of waiting out a grace it no longer needs.
    candidates = [
      candidate({
        deadlineAt: new Date(NOW.getTime() + 60_000),
        metadata: {
          activeTurn: {
            token: 'delivery-token',
            state: 'delivering',
            opencodeSessionId: 'ses_root',
            messageId: 'msg_turn_1',
          },
        },
      }),
    ];
    statusByExternal['ext-1'] = 'running';
    deliveringTurnObservationBySandbox['sb-1'] = 'active';
    activeTurnRenewalBySandbox['sb-1'] = 'renewed';

    const r = await reapAndReconcileSandboxes(NOW);

    expect(deliveringTurnRecoveryCalls).toEqual([
      { sandboxId: 'sb-1', token: 'delivery-token', observation: 'active' },
    ]);
    expect(activeTurnRenewalCalls).toEqual([{ sandboxId: 'sb-1', token: 'delivery-token' }]);
    expect(unconfirmedTurnDrips).toEqual([]);
    expect(r.stopped).toBe(0);
  });

  test('the delivery grace is the DELIVERY’s, not the box’s four-hour turn grant', async () => {
    // A prompt forwarded INTO a live turn writes a second, `delivering` record
    // on a box whose deadline the accepted turn already pushed four hours out.
    // Reading the BOX deadline as this record's grace made it unreconcilable
    // for those four hours: every pass skipped it, `claimExpiredSandboxStop`
    // refuses a box holding turn authority, and `GET .../turn` kept reporting
    // an open turn after the user pressed Stop.
    //
    // The grace belongs to the delivery, so it is measured from the record's
    // own `startedAtMs`.
    candidates = [
      candidate({
        deadlineAt: new Date(NOW.getTime() + 4 * HOUR),
        metadata: {
          activeTurns: {
            'delivery-token': {
              token: 'delivery-token',
              state: 'delivering',
              opencodeSessionId: 'ses_root',
              messageId: 'msg_turn_1',
              startedAtMs: NOW.getTime() - 20 * 60_000,
            },
          },
        },
      }),
    ];
    statusByExternal['ext-1'] = 'running';
    deliveringTurnObservationBySandbox['sb-1'] = 'terminal';

    await reapAndReconcileSandboxes(NOW);

    expect(deliveringTurnRecoveryCalls).toEqual([
      { sandboxId: 'sb-1', token: 'delivery-token', observation: 'terminal' },
    ]);
    expect(promptRedeliveries).toEqual([
      {
        sessionId: 'sess-1',
        wireMessageId: 'msg_turn_1',
        turnToken: 'delivery-token',
        endReason: 'abandoned',
      },
    ]);
  });

  test('a delivering record INSIDE its own grace is still left alone', async () => {
    // The other half of the rule above: the grace has to keep suppressing a
    // terminal read for a delivery OpenCode may simply not have persisted yet,
    // even when the box's own deadline has already passed.
    candidates = [
      candidate({
        deadlineAt: new Date(NOW.getTime() - 1),
        metadata: {
          activeTurns: {
            'delivery-token': {
              token: 'delivery-token',
              state: 'delivering',
              opencodeSessionId: 'ses_root',
              messageId: 'msg_turn_1',
              startedAtMs: NOW.getTime() - 5_000,
            },
          },
        },
      }),
    ];
    statusByExternal['ext-1'] = 'running';
    deliveringTurnObservationBySandbox['sb-1'] = 'terminal';

    await reapAndReconcileSandboxes(NOW);

    expect(deliveringTurnRecoveryCalls).toEqual([]);
    expect(promptRedeliveries).toEqual([]);
  });

  test('repairs a lost terminal relay before the prior active grant expires', async () => {
    candidates = [
      candidate({
        deadlineAt: new Date(NOW.getTime() + HOUR),
        metadata: {
          activeTurn: {
            token: 'active-token',
            state: 'active',
            opencodeSessionId: 'ses_root',
            messageId: 'msg_turn_1',
          },
        },
      }),
    ];
    statusByExternal['ext-1'] = 'running';
    deliveringTurnObservationBySandbox['sb-1'] = 'terminal';

    const result = await reapAndReconcileSandboxes(NOW);

    expect(clearedTurnCalls).toEqual([{ sandboxId: 'sb-1', token: 'active-token' }]);
    expect(promotedQueueSessions).toEqual(['sess-1']);
    expect(targetedQueueDrains).toEqual(['prompt:sess-1']);
    expect(result.stopped).toBe(0);
    expect(result.lifecycleRenewed).toBe(1);
  });

  test('removes a delivering record when OpenCode is terminal and allows expiry', async () => {
    candidates = [
      candidate({
        deadlineAt: new Date(NOW.getTime() - 1),
        metadata: {
          activeTurn: {
            token: 'delivery-token',
            state: 'delivering',
            opencodeSessionId: 'ses_root',
            messageId: 'msg_turn_1',
          },
        },
      }),
    ];
    statusByExternal['ext-1'] = 'running';
    deliveringTurnObservationBySandbox['sb-1'] = 'terminal';

    const r = await reapAndReconcileSandboxes(NOW);

    expect(deliveringTurnRecoveryCalls).toEqual([
      { sandboxId: 'sb-1', token: 'delivery-token', observation: 'terminal' },
    ]);
    expect(r.stopped).toBe(1);
    expect(timeoutRenewals).toEqual([]);
    // A prompt handed to a runtime that never turned it into a turn goes BACK
    // to the inbox — the whole point of the durable inbox.
    expect(promptRedeliveries).toEqual([
      {
        sessionId: 'sess-1',
        wireMessageId: 'msg_turn_1',
        turnToken: 'delivery-token',
        endReason: 'abandoned',
      },
    ]);
  });

  test('a delivering record the daemon says was ABANDONED redelivers under that reason', async () => {
    candidates = [
      candidate({
        deadlineAt: new Date(NOW.getTime() - 1),
        metadata: {
          activeTurn: {
            token: 'delivery-token',
            state: 'delivering',
            opencodeSessionId: 'ses_root',
            messageId: 'msg_turn_1',
          },
        },
      }),
    ];
    statusByExternal['ext-1'] = 'running';
    deliveringTurnObservationBySandbox['sb-1'] = 'terminal';
    daemonTurnEndBySandbox['sb-1'] = 'abandoned';

    await reapAndReconcileSandboxes(NOW);

    expect(promptRedeliveries.map((r) => r.endReason)).toEqual(['abandoned']);
  });

  test('a DELIVERING record the daemon says COMPLETED is never redelivered', async () => {
    // The record is still `delivering` only because the acceptance write lost
    // its race (`[turn-lifecycle] acceptance persistence failed … reaper will
    // reconcile delivery`) — the turn itself ran to the end. `completed` is
    // proof of that, so the prompt must NOT go back to the inbox: it would run
    // the user's message a second time.
    candidates = [
      candidate({
        deadlineAt: new Date(NOW.getTime() - 1),
        metadata: {
          activeTurn: {
            token: 'delivery-token',
            state: 'delivering',
            opencodeSessionId: 'ses_root',
            messageId: 'msg_turn_1',
          },
        },
      }),
    ];
    statusByExternal['ext-1'] = 'running';
    deliveringTurnObservationBySandbox['sb-1'] = 'terminal';
    daemonTurnEndBySandbox['sb-1'] = 'completed';

    await reapAndReconcileSandboxes(NOW);

    expect(promptRedeliveries).toEqual([]);
  });

  test('a DELIVERING record the daemon says FAILED is never redelivered', async () => {
    candidates = [
      candidate({
        deadlineAt: new Date(NOW.getTime() - 1),
        metadata: {
          activeTurn: {
            token: 'delivery-token',
            state: 'delivering',
            opencodeSessionId: 'ses_root',
            messageId: 'msg_turn_1',
          },
        },
      }),
    ];
    statusByExternal['ext-1'] = 'running';
    deliveringTurnObservationBySandbox['sb-1'] = 'terminal';
    daemonTurnEndBySandbox['sb-1'] = 'failed';

    await reapAndReconcileSandboxes(NOW);

    expect(promptRedeliveries).toEqual([]);
  });

  test('an ACTIVE record the daemon reports ORPHANED gives its prompt back', async () => {
    // THE INCIDENT THIS WHOLE STEP EXISTS FOR. A record is `delivering` for one
    // upstream round trip only: OpenCode 200s the `prompt_async` and
    // `acceptTurnLifecycle` promotes it to `active` within milliseconds. If
    // OpenCode is then killed before the first assistant token and respawns —
    // keeping the persisted user message, losing the in-memory queue — the
    // record is `active`, so the `delivering` branches never see it.
    //
    // `turn_orphaned_prompt` is the daemon saying exactly that: this prompt is
    // on record and nothing answered it. It is evidence about the PROMPT, so it
    // is what the redelivery reads — not the record's state, which only ever
    // described how far the acceptance write got.
    candidates = [
      candidate({
        deadlineAt: new Date(NOW.getTime() + HOUR),
        metadata: {
          activeTurn: {
            token: 'active-token',
            state: 'active',
            opencodeSessionId: 'ses_root',
            messageId: 'msg_turn_1',
            // Past ORPHANED_PROMPT_MIN_AGE_MS — see the sibling test below for
            // why a record this young is not orphaned yet.
            startedAtMs: NOW.getTime() - 120_000,
          },
        },
      }),
    ];
    statusByExternal['ext-1'] = 'running';
    deliveringTurnObservationBySandbox['sb-1'] = 'terminal';
    orphanedPromptByToken['active-token'] = true;

    await reapAndReconcileSandboxes(NOW);

    expect(clearedTurnCalls).toEqual([{ sandboxId: 'sb-1', token: 'active-token' }]);
    expect(promptRedeliveries).toEqual([
      {
        sessionId: 'sess-1',
        wireMessageId: 'msg_turn_1',
        turnToken: 'active-token',
        endReason: 'abandoned',
      },
    ]);
  });

  test('a JUST-ACCEPTED record is not orphaned yet — and its clear DEFERS, never swallows', async () => {
    // "User message on record, no assistant message, root idle" is also what
    // the moments between OpenCode ACKing a prompt and starting it look like.
    // Redelivering into that window runs the user's prompt twice.
    //
    // EXPECTATION CHANGED 2026-08-20 (live incident, Essentia session
    // d1b74954): this used to CLEAR the record while skipping the redelivery.
    // Clearing deletes the record — the only thing that can ever trigger the
    // redelivery — so a terminal observation landing inside the age floor was
    // a one-shot race that swallowed the prompt for good (cleared `unknown` at
    // age 27s, 3s under the floor, never answered). Now the young orphan
    // DEFERS: nothing is cleared, nothing is redelivered, and the next pass
    // (~20s later) decides with the age check satisfied.
    candidates = [
      candidate({
        deadlineAt: new Date(NOW.getTime() + HOUR),
        metadata: {
          activeTurn: {
            token: 'active-token',
            state: 'active',
            opencodeSessionId: 'ses_root',
            messageId: 'msg_turn_1',
            startedAtMs: NOW.getTime() - 2_000,
          },
        },
      }),
    ];
    statusByExternal['ext-1'] = 'running';
    deliveringTurnObservationBySandbox['sb-1'] = 'terminal';
    orphanedPromptByToken['active-token'] = true;

    await reapAndReconcileSandboxes(NOW);

    expect(clearedTurnCalls).toEqual([]);
    expect(promptRedeliveries).toEqual([]);
  });

  test('a turn that RAN is never redelivered, whatever the reaper had to clean up', async () => {
    // An `active` record observed terminal with NO orphan evidence is a turn
    // nothing can prove never ran, so it is left alone. Only the daemon's
    // `turn_orphaned_prompt` (the test above) turns this branch into a
    // redelivery.
    candidates = [
      candidate({
        deadlineAt: new Date(NOW.getTime() + HOUR),
        metadata: {
          activeTurn: {
            token: 'active-token',
            state: 'active',
            opencodeSessionId: 'ses_root',
            messageId: 'msg_turn_1',
          },
        },
      }),
    ];
    statusByExternal['ext-1'] = 'running';
    deliveringTurnObservationBySandbox['sb-1'] = 'terminal';

    await reapAndReconcileSandboxes(NOW);

    expect(clearedTurnCalls).toEqual([{ sandboxId: 'sb-1', token: 'active-token' }]);
    expect(promptRedeliveries).toEqual([]);
  });

  test('a delivering record with NO wire message id has no prompt to give back', async () => {
    // Trigger/Slack deliveries carry no client-minted id, so there is nothing
    // to match a durable row by — they keep today's behavior exactly.
    candidates = [
      candidate({
        deadlineAt: new Date(NOW.getTime() - 1),
        metadata: {
          activeTurn: {
            token: 'delivery-token',
            state: 'delivering',
            opencodeSessionId: 'ses_root',
            messageId: null,
          },
        },
      }),
    ];
    statusByExternal['ext-1'] = 'running';
    deliveringTurnObservationBySandbox['sb-1'] = 'terminal';

    await reapAndReconcileSandboxes(NOW);

    expect(promptRedeliveries).toEqual([]);
  });

  test('an indeterminate delivery stops after its persisted delivery grace expires', async () => {
    candidates = [
      candidate({
        deadlineAt: new Date(NOW.getTime() - 1),
        metadata: {
          activeTurn: {
            token: 'delivery-token',
            state: 'delivering',
            opencodeSessionId: 'ses_root',
            messageId: 'msg_turn_1',
          },
        },
      }),
    ];
    statusByExternal['ext-1'] = 'running';
    deliveringTurnObservationBySandbox['sb-1'] = 'unknown';

    const r = await reapAndReconcileSandboxes(NOW);

    expect(deliveringTurnRecoveryCalls).toEqual([
      { sandboxId: 'sb-1', token: 'delivery-token', observation: 'unknown' },
    ]);
    expect(clearedTurnCalls).toEqual([{ sandboxId: 'sb-1', token: 'delivery-token' }]);
    expect(r.stopped).toBe(1);
    expect(r.lifecycleRenewed).toBe(0);
    expect(timeoutRenewals).toEqual([]);
  });

  test('fresh OpenCode evidence renews an active turn without a wall-clock cap', async () => {
    candidates = [
      candidate({
        createdAt: new Date(NOW.getTime() - 25 * HOUR),
        deadlineAt: new Date(NOW.getTime() - 1),
        metadata: {
          activeTurns: {
            'long-turn': {
              token: 'long-turn',
              state: 'active',
              opencodeSessionId: 'ses_root',
              messageId: 'msg_long',
            },
          },
        },
      }),
    ];
    statusByExternal['ext-1'] = 'running';
    turnObservationByToken['long-turn'] = 'active';
    activeTurnRenewalBySandbox['sb-1'] = 'renewed';

    const r = await reapAndReconcileSandboxes(NOW);

    expect(activeTurnRenewalCalls).toEqual([{ sandboxId: 'sb-1', token: 'long-turn' }]);
    expect(r.stopped).toBe(0);
    expect(r.lifecycleRenewed).toBe(1);
    expect(timeoutRenewals).toEqual([{ provider: 'daytona', externalId: 'ext-1' }]);
  });

  test('an expired active record clears only after exact terminal evidence', async () => {
    candidates = [
      candidate({
        deadlineAt: new Date(NOW.getTime() - 1),
        metadata: {
          activeTurn: {
            token: 'active-token',
            state: 'active',
            opencodeSessionId: 'ses_root',
            messageId: 'msg_turn_1',
          },
        },
      }),
    ];
    statusByExternal['ext-1'] = 'running';
    deliveringTurnObservationBySandbox['sb-1'] = 'terminal';

    const r = await reapAndReconcileSandboxes(NOW);

    expect(clearedTurnCalls).toEqual([{ sandboxId: 'sb-1', token: 'active-token' }]);
    expect(r.stopped).toBe(1);
  });

  test('a terminal turn cannot stop a concurrent active turn', async () => {
    candidates = [
      candidate({
        deadlineAt: new Date(NOW.getTime() - 1),
        metadata: {
          activeTurns: {
            'first-token': {
              token: 'first-token',
              state: 'active',
              opencodeSessionId: 'ses_root',
              messageId: 'msg_first',
              startedAtMs: NOW.getTime() - 2_000,
            },
            'second-token': {
              token: 'second-token',
              state: 'active',
              opencodeSessionId: 'ses_root',
              messageId: 'msg_second',
              startedAtMs: NOW.getTime() - 1_000,
            },
          },
        },
      }),
    ];
    statusByExternal['ext-1'] = 'running';
    turnObservationByToken['first-token'] = 'terminal';
    turnObservationByToken['second-token'] = 'active';
    activeTurnRenewalBySandbox['sb-1'] = 'renewed';

    const result = await reapAndReconcileSandboxes(NOW);

    expect(clearedTurnCalls).toEqual([{ sandboxId: 'sb-1', token: 'first-token' }]);
    expect(activeTurnRenewalCalls).toEqual([{ sandboxId: 'sb-1', token: 'second-token' }]);
    expect(timeoutRenewals).toEqual([{ provider: 'daytona', externalId: 'ext-1' }]);
    expect(stops).toEqual([]);
    expect(result.stopped).toBe(0);
    expect(result.lifecycleRenewed).toBe(1);
    // Both records share ONE OpenCode root, and the abort the finalizer can
    // issue is root-scoped. The finalizer is therefore handed the terminal
    // turn's OWN message identity — never the live sibling's — which is the
    // only thing that lets it refuse to abort while `msg_second` is streaming
    // (husk-finalizer.test.ts proves the refusal against the real module).
    expect(huskFinalizeCalls).toEqual([
      {
        sandboxId: 'sb-1',
        externalId: 'ext-1',
        opencodeSessionId: 'ses_root',
        messageId: 'msg_first',
      },
    ]);
  });

  // ── the husk: "no turn in flight" is NOT "the assistant message is closed" ──
  // The daemon answers `turn_in_flight: false` the moment OpenCode's root goes
  // idle, even when the last assistant message was never completed. Deleting the
  // turn record on that evidence alone leaves every client streaming the root
  // spinning forever, with no record left that anything ran.
  test('an accepted turn observed terminal finalizes the husk BEFORE clearing the record', async () => {
    candidates = [
      candidate({
        deadlineAt: new Date(NOW.getTime() - 1),
        metadata: {
          activeTurns: {
            'active-token': {
              token: 'active-token',
              state: 'active',
              opencodeSessionId: 'ses_root',
              messageId: 'msg_turn_1',
            },
          },
        },
      }),
    ];
    statusByExternal['ext-1'] = 'running';
    deliveringTurnObservationBySandbox['sb-1'] = 'terminal';
    huskOutcomeBySandbox['sb-1'] = 'finalized';

    const r = await reapAndReconcileSandboxes(NOW);

    expect(huskFinalizeCalls).toEqual([
      {
        sandboxId: 'sb-1',
        externalId: 'ext-1',
        opencodeSessionId: 'ses_root',
        messageId: 'msg_turn_1',
      },
    ]);
    expect(lifecycleCallOrder).toEqual(['husk:ses_root', 'clear:active-token']);
    expect(r.husksFinalized).toBe(1);
  });

  // A finalizer that cannot read the box must not become a reason to KEEP the
  // box. The record still holds the four-hour turn grant here; only the clear
  // pulls the deadline in to the idle tail (clearSandboxTurn), and
  // claimExpiredSandboxStop refuses to stop a box that owns turn authority. So
  // an unreachable daemon that held its record would keep billing compute for
  // the rest of the grant. Terminal evidence clears, whatever the finalizer did.
  test('an unreadable transcript never holds the record: terminal evidence still clears', async () => {
    candidates = [
      candidate({
        deadlineAt: new Date(NOW.getTime() + HOUR),
        metadata: {
          activeTurns: {
            'active-token': {
              token: 'active-token',
              state: 'active',
              opencodeSessionId: 'ses_root',
              messageId: 'msg_turn_1',
            },
          },
        },
      }),
    ];
    statusByExternal['ext-1'] = 'running';
    deliveringTurnObservationBySandbox['sb-1'] = 'terminal';
    huskOutcomeBySandbox['sb-1'] = 'unreadable';

    const r = await reapAndReconcileSandboxes(NOW);

    expect(clearedTurnCalls).toEqual([{ sandboxId: 'sb-1', token: 'active-token' }]);
    expect(r.husksFinalized).toBe(0);
    expect(r.stopped).toBe(0);
  });

  test('an unreadable transcript clears and stops once the deadline has expired', async () => {
    candidates = [
      candidate({
        deadlineAt: new Date(NOW.getTime() - 1),
        metadata: {
          activeTurns: {
            'active-token': {
              token: 'active-token',
              state: 'active',
              opencodeSessionId: 'ses_root',
              messageId: 'msg_turn_1',
            },
          },
        },
      }),
    ];
    statusByExternal['ext-1'] = 'running';
    deliveringTurnObservationBySandbox['sb-1'] = 'terminal';
    huskOutcomeBySandbox['sb-1'] = 'unreadable';

    const r = await reapAndReconcileSandboxes(NOW);

    expect(clearedTurnCalls).toEqual([{ sandboxId: 'sb-1', token: 'active-token' }]);
    expect(r.stopped).toBe(1);
  });

  test('a turn with no opencodeSessionId is never handed to the finalizer', async () => {
    candidates = [
      candidate({
        deadlineAt: new Date(NOW.getTime() - 1),
        metadata: {
          activeTurns: {
            'active-token': {
              token: 'active-token',
              state: 'active',
              opencodeSessionId: null,
              messageId: 'msg_turn_1',
            },
          },
        },
      }),
    ];
    statusByExternal['ext-1'] = 'running';
    deliveringTurnObservationBySandbox['sb-1'] = 'terminal';

    const r = await reapAndReconcileSandboxes(NOW);

    expect(huskFinalizeCalls).toEqual([]);
    expect(clearedTurnCalls).toEqual([{ sandboxId: 'sb-1', token: 'active-token' }]);
    expect(r.husksFinalized).toBe(0);
  });

  test('an active observation never touches the finalizer', async () => {
    candidates = [
      candidate({
        deadlineAt: new Date(NOW.getTime() - 1),
        metadata: {
          activeTurns: {
            'active-token': {
              token: 'active-token',
              state: 'active',
              opencodeSessionId: 'ses_root',
              messageId: 'msg_turn_1',
            },
          },
        },
      }),
    ];
    statusByExternal['ext-1'] = 'running';
    turnObservationByToken['active-token'] = 'active';
    activeTurnRenewalBySandbox['sb-1'] = 'renewed';

    const r = await reapAndReconcileSandboxes(NOW);

    expect(huskFinalizeCalls).toEqual([]);
    expect(clearedTurnCalls).toEqual([]);
    expect(r.lifecycleRenewed).toBe(1);
  });

  // `end_reason` exists to separate "the turn finished" from "the runtime went
  // away mid-turn" and from "the prompt never landed". `terminal` alone proves
  // NONE of those — it is only `turn_in_flight === false`, which the daemon
  // answers for a completion, a hard model error and a message it never
  // received alike. So the reason is the daemon's word, never an assumption.
  const activeTurnCandidate = (deadlineAt: Date) =>
    candidate({
      deadlineAt,
      metadata: {
        activeTurns: {
          'active-token': {
            token: 'active-token',
            state: 'active',
            opencodeSessionId: 'ses_root',
            messageId: 'msg_turn_1',
          },
        },
      },
    });

  test('a terminal daemon observation settles the ledger with the reason the daemon reported', async () => {
    candidates = [activeTurnCandidate(new Date(NOW.getTime() + HOUR))];
    statusByExternal['ext-1'] = 'running';
    deliveringTurnObservationBySandbox['sb-1'] = 'terminal';
    daemonTurnEndBySandbox['sb-1'] = 'completed';

    await reapAndReconcileSandboxes(NOW);

    expect(clearedTurnCalls).toEqual([{ sandboxId: 'sb-1', token: 'active-token' }]);
    expect(clearedTurnReasons).toEqual(['completed']);
  });

  test('a turn the model killed is recorded failed, exactly as the session.error relay records it', async () => {
    // Same real event, two observers. If the ~20s pass wins the race it must
    // not rename the outcome — the relay writes 'failed' (completeSandboxTurn)
    // and the first settle is final.
    candidates = [activeTurnCandidate(new Date(NOW.getTime() + HOUR))];
    statusByExternal['ext-1'] = 'running';
    deliveringTurnObservationBySandbox['sb-1'] = 'terminal';
    daemonTurnEndBySandbox['sb-1'] = 'failed';

    await reapAndReconcileSandboxes(NOW);

    expect(clearedTurnReasons).toEqual(['failed']);
  });

  test('a husk the reaper had to force-close is failed, never completed', async () => {
    // The finalizer just ABORTED an assistant message that was still open. A
    // turn the control plane had to end did not finish.
    candidates = [activeTurnCandidate(new Date(NOW.getTime() + HOUR))];
    statusByExternal['ext-1'] = 'running';
    deliveringTurnObservationBySandbox['sb-1'] = 'terminal';
    huskOutcomeBySandbox['sb-1'] = 'finalized';

    const r = await reapAndReconcileSandboxes(NOW);

    expect(r.husksFinalized).toBe(1);
    expect(clearedTurnReasons).toEqual(['failed']);
  });

  test('a terminal answer no observer can explain is recorded unknown', async () => {
    // An agent build from before turn_end, or an OpenCode state its messages
    // cannot classify. The turn is over; nothing here says how. Naming it
    // 'completed' would make end_reason unable to answer its one question.
    candidates = [activeTurnCandidate(new Date(NOW.getTime() + HOUR))];
    statusByExternal['ext-1'] = 'running';
    deliveringTurnObservationBySandbox['sb-1'] = 'terminal';
    huskOutcomeBySandbox['sb-1'] = 'not_husk';

    await reapAndReconcileSandboxes(NOW);

    expect(clearedTurnReasons).toEqual(['unknown']);
  });

  test('a delivering turn the daemon never saw is reconciled as abandoned', async () => {
    // The prompt is not in the root at all. The user watched their message
    // vanish; the ledger has to say so.
    candidates = [
      candidate({
        deadlineAt: new Date(NOW.getTime() - 1),
        metadata: {
          activeTurns: {
            'delivering-token': {
              token: 'delivering-token',
              state: 'delivering',
              opencodeSessionId: 'ses_root',
              messageId: 'msg_turn_1',
            },
          },
        },
      }),
    ];
    statusByExternal['ext-1'] = 'running';
    deliveringTurnObservationBySandbox['sb-1'] = 'terminal';
    daemonTurnEndBySandbox['sb-1'] = 'abandoned';

    await reapAndReconcileSandboxes(NOW);

    expect(deliveringTurnRecoveryCalls).toEqual([
      {
        sandboxId: 'sb-1',
        token: 'delivering-token',
        observation: 'terminal',
        reason: 'abandoned',
      },
    ]);
  });

  test('an unreadable daemon past its deadline settles the ledger as a lost runtime', async () => {
    candidates = [
      candidate({
        deadlineAt: new Date(NOW.getTime() - 1),
        metadata: {
          activeTurns: {
            'active-token': {
              token: 'active-token',
              state: 'active',
              opencodeSessionId: 'ses_root',
              messageId: 'msg_turn_1',
            },
          },
        },
      }),
    ];
    statusByExternal['ext-1'] = 'running';
    deliveringTurnObservationBySandbox['sb-1'] = 'unknown';

    await reapAndReconcileSandboxes(NOW);

    expect(clearedTurnCalls).toEqual([{ sandboxId: 'sb-1', token: 'active-token' }]);
    // Nothing here proves the turn finished, so the default reason stands.
    expect(clearedTurnReasons).toEqual([undefined]);
  });

  // ═══ THE SILENT RENEWAL STARVATION THIS CLOSES ═══
  // Incident 2026-08-17T20:40:03Z (session 0fc6897a): `deadlineGrant` stayed
  // `boot_floor` for the box's whole life. The daemon on that warm snapshot
  // answered the turn probe with nothing readable, so `observeSandboxTurn`
  // never returned `active`, `renewActiveSandboxTurn` never ran, and the box
  // reached its 15-minute resume floor mid-turn. A provider-RUNNING box holding
  // a RECENT control-plane-minted turn record is far more likely mid-turn with
  // a mute daemon than abandoned, so it gets a bounded drip instead of silence.
  const unknownTurnCandidate = (
    startedAtMs: number | null,
    deadlineAt = new Date(NOW.getTime() + 60_000),
  ) =>
    candidate({
      deadlineAt,
      metadata: {
        activeTurns: {
          'mute-token': {
            token: 'mute-token',
            state: 'active',
            opencodeSessionId: 'ses_root',
            messageId: 'msg_turn_1',
            ...(startedAtMs === null ? {} : { startedAtMs }),
          },
        },
      },
    });

  test('REGRESSION: a daemon that answers without describing the turn is drip-extended', async () => {
    candidates = [unknownTurnCandidate(NOW.getTime() - 10 * 60_000)];
    statusByExternal['ext-1'] = 'running';
    turnObservationByToken['mute-token'] = 'unknown';

    const r = await reapAndReconcileSandboxes(NOW);

    expect(unconfirmedTurnDrips).toEqual(['sb-1']);
    // Nothing else changes: the record is untouched and the box lives on.
    expect(clearedTurnCalls).toEqual([]);
    expect(activeTurnRenewalCalls).toEqual([]);
    expect(r.stopped).toBe(0);
    expect(r.lifecycleRenewed).toBe(1);
  });

  // ═══ THE PROBE ITSELF WAS THE LOAD ═══
  // Essentia 2026-08-25 (session 9df2a873): two API replicas re-asked one box
  // 345 times in an hour after `unknown`; every ask made OpenCode serialise
  // its 140 MB transcript, and the kernel OOM-killed it mid-turn. An unknown
  // answer now backs the PROBE off (20 s → 5 min) while the drip still runs.
  test('REGRESSION: after an unknown answer the box is not re-probed until its back-off elapses', async () => {
    candidates = [unknownTurnCandidate(NOW.getTime() - 10 * 60_000)];
    statusByExternal['ext-1'] = 'running';
    turnObservationByToken['mute-token'] = 'unknown';

    await reapAndReconcileSandboxes(NOW);
    expect(turnObservationCalls).toHaveLength(1);
    expect(unconfirmedTurnDrips).toEqual(['sb-1']);

    // 10 s later: still inside the 20 s back-off — dripped, NOT probed.
    unconfirmedTurnDrips = [];
    await reapAndReconcileSandboxes(new Date(NOW.getTime() + 10_000));
    expect(turnObservationCalls).toHaveLength(1);
    expect(unconfirmedTurnDrips).toEqual(['sb-1']);

    // 25 s later: back-off elapsed — probed again; still unknown → back-off doubles to 40 s.
    await reapAndReconcileSandboxes(new Date(NOW.getTime() + 25_000));
    expect(turnObservationCalls).toHaveLength(2);
    await reapAndReconcileSandboxes(new Date(NOW.getTime() + 55_000));
    expect(turnObservationCalls).toHaveLength(2);
    await reapAndReconcileSandboxes(new Date(NOW.getTime() + 70_000));
    expect(turnObservationCalls).toHaveLength(3);

    // A readable answer clears it: the next pass probes at once.
    turnObservationByToken['mute-token'] = 'active';
    await reapAndReconcileSandboxes(new Date(NOW.getTime() + 200_000));
    expect(turnObservationCalls).toHaveLength(4);
    await reapAndReconcileSandboxes(new Date(NOW.getTime() + 201_000));
    expect(turnObservationCalls).toHaveLength(5);
  });

  // ═══ THE BILLED DEAD TIME THIS CLOSES ═══
  // A daemon that answers NOTHING — an unreachable box, a wedged opencode, a
  // sandbox whose daemon never bound its port — is not evidence of live work.
  // Dripping it replaces the bound its record actually carries with a horizon
  // per pass for as long as the record stays fresh, which on a boot record is
  // the difference between ~15 minutes and hours of billed dead time. The drip
  // needs the runtime to ANSWER; only what it said may be unreadable.
  test('REGRESSION: a daemon that answers nothing at all earns no drip', async () => {
    candidates = [unknownTurnCandidate(NOW.getTime() - 60_000)];
    statusByExternal['ext-1'] = 'running';
    turnObservationByToken['mute-token'] = 'unknown';
    daemonAnsweredByToken['mute-token'] = false;

    await reapAndReconcileSandboxes(NOW);

    expect(unconfirmedTurnDrips).toEqual([]);
  });

  test('one answering probe is enough when a sibling probe times out', async () => {
    // Two records, one daemon. An answer about either proves the runtime is up.
    candidates = [
      candidate({
        deadlineAt: new Date(NOW.getTime() + 60_000),
        metadata: {
          activeTurns: {
            'mute-token': {
              token: 'mute-token',
              state: 'active',
              opencodeSessionId: 'ses_root',
              messageId: 'msg_mute',
              startedAtMs: NOW.getTime() - 60_000,
            },
            'timeout-token': {
              token: 'timeout-token',
              state: 'active',
              opencodeSessionId: 'ses_root',
              messageId: 'msg_timeout',
              startedAtMs: NOW.getTime() - 30_000,
            },
          },
        },
      }),
    ];
    statusByExternal['ext-1'] = 'running';
    turnObservationByToken['mute-token'] = 'unknown';
    turnObservationByToken['timeout-token'] = 'unknown';
    daemonAnsweredByToken['timeout-token'] = false;

    await reapAndReconcileSandboxes(NOW);

    expect(unconfirmedTurnDrips).toEqual(['sb-1']);
  });

  test('a turn record older than the four-hour grant gets no drip', async () => {
    // Past the grant the record is no longer evidence of live work, so an
    // unreadable daemon stops buying compute and the box dies on its deadline.
    candidates = [unknownTurnCandidate(NOW.getTime() - 5 * HOUR)];
    statusByExternal['ext-1'] = 'running';
    turnObservationByToken['mute-token'] = 'unknown';

    await reapAndReconcileSandboxes(NOW);

    expect(unconfirmedTurnDrips).toEqual([]);
  });

  test('a record with no start instant gets no drip — freshness must be proven', async () => {
    // A legacy `activeTurn` written before startedAtMs existed carries no start
    // instant. Inventing one would make every box with an unreadable daemon
    // immortal.
    candidates = [unknownTurnCandidate(null)];
    statusByExternal['ext-1'] = 'running';
    turnObservationByToken['mute-token'] = 'unknown';

    await reapAndReconcileSandboxes(NOW);

    expect(unconfirmedTurnDrips).toEqual([]);
  });

  test('a daemon that ANSWERS is never drip-extended', async () => {
    // The terminal path is untouched: a daemon that says "no turn" still pulls
    // the deadline in to the idle tail.
    candidates = [unknownTurnCandidate(NOW.getTime() - 60_000)];
    statusByExternal['ext-1'] = 'running';
    turnObservationByToken['mute-token'] = 'terminal';

    await reapAndReconcileSandboxes(NOW);

    expect(unconfirmedTurnDrips).toEqual([]);
    expect(clearedTurnCalls).toEqual([{ sandboxId: 'sb-1', token: 'mute-token' }]);
  });

  test('one readable turn is enough — a renewed box needs no drip', async () => {
    candidates = [
      candidate({
        deadlineAt: new Date(NOW.getTime() + 60_000),
        metadata: {
          activeTurns: {
            'mute-token': {
              token: 'mute-token',
              state: 'active',
              opencodeSessionId: 'ses_root',
              messageId: 'msg_mute',
              startedAtMs: NOW.getTime() - 60_000,
            },
            'live-token': {
              token: 'live-token',
              state: 'active',
              opencodeSessionId: 'ses_root',
              messageId: 'msg_live',
              startedAtMs: NOW.getTime() - 30_000,
            },
          },
        },
      }),
    ];
    statusByExternal['ext-1'] = 'running';
    turnObservationByToken['mute-token'] = 'unknown';
    turnObservationByToken['live-token'] = 'active';
    activeTurnRenewalBySandbox['sb-1'] = 'renewed';

    await reapAndReconcileSandboxes(NOW);

    expect(unconfirmedTurnDrips).toEqual([]);
    expect(activeTurnRenewalCalls).toEqual([{ sandboxId: 'sb-1', token: 'live-token' }]);
  });

  // ═══ THE SHAPE THE INCIDENT ACTUALLY HAD ═══
  // A session created with an initial prompt carries a `delivering` record
  // (initialSandboxTurnMetadata) that ONLY the daemon's `turn_accepted` callback
  // promotes. The incident's daemon was mute, so the record never left
  // `delivering` and `deadlineGrant` never left `boot_floor` — a box dying on a
  // 15-minute floor mid-turn is by definition a box whose record was never
  // accepted. While such a record was skipped instead of probed,
  // `unreadableTurns` stayed 0 and the drip's `unreadableTurns === turns.length`
  // could never hold; once the floor lapsed the record WAS probed but the drip
  // was then blocked by its own `deadlineAt > now` guard. The two conditions
  // were mutually exclusive, so the drip could never fire for the one shape it
  // was written for.
  const bootDeliveringCandidate = (startedAtMs: number) =>
    candidate({
      deadlineAt: new Date(NOW.getTime() + 10 * 60_000),
      metadata: {
        activeTurns: {
          'boot-token': {
            token: 'boot-token',
            state: 'delivering',
            opencodeSessionId: null,
            messageId: 'msg_boot',
            startedAtMs,
          },
        },
      },
    });

  test('REGRESSION: an answering daemon on a boot DELIVERING record is drip-extended', async () => {
    candidates = [bootDeliveringCandidate(NOW.getTime() - 5 * 60_000)];
    statusByExternal['ext-1'] = 'running';
    turnObservationByToken['boot-token'] = 'unknown';

    const r = await reapAndReconcileSandboxes(NOW);

    expect(turnObservationCalls).toEqual([{ sandboxId: 'sb-1', token: 'boot-token' }]);
    expect(unconfirmedTurnDrips).toEqual(['sb-1']);
    expect(clearedTurnCalls).toEqual([]);
    expect(r.stopped).toBe(0);
  });

  // ═══ THE DELIVERY GRACE THIS PROTECTS ═══
  // `delivering` means NOTHING has confirmed the prompt reached OpenCode, and
  // sandbox-deadline-policy.ts is explicit about what such a record is worth:
  // "a failed delivery expires on this short grace instead of retaining a
  // four-hour active-turn window". Measuring a delivering record against the
  // four-hour TURN grant hands it that window one horizon at a time — the drip
  // becomes the thing that defeats the grace, and a box whose prompt never
  // landed bills for hours instead of minutes.
  test('REGRESSION: a delivering record past its delivery grace earns no drip', async () => {
    candidates = [bootDeliveringCandidate(NOW.getTime() - 20 * 60_000)];
    statusByExternal['ext-1'] = 'running';
    turnObservationByToken['boot-token'] = 'unknown';

    await reapAndReconcileSandboxes(NOW);

    expect(unconfirmedTurnDrips).toEqual([]);
  });

  test('an ACCEPTED record keeps the full four-hour bound', async () => {
    // The asymmetry is the point: acceptance is proof the prompt reached
    // OpenCode, so the record is measured against the turn grant. A delivering
    // record has no such proof and is measured against its own delivery grace.
    candidates = [unknownTurnCandidate(NOW.getTime() - 3 * HOUR)];
    statusByExternal['ext-1'] = 'running';
    turnObservationByToken['mute-token'] = 'unknown';

    await reapAndReconcileSandboxes(NOW);

    expect(unconfirmedTurnDrips).toEqual(['sb-1']);
  });

  test('a delivering record inside its grace does not suppress the drip for the box', async () => {
    // The mixed shape: a second prompt still `delivering` beside an accepted
    // record the daemon will not answer for. Both are mute, so the box is still
    // mid-turn behind a mute daemon and still earns its horizon.
    candidates = [
      candidate({
        deadlineAt: new Date(NOW.getTime() + 60_000),
        metadata: {
          activeTurns: {
            'mute-token': {
              token: 'mute-token',
              state: 'active',
              opencodeSessionId: 'ses_root',
              messageId: 'msg_mute',
              startedAtMs: NOW.getTime() - 60_000,
            },
            'delivery-token': {
              token: 'delivery-token',
              state: 'delivering',
              opencodeSessionId: 'ses_root',
              messageId: 'msg_turn_1',
              startedAtMs: NOW.getTime() - 1_000,
            },
          },
        },
      }),
    ];
    statusByExternal['ext-1'] = 'running';
    turnObservationByToken['mute-token'] = 'unknown';
    turnObservationByToken['delivery-token'] = 'unknown';

    await reapAndReconcileSandboxes(NOW);

    expect(unconfirmedTurnDrips).toEqual(['sb-1']);
    expect(clearedTurnCalls).toEqual([]);
  });

  test('a delivering record with no start instant still gets no drip', async () => {
    // Freshness must be PROVEN, whatever the record's state. Inventing a start
    // instant would make every box with an unreachable daemon immortal.
    candidates = [
      candidate({
        deadlineAt: new Date(NOW.getTime() + 60_000),
        metadata: {
          activeTurns: {
            'delivery-token': {
              token: 'delivery-token',
              state: 'delivering',
              opencodeSessionId: 'ses_root',
              messageId: 'msg_turn_1',
            },
          },
        },
      }),
    ];
    statusByExternal['ext-1'] = 'running';
    turnObservationByToken['delivery-token'] = 'unknown';

    await reapAndReconcileSandboxes(NOW);

    expect(unconfirmedTurnDrips).toEqual([]);
  });

  test('REGRESSION: an already-expired deadline is never resurrected by the drip', async () => {
    // Once the deadline has passed with nothing but unknown evidence, the
    // existing path clears the record and parks the box. The drip is a
    // PRE-expiry extension, not a way back from one.
    candidates = [unknownTurnCandidate(NOW.getTime() - 60_000, new Date(NOW.getTime() - 1))];
    statusByExternal['ext-1'] = 'running';
    turnObservationByToken['mute-token'] = 'unknown';

    const r = await reapAndReconcileSandboxes(NOW);

    expect(unconfirmedTurnDrips).toEqual([]);
    expect(clearedTurnCalls).toEqual([{ sandboxId: 'sb-1', token: 'mute-token' }]);
    expect(r.stopped).toBe(1);
  });

  test('a box the provider is not running gets no drip', async () => {
    // The drip's whole premise is a box the PROVIDER says is up. A stopped or
    // unknown box never reaches the running branch at all.
    candidates = [unknownTurnCandidate(NOW.getTime() - 60_000)];
    statusByExternal['ext-1'] = 'unknown';

    await reapAndReconcileSandboxes(NOW);

    expect(unconfirmedTurnDrips).toEqual([]);
  });

  test('a box with no turn record at all is never drip-extended', async () => {
    candidates = [candidate({ deadlineAt: new Date(NOW.getTime() + 60_000) })];
    statusByExternal['ext-1'] = 'running';

    await reapAndReconcileSandboxes(NOW);

    expect(unconfirmedTurnDrips).toEqual([]);
  });

  // The stop erases activeTurns, after which no token-scoped settle can ever
  // fire again for this box. If the ledger is not settled here it claims the
  // turn is still running for ever.
  test('parking an expired box settles its still-open ledger rows', async () => {
    candidates = [
      candidate({
        deadlineAt: new Date(NOW.getTime() - 1),
        metadata: {
          activeTurns: {
            'active-token': {
              token: 'active-token',
              state: 'delivering',
              opencodeSessionId: 'ses_root',
              messageId: 'msg_turn_1',
            },
          },
        },
      }),
    ];
    statusByExternal['ext-1'] = 'running';
    deliveringTurnObservationBySandbox['sb-1'] = 'unknown';

    expect((await reapAndReconcileSandboxes(NOW)).stopped).toBe(1);

    const stopSettles = ledgerSettleStatements.filter((statement) => statement.includes('sb-1'));
    expect(stopSettles).toHaveLength(1);
    expect(stopSettles[0]).toContain('UPDATE kortix.session_turns');
    expect(stopSettles[0]).toContain('runtime_gone');
  });

  // The last line of defence for the one property this ledger has to have:
  // every row reaches `ended`. A stop's settle is savepoint-bounded and can roll
  // back, a row can predate this code, and a session_sandboxes row can be
  // deleted out from under its history — each leaves a row answering "is a turn
  // running?" with a permanent yes.
  test('every pass settles ledger rows left open on a box that is no longer running', async () => {
    candidates = [];

    await reapAndReconcileSandboxes(NOW);

    // Runs even with nothing to reap — that is exactly when orphans linger.
    const backstop = ledgerSettleStatements.find((statement) => statement.includes('NOT EXISTS'));
    expect(backstop).toContain('UPDATE kortix.session_turns');
    expect(backstop).toContain("state <> 'ended'");
    expect(backstop).toContain('runtime_gone');
    // Scoped by the SANDBOX's status, so a turn on a live box is never touched.
    expect(backstop).toContain("status IN ('active', 'provisioning')");
  });

  test('a scoped lane never runs the platform-wide backstop', async () => {
    // The fast active-turn lane and the operational per-sandbox scope both ask
    // about specific rows. A platform-wide sweep inside them would settle turns
    // the caller never asked about.
    await reapAndReconcileSandboxes(NOW, { activeTurnsOnly: true });
    await reapAndReconcileSandboxes(NOW, { sandboxIds: ['sb-1'] });

    expect(ledgerSettleStatements.filter((s) => s.includes('NOT EXISTS'))).toEqual([]);
  });

  test("a 'not_husk' outcome clears exactly as before", async () => {
    candidates = [
      candidate({
        deadlineAt: new Date(NOW.getTime() - 1),
        metadata: {
          activeTurns: {
            'active-token': {
              token: 'active-token',
              state: 'active',
              opencodeSessionId: 'ses_root',
              messageId: 'msg_turn_1',
            },
          },
        },
      }),
    ];
    statusByExternal['ext-1'] = 'running';
    deliveringTurnObservationBySandbox['sb-1'] = 'terminal';
    huskOutcomeBySandbox['sb-1'] = 'not_husk';

    const r = await reapAndReconcileSandboxes(NOW);

    expect(clearedTurnCalls).toEqual([{ sandboxId: 'sb-1', token: 'active-token' }]);
    expect(r.husksFinalized).toBe(0);
    expect(r.stopped).toBe(1);
  });

  test('a stale legacy terminal contraction cannot stop a newer active turn', async () => {
    candidates = [
      candidate({
        deadlineAt: new Date(NOW.getTime() - 1),
        metadata: {
          activeTurn: {
            token: 'newer-token',
            state: 'active',
            opencodeSessionId: 'ses_root',
            messageId: 'msg_newer',
          },
        },
      }),
    ];
    statusByExternal['ext-1'] = 'running';
    deliveringTurnObservationBySandbox['sb-1'] = 'active';
    activeTurnRenewalBySandbox['sb-1'] = 'renewed';

    const r = await reapAndReconcileSandboxes(NOW);

    expect(clearedTurnCalls).toEqual([]);
    expect(r.stopped).toBe(0);
    expect(r.lifecycleRenewed).toBe(1);
  });

  test('every provider renews its native lifecycle while the Kortix deadline is live', async () => {
    candidates = (['daytona', 'platinum', 'e2b'] as const).map((provider, index) =>
      candidate({
        sandboxId: `sb-${provider}`,
        sessionId: `sess-${provider}`,
        externalId: `ext-${provider}`,
        provider,
        deadlineAt: new Date(NOW.getTime() + HOUR + index),
      }),
    );
    for (const provider of ['daytona', 'platinum', 'e2b']) {
      statusByExternal[`ext-${provider}`] = 'running';
    }

    const r = await reapAndReconcileSandboxes(NOW);

    expect(r.skipped).toBe(3);
    expect(r.lifecycleRenewed).toBe(3);
    expect(timeoutRenewals).toEqual([
      { provider: 'daytona', externalId: 'ext-daytona' },
      { provider: 'platinum', externalId: 'ext-platinum' },
      { provider: 'e2b', externalId: 'ext-e2b' },
    ]);
    expect(stops).toEqual([]);
  });

  test('an expired box is stopped without renewing its provider lifecycle', async () => {
    candidates = [candidate({ provider: 'e2b', deadlineAt: new Date(NOW.getTime() - 1) })];
    statusByExternal['ext-1'] = 'running';

    const r = await reapAndReconcileSandboxes(NOW);

    expect(r.stopped).toBe(1);
    expect(r.lifecycleRenewed).toBe(0);
    expect(timeoutRenewals).toEqual([]);
    expect(stops).toEqual(['ext-1']);
  });

  test('a renewal failure never turns a live Kortix deadline into a stop decision', async () => {
    candidates = [candidate({ provider: 'e2b', deadlineAt: new Date(NOW.getTime() + HOUR) })];
    statusByExternal['ext-1'] = 'running';
    lifecycleRenewErrorByExternal['ext-1'] = new Error('provider renewal unavailable');

    const r = await reapAndReconcileSandboxes(NOW);

    expect(r.errors).toBe(1);
    expect(r.stopped).toBe(0);
    expect(stops).toEqual([]);
    expect(pausedCompute).toEqual([]);
  });

  test('the deadline is the WHOLE decision — the box is never consulted', async () => {
    // Identical rows; only the deadline differs. Metadata that used to veto a
    // stop (a live lease, a fresh lastTurnAt) is present on the doomed one and
    // changes nothing.
    candidates = [
      candidate({
        sandboxId: 'sb-live',
        sessionId: 'sess-live',
        externalId: 'ext-live',
        deadlineAt: new Date(NOW.getTime() + 1),
      }),
      candidate({
        sandboxId: 'sb-dead',
        sessionId: 'sess-dead',
        externalId: 'ext-dead',
        deadlineAt: new Date(NOW.getTime() - 1),
        metadata: {
          executionLeaseUntil: new Date(NOW.getTime() + 3 * HOUR).toISOString(),
          lastTurnAt: NOW.toISOString(),
          idleObservedAt: null,
        },
      }),
    ];
    statusByExternal['ext-live'] = 'running';
    statusByExternal['ext-dead'] = 'running';

    const r = await reapAndReconcileSandboxes(NOW);

    expect(stops).toEqual(['ext-dead']);
    expect(r.stopped).toBe(1);
    expect(r.skipped).toBe(1);
  });

  test('exactly at the deadline is expired (<=, not <)', async () => {
    candidates = [candidate({ deadlineAt: NOW })];
    statusByExternal['ext-1'] = 'running';

    expect((await reapAndReconcileSandboxes(NOW)).stopped).toBe(1);
  });

  // An unclaimed warm box used to be exempt from the idle TTL entirely, so it
  // burned until the 240-min ceiling. It now dies at its 20-minute boot floor
  // like anything else nobody prompted.
  test('an expired WARM box is stopped like any other', async () => {
    candidates = [candidate({ deadlineAt: new Date(NOW.getTime() - 60_000) })];
    statusByExternal['ext-1'] = 'running';

    expect((await reapAndReconcileSandboxes(NOW)).stopped).toBe(1);
    expect(stops).toEqual(['ext-1']);
  });

  // ═══ TOCTOU: the snapshot is stale by a whole provider round-trip ═══
  // The pass selects candidates, then spends seconds per row in getStatus, and
  // only then decides — from `row.deadlineAt`, read BEFORE that round-trip. A
  // prompt (or a human clicking the preview, or a gateway LLM call) landing in
  // that window extends the box; stopping it anyway kills live work the control
  // plane had already agreed to keep, and the just-woken box dies on the spot.
  test('REGRESSION: a prompt arriving DURING the pass saves the box', async () => {
    candidates = [candidate({ deadlineAt: new Date(NOW.getTime() - HOUR) })];
    statusByExternal['ext-1'] = 'running';
    // The extend the prompt performed, invisible to the pass's snapshot.
    freshDeadlineBySandbox['sb-1'] = new Date(Date.now() + 4 * HOUR);

    const r = await reapAndReconcileSandboxes(NOW);

    expect(stops).toEqual([]);
    expect(r.stopped).toBe(0);
    expect(r.skipped).toBe(1);
    // Nothing was written: no billing close, no status flip.
    expect(pausedCompute).toEqual([]);
    expect(rowUpdates()).toEqual([]);
  });

  test('REGRESSION: a prompt that wins the final stop claim cannot be stopped', async () => {
    candidates = [candidate({ deadlineAt: new Date(NOW.getTime() - HOUR) })];
    statusByExternal['ext-1'] = 'running';
    freshDeadlineBySandbox['sb-1'] = new Date(Date.now() - 60_000);
    // The prompt commits its activeTurns entry between the reaper decision and
    // the stop claim. The claim's conditional UPDATE returns no row.
    stopClaimDeniedBySandbox['sb-1'] = true;

    const result = await reapAndReconcileSandboxes(NOW);

    expect(stops).toEqual([]);
    expect(result.skipped).toBe(1);
    expect(pausedCompute).toEqual([]);
  });

  test('a deadline still expired at the last moment is stopped as before', async () => {
    candidates = [candidate({ deadlineAt: new Date(NOW.getTime() - HOUR) })];
    statusByExternal['ext-1'] = 'running';
    freshDeadlineBySandbox['sb-1'] = new Date(Date.now() - 60_000);

    const r = await reapAndReconcileSandboxes(NOW);

    expect(stops).toEqual(['ext-1']);
    expect(r.stopped).toBe(1);
    expect(r.billingClosed).toBe(1);
  });

  test('an unreadable row is never stopped on a guess', async () => {
    candidates = [candidate({ deadlineAt: new Date(NOW.getTime() - HOUR) })];
    statusByExternal['ext-1'] = 'running';
    freshDeadlineBySandbox['sb-1'] = null; // read failed / row gone

    const r = await reapAndReconcileSandboxes(NOW);

    expect(stops).toEqual([]);
    expect(r.skipped).toBe(1);
  });

  test('the re-read costs nothing on the healthy path — only rows about to die pay', async () => {
    candidates = [candidate({ deadlineAt: new Date(NOW.getTime() + HOUR) })];
    statusByExternal['ext-1'] = 'running';
    // A value that would REVERSE the decision if it were consulted.
    freshDeadlineBySandbox['sb-1'] = new Date(NOW.getTime() - HOUR);

    const r = await reapAndReconcileSandboxes(NOW);

    expect(r.skipped).toBe(1);
    expect(stops).toEqual([]);
  });

  test('the sweep asks the provider FIRST — a stopped box is reconciled, never poked', async () => {
    candidates = [candidate({ deadlineAt: new Date(NOW.getTime() - HOUR) })];
    statusByExternal['ext-1'] = 'stopped';

    const r = await reapAndReconcileSandboxes(NOW);

    expect(r.reconciled).toBe(1);
    expect(r.billingClosed).toBe(1);
    expect(stops).toEqual([]);
    expect(pausedCompute).toEqual(['sb-1']);
  });

  test('a transient stopped observation cannot defeat an in-flight provider wake', async () => {
    candidates = [
      candidate({
        provider: 'platinum',
        metadata: {
          runtimeWakeId: 'wake-1',
          runtimeWakeStartedAt: new Date(NOW.getTime() - 5_000).toISOString(),
        },
      }),
    ];
    statusByExternal['ext-1'] = 'stopped';

    const r = await reapAndReconcileSandboxes(NOW);

    expect(r.skipped).toBe(1);
    expect(r.reconciled).toBe(0);
    expect(r.billingClosed).toBe(0);
    expect(pausedCompute).toEqual([]);
  });

  // ═══ THE MID-TURN PARK THIS CLOSES ═══
  // Incident 2026-08-17T20:40:03Z (session 0fc6897a, Daytona f468056d): one
  // provider read of `stopped` durably parked a box that was running a turn,
  // `stopReason: provider_reconcile`, and Daytona's own autoStopInterval was 720
  // — the provider never stopped it. `stopping` and `pending_stop` both map to
  // `stopped` (platform/providers/daytona-state.ts), so a box mid-transition, or
  // one transient misread, settled its turns `runtime_gone` and kicked its
  // client to the wake flow. While turn authority exists the park needs TWO
  // observations, one pass apart — the wake fence, mirrored to the stop side.
  const midTurnCandidate = (over: Partial<any> = {}, extraMetadata: Record<string, unknown> = {}) =>
    candidate({
      metadata: {
        activeTurns: {
          'active-token': {
            token: 'active-token',
            state: 'active',
            opencodeSessionId: 'ses_root',
            messageId: 'msg_turn_1',
            startedAtMs: NOW.getTime() - 60_000,
          },
        },
        ...extraMetadata,
      },
      ...over,
    });

  test('REGRESSION: one stopped read cannot park a box that is running a turn', async () => {
    candidates = [midTurnCandidate()];
    statusByExternal['ext-1'] = 'stopped';

    const r = await reapAndReconcileSandboxes(NOW);

    expect(r.reconciled).toBe(0);
    expect(r.skipped).toBe(1);
    expect(r.billingClosed).toBe(0);
    expect(pausedCompute).toEqual([]);
    expect(
      updateCalls.some((c) => c.table === sessionSandboxes && c.updates.status === 'stopped'),
    ).toBe(false);
    // The observation is RECORDED, so the next pass can confirm it.
    expect(
      rowUpdates().some((c) => describeSql(c.updates.metadata).includes('pendingStopObservedAtMs')),
    ).toBe(true);
  });

  test('a stopped read after the confirmation window parks the box', async () => {
    // Was "one pass later" (20s), which parked under the old 15s window. The
    // window is now 60s — sized to outlast a real provider transition after one
    // parked a healthy box mid-turn on 2026-08-21 — so a genuine park takes a
    // few passes instead of one. Same behaviour, later: the marker must be
    // older than MIDTURN_STOP_CONFIRMATION_MS, not merely older than a pass.
    candidates = [midTurnCandidate({}, { pendingStopObservedAtMs: NOW.getTime() - 90_000 })];
    statusByExternal['ext-1'] = 'stopped';

    const r = await reapAndReconcileSandboxes(NOW);

    expect(r.reconciled).toBe(1);
    expect(r.billingClosed).toBe(1);
    expect(pausedCompute).toEqual(['sb-1']);
    // The park still settles the turns it erases authority for.
    expect(ledgerSettleStatements.some((s) => s.includes('runtime_gone'))).toBe(true);
  });

  test('a stopped read INSIDE the window does not park — the turn survives', async () => {
    // The 2026-08-21 shape exactly: a second stopped read 20s after the first,
    // while the provider was still transitioning. Under the old window this
    // parked the box and settled a live turn `runtime_gone`; the box reported
    // running ten seconds later.
    // Future deadline on purpose: with an expired one the box parks under the
    // deadline rule and this would assert nothing about the stop guard.
    candidates = [
      midTurnCandidate(
        { deadlineAt: new Date(NOW.getTime() + HOUR) },
        { pendingStopObservedAtMs: NOW.getTime() - 20_000 },
      ),
    ];
    statusByExternal['ext-1'] = 'stopped';

    const r = await reapAndReconcileSandboxes(NOW);

    // Not reconciled and not paused IS "the turn survives": the park is the only
    // thing in this path that erases turn authority and settles `runtime_gone`.
    // Asserting on the ledger statements directly would be wrong here — other
    // lanes in the same pass settle unrelated boxes, so that log says nothing
    // about THIS candidate.
    expect(r.reconciled).toBe(0);
    expect(pausedCompute).toEqual([]);
    // The suspicion is kept, not discarded: a genuine stop still parks later.
    expect(
      rowUpdates().some((c) => describeSql(c.updates.metadata).includes('pendingStopObservedAtMs')),
    ).toBe(true);
  });

  test('a running read between the two clears the pending marker', async () => {
    candidates = [
      midTurnCandidate(
        { deadlineAt: new Date(NOW.getTime() + HOUR) },
        {
          pendingStopObservedAtMs: NOW.getTime() - 20_000,
        },
      ),
    ];
    statusByExternal['ext-1'] = 'running';
    turnObservationByToken['active-token'] = 'active';
    activeTurnRenewalBySandbox['sb-1'] = 'renewed';

    const r = await reapAndReconcileSandboxes(NOW);

    expect(r.reconciled).toBe(0);
    expect(
      rowUpdates().some((c) =>
        describeSql(c.updates.metadata).includes("- 'pendingStopObservedAtMs'"),
      ),
    ).toBe(true);
  });

  test('a running box with no marker pays for no extra write', async () => {
    candidates = [midTurnCandidate({ deadlineAt: new Date(NOW.getTime() + HOUR) })];
    statusByExternal['ext-1'] = 'running';
    turnObservationByToken['active-token'] = 'active';
    activeTurnRenewalBySandbox['sb-1'] = 'renewed';

    await reapAndReconcileSandboxes(NOW);

    expect(rowUpdates()).toEqual([]);
  });

  test('a terminal provider state parks a turn-holding box on the FIRST read', async () => {
    // Daytona `error` / Platinum `failed`. There is no transitional state that
    // maps to `terminal`, so a second observation would only cost the box's
    // client another pass of waiting for an answer that cannot change.
    candidates = [midTurnCandidate()];
    statusByExternal['ext-1'] = 'terminal';

    const r = await reapAndReconcileSandboxes(NOW);

    expect(r.reconciled).toBe(1);
    expect(pausedCompute).toEqual(['sb-1']);
  });

  test('never acts on transient unknown provider state, expired or not', async () => {
    candidates = [candidate({ deadlineAt: new Date(NOW.getTime() - HOUR) })];
    statusByExternal['ext-1'] = 'unknown';

    const r = await reapAndReconcileSandboxes(NOW);

    expect(r.skipped).toBe(1);
    expect(stops).toEqual([]);
    expect(pausedCompute).toEqual([]);
  });

  test('provider-removed preserves the established external identity', async () => {
    candidates = [candidate()];
    statusByExternal['ext-1'] = 'removed';

    const r = await reapAndReconcileSandboxes(NOW);

    expect(r.reconciled).toBe(1);
    expect(endedCompute).toEqual(['sb-1']);
    const sbUpdate = updateCalls.find((c) => c.table === sessionSandboxes);
    expect(sbUpdate?.updates.status).toBe('stopped');
    expect(sbUpdate?.updates.metadata).toMatchObject({
      runtimeIdentityState: 'unavailable',
      preservedExternalId: 'ext-1',
    });
    expect(stops).toEqual([]);
  });

  test('a failed provider.stop closes NOTHING — no status flip, no billing close', async () => {
    candidates = [candidate({ deadlineAt: new Date(NOW.getTime() - HOUR) })];
    statusByExternal['ext-1'] = 'running';
    stopErrorByExternal['ext-1'] = new Error('provider unavailable');

    const r = await reapAndReconcileSandboxes(NOW);

    expect(r.errors).toBe(1);
    expect(r.stopped).toBe(0);
    expect(r.billingClosed).toBe(0);
    expect(pausedCompute).toEqual([]);
    expect(
      updateCalls.some((c) => c.table === sessionSandboxes && c.updates.status === 'stopped'),
    ).toBe(false);
  });

  test('already stopped provider-side is success, not an error', async () => {
    candidates = [candidate({ deadlineAt: new Date(NOW.getTime() - HOUR) })];
    statusByExternal['ext-1'] = 'running';
    stopErrorByExternal['ext-1'] = new Error('Sandbox is already stopped');

    const r = await reapAndReconcileSandboxes(NOW);

    expect(r.stopped).toBe(1);
    expect(r.errors).toBe(0);
    expect(pausedCompute).toEqual(['sb-1']);
  });

  test('a lifecycle transition in progress defers rather than fighting the wake', async () => {
    candidates = [candidate({ deadlineAt: new Date(NOW.getTime() - HOUR) })];
    statusByExternal['ext-1'] = 'running';
    stopErrorByExternal['ext-1'] = new Error('state change in progress');

    const r = await reapAndReconcileSandboxes(NOW);

    expect(r.skipped).toBe(1);
    expect(r.stopped).toBe(0);
    expect(pausedCompute).toEqual([]);
  });
});

// ── orphan-box reaper: stops provider boxes the DB sweep can't see ────────────
describe('reapOrphanProviderBoxes', () => {
  const NOW2 = new Date('2026-06-21T12:00:00Z');
  const hoursAgo = (h: number) => new Date(NOW2.getTime() - h * 3_600_000);

  test('stops boxes with no live DB row; keeps live, too-young, and unknown-age boxes', async () => {
    // keepSet (the DB's view of live boxes) comes from the sessionSandboxes query.
    candidates = [{ provider: 'daytona', externalId: 'keep-1' }];
    managedBoxes = [
      { externalId: 'keep-1', createdAt: hoursAgo(48) }, // in keepSet → live
      { externalId: 'orphan-1', createdAt: hoursAgo(48) }, // orphan + old → STOP
      { externalId: 'orphan-2', createdAt: hoursAgo(3) }, // orphan + old → STOP
      { externalId: 'young-1', createdAt: hoursAgo(0.2) }, // orphan but <1h → keep (provision race)
      { externalId: 'nodate', createdAt: null }, // unknown age → keep (fail-safe)
    ];

    const r = await reapOrphanProviderBoxes(NOW2);

    expect([...stops].sort()).toEqual(['orphan-1', 'orphan-2']);
    expect(r.listed).toBe(5);
    expect(r.orphans).toBe(2);
    expect(r.stopped).toBe(2);
    expect(r.errors).toBe(0);
  });

  test('continues past a stop failure (bad box never sinks the sweep)', async () => {
    candidates = [];
    managedBoxes = [
      { externalId: 'orphan-a', createdAt: hoursAgo(10) },
      { externalId: 'orphan-b', createdAt: hoursAgo(10) },
    ];
    stopErrorByExternal['orphan-a'] = new Error('429 too many requests');

    const r = await reapOrphanProviderBoxes(NOW2);

    expect(stops).toContain('orphan-a'); // attempted
    expect(stops).toContain('orphan-b'); // and the next one still ran
    expect(r.stopped).toBe(1);
    expect(r.errors).toBe(1);
  });

  test('keeps a provider box referenced by a live App runtime', async () => {
    candidates = [];
    appRuntimeKeepRows = [{ provider: 'daytona', externalId: 'app-live' }];
    managedBoxes = [
      { externalId: 'app-live', createdAt: hoursAgo(48) },
      { externalId: 'real-orphan', createdAt: hoursAgo(48) },
    ];

    const r = await reapOrphanProviderBoxes(NOW2);

    expect(stops).toEqual(['real-orphan']);
    expect(r).toEqual({ listed: 2, orphans: 1, stopped: 1, errors: 0 });
  });

  test('lists and stops orphan boxes through every configured provider adapter', async () => {
    managedBoxes = [{ externalId: 'daytona-orphan', createdAt: hoursAgo(10) }];
    e2bManagedBoxes = [{ externalId: 'e2b-orphan', createdAt: hoursAgo(10) }];

    const r = await reapOrphanProviderBoxes(NOW2);

    expect(stopsByProvider).toEqual([
      { provider: 'daytona', externalId: 'daytona-orphan' },
      { provider: 'e2b', externalId: 'e2b-orphan' },
    ]);
    expect(r).toEqual({ listed: 2, orphans: 2, stopped: 2, errors: 0 });
  });

  test('env flag off → no-op (never lists or stops)', async () => {
    const prev = process.env.KORTIX_ORPHAN_BOX_REAP_ENABLED;
    process.env.KORTIX_ORPHAN_BOX_REAP_ENABLED = 'false';
    try {
      managedBoxes = [{ externalId: 'orphan-x', createdAt: hoursAgo(48) }];
      const r = await reapOrphanProviderBoxes(NOW2);
      expect(stops).toEqual([]);
      expect(r).toEqual({ listed: 0, orphans: 0, stopped: 0, errors: 0 });
    } finally {
      if (prev === undefined) delete process.env.KORTIX_ORPHAN_BOX_REAP_ENABLED;
      else process.env.KORTIX_ORPHAN_BOX_REAP_ENABLED = prev;
    }
  });
});

describe('reconcileStuckActiveSessions', () => {
  test('no candidates → no-op', async () => {
    stuckSessions = [];
    const result = await reconcileStuckActiveSessions(new Date());
    expect(result.candidates).toBe(0);
    expect(result.reconciled).toBe(0);
    expect(updateCalls.length).toBe(0);
    expect(pausedCompute.length).toBe(0);
  });

  test('stuck session with a dead box → close billing + flip session to stopped', async () => {
    stuckSessions = [{ sessionId: 's1' }];
    // per-session sandbox lookup resolves to the sessionSandboxes mock (candidates)
    candidates = [{ sandboxId: 'sb1' }];
    const result = await reconcileStuckActiveSessions(new Date());
    expect(result.candidates).toBe(1);
    expect(result.reconciled).toBe(1);
    expect(result.billingClosed).toBe(1);
    expect(pausedCompute).toContain('sb1');
    // exactly one project_sessions row flipped to 'stopped'
    const sessionUpdates = updateCalls.filter((u) => u.table === projectSessions);
    expect(sessionUpdates.length).toBe(1);
    expect(sessionUpdates[0].updates.status).toBe('stopped');
  });

  test('stuck session with no sandbox row → still flips to stopped, nothing billed', async () => {
    stuckSessions = [{ sessionId: 's2' }];
    candidates = []; // no sandbox rows for this session
    const result = await reconcileStuckActiveSessions(new Date());
    expect(result.candidates).toBe(1);
    expect(result.reconciled).toBe(1);
    expect(result.billingClosed).toBe(0);
    expect(pausedCompute.length).toBe(0);
    expect(updateCalls.filter((u) => u.table === projectSessions).length).toBe(1);
  });
});

describe('the batch cap rotates and cannot starve a row', () => {
  test('active renewal and expired-stop backlogs receive independent capacity', async () => {
    const prev = process.env.KORTIX_REAP_BATCH_SIZE;
    process.env.KORTIX_REAP_BATCH_SIZE = '2';
    try {
      const active = ['a', 'b', 'c'].map((id) =>
        candidate({
          sandboxId: `sb-active-${id}`,
          sessionId: `sess-active-${id}`,
          externalId: `ext-active-${id}`,
          metadata: {
            activeTurns: {
              [`turn-${id}`]: {
                token: `turn-${id}`,
                state: 'active',
                opencodeSessionId: `ses-${id}`,
                messageId: `msg-${id}`,
              },
            },
          },
        }),
      );
      const expired = ['a', 'b', 'c'].map((id) =>
        candidate({
          sandboxId: `sb-expired-${id}`,
          sessionId: `sess-expired-${id}`,
          externalId: `ext-expired-${id}`,
          deadlineAt: new Date(NOW.getTime() - 1),
        }),
      );
      candidates = [...active, ...expired];
      for (const row of candidates) statusByExternal[row.externalId] = 'running';
      for (const row of active) {
        activeTurnRenewalBySandbox[row.sandboxId] = 'renewed';
        turnObservationByToken[`turn-${row.sandboxId.replace('sb-active-', '')}`] = 'active';
      }

      const result = await reapAndReconcileSandboxes(NOW);

      expect(result.candidates).toBe(4);
      expect(
        activeTurnRenewalCalls.filter(({ sandboxId }) => sandboxId.startsWith('sb-active-')),
      ).toHaveLength(2);
      expect(stops.filter((id) => id.startsWith('ext-expired-'))).toHaveLength(2);
      expect(result.matching).toBe(6);
      expect(result.deferred).toBe(2);
    } finally {
      if (prev === undefined) delete process.env.KORTIX_REAP_BATCH_SIZE;
      else process.env.KORTIX_REAP_BATCH_SIZE = prev;
    }
  });

  test('the candidate query orders by the visit stamp, oldest first', async () => {
    candidates = [candidate()];
    statusByExternal['ext-1'] = 'running';

    await reapAndReconcileSandboxes(NOW);

    expect(orderByExpressions.some((e) => e.includes('reaperVisitedAt'))).toBe(true);
    expect(orderByExpressions.some((e) => e.includes('nulls first'))).toBe(true);
    // Expired rows must win the batch, or a backlog of healthy rows could defer
    // the one row that is actually over its deadline, forever.
    expect(orderByExpressions.some((e) => e.includes('deadline_at') && e.includes('desc'))).toBe(
      true,
    );
  });

  test('every examined row is stamped, including ones the pass deliberately left alone', async () => {
    candidates = [
      candidate({
        sandboxId: 'sb-a',
        sessionId: 'sess-a',
        externalId: 'ext-a',
      }),
      candidate({
        sandboxId: 'sb-b',
        sessionId: 'sess-b',
        externalId: 'ext-b',
      }),
    ];
    statusByExternal['ext-a'] = 'running';
    statusByExternal['ext-b'] = 'running';

    const r = await reapAndReconcileSandboxes(NOW);

    expect(r.skipped).toBe(2);
    // A row the pass leaves alone wrote nothing at all pre-fix, so it re-won
    // the batch every pass. Exactly one batched stamp now covers everything
    // examined.
    expect(visitStamps().length).toBe(1);
  });

  test('a backlog larger than the batch is reported, not silently dropped', async () => {
    const prev = process.env.KORTIX_REAP_BATCH_SIZE;
    process.env.KORTIX_REAP_BATCH_SIZE = '2';
    try {
      candidates = [
        candidate({
          sandboxId: 'sb-a',
          sessionId: 'sess-a',
          externalId: 'ext-a',
        }),
        candidate({
          sandboxId: 'sb-b',
          sessionId: 'sess-b',
          externalId: 'ext-b',
        }),
        candidate({
          sandboxId: 'sb-c',
          sessionId: 'sess-c',
          externalId: 'ext-c',
        }),
      ];

      const r = await reapAndReconcileSandboxes(NOW);

      expect(r.candidates).toBe(2);
      expect(r.matching).toBe(3);
      expect(r.deferred).toBe(1);
    } finally {
      if (prev === undefined) delete process.env.KORTIX_REAP_BATCH_SIZE;
      else process.env.KORTIX_REAP_BATCH_SIZE = prev;
    }
  });

  // The starvation regression itself: three rows, a batch of two, and rows the
  // pass leaves alone. Pre-fix (no ORDER BY, no visit stamp) the same two rows
  // win every pass and the third is unreachable FOREVER while the billing tick
  // keeps charging it. Two passes must now cover all three.
  test('REGRESSION: two passes over a batch of two cover all three rows', async () => {
    const prev = process.env.KORTIX_REAP_BATCH_SIZE;
    process.env.KORTIX_REAP_BATCH_SIZE = '2';
    try {
      const held = (id: string) => ({
        sandboxId: `sb-${id}`,
        sessionId: `sess-${id}`,
        externalId: `ext-${id}`,
      });
      candidates = [candidate(held('a')), candidate(held('b')), candidate(held('c'))];
      for (const id of ['a', 'b', 'c']) statusByExternal[`ext-${id}`] = 'running';

      const examined: string[][] = [];
      for (let pass = 0; pass < 2; pass++) {
        const seen: string[] = [];
        // Capture which rows this pass selected, then apply the stamp the reaper
        // writes so the next pass's ORDER BY sees the rotation.
        const before = candidates.map((c) => c.metadata?.reaperVisitedAt ?? null);
        void before;
        const beforeStamps = visitStamps().length;
        await reapAndReconcileSandboxes(new Date(NOW.getTime() + pass * 60_000));
        expect(visitStamps().length).toBe(beforeStamps + 1);
        const ordered = applyOrder(candidates).slice(0, 2);
        for (const row of ordered) {
          seen.push(row.sandboxId);
          row.metadata = {
            ...row.metadata,
            reaperVisitedAt: new Date(NOW.getTime() + pass * 60_000).toISOString(),
          };
        }
        examined.push(seen);
      }

      expect(new Set([...examined[0], ...examined[1]]).size).toBe(3);
    } finally {
      if (prev === undefined) delete process.env.KORTIX_REAP_BATCH_SIZE;
      else process.env.KORTIX_REAP_BATCH_SIZE = prev;
    }
  });
});

// ── the billing invariant: no open row without a provably-alive sandbox ──────

describe('hasFailedRuntimeStart', () => {
  test('a failure stamped at or after the wake it belongs to', () => {
    expect(
      hasFailedRuntimeStart({
        runtimeWakeStartedAt: '2026-07-29T01:09:29.142Z',
        runtimeWakeFailedAt: '2026-07-29T01:09:29.276Z',
      }),
    ).toBe(true);
  });
  test('a stale failure from a wake that has since been retried', () => {
    expect(
      hasFailedRuntimeStart({
        runtimeWakeStartedAt: '2026-07-29T02:00:00.000Z',
        runtimeWakeFailedAt: '2026-07-29T01:09:29.276Z',
      }),
    ).toBe(false);
  });
  test('no failure stamp / no metadata / garbage', () => {
    expect(hasFailedRuntimeStart(null)).toBe(false);
    expect(hasFailedRuntimeStart({})).toBe(false);
    expect(hasFailedRuntimeStart({ runtimeWakeFailedAt: 'nope' })).toBe(false);
  });
});

describe('decideComputeClose', () => {
  const base = {
    sandboxStatus: 'active' as string | null,
    hasProviderTarget: true,
    runtimeStartFailed: false,
    wakeInProgress: false,
    beyondLivenessCeiling: false,
    providerStatus: 'running' as any,
    unresolvedForMs: null as number | null,
    openForMs: HOUR,
    unresolvedCeilingMs: HOUR,
    maxWindowMs: 24 * HOUR,
  };

  test('a provably alive box keeps billing', () => {
    expect(decideComputeClose(base).reason).toBeNull();
  });

  // The 17 leaking prod rows. DB-only, so it must not need a provider call.
  test('REGRESSION: sandbox row already stopped → close, with zero provider calls', () => {
    const d = decideComputeClose({ ...base, sandboxStatus: 'stopped' });
    expect(d.reason).toBe('sandbox-not-active');
    expect(d.needsProviderStatus).toBe(false);
  });
  test('sandbox row in error → close', () => {
    expect(decideComputeClose({ ...base, sandboxStatus: 'error' }).reason).toBe(
      'sandbox-not-active',
    );
  });
  test('sandbox row archived → close', () => {
    expect(decideComputeClose({ ...base, sandboxStatus: 'archived' }).reason).toBe(
      'sandbox-not-active',
    );
  });
  test('a provisioning box is NOT closed — the meter legitimately opens first', () => {
    expect(decideComputeClose({ ...base, sandboxStatus: 'provisioning' }).reason).toBeNull();
  });
  test('no sandbox row at all → close', () => {
    expect(decideComputeClose({ ...base, sandboxStatus: null }).reason).toBe('sandbox-row-missing');
  });
  test('no provider target → close', () => {
    expect(decideComputeClose({ ...base, hasProviderTarget: false }).reason).toBe(
      'sandbox-row-missing',
    );
  });
  test('a wake that failed → close, without a provider call', () => {
    const d = decideComputeClose({ ...base, runtimeStartFailed: true });
    expect(d.reason).toBe('runtime-start-failed');
    expect(d.needsProviderStatus).toBe(false);
  });

  test('a row past its liveness ceiling can never bill again → close', () => {
    const d = decideComputeClose({ ...base, beyondLivenessCeiling: true });
    expect(d.reason).toBe('beyond-liveness-ceiling');
    expect(d.needsProviderStatus).toBe(false);
  });

  test('provider says stopped / removed / terminal → close', () => {
    expect(decideComputeClose({ ...base, providerStatus: 'stopped' }).reason).toBe(
      'provider-not-running',
    );
    expect(decideComputeClose({ ...base, providerStatus: 'removed' }).reason).toBe(
      'provider-not-running',
    );
    expect(decideComputeClose({ ...base, providerStatus: 'terminal' }).reason).toBe(
      'provider-not-running',
    );
  });

  test('a fresh wake fence makes provider-stopped transitional, not billable-stop proof', () => {
    const decision = decideComputeClose({
      ...base,
      providerStatus: 'stopped',
      wakeInProgress: true,
    });
    expect(decision.reason).toBeNull();
  });

  // 44 of 66 open prod rows answered `unknown`: it is the steady state for a
  // box deleted out from under us, not a transient.
  test('REGRESSION: unknown is transient on first sight — do not close yet', () => {
    expect(
      decideComputeClose({
        ...base,
        providerStatus: 'unknown',
        unresolvedForMs: null,
      }).reason,
    ).toBeNull();
  });
  test('REGRESSION: unknown past the ceiling stops billing — uncertainty never justifies charging', () => {
    expect(
      decideComputeClose({
        ...base,
        providerStatus: 'unknown',
        unresolvedForMs: HOUR,
      }).reason,
    ).toBe('unresolvable-past-ceiling');
  });
  test('unknown but only briefly → keep billing', () => {
    expect(
      decideComputeClose({
        ...base,
        providerStatus: 'unknown',
        unresolvedForMs: HOUR - 1,
      }).reason,
    ).toBeNull();
  });
  test('an unresolvable lookup (provider threw, status null) is treated like unknown', () => {
    expect(
      decideComputeClose({
        ...base,
        providerStatus: null,
        unresolvedForMs: HOUR,
      }).reason,
    ).toBe('unresolvable-past-ceiling');
  });

  // The rule that makes an 829-hour row impossible.
  test('REGRESSION: no window may exceed the max, even while the provider says running', () => {
    const d = decideComputeClose({
      ...base,
      openForMs: 24 * HOUR,
      providerStatus: 'running',
    });
    expect(d.reason).toBe('window-past-max');
    expect(d.needsProviderStatus).toBe(false);
  });
  test('just under the max window keeps billing', () => {
    expect(decideComputeClose({ ...base, openForMs: 24 * HOUR - 1 }).reason).toBeNull();
  });
});

describe('computeCloseWindowEnd', () => {
  const now = new Date('2026-07-29T12:00:00Z');
  const startedAt = new Date(now.getTime() - 100 * HOUR);
  const base = {
    now,
    startedAt,
    sandboxUpdatedAt: null as Date | null,
    unresolvedSince: null as Date | null,
    runtimeWakeFailedAt: null as Date | null,
    // A liveness ceiling far in the future isolates the per-reason behaviour;
    // the clamp itself is asserted separately below.
    lastAliveAt: now,
    livenessGraceMs: 1000 * HOUR,
    maxWindowMs: 24 * HOUR,
  };

  test('a stopped sandbox bills through the moment we recorded the stop', () => {
    const stoppedAt = new Date(now.getTime() - 90 * HOUR);
    expect(
      computeCloseWindowEnd({
        ...base,
        reason: 'sandbox-not-active',
        sandboxUpdatedAt: stoppedAt,
      }).getTime(),
    ).toBe(stoppedAt.getTime());
  });
  test('a failed wake bills through the failure, not through today', () => {
    const failedAt = new Date(now.getTime() - 95 * HOUR);
    expect(
      computeCloseWindowEnd({
        ...base,
        reason: 'runtime-start-failed',
        runtimeWakeFailedAt: failedAt,
      }).getTime(),
    ).toBe(failedAt.getTime());
  });
  test('an unresolvable box bills through the last moment it was resolvable', () => {
    const lastSeen = new Date(now.getTime() - 50 * HOUR);
    expect(
      computeCloseWindowEnd({
        ...base,
        reason: 'unresolvable-past-ceiling',
        unresolvedSince: lastSeen,
      }).getTime(),
    ).toBe(lastSeen.getTime());
  });
  test('a max-length window bills exactly the max, never the 100h it actually ran', () => {
    expect(computeCloseWindowEnd({ ...base, reason: 'window-past-max' }).getTime()).toBe(
      startedAt.getTime() + 24 * HOUR,
    );
  });
  test('never bills before the window opened', () => {
    expect(
      computeCloseWindowEnd({
        ...base,
        reason: 'sandbox-not-active',
        sandboxUpdatedAt: new Date(startedAt.getTime() - HOUR),
      }).getTime(),
    ).toBe(startedAt.getTime());
  });
  test('never bills into the future', () => {
    expect(
      computeCloseWindowEnd({
        ...base,
        reason: 'sandbox-not-active',
        sandboxUpdatedAt: new Date(now.getTime() + HOUR),
      }).getTime(),
    ).toBe(now.getTime());
  });
  test('a missing evidence timestamp degrades to now rather than throwing', () => {
    expect(
      computeCloseWindowEnd({
        ...base,
        reason: 'sandbox-not-active',
      }).getTime(),
    ).toBe(now.getTime());
  });

  // Get the reason wrong and the bill is still capped — that is what makes the
  // reason an optimisation rather than a correctness requirement.
  test('REGRESSION: the liveness ceiling overrides whatever the reason argues for', () => {
    const lastAliveAt = new Date(now.getTime() - 90 * HOUR);
    const end = computeCloseWindowEnd({
      ...base,
      reason: 'sandbox-row-missing', // this reason alone would bill through `now`
      lastAliveAt,
      livenessGraceMs: HOUR,
    });
    expect(end.getTime()).toBe(lastAliveAt.getTime() + HOUR);
  });
});

describe('reconcileOrphanComputeSessions', () => {
  const NOW3 = new Date('2026-07-29T12:00:00Z');
  // `lastAliveAt` defaults to "just observed" so each test isolates the rule it
  // is about; the liveness ceiling itself is asserted in its own tests below and
  // in billing/services/compute-liveness.test.ts.
  const openRow = (over: Partial<any> = {}) => ({
    computeId: 'cs-1',
    sandboxId: 'sb-1',
    workloadType: 'session',
    startedAt: new Date(NOW3.getTime() - 2 * HOUR).toISOString(),
    computeMetadata: { lastAliveAt: NOW3.toISOString() },
    sbStatus: 'active',
    sbUpdatedAt: new Date(NOW3.getTime() - HOUR).toISOString(),
    sbMetadata: {},
    sessionProvider: 'daytona',
    sessionExternalId: 'ext-1',
    appStatus: null,
    appUpdatedAt: null,
    appMetadata: null,
    appProvider: null,
    appExternalId: null,
    environmentStatus: null,
    environmentUpdatedAt: null,
    environmentMetadata: null,
    environmentProvider: null,
    environmentExternalId: null,
    ...over,
  });

  test('a healthy running box keeps billing', async () => {
    computeRows = [openRow()];
    statusByExternal['ext-1'] = 'running';

    const r = await reconcileOrphanComputeSessions(NOW3);

    expect(r.closed).toBe(0);
    expect(pausedCompute).toEqual([]);
  });

  test('the compute invariant keeps the meter open during a fresh provider wake', async () => {
    computeRows = [
      openRow({
        sessionProvider: 'platinum',
        sbMetadata: {
          runtimeWakeId: 'wake-1',
          runtimeWakeStartedAt: new Date(NOW3.getTime() - 5_000).toISOString(),
        },
      }),
    ];
    statusByExternal['ext-1'] = 'stopped';

    const r = await reconcileOrphanComputeSessions(NOW3);

    expect(r.closed).toBe(0);
    expect(pausedCompute).toEqual([]);
  });

  test('a healthy running App runtime keeps billing through its App join', async () => {
    computeRows = [
      openRow({
        workloadType: 'app',
        sbStatus: null,
        sessionProvider: null,
        sessionExternalId: null,
        appStatus: 'running',
        appUpdatedAt: new Date(NOW3.getTime() - HOUR).toISOString(),
        appMetadata: {},
        appProvider: 'daytona',
        appExternalId: 'app-ext-1',
      }),
    ];
    statusByExternal['app-ext-1'] = 'running';

    const r = await reconcileOrphanComputeSessions(NOW3);

    expect(r.closed).toBe(0);
    expect(statusCalls).toEqual(['app-ext-1']);
    expect(pausedCompute).toEqual([]);
  });

  test('a stopped App runtime closes its compute window without a provider call', async () => {
    const stoppedAt = new Date(NOW3.getTime() - HOUR);
    computeRows = [
      openRow({
        workloadType: 'app',
        sbStatus: null,
        sessionProvider: null,
        sessionExternalId: null,
        appStatus: 'stopped',
        appUpdatedAt: stoppedAt.toISOString(),
        appMetadata: {},
        appProvider: 'daytona',
        appExternalId: 'app-ext-1',
      }),
    ];

    const r = await reconcileOrphanComputeSessions(NOW3);

    expect(r.closed).toBe(1);
    expect(r.byReason['sandbox-not-active']).toBe(1);
    expect(statusCalls).toEqual([]);
    expect(pausedComputeWindows[0].windowEnd?.getTime()).toBe(stoppedAt.getTime());
  });

  test('a running environment refreshes liveness and keeps billing', async () => {
    const lastSeen = new Date(NOW3.getTime() - 2 * HOUR);
    computeRows = [
      openRow({
        workloadType: 'environment',
        computeMetadata: { lastAliveAt: lastSeen.toISOString() },
        sbStatus: null,
        sessionProvider: null,
        sessionExternalId: null,
        environmentStatus: 'active',
        environmentUpdatedAt: lastSeen.toISOString(),
        environmentMetadata: {},
        environmentProvider: 'daytona',
        environmentExternalId: 'env-ext-1',
      }),
    ];
    statusByExternal['env-ext-1'] = 'running';

    const r = await reconcileOrphanComputeSessions(NOW3);

    expect(r.closed).toBe(0);
    expect(statusCalls).toEqual(['env-ext-1']);
    const stamp = updateCalls.find((call) => call.table === sandboxComputeSessions);
    expect((stamp?.updates.metadata as any)?.lastAliveAt).toBe(NOW3.toISOString());
  });

  test('a stopped environment closes its compute window without a provider call', async () => {
    const stoppedAt = new Date(NOW3.getTime() - HOUR);
    computeRows = [
      openRow({
        workloadType: 'environment',
        sbStatus: null,
        sessionProvider: null,
        sessionExternalId: null,
        environmentStatus: 'stopped',
        environmentUpdatedAt: stoppedAt.toISOString(),
        environmentMetadata: {},
        environmentProvider: 'daytona',
        environmentExternalId: 'env-ext-1',
      }),
    ];

    const r = await reconcileOrphanComputeSessions(NOW3);

    expect(r.closed).toBe(1);
    expect(r.byReason['sandbox-not-active']).toBe(1);
    expect(statusCalls).toEqual([]);
    expect(pausedComputeWindows[0].windowEnd?.getTime()).toBe(stoppedAt.getTime());
  });

  test('a legacy environment window uses its metadata marker', async () => {
    computeRows = [
      openRow({
        workloadType: 'session',
        computeMetadata: {
          workload: 'session-environment',
          lastAliveAt: NOW3.toISOString(),
        },
        sbStatus: null,
        sessionProvider: null,
        sessionExternalId: null,
        environmentStatus: 'active',
        environmentUpdatedAt: NOW3.toISOString(),
        environmentMetadata: {},
        environmentProvider: 'daytona',
        environmentExternalId: 'legacy-env-ext-1',
      }),
    ];
    statusByExternal['legacy-env-ext-1'] = 'running';

    const r = await reconcileOrphanComputeSessions(NOW3);

    expect(r.closed).toBe(0);
    expect(statusCalls).toEqual(['legacy-env-ext-1']);
  });

  // The 17 prod rows: 5,587 sandbox-hours billed on boxes our own DB said were
  // stopped. Pre-fix this row is untouched because the provider answers
  // 'unknown' and only 'stopped'/'removed' closed anything.
  test('REGRESSION: an open row whose sandbox is already stopped is closed', async () => {
    const stoppedAt = new Date(NOW3.getTime() - 34 * 24 * HOUR);
    computeRows = [
      openRow({
        startedAt: new Date(NOW3.getTime() - 35 * 24 * HOUR).toISOString(),
        computeMetadata: { lastAliveAt: stoppedAt.toISOString() },
        sbStatus: 'stopped',
        sbUpdatedAt: stoppedAt.toISOString(),
      }),
    ];
    statusByExternal['ext-1'] = 'unknown';

    const r = await reconcileOrphanComputeSessions(NOW3);

    expect(r.closed).toBe(1);
    expect(r.byReason['sandbox-not-active']).toBe(1);
    // Billed through the stop we recorded 34 days ago, not through today.
    expect(pausedComputeWindows[0].windowEnd?.getTime()).toBe(stoppedAt.getTime());
  });

  // The liveness rule alone closes a dead row even when every other signal is
  // ambiguous — the sandbox row still says `active` and the provider says
  // `unknown`, which is exactly the 44-of-66 prod shape.
  test('REGRESSION: a row nobody has observed alive past the grace stops billing', async () => {
    const lastSeen = new Date(NOW3.getTime() - 800 * HOUR);
    computeRows = [
      openRow({
        startedAt: new Date(NOW3.getTime() - 829 * HOUR).toISOString(),
        computeMetadata: { lastAliveAt: lastSeen.toISOString() },
        sbStatus: 'active',
      }),
    ];
    statusByExternal['ext-1'] = 'unknown';

    const r = await reconcileOrphanComputeSessions(NOW3);

    expect(r.closed).toBe(1);
    expect(r.byReason['beyond-liveness-ceiling']).toBe(1);
    // One hour of grace past the last sighting. Not 800.
    expect(pausedComputeWindows[0].windowEnd?.getTime()).toBe(lastSeen.getTime() + HOUR);
    expect(statusCalls).toEqual([]);
  });

  // 44 of 66 open prod rows answered `unknown`, so the leak has to be closable
  // without ever asking the provider — otherwise a provider outage re-opens it.
  test('REGRESSION: closing a stopped-sandbox row costs ZERO provider round-trips', async () => {
    computeRows = [openRow({ sbStatus: 'stopped' })];
    statusByExternal['ext-1'] = 'unknown';

    const r = await reconcileOrphanComputeSessions(NOW3);

    expect(r.byReason['sandbox-not-active']).toBe(1);
    expect(statusCalls).toEqual([]);
  });

  test('an open row with no sandbox row behind it is closed', async () => {
    computeRows = [
      openRow({
        sbStatus: null,
        sessionProvider: null,
        sessionExternalId: null,
      }),
    ];

    const r = await reconcileOrphanComputeSessions(NOW3);

    expect(r.closed).toBe(1);
    expect(r.byReason['sandbox-row-missing']).toBe(1);
  });

  // The box that failed to start but kept its meter open.
  test('REGRESSION: a box whose wake failed stops billing at the failure', async () => {
    const failedAt = new Date(NOW3.getTime() - 90 * 60_000);
    computeRows = [
      openRow({
        sbMetadata: {
          runtimeWakeStartedAt: new Date(failedAt.getTime() - 200).toISOString(),
          runtimeWakeFailedAt: failedAt.toISOString(),
          runtimeWakeError: 'start_failed',
        },
      }),
    ];
    statusByExternal['ext-1'] = 'unknown';

    const r = await reconcileOrphanComputeSessions(NOW3);

    expect(r.closed).toBe(1);
    expect(r.byReason['runtime-start-failed']).toBe(1);
    expect(pausedComputeWindows[0].windowEnd?.getTime()).toBe(failedAt.getTime());
  });

  test('REGRESSION: an unresolvable box is armed on first sight, not closed', async () => {
    computeRows = [openRow()];
    statusByExternal['ext-1'] = 'unknown';

    const r = await reconcileOrphanComputeSessions(NOW3);

    expect(r.closed).toBe(0);
    // The unresolvedSince stamp is what makes the NEXT pass able to act.
    const stamp = updateCalls.find((c) => c.table === sandboxComputeSessions);
    expect((stamp?.updates.metadata as any)?.unresolvedSince).toBe(NOW3.toISOString());
  });

  test('REGRESSION: an unresolvable box past the ceiling stops billing', async () => {
    const lastSeen = new Date(NOW3.getTime() - 3 * HOUR);
    computeRows = [
      openRow({
        startedAt: new Date(NOW3.getTime() - 20 * HOUR).toISOString(),
        computeMetadata: {
          lastAliveAt: NOW3.toISOString(),
          unresolvedSince: lastSeen.toISOString(),
        },
      }),
    ];
    statusByExternal['ext-1'] = 'unknown';

    const r = await reconcileOrphanComputeSessions(NOW3);

    expect(r.closed).toBe(1);
    expect(r.byReason['unresolvable-past-ceiling']).toBe(1);
    expect(pausedComputeWindows[0].windowEnd?.getTime()).toBe(lastSeen.getTime());
  });

  test('a box that becomes resolvable again clears the unresolved clock', async () => {
    computeRows = [
      openRow({
        computeMetadata: {
          lastAliveAt: NOW3.toISOString(),
          unresolvedSince: new Date(NOW3.getTime() - 3 * HOUR).toISOString(),
        },
      }),
    ];
    statusByExternal['ext-1'] = 'running';

    const r = await reconcileOrphanComputeSessions(NOW3);

    expect(r.closed).toBe(0);
    const stamp = updateCalls.find((c) => c.table === sandboxComputeSessions);
    expect((stamp?.updates.metadata as any)?.unresolvedSince).toBeNull();
  });

  // 829 hours, $111.67, one row, still ticking. Never again.
  test('REGRESSION: an 829-hour window is closed at the max even if the provider says running', async () => {
    const startedAt = new Date(NOW3.getTime() - 829 * HOUR);
    computeRows = [openRow({ startedAt: startedAt.toISOString() })];
    statusByExternal['ext-1'] = 'running';

    const r = await reconcileOrphanComputeSessions(NOW3);

    expect(r.closed).toBe(1);
    expect(r.byReason['window-past-max']).toBe(1);
    expect(pausedComputeWindows[0].windowEnd?.getTime()).toBe(startedAt.getTime() + 24 * HOUR);
  });

  test('oldest-open rows are drained first so a saturated batch cannot starve them', async () => {
    computeRows = [
      openRow({
        computeId: 'cs-new',
        sandboxId: 'sb-new',
        startedAt: new Date(NOW3.getTime() - HOUR).toISOString(),
        sbStatus: 'stopped',
      }),
      openRow({
        computeId: 'cs-old',
        sandboxId: 'sb-old',
        startedAt: new Date(NOW3.getTime() - 800 * HOUR).toISOString(),
        sbStatus: 'stopped',
      }),
    ];

    await reconcileOrphanComputeSessions(NOW3);

    expect(pausedCompute[0]).toBe('sb-old');
    expect(
      orderByExpressions.some((e) => e.includes('started_at') || e.includes('startedAt')),
    ).toBe(true);
  });

  test('one bad row never sinks the sweep', async () => {
    computeRows = [
      openRow({
        computeId: 'cs-a',
        sandboxId: 'sb-a',
        startedAt: 'not-a-date',
        sbStatus: 'stopped',
      }),
      openRow({ computeId: 'cs-b', sandboxId: 'sb-b', sbStatus: 'stopped' }),
    ];

    const r = await reconcileOrphanComputeSessions(NOW3);

    expect(r.closed).toBe(2);
    expect(r.errors).toBe(0);
  });
});
