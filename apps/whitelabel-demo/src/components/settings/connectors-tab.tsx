'use client';

/**
 * The Connectors tab: sync, the add form, and the connector list. The form
 * owns its create; each row owns its presentation; remove stays here so its
 * pending state spans every row, as before.
 */

import Loading from '@/components/ui/loading';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { kortix } from '@/lib/kortix';
import { qk } from '@/lib/query-keys';
import type { AdminConnector } from '@kortix/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plug, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { AddConnectorForm } from './connectors/add-connector-form';
import { ConnectorRow } from './connectors/connector-row';

export function ConnectorsTab({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: qk.connectors(projectId) });

  const connectors = useQuery({
    queryKey: qk.connectors(projectId),
    queryFn: () => kortix.project(projectId).connectors.list(),
  });

  const sync = useMutation({
    mutationFn: () => kortix.project(projectId).connectors.sync(),
    onSuccess: (res) => {
      refresh();
      toast.success(`Synced ${res.synced} connector(s)`);
    },
    onError: () => toast.error('Sync failed'),
  });

  const remove = useMutation({
    mutationFn: (s: string) => kortix.project(projectId).connectors.remove(s),
    onSuccess: () => {
      refresh();
      toast.success('Connector removed');
    },
    onError: () => toast.error('Could not remove connector'),
  });

  const items: AdminConnector[] = connectors.data?.connectors ?? [];

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-sm font-medium">
              <Plug className="size-4 text-muted-foreground" /> Connectors
            </div>
            <p className="text-xs text-muted-foreground">
              Tools and connectors the agent can call at runtime.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={sync.isPending}
            onClick={() => sync.mutate()}
          >
            {sync.isPending ? <Loading className="size-4" /> : <RefreshCw className="size-4" />}
            Sync
          </Button>
        </div>
      </Card>

      <AddConnectorForm projectId={projectId} />

      <Card className="divide-y divide-border p-0">
        {connectors.isLoading && (
          <div className="p-4">
            <Skeleton className="h-5 w-40" />
          </div>
        )}
        {connectors.isSuccess && items.length === 0 && (
          <div className="p-6 text-center text-sm text-muted-foreground">No connectors yet.</div>
        )}
        {items.map((c, i) => {
          const cSlug = String(c.slug ?? c.name ?? i);
          return (
            <ConnectorRow
              key={cSlug}
              projectId={projectId}
              connector={c}
              index={i}
              removing={remove.isPending}
              onRemove={() => remove.mutate(cSlug)}
            />
          );
        })}
      </Card>
    </div>
  );
}
