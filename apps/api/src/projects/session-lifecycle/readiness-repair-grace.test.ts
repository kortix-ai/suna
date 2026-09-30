/**
 * A session must not be parked `failed` while the repair that would fix it is
 * still running inside its own budget.
 *
 * Measured on dev 2026-09-28: a box was parked at 05:58:06 with
 * `runtimeParkReason: runtime_unreachable_timeout` while its repair —
 * started 05:57:01 — ran until 06:05:20 and only then reported
 * "relaunched but not converged within budget". The readiness clock parks at
 * 5 minutes; the repair is allowed 8. A repair needing more than five minutes
 * could never win, and its verdict landed on a session the user had already
 * been told was broken.
 */
import { describe, expect, test } from 'bun:test';
import { LEGACY_BOOTSTRAP_CONVERGE_BUDGET_MS } from '../lib/legacy-runtime-bootstrap';
import {
  REPAIR_IN_FLIGHT_GRACE_MS,
  repairInFlight,
  staleRuntimeReadyReason,
} from './readiness-clocks';

const NOW = Date.parse('2026-09-28T06:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

/** A row that has been unreachable long past the 5-minute park threshold. */
function staleUnreachableRow(bootstrap?: Record<string, unknown>) {
  return {
    runtimeUnreachableWaitStartedAt: ago(9 * 60 * 1000),
    runtimeBootWaitFirstSeenAt: ago(9 * 60 * 1000),
    ...(bootstrap ? { legacyRuntimeBootstrap: bootstrap } : {}),
  };
}

describe('the readiness clock defers to a repair that is actually running', () => {
  test('the grace equals the repair budget it defers to', () => {
    // Declared separately to keep this module free of the bootstrap import
    // graph; this pins them together so they cannot drift apart silently.
    expect(REPAIR_IN_FLIGHT_GRACE_MS).toBe(LEGACY_BOOTSTRAP_CONVERGE_BUDGET_MS);
  });

  test('without a repair, a long-unreachable row still parks', () => {
    expect(staleRuntimeReadyReason(staleUnreachableRow(), 'unreachable', NOW)).toBe(
      'runtime_unreachable_timeout',
    );
  });

  test('a repair running inside its budget holds the park off', () => {
    const row = staleUnreachableRow({ state: 'running', lastAttemptAt: ago(60 * 1000) });
    expect(repairInFlight(row, NOW)).toBe(true);
    expect(staleRuntimeReadyReason(row, 'unreachable', NOW)).toBeNull();
  });

  test('a repair past its budget stops holding it — a wedged repair cannot park forever', () => {
    const row = staleUnreachableRow({
      state: 'running',
      lastAttemptAt: ago(REPAIR_IN_FLIGHT_GRACE_MS + 1000),
    });
    expect(repairInFlight(row, NOW)).toBe(false);
    expect(staleRuntimeReadyReason(row, 'unreachable', NOW)).toBe(
      'runtime_unreachable_timeout',
    );
  });

  test('a finished repair does not hold it', () => {
    for (const state of ['converged', 'failed']) {
      const row = staleUnreachableRow({ state, lastAttemptAt: ago(60 * 1000) });
      expect(repairInFlight(row, NOW)).toBe(false);
      expect(staleRuntimeReadyReason(row, 'unreachable', NOW)).toBe(
        'runtime_unreachable_timeout',
      );
    }
  });

  test('a malformed or absent bootstrap record is not a repair', () => {
    for (const bootstrap of [undefined, null, 'running', [], {}, { state: 'running' }]) {
      const row = staleUnreachableRow(bootstrap as Record<string, unknown>);
      expect(repairInFlight(row, NOW)).toBe(false);
    }
  });
});
