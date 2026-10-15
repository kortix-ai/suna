// The Overrides card is a merge-patch form: it sends ONLY the keys the
// operator changed, because `PUT /admin/api/accounts/{id}/overrides` leaves an
// absent key exactly as it was. Get the diff wrong and the card either wipes an
// override nobody touched or silently drops an expiry — both invisible in the
// UI and both billing-affecting. This file is the whole diff contract.
import { describe, expect, test } from 'bun:test';
import {
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
  branding: 'inherit',
  managedModels: 'inherit',
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
      rbac: null as never,
    });
    expect(draft.sso).toBe('inherit');
    expect(draft.scim).toBe('inherit');
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
    const stored = {
      sso: { value: true },
      scim: { value: false, expires_at: '2026-09-01T00:00:00.000Z' },
    };
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

  test('re-sending an unchanged row is a no-op, so its expiry survives', () => {
    // The patch carries no `expires_at`, so ANY entry it sends makes the grant
    // permanent. Not sending an unchanged row is what keeps a timed grant timed.
    const stored = { sso: { value: true, expires_at: '2026-09-01T00:00:00.000Z' } };
    expect(overridesPatch({ ...EMPTY, sso: 'on' }, stored)).toEqual({ ok: true, patch: {} });
  });

  test('several rows at once ride one patch', () => {
    const stored = { sso: { value: true } };
    const result = overridesPatch({ ...EMPTY, managedModels: 'off' }, stored);
    expect(result).toEqual({
      ok: true,
      patch: {
        sso: null,
        managedModels: { value: false },
      },
    });
  });
});

describe('override keys', () => {
  test('the draft has exactly the six live keys, none numeric', () => {
    expect(Object.keys(EMPTY).sort()).toEqual(
      ['auditAccess', 'branding', 'managedModels', 'rbac', 'scim', 'sso'].sort(),
    );
    expect(Object.keys(draftFromOverrides({ retiredKey: { value: 2 } })).sort()).toEqual(
      Object.keys(EMPTY).sort(),
    );
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
