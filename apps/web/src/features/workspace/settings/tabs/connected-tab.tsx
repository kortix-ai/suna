'use client';

import { localizedCopy } from './localized-copy';

import { Button } from '@kortix/ui/button';
import { InfoBanner } from '@kortix/ui/info-banner';
import Loading from '@kortix/ui/loading';
import { SettingsRow, SettingsRowGroup } from '@kortix/ui/settings-row';
import { Skeleton } from '@kortix/ui/skeleton';
import { errorToast, successToast } from '@kortix/ui/toast';
import { HubLink } from '@kortix/ui/internal/account-hub/account-hub-location';
import { Github } from '@kortix/ui/internal/icons/github';
import { useTranslations } from '@/i18n/use-translations';
import { githubInstallationLabel, rememberGitHubSetupReturn } from '@kortix/ui/internal/lib/github-installations';
import { usePermission } from '@kortix/ui/workspace';
import { hubTarget, type HubTarget } from '@kortix/ui/internal/stores/account-panel-store';
import { deleteGitHubInstallation, listGitHubInstallations } from '@kortix/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { SettingsTabHeader } from '@kortix/ui/customize/settings/settings-tab-header';
import { useSettingsAccountId } from '../use-settings-account-id';

export type ProviderRowStatus = 'loading' | 'connected' | 'disconnected' | 'error' | 'unavailable';

export interface ConnectedAccountsTabViewProps {
  canManageAccount?: boolean;

  githubStatus?: ProviderRowStatus;
  githubInstallationName?: string | null;
  githubError?: string | null;
  onConnectGitHub?: () => void;
  onDisconnectGitHub?: () => void;
  isGitHubActionPending?: boolean;
  githubOtherInstallationsCount?: number;
  /** The account hub's Git pane — a modal target, not a URL: the hub has no
   *  route (`stores/account-panel-store.ts`). */
  githubManageAllTo?: HubTarget;
  copy?: ConnectedAccountsTabCopy;
}

export interface ConnectedAccountsTabCopy {
  checking: string;
  connectedAs: (name: string) => string;
  unavailable: string;
  install: string;
  disconnect: string;
  connect: string;
  github: string;
  moreInstallations: (count: number) => string;
  adminOnly: string;
  disconnectedToast: string;
  disconnectFailed: string;
}

const DEFAULT_CONNECTED_ACCOUNTS_COPY: ConnectedAccountsTabCopy = {
  checking: 'Checking this account for a GitHub App installation.',
  connectedAs: (name) =>
    `Connected as ${name} — installed for this account, shared by every project.`,
  unavailable: 'GitHub status unavailable for this account.',
  install: 'Install the GitHub App for this account so every project can import its repositories.',
  disconnect: 'Disconnect',
  connect: 'Connect',
  github: 'GitHub',
  moreInstallations: (count) =>
    `+${count} more installation${count === 1 ? '' : 's'} on this account — manage all`,
  adminOnly: 'Only an account owner or admin can connect GitHub for this account.',
  disconnectedToast: 'GitHub disconnected',
  disconnectFailed: 'Failed to disconnect GitHub',
};

function ActionSkeleton() {
  return <Skeleton className="h-8 w-24 rounded-md" />;
}

export function ConnectedAccountsTabView({
  canManageAccount = true,
  githubStatus = 'disconnected',
  githubInstallationName = null,
  githubError = null,
  onConnectGitHub = () => {},
  onDisconnectGitHub = () => {},
  isGitHubActionPending = false,
  githubOtherInstallationsCount = 0,
  githubManageAllTo,
  copy = DEFAULT_CONNECTED_ACCOUNTS_COPY,
}: ConnectedAccountsTabViewProps) {
  // `loading` gets its own branch rather than falling through to the
  // disconnected copy. Without it the row asserted "Install the GitHub App"
  // before the query that answers that had returned, then flipped to
  // "Connected as …" — a claim the row could not yet make, and the same
  // flash-of-wrong-state the action slot's skeleton exists to avoid.
  const githubDescription =
    githubStatus === 'loading'
      ? copy.checking
      : githubStatus === 'connected' && githubInstallationName
        ? copy.connectedAs(githubInstallationName)
        : githubStatus === 'error'
          ? copy.unavailable
          : copy.install;

  const githubAction =
    githubStatus === 'loading' ? (
      <ActionSkeleton />
    ) : githubStatus === 'connected' ? (
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={onDisconnectGitHub}
        disabled={isGitHubActionPending}
      >
        {isGitHubActionPending ? <Loading className="size-3.5 shrink-0" /> : null}
        {copy.disconnect}
      </Button>
    ) : (
      <Button type="button" variant="secondary" size="sm" onClick={onConnectGitHub}>
        <Github /> {copy.connect}
      </Button>
    );

  return (
    <div className="mx-auto w-full max-w-2xl space-y-8">
      <SettingsTabHeader tab="connected" />

      {/* No managed-git setup card here. It configures ONE instance-global
          row, and this pane is account-scoped — the same shape that let a
          platform admin reconfigure production's GitHub App from inside a
          customer's settings on 2026-09-16. It lives at `/admin/git` now. */}
      {canManageAccount ? (
        <section className="space-y-3">
          <SettingsRowGroup>
            <SettingsRow label={copy.github} description={githubDescription}>
              {githubAction}
            </SettingsRow>
          </SettingsRowGroup>
          {githubStatus === 'error' && githubError ? (
            <InfoBanner tone="warning">{githubError}</InfoBanner>
          ) : null}
          {githubStatus === 'connected' &&
          githubOtherInstallationsCount > 0 &&
          githubManageAllTo ? (
            <HubLink
              to={githubManageAllTo}
              className="text-muted-foreground hover:text-foreground text-xs underline-offset-2 hover:underline"
            >
              {copy.moreInstallations(githubOtherInstallationsCount)}
            </HubLink>
          ) : null}
        </section>
      ) : (
        /* Without `account.write` there is no row to render — GitHub is the
           only provider on this pane, and installing it writes the account. An
           empty `SettingsRowGroup` would draw a bordered box around nothing, so
           the pane says why it is empty instead. */
        <InfoBanner tone="info">{copy.adminOnly}</InfoBanner>
      )}
    </div>
  );
}

