'use client';

/**
 * What THIS caller can see and do in an account — the one batched permission
 * probe behind the account hub, and the section-visibility rule derived from
 * it.
 *
 * Two consumers, one request: `app/(app)/accounts/[id]/page.tsx` (which pane
 * to render, which controls to offer) and the settings sidebar in
 * `account-settings-sidebar.tsx` (which nav items exist). Both call the hook
 * below; React Query keys the batch on `(accountId, userId, probes)`, so the
 * second caller reads the first caller's cache entry and the server sees one
 * `:batch` POST per page load, not two.
 */

import { useSearchParams } from 'next/navigation';

import { isBillingEnabled } from '@/lib/config';
import { usePermissions, type CanResult } from '@/lib/use-permission';

import { NAV_GROUPS, parseAccountSection, type AccountSection } from './sections';

// Stable (module-level) probe list for the account-capabilities batch. Order
// must match the destructure in `useAccountHubAccess`. Declared outside the
// hook so its identity is constant across renders and React Query doesn't
// refetch.
//
// READ leaves lead, because they decide whether a nav item exists at all:
// every Access pane fetches a list on mount, and the pane's list route asserts
// its own read leaf server-side (`apps/api/src/accounts/iam/*.ts`). Probing the
// same leaf here is what keeps "visible" and "openable" the same set — a nav
// item whose read probe says no would render straight into
// "Failed to load … you don't have permission". The WRITE leaves that follow
// decide what a visible pane offers, never whether it is reachable.
export const ACCOUNT_PERMISSION_PROBES = [
  // Reads → nav visibility.
  { action: 'member.read' }, // GET .../iam/members        → Members
  { action: 'group.read' }, // GET .../iam/groups          → Groups
  { action: 'role.read' }, // GET .../iam/roles            → Roles
  { action: 'policy.read' }, // GET .../iam/policies       → the members list's custom-role column
  { action: 'audit.read' }, // GET .../audit               → Audit log
  // Writes → controls inside a visible pane.
  { action: 'account.write' },
  { action: 'account.delete' },
  { action: 'member.invite' },
  { action: 'member.remove' },
  { action: 'member.update' },
  { action: 'group.create' },
  { action: 'group.members.manage' },
  { action: 'role.create' },
];

type Allowed = CanResult['allowed'];

export interface AccountHubAccess {
  canReadMembers: Allowed;
  canReadGroups: Allowed;
  canReadRoles: Allowed;
  canReadPolicies: Allowed;
  canReadAudit: Allowed;
  canWriteAccount: Allowed;
  canDeleteAccount: Allowed;
  canInviteMember: Allowed;
  canRemoveMember: Allowed;
  canUpdateMember: Allowed;
  canCreateGroup: Allowed;
  canManageGroupMembers: Allowed;
  canManageRoles: Allowed;
  /** Which sections this caller may open. ONE rule — see the body. */
  sectionVisible: Record<AccountSection, boolean>;
  /** The first section in nav order this caller can see; `help` at worst. */
  firstVisibleSection: AccountSection;
}

/**
 * The batched probe plus the visibility rule. Safe to call before the account
 * itself has loaded: `usePermissions` short-circuits when `accountId` is
 * falsy, and every flag reads `false` until the verdict lands.
 */
