'use client';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { successToast } from '@/components/ui/toast';
import { ProviderLogo } from '@/features/providers/provider-branding';
import {
  type ModelsPageRuntime,
  invalidateComposerCapabilityQueries,
  refreshProjectProviderState,
} from '@kortix/sdk/react';
import type { AuthProviderPublic } from '@kortix/shared/auth-providers';
import { useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Check, ExternalLink } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { type AccountFlowPoll, pollAccountFlow, startAccountFlow } from '../auth-flow-client';
import { METHOD_COMPATIBLE_HARNESSES } from '../harness-method-compat';
import type { ChatGptChallenge, ChatGptPhase } from '../types';
import { sleep } from '../utils';
import {
  UseWithRuntimes,
  applyUseWithSelections,
  defaultUseWithHarnesses,
} from './use-with-runtimes';

/**
 * The device-code account flow (spec §9.2) — the honest, browserless web
 * shape: the user opens a link and types a code, we poll until the provider
 * confirms. NO fake localhost redirect dance. Provider-generic: every field
 * that used to be OpenAI-specific now comes from the shared `AuthProviderPublic`
 * registry row + the derived compatible-harness set, so a second device-code
 * provider (Copilot/xAI, once Phase 2) drops in with no edit here.
 */
export function DeviceCodeForm({
  projectId,
  provider,
  runtimes,
  onConnected,
}: {
  projectId: string;
  provider: AuthProviderPublic;
  runtimes: ModelsPageRuntime[];
  onConnected: () => void;
}) {
  const queryClient = useQueryClient();
  const compatible = METHOD_COMPATIBLE_HARNESSES[provider.producesAuthKind];
  const [phase, setPhase] = useState<ChatGptPhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [challenge, setChallenge] = useState<ChatGptChallenge | null>(null);
  const [useWith, setUseWith] = useState(() => defaultUseWithHarnesses(compatible, runtimes));
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
      const start = await startAccountFlow(projectId, provider.id);
      if (cancelledRef.current) return;
      setChallenge({ url: start.verificationUrl, code: start.userCode });
      if (start.verificationUrl) {
        window.open(start.verificationUrl, '_blank', 'noopener,noreferrer');
      }

      while (!cancelledRef.current && Date.now() < start.expiresAt) {
        await sleep(start.intervalMs);
        if (cancelledRef.current) return;
        let res: AccountFlowPoll;
        try {
          res = await pollAccountFlow(projectId, provider.id, start.flowId);
        } catch {
          continue;
        }
        if (cancelledRef.current) return;
        if (res.status === 'success') {
          setPhase('done');
          await applyUseWithSelections(projectId, provider.producesAuthKind, useWith);
          successToast(`${provider.label} connected to this project`);
          await invalidateComposerCapabilityQueries(queryClient, projectId);
          refreshProjectProviderState(queryClient, projectId, { expectProviderId: provider.id });
          onConnected();
          return;
        }
        if (res.status === 'failed') {
          setChallenge(null);
          setPhase('idle');
          setError(res.error);
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
      setError(err instanceof Error ? err.message : `Failed to connect ${provider.label}`);
    }
  }, [projectId, provider, queryClient, onConnected, useWith]);

  const waiting = phase === 'waiting';

  return (
    <div className="bg-popover space-y-3 rounded-md border px-4 py-4">
      <div className="flex items-start gap-3">
        <ProviderLogo providerID={provider.id} name={provider.label} size="default" />
        <div className="min-w-0 flex-1">
          <div className="text-foreground text-sm font-medium">
            Sign in with your {provider.label} account
          </div>
          <p className="text-muted-foreground mt-0.5 text-xs leading-5 text-pretty">
            Open the link, approve in your browser, and come back — no API key needed.
          </p>
        </div>
      </div>

      {waiting && (
        <div className="bg-muted/40 space-y-3 rounded-md border px-3 py-3">
          {challenge ? (
            <>
              <div className="space-y-1.5">
                <div className="text-muted-foreground text-xs">Open this link and approve:</div>
                <div className="flex flex-wrap items-center gap-2">
                  {challenge.url && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-8 gap-1.5 px-3 active:scale-[0.96] transition-transform"
                      onClick={() => window.open(challenge.url, '_blank', 'noopener,noreferrer')}
                    >
                      <ExternalLink className="size-3.5 shrink-0" />
                      Open sign-in page
                    </Button>
                  )}
                </div>
              </div>
              {challenge.code ? (
                <div className="space-y-1">
                  <div className="text-muted-foreground text-xs">Enter this code if prompted:</div>
                  <div className="border-border/60 bg-background w-fit rounded-md border px-3 py-2 font-mono text-lg font-semibold tracking-normal tabular-nums">
                    {challenge.code}
                  </div>
                </div>
              ) : null}
            </>
          ) : (
            <div className="text-foreground text-xs font-medium">Starting authorization…</div>
          )}
          <div className="text-muted-foreground flex items-center gap-2 text-xs">
            <Loading className="size-3.5 shrink-0" />
            {challenge
              ? 'Waiting for you to finish in the browser…'
              : `Connecting to ${provider.label}…`}
          </div>
        </div>
      )}

      {phase === 'done' && (
        <div className="border-kortix-green/20 bg-kortix-green/[0.06] flex items-center gap-2 rounded-md border px-3 py-2.5">
          <Check className="text-kortix-green size-4 shrink-0" />
          <span className="text-foreground/80 text-xs">
            Authentication completed — you can close this window.
          </span>
        </div>
      )}

      {error && (
        <div className="bg-destructive/5 text-destructive flex items-start gap-2 rounded-md px-3 py-2 text-xs">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {!waiting && phase !== 'done' && (
        <UseWithRuntimes
          compatible={compatible}
          runtimes={runtimes}
          value={useWith}
          onChange={setUseWith}
        />
      )}

      <div className="flex flex-wrap items-center gap-2">
        {waiting ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="px-4 active:scale-[0.96] transition-transform"
            onClick={reset}
          >
            Cancel
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            className="px-4 active:scale-[0.96] transition-transform"
            onClick={handleConnect}
          >
            {error || phase === 'done'
              ? `Reconnect ${provider.label}`
              : `Connect ${provider.label}`}
          </Button>
        )}
      </div>
    </div>
  );
}
