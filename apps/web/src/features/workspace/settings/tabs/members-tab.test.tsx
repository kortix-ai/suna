import type { PendingProjectInvite, ProjectAccessMember, ProjectAccessRequest } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { MembersTabView } from './members-tab';

const pendingInvite = (o: Partial<PendingProjectInvite>): PendingProjectInvite => ({
  invite_id: 'inv1',
  email: 'pending@kortix.com',
  project_role: 'member',
  expires_at: null,
  invited_by_email: null,
  created_at: '2026-01-01T00:00:00Z',
  invite_expires_at: '2026-02-01T00:00:00Z',
  invite_expired: false,
  ...o,
});

const accessRequest = (o: Partial<ProjectAccessRequest>): ProjectAccessRequest => ({
  request_id: 'req1',
  account_id: 'acc1',
  project_id: 'proj1',
  requester_user_id: 'u9',
  requester_email: 'requester@kortix.com',
  message: null,
  status: 'pending',
  reviewed_by: null,
  reviewed_at: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  ...o,
});

/**
 * `MembersTabView` is the pure, props-only half — see this tab's header
 * comment. `inviteDialogSlot` is the one slot (the invite composer owns its
 * own `useMutation`, can't render under `renderToStaticMarkup` with no
 * `QueryClientProvider` — same reasoning `general-tab.tsx`'s
 * `generalFieldsSlot` documents). Every mutation's real network round trip,
 * Select interaction, and dialog open state need a live network and a real
 * DOM — untestable here by the task's hard constraint (no
 * `@testing-library/react`, no jsdom/happy-dom). These tests pin table
 * shape, column presence, per-row gating, and the pending invites / access
 * requests sections below the table.
 */
const member = (o: Partial<ProjectAccessMember>): ProjectAccessMember => ({
  user_id: 'u1',
  email: 'a@b.c',
  account_role: 'member',
  project_role: null,
  effective_project_role: null,
  has_implicit_access: false,
  effective_source: null,
  group_sources: [],
  joined_at: '',
  granted_by: null,
  granted_at: null,
  updated_at: null,
  ...o,
});

