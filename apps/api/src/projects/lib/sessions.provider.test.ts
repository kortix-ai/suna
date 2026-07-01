import { test, expect, describe } from 'bun:test';
import { resolveSessionProvider } from './provider-precedence';

// Per-project sandbox-provider override — precedence unit test. Deterministic:
// `allowed` + `isEnabled` are injected (they model config.ALLOWED_SANDBOX_PROVIDERS
// + config.isProviderEnabled), so no env/DB. Precedence under test:
//   explicit request › per-project pin (if enabled) › fallback (weighted balancer).
const ALLOWED = ['daytona', 'platinum'] as const;
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
