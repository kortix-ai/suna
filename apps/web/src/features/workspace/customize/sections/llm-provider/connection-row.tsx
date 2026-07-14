'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ProviderLogo } from '@/features/providers/provider-branding';
import { harnessLabel, type ModelsPageConnection } from '@kortix/sdk/react';

const CONNECTION_ICON_PROVIDER_ID: Record<string, string> = {
  managed_gateway: 'kortix',
  claude_subscription: 'anthropic',
  codex_subscription: 'codex',
  anthropic_api_key: 'anthropic',
  openai_api_key: 'openai',
};

const NOT_EXPOSED_TEXT: Record<string, string> = {
  claude_subscription: 'Models managed by Claude Code',
  codex_subscription: 'Models managed by Codex',
  native_config: 'Model catalog not exposed',
};

function joinAnd(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function catalogLine(connection: ModelsPageConnection): string {
  if (connection.catalogState === 'not-exposed') {
    return NOT_EXPOSED_TEXT[connection.kind] ?? 'Model catalog not exposed';
  }
  if (connection.catalogState === 'loading') return 'Loading models…';
  if (connection.catalogState === 'error') return 'Could not load models';
  const count = connection.modelCount ?? 0;
  return `${count} model${count === 1 ? '' : 's'} available`;
}

function metadataLine(connection: ModelsPageConnection): string {
  if (connection.status === 'needs-attention') {
    return `Needs attention · ${connection.statusReason ?? 'Reconnect to continue'}`;
  }
  const usedByText =
    connection.usedBy.length === 0
      ? 'Not currently used'
      : `Used by ${joinAnd(connection.usedBy.map(harnessLabel))}`;
  return `${usedByText} · ${catalogLine(connection)}`;
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
              <span className="text-foreground truncate text-sm font-medium">{connection.name}</span>
              <Badge
                variant={
                  connection.status === 'ready'
                    ? 'success'
                    : connection.status === 'needs-attention' || connection.status === 'unavailable'
                      ? 'destructive'
                      : 'secondary'
                }
                size="sm"
              >
                {connection.status === 'ready'
                  ? 'Connected'
                  : connection.status === 'needs-attention'
                    ? 'Needs attention'
                    : connection.status === 'unavailable'
                      ? 'Unavailable'
                      : 'Checking'}
              </Badge>
            </div>
            <p className="text-muted-foreground truncate text-xs text-pretty">{metadataLine(connection)}</p>
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
