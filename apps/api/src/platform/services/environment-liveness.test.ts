/**
 * The reconcile that was missing, and the reason a pi session could wedge for
 * good. See `environment-liveness.ts` for the mechanism.
 */
import { describe, expect, test } from 'bun:test';
import { decideEnvironmentLiveness, environmentReconcileWrite } from './environment-liveness';

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

/**
 * What the reconcile must WRITE, which is not the same question as what to do.
 *
 * The first version of this got it wrong in a way no unit test could see,
 * because it only ever asserted the action. `reprovision` wrote
 * `status = 'error'` and left `external_id` in place — but
 * `runEnvironmentWork` (session-environment.ts:309) branches on exactly that
 * column:
 *
 *     if (externalId) { await resumeEnvironment(externalId); ... }
 *     // provision happens ONLY in the else
 *
 * So a removed box was re-claimed out of 'error', sent down the RESUME branch
 * against an id the provider no longer has, failed, and was marked 'error'
 * again — forever. The wedge became an infinite retry, which is better only in
 * that it stops serving a dead URL. Clearing `external_id` is what actually
 * routes it to the provision branch.
 */
describe('what the reconcile writes', () => {
  test('resume keeps the box id — the box is off, not gone', () => {
    expect(environmentReconcileWrite('resume')).toEqual({
      status: 'stopped',
      clearExternalId: false,
    });
  });

  test('reprovision CLEARS the box id, or nothing will ever rebuild it', () => {
    expect(environmentReconcileWrite('reprovision')).toEqual({
      status: 'error',
      clearExternalId: true,
    });
  });

  test('serve writes nothing at all', () => {
    expect(environmentReconcileWrite('serve')).toBeNull();
  });
});
