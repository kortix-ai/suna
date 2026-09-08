import { describe, expect, test } from 'bun:test';

import { RUNTIME_WAKE_CLAIM_CLEARED_KEYS, shouldBootstrapSessionRuntime } from './shared';
import { prepareInPlaceRestartMetadata } from '../session-lifecycle/readiness-clocks';

/**
 * Measured on pi.kortix.com 2026-08-29, with a stop/resume on live sessions:
 *
 *   never stopped  → stage: ready,   runtime: ready
 *   stopped        → starting/unreachable/active → 33s → failed/
 *                    runtime_unreachable_timeout/stopped → cooldown → repeat
 *
 * Same project, same account, same snapshot (`kortix-piworker-preview-…`).
 * Three attempts each, none ever recovered; one box had been retrying for over
 * eight minutes. Restart failed identically, and the box was only hours old, so
 * this is not a token expiry.
 *
 * Daytona resumes the sandbox and starts nothing inside it — it replaces the
 * image ENTRYPOINT, which is why `ensureAppRuntimeStarted` exists for the App
 * workload on all three providers. The session workload had no equivalent, so
 * `/start`'s own "needs an explicit restart" path cycled the BOX, which cannot
 * help a box that is already running and merely empty.
 */
describe('shouldBootstrapSessionRuntime', () => {
  const base = {
    reason: 'unreachable' as const,
    externalId: 'box-1',
    attemptedForExternalId: undefined as unknown,
    providerSupportsBootstrap: true,
  };

  test('starts the process for a box that is running but unreachable', () => {
    expect(shouldBootstrapSessionRuntime(base)).toBe(true);
  });

  test('NEVER for not_ready — the daemon answered, so a process is already up', () => {
    // Launching a second worker against a booting one is the one way this
    // recovery could do harm.
    expect(shouldBootstrapSessionRuntime({ ...base, reason: 'not_ready' })).toBe(false);
  });

  test('one attempt per box-run, so a genuinely broken box is not hammered', () => {
    expect(shouldBootstrapSessionRuntime({ ...base, attemptedForExternalId: 'box-1' })).toBe(false);
  });

  test('a NEW box earns its own attempt', () => {
    // The stamp is keyed to the external id, so a reprovision is not blocked by
    // the previous box's failed attempt.
    expect(shouldBootstrapSessionRuntime({ ...base, attemptedForExternalId: 'box-0' })).toBe(true);
  });

  test('providers that re-run their entrypoint on resume are left alone', () => {
    // Platinum cold-boots the template on resume, so it needs nothing here and
    // must not be asked.
    expect(shouldBootstrapSessionRuntime({ ...base, providerSupportsBootstrap: false })).toBe(false);
  });
});


test('a new wake of the same box can bootstrap again without resetting its failure budget', () => {
  const metadata: Record<string, unknown> = {
    sessionRuntimeBootstrapFor: 'box-1',
    sessionRuntimeBootstrapAt: '2026-09-08T08:00:00.000Z',
    runtimeStartFailureCount: 1,
  };
  const input = {
    reason: 'unreachable' as const,
    externalId: 'box-1',
    providerSupportsBootstrap: true,
  };
  expect(shouldBootstrapSessionRuntime({ ...input, attemptedForExternalId: metadata.sessionRuntimeBootstrapFor })).toBe(false);
  const nextWake = Object.fromEntries(
    Object.entries(metadata).filter(([key]) => !(RUNTIME_WAKE_CLAIM_CLEARED_KEYS as readonly string[]).includes(key)),
  );
  expect(shouldBootstrapSessionRuntime({ ...input, attemptedForExternalId: nextWake.sessionRuntimeBootstrapFor })).toBe(true);
  expect(nextWake.sessionRuntimeBootstrapAt).toBeUndefined();
  expect(nextWake.runtimeStartFailureCount).toBe(1);
});


test('an explicit restart earns another bootstrap attempt and resets the failure episode', () => {
  const restarted = prepareInPlaceRestartMetadata({
    sessionRuntimeBootstrapFor: 'box-1',
    sessionRuntimeBootstrapAt: '2026-09-08T08:00:00.000Z',
    runtimeStartFailureCount: 2,
  });
  expect(shouldBootstrapSessionRuntime({
    reason: 'unreachable',
    externalId: 'box-1',
    attemptedForExternalId: restarted.sessionRuntimeBootstrapFor,
    providerSupportsBootstrap: true,
  })).toBe(true);
  expect(restarted.sessionRuntimeBootstrapAt).toBeUndefined();
  expect(restarted.runtimeStartFailureCount).toBeUndefined();
});
