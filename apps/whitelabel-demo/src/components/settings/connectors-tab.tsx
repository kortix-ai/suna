'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { kortix } from '@/lib/kortix';
import { cn } from '@/lib/utils';
import type { AdminConnector } from '@kortix/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plug, RefreshCw, Settings2, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

type Provider = 'pipedream' | 'mcp' | 'openapi' | 'graphql' | 'http' | 'channel' | 'computer';

const PROVIDERS: Provider[] = [
  'pipedream',
  'mcp',
  'openapi',
  'graphql',
  'http',
  'channel',
  'computer',
];

function statusVariant(status?: string) {
  if (status === 'active') return 'default' as const;
  if (status === 'error') return 'destructive' as const;
  return 'secondary' as const;
}

export function ConnectorsTab({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const key = ['project-connectors', projectId] as const;
  const refresh = () => qc.invalidateQueries({ queryKey: key });

  const connectors = useQuery({
    queryKey: key,
    queryFn: () => kortix.project(projectId).connectors.list(),
  });

  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [provider, setProvider] = useState<Provider>('mcp');
  const [url, setUrl] = useState('');

  const sync = useMutation({
    mutationFn: () => kortix.project(projectId).connectors.sync(),
    onSuccess: (res) => {
      refresh();
      toast.success(`Synced ${res.synced} connector(s)`);
    },
    onError: () => toast.error('Sync failed'),
  });

  const create = useMutation({
    mutationFn: () =>
      kortix.project(projectId).connectors.create({
        slug: slug.trim(),
        name: name.trim() || undefined,
        provider,
        url: url.trim() || undefined,
      }),
    onSuccess: () => {
      setSlug('');
      setName('');
      setUrl('');
      refresh();
      toast.success('Connector added');
    },
    onError: () => toast.error('Could not add connector'),
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
              Tools and integrations the agent can call at runtime.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={sync.isPending}
            onClick={() => sync.mutate()}
          >
            {sync.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
            Sync
          </Button>
        </div>
      </Card>

      <Card className="p-5">
        <div className="text-sm font-medium">Add a connector</div>
        <form
          className="mt-3 grid gap-2 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (slug.trim()) create.mutate();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="c-slug">Slug</Label>
            <Input
              id="c-slug"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="my-tool"
              className="font-mono"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="c-name">Name</Label>
            <Input
              id="c-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Tool"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Provider</Label>
            <Select value={provider} onValueChange={(v) => setProvider(v as Provider)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROVIDERS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="c-url">URL (optional)</Label>
            <Input
              id="c-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://…"
            />
          </div>
          <div className="sm:col-span-2 flex justify-end">
            <Button type="submit" disabled={!slug.trim() || create.isPending}>
              {create.isPending && <Loader2 className="size-4 animate-spin" />}
              Add connector
            </Button>
          </div>
        </form>
      </Card>

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
            <div key={cSlug} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">
                    {c.name ?? c.slug ?? 'Connector'}
                  </span>
                  <Badge variant={statusVariant(c.status)} className="capitalize">
                    {c.status ?? 'unknown'}
                  </Badge>
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-mono">{c.slug}</span>
                  {c.provider && <span>· {c.provider}</span>}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <ConnectorConfigDialog projectId={projectId} slug={cSlug} />
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 text-muted-foreground hover:text-destructive"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(cSlug)}
                  aria-label={`Remove ${cSlug}`}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </div>
          );
        })}
      </Card>
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
              <div key={k} className={cn('flex items-start justify-between gap-4')}>
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
