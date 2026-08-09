'use client';

import { createConnector, getConnectorConfig, type AdminConnector } from '@kortix/sdk';
import { formatRelative } from '@kortix/shared';
import { ArrowRightIcon, MonitorIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useMemo, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { InfoBanner } from '@/components/ui/info-banner';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import { ErrorState } from '@/features/layout/section/error-state';
import { useTunnelConnections } from '@/hooks/tunnel/use-tunnel';
import { useTunnelRealtimeSync } from '@/hooks/tunnel/use-tunnel-realtime';
import { cn } from '@/lib/utils';

export function normalizeMachineSelection(values: readonly unknown[]): string[] {
  return [
    ...new Set(
      values.filter((value): value is string => typeof value === 'string' && value.length > 0),
    ),
  ].sort();
}

export function machineSelectionChanged(
  current: readonly unknown[],
  saved: readonly unknown[],
): boolean {
  return (
    JSON.stringify(normalizeMachineSelection(current)) !==
    JSON.stringify(normalizeMachineSelection(saved))
  );
}

function machineValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function ComputerMachineSelector({
  selectedIds,
  onSelectedIdsChange,
  disabled = false,
  visibleIds,
}: {
  selectedIds: readonly string[];
  onSelectedIdsChange: (ids: string[]) => void;
  disabled?: boolean;
  /** Restrict read-only views to the profile's assigned set. */
  visibleIds?: readonly string[];
}) {
  const connectionsQuery = useTunnelConnections();
  useTunnelRealtimeSync();
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const visible = useMemo(() => (visibleIds ? new Set(visibleIds) : null), [visibleIds]);

  if (connectionsQuery.isLoading) {
    return (
      <div className="space-y-2">
        {[0, 1, 2].map((index) => (
          <Skeleton key={index} className="h-16 rounded-md" />
        ))}
      </div>
    );
  }
  if (connectionsQuery.isError) {
    return (
      <ErrorState
        size="sm"
        title="Couldn’t load computers"
        description={
          connectionsQuery.error instanceof Error
            ? connectionsQuery.error.message
            : 'The paired computer fleet could not be read.'
        }
        action={
          <Button variant="outline" size="sm" onClick={() => void connectionsQuery.refetch()}>
            Retry
          </Button>
        }
      />
    );
  }
  const machines = (connectionsQuery.data ?? []).filter(
    (connection) => visible === null || visible.has(connection.tunnelId),
  );
  if (machines.length === 0) {
    return (
      <InfoBanner
        tone="neutral"
        title={visible ? 'No assigned computers are available' : 'No paired computers'}
      >
        {visible
          ? 'The assigned computers are no longer present in this account fleet.'
          : 'Pair a computer from the Computers page before creating a connector profile.'}
      </InfoBanner>
    );
  }

  return (
    <ul className="space-y-2">
      {machines.map((connection) => {
        const platform = machineValue(connection.machineInfo.platform);
        const arch = machineValue(connection.machineInfo.arch);
        const lastSeen = connection.lastHeartbeatAt
          ? (formatRelative(connection.lastHeartbeatAt, { maxRelativeDays: null }) ?? 'Unknown')
          : 'Never';
        return (
          <li key={connection.tunnelId} className="bg-popover rounded-md border px-1 py-1">
            <Checkbox
              checked={selected.has(connection.tunnelId)}
              disabled={disabled}
              onCheckedChange={(checked) => {
                const next = new Set(selected);
                if (checked === true) next.add(connection.tunnelId);
                else next.delete(connection.tunnelId);
                onSelectedIdsChange([...next]);
              }}
              className="min-h-14 py-2"
              label={
                <span className="flex min-w-0 items-center gap-3">
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
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-foreground truncate text-sm font-medium">
                        {connection.name}
                      </span>
                      <Badge variant={connection.isLive ? 'success' : 'outline'} size="xs">
                        {connection.isLive ? 'Online' : 'Offline'}
                      </Badge>
                    </span>
                    <span className="text-muted-foreground mt-0.5 block text-xs">
                      {[platform, arch].filter(Boolean).join(' ') || 'Unknown platform'} &bull; Last
                      seen {lastSeen}
                    </span>
                  </span>
                </span>
              }
            />
          </li>
        );
      })}
    </ul>
  );
}

export function ComputerConnectorAccount({
  projectId,
  connector,
  canWrite,
  onChanged,
}: {
  projectId: string;
  connector: AdminConnector;
  canWrite: boolean;
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const configQuery = useQuery({
    queryKey: ['connector-config', projectId, connector.slug],
    queryFn: () => getConnectorConfig(projectId, connector.slug),
  });
  const savedIds = configQuery.data?.tunnelIds ?? [];
  const [selection, setSelection] = useState<string[] | null>(null);
  const selectedIds = selection ?? savedIds;

  const save = useMutation({
    mutationFn: () =>
      createConnector(projectId, {
        slug: connector.slug,
        name: connector.name,
        provider: 'computer',
        tunnel_ids: normalizeMachineSelection(selectedIds),
      }),
    onSuccess: () => {
      successToast('Computer assignments saved');
      setSelection(null);
      void queryClient.invalidateQueries({
        queryKey: ['connector-config', projectId, connector.slug],
      });
      onChanged();
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to save computer assignments'),
  });

  if (configQuery.isLoading) {
    return <Skeleton className="h-40 rounded-md" />;
  }
  if (configQuery.isError) {
    return (
      <ErrorState
        size="sm"
        title="Couldn’t load computer assignments"
        description={(configQuery.error as Error).message}
        action={
          <Button variant="outline" size="sm" onClick={() => void configQuery.refetch()}>
            Retry
          </Button>
        }
      />
    );
  }

  const dirty = machineSelectionChanged(selectedIds, savedIds);
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <Label>Assigned computers</Label>
          <p className="text-muted-foreground text-xs text-pretty">
            Agents using this connector can list and target only these computers.
          </p>
        </div>
        <Button asChild variant="outline" size="sm" className="shrink-0 gap-1.5">
          <Link href={`/projects/${projectId}/customize/computers`}>
            Manage fleet
            <ArrowRightIcon className="size-3.5 shrink-0" />
          </Link>
        </Button>
      </div>

      <ComputerMachineSelector
        selectedIds={selectedIds}
        onSelectedIdsChange={setSelection}
        disabled={!canWrite || save.isPending}
        visibleIds={canWrite ? undefined : savedIds}
      />

      {canWrite ? (
        <div className="border-border/60 flex justify-end gap-2 border-t pt-4">
          {dirty ? (
            <Button
              variant="outline"
              size="sm"
              disabled={save.isPending}
              onClick={() => setSelection(null)}
            >
              Reset
            </Button>
          ) : null}
          <Button
            size="sm"
            disabled={!dirty || selectedIds.length === 0 || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? <Loading className="size-4 shrink-0" /> : null}
            Save assignments
          </Button>
        </div>
      ) : null}
    </section>
  );
}
