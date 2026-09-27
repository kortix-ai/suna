'use client';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { cn } from '@/lib/utils';
import {
  finalizeConnectorSetupLink,
  startConnectorSetupLink,
  type ConnectorSetupLinkInfo,
} from '@kortix/sdk';
import {
  CheckIcon as Check,
  ArrowSquareOutIcon as ExternalLink,
  PlugIcon as Plug,
} from '@phosphor-icons/react';
import { useTranslations } from '@/i18n/use-translations';
import { useEffect, useState } from 'react';
import { loadConnectorLinkInfo, peekConnectorLinkInfo } from './connector-link-info';
import { nextConnectorPollDelay } from './connector-poll';
import { resolveConnectorStart } from './connector-start';
import { setupLinkApiBase } from './util';

type Phase = 'loading' | 'error' | 'ready' | 'starting' | 'opened' | 'connected';

/**
 * Renders 1-click authorization for an agent-minted connect link.
 *
 * Provider-agnostic on purpose. The server decides who brokers the connector —
 * Composio or Pipedream — and hands back whichever hosted page applies; this
 * component only knows "open the url /start returned, then poll". Naming a
 * provider here is what left a Composio connector reading "via Pipedream".
 *
 * On connect we POST /start for a FRESH url, because the durable link must
 * never hand out a stale provider token, and open it in a popup.
 *
 * The popup is on the provider's origin and cannot call back into us, so once
 * it is open we poll POST /finalize — the one call that persists the credential
 * and notifies the session that asked for the connector. The Pipedream connect
 * webhook does the same thing server-side, but only as redundancy; this poll is
 * what tells THIS window it worked. Shared by the public /connect/[token] page
 * and the in-chat modal.
 */
/**
 * The connect flow for one link: load what it names, open the provider's
 * hosted page, poll until the connection lands. Shared by the public
 * `/connect/[token]` page (`ConnectorIntake`) and the in-chat modal
 * (`ConnectorConnectModal`), so both run the same start/poll/finalize rules.
 */
export function useConnectorIntake(
  token: string,
  { onOpened }: { onOpened?: () => void } = {},
) {
  const base = setupLinkApiBase();
  // Seeded from the link-info cache the chat card already filled (or storage,
  // after a hard refresh), so the dialog opens `ready` with the app's logo on
  // its first frame instead of a loading state.
  const [seed] = useState(() => peekConnectorLinkInfo(token));
  const [phase, setPhase] = useState<Phase>(seed ? 'ready' : 'loading');
  const [info, setInfo] = useState<ConnectorSetupLinkInfo | null>(seed ?? null);
  const [error, setError] = useState<string | null>(null);
  // Bumped every time the popup is opened, so reopening restarts the poll
  // window instead of inheriting an already-expired one.
  const [openedAt, setOpenedAt] = useState(0);
  // Who the account was authorized as, from finalize. Shown on success so a
  // login used by mistake (a personal account on a shared slot) is visible
  // the moment it lands, not months later.
  const [connectedAs, setConnectedAs] = useState<string | null>(null);
  // True when /start found the slot already holding an active account. The
  // provider reuses it instead of re-authorizing, so there was no popup.
  const [alreadyConnected, setAlreadyConnected] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const body = await loadConnectorLinkInfo(token);
        if (cancelled) return;
        setInfo(body);
        setPhase((current) => (current === 'loading' ? 'ready' : current));
      } catch (cause) {
        // A seeded dialog already shows the link; a failed refresh is not an error.
        if (!cancelled && !seed) {
          setError(
            cause instanceof Error
              ? cause.message
              : 'Could not reach Kortix. Check your connection and try again.',
          );
          setPhase('error');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [base, token, seed]);

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
          setConnectedAs(body.connected_as ?? null);
          setPhase('connected');
          return;
        }
      } catch {
        // Transient (offline, rate limit, a 502 from the provider) — keep asking.
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
    const outcome = await resolveConnectorStart({
      start: () => startConnectorSetupLink(token, { backendUrl: base }),
      finalize: () => finalizeConnectorSetupLink(token, { backendUrl: base }),
    });
    if (outcome.kind === 'error') {
      setError(outcome.message);
      setPhase('ready');
      return;
    }
    if (outcome.kind === 'connected') {
      setAlreadyConnected(outcome.alreadyConnected);
      setConnectedAs(outcome.connectedAs);
      setPhase('connected');
      return;
    }
    window.open(outcome.url, '_blank', 'noopener,noreferrer,width=520,height=720');
    setOpenedAt(Date.now());
    setPhase('opened');
    onOpened?.();
  }

  return { phase, info, error, connectedAs, alreadyConnected, connect };
}

export function ConnectorIntake({
  token,
  onOpened,
  onConnected,
  compact,
}: {
  token: string;
  onOpened?: () => void;
  /**
   * Fired once the poll confirms the connection landed.
   *
   * The parent cannot observe this on its own: the connect happens in
   * Pipedream's hosted popup, and the only proof is the finalize poll below.
   * `SetupLinkButton` uses it to flip its card from "Waiting for you" to
   * "Connected" without reopening the modal.
   */
  onConnected?: () => void;
  compact?: boolean;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const { phase, info, error, connectedAs, alreadyConnected, connect } = useConnectorIntake(
    token,
    { onOpened },
  );

  const appLabel = info?.app || info?.slug || 'the app';

  useEffect(() => {
    if (phase === 'connected') onConnected?.();
  }, [phase, onConnected]);

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
        {error || tI18nHardcoded.raw('i18nComplete.text5998ac369aec')}
      </div>
    );
  }

  if (phase === 'connected') {
    return (
      <div className="flex flex-col items-center gap-2 py-8 text-center">
        <span className="bg-kortix-green/15 flex size-9 items-center justify-center rounded-sm">
          <Check weight="fill" className="text-kortix-green size-5" />
        </span>
        <p className="text-foreground text-sm font-medium">
          {alreadyConnected
            ? tI18nHardcoded.raw('i18nComplete.textbe03b81f11cb')
            : tI18nHardcoded.raw('i18nComplete.text22965568d22a')}
        </p>
        {connectedAs ? (
          <p className="text-foreground text-sm" data-testid="connector-intake-connected-as">
            {tI18nHardcoded('i18nComplete.texte9e0b20cf289', { value0: connectedAs })}
          </p>
        ) : null}
        <p className="text-muted-foreground max-w-xs text-xs">
          {appLabel} {tI18nHardcoded.raw('i18nComplete.text27fd394a8fbd')}
        </p>
        {alreadyConnected ? (
          <p className="text-muted-foreground max-w-xs text-xs">
            {tI18nHardcoded.raw('i18nComplete.text0223e507afd3')}
          </p>
        ) : null}
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
        {tI18nHardcoded.raw('autoComponentsSetupLinksConnectorIntakeJsxText1ClickConnect9e029325')}{' '}
        <span className="text-foreground font-medium">{appLabel}</span>{' '}
        {tI18nHardcoded.raw('autoComponentsSetupLinksConnectorIntakeJsxTextViaPipedreamNo5dadf477')}
      </p>
      {error ? <p className="text-destructive text-xs">{error}</p> : null}
      <Button className="w-full" onClick={connect} disabled={starting}>
        {starting ? <Loading className="mr-2 h-4 w-4" /> : <Plug className="mr-2 h-4 w-4" />}
        {starting ? tI18nHardcoded.raw('i18nComplete.textc926c2c50e65') : `Connect ${appLabel}`}
      </Button>
    </div>
  );
}
