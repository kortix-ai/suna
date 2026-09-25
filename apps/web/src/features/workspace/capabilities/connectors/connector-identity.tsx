'use client';

import { useTranslations } from '@/i18n/use-translations';
import type { AdminConnector } from '@kortix/sdk';
import {
  CubeIcon as Boxes,
  CheckIcon,
  EnvelopeSimpleIcon as Envelope,
  GlobeIcon as Globe,
  type Icon as LucideIcon,
  ChatIcon as MessageSquare,
  MonitorIcon as Monitor,
  PlugIcon as Plug,
  LightningIcon as Zap,
} from '@phosphor-icons/react';
import Image from 'next/image';
import { type ReactNode, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { connectorSetupStatus } from '@/features/workspace/customize/sections/connector-connection-form';
import { cn } from '@/lib/utils';
import { type ConnectorGlyph, connectorIconFace } from './connector-icon-face';
import { SlackLogo } from './slack-logo';

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
 * `GLYPH_ICON` and the tile-size helper came along because nothing else in
 * the old file used them.
 */

const GLYPH_ICON: Record<ConnectorGlyph, LucideIcon> = {
  app: Plug,
  automation: Zap,
  mcp: Boxes,
  web: Globe,
  chat: MessageSquare,
  email: Envelope,
  computer: Monitor,
};

function appIconTileClass(size: 'sm' | 'lg'): string {
  return size === 'lg' ? 'size-10 rounded-md' : 'size-6 rounded-sm';
}

/**
 * A logo in the connector icon tile, or `fallback` when the image fails.
 *
 * The one tile every connector surface paints a logo in: the connectors grid
 * and detail header (`ConnectorAppIcon`) and the add flow
 * (`ConnectorConnectionIcon`), so an app looks the same before and after it is
 * connected. Logos are third-party URLs (Composio, Pipedream, integrations.sh);
 * one that 404s or is blocked falls back to the glyph tile instead of leaving
 * an empty bordered box.
 */
export function ConnectorLogoTile({
  src,
  fallback,
  size = 'lg',
}: {
  src: string;
  fallback: ReactNode;
  size?: 'sm' | 'lg';
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (failedSrc === src) return <>{fallback}</>;
  return (
    <span
      className={cn(
        'border-border/60 bg-card relative flex shrink-0 items-center justify-center overflow-hidden border',
        appIconTileClass(size),
      )}
    >
      <Image
        src={src}
        alt=""
        referrerPolicy="no-referrer"
        fill
        sizes={size === 'lg' ? '40px' : '28px'}
        className="object-contain"
        unoptimized
        onError={() => setFailedSrc(src)}
      />
    </span>
  );
}

export function ConnectorAppIcon({
  connector,
  size = 'lg',
}: {
  connector: AdminConnector;
  size?: 'sm' | 'lg';
}) {
  const face = connectorIconFace(connector);
  const glyphTile = (
    <EntityAvatar
      icon={GLYPH_ICON[face.kind === 'glyph' ? face.glyph : 'app']}
      size={size}
      label={connector.name}
    />
  );

  if (face.kind === 'image') {
    return <ConnectorLogoTile src={face.src} size={size} fallback={glyphTile} />;
  }
  if (face.kind === 'slack') {
    return (
      <span
        className={cn(
          'border-border/60 bg-card flex shrink-0 items-center justify-center border',
          appIconTileClass(size),
        )}
      >
        <SlackLogo className={size === 'lg' ? 'size-5' : 'size-3.5'} />
      </span>
    );
  }
  return glyphTile;
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
        {tI18nHardcoded.raw('i18nComplete.text54a0e8c17ebb')}
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
