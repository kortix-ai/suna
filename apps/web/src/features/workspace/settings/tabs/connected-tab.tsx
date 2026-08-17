'use client';

/**
 * Connected accounts — the identities this ACCOUNT is linked to. One provider
 * today: the GitHub App.
 *
 * **The ChatGPT row is gone (Jay, 2026-08-17):** "this just doesn't make any
 * sense right because this is on a project level anyhow. i don't really get
 * what this is supposed to be." He is right, and the row's own code said so —
 * it was commented `// --- ChatGPT (project-scoped) ---`, it read
 * `useChatGptSubscriptionConnected(projectId, …)`, and it reported
 * `'unavailable'` whenever no project was open, which is the common case: this
 * dialog opens from Cmd+, and from the workspace switcher, neither of which
 * implies a project. A pane whose header says "for this account" is the wrong
 * place to configure one workspace, and a disabled Connect button is a poor way
 * to say so.
 *
 * **Where ChatGPT connect actually lives, and did before this deletion:** the
 * project sidebar's "Connect GPT subscription" row
 * (`project-sidebar/footer/project-chatgpt-connect-nav.tsx`, mounted at
 * `project-sidebar.tsx:245`). It is not a link — it opens
 * `ChatGptSubscriptionConnectDialog`, the complete device-code flow
 * (`components/projects/chatgpt-subscription-connect.tsx:424`), scoped to the
 * project whose sidebar it is in. Two further project-scoped surfaces host the
 * same connect card: Models → Providers (`ProviderConnect` →
 * `llm-api-keys-tab.tsx:97`) and `ProjectProviderModal`
 * (`llm-provider-modal.tsx:136`). So the row deleted here was the fourth copy
 * of a flow that already had a correct home — nothing about CONNECTING was
 * lost.
 *
 * **One capability WAS lost, deliberately, and it is not connect:** this row
 * held the only Disconnect in the product for a ChatGPT subscription
 * (`providerDisconnectPlan({ id: 'codex', … })` → `deleteProjectProviderOAuth`
 * + `deleteProjectSecret`). The sidebar row cannot carry it —
 * `useShowChatGptConnectPrompt` hides that row once connected — and the
 * provider list has no `codex` row to remove, because `codex` is synthetic
 * (`use-connected-providers.ts:113`) while rows come from the static
 * `LLM_PROVIDERS` catalog. Removing the OpenAI key does NOT disconnect it
 * either: `providerDisconnectPlan` filters `CODEX_AUTH_JSON` out by hand
 * (`llm-provider/utils.ts:17`). Its home is project-scoped and it should be
 * rebuilt there — the natural place is the same sidebar row, ungated so it
 * reads "Disconnect GPT subscription" once connected, or a `codex` row in
 * `ProviderConnect`. Do NOT re-add it to this account-scoped pane.
 */

import { GitHubAppSetupCard } from '@/components/iam/github-app-setup-card';
import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import Loading from '@/components/ui/loading';
import { SettingsRow, SettingsRowGroup } from '@/components/ui/settings-row';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import { Github } from '@/features/icon/icons/github';
import {
  githubInstallationLabel,
  isGitHubAppInstallationId,
  rememberGitHubSetupReturn,
} from '@/lib/github-installations';
import { usePermission } from '@/lib/use-permission';
import { deleteGitHubInstallation, listGitHubInstallations } from '@kortix/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { SettingsTabHeader } from '../settings-tab-header';
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
  githubManageAllHref?: string;
  githubAppSetupSlot?: ReactNode;
}

