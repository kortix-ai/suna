import { describe, expect, test } from 'bun:test';
import {
  canActivateGeneration,
  classifyProviderSwitch,
  classifyTransitionFailure,
  decideActivation,
  interpretImageReadiness,
  isLiveTransition,
  isPermanentTransitionError,
  isSupersededByGeneration,
  isTerminalTransition,
  isTransientTransitionError,
  MAX_TRANSITION_ATTEMPTS,
  nextGeneration,
  normalizeTargetProvider,
  prepIdentityUnchanged,
  preparationLabel,
  transitionBackoffMs,
  transitionDedupKey,
} from './provider-transition-core';

describe('status predicates', () => {
  test('live vs terminal partition every status', () => {
    for (const s of ['pending', 'building', 'ready', 'activating'] as const) {
      expect(isLiveTransition(s)).toBe(true);
      expect(isTerminalTransition(s)).toBe(false);
    }
    for (const s of ['activated', 'failed', 'superseded', 'cancelled'] as const) {
      expect(isTerminalTransition(s)).toBe(true);
      expect(isLiveTransition(s)).toBe(false);
    }
  });
});

describe('dedup key + identity drift', () => {
  const base = {
    projectId: 'p1',
    targetProvider: 'platinum',
    commitSha: 'abc',
    baseRuntimeIdentity: 'kortix-default-1',
  };

  test('same inputs produce the same key; a moved commit changes it', () => {
    expect(transitionDedupKey(base)).toBe(transitionDedupKey({ ...base }));
    expect(transitionDedupKey(base)).not.toBe(transitionDedupKey({ ...base, commitSha: 'def' }));
    expect(transitionDedupKey(base)).not.toBe(
      transitionDedupKey({ ...base, baseRuntimeIdentity: 'kortix-default-2' }),
    );
  });

  test('prepIdentityUnchanged detects a moved tip or bumped base runtime', () => {
    expect(prepIdentityUnchanged({ commitSha: 'abc', baseRuntimeIdentity: 'r1' }, { commitSha: 'abc', baseRuntimeIdentity: 'r1' })).toBe(true);
    expect(prepIdentityUnchanged({ commitSha: 'abc', baseRuntimeIdentity: 'r1' }, { commitSha: 'def', baseRuntimeIdentity: 'r1' })).toBe(false);
    expect(prepIdentityUnchanged({ commitSha: 'abc', baseRuntimeIdentity: 'r1' }, { commitSha: 'abc', baseRuntimeIdentity: 'r2' })).toBe(false);
  });
});

describe('generation CAS', () => {
  test('activation only wins with a strictly-greater generation', () => {
    expect(canActivateGeneration({ transitionGeneration: 2, projectRecordedGeneration: 1 })).toBe(true);
    expect(canActivateGeneration({ transitionGeneration: 1, projectRecordedGeneration: 1 })).toBe(false);
    expect(canActivateGeneration({ transitionGeneration: 1, projectRecordedGeneration: 2 })).toBe(false);
  });

  test('a strictly-newer generation supersedes an older live transition', () => {
    expect(isSupersededByGeneration(1, 2)).toBe(true);
    expect(isSupersededByGeneration(2, 2)).toBe(false);
    expect(isSupersededByGeneration(3, 2)).toBe(false);
  });

  test('nextGeneration is monotonic from the max seen', () => {
    expect(nextGeneration(0)).toBe(1);
    expect(nextGeneration(null)).toBe(1);
    expect(nextGeneration(undefined)).toBe(1);
    expect(nextGeneration(7)).toBe(8);
  });
});

describe('image readiness never mistakes an outage for "missing"', () => {
  test('provider states map to distinct readiness classes', () => {
    expect(interpretImageReadiness('active')).toBe('ready');
    expect(interpretImageReadiness('building')).toBe('building');
    expect(interpretImageReadiness('missing')).toBe('absent');
    expect(interpretImageReadiness('build_failed')).toBe('failed');
    expect(interpretImageReadiness('unknown')).toBe('indeterminate');
    expect(interpretImageReadiness('removing')).toBe('indeterminate');
  });
});

