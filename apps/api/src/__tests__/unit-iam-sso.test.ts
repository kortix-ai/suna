// Pure unit coverage for SAML SSO sync helpers — no DB.

import { describe, expect, test } from 'bun:test';
import {
  diffSsoGroups,
  extractGroupClaims,
  extractSsoProviderId,
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
