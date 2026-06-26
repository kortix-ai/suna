'use client';

import { useState } from 'react';
import { Check, Copy, KeyRound, MoreHorizontal, Trash2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/features/layout/section/empty-state';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { InfoBanner } from '@/components/ui/info-banner';
import { InlineMeta } from '@/components/ui/inline-meta';
import { Input } from '@/components/ui/input';
import { List, ListRow } from '@/components/ui/list';
import { SectionCard } from '@/components/ui/section-card';
import { toast } from '@/lib/toast';
import {
  useCreateGatewayKey,
  useGatewayKeys,
  useRevokeGatewayKey,
} from '@/hooks/projects/use-project-gateway';
import type { CreatedGatewayKey } from '@/lib/projects-gateway-client';

function fmtDate(s: string | null): string {
  if (!s) return 'never';
  return new Date(s).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function GatewayKeys({ projectId }: { projectId: string }) {
  const { data, isError } = useGatewayKeys(projectId);
  const createKey = useCreateGatewayKey(projectId);
  const revokeKey = useRevokeGatewayKey(projectId);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [created, setCreated] = useState<CreatedGatewayKey | null>(null);

  const keys = data?.keys ?? [];

  if (isError) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-5">
        <p className="text-sm text-muted-foreground">
          You need the manage-keys permission to view gateway keys.
        </p>
      </div>
    );
  }

  const submit = () => {
    const n = name.trim();
    if (!n) return;
    createKey.mutate(n, {
      onSuccess: (key) => {
        setCreated(key);
        setCreating(false);
        setName('');
      },
      onError: (e) => toast.error(e instanceof Error ? e.message : 'Could not create key'),
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl space-y-4 p-5">
        <SectionCard
          flush
          title="API keys"
          count={keys.length}
          description="Project-scoped keys for calling the gateway from external apps — every request is logged and billed here"
          action={
            <Button size="sm" onClick={() => setCreating(true)}>
              Create key
            </Button>
          }
        >
          {keys.length === 0 ? (
            <EmptyState
              icon={KeyRound}
              title="No keys yet"
              description="Create a project-scoped key to call the gateway from outside a Kortix session."
              action={<Button size="sm" onClick={() => setCreating(true)}>Create key</Button>}
            />
          ) : (
            <List>
              {keys.map((k) => {
                const active = k.status === 'active';
                return (
                  <ListRow
                    key={k.key_id}
                    compact
                    leading={<EntityAvatar icon={KeyRound} size="sm" />}
                    title={
                      <span className="truncate text-sm font-medium text-foreground">{k.name}</span>
                    }
                    badges={
                      <Badge size="sm" variant={active ? 'success' : 'secondary'} className="capitalize">
                        {k.status}
                      </Badge>
                    }
                    subtitle={
                      <InlineMeta>
                        <code className="font-mono">{k.key_prefix}…</code>
                        <span>last used {fmtDate(k.last_used_at)}</span>
                      </InlineMeta>
                    }
                    trailing={
                      active ? (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7"
                              aria-label="Key actions"
                            >
                              <MoreHorizontal className="h-3.5 w-3.5" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-44">
                            <DropdownMenuItem
                              variant="destructive"
                              onClick={() =>
                                revokeKey.mutate(k.key_id, {
                                  onSuccess: () => toast.success('Key revoked'),
                                  onError: (e) =>
                                    toast.error(e instanceof Error ? e.message : 'Could not revoke'),
                                })
                              }
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              Revoke key
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : null
                    }
                  />
                );
              })}
            </List>
          )}
        </SectionCard>
      </div>

      {creating && (
        <Dialog open onOpenChange={(n) => (n ? undefined : setCreating(false))}>
          <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-md">
            <DialogHeader className="border-b border-border/60 px-6 pt-6 pb-4">
              <DialogTitle>Create gateway key</DialogTitle>
              <DialogDescription>Name it so you can tell your keys apart later.</DialogDescription>
            </DialogHeader>
            <div className="px-6 py-5">
              <label className="mb-1.5 block text-sm font-medium text-foreground">Name</label>
              <Input
                autoFocus
                placeholder="e.g. Production backend"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submit()}
              />
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-border/60 bg-muted/30 px-6 py-3">
              <Button variant="ghost" onClick={() => setCreating(false)}>
                Cancel
              </Button>
              <Button disabled={!name.trim() || createKey.isPending} onClick={submit}>
                {createKey.isPending ? 'Creating…' : 'Create key'}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {created && (
        <RevealKeyDialog
          created={created}
          gatewayUrl={data?.gateway_url ?? null}
          onClose={() => setCreated(null)}
        />
      )}
    </div>
  );
}

function RevealKeyDialog({
  created,
  gatewayUrl,
  onClose,
}: {
  created: CreatedGatewayKey;
  /** Env-correct public gateway origin (dev vs prod); falls back to prod. */
  gatewayUrl: string | null;
  onClose: () => void;
}) {
  const base = gatewayUrl ?? 'https://gateway.kortix.com';
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(created.secret_key);
    setCopied(true);
    toast.success('Key copied');
  };
  return (
    <Dialog open onOpenChange={(n) => (n ? undefined : onClose())}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-md">
        <DialogHeader className="border-b border-border/60 px-6 pt-6 pb-4">
          <DialogTitle>Copy your key</DialogTitle>
          <DialogDescription>{created.name}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 px-6 py-5">
          <InfoBanner tone="warning" title="Shown once">
            This is the only time the full key is displayed. Store it somewhere safe.
          </InfoBanner>
          <div className="flex items-center gap-2 rounded-2xl border border-border bg-card px-3 py-2.5">
            <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
              {created.secret_key}
            </code>
            <button
              type="button"
              onClick={copy}
              className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              aria-label="Copy key"
            >
              {copied ? <Check className="size-4 text-kortix-green" /> : <Copy className="size-4" />}
            </button>
          </div>
          <div>
            <div className="mb-1.5 text-xs font-medium text-muted-foreground">Use it</div>
            <pre className="overflow-x-auto rounded-xl border border-border/60 bg-muted/30 p-3 font-mono text-xs leading-relaxed text-foreground">
{`curl ${base}/v1/chat/completions \\
  -H "Authorization: Bearer ${created.secret_key}" \\
  -d '{"model":"claude-sonnet-4.6","messages":[{"role":"user","content":"Hello"}]}'`}
            </pre>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border/60 bg-muted/30 px-6 py-3">
          <Button onClick={onClose}>Done</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
