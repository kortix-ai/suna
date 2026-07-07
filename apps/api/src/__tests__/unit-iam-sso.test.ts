// Pure unit coverage for SAML SSO sync helpers — no DB.

import { describe, expect, test } from 'bun:test';
import {
  diffSsoGroups,
  extractGroupClaims,
  extractSsoProviderId,
  resolveClaimedGroupIds,
} from '../iam/sso-sync';

describe('extractSsoProviderId', () => {
  test('reads sso_provider_id from app_metadata', () => {
    expect(
      extractSsoProviderId({ app_metadata: { sso_provider_id: 'aaa' } }),
    ).toBe('aaa');
  });

  test('falls back to provider_id (older Supabase)', () => {
    expect(
      extractSsoProviderId({ app_metadata: { provider_id: 'bbb' } }),
    ).toBe('bbb');
  });

  test('reads the real Supabase shape: app_metadata.provider = "sso:<uuid>"', () => {
    expect(
      extractSsoProviderId({
        app_metadata: {
          provider: 'sso:464651b7-6157-46b1-afaa-5bbd7fa37599',
          providers: ['sso:464651b7-6157-46b1-afaa-5bbd7fa37599'],
        },
      }),
    ).toBe('464651b7-6157-46b1-afaa-5bbd7fa37599');
  });

  test('reads the id out of the providers[] array when provider is absent', () => {
    expect(
      extractSsoProviderId({ app_metadata: { providers: ['sso:abc-123'] } }),
    ).toBe('abc-123');
  });

  test('prefers an explicit sso_provider_id over the provider tag', () => {
    expect(
      extractSsoProviderId({
        app_metadata: { sso_provider_id: 'explicit', provider: 'sso:tagged' },
      }),
    ).toBe('explicit');
  });

  test('non-SSO providers resolve to null', () => {
    expect(
      extractSsoProviderId({ app_metadata: { provider: 'email', providers: ['email'] } }),
    ).toBeNull();
    expect(extractSsoProviderId({ app_metadata: { provider: 'google' } })).toBeNull();
  });

  test('an empty "sso:" tag resolves to null', () => {
    expect(extractSsoProviderId({ app_metadata: { provider: 'sso:' } })).toBeNull();
    expect(extractSsoProviderId({ app_metadata: { provider: 'sso:   ' } })).toBeNull();
  });

  test('returns null when missing', () => {
    expect(extractSsoProviderId({})).toBeNull();
    expect(extractSsoProviderId(undefined)).toBeNull();
    expect(extractSsoProviderId({ app_metadata: {} })).toBeNull();
  });

  test('rejects non-string values', () => {
    expect(
      extractSsoProviderId({ app_metadata: { sso_provider_id: 123 } }),
    ).toBeNull();
  });
});

describe('extractGroupClaims', () => {
  test('reads array claim from app_metadata', () => {
    const out = extractGroupClaims(
      { app_metadata: { groups: ['Engineers', 'Admins'] } },
      'groups',
    );
    expect(out).toEqual(['Engineers', 'Admins']);
  });

  test('reads the real Supabase SSO location: user_metadata.custom_claims.groups', () => {
    expect(
      extractGroupClaims(
        { user_metadata: { custom_claims: { groups: ['Everyone', 'Managers'] } } },
        'groups',
      ),
    ).toEqual(['Everyone', 'Managers']);
  });

  test('reads string claim and wraps as array', () => {
    expect(
      extractGroupClaims({ app_metadata: { groups: 'Engineers' } }, 'groups'),
    ).toEqual(['Engineers']);
  });

  test('falls back to user_metadata then top level', () => {
    expect(
      extractGroupClaims({ user_metadata: { roles: ['admin'] } }, 'roles'),
    ).toEqual(['admin']);
    expect(extractGroupClaims({ memberOf: ['x'] }, 'memberOf')).toEqual(['x']);
  });

  test('returns empty when claim missing', () => {
    expect(extractGroupClaims({}, 'groups')).toEqual([]);
    expect(extractGroupClaims(undefined, 'groups')).toEqual([]);
  });

  test('skips non-string entries inside an array', () => {
    expect(
      extractGroupClaims({ app_metadata: { groups: ['a', 1, null, 'b'] } }, 'groups'),
    ).toEqual(['a', 'b']);
  });
});

