'use client';

// Account-level "My personal secrets" manager. Lists the caller's own
// personal secrets (private, account-wide — "connect once, travels"), plus
// create / rotate / delete. Mirrors the policies-table layout and the
// groups-tab dialog conventions.

import { FormEvent, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Globe,
  KeyRound,
  Loader2,
  Lock,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  Users,
} from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { SectionCard } from '@/components/ui/section-card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/components/AuthProvider';
import {
  type VaultItem,
  type VaultKind,
  type VaultVisibility,
  createVaultItem,
  deleteVaultItem,
  listVaultItems,
  updateVaultItem,
} from '@/lib/vault-client';

const SECRET_NAME_REGEX = /^[A-Z_][A-Z0-9_]{0,63}$/;

const KIND_LABELS: Record<VaultKind, string> = {
  env: 'Env',
  api_key: 'API key',
  oauth_token: 'OAuth token',
  oauth_client: 'OAuth client',
  connection_secret: 'Connection',
};

/** Visibility badge shared by the table rows. */
export function VisibilityBadge({
  visibility,
  grantCount,
}: {
  visibility: VaultVisibility;
  grantCount: number;
}) {
  if (visibility === 'global') {
    return (
      <Badge variant="outline" size="sm" className="gap-1">
        <Globe className="h-2.5 w-2.5" />
        Global
      </Badge>
    );
  }
  if (visibility === 'private') {
    return (
      <Badge variant="outline" size="sm" className="gap-1">
        <Lock className="h-2.5 w-2.5" />
        Private
      </Badge>
    );
  }
  return (
    <Badge variant="outline" size="sm" className="gap-1">
      <Users className="h-2.5 w-2.5" />
      {grantCount} member{grantCount === 1 ? '' : 's'}
    </Badge>
  );
}

interface VaultTabProps {
  accountId: string;
  canManage: boolean;
}

export function VaultTab({ accountId, canManage }: VaultTabProps) {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<VaultItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<VaultItem | null>(null);

  const queryKey = ['vault-items', accountId];

  const vaultQuery = useQuery({
    queryKey,
    queryFn: () => listVaultItems(accountId),
    staleTime: 20_000,
  });

  const deleteMutation = useMutation({
    mutationFn: (itemId: string) => deleteVaultItem(accountId, itemId),
    onSuccess: () => {
      toast.success('Secret deleted');
      queryClient.invalidateQueries({ queryKey });
      setDeleteTarget(null);
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to delete secret'),
  });

  // Personal secrets only: items owned by the current user.
  const allItems = vaultQuery.data?.items ?? [];
  const items = user?.id
    ? allItems.filter((item) => item.owner_user_id === user.id)
    : [];

  return (
    <>
      <SectionCard
        title="My personal secrets"
        description="Available across all your projects. Connect once, travels with you."
        action={
          canManage && (
            <Button onClick={() => setCreateOpen(true)} size="sm" className="gap-1.5">
              <Plus className="h-4 w-4" />
              New secret
            </Button>
          )
        }
        flush
      >
        {vaultQuery.isError && (
          <div className="px-6 py-5">
            <p className="text-sm text-destructive">
              {(vaultQuery.error as Error)?.message || 'Failed to load secrets'}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => vaultQuery.refetch()}
            >
              Retry
            </Button>
          </div>
        )}

        {vaultQuery.isLoading && (
          <div className="divide-y divide-border/60">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="px-6 py-3">
                <Skeleton className="h-4 w-full" />
              </div>
            ))}
          </div>
        )}

        {!vaultQuery.isLoading && !vaultQuery.isError && items.length === 0 && (
          <EmptyState
            icon={KeyRound}
            size="sm"
            title="No personal secrets yet"
            description={
              canManage
                ? 'Add a secret. Only you can use it, and it travels with you across all your projects.'
                : 'You have not added any personal secrets yet.'
            }
          />
        )}

        {!vaultQuery.isLoading && items.length > 0 && (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/60 bg-muted/20 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                <th className="px-6 py-2.5 font-medium">Name</th>
                <th className="px-3 py-2.5 font-medium">Kind</th>
                <th className="w-12 px-3 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {items.map((item) => (
                <tr key={item.item_id} className="hover:bg-muted/20">
                  <td className="px-6 py-3">
                    <code className="font-mono text-xs text-foreground">{item.name}</code>
                  </td>
                  <td className="px-3 py-3 text-muted-foreground">
                    {KIND_LABELS[item.kind] ?? item.kind}
                  </td>
                  <td className="px-3 py-3 text-right">
                    {item.can_edit && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-muted-foreground hover:text-foreground"
                            aria-label={`Actions for ${item.name}`}
                          >
                            <MoreHorizontal className="h-3.5 w-3.5" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-44">
                          <DropdownMenuItem
                            onSelect={() => setEditTarget(item)}
                            className="gap-2"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                            Edit secret
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() => setDeleteTarget(item)}
                            className="gap-2 text-destructive focus:text-destructive"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            Delete secret
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SectionCard>

      <CreateSecretDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        accountId={accountId}
        onCreated={() => queryClient.invalidateQueries({ queryKey })}
      />

      <EditSecretDialog
        item={editTarget}
        onOpenChange={(open) => {
          if (!open) setEditTarget(null);
        }}
        accountId={accountId}
        onUpdated={() => queryClient.invalidateQueries({ queryKey })}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="Delete secret"
        description={
          deleteTarget
            ? `Delete "${deleteTarget.name}"? Anything relying on this secret will lose access to it.`
            : ''
        }
        confirmLabel="Delete secret"
        isPending={deleteMutation.isPending}
        onConfirm={() => {
          if (deleteTarget) deleteMutation.mutate(deleteTarget.item_id);
        }}
      />
    </>
  );
}

