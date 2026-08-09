'use client';

/**
 * The Connected accounts tab — three rows, one action button each: GitHub,
 * ChatGPT, Claude Code. No modal, no accordion, no search (see the task
 * brief).
 *
 * **This tab's name and group both lie about scope, and that is the whole
 * design problem here.** It sits in the "You" group beside Profile and
 * Preferences, both genuinely user-scoped. None of these three providers is:
 *
 * - GitHub is ACCOUNT-scoped (`listGitHubInstallations(accountId)` /
 *   `deleteGitHubInstallation(accountId, installationId)`, gated on
 *   `account.write`). Disconnecting it removes the installation every
 *   project under the account depends on, not a personal login.
 * - ChatGPT is PROJECT-scoped (`startProjectProviderOAuth(projectId,
 *   'openai')`). Every member of the current project shares it.
 * - Claude Code would be PROJECT-scoped the same way, if it existed — see
 *   below.
 *
 * This was raised three times against the product owner with no answer, so
 * it ships as specified. The one non-negotiable mitigation: **every row's
 * description states its scope in plain words** — "for this account" on
 * GitHub, "for this workspace" on the two project-scoped rows — so a click
 * on Disconnect is an informed one. See `connected-tab.test.tsx`'s "every
 * row states which scope it writes to".
 *
 * **Claude Code has no real connect flow.** Checked directly: `apps/web/src/
 * features/marketing/faq/content.ts`'s accuracy gate states plainly "There is
 * NO Cursor auth path and no Claude-subscription auth path anywhere in the
 * codebase" (dated 2026-07-31, re-verified for this task by grepping for
 * `claude`/`anthropic` + `oauth`/`subscription` across `packages/sdk/src` and
 * `apps/web/src` — nothing). Inventing one here would be a Connect button
 * that silently does nothing, which is worse than not having the row — the
 * same principle the Profile tab's Delete button was held to. The row
 * renders with an honest disabled button instead.
 *
 * **Reuse, not reinvention:**
 * - GitHub: `apps/web/src/app/(app)/accounts/[id]/page.tsx`'s
 *   `GitHubConnectionCard` (still live, not actually deleted — the brief's
 *   "recover it from history" premise didn't hold) is the source for the
 *   query/mutation/navigation shape. It is NOT reused wholesale: that card
 *   lists every installation with a "Configure" link, a permissions badge,
 *   and a confirm dialog — none of which fits this tab's one-row-one-button
 *   contract or its "no modal" constraint. This file reuses its exported
 *   helpers (`isGitHubAppInstallationId`, `githubInstallationLabel` from
 *   `lib/github-installations.ts`) and adds one more
 *   (`rememberGitHubSetupReturn`, newly exported from that same file — see
 *   its doc comment) rather than inlining a third copy.
 * - ChatGPT: reuses `useChatGptSubscriptionConnected` (the exact
 *   "is a subscription connected right now" query this row needs) and the
 *   `ChatGptSubscriptionConnect` widget, both already exported from
 *   `@/components/projects/chatgpt-subscription-connect.tsx`. The task brief
 *   pointed at the OTHER `ChatGptSubscriptionConnect` (`features/workspace/
 *   customize/sections/llm-provider/chatgpt-subscription-connect.tsx`) — that
 *   copy has no persisted-connection query, only the ephemeral in-session
 *   OAuth phase state, so it can't answer "is this already connected" on
 *   its own. `components/projects/chatgpt-subscription-connect.tsx` is the
 *   newer, actively-consumed copy (`project-chatgpt-connect-nav.tsx`) and
 *   already exports exactly the hook this row needs — reusing it beats
 *   writing a third secrets-query, so this file deliberately uses that path
 *   instead of the one literally named in the brief. Disconnecting reuses
 *   `providerDisconnectPlan` from `features/workspace/customize/sections/
 *   llm-provider/utils.ts` (the same plan `ConnectedTab` there uses) rather
 *   than re-deriving which secret names a "codex" disconnect must delete.
 *
 * `ConnectedAccountsTabView` is the pure, props-only half — every prop is
 * optional with a safe default, so it renders under `renderToStaticMarkup`
 * with no `QueryClientProvider`, router, or auth session (see `ProfileTabView`
 * / `PreferencesTabView` for the same split — see `connected-tab.test.tsx`).
 * `ConnectedAccountsTab` is the container: every hook only runs once this tab
 * is actually mounted, which `SettingsTabPane` in `settings-panel.tsx`
 * guarantees happens only while this tab is active.
 *
 * **Untestable here, by design (see the brief's constraints):** the actual
 * GitHub App install redirect, the ChatGPT device-code OAuth round trip, and
 * both disconnect mutations all require a live network + a real browser
 * round trip. `bun test` has no DOM and no live API. The tests below cover
 * everything the pure view can prove statically: row order, scope wording,
 * the account.write gate, and "one button per row" — they do not, and
 * cannot, click a button and observe a network call.
 *
 * **Fix round 1 — two Important findings, both addressed here:**
 *
 * 1. `accountId` used to come ONLY from `project?.account_id`, so opening
 *    this tab with no project selected meant `usePermission(undefined,
 *    'account.write')` never ran and the GitHub row silently vanished —
 *    even for a user who genuinely holds the permission. `profile` and
 *    `preferences` (the same "You" group) don't have this problem because
 *    neither needs an account id at all. Fixed by `resolveConnectedAccountsId`
 *    below: the project's account wins when a project is open (most
 *    specific signal), and falls back to `useCurrentAccountStore`'s
 *    `selectedAccountId` — the app-wide "currently active account", set by
 *    the account switcher / project switcher and persisted across sessions
 *    (`stores/current-account-store.ts`), independent of any project.
 *    Two alternatives considered and rejected: `useAuth()` exposes only a
 *    Supabase `user`/`session`, no account concept at all (read the file —
 *    there is nothing to read here). `useBillingAccountId()` looked
 *    promising, but `project-shell.tsx` already wraps this exact mount
 *    point (`<SettingsPanel projectId={projectId} />`) in a
 *    `BillingAccountProvider` fed the SAME `project?.account_id` — so
 *    reading it here would just re-derive the identical project-scoped
 *    value, not an independent one. `useCurrentAccountStore` is a bare
 *    Zustand store (no Provider needed) and is the one piece of state in
 *    this codebase that means "the account the user is currently working
 *    in" without requiring a project.
 * 2. `installations[0]` was the only installation this row could see or
 *    disconnect — a second App installation on the same account had no
 *    path to disconnect from this tab. Fixed by keeping the one-row/
 *    one-button contract (a second button would break "each row carries
 *    exactly one action button") and adding a plain link — not a button —
 *    to the account's full GitHub connections list
 *    (`/accounts/{accountId}?tab=git`, the still-live
 *    `GitHubConnectionCard` surface) whenever `installations.length > 1`.
 *    The row's Disconnect button still only ever targets the primary
 *    (first) installation; the link is how a user reaches the rest.
 */

