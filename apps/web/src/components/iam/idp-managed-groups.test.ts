// SCIM-sourced groups are owned by the IdP: the API 409s renames and
// membership edits (claims match by name; local edits get clobbered by the
// next push), so the UI must not offer those affordances — and must say WHY
// and WHERE to do it instead. Pins the group detail page + groups tab.
//
// Second job since the access unification: pin that BOTH files consume the
// shared access primitives and define no picker / role select / row / grant
// modal of their own.
//
// Third job since the group detail moved INTO the account hub
// (`?tab=groups&group=<id>`): the detail lives in
// `components/iam/group-access-panel.tsx`, and the old standalone route is a
// redirect that keeps bookmarks working.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from '@/i18n/test-source';
import { join } from 'node:path';

const pageSource = readFileSync(join(import.meta.dir, 'group-access-panel.tsx'), 'utf8');
const flatPageSource = pageSource.replace(/\s+/g, ' ');
const tabSource = readFileSync(join(import.meta.dir, 'groups-tab.tsx'), 'utf8');
const legacyRouteSource = readFileSync(
  join(import.meta.dir, '../../app/(app)/accounts/[id]/groups/[groupId]/page.tsx'),
  'utf8',
);

describe('IdP-managed groups — detail panel', () => {
  test('the panel derives idpManaged from the group source and threads it to both cards', () => {
    expect(pageSource).toContain("idpManaged={group.source === 'scim'}");
    expect(pageSource).toContain('const canMutate = canManage && !idpManaged');
  });

  test('membership affordances hide for IdP-managed groups, with copy pointing at the IdP', () => {
    // The "Add members" button and the row kebab both gate on canMutate,
    // not canManage.
    expect(flatPageSource).toContain('canMutate ? ( <Button');
    expect(flatPageSource).toContain("label: tI18nComplete.raw('text035edd9bd720')");
    expect(flatPageSource).toContain('kebab={ canMutate ?');
    expect(flatPageSource).toContain("raw('text58dc708c6651')");
  });

  test('the name field locks with a why + where hint; description stays editable', () => {
    expect(flatPageSource).toContain('updateMutation.isPending || idpManaged');
    expect(flatPageSource).toContain("raw('text51621a0469f5')");
    // Only the NAME input carries the idpManaged lock — one occurrence.
    const locks = pageSource.match(/isPending \|\| idpManaged/g) ?? [];
    expect(locks.length).toBe(1);
  });

  test('deletion stays allowed but warns the next sync recreates the group', () => {
    expect(flatPageSource).toContain("tI18nComplete('text956146906c59'");
    // Both delete confirms — list row and Settings danger zone — are
    // destructive-styled. The Settings one used to fall back to the default.
    expect(flatPageSource).toContain("raw('text3f7374ac08ea')");
    expect(flatPageSource).toContain('confirmVariant="destructive"');
    expect(tabSource).toContain("raw('i18nComplete.text3f7374ac08ea')");
    expect(tabSource).toContain("tHardcodedUi('i18nComplete.text44db009e7d12'");
    expect(tabSource.replace(/\s+/g, ' ')).toContain('confirmVariant="destructive"');
  });

  test('the header badges IdP-synced groups', () => {
    expect(pageSource).toContain('Synced from IdP');
  });
});

describe('IdP-managed groups — groups tab', () => {
  test('scim-sourced rows read "Synced from IdP" instead of a raw enum value', () => {
    expect(tabSource).toContain("g.source === 'scim'");
    expect(tabSource).toContain("tHardcodedUi.raw('i18nComplete.text2d83971aa73e')");
  });
});

describe('groups surface consumes the shared access primitives', () => {
  const SHARED_IMPORT = "from '@/features/workspace/shared/access'";

  test('both files import their list, row and copy from the access barrel', () => {
    expect(tabSource).toContain(SHARED_IMPORT);
    expect(pageSource).toContain(SHARED_IMPORT);
    expect(tabSource).toContain('AccessRow');
    expect(pageSource).toContain('AccessDetailShell');
    expect(pageSource).toContain('AccessDialog');
  });

  test('the RBAC upsell string is the shared const, not a fourth local copy', () => {
    expect(tabSource).toContain('RBAC_UPSELL_MESSAGE');
    expect(tabSource).not.toContain('const RBAC_UPSELL_MESSAGE =');
    expect(pageSource).not.toContain('const RBAC_UPSELL_MESSAGE =');
  });

  test('the deleted bespoke dialogs and pickers are gone', () => {
    for (const dead of [
      'AddGroupMembersDialog',
      'AttachToProjectDialog',
      'CreateAssignmentDialog',
      'SubjectPicker',
      'MEMBER_ROW',
    ]) {
      expect(pageSource).not.toContain(dead);
    }
    // A group's project role is now editable in place (updateProjectGroupGrant
    // via AccessDialog) instead of detach + re-attach.
    expect(pageSource).toContain("label: tI18nComplete.raw('texta514a684676a')");
  });

  test('"Attach to project" is permission-gated like every other mutating control', () => {
    expect(flatPageSource).toContain('canManage ? ( <Button');
    expect(flatPageSource).toContain("raw('textc3f348ffaf7a')");
  });

  test('the group page still keeps CreateGroupDialog local to the tab — it defines a group', () => {
    expect(tabSource).toContain('function CreateGroupDialog');
  });
});

describe('the group detail renders inside the account hub, not on its own route', () => {
  test('the panel is the hub chrome: back "All groups", no tabs', () => {
    // Same shell + breadcrumb pattern as the project access panel, so the
    // left rail never disappears underneath a drill-down.
    expect(flatPageSource).toContain("raw('text1b492be77224')");
    expect(flatPageSource).toContain('onClick: onBack');
    // The three-tab Members / Access / Settings split is gone — the sections
    // stack, and renaming is a modal off the header kebab.
    expect(pageSource).not.toContain('TabsContent');
    expect(pageSource).toContain('Rename group');
    expect(pageSource).toContain('Delete group');
  });

  test('the groups tab owns the selection and hands it back to the hub', () => {
    expect(tabSource).toContain('selectedGroupId');
    expect(tabSource).toContain('onSelectGroup');
    expect(tabSource).toContain('GroupAccessPanel');
    // No route change anywhere in the tab — the hub turns this into
    // `?tab=groups&group=<id>`.
    expect(tabSource).not.toContain('/groups/${');
  });

  test('the old standalone route redirects so bookmarks keep working', () => {
    expect(legacyRouteSource).toContain('router.replace');
    expect(legacyRouteSource.replace(/\s+/g, ' ')).toContain(
      '`/accounts/${accountId}?tab=groups&group=${encodeURIComponent(groupId)}`',
    );
    // Nothing but the redirect survives in that file.
    expect(legacyRouteSource).not.toContain('AccessDetailShell');
  });
});
