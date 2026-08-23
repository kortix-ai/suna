'use client';

import {
  CoinsIcon as Coins,
  CreditCardIcon as CreditCard,
  ArrowSquareOutIcon as ExternalLink,
  FingerprintIcon as Fingerprint,
  FolderOpenIcon as FolderOpen,
  GitBranchIcon as GitBranch,
  GithubLogoIcon as Github,
  QuestionIcon as HelpCircle,
  InfoIcon as Info,
  KeyIcon as KeyRound,
  LinkIcon,
  NetworkIcon as Network,
  PencilSimpleIcon as PencilSimple,
  ArrowClockwiseIcon as RefreshCw,
  ScrollIcon as ScrollText,
  PlugsIcon as Unplug,
} from '@phosphor-icons/react';
import { invalidatePermissionProbes } from '@kortix/sdk/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { m, useReducedMotion } from 'motion/react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';

import { ConnectingScreen } from '@/components/dashboard/connecting-screen';
import { AccessHelp } from '@/components/iam/access-help';
import { AccessProjectsTab } from '@/components/iam/access-projects-tab';
import { ApiKeysSection } from '@/components/iam/api-keys-card';
import { AuditTab } from '@/components/iam/audit-tab';
import { AuditWebhooksCard } from '@/components/iam/audit-webhooks-card';
import { EnterpriseDemoCard } from '@/components/iam/enterprise-demo-card';
import { EnterpriseUpsell } from '@/components/iam/enterprise-upsell';
import { GitHubAppSetupCard } from '@/components/iam/github-app-setup-card';
import { GroupsTab } from '@/components/iam/groups-tab';
import { IdentityIntro } from '@/components/iam/identity-intro';
import { KeyRulesCard } from '@/components/iam/key-rules-card';
import { MemberAccessPanel } from '@/components/iam/member-access-panel';
import { MfaRequiredCard } from '@/components/iam/mfa-required-card';
import { RolesTab } from '@/components/iam/roles-tab';
import { ScimCard } from '@/components/iam/scim-card';
import { AccountSessionsPanel, SessionControlsCard } from '@/components/iam/session-controls-card';
import { SsoCard } from '@/components/iam/sso-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import {
  SettingsRail,
  SettingsShell,
  type SettingsRailGroup,
} from '@/features/workspace/shared/settings-shell';
import Hint from '@/components/ui/hint';
import { InfoBanner } from '@/components/ui/info-banner';
import { InlineMeta } from '@/components/ui/inline-meta';
import { Input } from '@/components/ui/input';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { SettingsRowGroup } from '@/components/ui/settings-row';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, infoToast, successToast, warningToast } from '@/components/ui/toast';
import { UserAvatar } from '@/components/ui/user-avatar';
import { BillingTab } from '@/features/accounts/settings/billing-tab';
import { TransactionsTab } from '@/features/accounts/settings/transactions-tab';
import { GlobalUpgradeModal } from '@/features/billing/global-upgrade-modal';
import { Close } from '@/features/icon/icons/close';
import { Plus } from '@/features/icon/icons/plus';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { useAuth } from '@/features/providers/auth-provider';
import {
  ACCESS_ROW_CLASS,
  AccessDialog,
  AccessList,
  AccessRow,
  builtinRole,
  builtinRoleLabel,
  customRole,
  formatDate,
  type AccessDialogPrincipal,
  type KebabItem,
  type RoleValue,
  principalLabel,
  roleValueLabel,
  useAccountRoles,
} from '@/features/workspace/shared/access';
import { useAccountState } from '@/hooks/billing';
import { isBillingEnabled } from '@/lib/config';
import { isGitHubAppInstallationId } from '@/lib/github-installations';
import { usePermissions } from '@/lib/use-permission';
import { cn } from '@/lib/utils';
import { BillingAccountProvider } from '@/stores/billing-account-context';
import {
  type AccountDetail,
  type AccountInvitation,
  type AccountMember,
  type AccountMemberProject,
  type AccountRole,
  type IamPolicy,
  cancelAccountInvite,
  deleteGitHubInstallation,
  getAccount,
  leaveAccount,
  listAccountInvites,
  listAccountMembers,
  listGitHubInstallations,
  listPolicies,
  removeAccountMember,
  resendAccountInvite,
  updateAccountMemberRole,
  updateAccountName,
} from '@kortix/sdk';
import type { Icon as IconType, Icon as LucideIcon } from '@phosphor-icons/react';
import {
  GearSixIcon as CogOne,
  type Icon as IconMynauiType,
  MagnifyingGlassIcon as Search,
  ShieldIcon as Shield,
  TrashIcon,
  UserPlusIcon as UserPlus,
  UsersIcon as Users,
} from '@phosphor-icons/react';

