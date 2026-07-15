'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronDown,
  Clock,
  Coins,
  CreditCard,
  ExternalLink,
  GitBranch,
  Github,
  Info,
  KeyRound,
  Link as LinkIcon,
  Mail,
  MoreHorizontal,
  Network,
  RefreshCw,
  ScrollText,
  Unplug,
} from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';

import { ConnectingScreen } from '@/components/dashboard/connecting-screen';
import { AuditTab } from '@/components/iam/audit-tab';
import { AuditWebhooksCard } from '@/components/iam/audit-webhooks-card';
import { EnterpriseDemoCard } from '@/components/iam/enterprise-demo-card';
import { EnterpriseUpsell } from '@/components/iam/enterprise-upsell';
import { GroupsTab } from '@/components/iam/groups-tab';
import { MfaRequiredCard } from '@/components/iam/mfa-required-card';
import { PatPolicyCard } from '@/components/iam/pat-policy-card';
import { PermissionsHelpPopover } from '@/components/iam/permissions-help-popover';
import { RolesTab } from '@/components/iam/roles-tab';
import { ScimCard } from '@/components/iam/scim-card';
import { ServiceAccountsCard } from '@/components/iam/service-accounts-card';
import { SessionControlsCard } from '@/components/iam/session-controls-card';
import { SsoCard } from '@/components/iam/sso-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EntityAvatar } from '@/components/ui/entity-avatar';
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
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, infoToast, successToast, warningToast } from '@/components/ui/toast';
import { UserAvatar } from '@/components/ui/user-avatar';
import { BillingTab } from '@/features/accounts/settings/billing-tab';
import { TransactionsTab } from '@/features/accounts/settings/transactions-tab';
import { GlobalUpgradeModal } from '@/features/billing/global-upgrade-modal';
import { Icon } from '@/features/icon/icon';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { useAuth } from '@/features/providers/auth-provider';
import { useAccountState } from '@/hooks/billing';
import { isBillingEnabled, isSingleAccountMode } from '@/lib/config';
import { addGroupMembers, listGroups } from '@/lib/iam-client';
import { usePermissions } from '@/lib/use-permission';
import { cn } from '@/lib/utils';
import { BillingAccountProvider } from '@/stores/billing-account-context';
import {
  cancelAccountInvite,
  deleteGitHubInstallation,
  getAccount,
  inviteAccountMember,
  leaveAccount,
  listAccountInvites,
  listAccountMembers,
  listGitHubInstallations,
  removeAccountMember,
  resendAccountInvite,
  updateAccountMemberRole,
  updateAccountName,
  type AccountDetail,
  type AccountInvitation,
  type AccountMember,
  type AccountRole,
} from '@kortix/sdk/projects-client';
import {
  CogOne,
  Icon as IconMynauiType,
  Search,
  Shield,
  TrashSolid,
  UserPlus,
  Users,
} from '@mynaui/icons-react';
import { LucideIcon } from 'lucide-react';
import { IconType } from 'react-icons/lib';

// Stable (module-level) probe list for the account-capabilities batch. Order
// must match the destructure at the call site. Declared outside the component
// so its identity is constant across renders and React Query doesn't refetch.
const ACCOUNT_PERMISSION_PROBES = [
  { action: 'account.write' },
  { action: 'account.delete' },
  { action: 'member.invite' },
  { action: 'member.remove' },
  { action: 'member.update' },
  { action: 'group.create' },
  { action: 'audit.read' },
  { action: 'role.create' },
];

const ROLE_LABEL: Record<AccountRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
};

// Entity row dialect shared with the customize section views (members-view).
const MEMBER_ROW = 'bg-popover flex items-center gap-3 rounded-md border px-4 py-2.5';

// ── Section nav (left rail) ───────────────────────────────────────────────

const VALID_TABS = [
  'members',
  'groups',
  'roles',
  'billing',
  'transactions',
  'git',
  'audit',
  'settings',
] as const;
type AccountSection = (typeof VALID_TABS)[number];

// Grouped like the reference: people & access, money, account plumbing.
const NAV_GROUPS: Array<
  Array<{ id: AccountSection; label: string; icon: LucideIcon | IconMynauiType | IconType }>
> = [
  [
    { id: 'members', label: 'Members', icon: Users },
    { id: 'groups', label: 'Groups', icon: Network },
    { id: 'roles', label: 'Roles', icon: Shield },
  ],
  [
    { id: 'billing', label: 'Billing', icon: CreditCard },
    { id: 'transactions', label: 'Credits', icon: Coins },
  ],
  [
    { id: 'git', label: 'Git', icon: GitBranch },
    { id: 'audit', label: 'Audit log', icon: ScrollText },
    { id: 'settings', label: 'Settings', icon: CogOne },
  ],
];

// Header block for sections whose content doesn't carry its own title.
const PANE_META: Partial<Record<AccountSection, { title: string; description: string }>> = {
  members: { title: 'Members', description: 'People with access to this account.' },
  billing: { title: 'Billing', description: 'Plan, wallet, and spend for this account.' },
  transactions: { title: 'Credits', description: 'Every credit movement on this account.' },
  settings: { title: 'Settings', description: 'Name, security, and access for this account.' },
};

