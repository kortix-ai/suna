import { describe, expect, test } from 'bun:test';

// entitlement-overrides.ts parses credit_accounts.entitlement_overrides — a
// JSONB column written by admin routes, data migrations, and operator SQL.
// Everything it reads is therefore untrusted, and the contract is: a malformed
// shape yields "no override" and NEVER throws, because the readers are
// entitlement gates on the request path.
//
// No mocks: the module is pure by construction (no I/O, no clock of its own).

import {
  type EntitlementOverrides,
  OVERRIDE_KEYS,
  mergeOverridePatch,
  parseEntitlementOverrides,
  readOverride,
  toStoredOverrides,
  validateOverridePatch,
} from '../billing/services/entitlement-overrides';

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const HOUR = 3_600_000;
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

describe('readOverride', () => {
  test('returns the value of a well-formed entry', () => {
    expect(readOverride({ sso: { value: true } }, 'sso', NOW)).toBe(true);
    expect(readOverride({ sso: { value: false } }, 'sso', NOW)).toBe(false);
    expect(readOverride({ managedModels: { value: false } }, 'managedModels', NOW)).toBe(false);
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
      managedModels: { value: false },
    });
    expect(parsed).toEqual({
      sso: { value: true, expires_at: iso(-HOUR) },
      managedModels: { value: false },
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
        // Removed keys (2026-10-15): stored rows may still carry them.
        demoEnterprise: { value: true },
        enterpriseEntitled: { value: true },
        computeRateMultiplier: { value: 0 },
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
  const current = { sso: { value: true }, managedModels: { value: false } };

  test('sets, replaces, and leaves absent keys alone', () => {
    expect(mergeOverridePatch(current, { scim: { value: true } })).toEqual({
      sso: { value: true },
      managedModels: { value: false },
      scim: { value: true },
    });
    expect(mergeOverridePatch(current, { sso: { value: false } }).sso).toEqual({ value: false });
  });

  test('null deletes the key (RFC 7386 merge-patch)', () => {
    expect(mergeOverridePatch(current, { sso: null })).toEqual({
      managedModels: { value: false },
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

describe('toStoredOverrides', () => {
  test('drops absent keys and keeps the rest verbatim', () => {
    const overrides: EntitlementOverrides = {
      sso: { value: true, expires_at: iso(HOUR) },
      scim: undefined,
    };
    expect(toStoredOverrides(overrides)).toEqual({ sso: { value: true, expires_at: iso(HOUR) } });
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
    expect(ok({ sso: { value: true }, managedModels: { value: false } })).toEqual({
      sso: { value: true },
      managedModels: { value: false },
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

  test('rejects removed keys as unknown', () => {
    for (const key of ['maxConcurrentSessions', 'demoEnterprise', 'enterpriseEntitled', 'computeRateMultiplier']) {
      expect(err({ [key]: { value: true } })).toMatch(new RegExp(`unknown override key "${key}"`));
    }
  });

  test('rejects a wrong-typed value', () => {
    expect(err({ sso: { value: 1 } })).toMatch(/"sso.value" must be a boolean/);
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
      ['auditAccess', 'branding', 'managedModels', 'rbac', 'scim', 'sso'].sort(),
    );
  });
});
