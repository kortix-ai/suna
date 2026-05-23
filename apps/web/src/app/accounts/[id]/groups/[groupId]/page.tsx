'use client';

import { useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Loader2, Plus, Trash2, Users } from 'lucide-react';
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
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { InfoBanner } from '@/components/ui/info-banner';
import { InlineMeta } from '@/components/ui/inline-meta';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { List, ListRow } from '@/components/ui/list';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';
import { UserAvatar } from '@/components/ui/user-avatar';
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
import { usePermission } from '@/lib/use-permission';

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

  // Granular permissions, sourced from the IAM engine. Each sub-tab gates on
  // the action it actually performs — no more single "admin or not" flag.
  // MUST be called before any conditional return (rules of hooks).
  const canManageMembers = usePermission(accountId, 'group.members.manage', {
    resourceType: 'group',
    resourceId: groupId,
  }).allowed;
  const canManagePolicies = usePermission(accountId, 'policy.create').allowed;
  const canEditGroup = usePermission(accountId, 'group.update', {
    resourceType: 'group',
    resourceId: groupId,
  }).allowed;
  const canDeleteGroup = usePermission(accountId, 'group.delete', {
    resourceType: 'group',
    resourceId: groupId,
  }).allowed;

  if (authLoading || !user) {
    return <ConnectingScreen forceConnecting overrideStage="auth" hideWorkspacePicker />;
  }

  const account = accountQuery.data;
  const group = groupQuery.data;

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <AppHeader user={user} />
      <main className="flex-1 px-4 py-8">
        <div className="mx-auto w-full max-w-4xl space-y-8">
          <div className="space-y-3">
            <button
              type="button"
              onClick={() => router.push('/projects')}
              className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Back to projects
            </button>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <button
                type="button"
                onClick={() => router.push('/accounts')}
                className="cursor-pointer transition-colors hover:text-foreground"
              >
                Accounts
              </button>
              <span className="text-muted-foreground/40">/</span>
              <button
                type="button"
                onClick={() => router.push(`/accounts/${accountId}`)}
                className="cursor-pointer transition-colors hover:text-foreground"
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
            <InfoBanner
              tone="destructive"
              title="Failed to load group"
              action={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => groupQuery.refetch()}
                >
                  Retry
                </Button>
              }
            >
              {(groupQuery.error as Error).message}
            </InfoBanner>
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
                  canManage={canManageMembers}
                />
              </TabsContent>

              <TabsContent value="policies">
                <PoliciesTable
                  accountId={account.account_id}
                  principalType="group"
                  principalId={group.group_id}
                  principalLabel={`the "${group.name}" group`}
                  canManage={canManagePolicies}
                />
              </TabsContent>

              <TabsContent value="settings">
                <GroupSettingsCard
                  accountId={account.account_id}
                  groupId={group.group_id}
                  initialName={group.name}
                  initialDescription={group.description ?? ''}
                  canEdit={canEditGroup}
                  canDelete={canDeleteGroup}
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
    <SectionCard
      title="Group members"
      count={members.length}
      description="Members of this group inherit every policy attached to it."
      action={
        canManage && (
          <Button onClick={() => setAddOpen(true)} size="sm" className="gap-1.5">
            <Plus className="h-4 w-4" />
            Add members
          </Button>
        )
      }
      flush
    >
      {membersQuery.isLoading && (
        <List>
          {Array.from({ length: 3 }).map((_, i) => (
            <li key={i} className="px-6 py-3">
              <Skeleton className="h-4 w-48" />
            </li>
          ))}
        </List>
      )}

      {!membersQuery.isLoading && members.length === 0 && (
        <EmptyState
          icon={Users}
          title="No members in this group"
          description={
            canManage
              ? "Add account members to grant them this group's policies."
              : undefined
          }
        />
      )}

      {!membersQuery.isLoading && members.length > 0 && (
        <List>
          {members.map((m) => {
            const label = emailByUserId.get(m.user_id) ?? m.user_id;
            return (
              <ListRow
                key={m.user_id}
                leading={<UserAvatar email={label} size="md" />}
                title={label}
                subtitle={
                  <InlineMeta>
                    <span>
                      Added{' '}
                      {new Date(m.added_at).toLocaleDateString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                      })}
                    </span>
                  </InlineMeta>
                }
                trailing={
                  canManage && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-foreground"
                      onClick={() => setRemoveTarget(m.user_id)}
                      aria-label="Remove from group"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )
                }
              />
            );
          })}
        </List>
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
    </SectionCard>
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
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-md">
        <DialogHeader className="border-b border-border/60 px-6 pt-6 pb-4">
          <DialogTitle className="text-lg font-semibold tracking-tight">
            Add members
          </DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            Pick the account members to add to this group.
          </DialogDescription>
        </DialogHeader>
        <div className="px-6 py-5">
          {eligible.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-border/60 px-3 py-6 text-center text-xs text-muted-foreground">
              Every account member is already in this group.
            </p>
          ) : (
            <div className="max-h-72 space-y-1 overflow-y-auto rounded-2xl border border-border/60 p-2">
              {eligible.map((m) => {
                const checked = selected.has(m.user_id);
                const label = m.email ?? m.user_id;
                return (
                  <button
                    key={m.user_id}
                    type="button"
                    onClick={() => toggle(m.user_id)}
                    className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors ${
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
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border/60 bg-muted/30 px-6 py-3">
          <Button
            type="button"
            variant="ghost"
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
        </div>
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
  canEdit,
  canDelete,
  onDeleted,
}: {
  accountId: string;
  groupId: string;
  initialName: string;
  initialDescription: string;
  canEdit: boolean;
  canDelete: boolean;
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
      <SectionCard title="Group details">
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="group-name">Name</Label>
            <Input
              id="group-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={128}
              disabled={!canEdit || updateMutation.isPending}
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
              disabled={!canEdit || updateMutation.isPending}
              className="max-w-md"
            />
          </div>
          <div className="flex justify-end border-t border-border/60 pt-4">
            <Button
              onClick={() => updateMutation.mutate()}
              disabled={!canEdit || !dirty || !name.trim() || updateMutation.isPending}
              className="gap-1.5"
            >
              {updateMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Save
            </Button>
          </div>
        </div>
      </SectionCard>

      {canDelete && (
        <SectionCard
          tone="destructive"
          title="Danger zone"
          description="Deleting a group removes every permission policy attached to it. Members keep their account membership."
          flush
        >
          <div className="flex items-center justify-between px-6 py-4">
            <p className="text-sm text-foreground">Delete this group</p>
            <Button variant="destructive" onClick={() => setDeleteOpen(true)}>
              Delete group
            </Button>
          </div>
        </SectionCard>
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
