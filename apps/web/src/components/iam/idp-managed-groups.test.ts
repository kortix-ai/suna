// SCIM-sourced groups are owned by the IdP: the API 409s renames and
// membership edits (claims match by name; local edits get clobbered by the
// next push), so the UI must not offer those affordances — and must say WHY
// and WHERE to do it instead. Pins the group detail page + groups tab.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const pageSource = readFileSync(
  join(import.meta.dir, '../../app/(app)/accounts/[id]/groups/[groupId]/page.tsx'),
  'utf8',
);
const flatPageSource = pageSource.replace(/\s+/g, ' ');
const tabSource = readFileSync(join(import.meta.dir, 'groups-tab.tsx'), 'utf8');

describe('IdP-managed groups — detail page', () => {
  test('the page derives idpManaged from the group source and threads it to both cards', () => {
    expect(pageSource).toContain("idpManaged={group.source === 'scim'}");
    expect(pageSource).toContain('const canMutate = canManage && !idpManaged');
  });

  test('membership affordances hide for IdP-managed groups, with copy pointing at the IdP', () => {
    // Add-members button and per-row remove gate on canMutate, not canManage.
    expect(flatPageSource).toContain('{canMutate ? ( <Button');
    expect(flatPageSource).toContain(
      'Membership is synced from your identity provider — add or remove people there.',
    );
  });

  test('the name field locks with a why + where hint; description stays editable', () => {
    expect(flatPageSource).toContain('updateMutation.isPending || idpManaged');
    expect(flatPageSource).toContain('rename the group there');
    // Only the NAME input carries the idpManaged lock — one occurrence.
    const locks = pageSource.match(/isPending \|\| idpManaged/g) ?? [];
    expect(locks.length).toBe(1);
  });

  test('deletion stays allowed but warns the next sync recreates the group', () => {
    expect(flatPageSource).toContain('the next sync recreates it');
  });

  test('the header badges IdP-synced groups', () => {
    expect(pageSource).toContain('Synced from IdP');
  });
});

describe('IdP-managed groups — groups tab', () => {
  test('scim-sourced rows read "Synced from IdP" instead of a raw enum value', () => {
    expect(tabSource).toContain("g.source === 'scim' ? 'Synced from IdP' : g.source");
  });
});