describe('MembersTabView', () => {
  test('renders the header title and description', () => {
    const out = renderToStaticMarkup(<MembersTabView />);
    expect(out).toContain('Members');
    expect(out).toContain('Who can reach this workspace, and what each person can do.');
  });

  /**
   * The pane is a routed Customize page, so its chrome is the shell every
   * sibling tab renders — Connectors, Agents, Skills, Triggers, Models,
   * Secrets, Channels. This is a RENDERED assertion, not a source grep,
   * because what it guards is what the browser gets: the shell is the page's
   * scroll container AND its `py-10 lg:py-14` gap below the tab bar. The
   * `(capabilities)` layout supplies neither, so the bare
   * `mx-auto w-full max-w-4xl` column this pane used to bring left the
   * "Members" heading pressed flush against the tab bar with no way to
   * scroll — the exact bug a screenshot caught on 2026-08-17.
   */
  test('the pane is the shared capability shell, not its own column', () => {
    const out = renderToStaticMarkup(<MembersTabView />);
    expect(out).toContain('max-w-5xl');
    expect(out).toContain('overflow-y-auto');
    expect(out).toContain('py-10');
    expect(out).not.toContain('max-w-4xl');
  });

  test('renders the permissions help slot in the header action', () => {
    const out = renderToStaticMarkup(
      <MembersTabView permissionsHelpSlot={<div>help-marker</div>} />,
    );
    expect(out).toContain('help-marker');
  });

  test('renders one row per member, with an Account column and a This-project column, scope-labelled', () => {
    // Was "Account role" / "Project role" — two labels for "the same kind of
    // thing" that read as equally scoped on a page that lives entirely
    // inside ONE project. Scope leads now ("Account" / "This project"), with
    // a muted second line spelling out what changing it actually reaches —
    // the confusion a live screenshot called out directly: "nobody will know
    // what is an account role, what is a project role... this is in the
    // project settings."
    const out = renderToStaticMarkup(
      <MembersTabView
        members={[
          member({ user_id: 'u1', email: 'owner@kortix.com', account_role: 'owner' }),
          member({ user_id: 'u2', email: 'viewer@kortix.com', account_role: 'member' }),
        ]}
      />,
    );
    expect(out).toContain('Account');
    expect(out).toContain('every workspace');
    expect(out).toContain('This project');
    expect(out).toContain('only here');
    expect(out).toContain('owner@kortix.com');
    expect(out).toContain('viewer@kortix.com');
    expect(out.match(/<tr/g)?.length).toBe(3); // 1 header row + 2 member rows
  });

  // ── Table shape. This pane and Secrets are the settings panel's only two
  // tables, and they must be the same object. These pin that, since nothing
  // else would catch a drift back to the borderless local container this pane
  // carried for a day (2026-08-11 → 2026-08-12). ──

  test('the table is the shared bordered `Table`, the same one Secrets uses', () => {
    const out = renderToStaticMarkup(
      <MembersTabView members={[member({ user_id: 'u1', email: 'a@kortix.com' })]} />,
    );
    // `@/components/ui/table`'s `Table` stamps this on its bordered card. A
    // local `<table>` container does not.
    expect(out).toContain('data-slot="table-container"');
    expect(out).toContain('data-slot="table-head"');
    expect(out).toContain('data-slot="table-cell"');
  });

  test('nothing cancels the primitive — no borderless-era overrides survive', () => {
    const out = renderToStaticMarkup(
      <MembersTabView members={[member({ user_id: 'u1', email: 'a@kortix.com' })]} />,
    );
    // Scoped to the table subtree on purpose: `bg-transparent` also lives in
    // `TabsTrigger`'s and `Input`'s own base classes, so asserting on the whole
    // document would fail on markup that has nothing to do with this table.
    const table = out.slice(out.indexOf('data-slot="table-container"'));
    // Body rows keep their hairline divider — `border-b-0` was the override
    // that removed it.
    expect(table).not.toContain('border-b-0');
    // The header keeps its fill. `TableHeader`'s `bg-accent` and a re-added
    // `bg-transparent` are the same tailwind-merge conflict group, so this
    // assertion fails the moment one is cancelled by the other.
    expect(table).toContain('bg-accent');
    // …and body rows keep the hover highlight.
    const body = table.slice(table.indexOf('data-slot="table-body"'));
    expect(body).toContain('hover:bg-popover-foreground/5');
  });

  test('a Joined column renders the join date as right-aligned tabular-nums', () => {
    const out = renderToStaticMarkup(
      <MembersTabView members={[member({ user_id: 'u1', joined_at: '2026-01-15T00:00:00Z' })]} />,
    );
    expect(out).toContain('Joined');
    expect(out).toContain('tabular-nums');
    expect(out).toContain('text-right');
  });

  test('a member with no join date reads as an em dash, not "Never"', () => {
    const out = renderToStaticMarkup(<MembersTabView members={[member({ joined_at: '' })]} />);
    expect(out).not.toContain('Never');
  });

  test('the read-only account role is coloured text, not a filled badge', () => {
    const out = renderToStaticMarkup(
      <MembersTabView members={[member({ user_id: 'u1', account_role: 'owner' })]} />,
    );
    expect(out).toContain('owner');
    expect(out).not.toContain('data-slot="badge"');
  });

  test('the Invite control is a labelled primary button on the People tab', () => {
    const out = renderToStaticMarkup(<MembersTabView canManageMembers members={[member({})]} />);
    // Jay's reference shot: one primary Invite button on the right of the
    // table toolbar, with a real label — not the icon-only `+` it used to be
    // in the pane header.
    expect(out).toContain('>Invite<');
    expect(out).not.toContain('aria-label="Invite"');
  });

  test('the member count renders beside the People tab label once there are members', () => {
    const withMembers = renderToStaticMarkup(
      <MembersTabView
        members={[member({ user_id: 'u1' }), member({ user_id: 'u2', email: 'b@kortix.com' })]}
      />,
    );
    expect(withMembers).toContain('>2<');

    // No count while the table is empty — a bare "0" beside the label reads as
    // a broken widget, and the empty state already says there is nobody.
    const empty = renderToStaticMarkup(<MembersTabView members={[]} />);
    expect(empty).not.toContain('>0<');
  });

  // ── The three underline tabs (2026-08-12). Nine stacked sections became
  // People / Invites / Access on the shared `TabsList type="underline"`
  // primitive. Radix renders ONLY the active panel — an inactive
  // `TabsContent` is an empty `<div hidden>` under `renderToStaticMarkup` —
  // so every assertion about a non-default tab passes `section` explicitly. ──

  test('renders exactly three underline tabs: People, Invites, Access', () => {
    const out = renderToStaticMarkup(<MembersTabView members={[member({})]} />);
    expect(out).toContain('role="tablist"');
    // The shared primitive's underline chrome, not a hand-rolled bar.
    expect(out).toContain('**:data-[slot=tabs-trigger]:data-[state=active]:after:bg-foreground');
    expect(out.match(/role="tab"/g)?.length).toBe(3);
    expect(out).toContain('>People<');
    expect(out).toContain('>Invites<');
    expect(out).toContain('>Access<');
  });

  test('People is the default tab — the table is what you land on', () => {
    const out = renderToStaticMarkup(<MembersTabView members={[member({})]} />);
    expect(out).toContain('<table');
    expect(out).toContain('This project');
  });

  test('the pane heading stays above the tab bar, outside every panel', () => {
    const out = renderToStaticMarkup(<MembersTabView members={[member({})]} />);
    expect(out.indexOf('Members')).toBeLessThan(out.indexOf('role="tablist"'));
  });

  test('the Invites tab counts everyone waiting across both lists', () => {
    const out = renderToStaticMarkup(
      <MembersTabView
        members={[member({})]}
        accountId="acc1"
        pendingInvites={[pendingInvite({})]}
        accessRequests={[accessRequest({})]}
      />,
    );
    expect(out).toContain('>2<');
  });

  // ── The People tab's client-side search. It filters `userLabel(member)` —
  // the email the table already renders — and is a controlled prop, so the
  // view stays hook-free. No route, no invented field. ──

  test('the search field filters the table by email, client-side', () => {
    const out = renderToStaticMarkup(
      <MembersTabView
        members={[
          member({ user_id: 'u1', email: 'ada@kortix.com' }),
          member({ user_id: 'u2', email: 'grace@kortix.com' }),
        ]}
        memberSearch="ada"
      />,
    );
    expect(out).toContain('ada@kortix.com');
    expect(out).not.toContain('grace@kortix.com');
    // The tab count stays the roster total, not the filtered total.
    expect(out).toContain('>2<');
  });

  test('a search matching nobody shows an empty state, not a headerless table', () => {
    const out = renderToStaticMarkup(
      <MembersTabView members={[member({ email: 'ada@kortix.com' })]} memberSearch="zzz" />,
    );
    expect(out).toContain('No one matches that search');
    expect(out).not.toContain('<table');
  });

  test('no search field until there is a roster to search', () => {
    const empty = renderToStaticMarkup(<MembersTabView members={[]} />);
    expect(empty).not.toContain('aria-label="Search members"');

    const withMembers = renderToStaticMarkup(<MembersTabView members={[member({})]} />);
    expect(withMembers).toContain('aria-label="Search members"');
  });

  test('the workspace-access control shares the workspace-access column — no trailing actions column', () => {
    const out = renderToStaticMarkup(
      <MembersTabView
        members={[
          member({
            project_role: 'editor',
            effective_project_role: 'editor',
            effective_source: 'direct',
          }),
        ]}
        canManageMembers
      />,
    );
    // Four columns: Member, Account, This project, Joined. The
    // character class keeps `<thead` out of the count.
    expect(out.match(/<th[ >]/g)?.length).toBe(4);
    expect(out).toContain('role="combobox"');
  });

  test('a group-sourced grant shows memberAccessLabel\'s "via <group>" annotation', () => {
    const out = renderToStaticMarkup(
      <MembersTabView
        members={[
          member({
            email: 'grouped@kortix.com',
            effective_project_role: 'editor',
            effective_source: 'group',
            group_sources: [{ group_id: 'g1', group_name: 'Engineering', role: 'editor' }],
          }),
        ]}
      />,
    );
    expect(out).toContain('Editor');
    expect(out).toContain('via Engineering');
  });

  test('an account member with no project access reads as an em dash, not a hidden row', () => {
    const out = renderToStaticMarkup(
      <MembersTabView members={[member({ email: 'none@kortix.com' })]} />,
    );
    expect(out).toContain('none@kortix.com');
    expect(out).toContain('—');
  });

  test('no role select or remove control when canManageMembers is false', () => {
    const out = renderToStaticMarkup(
      <MembersTabView
        members={[
          member({
            project_role: 'editor',
            effective_project_role: 'editor',
            effective_source: 'direct',
          }),
        ]}
        canManageMembers={false}
      />,
    );
    expect(out).not.toContain('role="combobox"');
  });

  test('a role select renders for a directly-granted member when canManageMembers is true', () => {
    const out = renderToStaticMarkup(
      <MembersTabView
        members={[
          member({
            project_role: 'editor',
            effective_project_role: 'editor',
            effective_source: 'direct',
          }),
        ]}
        canManageMembers
      />,
    );
    expect(out).toContain('role="combobox"');
  });

  test('implicit (account admin) access has no editable control, even when canManageMembers is true', () => {
    const out = renderToStaticMarkup(
      <MembersTabView
        members={[
          member({
            account_role: 'admin',
            effective_project_role: 'manager',
            effective_source: 'implicit',
            has_implicit_access: true,
          }),
        ]}
        canManageMembers
      />,
    );
    expect(out).not.toContain('role="combobox"');
  });

  test('group-inherited access has no editable control on this table, even when canManageMembers is true', () => {
    const out = renderToStaticMarkup(
      <MembersTabView
        members={[
          member({
            effective_project_role: 'editor',
            effective_source: 'group',
            group_sources: [{ group_id: 'g1', group_name: 'Engineering', role: 'editor' }],
          }),
        ]}
        canManageMembers
      />,
    );
    expect(out).not.toContain('role="combobox"');
  });

  test('the Invite button only renders when canManageMembers is true', () => {
    const withPerm = renderToStaticMarkup(
      <MembersTabView canManageMembers members={[member({})]} />,
    );
    const withoutPerm = renderToStaticMarkup(
      <MembersTabView canManageMembers={false} members={[member({})]} />,
    );
    expect(withPerm).toContain('Invite');
    expect(withoutPerm).not.toContain('>Invite<');
  });

  test('renders the invite dialog slot', () => {
    const out = renderToStaticMarkup(
      <MembersTabView inviteDialogSlot={<div>invite-dialog-marker</div>} />,
    );
    expect(out).toContain('invite-dialog-marker');
  });

  test('the Access tab holds the resource-access slot', () => {
    // Only one slot now — group role assignment and custom-role binding were
    // removed outright (not rehomed, not hidden): both duplicated a proper
    // account-level home that already existed (a group's own "Projects" tab,
    // the account Roles page's PolicyAssignments). See members-tab.tsx's
    // header comment.
    const out = renderToStaticMarkup(
      <MembersTabView
        section="access"
        members={[member({})]}
        resourceAccessSlot={<div>resource-access-marker</div>}
      />,
    );
    expect(out).toContain('resource-access-marker');
  });

  test('the access slot is NOT on the People tab — the table stands alone there', () => {
    const out = renderToStaticMarkup(
      <MembersTabView
        members={[member({})]}
        resourceAccessSlot={<div>resource-access-marker</div>}
      />,
    );
    expect(out).toContain('<table');
    expect(out).not.toContain('resource-access-marker');
  });

  test('an Access tab with no slots shows an empty state, not a blank panel', () => {
    const out = renderToStaticMarkup(<MembersTabView section="access" members={[member({})]} />);
    expect(out).toContain('No extra access rules');
    expect(out).not.toContain('group-grants-marker');
  });

  test('renders a loading skeleton for the table while isLoading', () => {
    const out = renderToStaticMarkup(<MembersTabView isLoading members={[member({})]} />);
    expect(out).not.toContain('<table');
  });

  test('renders an error state with retry when isError', () => {
    const out = renderToStaticMarkup(<MembersTabView isError errorMessage="boom" />);
    expect(out).toContain('Failed to load members');
    expect(out).toContain('boom');
    expect(out).toContain('Retry');
  });

  test('renders an empty state when there are no members at all', () => {
    const out = renderToStaticMarkup(<MembersTabView members={[]} />);
    expect(out).toContain('No members yet');
    expect(out).not.toContain('<table');
  });

  // ── The Invites tab. Three lists that used to sit one screen apart under
  // three near-identical headings ("Pending invites" / "Account invites" /
  // "Access requests") now share one tab, each retitled to say who is waiting
  // and for what — see members-tab.tsx's header comment, "Plain titles". ──

  test('project invites live on the Invites tab under a plain-language title', () => {
    const out = renderToStaticMarkup(
      <MembersTabView
        section="invites"
        members={[member({})]}
        pendingInvites={[pendingInvite({})]}
      />,
    );
    expect(out).toContain('Invited to this workspace');
    expect(out).toContain('pending@kortix.com');
    // The old jargon title is gone, not merely moved.
    expect(out).not.toContain('Pending invites');
  });

  test('access requests live on the Invites tab under a plain-language title', () => {
    const out = renderToStaticMarkup(
      <MembersTabView
        section="invites"
        members={[member({})]}
        accessRequests={[accessRequest({})]}
      />,
    );
    expect(out).toContain('Asked to join');
    expect(out).toContain('requester@kortix.com');
    expect(out).not.toContain('Access requests');
  });

  test('both waiting lists render together, invites before requests', () => {
    const out = renderToStaticMarkup(
      <MembersTabView
        section="invites"
        members={[member({})]}
        accountId="acc1"
        pendingInvites={[pendingInvite({})]}
        accessRequests={[accessRequest({})]}
      />,
    );
    expect(out.indexOf('Invited to this workspace')).toBeLessThan(out.indexOf('Asked to join'));
  });

  test('the waiting lists are NOT on the People tab', () => {
    const out = renderToStaticMarkup(
      <MembersTabView
        members={[member({})]}
        pendingInvites={[pendingInvite({})]}
        accessRequests={[accessRequest({})]}
      />,
    );
    expect(out).not.toContain('Invited to this workspace');
    expect(out).not.toContain('Asked to join');
  });

  test('an Invites tab with nobody waiting shows an empty state, not a blank panel', () => {
    const out = renderToStaticMarkup(<MembersTabView section="invites" members={[member({})]} />);
    expect(out).toContain('Nobody is waiting');
    expect(out).not.toContain('pending@kortix.com');
  });

  // ── Account controls moved out (2026-08-18): role change, remove-from-
  // account, invite-to-account, and leave-account all live on
  // `/accounts/:id` now, exclusively — see members-tab.tsx's header comment,
  // "Account controls moved out". This pane keeps exactly one account-scope
  // surface: a link out. ──

  test('the account role is a plain link to /accounts/:id when accountId is known', () => {
    const out = renderToStaticMarkup(
      <MembersTabView
        members={[member({ user_id: 'u1', email: 'other@kortix.com', account_role: 'admin' })]}
        accountId="acc1"
      />,
    );
    expect(out).toContain('href="/accounts/acc1?section=members"');
    expect(out).toContain('admin');
    // Not a Select, not a remove control — this pane cannot mutate account
    // membership at all any more.
    expect(out).not.toContain('role="combobox"');
    expect(out).not.toContain('from account');
  });

  test('the account role falls back to plain text (no link) with no accountId', () => {
    const out = renderToStaticMarkup(
      <MembersTabView members={[member({ user_id: 'u1', account_role: 'owner' })]} />,
    );
    expect(out).toContain('owner');
    expect(out).not.toContain('href="/accounts/');
  });

  test('no account invites section, no leave-account row, no account invite dialog — gone, not hidden', () => {
    const out = renderToStaticMarkup(
      <MembersTabView
        section="invites"
        members={[member({ user_id: 'u1', account_role: 'owner' })]}
        accountId="acc1"
      />,
    );
    expect(out).not.toContain('Invited to this account');
    expect(out).not.toContain('Leave ');
    expect(out).not.toContain('account-invite-dialog-marker');
  });

  /**
   * This table edits ONE workspace's access; account roles across every
   * workspace, groups, billing and audit live on `/accounts/<id>`. The row is
   * a plain link with no probe on it — that page gates its own sections.
   */
  test('the organization-settings row links to /accounts/<accountId>, below the table', () => {
    const out = renderToStaticMarkup(<MembersTabView members={[member({})]} accountId="acc1" />);
    expect(out).toContain('Organization account settings');
    expect(out).toContain('href="/accounts/acc1"');
    expect(out.indexOf('</table>')).toBeLessThan(out.indexOf('Organization account settings'));
  });

  test('no accountId, no organization-settings row — the href would be /accounts/undefined', () => {
    const out = renderToStaticMarkup(<MembersTabView members={[member({})]} />);
    expect(out).not.toContain('Organization account settings');
    expect(out).not.toContain('/accounts/undefined');
  });

  test('only inviteDialogSlot renders — there is no second, account-scope dialog slot', () => {
    for (const section of ['people', 'invites', 'access'] as const) {
      const out = renderToStaticMarkup(
        <MembersTabView
          section={section}
          members={[member({})]}
          inviteDialogSlot={<div>invite-dialog-marker</div>}
        />,
      );
      expect(out).toContain('invite-dialog-marker');
    }
  });
});
