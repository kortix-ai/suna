'use client';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { successToast } from '@/components/ui/toast';
import { ProviderLogo } from '@/features/providers/provider-branding';
import { pollProjectProviderOAuth, startProjectProviderOAuth } from '@kortix/sdk/projects-client';
import {
  invalidateComposerCapabilityQueries,
  refreshProjectProviderState,
  type ModelsPageRuntime,
} from '@kortix/sdk/react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertCircle, ChevronLeft, ExternalLink } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { ChatGptChallenge, ChatGptPhase } from '../types';
import { sleep } from '../utils';
import { applyUseWithSelections, defaultUseWithHarnesses, UseWithRuntimes } from './use-with-runtimes';

export function ChatGptSubscriptionForm({
  projectId,
  runtimes,
  onBack,
  onConnected,
}: {
  projectId: string;
  runtimes: ModelsPageRuntime[];
  onBack: () => void;
  onConnected: () => void;
}) {
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<ChatGptPhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [challenge, setChallenge] = useState<ChatGptChallenge | null>(null);
  const [useWith, setUseWith] = useState(() => defaultUseWithHarnesses(['codex'], runtimes));
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
          await applyUseWithSelections(projectId, 'codex_subscription', useWith);
          successToast('ChatGPT subscription connected to this project');
          await invalidateComposerCapabilityQueries(queryClient, projectId);
          refreshProjectProviderState(queryClient, projectId, { expectProviderId: 'codex' });
          onConnected();
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
  }, [projectId, queryClient, onConnected, useWith]);

  const waiting = phase === 'waiting';

  return (
    <div className="space-y-3">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="text-muted-foreground -ml-2 h-7 gap-1 px-2 text-xs"
        onClick={onBack}
      >
        <ChevronLeft className="size-3.5 shrink-0" />
        Back
      </Button>
      <div className="bg-popover space-y-3 rounded-md border px-4 py-4">
        <div className="flex items-start gap-3">
          <ProviderLogo providerID="openai" name="OpenAI" size="default" />
          <div className="min-w-0 flex-1">
            <div className="text-foreground text-sm font-medium">ChatGPT Plus, Pro, Business, Edu, or Enterprise</div>
            <p className="text-muted-foreground mt-0.5 text-xs leading-5">
              Sign in with your ChatGPT account in a browser tab — no API key needed.
            </p>
          </div>
        </div>

        {waiting && (
          <div className="bg-muted/40 rounded-md border px-3 py-3">
            {challenge ? (
              <>
                <div className="text-foreground text-xs font-medium">Authorize in the browser tab</div>
                {challenge.url && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="mt-2 h-8 gap-1.5 px-3"
                    onClick={() => window.open(challenge.url, '_blank', 'noopener,noreferrer')}
                  >
                    <ExternalLink className="size-3.5 shrink-0" />
                    Open auth page
                  </Button>
                )}
                {challenge.code ? (
                  <div className="mt-3">
                    <div className="text-muted-foreground text-xs">Enter this code if prompted</div>
                    <div className="border-border/60 bg-background mt-1 w-fit rounded-md border px-3 py-2 font-mono text-lg font-semibold tracking-normal">
                      {challenge.code}
                    </div>
                  </div>
                ) : null}
              </>
            ) : (
              <div className="text-foreground text-xs font-medium">Starting authorization…</div>
            )}
            <div className="text-muted-foreground mt-3 flex items-center gap-2 text-xs">
              <Loading className="size-3.5 shrink-0" />
              {challenge ? 'Waiting for you to finish in the browser…' : 'Connecting to OpenAI…'}
            </div>
          </div>
        )}

        {phase === 'done' && (
          <div className="text-foreground/80 border-kortix-green/20 bg-kortix-green/[0.06] flex items-start gap-2 rounded-md border px-3 py-2.5 text-xs">
            ChatGPT subscription connected.
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
            compatible={['codex']}
            runtimes={runtimes}
            value={useWith}
            onChange={setUseWith}
          />
        )}

        <div className="flex flex-wrap gap-2">
          {waiting ? (
            <Button type="button" size="sm" variant="outline" className="px-4" onClick={reset}>
              Cancel
            </Button>
          ) : (
            <Button type="button" size="sm" className="px-4" onClick={handleConnect}>
              {error || phase === 'done' ? 'Reconnect ChatGPT' : 'Connect ChatGPT'}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
