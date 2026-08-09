'use client';

import type { AdminConnector } from '@kortix/sdk';
import { formatRelative } from '@kortix/shared';
import { ArrowRightIcon, MonitorIcon } from '@phosphor-icons/react';
import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { InlineMeta } from '@/components/ui/inline-meta';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/features/layout/section/error-state';
import { useTunnelConnections } from '@/hooks/tunnel/use-tunnel';
import { useTunnelRealtimeSync } from '@/hooks/tunnel/use-tunnel-realtime';
import { cn } from '@/lib/utils';

const COMPUTER_PROFILE_PREFIX = 'computer-';

/** The per-machine connector slug contains the immutable tunnel UUID. */
export function computerTunnelId(slug: string): string | null {
  if (!slug.startsWith(COMPUTER_PROFILE_PREFIX)) return null;
  const tunnelId = slug.slice(COMPUTER_PROFILE_PREFIX.length);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tunnelId)
    ? tunnelId.toLowerCase()
    : null;
}

function machineValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function ComputerConnectorAccount({
  projectId,
  connector,
}: {
  projectId: string;
  connector: AdminConnector;
}) {
  const tunnelId = computerTunnelId(connector.slug);
  const connectionsQuery = useTunnelConnections();
  useTunnelRealtimeSync();

  if (connectionsQuery.isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-4 w-20 rounded-sm" />
        <Skeleton className="h-32 rounded-md" />
      </div>
    );
  }

  if (connectionsQuery.isError) {
    return (
      <ErrorState
        size="sm"
        title="Couldn’t load this computer"
        description={
          connectionsQuery.error instanceof Error
            ? connectionsQuery.error.message
            : 'The computer connection could not be read.'
        }
        action={
          <Button variant="outline" size="sm" onClick={() => void connectionsQuery.refetch()}>
            Retry
          </Button>
        }
      />
    );
  }

  const connection = connectionsQuery.data?.find((item) => item.tunnelId === tunnelId);
  if (!tunnelId || !connection) {
    return (
      <ErrorState
        size="sm"
        title="Computer disconnected"
        description="This connector profile no longer has a connected computer. Refresh the connector list to remove it."
      />
    );
  }

  const hostname = machineValue(connection.machineInfo.hostname);
  const platform = machineValue(connection.machineInfo.platform);
  const arch = machineValue(connection.machineInfo.arch);
  const lastSeen = connection.lastHeartbeatAt
    ? (formatRelative(connection.lastHeartbeatAt, { maxRelativeDays: null }) ?? 'Unknown')
    : 'Never';

  return (
    <section className="space-y-2">
      <Label>Computer</Label>
      <div className="bg-popover overflow-hidden rounded-md border">
        <div className="flex flex-col gap-4 px-4 py-5 sm:flex-row sm:items-start">
          <span
            className={cn(
              'flex size-9 shrink-0 items-center justify-center rounded-sm',
              connection.isLive
                ? 'bg-kortix-green/15 text-kortix-green'
                : 'bg-primary/5 text-muted-foreground',
            )}
          >
            <MonitorIcon className="size-5" weight="fill" />
          </span>
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-foreground truncate text-sm font-medium">{connection.name}</p>
              <Badge variant={connection.isLive ? 'success' : 'outline'} size="sm">
                {connection.isLive ? 'Online' : 'Offline'}
              </Badge>
            </div>
            <InlineMeta className="flex-wrap">
              {hostname}
              {[platform, arch].filter(Boolean).join(' ') || null}
              {`Last seen ${lastSeen}`}
            </InlineMeta>
            <p className="text-muted-foreground font-mono text-xs break-all">
              {connection.tunnelId}
            </p>
          </div>
          <Button asChild variant="outline" size="sm" className="shrink-0 gap-1.5">
            <Link href={`/projects/${projectId}/customize/computers`}>
              Manage computer
              <ArrowRightIcon className="size-3.5 shrink-0" />
            </Link>
          </Button>
        </div>
      </div>
    </section>
  );
}