// Stable (module-level) probe list for the account-capabilities batch. Order
// must match the destructure at the call site. Declared outside the component
// so its identity is constant across renders and React Query doesn't refetch.
//
// READ leaves lead, because they decide whether a rail item exists at all:
// every Access pane fetches a list on mount, and the pane's list route asserts
// its own read leaf server-side (`apps/api/src/accounts/iam/*.ts`). Probing the
// same leaf here is what keeps "visible" and "openable" the same set — a rail
// item whose read probe says no would render straight into
// "Failed to load … you don't have permission". The WRITE leaves that follow
// decide what a visible pane offers, never whether it is reachable.
const ACCOUNT_PERMISSION_PROBES = [
  // Reads → rail visibility.
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

// ── Section nav (left rail) ───────────────────────────────────────────────

const VALID_TABS = [
  'members',
  'git',
  'tokens',
  'settings',
  'billing',
  'transactions',
  'groups',
  'access-projects',
  'roles',
  'identity',
  'audit',
  'help',
] as const;
type AccountSection = (typeof VALID_TABS)[number];

// Three labeled groups. The unlabeled plumbing group (Settings/Git/Tokens —
// name, security, repo, machine tokens) leads: "who am I and how is this
// account configured" comes before "who else is in it" (Marko's call,
// 2026-08-18 — was Access-first; moved Settings ahead of it). Everything
// access-control-shaped lives in one "Access" cluster right after — Members /
// Groups / Projects / Roles / Identity / Audit log / Help are all
// facets of the same concern (who's in the account, what pools they're in,
// what those pools can do, where they can do it, how they signed in, and what
// happened) — deliberately not split into a separate "Enterprise" heading
// (Marko's call, 2026-08-18: Identity/Audit are access control too, plan-gating
// doesn't change what category they're in). Billing is unchanged.
//
// There is no "Agents" item: an agent is a project RESOURCE, not a principal,
// so agent access is the Agents field on a project grant (`AccessDialog`), not
// a tab of its own. Help closes the group — it is the old
// `PermissionsHelpPopover`, promoted to a linkable pane.
const NAV_GROUPS: Array<{
  label?: string;
  items: Array<{ id: AccountSection; label: string; icon: LucideIcon | IconMynauiType | IconType }>;
}> = [
  {
    items: [
      { id: 'settings', label: 'Settings', icon: CogOne },
      { id: 'git', label: 'Git', icon: GitBranch },
      { id: 'tokens', label: 'Tokens', icon: KeyRound },
    ],
  },
  {
    label: 'Access',
    items: [
      { id: 'members', label: 'Members', icon: Users },
      { id: 'groups', label: 'Groups', icon: Network },
      { id: 'access-projects', label: 'Projects', icon: FolderOpen },
      { id: 'roles', label: 'Roles', icon: Shield },
      { id: 'identity', label: 'Identity', icon: Fingerprint },
      { id: 'audit', label: 'Audit log', icon: ScrollText },
      { id: 'help', label: 'Help', icon: HelpCircle },
    ],
  },
  {
    label: 'Billing',
    items: [
      { id: 'billing', label: 'Plan', icon: CreditCard },
      { id: 'transactions', label: 'Usage', icon: Coins },
    ],
  },
];

// Header block for sections whose content doesn't carry its own title.
const PANE_META: Partial<Record<AccountSection, { title: string; description: string }>> = {
  members: { title: 'Members', description: 'People with access to this account.' },
  billing: { title: 'Plan', description: 'Plan, wallet, and spend for this account.' },
  transactions: {
    title: 'Usage',
    description: 'Session costs and credit ledger for this account.',
  },
  tokens: {
    title: 'Tokens',
    // Machine identities only. A person's own API keys moved to their own
    // settings on 2026-08-18 (`/settings/tokens`) — see the section below.
    description: 'Service account tokens for CI and automations, and the rules they follow.',
  },
  identity: {
    title: 'Identity',
    description: 'Bring members in from your identity provider.',
  },
  roles: {
    title: 'Roles',
    description: 'Built-in and custom roles. Assign them from Members and Projects.',
  },
  help: {
    title: 'Help',
    description: 'How access works in this account.',
  },
  settings: { title: 'Settings', description: 'Name and security for this account.' },
};

// The enterprise IdP surface (SAML SSO + SCIM provisioning) is PLAN-GATED,
// not env-gated: the cards render only for accounts whose tier carries the
// `sso` / `scim` entitlement (i.e. the sales-assigned `enterprise` tier). This
// matches the server-side enforcement in the SCIM/SSO routes — the API returns
// 402 for non-entitled accounts — so the UI never offers a control that the
// backend would reject. See `entitlements` on the account-state `tier` block.

// `formatDate` and `principalLabel` come from
// `features/workspace/shared/access` — this file used to carry its own copy of
// both, byte-identical to the ones the project/group/audit surfaces carried.

/** Copy an invite URL to the clipboard with a friendly toast either way. */
async function copyInviteLink(url: string) {
  try {
    await navigator.clipboard.writeText(url);
    successToast('Invite link copied to clipboard');
  } catch {
    // Older browsers / blocked clipboard — show the link in a toast so the
    // admin can copy it by hand.
    infoToast('Copy this invite link', {
      description: url,
      duration: 15_000,
    });
  }
}

function rememberGitHubSetupReturn(path: string) {
  try {
    window.localStorage.setItem('kortix:github_setup_return', path);
  } catch {
    // Non-critical: the setup page falls back to the project import flow.
  }
}

export default function AccountSettingsPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const accountId = params?.id;
  const queryClient = useQueryClient();
  const { user, isLoading: authLoading } = useAuth();

  useEffect(() => {
    if (!authLoading && !user) router.replace('/auth');
  }, [authLoading, user, router]);

  // Granular capabilities sourced from the IAM engine. MUST be called
  // before any conditional return — moving these below the auth-loading
  // guard would change the hook count between renders.
  // usePermission internally short-circuits when accountId is falsy, so
  // it's safe to call before the account query resolves.
  // One batched probe instead of 12 separate /effective?action=… GETs. Each
  // singular probe was its own DB round-trip, so a single load of this page
  // fanned out 12 concurrent queries — a meaningful contributor to DB
  // connection-pool pressure. The :batch endpoint answers all of them in one
  // request. Results come back in the same order as ACCOUNT_PERMISSION_PROBES.
  //
  // Declared ABOVE the data queries, not below them, because the read probes
  // now gate whether those queries fire at all.
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

  const accountQuery = useQuery({
    queryKey: ['account', accountId],
    queryFn: () => getAccount(accountId!),
    enabled: !!user && !!accountId,
    staleTime: 30_000,
  });

  // `GET .../iam/members` asserts `member.read`, so hold the request until the
  // probe stops saying no. `!== false` (not `=== true`) keeps it optimistic:
  // the list still starts loading the moment the probe answers, and an
  // in-flight probe never delays it for someone who does have the leaf.
  const membersQuery = useQuery({
    queryKey: ['account-members', accountId],
    queryFn: () => listAccountMembers(accountId!),
    enabled: !!user && !!accountId && canReadMembers !== false,
    staleTime: 20_000,
  });

  // Enterprise identity (SSO + SCIM) is gated on the account's plan. The cards
  // render only when the tier carries the entitlement — mirrors the server-side
  // 402 so we never show a control the backend rejects.
  const accountStateQuery = useAccountState({ accountId, enabled: !!user && !!accountId });
  const entitlements = accountStateQuery.data?.tier?.entitlements;
  const enterpriseIdentityEnabled = !!(entitlements?.sso || entitlements?.scim);
  // Audit and SSO/SCIM have no free-tier content — the server has nothing to
  // list until the account is entitled, so the EnterpriseUpsell card stands
  // in for the whole feature. Groups and Roles are different: `GET
  // .../groups` and `GET .../roles` carry NO entitlement check
  // (`apps/api/src/accounts/iam/groups.ts` / `custom-roles.ts` — only the
  // mutating routes call `requireEntitlement(..., 'rbac')`), because the six
  // built-in roles and an account's real (if empty) group list are product,
  // not upsell. `GroupsTab`/`RolesTab` already render that list unconditionally
  // and gate only "Create a group" / "New role" behind `rbacEnabled` — a
  // disabled control with an inline "Enterprise feature" tooltip/banner,
  // mirroring the server's 403 so an admin never submits a mutation the
  // backend will reject. Blocking the whole tab behind `rbacEnabled` here (as
  // this used to) hid that free content behind an upsell card for no reason;
  // see `enterprise-upsell.tsx`'s own header comment, which already said the
  // intent was to "keep the tab/section visible for discoverability" — the
  // page-level gate below just never let that happen. Audit/Identity keep the
  // outer gate; Groups/Roles no longer do. While the account state is still
  // loading we render nothing gated (skeleton) to avoid flashing.
  const rbacEnabled = !!entitlements?.rbac;
  const auditEnabled = !!entitlements?.auditAccess;
  const entitlementsLoading = !entitlements && accountStateQuery.isLoading;

  const prefersReducedMotion = useReducedMotion();

  if (authLoading || !user) {
    return <ConnectingScreen forceConnecting overrideStage="auth" hideWorkspacePicker />;
  }

  const account = accountQuery.data;
  const members = membersQuery.data ?? [];
  const rawTab = searchParams.get('tab');
  // Legacy callers pass tab=overview — the limits/wallet/spend panels now
  // live at the top of the Billing tab, so fold it.
  const tabParam = (rawTab === 'overview' ? 'billing' : rawTab) as AccountSection | null;
  const requestedTab: AccountSection =
    tabParam && (VALID_TABS as readonly string[]).includes(tabParam) ? tabParam : 'members';
  // Self-host billing-disabled: no Stripe plan controls to show. Session costs
  // remain available because they do not require the internal billing engine.
  const billingActive = isBillingEnabled();

  // Which rail items this caller can see. Mirrors the per-section gates the
  // content rendering applies below, so a deep link to a section the caller
  // can't use falls back to Members instead of an empty pane.
  // Which rail items this caller can see. ONE rule, no exceptions: a section
  // is visible when the probe for the leaf its own list route asserts came
  // back `true`. "Discoverability" is not a reason to show a rail item — a
  // pane that renders "Failed to load roles · You don't have permission
  // (role.read)" teaches nothing and reads as a broken product, which is
  // exactly what a plain account member used to get on Roles.
  //
  // Entitlement (`rbacEnabled`) is a DIFFERENT axis and stays where it is:
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
    // Reference copy — no data, no mutations, nothing to gate.
    help: true,
  };
  // Members is no longer unconditionally visible, so it cannot be the blanket
  // fallback: a caller denied `member.read` would land on a section the rail
  // does not even list and stare at an empty pane. Fall through to the first
  // section this caller CAN see, in rail order; `help` closes it out and is
  // visible to everyone, so this always resolves.
  const firstVisibleSection: AccountSection =
    NAV_GROUPS.flatMap((group) => group.items).find((item) => sectionVisible[item.id])?.id ?? 'help';

  // The rail's rows, gated. Groups that empty out entirely are dropped here
  // rather than inside the shell, so the shell can index what it is actually
  // going to draw — see `SettingsRail`'s note on the leading-spacer bug that
  // indexing the UNFILTERED list used to cause.
  // Not memoised: `sectionVisible` is a fresh object literal every render, so
  // a `useMemo` keyed on it would recompute every render anyway — and there is
  // an early return above this line, which is where the hook would sit.
  const railGroups: SettingsRailGroup[] = NAV_GROUPS.map((group) => ({
    label: group.label,
    items: group.items.filter((item) => sectionVisible[item.id]),
  })).filter((group) => group.items.length > 0);
  const activeSection: AccountSection = sectionVisible[requestedTab]
    ? requestedTab
    : firstVisibleSection;
  // The three drill-down params. Each names the entity whose detail panel
  // replaces its tab's list, in the tab's own pane — `AccessProjectsTab`,
  // `GroupsTab` and `MemberAccessPanel` all read their selection from here so
  // a detail view is a URL, not a route change, and the left rail never
  // disappears underneath it.
  const selectedAccessProjectId = searchParams.get('project');
  const selectedAccessGroupId = searchParams.get('group');
  const selectedAccessMemberId = searchParams.get('member');
  // The Members list has a pane header; its member panel carries its own, so
  // suppress the outer one while a member is open (Groups and Projects have
  // no `PANE_META` entry at all, for the same reason).
  const paneMeta =
    activeSection === 'members' && selectedAccessMemberId ? undefined : PANE_META[activeSection];
  // `project` / `group` / `member` carry the open detail entity onto the URL
  // (`?tab=groups&group=<id>`) — omit one (or pass null) to drop the param,
  // e.g. switching tabs or backing out to the list. Every other tab switch
  // keeps calling `navigate(section)` as before, which drops all three
  // implicitly.
  const navigate = (
    section: AccountSection,
    opts?: { project?: string | null; group?: string | null; member?: string | null },
  ) => {
    const query = new URLSearchParams({ tab: section });
    if (opts?.project) query.set('project', opts.project);
    if (opts?.group) query.set('group', opts.group);
    if (opts?.member) query.set('member', opts.member);
    router.replace(`/accounts/${accountId}?${query.toString()}`, { scroll: false });
  };

  return (
    <div className="mx-auto w-full max-w-6xl pb-10">
      {accountQuery.isError ? (
        <ErrorState
          size="sm"
          title="Failed to load account"
          description={(accountQuery.error as Error).message}
          action={
            <Button variant="outline" size="sm" onClick={() => accountQuery.refetch()}>
              Retry
            </Button>
          }
        />
      ) : accountQuery.isLoading ? (
        <div className="lg:grid lg:grid-cols-[208px_minmax(0,1fr)] lg:gap-12">
          <div className="mb-6 space-y-4 lg:mb-0">
            <div className="flex items-center gap-2.5">
              <Skeleton className="size-8 rounded-md" />
              <Skeleton className="h-5 w-32 rounded-md" />
            </div>
            <div className="space-y-1">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-8 w-full rounded-md" />
              ))}
            </div>
          </div>
          <div className="max-w-3xl space-y-4">
            <Skeleton className="h-7 w-40 rounded-md" />
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-[58px] w-full rounded-md" />
              ))}
            </div>
          </div>
        </div>
      ) : account ? (
        /* The account hub's own column is the `mx-auto w-full max-w-6xl pb-10`
           wrapper this whole page already sits in — the shell draws the grid
           only, so each host keeps the gutter its route calls for. */
        <SettingsShell
          activeKey={activeSection}
          contentClassName={activeSection === 'transactions' ? 'max-w-6xl' : undefined}
          rail={
            <SettingsRail
              groups={railGroups}
              activeId={activeSection}
              onSelect={(id) => navigate(id as AccountSection)}
              ariaLabel="Account sections"
              identity={
                <div className="flex min-w-0 items-center gap-2.5 px-1">
                  <EntityAvatar label={account.name || 'Account'} size="md" />
                  <div className="min-w-0">
                    <p className="text-foreground truncate text-sm font-medium">{account.name}</p>
                    {/* `members` is `[]` for a caller without `member.read` — the
                        query never runs — and "0 members" on an account they are
                        demonstrably a member of is a lie, not a placeholder. */}
                    {sectionVisible.members && !membersQuery.isLoading ? (
                      <p className="text-muted-foreground text-xs">
                        {members.length} member{members.length === 1 ? '' : 's'}
                      </p>
                    ) : null}
                  </div>
                </div>
              }
            />
          }
        >
          <>
            {paneMeta ? (
              <div className="mb-6 space-y-1">
                <h2 className="text-foreground text-xl font-medium">{paneMeta.title}</h2>
                <p className="text-muted-foreground text-sm">{paneMeta.description}</p>
              </div>
            ) : null}

            {activeSection === 'billing' && canWriteAccount ? (
              <div className="space-y-6">
                {/* Scope every billing hook nested below to this account so a
                    multi-account user doesn't see (or mutate) their primary
                    account by accident. */}
                <BillingAccountProvider accountId={account.account_id}>
                  <BillingTab
                    // Stripe Billing Portal requires an absolute return_url —
                    // a bare path 500s with "Not a valid URL". Build from origin.
                    returnUrl={
                      typeof window !== 'undefined'
                        ? `${window.location.origin}/accounts/${account.account_id}?tab=billing`
                        : `/accounts/${account.account_id}?tab=billing`
                    }
                    isActive
                  />
                  {/* The "Subscribe to Team plan" button opens the global
                      upgrade-dialog store; mount its renderer here (the global
                      one lives only on share pages) so the dialog actually
                      appears, scoped to THIS account via the provider above. */}
                  <GlobalUpgradeModal />
                </BillingAccountProvider>
              </div>
            ) : null}

            {activeSection === 'transactions' && canWriteAccount ? (
              <BillingAccountProvider accountId={account.account_id}>
                <TransactionsTab />
              </BillingAccountProvider>
            ) : null}

            {activeSection === 'members' && sectionVisible.members ? (
              selectedAccessMemberId ? (
                <MemberAccessPanel
                  key={selectedAccessMemberId}
                  accountId={account.account_id}
                  accountName={account.name}
                  memberUserId={selectedAccessMemberId}
                  currentUserId={user.id}
                  canUpdateRole={canUpdateMember}
                  canRemove={canRemoveMember}
                  rbacEnabled={rbacEnabled}
                  canManageRoles={canManageRoles}
                  canReadPolicies={canReadPolicies}
                  canReadRoles={canReadRoles}
                  onBack={() => navigate('members')}
                  onOpenGroup={(groupId) => navigate('groups', { group: groupId })}
                />
              ) : (
                <MembersCard
                  account={account}
                  members={members}
                  isLoading={membersQuery.isLoading}
                  isError={membersQuery.isError}
                  error={membersQuery.error as Error | null}
                  onRetry={() => membersQuery.refetch()}
                  queryClient={queryClient}
                  currentUserId={user.id}
                  canInvite={canInviteMember}
                  canRemove={canRemoveMember}
                  canUpdateRole={canUpdateMember}
                  canAddToGroup={canManageGroupMembers}
                  rbacEnabled={rbacEnabled}
                  canManageRoles={canManageRoles}
                  canReadRoles={canReadRoles}
                  canReadPolicies={canReadPolicies}
                  onSelectMember={(id) => navigate('members', { member: id })}
                />
              )
            ) : null}

            {activeSection === 'groups' && sectionVisible.groups ? (
              entitlementsLoading ? (
                <Skeleton className="h-64 w-full rounded-md" />
              ) : (
                <GroupsTab
                  accountId={account.account_id}
                  canCreate={canCreateGroup}
                  rbacEnabled={rbacEnabled}
                  canReadRoles={canReadRoles}
                  canReadPolicies={canReadPolicies}
                  selectedGroupId={selectedAccessGroupId}
                  onSelectGroup={(id) => navigate('groups', { group: id })}
                />
              )
            ) : null}

            {activeSection === 'access-projects' ? (
              <AccessProjectsTab
                accountId={account.account_id}
                selectedProjectId={selectedAccessProjectId}
                onSelectProject={(id) => navigate('access-projects', { project: id })}
                rbacEnabled={rbacEnabled}
                canManageRoles={canManageRoles}
              />
            ) : null}

            {activeSection === 'help' ? <AccessHelp accountId={account.account_id} /> : null}

            {activeSection === 'roles' && sectionVisible.roles ? (
              entitlementsLoading ? (
                <Skeleton className="h-64 w-full rounded-md" />
              ) : (
                <RolesTab
                  accountId={account.account_id}
                  canManage={canManageRoles}
                  rbacEnabled={rbacEnabled}
                />
              )
            ) : null}

            {activeSection === 'audit' && canReadAudit ? (
              <div className="space-y-10">
                {entitlementsLoading ? (
                  <Skeleton className="h-64 w-full rounded-md" />
                ) : auditEnabled ? (
                  <AuditTab accountId={account.account_id} />
                ) : (
                  <EnterpriseUpsell feature="audit" />
                )}
                {/* Webhooks ship the same events the log above shows, so they
                    live on this tab rather than buried in Settings. Only
                    rendered entitled + writable — the card is all mutations. */}
                {!entitlementsLoading && auditEnabled && canWriteAccount ? (
                  <AuditWebhooksCard accountId={account.account_id} canManage={canWriteAccount} />
                ) : null}
              </div>
            ) : null}

            {activeSection === 'git' && canWriteAccount ? (
              <div className="space-y-8">
                <GitHubConnectionCard account={account} canManage={canWriteAccount} />
                <GitHubAppSetupCard canManage={canWriteAccount} />
              </div>
            ) : null}

            {/* Tokens — the machine-access surface, and ONLY that since
                2026-08-18: service account tokens first, the rules that govern
                them second. A person's own API keys are not account
                configuration and left for `/settings/tokens`
                (`features/workspace/settings/tabs/tokens-tab.tsx`);
                `ApiKeysSection` carries the one line that points there. Both
                components carry their own section headers, so the pane header
                above is the only other chrome. */}
            {activeSection === 'tokens' && canWriteAccount ? (
              <div className="space-y-10">
                <ApiKeysSection accountId={account.account_id} canManage={canWriteAccount} />
                <KeyRulesCard accountId={account.account_id} canManage={canWriteAccount} />
              </div>
            ) : null}

            {/* Identity — SAML SSO + SCIM. Ordering + copy make the
                relationship explicit (SAML first, SCIM second — provisioned
                accounts still need SSO to sign in) without merging the two
                working cards into a new surface. The self-serve
                enterprise-demo toggle now lives in Settings (see below) —
                it's an account-level unlock, not part of the identity
                journey itself. */}
            {activeSection === 'identity' && canWriteAccount ? (
              <div className="space-y-3">
                {entitlementsLoading ? (
                  <Skeleton className="h-40 w-full rounded-md" />
                ) : enterpriseIdentityEnabled ? (
                  <>
                    {/* Onboarding copy only — self-hides once either surface
                        is configured (see IdentityIntro). */}
                    <IdentityIntro accountId={account.account_id} />
                    <SsoCard accountId={account.account_id} canManage={canWriteAccount} />
                    <ScimCard accountId={account.account_id} canManage={canWriteAccount} />
                  </>
                ) : (
                  <EnterpriseUpsell feature="identity" />
                )}
              </div>
            ) : null}

            {activeSection === 'settings' && canWriteAccount ? (
              <div className="space-y-10">
                <SettingsGroup title="General">
                  <GeneralCard
                    account={account}
                    queryClient={queryClient}
                    canWrite={canWriteAccount}
                  />
                </SettingsGroup>

                {/* MFA and the session policy are one decision — how hard it
                    is to hold a session here — so they share one bordered
                    group. The "Advanced" disclosure that used to hide session
                    lifetime + idle timeout is gone: as full cards they were
                    genuinely too much, as two rows they cost two lines. See
                    `components/iam/session-controls-card.tsx`. */}
                <SettingsGroup title="Security" description="Account-wide sign-in requirements.">
                  <SettingsRowGroup>
                    <MfaRequiredCard accountId={account.account_id} canManage={canWriteAccount} />
                    <SessionControlsCard
                      accountId={account.account_id}
                      canManage={canWriteAccount}
                    />
                  </SettingsRowGroup>
                  <AccountSessionsPanel
                    accountId={account.account_id}
                    canManage={canWriteAccount}
                  />
                </SettingsGroup>

                {/* Tucked away, not headline: this reports whether the
                    Enterprise surface (SSO/SCIM/RBAC/audit) is unlocked for
                    evaluation, not a feature admins configure day-to-day. The
                    toggle is platform-admin-only now; account admins see the
                    state read-only (see EnterpriseDemoCard). Hidden entirely
                    when a self-host operator's Enterprise license already
                    forces every entitlement on — there's nothing left to
                    demo-toggle or upsell in that case. */}
                {!entitlementsLoading && !accountStateQuery.data?.enterprise_license_available ? (
                  <SettingsGroup
                    title="Enterprise features"
                    description="Preview SSO, SCIM, advanced RBAC, and audit logs before upgrading."
                  >
                    <SettingsRowGroup>
                      <EnterpriseDemoCard
                        accountId={account.account_id}
                        canManage={canWriteAccount}
                      />
                    </SettingsRowGroup>
                  </SettingsGroup>
                ) : null}

                {canDeleteAccount ? (
                  <SettingsGroup title="Danger zone">
                    <DangerZoneCard />
                  </SettingsGroup>
                ) : null}
              </div>
            ) : null}
          </>
        </SettingsShell>
      ) : null}
    </div>
  );
}

