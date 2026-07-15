'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, FolderOpen, Plus, Trash2, Users } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { ConnectingScreen } from '@/components/dashboard/connecting-screen';
import {
  countOverridingMembers,
  floatCurrentUserFirst,
  formatExpiry,
  isOverridingAccountRole,
  sortGroupMembersByOverride,
  type AccountMeta,
} from '@/components/iam/iam-display-helpers';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { InfoBanner } from '@/components/ui/info-banner';
import { InlineMeta } from '@/components/ui/inline-meta';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import Loading from '@/components/ui/loading';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from '@/components/ui/modal';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { errorToast, successToast } from '@/components/ui/toast';
import { UserAvatar } from '@/components/ui/user-avatar';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { useAuth } from '@/features/providers/auth-provider';
import { isSingleAccountMode } from '@/lib/config';
import {
  addGroupMembers,
  deleteGroup,
  getGroup,
  listGroupMembers,
  listGroupProjectGrants,
  removeGroupMember,
  updateGroup,
  type GroupProjectGrant,
} from '@/lib/iam-client';
import { cn } from '@/lib/utils';
import {
  attachGroupToProject,
  detachGroupFromProject,
  getAccount,
  listAccountMembers,
  listProjectsForAccount,
  type ProjectRole,
} from '@kortix/sdk/projects-client';
import { usePermission } from '@/lib/use-permission';

