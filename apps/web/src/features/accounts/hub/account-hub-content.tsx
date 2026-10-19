'use client';

/**
 * The account hub's body — everything to the right of the settings sidebar at
 * `/accounts/<id>`: the section catalog's panes, their drill-downs, and the
 * mutations each one owns.
 *
 * **One body, two mounts.** This used to BE `features/accounts/hub/account-hub-content.tsx`.
 * It moved here on 2026-09-08 so the same component can render in two places:
 * the route (cold loads, deep links, the five sub-routes) and
 * `AccountHubPanel`, the full-screen overlay that opens over whatever page you
 * are on with no navigation at all. The route mount is unchanged in behaviour;
 * the overlay is what makes an in-app click cost a render instead of an RSC
 * round-trip, a chunk fetch and a shell remount.
 *
 * Nothing here knows which mount it is in. The account id and what a hub link
 * does come from `useAccountHubLocation()`; the hub's own query — `tab`,
 * `member`, `group`, `project` — comes from `useHubSearchParams()`, which
 * reads the route's URL directly and the overlay's prefixed params
 * (`accountTab`, …) through one translation. Never `useSearchParams()`.
 */

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
  DotsThreeIcon as DotsThree,
  ClockIcon,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useUiRouter } from '@kortix/ui/providers/ui-provider';
import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from 'react';

import { ConnectingScreen } from '@/components/dashboard/connecting-screen';
import { AccessHelp } from '@/components/iam/access-help';
import { AccessProjectsTab } from '@/components/iam/access-projects-tab';
import { AddGitHubAccountDialog } from '@kortix/ui/access/iam/add-github-account-dialog';
import { ApiKeysSection } from '@/components/iam/api-keys-card';
import { AuditTab } from '@/components/iam/audit-tab';
import { AuditWebhooksCard } from '@/components/iam/audit-webhooks-card';
import { EnterpriseUpsell } from '@/components/iam/enterprise-upsell';
import { GroupsTab } from '@/components/iam/groups-tab';
import { IdentityIntro } from '@/components/iam/identity-intro';
import { KeyRulesCard } from '@/components/iam/key-rules-card';
import { ManagedGitNotice } from '@kortix/ui/access/iam/managed-git-notice';
import { MemberAccessPanel } from '@/components/iam/member-access-panel';
import { MfaRequiredCard } from '@/components/iam/mfa-required-card';
import { SessionOversightCard } from '@kortix/ui/access/iam/session-oversight-card';
import { OAuthAppsCard } from '@/components/iam/oauth-apps-card';
import { RolesTab } from '@/components/iam/roles-tab';
import { ScimCard } from '@/components/iam/scim-card';
import { AccountSessionsPanel, SessionControlsCard } from '@/components/iam/session-controls-card';
import { SsoCard } from '@/components/iam/sso-card';
import { Badge } from '@kortix/ui/badge';
import { ButtonGroup } from '@kortix/ui/button-group';
import { Button } from '@kortix/ui/button';
import { Checkbox } from '@kortix/ui/checkbox';
import { ConfirmDialog } from '@kortix/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@kortix/ui/dropdown-menu';
import { EntityAvatar } from '@kortix/ui/entity-avatar';
import Hint from '@kortix/ui/hint';
import { InfoBanner } from '@kortix/ui/info-banner';
import { InlineMeta } from '@kortix/ui/inline-meta';
import { Input } from '@kortix/ui/input';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@kortix/ui/input-group';
import { Label } from '@kortix/ui/label';
import Loading from '@kortix/ui/loading';
import { SettingsRowGroup } from '@kortix/ui/settings-row';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@kortix/ui/select';
import { Skeleton } from '@kortix/ui/skeleton';
import { errorToast, infoToast, successToast, warningToast } from '@kortix/ui/toast';
import { UserAvatar } from '@kortix/ui/user-avatar';
import { BillingTab } from '@/features/accounts/settings/billing-tab';
import { BrandingTab } from '@/features/accounts/settings/branding-tab';
import { TransactionsTab } from '@/features/accounts/settings/transactions-tab';
import { GlobalUpgradeModal } from '@/features/billing/global-upgrade-modal';
import { useBrandingScope } from '@kortix/ui/internal/branding/branding-provider';
import { Close } from '@kortix/ui/icons';
import { Plus } from '@kortix/ui/internal/icons/plus';
import { EmptyState } from '@kortix/ui/empty-state';
import { ErrorState } from '@kortix/ui/error-state';
import { useAuth } from '@/features/providers/auth-provider';
import { ScimSetupWizard, SsoSetupWizard } from '@/features/sso-setup/setup-wizard';
import {
  ACCESS_ROW_CLASS,
  type AccessDialogPrincipal,
  type KebabItem,
  type RoleValue,
  builtinRoleLabel,
  formatDate,
  principalLabel,
  roleValueLabel,
  useAccountRoleEditor,
  useAccountRoles,
} from '@kortix/ui/access/access/index';
import { AccessDialog } from '@kortix/ui/access';
import { useAccountState } from '@kortix/ui/internal/billing/index';
import { useSignedOutRedirect } from '@/lib/auth/use-signed-out-redirect';
import { cn } from '@kortix/ui';
import { forgetPushedEntry, hubTarget, openAccountPanel } from '@kortix/ui/internal/stores/account-panel-store';
import { BillingAccountProvider } from '@kortix/ui/internal/stores/billing-account-context';
import {
  type AccountDetail,
  type AccountInvitation,
  type AccountMember,
  type AccountRole,
  cancelAccountInvite,
  deleteGitHubInstallation,
  leaveAccount,
  listAccountInvites,
  listGitHubInstallations,
  removeAccountMember,
  resendAccountInvite,
  updateAccountName,
} from '@kortix/sdk';
import {
  MagnifyingGlassIcon as Search,
  TrashIcon,
  UsersIcon as Users,
} from '@phosphor-icons/react';
import { useAccountPanelId, useHubSearchParams } from '@kortix/ui/internal/account-hub/account-hub-location';
import { AccountPane, AccountPaneSkeleton } from './account-pane';
import { type AccountSection, localizedAccountPaneMeta, paneWidth } from '@kortix/ui/internal/account-hub/sections';
import { useAccountDetail } from '@kortix/ui/internal/account-hub/use-account-detail';
import { useAccountHubSection } from '@kortix/ui/internal/account-hub/use-account-hub-access';
import { useAccountMembers } from '@kortix/ui/internal/account-hub/use-account-members';
import { useAccountHubSheet } from '@kortix/ui/internal/account-hub/hub-sheet';

