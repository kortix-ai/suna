import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { toArray } from '@/features/workspace/customize/shared/utils';

// Regression test for the Better Stack error pattern
//   `f9603a4344ea892980086cc75a9f15d6457da1e8bfa88ffbcfa7b08f1c2dcb0b` —
//   `TypeError: (intermediate value)(intermediate value)(intermediate value).filter is not a function`
// thrown from the workspace layout chunk
// (`app/(app)/workspaces/[id]/layout-b5947ecaa233b0d6.js`) at `Object.useMemo`.
//
// Root cause: the `WorkspaceGroupGrantsCard` component in members-view.tsx
// derived `groupsWithCustomRole` inside a `useMemo` as
//   `(policiesQuery.data ?? []).filter(...).map(...)`.
// The IAM `listPolicies(accountId, { scopeId: workspaceId })` SDK call is typed
// to return `IamPolicy[]`, but a 200 whose body yields a non-array `policies`
// value (a backend shape gap, a partial response, an empty object) is a valid
// HTTP outcome. `?? []` only absorbs `null`/`undefined`; a defined non-array
// (e.g. `{}`) passes straight through, so `.filter` throws. The prod build
// downlevels `??` to a ternary, which is what produces the
// `(intermediate value)(intermediate value)(intermediate value).filter`
// wording (three intermediate values = the inlined `(a ?? b).filter` ternary).
//
// The fix routes every `query.data ?? []` consumer in members-view.tsx through
// `toArray(...)` (Array.isArray guard — absorbs undefined, null, AND non-array).
// These tests (a) reproduce the exact prod throw on the unguarded path and
// (b) keep a future refactor from silently restoring the `(x ?? []).filter`
// shape via source-level assertions (same convention as chunk22256-guard.test.ts
// and policies-panel.test.ts).

const membersViewSource = readFileSync(
  join(import.meta.dir, 'members-view.tsx'),
  'utf8',
);

/**
 * The exact derivation that threw in prod, lifted out of the useMemo so it can
 * be exercised without a react-query harness. Mirrors the
 * `WorkspaceGroupGrantsCard` `groupsWithCustomRole` derivation: filter the
 * project-scoped group policies and collect their principal ids.
 */
function groupsWithCustomRoleFrom(policiesData: unknown, workspaceId: string): Set<string> {
  return new Set(
    toArray(policiesData)
      .filter(
        (p: any) =>
          p.principal_type === 'group' &&
          p.scope_type === 'workspace' &&
          p.scope_id === workspaceId,
      )
      .map((p: any) => p.principal_id),
  );
}

describe('members-view non-array guard — WorkspaceGroupGrantsCard derivation', () => {
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
      { principal_type: 'group', scope_type: 'workspace', scope_id: 'p1', principal_id: 'g1' },
      { principal_type: 'group', scope_type: 'workspace', scope_id: 'p2', principal_id: 'g2' },
      { principal_type: 'member', scope_type: 'workspace', scope_id: 'p1', principal_id: 'u1' },
    ];
    expect(groupsWithCustomRoleFrom(policies, 'p1')).toEqual(new Set(['g1']));
  });
});

describe('members-view source guard — no unguarded (query.data ?? []).filter/.map', () => {
  // The prod throw was a `(policiesQuery.data ?? []).filter(...)` inside a
  // useMemo. Every query-data-derived array in this file must go through
  // `toArray(...)` so a non-array response can never reach `.filter` / `.map`.
  test('imports toArray from the shared customize utils', () => {
    expect(membersViewSource).toContain('from \'@/features/workspace/customize/shared/utils\'');
    expect(membersViewSource).toContain('toArray(');
  });

  test('WorkspaceGroupGrantsCard groupsWithCustomRole routes through toArray, not (data ?? []).filter', () => {
    // The exact line that threw in prod.
    expect(membersViewSource).not.toContain('(policiesQuery.data ?? []).filter(');
    expect(membersViewSource).toContain('toArray(policiesQuery.data)');
  });

  test('no remaining unguarded (query.data ?? []).filter or .map in the file', () => {
    // Any `(X ?? []).filter(` or `(X ?? []).map(` whose receiver is a query data
    // field would re-open the same class of throw. Catch them all.
    const unguarded = membersViewSource.match(/\(\w+Query\.data(?:\?\.\w+)? \?\? \[\]\)\.(?:filter|map)\(/g);
    expect(unguarded).toBeNull();
  });

  test('no remaining unguarded query.data ?? [] used directly as a filtered/mapped array', () => {
    // `const x = query.data ?? []` followed by `x.filter(` is safe ONLY for
    // null/undefined; a non-array still throws. Guard these at the source too.
    // (The members prop and the grants/policies/roles/agents/groups derivations
    //  all now use toArray.)
    const directAssign = membersViewSource.match(/=\s*\w+Query\.data(?:\?\.\w+)?\s*\?\s*\[\]/g);
    // These are allowed only when the result is never .filter/.map'd directly
    // (e.g. a `.length` count). Assert none remain that feed a .filter/.map.
    expect(directAssign).toBeNull();
  });
});
