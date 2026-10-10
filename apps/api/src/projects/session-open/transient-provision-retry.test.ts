/**
 * A wake (or a first provision) that hit a full provider fleet must not stick.
 *
 * Rig, 2026-10-10: five sessions reopened at once, one ephemeral wake got
 * Platinum's 503 "no capacity", and every later `/start` replayed
 * `{stage:'failed', retriable:false}` under a message that said "Try again in
 * a minute". Only Restart recovered it. `/start` now re-attempts a transient
 * failure itself, with backoff, and its `retriable` agrees with its message.
 *
 * Collaborators are injected (the `replaceRefusedRuntimeOnOpen` seam), so the
 * classification and the backoff are real and nothing touches a provider.
 */
import type { sessionSandboxes } from '@kortix/db';
import { describe, expect, test } from 'bun:test';
import { classifySandboxProvisioningFailure } from '../../platform/services/sandbox-provisioning-error';
import { retryTransientProvisionFailure, TRANSIENT_PROVISION_MAX_RETRIES } from './index';

const FAILED_AT = new Date('2026-10-10T09:00:00.000Z');
const at = (ms: number) => new Date(FAILED_AT.getTime() + ms);

/** The row `failSessionSandboxProvisioning` leaves behind for a provider error. */
function failedWakeRow(providerError: string, extra: Record<string, unknown> = {}) {
  const failure = classifySandboxProvisioningFailure(new Error(providerError));
  return {
    sandboxId: 'sess-cap-1',
    sessionId: 'sess-cap-1',
    projectId: 'proj-1',
    accountId: 'acct-1',
    provider: 'platinum',
    externalId: null,
    baseUrl: null,
    status: 'error',
    config: {},
    metadata: {
      ephemeralWakeAt: FAILED_AT.toISOString(),
      platinumCreateAttempt: 301,
      initStatus: 'failed',
      initFailedAt: FAILED_AT.toISOString(),
      lastProvisioningError: providerError,
      errorMessage: failure.userMessage,
      failureCategory: failure.category,
      failureTransient: failure.transient,
      ...extra,
    },
    lastUsedAt: null,
    deadlineAt: null,
    createdAt: FAILED_AT,
    updatedAt: FAILED_AT,
  } as unknown as typeof sessionSandboxes.$inferSelect;
}

const ARGS = {
  loaded: { row: {} as never, userId: 'user-1' },
  visible: {
    row: { sandboxProvider: 'platinum', baseRef: null, agentName: 'default', metadata: null },
  } as never,
  projectId: 'proj-1',
  sessionId: 'sess-cap-1',
};

const CAPACITY_503 =
  'platinum POST /v1/sandboxes?wait_for_state=running&wait_timeout_ms=60000 -> 503 ' +
  '{"error":"no capacity on a host that can mount these volumes","region":"eu-west","pinned_host":null}';

describe('a transient provision failure on wake', () => {
  test('is retried by /start with backoff, never replayed as terminal', async () => {
    const allocations: Array<Record<string, unknown> | undefined> = [];
    const deps = {
      claim: async () => true,
      allocate: async (_l: unknown, _v: unknown, _p: string, _s: string, extra?: Record<string, unknown>) => {
        allocations.push(extra);
      },
      canAllocate: () => true,
    };
    const row = failedWakeRow(CAPACITY_503);

    // Inside the backoff: polling makes progress, and the copy says so.
    const waiting = await retryTransientProvisionFailure(ARGS, row, at(1_000), deps);
    expect(waiting?.stage).toBe('starting');
    expect(waiting?.retriable).toBe(true);
    expect(waiting?.failure?.category).toBe('provider-capacity');
    expect(waiting?.failure?.message).toMatch(/Retrying automatically/);
    expect(waiting?.failure?.message).not.toMatch(/Try again/);
    expect(waiting?.failure?.evidence?.next_retry_at).toBe(at(5_000).toISOString());
    expect(allocations).toHaveLength(0);

    // Past it: the same /start re-provisions on a new create attempt — no Restart.
    const retried = await retryTransientProvisionFailure(ARGS, row, at(5_000), deps);
    expect(retried?.stage).toBe('provisioning');
    expect(retried?.retriable).toBe(true);
    expect(allocations).toEqual([{ transientRetryCount: 1, platinumCreateAttempt: 302 }]);

    // Bounded: a fleet that stays full ends in an answer that says Restart and
    // stops the poll, instead of one that says "a minute" and stops it anyway.
    const exhausted = await retryTransientProvisionFailure(
      ARGS,
      failedWakeRow(CAPACITY_503, { transientRetryCount: TRANSIENT_PROVISION_MAX_RETRIES }),
      at(3_600_000),
      deps,
    );
    expect(exhausted?.stage).toBe('failed');
    expect(exhausted?.retriable).toBe(false);
    expect(exhausted?.failure?.message).toMatch(/Restart/);
    expect(allocations).toHaveLength(1);

    // A refusal that fails identically every time keeps its terminal answer.
    const refused = failedWakeRow(
      'platinum POST /v1/sandboxes -> 400 {"error":"ram_mb=4096 exceeds your plan\'s per-sandbox limit","code":"spec_over_tier_cap"}',
    );
    expect(await retryTransientProvisionFailure(ARGS, refused, at(3_600_000), deps)).toBeNull();
  });

  test('a server that cannot provision this provider keeps the stored answer', async () => {
    // No retry is possible (the provider is not allowed here, or the box could
    // not call back), so none is claimed: /start answers the stored failure.
    let claimed = false;
    const answer = await retryTransientProvisionFailure(ARGS, failedWakeRow(CAPACITY_503), at(3_600_000), {
      claim: async () => (claimed = true),
      allocate: async () => {},
      canAllocate: () => false,
    });
    expect(answer).toBeNull();
    expect(claimed).toBe(false);
  });
});
