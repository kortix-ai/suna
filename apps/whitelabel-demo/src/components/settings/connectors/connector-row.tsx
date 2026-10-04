'use client';

/** One connector row: its badges and its configure/remove actions. The row is
 *  presentation only — the shared remove mutation lives in ConnectorsTab so
 *  its pending state spans every row, as before. */

import Loading from '@/components/ui/loading';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { kortix } from '@/lib/kortix';
import type { AdminConnector } from '@kortix/sdk';
import { useQuery } from '@tanstack/react-query';
import { Settings2, Trash2 } from 'lucide-react';
import { useState } from 'react';

function statusVariant(status?: string) {
  if (status === 'active') return 'default' as const;
  if (status === 'error') return 'destructive' as const;
  return 'secondary' as const;
}

export function ConnectorRow({
  projectId,
  connector,
  index,
  removing,
  onRemove,
}: {
  projectId: string;
  connector: AdminConnector;
  index: number;
  removing: boolean;
  onRemove: () => void;
}) {
  const cSlug = String(connector.slug ?? connector.name ?? index);
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">
            {connector.name ?? connector.slug ?? 'Connector'}
          </span>
          <Badge variant={statusVariant(connector.status)} className="capitalize">
            {connector.status ?? 'unknown'}
          </Badge>
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
          <span className="font-mono">{connector.slug}</span>
          {connector.provider && <span>· {connector.provider}</span>}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <ConnectorConfigDialog projectId={projectId} slug={cSlug} />
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground hover:text-destructive"
          disabled={removing}
          onClick={onRemove}
          aria-label={`Remove ${cSlug}`}
        >
          <Trash2 className="size-4" />
        </Button>
      </div>
    </div>
  );
}

function ConnectorConfigDialog({
  projectId,
  slug,
}: {
  projectId: string;
  slug: string;
}) {
  const [open, setOpen] = useState(false);
  const config = useQuery({
    queryKey: ['project-connector-config', projectId, slug],
    queryFn: () => kortix.project(projectId).connectors.config(slug),
    enabled: open,
  });

  const data = config.data;
  const rows: Array<[string, unknown]> = data
    ? Object.entries(data).filter(([, v]) => v !== null && typeof v !== 'object')
    : [];

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground"
          aria-label={`Configure ${slug}`}
        >
          <Settings2 className="size-4" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-mono text-base">{slug}</DialogTitle>
          <DialogDescription>Connector configuration (read-only).</DialogDescription>
        </DialogHeader>
        {config.isLoading && <Skeleton className="h-24 w-full" />}
        {config.isError && <p className="text-sm text-destructive">Could not load config.</p>}
        {config.isSuccess && (
          <div className="space-y-2 text-sm">
            {rows.length === 0 && <p className="text-muted-foreground">No configurable fields.</p>}
            {rows.map(([k, v]) => (
              <div key={k} className="flex items-start justify-between gap-4">
                <span className="text-muted-foreground">{k}</span>
                <span className="truncate font-mono text-xs">{String(v)}</span>
              </div>
            ))}
            <Separator />
            {data?.auth && (
              <div className="flex items-start justify-between gap-4">
                <span className="text-muted-foreground">auth</span>
                <span className="truncate font-mono text-xs">
                  {String(data.auth?.type ?? 'none')}
                </span>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