// The enterprise IdP surface (SAML SSO + SCIM provisioning) is PLAN-GATED,
// not env-gated: the cards render only for accounts whose tier carries the
// `sso` / `scim` entitlement (i.e. the sales-assigned `enterprise` tier). This
// matches the server-side enforcement in the SCIM/SSO routes — the API returns
// 402 for non-entitled accounts — so the UI never offers a control that the
// backend would reject. See `entitlements` on the account-state `tier` block.

function formatDate(input: string | null | undefined) {
  if (!input) return '—';
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function memberLabel(member: Pick<AccountMember, 'email' | 'user_id'>) {
  return member.email || member.user_id;
}

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

  const accountQuery = useQuery({
    queryKey: ['account', accountId],
    queryFn: () => getAccount(accountId!),
    enabled: !!user && !!accountId,
    staleTime: 30_000,
  });

  const membersQuery = useQuery({
    queryKey: ['account-members', accountId],
    queryFn: () => listAccountMembers(accountId!),
    enabled: !!user && !!accountId,
    staleTime: 20_000,
  });

  // Enterprise identity (SSO + SCIM) is gated on the account's plan. The cards
  // render only when the tier carries the entitlement — mirrors the server-side
  // 402 so we never show a control the backend rejects.
  const accountStateQuery = useAccountState({ accountId, enabled: !!user && !!accountId });
  const entitlements = accountStateQuery.data?.tier?.entitlements;
  const enterpriseIdentityEnabled = !!(entitlements?.sso || entitlements?.scim);
  // The IAM surfaces (Groups, Roles, Audit, SSO/SCIM) are enterprise-gated.
  // Tabs/sections stay VISIBLE for discoverability, but a non-entitled
  // account sees the EnterpriseUpsell card in place of the feature — mirrors
  // the server's 402 (requireEntitlement) so an admin never touches a control
  // the backend will reject. While the account state is still loading we
  // render nothing gated (skeleton) to avoid flashing the upsell at
  // enterprise accounts.
  const rbacEnabled = !!entitlements?.rbac;
  const auditEnabled = !!entitlements?.auditAccess;
  const entitlementsLoading = !entitlements && accountStateQuery.isLoading;

  // Granular capabilities sourced from the IAM engine. MUST be called
  // before any conditional return — moving these below the auth-loading
  // guard would change the hook count between renders.
  // usePermission internally short-circuits when accountId is falsy, so
  // it's safe to call before the account query resolves.
  // One batched probe instead of 7 separate /effective?action=… GETs. Each
  // singular probe was its own DB round-trip, so a single load of this page
  // fanned out 7 concurrent queries — a meaningful contributor to DB
  // connection-pool pressure. The :batch endpoint answers all of them in one
  // request. Results come back in the same order as ACCOUNT_PERMISSION_PROBES.
  const [
    { allowed: canWriteAccount },
    { allowed: canDeleteAccount },
    { allowed: canInviteMember },
    { allowed: canRemoveMember },
    { allowed: canUpdateMember },
    { allowed: canCreateGroup },
    { allowed: canReadAudit },
    { allowed: canManageRoles },
  ] = usePermissions(accountId, ACCOUNT_PERMISSION_PROBES);

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
  // Self-host single-account mode: no teams, so member/group management has
  // nothing to manage. Self-host billing-disabled: no Stripe/credit ledger
  // to show — see isBillingEnabled() (mirrors the backend's
  // KORTIX_BILLING_INTERNAL_ENABLED) instead of only checking permission.
  const singleAccountMode = isSingleAccountMode();
  const billingActive = isBillingEnabled();

  // Which rail items this caller can see. Mirrors the per-section gates the
  // content rendering applies below, so a deep link to a section the caller
  // can't use falls back to Members instead of an empty pane.
  const sectionVisible: Record<AccountSection, boolean> = {
    members: !singleAccountMode,
    groups: !singleAccountMode,
    roles: canManageRoles === true,
    billing: canWriteAccount === true && billingActive,
    transactions: canWriteAccount === true && billingActive,
    git: canWriteAccount === true,
    audit: canReadAudit === true,
    settings: canWriteAccount === true,
  };
  const activeSection: AccountSection = sectionVisible[requestedTab]
    ? requestedTab
    : sectionVisible.members
      ? 'members'
      : 'settings';
  const paneMeta = PANE_META[activeSection];
  const navigate = (section: AccountSection) =>
    router.replace(`/accounts/${accountId}?tab=${section}`, { scroll: false });

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
        <div className="lg:grid lg:grid-cols-[208px_minmax(0,1fr)] lg:gap-12">
          {/* ── Rail — identity + section nav ── */}
          <aside className="mb-6 space-y-4 self-start lg:sticky lg:top-8 lg:mb-0">
            <div className="flex min-w-0 items-center gap-2.5 px-1">
              <EntityAvatar label={account.name || 'Account'} size="md" />
              <div className="min-w-0">
                <p className="text-foreground truncate text-sm font-medium">{account.name}</p>
                {!membersQuery.isLoading ? (
                  <p className="text-muted-foreground text-xs">
                    {members.length} member{members.length === 1 ? '' : 's'}
                  </p>
                ) : null}
              </div>
            </div>

            <nav
              aria-label="Account sections"
              className="flex gap-1 overflow-x-auto pb-1 lg:flex-col lg:gap-0.5 lg:overflow-visible lg:pb-0"
            >
              {NAV_GROUPS.map((group, gi) => {
                const items = group.filter((item) => sectionVisible[item.id]);
                if (items.length === 0) return null;
                return (
                  <div key={gi} className="contents lg:block lg:space-y-0.5">
                    {gi > 0 ? <div className="hidden lg:block lg:h-3" aria-hidden /> : null}
                    {items.map((item) => {
                      const active = item.id === activeSection;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => navigate(item.id)}
                          aria-current={active ? 'page' : undefined}
                          className={cn(
                            'flex h-8 shrink-0 cursor-pointer items-center gap-2.5 rounded-sm px-2.5 text-sm whitespace-nowrap transition-colors lg:w-full',
                            active
                              ? 'bg-primary/[0.06] text-foreground font-medium'
                              : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                          )}
                        >
                          <item.icon className="size-4 shrink-0" />
                          {item.label}
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </nav>

            <div className="hidden px-1 lg:block">
              <PermissionsHelpPopover />
            </div>
          </aside>

          {/* ── Content pane. Keyed remount + a 200ms rise on section switch;
                opacity-only under reduced motion. ── */}
          <motion.div
            key={activeSection}
            initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
            className="max-w-3xl min-w-0"
          >
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

            {activeSection === 'members' ? (
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
              />
            ) : null}

            {activeSection === 'groups' ? (
              entitlementsLoading ? (
                <Skeleton className="h-64 w-full rounded-md" />
              ) : rbacEnabled ? (
                <GroupsTab
                  accountId={account.account_id}
                  canCreate={canCreateGroup}
                  rbacEnabled={rbacEnabled}
                />
              ) : (
                <EnterpriseUpsell feature="groups" />
              )
            ) : null}

            {activeSection === 'roles' && canManageRoles ? (
              entitlementsLoading ? (
                <Skeleton className="h-64 w-full rounded-md" />
              ) : rbacEnabled ? (
                <RolesTab
                  accountId={account.account_id}
                  canManage={canManageRoles}
                  rbacEnabled={rbacEnabled}
                />
              ) : (
                <EnterpriseUpsell feature="roles" />
              )
            ) : null}

            {activeSection === 'audit' && canReadAudit ? (
              entitlementsLoading ? (
                <Skeleton className="h-64 w-full rounded-md" />
              ) : auditEnabled ? (
                <AuditTab accountId={account.account_id} />
              ) : (
                <EnterpriseUpsell feature="audit" />
              )
            ) : null}

            {activeSection === 'git' && canWriteAccount ? (
              <GitHubConnectionCard account={account} canManage={canWriteAccount} />
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

                {/* MFA is the only security control 95% of accounts ever touch —
                  keep it primary. Session lifetime + idle timeout tuning
                  matters for compliance shops but is noise for everyone else,
                  so it hides under an "Advanced" disclosure (closed by
                  default). */}
                <SettingsGroup title="Security" description="Account-wide sign-in requirements.">
                  <MfaRequiredCard accountId={account.account_id} canManage={canWriteAccount} />
                  <Disclosure variant="outline" className="group bg-popover overflow-hidden">
                    <DisclosureTrigger className="px-4 py-3">
                      <div className="flex w-full cursor-pointer items-center justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="text-foreground text-sm font-medium">Advanced</p>
                          <p className="text-muted-foreground mt-0.5 text-xs">
                            Session lifetime and idle timeout.
                          </p>
                        </div>
                        <ChevronDown className="text-muted-foreground size-4 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
                      </div>
                    </DisclosureTrigger>
                    <DisclosureContent contentClassName="border-border border-t">
                      <div className="px-4 py-5">
                        <SessionControlsCard
                          accountId={account.account_id}
                          canManage={canWriteAccount}
                        />
                      </div>
                    </DisclosureContent>
                  </Disclosure>
                </SettingsGroup>

                {/* The enterprise-demo toggle is ALWAYS shown to account admins
                  so they can unlock the surface self-serve. SAML SSO + SCIM
                  are Enterprise features and only render once the entitlement
                  is on (the demo flag OR a real enterprise tier); their API
                  routes enforce the same gate server-side (402 for non-entitled
                  accounts). Keeping the toggle OUTSIDE the entitlement gate
                  avoids a chicken-and-egg where the enabler is hidden behind
                  the very thing it enables.
                  Single-account mode has no other members to bring in from an
                  IdP or provision via SCIM, so the whole section is moot — hide
                  it rather than show controls with nothing to act on. */}
                {!singleAccountMode ? (
                  <SettingsGroup
                    title="Identity"
                    description="Bring members in from your identity provider."
                  >
                    <EnterpriseDemoCard accountId={account.account_id} canManage={canWriteAccount} />
                    {entitlementsLoading ? (
                      <Skeleton className="h-40 w-full rounded-md" />
                    ) : enterpriseIdentityEnabled ? (
                      <>
                        <SsoCard accountId={account.account_id} canManage={canWriteAccount} />
                        <ScimCard accountId={account.account_id} canManage={canWriteAccount} />
                      </>
                    ) : (
                      <EnterpriseUpsell feature="identity" />
                    )}
                  </SettingsGroup>
                ) : null}

                {/* These cards carry their own title + description headers, so
                  they stand alone — a wrapping group label would double up. */}
                <PatPolicyCard accountId={account.account_id} canManage={canWriteAccount} />
                <ServiceAccountsCard accountId={account.account_id} canManage={canWriteAccount} />
                <AuditWebhooksCard accountId={account.account_id} canManage={canWriteAccount} />

                {canDeleteAccount ? (
                  <SettingsGroup title="Danger zone">
                    <DangerZoneCard />
                  </SettingsGroup>
                ) : null}
              </div>
            ) : null}
          </motion.div>
        </div>
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

  async function handleConnect() {
    if (!canManage) return;
    setIsConnecting(true);
    try {
      const result = await installationsQuery.refetch();
      if (result.error) throw result.error;
      const installUrl = result.data?.install_url;
      if (!installUrl) {
        errorToast(
          result.data?.configured === false
            ? 'GitHub App is not configured'
            : 'GitHub install URL unavailable',
        );
        return;
      }
      rememberGitHubSetupReturn(`/accounts/${account.account_id}?tab=git`);
      window.location.assign(installUrl);
    } catch (err) {
      errorToast((err as Error).message || 'Failed to start GitHub setup');
    } finally {
      setIsConnecting(false);
    }
  }

  const installations = installationsQuery.data?.installations ?? [];

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
            Connect GitHub users or organizations to import repositories.
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
          {isConnecting ? 'Connecting' : 'Connect GitHub'}
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
          No GitHub connections yet. Connect the Kortix GitHub App to import repositories.
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
                className={MEMBER_ROW}
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
}) {
  const router = useRouter();
  const [inviteOpen, setInviteOpen] = useState(false);
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
  const [bulkDialog, setBulkDialog] = useState<'add_to_group' | 'set_role' | 'remove' | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  // canInvite/canRemove/canUpdateRole come in as props (driven by usePermission
  // at the page level). The row-level kebab respects each granularly.

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
      return memberLabel(a).localeCompare(memberLabel(b));
    });
  }, [members, search]);

  const invalidateMembers = () => {
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

  const roleMutation = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: AccountRole }) =>
      updateAccountMemberRole(account.account_id, userId, role),
    onMutate: ({ userId }) => markPending(userId),
    onSettled: (_data, _error, vars) => clearPending(vars.userId),
    onSuccess: () => {
      successToast('Role updated');
      invalidateMembers();
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to update role'),
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
  // useful (add to group OR change role OR remove). canInvite is the
  // closest proxy for "can manage account membership" without adding
  // another permission probe.
  const canBulk = canInvite || canUpdateRole || canRemove;
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

  // Bulk handlers — all use the existing per-user endpoints fanned out
  // with Promise.allSettled so a single failure doesn't block the
  // others. On any failure we:
  //   1. console.error a full table (email + userId + reason) — admins
  //      doing bulk ops are likely to have devtools open.
  //   2. surface the FIRST failure reason inline in the toast so the
  //      user sees at least one actionable hint without expanding it.
  //   3. preserve the selection so they can retry only the failing rows
  //      after fixing whatever was wrong (e.g. a missing permission).
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
    const results = await Promise.allSettled(ids.map(runOne));
    setBulkBusy(false);
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

    // Devtools-friendly dump. console.table renders one row per failure
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
  async function bulkAddToGroup(groupId: string) {
    // addGroupMembers takes an array natively — single round-trip.
    // Use the eligible intersection (see effectiveSelectedIds) so a
    // hidden-by-filter row doesn't get silently added.
    setBulkBusy(true);
    try {
      const ids = Array.from(effectiveSelectedIds);
      const res = await addGroupMembers(account.account_id, groupId, ids);
      invalidateMembers();
      successToast(`Added ${res.added} member${res.added === 1 ? '' : 's'} to group`);
      clearSelection();
      setBulkDialog(null);
    } catch (err) {
      errorToast((err as Error).message || 'Failed to add to group');
    } finally {
      setBulkBusy(false);
    }
  }

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
                onClick={() => setInviteOpen(true)}
              >
                <Icon.Plus className="size-4" />
                Invite
              </Button>
            ) : null}
          </div>

          {selectedCount > 0 && canBulk ? (
            <div className="bg-popover flex flex-wrap items-center gap-2 rounded-md border px-4 py-2 text-sm">
              <span className="text-foreground text-xs font-medium">{selectedCount} selected</span>
              {canInvite ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setBulkDialog('add_to_group')}
                  disabled={bulkBusy}
                >
                  Add to group
                </Button>
              ) : null}
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
              <Button
                size="sm"
                variant="ghost"
                onClick={clearSelection}
                disabled={bulkBusy}
                className="text-muted-foreground ml-auto"
              >
                Clear
              </Button>
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
            <div className="space-y-2">
              <div className="flex items-center justify-between px-1">
                {/* Count what THIS caller can actually see, not the raw
                    total. The roster is visibility-filtered server-side for
                    plain members (owners/admins + self), while
                    account.member_count is the unfiltered COUNT(*) — using it
                    would leak the roster size and mismatch the list below. */}
                <span className="text-muted-foreground text-xs font-medium">
                  Members · {sorted.length}
                </span>
                {canBulk && bulkEligible.length > 0 ? (
                  <label className="text-muted-foreground flex cursor-pointer items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={allEligibleSelected}
                      onChange={toggleAllEligible}
                      className="border-border accent-primary size-3.5 cursor-pointer rounded"
                    />
                    {allEligibleSelected ? 'Deselect all' : 'Select all'}{' '}
                    {bulkEligible.length !== sorted.length ? <span>(visible)</span> : null}
                  </label>
                ) : null}
              </div>
              <ul className="space-y-2">
                {sorted.map((member) => {
                  const isSelf = member.user_id === currentUserId;
                  const isLastOwner =
                    member.account_role === 'owner' &&
                    sorted.filter((m) => m.account_role === 'owner').length === 1;
                  const pending = pendingUserIds.has(member.user_id);
                  // Kebab is always available — "View & edit permissions" is
                  // open to anyone who can view the member; backend gates writes.
                  const showKebab = !pending;
                  // Self rows can't be bulk-acted on — would let an admin
                  // demote / remove themselves in a sweep.
                  const bulkEnabled = canBulk && !isSelf;
                  const isSelected = selectedIds.has(member.user_id);

                  const metaParts: string[] = [`Joined ${formatDate(member.joined_at)}`];
                  if (
                    member.account_role === 'member' &&
                    typeof member.explicit_project_count === 'number' &&
                    member.explicit_project_count > 0
                  ) {
                    metaParts.push(
                      `${member.explicit_project_count} project${member.explicit_project_count === 1 ? '' : 's'}`,
                    );
                  }
                  if (member.groups && member.groups.length > 0) {
                    metaParts.push(
                      `${member.groups.length} group${member.groups.length === 1 ? '' : 's'}`,
                    );
                  }
                  if (typeof member.active_pat_count === 'number' && member.active_pat_count > 0) {
                    metaParts.push(
                      `${member.active_pat_count} token${member.active_pat_count === 1 ? '' : 's'}`,
                    );
                  }

                  return (
                    <li key={member.user_id} className={MEMBER_ROW}>
                      {
                        bulkEnabled ? (
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleOne(member.user_id)}
                            onClick={(e) => e.stopPropagation()}
                            aria-label={`Select ${memberLabel(member)}`}
                            className="border-border accent-primary size-3.5 shrink-0 cursor-pointer rounded"
                          />
                        ) : canBulk ? null : null // Spacer so avatars align across selectable + self rows.
                      }
                      <UserAvatar
                        email={member.email ?? member.user_id}
                        name={member.email ?? undefined}
                        size="md"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-foreground truncate text-sm font-medium">
                            {memberLabel(member)}
                          </span>
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
                          ) : null}
                        </div>
                        <span className="text-muted-foreground text-xs">
                          <InlineMeta>
                            {metaParts.map((part) => (
                              <span key={part}>{part}</span>
                            ))}
                          </InlineMeta>
                        </span>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <RoleBadge role={member.account_role} />
                        <div className="w-7 shrink-0">
                          {pending ? (
                            <Loading className="text-muted-foreground size-4 shrink-0" />
                          ) : showKebab ? (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="text-muted-foreground hover:text-foreground size-7"
                                  aria-label={`Actions for ${memberLabel(member)}`}
                                >
                                  <MoreHorizontal className="size-3.5" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="w-56">
                                <DropdownMenuItem
                                  onSelect={() =>
                                    router.push(
                                      `/accounts/${account.account_id}/members/${member.user_id}`,
                                    )
                                  }
                                  className="gap-2"
                                >
                                  <KeyRound className="size-3.5" />
                                  View & edit permissions
                                </DropdownMenuItem>
                                {canUpdateRole && !isSelf ? (
                                  <>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuLabel className="text-muted-foreground text-xs font-medium">
                                      Change role
                                    </DropdownMenuLabel>
                                    {(['owner', 'admin', 'member'] as AccountRole[]).map((role) => (
                                      <DropdownMenuItem
                                        key={role}
                                        disabled={role === member.account_role}
                                        onSelect={() =>
                                          roleMutation.mutate({
                                            userId: member.user_id,
                                            role,
                                          })
                                        }
                                        className="gap-2"
                                      >
                                        <Shield className="size-3.5" />
                                        {ROLE_LABEL[role]}
                                        {role === member.account_role ? (
                                          <span className="text-muted-foreground ml-auto text-xs">
                                            Current
                                          </span>
                                        ) : null}
                                      </DropdownMenuItem>
                                    ))}
                                  </>
                                ) : null}
                                {canRemove && !isSelf ? (
                                  <>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem
                                      onSelect={() => setRemoveTarget(member)}
                                      disabled={isLastOwner}
                                      className="gap-2"
                                    >
                                      <TrashSolid className="size-3.5" />
                                      Remove from team
                                    </DropdownMenuItem>
                                  </>
                                ) : null}
                                {isSelf ? (
                                  <>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem
                                      onSelect={() => setLeaveConfirmOpen(true)}
                                      disabled={isLastOwner}
                                      className="gap-2"
                                    >
                                      <TrashSolid className="size-3.5" />
                                      Leave team
                                    </DropdownMenuItem>
                                  </>
                                ) : null}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          ) : null}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
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
                    onClick={() => setInviteOpen(true)}
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

      <InviteMemberModal
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        accountId={account.account_id}
        onInvited={invalidateMembers}
      />

      <ConfirmDialog
        open={!!removeTarget}
        onOpenChange={(o) => {
          if (!o) setRemoveTarget(null);
        }}
        title="Remove member"
        description={
          <span>
            Remove{' '}
            <span className="text-foreground font-medium">
              {removeTarget ? memberLabel(removeTarget) : ''}
            </span>{' '}
            from <span className="text-foreground font-medium">{account.name}</span>? They will lose
            access immediately.
          </span>
        }
        confirmLabel="Remove"
        onConfirm={() => removeTarget && removeMutation.mutate(removeTarget.user_id)}
        isPending={removeMutation.isPending}
      />

      <ConfirmDialog
        open={leaveConfirmOpen}
        onOpenChange={setLeaveConfirmOpen}
        title="Leave team"
        description={
          <span>
            You&apos;ll lose access to{' '}
            <span className="text-foreground font-medium">{account.name}</span> and its projects.
          </span>
        }
        confirmLabel="Leave"
        onConfirm={() => leaveMutation.mutate()}
        isPending={leaveMutation.isPending}
      />

      <BulkAddToGroupDialog
        open={bulkDialog === 'add_to_group'}
        onOpenChange={(o) => !o && setBulkDialog(null)}
        accountId={account.account_id}
        selectedCount={selectedCount}
        busy={bulkBusy}
        onConfirm={bulkAddToGroup}
      />

      <BulkSetRoleDialog
        open={bulkDialog === 'set_role'}
        onOpenChange={(o) => !o && setBulkDialog(null)}
        selectedCount={selectedCount}
        busy={bulkBusy}
        onConfirm={(role) =>
          bulkRun('Role changed', (uid) => updateAccountMemberRole(account.account_id, uid, role))
        }
      />

      <ConfirmDialog
        open={bulkDialog === 'remove'}
        onOpenChange={(o) => !o && setBulkDialog(null)}
        title="Remove members"
        description={
          <span>
            Remove{' '}
            <span className="text-foreground font-medium">
              {selectedCount} member{selectedCount === 1 ? '' : 's'}
            </span>{' '}
            from <span className="text-foreground font-medium">{account.name}</span>? They lose
            access immediately.
          </span>
        }
        confirmLabel={`Remove ${selectedCount}`}
        isPending={bulkBusy}
        onConfirm={() => bulkRun('Removed', (uid) => removeAccountMember(account.account_id, uid))}
      />
    </div>
  );
}