// ============================== GIT ==============================

function GitHubConnectionCard({
  account,
  canManage,
}: {
  account: AccountDetail;
  canManage: boolean;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [disconnectTarget, setDisconnectTarget] = useState<{
    installationId: string;
    ownerLogin: string | null;
  } | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);

  const installationsQuery = useQuery({
    queryKey: ['github-installations', account.account_id],
    queryFn: () => listGitHubInstallations(account.account_id),
    staleTime: 0,
  });

  const disconnectMutation = useMutation({
    mutationFn: (installationId: string) =>
      deleteGitHubInstallation(account.account_id, installationId),
    onSuccess: () => {
      successToast('GitHub disconnected');
      setDisconnectTarget(null);
      queryClient.invalidateQueries({
        queryKey: ['github-installations', account.account_id],
      });
      queryClient.invalidateQueries({
        queryKey: ['github-repositories', account.account_id],
      });
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to disconnect GitHub'),
  });

  function handleConnect() {
    if (!canManage) return;
    setIsConnecting(true);
    rememberGitHubSetupReturn(`/accounts/${account.account_id}?tab=git`);
    router.push(`/github/setup?account_id=${encodeURIComponent(account.account_id)}`);
  }

  const installations = (installationsQuery.data?.installations ?? []).filter((installation) =>
    isGitHubAppInstallationId(installation.installation_id),
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-0.5">
          <span className="flex items-center gap-1">
            <p className="text-foreground text-sm font-medium">GitHub connections</p>
            <Hint label="Kortix stores the GitHub App installation on the account, not on individual members — Git credentials are platform credentials.">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="About Git credentials"
                className="text-muted-foreground hover:text-foreground size-5"
              >
                <Info className="size-3.5" />
              </Button>
            </Hint>
          </span>
          <p className="text-muted-foreground text-xs">
            Link an existing App installation or install the App for a GitHub account.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="gap-1.5"
          disabled={!canManage || isConnecting}
          onClick={handleConnect}
          title={canManage ? undefined : 'You do not have permission to connect GitHub.'}
        >
          {isConnecting ? <Loading className="size-4 shrink-0" /> : <Github className="size-4" />}
          {isConnecting ? 'Connecting' : 'Add account'}
        </Button>
      </div>

      {installationsQuery.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-[58px] w-full rounded-md" />
        </div>
      ) : installationsQuery.isError ? (
        <InfoBanner tone="warning" icon={Github} title="GitHub status unavailable">
          {(installationsQuery.error as Error).message}
        </InfoBanner>
      ) : installations.length === 0 ? (
        // Quiet contained empty state — the toolbar above already carries the
        // single "Connect GitHub" CTA.
        <div className="border-border text-muted-foreground rounded-md border border-dashed px-4 py-8 text-center text-sm">
          No GitHub connections yet. Add an existing App installation or install the App.
        </div>
      ) : (
        <ul className="space-y-2">
          {installations.map((installation) => {
            const contentsPermission = permissionLabel(installation.permissions?.contents);
            const repoSelection =
              installation.repository_selection === 'selected'
                ? 'Selected repositories'
                : installation.repository_selection === 'all'
                  ? 'All repositories'
                  : null;
            const installationId = installation.installation_id ?? '';
            return (
              <li
                key={installationId || installation.owner_login || 'github'}
                className={ACCESS_ROW_CLASS}
              >
                <EntityAvatar icon={Github} size="md" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-foreground truncate text-sm font-medium">
                      {installation.owner_login ?? 'GitHub App'}
                    </span>
                    <Badge variant="success" size="sm">
                      Connected
                    </Badge>
                  </div>
                  <span className="text-muted-foreground text-xs">
                    <InlineMeta>
                      {installation.owner_type ? <span>{installation.owner_type}</span> : null}
                      {repoSelection ? <span>{repoSelection}</span> : null}
                      {contentsPermission ? <span>{contentsPermission}</span> : null}
                    </InlineMeta>
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {installation.installation_url ? (
                    <Button asChild variant="ghost" size="sm" className="gap-1.5">
                      <a
                        href={installation.installation_url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <ExternalLink className="size-3.5" />
                        Configure
                      </a>
                    </Button>
                  ) : null}
                  {canManage && installationId ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="gap-1.5"
                      onClick={() =>
                        setDisconnectTarget({
                          installationId,
                          ownerLogin: installation.owner_login,
                        })
                      }
                    >
                      <Unplug className="size-3.5" />
                      Disconnect
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmDialog
        open={Boolean(disconnectTarget)}
        onOpenChange={(open) => !open && setDisconnectTarget(null)}
        title="Disconnect GitHub"
        description={`New imports from ${disconnectTarget?.ownerLogin ?? 'this GitHub account'} will stop working until it is connected again. Existing projects keep their repository link.`}
        confirmLabel="Disconnect"
        onConfirm={() => {
          if (disconnectTarget) {
            disconnectMutation.mutate(disconnectTarget.installationId);
          }
        }}
        isPending={disconnectMutation.isPending}
      />
    </div>
  );
}

function permissionLabel(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  return `Contents ${value}`;
}

// ============================== SETTINGS ==============================

/**
 * Visual grouping for the Settings tab: a `Label` heading with an optional
 * one-line description over the group's panels — same dialect as the
 * customize settings view.
 */
function SettingsGroup({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <Label>{title}</Label>
        {description ? <p className="text-muted-foreground text-xs">{description}</p> : null}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function GeneralCard({
  account,
  queryClient,
  canWrite,
}: {
  account: AccountDetail;
  queryClient: ReturnType<typeof useQueryClient>;
  canWrite: boolean;
}) {
  const [name, setName] = useState(account.name);

  useEffect(() => {
    setName(account.name);
  }, [account.name]);

  const renameMutation = useMutation({
    mutationFn: (next: string) => updateAccountName(account.account_id, next),
    onSuccess: (updated) => {
      successToast('Account updated');
      queryClient.setQueryData(['account', account.account_id], updated);
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to update account'),
  });

  const trimmed = name.trim();
  const canSubmit = canWrite && trimmed.length > 0 && trimmed !== account.name;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    renameMutation.mutate(trimmed);
  }

  return (
    <form onSubmit={handleSubmit} className="bg-popover rounded-md border">
      <div className="space-y-1.5 px-4 py-5">
        <Label htmlFor="account-name">Account name</Label>
        <Input
          id="account-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={!canWrite || renameMutation.isPending}
          maxLength={120}
          className="max-w-md"
          title={canWrite ? undefined : 'You do not have permission to rename this account.'}
        />
        {!canWrite ? (
          <p className="text-muted-foreground text-xs">
            You do not have permission to rename this account.
          </p>
        ) : null}
      </div>

      <div className="border-border flex items-center justify-between border-t px-4 py-3">
        <p className="text-muted-foreground text-xs">Created {formatDate(account.created_at)}</p>
        <Button
          type="submit"
          size="sm"
          disabled={!canSubmit || renameMutation.isPending}
          className="gap-1.5"
        >
          {renameMutation.isPending ? <Loading className="size-4 shrink-0" /> : null}
          Save
        </Button>
      </div>
    </form>
  );
}

function DangerZoneCard() {
  return (
    <div className="bg-popover rounded-md border px-4 py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-foreground text-sm font-medium">Delete account</p>
          <p className="text-muted-foreground mt-0.5 text-xs">
            Permanently deletes this account and all its projects.
          </p>
        </div>
        <Button variant="outline" size="sm" disabled title="Coming soon" className="shrink-0">
          Coming soon
        </Button>
      </div>
    </div>
  );
}

// ============================== MEMBERS ==============================
//
// One list dialect (`AccessList` + `AccessRow`) and ONE modal (`AccessDialog`)
// for every "give / edit access" interaction on this tab. What used to live
// here and is now gone: `InviteMemberModal` (457 lines), `BulkAddToGroupDialog`,
// `BulkSetRoleDialog`, `RoleBadge`, the `DropdownMenuRadioGroup` role changer
// and its "Change role" confirm, and the `MEMBER_ROW` class copy.

function MembersCard({
  account,
  members,
  isLoading,
  isError,
  error,
  onRetry,
  queryClient,
  currentUserId,
  canInvite,
  canRemove,
  canUpdateRole,
  canAddToGroup,
  rbacEnabled,
  canManageRoles,
  canReadRoles,
  canReadPolicies,
  onSelectMember,
}: {
  account: AccountDetail;
  members: AccountMember[];
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  onRetry: () => void;
  queryClient: ReturnType<typeof useQueryClient>;
  currentUserId: string;
  canInvite: boolean;
  canRemove: boolean;
  canUpdateRole: boolean;
  /** `group.members.manage` — gates the bulk "Add to group" action. */
  canAddToGroup: boolean;
  /** Tier carries the `rbac` entitlement — gates the custom-role group. */
  rbacEnabled: boolean;
  canManageRoles: boolean;
  /** `role.read` — the leaf `GET .../iam/roles` asserts. PERMISSION, not
   *  entitlement: an entitled account whose viewer is a plain member holds
   *  neither `role.read` nor `policy.read` — both live in `ADMIN_EXTRAS`
   *  (`apps/api/src/iam/role-perms.ts`), never in `MEMBER_BASELINE`. */
  canReadRoles: boolean;
  /** `policy.read` — the leaf `GET .../iam/policies` asserts. */
  canReadPolicies: boolean;
  /** Opens one member's `MemberAccessPanel` in this same pane
   *  (`?tab=members&member=<id>`) — no route change, the rail stays. */
  onSelectMember: (userId: string) => void;
}) {
  const router = useRouter();
  const [grantOpen, setGrantOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<AccountMember | null>(null);
  // Set rather than scalar so multiple per-row mutations (remove + role
  // change on different rows) can fly in parallel without their spinners
  // hopping between rows. Helpers below add/remove on mutate/settle.
  const [pendingUserIds, setPendingUserIds] = useState<Set<string>>(() => new Set());
  const markPending = (userId: string) => setPendingUserIds((prev) => new Set(prev).add(userId));
  const clearPending = (userId: string) =>
    setPendingUserIds((prev) => {
      const next = new Set(prev);
      next.delete(userId);
      return next;
    });
  const [removeTarget, setRemoveTarget] = useState<AccountMember | null>(null);
  const [leaveConfirmOpen, setLeaveConfirmOpen] = useState(false);
  // Free-text search over email + user_id. Lives in component state so
  // it doesn't survive tab switches — admins almost never want to jump
  // back to the same search after navigating away.
  const [search, setSearch] = useState('');
  // Bulk-select state. Users can't bulk-modify themselves (would let an
  // admin lock themselves out by demoting their own row in a sweep).
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDialog, setBulkDialog] = useState<'set_role' | 'add_to_group' | 'remove' | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  // A member's role is ONE value — a built-in account role, or a custom role
  // that rides on the `member` baseline plus one account-scoped
  // `iam_policies` row. The row and the dialog read it through the same
  // `RoleValue`, so neither has to know which of the two it is.
  // Both reads are gated on TWO independent axes, and both must hold:
  //
  //  1. ENTITLEMENT (`rbacEnabled`) — without `rbac` there are no custom roles
  //     and no policies to resolve, so every row's role is the built-in one.
  //  2. PERMISSION (`canReadRoles` / `canReadPolicies`) — `GET .../iam/roles`
  //     asserts `role.read` and `GET .../iam/policies` asserts `policy.read`
  //     (`apps/api/src/accounts/iam/custom-roles.ts`). Both leaves sit in
  //     `ADMIN_EXTRAS`; `MEMBER_BASELINE` holds neither
  //     (`apps/api/src/iam/role-perms.ts`).
  //
  // The entitlement alone was the gate until now, which meant an entitled
  // account whose viewer is an ordinary member fired both requests on every
  // hub load and took two background 403s for data it can never render.
  // `=== true` deliberately, not `!== false`: the probe answers `false` while
  // in flight, so an optimistic gate would fire the very request it exists to
  // suppress before the verdict arrives.
  const rolesQuery = useAccountRoles(account.account_id, rbacEnabled && canReadRoles === true);
  const policiesQuery = useQuery({
    queryKey: ['iam-policies', account.account_id],
    queryFn: () => listPolicies(account.account_id),
    enabled: rbacEnabled && canReadPolicies === true,
    staleTime: 30_000,
  });
  const accountPolicyByUser = useMemo(() => {
    const map = new Map<string, IamPolicy>();
    for (const policy of policiesQuery.data ?? []) {
      if (policy.principal_type === 'member' && policy.scope_type === 'account') {
        map.set(policy.principal_id, policy);
      }
    }
    return map;
  }, [policiesQuery.data]);
  const roleValueFor = (member: AccountMember): RoleValue => {
    const policy = accountPolicyByUser.get(member.user_id);
    return policy ? customRole(policy.role_id) : builtinRole(member.account_role);
  };

  const sorted = useMemo(() => {
    const rank: Record<AccountRole, number> = { owner: 0, admin: 1, member: 2 };
    const q = search.trim().toLowerCase();
    const filtered = q
      ? members.filter((m) => {
          // Match against email (most common) and user_id (for the rare
          // case where an admin only knows the auth uuid).
          const email = (m.email ?? '').toLowerCase();
          return email.includes(q) || m.user_id.toLowerCase().includes(q);
        })
      : members;
    return [...filtered].sort((a, b) => {
      const r = rank[a.account_role] - rank[b.account_role];
      if (r !== 0) return r;
      return principalLabel(a).localeCompare(principalLabel(b));
    });
  }, [members, search]);

  const invalidateMembers = () => {
    // Membership, roles and invites all move verdicts. Probes are cached 5
    // minutes, so a change that is not busted here renders as stale access.
    void invalidatePermissionProbes(queryClient, { accountId: account.account_id });
    queryClient.invalidateQueries({
      queryKey: ['account-members', account.account_id],
    });
    queryClient.invalidateQueries({
      queryKey: ['account-invites', account.account_id],
    });
    queryClient.invalidateQueries({
      queryKey: ['account', account.account_id],
    });
  };

  const removeMutation = useMutation({
    mutationFn: (userId: string) => removeAccountMember(account.account_id, userId),
    onMutate: (userId) => markPending(userId),
    onSettled: (_data, _error, userId) => clearPending(userId),
    onSuccess: () => {
      successToast('Member removed');
      invalidateMembers();
      setRemoveTarget(null);
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to remove member'),
  });

  const leaveMutation = useMutation({
    mutationFn: () => leaveAccount(account.account_id),
    onMutate: () => markPending(currentUserId),
    onSettled: () => clearPending(currentUserId),
    onSuccess: () => {
      successToast(`Left ${account.name}`);
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      router.push('/accounts');
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to leave team'),
  });

  // Bulk surface only shows when the caller can actually do something
  // useful (change role, add to a group, OR remove).
  const canBulk = canUpdateRole || canRemove || canAddToGroup;
  // Eligible for bulk = visible after filter, excluding the current user
  // and any pending row.
  const bulkEligible = useMemo(
    () => sorted.filter((m) => m.user_id !== currentUserId),
    [sorted, currentUserId],
  );
  // Effective selection = what's both clicked AND currently eligible.
  // We don't prune selectedIds when the search filter changes (so the
  // user can temporarily filter to scan a name without losing their
  // selection), but every consumer — the "X selected" badge, the action
  // buttons, bulkRun — has to act on the intersection. Without this,
  // selecting alice/bob/charlie then typing "alice" in the search bar
  // would display "3 selected" and silently fire bulk actions on all 3,
  // not just the visible row.
  const effectiveSelectedIds = useMemo(() => {
    const eligibleIds = new Set(bulkEligible.map((m) => m.user_id));
    return new Set(Array.from(selectedIds).filter((id) => eligibleIds.has(id)));
  }, [selectedIds, bulkEligible]);
  const selectedCount = effectiveSelectedIds.size;
  const allEligibleSelected =
    bulkEligible.length > 0 && bulkEligible.every((m) => selectedIds.has(m.user_id));
  function toggleOne(userId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }
  function toggleAllEligible() {
    if (allEligibleSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(bulkEligible.map((m) => m.user_id)));
    }
  }
  function clearSelection() {
    setSelectedIds(new Set());
  }

  // The principals the bulk-role dialog acts on, in list order.
  const bulkPrincipals: AccessDialogPrincipal[] = useMemo(
    () =>
      bulkEligible
        .filter((m) => effectiveSelectedIds.has(m.user_id))
        .map((m) => ({ type: 'member' as const, id: m.user_id, label: principalLabel(m) })),
    [bulkEligible, effectiveSelectedIds],
  );

  // Bulk remove — the existing per-user endpoint fanned out with
  // Promise.allSettled so a single failure doesn't block the others. On any
  // failure we:
  //   1. console.error a full table (email + userId + reason) — admins
  //      doing bulk ops are likely to have devtools open.
  //   2. surface the FIRST failure reason inline in the toast so the
  //      user sees at least one actionable hint without expanding it.
  //   3. preserve the failed selection so they can retry only those rows.
  // `AccessDialog`'s bulk-role mode applies the same rule through
  // `onDone.failedPrincipalIds`.
  async function bulkRun(
    label: string,
    runOne: (userId: string) => Promise<unknown>,
  ): Promise<void> {
    setBulkBusy(true);
    // Use the eligible intersection — see effectiveSelectedIds above for
    // why we don't just iterate selectedIds. A row that's been
    // filtered out of view shouldn't be silently included in the bulk
    // action just because it was clicked before the filter applied.
    const ids = Array.from(effectiveSelectedIds);
    let results: PromiseSettledResult<unknown>[];
    try {
      results = await Promise.allSettled(ids.map(runOne));
    } finally {
      setBulkBusy(false);
    }
    invalidateMembers();

    const failures: { userId: string; email: string; reason: string }[] = [];
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        const userId = ids[i];
        const member = members.find((m) => m.user_id === userId);
        failures.push({
          userId,
          email: member?.email ?? userId,
          reason:
            r.reason instanceof Error ? r.reason.message : String(r.reason ?? 'Unknown error'),
        });
      }
    });

    if (failures.length === 0) {
      successToast(`${label}: ${ids.length} member${ids.length === 1 ? '' : 's'}`);
      clearSelection();
      setBulkDialog(null);
      return;
    }

    // Devtools-friendly dump. console.error renders one row per failure
    // so an admin can copy/paste or grep through them.
    console.error(`[bulk:${label}] ${failures.length} failed`, failures);

    // First failure is shown inline; rest summarised. Trim long
    // messages so a 500-char stack trace doesn't blow up the toast.
    const first = failures[0];
    const reasonShort = first.reason.length > 140 ? `${first.reason.slice(0, 137)}…` : first.reason;
    const tail = failures.length > 1 ? ` (+${failures.length - 1} more — see console)` : '';
    errorToast(
      `${label}: ${ids.length - failures.length} succeeded, ${failures.length} failed. ${first.email}: ${reasonShort}${tail}`,
    );
    // Drop succeeded rows from the selection so a retry only re-runs
    // the ones that failed.
    const failedIds = new Set(failures.map((f) => f.userId));
    setSelectedIds(failedIds);
  }

  const editRoleValue = editTarget ? roleValueFor(editTarget) : null;

  return (
    <div className="space-y-4">
      {isError ? (
        <ErrorState
          size="sm"
          title="Failed to load members"
          description={error?.message}
          action={
            <Button variant="outline" size="sm" onClick={onRetry}>
              Retry
            </Button>
          }
        />
      ) : null}

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-[58px] w-full rounded-md" />
          ))}
        </div>
      ) : null}

      {/* Search filters EVERYTHING below it — pending invites + members
          alike. Looking up "@foo.com" shouldn't care whether the person has
          accepted yet; they're all people you're trying to find. */}
      {!isLoading && !isError ? (
        <>
          <div className="flex items-center gap-2">
            <InputGroupSearch className="flex-1">
              <InputGroupSearchIcon>
                <Search />
              </InputGroupSearchIcon>
              <InputGroupSearchInput
                placeholder="Search members"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                variant="popover"
              />
              {search ? <InputGroupSearchClear onClick={() => setSearch('')} /> : null}
            </InputGroupSearch>
            {canInvite ? (
              <Button
                variant="secondary"
                className="shrink-0 gap-1.5"
                onClick={() => setGrantOpen(true)}
              >
                <Plus className="size-4" />
                Invite
              </Button>
            ) : null}
          </div>

          {/* Bulk bar. It is the ONLY place a select-all control lives — the
              list header used to carry a permanently visible "Select all
              visible" checkbox, which put a bulk affordance on screen before
              anyone had asked for one (Marko, 2026-08-18). Row checkboxes stay
              in `AccessRow`; everything else appears once a row is ticked. */}
          {selectedCount > 0 && canBulk ? (
            <div className="bg-popover flex flex-wrap items-center gap-2 rounded-md border px-4 py-2 text-sm">
              <span className="text-foreground text-xs font-medium">{selectedCount} selected</span>
              <Button
                size="sm"
                variant="ghost"
                onClick={toggleAllEligible}
                disabled={bulkBusy}
                className="text-muted-foreground"
              >
                {allEligibleSelected ? 'Deselect all' : 'Select all'}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={clearSelection}
                disabled={bulkBusy}
                className="text-muted-foreground"
              >
                Clear
              </Button>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                {canUpdateRole ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setBulkDialog('set_role')}
                    disabled={bulkBusy}
                  >
                    Change role
                  </Button>
                ) : null}
                {canAddToGroup ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setBulkDialog('add_to_group')}
                    disabled={bulkBusy}
                  >
                    Add to group
                  </Button>
                ) : null}
                {canRemove ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setBulkDialog('remove')}
                    disabled={bulkBusy}
                  >
                    Remove
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}

          <PendingInvitesSection
            accountId={account.account_id}
            canManage={canInvite}
            search={search}
          />

          {members.length > 0 && sorted.length === 0 ? (
            <p className="text-muted-foreground px-3 py-6 text-center text-xs">
              No members match “{search.trim()}”.
            </p>
          ) : null}

          {sorted.length > 0 ? (
            <AccessList
              // Count what THIS caller can actually see, not the raw total.
              // The roster is visibility-filtered server-side for plain
              // members (owners/admins + self), while account.member_count is
              // the unfiltered COUNT(*) — using it would leak the roster size
              // and mismatch the list below.
              // No `selectable` on the LIST: the header's select-all control
              // is gone. Selection starts on a row checkbox, and only then
              // does the bulk bar above offer "Select all" / "Deselect all".
              header={{ title: 'Members', count: sorted.length }}
            >
              {sorted.map((member) => {
                const isSelf = member.user_id === currentUserId;
                const isLastOwner =
                  member.account_role === 'owner' &&
                  sorted.filter((m) => m.account_role === 'owner').length === 1;
                const pending = pendingUserIds.has(member.user_id);
                const label = principalLabel(member);
                const roleValue = roleValueFor(member);

                const kebab: KebabItem[] = [];
                if (canUpdateRole && !isSelf) {
                  kebab.push({
                    label: 'Edit access',
                    icon: <PencilSimple className="size-3.5" />,
                    onSelect: () => setEditTarget(member),
                  });
                }
                kebab.push({
                  label: 'View access',
                  icon: <KeyRound className="size-3.5" />,
                  onSelect: () => onSelectMember(member.user_id),
                });
                if (canRemove && !isSelf) {
                  kebab.push({
                    label: 'Remove from account',
                    icon: <TrashIcon className="size-3.5" />,
                    variant: 'destructive',
                    separated: true,
                    disabled: isLastOwner,
                    onSelect: () => setRemoveTarget(member),
                  });
                }
                if (isSelf) {
                  kebab.push({
                    label: 'Leave account',
                    icon: <TrashIcon className="size-3.5" />,
                    variant: 'destructive',
                    separated: true,
                    disabled: isLastOwner,
                    onSelect: () => setLeaveConfirmOpen(true),
                  });
                }

                return (
                  <AccessRow
                    key={member.user_id}
                    leading={
                      <UserAvatar
                        email={member.email ?? member.user_id}
                        name={member.email ?? undefined}
                        size="md"
                      />
                    }
                    title={label}
                    badges={
                      <>
                        {isSelf ? (
                          <Badge variant="secondary" size="sm">
                            You
                          </Badge>
                        ) : null}
                        {member.is_super_admin ? (
                          <Badge
                            size="sm"
                            className="bg-kortix-orange/15 text-kortix-orange border-transparent"
                            title="Super admin — bypasses every IAM check"
                          >
                            Super
                          </Badge>
                        ) : null}
                        {member.has_verified_mfa ? (
                          <Badge variant="success" size="sm" title="MFA enrolled">
                            2FA
                          </Badge>
                        ) : account.mfa_required && !member.is_super_admin ? (
                          // Account requires MFA and this member has no verified
                          // factor — they're blocked from gated actions until they
                          // enrol. Super-admins are exempt, so they're not flagged.
                          <Badge
                            variant="destructive"
                            size="sm"
                            title="MFA required but not enrolled — this member is blocked from gated actions"
                          >
                            No 2FA
                          </Badge>
                        ) : null}
                      </>
                    }
                    meta={<MemberMeta member={member} />}
                    trailing={roleValueLabel('account', roleValue, rolesQuery.data)}
                    selectable={
                      canBulk
                        ? {
                            // Self rows can't be bulk-acted on — would let an
                            // admin demote / remove themselves in a sweep — but
                            // they still reserve the checkbox column so every
                            // avatar lines up.
                            reserveSpace: isSelf,
                            checked: selectedIds.has(member.user_id),
                            onCheckedChange: () => toggleOne(member.user_id),
                            label: `Select ${label}`,
                          }
                        : undefined
                    }
                    pending={pending}
                    kebab={kebab}
                    kebabLabel={`Actions for ${label}`}
                  />
                );
              })}
            </AccessList>
          ) : null}

          {members.length === 0 ? (
            <EmptyState
              icon={Users}
              size="sm"
              title="No members yet"
              description="Invite people to work in this account."
              action={
                canInvite ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    onClick={() => setGrantOpen(true)}
                  >
                    <UserPlus className="size-3.5" />
                    Invite
                  </Button>
                ) : undefined
              }
            />
          ) : null}
        </>
      ) : null}

      {/* ── The one modal. Grant / edit / bulk-role are three modes of it. ── */}
      <AccessDialog
        open={grantOpen}
        onOpenChange={setGrantOpen}
        accountId={account.account_id}
        accountName={account.name}
        scope={{ kind: 'account' }}
        mode={{ kind: 'grant' }}
        rbacEnabled={rbacEnabled}
        canManageRoles={canManageRoles}
        onDone={invalidateMembers}
      />

      {editTarget && editRoleValue ? (
        <AccessDialog
          open
          onOpenChange={(open) => {
            if (!open) setEditTarget(null);
          }}
          accountId={account.account_id}
          accountName={account.name}
          scope={{ kind: 'account' }}
          mode={{
            kind: 'edit',
            principal: {
              type: 'member',
              id: editTarget.user_id,
              label: principalLabel(editTarget),
            },
            // No `assignmentId`: the roster still carries legacy policy ids,
            // which are NOT assignment ids. The dialog reads the row back.
            current: { role: editRoleValue },
          }}
          rbacEnabled={rbacEnabled}
          canManageRoles={canManageRoles}
          onDone={invalidateMembers}
        />
      ) : null}

      <AccessDialog
        open={bulkDialog === 'set_role'}
        onOpenChange={(open) => {
          if (!open) setBulkDialog(null);
        }}
        accountId={account.account_id}
        accountName={account.name}
        scope={{ kind: 'account' }}
        mode={{ kind: 'bulk-role', principals: bulkPrincipals }}
        rbacEnabled={rbacEnabled}
        canManageRoles={canManageRoles}
        onDone={({ failedPrincipalIds }) => {
          invalidateMembers();
          // Partial failure keeps exactly the failed rows selected so a
          // retry re-runs only those.
          setSelectedIds(new Set(failedPrincipalIds));
          if (failedPrincipalIds.length === 0) setBulkDialog(null);
        }}
      />

      {/* Bulk "Add to group" — one `addGroupMembers` call for every selected
          row, through the same modal chrome as every other access dialog. */}
      <AccessDialog
        open={bulkDialog === 'add_to_group'}
        onOpenChange={(open) => {
          if (!open) setBulkDialog(null);
        }}
        accountId={account.account_id}
        accountName={account.name}
        scope={{ kind: 'account' }}
        mode={{ kind: 'bulk-group', principals: bulkPrincipals }}
        onDone={({ failedPrincipalIds }) => {
          invalidateMembers();
          setSelectedIds(new Set(failedPrincipalIds));
          if (failedPrincipalIds.length === 0) setBulkDialog(null);
        }}
      />

      <ConfirmDialog
        open={!!removeTarget}
        onOpenChange={(o) => {
          if (!o) setRemoveTarget(null);
        }}
        title="Remove access?"
        description={
          removeTarget
            ? `${principalLabel(removeTarget)} loses access to ${account.name}.`
            : ''
        }
        confirmLabel="Remove"
        confirmVariant="destructive"
        onConfirm={() => removeTarget && removeMutation.mutate(removeTarget.user_id)}
        isPending={removeMutation.isPending}
      />

      <ConfirmDialog
        open={leaveConfirmOpen}
        onOpenChange={setLeaveConfirmOpen}
        title="Leave account"
        description={
          <span>
            You&apos;ll lose access to{' '}
            <span className="text-foreground font-medium">{account.name}</span> and its projects.
          </span>
        }
        confirmLabel="Leave"
        confirmVariant="destructive"
        onConfirm={() => leaveMutation.mutate()}
        isPending={leaveMutation.isPending}
      />

      <ConfirmDialog
        open={bulkDialog === 'remove'}
        onOpenChange={(o) => !o && setBulkDialog(null)}
        title="Remove access?"
        description={`${selectedCount} member${selectedCount === 1 ? '' : 's'} lose access to ${account.name}.`}
        confirmLabel={`Remove ${selectedCount}`}
        confirmVariant="destructive"
        isPending={bulkBusy}
        onConfirm={() => bulkRun('Removed', (uid) => removeAccountMember(account.account_id, uid))}
      />
    </div>
  );
}

