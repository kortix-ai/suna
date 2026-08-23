/**
 * `GET .../turn` is server truth, and the web is server-truth-first: while the
 * authority says `active`, the UI shows "Gathering thoughts". When the daemon's
 * turn-end relay is lost (an OpenCode replacement dropped the /event
 * subscription; live 2026-08-23, session eddd499a), the only thing that ended
 * the turn was the reaper, on its cadence, with an orphan min-age — 80+s of a
 * spinner on a 5s answer. This module is the bounded server-truth reconcile the
 * read path runs itself, through the SAME daemon observation the reaper uses.
 *
 * Every case drives the real module with injected dependencies: the daemon
 * reading, the clear, the husk finalizer, the clock and the per-sandbox
 * rate-limit map are all under test control.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import type { SandboxProvider } from '../../platform/providers';
import type { SandboxTurnReading } from '../reaping/box-reaper';
import type { StoredSandboxTurn } from '../sandbox-turn-lifecycle';
import {
  TURN_READ_RECONCILE_EVERY_MS,
  TURN_READ_RECONCILE_MIN_AGE_MS,
  type TurnReadReconcileDependencies,
  type TurnReadReconcileResult,
  reconcileStaleTurnsOnRead,
} from './turn-read-reconcile';

const BOX = { sandboxId: 'sb-1', provider: 'daytona' as const, externalId: 'ext-1' };
const NOW = 1_760_000_000_000;

function turn(overrides: Partial<StoredSandboxTurn> & { token: string }): StoredSandboxTurn {
  return {
    state: 'active',
    opencodeSessionId: 'ses_root',
    messageId: 'msg_turn_1',
    startedAtMs: NOW - TURN_READ_RECONCILE_MIN_AGE_MS - 1_000, // old enough by default
    ...overrides,
  };
}

const inFlight: SandboxTurnReading = {
  observation: 'active',
  endReason: null,
  daemonAnswered: true,
  orphanedPrompt: false,
};
const completed: SandboxTurnReading = {
  observation: 'terminal',
  endReason: 'completed',
  daemonAnswered: true,
  orphanedPrompt: false,
};
const terminalUnclassified: SandboxTurnReading = {
  observation: 'terminal',
  endReason: null,
  daemonAnswered: true,
  orphanedPrompt: false,
};
const unreachable: SandboxTurnReading = {
  observation: 'unknown',
  endReason: null,
  daemonAnswered: false,
  orphanedPrompt: false,
};

let observations: Array<{ externalId: string; sandboxId?: string; identity?: unknown }> = [];
let clears: Array<{ sandboxId: string; token: string; reason?: string }> = [];
let huskCalls: Array<Record<string, unknown>> = [];
let reading: SandboxTurnReading = inFlight;
let huskOutcome: 'finalized' | 'not_husk' | 'unreadable' = 'not_husk';
let nowMs = NOW;
let lastProbeAt: Map<string, number>;
const provider = { resolveEndpoint: async () => ({ url: 'http://daemon', headers: {} }) } as unknown as SandboxProvider;

function deps(): TurnReadReconcileDependencies {
  return {
    observeSandboxTurn: async (_provider, externalId, sandboxId, identity) => {
      observations.push({ externalId, sandboxId, identity });
      return reading;
    },
    clearSandboxTurn: async (sandboxId, token, _graceMs, reason) => {
      clears.push({ sandboxId, token, reason });
      return true;
    },
    finalizeHuskTurn: async (target) => {
      huskCalls.push(target as unknown as Record<string, unknown>);
      return huskOutcome;
    },
    getProvider: () => provider,
    now: () => nowMs,
    lastProbeAt,
  };
}

function run(turns: StoredSandboxTurn[]): Promise<TurnReadReconcileResult> {
  return reconcileStaleTurnsOnRead(BOX, turns, deps());
}

beforeEach(() => {
  observations = [];
  clears = [];
  huskCalls = [];
  reading = inFlight;
  huskOutcome = 'not_husk';
  nowMs = NOW;
  lastProbeAt = new Map();
});

describe('reconcileStaleTurnsOnRead', () => {
  test('constants: 15s min age, 10s per-sandbox probe interval', () => {
    expect(TURN_READ_RECONCILE_MIN_AGE_MS).toBe(15_000);
    expect(TURN_READ_RECONCILE_EVERY_MS).toBe(10_000);
  });

  test('daemon says the turn is in flight → untouched, no DB write', async () => {
    reading = inFlight;
    const result = await run([turn({ token: 't1' })]);
    expect(result).toEqual({ probed: 1, ended: 0, skipped: 'none' });
    expect(clears).toEqual([]);
    expect(huskCalls).toEqual([]);
  });

  test('terminal + assistant completed without error → ended with end_reason completed', async () => {
    reading = completed;
    const result = await run([turn({ token: 't1' })]);
    expect(result).toEqual({ probed: 1, ended: 1, skipped: 'none' });
    expect(clears).toEqual([{ sandboxId: 'sb-1', token: 't1', reason: 'completed' }]);
    // The daemon was asked about THIS turn's identity, exactly as the reaper asks.
    expect(observations).toEqual([
      {
        externalId: 'ext-1',
        sandboxId: 'sb-1',
        identity: expect.objectContaining({ opencodeSessionId: 'ses_root', messageId: 'msg_turn_1' }),
      },
    ]);
  });

  test('terminal with no daemon reason → the husk finalizer decides: finalized → failed, else unknown', async () => {
    reading = terminalUnclassified;
    huskOutcome = 'finalized';
    await run([turn({ token: 't1' })]);
    expect(huskCalls).toEqual([
      { sandboxId: 'sb-1', externalId: 'ext-1', opencodeSessionId: 'ses_root', messageId: 'msg_turn_1' },
    ]);
    expect(clears).toEqual([{ sandboxId: 'sb-1', token: 't1', reason: 'failed' }]);

    clears = [];
    huskOutcome = 'not_husk';
    lastProbeAt.clear();
    await run([turn({ token: 't2' })]);
    expect(clears).toEqual([{ sandboxId: 'sb-1', token: 't2', reason: 'unknown' }]);
  });

  test('a turn younger than the min age is never probed', async () => {
    reading = completed;
    const result = await run([turn({ token: 'young', startedAtMs: NOW - TURN_READ_RECONCILE_MIN_AGE_MS + 1 })]);
    expect(result).toEqual({ probed: 0, ended: 0, skipped: 'no_stale_turn' });
    expect(observations).toEqual([]);
    expect(clears).toEqual([]);
    // And it leaves no rate-limit footprint: the next read that DOES qualify probes.
    expect(lastProbeAt.size).toBe(0);
  });

  test('exactly the min age qualifies', async () => {
    reading = completed;
    const result = await run([turn({ token: 'edge', startedAtMs: NOW - TURN_READ_RECONCILE_MIN_AGE_MS })]);
    expect(result.probed).toBe(1);
    expect(clears.length).toBe(1);
  });

  test('a delivering record, and a legacy record with no start instant, are left to the reaper', async () => {
    reading = completed;
    const result = await run([
      turn({ token: 'd', state: 'delivering' }),
      turn({ token: 'legacy', startedAtMs: null }),
    ]);
    expect(result).toEqual({ probed: 0, ended: 0, skipped: 'no_stale_turn' });
    expect(observations).toEqual([]);
  });

  test('rate limit: a second read within 10s of the last probe does not probe again', async () => {
    reading = completed;
    await run([turn({ token: 't1' })]);
    expect(observations.length).toBe(1);
    nowMs = NOW + TURN_READ_RECONCILE_EVERY_MS - 1;
    const second = await run([turn({ token: 't1' })]);
    expect(second).toEqual({ probed: 0, ended: 0, skipped: 'rate_limited' });
    expect(observations.length).toBe(1);
    nowMs = NOW + TURN_READ_RECONCILE_EVERY_MS;
    const third = await run([turn({ token: 't1' })]);
    expect(third.probed).toBe(1);
    expect(observations.length).toBe(2);
  });

  test('the rate limit is per sandbox', async () => {
    reading = completed;
    await run([turn({ token: 't1' })]);
    const other = await reconcileStaleTurnsOnRead(
      { ...BOX, sandboxId: 'sb-2', externalId: 'ext-2' },
      [turn({ token: 't9' })],
      deps(),
    );
    expect(other.probed).toBe(1);
    expect(observations.map((o) => o.externalId)).toEqual(['ext-1', 'ext-2']);
  });

  test('daemon unreachable → untouched, and the rate limit still applies (no hammering a dead box)', async () => {
    reading = unreachable;
    const result = await run([turn({ token: 't1' })]);
    expect(result).toEqual({ probed: 1, ended: 0, skipped: 'none' });
    expect(clears).toEqual([]);
    const again = await run([turn({ token: 't1' })]);
    expect(again.skipped).toBe('rate_limited');
  });

  test('an orphaned prompt (daemon: prompt on record, nothing answering) is left to the reaper redelivery', async () => {
    reading = { ...terminalUnclassified, orphanedPrompt: true };
    const result = await run([turn({ token: 't1' })]);
    expect(result.ended).toBe(0);
    expect(clears).toEqual([]);
  });

  test('a box with no external id cannot be probed', async () => {
    reading = completed;
    const result = await reconcileStaleTurnsOnRead(
      { ...BOX, externalId: null },
      [turn({ token: 't1' })],
      deps(),
    );
    expect(result).toEqual({ probed: 0, ended: 0, skipped: 'no_endpoint' });
    expect(observations).toEqual([]);
  });

  test('a throwing dependency never escapes the read path', async () => {
    const result = await reconcileStaleTurnsOnRead(BOX, [turn({ token: 't1' })], {
      ...deps(),
      observeSandboxTurn: async () => {
        throw new Error('boom');
      },
    });
    expect(result).toEqual({ probed: 1, ended: 0, skipped: 'none' });
    expect(clears).toEqual([]);
  });

  test('the rate-limit map is pruned: entries older than 10 intervals are dropped when it grows', async () => {
    reading = completed;
    for (let i = 0; i < 1_001; i++) lastProbeAt.set(`sb-old-${i}`, NOW - TURN_READ_RECONCILE_EVERY_MS * 11);
    await run([turn({ token: 't1' })]);
    expect(lastProbeAt.has('sb-old-0')).toBe(false);
    expect(lastProbeAt.get('sb-1')).toBe(NOW);
  });
});