// ─── Create secret dialog ────────────────────────────────────────────────────

function CreateSecretDialog({
  open,
  onOpenChange,
  accountId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [kind, setKind] = useState<VaultKind>('env');

  function reset() {
    setName('');
    setValue('');
    setKind('env');
  }

  const createMutation = useMutation({
    mutationFn: () => {
      const normalized = name.trim().toUpperCase();
      if (!SECRET_NAME_REGEX.test(normalized)) {
        throw new Error('Use A-Z, 0-9, _ only. Must start with a letter or _. Max 64 chars.');
      }
      // Personal secret: private (owned by caller) + account-wide (no project_id).
      return createVaultItem(accountId, {
        name: normalized,
        value,
        kind,
        visibility: 'private',
      });
    },
    onSuccess: () => {
      toast.success('Secret created');
      onCreated();
      reset();
      onOpenChange(false);
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to create secret'),
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim() || createMutation.isPending) return;
    createMutation.mutate();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (createMutation.isPending) return;
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New personal secret</DialogTitle>
          <DialogDescription>
            Add a secret only you can use, available across all your projects.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4" autoComplete="off">
          {/* Dummy fields absorb any browser autofill so the real inputs below
              aren't treated as a username/password login form. */}
          <input type="text" name="username" autoComplete="username" className="hidden" tabIndex={-1} aria-hidden="true" />
          <input type="password" name="password" autoComplete="new-password" className="hidden" tabIndex={-1} aria-hidden="true" />
          <div className="space-y-1.5">
            <Label htmlFor="secret-name">Name</Label>
            <Input
              id="secret-name"
              name="vault-secret-name"
              value={name}
              onChange={(e) =>
                setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))
              }
              placeholder="MY_API_KEY"
              className="font-mono"
              autoFocus
              required
              autoComplete="off"
              data-1p-ignore="true"
              data-lpignore="true"
              data-form-type="other"
              disabled={createMutation.isPending}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="secret-value">Value</Label>
            <Input
              id="secret-value"
              name="vault-secret-value"
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="••••••••"
              className="font-mono"
              autoComplete="new-password"
              data-1p-ignore="true"
              data-lpignore="true"
              data-form-type="other"
              disabled={createMutation.isPending}
            />
          </div>

          <div className="space-y-1.5">
            <Label>Kind</Label>
            <Select
              value={kind}
              onValueChange={(v) => setKind(v as VaultKind)}
              disabled={createMutation.isPending}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(KIND_LABELS) as VaultKind[]).map((k) => (
                  <SelectItem key={k} value={k}>
                    {KIND_LABELS[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <p className="text-xs text-muted-foreground">
            Only you. Available in every session across all your projects.
          </p>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={createMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!name.trim() || createMutation.isPending}
              className="gap-1.5"
            >
              {createMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Create secret
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Edit secret dialog ──────────────────────────────────────────────────────
// Personal secrets: rotate the value. There are no grants/visibility to edit.

function EditSecretDialog({
  item,
  onOpenChange,
  accountId,
  onUpdated,
}: {
  item: VaultItem | null;
  onOpenChange: (open: boolean) => void;
  accountId: string;
  onUpdated: () => void;
}) {
  const [value, setValue] = useState('');

  // Hydrate from the item whenever the dialog opens.
  useEffect(() => {
    if (item) {
      setValue('');
    }
  }, [item]);

  const updateMutation = useMutation({
    mutationFn: () => {
      if (!item) throw new Error('No secret selected');
      return updateVaultItem(accountId, item.item_id, {
        value: value ? value : undefined,
      });
    },
    onSuccess: () => {
      toast.success('Secret updated');
      onUpdated();
      onOpenChange(false);
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to update secret'),
  });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (updateMutation.isPending) return;
    updateMutation.mutate();
  }

  return (
    <Dialog
      open={!!item}
      onOpenChange={(next) => {
        if (updateMutation.isPending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit secret</DialogTitle>
          <DialogDescription>
            {item ? (
              <>
                Rotate the value for{' '}
                <code className="font-mono text-foreground">{item.name}</code>.
              </>
            ) : null}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4" autoComplete="off">
          <input type="text" name="username" autoComplete="username" className="hidden" tabIndex={-1} aria-hidden="true" />
          <input type="password" name="password" autoComplete="new-password" className="hidden" tabIndex={-1} aria-hidden="true" />
          <div className="space-y-1.5">
            <Label htmlFor="edit-secret-value">
              New value{' '}
              <span className="text-xs font-normal text-muted-foreground">
                (leave blank to keep current)
              </span>
            </Label>
            <Input
              id="edit-secret-value"
              name="vault-secret-value"
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="••••••••"
              className="font-mono"
              autoComplete="new-password"
              data-1p-ignore="true"
              data-lpignore="true"
              data-form-type="other"
              disabled={updateMutation.isPending}
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={updateMutation.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={updateMutation.isPending} className="gap-1.5">
              {updateMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Save changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