/**
 * "Joined … · N projects · N groups · N tokens". The projects count is the
 * affordance: `AccountMember.projects` already ships the names and roles
 * (that is what the SDK field was added for), so the count opens them in a
 * `Popover` instead of making an admin leave the list to find out which ones.
 */
function MemberMeta({ member }: { member: AccountMember }) {
  const projects = member.projects ?? [];
  const projectCount =
    typeof member.explicit_project_count === 'number'
      ? member.explicit_project_count
      : projects.length;
  const showProjects = member.account_role === 'member' && projectCount > 0;

  return (
    <span className="text-muted-foreground text-xs">
      <InlineMeta>
        <span>Joined {formatDate(member.joined_at)}</span>
        {showProjects ? (
          <MemberProjectsChip count={projectCount} projects={projects} />
        ) : null}
        {member.groups && member.groups.length > 0 ? (
          <span>
            {member.groups.length} group{member.groups.length === 1 ? '' : 's'}
          </span>
        ) : null}
        {typeof member.active_pat_count === 'number' && member.active_pat_count > 0 ? (
          <span>
            {member.active_pat_count} token{member.active_pat_count === 1 ? '' : 's'}
          </span>
        ) : null}
      </InlineMeta>
    </span>
  );
}

function MemberProjectsChip({
  count,
  projects,
}: {
  count: number;
  projects: AccountMemberProject[];
}) {
  const label = `${count} project${count === 1 ? '' : 's'}`;
  if (projects.length === 0) return <span>{label}</span>;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="hover:text-foreground cursor-pointer underline decoration-dotted underline-offset-2 transition-colors"
        >
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 space-y-0.5 p-2">
        {projects.map((project) => (
          <div
            key={project.project_id}
            className="flex items-center justify-between gap-3 rounded-sm px-2 py-1.5 text-xs"
          >
            <span className="text-foreground min-w-0 truncate">{project.name}</span>
            <span className="text-muted-foreground shrink-0">
              {builtinRoleLabel('project', project.role)}
            </span>
          </div>
        ))}
      </PopoverContent>
    </Popover>
  );
}

