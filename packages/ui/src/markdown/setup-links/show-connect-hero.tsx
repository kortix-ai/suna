'use client';

import { LockSimpleIcon } from '@phosphor-icons/react';
import React, { useCallback, useState } from 'react';
import { useLocalizedUiCatalog } from '../../i18n/ui-catalog/use-localized-ui-catalog';
import { Button } from '../../primitives/button';
import { useUiComponents } from '../../providers/ui-provider';
import { ConnectorHandshake } from './connector-handshake';
import { connectorHeadline, useConnectorLinkInfo } from './connector-link-info';
import { onSetupLinkModalClose } from './setup-link-close-finalize';
import { parseSetupLinkHref } from './util';

const COPY = {
  title: 'Connect {app}',
  connectedTitle: '{app} connected',
  connectedDescription: 'Your agent can use {app} now and continues on its own.',
  connect: 'Connect {app}',
  view: 'View',
  trust: 'You sign in on {app}. Kortix never sees your password.',
  secureHost: 'Secure sign-in at {host}',
  fallbackApp: 'the app',
} as const;

/** Provider-hosted sign-in pages an agent may show instead of a Kortix link. */
const PROVIDER_HOSTS = /(^|\.)(composio\.dev|pipedream\.com)$/i;

export type ShowConnectTarget =
  | { kind: 'kortix'; token: string }
  | { kind: 'provider'; host: string };

/**
 * A `show` URL that is a connect step, not a page: a Kortix link, a provider's
 * sign-in page, or any URL the agent titled "Connect <app>". A connection URL
 * never falls back to the plain link card.
 */
export function showConnectTarget(url: string, title = ''): ShowConnectTarget | null {
  const setup = parseSetupLinkHref(url);
  if (setup?.kind === 'connector') return { kind: 'kortix', token: setup.token };
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  if (PROVIDER_HOSTS.test(host) || /^connect\s+\S/i.test(title.trim())) {
    return { kind: 'provider', host };
  }
  return null;
}

/** "Connect Snaps YouTube" → "Snaps YouTube"; the agent's own title names the app. */
function appFromTitle(title: string): string {
  return title.replace(/^connect\s+/i, '').trim();
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? '');
}

/**
 * The `show` panel for a connect URL (Paper, "Show tool · connect URL panel" 01):
 * the Kortix ··· app handshake, one title, the agent's sentence, one action.
 *
 * A Kortix link opens the host's connect dialog in place and turns into the
 * connected record once the account lands. A provider page opens in a sign-in
 * window; its app comes from the agent's title, never the provider's favicon.
 */
export function ShowConnectHero({
  url,
  target,
  title,
  description,
}: {
  url: string;
  target: ShowConnectTarget;
  title: string;
  description: string;
}) {
  const copy = useLocalizedUiCatalog(COPY);
  const { ConnectorConnectModal } = useUiComponents();
  const token = target.kind === 'kortix' ? target.token : null;
  const info = useConnectorLinkInfo(token);
  const [settledHere, setSettledHere] = useState(false);
  const [open, setOpen] = useState(false);

  const headline = info ? connectorHeadline(info) : null;
  const app = headline?.app || appFromTitle(title) || copy.fallbackApp;
  const connected = settledHere || info?.connected === true;
  // `undefined` while a Kortix link's info loads (skeleton tile). With no icon on
  // the link, the catalogue logo by slug (as `approval-decision.tsx` does); a
  // 404 there falls back to the neutral glyph inside `ConnectorLogo`.
  const logoSlug = info?.slug || app.toLowerCase().replace(/[^a-z0-9]/g, '');
  const iconUrl =
    token && info === undefined
      ? undefined
      : (info?.icon_url ?? `https://logos.composio.dev/api/${encodeURIComponent(logoSlug)}`);
  const inApp = token !== null && !!ConnectorConnectModal;

  const handleSettled = useCallback(() => setSettledHere(true), []);
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (token) void onSetupLinkModalClose({ open: next, kind: 'connector', token });
  };
  const onAction = () => {
    if (inApp) setOpen(true);
    else window.open(url, '_blank', 'noopener,noreferrer,width=520,height=720');
  };

  return (
    <div
      className="flex w-full max-w-sm flex-col items-center gap-4 py-6 text-center"
      data-testid="show-connect-hero"
      data-connected={connected || undefined}
    >
      <ConnectorHandshake
        name={app}
        iconUrl={iconUrl}
        connected={connected}
        size="lg"
        collapsible={false}
      />
      <div className="flex flex-col gap-0.5">
        <h3 className="text-foreground text-sm font-medium">
          {fill(connected ? copy.connectedTitle : copy.title, { app })}
        </h3>
        {connected || description ? (
          <p className="text-muted-foreground text-sm font-normal text-pretty">
            {connected ? fill(copy.connectedDescription, { app }) : description}
          </p>
        ) : null}
      </div>
      <div className="flex flex-col items-center gap-2">
        <Button size="sm" variant={connected ? 'outline' : 'default'} onClick={onAction}>
          {connected ? copy.view : fill(copy.connect, { app })}
        </Button>
        {connected ? null : (
          <p className="text-muted-foreground flex items-center gap-1.5 text-xs font-normal">
            {target.kind === 'provider' ? (
              <>
                <LockSimpleIcon className="size-3 shrink-0" />
                {fill(copy.secureHost, { host: target.host })}
              </>
            ) : (
              fill(copy.trust, { app })
            )}
          </p>
        )}
      </div>

      {token && ConnectorConnectModal ? (
        <ConnectorConnectModal
          token={token}
          open={open}
          onOpenChange={handleOpenChange}
          onConnected={handleSettled}
          fallbackName={app}
        />
      ) : null}
    </div>
  );
}
