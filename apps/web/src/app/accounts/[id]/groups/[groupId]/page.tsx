'use client';

import { useTranslations } from 'next-intl';

import { useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, FolderOpen, Loader2, Plus, Trash2, Users } from 'lucide-react';
import { toast } from '@/lib/toast';

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
import {
  countOverridingMembers,
  floatCurrentUserFirst,
  formatExpiry,
  isOverridingAccountRole,
  sortGroupMembersByOverride,
  type AccountMeta,
} from '@/components/iam/iam-display-helpers';
import {
  attachGroupToProject,
  detachGroupFromProject,
  getAccount,
  listAccountMembers,
  listProjectsForAccount,
  type ProjectRole,
} from '@/lib/projects-client';
import { usePermission } from '@/lib/use-permission';

export default function GroupDetailPage() {
  const tHardcodedUi = useTranslations('hardcodedUi');
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

  if (authLoading || !user) {
    return <ConnectingScreen forceConnecting overrideStage="auth" />;
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
              <ArrowLeft className="h-3.5 w-3.5" />{tHardcodedUi.raw('appAccountsIdGroupsGroupidPage.line99JsxTextBackToProjects')}</button>
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
              title={tHardcodedUi.raw('appAccountsIdGroupsGroupidPage.line139JsxAttrTitleFailedToLoadGroup')}
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
                <TabsTrigger value="members">{tHardcodedUi.raw('appAccountsIdGroupsGroupidPage.line157JsxTextGroupMembers')}</TabsTrigger>
                <TabsTrigger value="projects">Project access</TabsTrigger>
                <TabsTrigger value="settings">Settings</TabsTrigger>
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
  const tHardcodedUi = useTranslations('hardcodedUi');
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
      title={tHardcodedUi.raw('appAccountsIdGroupsGroupidPage.line249JsxAttrTitleGroupMembers')}
      count={members.length}
      description={tHardcodedUi.raw('appAccountsIdGroupsGroupidPage.line251JsxAttrDescriptionMembersOfThisGroupInheritEveryPolicyAttached')}
      action={
        canManage && (
          <Button onClick={() => setAddOpen(true)} size="sm" className="gap-1.5">
            <Plus className="h-4 w-4" />{tHardcodedUi.raw('appAccountsIdGroupsGroupidPage.line256JsxTextAddMembers')}</Button>
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
          title={tHardcodedUi.raw('appAccountsIdGroupsGroupidPage.line275JsxAttrTitleNoMembersInThisGroup')}
          description={
            canManage
              ? "Add account members to grant them this group's policies."
              : undefined
          }
        />
      )}

      {!membersQuery.isLoading && members.length > 0 && overrideCount > 0 && (
        <div className="border-b border-border/60 bg-amber-500/5 px-6 py-2.5 text-xs text-amber-700 dark:text-amber-300">
          <span className="font-medium">Heads-up:</span>{' '}
          {overrideCount} {overrideCount === 1 ? 'member is' : 'members are'} an
          account owner or admin. They get Manager on every project regardless
          of this group&apos;s role.
        </div>
      )}

      {!membersQuery.isLoading && members.length > 0 && (
        <List>
          {sortGroupMembersByOverride(members, accountMetaByUserId)
            .map((m) => {
              const label = emailByUserId.get(m.user_id) ?? m.user_id;
              const meta = accountMetaByUserId.get(m.user_id);
              const overrides = !!meta && isOverridingAccountRole(meta);
              const badgeLabel = meta?.isSuperAdmin
                ? 'super admin'
                : meta?.accountRole;
              return (
                <ListRow
                  key={m.user_id}
                  leading={<UserAvatar email={label} size="md" />}
                  title={label}
                  badges={
                    overrides && badgeLabel ? (
                      <span
                        className="rounded-2xl border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-normal capitalize text-amber-700 dark:text-amber-300"
                        title="Account owners and admins always have Manager access on every project, regardless of group role."
                      >
                        {badgeLabel}
                      </span>
                    ) : meta?.accountRole === 'member' ? (
                      <span className="rounded-2xl border border-border/60 px-1.5 py-0.5 text-[10px] font-normal capitalize text-muted-foreground">
                        member
                      </span>
                    ) : null
                  }
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
                        aria-label={tHardcodedUi.raw('appAccountsIdGroupsGroupidPage.line312JsxAttrAriaLabelRemoveFromGroup')}
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
        title={tHardcodedUi.raw('appAccountsIdGroupsGroupidPage.line338JsxAttrTitleRemoveFromGroup')}
        description={tHardcodedUi.raw('appAccountsIdGroupsGroupidPage.line339JsxAttrDescriptionTheUserStaysAMemberOfTheAccount')}
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
  const tHardcodedUi = useTranslations('hardcodedUi');
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
          <DialogTitle className="text-lg font-semibold tracking-tight">{tHardcodedUi.raw('appAccountsIdGroupsGroupidPage.line406JsxTextAddMembers')}</DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">{tHardcodedUi.raw('appAccountsIdGroupsGroupidPage.line409JsxTextPickTheAccountMembersToAddToThis')}</DialogDescription>
        </DialogHeader>
        <div className="px-6 py-5">
          {eligible.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-border/60 px-3 py-6 text-center text-xs text-muted-foreground">{tHardcodedUi.raw('appAccountsIdGroupsGroupidPage.line415JsxTextEveryAccountMemberIsAlreadyInThisGroup')}</p>
          ) : (
            <div className="max-h-72 space-y-1 overflow-y-auto rounded-2xl border border-border/60 p-2">
              {eligible.map((m) => {
                const checked = selected.has(m.user_id);
                const label = m.email ?? m.user_id;
                const isMe = m.user_id === currentUserId;
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
                    {isMe && (
                      <span className="ml-auto rounded-2xl border border-border/60 px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">
                        you
                      </span>
                    )}
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
  const tHardcodedUi = useTranslations('hardcodedUi');
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
      <SectionCard title={tHardcodedUi.raw('appAccountsIdGroupsGroupidPage.line522JsxAttrTitleGroupDetails')}>
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
          title={tHardcodedUi.raw('appAccountsIdGroupsGroupidPage.line562JsxAttrTitleDangerZone')}
          description={tHardcodedUi.raw('appAccountsIdGroupsGroupidPage.line563JsxAttrDescriptionDeletingAGroupRemovesEveryPermissionPolicyAttached')}
          flush
        >
          <div className="flex items-center justify-between px-6 py-4">
            <p className="text-sm text-foreground">{tHardcodedUi.raw('appAccountsIdGroupsGroupidPage.line567JsxTextDeleteThisGroup')}</p>
            <Button variant="destructive" onClick={() => setDeleteOpen(true)}>{tHardcodedUi.raw('appAccountsIdGroupsGroupidPage.line569JsxTextDeleteGroup')}</Button>
          </div>
        </SectionCard>
      )}

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={tHardcodedUi.raw('appAccountsIdGroupsGroupidPage.line578JsxAttrTitleDeleteGroup')}
        description={`Delete "${initialName}"? This cannot be undone.`}
        confirmLabel={tHardcodedUi.raw('appAccountsIdGroupsGroupidPage.line580JsxAttrConfirmlabelDeleteGroup')}
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
  const attachedProjectIds = useMemo(
    () => new Set(grants.map((g) => g.project_id)),
    [grants],
  );

  // Set rather than scalar so two concurrent detaches (admin clicks
  // Revoke on row A, then row B before A finishes) both show their
  // own spinner instead of A's spinner jumping to B.
  const [pendingProjectIds, setPendingProjectIds] = useState<Set<string>>(
    () => new Set(),
  );
  // Detach is destructive — strips every group member's inherited
  // access on the project at once. Confirm first.
  const [detachTarget, setDetachTarget] = useState<GroupProjectGrant | null>(null);

  const detachMutation = useMutation({
    // detach the grant via the per-project route — that's the one gated
    // by project.members.manage and the canonical write surface.
    mutationFn: (projectId: string) => detachGroupFromProject(projectId, groupId),
    onMutate: (projectId) =>
      setPendingProjectIds((prev) => new Set(prev).add(projectId)),
    onSettled: (_data, _error, projectId) =>
      setPendingProjectIds((prev) => {
        const next = new Set(prev);
        next.delete(projectId);
        return next;
      }),
    onSuccess: (_data, projectId) => {
      toast.success('Group detached from project');
      queryClient.invalidateQueries({ queryKey });
      queryClient.invalidateQueries({ queryKey: ['account-groups', accountId] });
      // The target project's Members card (in another tab) shows
      // every group member's effective access — detaching this group
      // removes a path. Invalidate so a stale tab refetches on next
      // focus.
      queryClient.invalidateQueries({ queryKey: ['project-access', projectId] });
      queryClient.invalidateQueries({ queryKey: ['project', projectId] });
    },
    onError: (err: Error) => toast.error(err.message || 'Failed to detach'),
  });

  return (
    <>
    <SectionCard
      flush
      title="Project access"
      description={`Projects "${groupName}" is attached to. Every group member inherits the chosen role on that project — except account owners and admins, who always have Manager.`}
      count={grants.length}
      action={
        <Button size="sm" className="gap-1.5" onClick={() => setAttachOpen(true)}>
          <Plus className="h-4 w-4" />
          Attach to project
        </Button>
      }
    >
      {grantsQuery.isLoading && (
        <div className="px-6 py-5">
          <Skeleton className="h-8 w-full" />
        </div>
      )}

      {!grantsQuery.isLoading && grantsQuery.isError && (
        <div className="px-6 py-5">
          <InfoBanner
            tone="destructive"
            title="Failed to load project access"
            action={
              <Button variant="outline" size="sm" onClick={() => grantsQuery.refetch()}>
                Retry
              </Button>
            }
          >
            {(grantsQuery.error as Error)?.message}
          </InfoBanner>
        </div>
      )}

      {!grantsQuery.isLoading && !grantsQuery.isError && grants.length === 0 && (
        <EmptyState
          icon={FolderOpen}
          title="Not attached to any project"
          description={`Click "Attach to project" to give "${groupName}" access to one of your projects.`}
        />
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


      {!grantsQuery.isLoading && grants.length > 0 && (
        <List>
          {grants.map((g: GroupProjectGrant) => {
            const busy = pendingProjectIds.has(g.project_id);
            return (
              <ListRow
                key={g.project_id}
                leading={
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-muted/60">
                    <FolderOpen className="h-4 w-4 text-muted-foreground" />
                  </span>
                }
                title={g.project_name}
                badges={
                  <span className="rounded-2xl border border-border/60 px-1.5 py-0.5 text-[10px] font-normal capitalize text-muted-foreground">
                    {g.role}
                  </span>
                }
                subtitle={
                  <InlineMeta>
                    <span>Attached {new Date(g.created_at).toLocaleDateString()}</span>
                    {g.expires_at && (
                      <span
                        className={
                          new Date(g.expires_at).getTime() < Date.now()
                            ? 'text-rose-600 dark:text-rose-400'
                            : 'text-amber-700 dark:text-amber-400'
                        }
                        title={new Date(g.expires_at).toLocaleString()}
                      >
                        {formatExpiry(g.expires_at)}
                      </span>
                    )}
                  </InlineMeta>
                }
                trailing={
                  busy ? (
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => setDetachTarget(g)}
                    >
                      Detach
                    </Button>
                  )
                }
              />
            );
          })}
        </List>
      )}
    </SectionCard>

    <ConfirmDialog
      open={detachTarget !== null}
      onOpenChange={(open) => {
        if (!open) setDetachTarget(null);
      }}
      title="Detach from project?"
      description={
        detachTarget ? (
          <span>
            <strong>{groupName}</strong> will no longer be attached to{' '}
            <strong>{detachTarget.project_name}</strong>. Every group
            member will lose their inherited{' '}
            <strong>{detachTarget.role}</strong> access on that
            project (unless they also have a direct grant or another
            group attached). Owners and admins keep their implicit
            Manager access either way.
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
    </>
  );
}

// ─── V2: Attach group → project dialog ───────────────────────────────────
//
// Opens from the Project access card. Lists every project in the account
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
  const [selectedProjectId, setSelectedProjectId] = useState<string | undefined>(
    undefined,
  );
  const [selectedRole, setSelectedRole] = useState<ProjectRole>('editor');
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
        (p) =>
          p.effective_project_role === 'manager' &&
          !attachedProjectIds.has(p.project_id),
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
      const expiresAt = expiresAtLocal
        ? new Date(expiresAtLocal).toISOString()
        : undefined;
      return attachGroupToProject(
        selectedProjectId,
        groupId,
        selectedRole,
        expiresAt,
      );
    },
    onSuccess: () => {
      toast.success(`"${groupName}" attached to project`);
      // selectedProjectId is non-null here — the mutationFn throws
      // synchronously if it isn't set, which short-circuits onSuccess.
      onAttached(selectedProjectId!);
    },
    onError: (err: Error) =>
      toast.error(err.message || 'Failed to attach group to project'),
  });

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Attach &quot;{groupName}&quot; to a project</DialogTitle>
          <DialogDescription>
            Every member of this group will inherit the chosen role on the
            project.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="space-y-1.5">
            <Label htmlFor="attach-project">Project</Label>
            {projectsQuery.isLoading ? (
              <Skeleton className="h-9 w-full" />
            ) : candidates.length === 0 ? (
              <p className="rounded-2xl border border-border/60 bg-muted/20 px-3 py-2.5 text-xs text-muted-foreground">
                {(projectsQuery.data ?? []).length === 0
                  ? 'No projects in this account yet.'
                  : attachedProjectIds.size > 0 &&
                    attachedProjectIds.size === (projectsQuery.data ?? []).filter(
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
                  <SelectValue placeholder="Choose a project…" />
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
            <Select
              value={selectedRole}
              onValueChange={(v) => setSelectedRole(v as ProjectRole)}
            >
              <SelectTrigger id="attach-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="manager">
                  Manager — full control of the project
                </SelectItem>
                <SelectItem value="editor">
                  Editor — read and write, no member or settings changes
                </SelectItem>
                <SelectItem value="viewer">Viewer — read-only</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="attach-expires" className="flex items-center gap-2">
              Expires
              <span className="text-[10px] font-normal text-muted-foreground">
                optional · leave blank for permanent
              </span>
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
            <p className="text-[11px] text-muted-foreground">
              The grant auto-revokes at this time. Group members lose
              this project on the next request after expiry; the audit
              log records the revocation within a minute.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={attachMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={() => attachMutation.mutate()}
            disabled={
              !selectedProjectId ||
              attachMutation.isPending ||
              candidates.length === 0
            }
            className="gap-1.5"
          >
            {attachMutation.isPending && (
              <Loader2 className="h-4 w-4 animate-spin" />
            )}
            Attach
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
