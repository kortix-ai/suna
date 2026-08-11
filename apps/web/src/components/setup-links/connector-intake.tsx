'use client';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { cn } from '@/lib/utils';
import {
  CheckIcon as Check,
  ArrowSquareOutIcon as ExternalLink,
  PlugIcon as Plug,
} from '@phosphor-icons/react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { nextConnectorPollDelay } from './connector-poll';
import { setupLinkApiBase } from './util';
import {
  finalizeConnectorSetupLink,
  getConnectorSetupLink,
  startConnectorSetupLink,
  type ConnectorSetupLinkInfo,
} from '@kortix/sdk';

type Phase = 'loading' | 'error' | 'ready' | 'starting' | 'opened' | 'connected';

/**
 * Renders a 1-click Pipedream Quick Connect for an agent-minted connect link.
 * On connect we POST /start to mint a FRESH Pipedream connect URL (the durable
 * link never hands out a stale Pipedream token) and open it in a popup.
 *
 * The popup is on Pipedream's origin and cannot call back into us, so once it
 * is open we poll POST /finalize — the one call that persists the credential
 * and notifies the session that asked for the connector. The Pipedream connect
 * webhook does the same thing server-side, but only as redundancy; this poll is
 * what tells THIS window it worked. Shared by the public /connect/[token] page
 * and the in-chat modal.
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
  const [info, setInfo] = useState<ConnectorSetupLinkInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped every time the popup is opened, so reopening restarts the poll
  // window instead of inheriting an already-expired one.
  const [openedAt, setOpenedAt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const body = await getConnectorSetupLink(token, { backendUrl: base });
        if (cancelled) return;
        setInfo(body);
        setPhase('ready');
      } catch (cause) {
        if (!cancelled) {
          setError(
            cause instanceof Error
              ? cause.message
              : 'Could not reach dosco. Check your connection and try again.',
          );
          setPhase('error');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [base, token]);

  // Ask the API whether the connection landed, until it says yes or the poll
  // window closes. One request is in flight at a time by construction: the next
  // timer is only armed after the current one settles. A failed poll is not
  // fatal — the popup may still be open — so it just schedules the next one.
  useEffect(() => {
    if (phase !== 'opened') return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();
    let attempt = 0;

    const schedule = () => {
      const delay = nextConnectorPollDelay(attempt, Date.now() - startedAt);
      if (delay === null) return;
      attempt += 1;
      timer = setTimeout(poll, delay);
    };

    const poll = async () => {
      try {
        const body = await finalizeConnectorSetupLink(token, { backendUrl: base });
        if (cancelled) return;
        if (body.connected) {
          setPhase('connected');
          return;
        }
      } catch {
        // Transient (offline, rate limit, a 502 from Pipedream) — keep asking.
      }
      if (cancelled) return;
      schedule();
    };

    schedule();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [phase, openedAt, token, base]);

  async function connect() {
    setPhase('starting');
    setError(null);
    try {
      const body = await startConnectorSetupLink(token, { backendUrl: base });
      if (!body.connect_url) {
        setError('Could not start the connect flow.');
        setPhase('ready');
        return;
      }
      window.open(body.connect_url, '_blank', 'noopener,noreferrer,width=520,height=720');
      setOpenedAt(Date.now());
      setPhase('opened');
      onOpened?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not start the connect flow. Try again.');
      setPhase('ready');
    }
  }

  const appLabel = info?.app || info?.slug || 'the app';

  if (phase === 'loading') {
    return (
      <div className="text-muted-foreground flex items-center justify-center gap-2 py-8 text-sm">
        <Loading className="h-4 w-4" />{' '}
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

  if (phase === 'connected') {
    return (
      <div className="flex flex-col items-center gap-2 py-8 text-center">
        <span className="bg-kortix-green/15 flex size-9 items-center justify-center rounded-sm">
          <Check weight="fill" className="text-kortix-green size-5" />
        </span>
        <p className="text-foreground text-sm font-medium">Connected</p>
        <p className="text-muted-foreground max-w-xs text-xs">
          {appLabel} is connected to this project. You can close this window and return to your
          session — the agent has been notified.
        </p>
      </div>
    );
  }

  if (phase === 'opened') {
    return (
      <div className="flex flex-col items-center gap-2 py-8 text-center">
        <span className="bg-muted flex size-9 items-center justify-center rounded-sm">
          <Loading className="size-4" />
        </span>
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
          <Loading className="mr-2 h-4 w-4" />
        ) : (
          <Plug className="mr-2 h-4 w-4" />
        )}
        {starting ? 'Opening…' : `Connect ${appLabel}`}
      </Button>
    </div>
  );
}
