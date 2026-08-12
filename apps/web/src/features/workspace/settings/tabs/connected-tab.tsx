'use client';

import { GitHubAppSetupCard } from '@/components/iam/github-app-setup-card';
import {
  ChatGptAuthChallenge,
  CODEX_AUTH_JSON_SECRET_NAME,
  useChatGptConnectFlow,
  useChatGptSubscriptionConnected,
} from '@/components/projects/chatgpt-subscription-connect';
import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import Loading from '@/components/ui/loading';
import { SettingsRow, SettingsRowGroup } from '@/components/ui/settings-row';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import { Github } from '@/features/icon/icons/github';
import { OpenAI } from '@/features/icon/icons/open-ai';
import { providerDisconnectPlan } from '@/features/workspace/customize/sections/llm-provider/utils';
import {
  githubInstallationLabel,
  isGitHubAppInstallationId,
  rememberGitHubSetupReturn,
} from '@/lib/github-installations';
import { usePermission } from '@/lib/use-permission';
import {
  deleteGitHubInstallation,
  deleteProjectProviderOAuth,
  deleteProjectSecret,
  listGitHubInstallations,
} from '@kortix/sdk';
import { qk, refreshProjectProviderState } from '@kortix/sdk/react';
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

  chatgptStatus?: ProviderRowStatus;
  /**
   * The device-code step only — `ChatGptAuthChallenge`, not the whole
   * `ChatGptSubscriptionConnect` card.
   *
   * This row used to render that entire card here, which brought its own
   * border, logo, title, description and footer. Beside a row already labelled
   * "ChatGPT" it said the same thing twice inside a box inside a box. The row
   * owns the label and the button now; the slot carries only what the row
   * cannot render itself — the code you copy and the link that opens OpenAI.
   */
  chatgptChallengeSlot?: ReactNode;
  onConnectChatGpt?: () => void;
  onCancelChatGpt?: () => void;
  onDisconnectChatGpt?: () => void;
  isChatGptActionPending?: boolean;
  /** Authorization in flight — the row offers Cancel instead of Connect. */
  isChatGptWaiting?: boolean;
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
  chatgptStatus = 'disconnected',
  chatgptChallengeSlot,
  onConnectChatGpt = () => {},
  onCancelChatGpt = () => {},
  onDisconnectChatGpt = () => {},
  isChatGptActionPending = false,
  isChatGptWaiting = false,
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

  // Same reasoning as `githubDescription` above — see that comment.
  const chatgptDescription =
    chatgptStatus === 'loading'
      ? 'Checking this workspace for a connected ChatGPT subscription.'
      : chatgptStatus === 'connected'
        ? 'ChatGPT Plus/Pro connected for this workspace.'
        : chatgptStatus === 'unavailable'
          ? 'Open a project to connect a ChatGPT subscription for this workspace.'
          : 'Sign in with a ChatGPT Plus or Pro subscription for this workspace.';

  // One control at a time, and always the one the current state calls for:
  // Cancel while authorizing, Disconnect once connected, Connect otherwise.
  const chatgptAction =
    chatgptStatus === 'loading' ? (
      <ActionSkeleton />
    ) : isChatGptWaiting ? (
      <Button type="button" variant="secondary" size="sm" onClick={onCancelChatGpt}>
        Cancel
      </Button>
    ) : chatgptStatus === 'connected' ? (
      <Button
        type="button"
        variant="destructive"
        size="sm"
        onClick={onDisconnectChatGpt}
        disabled={isChatGptActionPending}
      >
        {isChatGptActionPending ? <Loading className="size-3.5 shrink-0" /> : null}
        Disconnect
      </Button>
    ) : (
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={onConnectChatGpt}
        disabled={chatgptStatus === 'unavailable'}
      >
        <OpenAI /> Connect
      </Button>
    );

  return (
    <div className="mx-auto w-full max-w-2xl space-y-8">
      <SettingsTabHeader tab="connected" />

      {/* Managed GitHub — the instance's git backend — leads the pane, and the
          pane then descends by scope: instance → account (the GitHub row,
          "shared by every project") → workspace (ChatGPT, "for this
          workspace"). That is the same descending scope the row descriptions
          already state, and it puts the prerequisite above the things it
          unblocks: without a managed-git connection no project gets a
          repository at all.

          It does NOT sit between the GitHub and ChatGPT rows, which is where
          `accounts/[id]/page.tsx:579-583` put it relative to the account-level
          `GitHubConnectionCard` this row replaced. That order cannot be
          transplanted. The card is a titled section with its own bordered
          panel; the rows are one `SettingsRowGroup`, a single bordered box
          whose rows share hairlines. Landing the card between them splits the
          group in two, orphans ChatGPT under a tall operator section, and
          turns the provider list back into the stack of cards
          `settings-row.tsx` exists to prevent. Leading the pane keeps the two
          GitHub surfaces adjacent — which the old order also achieved — without
          paying that cost. */}
      {canManageAccount ? githubAppSetupSlot : null}

      <SettingsRowGroup>
        {canManageAccount && (
          <section className="space-y-3">
            <SettingsRow label="GitHub" description={githubDescription}>
              {githubAction}
            </SettingsRow>
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
        )}

        <section className="space-y-3">
          <SettingsRow label="ChatGPT" description={chatgptDescription}>
            {chatgptAction}
          </SettingsRow>
          {/* Only while authorizing, and only the code + auth link — the row
              above already carries the name, the explanation, and the button. */}
          {chatgptChallengeSlot ? <div className="px-4 pb-3">{chatgptChallengeSlot}</div> : null}
        </section>
      </SettingsRowGroup>
    </div>
  );
}

