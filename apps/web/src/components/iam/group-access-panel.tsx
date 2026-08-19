'use client';

/**
 * `GroupAccessPanel` — one group's detail surface, rendered INSIDE the account
 * hub pane (`/accounts/{id}?tab=groups&group=<id>`), exactly like
 * `ProjectAccessPanel` renders inside `?tab=access-projects&project=<id>`.
 *
 * It used to be a standalone route (`accounts/[id]/groups/[groupId]/page.tsx`)
 * with its own three tabs — Members / Access / Settings. Opening a group left
 * the hub: the left rail disappeared, the breadcrumb pointed at the account
 * name instead of the list you came from, and "Settings" was a third tab
 * holding one rename form. Next to the project panel it read as a different
 * product. This is the same shell, the same breadcrumb pattern, the same
 * stacked `AccessList` sections:
 *
 *   - back "All groups" → the groups list (drops the `group` query param)
 *   - header: `EntityAvatar Users` · name · "Synced from IdP" badge ·
 *     description · a kebab holding **Rename group** and **Delete group**
 *   - body: **Members** then **Access**, both `AccessList`/`AccessRow`
 *
 * The Settings tab is gone. Renaming a group is a two-field edit, so it is a
 * `Modal` off the header kebab; deleting is a destructive `ConfirmDialog` that
 * returns to the list. No tabs.
 *
 * Every guardrail from the old page is preserved, not re-derived:
 * IdP-managed (`source === 'scim'`) groups hide their membership affordances
 * and lock their name, the account owner/admin override banner still counts
 * overriding members, every mutating control gates on the same IAM probe, the
 * same query keys are invalidated, and the Edit-access dialog is still seeded
 * from a completed `listProjectResourceGrants` fetch so an agent subset can
 * never be silently widened by a blind Save.
 *
 * `selectedGroupId` / `onSelectGroup` live on `GroupsTab`; the account page
 * owns the `?group=` param.
 */

import {
  FolderOpenIcon,
  DotsThreeIcon as MoreHorizontal,
  PencilSimpleIcon,
  PlusIcon,
  TrashIcon,
  UsersIcon,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import {
  countOverridingMembers,
  isOverridingAccountRole,
  sortGroupMembersByOverride,
  type AccountMeta,
} from '@/components/iam/iam-display-helpers';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { InfoBanner } from '@/components/ui/info-banner';
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
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast } from '@/components/ui/toast';
import { UserAvatar } from '@/components/ui/user-avatar';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import {
  AccessDetailShell,
  AccessDialog,
  AccessList,
  AccessRow,
  builtinRole,
  customRole,
  formatDate,
  formatExpiry,
  removeAccessCopy,
  roleValueLabel,
  useAccountRoles,
  type RoleValue,
} from '@/features/workspace/shared/access';
import {
  deleteGroup,
  getGroup,
  listGroupMembers,
  listGroupProjectGrants,
  listPolicies,
  removeGroupMember,
  updateGroup,
  type GroupProjectGrant,
} from '@/lib/iam-client';
import { usePermission } from '@/lib/use-permission';
import {
  detachGroupFromProject,
  listAccountMembers,
  listProjectResourceGrants,
} from '@kortix/sdk';
import { contract, invalidatePermissionProbes, qk } from '@kortix/sdk/react';

const IDP_BADGE_TITLE =
  'This group is pushed by your identity provider via Directory Sync — its name and membership are managed there.';

export interface GroupAccessPanelProps {
  accountId: string;
  groupId: string;
  /** Hides the custom-role group inside `RoleSelect` when the tier lacks the
   *  `rbac` entitlement. Defaults to true so an unresolved tier is never
   *  silently downgraded. */
  rbacEnabled?: boolean;
  /** Back to the groups list — the hub drops the `?group=` param. */
  onBack: () => void;
}

