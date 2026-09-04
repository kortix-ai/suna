'use client';

import { ChatGptDeviceChallenge } from '@/components/projects/chatgpt-device-challenge';
import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import Loading from '@/components/ui/loading';
import { errorToast, successToast } from '@/components/ui/toast';
import { ProviderLogo } from '@/features/providers/provider-branding';
import {
  deleteProjectProviderOAuth,
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
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { subscriptionIsConnected, subscriptionPrimaryAction } from './subscription-control';
import type { ChatGptChallenge, ChatGptPhase } from './types';
import { sleep } from './utils';

// ChatGPT subscription logins connect project-wide, like every other LLM
// provider credential (kortix policy: no per-user access choice at the LLM
// level). The server's default sharing intent is project-wide.
export function ChatGptSubscriptionConnect({
  projectId,
  onConnected,
}: {
  projectId: string;
  onConnected: (providerId: string) => void;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const queryClient = useQueryClient();
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
      const start = await startProjectProviderOAuth(projectId, 'openai', {});
      if (cancelledRef.current) return;
      setChallenge({ url: start.verification_url, code: start.user_code });

      const interval = Math.max(2000, start.interval_ms || 3000);
      const deadline = start.expires_at || Date.now() + 10 * 60_000;
      while (!cancelledRef.current && Date.now() < deadline) {
        await sleep(interval);
        if (cancelledRef.current) return;
        let res;
        try {
          res = await pollProjectProviderOAuth(projectId, 'openai', start.flow_id);
        } catch {
          continue;
        }
        if (cancelledRef.current) return;
        if (res.status === 'success') {
          setPhase('done');
          successToast('ChatGPT subscription connected to this project');
          queryClient.invalidateQueries({ queryKey: qk.project.secrets(projectId) });
          refreshProjectProviderState(queryClient, projectId, { expectProviderId: 'codex' });
          onConnected('codex');
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
      setError(err instanceof Error ? err.message : 'Failed to connect ChatGPT subscription');
    }
  }, [projectId, queryClient, onConnected]);

  // What the PROJECT holds, not what this component remembers doing. A
  // credential connected in another tab, another surface, or before this page
  // load is still connected — and until this read existed the card offered
  // "Connect ChatGPT" over it and no way to remove it at all.
  const secretsQuery = useQuery({
    queryKey: qk.project.secrets(projectId),
    queryFn: () => listProjectSecrets(projectId),
    ...contract('config'),
  });
  const connected = useMemo(() => {
    const data = secretsQuery.data;
    const items = Array.isArray(data) ? data : (data?.items ?? []);
    return subscriptionIsConnected(items.map((item) => item.name));
  }, [secretsQuery.data]);

  const disconnect = useMutation({
    // The server route was always correct and always unreachable: it deletes
    // the credential, audits it, and refreshes the model catalog. Nothing in
    // the product called it.
    mutationFn: () => deleteProjectProviderOAuth(projectId, 'openai'),
    onSuccess: () => {
      successToast('ChatGPT subscription disconnected');
      setPhase('idle');
      setError(null);
      queryClient.invalidateQueries({ queryKey: qk.project.secrets(projectId) });
      refreshProjectProviderState(queryClient, projectId);
    },
    onError: (err) =>
      errorToast(err instanceof Error ? err.message : 'Failed to disconnect the subscription'),
  });

  const waiting = phase === 'waiting';
  const action = subscriptionPrimaryAction({ connected, failed: !!error });

  return (
    <div className="bg-popover rounded-md border px-4 py-4">
      <div className="flex items-start gap-3">
        <ProviderLogo providerID="openai" name="OpenAI" size="default" />
        <div className="min-w-0 flex-1">
          <div className="text-foreground text-sm font-medium">
            {tHardcodedUi.raw(
              'autoComponentsProjectsProjectProviderModalJsxTextChatGPTPlusPro0deb5530',
            )}
          </div>
          <p className="text-muted-foreground mt-0.5 text-xs leading-5">
            {tHardcodedUi.raw(
              'autoComponentsProjectsProjectProviderModalJsxTextSignInWitha0c5128c',
            )}
          </p>
        </div>
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
                <ChatGptDeviceChallenge url={challenge.url} code={challenge.code} />
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
            {challenge ? 'Waiting for you to finish in the browser…' : 'Connecting to OpenAI…'}
          </div>
        </div>
      )}

      {(phase === 'done' || (connected && !waiting)) && (
        <InfoBanner tone="success" icon={CheckCircle2} className="mt-3 text-xs">
          {tHardcodedUi.raw(
            'autoComponentsProjectsProjectProviderModalJsxTextChatGPTSubscriptionConnectedcf12bc87',
          )}
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
            Cancel
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
            {disconnect.isPending ? 'Disconnecting…' : 'Disconnect ChatGPT'}
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="px-4"
            onClick={handleConnect}
          >
            {action === 'reconnect' ? 'Reconnect ChatGPT' : 'Connect ChatGPT'}
          </Button>
        )}
      </div>
    </div>
  );
}
