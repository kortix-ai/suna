import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

/**
 * The icon save's CACHE INVALIDATION, pinned at the source.
 *
 * A workspace's icon is read from three different cache entries, and until
 * 2026-09-01 the icon mutation wrote back to exactly one of them:
 *
 *   `qk.project.summary(id)`  — the sidebar switcher. WAS updated.
 *   `qk.projects.list(acct)`  — the projects grid + ⌘K. Was NOT.
 *   `qk.project.detail(id)`   — the project-home heading, `useProjectName`,
 *                               `useProjectIcon`. Was NOT.
 *
 * So picking a new icon repainted the sidebar and left the grid, the palette
 * and the project home showing the old one until eviction. That is the SAME
 * bug `invalidateProjectIdentity`'s own doc comment records being fixed for
 * the project NAME (`@kortix/sdk/react/invalidate-project.ts`) — the rename
 * mutation calls it through `renameOnSettled`; the icon mutation never did.
 *
 * Asserted against the source rather than by rendering, matching the sibling
 * `general-tab.rename.test.tsx`: the component needs a QueryClientProvider, a
 * router and an auth session to mount, and none of that would make the
 * assertion stronger than "this exact call is wired".
 */
const source = readFileSync(join(import.meta.dir, 'general-tab.tsx'), 'utf8');
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

// `general-tab.tsx` holds three `useMutation({…})` calls — rename and icon
// inside `GeneralWorkspaceCard`, archive inside `GeneralTab`. Anchor on the
// icon one by name so a match can never come from a sibling.
const iconStart = code.indexOf('const iconMutation = useMutation({');
const iconEnd = iconStart < 0 ? -1 : code.indexOf('});', iconStart);
const iconBlock = iconStart < 0 || iconEnd < 0 ? '' : code.slice(iconStart, iconEnd);

describe('the workspace icon save', () => {
  // Guard the guards: an empty string passes every `.not.toContain` silently,
  // and a scan that stops matching would make this whole file a no-op.
  test('the scan found the icon mutation', () => {
    expect(iconBlock.length).toBeGreaterThan(0);
    expect(iconBlock).toContain('mutationFn:');
    expect(iconBlock).toContain('updateProject(project.project_id, patch)');
  });

  test('writes the fresh project straight into the summary cache', () => {
    // The optimistic half — the sidebar repaints without a round trip.
    expect(iconBlock).toContain('setQueryData(qk.project.summary(project.project_id), updated)');
  });

  test('invalidates the project identity, so the grid and the home title follow', () => {
    // The half that was missing. `invalidateProjectIdentity` reaches BOTH the
    // `qk.projects.scope()` prefix (every list form) and
    // `qk.project.detail(id)` — see its doc comment for why the prefix, and
    // not `qk.projects.list()`, is the one that works.
    expect(iconBlock).toContain('invalidateProjectIdentity(queryClient, project.project_id)');
  });

  test('invalidates on SETTLED, not only on success', () => {
    // A failed icon save still has to re-sync: `onSuccess` alone leaves a
    // rejected write's optimistic neighbours unexamined. Same placement the
    // rename mutation uses.
    const settledStart = iconBlock.indexOf('onSettled:');
    expect(settledStart).toBeGreaterThan(-1);
    expect(iconBlock.slice(settledStart)).toContain('invalidateProjectIdentity');
  });
});
