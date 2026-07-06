import { test, expect, describe } from 'bun:test';
import { resolveSessionProvider } from './provider-precedence';

// Mirrors config.normalizeProviderName (legacy 'daytona' → canonical 'managed').
// Inlined so this stays a zero-dep pure test — importing config.ts would drag in
// zod + full env validation and break the "no env/DB" isolation this file relies on.
const norm = (p: string | null) => (p === 'daytona' ? 'managed' : p);

// Per-project sandbox-provider override — precedence unit test. Deterministic:
// `allowed` + `isEnabled` are injected (they model config.ALLOWED_SANDBOX_PROVIDERS
// + config.isProviderEnabled), so no env/DB. Precedence under test:
//   explicit request › per-project pin (if enabled) › fallback (weighted balancer).
// Post-rename ALLOWED holds the canonical 'managed' (legacy 'daytona' → 'managed').
const ALLOWED = ['managed', 'platinum'] as const;
const bothEnabled = (_p: string) => true;

describe('resolveSessionProvider (per-project provider override)', () => {
  test('explicit request wins over the pin + is used verbatim', () => {
    expect(
      resolveSessionProvider({ requested: 'platinum', projectPin: 'managed', allowed: ALLOWED, isEnabled: bothEnabled }),
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

// Provider rename back-compat (regression for the missed session-create call site
// from PR #4201). createProjectSession runs body.provider / the project pin through
// normalizeProviderName() BEFORE resolveSessionProvider — so the legacy 'daytona'
// alias resolves to canonical 'managed' against ALLOWED=['managed','platinum']
// instead of 400 "Unknown or disabled sandbox provider: daytona".
describe('legacy daytona→managed normalization at session-create', () => {
  test("explicit provider:'daytona' → managed (no longer a 400)", () => {
    expect(
      resolveSessionProvider({ requested: norm('daytona'), projectPin: null, allowed: ALLOWED, isEnabled: bothEnabled }),
    ).toEqual({ provider: 'managed' });
  });

  test("explicit provider:'managed' → managed (canonical unaffected)", () => {
    expect(
      resolveSessionProvider({ requested: norm('managed'), projectPin: null, allowed: ALLOWED, isEnabled: bothEnabled }),
    ).toEqual({ provider: 'managed' });
  });

  test("explicit provider:'platinum' → platinum (other provider unaffected)", () => {
    expect(
      resolveSessionProvider({ requested: norm('platinum'), projectPin: null, allowed: ALLOWED, isEnabled: bothEnabled }),
    ).toEqual({ provider: 'platinum' });
  });

  test("legacy 'daytona' project pin → managed (used when enabled)", () => {
    expect(
      resolveSessionProvider({ requested: null, projectPin: norm('daytona'), allowed: ALLOWED, isEnabled: bothEnabled }),
    ).toEqual({ provider: 'managed' });
  });

  test('no request + no pin still falls through unaffected', () => {
    expect(
      resolveSessionProvider({ requested: norm(null), projectPin: norm(null), allowed: ALLOWED, isEnabled: bothEnabled }),
    ).toEqual({ fallback: true });
  });
});
