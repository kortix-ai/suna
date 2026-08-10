'use client';

import { createConnector, getConnectorConfig, type WorkspaceAdminConnector } from '@kortix/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import { ErrorState } from '@/features/layout/section/error-state';
import { ComputerTunnelManager } from '@/features/tunnel/tunnel-overview';

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

export function ComputerConnectorAccount({
  workspaceId,
  connector,
  canWrite,
  onChanged,
}: {
  workspaceId: string;
  connector: WorkspaceAdminConnector;
  canWrite: boolean;
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const configQuery = useQuery({
    queryKey: ['connector-config', workspaceId, connector.slug],
    queryFn: () => getConnectorConfig(workspaceId, connector.slug),
  });
  const savedIds = configQuery.data?.tunnelIds ?? [];
  const [selection, setSelection] = useState<string[] | null>(null);
  const selectedIds = selection ?? savedIds;

  const save = useMutation({
    mutationFn: () =>
      createConnector(workspaceId, {
        slug: connector.slug,
        name: connector.name,
        provider: 'computer',
        tunnel_ids: normalizeMachineSelection(selectedIds),
      }),
    onSuccess: () => {
      successToast('Computer Tunnel assignments saved');
      setSelection(null);
      void queryClient.invalidateQueries({
        queryKey: ['connector-config', workspaceId, connector.slug],
      });
      onChanged();
    },
    onError: (error: Error) =>
      errorToast(error.message || 'Failed to save Computer Tunnel assignments'),
  });

  if (configQuery.isLoading) {
    return <Skeleton className="h-96 rounded-md" />;
  }
  if (configQuery.isError) {
    return (
      <ErrorState
        size="sm"
        title="Couldn’t load Computer Tunnel assignments"
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
      <div className="space-y-1">
        <Label>Assigned machines</Label>
        <p className="text-muted-foreground text-xs text-pretty">
          Pair, inspect, and select machines here. Agents can list and target only the selected
          machines.
        </p>
      </div>

      <ComputerTunnelManager
        canWrite={canWrite}
        selectedIds={selectedIds}
        onSelectedIdsChange={setSelection}
        selectionDisabled={!canWrite || save.isPending}
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
