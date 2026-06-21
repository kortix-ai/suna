'use client';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Check, ExternalLink, Loader2, Plug } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { setupLinkApiBase } from './util';

interface ConnectorLinkInfo {
  project_name: string;
  slug: string;
  app: string | null;
  expires_at: string;
}

type Phase = 'loading' | 'error' | 'ready' | 'starting' | 'opened';

/**
 * Renders a 1-click Pipedream Quick Connect for an agent-minted connect link.
 * On connect we POST /start to mint a FRESH Pipedream connect URL (the durable
 * link never hands out a stale Pipedream token) and open it in a popup. The
 * Pipedream connect webhook persists the credential server-side, so there's no
 * explicit finalize step here. Shared by the public /connect/[token] page and
 * the in-chat modal.
 */
export function ConnectorIntake({
  token,
  onOpened,
  compact,
}: {
  token: string;
  onOpened?: () => void;
  compact?: boolean;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const base = setupLinkApiBase();
  const [phase, setPhase] = useState<Phase>('loading');
  const [info, setInfo] = useState<ConnectorLinkInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${base}/setup-links/connector/${encodeURIComponent(token)}`);
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setError(body?.error || 'This link is invalid or has expired.');
          setPhase('error');
          return;
        }
        setInfo(body);
        setPhase('ready');
      } catch {
        if (!cancelled) {
          setError('Could not reach Kortix. Check your connection and try again.');
          setPhase('error');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [base, token]);

  async function connect() {
    setPhase('starting');
    setError(null);
    try {
      const res = await fetch(`${base}/setup-links/connector/${encodeURIComponent(token)}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body?.connect_url) {
        setError(body?.error || 'Could not start the connect flow.');
        setPhase('ready');
        return;
      }
      window.open(body.connect_url, '_blank', 'noopener,noreferrer,width=520,height=720');
      setPhase('opened');
      onOpened?.();
    } catch {
      setError('Could not start the connect flow. Try again.');
      setPhase('ready');
    }
  }

  const appLabel = info?.app || info?.slug || 'the app';

  if (phase === 'loading') {
    return (
      <div className="text-muted-foreground flex items-center justify-center gap-2 py-8 text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />{' '}
        {tI18nHardcoded.raw('autoComponentsSetupLinksConnectorIntakeJsxTextLoading4e5fd209')}
      </div>
    );
  }

  if (phase === 'error') {
    return (
      <div className="text-muted-foreground py-6 text-center text-sm">
        {error || 'This link is invalid or has expired.'}
      </div>
    );
  }

  if (phase === 'opened') {
    return (
      <div className="flex flex-col items-center gap-2 py-8 text-center">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-500">
          <Check className="h-5 w-5" />
        </div>
        <p className="text-foreground text-sm font-medium">
          {tI18nHardcoded.raw('autoComponentsSetupLinksConnectorIntakeJsxTextFinishInThe0a10e77c')}
        </p>
        <p className="text-muted-foreground max-w-xs text-xs">
          {tI18nHardcoded.raw('autoComponentsSetupLinksConnectorIntakeJsxTextCompleteThe07661028')}
          {appLabel}{' '}
          {tI18nHardcoded.raw('autoComponentsSetupLinksConnectorIntakeJsxTextSignInIn5b6c05ee')}
        </p>
        <Button variant="ghost" size="sm" className="mt-1" onClick={connect}>
          <ExternalLink className="mr-2 h-3.5 w-3.5" />{' '}
          {tI18nHardcoded.raw(
            'autoComponentsSetupLinksConnectorIntakeJsxTextReopenConnectWindowb7f822cd',
          )}
        </Button>
      </div>
    );
  }

  const starting = phase === 'starting';

  return (
    <div className={cn('space-y-4 text-center', compact ? '' : 'mt-2')}>
      <p className="text-muted-foreground text-sm">
        {tI18nHardcoded.raw('autoComponentsSetupLinksConnectorIntakeJsxText1ClickConnect9e029325')}
        <span className="text-foreground font-medium">{appLabel}</span>{' '}
        {tI18nHardcoded.raw('autoComponentsSetupLinksConnectorIntakeJsxTextViaPipedreamNo5dadf477')}
      </p>
      {error ? <p className="text-destructive text-xs">{error}</p> : null}
      <Button className="w-full" onClick={connect} disabled={starting}>
        {starting ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <Plug className="mr-2 h-4 w-4" />
        )}
        {starting ? 'Opening…' : `Connect ${appLabel}`}
      </Button>
    </div>
  );
}