// Entity row dialect shared with the customize section views.
const MEMBER_ROW = 'bg-popover flex items-center gap-3 rounded-md border px-4 py-2.5';

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
  const canEditGroup = usePermission(accountId, 'group.update', {
    resourceType: 'group',
    resourceId: groupId,
  }).allowed;
  const canDeleteGroup = usePermission(accountId, 'group.delete', {
    resourceType: 'group',
    resourceId: groupId,
  }).allowed;

  // Single-account deployments have no groups to manage — the account
  // settings nav already hides the Groups tab (sectionVisible.groups in
  // accounts/[id]/page.tsx), but this detail route is still directly
  // linkable/bookmarkable. Bounce back to the account page instead of
  // showing group-policy management that doesn't apply here.
  useEffect(() => {
    if (isSingleAccountMode() && accountId) {
      router.replace(`/accounts/${accountId}`);
    }
  }, [accountId, router]);

  if (authLoading || !user || isSingleAccountMode()) {
    return <ConnectingScreen forceConnecting overrideStage="auth" hideWorkspacePicker />;
  }

  const account = accountQuery.data;
  const group = groupQuery.data;

  return (
    <div className="mx-auto w-full max-w-6xl space-y-5 pb-10">
      <div className="space-y-5">
        <Link
          href={`/accounts/${accountId}?tab=groups`}
          className="text-muted-foreground hover:text-foreground flex w-fit items-center gap-1 text-sm transition-colors"
        >
          <ChevronLeft className="size-4" />
          {account?.name ?? 'Account'}
        </Link>

        <div className="flex min-w-0 items-center gap-3.5">
          {groupQuery.isLoading ? (
            <Skeleton className="size-10 rounded-md" />
          ) : (
            <EntityAvatar icon={Users} size="lg" />
          )}
          <div className="min-w-0 space-y-0.5">
            {groupQuery.isLoading ? (
              <Skeleton className="h-6 w-44" />
            ) : (
              <h2 className="text-foreground truncate text-xl font-medium">{group?.name}</h2>
            )}
            {group?.description ? (
              <p className="text-muted-foreground truncate text-sm">{group.description}</p>
            ) : null}
          </div>
        </div>
      </div>

      {groupQuery.isError ? (
        <ErrorState
          size="sm"
          title="Failed to load group"
          description={(groupQuery.error as Error).message}
          action={
            <Button variant="outline" size="sm" onClick={() => groupQuery.refetch()}>
              Retry
            </Button>
          }
        />
      ) : null}

      {group && account ? (
        <Tabs defaultValue="members" className="space-y-6">
          <TabsList type="underline" className="flex w-full items-center justify-start">
            <TabsTrigger value="members" className="w-fit flex-none">
              Members
            </TabsTrigger>
            <TabsTrigger value="projects" className="w-fit flex-none">
              Projects
            </TabsTrigger>
            <TabsTrigger value="settings" className="w-fit flex-none">
              Settings
            </TabsTrigger>
          </TabsList>

          <TabsContent value="members">
            <GroupMembersCard
              accountId={account.account_id}
              groupId={group.group_id}
              canManage={canManageMembers}
            />
          </TabsContent>

          <TabsContent value="projects">
            <GroupProjectGrantsCard
              accountId={account.account_id}
              groupId={group.group_id}
              groupName={group.name}
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
              onDeleted={() => router.push(`/accounts/${account.account_id}?tab=groups`)}
            />
          </TabsContent>
        </Tabs>
      ) : null}
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

  // Combined index of account-level info per user_id. Lets the group
  // members list show emails AND surface the account role badge — owners
  // and admins implicitly have Manager on every project, which overrides
  // any group-level role on that project. Worth flagging here so an
  // admin who adds another admin to a "Viewer" group understands the
  // grant is mostly cosmetic for that user.
  const accountMetaByUserId = useMemo(() => {
    const map = new Map<string, AccountMeta>();
    for (const m of accountMembersQuery.data ?? []) {
      map.set(m.user_id, {
        email: m.email,
        accountRole: m.account_role,
        isSuperAdmin: !!m.is_super_admin,
      });
    }
    return map;
  }, [accountMembersQuery.data]);
  const emailByUserId = useMemo(() => {
    const map = new Map<string, string>();
    for (const [id, meta] of accountMetaByUserId) {
      if (meta.email) map.set(id, meta.email);
    }
    return map;
  }, [accountMetaByUserId]);

  // Pure helpers in iam-display-helpers (unit-tested).
  const overrideCount = useMemo(
    () => countOverridingMembers(membersQuery.data ?? [], accountMetaByUserId),
    [membersQuery.data, accountMetaByUserId],
  );

  const removeMutation = useMutation({
    mutationFn: (userId: string) => removeGroupMember(accountId, groupId, userId),
    onSuccess: () => {
      successToast('Removed from group');
      queryClient.invalidateQueries({ queryKey: ['group-members', accountId, groupId] });
      queryClient.invalidateQueries({ queryKey: ['account-groups', accountId] });
      setRemoveTarget(null);
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to remove member'),
  });

  const members = membersQuery.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-0.5">
          <p className="text-foreground text-sm font-medium">
            Members{members.length > 0 ? ` · ${members.length}` : ''}
          </p>
          <p className="text-muted-foreground text-xs">
            Members of this group inherit every policy attached to it.
          </p>
        </div>
        {canManage ? (
          <Button size="sm" variant="secondary" className="gap-1.5" onClick={() => setAddOpen(true)}>
            <Plus className="size-4" />
            Add members
          </Button>
        ) : null}
      </div>

      {membersQuery.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-[58px] w-full rounded-md" />
          ))}
        </div>
      ) : null}

      {!membersQuery.isLoading && members.length === 0 ? (
        <EmptyState
          icon={Users}
          size="sm"
          title="No members in this group"
          description={
            canManage ? "Add account members to grant them this group's policies." : undefined
          }
        />
      ) : null}

      {!membersQuery.isLoading && members.length > 0 && overrideCount > 0 ? (
        <InfoBanner tone="warning">
          {overrideCount} {overrideCount === 1 ? 'member is' : 'members are'} an account owner or
          admin — they keep Manager access on every project regardless of this group&apos;s role.
        </InfoBanner>
      ) : null}

      {!membersQuery.isLoading && members.length > 0 ? (
        <ul className="space-y-2">
          {sortGroupMembersByOverride(members, accountMetaByUserId).map((m) => {
            const label = emailByUserId.get(m.user_id) ?? m.user_id;
            const meta = accountMetaByUserId.get(m.user_id);
            const overrides = !!meta && isOverridingAccountRole(meta);
            const badgeLabel = meta?.isSuperAdmin ? 'super admin' : meta?.accountRole;
            return (
              <li key={m.user_id} className={MEMBER_ROW}>
                <UserAvatar email={label} size="md" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-foreground truncate text-sm font-medium">{label}</span>
                    {overrides && badgeLabel ? (
                      <Badge
                        size="sm"
                        className="bg-kortix-orange/15 text-kortix-orange border-transparent capitalize"
                        title="Account owners and admins always have Manager on every project"
                      >
                        {badgeLabel}
                      </Badge>
                    ) : meta?.accountRole === 'member' ? (
                      <Badge variant="outline" size="sm" className="capitalize">
                        Member
                      </Badge>
                    ) : null}
                  </div>
                  <span className="text-muted-foreground text-xs">
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
                  </span>
                </div>
                {canManage ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground hover:text-foreground size-7 shrink-0"
                    onClick={() => setRemoveTarget(m.user_id)}
                    aria-label="Remove from group"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

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
        description="They stay a member of the account and only lose this group's policies."
        confirmLabel="Remove"
        isPending={removeMutation.isPending}
        onConfirm={() => {
          if (removeTarget) removeMutation.mutate(removeTarget);
        }}
      />
    </div>
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
  const { user } = useAuth();
  const currentUserId = user?.id ?? null;
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Filter out members already in the group, then float the current
  // user (if still eligible) to the first row. Adding yourself to a
  // group you just created is one of the most common actions in this
  // dialog — pinning your own row makes it a one-click step instead of
  // a scan-and-find. Pure sort in iam-display-helpers, unit-tested.
  const eligible = useMemo(
    () =>
      floatCurrentUserFirst(
        candidates.filter((m) => !existingUserIds.has(m.user_id)),
        currentUserId,
      ),
    [candidates, existingUserIds, currentUserId],
  );

  const addMutation = useMutation({
    mutationFn: () => addGroupMembers(accountId, groupId, Array.from(selected)),
    onSuccess: (res) => {
      successToast(`Added ${res.added} member${res.added === 1 ? '' : 's'}`);
      queryClient.invalidateQueries({ queryKey: ['group-members', accountId, groupId] });
      queryClient.invalidateQueries({ queryKey: ['account-groups', accountId] });
      setSelected(new Set());
      onOpenChange(false);
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to add members'),
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
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (addMutation.isPending) return;
        if (!next) setSelected(new Set());
        onOpenChange(next);
      }}
    >
      <ModalContent className="lg:max-w-md">
        <ModalHeader>
          <ModalTitle>Add members</ModalTitle>
          <ModalDescription>Pick the account members to add to this group.</ModalDescription>
        </ModalHeader>
        <ModalBody>
          {eligible.length === 0 ? (
            <p className="border-border text-muted-foreground rounded-md border border-dashed px-3 py-6 text-center text-xs">
              Every account member is already in this group.
            </p>
          ) : (
            <div className="bg-popover max-h-72 space-y-1 overflow-y-auto rounded-md border p-2">
              {eligible.map((m) => {
                const checked = selected.has(m.user_id);
                const label = m.email ?? m.user_id;
                const isMe = m.user_id === currentUserId;
                return (
                  <button
                    key={m.user_id}
                    type="button"
                    onClick={() => toggle(m.user_id)}
                    className={cn(
                      'flex w-full cursor-pointer items-center gap-3 rounded-md px-2.5 py-2 text-left transition-colors',
                      checked ? 'bg-primary/[0.05]' : 'hover:bg-accent',
                    )}
                    disabled={addMutation.isPending}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      readOnly
                      className="border-border accent-primary size-3.5 rounded"
                    />
                    <span className="truncate text-sm">{label}</span>
                    {isMe ? (
                      <Badge variant="secondary" size="sm" className="ml-auto">
                        You
                      </Badge>
                    ) : null}
                  </button>
                );
              })}
            </div>
          )}
        </ModalBody>
        <ModalFooter className="sm:justify-between">
          <Button
            type="button"
            variant="outline-ghost"
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
            {addMutation.isPending ? <Loading className="size-4 shrink-0" /> : null}
            Add {selected.size > 0 && `(${selected.size})`}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
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
      successToast('Group updated');
      queryClient.invalidateQueries({ queryKey: ['group', accountId, groupId] });
      queryClient.invalidateQueries({ queryKey: ['account-groups', accountId] });
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to update group'),
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteGroup(accountId, groupId),
    onSuccess: () => {
      successToast('Group deleted');
      queryClient.invalidateQueries({ queryKey: ['account-groups', accountId] });
      onDeleted();
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to delete group'),
  });

  const dirty = name.trim() !== initialName || description.trim() !== (initialDescription ?? '');

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <Label>General</Label>
        <div className="bg-popover rounded-md border">
          <div className="space-y-4 px-4 py-5">
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
          </div>
          <div className="border-border flex justify-end border-t px-4 py-3">
            <Button
              size="sm"
              onClick={() => updateMutation.mutate()}
              disabled={!canEdit || !dirty || !name.trim() || updateMutation.isPending}
              className="gap-1.5"
            >
              {updateMutation.isPending ? <Loading className="size-4 shrink-0" /> : null}
              Save
            </Button>
          </div>
        </div>
      </section>

      {canDelete ? (
        <section className="space-y-4">
          <Label>Danger zone</Label>
          <div className="bg-popover rounded-md border px-4 py-3">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="text-foreground text-sm font-medium">Delete this group</p>
                <p className="text-muted-foreground mt-0.5 text-xs">
                  Removes every policy attached to it. Members keep their account access.
                </p>
              </div>
              <Button
                variant="destructive"
                size="sm"
                className="shrink-0"
                onClick={() => setDeleteOpen(true)}
              >
                Delete group
              </Button>
            </div>
          </div>
        </section>
      ) : null}

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

// ─── V2: Projects this group is attached to ───────────────────────────────

function GroupProjectGrantsCard({
  accountId,
  groupId,
  groupName,
}: {
  accountId: string;
  groupId: string;
  groupName: string;
}) {
  const queryClient = useQueryClient();
  const queryKey = ['group-project-grants', accountId, groupId];
  const [attachOpen, setAttachOpen] = useState(false);

  const grantsQuery = useQuery({
    queryKey,
    queryFn: () => listGroupProjectGrants(accountId, groupId),
    staleTime: 30_000,
  });
  // Defensive client-side sort. The API also sets ORDER BY (see twin
  // query in apps/api/src/accounts/iam.ts), but a stable order here
  // means a role change can't ever visibly reshuffle rows even if a
  // future API refactor drops the ORDER BY.
  const grants = useMemo(() => {
    const raw = grantsQuery.data ?? [];
    return [...raw].sort((a, b) => {
      const t = a.created_at.localeCompare(b.created_at);
      return t !== 0 ? t : a.project_id.localeCompare(b.project_id);
    });
  }, [grantsQuery.data]);
  const attachedProjectIds = useMemo(() => new Set(grants.map((g) => g.project_id)), [grants]);

  // Set rather than scalar so two concurrent detaches (admin clicks
  // Revoke on row A, then row B before A finishes) both show their
  // own spinner instead of A's spinner jumping to B.
  const [pendingProjectIds, setPendingProjectIds] = useState<Set<string>>(() => new Set());
  // Detach is destructive — strips every group member's inherited
  // access on the project at once. Confirm first.
  const [detachTarget, setDetachTarget] = useState<GroupProjectGrant | null>(null);

  const detachMutation = useMutation({
    // detach the grant via the per-project route — that's the one gated
    // by project.members.manage and the canonical write surface.
    mutationFn: (projectId: string) => detachGroupFromProject(projectId, groupId),
    onMutate: (projectId) => setPendingProjectIds((prev) => new Set(prev).add(projectId)),
    onSettled: (_data, _error, projectId) =>
      setPendingProjectIds((prev) => {
        const next = new Set(prev);
        next.delete(projectId);
        return next;
      }),
    onSuccess: (_data, projectId) => {
      successToast('Group detached from project');
      queryClient.invalidateQueries({ queryKey });
      queryClient.invalidateQueries({ queryKey: ['account-groups', accountId] });
      // The target project's Members card (in another tab) shows
      // every group member's effective access — detaching this group
      // removes a path. Invalidate so a stale tab refetches on next
      // focus.
      queryClient.invalidateQueries({ queryKey: ['project-access', projectId] });
      queryClient.invalidateQueries({ queryKey: ['project', projectId] });
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to detach'),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-0.5">
          <p className="text-foreground text-sm font-medium">
            Projects{grants.length > 0 ? ` · ${grants.length}` : ''}
          </p>
          <p className="text-muted-foreground text-xs">
            Every group member inherits the chosen role on these projects. Account owners and
            admins always have Manager.
          </p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          className="gap-1.5"
          onClick={() => setAttachOpen(true)}
        >
          <Plus className="size-4" />
          Attach to project
        </Button>
      </div>

      {grantsQuery.isLoading ? (
        <Skeleton className="h-[58px] w-full rounded-md" />
      ) : grantsQuery.isError ? (
        <ErrorState
          size="sm"
          title="Failed to load projects"
          description={(grantsQuery.error as Error)?.message}
          action={
            <Button variant="outline" size="sm" onClick={() => grantsQuery.refetch()}>
              Retry
            </Button>
          }
        />
      ) : grants.length === 0 ? (
        <EmptyState
          icon={FolderOpen}
          size="sm"
          title="Not attached to any projects"
          description={`Attach "${groupName}" to a project to give its members access.`}
        />
      ) : (
        <ul className="space-y-2">
          {grants.map((g: GroupProjectGrant) => {
            const busy = pendingProjectIds.has(g.project_id);
            return (
              <li key={g.project_id} className={MEMBER_ROW}>
                <EntityAvatar icon={FolderOpen} size="md" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-foreground truncate text-sm font-medium">
                      {g.project_name}
                    </span>
                    <Badge variant="outline" size="sm" className="capitalize">
                      {g.role}
                    </Badge>
                  </div>
                  <span className="text-muted-foreground text-xs">
                    <InlineMeta>
                      <span>Attached {new Date(g.created_at).toLocaleDateString()}</span>
                      {g.expires_at ? (
                        <span
                          className={
                            new Date(g.expires_at).getTime() < Date.now()
                              ? 'text-kortix-red'
                              : 'text-kortix-yellow'
                          }
                          title={new Date(g.expires_at).toLocaleString()}
                        >
                          {formatExpiry(g.expires_at)}
                        </span>
                      ) : null}
                    </InlineMeta>
                  </span>
                </div>
                {busy ? (
                  <Loading className="text-muted-foreground size-4 shrink-0" />
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="shrink-0"
                    onClick={() => setDetachTarget(g)}
                  >
                    Detach
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <AttachToProjectDialog
        accountId={accountId}
        groupId={groupId}
        groupName={groupName}
        open={attachOpen}
        onOpenChange={setAttachOpen}
        attachedProjectIds={attachedProjectIds}
        onAttached={(attachedProjectId) => {
          queryClient.invalidateQueries({ queryKey });
          queryClient.invalidateQueries({ queryKey: ['account-groups', accountId] });
          // The target project's Members card (in another tab) shows
          // group-derived access for every member — without these the
          // tab would be stale until the next focus + 20s staleTime.
          queryClient.invalidateQueries({ queryKey: ['project-access', attachedProjectId] });
          queryClient.invalidateQueries({ queryKey: ['project', attachedProjectId] });
          setAttachOpen(false);
        }}
      />

      <ConfirmDialog
        open={detachTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDetachTarget(null);
        }}
        title="Detach from project"
        description={
          detachTarget ? (
            <span>
              <strong>{groupName}</strong> will no longer be attached to{' '}
              <strong>{detachTarget.project_name}</strong>. Every group member will lose their
              inherited <strong className="capitalize">{detachTarget.role}</strong> access.
            </span>
          ) : null
        }
        confirmLabel="Detach"
        confirmVariant="destructive"
        isPending={detachMutation.isPending}
        onConfirm={() => {
          if (!detachTarget) return;
          const target = detachTarget;
          setDetachTarget(null);
          detachMutation.mutate(target.project_id);
        }}
      />
    </div>
  );
}

// ─── V2: Attach group → project dialog ───────────────────────────────────
//
// Opens from the Projects section. Lists every project in the account
// the caller can manage (effective_project_role === 'manager'), minus
// projects this group is already attached to. POSTs to the canonical
// per-project group-grants endpoint (server-side gate on
// project.members.manage matches our client-side filter).

function AttachToProjectDialog({
  accountId,
  groupId,
  groupName,
  open,
  onOpenChange,
  attachedProjectIds,
  onAttached,
}: {
  accountId: string;
  groupId: string;
  groupName: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  attachedProjectIds: Set<string>;
  /** Receives the projectId so the parent can scope cache
   *  invalidations to the project that was just attached. */
  onAttached: (projectId: string) => void;
}) {
  const [selectedProjectId, setSelectedProjectId] = useState<string | undefined>(undefined);
  const [selectedRole, setSelectedRole] = useState<ProjectRole>('member');
  // Optional auto-revoke timestamp. Empty string = permanent (default).
  // Stored as the raw <input type="datetime-local"> value; we convert
  // to ISO on submit so the server can parse it.
  const [expiresAtLocal, setExpiresAtLocal] = useState<string>('');

  // Only fetch the project list when the dialog is open. Includes
  // effective_project_role so we can filter to manageable projects.
  const projectsQuery = useQuery({
    queryKey: ['projects-for-account', accountId],
    queryFn: () => listProjectsForAccount(accountId),
    enabled: open,
    staleTime: 30_000,
  });

  const candidates = useMemo(() => {
    const all = projectsQuery.data ?? [];
    return all
      .filter(
        (p) => p.effective_project_role === 'manager' && !attachedProjectIds.has(p.project_id),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [projectsQuery.data, attachedProjectIds]);

  // Reset picker state every time the dialog (re)opens so a stale
  // selection from a previous open doesn't pre-fill.
  function handleOpenChange(v: boolean) {
    if (v) {
      setSelectedProjectId(undefined);
      setSelectedRole('editor');
      setExpiresAtLocal('');
    }
    onOpenChange(v);
  }

  const attachMutation = useMutation({
    mutationFn: () => {
      if (!selectedProjectId) throw new Error('Pick a project first');
      // datetime-local gives us a naive local timestamp; convert to
      // ISO so server gets unambiguous UTC. Empty = permanent (null
      // would clear an existing expiry, but on attach there's nothing
      // to clear, so we just omit it).
      const expiresAt = expiresAtLocal ? new Date(expiresAtLocal).toISOString() : undefined;
      return attachGroupToProject(selectedProjectId, groupId, selectedRole, expiresAt);
    },
    onSuccess: () => {
      successToast(`"${groupName}" attached to project`);
      // selectedProjectId is non-null here — the mutationFn throws
      // synchronously if it isn't set, which short-circuits onSuccess.
      onAttached(selectedProjectId!);
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to attach group to project'),
  });

  return (
    <Modal open={open} onOpenChange={handleOpenChange}>
      <ModalContent className="lg:max-w-md">
        <ModalHeader>
          <ModalTitle>Attach “{groupName}” to a project</ModalTitle>
          <ModalDescription>
            Every member of this group gets the chosen role on the project.
          </ModalDescription>
        </ModalHeader>

        <ModalBody className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="attach-project">Project</Label>
            {projectsQuery.isLoading ? (
              <Skeleton className="h-9 w-full rounded-lg" />
            ) : candidates.length === 0 ? (
              <p className="bg-popover text-muted-foreground rounded-md border px-3 py-2.5 text-xs">
                {(projectsQuery.data ?? []).length === 0
                  ? 'No projects in this account yet.'
                  : attachedProjectIds.size > 0 &&
                      attachedProjectIds.size ===
                        (projectsQuery.data ?? []).filter(
                          (p) => p.effective_project_role === 'manager',
                        ).length
                    ? 'This group is already attached to every project you can manage.'
                    : 'You need Manager access on a project to attach a group to it.'}
              </p>
            ) : (
              <Select
                value={selectedProjectId ?? ''}
                onValueChange={(v) => setSelectedProjectId(v || undefined)}
              >
                <SelectTrigger id="attach-project">
                  <SelectValue placeholder="Choose a project" />
                </SelectTrigger>
                <SelectContent>
                  {candidates.map((p) => (
                    <SelectItem key={p.project_id} value={p.project_id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="attach-role">Role</Label>
            <Select value={selectedRole} onValueChange={(v) => setSelectedRole(v as ProjectRole)}>
              <SelectTrigger id="attach-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="manager">Manager</SelectItem>
                <SelectItem value="editor">Editor</SelectItem>
                <SelectItem value="member">Member</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="attach-expires" className="flex items-center gap-2">
              Expires
              <span className="text-muted-foreground text-xs font-normal">optional</span>
            </Label>
            {/* datetime-local renders the OS-native picker. We convert
                to ISO on submit. Min = now + 1 minute to dodge the
                "in the past" 400 from the server when an admin picks
                a date and the click lands a second later. */}
            <Input
              id="attach-expires"
              type="datetime-local"
              value={expiresAtLocal}
              onChange={(e) => setExpiresAtLocal(e.target.value)}
              min={new Date(Date.now() + 60_000).toISOString().slice(0, 16)}
              className="max-w-xs"
            />
            <p className="text-muted-foreground text-xs">
              The grant is removed automatically at this time.
            </p>
          </div>
        </ModalBody>

        <ModalFooter className="sm:justify-between">
          <Button
            variant="outline-ghost"
            onClick={() => handleOpenChange(false)}
            disabled={attachMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={() => attachMutation.mutate()}
            disabled={!selectedProjectId || attachMutation.isPending || candidates.length === 0}
            className="gap-1.5"
          >
            {attachMutation.isPending ? <Loading className="size-4 shrink-0" /> : null}
            Attach
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
