'use client';

/** The "Add a connector" card: owns its fields and the create mutation. */

import Loading from '@/components/ui/loading';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { kortix } from '@/lib/kortix';
import { qk } from '@/lib/query-keys';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';

export type ConnectorProvider =
  | 'pipedream'
  | 'mcp'
  | 'openapi'
  | 'postman'
  | 'graphql'
  | 'http'
  | 'channel'
  | 'computer';

export const CONNECTOR_PROVIDERS: ConnectorProvider[] = [
  'pipedream',
  'mcp',
  'openapi',
  'graphql',
  'http',
  'channel',
  'computer',
];

export function AddConnectorForm({ projectId }: { projectId: string }) {
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
      toast.success('Connector added');
    },
    onError: () => toast.error('Could not add connector'),
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
        <div className="space-y-1.5">
          <Label>Provider</Label>
          <Select value={provider} onValueChange={(v) => setProvider(v as ConnectorProvider)}>
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
