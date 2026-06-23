'use client';

import { Button } from '@/components/ui/button';
import { successToast } from '@/components/ui/toast';
import { ProviderLogo } from '@/features/providers/provider-branding';
import {
  isSharingComplete,
  selectionToIntent,
  type SharingSelection,
} from '@/features/workspace/shared/sharing-picker';
import {
  pollProjectProviderOAuth,
  startProjectProviderOAuth,
} from '@/lib/projects-client';
import { useQueryClient } from '@tanstack/react-query';
import { AlertCircle, ExternalLink, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { ChatGptChallenge, ChatGptPhase } from './types';
import { sleep } from './utils';

export function ChatGptSubscriptionConnect({
  projectId,
  sharing,
  onConnected,
}: {
  projectId: string;
  sharing: SharingSelection;
  onConnected: () => void;
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
          successToast('ChatGPT subscription connected to this project');
          queryClient.invalidateQueries({ queryKey: ['project-secrets', projectId] });
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
  }, [projectId, sharing, queryClient, onConnected]);

  const waiting = phase === 'waiting';

  return (
    <div className="border-border/50 bg-muted/20 rounded-2xl border p-4">
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
        <div className="border-border/50 bg-background/70 mt-3 rounded-2xl border p-3">
          {challenge ? (
            <>
              <div className="text-foreground text-xs font-medium">
                {tHardcodedUi.raw(
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
                  {tHardcodedUi.raw(
                    'autoComponentsProjectsProjectProviderModalJsxTextOpenAuthPaged0381841',
                  )}
                </Button>
              )}
              {challenge.code ? (
                <div className="mt-3">
                  <div className="text-muted-foreground text-xs">
                    {tHardcodedUi.raw(
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
              {tHardcodedUi.raw(
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
          {tHardcodedUi.raw(
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
    </div>
  );
}
