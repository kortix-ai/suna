'use client';

import type { AdminConnector } from '@kortix/sdk';
import {
  CheckIcon,
} from '@phosphor-icons/react';

import { useTranslations } from '../../i18n';
import { ConnectorLogo } from '../../internal/connector-logo/connector-logo';
import type { ConnectorLogoSource } from '../../internal/connector-logo/connector-logo-source';
import { STATUS_DOT, STATUS_WORD, connectorStatusTone } from './detail/connector-status';
import { ConnectorStatusBadge as ToneBadge } from './detail/status-badge';
import { cn } from '../../internal/lib/utils';

/**
 * How a connector presents its status — the connected mark and the status
 * pill. Its logo is `ConnectorLogo` (`connector-logo.tsx`), shared by every
 * connector surface.
 *
 * These two render once per card in the connectors grid, so they sit on the
 * hottest path of `/projects/[id]/connectors`. They used to live in
 * `customize/sections/connectors-view.tsx`, which is ~5,100 lines across 50
 * components and pulls `HighlightedCode` and `PoliciesPanel`. Importing
 * two small components from there put that entire graph in this route's client
 * chunk — an ES module is all-or-nothing to the bundler.
 *
 * The tile-size helper came along because nothing else in the old file used it.
 */

/**
 * Green `✓` for a healthy project connector — same glyph Discovery/All use in
 * the catalogue card's `trailing` slot. Not a badge: problem states keep the
 * text pills in {@link ConnectorStatusBadge}; connected is affirmative and
 * stays a mark, not a chip.
 */
export function ConnectorConnectedMark({ className }: { className?: string } = {}) {
  return (
    <CheckIcon
      aria-hidden
      weight="bold"
      className={cn('text-kortix-green size-4 shrink-0', className)}
      data-testid="catalog-connected"
    />
  );
}

/**
 * The state pill for a project connector: Needs account or Error. Connected
 * returns `null`: put {@link ConnectorConnectedMark} in the card's `trailing`
 * slot instead, the catalogue's `✓`.
 */
export function ConnectorStatusBadge({
  connector,
  accountCount,
}: {
  connector: AdminConnector;
  accountCount?: number;
}) {
  const tone = connectorStatusTone(connector, accountCount);
  return tone === 'connected' ? null : <ToneBadge tone={tone} />;
}


/**
 * A project connector's logo with its state on it, the way a Slack or Teams
 * app tile shows one: a dot on the bottom-right corner (green Connected,
 * orange Needs account, red Error). The word is for screen readers; the dot
 * carries it on screen.
 */
export function ConnectorStatusLogo({
  connector,
  source,
  accountCount,
}: {
  connector: AdminConnector;
  source: ConnectorLogoSource;
  accountCount?: number;
}) {
  const t = useTranslations('connectorPages');
  const tone = connectorStatusTone(connector, accountCount);
  return (
    <span className="relative flex shrink-0">
      <ConnectorLogo source={source} size="lg" />
      <span aria-hidden className="bg-background absolute -right-1 -bottom-1 flex size-3 items-center justify-center rounded-full">
        <span className={cn('size-2 rounded-full', STATUS_DOT[tone])} />
      </span>
      <span className="sr-only">{t(STATUS_WORD[tone])}</span>
    </span>
  );
}
