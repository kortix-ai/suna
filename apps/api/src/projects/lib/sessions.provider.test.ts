import { test, expect, describe } from 'bun:test';
import {
  nextFailoverProvider,
  resolveSessionProvider,
  sessionProviderIsLocked,
} from './provider-precedence';

// Per-project sandbox-provider override — precedence unit test. Deterministic:
// `allowed` + `isEnabled` are injected (they model config.ALLOWED_SANDBOX_PROVIDERS
// + config.isProviderEnabled), so no env/DB. Precedence under test:
//   explicit request › per-project pin (if enabled) › fallback (weighted balancer).
const ALLOWED = ['daytona', 'platinum', 'e2b'] as const;
const bothEnabled = (_p: string) => true;

describe('resolveSessionProvider (per-project provider override)', () => {
  test('explicit request wins over the pin + is used verbatim', () => {
    expect(
      resolveSessionProvider({ requested: 'platinum', projectPin: 'daytona', allowed: ALLOWED, isEnabled: bothEnabled }),
    ).toEqual({ provider: 'platinum' });
  });

  test('explicit request not in ALLOWED → badRequest (becomes 400 upstream)', () => {
    expect(
      resolveSessionProvider({ requested: 'gcp', projectPin: null, allowed: ALLOWED, isEnabled: bothEnabled }),
    ).toEqual({ badRequest: 'gcp' });
  });

  test('per-project pin is used when set + enabled + no explicit request', () => {
    expect(
      resolveSessionProvider({ requested: null, projectPin: 'platinum', allowed: ALLOWED, isEnabled: bothEnabled }),
    ).toEqual({ provider: 'platinum' });
  });

  test('pin BYPASSES distribution weights — the gate is enabled(allowed+key), NOT weight', () => {
    // platinum allowed+enabled but (hypothetically) weight-0 in the distribution;
    // the pin still wins. The helper never consults weights — that is the feature.
    expect(
      resolveSessionProvider({
        requested: null,
        projectPin: 'platinum',
        allowed: ALLOWED,
        isEnabled: (p) => p === 'daytona' || p === 'platinum',
      }),
    ).toEqual({ provider: 'platinum' });
  });

  test('stale pin (provider since removed from ALLOWED) is ignored → fallback', () => {
    expect(
      resolveSessionProvider({ requested: null, projectPin: 'platinum', allowed: ['daytona'], isEnabled: (p) => p === 'daytona' }),
    ).toEqual({ fallback: true });
  });

  test('pin allowed but keyless (isEnabled=false) → fallback, never a hard create failure', () => {
    expect(
      resolveSessionProvider({ requested: null, projectPin: 'platinum', allowed: ALLOWED, isEnabled: (p) => p === 'daytona' }),
    ).toEqual({ fallback: true });
  });

  test('no request + no pin → fallback (weighted balancer runs)', () => {
    expect(
      resolveSessionProvider({ requested: null, projectPin: null, allowed: ALLOWED, isEnabled: bothEnabled }),
    ).toEqual({ fallback: true });
  });
});

// ── Provider failover reachability ──────────────────────────────────────────
// Regression guard for the 2026-08-26 incident: `provider_fallback` was ON in
// production, yet 654 sessions died on a provider at capacity and NOT ONE
// handed off. Cause: createProjectSession passed the weighted balancer's pick
// down as `provider`, and the provisioner read any provider as "explicitly
// selected", making its failover branch dead code for every project session.
describe('sessionProviderIsLocked', () => {
  test('an explicit request locks the provider — never override the caller', () => {
    expect(
      sessionProviderIsLocked(
        resolveSessionProvider({ requested: 'platinum', projectPin: null, allowed: ALLOWED, isEnabled: bothEnabled }),
      ),
    ).toBe(true);
  });

  test('an enabled per-project pin locks the provider', () => {
    expect(
      sessionProviderIsLocked(
        resolveSessionProvider({ requested: null, projectPin: 'platinum', allowed: ALLOWED, isEnabled: bothEnabled }),
      ),
    ).toBe(true);
  });

  test('the weighted balancer pick is NOT locked — failover must stay reachable', () => {
    expect(
      sessionProviderIsLocked(
        resolveSessionProvider({ requested: null, projectPin: null, allowed: ALLOWED, isEnabled: bothEnabled }),
      ),
    ).toBe(false);
  });

  test('a stale/disabled pin degrades to the balancer, so it does NOT lock', () => {
    expect(
      sessionProviderIsLocked(
        resolveSessionProvider({
          requested: null,
          projectPin: 'e2b',
          allowed: ALLOWED,
          isEnabled: (p) => p !== 'e2b',
        }),
      ),
    ).toBe(false);
  });
});

describe('nextFailoverProvider', () => {
  const base = {
    providerLocked: false,
    fallbackAttempted: false,
    fallbackEnabled: true,
    current: 'platinum',
    allowed: ['platinum', 'daytona'] as const,
  };

  test('an unlocked balancer pick hands off to the other allowed provider', () => {
    expect(nextFailoverProvider(base)).toBe('daytona');
  });

  test('a locked provider never fails over', () => {
    expect(nextFailoverProvider({ ...base, providerLocked: true })).toBeNull();
  });

  test('failover is one shot per session', () => {
    expect(nextFailoverProvider({ ...base, fallbackAttempted: true })).toBeNull();
  });

  test('the admin gate being OFF disables failover', () => {
    expect(nextFailoverProvider({ ...base, fallbackEnabled: false })).toBeNull();
  });

  test('a single allowed provider has nowhere to go', () => {
    expect(nextFailoverProvider({ ...base, allowed: ['platinum'] })).toBeNull();
  });
});
