'use client';

import { useTranslations } from '../../i18n';
import type { AdminConnector } from '@kortix/sdk';
import {
  CheckIcon,
} from '@phosphor-icons/react';

import { Badge } from '../../primitives/badge';
import { connectorSetupStatus } from '../sections/connector-connection-form';
import { cn } from '../../internal/lib/utils';

/**
 * How a connector presents its status — the connected mark and the status
 * pill. Its logo is `ConnectorLogo` (`connector-logo.tsx`), shared by every
 * connector surface.
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
