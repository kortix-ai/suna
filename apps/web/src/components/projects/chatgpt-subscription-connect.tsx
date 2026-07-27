'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, TriangleAlert } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ChatGptDeviceChallenge } from '@/components/projects/chatgpt-device-challenge';
import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import Loading from '@/components/ui/loading';
import {
  Modal,
  ModalContent,
  ModalDescription,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import { successToast } from '@/components/ui/toast';
import { ProviderLogo } from '@/features/providers/provider-branding';
import {
  type SharingSelection,
  isSharingComplete,
  selectionToIntent,
} from '@/features/workspace/shared/sharing-picker';
import { accountStateSelectors, useAccountState } from '@/hooks/billing';
import { isBillingEnabled } from '@/lib/config';
import { useBillingAccountId } from '@/stores/billing-account-context';
import {
  listProjectSecrets,
  pollProjectProviderOAuth,
  startProjectProviderOAuth,
} from '@kortix/sdk';
import { refreshProjectProviderState } from '@kortix/sdk/react';

export const CODEX_AUTH_JSON_SECRET_NAME = 'CODEX_AUTH_JSON';
export const LEGACY_RUNTIME_AUTH_JSON_SECRET_NAME = 'OPENCODE_AUTH_JSON';

const DEFAULT_PROJECT_SHARING: SharingSelection = { mode: 'project', memberIds: [], groupIds: [] };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type ChatGptPhase = 'idle' | 'waiting' | 'done';
type ChatGptChallenge = { url: string; code: string | null };

export function isChatGptSubscriptionConnected(secretNames: Set<string>): boolean {
  return (
    secretNames.has(CODEX_AUTH_JSON_SECRET_NAME) ||
    secretNames.has(LEGACY_RUNTIME_AUTH_JSON_SECRET_NAME)
  );
}

export function useChatGptSubscriptionConnected(projectId: string, enabled = true) {
  const secretsQuery = useQuery({
    queryKey: ['project-secrets', projectId],
    queryFn: () => listProjectSecrets(projectId),
    staleTime: 10_000,
    enabled: enabled && !!projectId,
  });

  const connected = secretsQuery.data
    ? isChatGptSubscriptionConnected(
        new Set(
          (Array.isArray(secretsQuery.data)
            ? secretsQuery.data
            : (secretsQuery.data?.items ?? [])
          ).map((item) => item.name),
        ),
      )
    : false;

  return { connected, isLoading: secretsQuery.isLoading };
}

export function useShowChatGptConnectPrompt(projectId: string) {
  const accountId = useBillingAccountId();
  const { data: accountState, isLoading: accountLoading } = useAccountState({
    accountId,
    enabled: isBillingEnabled() && !!accountId,
  });

  const tierKey = accountStateSelectors.tierKey(accountState).toLowerCase();
  const hasActiveSubscription = !!accountState?.subscription?.subscription_id;
  const isFreeTier = tierKey === 'free' && !hasActiveSubscription;
  const billingReady = !isBillingEnabled() || (!accountLoading && !!accountState);

  const { connected, isLoading: secretsLoading } = useChatGptSubscriptionConnected(
    projectId,
    isBillingEnabled() && isFreeTier && billingReady,
  );

  const show = isBillingEnabled() && billingReady && isFreeTier && !secretsLoading && !connected;

  return { show, connected, isLoading: accountLoading || secretsLoading };
}

export function ChatGptSubscriptionConnect({
  projectId,
  sharing = DEFAULT_PROJECT_SHARING,
  showSharingPicker = false,
  autoStartOnOpen = false,
  onConnected,
}: {
  projectId: string;
  sharing?: SharingSelection;
  showSharingPicker?: boolean;
  autoStartOnOpen?: boolean;
  onConnected?: () => void;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<ChatGptPhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [challenge, setChallenge] = useState<ChatGptChallenge | null>(null);
  const cancelledRef = useRef(false);
  const autoStartedRef = useRef(false);

  useEffect(() => {
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  const reset = useCallback(() => {
    cancelledRef.current = true;
    autoStartedRef.current = false;
    setChallenge(null);
    setError(null);
    setPhase('idle');
  }, []);

  const handleConnect = useCallback(async () => {
    if (!isSharingComplete(sharing)) {
      setError('Pick at least one member, or choose another access option.');
      return;
    }
    cancelledRef.current = false;
    setError(null);
    setChallenge(null);
    setPhase('waiting');
    try {
      const start = await startProjectProviderOAuth(projectId, 'openai', {
        sharing: selectionToIntent(sharing),
      });
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
          queryClient.invalidateQueries({ queryKey: ['project-secrets', projectId] });
          refreshProjectProviderState(queryClient, projectId, { expectProviderId: 'codex' });
          onConnected?.();
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
  }, [projectId, sharing, queryClient, onConnected]);

  useEffect(() => {
    if (!autoStartOnOpen || autoStartedRef.current || phase !== 'idle') return;
    autoStartedRef.current = true;
    void handleConnect();
  }, [autoStartOnOpen, handleConnect, phase]);

  const waiting = phase === 'waiting';

  return (
    <div className="bg-popover rounded-md border p-4">
      <div className="flex items-start gap-3">
        <ProviderLogo providerID="openai" name="OpenAI" size="default" />
        <div className="min-w-0 flex-1">
          <div className="text-foreground text-sm font-medium">
            {tI18nHardcoded.raw(
              'autoComponentsProjectsProjectProviderModalJsxTextChatGPTPlusPro0deb5530',
            )}
          </div>
          <p className="text-muted-foreground mt-0.5 text-xs leading-5">
            {tI18nHardcoded.raw(
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
                {tI18nHardcoded.raw(
                  'autoComponentsProjectsProjectProviderModalJsxTextAuthorizeInThed882ae47',
                )}
              </div>
              <div className="mt-3">
                <ChatGptDeviceChallenge url={challenge.url} code={challenge.code} />
              </div>
            </>
          ) : (
            <div className="text-foreground text-xs font-medium">
              {tI18nHardcoded.raw(
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

      {phase === 'done' && (
        <InfoBanner tone="success" icon={CheckCircle2} className="mt-3 text-xs">
          {tI18nHardcoded.raw(
            'autoComponentsProjectsProjectProviderModalJsxTextChatGPTSubscriptionConnectedcf12bc87',
          )}
        </InfoBanner>
      )}

      {error && (
        <InfoBanner tone="destructive" icon={TriangleAlert} className="mt-3 text-xs">
          {error}
        </InfoBanner>
      )}

      {!autoStartOnOpen && (
        <div className="mt-3 flex flex-wrap gap-2">
          {waiting ? (
            <Button type="button" size="sm" variant="outline" className="px-4" onClick={reset}>
              Cancel
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="px-4"
              onClick={handleConnect}
            >
              {error || phase === 'done' ? 'Reconnect ChatGPT' : 'Connect ChatGPT'}
            </Button>
          )}
        </div>
      )}

      {autoStartOnOpen && waiting && (
        <div className="mt-3">
          <Button type="button" size="sm" variant="outline" className="px-4" onClick={reset}>
            Cancel
          </Button>
        </div>
      )}

      {showSharingPicker ? null : (
        <p className="text-muted-foreground mt-3 text-xs">
          Saved for everyone on this project. Restart a running session sandbox to pick it up.
        </p>
      )}
    </div>
  );
}

export function ChatGptSubscriptionConnectDialog({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const handleConnected = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="gap-0 space-y-0 overflow-hidden p-0 lg:max-w-md">
        <ModalHeader className="space-y-1 pb-3">
          <ModalTitle>Connect GPT subscription</ModalTitle>
          <ModalDescription className="text-xs">
            Use your ChatGPT Plus or Pro subscription for premium models on the free plan.
          </ModalDescription>
        </ModalHeader>
        <div className="px-5 pb-5">
          {open ? (
            <ChatGptSubscriptionConnect
              projectId={projectId}
              autoStartOnOpen
              onConnected={handleConnected}
            />
          ) : null}
        </div>
      </ModalContent>
    </Modal>
  );
}