import {
  ChatGptSubscriptionConnect,
  CODEX_AUTH_JSON_SECRET_NAME,
  useChatGptSubscriptionConnected,
} from '@/components/projects/chatgpt-subscription-connect';
import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import Loading from '@/components/ui/loading';
import { SettingsSectionHeader } from '@/components/ui/settings-section-header';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import { providerDisconnectPlan } from '@/features/workspace/customize/sections/llm-provider/utils';
import {
  githubInstallationLabel,
  isGitHubAppInstallationId,
  rememberGitHubSetupReturn,
} from '@/lib/github-installations';
import { usePermission } from '@/lib/use-permission';
import { useCurrentAccountStore } from '@/stores/current-account-store';
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

export type ProviderRowStatus = 'loading' | 'connected' | 'disconnected' | 'error' | 'unavailable';

/**
 * Which account the GitHub row should probe/act against. `projectAccountId`
 * (this project's owning account, when a project is open) wins when present
 * — it's the most specific signal. `selectedAccountId` (`useCurrentAccountStore`,
 * project-independent) is the fallback, so the row still resolves correctly
 * with no project open. Pure and exported so this resolution is unit-testable
 * without a QueryClientProvider, router, or auth session — see this file's
 * header comment ("Fix round 1", finding 1) and `connected-tab.test.tsx`.
 */
