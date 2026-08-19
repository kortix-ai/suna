'use client';

import {
  CheckCircleIcon as CheckCircle2,
  WarningIcon as TriangleAlert,
} from '@phosphor-icons/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
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
import { cn } from '@/lib/utils';
import { useBillingAccountId } from '@/stores/billing-account-context';
import {
  listProjectSecrets,
  pollProjectProviderOAuth,
  startProjectProviderOAuth,
} from '@kortix/sdk';
import { contract, qk, refreshProjectProviderState } from '@kortix/sdk/react';

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
    queryKey: qk.project.secrets(projectId),
    queryFn: () => listProjectSecrets(projectId),
    ...contract('config'),
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

/**
 * The whole ChatGPT device-OAuth flow, with no UI attached.
 *
 * **Why this is split out.** `ChatGptSubscriptionConnect` below is one fixed
 * card: its own border, its own logo, its own title and description, its own
 * button, its own footer note. That is fine as a standalone block and wrong
 * everywhere else — dropping it inside a settings row that already says
 * "ChatGPT" produces the same words twice inside a nested box.
 *
 * The flow is the part worth sharing; the card is just one arrangement of it.
 * Take this hook and render whichever pieces you need:
 *
 * ```tsx
 * const flow = useChatGptConnectFlow({ projectId });
 *
 * <SettingsRow label="ChatGPT" description="…">
 *   {flow.isWaiting ? <ChatGptCancelButton flow={flow} /> : <ChatGptConnectButton flow={flow} />}
 * </SettingsRow>
 * <ChatGptAuthChallenge flow={flow} />
 * ```
 *
 * Nothing here renders, so a host owns its own chrome completely.
 */
export interface ChatGptConnectFlow {
  phase: ChatGptPhase;
  error: string | null;
  challenge: ChatGptChallenge | null;
  /** Authorization is in flight — show the challenge and a Cancel, not Connect. */
  isWaiting: boolean;
  isDone: boolean;
  connect: () => void;
  /** Abandons an in-flight authorization and returns to idle. */
  cancel: () => void;
}

export function useChatGptConnectFlow({
  projectId,
  sharing = DEFAULT_PROJECT_SHARING,
  autoStart = false,
  onConnected,
}: {
  projectId: string;
  sharing?: SharingSelection;
  autoStart?: boolean;
  onConnected?: () => void;
}): ChatGptConnectFlow {
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
          queryClient.invalidateQueries({ queryKey: qk.project.secrets(projectId) });
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
    if (!autoStart || autoStartedRef.current || phase !== 'idle') return;
    autoStartedRef.current = true;
    void handleConnect();
  }, [autoStart, handleConnect, phase]);

  return {
    phase,
    error,
    challenge,
    isWaiting: phase === 'waiting',
    isDone: phase === 'done',
    connect: handleConnect,
    cancel: reset,
  };
}

/**
 * Start / retry authorization. Label changes to "Reconnect" once a previous
 * attempt errored or succeeded, matching what the card has always shown.
 * Renders nothing while an authorization is in flight — pair it with
 * `ChatGptCancelButton`, which is the control that belongs there instead.
 */
export function ChatGptConnectButton({
  flow,
  size = 'sm',
  variant = 'outline',
  className,
  label,
}: {
  flow: ChatGptConnectFlow;
  size?: 'sm' | 'default';
  variant?: 'outline' | 'secondary' | 'default';
  className?: string;
  /** Overrides the default label; useful where the surrounding row already says "ChatGPT". */
  label?: string;
}) {
  if (flow.isWaiting) return null;
  const fallback = flow.error || flow.isDone ? 'Reconnect ChatGPT' : 'Connect ChatGPT';
  return (
    <Button
      type="button"
      size={size}
      variant={variant}
      className={className}
      onClick={flow.connect}
    >
      {label ?? fallback}
    </Button>
  );
}

/** Abandons an in-flight authorization. Renders nothing when nothing is in flight. */
export function ChatGptCancelButton({
  flow,
  size = 'sm',
  variant = 'outline',
  className,
}: {
  flow: ChatGptConnectFlow;
  size?: 'sm' | 'default';
  variant?: 'outline' | 'secondary' | 'default';
  className?: string;
}) {
  if (!flow.isWaiting) return null;
  return (
    <Button type="button" size={size} variant={variant} className={className} onClick={flow.cancel}>
      Cancel
    </Button>
  );
}

/**
 * The device-code step: the code to copy and the link that opens OpenAI's auth
 * page, plus the waiting indicator. Renders nothing unless an authorization is
 * actually in flight, so a host can mount it unconditionally.
 *
 * `bare` drops the boxed chrome for hosts that already sit inside a bordered
 * group — the settings panel's rows, for instance — so the code does not end up
 * in a border inside a border.
 */
export function ChatGptAuthChallenge({
  flow,
  bare = false,
  className,
}: {
  flow: ChatGptConnectFlow;
  bare?: boolean;
  className?: string;
}) {
  if (!flow.isWaiting) return null;
  return (
    <div
      className={cn(
        bare ? 'space-y-3' : 'border-border bg-muted/30 space-y-3 rounded-md border p-3',
        className,
      )}
    >
      {flow.challenge ? (
        <ChatGptDeviceChallenge url={flow.challenge.url} code={flow.challenge.code} />
      ) : (
        <div className="text-foreground text-xs font-medium">Starting authorization…</div>
      )}
      <div className="text-muted-foreground flex items-center gap-2 text-xs">
        <Loading className="size-3.5 shrink-0" />
        {flow.challenge ? 'Waiting for you to finish in the browser…' : 'Connecting to OpenAI…'}
      </div>
    </div>
  );
}

/**
 * The standalone card — logo, title, description, the flow's controls, and a
 * footer note. Unchanged in behaviour and API; it is now assembled from the
 * parts above rather than owning the flow itself, so this file has one
 * implementation of the OAuth loop instead of one per layout.
 *
 * Do NOT reach for this inside a surface that already labels ChatGPT. Use
 * `useChatGptConnectFlow` with the individual parts instead.
 */
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
  const flow = useChatGptConnectFlow({
    projectId,
    sharing,
    autoStart: autoStartOnOpen,
    onConnected,
  });
  const { phase, error, challenge } = flow;
  const waiting = flow.isWaiting;

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

      <ChatGptAuthChallenge flow={flow} className="mt-3" />

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

      {/* Both branches are now the shared parts. `autoStartOnOpen` only ever
          suppressed Connect — the flow starts itself — so Cancel is the one
          control it keeps. */}
      <div className="mt-3 flex flex-wrap gap-2 empty:mt-0">
        {autoStartOnOpen ? null : <ChatGptConnectButton flow={flow} className="px-4" />}
        <ChatGptCancelButton flow={flow} className="px-4" />
      </div>

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
