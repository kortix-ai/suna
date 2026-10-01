'use client';

import { ChatGptDeviceChallenge } from '@/components/projects/chatgpt-device-challenge';
import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import Loading from '@/components/ui/loading';
import { errorToast, successToast } from '@/components/ui/toast';
import { ProviderLogo } from '@/features/providers/provider-branding';
import {
  deleteProjectProviderOAuth,
  listProjectProviderOAuth,
  listProjectSecrets,
  pollProjectProviderOAuth,
  startProjectProviderOAuth,
} from '@kortix/sdk';
import { contract, qk, refreshProjectProviderState } from '@kortix/sdk/react';
import {
  CheckCircleIcon as CheckCircle2,
  WarningIcon as TriangleAlert,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from '@/i18n/use-translations';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import {
  forgetSubscriptionCredentials,
  subscriptionIsConnected,
  subscriptionPrimaryAction,
} from './subscription-control';
import type { ChatGptChallenge, ChatGptPhase } from './types';
import { sleep } from './utils';

/**
 * A subscription sign-in card. `chatgpt` is the ChatGPT Plus/Pro login (Codex
 * device grant); `opencode-go` is an OpenCode Console account login for
 * OpenCode Go. Same flow, same card; only the provider and the copy differ.
 */
export type SubscriptionKind = 'chatgpt' | 'opencode-go';

/** OAuth route id, the provider the models belong to, and the logo. */
const SUBSCRIPTIONS: Record<SubscriptionKind, { oauth: string; providerId: string; logo: string; logoName: string }> = {
  chatgpt: { oauth: 'openai', providerId: 'codex', logo: 'openai', logoName: 'OpenAI' },
  'opencode-go': { oauth: 'opencode-go', providerId: 'opencode-go', logo: 'opencode-go', logoName: 'OpenCode Go' },
};

const providerLoginsKey = (projectId: string) => ['project-provider-oauth', projectId] as const;

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
  const queryClient = useQueryClient();
  const subscription = SUBSCRIPTIONS[kind];
  const chatgpt = kind === 'chatgpt';
  const copy = chatgpt ? {
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
  const cancelledRef = useRef(false);

  useEffect(() => {
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  const reset = useCallback(() => {
    cancelledRef.current = true;
    setChallenge(null);
    setError(null);
    setPhase('idle');
  }, []);

  const handleConnect = useCallback(async () => {
    cancelledRef.current = false;
    setError(null);
    setChallenge(null);
    setPhase('waiting');
    try {
      const start = await startProjectProviderOAuth(projectId, subscription.oauth, {});
      if (cancelledRef.current) return;
      setChallenge({ url: start.verification_url, code: start.user_code });

      const interval = Math.max(2000, start.interval_ms || 3000);
      const deadline = start.expires_at || Date.now() + 10 * 60_000;
      while (!cancelledRef.current && Date.now() < deadline) {
        await sleep(interval);
        if (cancelledRef.current) return;
        let res;
        try {
          res = await pollProjectProviderOAuth(projectId, subscription.oauth, start.flow_id);
        } catch {
          continue;
        }
        if (cancelledRef.current) return;
        if (res.status === 'success') {
          setPhase('done');
          successToast(copy.connectedToast);
          queryClient.invalidateQueries({ queryKey: qk.project.secrets(projectId) });
          queryClient.invalidateQueries({ queryKey: providerLoginsKey(projectId) });
          refreshProjectProviderState(queryClient, projectId, { expectProviderId: subscription.providerId });
          onConnected(subscription.providerId);
          return;
        }
        if (res.status === 'failed') {
          setChallenge(null);
          setPhase('idle');
          setError(res.error || 'Authorization failed');
          return;
        }
        if (res.status === 'expired') {
          setChallenge(null);
          setPhase('idle');
          setError('Authorization timed out. Try again.');
          return;
        }
      }
      if (!cancelledRef.current) {
        setChallenge(null);
        setPhase('idle');
        setError('Authorization timed out. Try again.');
      }
    } catch (err) {
      if (cancelledRef.current) return;
      setChallenge(null);
      setPhase('idle');
      setError(err instanceof Error ? err.message : copy.failed);
    }
  }, [projectId, queryClient, onConnected, subscription, copy.connectedToast, copy.failed]);

  // What the PROJECT holds, not what this component remembers doing. A
  // credential connected in another tab, another surface, or before this page
  // load is still connected — and until this read existed the card offered
  // "Connect ChatGPT" over it and no way to remove it at all.
  const secretsQuery = useQuery({
    queryKey: qk.project.secrets(projectId),
    queryFn: () => listProjectSecrets(projectId),
    ...contract('config'),
  });
  // An OpenCode key secret can hold a plain API key, so a secret name does not
  // say "signed in"; the login list does.
  const loginsQuery = useQuery({
    queryKey: providerLoginsKey(projectId),
    queryFn: () => listProjectProviderOAuth(projectId),
    ...contract('config'),
    enabled: !chatgpt,
  });
  const connected = useMemo(() => {
    if (!chatgpt) return (loginsQuery.data ?? []).some((login) => login.provider_id === subscription.oauth);
    const data = secretsQuery.data;
    const items = Array.isArray(data) ? data : (data?.items ?? []);
    return subscriptionIsConnected(items.map((item) => item.name));
  }, [chatgpt, loginsQuery.data, secretsQuery.data, subscription.oauth]);

  const disconnect = useMutation({
    // The server route was always correct and always unreachable: it deletes
    // the credential, audits it, and refreshes the model catalog. Nothing in
    // the product called it.
    mutationFn: () => deleteProjectProviderOAuth(projectId, subscription.oauth),
    // Returning the promise keeps the button in its pending state until the
    // cache says "disconnected", so the card never shows a live Disconnect
    // button over a credential the server already removed.
    onSuccess: async () => {
      if (chatgpt) await forgetSubscriptionCredentials(queryClient, projectId);
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
