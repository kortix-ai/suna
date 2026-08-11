// The Overrides card is a merge-patch form: it sends ONLY the keys the
// operator changed, because `PUT /admin/api/accounts/{id}/overrides` leaves an
// absent key exactly as it was. Get the diff wrong and the card either wipes an
// override nobody touched or silently drops an expiry — both invisible in the
// UI and both billing-affecting. This file is the whole diff contract.
import { describe, expect, test } from 'bun:test';
import {
  MAX_COMPUTE_RATE_MULTIPLIER,
  MAX_CONCURRENT_SESSIONS_OVERRIDE,
  describeOverridePatch,
  draftFromOverrides,
  isOverrideExpired,
  overrideExpiresAt,
  overridesPatch,
  type OverridesDraft,
} from './overrides-form';

const EMPTY: OverridesDraft = {
  sso: 'inherit',
  scim: 'inherit',
  rbac: 'inherit',
  auditAccess: 'inherit',
  managedModels: 'inherit',
  maxConcurrentSessions: '',
  computeRateMultiplier: '',
};

describe('draftFromOverrides', () => {
  test('an account with no overrides inherits every row', () => {
    expect(draftFromOverrides(null)).toEqual(EMPTY);
    expect(draftFromOverrides({})).toEqual(EMPTY);
    expect(draftFromOverrides(undefined)).toEqual(EMPTY);
  });

  test('a stored boolean becomes force-on / force-off', () => {
    const draft = draftFromOverrides({ sso: { value: true }, managedModels: { value: false } });
    expect(draft.sso).toBe('on');
    expect(draft.managedModels).toBe('off');
    expect(draft.scim).toBe('inherit');
  });

  test('a stored number becomes the input string', () => {
    const draft = draftFromOverrides({
      maxConcurrentSessions: { value: 12 },
      computeRateMultiplier: { value: 0.5 },
    });
    expect(draft.maxConcurrentSessions).toBe('12');
    expect(draft.computeRateMultiplier).toBe('0.5');
  });

  test('an expired entry still shows its value — expiry is the server’s job, not the form’s', () => {
    // The row projection does NOT apply expiry: an operator must see what is on
    // the account, including a grant that has lapsed, or they cannot clean it up.
    const draft = draftFromOverrides({
      sso: { value: true, expires_at: '2020-01-01T00:00:00.000Z' },
    });
    expect(draft.sso).toBe('on');
  });

  test('a malformed entry reads as inherit and never as a value', () => {
    // JSONB written by migrations and operator SQL: a wrong-typed value must
    // degrade to "no override", exactly like the server-side parser does.
    const draft = draftFromOverrides({
      sso: { value: 'yes' },
      scim: { value: 1 },
      maxConcurrentSessions: { value: true },
      rbac: null as never,
    });
    expect(draft.sso).toBe('inherit');
    expect(draft.scim).toBe('inherit');
    expect(draft.maxConcurrentSessions).toBe('');
    expect(draft.rbac).toBe('inherit');
  });
});

describe('overrideExpiresAt', () => {
  test('reports a parseable expiry and ignores everything else', () => {
    const stored = {
      sso: { value: true, expires_at: '2026-09-01T00:00:00.000Z' },
      scim: { value: true },
      rbac: { value: true, expires_at: 'whenever' },
    };
    expect(overrideExpiresAt(stored, 'sso')).toBe('2026-09-01T00:00:00.000Z');
    expect(overrideExpiresAt(stored, 'scim')).toBeNull();
    expect(overrideExpiresAt(stored, 'rbac')).toBeNull();
    expect(overrideExpiresAt(null, 'sso')).toBeNull();
  });
});

