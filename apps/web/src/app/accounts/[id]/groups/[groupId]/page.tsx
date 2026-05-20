'use client';

import { useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Loader2, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { useAuth } from '@/components/AuthProvider';
import { ConnectingScreen } from '@/components/dashboard/connecting-screen';
import { AppHeader } from '@/components/layout/app-header';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PoliciesTable } from '@/components/iam/policies-table';
import {
  addGroupMembers,
  deleteGroup,
  getGroup,
  listGroupMembers,
  removeGroupMember,
  updateGroup,
} from '@/lib/iam-client';
import { getAccount, listAccountMembers } from '@/lib/projects-client';

export default function GroupDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string; groupId: string }>();
  const accountId = params?.id;
  const groupId = params?.groupId;
  const { user, isLoading: authLoading } = useAuth();

  const accountQuery = useQuery({
    queryKey: ['account', accountId],
    queryFn: () => getAccount(accountId!),
    enabled: !!user && !!accountId,
    staleTime: 30_000,
  });

  const groupQuery = useQuery({
    queryKey: ['group', accountId, groupId],
    queryFn: () => getGroup(accountId!, groupId!),
    enabled: !!user && !!accountId && !!groupId,
    staleTime: 30_000,
  });

  if (authLoading || !user) {
    return <ConnectingScreen forceConnecting overrideStage="auth" hideWorkspacePicker />;
  }

  const account = accountQuery.data;
  const group = groupQuery.data;
  const canManage = account?.role === 'owner' || account?.role === 'admin';

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <AppHeader user={user} />
      <main className="flex-1 px-4 py-8">
        <div className="mx-auto w-full max-w-4xl space-y-8">
          <div className="space-y-3">
            <button
              type="button"
              onClick={() => router.push('/projects')}
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Back to projects
            </button>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <button
                type="button"
                onClick={() => router.push('/accounts')}
                className="transition-colors hover:text-foreground"
              >
                Accounts
              </button>
              <span className="text-muted-foreground/40">/</span>
              <button
                type="button"
                onClick={() => router.push(`/accounts/${accountId}`)}
                className="transition-colors hover:text-foreground"
              >
                Groups
              </button>
              <span className="text-muted-foreground/40">/</span>
              {groupQuery.isLoading ? (
                <Skeleton className="h-4 w-24" />
              ) : (
                <span className="truncate font-medium text-foreground">
                  {group?.name ?? 'Group'}
                </span>
              )}
            </div>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">
                {groupQuery.isLoading ? <Skeleton className="h-7 w-48" /> : group?.name}
              </h1>
              {group?.description && (
                <p className="mt-1 text-sm text-muted-foreground">{group.description}</p>
              )}
            </div>
          </div>

          {groupQuery.isError && (
            <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-5">
              <p className="text-sm font-medium text-destructive">Failed to load group</p>
              <p className="mt-1 text-xs text-destructive/80">
                {(groupQuery.error as Error).message}
              </p>
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => groupQuery.refetch()}
              >
                Retry
              </Button>
            </div>
          )}

          {group && account && (
            <Tabs defaultValue="members" className="space-y-6">
              <TabsList>
                <TabsTrigger value="members">Group members</TabsTrigger>
                <TabsTrigger value="policies">Permission policies</TabsTrigger>
                <TabsTrigger value="settings">Settings</TabsTrigger>
              </TabsList>

              <TabsContent value="members">
                <GroupMembersCard
                  accountId={account.account_id}
                  groupId={group.group_id}
                  canManage={canManage}
                />
              </TabsContent>

              <TabsContent value="policies">
                <PoliciesTable
                  accountId={account.account_id}
                  principalType="group"
                  principalId={group.group_id}
                  principalLabel={`the "${group.name}" group`}
                  canManage={canManage}
                />
              </TabsContent>

              <TabsContent value="settings">
                <GroupSettingsCard
                  accountId={account.account_id}
                  groupId={group.group_id}
                  initialName={group.name}
                  initialDescription={group.description ?? ''}
                  canManage={canManage}
                  onDeleted={() => router.push(`/accounts/${account.account_id}`)}
                />
              </TabsContent>
            </Tabs>
          )}
        </div>
      </main>
    </div>
  );
}

// ─── Group members card ───────────────────────────────────────────────────

