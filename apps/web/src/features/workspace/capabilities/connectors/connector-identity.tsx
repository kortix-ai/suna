'use client';

import type { AdminConnector } from '@kortix/sdk';
import {
  CubeIcon as Boxes,
  CheckIcon,
  GlobeIcon as Globe,
  type Icon as LucideIcon,
  ChatIcon as MessageSquare,
  MonitorIcon as Monitor,
  PlugIcon as Plug,
  LightningIcon as Zap,
} from '@phosphor-icons/react';
import { useTranslations } from 'next-intl';
import Image from 'next/image';

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
 * components and pulls `@pipedream/sdk/browser`, `HighlightedCode`,
 * `PoliciesPanel`, `DiscoverCatalogue` and `ConnectorConnectionModal`. Importing
 * two small components from there put that entire graph in this route's client
 * chunk — an ES module is all-or-nothing to the bundler.
 *
 * `PROVIDER_ICON` and the tile-size helper came along because nothing else in
 * the old file used them.
 */

const PROVIDER_ICON: Record<AdminConnector['provider'], LucideIcon> = {
  pipedream: Zap,
  mcp: Boxes,
  openapi: Globe,
  postman: Globe,
  graphql: Globe,
  http: Globe,
  channel: MessageSquare,
  computer: Monitor,
};

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
  const imgSrc = connector.iconUrl ?? null;

  if (imgSrc) {
    return (
      <span
        className={cn(
          'border-border/60 bg-card flex shrink-0 items-center justify-center overflow-hidden border',
          'relative',
          appIconTileClass(size),
        )}
      >
        <Image
          src={imgSrc}
          alt=""
          referrerPolicy="no-referrer"
          fill
          sizes={size === 'lg' ? '40px' : '28px'}
          className="object-contain"
          unoptimized
        />
      </span>
    );
  }
  return (
    <EntityAvatar
      icon={PROVIDER_ICON[connector.provider] ?? Plug}
      size={size}
      label={connector.name}
    />
  );
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
  const status = connectorSetupStatus(connector);
  if (status === 'error')
    return (
      <Badge variant="destructive" size="sm">
        Error
      </Badge>
    );
  if (status === 'no_auth')
    return (
      <Badge variant="outline" size="sm">
        {tI18nHardcoded.raw(
          'autoComponentsProjectsCustomizeSectionsConnectorsViewJsxTextNoAuth45c43558',
        )}
      </Badge>
    );
  if (status === 'user_managed')
    return (
      <Badge variant="outline" size="sm">
        User-managed
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
