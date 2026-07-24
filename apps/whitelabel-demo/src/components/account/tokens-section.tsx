'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { kortix } from '@/lib/kortix';
import { relativeTime } from '@/lib/utils';
import type { CreatedAccountToken } from '@kortix/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, KeyRound, Loader2, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

/**
 * API keys — `accounts.tokens.list(accountId)` to list, `.create({ name,
 * accountId })` to mint, `.revoke(tokenId, accountId)` to revoke. The
 * plaintext `secret_key` exists only on the create response: it is shown
 * once inside the dialog and never rendered after it closes.
 */
export function TokensSection({ accountId }: { accountId: string }) {
  const qc = useQueryClient();
  const tokensKey = ['account-tokens', accountId] as const;
  const tokens = useQuery({
    queryKey: tokensKey,
    queryFn: () => kortix.accounts.tokens.list(accountId),
  });

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [created, setCreated] = useState<CreatedAccountToken | null>(null);

  const create = useMutation({
    mutationFn: () => kortix.accounts.tokens.create({ name: name.trim(), accountId }),
    onSuccess: (token) => {
      setCreated(token);
      qc.invalidateQueries({ queryKey: tokensKey });
      toast.success('API key created');
    },
    onError: () => toast.error('Could not create the key'),
  });

  const revoke = useMutation({
    mutationFn: (tokenId: string) => kortix.accounts.tokens.revoke(tokenId, accountId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: tokensKey });
      toast.success('API key revoked');
    },
    onError: () => toast.error('Could not revoke the key'),
  });

  // Every session mint auto-creates an "Executor Session …" token; dozens of
  // them drown the keys a human actually made. Fold them behind a toggle.
  const [showSystem, setShowSystem] = useState(false);
  const all = tokens.data ?? [];
  const systemTokens = all.filter((t) => /^executor session /i.test(t.name ?? ''));
  const items = showSystem ? all : all.filter((t) => !systemTokens.includes(t));

  const closeCreate = () => {
    setCreateOpen(false);
    setCreated(null);
    setName('');
  };

  const copySecret = async () => {
    if (!created) return;
    await navigator.clipboard.writeText(created.secret_key);
    toast.success('Copied to clipboard');
  };

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-foreground">API keys</h3>
        <Dialog
          open={createOpen}
          onOpenChange={(open) => (open ? setCreateOpen(true) : closeCreate())}
        >
          <DialogTrigger asChild>
            <Button size="sm" variant="outline">
              <Plus className="size-4" /> Create key
            </Button>
          </DialogTrigger>
          <DialogContent>
            {created ? (
              <>
                <DialogHeader>
                  <DialogTitle>Save your API key</DialogTitle>
                  <DialogDescription>
                    Copy it somewhere safe. You won&apos;t see this again.
                  </DialogDescription>
                </DialogHeader>
                <div className="select-all rounded-md border border-border bg-muted/50 p-3 font-mono text-xs break-all">
                  {created.secret_key}
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={copySecret}>
                    <Copy className="size-4" /> Copy
                  </Button>
                  <Button onClick={closeCreate}>Done</Button>
                </DialogFooter>
              </>
            ) : (
              <>
                <DialogHeader>
                  <DialogTitle>Create API key</DialogTitle>
                  <DialogDescription>
                    An account-scoped key for CLI and API access.
                  </DialogDescription>
                </DialogHeader>
                <form
                  className="space-y-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (name.trim() && !create.isPending) create.mutate();
                  }}
                >
                  <Label htmlFor="new-key-name">Name</Label>
                  <Input
                    id="new-key-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. ci-deploy"
                    autoFocus
                  />
                  <DialogFooter className="mt-4">
                    <Button type="button" variant="ghost" onClick={closeCreate}>
                      Cancel
                    </Button>
                    <Button type="submit" disabled={!name.trim() || create.isPending}>
                      {create.isPending && <Loader2 className="size-4 animate-spin" />}
                      Create key
                    </Button>
                  </DialogFooter>
                </form>
              </>
            )}
          </DialogContent>
        </Dialog>
      </div>

      {/* List — accounts.tokens.list */}
      <Card className="divide-y divide-border p-0">
        {tokens.isLoading && (
          <div className="space-y-2 p-4">
            <Skeleton className="h-5 w-52" />
            <Skeleton className="h-5 w-40" />
          </div>
        )}
        {tokens.isError && (
          <div className="p-6 text-center text-sm text-destructive">
            Couldn&apos;t load API keys.
          </div>
        )}
        {tokens.isSuccess && items.length === 0 && (
          <div className="p-6 text-center text-sm text-muted-foreground">No API keys yet.</div>
        )}
        {items.map((t) => {
          const revoked = t.status !== 'active';
          const busy = revoke.isPending && revoke.variables === t.token_id;
          return (
            <div key={t.token_id} className="flex items-center gap-3 px-4 py-3">
              <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted">
                <KeyRound className="size-4 text-muted-foreground" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{t.name}</span>
                  {t.project_id && (
                    <Badge variant="outline" className="font-mono text-[10px]">
                      {t.project_id.slice(0, 8)}
                    </Badge>
                  )}
                  {revoked && (
                    <Badge variant="secondary" className="capitalize">
                      {t.status}
                    </Badge>
                  )}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  <span className="font-mono">{t.public_key}</span> · created{' '}
                  {relativeTime(t.created_at)} ·{' '}
                  {t.last_used_at ? `last used ${relativeTime(t.last_used_at)}` : 'never used'}
                </div>
              </div>
              {!revoked && (
                <RevokeKeyDialog
                  name={t.name}
                  pending={busy}
                  onConfirm={() => revoke.mutate(t.token_id)}
                />
              )}
            </div>
          );
        })}
        {systemTokens.length > 0 && (
          <button
            type="button"
            className="w-full px-4 py-2.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
            onClick={() => setShowSystem((v) => !v)}
          >
            {showSystem
              ? 'Hide session-minted executor keys'
              : `${systemTokens.length} session-minted executor keys hidden — show them`}
          </button>
        )}
      </Card>
    </section>
  );
}

function RevokeKeyDialog({
  name,
  pending,
  onConfirm,
}: {
  name: string;
  pending: boolean;
  onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-destructive hover:text-destructive"
          disabled={pending}
          aria-label={`Revoke ${name}`}
        >
          {pending ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Revoke {name}?</DialogTitle>
          <DialogDescription>
            Anything authenticating with this key stops working immediately. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() => {
              onConfirm();
              setOpen(false);
            }}
          >
            Revoke key
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
