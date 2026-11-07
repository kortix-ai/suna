import type { SessionStartResult } from '@kortix/api-contract';
import { describe, expect, test } from 'bun:test';
import { createStartCallLog, deriveBoot, withStartEnvelope } from './start-envelope';

const OBSERVED_AT = new Date('2026-08-26T14:00:00.000Z');

function payload(partial: Partial<SessionStartResult>): SessionStartResult {
  return {
    stage: 'starting',
    agent_name: 'default',
    retriable: true,
    sandbox: null,
    runtime_session_id: null,
    ...partial,
  };
}

describe('the session-open answer names the runtime session neutrally', () => {
  test('runtime_session_id carries the same pin as runtime_session_id', () => {
    const log = createStartCallLog(OBSERVED_AT);
    const pinned = withStartEnvelope(payload({ runtime_session_id: 'ses_root' }), log);
    expect(pinned.runtime_session_id).toBe('ses_root');
    expect(pinned.runtime_session_id).toBe('ses_root');
    expect(withStartEnvelope(payload({}), log).runtime_session_id).toBeNull();
  });
});

describe('the session-open envelope states what THIS call did', () => {
  test('ready: provider checked, daemon answered, nothing left starting', () => {
    const log = createStartCallLog(OBSERVED_AT);
    log.sawProvider('running');
    log.sawRuntime('ready');
    const result = withStartEnvelope(
      payload({ stage: 'ready', retriable: false, reason: 'ready' }),
      log,
      { providerRunningConfirmedAt: '2026-08-26T13:59:00.000Z' },
    );
    expect(result.observed_at).toBe(OBSERVED_AT.toISOString());
    expect(result.action).toBe('checked_provider');
    expect(result.observation?.provider).toMatchObject({ known: true, status: 'running' });
    expect(result.observation?.runtime).toMatchObject({ known: true, state: 'ready' });
    expect(result.boot).toMatchObject({
      phase: 'ready',
      since: '2026-08-26T13:59:00.000Z',
      actively_starting: false,
    });
  });

  test('resuming: the wake this call started is actively_starting', () => {
    const log = createStartCallLog(OBSERVED_AT);
    log.sawProvider('stopped');
    log.did('resumed');
    const result = withStartEnvelope(payload({ reason: 'runtime_waking' }), log, {
      runtimeWakeId: 'wake-1',
      runtimeWakeStartedAt: '2026-08-26T13:59:55.000Z',
    });
    expect(result.action).toBe('resumed');
    expect(result.boot).toMatchObject({
      phase: 'resuming',
      since: '2026-08-26T13:59:55.000Z',
      actively_starting: true,
    });
  });

  test('creating: a provisioning call never claims a provider observation', () => {
    const log = createStartCallLog(OBSERVED_AT);
    log.did('provisioned');
    const result = withStartEnvelope(payload({ stage: 'provisioning' }), log, {
      initStatus: 'provisioning',
      initStartedAt: '2026-08-26T13:59:58.000Z',
    });
    expect(result.action).toBe('provisioned');
    // known:false = NOT CHECKED. It is never "checked and found nothing".
    expect(result.observation?.provider.known).toBe(false);
    expect(result.observation?.provider.status).toBeNull();
    expect(result.observation?.runtime.known).toBe(false);
    expect(result.boot).toMatchObject({ phase: 'provisioning', actively_starting: true });
  });

  test('booting: the daemon verdict this call earned, with its boot phase', () => {
    const log = createStartCallLog(OBSERVED_AT);
    log.sawProvider('running');
    log.sawRuntime('booting', 'installing-opencode@1.18.23');
    const result = withStartEnvelope(payload({ reason: 'not_ready' }), log, {
      runtimeBootWaitFirstSeenAt: '2026-08-26T13:59:30.000Z',
    });
    expect(result.boot?.phase).toBe('booting');
    expect(result.observation?.runtime.boot_phase).toBe('installing-opencode@1.18.23');
  });

  test('booting: since = the first-seen clock, under its neutral or its pre-W4 name', () => {
    const booting = (metadata: Record<string, unknown>) => {
      const log = createStartCallLog(OBSERVED_AT);
      log.sawProvider('running');
      log.sawRuntime('booting', 'p0');
      return withStartEnvelope(payload({ reason: 'not_ready' }), log, metadata).boot?.since;
    };
    expect(booting({ runtimeBootWaitFirstSeenAt: '2026-08-26T13:59:30.000Z' })).toBe(
      '2026-08-26T13:59:30.000Z',
    );
  });

  // `cooling_down` is proven through the real /start route in
  // __tests__/e2e-project-session-contract.test.ts (the wake-cooldown case).
  test('genuinely failed: the negative carries the check that produced it', () => {
    const log = createStartCallLog(OBSERVED_AT);
    log.sawProvider('stopped');
    log.did('reconciled');
    const result = withStartEnvelope(
      payload({
        stage: 'failed',
        retriable: false,
        reason: 'runtime_boot_failed',
        failure: {
          category: 'sandbox-provider',
          message: 'The session runtime did not become reachable after 5 attempts.',
          retryable: true,
          evidence: {
            check: 'runtime_not_ready_timeout',
            observed_at: '2026-08-26T13:50:00.000Z',
            error: 'opencode never bound :4096',
            attempts: 5,
            next_retry_at: null,
          },
        },
      }),
      log,
      { stoppedAt: '2026-08-26T13:50:00.000Z' },
    );
    expect(result.action).toBe('reconciled');
    expect(result.boot?.phase).toBe('failed');
    // The negative names the provider check that produced it.
    expect(result.observation?.provider.checked_at).not.toBeNull();
  });

  test('a more specific action always outranks `inspected`, and never the reverse', () => {
    const log = createStartCallLog(OBSERVED_AT);
    log.did('resumed');
    log.did('inspected');
    log.sawProvider('stopped');
    expect(log.action).toBe('resumed');
  });

  test('provisioning: the image step the row recorded is boot.image', () => {
    const step = { state: 'building' as const, image: 'kortix-default-abc', since: '2026-08-26T13:59:58.000Z' };
    const boot = deriveBoot(payload({ stage: 'provisioning' }), { initStatus: 'provisioning', imageStep: step }, 'inspected', OBSERVED_AT);
    expect(boot.image).toEqual(step);
  });

  test('provisioning before the image step: boot.image is null; a malformed step is null, never a guess', () => {
    expect(deriveBoot(payload({ stage: 'provisioning' }), { initStatus: 'provisioning' }, 'inspected', OBSERVED_AT).image).toBeNull();
    const malformed = { initStatus: 'provisioning', imageStep: { state: 'compiling', image: 1, since: 'later' } };
    expect(deriveBoot(payload({ stage: 'provisioning' }), malformed, 'inspected', OBSERVED_AT).image).toBeNull();
  });

  test('a ready session carries no image step, even when the row still holds one', () => {
    const boot = deriveBoot(
      payload({ stage: 'ready' }),
      { imageStep: { state: 'serving_last_ready', image: 'x', since: '2026-08-26T13:59:58.000Z' } },
      'inspected',
      OBSERVED_AT,
    );
    expect('image' in boot).toBe(false);
  });

  test('deriveBoot never reports actively_starting for a parked row nobody is waking', () => {
    const boot = deriveBoot(payload({ stage: 'stopped' }), { stoppedAt: '2026-08-26T13:00:00.000Z' }, 'inspected', OBSERVED_AT);
    expect(boot).toEqual({
      phase: 'parked',
      since: '2026-08-26T13:00:00.000Z',
      actively_starting: false,
    });
  });
});
