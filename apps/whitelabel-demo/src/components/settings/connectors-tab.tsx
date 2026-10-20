'use client';

/**
 * The Connectors tab: sync, the add form, and the connector list. The form
 * owns its create; each row owns its presentation; remove stays here so its
 * pending state spans every row, as before.
 */

import Loading from '@kortix/ui/loading';

import { Badge } from '@kortix/ui/badge';
import { Button } from '@kortix/ui/button';
import { Card } from '@kortix/ui/card';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalHeader,
  ModalTitle,
  ModalTrigger,
} from '@kortix/ui/modal';
import { Input } from '@kortix/ui/input';
import { Label } from '@kortix/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@kortix/ui/select';
import { Separator } from '@kortix/ui/separator';
import { Skeleton } from '@kortix/ui/skeleton';
import { kortix } from '@/lib/kortix';
import { qk } from '@/lib/query-keys';
import type { AdminConnector } from '@kortix/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { errorToast, successToast } from '@kortix/ui/toast';
import { ArrowsClockwiseIcon, PlugIcon, SlidersHorizontalIcon, TrashIcon } from '@phosphor-icons/react';

export type ConnectorProvider =
  | 'pipedream'
  | 'mcp'
  | 'openapi'
  | 'postman'
  | 'graphql'
  | 'http'
  | 'channel'
  | 'computer';

const CONNECTOR_PROVIDERS: ConnectorProvider[] = [
  'pipedream',
  'mcp',
  'openapi',
  'graphql',
  'http',
  'channel',
  'computer',
];

function AddConnectorForm({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: qk.connectors(projectId) });

  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [provider, setProvider] = useState<ConnectorProvider>('mcp');
  const [url, setUrl] = useState('');

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
      successToast('Connector added');
    },
    onError: () => errorToast('Could not add connector'),
  });

  return (
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
        <ConnectorProviderSelect value={provider} onValueChange={setProvider} />
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
            {create.isPending && <Loading className="size-4" />}
            Add connector
          </Button>
        </div>
      </form>
    </Card>
  );
}

function ConnectorProviderSelect({
  value,
  onValueChange,
}: {
  value: ConnectorProvider;
  onValueChange: (value: ConnectorProvider) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label>Provider</Label>
      <Select value={value} onValueChange={(v) => onValueChange(v as ConnectorProvider)}>
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {CONNECTOR_PROVIDERS.map((p) => (
            <SelectItem key={p} value={p}>
              {p}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

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
          <TrashIcon className="size-4" />
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
    <Modal open={open} onOpenChange={setOpen}>
      <ModalTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground"
          aria-label={`Configure ${slug}`}
        >
          <SlidersHorizontalIcon className="size-4" />
        </Button>
      </ModalTrigger>
      <ModalContent>
        <ModalHeader>
          <ModalTitle className="font-mono text-base">{slug}</ModalTitle>
          <ModalDescription>Connector configuration (read-only).</ModalDescription>
        </ModalHeader>
        <ModalBody>
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
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}

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
      successToast(`Synced ${res.synced} connector(s)`);
    },
    onError: () => errorToast('Sync failed'),
  });
  const remove = useMutation({
    mutationFn: (s: string) => kortix.project(projectId).connectors.remove(s),
    onSuccess: () => {
      refresh();
      successToast('Connector removed');
    },
    onError: () => errorToast('Could not remove connector'),
  });

  const items: AdminConnector[] = connectors.data?.connectors ?? [];

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-sm font-medium">
              <PlugIcon className="size-4 text-muted-foreground" /> Connectors
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
            {sync.isPending ? <Loading className="size-4" /> : <ArrowsClockwiseIcon className="size-4" />}
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