export function GroupAccessPanel({
  accountId,
  groupId,
  rbacEnabled = true,
  onBack,
}: GroupAccessPanelProps) {
  const queryClient = useQueryClient();
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const groupQuery = useQuery({
    queryKey: ['group', accountId, groupId],
    queryFn: () => getGroup(accountId, groupId),
    staleTime: 30_000,
  });

  // Granular permissions from the IAM engine. Each control gates on the action
  // it actually performs — no single "admin or not" flag.
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
  // Same gate the account Roles tab uses — drives the "Create a custom role →"
  // shortcut inside the shared `RoleSelect`.
  const canManageRoles = usePermission(accountId, 'role.create').allowed;

  const deleteMutation = useMutation({
    mutationFn: () => deleteGroup(accountId, groupId),
    onSuccess: () => {
      successToast('Group deleted');
      // Deleting a group revokes every assignment it carried, for every member
      // of it — principals this screen cannot enumerate, so bust the account.
      void invalidatePermissionProbes(queryClient, { accountId });
      queryClient.invalidateQueries({ queryKey: ['account-groups', accountId] });
      setDeleteOpen(false);
      onBack();
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to delete group'),
  });

  const group = groupQuery.data;
  const idpManaged = group?.source === 'scim';
  const hasHeaderActions = !!group && (canEditGroup || canDeleteGroup);

  return (
    <AccessDetailShell
      back={{ label: 'All groups', onClick: onBack }}
      avatar={<EntityAvatar icon={UsersIcon} size="lg" />}
      title={group?.name ?? '…'}
      badges={
        idpManaged ? (
          <Badge variant="outline" size="sm" className="shrink-0" title={IDP_BADGE_TITLE}>
            Synced from IdP
          </Badge>
        ) : null
      }
      meta={group?.description || undefined}
      loading={groupQuery.isLoading}
      actions={
        hasHeaderActions ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="text-muted-foreground hover:text-foreground size-7 shrink-0"
                aria-label={`Actions for ${group.name}`}
              >
                <MoreHorizontal className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {canEditGroup ? (
                <DropdownMenuItem onSelect={() => setRenameOpen(true)} className="gap-2">
                  <PencilSimpleIcon className="size-3.5" />
                  Rename group
                </DropdownMenuItem>
              ) : null}
              {canDeleteGroup ? (
                <>
                  {canEditGroup ? <DropdownMenuSeparator /> : null}
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => setDeleteOpen(true)}
                    className="gap-2"
                  >
                    <TrashIcon className="size-3.5" />
                    Delete group
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null
      }
    >
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

      {group ? (
        <>
          <GroupMembersCard
            accountId={accountId}
            groupId={group.group_id}
            groupName={group.name}
            canManage={canManageMembers}
            idpManaged={group.source === 'scim'}
          />

          <GroupProjectAccessCard
            accountId={accountId}
            groupId={group.group_id}
            groupName={group.name}
            canManage={canManageMembers}
            rbacEnabled={rbacEnabled}
            canManageRoles={canManageRoles}
          />
        </>
      ) : null}

      {group ? (
        <RenameGroupModal
          key={`${group.group_id}:${group.name}`}
          open={renameOpen}
          onOpenChange={setRenameOpen}
          accountId={accountId}
          groupId={group.group_id}
          initialName={group.name}
          initialDescription={group.description ?? ''}
          canEdit={canEditGroup}
          idpManaged={group.source === 'scim'}
        />
      ) : null}

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete group"
        description={
          idpManaged
            ? `Delete "${group?.name ?? 'this group'}"? This cannot be undone — and if your identity provider still pushes this group, the next sync recreates it (without its project roles).`
            : `Delete "${group?.name ?? 'this group'}"? This cannot be undone. Members keep their account access.`
        }
        confirmLabel="Delete group"
        confirmVariant="destructive"
        isPending={deleteMutation.isPending}
        onConfirm={() => deleteMutation.mutate()}
      />
    </AccessDetailShell>
  );
}

// ─── Rename — the old Settings tab, as one modal ──────────────────────────

function RenameGroupModal({
  open,
  onOpenChange,
  accountId,
  groupId,
  initialName,
  initialDescription,
  canEdit,
  idpManaged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string;
  groupId: string;
  initialName: string;
  initialDescription: string;
  canEdit: boolean;
  /** SCIM-sourced group: the NAME is owned by the IdP (sign-in claims match by
   *  name; the API 409s a local rename). Description stays locally editable. */
  idpManaged: boolean;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);

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
      onOpenChange(false);
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to update group'),
  });

  const dirty = name.trim() !== initialName || description.trim() !== (initialDescription ?? '');

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (updateMutation.isPending) return;
        if (!next) {
          setName(initialName);
          setDescription(initialDescription);
        }
        onOpenChange(next);
      }}
    >
      <ModalContent className="sm:max-w-md">
        <ModalHeader>
          <ModalTitle>Rename group</ModalTitle>
          <ModalDescription>
            The name and description are how people find this group. Neither changes what it grants.
          </ModalDescription>
        </ModalHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!canEdit || !dirty || !name.trim() || updateMutation.isPending) return;
            updateMutation.mutate();
          }}
        >
          <ModalBody className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="group-name">Name</Label>
              <Input
                id="group-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={128}
                autoFocus
                disabled={!canEdit || updateMutation.isPending || idpManaged}
              />
              {idpManaged ? (
                <p className="text-muted-foreground text-xs">
                  The name is managed by your identity provider — rename the group there. Sign-in
                  group claims match by name, so a local rename would orphan its access.
                </p>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="group-description">
                Description{' '}
                <span className="text-muted-foreground text-xs font-normal">(optional)</span>
              </Label>
              <Input
                id="group-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={256}
                disabled={!canEdit || updateMutation.isPending}
              />
            </div>
          </ModalBody>
          <ModalFooter className="sm:justify-between">
            <Button
              type="button"
              variant="outline-ghost"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={updateMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={!canEdit || !dirty || !name.trim() || updateMutation.isPending}
              className="gap-1.5"
            >
              {updateMutation.isPending ? <Loading className="size-4 shrink-0" /> : null}
              Save
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}

// ─── Members section ──────────────────────────────────────────────────────

function GroupMembersCard({
  accountId,
  groupId,
  groupName,
  canManage,
  idpManaged,
}: {
  accountId: string;
  groupId: string;
  groupName: string;
  canManage: boolean;
  /** SCIM-sourced group: membership is owned by the IdP — the API 409s local
   *  edits (they'd be clobbered by the next push), so hide the affordances. */
  idpManaged: boolean;
}) {
  // Local membership edits only make sense for locally-owned groups.
  const canMutate = canManage && !idpManaged;
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
      // Group membership IS how the assignment reaches this person.
      void invalidatePermissionProbes(queryClient, { accountId });
      queryClient.invalidateQueries({ queryKey: ['group-members', accountId, groupId] });
      queryClient.invalidateQueries({ queryKey: ['account-groups', accountId] });
      setRemoveTarget(null);
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to remove member'),
  });

  const members = membersQuery.data ?? [];
  const removeLabel = removeTarget ? (emailByUserId.get(removeTarget) ?? removeTarget) : '';
  const settled = !membersQuery.isLoading;

  const addMembersButton = canMutate ? (
    <Button type="button" size="sm" className="gap-1.5" onClick={() => setAddOpen(true)}>
      <PlusIcon className="size-3.5" />
      Add members
    </Button>
  ) : undefined;

  return (
    <>
      {/* The IdP owns this membership — say so, and say where to change it. */}
      {idpManaged ? (
        <InfoBanner tone="info">
          Membership is synced from your identity provider — add or remove people there.
        </InfoBanner>
      ) : null}

      {settled && members.length > 0 && overrideCount > 0 ? (
        <InfoBanner tone="warning">
          {overrideCount} {overrideCount === 1 ? 'member is' : 'members are'} an account owner or
          admin — they keep Manager access on every project regardless of this group&apos;s role.
        </InfoBanner>
      ) : null}

      {membersQuery.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-[58px] w-full rounded-md" />
          ))}
        </div>
      ) : members.length === 0 ? (
        <EmptyState
          icon={UsersIcon}
          size="sm"
          title="No members in this group"
          description={
            idpManaged
              ? 'Members appear here as your identity provider pushes them.'
              : canMutate
                ? "Add account members to grant them this group's access."
                : undefined
          }
          action={addMembersButton}
        />
      ) : (
        <AccessList
          header={{ title: 'Members', count: members.length, actions: addMembersButton }}
        >
          {sortGroupMembersByOverride(members, accountMetaByUserId).map((m) => {
            const label = emailByUserId.get(m.user_id) ?? m.user_id;
            const meta = accountMetaByUserId.get(m.user_id);
            const overrides = !!meta && isOverridingAccountRole(meta);
            const badgeLabel = meta?.isSuperAdmin ? 'super admin' : meta?.accountRole;
            return (
              <AccessRow
                key={m.user_id}
                leading={<UserAvatar email={label} size="md" />}
                title={label}
                badges={
                  overrides && badgeLabel ? (
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
                  ) : null
                }
                metaParts={[`Added ${formatDate(m.added_at)}`]}
                kebabLabel={`Actions for ${label}`}
                kebab={
                  canMutate
                    ? [
                        {
                          label: 'Remove from group',
                          icon: <TrashIcon className="size-3.5" />,
                          variant: 'destructive' as const,
                          onSelect: () => setRemoveTarget(m.user_id),
                        },
                      ]
                    : undefined
                }
              />
            );
          })}
        </AccessList>
      )}

      <AccessDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        accountId={accountId}
        scope={{ kind: 'group', groupId, groupName }}
        mode={{ kind: 'grant' }}
        excludeUserIds={members.map((m) => m.user_id)}
      />

      <ConfirmDialog
        open={!!removeTarget}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
        confirmLabel="Remove from group"
        confirmVariant="destructive"
        isPending={removeMutation.isPending}
        onConfirm={() => {
          if (removeTarget) removeMutation.mutate(removeTarget);
        }}
        {...removeAccessCopy({ principal: removeLabel, scopeName: groupName })}
      />
    </>
  );
}

