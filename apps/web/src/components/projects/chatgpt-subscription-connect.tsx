'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, ExternalLink, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ProviderLogo } from '@/features/providers/provider-branding';
import {
  type SharingSelection,
  isSharingComplete,
  selectionToIntent,
} from '@/features/workspace/shared/sharing-picker';
import { accountStateSelectors, useAccountState } from '@/hooks/billing';
import { isBillingEnabled } from '@/lib/config';
import {
  listProjectSecrets,
  pollProjectProviderOAuth,
  startProjectProviderOAuth,
} from '@/lib/projects-client';
import { toast } from '@/lib/toast';
import { useBillingAccountId } from '@/stores/billing-account-context';

export const CODEX_AUTH_JSON_SECRET_NAME = 'CODEX_AUTH_JSON';
export const LEGACY_OPENCODE_AUTH_JSON_SECRET_NAME = 'OPENCODE_AUTH_JSON';

const DEFAULT_PROJECT_SHARING: SharingSelection = { mode: 'project', memberIds: [] };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type ChatGptPhase = 'idle' | 'waiting' | 'done';
type ChatGptChallenge = { url: string; code: string | null };

export function isChatGptSubscriptionConnected(secretNames: Set<string>): boolean {
  return (
    secretNames.has(CODEX_AUTH_JSON_SECRET_NAME) ||
    secretNames.has(LEGACY_OPENCODE_AUTH_JSON_SECRET_NAME)
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
      if (start.verification_url) {
        window.open(start.verification_url, '_blank', 'noopener,noreferrer');
      }

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
          toast.success('ChatGPT subscription connected to this project');
          queryClient.invalidateQueries({ queryKey: ['project-secrets', projectId] });
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
    <div className="border-border/50 bg-muted/20 rounded-2xl border p-4">
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
        <div className="border-border/50 bg-background/70 mt-3 rounded-2xl border p-3">
          {challenge ? (
            <>
              <div className="text-foreground text-xs font-medium">
                {tI18nHardcoded.raw(
                  'autoComponentsProjectsProjectProviderModalJsxTextAuthorizeInThed882ae47',
                )}
              </div>
              {challenge.url && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="mt-2 h-8 gap-1.5 px-3"
                  onClick={() => window.open(challenge.url, '_blank', 'noopener,noreferrer')}
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  {tI18nHardcoded.raw(
                    'autoComponentsProjectsProjectProviderModalJsxTextOpenAuthPaged0381841',
                  )}
                </Button>
              )}
              {challenge.code ? (
                <div className="mt-3">
                  <div className="text-muted-foreground text-xs">
                    {tI18nHardcoded.raw(
                      'autoComponentsProjectsProjectProviderModalJsxTextEnterThisCodee346992b',
                    )}
                  </div>
                  <div className="border-border/60 bg-muted text-foreground mt-1 w-fit rounded-2xl border px-3 py-2 font-mono text-lg font-semibold tracking-normal">
                    {challenge.code}
                  </div>
                </div>
              ) : null}
            </>
          ) : (
            <div className="text-foreground text-xs font-medium">
              {tI18nHardcoded.raw(
                'autoComponentsProjectsProjectProviderModalJsxTextStartingAuthorization35b1fe13',
              )}
            </div>
          )}
          <div className="text-muted-foreground mt-3 flex items-center gap-2 text-xs">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {challenge ? 'Waiting for you to finish in the browser…' : 'Connecting to OpenAI…'}
          </div>
        </div>
      )}

      {phase === 'done' && (
        <div className="text-foreground/80 mt-3 flex items-start gap-2 rounded-2xl border border-emerald-500/20 bg-emerald-500/[0.06] px-3 py-2.5 text-xs">
          {tI18nHardcoded.raw(
            'autoComponentsProjectsProjectProviderModalJsxTextChatGPTSubscriptionConnectedcf12bc87',
          )}
        </div>
      )}

      {error && (
        <div className="bg-destructive/5 text-destructive mt-3 flex items-start gap-2 rounded-2xl px-3 py-2 text-xs">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 space-y-0 overflow-hidden p-0 sm:max-w-md">
        <DialogHeader className="space-y-1 px-5 pt-5 pb-3">
          <DialogTitle className="text-base font-semibold">Connect GPT subscription</DialogTitle>
          <DialogDescription className="text-xs">
            Use your ChatGPT Plus or Pro subscription for premium models on the free plan.
          </DialogDescription>
        </DialogHeader>
        <div className="px-5 pb-5">
          {open ? (
            <ChatGptSubscriptionConnect
              projectId={projectId}
              autoStartOnOpen
              onConnected={handleConnected}
            />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
