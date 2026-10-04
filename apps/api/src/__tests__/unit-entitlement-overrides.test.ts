import { describe, expect, test } from 'bun:test';

// entitlement-overrides.ts parses credit_accounts.entitlement_overrides — a
// JSONB column written by admin routes, data migrations, and operator SQL.
// Everything it reads is therefore untrusted, and the contract is: a malformed
// shape yields "no override" and NEVER throws, because the readers are
// entitlement gates on the request path.
//
// No mocks: the module is pure by construction (no I/O, no clock of its own).

import {
  DEFAULT_COMPUTE_RATE_MULTIPLIER,
  type EntitlementOverrides,
  MAX_COMPUTE_RATE_MULTIPLIER,
  OVERRIDE_KEYS,
  clampComputeRateMultiplier,
  legacyMirrorPatch,
  mergeOverridePatch,
  parseEntitlementOverrides,
  readOverride,
  toStoredOverrides,
  validateOverridePatch,
  withoutOverrideKeys,
} from '../billing/services/entitlement-overrides';

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const HOUR = 3_600_000;
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

describe('readOverride', () => {
  test('returns the value of a well-formed entry', () => {
    expect(readOverride({ sso: { value: true } }, 'sso', NOW)).toBe(true);
    expect(readOverride({ sso: { value: false } }, 'sso', NOW)).toBe(false);
    expect(readOverride({ computeRateMultiplier: { value: 0.5 } }, 'computeRateMultiplier', NOW)).toBe(
      0.5,
    );
  });

  test('an unexpired entry applies; an expired one does not', () => {
    const live = { rbac: { value: true, expires_at: iso(HOUR) } };
    const dead = { rbac: { value: true, expires_at: iso(-1) } };
    expect(readOverride(live, 'rbac', NOW)).toBe(true);
    expect(readOverride(dead, 'rbac', NOW)).toBeUndefined();
  });

  test('expiry is exclusive at the boundary — expires_at == now is over', () => {
    const entry = { scim: { value: true, expires_at: iso(0) } };
    expect(readOverride(entry, 'scim', NOW - 1)).toBe(true);
    expect(readOverride(entry, 'scim', NOW)).toBeUndefined();
  });

  test('an unparseable expires_at fails CLOSED, not open', () => {
    expect(readOverride({ sso: { value: true, expires_at: 'whenever' } }, 'sso', NOW)).toBeUndefined();
    expect(readOverride({ sso: { value: true, expires_at: 12345 } }, 'sso', NOW)).toBeUndefined();
  });

  test('a missing key reads as no override', () => {
    expect(readOverride({}, 'sso', NOW)).toBeUndefined();
    expect(readOverride({ scim: { value: true } }, 'sso', NOW)).toBeUndefined();
  });

  test('wrong value type per key yields undefined, never a coerced value', () => {
    expect(readOverride({ sso: { value: 1 } }, 'sso', NOW)).toBeUndefined();
    expect(readOverride({ sso: { value: 'true' } }, 'sso', NOW)).toBeUndefined();
    expect(
      readOverride({ computeRateMultiplier: { value: true } }, 'computeRateMultiplier', NOW),
    ).toBeUndefined();
    expect(
      readOverride({ computeRateMultiplier: { value: Number.NaN } }, 'computeRateMultiplier', NOW),
    ).toBeUndefined();
  });

  test('every malformed container shape yields undefined without throwing', () => {
    for (const raw of [null, undefined, 'x', 42, [], [{ sso: { value: true } }]]) {
      expect(readOverride(raw, 'sso', NOW)).toBeUndefined();
    }
    for (const entry of [null, 'true', 7, [], { novalue: 1 }]) {
      expect(readOverride({ sso: entry }, 'sso', NOW)).toBeUndefined();
    }
  });

  test('expires_at: null means "never expires", like an absent key', () => {
    expect(readOverride({ sso: { value: true, expires_at: null } }, 'sso', NOW)).toBe(true);
  });
});