function RoleBadge({ role }: { role: AccountRole }) {
  return (
    <Badge
      variant="outline"
      size="sm"
      className={cn(role === 'owner' && 'border-foreground/30 text-foreground')}
    >
      {ROLE_LABEL[role]}
    </Badge>
  );
}

// ============================== INVITE MODAL ==============================

function InviteMemberModal({
  open,
  onOpenChange,
  accountId,
  onInvited,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string;
  onInvited: () => void;
}) {
  const [emails, setEmails] = useState<string[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [role, setRole] = useState<AccountRole>('member');
  const [inlineError, setInlineError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const mutation = useMutation({
    mutationFn: async (list: string[]) =>
      Promise.all(
        list.map(async (addr) => {
          try {
            const res = await inviteAccountMember(accountId, {
              email: addr,
              role,
            });
            return { email: addr, ok: true as const, res };
          } catch (err) {
            return {
              email: addr,
              ok: false as const,
              status: (err as { status?: number }).status,
              message: (err as Error).message,
            };
          }
        }),
      ),
    onSuccess: (results) => {
      type Ok = Extract<(typeof results)[number], { ok: true }>;
      type Failed = Extract<(typeof results)[number], { ok: false }>;
      const succeeded = results.filter((r): r is Ok => r.ok);
      const failed = results.filter((r): r is Failed => !r.ok);
      const alreadyMembers = failed.filter((r) => r.status === 409);
      const otherFailures = failed.filter((r) => r.status !== 409);

      if (succeeded.length === 1) {
        const r = succeeded[0];
        if (r.res.status === 'pending' && !r.res.email_sent) {
          // Email delivery was skipped (e.g. Mailtrap not configured locally).
          // Surface the link so the admin can share it manually.
          const inviteUrl = r.res.invite_url;
          warningToast('Invite created — email skipped. Share the link manually.', {
            duration: 10_000,
            button: (
              <Button size="sm" onClick={() => copyInviteLink(inviteUrl)}>
                Copy link
              </Button>
            ),
          });
        } else if (r.res.status === 'pending') {
          successToast(`Invite sent to ${r.res.email} — they'll see it when they sign up`);
        } else {
          successToast(`Added ${r.res.email}`);
        }
      } else if (succeeded.length > 1) {
        successToast(`Invited ${succeeded.length} people`);
        const skipped = succeeded.filter(
          (r) => r.res.status === 'pending' && !r.res.email_sent,
        ).length;
        if (skipped > 0) {
          warningToast(
            `${skipped} ${skipped === 1 ? 'email was' : 'emails were'} skipped — share their links manually.`,
          );
        }
      }

      if (alreadyMembers.length > 0) {
        warningToast(
          alreadyMembers.length === 1
            ? `${alreadyMembers[0].email} is already a member.`
            : `${alreadyMembers.length} were already members.`,
        );
      }

      if (succeeded.length > 0 || alreadyMembers.length > 0) {
        onInvited();
      }

      // Keep only the genuinely-failed emails so the admin can retry them.
      const failedEmails = otherFailures.map((r) => r.email);
      if (failedEmails.length > 0) {
        setEmails(failedEmails);
        setInputValue('');
        setInlineError(
          otherFailures.length === 1
            ? otherFailures[0].message || 'Failed to invite member'
            : `Failed to invite ${otherFailures.length} of these — try again.`,
        );
      } else {
        reset();
        onOpenChange(false);
      }
    },
  });

  function reset() {
    setEmails([]);
    setInputValue('');
    setRole('member');
    setInlineError(null);
  }

  /**
   * Parse free text (typed or pasted) into email chips. Splits on commas,
   * semicolons, and whitespace. Returns true if everything parsed cleanly;
   * leaves any invalid tokens in the input and surfaces an error otherwise.
   */
  function commitInput(raw: string): boolean {
    const tokens = raw
      .split(/[\s,;]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    if (tokens.length === 0) {
      setInputValue('');
      return true;
    }
    const valid: string[] = [];
    const invalid: string[] = [];
    for (const t of tokens) {
      if (!EMAIL_RE.test(t)) invalid.push(t);
      else valid.push(t);
    }
    if (valid.length > 0) {
      setEmails((prev) => [...prev, ...valid.filter((v) => !prev.includes(v))]);
    }
    if (invalid.length > 0) {
      setInputValue(invalid.join(', '));
      setInlineError(
        `${invalid.length === 1 ? 'Not a valid email' : 'Not valid emails'}: ${invalid.join(', ')}`,
      );
      return false;
    }
    setInputValue('');
    setInlineError(null);
    return true;
  }

  function removeEmail(addr: string) {
    setEmails((prev) => prev.filter((e) => e !== addr));
  }

  function handleInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (
      event.key === 'Enter' ||
      event.key === ',' ||
      event.key === ';' ||
      (event.key === ' ' && inputValue.trim() !== '')
    ) {
      event.preventDefault();
      commitInput(inputValue);
    } else if (event.key === 'Backspace' && inputValue === '' && emails.length > 0) {
      setEmails((prev) => prev.slice(0, -1));
    }
  }

  function handlePaste(event: React.ClipboardEvent<HTMLInputElement>) {
    const text = event.clipboardData.getData('text');
    // Only intercept multi-email pastes; let a single address paste normally
    // so the admin can still edit it before committing.
    if (/[\s,;]/.test(text.trim())) {
      event.preventDefault();
      commitInput(`${inputValue} ${text}`);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setInlineError(null);
    const tokens = inputValue
      .split(/[\s,;]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    const invalid = tokens.filter((t) => !EMAIL_RE.test(t));
    if (invalid.length > 0) {
      setInlineError(
        `${invalid.length === 1 ? 'Not a valid email' : 'Not valid emails'}: ${invalid.join(', ')}`,
      );
      return;
    }
    const all = Array.from(new Set([...emails, ...tokens]));
    if (all.length === 0) {
      setInlineError('Add at least one email');
      return;
    }
    setEmails(all);
    setInputValue('');
    mutation.mutate(all);
  }

  const pendingCount = emails.length + (inputValue.trim() ? 1 : 0);

  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <ModalContent className="lg:max-w-lg">
        <ModalHeader>
          <ModalTitle>Invite members</ModalTitle>
          <ModalDescription>
            Invite by email. If they don&apos;t have an account yet, the invite waits for them.
          </ModalDescription>
        </ModalHeader>
        <form onSubmit={handleSubmit}>
          <ModalBody className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="invite-email">Emails</Label>
              <div
                className="bg-popover focus-within:border-ring flex min-h-10 w-full flex-wrap items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm transition-colors"
                onClick={() => inputRef.current?.focus()}
              >
                <Mail className="text-muted-foreground pointer-events-none size-4 shrink-0" />
                {emails.map((addr) => (
                  <Badge key={addr} variant="secondary" className="gap-1 pr-1">
                    {addr}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeEmail(addr);
                      }}
                      className="text-muted-foreground hover:text-foreground transition-colors"
                      aria-label={`Remove ${addr}`}
                      disabled={mutation.isPending}
                    >
                      <Icon.Close className="size-3" />
                    </button>
                  </Badge>
                ))}
                <input
                  ref={inputRef}
                  id="invite-email"
                  type="text"
                  value={inputValue}
                  onChange={(e) => {
                    setInputValue(e.target.value);
                    if (inlineError) setInlineError(null);
                  }}
                  onKeyDown={handleInputKeyDown}
                  onPaste={handlePaste}
                  placeholder={emails.length === 0 ? 'teammate@company.com' : 'Add another…'}
                  autoFocus
                  className="placeholder:text-muted-foreground min-w-[8rem] flex-1 bg-transparent font-medium outline-none disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={mutation.isPending}
                />
              </div>
              <p className="text-muted-foreground text-xs">
                Add several at once — separate with commas or spaces.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="invite-role">Role</Label>
              <Select
                value={role}
                onValueChange={(v) => setRole(v as AccountRole)}
                disabled={mutation.isPending}
              >
                <SelectTrigger id="invite-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="member">Member — can use assigned projects</SelectItem>
                  <SelectItem value="admin">Admin — can invite members</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {inlineError ? <InfoBanner tone="destructive">{inlineError}</InfoBanner> : null}
          </ModalBody>

          <ModalFooter className="sm:justify-between">
            <Button
              type="button"
              variant="outline-ghost"
              onClick={() => onOpenChange(false)}
              disabled={mutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              className="gap-1.5"
              disabled={mutation.isPending || pendingCount === 0}
            >
              {mutation.isPending ? (
                <Loading className="size-4 shrink-0" />
              ) : (
                <UserPlus className="size-4" />
              )}
              {pendingCount > 1 ? `Invite ${pendingCount}` : 'Invite'}
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
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
    <div className="space-y-2">
      <p className="text-muted-foreground px-1 text-xs font-medium">Invited · {invites.length}</p>
      <ul className="space-y-2">
        {invites.map((invite) => {
          const busy = pendingIds.has(invite.invite_id);
          return (
            <li key={invite.invite_id} className={cn(MEMBER_ROW, 'border-dashed')}>
              <UserAvatar email={invite.email} size="md" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-foreground truncate text-sm font-medium">
                    {invite.email}
                  </span>
                </div>
                <span className="text-muted-foreground text-xs">
                  <InlineMeta>
                    <span className="flex items-center gap-1">
                      <Clock className="size-3" />
                      Invite expires {formatDate(invite.expires_at)}
                    </span>
                  </InlineMeta>
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <RoleBadge role={invite.initial_role} />
                <div className="w-7 shrink-0">
                  {busy ? (
                    <Loading className="text-muted-foreground size-4 shrink-0" />
                  ) : canManage ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-muted-foreground hover:text-foreground size-7"
                          aria-label={`Actions for ${invite.email}`}
                        >
                          <MoreHorizontal className="size-3.5" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-52">
                        <DropdownMenuItem
                          onSelect={() => resendMutation.mutate(invite.invite_id)}
                          className="gap-2"
                        >
                          <RefreshCw className="size-3.5" />
                          Resend invite
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() => copyInviteLink(invite.invite_url)}
                          className="gap-2"
                        >
                          <LinkIcon className="size-3.5" />
                          Copy invite link
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onSelect={() => setCancelTarget(invite)}
                          className="gap-2"
                        >
                          <Icon.Close className="size-3.5" />
                          Cancel invite
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                </div>
              </div>
            </li>
          );
        })}
      </ul>

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
        isPending={cancelMutation.isPending}
        onConfirm={() => {
          if (!cancelTarget) return;
          cancelMutation.mutate(cancelTarget.invite_id);
          setCancelTarget(null);
        }}
      />
    </div>
  );
}

// ─── Bulk dialogs ─────────────────────────────────────────────────────────

function BulkAddToGroupDialog({
  open,
  onOpenChange,
  accountId,
  selectedCount,
  busy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  accountId: string;
  selectedCount: number;
  busy: boolean;
  onConfirm: (groupId: string) => void;
}) {
  const [groupId, setGroupId] = useState<string | undefined>(undefined);
  const groupsQuery = useQuery({
    queryKey: ['account-groups', accountId],
    queryFn: () => listGroups(accountId),
    enabled: open,
    staleTime: 30_000,
  });
  // Reset selection every reopen so a stale id from last time doesn't
  // pre-fill an unrelated group.
  function handleOpenChange(v: boolean) {
    if (v) setGroupId(undefined);
    onOpenChange(v);
  }
  const groups = groupsQuery.data ?? [];
  return (
    <Modal open={open} onOpenChange={handleOpenChange}>
      <ModalContent className="lg:max-w-md">
        <ModalHeader>
          <ModalTitle>
            Add {selectedCount} member{selectedCount === 1 ? '' : 's'} to a group
          </ModalTitle>
          <ModalDescription>Pick the group they should join.</ModalDescription>
        </ModalHeader>
        <ModalBody>
          <div className="space-y-1.5">
            <Label htmlFor="bulk-group">Group</Label>
            {groupsQuery.isLoading ? (
              <Skeleton className="h-9 w-full rounded-lg" />
            ) : groups.length === 0 ? (
              <p className="bg-popover text-muted-foreground rounded-md border px-3 py-2.5 text-xs">
                No groups exist yet. Create one in the Groups tab first.
              </p>
            ) : (
              <Select value={groupId ?? ''} onValueChange={(v) => setGroupId(v || undefined)}>
                <SelectTrigger id="bulk-group">
                  <SelectValue placeholder="Choose a group" />
                </SelectTrigger>
                <SelectContent>
                  {groups.map((g) => (
                    <SelectItem key={g.group_id} value={g.group_id}>
                      {g.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        </ModalBody>
        <ModalFooter className="sm:justify-between">
          <Button variant="outline-ghost" onClick={() => handleOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            disabled={!groupId || busy || groups.length === 0}
            onClick={() => groupId && onConfirm(groupId)}
            className="gap-1.5"
          >
            {busy ? <Loading className="size-4 shrink-0" /> : null}
            Add to group
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

function BulkSetRoleDialog({
  open,
  onOpenChange,
  selectedCount,
  busy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  selectedCount: number;
  busy: boolean;
  onConfirm: (role: AccountRole) => void;
}) {
  const [role, setRole] = useState<AccountRole>('member');
  function handleOpenChange(v: boolean) {
    if (v) setRole('member');
    onOpenChange(v);
  }
  return (
    <Modal open={open} onOpenChange={handleOpenChange}>
      <ModalContent className="lg:max-w-md">
        <ModalHeader>
          <ModalTitle>
            Change role for {selectedCount} member{selectedCount === 1 ? '' : 's'}
          </ModalTitle>
          <ModalDescription>Owners and admins can manage the whole account.</ModalDescription>
        </ModalHeader>
        <ModalBody>
          <div className="space-y-1.5">
            <Label htmlFor="bulk-role">New role</Label>
            <Select value={role} onValueChange={(v) => setRole(v as AccountRole)}>
              <SelectTrigger id="bulk-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="owner">Owner — full control</SelectItem>
                <SelectItem value="admin">Admin — everything except ownership</SelectItem>
                <SelectItem value="member">Member — no implicit access</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </ModalBody>
        <ModalFooter className="sm:justify-between">
          <Button variant="outline-ghost" onClick={() => handleOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => onConfirm(role)} disabled={busy} className="gap-1.5">
            {busy ? <Loading className="size-4 shrink-0" /> : null}
            Apply
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
