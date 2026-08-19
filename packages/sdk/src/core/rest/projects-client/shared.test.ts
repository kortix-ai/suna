import { describe, expect, test } from 'bun:test';

import type { ProjectRole } from './shared';

// Owner decision 2026-08-18: the built-in `editor` project role is removed.
// Two project roles remain — `member` (read + run) and `manager` (everything).
// Existing `editor` assignments become `manager`.
//
// This is a compile-time contract, so the assertions below are typed, not just
// asserted: `EXTRA_ROLES` is `never` only while the union is exactly
// manager|member. Widening the union again (or re-adding `editor`) makes
// `noExtraRoles` a `false`-typed value initialised with `true`, which fails
// `pnpm --filter @kortix/sdk typecheck`.

type ExtraRoles = Exclude<ProjectRole, 'manager' | 'member'>;
const noExtraRoles: [ExtraRoles] extends [never] ? true : false = true;

type MissingRoles = Exclude<'manager' | 'member', ProjectRole>;
const noMissingRoles: [MissingRoles] extends [never] ? true : false = true;

const ALL_PROJECT_ROLES: ProjectRole[] = ['manager', 'member'];

describe('ProjectRole', () => {
  test('is exactly manager | member — `editor` is removed', () => {
    expect(noExtraRoles).toBe(true);
    expect(noMissingRoles).toBe(true);
    expect(ALL_PROJECT_ROLES).toEqual(['manager', 'member']);
  });
});