describe('resolveClaimedGroupIds — Entra-tolerant claim→group matching', () => {
  const mappings = [
    { claimValue: 'Marketing', groupId: 'g-mkt' },
    { claimValue: 'Engineering', groupId: 'g-eng' },
    { claimValue: '11111111-2222-3333-4444-555555555555', groupId: 'g-guid' },
  ];

  test('exact match resolves the group id', () => {
    expect([...resolveClaimedGroupIds(['Marketing'], mappings)]).toEqual(['g-mkt']);
  });

  test('CASE-insensitive: Azure display-name casing mismatch still matches', () => {
    // Entra sends "MARKETING"; admin typed "Marketing" in the mapping.
    expect([...resolveClaimedGroupIds(['MARKETING', 'engineering'], mappings)].sort()).toEqual([
      'g-eng',
      'g-mkt',
    ]);
  });

  test('whitespace-insensitive on both sides', () => {
    expect([...resolveClaimedGroupIds(['  Marketing  '], mappings)]).toEqual(['g-mkt']);
  });

  test('GUID object-id claims (Entra default) match regardless of case', () => {
    expect([...resolveClaimedGroupIds(['11111111-2222-3333-4444-555555555555'.toUpperCase()], mappings)]).toEqual([
      'g-guid',
    ]);
  });

  test('unmapped claim values are ignored (no group)', () => {
    expect([...resolveClaimedGroupIds(['Finance', 'Sales'], mappings)]).toEqual([]);
  });

  test('empty claims resolve to nothing', () => {
    expect(resolveClaimedGroupIds([], mappings).size).toBe(0);
  });

  test('de-dupes when two claim values map to the same group', () => {
    const dup = [
      { claimValue: 'A', groupId: 'g' },
      { claimValue: 'B', groupId: 'g' },
    ];
    expect([...resolveClaimedGroupIds(['a', 'b'], dup)]).toEqual(['g']);
  });
});

describe('diffSsoGroups', () => {
  test('adds claimed groups not currently joined', () => {
    const { toAdd, toRemove } = diffSsoGroups({
      currentGroupIds: new Set(),
      mappedGroupIds: new Set(['g1', 'g2']),
      claimedGroupIds: new Set(['g1']),
    });
    expect(toAdd).toEqual(['g1']);
    expect(toRemove).toEqual([]);
  });

  test('removes joined-via-SSO groups whose claim disappeared', () => {
    const { toAdd, toRemove } = diffSsoGroups({
      currentGroupIds: new Set(['g1', 'g2']),
      mappedGroupIds: new Set(['g1', 'g2']),
      claimedGroupIds: new Set(['g1']),
    });
    expect(toAdd).toEqual([]);
    expect(toRemove).toEqual(['g2']);
  });

  test('preserves manually-added groups (not in mapped set)', () => {
    const { toAdd, toRemove } = diffSsoGroups({
      currentGroupIds: new Set(['manual', 'g1']),
      mappedGroupIds: new Set(['g1']),
      claimedGroupIds: new Set(),
    });
    expect(toAdd).toEqual([]);
    expect(toRemove).toEqual(['g1']);
  });

  test('no-op when claims match current SSO membership', () => {
    const { toAdd, toRemove } = diffSsoGroups({
      currentGroupIds: new Set(['g1', 'g2']),
      mappedGroupIds: new Set(['g1', 'g2', 'g3']),
      claimedGroupIds: new Set(['g1', 'g2']),
    });
    expect(toAdd).toEqual([]);
    expect(toRemove).toEqual([]);
  });
});