export function resolveConnectedAccountsId(
  projectAccountId: string | undefined,
  selectedAccountId: string | null | undefined,
): string | undefined {
  return projectAccountId ?? selectedAccountId ?? undefined;
}

export interface ConnectedAccountsTabViewProps {
  /** Whether the current user holds `account.write` on this project's
   *  account. The GitHub row is entirely absent without it — see the task
   *  brief and this file's header comment. */
  canManageAccount?: boolean;

  // GitHub — account-scoped.
  githubStatus?: ProviderRowStatus;
  githubInstallationName?: string | null;
  githubError?: string | null;
  onConnectGitHub?: () => void;
  onDisconnectGitHub?: () => void;
  isGitHubActionPending?: boolean;
  /** Count of App installations on this account beyond the one this row
   *  shows (`installations.length - 1`), or `0`/`undefined` when there's at
   *  most one. This row's Disconnect only ever targets the primary
   *  installation — when this is > 0, a link to the account's full GitHub
   *  connections list is rendered so the rest are still reachable (not a
   *  second button — see this file's header comment, finding 2). */
  githubOtherInstallationsCount?: number;
  /** Where that link points — the account settings page's GitHub
   *  connections section (`GitHubConnectionCard`), which still lists every
   *  installation. Required to render the link; the link is omitted
   *  without it even if the count is > 0. */
  githubManageAllHref?: string;

  // ChatGPT — project-scoped.
  chatgptStatus?: ProviderRowStatus;
  /** When set (and `chatgptStatus === 'disconnected'`), rendered in place of
   *  the plain "Connect" button — the real `ChatGptSubscriptionConnect`
   *  widget, which owns its own device-code OAuth flow. Left `undefined` by
   *  default so the bare view (no container, no providers) renders a plain
   *  button instead of a component that needs `useQueryClient()`. */
  chatgptConnectSlot?: ReactNode;
  onConnectChatGpt?: () => void;
  onDisconnectChatGpt?: () => void;
  isChatGptActionPending?: boolean;
}