// The enterprise IdP surface (SAML SSO + SCIM provisioning) is PLAN-GATED,
// not env-gated: the cards render only for accounts whose tier carries the
// `sso` / `scim` entitlement (i.e. the sales-assigned `enterprise` tier). This
// matches the server-side enforcement in the SCIM/SSO routes — the API returns
// 402 for non-entitled accounts — so the UI never offers a control that the
// backend would reject. See `entitlements` on the account-state `tier` block.

// `formatDate` and `principalLabel` come from
// `packages/ui/src/access/access` — this file used to carry its own copy of
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

export function AccountHubContent() {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  // `?accountId=` and the hub's own params, both off the URL the modal writes
  // onto the page it floats over. See `account-hub-location.tsx`.
  const accountId = useAccountPanelId();
  const searchParams = useHubSearchParams();
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
    canCreateToken,
    sectionVisible,
    activeSection,
  } = useAccountHubSection(accountId);

  // Shared with the settings shell's breadcrumb — same key, one request.
  const accountQuery = useAccountDetail(accountId);

  const membersQuery = useAccountMembers(accountId);

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
  // Forms open in the hub's split sheet beside the pane. A sheet belongs to
  // the pane that opened it, so leaving the pane closes it.
  const hubSheet = useAccountHubSheet();
  const closeHubSheet = hubSheet.close;
  useEffect(() => {
    closeHubSheet();
  }, [accountId, activeSection, closeHubSheet]);

  if (authLoading || !user) {
    return <ConnectingScreen overrideStage="auth" hideWorkspacePicker />;
  }

  const account = accountQuery.data;
  const members = membersQuery.data ?? [];
  // The three drill-down params. Each names the entity whose detail panel
  // replaces its tab's list, in the tab's own pane — `AccessProjectsTab`,
  // `GroupsTab` and `MemberAccessPanel` all read their selection from here so
  // a detail view is a URL, not a route change, and the left rail never
  // disappears underneath it.
  const selectedAccessProjectId = searchParams.get('project');
  const selectedAccessGroupId = searchParams.get('group');
  // `sso` | `scim`: a guided wizard standing in for the Identity pane.
  const rawSetup = searchParams.get('setup');
  const activeSetup = rawSetup === 'sso' || rawSetup === 'scim' ? rawSetup : null;
  const selectedAccessMemberId = searchParams.get('member');
  // The Members list has a pane header; its member panel carries its own, so
  // suppress the outer one while a member is open (Groups and Projects have
  // no `PANE_META` entry at all, for the same reason).
  const paneMeta =
    (activeSection === 'members' && selectedAccessMemberId) ||
    (activeSection === 'identity' && activeSetup)
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
    openAccountPanel(
      hubTarget(accountId, {
        tab: section,
        project: opts?.project,
        group: opts?.group,
        member: opts?.member,
      }),
    );
  };

  const openInvite = (target: AccountDetail) =>
    hubSheet.open({
      title: tI18nComplete.raw('text8693768c7e08'),
      body: (
        <AccessDialog
          presentation="split-sheet"
          open
          onOpenChange={(next) => {
            if (!next) hubSheet.close();
          }}
          accountId={target.account_id}
          accountName={target.name}
          scope={{ kind: 'account' }}
          mode={{ kind: 'grant' }}
          rbacEnabled={rbacEnabled}
          canManageRoles={canManageRoles}
          onDone={() => {
            // Membership, roles and invites all move verdicts; the probes are
            // cached 5 minutes. Same set `MembersCard` busts after a change.
            void invalidatePermissionProbes(queryClient, { accountId: target.account_id });
            for (const key of ['account-members', 'account-invites', 'account']) {
              void queryClient.invalidateQueries({ queryKey: [key, target.account_id] });
            }
          }}
        />
      ),
    });

  return (
    <AccountPane
      back={{ to: hubTarget(null), label: tI18nComplete.raw('text68d8e728a8ad') }}
      title={paneMeta?.title}
      description={paneMeta?.description}
      /* A wizard is a full-width surface wherever it renders — it was a
         `width="full"` page of its own before it became a pane. */
      width={activeSetup && activeSection === 'identity' ? 'full' : paneWidth(activeSection)}
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
        /* Keyed remount on section switch, no transition: a settings tab is
           switched many times a session, and a rise on every switch read as lag. */
        <div key={activeSection} className="min-w-0">
          {activeSection === 'billing' && sectionVisible.billing ? (
            <div className="space-y-6">
              {/* Scope every billing hook nested below to this account so a
                  multi-account user doesn't see (or mutate) their primary
                  account by accident. */}
              <BillingAccountProvider accountId={account.account_id}>
                <BillingTab
                  // Stripe Billing Portal requires an absolute return_url —
                  // a bare path 500s with "Not a valid URL". Build from origin.
                  // Stripe requires an ABSOLUTE return_url (a bare path 500s
                  // with "Not a valid URL"), and it must come back to the hub.
                  // The current URL already IS that: this pane only renders
                  // while `?accountId=…&accountTab=billing` is on it. Building
                  // it from `window.location` rather than from a hard-coded
                  // path is also what keeps the person on the page they opened
                  // the hub over.
                  returnUrl={typeof window !== 'undefined' ? window.location.href : '/projects'}
                  isActive
                />
                {/* The plan picker's subscribe button starts checkout, and the
                    top-up view opens the global upgrade-dialog store; mount its renderer here (the global
                    one lives only on share pages) so the dialog actually
                    appears, scoped to THIS account via the provider above. */}
                <GlobalUpgradeModal />
              </BillingAccountProvider>
            </div>
          ) : null}

          {activeSection === 'transactions' && sectionVisible.transactions ? (
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
                canReadMembers={canReadMembers}
                onSelectMember={(id) => navigate('members', { member: id })}
                onInvite={() => openInvite(account)}
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
                accountName={account.name}
                currentUserId={user.id}
                canUpdateRole={canUpdateMember}
                canReadMembers={canReadMembers}
                onSelectMember={(id) => navigate('members', { member: id })}
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
                <EnterpriseUpsell feature="audit" accountId={account.account_id} />
              )}
              {/* Webhooks ship the same events the log above shows, so they
                  live on this tab rather than buried in Settings. Only
                  rendered entitled + writable — the card is all mutations. */}
              {!entitlementsLoading && auditEnabled && canWriteAccount ? (
                <AuditWebhooksCard accountId={account.account_id} canManage={canWriteAccount} />
              ) : null}
            </div>
          ) : null}

          {/* Account-scoped ONLY. The instance's managed-git identity used to
              render here as `GitHubAppSetupCard`, one card below the
              account's own connections — and on 2026-09-16 a platform admin
              reconfigured production's GitHub App from inside one customer's
              settings. That card lives at `/admin/git` now. What is left here
              is the account's own App installations plus one read-only line
              naming the instance's managed-git owner. */}
          {activeSection === 'git' && canWriteAccount ? (
            <div className="space-y-8">
              <GitHubConnectionCard account={account} canManage={canWriteAccount} />
              <ManagedGitNotice />
            </div>
          ) : null}

          {/* Tokens — the machine-access surface, and ONLY that since
              2026-08-18: service account tokens first, the rules that govern
              them second. A person's own API keys are not account
              configuration and left for `/settings/tokens`
              (`packages/ui/src/customize/settings/tabs/tokens-tab.tsx`);
              `ApiKeysSection` carries the one line that points there. Both
              components carry their own section headers, so the pane header
              above is the only other chrome. */}
          {activeSection === 'tokens' && sectionVisible.tokens ? (
            <div className="space-y-10">
              <ApiKeysSection accountId={account.account_id} canManage={canCreateToken === true} />
              {/* OAuth apps — "Sign in with Kortix" clients. A client secret
                  is a credential the account issues to a machine, so it
                  sits with the other machine credentials and under the same
                  `token.*` permissions. */}
              <OAuthAppsCard accountId={account.account_id} canManage={canCreateToken === true} />
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
          {/* The two guided wizards took over the Identity pane on 2026-09-08,
              when `/accounts/<id>/sso-setup` and `/accounts/<id>/scim-setup`
              were deleted with the rest of the account routes. `?setup=` is
              what the SSO and SCIM cards' Configure buttons now set, and the
              breadcrumb grows a fourth crumb for it (`accountHubCrumbs`). */}
          {activeSection === 'identity' && canWriteAccount && activeSetup ? (
            activeSetup === 'sso' ? (
              <SsoSetupWizard accountId={account.account_id} />
            ) : (
              <ScimSetupWizard accountId={account.account_id} />
            )
          ) : null}

          {activeSection === 'identity' && canWriteAccount && !activeSetup ? (
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
                <EnterpriseUpsell feature="identity" accountId={account.account_id} />
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
              <EnterpriseUpsell feature="branding" accountId={account.account_id} />
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
                  {/* Who may open whose work. Owner-only toggle; the row
                      reads `can_change` from the API and explains itself to
                      everyone else. See `session-oversight-card.tsx`. */}
                  <SessionOversightCard accountId={account.account_id} />
                </SettingsRowGroup>
                <AccountSessionsPanel accountId={account.account_id} canManage={canWriteAccount} />
              </SettingsGroup>

              {canDeleteAccount ? (
                <SettingsGroup title={tI18nComplete.raw('textfd8b8dae4421')}>
                  <DangerZoneCard />
                </SettingsGroup>
              ) : null}
            </div>
          ) : null}
          {/* section-panes:end — source tests slice the panes up to here. */}
        </div>
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
  // GitHub's install flow is a full page load on github.com, so this LEAVES
  // the hub for a real page. `router.replace` is the whole job: it overwrites
  // the entry the modal pushed — so Back from the setup page returns to where
  // the hub was opened, not to the hub — and the URL it goes to carries no
  // `accountId`, which is what "closed" means.
  const router = useUiRouter();
  const queryClient = useQueryClient();
  const [disconnectTarget, setDisconnectTarget] = useState<{
    installationId: string;
    ownerLogin: string | null;
  } | null>(null);
  const [addOpen, setAddOpen] = useState(false);

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

  // Account connections only. The instance git backend used to be injected
  // here as a synthetic entry, which made one instance-global credential look
  // like this account's own GitHub connection; it has its own namespace now
  // and is reported read-only by `ManagedGitNotice`.
  const installations = installationsQuery.data?.installations ?? [];
  // Where GitHub installs the Kortix App. `null` on an instance with no App
  // configured at all — the action says so rather than opening a 404 on
  // github.com, which is what a wrong slug used to produce.
  const installUrl = installationsQuery.data?.install_url ?? null;

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
          disabled={!canManage}
          onClick={() => setAddOpen(true)}
          title={canManage ? undefined : tI18nComplete.raw('text89a0e2d1b569')}
        >
          <Plus className="size-3.5" />
          {tI18nComplete.raw('textee7ee5830f09')}
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
            const contents = installation.permissions?.contents;
            const contentsPermission =
              typeof contents === 'string' && contents
                ? tI18nComplete('text65ef045d1ffa', { value0: contents })
                : null;
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

      <AddGitHubAccountDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        accountId={account.account_id}
        installUrl={installUrl}
        // Back to this hub tab, over the page it is open on.
        returnPath={
          typeof window === 'undefined'
            ? ''
            : `${window.location.pathname}${window.location.search}`
        }
        // Drop the entry the hub modal pushed, so Back from GitHub returns to
        // the page the hub was opened over.
        onBeforeLeave={forgetPushedEntry}
      />

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

type MemberFilter = 'all' | AccountRole | 'invited';
const MEMBER_FILTERS: readonly MemberFilter[] = ['all', 'owner', 'admin', 'member', 'invited'];
/** "Owner" / "Admin" / "Member" — Linear's short role names. */
const ACCOUNT_ROLE_KEY: Record<AccountRole, string> = {
  owner: 'text4b1b8aa3608a',
  admin: 'textc1c224b03cd9',
  member: 'text7c968fb71f50',
};

type RoleTone = 'secondary' | 'outline' | 'muted';
/** Badge variant by rank: the owner reads strongest, a member quietest. A
 *  custom role reads like an admin; an invite like a member. */
function roleTone(value: RoleValue): RoleTone {
  if (value.kind !== 'builtin') return 'outline';
  if (value.role === 'owner') return 'secondary';
  if (value.role === 'admin') return 'outline';
  return 'muted';
}
//
// Linear's members table (`MemberTableHead` / `MemberTableRow` below): flat
// rows, a checkbox gutter that appears on hover and stays once anything is
// selected, a floating bulk bar. Granting opens `AccessDialog` in the hub's
// split sheet; editing and bulk changes use it as a modal. What used to live
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
  canReadMembers,
  onSelectMember,
  onInvite,
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
  /** `member.read` — another member's access panel reads `.../iam/members/:id/*`,
   *  which asserts it. Without it, "View access" is offered on the own row only. */
  canReadMembers: boolean;
  /** Opens one member's `MemberAccessPanel` in this same pane
   *  (`?tab=members&member=<id>`) — no route change, the rail stays. */
  onSelectMember: (userId: string) => void;
  /** Opens the grant form in the hub's split sheet. */
  onInvite: () => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
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
  // The "All" select beside search: one account role, or pending invites.
  const [roleFilter, setRoleFilter] = useState<MemberFilter>('all');
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
  const roleEditor = useAccountRoleEditor({
    accountId: account.account_id,
    accountName: account.name,
    rbacEnabled,
    canReadPolicies,
    canManageRoles,
    onDone: () => invalidateMembers(),
  });
  const roleValueFor = (member: AccountMember): RoleValue =>
    roleEditor.roleValueFor(member.user_id, member.account_role);

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
    const byRole =
      roleFilter === 'all'
        ? filtered
        : roleFilter === 'invited'
          ? []
          : filtered.filter((m) => m.account_role === roleFilter);
    return [...byRole].sort((a, b) => {
      const r = rank[a.account_role] - rank[b.account_role];
      if (r !== 0) return r;
      return principalLabel(a).localeCompare(principalLabel(b));
    });
  }, [members, search, roleFilter]);

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
      openAccountPanel(hubTarget(null));
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
            r.reason instanceof Error
              ? r.reason.message
              : String(r.reason ?? tI18nComplete.raw('text27c2ccd962c2')),
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
    console.error(`[bulk] ${failures.length} failed`, failures);

    // First failure is shown inline; rest summarised. Trim long
    // messages so a 500-char stack trace doesn't blow up the toast.
    const first = failures[0];
    const reasonShort = first.reason.length > 140 ? `${first.reason.slice(0, 137)}…` : first.reason;
    const tail =
      failures.length > 1 ? tI18nComplete('text4e9efdcbbcbe', { count: failures.length - 1 }) : '';
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

  // Linear's selection model: once anything is ticked, every row shows its
  // checkbox; before that a checkbox shows only on the hovered row.
  const selecting = selectedCount > 0;
  const ownerCount = sorted.filter((m) => m.account_role === 'owner').length;
  const showInvites = roleFilter === 'all' || roleFilter === 'invited';
  // Owner / Admin / Member for the built-ins; a custom role keeps its name.
  const shortRoleLabel = (value: RoleValue) =>
    value.kind === 'builtin' && value.role in ACCOUNT_ROLE_KEY
      ? tI18nComplete.raw(ACCOUNT_ROLE_KEY[value.role as AccountRole])
      : roleValueLabel('account', value, rolesQuery.data, tI18nComplete);
  const filterLabel: Record<MemberFilter, string> = {
    all: tI18nComplete.raw('texta52ace420f21'),
    owner: tI18nComplete.raw(ACCOUNT_ROLE_KEY.owner),
    admin: tI18nComplete.raw(ACCOUNT_ROLE_KEY.admin),
    member: tI18nComplete.raw(ACCOUNT_ROLE_KEY.member),
    invited: tI18nComplete.raw('text63b17becd812'),
  };

  return (
    <div className="space-y-3">
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
        <div className="space-y-1">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-11 w-full rounded-lg" />
          ))}
        </div>
      ) : null}

      {!isLoading && !isError ? (
        <>
          {/* Linear's toolbar: search, a role filter, and Invite pushed right.
              Search filters invites and members alike. */}
          <div className="flex items-center gap-2">
            {/* h-8 like the select and Invite beside it. */}
            <InputGroupSearch className="w-full max-w-90">
              <InputGroupSearchIcon className="left-2.5">
                <Search className="size-4" />
              </InputGroupSearchIcon>
              <InputGroupSearchInput
                size="xs"
                className="pl-8 text-sm"
                placeholder={tI18nComplete.raw('text6497fc6f8400')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {search ? <InputGroupSearchClear onClick={() => setSearch('')} /> : null}
            </InputGroupSearch>
            <Select value={roleFilter} onValueChange={(v) => setRoleFilter(v as MemberFilter)}>
              <SelectTrigger className="w-auto shrink-0" aria-label={tI18nComplete.raw('text14736a2eb9f4')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="start">
                {MEMBER_FILTERS.map((value) => (
                  <SelectItem key={value} value={value}>
                    {filterLabel[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {/* Bulk actions sit in the toolbar, before Invite, while anything
                is selected. No count, no floating bar. */}
            <div className="ml-auto flex shrink-0 items-center gap-3">
              {selecting && canBulk ? (
                <ButtonGroup>
                  {canUpdateRole ? (
                    <Button size="sm" variant="secondary" onClick={() => setBulkDialog('set_role')} disabled={bulkBusy}>
                      {tI18nComplete.raw('texta43a8d8cfd29')}
                    </Button>
                  ) : null}
                  {canAddToGroup ? (
                    <Button size="sm" variant="secondary" onClick={() => setBulkDialog('add_to_group')} disabled={bulkBusy}>
                      {tI18nComplete.raw('textea849eb70c26')}
                    </Button>
                  ) : null}
                  {canRemove ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      className="text-destructive hover:text-destructive"
                      onClick={() => setBulkDialog('remove')}
                      disabled={bulkBusy}
                    >
                      {tI18nComplete.raw('textc3812fc4acb8')}
                    </Button>
                  ) : null}
                </ButtonGroup>
              ) : null}
            {canInvite ? (
              <Button size="sm" className="shrink-0 gap-1.5" onClick={onInvite}>
                <Plus className="size-3.5" />
                {tI18nComplete.raw('text1fd9ae1607aa')}
              </Button>
            ) : null}
            </div>
          </div>

          {members.length === 0 ? (
            <EmptyState
              icon={Users}
              size="sm"
              title={tI18nComplete.raw('text669a52e9230b')}
              description={tI18nComplete.raw('text9233263288f5')}
            />
          ) : (
            // `-ml-7`: the select gutter hangs outside the content edge.
            <div role="table" aria-label={tI18nComplete.raw('text1044a4c056d0')} className="-ml-7">
              <MemberTableHead
                select={
                  canBulk && bulkEligible.length > 0
                    ? {
                        visible: selecting,
                        checked: allEligibleSelected
                          ? true
                          : selecting
                            ? 'indeterminate'
                            : false,
                        onCheckedChange: toggleAllEligible,
                        label: allEligibleSelected
                          ? tI18nComplete.raw('text967549497036')
                          : tI18nComplete.raw('text1fc9a387654d'),
                      }
                    : undefined
                }
              />
              <div role="rowgroup">
                {sorted.map((member) => {
                  const isSelf = member.user_id === currentUserId;
                  const isLastOwner = member.account_role === 'owner' && ownerCount === 1;
                  const label = principalLabel(member);

                  const kebab: KebabItem[] = [];
                  if (canUpdateRole && !isSelf) {
                    kebab.push({
                      label: tI18nComplete.raw('texta514a684676a'),
                      icon: <PencilSimple className="size-3.5" />,
                      onSelect: () =>
                        roleEditor.openEdit({
                          userId: member.user_id,
                          label,
                          accountRole: member.account_role,
                        }),
                    });
                  }
                  if (canReadMembers || isSelf) {
                    kebab.push({
                      label: tI18nComplete.raw('textf5462009cf42'),
                      icon: <KeyRound className="size-3.5" />,
                      onSelect: () => onSelectMember(member.user_id),
                    });
                  }
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

                  const checked = selectedIds.has(member.user_id);
                  return (
                    <MemberTableRow
                      key={member.user_id}
                      selected={checked}
                      pending={pendingUserIds.has(member.user_id)}
                      onOpen={() => onSelectMember(member.user_id)}
                      select={
                        // Self rows can't be bulk-acted on — an admin could
                        // demote or remove themselves in a sweep. The gutter
                        // stays so every avatar lines up.
                        canBulk && !isSelf
                          ? {
                              visible: selecting,
                              checked,
                              onCheckedChange: () => toggleOne(member.user_id),
                              label: tI18nComplete('textb4b262ae0516', { value0: label }),
                            }
                          : undefined
                      }
                      avatar={<UserAvatar email={member.email ?? member.user_id} size="sm" />}
                      name={memberHandle(member.email, label)}
                      email={label}
                      tags={
                        <>
                          {isSelf ? (
                            <span className="text-muted-foreground text-xs">
                              {tI18nComplete.raw('text08b041935798')}
                            </span>
                          ) : null}
                          {!member.has_verified_mfa &&
                          account.mfa_required &&
                          !member.is_super_admin ? (
                            // Account requires MFA and this member has no
                            // verified factor — blocked from gated actions
                            // until they enrol. Super-admins are exempt.
                            <Hint label={tI18nComplete.raw('text0bd9da305fb1')}>
                              <span className="text-destructive text-xs">
                                {tI18nComplete.raw('textfdeee365fcf3')}
                              </span>
                            </Hint>
                          ) : null}
                        </>
                      }
                      role={shortRoleLabel(roleValueFor(member))}
                      roleTone={roleTone(roleValueFor(member))}
                      kebab={kebab}
                      kebabLabel={tI18nComplete('text33da220b1a34', { value0: label })}
                    />
                  );
                })}
                {showInvites ? (
                  <PendingInvitesSection
                    accountId={account.account_id}
                    canManage={canInvite}
                    search={search}
                  />
                ) : null}
              </div>
            </div>
          )}

          {members.length > 0 && sorted.length === 0 && roleFilter !== 'invited' ? (
            <p className="text-muted-foreground px-3 py-6 text-center text-xs">
              {tI18nComplete.raw('text4caa18882dc4')}
              {search.trim()}”.
            </p>
          ) : null}
        </>
      ) : null}

      {roleEditor.dialog}

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
        description={tI18nComplete('text586a24125900', {
          count: selectedCount,
          account: account.name,
        })}
        confirmLabel={tI18nComplete('text3028bf7d2dec', { value0: selectedCount })}
        confirmVariant="destructive"
        isPending={bulkBusy}
        onConfirm={() =>
          bulkRun(tI18nComplete.raw('text4118fb4fed0e'), (uid) =>
            removeAccountMember(account.account_id, uid),
          )
        }
      />
    </div>
  );
}

// ============================== MEMBER TABLE ==============================

/**
 * Linear's team members table: flat rows, no borders, a full-width fill on
 * hover. One grid so every row lines up: select gutter · name · email · role ·
 * actions. The gutter sits OUTSIDE the content edge (the table pulls left by
 * its width), so avatars align with the toolbar above. Below `sm` the email
 * column drops.
 */
const MEMBER_GRID =
  'grid grid-cols-[1.75rem_minmax(0,1fr)_minmax(0,9rem)_2rem] items-center pr-1 sm:grid-cols-[1.75rem_minmax(0,1fr)_minmax(0,18rem)_11rem_2rem]';

/** The name cell's handle: the email's local part, else the label. */
function memberHandle(email: string | null | undefined, fallback: string): string {
  return email?.split('@')[0] || fallback;
}

interface MemberSelect {
  /** Any row is selected: show every checkbox, not just the hovered one. */
  visible: boolean;
  checked: boolean | 'indeterminate';
  onCheckedChange: () => void;
  label: string;
}

function SelectCell({ select }: { select?: MemberSelect }) {
  return (
    <span role="cell" className="relative z-10 flex items-center justify-center">
      {select ? (
        <Checkbox
          checked={select.checked}
          onCheckedChange={select.onCheckedChange}
          onClick={(event) => event.stopPropagation()}
          aria-label={select.label}
          className={cn(
            // A 32px hit area: the pseudo-element takes the clicks.
            "relative after:absolute after:-inset-2 after:content-['']",
            !select.visible &&
              'opacity-0 group-hover/member:opacity-100 focus-visible:opacity-100',
          )}
        />
      ) : null}
    </span>
  );
}

function MemberTableHead({ select }: { select?: MemberSelect }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const head = 'text-muted-foreground truncate text-xs font-medium';
  return (
    <div role="row" className={cn(MEMBER_GRID, 'group/member h-9 px-2')}>
      <SelectCell select={select} />
      <span role="columnheader" aria-sort="ascending" className={cn(head, 'flex items-center gap-1')}>
        {tI18nComplete.raw('textdcd1d5223f73')}
      </span>
      <span role="columnheader" className={cn(head, 'max-sm:hidden')}>
        {tI18nComplete.raw('text969ccbd3cf63')}
      </span>
      <span role="columnheader" className={head}>
        {tI18nComplete.raw('text14736a2eb9f4')}
      </span>
      <span aria-hidden />
    </div>
  );
}

function MemberTableRow({
  select,
  selected = false,
  pending = false,
  invited = false,
  onOpen,
  avatar,
  name,
  email,
  tags,
  role,
  roleTone: tone = 'muted',
  kebab,
  kebabLabel,
}: {
  select?: MemberSelect;
  selected?: boolean;
  pending?: boolean;
  /** A pending invite: muted name. */
  invited?: boolean;
  /** Row click: opens the member's access panel. */
  onOpen?: () => void;
  avatar: ReactNode;
  name: string;
  email: string;
  tags?: ReactNode;
  role: ReactNode;
  /** Badge variant by the role's rank (`roleTone`). */
  roleTone?: RoleTone;
  kebab?: KebabItem[];
  kebabLabel: string;
}) {
  return (
    <div
      role="row"
      aria-selected={select ? selected : undefined}
      className={cn(
        MEMBER_GRID,
        'group/member relative h-11 rounded-lg px-2',
        selected ? 'bg-active' : 'hover:bg-hover',
      )}
    >
      {onOpen ? (
        // The whole row opens the member; checkbox and kebab sit above it.
        <button
          type="button"
          aria-label={email}
          onClick={onOpen}
          className="focus-visible:ring-ring absolute inset-0 rounded-[inherit] outline-none focus-visible:ring-1"
        />
      ) : null}
      <SelectCell select={select} />
      <span role="cell" className="flex min-w-0 items-center gap-3">
        {avatar}
        <span
          className={cn(
            'min-w-0 truncate text-sm',
            invited ? 'text-muted-foreground' : 'text-foreground',
          )}
        >
          {name}
        </span>
        {tags ? <span className="relative z-10 flex shrink-0 items-center gap-1.5">{tags}</span> : null}
      </span>
      <span role="cell" className="text-muted-foreground truncate pr-4 text-sm max-sm:hidden">
        {email}
      </span>
      <span role="cell" className="flex min-w-0">
        {/* The role as a neutral `Badge` tag in sans, the same recipe as the
            Roles pane's Built-in / Custom tags. */}
        <Badge variant={tone} className="max-w-full truncate">
          {role}
        </Badge>
      </span>
      <span role="cell" className="relative z-10 flex justify-end">
        {pending ? (
          <Loading className="size-3.5 shrink-0" />
        ) : kebab && kebab.length > 0 ? (
          <MemberKebab items={kebab} label={kebabLabel} />
        ) : null}
      </span>
    </div>
  );
}

/** The row's actions. Hidden until the row is hovered, focused or open. */
function MemberKebab({ items, label }: { items: KebabItem[]; label: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={label}
          className="text-muted-foreground hover:text-foreground data-[state=open]:text-foreground opacity-0 group-hover/member:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
        >
          <DotsThree className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {items.map((item, index) => (
          <div key={item.label}>
            {item.separated && index > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem
              variant={item.variant}
              disabled={item.disabled}
              onSelect={item.onSelect}
              className="gap-2"
            >
              {item.icon}
              {item.label}
            </DropdownMenuItem>
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
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
          actions: [
            {
              label: tI18nComplete.raw('text9adff6870471'),
              onClick: () =>
                copyInviteLink(
                  res.invite_url,
                  tI18nComplete.raw('text0dc2f4c75de6'),
                  tI18nComplete.raw('textfa6453683837'),
                ),
            },
          ],
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
      <>
        {invites.map((invite) => (
          <MemberTableRow
            key={invite.invite_id}
            invited
            // Invites are not bulk-selectable; the gutter keeps them aligned.
            avatar={
              <span
                aria-hidden
                className="text-muted-foreground flex size-6 shrink-0 items-center justify-center rounded-full border border-dashed text-xs"
              >
                {invite.email.charAt(0).toUpperCase()}
              </span>
            }
            name={memberHandle(invite.email, invite.email)}
            email={invite.email}
            // Linear's "Admin (Invited)": the role the invite carries, marked.
            role={`${tI18nComplete.raw(ACCOUNT_ROLE_KEY[invite.initial_role] ?? ACCOUNT_ROLE_KEY.member)} (${tI18nComplete.raw('text63b17becd812')})`}
            roleTone="muted"
            tags={
              <Hint label={`${tI18nComplete.raw('text2a91147eb974')} ${formatDate(invite.expires_at)}`}>
                <ClockIcon aria-label={tI18nComplete.raw('text2a91147eb974')} className="text-muted-foreground size-3.5" />
              </Hint>
            }
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
      </>

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
