'use client';

import { PlugIcon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';

import { EntityAvatar } from '@/components/ui/entity-avatar';
import { ConnectorLogoTile } from '@/features/workspace/capabilities/connectors/connector-identity';
import { cn } from '@/lib/utils';

/**
 * The icon tile for a connector that does not exist yet. `ConnectorAppIcon`
 * (`capabilities/connectors/connector-identity.tsx`) needs an `AdminConnector`;
 * the add flow has a catalogue app — an image URL and a name, nothing more.
 * Both paint through `ConnectorLogoTile`, so the two are indistinguishable on
 * screen.
 */
export function ConnectorConnectionIcon({ src, name }: { src?: string | null; name: string }) {
  const glyphTile = <EntityAvatar icon={PlugIcon} size="lg" label={name} />;
  if (src) return <ConnectorLogoTile src={src} size="lg" fallback={glyphTile} />;
  return glyphTile;
}

/**
 * A connector's identity block — icon, name, byline, description —
 * shared by the add flow (`ConnectorConnectionModal`) and the detail modal
 * (`connector-modal.tsx`), so "what is this thing?" is answered by the same
 * layout in both places.
 *
 * Everything except `icon` and `name` is optional; a custom connector with
 * no catalogue record simply renders less. `nameSlot` swaps the plain name
 * for a caller-owned control (the detail modal's inline rename, or Radix's
 * `ModalTitle`) without changing the rhythm around it.
 */
export function ConnectorConnectionHeader({
  icon,
  name,
  nameSlot,
  byline,
  meta,
  status,
  description,
  className,
}: {
  icon: ReactNode;
  name: string;
  nameSlot?: ReactNode;
  /** e.g. "by Pipedream" — the catalogue the app came from. */
  byline?: string | null;
  /** Small muted facts after the byline: tool count, slug. */
  meta?: ReactNode;
  /** Badges trailing the name: provider, connection status. */
  status?: ReactNode;
  description?: string | null;
  className?: string;
}) {
  return (
    <div className={cn('flex items-start gap-3.5', className)}>
      {icon}
      <div className="min-w-0 flex-1 space-y-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {nameSlot ?? (
            <span className="text-foreground truncate text-lg font-semibold">{name}</span>
          )}
          {status}
        </div>
        {byline || meta ? (
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            {byline ? <span>{byline}</span> : null}
            {meta}
          </div>
        ) : null}
        {description ? (
          <p className="text-muted-foreground text-sm text-pretty">{description}</p>
        ) : null}
      </div>
    </div>
  );
}