/**
 * The action slot's own loading state — a skeleton shaped like the `size="sm"`
 * button that replaces it (`h-8`, `rounded-md`), so the row never changes
 * height when the provider's status resolves.
 *
 * Replaces a full-width `h-14` skeleton that sat BELOW the row while the
 * action slot rendered nothing. That read as a phantom second row appearing
 * and then vanishing — the row itself looked finished (label, description, no
 * control) with an unexplained grey block under it (Jay, 2026-08-12).
 *
 * A skeleton rather than a disabled button: while the status query is in
 * flight we do not yet know whether this row offers "Connect" or "Disconnect",
 * so any real button would have to show a label that flips once the query
 * lands. The skeleton claims the space without claiming the answer. `Loading`
 * is for an action the user started; this is a placeholder for content that
 * has not arrived, which is `Skeleton`'s job per the design system.
 */
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
  githubManageAllHref,
  githubAppSetupSlot,
}: ConnectedAccountsTabViewProps) {
  // `loading` gets its own branch rather than falling through to the
  // disconnected copy. Without it the row asserted "Install the GitHub App"
  // before the query that answers that had returned, then flipped to
  // "Connected as …" — a claim the row could not yet make, and the same
  // flash-of-wrong-state the action slot's skeleton exists to avoid.
  const githubDescription =
    githubStatus === 'loading'
      ? 'Checking this account for a GitHub App installation.'
      : githubStatus === 'connected' && githubInstallationName
        ? `Connected as ${githubInstallationName} — installed for this account, shared by every project.`
        : githubStatus === 'error'
          ? 'GitHub status unavailable for this account.'
          : 'Install the GitHub App for this account so every project can import its repositories.';

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
        Disconnect
      </Button>
    ) : (
      <Button type="button" variant="secondary" size="sm" onClick={onConnectGitHub}>
        <Github /> Connect
      </Button>
    );

  return (
    <div className="mx-auto w-full max-w-2xl space-y-8">
      <SettingsTabHeader tab="connected" />

      {/* Managed GitHub — the instance's git backend — leads the pane, above
          the account-level row it unblocks: without a managed-git connection no
          project gets a repository at all.

          It does NOT sit below the row, which is where
          `accounts/[id]/page.tsx:579-583` put it relative to the account-level
          `GitHubConnectionCard` this row replaced. That order cannot be
          transplanted. The card is a titled section with its own bordered
          panel; the row lives in a `SettingsRowGroup`, a bordered box whose
          rows share hairlines. Leading the pane keeps the two GitHub surfaces
          adjacent and ordered widest-scope-first — instance, then account. */}
      {canManageAccount ? githubAppSetupSlot : null}

      {canManageAccount ? (
        <section className="space-y-3">
          <SettingsRowGroup>
            <SettingsRow label="GitHub" description={githubDescription}>
              {githubAction}
            </SettingsRow>
          </SettingsRowGroup>
          {githubStatus === 'error' && githubError ? (
            <InfoBanner tone="warning">{githubError}</InfoBanner>
          ) : null}
          {githubStatus === 'connected' &&
          githubOtherInstallationsCount > 0 &&
          githubManageAllHref ? (
            <a
              href={githubManageAllHref}
              className="text-muted-foreground hover:text-foreground text-xs underline-offset-2 hover:underline"
            >
              +{githubOtherInstallationsCount} more installation
              {githubOtherInstallationsCount === 1 ? '' : 's'} on this account — manage all
            </a>
          ) : null}
        </section>
      ) : (
        /* Without `account.write` there is no row to render — GitHub is the
           only provider on this pane, and installing it writes the account. An
           empty `SettingsRowGroup` would draw a bordered box around nothing, so
           the pane says why it is empty instead. */
        <InfoBanner tone="info">
          Only an account owner or admin can connect GitHub for this account.
        </InfoBanner>
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

  const installations = (installationsQuery.data?.installations ?? []).filter((installation) =>
    isGitHubAppInstallationId(installation.installation_id),
  );
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
      successToast('GitHub disconnected');
      queryClient.invalidateQueries({ queryKey: ['github-installations', resolvedAccountId] });
      queryClient.invalidateQueries({ queryKey: ['github-repositories', resolvedAccountId] });
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to disconnect GitHub'),
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
      canManageAccount={canManageAccount}
      githubStatus={githubStatus}
      githubInstallationName={
        primaryInstallation
          ? githubInstallationLabel(
              primaryInstallation.installation_id,
              primaryInstallation.owner_login,
            )
          : null
      }
      githubError={
        installationsQuery.error instanceof Error ? installationsQuery.error.message : null
      }
      onConnectGitHub={handleConnectGitHub}
      onDisconnectGitHub={handleDisconnectGitHub}
      isGitHubActionPending={disconnectGitHubMutation.isPending}
      githubOtherInstallationsCount={otherInstallationsCount}
      githubManageAllHref={resolvedAccountId ? `/accounts/${resolvedAccountId}?tab=git` : undefined}
      githubAppSetupSlot={
        canManageAccount ? <GitHubAppSetupCard canManage={canManageAccount} /> : undefined
      }
    />
  );
}
