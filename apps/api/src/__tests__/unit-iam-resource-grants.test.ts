/**
 * The object rule — `objectUsable` in `iam/authorize.ts`, the ONE place that
 * decides what "nobody scoped this" means — plus the two type guards that decide
 * which object kinds a grant may name at all.
 *
 * No DB in the cases below: `objectUsable` only reads `object_policies` for the
 * unscoped branch at MEMBER tier, and every case here either has grant rows or
 * asks at manager tier. The unscoped defaults themselves are pinned against the
 * seed by integration-iam-role-catalog-parity and exercised end to end by
 * integration-resource-grants.
 *
 * Semantics under test (object-id-level activation):
 *  - an object WITH grants is closed to all but the named members/groups,
 *    identically for both tiers;
 *  - group grants match if the user is in ANY of their groups;
 *  - an object with NO grants is open at manager tier, whatever its type.
 *
 * The principal vocabulary is the canonical one: `user` and `group`. The legacy
 * `member` spelling survives only in the compatibility view's column.
 */
import { describe, expect, test } from 'bun:test';
import { objectUsable } from '../iam/authorize';
import {
  CREATABLE_RESOURCE_GRANT_TYPES,
  isCreatableResourceType,
  isResourceType,
  RESOURCE_GRANT_TYPES,
} from '../iam/resource-grants';

const USER = crypto.randomUUID();
const OTHER = crypto.randomUUID();

describe('objectUsable — a scoped object gates by principal', () => {
  test('user grant → only that user passes, at either tier', async () => {
    const grants = [{ principalType: 'user', principalId: USER }];
    expect(await objectUsable('agent', grants, USER, [], false)).toBe(true);
    expect(await objectUsable('agent', grants, OTHER, [], false)).toBe(false);
    // a different user in some group still cannot reach a user-only grant
    expect(await objectUsable('agent', grants, OTHER, ['g1', 'g2'], false)).toBe(false);
    // …and a MANAGER is not exempt from an explicit grant either
    expect(await objectUsable('agent', grants, OTHER, [], true)).toBe(false);
  });

  test('group grant → any member of that group passes', async () => {
    const grants = [{ principalType: 'group', principalId: 'marketing' }];
    expect(await objectUsable('agent', grants, USER, ['marketing'], false)).toBe(true);
    expect(await objectUsable('agent', grants, USER, ['eng', 'marketing', 'ops'], false)).toBe(true);
    expect(await objectUsable('agent', grants, USER, ['eng'], false)).toBe(false);
    expect(await objectUsable('agent', grants, USER, [], false)).toBe(false);
  });

  test('mixed user + group grants → union (either path grants access)', async () => {
    const grants = [
      { principalType: 'user', principalId: OTHER },
      { principalType: 'group', principalId: 'marketing' },
    ];
    expect(await objectUsable('agent', grants, USER, ['marketing'], false)).toBe(true);
    expect(await objectUsable('agent', grants, OTHER, [], false)).toBe(true);
    expect(await objectUsable('agent', grants, crypto.randomUUID(), ['eng'], false)).toBe(false);
  });
});

describe('objectUsable — an unscoped object at manager tier', () => {
  test('no grant rows → open, whatever the object type', async () => {
    expect(await objectUsable('agent', undefined, USER, [], true)).toBe(true);
    expect(await objectUsable('agent', [], USER, ['g1'], true)).toBe(true);
    expect(await objectUsable('skill', undefined, USER, [], true)).toBe(true);
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
