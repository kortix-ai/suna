'use client';

import { useTranslations } from '@/i18n/use-translations';
import { invalidatePermissionProbes, qk } from '@kortix/sdk/react';
import {
  ArrowSquareOutIcon as ExternalLink,
  GithubLogoIcon as Github,
  InfoIcon as Info,
  KeyIcon as KeyRound,
  LinkIcon,
  PencilSimpleIcon as PencilSimple,
  ArrowClockwiseIcon as RefreshCw,
  PlugsIcon as Unplug,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { m, useReducedMotion } from 'motion/react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { type FormEvent, useEffect, useMemo, useState } from 'react';

import { ConnectingScreen } from '@/components/dashboard/connecting-screen';
import { AccessHelp } from '@/components/iam/access-help';
import { AccessProjectsTab } from '@/components/iam/access-projects-tab';
import { ApiKeysSection } from '@/components/iam/api-keys-card';
import { AuditTab } from '@/components/iam/audit-tab';
import { AuditWebhooksCard } from '@/components/iam/audit-webhooks-card';
import { BackToCustomizeOverlay } from '@/components/iam/back-to-customize-overlay';
import { EnterpriseDemoCard } from '@/components/iam/enterprise-demo-card';
import { EnterpriseUpsell } from '@/components/iam/enterprise-upsell';
import { GitHubAppSetupCard } from '@/components/iam/github-app-setup-card';
import { GroupsTab } from '@/components/iam/groups-tab';
import { IdentityIntro } from '@/components/iam/identity-intro';
import { KeyRulesCard } from '@/components/iam/key-rules-card';
import { MemberAccessPanel } from '@/components/iam/member-access-panel';
import { MfaRequiredCard } from '@/components/iam/mfa-required-card';
import { OAuthAppsCard } from '@/components/iam/oauth-apps-card';
import { RolesTab } from '@/components/iam/roles-tab';
import { ScimCard } from '@/components/iam/scim-card';
import { AccountSessionsPanel, SessionControlsCard } from '@/components/iam/session-controls-card';
import { SsoCard } from '@/components/iam/sso-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { SettingsRowGroup } from '@/components/ui/settings-row';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, infoToast, successToast, warningToast } from '@/components/ui/toast';
import { UserAvatar } from '@/components/ui/user-avatar';
import { AccountPane, AccountPaneSkeleton } from '@/features/accounts/hub/account-pane';
import {
  type AccountSection,
  localizedAccountPaneMeta,
  paneWidth,
} from '@/features/accounts/hub/sections';
import { useAccountDetail } from '@/features/accounts/hub/use-account-detail';
import { useAccountHubSection } from '@/features/accounts/hub/use-account-hub-access';
import { useAccountMembers } from '@/features/accounts/hub/use-account-members';
import { BillingTab } from '@/features/accounts/settings/billing-tab';
import { BrandingTab } from '@/features/accounts/settings/branding-tab';
import { TransactionsTab } from '@/features/accounts/settings/transactions-tab';
import { GlobalUpgradeModal } from '@/features/billing/global-upgrade-modal';
import { useBrandingScope } from '@/features/branding/branding-provider';
import { Close } from '@/features/icon/icons/close';
import { Plus } from '@/features/icon/icons/plus';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { useAuth } from '@/features/providers/auth-provider';
import {
  ACCESS_ROW_CLASS,
  AccessDialog,
  type AccessDialogPrincipal,
  AccessList,
  AccessRow,
  type KebabItem,
  type RoleValue,
  builtinRole,
  builtinRoleLabel,
  customRole,
  formatDate,
  principalLabel,
  roleValueLabel,
  useAccountRoles,
} from '@/features/workspace/shared/access';
import { useAccountState } from '@/hooks/billing';
import { useSignedOutRedirect } from '@/lib/auth/use-signed-out-redirect';
import { isGitHubAppInstallationId } from '@/lib/github-installations';
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
  leaveAccount,
  listAccountInvites,
  listGitHubInstallations,
  listPolicies,
  removeAccountMember,
  resendAccountInvite,
  updateAccountName,
} from '@kortix/sdk';
import {
  MagnifyingGlassIcon as Search,
  TrashIcon,
  UserPlusIcon as UserPlus,
  UsersIcon as Users,
} from '@phosphor-icons/react';

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
async function copyInviteLink(url: string, copiedMessage: string, fallbackMessage: string) {
  try {
    await navigator.clipboard.writeText(url);
    successToast(copiedMessage);
  } catch {
    // Older browsers / blocked clipboard — show the link in a toast so the
    // admin can copy it by hand.
    infoToast(fallbackMessage, {
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const accountId = params?.id;
  const queryClient = useQueryClient();
  const { user, isLoading: authLoading } = useAuth();

  useSignedOutRedirect();

  // Granular capabilities sourced from the IAM engine — ONE batched probe,
  // shared with the settings sidebar through the React Query cache (same key,
  // same probe list, one request). MUST be called before any conditional
  // return — moving it below the auth-loading guard would change the hook
  // count between renders. `usePermissions` short-circuits when accountId is
  // falsy, so it is safe to call before the account query resolves.
  const {
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
    activeSection,
  } = useAccountHubSection(accountId);

  // Shared with the settings shell's breadcrumb — same key, one request.
  const accountQuery = useAccountDetail(accountId);

  const membersQuery = useAccountMembers(accountId, canReadMembers);

  // Enterprise identity (SSO + SCIM) is gated on the account's plan. The cards
  // render only when the tier carries the entitlement — mirrors the server-side
  // 402 so we never show a control the backend rejects.
  const accountStateQuery = useAccountState({ accountId, enabled: !!user && !!accountId });
  // The hub brands as the account it SHOWS (Enterprise branding), not the
  // switcher's selected one — so an upload on the Branding tab re-brands the
  // header above it live.
  useBrandingScope(accountId);
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
  const brandingEnabled = !!entitlements?.branding;
  const entitlementsLoading = !entitlements && accountStateQuery.isLoading;

  const prefersReducedMotion = useReducedMotion();

  if (authLoading || !user) {
    return <ConnectingScreen forceConnecting overrideStage="auth" hideWorkspacePicker />;
  }

  const account = accountQuery.data;
  const members = membersQuery.data ?? [];
  // The three drill-down params. Each names the entity whose detail panel
  // replaces its tab's list, in the tab's own pane — `AccessProjectsTab`,
  // `GroupsTab` and `MemberAccessPanel` all read their selection from here so
  // a detail view is a URL, not a route change, and the left rail never
  // disappears underneath it.
  const selectedAccessProjectId = searchParams.get('project');
  // Set only by the Customize bar's "Members" link
  // (`capabilities/shared/capability-tabs.tsx`). It means this hub was opened
  // FROM a project, so the project panel offers a way back to it — landing
  // someone on the account hub with only an "All projects" breadcrumb strands
  // them one level above where they started.
  const cameFromCustomize = searchParams.get('from') === 'customize';
  const selectedAccessGroupId = searchParams.get('group');
  const selectedAccessMemberId = searchParams.get('member');
  // The Members list has a pane header; its member panel carries its own, so
  // suppress the outer one while a member is open (Groups and Projects have
  // no `PANE_META` entry at all, for the same reason).
  const paneMeta =
    activeSection === 'members' && selectedAccessMemberId
      ? undefined
      : localizedAccountPaneMeta(tI18nComplete)[activeSection];
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
    <AccountPane
      back={{ href: '/accounts', label: tI18nComplete.raw('text68d8e728a8ad') }}
      title={paneMeta?.title}
      description={paneMeta?.description}
      width={paneWidth(activeSection)}
    >
      {accountQuery.isError ? (
        <ErrorState
          size="sm"
          title={tI18nComplete.raw('text25eea22ea61b')}
          description={(accountQuery.error as Error).message}
          action={
            <Button variant="outline" size="sm" onClick={() => accountQuery.refetch()}>
              {tI18nComplete.raw('text942087cc2d41')}
            </Button>
          }
        />
      ) : accountQuery.isLoading ? (
        <AccountPaneSkeleton />
      ) : account ? (
        /* Keyed remount + a 200ms rise on section switch; opacity-only under
           reduced motion. */
        <m.div
          key={activeSection}
          initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
          className="min-w-0"
        >
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

          {/* Page chrome, not panel chrome: `fixed`, so it costs this
              layout no height and the panel's own "All projects" breadcrumb
              is untouched. Only on the project panel — the section the
              Customize bar's "Members" link actually opens. */}
          {activeSection === 'access-projects' && selectedAccessProjectId && cameFromCustomize ? (
            <BackToCustomizeOverlay />
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
              {/* OAuth apps — "Sign in with Kortix" clients. A client secret
                  is a credential the account issues to a machine, so it
                  sits with the other machine credentials and under the same
                  `token.*` permissions. */}
              <OAuthAppsCard accountId={account.account_id} canManage={canWriteAccount} />
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

          {/* Branding — Enterprise. The pane exists for anyone with
              account.write (rail rule); the entitlement decides whether it
              is the editor or the upsell, mirroring the server's 402 on the
              write routes. */}
          {activeSection === 'branding' && canWriteAccount ? (
            entitlementsLoading ? (
              <Skeleton className="h-64 w-full rounded-md" />
            ) : brandingEnabled ? (
              <BrandingTab accountId={account.account_id} canManage={canWriteAccount} />
            ) : (
              <EnterpriseUpsell feature="branding" />
            )
          ) : null}

          {activeSection === 'settings' && canWriteAccount ? (
            <div className="space-y-10">
              <SettingsGroup title={tI18nComplete.raw('textc910d474dcd7')}>
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
              <SettingsGroup
                title={tI18nComplete.raw('text8f6fb4eb7f42')}
                description={tI18nComplete.raw('textf9d52abc1fb8')}
              >
                <SettingsRowGroup>
                  <MfaRequiredCard accountId={account.account_id} canManage={canWriteAccount} />
                  <SessionControlsCard accountId={account.account_id} canManage={canWriteAccount} />
                </SettingsRowGroup>
                <AccountSessionsPanel accountId={account.account_id} canManage={canWriteAccount} />
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
                  title={tI18nComplete.raw('textc2ef82e31689')}
                  description={tI18nComplete.raw('text9c7d38b81f41')}
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
                <SettingsGroup title={tI18nComplete.raw('textfd8b8dae4421')}>
                  <DangerZoneCard />
                </SettingsGroup>
              ) : null}
            </div>
          ) : null}
        </m.div>
      ) : null}
    </AccountPane>
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
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
      successToast(tI18nComplete.raw('text06993786f49e'));
      setDisconnectTarget(null);
      queryClient.invalidateQueries({
        queryKey: ['github-installations', account.account_id],
      });
      queryClient.invalidateQueries({
        queryKey: ['github-repositories', account.account_id],
      });
    },
    onError: (err: Error) => errorToast(err.message || tI18nComplete.raw('text6e9715f4f2a9')),
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
            <p className="text-foreground text-sm font-medium">
              {tI18nComplete.raw('texte95944e1c3c8')}
            </p>
            <Hint label={tI18nComplete.raw('text01c8d0fbaec6')}>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={tI18nComplete.raw('text83ce6bad47b6')}
                className="text-muted-foreground hover:text-foreground size-5"
              >
                <Info className="size-3.5" />
              </Button>
            </Hint>
          </span>
          <p className="text-muted-foreground text-xs">{tI18nComplete.raw('text5122d0f1db23')}</p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="gap-1.5"
          disabled={!canManage || isConnecting}
          onClick={handleConnect}
          title={canManage ? undefined : tI18nComplete.raw('text89a0e2d1b569')}
        >
          {isConnecting ? <Loading className="size-4 shrink-0" /> : <Github className="size-4" />}
          {isConnecting ? 'Connecting' : tI18nComplete.raw('textee7ee5830f09')}
        </Button>
      </div>

      {installationsQuery.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-[58px] w-full rounded-md" />
        </div>
      ) : installationsQuery.isError ? (
        <InfoBanner tone="warning" icon={Github} title={tI18nComplete.raw('textd3a118da5b46')}>
          {(installationsQuery.error as Error).message}
        </InfoBanner>
      ) : installations.length === 0 ? (
        // Quiet contained empty state — the toolbar above already carries the
        // single "Connect GitHub" CTA.
        <div className="border-border text-muted-foreground rounded-md border border-dashed px-4 py-8 text-center text-sm">
          {tI18nComplete.raw('text053689bf661f')}
        </div>
      ) : (
        <ul className="space-y-2">
          {installations.map((installation) => {
            const contentsPermission = permissionLabel(installation.permissions?.contents);
            const repoSelection =
              installation.repository_selection === 'selected'
                ? tI18nComplete.raw('texte0a8d25fe959')
                : installation.repository_selection === 'all'
                  ? tI18nComplete.raw('text77fe4eba38d8')
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
                      {installation.owner_login ?? tI18nComplete.raw('texte53bb01e5503')}
                    </span>
                    <Badge variant="success" size="sm">
                      {tI18nComplete.raw('text22965568d22a')}
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
                        {tI18nComplete.raw('text6defafa2caa6')}
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
                      {tI18nComplete.raw('textacfc5be785a9')}
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
        title={tI18nComplete.raw('text6c47b175b49c')}
        description={tI18nComplete('text53270bef8b4a', {
          value0: disconnectTarget?.ownerLogin ?? tI18nComplete.raw('textd5f73450ac16'),
        })}
        confirmLabel={tI18nComplete.raw('textacfc5be785a9')}
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const [name, setName] = useState(account.name);

  useEffect(() => {
    setName(account.name);
  }, [account.name]);

  const renameMutation = useMutation({
    mutationFn: (next: string) => updateAccountName(account.account_id, next),
    onSuccess: (updated) => {
      successToast(tI18nComplete.raw('textfb38fa39668b'));
      queryClient.setQueryData(['account', account.account_id], updated);
      // The account LIST renders this name in every switcher. `scope()` is
      // the prefix that reaches the signed-in user's list slot from inside a
      // mutation callback, which has no user id in hand.
      queryClient.invalidateQueries({ queryKey: qk.accounts.scope() });
    },
    onError: (err: Error) => errorToast(err.message || tI18nComplete.raw('textf8b3ddaa27a4')),
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
        <Label htmlFor="account-name">{tI18nComplete.raw('texta704d8d4a818')}</Label>
        <Input
          id="account-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={!canWrite || renameMutation.isPending}
          maxLength={120}
          className="max-w-md"
          title={canWrite ? undefined : tI18nComplete.raw('textc7184af7d9c9')}
        />
        {!canWrite ? (
          <p className="text-muted-foreground text-xs">{tI18nComplete.raw('textc7184af7d9c9')}</p>
        ) : null}
      </div>

      <div className="border-border flex items-center justify-between border-t px-4 py-3">
        <p className="text-muted-foreground text-xs">
          {tI18nComplete.raw('textd70b9e24bca2')} {formatDate(account.created_at)}
        </p>
        <Button
          type="submit"
          size="sm"
          disabled={!canSubmit || renameMutation.isPending}
          className="gap-1.5"
        >
          {renameMutation.isPending ? <Loading className="size-4 shrink-0" /> : null}
          {tI18nComplete.raw('text1509f561f241')}
        </Button>
      </div>
    </form>
  );
}

function DangerZoneCard() {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <div className="bg-popover rounded-md border px-4 py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-foreground text-sm font-medium">
            {tI18nComplete.raw('texta2e20a335700')}
          </p>
          <p className="text-muted-foreground mt-0.5 text-xs">
            {tI18nComplete.raw('textdc32ee18ad99')}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled
          title={tI18nComplete.raw('text4f7d64017689')}
          className="shrink-0"
        >
          {tI18nComplete.raw('text4f7d64017689')}
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
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
      successToast(tI18nComplete.raw('text23b0caa9d34a'));
      invalidateMembers();
      setRemoveTarget(null);
    },
    onError: (err: Error) => errorToast(err.message || tI18nComplete.raw('text1cff79b7eb0b')),
  });

  const leaveMutation = useMutation({
    mutationFn: () => leaveAccount(account.account_id),
    onMutate: () => markPending(currentUserId),
    onSettled: () => clearPending(currentUserId),
    onSuccess: () => {
      successToast(tI18nComplete('texta95f7e7aff62', { value0: account.name }));
      queryClient.invalidateQueries({ queryKey: qk.accounts.scope() });
      router.push('/accounts');
    },
    onError: (err: Error) => errorToast(err.message || tI18nComplete.raw('text9de0b8c8b34b')),
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
      successToast(tI18nComplete('text540afa4c53ff', { label, count: ids.length }));
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
      tI18nComplete('text479974eaff88', {
        value0: label,
        value1: ids.length - failures.length,
        value2: failures.length,
        value3: first.email,
        value4: reasonShort,
        value5: tail,
      }),
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
          title={tI18nComplete.raw('texte0447514873e')}
          description={error?.message}
          action={
            <Button variant="outline" size="sm" onClick={onRetry}>
              {tI18nComplete.raw('text942087cc2d41')}
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
                placeholder={tI18nComplete.raw('text6497fc6f8400')}
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
                {tI18nComplete.raw('text1fd9ae1607aa')}
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
              <span className="text-foreground text-xs font-medium">
                {selectedCount} {tI18nComplete.raw('textd7cbbb688b2e')}
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={toggleAllEligible}
                disabled={bulkBusy}
                className="text-muted-foreground"
              >
                {allEligibleSelected
                  ? tI18nComplete.raw('text967549497036')
                  : tI18nComplete.raw('text1fc9a387654d')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={clearSelection}
                disabled={bulkBusy}
                className="text-muted-foreground"
              >
                {tI18nComplete.raw('text83b12c2216ef')}
              </Button>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                {canUpdateRole ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setBulkDialog('set_role')}
                    disabled={bulkBusy}
                  >
                    {tI18nComplete.raw('texta43a8d8cfd29')}
                  </Button>
                ) : null}
                {canAddToGroup ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setBulkDialog('add_to_group')}
                    disabled={bulkBusy}
                  >
                    {tI18nComplete.raw('textea849eb70c26')}
                  </Button>
                ) : null}
                {canRemove ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setBulkDialog('remove')}
                    disabled={bulkBusy}
                  >
                    {tI18nComplete.raw('textc3812fc4acb8')}
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
              {tI18nComplete.raw('text4caa18882dc4')}
              {search.trim()}”.
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
              header={{ title: tI18nComplete.raw('text1044a4c056d0'), count: sorted.length }}
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
                    label: tI18nComplete.raw('texta514a684676a'),
                    icon: <PencilSimple className="size-3.5" />,
                    onSelect: () => setEditTarget(member),
                  });
                }
                kebab.push({
                  label: tI18nComplete.raw('textf5462009cf42'),
                  icon: <KeyRound className="size-3.5" />,
                  onSelect: () => onSelectMember(member.user_id),
                });
                if (canRemove && !isSelf) {
                  kebab.push({
                    label: tI18nComplete.raw('text6bfa319e3d20'),
                    icon: <TrashIcon className="size-3.5" />,
                    variant: 'destructive',
                    separated: true,
                    disabled: isLastOwner,
                    onSelect: () => setRemoveTarget(member),
                  });
                }
                if (isSelf) {
                  kebab.push({
                    label: tI18nComplete.raw('text1d5b40338c62'),
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
                            {tI18nComplete.raw('text08b041935798')}
                          </Badge>
                        ) : null}
                        {member.is_super_admin ? (
                          <Badge
                            size="sm"
                            className="bg-kortix-orange/15 text-kortix-orange border-transparent"
                            title={tI18nComplete.raw('text3cafa764c6f9')}
                          >
                            {tI18nComplete.raw('text8185c8ac4656')}
                          </Badge>
                        ) : null}
                        {member.has_verified_mfa ? (
                          <Badge
                            variant="success"
                            size="sm"
                            title={tI18nComplete.raw('textc56fc40bb882')}
                          >
                            2FA
                          </Badge>
                        ) : account.mfa_required && !member.is_super_admin ? (
                          // Account requires MFA and this member has no verified
                          // factor — they're blocked from gated actions until they
                          // enrol. Super-admins are exempt, so they're not flagged.
                          <Badge
                            variant="destructive"
                            size="sm"
                            title={tI18nComplete.raw('text0bd9da305fb1')}
                          >
                            {tI18nComplete.raw('textfdeee365fcf3')}
                          </Badge>
                        ) : null}
                      </>
                    }
                    meta={<MemberMeta member={member} />}
                    trailing={roleValueLabel('account', roleValue, rolesQuery.data, tI18nComplete)}
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
                            label: tI18nComplete('textb4b262ae0516', { value0: label }),
                          }
                        : undefined
                    }
                    pending={pending}
                    kebab={kebab}
                    kebabLabel={tI18nComplete('text33da220b1a34', { value0: label })}
                  />
                );
              })}
            </AccessList>
          ) : null}

          {members.length === 0 ? (
            <EmptyState
              icon={Users}
              size="sm"
              title={tI18nComplete.raw('text669a52e9230b')}
              description={tI18nComplete.raw('text9233263288f5')}
              action={
                canInvite ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    onClick={() => setGrantOpen(true)}
                  >
                    <UserPlus className="size-3.5" />
                    {tI18nComplete.raw('text1fd9ae1607aa')}
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
        title={tI18nComplete.raw('text914d43beac26')}
        description={
          removeTarget
            ? tI18nComplete('text0b628a266141', {
                value0: principalLabel(removeTarget),
                value1: account.name,
              })
            : ''
        }
        confirmLabel={tI18nComplete.raw('textc3812fc4acb8')}
        confirmVariant="destructive"
        onConfirm={() => removeTarget && removeMutation.mutate(removeTarget.user_id)}
        isPending={removeMutation.isPending}
      />

      <ConfirmDialog
        open={leaveConfirmOpen}
        onOpenChange={setLeaveConfirmOpen}
        title={tI18nComplete.raw('text1d5b40338c62')}
        description={
          <span>
            {tI18nComplete.raw('text54ce8b59de87')}{' '}
            <span className="text-foreground font-medium">{account.name}</span>{' '}
            {tI18nComplete.raw('textd17426176cc2')}
          </span>
        }
        confirmLabel={tI18nComplete.raw('textfc6e4a408d56')}
        confirmVariant="destructive"
        onConfirm={() => leaveMutation.mutate()}
        isPending={leaveMutation.isPending}
      />

      <ConfirmDialog
        open={bulkDialog === 'remove'}
        onOpenChange={(o) => !o && setBulkDialog(null)}
        title={tI18nComplete.raw('text914d43beac26')}
        description={tI18nComplete('text37074af6784c', {
          value0: selectedCount,
          value1: selectedCount === 1 ? '' : 's',
          value2: account.name,
        })}
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const projects = member.projects ?? [];
  const projectCount =
    typeof member.explicit_project_count === 'number'
      ? member.explicit_project_count
      : projects.length;
  const showProjects = member.account_role === 'member' && projectCount > 0;

  return (
    <span className="text-muted-foreground text-xs">
      <InlineMeta>
        <span>
          {tI18nComplete.raw('text69318b0c6a92')} {formatDate(member.joined_at)}
        </span>
        {showProjects ? <MemberProjectsChip count={projectCount} projects={projects} /> : null}
        {member.groups && member.groups.length > 0 ? (
          <span>
            {member.groups.length} {tI18nComplete.raw('textad936fcbed63')}
            {member.groups.length === 1 ? '' : 's'}
          </span>
        ) : null}
        {typeof member.active_pat_count === 'number' && member.active_pat_count > 0 ? (
          <span>
            {member.active_pat_count} {tI18nComplete.raw('text3c469e9d6c58')}
            {member.active_pat_count === 1 ? '' : 's'}
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
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
              {builtinRoleLabel('project', project.role, tI18nComplete)}
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
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
        successToast(tI18nComplete.raw('text7e4f3f8089ab'));
      } else {
        // Mailtrap not configured (local dev or unconfigured prod). Hand the
        // admin the link directly so they can share it manually.
        warningToast(tI18nComplete.raw('text146fd497badf'), {
          duration: 8_000,
          button: (
            <Button
              size="sm"
              onClick={() =>
                copyInviteLink(
                  res.invite_url,
                  tI18nComplete.raw('text0dc2f4c75de6'),
                  tI18nComplete.raw('textfa6453683837'),
                )
              }
            >
              {tI18nComplete.raw('text9adff6870471')}
            </Button>
          ),
        });
      }
      invalidate();
    },
    onError: (err: Error) => errorToast(err.message || tI18nComplete.raw('text1f37df0db62b')),
  });

  const cancelMutation = useMutation({
    mutationFn: (inviteId: string) => cancelAccountInvite(accountId, inviteId),
    onMutate: (id) => markPending(id),
    onSettled: (_data, _error, id) => clearPending(id),
    onSuccess: () => {
      successToast(tI18nComplete.raw('text25a5ba44713d'));
      invalidate();
    },
    onError: (err: Error) => errorToast(err.message || tI18nComplete.raw('text05c7ab9784c3')),
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
      <AccessList header={{ title: tI18nComplete.raw('text63b17becd812'), count: invites.length }}>
        {invites.map((invite) => (
          <AccessRow
            key={invite.invite_id}
            dashed
            leading={<UserAvatar email={invite.email} size="md" />}
            title={invite.email}
            meta={
              <span className="text-muted-foreground text-xs">
                <InlineMeta>
                  <span>
                    {tI18nComplete.raw('text2a91147eb974')} {formatDate(invite.expires_at)}
                  </span>
                </InlineMeta>
              </span>
            }
            trailing={builtinRoleLabel('account', invite.initial_role, tI18nComplete)}
            pending={pendingIds.has(invite.invite_id)}
            kebabLabel={tI18nComplete('text33da220b1a34', { value0: invite.email })}
            kebab={
              canManage
                ? [
                    {
                      label: tI18nComplete.raw('text60ca7b35a944'),
                      icon: <RefreshCw className="size-3.5" />,
                      onSelect: () => resendMutation.mutate(invite.invite_id),
                    },
                    {
                      label: tI18nComplete.raw('text5c58cd7963ca'),
                      icon: <LinkIcon className="size-3.5" />,
                      onSelect: () =>
                        void copyInviteLink(
                          invite.invite_url,
                          tI18nComplete.raw('text0dc2f4c75de6'),
                          tI18nComplete.raw('textfa6453683837'),
                        ),
                    },
                    {
                      label: tI18nComplete.raw('textd1a5371a1e08'),
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
        title={tI18nComplete.raw('textd1a5371a1e08')}
        description={
          cancelTarget ? tI18nComplete('textaa5da553f3c6', { value0: cancelTarget.email }) : ''
        }
        confirmLabel={tI18nComplete.raw('textd1a5371a1e08')}
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