describe('parseEntitlementOverrides', () => {
  test('keeps well-formed entries with their expiry, expired or not', () => {
    const parsed = parseEntitlementOverrides({
      sso: { value: true, expires_at: iso(-HOUR) },
      computeRateMultiplier: { value: 5 },
    });
    expect(parsed).toEqual({
      sso: { value: true, expires_at: iso(-HOUR) },
      computeRateMultiplier: { value: 5 },
    });
  });

  test('drops unknown keys and malformed entries', () => {
    expect(
      parseEntitlementOverrides({
        sso: { value: true },
        notAKey: { value: true },
        scim: 'yes',
        rbac: { value: 3 },
        maxConcurrentSessions: { value: 5 },
      }),
    ).toEqual({ sso: { value: true } });
  });

  test('a non-object column reads as no overrides', () => {
    for (const raw of [null, undefined, 'x', 7, []]) {
      expect(parseEntitlementOverrides(raw)).toEqual({});
    }
  });
});

describe('mergeOverridePatch', () => {
  const current = { sso: { value: true }, computeRateMultiplier: { value: 0.5 } };

  test('sets, replaces, and leaves absent keys alone', () => {
    expect(mergeOverridePatch(current, { scim: { value: true } })).toEqual({
      sso: { value: true },
      computeRateMultiplier: { value: 0.5 },
      scim: { value: true },
    });
    expect(mergeOverridePatch(current, { sso: { value: false } }).sso).toEqual({ value: false });
  });

  test('null deletes the key (RFC 7386 merge-patch)', () => {
    expect(mergeOverridePatch(current, { sso: null })).toEqual({
      computeRateMultiplier: { value: 0.5 },
    });
  });

  test('deleting a key that is not there is a no-op, not an error', () => {
    expect(mergeOverridePatch({}, { sso: null })).toEqual({});
  });

  test('does not mutate its input', () => {
    const before = JSON.parse(JSON.stringify(current));
    mergeOverridePatch(current, { sso: null, scim: { value: true } });
    expect(current).toEqual(before);
  });
});

describe('withoutOverrideKeys', () => {
  test('drops exactly the named keys', () => {
    const current = {
      sso: { value: true },
      computeRateMultiplier: { value: 0.5 },
      scim: { value: true },
    };
    expect(withoutOverrideKeys(current, ['sso', 'scim'])).toEqual({
      computeRateMultiplier: { value: 0.5 },
    });
  });
});

describe('toStoredOverrides', () => {
  test('drops absent keys and keeps the rest verbatim', () => {
    const overrides: EntitlementOverrides = {
      sso: { value: true, expires_at: iso(HOUR) },
      scim: undefined,
    };
    expect(toStoredOverrides(overrides)).toEqual({ sso: { value: true, expires_at: iso(HOUR) } });
  });
});

describe('clampComputeRateMultiplier', () => {
  test('passes an in-range multiplier through, including 0 (free compute)', () => {
    expect(clampComputeRateMultiplier(0)).toBe(0);
    expect(clampComputeRateMultiplier(0.5)).toBe(0.5);
    expect(clampComputeRateMultiplier(MAX_COMPUTE_RATE_MULTIPLIER)).toBe(MAX_COMPUTE_RATE_MULTIPLIER);
  });

  test('clamps out-of-range values into [0, 10]', () => {
    expect(clampComputeRateMultiplier(-3)).toBe(0);
    expect(clampComputeRateMultiplier(1000)).toBe(MAX_COMPUTE_RATE_MULTIPLIER);
  });

  test('anything absent or non-finite bills at list price, never at zero', () => {
    for (const value of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(clampComputeRateMultiplier(value as never)).toBe(DEFAULT_COMPUTE_RATE_MULTIPLIER);
    }
  });
});

