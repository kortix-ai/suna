import { describe, expect, test } from 'bun:test';
import { parkMetadataPatch, runtimeLossVerdict } from './runtime-identity';

/**
 * Incident 2026-08-14 (docs/incidents/2026-08-14-computer-lost-false-alarm-and-boot-failures.md).
 *
 * Two healthy sandboxes were shown as "This session's computer was lost": a
 * dead local tunnel kept them from booting, the on-open path preserved both as
 * unavailable, and NOTHING asked the provider first. Both provider control
 * planes reported the boxes running the whole time.
 *
 * The rule these tests pin: only a fresh, definitive provider `removed` may
 * classify an identity as lost. Everything else — present states, transitional
 * states, and probes the provider could not answer — parks the runtime as an
 * ordinary stopped row that a later /start can wake.
 */
describe('runtimeLossVerdict', () => {
  test('a definitive provider `removed` is the ONLY loss verdict', () => {
    expect(runtimeLossVerdict('removed')).toBe('preserve');
  });

  test.each(['running', 'stopped', 'starting', 'restoring', 'error'])(
    'a present or transitional provider state (%s) parks instead of preserving',
    (status) => {
      expect(runtimeLossVerdict(status)).toBe('park');
    },
  );

  test('`unknown` is a probe failure, not evidence of loss — it parks', () => {
    // Declaring a permanent, unrecoverable loss requires positive evidence.
    // A timeout or 5xx from the provider control plane is not that.
    expect(runtimeLossVerdict('unknown')).toBe('park');
  });
});

describe('parkMetadataPatch', () => {
  const now = new Date('2026-08-14T18:24:51.624Z');
  const patch = parkMetadataPatch('opencode_ready_wait_stale', 'runtime_boot_failed', now);

  test('a park never carries the loss flags the web renders as "computer was lost"', () => {
    // apps/web isRuntimeIdentityUnavailable() keys on runtimeIdentityState ===
    // 'unavailable'; preservedExternalId / runtimeUnavailable* are its
    // companions. None of them may appear on a park.
    expect(patch).not.toHaveProperty('runtimeIdentityState');
    expect(patch).not.toHaveProperty('runtimeUnavailableReason');
    expect(patch).not.toHaveProperty('runtimeUnavailableAt');
    expect(patch).not.toHaveProperty('preservedExternalId');
  });

  test('a park still records WHICH failure parked it, for the stop-reason query', () => {
    expect(patch.stopReason).toBe('runtime_boot_failed');
    expect(patch.stoppedAt).toBe('2026-08-14T18:24:51.624Z');
    expect(patch.runtimeParkReason).toBe('opencode_ready_wait_stale');
    expect(patch.providerStopPendingAt).toBe('2026-08-14T18:24:51.624Z');
  });
});