export function useAccountHubAccess(accountId: string | undefined): AccountHubAccess {
  // One batched probe instead of 13 separate /effective?action=… GETs. Each
  // singular probe was its own DB round-trip, so a single load of this page
  // fanned out 13 concurrent queries — a meaningful contributor to DB
  // connection-pool pressure. The :batch endpoint answers all of them in one
  // request. Results come back in the same order as ACCOUNT_PERMISSION_PROBES.
  const [
    { allowed: canReadMembers },
    { allowed: canReadGroups },
    { allowed: canReadRoles },
    { allowed: canReadPolicies },
    { allowed: canReadAudit },
    { allowed: canWriteAccount },
    { allowed: canDeleteAccount },
    { allowed: canInviteMember },
    { allowed: canRemoveMember },
    { allowed: canUpdateMember },
    { allowed: canCreateGroup },
    { allowed: canManageGroupMembers },
    { allowed: canManageRoles },
  ] = usePermissions(accountId, ACCOUNT_PERMISSION_PROBES);

  // Self-host billing-disabled: no Stripe plan controls to show. Session costs
  // remain available because they do not require the internal billing engine.
  const billingActive = isBillingEnabled();

  // Which nav items this caller can see. ONE rule, no exceptions: a section
  // is visible when the probe for the leaf its own list route asserts came
  // back `true`. "Discoverability" is not a reason to show a nav item — a
  // pane that renders "Failed to load roles · You don't have permission
  // (role.read)" teaches nothing and reads as a broken product, which is
  // exactly what a plain account member used to get on Roles.
  //
  // Entitlement (`rbacEnabled`) is a DIFFERENT axis and stays in the page:
  // `GroupsTab`/`RolesTab` render the free built-in content and disable only
  // "Create a group" / "New role" with an inline upsell. Permission decides
  // whether the pane exists; entitlement decides what it offers.
  const sectionVisible: Record<AccountSection, boolean> = {
    // GET .../iam/members — `MEMBER_READ` (accounts/iam/members.ts:150).
    members: canReadMembers === true,
    // GET .../iam/groups — `GROUP_READ` (accounts/iam/groups.ts:81).
    groups: canReadGroups === true,
    // No account-level leaf of its own: the pane lists projects through
    // `GET /projects?account_id=` (already scoped to what the caller can
    // read) and opens each one's access through
    // `GET /projects/:id/access` — `project.members.read`, a PROJECT leaf
    // that `AccessProjectsTab` probes per project. An account member with no
    // projects simply gets an empty list, never a 403.
    'access-projects': true,
    // GET .../iam/roles — `ROLE_READ` (accounts/iam/custom-roles.ts:104),
    // which lives in ADMIN_EXTRAS. This was hard-coded `true`, so every plain
    // member saw a Roles item that could only ever fail to load.
    roles: canReadRoles === true,
    identity: canWriteAccount === true,
    billing: canWriteAccount === true && billingActive,
    transactions: canWriteAccount === true,
    git: canWriteAccount === true,
    tokens: canWriteAccount === true,
    // GET .../audit — `AUDIT_READ`, also ADMIN_EXTRAS.
    audit: canReadAudit === true,
    settings: canWriteAccount === true,
    // Branding is all mutations (upload / remove / rename); the entitlement is
    // the OTHER axis and picks between the pane and the upsell card.
    branding: canWriteAccount === true,
    // Reference copy — no data, no mutations, nothing to gate.
    help: true,
  };

  // Members is not unconditionally visible, so it cannot be the blanket
  // fallback: a caller denied `member.read` would land on a section the nav
  // does not even list and stare at an empty pane. Fall through to the first
  // section this caller CAN see, in nav order; `help` closes it out and is
  // visible to everyone, so this always resolves.
  const firstVisibleSection: AccountSection =
    NAV_GROUPS.flatMap((group) => group.items).find((item) => sectionVisible[item.id])?.id ??
    'help';

  return {
    canReadMembers,
    canReadGroups,
    canReadRoles,
    canReadPolicies,
    canReadAudit,
    canWriteAccount,
    canDeleteAccount,
    canInviteMember,
    canRemoveMember,
    canUpdateMember,
    canCreateGroup,
    canManageGroupMembers,
    canManageRoles,
    sectionVisible,
    firstVisibleSection,
  };
}

export interface AccountHubSection extends AccountHubAccess {
  /** What `?tab=` asked for (`members` when absent or unparseable). */
  requestedTab: AccountSection;
  /** What actually renders: the request if this caller may see it, else the fallback. */
  activeSection: AccountSection;
}

/**
 * Access plus the resolved section. Reads `?tab=`, so a component calling
 * this needs a `Suspense` boundary above it when it can render during a
 * static prerender.
 */
export function useAccountHubSection(accountId: string | undefined): AccountHubSection {
  const access = useAccountHubAccess(accountId);
  const searchParams = useSearchParams();
  const { sectionVisible, firstVisibleSection } = access;
  const requestedTab: AccountSection = parseAccountSection(searchParams.get('tab')) ?? 'members';
  const activeSection: AccountSection = sectionVisible[requestedTab]
    ? requestedTab
    : firstVisibleSection;
  return { ...access, requestedTab, activeSection };
}