// ============================== PENDING INVITES ==============================

function PendingInvitesSection({
  accountId,
  canManage,
  search = '',
}: {
  accountId: string;
  canManage: boolean;
  /** Optional email filter — when the parent's search input has a
   *  value, hide invites whose email doesn't include the query. */
  search?: string;
}) {
  const queryClient = useQueryClient();
  // Per-invite spinner state. Set rather than scalar so resending one
  // invite + cancelling another (or rapid clicks across rows) don't
  // make the spinner jump between rows.
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());
  const markPending = (id: string) => setPendingIds((prev) => new Set(prev).add(id));
  const clearPending = (id: string) =>
    setPendingIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  const [cancelTarget, setCancelTarget] = useState<AccountInvitation | null>(null);

  const invitesQuery = useQuery({
    queryKey: ['account-invites', accountId],
    queryFn: () => listAccountInvites(accountId),
    staleTime: 20_000,
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['account-invites', accountId] });

  const resendMutation = useMutation({
    mutationFn: (inviteId: string) => resendAccountInvite(accountId, inviteId),
    onMutate: (id) => markPending(id),
    onSettled: (_data, _error, id) => clearPending(id),
    onSuccess: (res) => {
      if (res.email_sent) {
        successToast('Invite email sent');
      } else {
        // Mailtrap not configured (local dev or unconfigured prod). Hand the
        // admin the link directly so they can share it manually.
        warningToast('Email skipped — copy invite link to share manually', {
          duration: 8_000,
          button: (
            <Button size="sm" onClick={() => copyInviteLink(res.invite_url)}>
              Copy link
            </Button>
          ),
        });
      }
      invalidate();
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to resend invite'),
  });

  const cancelMutation = useMutation({
    mutationFn: (inviteId: string) => cancelAccountInvite(accountId, inviteId),
    onMutate: (id) => markPending(id),
    onSettled: (_data, _error, id) => clearPending(id),
    onSuccess: () => {
      successToast('Invite cancelled');
      invalidate();
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to cancel invite'),
  });

  const allInvites = invitesQuery.data ?? [];
  // Filter by search query — case-insensitive substring on email.
  const query = search.trim().toLowerCase();
  const invites = query
    ? allInvites.filter((i) => i.email.toLowerCase().includes(query))
    : allInvites;
  // Hide the whole section when there are no invites at all OR when
  // the search filtered everything out — there's no useful empty state
  // to show here (the parent's members list handles the "no matches"
  // copy for the combined search).
  if (!invites.length) return null;

  return (
    <>
      <AccessList header={{ title: 'Invited', count: invites.length }}>
        {invites.map((invite) => (
          <AccessRow
            key={invite.invite_id}
            dashed
            leading={<UserAvatar email={invite.email} size="md" />}
            title={invite.email}
            meta={
              <span className="text-muted-foreground text-xs">
                <InlineMeta>
                  <span>Invite expires {formatDate(invite.expires_at)}</span>
                </InlineMeta>
              </span>
            }
            trailing={builtinRoleLabel('account', invite.initial_role)}
            pending={pendingIds.has(invite.invite_id)}
            kebabLabel={`Actions for ${invite.email}`}
            kebab={
              canManage
                ? [
                    {
                      label: 'Resend invite',
                      icon: <RefreshCw className="size-3.5" />,
                      onSelect: () => resendMutation.mutate(invite.invite_id),
                    },
                    {
                      label: 'Copy invite link',
                      icon: <LinkIcon className="size-3.5" />,
                      onSelect: () => void copyInviteLink(invite.invite_url),
                    },
                    {
                      label: 'Cancel invite',
                      icon: <Close className="size-3.5" />,
                      variant: 'destructive',
                      separated: true,
                      onSelect: () => setCancelTarget(invite),
                    },
                  ]
                : undefined
            }
          />
        ))}
      </AccessList>

      <ConfirmDialog
        open={!!cancelTarget}
        onOpenChange={(o) => {
          if (!o) setCancelTarget(null);
        }}
        title="Cancel invite"
        description={
          cancelTarget
            ? `Revoke the pending invite for ${cancelTarget.email}? They'll need a new invite to join.`
            : ''
        }
        confirmLabel="Cancel invite"
        confirmVariant="destructive"
        isPending={cancelMutation.isPending}
        onConfirm={() => {
          if (!cancelTarget) return;
          cancelMutation.mutate(cancelTarget.invite_id);
          setCancelTarget(null);
        }}
      />
    </>
  );
}
