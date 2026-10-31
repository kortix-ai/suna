'use client';

import { ChatGptDeviceChallenge } from './chatgpt-device-challenge';
import { Button } from '../../../primitives/button';
import { InfoBanner } from '../../../primitives/info-banner';
import Loading from '../../../primitives/loading';
import { errorToast, successToast } from '../../../primitives/toast';
import { ProviderLogo } from '../../../internal/lib/provider-branding';
import {
  completeClaudeSubscriptionLogin,
  deleteAccountSecretResource,
  deleteProjectProviderOAuth,
  getClaudeSubscription,
  getProjectDetail,
  listAccountSecretResources,
  listProjectProviderOAuth,
  listProjectSecrets,
  pollProjectProviderOAuth,
  startClaudeSubscriptionLogin,
  startProjectProviderOAuth,
} from '@kortix/sdk';
import { contract, qk, refreshProjectProviderState } from '@kortix/sdk/react';
import {
  CheckCircleIcon as CheckCircle2,
  WarningIcon as TriangleAlert,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from '../../../i18n';
import { useUiViewer } from '../../../providers/ui-provider';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import {
  forgetSubscriptionCredentials,
  subscriptionIsConnected,
  subscriptionPrimaryAction,
} from './subscription-control';
import type { ChatGptChallenge, ChatGptPhase } from './types';
import { sleep } from './utils';
import { runDeviceGrant } from './device-grant';

/**
 * A subscription sign-in card. `chatgpt` is the ChatGPT Plus/Pro login (Codex
 * device grant); `opencode-go` is an OpenCode Console account login for
 * OpenCode Go; `claude` is the member's own Claude Pro or Max login for Claude
 * models run through Claude Code (`claude setup-token` on the server: the
 * member approves on claude.com and pastes the code back, `submitCode`).
 * Same flow, same card; only the provider, the copy and that last step differ.
 */
export type SubscriptionKind = 'chatgpt' | 'opencode-go' | 'claude';

/** OAuth route id, the provider the models belong to, and the logo. */
const SUBSCRIPTIONS: Record<SubscriptionKind, { oauth: string; providerId: string; logo: string; logoName: string }> = {
  chatgpt: { oauth: 'openai', providerId: 'codex', logo: 'openai', logoName: 'OpenAI' },
  'opencode-go': { oauth: 'opencode-go', providerId: 'opencode-go', logo: 'opencode-go', logoName: 'OpenCode Go' },
  claude: { oauth: 'claude', providerId: 'claude-agent', logo: 'anthropic', logoName: 'Anthropic' },
};

/** Whether the caller can use a Claude account in the project (`GET /projects/:id/claude-subscription`). */
export const claudeSubscriptionKey = (projectId: string) => ['claude-subscription', projectId] as const;

const providerLoginsKey = (projectId: string) => ['project-provider-oauth', projectId] as const;

/**
 * The sign-in state machine behind every subscription surface: the card below
 * and the provider sheet (`packages/ui/src/customize/providers/provider-sheet.tsx`). One copy,
 * so a device-grant fix lands in both.
 */
export function useSubscriptionSignIn({
  projectId,
  onConnected,
  kind = 'chatgpt',
}: {
  projectId: string;
  onConnected: (providerId: string) => void;
  kind?: SubscriptionKind;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const tPooled = useTranslations('pooledSecrets');
  const queryClient = useQueryClient();
  const viewer = useUiViewer();
  const subscription = SUBSCRIPTIONS[kind];
  const chatgpt = kind === 'chatgpt';
  const claude = kind === 'claude';
  const tClaude = useTranslations('claudeSubscription');
  const copy = claude ? {
    title: tClaude('title'),
    description: tClaude('description'),
    connectedBanner: tClaude('connectedTitle'),
    connectedToast: tClaude('connected'),
    disconnectedToast: tClaude('disconnected'),
    connect: tClaude('connectClaude'),
    reconnect: tClaude('reconnectClaude'),
    disconnect: tClaude('disconnect'),
    connecting: tClaude('starting'),
    deviceDescription: undefined,
    failed: tClaude('startError'),
  } : chatgpt ? {
    title: tHardcodedUi.raw('autoComponentsProjectsProjectProviderModalJsxTextChatGPTPlusPro0deb5530'),
    description: tHardcodedUi.raw('autoComponentsProjectsProjectProviderModalJsxTextSignInWitha0c5128c'),
    connectedBanner: tHardcodedUi.raw('autoComponentsProjectsProjectProviderModalJsxTextChatGPTSubscriptionConnectedcf12bc87'),
    connectedToast: tHardcodedUi.raw('i18nComplete.text3f86a31c64fc'),
    disconnectedToast: tHardcodedUi.raw('i18nComplete.text555cd401b3c3'),
    connect: tHardcodedUi.raw('i18nComplete.textaa023456aca4'),
    reconnect: tHardcodedUi.raw('i18nComplete.textd9c95c52010d'),
    disconnect: tHardcodedUi.raw('i18nComplete.textc4e46df5702b'),
    connecting: tHardcodedUi.raw('i18nComplete.textf29674479db4'),
    deviceDescription: undefined,
    failed: 'Failed to connect ChatGPT subscription',
  } : {
    title: tPooled('opencodeGoTitle'),
    description: tPooled('opencodeGoDescription'),
    connectedBanner: tPooled('opencodeGoConnectedBanner'),
    connectedToast: tPooled('opencodeConnected'),
    disconnectedToast: tPooled('opencodeGoDisconnected'),
    connect: tPooled('opencodeGoConnect'),
    reconnect: tPooled('opencodeGoReconnect'),
    disconnect: tPooled('opencodeGoDisconnect'),
    connecting: tPooled('opencodeStarting'),
    deviceDescription: tPooled('opencodeDeviceDescription'),
    failed: tPooled('opencodeGoFailed'),
  };
  const [phase, setPhase] = useState<ChatGptPhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [challenge, setChallenge] = useState<ChatGptChallenge | null>(null);
  /** Claude: the sign-in the pasted code completes, and whether it is being checked. */
  const [claudeFlow, setClaudeFlow] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const cancelledRef = useRef(false);

  useEffect(() => {
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  const reset = useCallback(() => {
    cancelledRef.current = true;
    setChallenge(null);
    setClaudeFlow(null);
    setChecking(false);
    setError(null);
    setPhase('idle');
  }, []);

  const claudeConnected = useCallback(async () => {
    setPhase('done');
    setChallenge(null);
    setClaudeFlow(null);
    successToast(copy.connectedToast);
    await queryClient.invalidateQueries({ queryKey: claudeSubscriptionKey(projectId) });
    void queryClient.invalidateQueries({ queryKey: ['account-secret-resources'] });
    refreshProjectProviderState(queryClient, projectId);
    onConnected(subscription.providerId);
  }, [copy.connectedToast, onConnected, projectId, queryClient, subscription.providerId]);

  /** Claude: start `claude setup-token` and open claude.com. The tab opens inside the click, so a popup blocker lets it through. */
  const startClaude = useCallback(async () => {
    cancelledRef.current = false;
    setError(null);
    setChallenge(null);
    setPhase('waiting');
    const popup = typeof window === 'undefined' ? null : window.open('about:blank', '_blank');
    try {
      const started = await startClaudeSubscriptionLogin(projectId);
      if (cancelledRef.current) {
        popup?.close();
        return;
      }
      setClaudeFlow(started.flow_id);
      setChallenge({ url: started.authorize_url, code: null });
      if (popup && !popup.closed) popup.location.href = started.authorize_url;
    } catch (err) {
      popup?.close();
      setPhase('idle');
      setError(err instanceof Error && err.message ? err.message : copy.failed);
    }
  }, [copy.failed, projectId]);

  /** Claude: hand the code claude.com showed to the sign-in. A refused code ends it: the next try signs in again. */
  const submitCode = useCallback(async (code: string) => {
    if (!claudeFlow || !code.trim()) return;
    setChecking(true);
    setError(null);
    try {
      await completeClaudeSubscriptionLogin(projectId, { flowId: claudeFlow, code: code.trim() });
      if (!cancelledRef.current) await claudeConnected();
    } catch (err) {
      if (cancelledRef.current) return;
      setPhase('idle');
      setChallenge(null);
      setClaudeFlow(null);
      setError(err instanceof Error && err.message ? err.message : tClaude('codeError'));
    } finally {
      setChecking(false);
    }
  }, [claudeConnected, claudeFlow, projectId, tClaude]);

  const handleConnect = useCallback(async () => {
    if (claude) return startClaude();
    cancelledRef.current = false;
    setError(null);
    setChallenge(null);
    setPhase('waiting');
    await runDeviceGrant({
      startOAuth: () => startProjectProviderOAuth(projectId, subscription.oauth, {}),
      pollOAuth: (flowId) => pollProjectProviderOAuth(projectId, subscription.oauth, flowId),
      sleep,
      now: Date.now,
      isCancelled: () => cancelledRef.current,
      setChallenge,
      setPhase,
      setError,
      failedMessage: copy.failed,
      onSuccess: () => {
          setPhase('done');
          successToast(copy.connectedToast);
          queryClient.invalidateQueries({ queryKey: qk.project.secrets(projectId) });
          queryClient.invalidateQueries({ queryKey: providerLoginsKey(projectId) });
          refreshProjectProviderState(queryClient, projectId, { expectProviderId: subscription.providerId });
          onConnected(subscription.providerId);
      },
    });
  }, [claude, startClaude, projectId, queryClient, onConnected, subscription, copy.connectedToast, copy.failed]);

  // What the PROJECT holds, not what this component remembers doing. A
  // credential connected in another tab, another surface, or before this page
  // load is still connected — and until this read existed the card offered
  // "Connect ChatGPT" over it and no way to remove it at all.
  const secretsQuery = useQuery({
    queryKey: qk.project.secrets(projectId),
    queryFn: () => listProjectSecrets(projectId),
    ...contract('config'),
    enabled: !claude,
  });
  // A Claude account is an account secret resource: own or shared, the server counts the usable ones.
  const claudeQuery = useQuery({
    queryKey: claudeSubscriptionKey(projectId),
    queryFn: () => getClaudeSubscription(projectId),
    enabled: claude,
  });
  // An OpenCode key secret can hold a plain API key, so a secret name does not
  // say "signed in"; the login list does.
  const loginsQuery = useQuery({
    queryKey: providerLoginsKey(projectId),
    queryFn: () => listProjectProviderOAuth(projectId),
    ...contract('config'),
    enabled: !chatgpt && !claude,
  });
  const connected = useMemo(() => {
    if (claude) return claudeQuery.data?.connected === true;
    if (!chatgpt) return (loginsQuery.data ?? []).some((login) => login.provider_id === subscription.oauth);
    const data = secretsQuery.data;
    const items = Array.isArray(data) ? data : (data?.items ?? []);
    return subscriptionIsConnected(items.map((item) => item.name));
  }, [chatgpt, claude, claudeQuery.data, loginsQuery.data, secretsQuery.data, subscription.oauth]);

  const disconnect = useMutation({
    // The server route was always correct and always unreachable: it deletes
    // the credential, audits it, and refreshes the model catalog. Nothing in
    // the product called it.
    mutationFn: async () => {
      if (claude) {
        // The caller's own Claude accounts in this project; one shared by someone else stays theirs to remove.
        const accountId = (await getProjectDetail(projectId)).project?.account_id;
        if (!accountId) throw new Error(tClaude('startError'));
        const { secrets } = await listAccountSecretResources(accountId, projectId);
        for (const secret of secrets.filter((item) => item.provider_id === subscription.providerId && item.created_by === viewer?.id)) {
          await deleteAccountSecretResource(accountId, secret.secret_id);
        }
      } else await deleteProjectProviderOAuth(projectId, subscription.oauth);
    },
    // Returning the promise keeps the button in its pending state until the
    // cache says "disconnected", so the card never shows a live Disconnect
    // button over a credential the server already removed.
    onSuccess: async () => {
      if (claude) {
        await queryClient.invalidateQueries({ queryKey: claudeSubscriptionKey(projectId) });
        void queryClient.invalidateQueries({ queryKey: ['account-secret-resources'] });
      }
      else if (chatgpt) await forgetSubscriptionCredentials(queryClient, projectId);
      else {
        queryClient.setQueryData(providerLoginsKey(projectId), (logins: Awaited<ReturnType<typeof listProjectProviderOAuth>> | undefined) =>
          logins?.filter((login) => login.provider_id !== subscription.oauth));
        void queryClient.invalidateQueries({ queryKey: qk.project.secrets(projectId) });
      }
      successToast(copy.disconnectedToast);
      setPhase('idle');
      setError(null);
      refreshProjectProviderState(queryClient, projectId);
    },
    onError: (err) =>
      errorToast(
        err instanceof Error ? err.message : tHardcodedUi.raw('i18nComplete.text7b7e67f5f919'),
      ),
  });

  return {
    subscription,
    copy,
    phase,
    challenge,
    error,
    connected,
    start: handleConnect,
    cancel: reset,
    disconnect,
    /** Claude only: the member pastes the code claude.com shows (`submitCode`) instead of typing one into the provider. */
    pastesCode: claude,
    submitCode,
    checking,
  };
}

// Legacy ChatGPT subscription login. With pooled connections enabled this
// component shows only an existing project login; new accounts use resources.
export function ChatGptSubscriptionConnect({
  projectId,
  onConnected,
  accessSlot,
  legacyOnly = false,
  kind = 'chatgpt',
}: {
  projectId: string;
  onConnected: (providerId: string) => void;
  accessSlot?: ReactNode;
  legacyOnly?: boolean;
  kind?: SubscriptionKind;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const tPooled = useTranslations('pooledSecrets');
  const {
    subscription,
    copy,
    phase,
    challenge,
    error,
    connected,
    start: handleConnect,
    cancel: reset,
    disconnect,
  } = useSubscriptionSignIn({ projectId, onConnected, kind });
  const waiting = phase === 'waiting';
  const action = subscriptionPrimaryAction({ connected, failed: !!error });
  if (legacyOnly && !connected) return null;

  return (
    <div className="bg-popover rounded-md border px-4 py-4">
      <div className="flex items-start gap-3">
        <ProviderLogo providerID={subscription.logo} name={subscription.logoName} size="default" />
        <div className="min-w-0 flex-1">
          <div className="text-foreground text-sm font-medium">
            {legacyOnly ? tPooled('legacyChatGptLogin') : copy.title}
          </div>
          <p className="text-muted-foreground mt-0.5 text-xs leading-5">
            {legacyOnly ? tPooled('legacyChatGptDescription') : copy.description}
          </p>
        </div>
        {accessSlot}
      </div>

      {waiting && (
        <div className="border-border bg-muted/30 mt-3 rounded-md border p-3">
          {challenge ? (
            <>
              <div className="text-foreground text-xs font-medium">
                {tHardcodedUi.raw(
                  'autoComponentsProjectsProjectProviderModalJsxTextAuthorizeInThed882ae47',
                )}
              </div>
              <div className="mt-3">
                <ChatGptDeviceChallenge url={challenge.url} code={challenge.code} description={copy.deviceDescription} />
              </div>
            </>
          ) : (
            <div className="text-foreground text-xs font-medium">
              {tHardcodedUi.raw(
                'autoComponentsProjectsProjectProviderModalJsxTextStartingAuthorization35b1fe13',
              )}
            </div>
          )}
          <div className="text-muted-foreground mt-3 flex items-center gap-2 text-xs">
            <Loading className="size-3.5 shrink-0" />
            {challenge
              ? tHardcodedUi.raw('i18nComplete.text2f938f9b118b')
              : copy.connecting}
          </div>
        </div>
      )}

      {(phase === 'done' || (connected && !waiting)) && (
        <InfoBanner tone="success" icon={CheckCircle2} className="mt-3 text-xs">
          {copy.connectedBanner}
        </InfoBanner>
      )}

      {error && (
        <InfoBanner tone="destructive" icon={TriangleAlert} className="mt-3 text-xs">
          {error}
        </InfoBanner>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {waiting ? (
          <Button type="button" size="sm" variant="outline" className="px-4" onClick={reset}>
            {tHardcodedUi.raw('i18nComplete.text19766ed6ccb2')}
          </Button>
        ) : action === 'disconnect' ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="px-4"
            disabled={disconnect.isPending}
            onClick={() => disconnect.mutate()}
          >
            {disconnect.isPending
              ? tHardcodedUi.raw('i18nComplete.textcb2b6a572a85')
              : copy.disconnect}
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="px-4"
            onClick={handleConnect}
          >
            {action === 'reconnect' ? copy.reconnect : copy.connect}
          </Button>
        )}
      </div>
    </div>
  );
}
