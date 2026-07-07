/**
 * Per-resource scoping — the pure engine helper (isResourceAccessible) that the
 * authorizeV2 fold and the list-filter both hang off. No DB: locks the exact
 * allow/deny semantics so the SQL/route layers can trust it.
 *
 * Semantics under test (resource-id-level activation):
 *  - a resource with NO grants is OPEN to everyone (unscoped = project-wide);
 *  - a resource WITH grants is closed to all but the granted member/groups;
 *  - group grants match if the user is in ANY of their groups.
 */
import { describe, expect, test } from 'bun:test';
import {
  CREATABLE_RESOURCE_GRANT_TYPES,
  isCreatableResourceType,
  isResourceAccessible,
  isResourceType,
  RESOURCE_GRANT_TYPES,
} from '../iam/resource-grants';

const USER = 'user-1';
const OTHER = 'user-2';

describe('isResourceAccessible — unscoped resources stay project-wide', () => {
  test('undefined grants (resource never scoped) → accessible', () => {
    expect(isResourceAccessible(undefined, USER, [])).toBe(true);
  });
  test('empty grant list → accessible', () => {
    expect(isResourceAccessible([], USER, ['g1'])).toBe(true);
  });
});

describe('isResourceAccessible — scoped resources gate by principal', () => {
  test('member grant → only that user passes', () => {
    const grants = [{ principalType: 'member' as const, principalId: USER }];
    expect(isResourceAccessible(grants, USER, [])).toBe(true);
    expect(isResourceAccessible(grants, OTHER, [])).toBe(false);
    // a different user in some group still can't see a member-only grant
    expect(isResourceAccessible(grants, OTHER, ['g1', 'g2'])).toBe(false);
  });

  test('group grant → any member of that group passes', () => {
    const grants = [{ principalType: 'group' as const, principalId: 'marketing' }];
    expect(isResourceAccessible(grants, USER, ['marketing'])).toBe(true);
    expect(isResourceAccessible(grants, USER, ['eng', 'marketing', 'ops'])).toBe(true);
    expect(isResourceAccessible(grants, USER, ['eng'])).toBe(false);
    expect(isResourceAccessible(grants, USER, [])).toBe(false);
  });

  test('mixed member + group grants → union (either path grants access)', () => {
    const grants = [
      { principalType: 'member' as const, principalId: OTHER },
      { principalType: 'group' as const, principalId: 'marketing' },
    ];
    // USER is not the member, but is in the granted group
    expect(isResourceAccessible(grants, USER, ['marketing'])).toBe(true);
    // OTHER is the granted member directly
    expect(isResourceAccessible(grants, OTHER, [])).toBe(true);
    // a third user in neither → denied
    expect(isResourceAccessible(grants, 'user-3', ['eng'])).toBe(false);
  });

  test('a scoped resource denies an empty-group anonymous-ish member', () => {
    const grants = [{ principalType: 'group' as const, principalId: 'marketing' }];
    expect(isResourceAccessible(grants, USER, [])).toBe(false);
  });
});

describe('resource type guard', () => {
  test('agent, skill + secret remain valid resource types (READ/REVOKE back-compat)', () => {
    // skill/secret stay in the union so pre-existing grant rows of those types
    // still read, list, and revoke — the CREATE restriction is separate (below).
    expect(RESOURCE_GRANT_TYPES).toEqual(['agent', 'skill', 'secret']);
    expect(isResourceType('agent')).toBe(true);
    expect(isResourceType('skill')).toBe(true);
    expect(isResourceType('secret')).toBe(true);
    expect(isResourceType('connector')).toBe(false);
    expect(isResourceType('')).toBe(false);
  });
});

describe('creatable resource type guard — AGENT-ONLY new grants', () => {
  test('only agent is creatable; skill/secret are NOT (governed by editor role + agent inheritance)', () => {
    expect(CREATABLE_RESOURCE_GRANT_TYPES).toEqual(['agent']);
    expect(isCreatableResourceType('agent')).toBe(true);
    // skill/secret are valid to READ but NOT to CREATE a new member-scoped grant.
    expect(isCreatableResourceType('skill')).toBe(false);
    expect(isCreatableResourceType('secret')).toBe(false);
    expect(isCreatableResourceType('connector')).toBe(false);
    expect(isCreatableResourceType('')).toBe(false);
  });

  test('every creatable type is also a readable resource type (subset invariant)', () => {
    for (const t of CREATABLE_RESOURCE_GRANT_TYPES) {
      expect(isResourceType(t)).toBe(true);
    }
  });
});