/** Container: owns every hook (React Query, permission probe, router) and
 *  renders `ConnectedAccountsTabView` with real data + handlers. Only ever
 *  mounted while this tab is active (`SettingsTabPane` in
 *  `settings-panel.tsx` returns `null` otherwise), so nothing here fetches
 *  on panel open unless the user actually lands on this tab. */
export function ConnectedAccountsTab({
  projectId,
  accountId,
}: {
  projectId?: string;
  accountId?: string;
}) {
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

  // --- ChatGPT (project-scoped) ------------------------------------------
  const { connected: chatgptConnected, isLoading: chatgptLoading } =
    useChatGptSubscriptionConnected(projectId ?? '', !!projectId);

  // The flow, not the card: this tab renders its own label, description and
  // button, and needs only the device-code step from the shared component.
  const chatgptFlow = useChatGptConnectFlow({ projectId: projectId ?? '' });

  const chatgptStatus: ProviderRowStatus = !projectId
    ? 'unavailable'
    : chatgptLoading
      ? 'loading'
      : chatgptConnected
        ? 'connected'
        : 'disconnected';

  const disconnectChatGptMutation = useMutation({
    mutationFn: async () => {
      const plan = providerDisconnectPlan({ id: 'codex', envVars: [CODEX_AUTH_JSON_SECRET_NAME] });
      await Promise.all([
        ...(plan.oauthProvider ? [deleteProjectProviderOAuth(projectId!, plan.oauthProvider)] : []),
        ...plan.secretNames.map((name) => deleteProjectSecret(projectId!, name)),
      ]);
    },
    onSuccess: () => {
      successToast('ChatGPT disconnected');
      queryClient.invalidateQueries({ queryKey: qk.project.secrets(projectId!) });
      refreshProjectProviderState(queryClient, projectId!);
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to disconnect ChatGPT'),
  });

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
      chatgptStatus={chatgptStatus}
      chatgptChallengeSlot={
        chatgptFlow.isWaiting ? <ChatGptAuthChallenge flow={chatgptFlow} bare /> : undefined
      }
      onConnectChatGpt={chatgptFlow.connect}
      onCancelChatGpt={chatgptFlow.cancel}
      isChatGptWaiting={chatgptFlow.isWaiting}
      onDisconnectChatGpt={() => disconnectChatGptMutation.mutate()}
      isChatGptActionPending={disconnectChatGptMutation.isPending}
    />
  );
}