describe('decideActivation', () => {
  const ok = {
    cancelled: false,
    supersededByNewer: false,
    tipMatches: true,
    runtimeMatches: true,
    imageReadiness: 'ready' as const,
  };

  test('activates only when everything agrees', () => {
    expect(decideActivation(ok)).toBe('activate');
  });

  test('a moved tip or bumped runtime forces a rebuild, never a stale activation', () => {
    expect(decideActivation({ ...ok, tipMatches: false })).toBe('rebuild');
    expect(decideActivation({ ...ok, runtimeMatches: false })).toBe('rebuild');
  });

  test('a newer request supersedes; cancellation short-circuits first', () => {
    expect(decideActivation({ ...ok, supersededByNewer: true })).toBe('supersede');
    expect(decideActivation({ ...ok, cancelled: true, supersededByNewer: true })).toBe('cancelled');
  });

  test('a not-ready or indeterminate image waits — never activates on uncertainty', () => {
    expect(decideActivation({ ...ok, imageReadiness: 'building' })).toBe('wait');
    expect(decideActivation({ ...ok, imageReadiness: 'indeterminate' })).toBe('wait');
    expect(decideActivation({ ...ok, imageReadiness: 'absent' })).toBe('rebuild');
    expect(decideActivation({ ...ok, imageReadiness: 'failed' })).toBe('rebuild');
  });
});

describe('failure classification', () => {
  test('auth / authorization / invalid-build are permanent, not "image missing"', () => {
    for (const m of ['401 Unauthorized', 'HTTP 403 forbidden', 'authentication failed', 'invalid build spec', 'template build failed']) {
      expect(isPermanentTransitionError(new Error(m))).toBe(true);
      expect(isTransientTransitionError(new Error(m))).toBe(false);
    }
  });

  test('network / rate-limit / 5xx are transient', () => {
    for (const m of ['ETIMEDOUT', 'socket hang up', '429 too many requests', 'bad gateway 502', '503 service unavailable', 'ECONNRESET']) {
      expect(isTransientTransitionError(new Error(m))).toBe(true);
      expect(isPermanentTransitionError(new Error(m))).toBe(false);
    }
  });

  test('classifyTransitionFailure: permanent fails now; transient retries then dead-letters', () => {
    expect(classifyTransitionFailure({ err: new Error('403 forbidden'), attempts: 1 }).action).toBe('fail');
    const retry = classifyTransitionFailure({ err: new Error('timeout'), attempts: 1 });
    expect(retry.action).toBe('retry');
    expect(retry.nextDelayMs).toBeGreaterThan(0);
    expect(classifyTransitionFailure({ err: new Error('timeout'), attempts: MAX_TRANSITION_ATTEMPTS }).action).toBe('fail');
  });

  test('backoff is exponential, bounded, and monotonic', () => {
    const a = transitionBackoffMs(1);
    const b = transitionBackoffMs(2);
    const c = transitionBackoffMs(3);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    expect(transitionBackoffMs(100)).toBeLessThanOrEqual(transitionBackoffMs(100, { maxMs: 5 * 60_000 }));
    expect(transitionBackoffMs(100)).toBe(5 * 60_000);
  });
});

describe('switch classification', () => {
  test('clear, no-op, safe-default are immediate; a different provider prepares', () => {
    expect(classifyProviderSwitch({ target: null, effectiveActive: 'daytona', platformDefault: 'daytona' })).toBe('immediate_clear');
    expect(classifyProviderSwitch({ target: 'daytona', effectiveActive: 'daytona', platformDefault: 'daytona' })).toBe('noop');
    expect(classifyProviderSwitch({ target: 'daytona', effectiveActive: 'platinum', platformDefault: 'daytona' })).toBe('immediate_set');
    expect(classifyProviderSwitch({ target: 'platinum', effectiveActive: 'daytona', platformDefault: 'daytona' })).toBe('prepare');
  });

  test('normalizeTargetProvider treats empty as clear', () => {
    expect(normalizeTargetProvider('')).toBeNull();
    expect(normalizeTargetProvider(null)).toBeNull();
    expect(normalizeTargetProvider(undefined)).toBeNull();
    expect(normalizeTargetProvider('platinum')).toBe('platinum');
  });
});

describe('preparation labels', () => {
  test('cover each product state', () => {
    expect(preparationLabel('building', 'platinum', 'daytona')).toBe('Preparing Platinum');
    expect(preparationLabel('ready', 'platinum', 'daytona')).toBe('Platinum image ready');
    expect(preparationLabel('activated', 'platinum', 'daytona')).toBe('Switched to Platinum');
    expect(preparationLabel('failed', 'platinum', 'daytona')).toBe('Preparation failed; remains on Daytona');
  });
});
