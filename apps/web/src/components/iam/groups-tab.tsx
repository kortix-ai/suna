'use client';

// Groups tab on the account page. List + create + delete + navigate to
// detail. Mirrors Cloudflare's "User Groups" surface.

import { FormEvent, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, MoreHorizontal, Plus, Search, Trash2, Users } from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
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
import { Skeleton } from '@/components/ui/skeleton';
import {
  type AccountGroup,
  createGroup,
  deleteGroup,
  listGroups,
} from '@/lib/iam-client';

interface GroupsTabProps {
  accountId: string;
  canManage: boolean;
}

export function GroupsTab({ accountId, canManage }: GroupsTabProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<AccountGroup | null>(null);

  const groupsQuery = useQuery({
    queryKey: ['account-groups', accountId],
    queryFn: () => listGroups(accountId),
    staleTime: 30_000,
  });

  const deleteMutation = useMutation({
    mutationFn: (groupId: string) => deleteGroup(accountId, groupId),
    onSuccess: () => {
      toast.success('Group deleted');
      queryClient.invalidateQueries({ queryKey: ['account-groups', accountId] });
      setDeleteTarget(null);
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to delete group'),
  });

  const filtered = useMemo(() => {
    const all = groupsQuery.data ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (g) =>
        g.name.toLowerCase().includes(q) ||
        (g.description?.toLowerCase().includes(q) ?? false),
    );
  }, [groupsQuery.data, search]);

  return (
    <section className="rounded-xl border border-border/70 bg-card">
      <header className="flex items-center justify-between gap-3 border-b border-border/60 px-6 py-4">
        <div>
          <h2 className="text-base font-semibold text-foreground">Groups</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Bundle members together and grant permission policies to the whole group.
          </p>
        </div>
        {canManage && (
          <Button onClick={() => setCreateOpen(true)} size="sm" className="gap-1.5">
            <Plus className="h-4 w-4" />
            Create a group
          </Button>
        )}
      </header>

      <div className="border-b border-border/60 px-6 py-3">
        <div className="relative max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by user group name..."
            className="h-9 pl-9"
          />
        </div>
      </div>

      {groupsQuery.isError && (
        <div className="px-6 py-5">
          <p className="text-sm text-destructive">
            {(groupsQuery.error as Error)?.message || 'Failed to load groups'}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => groupsQuery.refetch()}
          >
            Retry
          </Button>
        </div>
      )}

      {groupsQuery.isLoading && (
        <div className="divide-y divide-border/60">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 px-6 py-3">
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-3.5 w-40" />
                <Skeleton className="h-3 w-24" />
              </div>
            </div>
          ))}
        </div>
      )}

      {!groupsQuery.isLoading && !groupsQuery.isError && filtered.length === 0 && (
        <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-full border border-border/70 bg-background text-muted-foreground">
            <Users className="h-4 w-4" />
          </div>
          <div className="space-y-1">
            <p className="text-sm font-medium text-foreground">
              {search ? 'No groups match your search' : 'No groups yet'}
            </p>
            {!search && canManage && (
              <p className="text-xs text-muted-foreground">
                Create a group to start attaching permission policies.
              </p>
            )}
          </div>
        </div>
      )}

      {!groupsQuery.isLoading && filtered.length > 0 && (
        <div className="overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/60 bg-muted/20 text-left text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                <th className="px-6 py-2.5 font-medium">Name</th>
                <th className="px-3 py-2.5 font-medium">Source</th>
                <th className="px-3 py-2.5 font-medium">Members</th>
                <th className="px-3 py-2.5 font-medium">Permission policies</th>
                <th className="w-12 px-3 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {filtered.map((g) => (
                <tr
                  key={g.group_id}
                  className="cursor-pointer transition-colors hover:bg-muted/30"
                  onClick={() =>
                    router.push(`/accounts/${accountId}/groups/${g.group_id}`)
                  }
                >
                  <td className="px-6 py-3 font-medium text-foreground">
                    <div className="flex flex-col gap-0.5">
                      <span>{g.name}</span>
                      {g.description && (
                        <span className="text-xs font-normal text-muted-foreground">
                          {g.description}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-3 text-muted-foreground">
                    <Badge variant="outline" className="h-5 rounded-md px-1.5 text-[10px] font-normal capitalize">
                      {g.source}
                    </Badge>
                  </td>
                  <td className="px-3 py-3 text-muted-foreground">
                    {g.member_count ?? 0}
                  </td>
                  <td className="px-3 py-3 text-muted-foreground">
                    {g.policy_count ?? 0}
                  </td>
                  <td
                    className="px-3 py-3 text-right"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {canManage && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-muted-foreground hover:text-foreground"
                            aria-label={`Actions for ${g.name}`}
                          >
                            <MoreHorizontal className="h-3.5 w-3.5" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-44">
                          <DropdownMenuItem
                            onSelect={() => setDeleteTarget(g)}
                            className="gap-2 text-destructive focus:text-destructive"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            Delete group
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <CreateGroupDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        accountId={accountId}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="Delete group"
        description={
          deleteTarget
            ? `Delete "${deleteTarget.name}"? Any permission policies attached to this group will be removed.`
            : ''
        }
        confirmLabel="Delete group"
        isPending={deleteMutation.isPending}
        onConfirm={() => {
          if (deleteTarget) deleteMutation.mutate(deleteTarget.group_id);
        }}
      />
    </section>
  );
}

function CreateGroupDialog({
  open,
  onOpenChange,
  accountId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  const createMutation = useMutation({
    mutationFn: () =>
      createGroup(accountId, { name: name.trim(), description: description.trim() || undefined }),
    onSuccess: (group) => {
      toast.success('Group created');
      queryClient.invalidateQueries({ queryKey: ['account-groups', accountId] });
      setName('');
      setDescription('');
      onOpenChange(false);
      router.push(`/accounts/${accountId}/groups/${group.group_id}`);
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to create group'),
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
        if (!next) {
          setName('');
          setDescription('');
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create a group</DialogTitle>
          <DialogDescription>
            Groups bundle members together. Attach permission policies to the
            group so every member inherits them.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="group-name">Group name</Label>
            <Input
              id="group-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Engineering"
              maxLength={128}
              autoFocus
              required
              disabled={createMutation.isPending}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="group-description">
              Description{' '}
              <span className="text-xs font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="group-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Engineers shipping the platform"
              maxLength={256}
              disabled={createMutation.isPending}
            />
          </div>
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
              Create group
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