describe('overridesPatch — only what changed', () => {
  test('an untouched form sends nothing', () => {
    const stored = { sso: { value: true }, computeRateMultiplier: { value: 0.5 } };
    const result = overridesPatch(draftFromOverrides(stored), stored);
    expect(result).toEqual({ ok: true, patch: {} });
  });

  test('a malformed stored entry is not a change — Save stays disabled on open', () => {
    const stored = { sso: { value: 'yes' } } as never;
    expect(overridesPatch(draftFromOverrides(stored), stored)).toEqual({ ok: true, patch: {} });
  });

  test('setting a boolean sends one entry, not the whole map', () => {
    const stored = { sso: { value: true } };
    const result = overridesPatch({ ...draftFromOverrides(stored), managedModels: 'off' }, stored);
    expect(result).toEqual({ ok: true, patch: { managedModels: { value: false } } });
  });

  test('clearing a boolean row sends null, which deletes the key', () => {
    const stored = { sso: { value: true } };
    const result = overridesPatch({ ...EMPTY }, stored);
    expect(result).toEqual({ ok: true, patch: { sso: null } });
  });

  test('a number row sends its value, and an emptied one sends null', () => {
    expect(overridesPatch({ ...EMPTY, computeRateMultiplier: '0.5' }, {})).toEqual({
      ok: true,
      patch: { computeRateMultiplier: { value: 0.5 } },
    });
    expect(overridesPatch({ ...EMPTY }, { computeRateMultiplier: { value: 0.5 } })).toEqual({
      ok: true,
      patch: { computeRateMultiplier: null },
    });
  });

  test('0 is a real multiplier — free compute, not "empty"', () => {
    expect(overridesPatch({ ...EMPTY, computeRateMultiplier: '0' }, {})).toEqual({
      ok: true,
      patch: { computeRateMultiplier: { value: 0 } },
    });
  });

  test('re-typing the same number is not a change, so the expiry survives', () => {
    // The patch carries no `expires_at`, so ANY entry it sends makes the grant
    // permanent. Not sending an unchanged row is what keeps a timed grant timed.
    const stored = { computeRateMultiplier: { value: 0.5, expires_at: '2026-09-01T00:00:00.000Z' } };
    const result = overridesPatch({ ...EMPTY, computeRateMultiplier: '0.50' }, stored);
    expect(result).toEqual({ ok: true, patch: {} });
  });

  test('several rows at once ride one patch', () => {
    const stored = { sso: { value: true } };
    const result = overridesPatch(
      { ...EMPTY, managedModels: 'off', computeRateMultiplier: '0.5' },
      stored,
    );
    expect(result).toEqual({
      ok: true,
      patch: {
        sso: null,
        managedModels: { value: false },
        computeRateMultiplier: { value: 0.5 },
      },
    });
  });
});

describe('overridesPatch — the ranges the server enforces', () => {
  test('rejects a non-numeric entry before it becomes a 400', () => {
    const result = overridesPatch({ ...EMPTY, computeRateMultiplier: 'half' }, {});
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('Compute rate multiplier');
  });

  test('compute rate multiplier is clamped to [0, 10] by validation, not by silence', () => {
    expect(overridesPatch({ ...EMPTY, computeRateMultiplier: '-1' }, {}).ok).toBe(false);
    expect(
      overridesPatch(
        { ...EMPTY, computeRateMultiplier: String(MAX_COMPUTE_RATE_MULTIPLIER + 0.5) },
        {},
      ).ok,
    ).toBe(false);
    expect(
      overridesPatch({ ...EMPTY, computeRateMultiplier: String(MAX_COMPUTE_RATE_MULTIPLIER) }, {})
        .ok,
    ).toBe(true);
  });

  test('max concurrent sessions is an integer from 1 to the server ceiling', () => {
    expect(overridesPatch({ ...EMPTY, maxConcurrentSessions: '0' }, {}).ok).toBe(false);
    expect(overridesPatch({ ...EMPTY, maxConcurrentSessions: '1.5' }, {}).ok).toBe(false);
    expect(
      overridesPatch(
        { ...EMPTY, maxConcurrentSessions: String(MAX_CONCURRENT_SESSIONS_OVERRIDE + 1) },
        {},
      ).ok,
    ).toBe(false);
    expect(overridesPatch({ ...EMPTY, maxConcurrentSessions: '12' }, {})).toEqual({
      ok: true,
      patch: { maxConcurrentSessions: { value: 12 } },
    });
  });

  test('the ceilings match the server constants they mirror', () => {
    expect(MAX_CONCURRENT_SESSIONS_OVERRIDE).toBe(100_000);
    expect(MAX_COMPUTE_RATE_MULTIPLIER).toBe(10);
  });
});

describe('isOverrideExpired', () => {
  const now = Date.parse('2026-08-11T12:00:00.000Z');

  test('a lapsed grant is expired, a future one is not, and none never is', () => {
    expect(isOverrideExpired('2026-08-11T11:59:59.000Z', now)).toBe(true);
    expect(isOverrideExpired('2026-08-11T12:00:00.000Z', now)).toBe(true);
    expect(isOverrideExpired('2026-09-01T00:00:00.000Z', now)).toBe(false);
    expect(isOverrideExpired(null, now)).toBe(false);
  });
});

describe('describeOverridePatch', () => {
  test('counts what was set and what was cleared', () => {
    expect(describeOverridePatch({ sso: { value: true } })).toBe('1 override set.');
    expect(describeOverridePatch({ sso: null, scim: null })).toBe('2 overrides cleared.');
    expect(
      describeOverridePatch({ sso: { value: true }, scim: { value: false }, rbac: null }),
    ).toBe('2 overrides set, 1 override cleared.');
    expect(describeOverridePatch({})).toBe('No change.');
  });
});