/** Container: owns every hook (React Query, permission probe, router) and
 *  renders `ConnectedAccountsTabView` with real data + handlers. Only ever
 *  mounted while this tab is active (`SettingsTabPane` in
 *  `settings-panel.tsx` returns `null` otherwise), so nothing here fetches
 *  on panel open unless the user actually lands on this tab. */
export function ConnectedAccountsTab({ accountId }: { accountId?: string }) {
  const t = useTranslations('settings.connected');
  const copy = localizedCopy(DEFAULT_CONNECTED_ACCOUNTS_COPY, t);
  const router = useRouter();
  const queryClient = useQueryClient();

  // --- GitHub (account-scoped) ------------------------------------------
  // `accountId` (the project's owning account, when a project is open) wins;
  // the store-selected account (project-independent, see
  // `useSettingsAccountId`'s doc comment) is the fallback so this row still
  // resolves with no project open — same account-scoped shape
  // `profile`/`preferences` already have, now also true for the row that
  // actually needs an account id.
  const resolvedAccountId = useSettingsAccountId(accountId);
  const { allowed: canManageAccount } = usePermission(resolvedAccountId, 'account.write');

  const installationsQuery = useQuery({
    queryKey: ['github-installations', resolvedAccountId],
    queryFn: () => listGitHubInstallations(resolvedAccountId!),
    enabled: canManageAccount && !!resolvedAccountId,
    staleTime: 0,
  });

  // Account connections only — `GET /projects/github/installations` no longer
  // injects the instance git backend as a synthetic entry, so there is nothing
  // to filter out of this list.
  const installations = installationsQuery.data?.installations ?? [];
  const primaryInstallation = installations[0];
  const otherInstallationsCount = Math.max(0, installations.length - 1);

  const githubStatus: ProviderRowStatus = installationsQuery.isLoading
    ? 'loading'
    : installationsQuery.isError
      ? 'error'
      : primaryInstallation
        ? 'connected'
        : 'disconnected';

  const disconnectGitHubMutation = useMutation({
    mutationFn: (installationId: string) =>
      deleteGitHubInstallation(resolvedAccountId!, installationId),
    onSuccess: () => {
      successToast(copy.disconnectedToast);
      queryClient.invalidateQueries({ queryKey: ['github-installations', resolvedAccountId] });
      queryClient.invalidateQueries({ queryKey: ['github-repositories', resolvedAccountId] });
    },
    onError: (err: Error) => errorToast(err.message || copy.disconnectFailed),
  });

  const handleConnectGitHub = () => {
    if (!resolvedAccountId) return;
    rememberGitHubSetupReturn(
      typeof window !== 'undefined'
        ? window.location.pathname + window.location.search
        : '/projects',
    );
    router.push(`/github/setup?account_id=${encodeURIComponent(resolvedAccountId)}`);
  };

  const handleDisconnectGitHub = () => {
    if (primaryInstallation?.installation_id) {
      disconnectGitHubMutation.mutate(primaryInstallation.installation_id);
    }
  };

  return (
    <ConnectedAccountsTabView
      copy={copy}
      canManageAccount={canManageAccount}
      githubStatus={githubStatus}
      githubInstallationName={
        primaryInstallation ? githubInstallationLabel(primaryInstallation.owner_login) : null
      }
      githubError={
        installationsQuery.error instanceof Error ? installationsQuery.error.message : null
      }
      onConnectGitHub={handleConnectGitHub}
      onDisconnectGitHub={handleDisconnectGitHub}
      isGitHubActionPending={disconnectGitHubMutation.isPending}
      githubOtherInstallationsCount={otherInstallationsCount}
      githubManageAllTo={
        resolvedAccountId ? hubTarget(resolvedAccountId, { tab: 'git' }) : undefined
      }
    />
  );
}
