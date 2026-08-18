'use client';

/**
 * The Members tab — one unified table of every account member's project
 * standing, replacing `customize/sections/view/members-view.tsx`'s
 * `MembersView` at this mount (`settings-panel.tsx`'s `case 'members'`).
 *
 * **One list, not a compromise (task brief).** `GET /projects/:id/access`
 * (`listProjectAccess`, `packages/sdk/src/core/rest/projects-client/
 * access.ts:103`) already selects every ACCOUNT member and left-joins their
 * project + group grants server-side
 * (`apps/api/src/projects/routes/r6.ts:240`) — each `ProjectAccessMember`
 * already carries `account_role`, `project_role`, `effective_project_role`,
 * and `effective_source`. This tab renders that one response as one table:
 * an "Account role" column (`member.account_role`, read-only — account
 * roles are an account-settings concern, not a project one) and a
 * "Project role" column (`memberAccessLabel(member)`, see
 * `member-access-label.ts` — was "Workspace access", which named a
 * different concept, "access", than the value it showed, a role name or
 * "No access"; both columns now read as the same kind of thing at two
 * scopes). Unlike the old `ProjectAccessCard`
 * (`members-view.tsx`), which filtered to
 * `has_implicit_access || effective_project_role != null` and hid every
 * account member with zero project access, this table renders every row
 * the API returns — a no-access member reads as "—" via
 * `memberAccessLabel`, matching that function's own "no access reads as an
 * em dash" case instead of being silently dropped.
 *
 * **The write gate — verified against the routes, not the brief's literal
 * wording.** The brief describes "account writes gated on
 * `member.invite`/`member.update`/`member.remove` and workspace writes on
 * `project.member.write`". Checked directly against
 * `apps/api/src/projects/routes/r6.ts`: EVERY mutation this table's
 * **project-role column** (or the project-scoped sections below it) can
 * trigger — invite (`:673`), list/revoke/resend a pending invite (`:851`,
 * `:941`, `:1012`), list/approve/reject an access request (`:491`, `:533`),
 * and update/revoke a member's own access (`:1096`, `:1169`) — asserts the
 * SAME single leaf: `PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE`
 * ('project.members.manage', `lib/project-actions.ts:61`). So the workspace
 * -access column, the invite-to-project dialog, and the pending-invites /
 * access-requests sections below the table all gate on ONE probe:
 * `useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE)`. This is
 * unchanged by JAY-549 below.
 *
 * `member.invite`/`member.update`/`member.remove` are a SEPARATE axis —
 * see "JAY-549" further down for where they are now genuinely used.
 *
 * **This task's orphan — `ACCOUNT_ROLE_DESCRIPTORS`.** The brief frames this
 * as "referenced only by the legacy page's members pane" — checked, and
 * that premise is already stale: `components/iam/permissions-help-popover.tsx`
 * ALSO imports and renders it (`ACCOUNT_ROLE_DESCRIPTORS[role].label`/
 * `.blurb` for each of `ACCOUNT_ROLES_DESCENDING`), and `PermissionsHelpPopover`
 * is what `members-view.tsx`'s `MembersView` mounts as its section action
 * (`members-view.tsx:282-288`) — the exact mount this tab replaces. So the
 * "owner / admin / member role explainer copy" was already reachable through
 * TWO paths, not one, before this change. This tab keeps that reachable by
 * mounting the same `<PermissionsHelpPopover />` as its own header action
 * (reused, not reimplemented) — see `project-role-descriptors.ts`'s own
 * header comment; that file is NOT modified here, per the brief.
 *
 * **`members-view.tsx` is gone — this file absorbed it.** Taking over
 * `settings-panel.tsx`'s `case 'members'` left `MembersView` with no caller,
 * so it was deleted along with everything only it reached:
 * `customize/sections/member-sort.ts` (+ its test), which had become
 * reachable from its own test alone. Its three substantive cards were NOT
 * dropped — `ProjectGroupGrantsCard` (bulk group-access grants),
 * `ResourceAccessCard` (per-agent/skill scoping) and
 * `ProjectRoleAssignmentsCard` (custom-role bindings) were moved into this
 * file (cut, not copied — see their slots below). Of those three,
 * `ProjectGroupGrantsCard` and `ProjectRoleAssignmentsCard` were later
 * removed outright (not just this move) — see the header comment further
 * down, right above where they used to live, for why; `ResourceAccessCard`
 * is the only one left. And
 * `consumeMembersTabIntent` moved to `members-tab-intent.ts` beside its only
 * caller. `PermissionsHelpPopover` keeps a live mount here as this tab's own
 * header action, independent of `accounts/[id]/page.tsx`'s.
 *
 * What genuinely did not carry forward is the bulk invite-by-email composer;
 * `InviteMemberDialog` / `InviteToAccountDialog` below are single-email by
 * this file's own convention — see the "Invite-to-account" note further down.
 *
 * `MembersTabView` is the pure, props-only half — no hooks, no data
 * fetching. `MembersTab` is the container: every hook only runs while this
 * tab is actually mounted, which `SettingsTabPane` in `settings-panel.tsx`
 * guarantees (`if (!active) return null;` — see this file's task brief).
 *
 * **`InviteMemberDialog` and `PermissionsHelpPopover` are both slots.**
 * `InviteMemberDialog` owns its own `useMutation`, same reasoning as
 * `general-tab.tsx`'s `GeneralWorkspaceCard`/`service-accounts-card.tsx`'s
 * `CreateServiceAccountDialog` — it can't render under
 * `renderToStaticMarkup` with no `QueryClientProvider`. `PermissionsHelpPopover`
 * looked stateless but isn't: it calls `useTranslations('hardcodedUi')`
 * (`components/iam/permissions-help-popover.tsx:26`), which throws with no
 * `NextIntlClientProvider` ancestor — confirmed directly, not assumed: a
 * standalone `renderToStaticMarkup(<PermissionsHelpPopover />)` throws inside
 * `react-dom/server` with no provider mounted. Both slots are left
 * `undefined` by default so the bare `<MembersTabView />` the test file
 * renders still renders cleanly.
 *
 * **Untestable here, by design (see the task brief's hard constraint — no
 * `@testing-library/react`, no jsdom/happy-dom, none may be added):** every
 * mutation's actual network round trip, the invite dialog's form
 * interaction, and Select/dropdown open state all need a live network and a
 * real DOM. `members-tab.test.tsx` covers what the pure view can prove
 * statically: table shape, column presence, gated controls, and the pending
 * invites / access requests sections below it.
 *
 * **JAY-548 — two more orphans closed: `listAccountInvites`,
 * `cancelAccountInvite`, `resendAccountInvite`, `leaveAccount`.** Verified
 * before writing any of this: `grep -rn "listAccountInvites\|
 * cancelAccountInvite\|resendAccountInvite\|leaveAccount\b" src --include=
 * "*.tsx" --include="*.ts"` matched exactly one caller for each — all four
 * inside `accounts/[id]/page.tsx` (`leaveAccount` at :1119,
 * `listAccountInvites` at :2084, `resendAccountInvite` at :2092,
 * `cancelAccountInvite` at :2116) — the page JAY-505 deletes. These are
 * ACCOUNT-scoped (this account's own membership/invitations), a different
 * axis from every `project*` field above (this project's access to THIS
 * project). There is no separate "account members" settings tab in
 * `settings-tabs.ts`'s `SettingsTab` union — `members` is the merged
 * vocabulary for both, so both surfaces live here, not on a new tab.
 *
 * *Account invites* (`accountInvites`/`canManageAccountInvites`/
 * `onResendAccountInvite`/`onRequestCancelAccountInvite`/…) reproduces
 * `page.tsx`'s `PendingInvitesSection` (:2057-2233): same fields
 * (`invite.initial_role`, `invite.expires_at`, no `invite_expired` flag —
 * `AccountInvitation` doesn't carry one, unlike `PendingProjectInvite`), same
 * "list renders for anyone, actions gate on `member.invite`" shape (the
 * source's `invitesQuery` has no `canManage`-gated `enabled` clause — only
 * the row's dropdown menu is gated on `canManage={canInviteMember}`,
 * preserved here as `canManageAccountInvites` via
 * `usePermission(accountId, 'member.invite')`). Titled "Account invites",
 * NOT "Pending invites" — that title is already taken by the project-invites
 * section above it; two sections with the same title one screen apart would
 * read as one broken list. Row actions are "Resend"/"Cancel" inline buttons
 * (this file's own established row dialect, matching the project pending-
 * invites section above), not the source's three-item dropdown (which also
 * offered "Copy invite link") — the task brief names exactly two actions,
 * cancel and resend, so the third is not reproduced.
 *
 * *Leave account* (`leaveAccountOpen`/`isLastOwner`/`onOpenLeaveAccount`/…)
 * reproduces `page.tsx`'s self-row "Leave team" menu item (:1565-1577,
 * `leaveMutation` at :1118-1128) as its own standalone section instead — the
 * source's per-row-kebab composition doesn't fit here: this table's rows are
 * PROJECT access grants keyed by member, not "which accounts am I in", so
 * there is no natural per-row slot for a self-referential account action.
 * **Self-directed — no permission probe gates it, on purpose (this task's
 * own explicit call-out).** `member.invite`/`member.remove` gate inviting or
 * removing SOMEONE ELSE; leaving your own account is a different thing
 * entirely and is not an IAM leaf at all. The only thing that governs the
 * control is `isLastOwner` — computed from the SAME account roster this file's
 * own table already renders (`accessQuery.data.members`, every account
 * member with `account_role` — see this file's own "one list" reasoning
 * above), not a second `listAccountMembers` fetch (that function is out of
 * this task's four-function scope and still has its own separate live
 * caller in `page.tsx`).
 *
 * **The sole owner sees no leave row at all** (Jay, 2026-08-12). It used to
 * render `disabled={isLastOwner}` with a line explaining why, mirroring
 * `page.tsx:1570`'s own disabled menu item — a control that could never do
 * anything, plus an apology for it, which is the dead-button shape this panel
 * already removed from Profile ("Unavailable") and Organization ("Coming
 * soon"). The gate is "only owner", NEVER "is an owner": `isLastOwner` is
 * `currentAccountRole === 'owner' && ownerCount <= 1`, and a CO-owner can
 * genuinely leave, so widening it would take a working capability away from
 * anyone who shares ownership. A sole owner who wants out transfers ownership
 * first, in the Account role column of the table directly above the row.
 *
 * **Confirm-before-destroy — the task's own explicit constraint, not
 * `page.tsx`'s.** Cancelling an account invite and leaving an account both
 * go through `ConfirmDialog` with `confirmVariant="destructive"`, even
 * though `page.tsx`'s own two dialogs for these (:2212-2230, :1666-1679)
 * omit `confirmVariant` (default, non-destructive styling) — this file's
 * task brief calls both destructive explicitly (leaving removes your own
 * access), so that is preserved here over the source's own choice.
 *
 * **`accountId` is resolved via `useSettingsAccountId`, never
 * `project?.account_id` alone** — same shape (and same fixed bug) every
 * other account-scoped tab in this panel uses; see `use-settings-account-id
 * .ts`'s header comment and `organization-tab.tsx`'s. It is a SEPARATE value
 * from `project?.account_id` (read off this file's own `projectQuery`
 * below), which still feeds ONLY the three rehomed cards' gates, unchanged —
 * the two are never conflated.
 *
 * `members-tab.test.tsx`'s new cases cover the same axis as everything
 * above: the "Account invites" vs "Pending invites" title split, the
 * `canManageAccountInvites`-not-`canManageMembers` row-action gate, the
 * `accountId`-gated visibility of both new sections, and the
 * `isLastOwner`-hidden Leave row (with its companion case: a co-owner keeps
 * it, enabled). The mutations' real network round trips remain untestable
 * here for the same reason as everything else in this file (no DOM testing
 * library).
 *
 * **JAY-549 — the three genuinely-orphaned functions, closed.** An earlier
 * pass on this ticket claimed `inviteAccountMember`/`updateAccountMemberRole`/
 * `removeAccountMember` were already called here. That claim was FALSE — it
 * was based on `grep -rl` (file contains the string) rather than the call
 * line, and the one hit was this file's own JSDoc *mentioning* the names in a
 * sentence saying they were NOT used. Re-verified with line content before
 * writing any of this:
 * `grep -n "inviteAccountMember\|updateAccountMemberRole\|removeAccountMember"
 * apps/web/src/app/(app)/accounts/[id]/page.tsx` — matches only inside
 * `page.tsx`'s own `MembersCard`/`InviteMemberModal`/`BulkSetRoleDialog`
 * (imports at :111,:116,:118; calls at :1095,:1108,:1696,:1716,:1760). This
 * task adds the first other caller.
 *
 * These three are a THIRD axis, distinct from both `project.members.manage`
 * (project-role column above) and `member.invite`-for-invites
 * (`canManageAccountInvites`, JAY-548): they mutate the ACCOUNT roster
 * itself — who is a member of this account at all, and at what account
 * role. Gates are copied byte-for-byte from `page.tsx`'s
 * `ACCOUNT_PERMISSION_PROBES` (`accounts/[id]/page.tsx:135-144,322-331`),
 * never re-derived from `canManageMembers`/`canManageAccountInvites`:
 * `canUpdateAccountRole` = `usePermission(accountId, 'member.update')`
 * (`canUpdateMember` at `page.tsx:327`), `canRemoveFromAccount` =
 * `usePermission(accountId, 'member.remove')` (`canRemoveMember` at
 * `page.tsx:326`). Inviting reuses `canManageAccountInvites`
 * (`member.invite`) as-is — it is the SAME leaf `page.tsx:325`'s
 * `canInviteMember` used for both `MembersCard`'s Invite button and
 * `PendingInvitesSection`'s row actions, so one probe correctly gates both
 * surfaces here too.
 *
 * **Row-level, not a second list.** The table's existing "Account role"
 * column gains its OWN controls, in place of the always-read-only `Badge`
 * it rendered before this task — a compact `Select` (value bound to
 * `member.account_role`, mirrors `page.tsx`'s "Change role" menu,
 * `page.tsx:1532-1549`, current role selectable but a no-op since it's
 * already selected) plus a small "Remove from account" icon button (mirrors
 * `page.tsx:1552-1564`). This is the SAME row `memberAccessLabel` already
 * renders — no second roster, matching this file's "one list, not a
 * compromise" mandate at the top of this comment. Deliberately NOT a
 * `DropdownMenu` kebab (tried first, reverted): `DropdownMenuContent` is
 * Radix-portal-gated and renders nothing under `renderToStaticMarkup` while
 * closed — confirmed directly, not assumed, by writing that version first
 * and watching every content-text assertion fail with the trigger present
 * but the menu items entirely absent from the static markup. A `Select`
 * with `SelectValue` in the trigger (the SAME pattern the Workspace-access
 * column already uses two columns over) renders its current value
 * server-side with no open state required, so it is genuinely testable
 * under this file's hard no-DOM-library constraint. Both controls are
 * hidden for the viewer's OWN row (`currentUserId`), mirroring `page.tsx`'s
 * per-row `!isSelf` guard on both controls (`page.tsx:1526`,`:1552`)
 * exactly — a member's own account role/membership goes through the
 * separate self-directed "Leave account" section (JAY-548) instead, never
 * this row. "Remove from account" is additionally disabled for the
 * account's last owner (`page.tsx:1557`'s `disabled={isLastOwner}`),
 * computed from the SAME `members` array the table already renders (every
 * row carries `account_role`) — no second `listAccountMembers` fetch (still
 * out of this file's scope, still has its own live caller in `page.tsx`).
 * Selecting a role does NOT mutate directly — `onValueChange` calls
 * `onRequestAccountRoleChange`, which only STAGES the change; the `Select`'s
 * own `value` prop stays bound to the unchanged `member.account_role` until
 * the `ConfirmDialog` below is confirmed and the query re-fetches, so an
 * unconfirmed pick visually reverts instead of looking silently applied.
 *
 * **Confirm-before-destroy.** `ConfirmDialog` gates both actions, per this
 * task's explicit constraint — a role change (including self-demotion risk
 * on the *next* viewer to look at this table) and a removal are both
 * destructive and effectively irreversible without another owner's help.
 * Role-change uses the default (non-destructive) `ConfirmDialog` variant,
 * matching `page.tsx`'s own choice (`page.tsx:1621-1643` sets no
 * `confirmVariant`); removal uses `confirmVariant="destructive"`, matching
 * this file's OWN established dialect for every other removal dialog above
 * (`onRequestRemove`'s "Remove member?", `onRequestRevokeInvite`'s "Revoke
 * invitation?", `onRequestCancelAccountInvite`'s "Cancel invite") rather
 * than `page.tsx`'s own non-destructive remove dialog (`page.tsx:1645-1664`
 * also sets no `confirmVariant`) — consistency with this file's own pattern
 * wins over byte-matching a source that predates this file's own destructive
 * -variant convention.
 *
 * **Invite-to-account is a new, smaller dialog** (`InviteToAccountDialog`),
 * not `page.tsx`'s `InviteMemberModal` ported verbatim — that source dialog
 * is a bulk multi-email chip composer; this file's OWN established
 * convention for its sibling `InviteMemberDialog` (invite-to-PROJECT, above)
 * is already single-email, so the account counterpart matches that local
 * precedent instead of the source's bulk UI, same reasoning this file's
 * header comment already gives for not porting `members-view.tsx`'s bulk
 * composer either. Role options are owner/admin/member (`page.tsx:2013-2019`
 * order), copy sourced from `ACCOUNT_ROLE_DESCRIPTORS` — the same single
 * source of truth `PermissionsHelpPopover` already renders via this file's
 * own `permissionsHelpSlot`, so the invite dialog's role blurbs cannot drift
 * from the popover's explainer copy. Mounted only once `accountId` resolves
 * (same gate as every other account-scoped surface in this file).
 * `page.tsx:1780-1834`'s per-item 409-vs-other-failure partial-success
 * handling only exists because that dialog invites many emails at once; a
 * single-email dialog has nothing to partially succeed, so it simplifies to
 * one success/one error path, matching `InviteMemberDialog`'s own shape.
 *
 * The "Account invites" section header (JAY-548) now carries the Invite
 * button, gated on `canManageAccountInvites` — the same `member.invite` leaf
 * that already gated its row actions — so cancelling/resending an invite
 * and creating one live under the same gate and the same section, closing
 * the JAY-548 gap this ticket exists to fix ("cancel/resend shipped with no
 * way to create one"). The section's visibility condition grows an OR-branch
 * for `canManageAccountInvites` so an authorized viewer with zero pending
 * invites still sees the header + Invite button, not just after the first
 * invite exists — this cannot regress the JAY-548 tests, since every one of
 * them either passes `canManageAccountInvites` as its (still-false) default
 * or already satisfies the OR-condition's other two branches.
 *
 * `member-role-safety.test.ts` (`components/iam/`, NOT edited otherwise per
 * this task's constraint) is repointed at this file instead of
 * `readFileSync`-ing `page.tsx` — it now pins the same two invariants
 * (role-change stages a `ConfirmDialog` rather than mutating on select; role
 * copy has one source, `ACCOUNT_ROLE_DESCRIPTORS`) against this file's own
 * `setAccountRoleChangeTarget`/`onConfirmAccountRoleChange`/
 * `accountRoleMutation.mutate` shape.
 *
 * **Table shape — presentation only.** Four changes, none of which touch a
 * query, a mutation, or a permission gate:
 *
 * 1. The table is the shared `Table` primitive, used exactly as
 *    `secrets-view.tsx` uses it: `<Table className="overflow-hidden
 *    rounded-md">`, a bordered `bg-popover` card, a filled header row,
 *    hairline dividers between rows, and the hover highlight — no overrides.
 *
 *    It was borderless for a day (2026-08-11), copying Linear's members
 *    settings: a local `<table>` container, `TableHeader` forced to
 *    `bg-transparent`, and every body row forced to `border-b-0
 *    hover:bg-transparent`. Jay's call, 2026-08-12: match the Secrets table
 *    instead. The settings panel has exactly two tables — this one and
 *    Secrets — and they were the only two surfaces in the panel that
 *    disagreed about what a table is. Do not reintroduce the local container:
 *    every class the borderless version added existed to cancel one the
 *    primitive already sets.
 * 2. `Joined` is its own right-aligned `tabular-nums` column instead of a
 *    second line inside the Member cell, so dates align down the table. An
 *    absent `joined_at` reads as an em dash rather than `formatDate`'s
 *    "Never", which is nonsense for a join date.
 * 3. The trailing actions column is gone: the workspace-access `Select` now
 *    sits in the project-role column it edits. Nothing is lost —
 *    `memberAccessLabel` only returns a `via` annotation for implicit or
 *    group-sourced access, and `editable` excludes both.
 * 4. The read-only account role is tonal text, not a filled `Badge` — an
 *    owner/admin reads at full strength, a plain member reads muted. `Badge`
 *    is still this file's chip for the invite/request rows below.
 *
 * Every capability enumerated above this paragraph is still on the pane, in
 * the same order, under the same gate: the three rehomed access cards, both
 * role columns, the account-role `Select` + remove, project pending invites,
 * access requests, account invites, and Leave account.
 *
 * **Three underline tabs (2026-08-12) — layout only.** Everything above had
 * grown into NINE sections stacked in one scroll, all equally prominent, with
 * three near-identical headings ("Pending invites" / "Account invites" /
 * "Access requests") one screen apart. Jay's call: split it into `People`,
 * `Invites`, `Access` using the shared `TabsList type="underline"` primitive
 * (the same one `review-center.tsx` and the group detail page use — not a
 * hand-rolled bar). Nothing moved between permission gates, no query, no
 * mutation, and no capability was dropped:
 *
 * - **People** — the members table, the Invite action (now a labelled primary
 *   button beside a client-side search field, per Jay's reference shots), and
 *   two quiet account-scoped rows at the bottom in one bordered group:
 *   "Organization account settings" (a `Link` to `/accounts/<accountId>`, the
 *   account page's own default section) and Leave account. The first is
 *   Jay's call, 2026-08-17 — this table edits ONE workspace's access, and
 *   nothing on the pane said where the rest of the organization is
 *   configured. It is a plain link: no probe gates it, because
 *   `/accounts/<id>` gates its own sections. The search filters
 *   `userLabel(member)` — the email the table already renders — in the
 *   browser; it invents no field and hits no route. It is a controlled prop so
 *   `MembersTabView` stays hook-free.
 * - **Invites** — everyone waiting to get in: the project invites, the account
 *   invites, and the access requests, each retitled to say who is waiting and
 *   for what. See "Plain titles" below.
 * - **Access** — `resourceAccessSlot` only: which members/groups can USE
 *   which agent, the one project-scoped concern this page owns. Assigning a
 *   project ROLE to a whole group at once, and binding a custom role, both
 *   moved out — they were never a resource concern (Groups attached a plain
 *   ProjectRole, the same op the People tab does per-member; Custom roles
 *   bound an account-defined role) and both already have a proper home:
 *   a group's own detail page's "Projects" tab
 *   (`accounts/[id]/groups/[groupId]`'s `GroupProjectGrantsCard`) and the
 *   account Roles page's `PolicyAssignments`, which can target ANY project,
 *   not just the one you happen to be viewing. Keeping a second, narrower
 *   copy of each on every individual project's Access tab was pure
 *   duplication — and, for the vast majority of accounts with zero groups
 *   and zero custom roles, a permanently-empty "go create one elsewhere"
 *   card that only added noise.
 *
 * **Plain titles.** The three waiting lists were renamed for a non-technical
 * reader; each is a display string with no other consumer (verified with
 * `grep -rn "Pending invites\|Access requests\|Account invites" src` — the
 * only matches were this file and its own test):
 *
 *   Pending invites  -> "Invited to this workspace"
 *   Account invites  -> "Invited to this account"
 *   Access requests  -> "Asked to join"
 *
 * No permission leaf, API field, query key, or prop name changed with them.
 *
 * **The Cmd+K deep link still lands.** `command-palette.tsx`'s
 * `openSettings('members', { membersTab: 'invite' })` is consumed by the same
 * one-shot `consumeMembersTabIntent` effect as before; it now ALSO forces the
 * `people` section, because the project Invite button lives there, before
 * opening the dialog. The dialog slots render outside `Tabs`, so an open
 * dialog survives a tab switch.
 *
 * **Radix renders only the active panel.** An inactive `TabsContent` is an
 * empty `<div hidden>` under `renderToStaticMarkup` — confirmed directly, not
 * assumed. So every test that asserts on a non-default tab passes `section`
 * explicitly; that prop exists for the container's state, and the tests ride
 * the same door.
 */

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Children,
  Fragment,
  isValidElement,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { useAuth } from '@/features/providers/auth-provider';
