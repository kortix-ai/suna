'use client';

import Loading from '@/components/ui/loading';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
} from '@/components/ui/select';
import { errorToast, successToast } from '@/components/ui/toast';
import { setActiveHarnessConnection, type HarnessAuthKind, type HarnessId } from '@kortix/sdk/projects-client';
import {
  harnessLabel,
  invalidateComposerCapabilityQueries,
  type ModelsPageConnection,
} from '@kortix/sdk/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

const CONNECT_ANOTHER = '__connect_another__';

function connectionMetaLine(connection: ModelsPageConnection): string {
  if (connection.catalogState === 'not-exposed') return 'Managed by the harness';
  if (connection.catalogState === 'loading') return 'Loading models…';
  if (connection.catalogState === 'error') return 'Could not load models';
  const count = connection.modelCount ?? 0;
  return `${count} model${count === 1 ? '' : 's'} available`;
}

export function ConnectionSelect({
  projectId,
  harness,
  connections,
  compatibleConnectionIds,
  selectedConnectionId,
  triggerLabel,
  disabled = false,
  onConnectAnother,
}: {
  projectId: string;
  harness: HarnessId;
  connections: ModelsPageConnection[];
  compatibleConnectionIds: HarnessAuthKind[];
  selectedConnectionId: HarnessAuthKind | null;
  triggerLabel: string;
  disabled?: boolean;
  onConnectAnother: () => void;
}) {
  const queryClient = useQueryClient();
  const connectionsKey = ['project', projectId, 'harness-connections'] as const;

  const select = useMutation({
    mutationFn: (connectionId: HarnessAuthKind) =>
      setActiveHarnessConnection(projectId, harness, connectionId),
    onMutate: async (connectionId) => {
      await queryClient.cancelQueries({ queryKey: connectionsKey });
      const previous = queryClient.getQueryData<{
        connections: Array<{ id: HarnessAuthKind; active_for: HarnessId[] }>;
      }>(connectionsKey);
      if (previous) {
        queryClient.setQueryData(connectionsKey, {
          ...previous,
          connections: previous.connections.map((connection) => ({
            ...connection,
            active_for:
              connection.id === connectionId
                ? [...connection.active_for.filter((h) => h !== harness), harness]
                : connection.active_for.filter((h) => h !== harness),
          })),
        });
      }
      return { previous };
    },
    onError: (err, _connectionId, context) => {
      if (context?.previous) queryClient.setQueryData(connectionsKey, context.previous);
      errorToast(err instanceof Error ? err.message : 'Could not change connection');
    },
    onSuccess: (_data, connectionId) => {
      const name = connections.find((c) => c.id === connectionId)?.name ?? connectionId;
      successToast(`${harnessLabel(harness)} now uses ${name}`);
      void invalidateComposerCapabilityQueries(queryClient, projectId);
    },
  });

  const compatible = compatibleConnectionIds
    .map((id) => connections.find((connection) => connection.id === id))
    .filter((connection): connection is ModelsPageConnection => Boolean(connection));

  return (
    <Select
      value={selectedConnectionId ?? undefined}
      disabled={disabled || select.isPending}
      onValueChange={(value) => {
        if (value === CONNECT_ANOTHER) {
          onConnectAnother();
          return;
        }
        select.mutate(value as HarnessAuthKind);
      }}
    >
      <SelectTrigger
        variant="popover"
        size="sm"
        className="min-h-10 gap-1.5"
        aria-label={`Change the connection ${harnessLabel(harness)} uses`}
      >
        {select.isPending ? <Loading className="size-3.5 shrink-0" /> : null}
        {triggerLabel}
      </SelectTrigger>
      <SelectContent align="end">
        {compatible.map((connection) => (
          <SelectItem
            key={connection.id}
            value={connection.id}
            description={connectionMetaLine(connection)}
          >
            {connection.name}
          </SelectItem>
        ))}
        <SelectSeparator />
        <SelectItem value={CONNECT_ANOTHER}>Connect another service</SelectItem>
      </SelectContent>
    </Select>
  );
}