describe('legacyMirrorPatch', () => {
  test('a PERMANENT entry mirrors its value onto the legacy column', () => {
    expect(legacyMirrorPatch({ enterpriseEntitled: { value: true } })).toEqual({
      enterpriseEntitled: true,
    });
    expect(legacyMirrorPatch({ managedModelsOverride: { value: false } })).toEqual({
      managedModelsOverride: false,
    });
  });

  // The trap this rule exists for: the resolver falls back to the legacy column
  // when the JSONB entry no longer applies, so mirroring a TIMED grant would
  // make it permanent the instant it expired.
  test('a TIMED entry clears the column instead of mirroring, so the expiry stands', () => {
    expect(legacyMirrorPatch({ enterpriseEntitled: { value: true, expires_at: iso(HOUR) } })).toEqual(
      { enterpriseEntitled: false },
    );
    expect(
      legacyMirrorPatch({ managedModelsOverride: { value: true, expires_at: iso(HOUR) } }),
    ).toEqual({ managedModelsOverride: null });
  });

  test('a deletion clears the column to its no-override value', () => {
    expect(legacyMirrorPatch({ demoEnterprise: null })).toEqual({ demoEnterprise: false });
    expect(legacyMirrorPatch({ managedModelsOverride: null })).toEqual({
      managedModelsOverride: null,
    });
  });

  test('keys the patch does not mention are not written at all', () => {
    expect(legacyMirrorPatch({ sso: { value: true } })).toEqual({});
    expect(legacyMirrorPatch({})).toEqual({});
  });
});

describe('validateOverridePatch', () => {
  const ok = (raw: unknown) => {
    const r = validateOverridePatch(raw);
    if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
    return r.patch;
  };
  const err = (raw: unknown) => {
    const r = validateOverridePatch(raw);
    if (r.ok) throw new Error('expected a validation error');
    return r.error;
  };

  test('accepts every known key with the right value type', () => {
    expect(ok({ sso: { value: true }, computeRateMultiplier: { value: 0 } })).toEqual({
      sso: { value: true },
      computeRateMultiplier: { value: 0 },
    });
  });

  test('accepts null (delete) and an ISO expiry', () => {
    expect(ok({ sso: null })).toEqual({ sso: null });
    expect(ok({ sso: { value: true, expires_at: iso(HOUR) } })).toEqual({
      sso: { value: true, expires_at: iso(HOUR) },
    });
  });

  test('rejects an unknown key rather than silently dropping it', () => {
    expect(err({ superAdmin: { value: true } })).toMatch(/unknown override key "superAdmin"/);
  });

  test('rejects the removed maxConcurrentSessions key as unknown', () => {
    expect(err({ maxConcurrentSessions: { value: 5 } })).toMatch(
      /unknown override key "maxConcurrentSessions"/,
    );
  });

  test('rejects a wrong-typed value', () => {
    expect(err({ sso: { value: 1 } })).toMatch(/"sso.value" must be a boolean/);
    expect(err({ computeRateMultiplier: { value: true } })).toMatch(/must be a finite number/);
  });

  test('rejects out-of-range numbers at both ends', () => {
    expect(err({ computeRateMultiplier: { value: -1 } })).toMatch(/from 0 to 10/);
    expect(err({ computeRateMultiplier: { value: 10.5 } })).toMatch(/from 0 to 10/);
  });

  test('rejects a malformed expires_at and a non-object body', () => {
    expect(err({ sso: { value: true, expires_at: 'soon' } })).toMatch(/ISO-8601/);
    expect(err('nope')).toMatch(/must be a JSON object/);
    expect(err(null)).toMatch(/must be a JSON object/);
  });

  test('an empty patch is valid and changes nothing', () => {
    expect(ok({})).toEqual({});
  });
});

describe('invariants', () => {
  test('OVERRIDE_KEYS is the complete, de-duplicated key set', () => {
    expect(new Set(OVERRIDE_KEYS).size).toBe(OVERRIDE_KEYS.length);
    expect([...OVERRIDE_KEYS].sort() as string[]).toEqual(
      [
        'auditAccess',
        'branding',
        'computeRateMultiplier',
        'demoEnterprise',
        'enterpriseEntitled',
        'managedModels',
        'managedModelsOverride',
        'rbac',
        'scim',
        'sso',
      ].sort(),
    );
  });
});