function GroupMembersCard({
  accountId,
  groupId,
  canManage,
}: {
  accountId: string;
  groupId: string;
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);

  const membersQuery = useQuery({
    queryKey: ['group-members', accountId, groupId],
    queryFn: () => listGroupMembers(accountId, groupId),
    staleTime: 20_000,
  });

  const accountMembersQuery = useQuery({
    queryKey: ['account-members', accountId],
    queryFn: () => listAccountMembers(accountId),
    staleTime: 30_000,
  });

  const emailByUserId = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of accountMembersQuery.data ?? []) {
      if (m.email) map.set(m.user_id, m.email);
    }
    return map;
  }, [accountMembersQuery.data]);

  const removeMutation = useMutation({
    mutationFn: (userId: string) => removeGroupMember(accountId, groupId, userId),
    onSuccess: () => {
      toast.success('Removed from group');
      queryClient.invalidateQueries({ queryKey: ['group-members', accountId, groupId] });
      queryClient.invalidateQueries({ queryKey: ['account-groups', accountId] });
      setRemoveTarget(null);
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to remove member'),
  });

  const members = membersQuery.data ?? [];

  return (
    <section className="rounded-xl border border-border/70 bg-card">
      <header className="flex items-center justify-between gap-3 border-b border-border/60 px-6 py-4">
        <div>
          <h2 className="text-base font-semibold text-foreground">
            Group members{' '}
            <span className="font-normal text-muted-foreground">({members.length})</span>
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Members of this group inherit every policy attached to it.
          </p>
        </div>
        {canManage && (
          <Button onClick={() => setAddOpen(true)} size="sm" className="gap-1.5">
            <Plus className="h-4 w-4" />
            Add members
          </Button>
        )}
      </header>

      {membersQuery.isLoading && (
        <div className="divide-y divide-border/60">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="px-6 py-3">
              <Skeleton className="h-4 w-48" />
            </div>
          ))}
        </div>
      )}

      {!membersQuery.isLoading && members.length === 0 && (
        <div className="px-6 py-12 text-center">
          <p className="text-sm font-medium text-foreground">No members in this group</p>
          {canManage && (
            <p className="mt-1 text-xs text-muted-foreground">
              Add account members to grant them this group&apos;s policies.
            </p>
          )}
        </div>
      )}

      {!membersQuery.isLoading && members.length > 0 && (
        <ul className="divide-y divide-border/60">
          {members.map((m) => {
            const label = emailByUserId.get(m.user_id) ?? m.user_id;
            return (
              <li key={m.user_id} className="flex items-center gap-3 px-6 py-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border/70 bg-background text-xs font-semibold text-foreground">
                  {(label[0] ?? '?').toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">{label}</p>
                  <p className="text-xs text-muted-foreground">
                    Added {new Date(m.added_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                  </p>
                </div>
                {canManage && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-destructive"
                    onClick={() => setRemoveTarget(m.user_id)}
                    aria-label="Remove from group"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <AddGroupMembersDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        accountId={accountId}
        groupId={groupId}
        existingUserIds={new Set(members.map((m) => m.user_id))}
        candidates={accountMembersQuery.data ?? []}
      />

      <ConfirmDialog
        open={!!removeTarget}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
        title="Remove from group"
        description="The user stays a member of the account but loses any access granted via this group."
        confirmLabel="Remove"
        isPending={removeMutation.isPending}
        onConfirm={() => {
          if (removeTarget) removeMutation.mutate(removeTarget);
        }}
      />
    </section>
  );
}

function AddGroupMembersDialog({
  open,
  onOpenChange,
  accountId,
  groupId,
  existingUserIds,
  candidates,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string;
  groupId: string;
  existingUserIds: Set<string>;
  candidates: Awaited<ReturnType<typeof listAccountMembers>>;
}) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const eligible = useMemo(
    () => candidates.filter((m) => !existingUserIds.has(m.user_id)),
    [candidates, existingUserIds],
  );

  const addMutation = useMutation({
    mutationFn: () => addGroupMembers(accountId, groupId, Array.from(selected)),
    onSuccess: (res) => {
      toast.success(`Added ${res.added} member${res.added === 1 ? '' : 's'}`);
      queryClient.invalidateQueries({ queryKey: ['group-members', accountId, groupId] });
      queryClient.invalidateQueries({ queryKey: ['account-groups', accountId] });
      setSelected(new Set());
      onOpenChange(false);
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to add members'),
  });

  function toggle(userId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (addMutation.isPending) return;
        if (!next) setSelected(new Set());
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add members</DialogTitle>
          <DialogDescription>
            Pick the account members to add to this group.
          </DialogDescription>
        </DialogHeader>
        {eligible.length === 0 ? (
          <p className="rounded-md border border-dashed border-border/60 px-3 py-6 text-center text-xs text-muted-foreground">
            Every account member is already in this group.
          </p>
        ) : (
          <div className="max-h-72 space-y-1 overflow-y-auto rounded-md border border-border/60 p-2">
            {eligible.map((m) => {
              const checked = selected.has(m.user_id);
              const label = m.email ?? m.user_id;
              return (
                <button
                  key={m.user_id}
                  type="button"
                  onClick={() => toggle(m.user_id)}
                  className={`flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left transition-colors ${
                    checked ? 'bg-primary/5' : 'hover:bg-muted/40'
                  }`}
                  disabled={addMutation.isPending}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    readOnly
                    className="h-3.5 w-3.5 rounded border-border accent-primary"
                  />
                  <span className="truncate text-sm">{label}</span>
                </button>
              );
            })}
          </div>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={addMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => addMutation.mutate()}
            disabled={selected.size === 0 || addMutation.isPending}
            className="gap-1.5"
          >
            {addMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Add {selected.size > 0 && `(${selected.size})`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Group settings card ──────────────────────────────────────────────────

function GroupSettingsCard({
  accountId,
  groupId,
  initialName,
  initialDescription,
  canManage,
  onDeleted,
}: {
  accountId: string;
  groupId: string;
  initialName: string;
  initialDescription: string;
  canManage: boolean;
  onDeleted: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const updateMutation = useMutation({
    mutationFn: () =>
      updateGroup(accountId, groupId, {
        name: name.trim(),
        description: description.trim() || null,
      }),
    onSuccess: () => {
      toast.success('Group updated');
      queryClient.invalidateQueries({ queryKey: ['group', accountId, groupId] });
      queryClient.invalidateQueries({ queryKey: ['account-groups', accountId] });
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to update group'),
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteGroup(accountId, groupId),
    onSuccess: () => {
      toast.success('Group deleted');
      queryClient.invalidateQueries({ queryKey: ['account-groups', accountId] });
      onDeleted();
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to delete group'),
  });

  const dirty =
    name.trim() !== initialName || description.trim() !== (initialDescription ?? '');

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-border/70 bg-card">
        <header className="border-b border-border/60 px-6 py-4">
          <h2 className="text-base font-semibold text-foreground">Group details</h2>
        </header>
        <div className="space-y-4 px-6 py-5">
          <div className="space-y-1.5">
            <Label htmlFor="group-name">Name</Label>
            <Input
              id="group-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={128}
              disabled={!canManage || updateMutation.isPending}
              className="max-w-md"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="group-description">Description</Label>
            <Input
              id="group-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={256}
              disabled={!canManage || updateMutation.isPending}
              className="max-w-md"
            />
          </div>
          <div className="flex justify-end border-t border-border/60 pt-4">
            <Button
              onClick={() => updateMutation.mutate()}
              disabled={!canManage || !dirty || !name.trim() || updateMutation.isPending}
              className="gap-1.5"
            >
              {updateMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Save
            </Button>
          </div>
        </div>
      </section>

      {canManage && (
        <section className="rounded-xl border border-destructive/30 bg-destructive/5">
          <header className="border-b border-destructive/20 px-6 py-4">
            <h2 className="text-base font-semibold text-destructive">Danger zone</h2>
            <p className="mt-0.5 text-xs text-destructive/80">
              Deleting a group removes every permission policy attached to it. Members
              keep their account membership.
            </p>
          </header>
          <div className="flex items-center justify-between px-6 py-4">
            <p className="text-sm text-foreground">Delete this group</p>
            <Button variant="destructive" onClick={() => setDeleteOpen(true)}>
              Delete group
            </Button>
          </div>
        </section>
      )}

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete group"
        description={`Delete "${initialName}"? This cannot be undone.`}
        confirmLabel="Delete group"
        isPending={deleteMutation.isPending}
        onConfirm={() => deleteMutation.mutate()}
      />
    </div>
  );
}
