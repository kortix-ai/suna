import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
// `members-tab.tsx`; see that file's header comment.
//
// **`ProjectGroupGrantsCard` and its `groupsWithCustomRole` derivation are
// gone.** Both it and `ProjectRoleAssignmentsCard` were removed outright,
// not just fixed — they duplicated proper account-level homes (a group's own
// "Projects" tab, the account Roles page's `PolicyAssignments`) and were
// never a resource concern the project's Access tab should own. The exact
// `policiesQuery.data` derivation this file used to reproduce no longer
// exists anywhere in `members-tab.tsx`, so the reproduction tests below it
// were removed with it — they tested a synthetic copy of logic that has no
// real counterpart left to protect. What remains is the general hygiene
// guard: this file's own history proves the `(query.data ?? []).filter`
// shape is a recurring mistake, worth catching for ANY query in this file,
// present or future, not just the one that actually threw.
//
// These tests keep a future refactor from silently reintroducing the
// `(x ?? []).filter` shape via source-level assertions (same convention as
// chunk22256-guard.test.ts and policies-panel.test.ts).

const membersTabSource = readFileSync(join(import.meta.dir, 'members-tab.tsx'), 'utf8');

describe('members-tab source guard — no unguarded (query.data ?? []).filter/.map', () => {
  // The prod throw was a `(policiesQuery.data ?? []).filter(...)` inside a
  // useMemo. Every query-data-derived array in this file must go through
  // `toArray(...)` so a non-array response can never reach `.filter` / `.map`.
  test('imports toArray from the shared customize utils', () => {
    expect(membersTabSource).toContain("from '@/features/workspace/customize/shared/utils'");
    expect(membersTabSource).toContain('toArray(');
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
