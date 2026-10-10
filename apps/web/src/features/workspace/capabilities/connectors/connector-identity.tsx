'use client';

import type { AdminConnector } from '@kortix/sdk';
import {
  CheckIcon,
  ChatIcon as MessageSquare,
  MonitorIcon as Monitor,
} from '@phosphor-icons/react';
import { useTranslations } from '@/i18n/use-translations';
import Image from 'next/image';
import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { connectorSetupStatus } from '@/features/workspace/customize/sections/connector-connection-form';
import { cn } from '@/lib/utils';

/**
 * How a connector presents itself — its icon tile and its status pill.
 *
 * These two render once per card in the connectors grid, so they sit on the
 * hottest path of `/projects/[id]/connectors`. They used to live in
 * `customize/sections/connectors-view.tsx`, which is ~5,100 lines across 50
 * components and pulls `HighlightedCode`,
 * `PoliciesPanel`, `DiscoverCatalogue` and `ConnectorConnectionModal`. Importing
 * two small components from there put that entire graph in this route's client
 * chunk — an ES module is all-or-nothing to the bundler.
 *
 * The tile-size helper came along because nothing else in the old file used it.
 */

function appIconTileClass(size: 'sm' | 'lg'): string {
  return size === 'lg' ? 'size-10 rounded-md' : 'size-6 rounded-sm';
}

export function ConnectorAppIcon({
  connector,
  size = 'lg',
}: {
  connector: AdminConnector;
  size?: 'sm' | 'lg';
}) {
  const [broken, setBroken] = useState(false);
  const imgSrc = connector.iconUrl ?? null;

  if (imgSrc && !broken) {
    return (
      <span
        // The catalogue grid card's logo (`connector-browse.tsx`): the bare
        // image, no tile, so an app looks the same on every connector surface.
        className={cn(
          'relative flex shrink-0 items-center justify-center overflow-hidden rounded-sm',
          size === 'lg' ? 'size-9' : 'size-6',
        )}
      >
        <Image
          src={imgSrc}
          alt=""
          referrerPolicy="no-referrer"
          fill
          sizes={size === 'lg' ? '36px' : '24px'}
          className="object-contain"
          unoptimized
          onError={() => setBroken(true)}
        />
      </span>
    );
  }
  // No logo: a channel or a computer keeps its own glyph, because that glyph
  // says what it is. An app shows its first letter. A plug says only "some app".
  const glyph =
    connector.provider === 'channel'
      ? MessageSquare
      : connector.provider === 'computer'
        ? Monitor
        : undefined;
  return <EntityAvatar icon={glyph} size={size} label={connector.name} />;
}

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
 * Problem / setup pills for a project connector. Deliberately returns `null`
 * when status is `connected` — put {@link ConnectorConnectedMark} in the card's
 * `trailing` slot instead so Connected matches Discovery's `✓` affordance.
 */
export function ConnectorStatusBadge({ connector }: { connector: AdminConnector }) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const tPages = useTranslations('connectorPages');
  const status = connectorSetupStatus(connector);
  if (status === 'pending')
    return (
      <Badge variant="info" size="sm">
        {tPages('statusPending')}
      </Badge>
    );
  if (status === 'error')
    return (
      <Badge variant="destructive" size="sm">
        {tI18nHardcoded.raw('i18nComplete.text54a0e8c17ebb')}
      </Badge>
    );
  if (status === 'user_managed')
    return (
      <Badge variant="outline" size="sm">
        {tI18nHardcoded.raw('i18nComplete.text82bcb52dba1e')}
      </Badge>
    );
  if (status === 'needs_setup')
    return (
      <Badge variant="info" size="sm">
        {tI18nHardcoded.raw(
          'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxTextNeedsSetupbefdbc49',
        )}
      </Badge>
    );
  return null;
}