/** Presentational only — no hooks, no data fetching, no store or Supabase
 *  read. Kept separate from `ConnectedAccountsTab` so this renders under
 *  `renderToStaticMarkup` without a `QueryClientProvider`, router, or auth
 *  session — see `ProfileTabView` for the same split. Every prop is optional
 *  with a safe default so the bare `<ConnectedAccountsTabView />` the test
 *  file renders shows every row fully formed, one action button each. */
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
  chatgptStatus = 'disconnected',
  chatgptConnectSlot,
  onConnectChatGpt = () => {},
  onDisconnectChatGpt = () => {},
  isChatGptActionPending = false,
}: ConnectedAccountsTabViewProps) {
  const githubDescription =
    githubStatus === 'connected' && githubInstallationName
      ? `Connected as ${githubInstallationName} — installed for this account, shared by every project.`
      : githubStatus === 'error'
        ? 'GitHub status unavailable for this account.'
        : 'Install the GitHub App for this account so every project can import its repositories.';

  const githubAction =
    githubStatus === 'loading' ? null : githubStatus === 'connected' ? (
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onDisconnectGitHub}
        disabled={isGitHubActionPending}
      >
        {isGitHubActionPending ? <Loading className="size-3.5 shrink-0" /> : null}
        Disconnect
      </Button>
    ) : (
      <Button type="button" variant="outline" size="sm" onClick={onConnectGitHub}>
        Connect
      </Button>
    );

  const chatgptDescription =
    chatgptStatus === 'connected'
      ? 'ChatGPT Plus/Pro connected for this workspace.'
      : chatgptStatus === 'unavailable'
        ? 'Open a project to connect a ChatGPT subscription for this workspace.'
        : 'Sign in with a ChatGPT Plus or Pro subscription for this workspace.';

  const chatgptShowsSlot = chatgptStatus === 'disconnected' && chatgptConnectSlot != null;

  const chatgptAction =
    chatgptStatus === 'loading' || chatgptShowsSlot ? null : chatgptStatus === 'connected' ? (
      <Button
        type="button"
        variant="outline"
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
        variant="outline"
        size="sm"
        onClick={onConnectChatGpt}
        disabled={chatgptStatus === 'unavailable'}
      >
        Connect
      </Button>
    );

  return (
    <div className="mx-auto w-full max-w-lg space-y-8 px-6 py-10">
      {/* 1. GitHub — account-scoped, hidden entirely without account.write. */}
      {canManageAccount ? (
        <section className="space-y-3">
          <SettingsSectionHeader title="GitHub" description={githubDescription} action={githubAction} />
          {githubStatus === 'loading' ? <Skeleton className="h-14 w-full" /> : null}
          {githubStatus === 'error' && githubError ? (
            <InfoBanner tone="warning">{githubError}</InfoBanner>
          ) : null}
          {githubStatus === 'connected' && githubOtherInstallationsCount > 0 && githubManageAllHref ? (
            <a
              href={githubManageAllHref}
              className="text-muted-foreground hover:text-foreground text-xs underline-offset-2 hover:underline"
            >
              +{githubOtherInstallationsCount} more installation
              {githubOtherInstallationsCount === 1 ? '' : 's'} on this account — manage all
            </a>
          ) : null}
        </section>
      ) : null}

      {/* 2. ChatGPT — project-scoped. */}
      <section className="space-y-3">
        <SettingsSectionHeader title="ChatGPT" description={chatgptDescription} action={chatgptAction} />
        {chatgptStatus === 'loading' ? <Skeleton className="h-14 w-full" /> : null}
        {chatgptShowsSlot ? chatgptConnectSlot : null}
      </section>

      {/* 3. Claude Code — project-scoped, no real connect flow exists in
          this codebase (see this file's header comment). Honest disabled
          state rather than a button that does nothing. */}
      <section className="space-y-3">
        <SettingsSectionHeader
          title="Claude Code"
          description="Claude Pro/Max subscription sign-in for this workspace isn't available yet — bring your own Anthropic API key from Models instead."
          action={
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled
              title="Claude subscription sign-in isn't available yet"
            >
              Not available
            </Button>
          }
        />
      </section>
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
  // `selectedAccountId` (project-independent, see `resolveConnectedAccountsId`'s
  // doc comment) is the fallback so this row still resolves with no project
  // open — same account-scoped shape `profile`/`preferences` already have,
  // now also true for the row that actually needs an account id.
  const selectedAccountId = useCurrentAccountStore((s) => s.selectedAccountId);
  const resolvedAccountId = resolveConnectedAccountsId(accountId, selectedAccountId);
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
    mutationFn: (installationId: string) => deleteGitHubInstallation(resolvedAccountId!, installationId),
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
      typeof window !== 'undefined' ? window.location.pathname + window.location.search : '/projects',
    );
    router.push(`/github/setup?account_id=${encodeURIComponent(resolvedAccountId)}`);
  };

  const handleDisconnectGitHub = () => {
    if (primaryInstallation?.installation_id) {
      disconnectGitHubMutation.mutate(primaryInstallation.installation_id);
    }
  };

  // --- ChatGPT (project-scoped) ------------------------------------------
  const { connected: chatgptConnected, isLoading: chatgptLoading } = useChatGptSubscriptionConnected(
    projectId ?? '',
    !!projectId,
  );

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
          ? githubInstallationLabel(primaryInstallation.installation_id, primaryInstallation.owner_login)
          : null
      }
      githubError={installationsQuery.error instanceof Error ? installationsQuery.error.message : null}
      onConnectGitHub={handleConnectGitHub}
      onDisconnectGitHub={handleDisconnectGitHub}
      isGitHubActionPending={disconnectGitHubMutation.isPending}
      githubOtherInstallationsCount={otherInstallationsCount}
      githubManageAllHref={resolvedAccountId ? `/accounts/${resolvedAccountId}?tab=git` : undefined}
      chatgptStatus={chatgptStatus}
      chatgptConnectSlot={
        projectId ? <ChatGptSubscriptionConnect projectId={projectId} /> : undefined
      }
      onDisconnectChatGpt={() => disconnectChatGptMutation.mutate()}
      isChatGptActionPending={disconnectChatGptMutation.isPending}
    />
  );
}
