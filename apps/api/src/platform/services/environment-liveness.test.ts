/**
 * The reconcile that was missing, and the reason a pi session could wedge for
 * good. See `environment-liveness.ts` for the mechanism.
 */
import { describe, expect, test } from 'bun:test';
import { decideEnvironmentLiveness } from './environment-liveness';

describe('what to do with an "active" row', () => {
  test('a running box: the row is honest', () => {
    expect(decideEnvironmentLiveness('running')).toBe('serve');
  });

  /**
   * THE case. `autoStopInterval: 60` powers an idle environment off and nothing
   * writes that to the row, so `ensure` kept handing back a box that was off.
   * Marking it 'stopped' is what lets `claimEnvironmentWork` re-claim and
   * resume it — that path already exists and was simply unreachable.
   */
  test('a stopped box: resume it, do not keep serving a dead origin', () => {
    expect(decideEnvironmentLiveness('stopped')).toBe('resume');
  });

  test('a removed box cannot be started, so it must be rebuilt', () => {
    expect(decideEnvironmentLiveness('removed')).toBe('reprovision');
  });

  test('a box the provider calls dead is rebuilt, not resumed', () => {
    expect(decideEnvironmentLiveness('terminal')).toBe('reprovision');
  });

  /**
   * `providers/status.ts` records why `unknown` is its own state and not folded
   * into a failure: conflating them was "the single most expensive bug in this
   * subsystem". Uncertainty must not authorize a teardown — a provider blip
   * would otherwise reprovision every healthy environment at once.
   */
  test('an unreachable provider is not evidence the box is down', () => {
    expect(decideEnvironmentLiveness('unknown')).toBe('serve');
  });
});
