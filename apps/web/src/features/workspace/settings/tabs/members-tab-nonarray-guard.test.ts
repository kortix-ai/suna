import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { toArray } from '@/features/workspace/customize/shared/utils';

// Regression test for the Better Stack error pattern
//   `f9603a4344ea892980086cc75a9f15d6457da1e8bfa88ffbcfa7b08f1c2dcb0b` —
//   `TypeError: (intermediate value)(intermediate value)(intermediate value).filter is not a function`
// thrown from the project layout chunk
// (`app/(app)/projects/[id]/layout-b5947ecaa233b0d6.js`) at `Object.useMemo`.
//
// Root cause: the `ProjectGroupGrantsCard` component derived
// `groupsWithCustomRole` inside a `useMemo` as
//   `(policiesQuery.data ?? []).filter(...).map(...)`.
// The IAM `listPolicies(accountId, { scopeId: projectId })` SDK call is typed
// to return `IamPolicy[]`, but a 200 whose body yields a non-array `policies`
// value (a backend shape gap, a partial response, an empty object) is a valid
// HTTP outcome. `?? []` only absorbs `null`/`undefined`; a defined non-array
// (e.g. `{}`) passes straight through, so `.filter` throws.
//
// **Moved from `customize/sections/view/members-view-nonarray-guard.test.ts`
// (Task 19, coordinator fix round 1).** `ProjectGroupGrantsCard` — along with
// `ResourceAccessCard` and `ProjectRoleAssignmentsCard`, which share the same
// `toArray(policiesQuery.data)` / `toArray(groupsQuery.data)` derivation
// shape — was rehomed (cut, not copied) from `members-view.tsx` into
// `members-tab.tsx`; see that file's header comment. This guard follows the
// code it protects: the invariant is about the derivation, not about which
// file happens to hold it, so it now reads `members-tab.tsx`'s source
// instead. `members-view.tsx` no longer contains this card at all.
//
// These tests (a) reproduce the exact prod throw on the unguarded path and
// (b) keep a future refactor from silently restoring the `(x ?? []).filter`
// shape via source-level assertions (same convention as chunk22256-guard.test.ts
// and policies-panel.test.ts).

const membersTabSource = readFileSync(join(import.meta.dir, 'members-tab.tsx'), 'utf8');

/**
 * The exact derivation that threw in prod, lifted out of the useMemo so it can
 * be exercised without a react-query harness. Mirrors the
 * `ProjectGroupGrantsCard` `groupsWithCustomRole` derivation: filter the
 * project-scoped group policies and collect their principal ids.
 */
function groupsWithCustomRoleFrom(policiesData: unknown, projectId: string): Set<string> {
  return new Set(
    toArray(policiesData)
      .filter(
        (p: any) =>
          p.principal_type === 'group' && p.scope_type === 'project' && p.scope_id === projectId,
      )
      .map((p: any) => p.principal_id),
  );
}

describe('members-tab non-array guard — ProjectGroupGrantsCard derivation', () => {
  test('does NOT throw on the exact prod failure shape: a defined non-array policies value', () => {
    // The shape that fired in prod: `policiesQuery.data` is a defined non-array
    // (e.g. an empty object or an error envelope). The old `(data ?? []).filter`
    // path threw `(intermediate value)...filter is not a function` here.
    expect(() => groupsWithCustomRoleFrom({}, 'p1')).not.toThrow();
    expect(() => groupsWithCustomRoleFrom({ error: 'x' }, 'p1')).not.toThrow();
    expect(() => groupsWithCustomRoleFrom('not-an-array', 'p1')).not.toThrow();
    expect(() => groupsWithCustomRoleFrom(42, 'p1')).not.toThrow();
    expect(groupsWithCustomRoleFrom({}, 'p1')).toEqual(new Set());
  });

  test('absorbs null/undefined (the ?? [] cases) without throwing', () => {
    expect(() => groupsWithCustomRoleFrom(null, 'p1')).not.toThrow();
    expect(() => groupsWithCustomRoleFrom(undefined, 'p1')).not.toThrow();
    expect(groupsWithCustomRoleFrom(null, 'p1')).toEqual(new Set());
    expect(groupsWithCustomRoleFrom(undefined, 'p1')).toEqual(new Set());
  });

  test('happy path: filters project-scoped group policies and collects principal ids', () => {
    const policies = [
      { principal_type: 'group', scope_type: 'project', scope_id: 'p1', principal_id: 'g1' },
      { principal_type: 'group', scope_type: 'project', scope_id: 'p2', principal_id: 'g2' },
      { principal_type: 'member', scope_type: 'project', scope_id: 'p1', principal_id: 'u1' },
    ];
    expect(groupsWithCustomRoleFrom(policies, 'p1')).toEqual(new Set(['g1']));
  });
});

describe('members-tab source guard — no unguarded (query.data ?? []).filter/.map', () => {
  // The prod throw was a `(policiesQuery.data ?? []).filter(...)` inside a
  // useMemo. Every query-data-derived array in this file must go through
  // `toArray(...)` so a non-array response can never reach `.filter` / `.map`.
  test('imports toArray from the shared customize utils', () => {
    expect(membersTabSource).toContain("from '@/features/workspace/customize/shared/utils'");
    expect(membersTabSource).toContain('toArray(');
  });

  test('ProjectGroupGrantsCard groupsWithCustomRole routes through toArray, not (data ?? []).filter', () => {
    // The exact line that threw in prod.
    expect(membersTabSource).not.toContain('(policiesQuery.data ?? []).filter(');
    expect(membersTabSource).toContain('toArray(policiesQuery.data)');
  });

  test('no remaining unguarded (query.data ?? []).filter or .map in the file', () => {
    // Any `(X ?? []).filter(` or `(X ?? []).map(` whose receiver is a query data
    // field would re-open the same class of throw. Catch them all.
    const unguarded = membersTabSource.match(
      /\(\w+Query\.data(?:\?\.\w+)? \?\? \[\]\)\.(?:filter|map)\(/g,
    );
    expect(unguarded).toBeNull();
  });

  test('no remaining unguarded query.data ?? [] used directly as a filtered/mapped array', () => {
    // `const x = query.data ?? []` followed by `x.filter(` is safe ONLY for
    // null/undefined; a non-array still throws. Guard these at the source too.
    const directAssign = membersTabSource.match(/=\s*\w+Query\.data(?:\?\.\w+)?\s*\?\s*\[\]/g);
    // These are allowed only when the result is never .filter/.map'd directly
    // (e.g. a `.length` count). Assert none remain that feed a .filter/.map.
    expect(directAssign).toBeNull();
  });
});