// ─── Access section — the projects this group is attached to ──────────────

function GroupProjectAccessCard({
  accountId,
  groupId,
  groupName,
  canManage,
  rbacEnabled,
  canManageRoles,
}: {
  accountId: string;
  groupId: string;
  groupName: string;
  /** Gates every mutating affordance in this section (attach / edit / detach).
   *  The server also gates the writes on the TARGET project's
   *  project.members.manage, and `AccessDialog`'s project picker only lists
   *  projects the caller manages — this is the client-side hide/disable half. */
  canManage: boolean;
  rbacEnabled: boolean;
  canManageRoles: boolean;
}) {
  const queryClient = useQueryClient();
  const grantsKey = ['group-project-grants', accountId, groupId];
  const [attachOpen, setAttachOpen] = useState(false);
  // The target OUTLIVES `editOpen` on purpose: clearing it on close would
  // unmount the modal mid-exit-animation.
  const [editTarget, setEditTarget] = useState<GroupProjectGrant | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [detachTarget, setDetachTarget] = useState<GroupProjectGrant | null>(null);

  const grantsQuery = useQuery({
    queryKey: grantsKey,
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
  const attachedProjectIds = useMemo(() => grants.map((g) => g.project_id), [grants]);

  // A custom role for this group at a project scope is ONE `iam_policies`
  // row layered on the built-in grant above. The row shows the custom
  // role's name instead of the built-in one, and `AccessDialog` needs the
  // policy id to switch away from it.
  const rolesQuery = useAccountRoles(accountId);
  const policiesQuery = useQuery({
    // Prefixed by ['iam-policies', accountId] so AccessDialog's invalidation
    // reaches this query too.
    queryKey: ['iam-policies', accountId, 'group', groupId],
    queryFn: () => listPolicies(accountId, { principalType: 'group', principalId: groupId }),
    staleTime: 30_000,
  });
  const policyByProjectId = useMemo(() => {
    const map = new Map<string, { policy_id: string; role_id: string }>();
    for (const p of policiesQuery.data ?? []) {
      if (p.scope_type === 'project' && p.scope_id) {
        map.set(p.scope_id, { policy_id: p.policy_id, role_id: p.role_id });
      }
    }
    return map;
  }, [policiesQuery.data]);

  function roleValueFor(grant: GroupProjectGrant): RoleValue {
    const policy = policyByProjectId.get(grant.project_id);
    return policy ? customRole(policy.role_id) : builtinRole(grant.role);
  }

  // Agent subsets live in the project's resource grants. Only the project
  // being edited is fetched, and under the SAME query key `AccessDialog`
  // reads — opening the dialog costs no second request.
  const editResourceGrants = useQuery({
    queryKey: qk.project.resourceGrants(editTarget?.project_id ?? ''),
    queryFn: () => listProjectResourceGrants(editTarget!.project_id),
    enabled: !!editTarget,
    ...contract('inventory'),
  });
  const editAgentIds = useMemo<string[] | 'all'>(() => {
    const ids = (editResourceGrants.data?.grants ?? [])
      .filter(
        (g) =>
          g.resource_type === 'agent' && g.principal_type === 'group' && g.principal_id === groupId,
      )
      .map((g) => g.resource_id);
    return ids.length > 0 ? ids : 'all';
  }, [editResourceGrants.data, groupId]);
  // Seed the dialog only once the grants are known — the draft is captured on
  // the closed → open transition, so opening early would seed "All agents"
  // over a real subset and silently drop it on save.
  const editReady =
    editOpen && !!editTarget && (editResourceGrants.isSuccess || editResourceGrants.isError);

  function invalidateGrants(projectId: string) {
    queryClient.invalidateQueries({ queryKey: grantsKey });
    queryClient.invalidateQueries({ queryKey: ['account-groups', accountId] });
    // The target project's access list (in another tab) shows group-derived
    // access for every member — without these it stays stale until the next
    // focus + staleTime.
    queryClient.invalidateQueries({ queryKey: qk.project.scope(projectId) });
  }

  const detachMutation = useMutation({
    // Detach via the per-project route — that's the one gated by
    // project.members.manage and the canonical write surface.
    mutationFn: (projectId: string) => detachGroupFromProject(projectId, groupId),
    onSuccess: (_data, projectId) => {
      successToast('Group detached from project');
      void invalidatePermissionProbes(queryClient, { accountId });
      invalidateGrants(projectId);
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to detach'),
  });

  const attachButton = canManage ? (
    <Button type="button" size="sm" className="gap-1.5" onClick={() => setAttachOpen(true)}>
      <PlusIcon className="size-3.5" />
      Attach to project
    </Button>
  ) : undefined;

  return (
    <>
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
          icon={FolderOpenIcon}
          size="sm"
          title="Not attached to any projects"
          description={`Attach "${groupName}" to a project and every member inherits the role you pick.`}
          action={attachButton}
        />
      ) : (
        <AccessList header={{ title: 'Access', count: grants.length, actions: attachButton }}>
          {grants.map((g) => {
            const expiry = formatExpiry(g.expires_at);
            return (
              <AccessRow
                key={g.project_id}
                leading={<EntityAvatar icon={FolderOpenIcon} size="md" />}
                title={g.project_name}
                trailing={roleValueLabel('project', roleValueFor(g), rolesQuery.data)}
                metaParts={[
                  `Attached ${formatDate(g.created_at)}`,
                  expiry.bounded ? (
                    <span
                      key="expiry"
                      className={expiry.expired ? 'text-kortix-red' : 'text-kortix-yellow'}
                    >
                      {expiry.expired ? 'Expired' : `Expires ${expiry.label}`}
                    </span>
                  ) : null,
                ].filter(Boolean)}
                pending={detachMutation.isPending && detachMutation.variables === g.project_id}
                kebabLabel={`Actions for ${g.project_name}`}
                kebab={
                  canManage
                    ? [
                        {
                          label: 'Edit access',
                          icon: <PencilSimpleIcon className="size-3.5" />,
                          onSelect: () => {
                            setEditTarget(g);
                            setEditOpen(true);
                          },
                        },
                        {
                          label: 'Detach',
                          icon: <TrashIcon className="size-3.5" />,
                          variant: 'destructive' as const,
                          separated: true,
                          onSelect: () => setDetachTarget(g),
                        },
                      ]
                    : undefined
                }
              />
            );
          })}
        </AccessList>
      )}

      {/* Attach: the project is picked INSIDE the dialog, so the scope names
          no project — it only tells the dialog to run its project-scoped role
          select and expiry field. Attach copy reads off the principal, never
          off `projectName`. */}
      <AccessDialog
        open={attachOpen}
        onOpenChange={setAttachOpen}
        accountId={accountId}
        scope={{ kind: 'project', projectId: '', projectName: '' }}
        mode={{ kind: 'attach', principal: { type: 'group', id: groupId, label: groupName } }}
        excludeProjectIds={attachedProjectIds}
        rbacEnabled={rbacEnabled}
        canManageRoles={canManageRoles}
        onDone={() => queryClient.invalidateQueries({ queryKey: grantsKey })}
      />

      {editTarget ? (
        <AccessDialog
          open={editReady}
          onOpenChange={setEditOpen}
          accountId={accountId}
          scope={{
            kind: 'project',
            projectId: editTarget.project_id,
            projectName: editTarget.project_name,
          }}
          mode={{
            kind: 'edit',
            principal: { type: 'group', id: groupId, label: groupName },
            current: {
              role: roleValueFor(editTarget),
              agentIds: editAgentIds,
              expiresAt: editTarget.expires_at ?? null,
            },
          }}
          rbacEnabled={rbacEnabled}
          canManageRoles={canManageRoles}
          onDone={() => {
            queryClient.invalidateQueries({ queryKey: grantsKey });
          }}
        />
      ) : null}

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
    </>
  );
}
