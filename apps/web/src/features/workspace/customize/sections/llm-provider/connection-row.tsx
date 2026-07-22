'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ProviderLogo } from '@/features/providers/provider-branding';
import {
  CONNECTION_ICON_PROVIDER_ID,
  type ModelsPageConnection,
  notExposedCatalogText,
} from '@kortix/sdk/react';

import { connectionStatusBadge } from './connection-status';

export function catalogLine(connection: ModelsPageConnection): string {
  if (connection.catalogState === 'not-exposed') {
    return notExposedCatalogText(connection.kind) ?? 'Model catalog not exposed';
  }
  if (connection.catalogState === 'loading') return 'Loading models…';
  if (connection.catalogState === 'error') return 'Could not load models';
  const count = connection.modelCount ?? 0;
  return `${count} model${count === 1 ? '' : 's'} available`;
}

// The service subtitle describes the SERVICE only — the models it unlocks and
// its health. Which agent uses it now lives on the agent rows above, so this
// no longer echoes a "Used by …" clause back at them (that mutual
// cross-reference was the confusing part of the old two-list page).
export function metadataLine(connection: ModelsPageConnection): string {
  if (connection.status === 'needs-attention') {
    return `Needs attention · ${connection.statusReason ?? 'Reconnect to continue'}`;
  }
  // Kortix is the home of the project default model — say so plainly so a user
  // hunting for it knows to open this row.
  if (connection.kind === 'managed_gateway') {
    return `Included · ${catalogLine(connection)} · sets your default model`;
  }
  return catalogLine(connection);
}

export function ConnectionRow({
  connection,
  canWrite,
  onManage,
}: {
  connection: ModelsPageConnection;
  canWrite: boolean;
  onManage: (connectionId: string) => void;
}) {
  return (
    <li className="bg-popover rounded-md border px-4 py-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <ProviderLogo
            providerID={CONNECTION_ICON_PROVIDER_ID[connection.kind] ?? connection.kind}
            name={connection.name}
            size="default"
          />
          <div className="min-w-0 flex-1 space-y-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-foreground truncate text-sm font-medium">
                {connection.name}
              </span>
              <Badge variant={connectionStatusBadge(connection.status).variant} size="sm">
                {connectionStatusBadge(connection.status).label}
              </Badge>
            </div>
            <p className="text-muted-foreground truncate text-xs text-pretty">
              {metadataLine(connection)}
            </p>
          </div>
        </div>
        <div className="shrink-0 sm:self-center">
          <Button
            size="sm"
            variant="outline"
            className="min-h-10 active:scale-[0.96] transition-transform"
            onClick={() => onManage(connection.id)}
          >
            {canWrite ? 'Manage' : 'View'}
          </Button>
        </div>
      </div>
    </li>
  );
}