import { SubjectPicker } from '@/features/workspace/shared/sharing-picker';
import { useSettingsNav } from '@/features/workspace/shared/settings-nav-context';
import { cn } from '@/lib/utils';
// Moved here from `members-view.tsx` when that file was deleted — it was the
// one live export in an otherwise dead module. Reused, not reimplemented: an
// exported pure function with its own dedicated test coverage
// (`members-tab-intent.test.ts`'s "reviewer-found sequence" — the JAY-530
// stale-intent fix). See `MembersTabInner`'s "Invite deep-link intent"
// comment below for what it does.
import { consumeMembersTabIntent } from './members-tab-intent';

import { isInheritedFromGroupOnly } from '@/components/iam/iam-display-helpers';
import { PermissionsHelpPopover } from '@/components/iam/permissions-help-popover';
import { ACCOUNT_ROLE_DESCRIPTORS } from '@/components/iam/project-role-descriptors';
import { ProjectRoleSelectItem } from '@/components/iam/role-select-item';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Field, FieldLabel } from '@/components/ui/field';
import { InlineMeta } from '@/components/ui/inline-meta';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SettingsRow, SettingsRowGroup } from '@/components/ui/settings-row';
import { SettingsSubsectionHeader } from '@/components/ui/settings-subsection-header';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { errorToast, successToast, warningToast } from '@/components/ui/toast';
import { UserAvatar } from '@/components/ui/user-avatar';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { useCopy } from '@/hooks/use-copy';
import { PROJECT_LANDING_PATH } from '@/lib/onboarding/landing-destination';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { usePermission } from '@/lib/use-permission';
import { useProjectCan } from '@/lib/use-project-can';
import {
  approveProjectAccessRequest,
  cancelAccountInvite,
  createProjectResourceGrant,
  deleteProjectResourceGrant,
  getAccount,
  getProject,
  inviteAccountMember,
  inviteProjectMember,
  isInviteSent,
  leaveAccount,
  listAccountInvites,
  listPendingProjectInvites,
  listProjectAccess,
  listProjectAccessRequests,
  listProjectResourceGrants,
  rejectProjectAccessRequest,
  removeAccountMember,
  resendAccountInvite,
  resendPendingProjectInvite,
  revokePendingProjectInvite,
  revokeProjectAccess,
  updateAccountMemberRole,
  updateProjectAccess,
  type AccountInvitation,
  type AccountRole,
  type PendingProjectInvite,
  type ProjectAccessMember,
  type ProjectAccessRequest,
  type ProjectResourceGrant,
  type ProjectRole,
  type ResourceGrantType,
} from '@kortix/sdk';
import { contract, invalidateProject, qk } from '@kortix/sdk/react';
import {
  CheckIcon as Check,
  ClockIcon as Clock,
  ArrowElbowDownRightIcon as CornerDownRight,
  KeyIcon as KeyRound,
  LockIcon as Lock,
  EnvelopeIcon as Mail,
  PlugIcon as Plug,
  PlusIcon as Plus,
  ArrowClockwiseIcon as RefreshCw,
  UsersIcon as Users,
  XIcon as X,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import Hint from '@/components/ui/hint';
import { CapabilityPageShell } from '@/features/workspace/capabilities/shared/capability-page-shell';
import { toArray } from '@/features/workspace/customize/shared/utils';
import { useSettingsAccountId } from '../use-settings-account-id';
import { memberAccessLabel } from './member-access-label';

const NO_ACCESS = '__none__';
const MEMBER_ROW = 'bg-popover flex items-center gap-3 rounded-md border px-4 py-2.5';

/** The account standing renders as text, not a filled badge — Kortix's palette
 *  earns exactly one accent and this is not it, so the "colour" here is tonal:
 *  an owner/admin reads at full strength, a plain member reads muted. */
function accountRoleToneClass(role: string) {
  return role === 'owner' || role === 'admin' ? 'text-foreground' : 'text-muted-foreground';
}

function userLabel(member: Pick<ProjectAccessMember, 'email' | 'user_id'>) {
  return member.email || member.user_id;
}

/** Shared formatter, hoisted so render does not rebuild the Intl machinery
 *  per call. Same options as the old `toLocaleDateString` call — identical output. */
const rowDateFormatter = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

function formatDate(input: string | null | undefined) {
  if (!input) return 'Never';
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return 'Never';
  return rowDateFormatter.format(date);
}

/** The three underline tabs this pane is split into — see this file's header
 *  comment, "Three underline tabs". */
export type MembersSection = 'people' | 'invites' | 'access';

export interface MembersTabViewProps {
  /** Which tab is showing. Controlled by `MembersTabInner` so the Cmd+K
   *  invite deep link can force `people` (where the Invite button lives)
   *  before opening the dialog. Defaults to `people`. */
  section?: MembersSection;
  onSectionChange?: (section: MembersSection) => void;
  /** Client-side filter over `userLabel(member)` — the email this table
   *  already renders. Controlled by the container so this view stays
   *  hook-free; it adds no query parameter and no new field. */
  memberSearch?: string;
  onMemberSearchChange?: (value: string) => void;

  isLoading?: boolean;
  isError?: boolean;
  errorMessage?: string;
  onRetry?: () => void;

  members?: ProjectAccessMember[];
  /** `project.members.manage` — the single leaf every write control below
   *  gates on. See this file's header comment. */
  canManageMembers?: boolean;
  /** user_id set — rows currently mid-mutation (role change or remove). */
  pendingUserIds?: Set<string>;
  onRoleChange?: (member: ProjectAccessMember, role: ProjectRole | typeof NO_ACCESS) => void;
  onRequestRemove?: (member: ProjectAccessMember) => void;

  removeTarget?: ProjectAccessMember | null;
  onCancelRemove?: () => void;
  onConfirmRemove?: () => void;
  isRemovePending?: boolean;

  onOpenInvite?: () => void;
  /** `InviteMemberDialog` — see this file's header comment for why it's a
   *  slot. */
  inviteDialogSlot?: ReactNode;
  /** `ResourceAccessCard`, moved from `members-view.tsx`. The container
   *  renders it only when `project?.account_id && canManage` — same gate
   *  `members-view.tsx` used, preserved exactly (manager-only DATA: the
   *  grants list route denies non-managers). The only slot the Access tab
   *  renders now — group-role and custom-role assignment moved out to their
   *  proper account-level homes, see this file's header comment. */
  resourceAccessSlot?: ReactNode;
  /** `<PermissionsHelpPopover />` — see this file's header comment for why
   *  it's a slot (it calls `useTranslations`, which throws with no
   *  `NextIntlClientProvider`). Carries `ACCOUNT_ROLE_DESCRIPTORS`'
   *  owner/admin/member explainer copy — see this file's header comment,
   *  "This task's orphan". */
  permissionsHelpSlot?: ReactNode;

  pendingInvites?: PendingProjectInvite[];
  isPendingInvitesLoading?: boolean;
  pendingInviteBusyIds?: Set<string>;
  onResendInvite?: (invite: PendingProjectInvite) => void;
  onRequestRevokeInvite?: (invite: PendingProjectInvite) => void;
  revokeInviteTarget?: PendingProjectInvite | null;
  onCancelRevokeInvite?: () => void;
  onConfirmRevokeInvite?: () => void;
  isRevokeInvitePending?: boolean;

  accessRequests?: ProjectAccessRequest[];
  isAccessRequestsLoading?: boolean;
  accessRequestBusyIds?: Set<string>;
  onApproveRequest?: (request: ProjectAccessRequest) => void;
  onRejectRequest?: (request: ProjectAccessRequest) => void;

  /** The account this project belongs to — resolved via
   *  `useSettingsAccountId` in `MembersTab`, same shape every other
   *  account-scoped settings tab uses (see `organization-tab.tsx`'s header
   *  comment). Gates whether the two ACCOUNT-scoped sections below render at
   *  all: both need an account id to fetch or mutate against. Distinct from
   *  every `project*` field above — those are keyed on `projectId`, these on
   *  this account. */
  accountId?: string;

  /** `listAccountInvites` — pending invitations to JOIN THIS ACCOUNT
   *  (`initial_role`, no `project_role`). A different list from
   *  `pendingInvites` above, which is project access invites
   *  (`listPendingProjectInvites`) — see this file's header comment,
   *  "JAY-548". Section title is "Account invites" specifically so it never
   *  reads as the same list as "Pending invites". */
  accountInvites?: AccountInvitation[];
  isAccountInvitesLoading?: boolean;
  accountInviteBusyIds?: Set<string>;
  /** `member.invite` — the SAME leaf `accounts/[id]/page.tsx` gated
   *  `PendingInvitesSection`'s resend/cancel controls on (`canInvite`,
   *  `ACCOUNT_PERMISSION_PROBES`'s `member.invite`). Preserved exactly, not
   *  re-derived from `canManageMembers` (a different, project-scoped leaf).
   *  Gates the row actions only — the list itself renders for anyone, same
   *  as the source (`invitesQuery` there has no `canManage`-gated `enabled`
   *  clause). */
  canManageAccountInvites?: boolean;
  onResendAccountInvite?: (invite: AccountInvitation) => void;
  onRequestCancelAccountInvite?: (invite: AccountInvitation) => void;
  cancelAccountInviteTarget?: AccountInvitation | null;
  onCancelCancelAccountInvite?: () => void;
  onConfirmCancelAccountInvite?: () => void;
  isCancelAccountInvitePending?: boolean;

  /** `leaveAccount` — self-directed, see this file's header comment,
   *  "JAY-548". NO permission probe gates this — a member leaving their own
   *  account is not the same permission as inviting or removing someone
   *  else (`member.invite`/`member.remove`), so it is never gated on
   *  `canManageMembers`/`canManageAccountInvites`. The only thing that
   *  governs it is `isLastOwner` — computed from the SAME account roster
   *  this tab's own table already renders (`accessQuery.data.members`,
   *  every account member with `account_role`), not a second fetch. */
  accountName?: string;
  isAccountRosterLoading?: boolean;
  /** True only when the viewer IS the account's single owner
   *  (`currentAccountRole === 'owner' && ownerCount <= 1`). HIDES the leave
   *  row rather than disabling it — see this file's header comment, "The sole
   *  owner sees no leave row at all". Never widen this to "is an owner": a
   *  co-owner can leave. */
  isLastOwner?: boolean;
  leaveAccountOpen?: boolean;
  onOpenLeaveAccount?: () => void;
  onCancelLeaveAccount?: () => void;
  onConfirmLeaveAccount?: () => void;
  isLeaveAccountPending?: boolean;

  /** The signed-in viewer's own `user_id` — both account-role row controls
   *  (below) are hidden entirely on this row, same as `page.tsx`'s per-row
   *  `!isSelf` guard. See this file's header comment, "JAY-549". */
  currentUserId?: string;
  /** `member.update` — the SAME leaf `page.tsx`'s `canUpdateMember`
   *  (`ACCOUNT_PERMISSION_PROBES`) gated the "Change role" submenu on. Turns
   *  the "Account role" column's `Badge` into a `Select`. Distinct from
   *  `canManageMembers`/`canManageAccountInvites` — never re-derived from
   *  either. */
  canUpdateAccountRole?: boolean;
  /** `member.remove` — the SAME leaf `page.tsx`'s `canRemoveMember` gated
   *  "Remove from team" on. Renders a "Remove from account" icon button
   *  next to the role control. */
  canRemoveFromAccount?: boolean;
  /** user_id set — rows currently mid account-role-change or
   *  account-removal. Separate from `pendingUserIds` above (that Set is for
   *  the project-role column's own mutations) so an account-scope
   *  mutation never shows a misleading "workspace access is changing"
   *  spinner. */
  accountPendingUserIds?: Set<string>;
  accountRoleChangeTarget?: { member: ProjectAccessMember; role: AccountRole } | null;
  onRequestAccountRoleChange?: (member: ProjectAccessMember, role: AccountRole) => void;
  onCancelAccountRoleChange?: () => void;
  onConfirmAccountRoleChange?: () => void;
  isAccountRoleChangePending?: boolean;
  accountRemoveTarget?: ProjectAccessMember | null;
  onRequestRemoveFromAccount?: (member: ProjectAccessMember) => void;
  onCancelRemoveFromAccount?: () => void;
  onConfirmRemoveFromAccount?: () => void;
  isAccountRemovePending?: boolean;

  /** Opens `InviteToAccountDialog` — see this file's header comment,
   *  "JAY-549". Gated on `canManageAccountInvites` (the "Account invites"
   *  section header's own action slot), not a new probe: `member.invite` is
   *  the SAME leaf `page.tsx:325`'s `canInviteMember` used for both the
   *  Invite button and the pending-invite row actions. */
  onOpenAccountInvite?: () => void;
  /** `InviteToAccountDialog` — a slot for the same reason `inviteDialogSlot`
   *  above is one (owns its own `useMutation`, can't render under
   *  `renderToStaticMarkup`). */
  accountInviteDialogSlot?: ReactNode;
}

/** Presentational only — no hooks, no data fetching, no store or Supabase
 *  read. Kept separate from `MembersTab` so this renders under
 *  `renderToStaticMarkup` with no `QueryClientProvider` — see
 *  `GeneralTabView`/`ApiKeysTabView` for the same split. */
export function MembersTabView({
  section = 'people',
  onSectionChange = () => {},
  memberSearch = '',
  onMemberSearchChange = () => {},
  isLoading = false,
  isError = false,
  errorMessage = '',
  onRetry = () => {},
  members = [],
  canManageMembers = false,
  pendingUserIds = new Set(),
  onRoleChange = () => {},
  onRequestRemove = () => {},
  removeTarget = null,
  onCancelRemove = () => {},
  onConfirmRemove = () => {},
  isRemovePending = false,
  onOpenInvite = () => {},
  inviteDialogSlot,
  permissionsHelpSlot,
  resourceAccessSlot,
  pendingInvites = [],
  isPendingInvitesLoading = false,
  pendingInviteBusyIds = new Set(),
  onResendInvite = () => {},
  onRequestRevokeInvite = () => {},
  revokeInviteTarget = null,
  onCancelRevokeInvite = () => {},
  onConfirmRevokeInvite = () => {},
  isRevokeInvitePending = false,
  accessRequests = [],
  isAccessRequestsLoading = false,
  accessRequestBusyIds = new Set(),
  onApproveRequest = () => {},
  onRejectRequest = () => {},
  accountId,
  accountInvites = [],
  isAccountInvitesLoading = false,
  accountInviteBusyIds = new Set(),
  canManageAccountInvites = false,
  onResendAccountInvite = () => {},
  onRequestCancelAccountInvite = () => {},
  cancelAccountInviteTarget = null,
  onCancelCancelAccountInvite = () => {},
  onConfirmCancelAccountInvite = () => {},
  isCancelAccountInvitePending = false,
  accountName,
  isAccountRosterLoading = false,
  isLastOwner = false,
  leaveAccountOpen = false,
  onOpenLeaveAccount = () => {},
  onCancelLeaveAccount = () => {},
  onConfirmLeaveAccount = () => {},
  isLeaveAccountPending = false,
  currentUserId,
  canUpdateAccountRole = false,
  canRemoveFromAccount = false,
  accountPendingUserIds = new Set(),
  accountRoleChangeTarget = null,
  onRequestAccountRoleChange = () => {},
  onCancelAccountRoleChange = () => {},
  onConfirmAccountRoleChange = () => {},
  isAccountRoleChangePending = false,
  accountRemoveTarget = null,
  onRequestRemoveFromAccount = () => {},
  onCancelRemoveFromAccount = () => {},
  onConfirmRemoveFromAccount = () => {},
  isAccountRemovePending = false,
  onOpenAccountInvite = () => {},
  accountInviteDialogSlot,
}: MembersTabViewProps) {
  const showPendingInvites = isPendingInvitesLoading || pendingInvites.length > 0;
  const showAccessRequests = isAccessRequestsLoading || accessRequests.length > 0;
  // Both account-scoped surfaces need an account id to fetch/mutate against —
  // hidden entirely (not a skeleton) while it's unresolved, same as every
  // other account-scoped tab in this panel treats a missing accountId. The
  // `canManageAccountInvites` OR-branch keeps the section header (and its
  // Invite button) visible for an authorized viewer with zero pending
  // invites, not only after the first invite exists. Unchanged by the tab
  // split — see this file's header comment, "JAY-549".
  const showAccountInvites =
    !!accountId &&
    (canManageAccountInvites || isAccountInvitesLoading || accountInvites.length > 0);
  // Hidden for the sole owner, not disabled. `isLastOwner` already means "the
  // viewer IS the only owner" (`currentAccountRole === 'owner' && ownerCount
  // <= 1` in the container), so the row it used to render was a control that
  // could never do anything plus a line explaining why — the dead-button shape
  // this panel removed from Profile and Organization. A CO-owner can genuinely
  // leave, so the gate is "only owner", never "is an owner": that would take a
  // working capability away. Transferring ownership first is done in the
  // Account role column of the table right above this.
  const showLeaveAccount = !!accountId && !isLastOwner;
  // The Access tab is exactly the three rehomed slots. The container decides
  // whether each one exists at all (its gate, unchanged); this only decides
  // whether the tab shows them or one muted row instead of a blank panel.
  const showAccessCards = !!resourceAccessSlot;
  // Everyone waiting to get in, counted once for the Invites tab's own count.
  const waitingCount =
    pendingInvites.length + accessRequests.length + (accountId ? accountInvites.length : 0);
  // Every account-owner row, for the per-row "last owner" guard on "Remove
  // from account" — mirrors `page.tsx`'s own `isLastOwner` (computed inline
  // per row there too), off the SAME `members` array this table already
  // renders. See this file's header comment, "JAY-549".
  const accountOwnerCount = members.filter((m) => m.account_role === 'owner').length;
  // Client-side, over data the table already renders (`userLabel` is the
  // email, falling back to the user id). No route, no new field — the one
  // filter this pane can honestly offer.
  const search = memberSearch.trim().toLowerCase();
  const visibleMembers = search
    ? members.filter((member) => userLabel(member).toLowerCase().includes(search))
    : members;

  return (
    /* The page's own chrome, not a section header inside someone else's page.
       `CapabilityPageShell` is what every sibling Customize tab renders
       (Connectors, Agents, Skills, Triggers, Models, Secrets), so Members gets
       their column, their heading, their header group — and, the reason this
       moved, their scroll container and their `py-10 lg:py-14` gap below the
       tab bar. The `(capabilities)` layout gives a page neither: it is a
       bounded `h-svh` column that renders `{children}` with no padding, so a
       page that brings its own bare `mx-auto` div sits flush against the tab
       bar and cannot scroll. Only the role explainer popover rides in the
       header's action slot; the member count and the Invite button belong to
       the People tab and live there. */
    <CapabilityPageShell
      title="Members"
      description="Who can reach this workspace, and what each person can do."
      action={permissionsHelpSlot}
    >
      <Tabs
        value={section}
        onValueChange={(next) => onSectionChange(next as MembersSection)}
        className="gap-6"
      >
        <TabsList type="underline" className="flex h-auto w-full items-center justify-start">
          <TabsTrigger value="people" className="w-fit flex-none gap-1.5 pb-3">
            People
            {members.length > 0 ? (
              <span className="text-muted-foreground text-xs tabular-nums">{members.length}</span>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="invites" className="w-fit flex-none gap-1.5 pb-3">
            Invites
            {waitingCount > 0 ? (
              <span className="text-muted-foreground text-xs tabular-nums">{waitingCount}</span>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="access" className="w-fit flex-none pb-3">
            Access
          </TabsTrigger>
        </TabsList>

        {/* ── People ────────────────────────────────────────────────────── */}
        <TabsContent value="people" className="space-y-4">
          {members.length > 0 || canManageMembers ? (
            <div className="flex items-center justify-between gap-3">
              {members.length > 0 ? (
                <Input
                  type="search"
                  value={memberSearch}
                  onChange={(event) => onMemberSearchChange(event.target.value)}
                  placeholder="Search members"
                  aria-label="Search members"
                  className="h-8 max-w-64"
                />
              ) : (
                <span />
              )}
              {canManageMembers ? (
                <Button type="button" size="sm" onClick={onOpenInvite} className="shrink-0 gap-1.5">
                  <Plus className="size-3.5" />
                  Invite
                </Button>
              ) : null}
            </div>
          ) : null}

          {isLoading ? (
            <Skeleton className="h-64 w-full rounded-md" />
          ) : isError ? (
            <ErrorState
              size="sm"
              title="Failed to load members"
              description={errorMessage}
              action={
                <Button variant="outline" size="sm" onClick={onRetry}>
                  Retry
                </Button>
              }
            />
          ) : members.length === 0 ? (
            <EmptyState
              icon={Users}
              title="No members yet"
              description="Invite someone to get started."
            />
          ) : visibleMembers.length === 0 ? (
            <EmptyState
              icon={Users}
              title="No one matches that search"
              description="Try part of an email address instead."
            />
          ) : (
            /* The shared `Table` primitive, used exactly as `secrets-view.tsx`
               uses it — bordered `bg-popover` card, filled header, hairline
               row dividers, hover highlight. Nothing is overridden here; the
               only per-column classes below are alignment and wrapping. */
            <Table className="overflow-hidden rounded-md">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Member</TableHead>
                  {/* SCOPE is the word that answers the actual question here
                      — "does changing this reach every workspace, or just
                      the one I'm looking at?" — so scope leads, "role" is
                      the secondary line. "Account role" / "Project role"
                      read as two labels for the same kind of thing; on a
                      PROJECT-scoped page (this whole pane lives under one
                      project's Customize bar) that reads as two flavors of
                      "this project's roles" when one of them is actually
                      account-wide and edits the person everywhere, not just
                      here. See this file's header comment. */}
                  <TableHead>
                    <span className="text-foreground block">Account</span>
                    <span className="text-muted-foreground/70 block text-[11px] font-normal">
                      every workspace
                    </span>
                  </TableHead>
                  <TableHead>
                    <span className="text-foreground block">This project</span>
                    <span className="text-muted-foreground/70 block text-[11px] font-normal">
                      only here
                    </span>
                  </TableHead>
                  <TableHead className="text-right">Joined</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleMembers.map((member) => {
                  const { role, via } = memberAccessLabel(member);
                  const busy = pendingUserIds.has(member.user_id);
                  const editable =
                    canManageMembers &&
                    !member.has_implicit_access &&
                    !isInheritedFromGroupOnly(member);

                  // JAY-549 — account-scope row actions. Hidden entirely on
                  // the viewer's own row (mirrors page.tsx's per-row
                  // `!isSelf` guard) — self goes through the separate "Leave
                  // account" row instead. See this file's header comment.
                  const isSelfAccountRow = !!currentUserId && member.user_id === currentUserId;
                  const accountBusy = accountPendingUserIds.has(member.user_id);
                  const accountRoleEditable = canUpdateAccountRole && !isSelfAccountRow;
                  const accountRemovable = canRemoveFromAccount && !isSelfAccountRow;
                  const isLastAccountOwner =
                    member.account_role === 'owner' && accountOwnerCount === 1;

                  return (
                    <TableRow key={member.user_id}>
                      <TableCell className="max-w-[240px] whitespace-normal">
                        <div className="flex min-w-0 items-center gap-2.5">
                          <UserAvatar email={member.email ?? ''} size="sm" />
                          <span className="text-foreground min-w-0 truncate">
                            {userLabel(member)}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          {accountBusy ? (
                            <Loading className="text-muted-foreground size-3.5 shrink-0" />
                          ) : accountRoleEditable ? (
                            <Select
                              value={member.account_role}
                              onValueChange={(next) =>
                                onRequestAccountRoleChange(member, next as AccountRole)
                              }
                            >
                              <SelectTrigger
                                className="h-7 w-28 text-xs capitalize"
                                aria-label={`Account role for ${userLabel(member)}`}
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="owner">
                                  {ACCOUNT_ROLE_DESCRIPTORS.owner.label}
                                </SelectItem>
                                <SelectItem value="admin">
                                  {ACCOUNT_ROLE_DESCRIPTORS.admin.label}
                                </SelectItem>
                                <SelectItem value="member">
                                  {ACCOUNT_ROLE_DESCRIPTORS.member.label}
                                </SelectItem>
                              </SelectContent>
                            </Select>
                          ) : (
                            // Coloured text, not a filled badge — Linear's
                            // own treatment for this column. See
                            // `accountRoleToneClass` above.
                            <span
                              className={cn(
                                'capitalize',
                                accountRoleToneClass(member.account_role),
                              )}
                            >
                              {member.account_role}
                            </span>
                          )}
                          {!accountBusy && accountRemovable ? (
                            <Button
                              type="button"
                              size="icon-xs"
                              variant="ghost"
                              onClick={() => onRequestRemoveFromAccount(member)}
                              disabled={isLastAccountOwner}
                              title={
                                isLastAccountOwner
                                  ? 'The account needs at least one owner.'
                                  : 'Remove from account'
                              }
                              aria-label={`Remove ${userLabel(member)} from account`}
                            >
                              <X className="size-3.5" />
                            </Button>
                          ) : null}
                        </div>
                      </TableCell>
                      {/* One column, one fact: the workspace-access control
                            lives in the project-role column it edits. No
                            annotation is lost — `memberAccessLabel` only
                            returns a `via` for implicit or group-sourced
                            access, and `editable` excludes both. */}
                      <TableCell className="max-w-[220px] whitespace-normal">
                        {busy ? (
                          <Loading className="text-muted-foreground shrink-0" />
                        ) : editable ? (
                          <div className="flex shrink-0 items-center gap-1">
                            <Select
                              value={member.project_role ?? NO_ACCESS}
                              onValueChange={(next) =>
                                onRoleChange(member, next as ProjectRole | typeof NO_ACCESS)
                              }
                            >
                              <SelectTrigger
                                className="h-7 w-32 text-xs"
                                aria-label={`Project role for ${userLabel(member)}`}
                              >
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value={NO_ACCESS}>No access</SelectItem>
                                <ProjectRoleSelectItem role="member" compact />
                                <ProjectRoleSelectItem role="editor" compact />
                                <ProjectRoleSelectItem role="manager" compact />
                              </SelectContent>
                            </Select>
                            {member.project_role ? (
                              <Button
                                type="button"
                                size="icon-xs"
                                variant="ghost"
                                onClick={() => onRequestRemove(member)}
                                title="Remove"
                                aria-label={`Remove ${userLabel(member)} from this workspace`}
                              >
                                <X className="size-3.5" />
                              </Button>
                            ) : null}
                          </div>
                        ) : (
                          <div className="flex items-center gap-1.5">
                            <div className="flex flex-col gap-0.5">
                              <span className="text-foreground">{role}</span>
                              {via ? (
                                <span className="text-muted-foreground text-xs">{via}</span>
                              ) : null}
                            </div>
                            {/* Explains why THIS row has no dropdown when the
                                column next to it (Account role) might.
                                Without this a locked row reads as a bug — see
                                this task's report, "i can't even seem to be
                                able to fucking change the workspace access."
                                Scoped to `canManageMembers`: if the viewer
                                cannot manage members at all, every row is a
                                blank read view and a lock icon on each one
                                would be page-level noise, not a per-row fact. */}
                            {canManageMembers && member.has_implicit_access ? (
                              <Hint
                                side="top"
                                label="Owners and admins always have Manager on every project. To set this directly, change their account role to Member first."
                              >
                                <Lock className="text-muted-foreground size-3.5 shrink-0" />
                              </Hint>
                            ) : canManageMembers && isInheritedFromGroupOnly(member) ? (
                              <Hint
                                side="top"
                                label={(() => {
                                  const groupName = member.group_sources?.[0]?.group_name ?? 'group';
                                  const extra = (member.group_sources?.length ?? 0) - 1;
                                  // Only naming the winning group used to make
                                  // "change the group's project access" a lie
                                  // when a second group also granted access —
                                  // editing just Engineering wouldn't actually
                                  // unlock the row if Viewers still applied.
                                  return extra > 0
                                    ? `Inherited from the ${groupName} group and ${extra} other group${extra === 1 ? '' : 's'}. Change all of their project access to update this.`
                                    : `Inherited from the ${groupName} group. Change the group's project access to update this.`;
                                })()}
                              >
                                <Lock className="text-muted-foreground size-3.5 shrink-0" />
                              </Hint>
                            ) : null}
                          </div>
                        )}
                      </TableCell>
                      {/* `tabular-nums` so the dates align down the column. */}
                      <TableCell className="text-muted-foreground text-right tabular-nums">
                        {member.joined_at ? formatDate(member.joined_at) : '—'}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}

          {/* The two account-scoped rows, quiet and at the foot of the People
              tab rather than in titled sections competing with the table.
              Both need a resolved account id: one links to that account, the
              other leaves it. */}
          {accountId ? (
            <SettingsRowGroup className="mt-2">
              {/* This table edits ONE workspace's access. Everything else
                  about the organization — account roles across every
                  workspace, groups, custom roles, billing, audit — lives on
                  `/accounts/<id>`, and nothing on this pane said so (Jay,
                  2026-08-17: "have a link to the account settings somewhere").
                  `/accounts/<id>` with no `?tab=` lands on that page's own
                  Members section (`accounts/[id]/page.tsx`'s `VALID_TABS`
                  falls back to `members`), which is the continuation of what
                  a reader is already looking at. */}
              <SettingsRow
                label="Organization account settings"
                description="Account roles, groups, custom roles, billing, and audit — for every workspace, not just this one."
              >
                <Button asChild variant="outline" size="sm">
                  <Link href={`/accounts/${accountId}`}>Manage account</Link>
                </Button>
              </SettingsRow>

              {/* Self-directed. NO permission probe gates it — leaving your
                  own account is not an IAM leaf. See this file's header
                  comment, "JAY-548". */}
              {showLeaveAccount ? (
                isAccountRosterLoading ? (
                  <div className="px-4 py-3">
                    <Skeleton className="h-8 w-full rounded-md" />
                  </div>
                ) : (
                  <SettingsRow
                    label={`Leave ${accountName || 'this account'}`}
                    description="You'll lose access to this account and its projects."
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive gap-1.5"
                      onClick={onOpenLeaveAccount}
                    >
                      {isLeaveAccountPending ? <Loading className="size-3.5 shrink-0" /> : null}
                      Leave
                    </Button>
                  </SettingsRow>
                )
              ) : null}
            </SettingsRowGroup>
          ) : null}
        </TabsContent>

        {/* ── Invites ───────────────────────────────────────────────────── */}
        {/* Everyone waiting to get in, in one place. Three lists that used to
            read as one broken list now say who is waiting and for what — see
            this file's header comment, "Plain titles". No gate moved: the two
            project lists still gate on `canManageMembers`
            (`project.members.manage`), the account list on
            `canManageAccountInvites` (`member.invite`). */}
        <TabsContent value="invites" className="space-y-8">
          {showPendingInvites ? (
            <section className="space-y-4">
              <SettingsSubsectionHeader
                title="Invited to this workspace"
                description="They already have a Kortix account and just need to accept."
              />
              {isPendingInvitesLoading ? (
                <Skeleton className="h-14 w-full rounded-md" />
              ) : (
                <ul className="space-y-2">
                  {pendingInvites.map((invite) => {
                    const busy = pendingInviteBusyIds.has(invite.invite_id);
                    return (
                      <li key={invite.invite_id} className={MEMBER_ROW}>
                        <span className="bg-kortix-orange/10 text-kortix-orange inline-flex size-8 shrink-0 items-center justify-center rounded-sm border">
                          <Mail className="size-4" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-foreground truncate text-sm font-medium">
                              {invite.email}
                            </span>
                            <Badge variant="outline" size="sm" className="capitalize">
                              {invite.project_role}
                            </Badge>
                          </div>
                          <InlineMeta>
                            <span className="tabular-nums">
                              Invited {formatDate(invite.created_at)}
                            </span>
                            {invite.invite_expired ? (
                              <span className="text-kortix-orange">Link expired</span>
                            ) : (
                              <span className="inline-flex items-center gap-1 tabular-nums">
                                <Clock className="size-3" />
                                Expires {formatDate(invite.invite_expires_at)}
                              </span>
                            )}
                          </InlineMeta>
                        </div>
                        {busy ? (
                          <Loading className="text-muted-foreground shrink-0" />
                        ) : canManageMembers ? (
                          <div className="flex shrink-0 items-center gap-1.5">
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() => onResendInvite(invite)}
                              className="gap-1.5"
                            >
                              <RefreshCw className="size-3.5" />
                              Resend
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() => onRequestRevokeInvite(invite)}
                              className="gap-1.5"
                            >
                              <X className="size-3.5" />
                              Revoke
                            </Button>
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          ) : null}

          {showAccountInvites ? (
            <section className="space-y-4">
              <SettingsSubsectionHeader
                title="Invited to this account"
                description="They still need to sign up. Once they do, you can add them to workspaces."
                action={
                  canManageAccountInvites ? (
                    <Button
                      type="button"
                      size="sm"
                      onClick={onOpenAccountInvite}
                      className="gap-1.5"
                    >
                      <Plus className="size-3.5" />
                      Invite
                    </Button>
                  ) : undefined
                }
              />
              {isAccountInvitesLoading ? (
                <Skeleton className="h-14 w-full rounded-md" />
              ) : accountInvites.length === 0 ? (
                <p className="text-muted-foreground text-xs">Nobody is waiting to sign up.</p>
              ) : (
                <ul className="space-y-2">
                  {accountInvites.map((invite) => {
                    const busy = accountInviteBusyIds.has(invite.invite_id);
                    return (
                      <li key={invite.invite_id} className={MEMBER_ROW}>
                        <span className="bg-kortix-orange/10 text-kortix-orange inline-flex size-8 shrink-0 items-center justify-center rounded-sm border">
                          <Mail className="size-4" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-foreground truncate text-sm font-medium">
                              {invite.email}
                            </span>
                            <Badge variant="outline" size="sm" className="capitalize">
                              {invite.initial_role}
                            </Badge>
                          </div>
                          <InlineMeta>
                            <span className="tabular-nums">
                              Invited {formatDate(invite.created_at)}
                            </span>
                            <span className="inline-flex items-center gap-1 tabular-nums">
                              <Clock className="size-3" />
                              Expires {formatDate(invite.expires_at)}
                            </span>
                          </InlineMeta>
                        </div>
                        {busy ? (
                          <Loading className="text-muted-foreground shrink-0" />
                        ) : canManageAccountInvites ? (
                          <div className="flex shrink-0 items-center gap-1.5">
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() => onResendAccountInvite(invite)}
                              className="gap-1.5"
                            >
                              <RefreshCw className="size-3.5" />
                              Resend
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() => onRequestCancelAccountInvite(invite)}
                              className="gap-1.5"
                            >
                              <X className="size-3.5" />
                              Cancel
                            </Button>
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          ) : null}

          {showAccessRequests ? (
            <section className="space-y-4">
              <SettingsSubsectionHeader
                title="Asked to join"
                description="They requested access to this workspace. Approve to let them in."
              />
              {isAccessRequestsLoading ? (
                <Skeleton className="h-14 w-full rounded-md" />
              ) : (
                <ul className="space-y-2">
                  {accessRequests.map((request) => {
                    const busy = accessRequestBusyIds.has(request.request_id);
                    return (
                      <li key={request.request_id} className={MEMBER_ROW}>
                        <span className="bg-kortix-yellow/10 text-kortix-yellow inline-flex size-8 shrink-0 items-center justify-center rounded-sm border">
                          <Mail className="size-4" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <span className="text-foreground truncate text-sm font-medium">
                            {request.requester_email}
                          </span>
                          <InlineMeta>
                            <span className="tabular-nums">
                              Requested {formatDate(request.created_at)}
                            </span>
                            {request.message ? <span>"{request.message}"</span> : null}
                          </InlineMeta>
                        </div>
                        {busy ? (
                          <Loading className="text-muted-foreground shrink-0" />
                        ) : (
                          <div className="flex shrink-0 items-center gap-1.5">
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() => onApproveRequest(request)}
                              className="gap-1.5"
                            >
                              <Check className="size-3.5" />
                              Approve
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              onClick={() => onRejectRequest(request)}
                              className="gap-1.5"
                            >
                              <X className="size-3.5" />
                              Decline
                            </Button>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          ) : null}

          {!showPendingInvites && !showAccountInvites && !showAccessRequests ? (
            <EmptyState
              icon={Mail}
              title="Nobody is waiting"
              description="Invitations you send, and requests to join, appear here until they are accepted."
            />
          ) : null}
        </TabsContent>

        {/* ── Access ────────────────────────────────────────────────────── */}
        {/* Who can USE which agent — the one project-scoped resource concern
            this tab owns. Nothing is re-derived here; this tab only decides
            where the card sits, behind the same gate the container already
            passed it under. See this file's header comment for why group
            role assignment and custom-role binding live on their account-
            level pages instead of a second copy here. */}
        <TabsContent value="access" className="space-y-8">
          {showAccessCards ? (
            resourceAccessSlot
          ) : (
            /* The same muted row the card uses when its own list is empty —
               not a second, illustrated way of saying "nothing here". A
               viewer who can see no access card at all reads one row, in the
               same bordered group, at the same height. */
            <SettingsRowGroup>
              <SettingsEmptyRow
                label="No extra access rules"
                description="Agent assignments for this workspace appear here."
              />
            </SettingsRowGroup>
          )}
        </TabsContent>
      </Tabs>

      <ConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) onCancelRemove();
        }}
        title="Remove member?"
        description={
          removeTarget ? (
            <span>
              <strong>{userLabel(removeTarget)}</strong> will lose access to this project.
            </span>
          ) : null
        }
        confirmLabel="Remove"
        confirmVariant="destructive"
        isPending={isRemovePending}
        onConfirm={onConfirmRemove}
      />

      <ConfirmDialog
        open={revokeInviteTarget !== null}
        onOpenChange={(open) => {
          if (!open) onCancelRevokeInvite();
        }}
        title="Revoke invitation?"
        description={
          revokeInviteTarget ? (
            <span>
              The invitation to <strong>{revokeInviteTarget.email}</strong> will be cancelled.
            </span>
          ) : null
        }
        confirmLabel="Revoke"
        confirmVariant="destructive"
        isPending={isRevokeInvitePending}
        onConfirm={onConfirmRevokeInvite}
      />

      <ConfirmDialog
        open={cancelAccountInviteTarget !== null}
        onOpenChange={(open) => {
          if (!open) onCancelCancelAccountInvite();
        }}
        title="Cancel invite"
        description={
          cancelAccountInviteTarget ? (
            <span>
              Revoke the pending invite for <strong>{cancelAccountInviteTarget.email}</strong>?
              They&apos;ll need a new invite to join.
            </span>
          ) : null
        }
        confirmLabel="Cancel invite"
        confirmVariant="destructive"
        isPending={isCancelAccountInvitePending}
        onConfirm={onConfirmCancelAccountInvite}
      />

      <ConfirmDialog
        open={leaveAccountOpen}
        onOpenChange={(open) => {
          if (!open) onCancelLeaveAccount();
        }}
        title="Leave account"
        description={
          <span>
            You&apos;ll lose access to <strong>{accountName || 'this account'}</strong> and its
            projects.
          </span>
        }
        confirmLabel="Leave"
        confirmVariant="destructive"
        isPending={isLeaveAccountPending}
        onConfirm={onConfirmLeaveAccount}
      />

      {/* JAY-549 — see this file's header comment, "JAY-549". Role-change
          uses the default (non-destructive) variant, matching page.tsx's own
          choice; removal uses "destructive", matching this file's own
          established dialect for every other removal dialog above. */}
      <ConfirmDialog
        open={accountRoleChangeTarget !== null}
        onOpenChange={(open) => {
          if (!open) onCancelAccountRoleChange();
        }}
        title="Change account role"
        description={
          accountRoleChangeTarget ? (
            <span>
              Change <strong>{userLabel(accountRoleChangeTarget.member)}</strong> to{' '}
              <strong>{ACCOUNT_ROLE_DESCRIPTORS[accountRoleChangeTarget.role].label}</strong>.{' '}
              {ACCOUNT_ROLE_DESCRIPTORS[accountRoleChangeTarget.role].blurb}
            </span>
          ) : null
        }
        confirmLabel="Change role"
        isPending={isAccountRoleChangePending}
        onConfirm={onConfirmAccountRoleChange}
      />

      <ConfirmDialog
        open={accountRemoveTarget !== null}
        onOpenChange={(open) => {
          if (!open) onCancelRemoveFromAccount();
        }}
        title="Remove from account?"
        description={
          accountRemoveTarget ? (
            <span>
              <strong>{userLabel(accountRemoveTarget)}</strong> will lose access to this account and
              its projects immediately.
            </span>
          ) : null
        }
        confirmLabel="Remove"
        confirmVariant="destructive"
        isPending={isAccountRemovePending}
        onConfirm={onConfirmRemoveFromAccount}
      />

      {inviteDialogSlot}
      {accountInviteDialogSlot}
    </CapabilityPageShell>
  );
}

/** Container entry point. Resolves the account id once (same
 *  `useSettingsAccountId` shape as `organization-tab.tsx`/`billing-tab.tsx`/
 *  every other account-scoped tab — never `project?.account_id` alone, see
 *  that hook's header comment for why), then hands off to `MembersTabInner`
 *  so every hook below only runs while this tab is actually mounted —
 *  `SettingsTabPane` in `settings-panel.tsx` guarantees that only happens
 *  while this tab is the active one. */
export function MembersTab({ projectId, accountId }: { projectId: string; accountId?: string }) {
  const resolvedAccountId = useSettingsAccountId(accountId);
  return <MembersTabInner projectId={projectId} accountId={resolvedAccountId} />;
}

function MembersTabInner({
  projectId,
  accountId,
}: {
  projectId: string;
  /** Resolved via `useSettingsAccountId` in `MembersTab` above — feeds ONLY
   *  the two new account-scoped sections (account invites, leave account).
   *  Deliberately separate from `project?.account_id` below (from this
   *  file's own `projectQuery`), which feeds the three REHOMED cards' gates
   *  — those are preserved exactly as `members-view.tsx` passed them and
   *  must not be re-derived from a different source. See this file's header
   *  comment, "JAY-548". */
  accountId: string | undefined;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { user } = useAuth();
  // Invite deep-link intent (e.g. Cmd+K "Invite members" —
  // `command-palette.tsx:1146`, `openSettings('members', { membersTab:
  // 'invite' })`). `membersTab` is a ONE-SHOT instruction, not persistent
  // state — see `consumeMembersTabIntent`'s doc comment in
  // `members-view.tsx`, and the JAY-530 stale-intent fix it documents.
  // Consumed and cleared together below (`useEffect`), same shape
  // `MembersView` used before this task's rewire unmounted it — that
  // producer (`command-palette.tsx:1146`) never stopped firing, only the
  // consumer went away, which is the bug this wiring restores.
  const { membersTab: requestedMembersTab, activeTab, navigate } = useSettingsNav();

  // project.members.manage — the single leaf every write control on this
  // page gates on. See this file's header comment.
  const { allowed: canManageMembers } = useProjectCan(
    projectId,
    PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE,
  );

  const accessQuery = useQuery({
    queryKey: qk.project.access(projectId),
    queryFn: () => listProjectAccess(projectId),
    ...contract('inventory'),
  });

  // Feeds `canManage` below, and the three rehomed cards' own gate — see
  // this file's header comment, "Rehomed from MembersView". Same query
  // `members-view.tsx`'s `MembersView` ran for the identical purpose
  // (`qk.project.summary(projectId)` / `getProject`).
  const projectQuery = useQuery({
    queryKey: qk.project.summary(projectId),
    queryFn: () => getProject(projectId),
    ...contract('config'),
  });
  const project = projectQuery.data;
  // Mined verbatim from `members-view.tsx`'s `MembersView` — NOT re-derived
  // from `canManageMembers` above. Deliberately a SEPARATE boolean:
  // `canManageMembers` (this file's own accepted deviation, `project.members.manage`
  // via `useProjectCan`) gates this tab's OWN table/invite/pending-invite/
  // access-request controls; `canManage` here is preserved EXACTLY as the
  // three rehomed cards received it before this move, so their access gate
  // cannot silently drift from what they shipped with.
  const canManage = project?.effective_project_role === 'manager' || accessQuery.data?.can_manage;

  const pendingInvitesQuery = useQuery({
    queryKey: qk.project.pendingInvites(projectId),
    queryFn: () => listPendingProjectInvites(projectId),
    ...contract('inventory'),
    enabled: canManageMembers,
  });

  const accessRequestsQuery = useQuery({
    queryKey: qk.project.accessRequests(projectId),
    queryFn: () => listProjectAccessRequests(projectId),
    ...contract('inventory'),
    enabled: canManageMembers,
  });

  function invalidateAccess() {
    queryClient.invalidateQueries({ queryKey: qk.project.access(projectId) });
    queryClient.invalidateQueries({ queryKey: qk.projects.scope() });
    queryClient.invalidateQueries({ queryKey: qk.project.summary(projectId) });
  }

  const [pendingUserIds, setPendingUserIds] = useState<Set<string>>(() => new Set());
  const markUserPending = (id: string) => setPendingUserIds((prev) => new Set(prev).add(id));
  const clearUserPending = (id: string) =>
    setPendingUserIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });

  const updateMutation = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: ProjectRole }) =>
      updateProjectAccess(projectId, userId, role),
    onMutate: ({ userId }) => markUserPending(userId),
    onSettled: (_data, _error, vars) => clearUserPending(vars.userId),
    onSuccess: () => {
      successToast('Access updated');
      invalidateAccess();
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to update access'),
  });

  const [removeTarget, setRemoveTarget] = useState<ProjectAccessMember | null>(null);
  const removeMutation = useMutation({
    mutationFn: (userId: string) => revokeProjectAccess(projectId, userId),
    onMutate: (userId) => markUserPending(userId),
    onSettled: (_data, _error, userId) => clearUserPending(userId),
    onSuccess: () => {
      successToast('Access removed');
      invalidateAccess();
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to remove access'),
  });

  function handleRoleChange(member: ProjectAccessMember, role: ProjectRole | typeof NO_ACCESS) {
    if (!canManageMembers || member.has_implicit_access) return;
    if (role === NO_ACCESS) {
      setRemoveTarget(member);
      return;
    }
    updateMutation.mutate({ userId: member.user_id, role });
  }

  const [inviteOpen, setInviteOpen] = useState(false);
  // Which of the three underline tabs is showing. Local, not persisted:
  // reopening the pane should land on People, the thing you came for.
  const [section, setSection] = useState<MembersSection>('people');
  const [memberSearch, setMemberSearch] = useState('');

  // Consume-and-clear in one shot (JAY-530 shape — see the comment above
  // `requestedMembersTab`). Only ever runs while THIS tab is the active
  // one: `MembersTabInner` is only ever constructed by `MembersTab`, which
  // `SettingsTabPane` (`settings-panel.tsx`) only renders past its own
  // `if (!active) return null;` guard — confirmed by reading that gate
  // directly, not assumed (there is no other call site: `grep -rn
  // "<MembersTab\b" src` outside tests matches only
  // `settings-panel.tsx`'s `case 'members'`). So this effect neither fires
  // nor opens the dialog for an inactive pane; it fires once per activation
  // (and on a `membersTab`/`activeTab`/`navigate` identity change while
  // active), exactly mirroring `MembersView`'s own former effect.
  useEffect(() => {
    const consumed = consumeMembersTabIntent({
      membersTab: requestedMembersTab,
      activeTab,
      navigate,
    });
    if (consumed) {
      // The project Invite button lives on the People tab, so the deep link
      // must land there before the dialog opens — otherwise dismissing the
      // dialog would drop the user on whichever tab they last left behind,
      // with no visible trace of what they asked for. See this file's header
      // comment, "The Cmd+K deep link still lands".
      setSection('people');
      setInviteOpen(true);
    }
  }, [requestedMembersTab, activeTab, navigate]);

  const [pendingInviteBusyIds, setPendingInviteBusyIds] = useState<Set<string>>(() => new Set());
  const markInvitePending = (id: string) =>
    setPendingInviteBusyIds((prev) => new Set(prev).add(id));
  const clearInvitePending = (id: string) =>
    setPendingInviteBusyIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  const [revokeInviteTarget, setRevokeInviteTarget] = useState<PendingProjectInvite | null>(null);

  const { copy } = useCopy({
    successMessage: 'Invite link copied',
    errorMessage: 'Could not copy link',
  });

  const resendInviteMutation = useMutation({
    mutationFn: (inviteId: string) => resendPendingProjectInvite(projectId, inviteId),
    onMutate: (inviteId) => markInvitePending(inviteId),
    onSettled: (_data, _error, inviteId) => clearInvitePending(inviteId),
    onSuccess: (result) => {
      if (result.email_sent) {
        successToast('Invite email sent');
      } else {
        warningToast('Email skipped — copy the invite link to share manually', {
          duration: 8_000,
          button: (
            <Button size="sm" onClick={() => copy(result.invite_url)}>
              Copy link
            </Button>
          ),
        });
      }
      queryClient.invalidateQueries({ queryKey: qk.project.pendingInvites(projectId) });
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to resend invitation'),
  });

  const revokeInviteMutation = useMutation({
    mutationFn: (inviteId: string) => revokePendingProjectInvite(projectId, inviteId),
    onMutate: (inviteId) => markInvitePending(inviteId),
    onSettled: (_data, _error, inviteId) => clearInvitePending(inviteId),
    onSuccess: (result) => {
      successToast(
        result.invitation_cancelled
          ? 'Invitation cancelled.'
          : 'Project access removed from invitation.',
      );
      queryClient.invalidateQueries({ queryKey: qk.project.pendingInvites(projectId) });
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to revoke invitation'),
  });

  const [accessRequestBusyIds, setAccessRequestBusyIds] = useState<Set<string>>(() => new Set());
  const markRequestBusy = (id: string) => setAccessRequestBusyIds((prev) => new Set(prev).add(id));
  const clearRequestBusy = (id: string) =>
    setAccessRequestBusyIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });

  const approveMutation = useMutation({
    mutationFn: (requestId: string) => approveProjectAccessRequest(projectId, requestId, 'member'),
    onMutate: (requestId) => markRequestBusy(requestId),
    onSettled: (_data, _error, requestId) => clearRequestBusy(requestId),
    onSuccess: (result) => {
      successToast(`${result.member.email ?? 'Requester'} can now view this project`);
      queryClient.invalidateQueries({ queryKey: qk.project.accessRequests(projectId) });
      invalidateAccess();
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to approve request'),
  });

  const rejectMutation = useMutation({
    mutationFn: (requestId: string) => rejectProjectAccessRequest(projectId, requestId),
    onMutate: (requestId) => markRequestBusy(requestId),
    onSettled: (_data, _error, requestId) => clearRequestBusy(requestId),
    onSuccess: () => {
      successToast('Access request declined');
      queryClient.invalidateQueries({ queryKey: qk.project.accessRequests(projectId) });
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to decline request'),
  });

  // ── JAY-548: the two account-scoped surfaces orphaned by
  // `accounts/[id]/page.tsx`'s deletion — see this file's header comment. ──

  // member.invite — the SAME leaf `page.tsx`'s `canInviteMember`
  // (`ACCOUNT_PERMISSION_PROBES`) gated `PendingInvitesSection`'s row
  // actions on. A DIFFERENT leaf from `canManageMembers` above
  // (`project.members.manage`) — never re-derived from it.
  const { allowed: canManageAccountInvites } = usePermission(accountId, 'member.invite');

  // Account name — only for this tab's own "Leave {name}" copy and the
  // leave-confirm dialog. Same `['account', accountId]` key
  // `organization-tab.tsx`/`groups-tab.tsx` use, so it's warm if the viewer
  // already opened one of those tabs this session.
  const accountQuery = useQuery({
    queryKey: ['account', accountId],
    queryFn: () => getAccount(accountId!),
    enabled: !!accountId,
    staleTime: 30_000,
  });

  const accountInvitesQuery = useQuery({
    queryKey: ['account-invites', accountId],
    queryFn: () => listAccountInvites(accountId!),
    enabled: !!accountId,
    staleTime: 20_000,
  });

  function invalidateAccountInvites() {
    queryClient.invalidateQueries({ queryKey: ['account-invites', accountId] });
  }

  const [accountInviteBusyIds, setAccountInviteBusyIds] = useState<Set<string>>(() => new Set());
  const markAccountInviteBusy = (id: string) =>
    setAccountInviteBusyIds((prev) => new Set(prev).add(id));
  const clearAccountInviteBusy = (id: string) =>
    setAccountInviteBusyIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });

  const resendAccountInviteMutation = useMutation({
    mutationFn: (inviteId: string) => resendAccountInvite(accountId!, inviteId),
    onMutate: (inviteId) => markAccountInviteBusy(inviteId),
    onSettled: (_data, _error, inviteId) => clearAccountInviteBusy(inviteId),
    onSuccess: (result) => {
      if (result.email_sent) {
        successToast('Invite email sent');
      } else {
        warningToast('Email skipped — copy the invite link to share manually', {
          duration: 8_000,
          button: (
            <Button size="sm" onClick={() => copy(result.invite_url)}>
              Copy link
            </Button>
          ),
        });
      }
      invalidateAccountInvites();
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to resend invite'),
  });

  const [cancelAccountInviteTarget, setCancelAccountInviteTarget] =
    useState<AccountInvitation | null>(null);
  const cancelAccountInviteMutation = useMutation({
    mutationFn: (inviteId: string) => cancelAccountInvite(accountId!, inviteId),
    onMutate: (inviteId) => markAccountInviteBusy(inviteId),
    onSettled: (_data, _error, inviteId) => clearAccountInviteBusy(inviteId),
    onSuccess: () => {
      successToast('Invite cancelled');
      invalidateAccountInvites();
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to cancel invite'),
  });

  // leaveAccount — self-directed (see this file's header comment). NO
  // permission probe gates this: whether the CURRENT user can leave their
  // own account is not an IAM leaf at all, just "are you the sole owner".
  // `isLastOwner` is computed from the SAME account roster the table above
  // already renders (`accessQuery.data.members` — every account member,
  // with `account_role`, per this file's header comment) rather than a
  // second fetch.
  const accountRoster = accessQuery.data?.members ?? [];
  const currentAccountRole = accountRoster.find((m) => m.user_id === user?.id)?.account_role;
  const ownerCount = accountRoster.filter((m) => m.account_role === 'owner').length;
  const isLastOwner = currentAccountRole === 'owner' && ownerCount <= 1;

  const [leaveAccountOpen, setLeaveAccountOpen] = useState(false);
  const leaveAccountMutation = useMutation({
    mutationFn: () => leaveAccount(accountId!),
    onSuccess: () => {
      successToast(`Left ${accountQuery.data?.name ?? 'account'}`);
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      // `/accounts/[id]` is the page this panel replaced. After leaving, the
      // account's settings are no longer yours to see, so land on the landing
      // door — NOT the remembered project, which names a project in the
      // account just left. Same rule `account-switcher.tsx` and
      // `command-palette.tsx` follow when the account context changes.
      router.push(PROJECT_LANDING_PATH);
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to leave account'),
  });

  // ── JAY-549: inviteAccountMember / updateAccountMemberRole /
  // removeAccountMember — the three genuinely-orphaned functions this task
  // exists to close. See this file's header comment, "JAY-549". Gates
  // copied byte-for-byte from `page.tsx`'s `ACCOUNT_PERMISSION_PROBES`,
  // never re-derived from `canManageMembers` (project.members.manage) or
  // `canManageAccountInvites` above. ──

  // member.update — page.tsx's canUpdateMember (`page.tsx:327`).
  const { allowed: canUpdateAccountRole } = usePermission(accountId, 'member.update');
  // member.remove — page.tsx's canRemoveMember (`page.tsx:326`).
  const { allowed: canRemoveFromAccount } = usePermission(accountId, 'member.remove');

  // Separate busy-set from `pendingUserIds` above — that one belongs to the
  // project-role column's own mutations. Sharing it would show a
  // misleading "workspace access is changing" spinner during an
  // account-scope mutation.
  const [accountPendingUserIds, setAccountPendingUserIds] = useState<Set<string>>(() => new Set());
  const markAccountRowPending = (id: string) =>
    setAccountPendingUserIds((prev) => new Set(prev).add(id));
  const clearAccountRowPending = (id: string) =>
    setAccountPendingUserIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });

  const [accountRoleChangeTarget, setAccountRoleChangeTarget] = useState<{
    member: ProjectAccessMember;
    role: AccountRole;
  } | null>(null);
  const accountRoleMutation = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: AccountRole }) =>
      updateAccountMemberRole(accountId!, userId, role),
    onMutate: ({ userId }) => markAccountRowPending(userId),
    onSettled: (_data, _error, vars) => clearAccountRowPending(vars.userId),
    onSuccess: () => {
      successToast('Role updated');
      // listProjectAccess left-joins account_role — invalidating the SAME
      // query the table already reads re-fetches this row's new role.
      invalidateAccess();
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to update role'),
  });

  const [accountRemoveTarget, setAccountRemoveTarget] = useState<ProjectAccessMember | null>(null);
  const accountRemoveMutation = useMutation({
    mutationFn: (userId: string) => removeAccountMember(accountId!, userId),
    onMutate: (userId) => markAccountRowPending(userId),
    onSettled: (_data, _error, userId) => clearAccountRowPending(userId),
    onSuccess: () => {
      successToast('Removed from account');
      invalidateAccess();
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to remove member'),
  });

  const [accountInviteOpen, setAccountInviteOpen] = useState(false);

  return (
    <MembersTabView
      section={section}
      onSectionChange={setSection}
      memberSearch={memberSearch}
      onMemberSearchChange={setMemberSearch}
      isLoading={accessQuery.isLoading}
      isError={accessQuery.isError}
      errorMessage={(accessQuery.error as Error)?.message ?? ''}
      onRetry={() => accessQuery.refetch()}
      members={accessQuery.data?.members ?? []}
      canManageMembers={canManageMembers}
      pendingUserIds={pendingUserIds}
      onRoleChange={handleRoleChange}
      onRequestRemove={(member) => setRemoveTarget(member)}
      removeTarget={removeTarget}
      onCancelRemove={() => setRemoveTarget(null)}
      onConfirmRemove={() => {
        if (!removeTarget) return;
        const target = removeTarget;
        setRemoveTarget(null);
        removeMutation.mutate(target.user_id);
      }}
      isRemovePending={removeMutation.isPending}
      onOpenInvite={() => setInviteOpen(true)}
      permissionsHelpSlot={<PermissionsHelpPopover align="end" accountId={accountId} />}
      pendingInvites={pendingInvitesQuery.data?.pending ?? []}
      isPendingInvitesLoading={canManageMembers && pendingInvitesQuery.isLoading}
      pendingInviteBusyIds={pendingInviteBusyIds}
      onResendInvite={(invite) => resendInviteMutation.mutate(invite.invite_id)}
      onRequestRevokeInvite={(invite) => setRevokeInviteTarget(invite)}
      revokeInviteTarget={revokeInviteTarget}
      onCancelRevokeInvite={() => setRevokeInviteTarget(null)}
      onConfirmRevokeInvite={() => {
        if (!revokeInviteTarget) return;
        const target = revokeInviteTarget;
        setRevokeInviteTarget(null);
        revokeInviteMutation.mutate(target.invite_id);
      }}
      isRevokeInvitePending={revokeInviteMutation.isPending}
      accessRequests={accessRequestsQuery.data?.requests ?? []}
      isAccessRequestsLoading={canManageMembers && accessRequestsQuery.isLoading}
      accessRequestBusyIds={accessRequestBusyIds}
      onApproveRequest={(request) => approveMutation.mutate(request.request_id)}
      onRejectRequest={(request) => rejectMutation.mutate(request.request_id)}
      inviteDialogSlot={
        <InviteMemberDialog
          projectId={projectId}
          open={inviteOpen}
          onOpenChange={setInviteOpen}
          onInvited={invalidateAccess}
        />
      }
      // Gate preserved EXACTLY as `members-view.tsx` passed it at its own
      // mount site (see this file's header comment): manager-only DATA, the
      // grants list route denies non-managers. Group-role assignment and
      // custom-role binding used to render here too — removed, not hidden;
      // see this file's header comment for where they live now.
      resourceAccessSlot={
        project?.account_id && canManage ? (
          <ResourceAccessCard projectId={projectId} canManage={!!canManage} />
        ) : undefined
      }
      accountId={accountId}
      accountInvites={accountInvitesQuery.data ?? []}
      isAccountInvitesLoading={!!accountId && accountInvitesQuery.isLoading}
      accountInviteBusyIds={accountInviteBusyIds}
      canManageAccountInvites={canManageAccountInvites}
      onResendAccountInvite={(invite) => resendAccountInviteMutation.mutate(invite.invite_id)}
      onRequestCancelAccountInvite={(invite) => setCancelAccountInviteTarget(invite)}
      cancelAccountInviteTarget={cancelAccountInviteTarget}
      onCancelCancelAccountInvite={() => setCancelAccountInviteTarget(null)}
      onConfirmCancelAccountInvite={() => {
        if (!cancelAccountInviteTarget) return;
        const target = cancelAccountInviteTarget;
        setCancelAccountInviteTarget(null);
        cancelAccountInviteMutation.mutate(target.invite_id);
      }}
      isCancelAccountInvitePending={cancelAccountInviteMutation.isPending}
      accountName={accountQuery.data?.name}
      isAccountRosterLoading={!!accountId && accessQuery.isLoading}
      isLastOwner={isLastOwner}
      leaveAccountOpen={leaveAccountOpen}
      onOpenLeaveAccount={() => setLeaveAccountOpen(true)}
      onCancelLeaveAccount={() => setLeaveAccountOpen(false)}
      onConfirmLeaveAccount={() => {
        setLeaveAccountOpen(false);
        leaveAccountMutation.mutate();
      }}
      isLeaveAccountPending={leaveAccountMutation.isPending}
      currentUserId={user?.id}
      canUpdateAccountRole={canUpdateAccountRole}
      canRemoveFromAccount={canRemoveFromAccount}
      accountPendingUserIds={accountPendingUserIds}
      accountRoleChangeTarget={accountRoleChangeTarget}
      onRequestAccountRoleChange={(member, role) => setAccountRoleChangeTarget({ member, role })}
      onCancelAccountRoleChange={() => setAccountRoleChangeTarget(null)}
      onConfirmAccountRoleChange={() => {
        if (!accountRoleChangeTarget) return;
        const { member, role } = accountRoleChangeTarget;
        setAccountRoleChangeTarget(null);
        accountRoleMutation.mutate({ userId: member.user_id, role });
      }}
      isAccountRoleChangePending={accountRoleMutation.isPending}
      accountRemoveTarget={accountRemoveTarget}
      onRequestRemoveFromAccount={(member) => setAccountRemoveTarget(member)}
      onCancelRemoveFromAccount={() => setAccountRemoveTarget(null)}
      onConfirmRemoveFromAccount={() => {
        if (!accountRemoveTarget) return;
        const target = accountRemoveTarget;
        setAccountRemoveTarget(null);
        accountRemoveMutation.mutate(target.user_id);
      }}
      isAccountRemovePending={accountRemoveMutation.isPending}
      onOpenAccountInvite={() => setAccountInviteOpen(true)}
      accountInviteDialogSlot={
        accountId ? (
          <InviteToAccountDialog
            accountId={accountId}
            open={accountInviteOpen}
            onOpenChange={setAccountInviteOpen}
            onInvited={invalidateAccountInvites}
          />
        ) : undefined
      }
    />
  );
}

/** New-invite composer — a single email + role, not `members-view.tsx`'s
 *  `InviteMemberCard` (bulk multi-email chip input) ported verbatim. That
 *  component is not exported and this task's Files list does not include
 *  `members-view.tsx`, so it is rebuilt smaller rather than reused — see
 *  this file's header comment for the capabilities this deliberately does
 *  NOT carry forward. Owns its own `useMutation`/`useState`, so it's a slot
 *  on `MembersTabView` — see that prop's doc comment. */
function InviteMemberDialog({
  projectId,
  open,
  onOpenChange,
  onInvited,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInvited: () => void;
}) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<ProjectRole>('member');
  const { copy } = useCopy({
    successMessage: 'Invite link copied',
    errorMessage: 'Could not copy link',
  });

  const mutation = useMutation({
    mutationFn: () => inviteProjectMember(projectId, email.trim(), role, null),
    onSuccess: (result) => {
      if (isInviteSent(result)) {
        if (result.email_sent) {
          successToast(
            `Invitation sent to ${result.email}. They'll land on this project as ${result.project_role} when they sign up.`,
          );
        } else {
          const inviteUrl = result.invite_url;
          warningToast(
            `Invitation created for ${result.email} — email skipped. Share the invite link manually.`,
            {
              duration: 10_000,
              button: (
                <Button size="sm" onClick={() => copy(inviteUrl)}>
                  Copy link
                </Button>
              ),
            },
          );
        }
        queryClient.invalidateQueries({ queryKey: qk.project.pendingInvites(projectId) });
      } else {
        successToast('Member added');
        onInvited();
      }
      setEmail('');
      setRole('member');
      onOpenChange(false);
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to invite member'),
  });

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const canSubmit = EMAIL_RE.test(email.trim()) && !mutation.isPending;

  return (
    <Modal open={open} onOpenChange={(o) => !mutation.isPending && onOpenChange(o)}>
      <ModalContent className="lg:max-w-md">
        <ModalHeader>
          <ModalTitle>Invite a member</ModalTitle>
          <ModalDescription>They'll get project access at the role you pick.</ModalDescription>
        </ModalHeader>
        <ModalBody className="space-y-4">
          <Field className="gap-1.5">
            <FieldLabel htmlFor="invite-member-email">Email</FieldLabel>
            <Input
              id="invite-member-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="teammate@example.com"
              disabled={mutation.isPending}
              autoFocus
              variant="popover"
            />
          </Field>
          <Field className="gap-1.5">
            <FieldLabel htmlFor="invite-member-role">Role</FieldLabel>
            <Select
              value={role}
              onValueChange={(next) => setRole(next as ProjectRole)}
              disabled={mutation.isPending}
            >
              <SelectTrigger id="invite-member-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <ProjectRoleSelectItem role="member" />
                <ProjectRoleSelectItem role="editor" />
                <ProjectRoleSelectItem role="manager" />
              </SelectContent>
            </Select>
          </Field>
        </ModalBody>
        <ModalFooter className="sm:justify-between">
          <Button
            type="button"
            variant="outline-ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={mutation.isPending}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => mutation.mutate()}
            disabled={!canSubmit}
            className="gap-1.5"
          >
            {mutation.isPending && <Loading className="size-3.5 shrink-0" />}
            Invite
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

/** Invite-to-ACCOUNT composer — a single email + `AccountRole`, mirroring
 *  `InviteMemberDialog` above's shape rather than `page.tsx`'s
 *  `InviteMemberModal` (bulk multi-email chip composer) ported verbatim.
 *  See this file's header comment, "JAY-549", for why. Calls
 *  `inviteAccountMember` — the first other caller besides `page.tsx`. Owns
 *  its own `useMutation`, so it's a slot on `MembersTabView`
 *  (`accountInviteDialogSlot`), same reasoning as `inviteDialogSlot`. */
function InviteToAccountDialog({
  accountId,
  open,
  onOpenChange,
  onInvited,
}: {
  accountId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInvited: () => void;
}) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<AccountRole>('member');
  const { copy } = useCopy({
    successMessage: 'Invite link copied',
    errorMessage: 'Could not copy link',
  });

  const mutation = useMutation({
    mutationFn: () => inviteAccountMember(accountId, { email: email.trim(), role }),
    onSuccess: (result) => {
      if (result.status === 'pending') {
        if (result.email_sent) {
          successToast(`Invite sent to ${result.email}`);
        } else {
          const inviteUrl = result.invite_url;
          warningToast('Invite created — email skipped. Share the link manually.', {
            duration: 10_000,
            button: (
              <Button size="sm" onClick={() => copy(inviteUrl)}>
                Copy link
              </Button>
            ),
          });
        }
      } else {
        successToast(`Added ${result.email}`);
      }
      onInvited();
      setEmail('');
      setRole('member');
      onOpenChange(false);
    },
    onError: (error: Error) => {
      const status = (error as Error & { status?: number }).status;
      errorToast(
        status === 409
          ? `${email.trim()} is already a member of this account.`
          : error.message || 'Failed to invite member',
      );
    },
  });

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const canSubmit = EMAIL_RE.test(email.trim()) && !mutation.isPending;

  return (
    <Modal open={open} onOpenChange={(o) => !mutation.isPending && onOpenChange(o)}>
      <ModalContent className="lg:max-w-md">
        <ModalHeader>
          <ModalTitle>Invite to account</ModalTitle>
          <ModalDescription>They&apos;ll get account access at the role you pick.</ModalDescription>
        </ModalHeader>
        <ModalBody className="space-y-4">
          <Field className="gap-1.5">
            <FieldLabel htmlFor="invite-account-email">Email</FieldLabel>
            <Input
              id="invite-account-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="teammate@example.com"
              disabled={mutation.isPending}
              autoFocus
              variant="popover"
            />
          </Field>
          <Field className="gap-1.5">
            <FieldLabel htmlFor="invite-account-role">Role</FieldLabel>
            <Select
              value={role}
              onValueChange={(next) => setRole(next as AccountRole)}
              disabled={mutation.isPending}
            >
              <SelectTrigger id="invite-account-role">
                <SelectValue />
              </SelectTrigger>
              {/* `description`, not a concatenated "label — blurb" string.
                  Each option used to read its full sentence inline
                  ("Admin — Everything except deleting the account or
                  transferring ownership."), which wrapped to two lines per
                  row inside a `lg:max-w-md` modal and pushed the open
                  popover past the bottom of the screen. `SelectItem`'s own
                  `description` prop already renders label and blurb as two
                  properly-laid-out lines — the exact pattern
                  `ProjectRoleSelectItem` (`components/iam/role-select-item.tsx`)
                  uses for the project-role picker right below this one in the
                  same file. */}
              <SelectContent>
                <SelectItem value="member" description={ACCOUNT_ROLE_DESCRIPTORS.member.blurb}>
                  {ACCOUNT_ROLE_DESCRIPTORS.member.label}
                </SelectItem>
                <SelectItem value="admin" description={ACCOUNT_ROLE_DESCRIPTORS.admin.blurb}>
                  {ACCOUNT_ROLE_DESCRIPTORS.admin.label}
                </SelectItem>
                <SelectItem value="owner" description={ACCOUNT_ROLE_DESCRIPTORS.owner.blurb}>
                  {ACCOUNT_ROLE_DESCRIPTORS.owner.label}
                </SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </ModalBody>
        <ModalFooter className="sm:justify-between">
          <Button
            type="button"
            variant="outline-ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={mutation.isPending}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => mutation.mutate()}
            disabled={!canSubmit}
            className="gap-1.5"
          >
            {mutation.isPending && <Loading className="size-3.5 shrink-0" />}
            Invite
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Originally rehomed from `members-view.tsx` (moved, not copied) as three
// cards: `ProjectGroupGrantsCard`, `ResourceAccessCard`, and
// `ProjectRoleAssignmentsCard`. The group and custom-role cards are gone —
// removed, not hidden — once it became clear they were never a resource
// concern (Groups attached a plain ProjectRole, the exact op the People tab
// already does per-member; Custom roles bound an account-defined role) and
// both duplicated a proper account-level home that already existed: a
// group's own detail page's "Projects" tab
// (`accounts/[id]/groups/[groupId]`'s `GroupProjectGrantsCard`) and the
// account Roles page's `PolicyAssignments`, which can target ANY project,
// not just the one you happen to be on. `FilterChips`, `ScopeLine`,
// `BlastRadiusPreview`, and `ResourceAccessCard` below are what's left —
// mounted as a slot from `MembersTabInner` with its gate preserved EXACTLY
// as `members-view.tsx` passed it at its own mount site, using this file's
// own `MEMBER_ROW`/`formatDate`/`userLabel` (byte-identical definitions
// already declared above) instead of re-declaring them. Its PRESENTATION is
// the panel's own: a `SettingsSubsectionHeader` over one `SettingsRowGroup`,
// one `SettingsRow` per item.
// ─────────────────────────────────────────────────────────────────────────

/**
 * `InlineMeta`'s "·"-separated line, rebuilt out of phrasing content.
 *
 * A row's second line renders inside `SettingsRow`'s `description`, which is a
 * `FieldDescription` — a `<p>`. `InlineMeta`'s root is a `<div>`, which a `<p>`
 * may not contain: React would flag the nesting and the browser would close the
 * paragraph early, splitting the row's own text. Same separator, same rhythm,
 * `<span>` all the way down.
 */
function RowMeta({ children }: { children: ReactNode }) {
  const items = Children.toArray(children).filter((c) => c !== null && c !== undefined && c !== '');
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
      {items.map((child, i) => (
        <Fragment key={isValidElement(child) ? (child.key ?? i) : i}>
          {i > 0 ? <span className="text-muted-foreground/30">·</span> : null}
          <span className="min-w-0">{child}</span>
        </Fragment>
      ))}
    </span>
  );
}

/**
 * The loading placeholder for one row, inside the real `SettingsRowGroup`.
 *
 * Two bars in the label slot rather than a description bar: `FieldDescription`
 * is a `<p>` and `Skeleton` is a `<div>`. Both bars stack to about the height
 * of a label-plus-description row, so the group does not resize when the data
 * lands — a skeleton of a different height is the same flicker in another
 * costume.
 */
function SettingsRowSkeleton() {
  return (
    <SettingsRow
      label={
        <span className="flex flex-col gap-1.5">
          <Skeleton className="h-4 w-40 py-0" />
          <Skeleton className="h-3 w-56 py-0" />
        </span>
      }
    />
  );
}

/**
 * "There is nothing here", as a row.
 *
 * One muted `SettingsRow` inside the same `SettingsRowGroup` the items would
 * have filled — no icon, no illustration, no dashed box. The border and the
 * rhythm are then identical at zero items and at five, so a list that fills in
 * does not shove the section below it down the page.
 */
function SettingsEmptyRow({ label, description }: { label: string; description?: ReactNode }) {
  return (
    <SettingsRow
      label={<span className="text-muted-foreground font-normal">{label}</span>}
      description={description}
    />
  );
}

// ─── Per-resource scoping (agents/skills → member/group) ──────────────

/**
 * A row of filter pills shown above a long list (resource grants, role
 * bindings). Each pill carries its own count; the active one is solid. Render
 * only when there's more than one category to switch between — a single-category
 * list needs no filter chrome.
 */
function FilterChips<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; count: number }[];
}) {
  return (
    <div className="border-border/60 flex flex-wrap items-center gap-1.5 border-b px-6 py-2.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            // Press feedback: `active:scale-[0.96]` is this app's dominant
            // convention (123 of 148 `active:scale` usages) and the value the
            // design-system reference page uses. The transition names its
            // properties rather than using `transition-colors` alone, so the
            // scale actually animates — a bare `transition-colors` would snap.
            'flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium',
            'transition-[color,background-color,scale] duration-150 ease-out active:scale-[0.96]',
            value === o.value
              ? 'bg-foreground text-background'
              : 'bg-muted/50 text-muted-foreground hover:bg-muted',
          )}
        >
          {o.label}
          <span className={cn('tabular-nums', value === o.value ? 'opacity-70' : 'opacity-50')}>
            {o.count}
          </span>
        </button>
      ))}
    </div>
  );
}

/** One dimension (secrets / connectors) of an agent's declared scope. */
function ScopeLine({
  icon: Icon,
  label,
  items,
}: {
  icon: typeof KeyRound;
  label: string;
  items: string[];
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Icon className="text-muted-foreground/70 size-3.5 shrink-0" />
      <span className="text-muted-foreground text-[11px] font-medium">{label}</span>
      {items.map((n) => (
        <Badge key={n} variant="outline" size="xs" className="font-mono">
          {n}
        </Badge>
      ))}
    </div>
  );
}

/**
 * Blast-radius preview for an agent assignment: the concrete secrets + connectors
 * the assignee will INHERIT (the pyramid). `'all'` inherits nothing SPECIFIC (it
 * already means "everything they can see"), so only explicit lists show — mirrors
 * the backend's unionDeclaredResources.
 */
function BlastRadiusPreview({
  declares,
}: {
  declares: { secrets: string[] | 'all'; connectors: string[] | 'all' };
}) {
  const secrets = declares.secrets === 'all' ? [] : declares.secrets;
  const conns = declares.connectors === 'all' ? [] : declares.connectors;
  const nothingExtra = secrets.length === 0 && conns.length === 0;
  return (
    <div className="border-border/60 bg-muted/30 space-y-2 rounded-lg border p-3">
      <div className="flex items-center gap-1.5">
        <CornerDownRight className="text-muted-foreground/70 size-3.5 shrink-0" />
        <span className="text-foreground/80 text-xs font-medium">Assigning this also grants</span>
      </div>
      {nothingExtra ? (
        <p className="text-muted-foreground text-[11px] leading-relaxed">
          Nothing extra — this agent declares no specific secrets or connectors to inherit.
        </p>
      ) : (
        <>
          <div className="space-y-1.5">
            {secrets.length > 0 && <ScopeLine icon={KeyRound} label="Secrets" items={secrets} />}
            {conns.length > 0 && <ScopeLine icon={Plug} label="Connectors" items={conns} />}
          </div>
          <p className="text-muted-foreground/60 text-[11px] leading-relaxed">
            The member inherits these as their own — usable in Secrets, sessions, and connector
            calls.
          </p>
        </>
      )}
    </div>
  );
}

function ResourceAccessCard({
  projectId,
  canManage,
}: {
  projectId: string;
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const grantsKey = qk.project.resourceGrants(projectId);

  const grantsQuery = useQuery({
    queryKey: grantsKey,
    queryFn: () => listProjectResourceGrants(projectId),
    // Manager-only endpoint (403s otherwise) — don't fire it for non-managers.
    enabled: canManage,
    ...contract('inventory'),
  });

  const resources = grantsQuery.data?.resources ?? { agents: [], skills: [], secrets: [] };
  const grants = useMemo(() => {
    const raw = toArray(grantsQuery.data?.grants);
    return [...raw].sort((a, b) => {
      const t = a.resource_type.localeCompare(b.resource_type);
      if (t !== 0) return t;
      const r = a.resource_id.localeCompare(b.resource_id);
      return r !== 0 ? r : a.principal_label.localeCompare(b.principal_label);
    });
  }, [grantsQuery.data]);

  // Display name for a resource id (falls back to the id itself).
  const resourceName = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of resources.agents) m.set(`agent:${a.id}`, a.name);
    for (const s of resources.skills) m.set(`skill:${s.id}`, s.name);
    for (const s of resources.secrets ?? []) m.set(`secret:${s.id}`, s.name);
    return m;
  }, [resources]);

  const hasResources =
    resources.agents.length > 0 ||
    resources.skills.length > 0 ||
    (resources.secrets?.length ?? 0) > 0;

  const [dialogOpen, setDialogOpen] = useState(false);
  const [pickerType] = useState<ResourceGrantType>('agent'); // agent-only grant flow
  // Multi-select on BOTH sides: grant several agents to several members/groups
  // in one action. Fires one createProjectResourceGrant call per (agent,
  // principal) pair — the API is one row per resource×principal, there is no
  // batch endpoint — but the person only ever picks two sets and hits one
  // button, instead of re-opening the dialog per agent per person.
  const [selectedAgentIds, setSelectedAgentIds] = useState<string[]>([]);
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>([]);
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([]);
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());
  const markPending = (id: string) => setPendingIds((prev) => new Set(prev).add(id));
  const clearPending = (id: string) =>
    setPendingIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  const toggleAgent = (id: string) =>
    setSelectedAgentIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  // The grant flow is AGENT-ONLY: the pyramid routes ALL resources — secrets,
  // connectors, AND skills — to people through the AGENTS they're assigned to,
  // never by a direct resource→member grant. Declare the resource on an agent
  // (its scope / skills), then assign the agent here. (Pre-existing skill/secret
  // grants still render in the list below so they can be revoked.)
  const activeItems = resources.agents;

  // Blast-radius preview: the UNION of every selected agent's declared
  // secrets/connectors — what the assignees inherit across all of them, not
  // just the first pick. 'all' on any one agent makes the union 'all' for
  // that dimension (it can't be narrowed by adding more agents).
  const selectedAgentDeclares = useMemo(() => {
    if (pickerType !== 'agent' || selectedAgentIds.length === 0) return null;
    const picked = resources.agents.filter((a) => selectedAgentIds.includes(a.id));
    if (picked.length === 0) return null;
    const union = (key: 'secrets' | 'connectors'): string[] | 'all' => {
      if (picked.some((a) => a.declares?.[key] === 'all')) return 'all';
      return [...new Set(picked.flatMap((a) => (a.declares?.[key] as string[] | undefined) ?? []))];
    };
    return { secrets: union('secrets'), connectors: union('connectors') };
  }, [pickerType, selectedAgentIds, resources.agents]);

  function resetGrantForm() {
    setSelectedAgentIds([]);
    setSelectedMemberIds([]);
    setSelectedGroupIds([]);
  }

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: grantsKey });
    // The agent/skill lists the rest of the UI renders are now filtered, so
    // the project detail must refetch to reflect what this user can see.
    // invalidateProject() reaches qk.project.scope(projectId), which
    // qk.project.summary(projectId) nests under — no separate summary
    // invalidation needed alongside it.
    void invalidateProject(queryClient, projectId);
  }

  const selectedPrincipalCount = selectedMemberIds.length + selectedGroupIds.length;
  // Total grants this submit will create: every selected agent crossed with
  // every selected principal, not just one dimension.
  const selectedGrantCount = selectedAgentIds.length * selectedPrincipalCount;

  const createMutation = useMutation({
    mutationFn: async () => {
      const principals: Array<{ principalType: 'member' | 'group'; principalId: string }> = [
        ...selectedMemberIds.map((principalId) => ({ principalType: 'member' as const, principalId })),
        ...selectedGroupIds.map((principalId) => ({ principalType: 'group' as const, principalId })),
      ];
      const pairs = selectedAgentIds.flatMap((resourceId) =>
        principals.map((p) => ({ resourceId, ...p })),
      );
      const results = await Promise.allSettled(
        pairs.map((pair) =>
          createProjectResourceGrant(projectId, {
            resourceType: pickerType as ResourceGrantType,
            resourceId: pair.resourceId,
            principalType: pair.principalType,
            principalId: pair.principalId,
          }),
        ),
      );
      const failed = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      return { total: pairs.length, failed };
    },
    onSuccess: ({ total, failed }) => {
      const ok = total - failed.length;
      if (failed.length === 0) {
        successToast(total === 1 ? 'Resource scoped' : `Resource scoped to ${total}`);
        resetGrantForm();
        setDialogOpen(false);
      } else if (ok > 0) {
        // Partial failure: leave the dialog open on the still-selected
        // principals so the failed ones are easy to retry, instead of
        // silently dropping which ones didn't go through.
        errorToast(
          `Granted to ${ok} of ${total} — ${failed.length} failed. Remove the granted ones and retry the rest.`,
        );
      } else {
        errorToast(
          failed[0]?.reason instanceof Error ? failed[0].reason.message : 'Failed to scope resource',
        );
      }
      invalidate();
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to scope resource'),
  });

  function onDialogOpenChange(next: boolean) {
    if (createMutation.isPending) return;
    if (next) resetGrantForm(); // agent-only flow; the agent list is live immediately
    setDialogOpen(next);
  }

  const removeMutation = useMutation({
    mutationFn: (grantId: string) => deleteProjectResourceGrant(projectId, grantId),
    onMutate: (grantId) => markPending(grantId),
    onSettled: (_d, _e, grantId) => clearPending(grantId),
    onSuccess: () => {
      successToast('Scope removed');
      invalidate();
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to remove scope'),
  });

  // List filter (below): keep a long, mixed grant list scannable by type.
  const [resourceFilter, setResourceFilter] = useState<'all' | ResourceGrantType>('all');
  const grantCounts = useMemo(() => {
    const c: Record<ResourceGrantType, number> = { agent: 0, skill: 0, secret: 0 };
    for (const g of grants) c[g.resource_type] += 1;
    return c;
  }, [grants]);
  const grantFilterOptions = useMemo(() => {
    const opts: { value: 'all' | ResourceGrantType; label: string; count: number }[] = [
      { value: 'all', label: 'All', count: grants.length },
    ];
    if (grantCounts.agent) opts.push({ value: 'agent', label: 'Agents', count: grantCounts.agent });
    if (grantCounts.skill) opts.push({ value: 'skill', label: 'Skills', count: grantCounts.skill });
    if (grantCounts.secret)
      opts.push({ value: 'secret', label: 'Secrets', count: grantCounts.secret });
    return opts;
  }, [grants.length, grantCounts]);
  const visibleGrants = useMemo(
    () =>
      resourceFilter === 'all' ? grants : grants.filter((g) => g.resource_type === resourceFilter),
    [grants, resourceFilter],
  );

  const canSubmit =
    !!pickerType &&
    selectedAgentIds.length > 0 &&
    selectedPrincipalCount > 0 &&
    !createMutation.isPending;

  return (
    <>
      <section className="space-y-3">
        {/* Was "Resource access" over a five-line paragraph explaining
            USE-vs-edit, inheritance, and declared skills/connectors/
            secrets. The rule underneath is two sentences; the rest was
            restating it. "Agents" says what the list contains — nobody
            arrives looking for a "resource". */}
        <SettingsSubsectionHeader
          title={
            <>
              Agents
              {grants.length > 0 ? (
                <span className="text-muted-foreground ml-1.5 font-normal tabular-nums">
                  {grants.length}
                </span>
              ) : null}
            </>
          }
          description="Choose who can use each agent. An agent with nobody assigned is open to everyone in this workspace. Being assigned never allows editing — that still needs the editor role."
          action={
            canManage && hasResources ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="shrink-0 gap-1.5"
                onClick={() => onDialogOpenChange(true)}
              >
                <Plus className="size-3.5 shrink-0" />
                Grant access
              </Button>
            ) : null
          }
        />

        {!grantsQuery.isLoading && grants.length > 0 && grantFilterOptions.length > 2 && (
          <FilterChips
            value={resourceFilter}
            onChange={setResourceFilter}
            options={grantFilterOptions}
          />
        )}

        <SettingsRowGroup>
          {grantsQuery.isLoading ? (
            <SettingsRowSkeleton />
          ) : grants.length === 0 ? (
            <SettingsEmptyRow
              label="No agents assigned"
              description={
                hasResources
                  ? 'Every agent is open to everyone with project access. Grant one to narrow that.'
                  : 'This project has no agents yet. Add one first, then come back to choose who can use it.'
              }
            />
          ) : (
            visibleGrants.map((g: ProjectResourceGrant) => {
              const busy = pendingIds.has(g.grant_id);
              const displayName =
                resourceName.get(`${g.resource_type}:${g.resource_id}`) ?? g.resource_id;
              return (
                <SettingsRow
                  key={g.grant_id}
                  label={
                    <>
                      {/* No `truncate`: `SettingsRow`'s contract is that a long
                          label WRAPS rather than squeezing the control, which is
                          `shrink-0` (see settings-row.tsx). */}
                      <span className="min-w-0">{displayName}</span>
                      <Badge variant="outline" size="sm" className="capitalize">
                        {g.resource_type}
                      </Badge>
                      {g.orphaned && (
                        <Badge
                          variant="outline"
                          size="sm"
                          className="border-kortix-orange/30 text-kortix-orange"
                          title={`This ${g.resource_type} no longer exists (renamed or deleted). The grant is inert — the restriction has lapsed. Remove it or re-grant the current ${g.resource_type}.`}
                        >
                          renamed / removed
                        </Badge>
                      )}
                    </>
                  }
                  description={
                    <RowMeta>
                      <span>
                        {g.principal_type === 'group' ? 'Group' : 'Member'}: {g.principal_label}
                      </span>
                      <span>Granted {formatDate(g.created_at)}</span>
                    </RowMeta>
                  }
                >
                  {busy ? (
                    <Loading className="text-muted-foreground shrink-0" />
                  ) : canManage ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => removeMutation.mutate(g.grant_id)}
                    >
                      Remove
                    </Button>
                  ) : (
                    <Badge variant="outline" size="sm" className="capitalize">
                      {g.principal_type}
                    </Badge>
                  )}
                </SettingsRow>
              );
            })
          )}
        </SettingsRowGroup>
      </section>

      <Modal open={dialogOpen} onOpenChange={onDialogOpenChange}>
        <ModalContent className="sm:max-w-md">
          <ModalHeader>
            <ModalTitle>Assign an agent</ModalTitle>
            <ModalDescription>
              Assign an agent to a member or group — they inherit everything that agent uses (its
              secrets, connectors, and skills) to USE, not edit. Resources reach people through
              agents, not by a direct grant; agents you don't assign stay open to everyone with
              project access. Editing the agent or any resource it uses still requires the editor
              role.
            </ModalDescription>
          </ModalHeader>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!canSubmit) return;
              createMutation.mutate();
            }}
          >
            <ModalBody className="space-y-4">
              <div className="space-y-1.5">
                <span className="text-muted-foreground text-xs font-medium">
                  1. Agent
                  {selectedAgentIds.length > 0 ? (
                    <span className="ml-1 tabular-nums">({selectedAgentIds.length})</span>
                  ) : null}
                </span>
                {/* Multi-select: grant several agents to the same set of
                    people in one submit, instead of re-opening this dialog
                    per agent. */}
                <div className="border-border max-h-40 overflow-y-auto rounded-md border p-1">
                  {activeItems.map((r) => (
                    <Checkbox
                      key={r.id}
                      label={r.name}
                      checked={selectedAgentIds.includes(r.id)}
                      onCheckedChange={() => toggleAgent(r.id)}
                      disabled={createMutation.isPending}
                    />
                  ))}
                </div>
              </div>

              {selectedAgentDeclares && <BlastRadiusPreview declares={selectedAgentDeclares} />}

              <div className="space-y-1.5">
                <span className="text-muted-foreground text-xs font-medium">
                  2. Grant to
                  {selectedPrincipalCount > 0 ? (
                    <span className="ml-1 tabular-nums">({selectedPrincipalCount})</span>
                  ) : null}
                </span>
                {/* Multi-select, not one-at-a-time: pick as many members and
                    groups as should get this agent in a single grant action.
                    Same allow-list component the trigger session-access
                    picker uses — see SubjectPicker's own doc comment. */}
                <SubjectPicker
                  projectId={projectId}
                  memberIds={selectedMemberIds}
                  groupIds={selectedGroupIds}
                  onChange={(memberIds, groupIds) => {
                    setSelectedMemberIds(memberIds);
                    setSelectedGroupIds(groupIds);
                  }}
                />
              </div>
            </ModalBody>

            <ModalFooter className="sm:justify-between">
              <Button
                type="button"
                variant="outline-ghost"
                size="sm"
                onClick={() => onDialogOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={!canSubmit}>
                {createMutation.isPending ? <Loading className="size-4 shrink-0" /> : null}
                {selectedGrantCount > 1 ? `Grant access (${selectedGrantCount})` : 'Grant access'}
              </Button>
            </ModalFooter>
          </form>
        </ModalContent>
      </Modal>
    </>
  );
}

