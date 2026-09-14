'use client';

import { useTranslations } from '@/i18n/use-translations';
/**
 * `MemberAccessPanel` — one person's detail surface, rendered INSIDE the
 * account hub pane (`/accounts/{id}?tab=members&member=<id>`), exactly like
 * `ProjectAccessPanel` renders inside `?tab=access-projects&project=<id>` and
 * `GroupAccessPanel` inside `?tab=groups&group=<id>`.
 *
 * It used to be a standalone route (`accounts/[id]/members/[userId]/page.tsx`)
 * that dropped the hub's left rail on the way in. Same shell now, same
 * breadcrumb pattern, same stacked `AccessList` sections:
 *
 *   - back "All members" → the members list (drops the `member` query param)
 *   - header: `UserAvatar` · email · You / Super / 2FA badges · role · joined ·
 *     a kebab that is a SUPERSET of the list row's — every action the row
 *     offers (Edit access, Remove from account) plus the two only this surface
 *     has (View as this member, Grant / Revoke super-admin)
 *   - body: **Projects**, **Groups**, then **What they can do**
 *
 * Nothing about the data changed: the same three queries answer it, the same
 * `AccessDialog` edits a project grant (still seeded from a completed
 * `listProjectResourceGrants` fetch so an agent subset is never silently
 * widened), and `ViewAsUserDialog` is the same read-only simulator.
 */

import {
  CheckIcon as Check,
  EyeIcon as Eye,
  FolderOpenIcon as FolderOpen,
  DotsThreeIcon as MoreHorizontal,
  ArrowSquareOutIcon as OpenIcon,
  PencilSimpleIcon as PencilSimple,
  ShieldIcon as Shield,
  ShieldSlashIcon as ShieldOff,
  TrashIcon,
  UsersIcon as Users,
  XIcon as X,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

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
import { InlineMeta } from '@/components/ui/inline-meta';
import { Label } from '@/components/ui/label';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
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
  builtinRoleLabel,
  customRole,
  formatDate,
  formatList,
  principalLabel,
  type KebabItem,
  type RoleValue,
} from '@/features/workspace/shared/access';
import {
  listMemberGroups,
  listMemberProjectAccess,
  listPermissions,
  listPolicies,
  setMemberSuperAdmin,
  type MemberGroupSummary,
  type MemberProjectAccess,
} from '@/lib/iam-client';
import { usePermission, usePermissionsFor } from '@/lib/use-permission';
import { cn } from '@/lib/utils';
import {
  listAccountMembers,
  listProjectResourceGrants,
  removeAccountMember,
  type IamPolicy,
} from '@kortix/sdk';
import { invalidatePermissionProbes, qk } from '@kortix/sdk/react';
import { areaLabel, permissionLabel } from './role-capability-matrix';

const PANEL = 'bg-popover rounded-md border';

/** A single custom-role grant, as returned per-project (`custom_role_policies`)
 *  or once account-wide (`account_wide_policies`) by GET .../project-access. */
type CustomRolePolicy = NonNullable<MemberProjectAccess['custom_role_policies']>[number];

const SOURCE_LABEL: Record<MemberProjectAccess['sources'][number], string> = {
  implicit: 'Account admin',
  direct: 'Direct',
  group: 'Group',
};

const PROJECT_ROLE_RANK = { manager: 3, editor: 2, member: 1 } as const;

/** The DIRECT custom-role policy on a scope, if there is one. A group-inherited
 *  policy is not editable from the principal's own row — it belongs to the
 *  group. */
function directPolicy(policies: CustomRolePolicy[] | undefined): CustomRolePolicy | undefined {
  return policies?.find((p) => p.source === 'direct');
}

export interface MemberAccessPanelProps {
  accountId: string;
  accountName: string;
  memberUserId: string;
  /** The signed-in user — drives the "You" badge and hides self-destructive
   *  kebab items. */
  currentUserId: string;
  canUpdateRole: boolean;
  canRemove: boolean;
  rbacEnabled?: boolean;
  canManageRoles?: boolean;
  /** `policy.read` — the leaf `GET .../iam/policies` asserts. PERMISSION, a
   *  different axis from the `rbacEnabled` ENTITLEMENT above, and required
   *  (not optional-with-a-default) on purpose: a default of `true` reinstates
   *  the background 403 for every caller that forgets it, and a default of
   *  `false` silently blanks the custom-role line. The compiler should make a
   *  new call site answer the question. The hub already has the verdict in its
   *  batched probe — pass it down, do not re-probe. */
  canReadPolicies: boolean;
  /** `role.read` — asserted by `GET .../iam/permissions`, the CATALOG read
   *  behind "What they can do" and "View as this member"
   *  (`apps/api/src/accounts/iam/assignments.ts`, the `/iam/permissions`
   *  route). Without it the catalog comes back 403 and both surfaces can only
   *  ever render empty, so they are not rendered at all — the same rule the
   *  hub's left rail follows. Required, for the reason above. */
  canReadRoles: boolean;
  /** Back to the members list — the hub drops the `?member=` param. */
  onBack: () => void;
  /** Opens a group in the hub's Groups pane (`?tab=groups&group=<id>`). */
  onOpenGroup: (groupId: string) => void;
}

export function MemberAccessPanel({
  accountId,
  accountName,
  memberUserId,
  currentUserId,
  canUpdateRole,
  canRemove,
  rbacEnabled = true,
  canManageRoles = false,
  canReadPolicies,
  canReadRoles,
  onBack,
  onOpenGroup,
}: MemberAccessPanelProps) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const queryClient = useQueryClient();
  const [grantConfirmOpen, setGrantConfirmOpen] = useState(false);
  const [revokeConfirmOpen, setRevokeConfirmOpen] = useState(false);
  const [viewAsOpen, setViewAsOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);

  const membersQuery = useQuery({
    queryKey: ['account-members', accountId],
    queryFn: () => listAccountMembers(accountId),
    staleTime: 20_000,
  });

  // Server-side derivation of this member's group memberships. Drives the
  // "Groups" section so admins can see at a glance which policies the user
  // inherits via group attachments.
  const memberGroupsQuery = useQuery({
    queryKey: ['member-groups', accountId, memberUserId],
    queryFn: () => listMemberGroups(accountId, memberUserId),
    staleTime: 30_000,
  });

  // Which projects this member reaches, at what role, and how. Lifted to the
  // panel because the header's role line needs the same answer's
  // `account_wide_policies` — an account-scoped custom role IS part of "what
  // role are they", not a separate panel.
  const projectAccessQuery = useQuery({
    queryKey: ['iam-member-project-access', accountId, memberUserId],
    queryFn: () => listMemberProjectAccess(accountId, memberUserId),
    staleTime: 30_000,
  });

  // The member's ACCOUNT role is one value: a built-in role, or a custom role
  // riding on the `member` baseline plus one account-scoped `iam_policies`
  // row. `AccessDialog`'s edit mode needs both the value and the policy id.
  //
  // Two axes, both required. ENTITLEMENT (`rbacEnabled`): without `rbac` there
  // are no policies to resolve. PERMISSION (`canReadPolicies`): `GET
  // .../iam/policies` asserts `policy.read`, which sits in ADMIN_EXTRAS and
  // never in the member baseline (`apps/api/src/iam/role-perms.ts`). The
  // entitlement alone was the gate, so a plain member — who holds `member.read`
  // and can therefore open this panel from `?tab=members&member=<id>` — took a
  // background 403 here on every drill-down. `=== true`, not `!== false`:
  // `CanResult.allowed` reads `false` while the probe is in flight, so an
  // optimistic gate fires the very request it exists to suppress.
  const policiesQuery = useQuery({
    queryKey: ['iam-policies', accountId, 'member', memberUserId],
    queryFn: () => listPolicies(accountId, { principalType: 'member', principalId: memberUserId }),
    enabled: rbacEnabled && canReadPolicies === true,
    staleTime: 30_000,
  });
  const accountPolicy: IamPolicy | undefined = useMemo(
    () => (policiesQuery.data ?? []).find((p) => p.scope_type === 'account'),
    [policiesQuery.data],
  );

  const setSuperAdminMutation = useMutation({
    mutationFn: (next: boolean) => setMemberSuperAdmin(accountId, memberUserId, next),
    onSuccess: (res) => {
      successToast(
        res.is_super_admin
          ? tI18nComplete.raw('text9648d371aee7')
          : tI18nComplete.raw('textecffbad40a81'),
      );
      // Super-admin is a total bypass: every verdict for this principal moves.
      void invalidatePermissionProbes(queryClient, { accountId, userId: memberUserId });
      queryClient.invalidateQueries({ queryKey: ['account-members', accountId] });
      setGrantConfirmOpen(false);
      setRevokeConfirmOpen(false);
    },
    onError: (err: Error) => errorToast(err.message || tI18nComplete.raw('text8eb4917bbe54')),
  });

  const member = useMemo(
    () => (membersQuery.data ?? []).find((m) => m.user_id === memberUserId),
    [membersQuery.data, memberUserId],
  );

  const removeMutation = useMutation({
    mutationFn: () => removeAccountMember(accountId, memberUserId),
    onSuccess: () => {
      successToast(tI18nComplete.raw('text23b0caa9d34a'));
      void invalidatePermissionProbes(queryClient, { accountId, userId: memberUserId });
      queryClient.invalidateQueries({ queryKey: ['account-members', accountId] });
      queryClient.invalidateQueries({ queryKey: ['account', accountId] });
      setRemoveOpen(false);
      onBack();
    },
    onError: (err: Error) => errorToast(err.message || tI18nComplete.raw('text1cff79b7eb0b')),
  });

  // canPromoteSuperAdmin gates the Grant/Revoke super-admin menu items below —
  // it's the caller's own member.super_admin.grant permission, the same
  // action the PATCH .../super-admin route asserts server-side.
  const canPromoteSuperAdmin = usePermission(accountId, 'member.super_admin.grant').allowed;
  // Owners and admins are implicit Manager on every project, so this is also
  // exactly the set of callers whose "Edit access" on a project row can never
  // 403. A project-only manager edits that grant from the project's own
  // Access list instead.
  const canEditProjectAccess = usePermission(accountId, 'member.update').allowed;

  const memberLabel = member ? principalLabel(member) : memberUserId;
  const accountWidePolicies = projectAccessQuery.data?.account_wide_policies ?? [];
  const isSelf = memberUserId === currentUserId;
  const isLastOwner =
    member?.account_role === 'owner' &&
    (membersQuery.data ?? []).filter((m) => m.account_role === 'owner').length === 1;
  const accountRoleValue: RoleValue | null = member
    ? accountPolicy
      ? customRole(accountPolicy.role_id)
      : builtinRole(member.account_role)
    : null;

  function invalidateMember() {
    queryClient.invalidateQueries({ queryKey: ['account-members', accountId] });
    queryClient.invalidateQueries({ queryKey: ['iam-policies', accountId] });
  }

  return (
    <AccessDetailShell
      back={{ label: tI18nComplete.raw('text3d6fe3e703f6'), onClick: onBack }}
      loading={membersQuery.isLoading}
      avatar={<UserAvatar email={memberLabel} name={member?.email ?? undefined} size="lg" />}
      title={memberLabel}
      badges={
        member ? (
          <>
            {isSelf ? (
              <Badge variant="secondary" size="sm">
                {tI18nComplete.raw('text08b041935798')}
              </Badge>
            ) : null}
            {member.is_super_admin ? (
              <Badge
                size="sm"
                className="bg-kortix-orange/15 text-kortix-orange border-transparent"
                title={tI18nComplete.raw('text3cafa764c6f9')}
              >
                {tI18nComplete.raw('text8185c8ac4656')}
              </Badge>
            ) : null}
            {member.has_verified_mfa ? (
              <Badge variant="success" size="sm" title={tI18nComplete.raw('textc56fc40bb882')}>
                2FA
              </Badge>
            ) : null}
          </>
        ) : null
      }
      meta={
        member ? (
          <InlineMeta className="text-sm">
            <span>{builtinRoleLabel('account', member.account_role, tI18nComplete)}</span>
            <span>
              {tI18nComplete.raw('text69318b0c6a92')} {formatDate(member.joined_at)}
            </span>
            {accountWidePolicies.length > 0 ? (
              <span>
                {tI18nComplete.raw('texte7bb06822dfd')}{' '}
                {formatList(accountWidePolicies.map((p) => p.role_name))}
              </span>
            ) : null}
          </InlineMeta>
        ) : null
      }
      actions={
        member ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="text-muted-foreground hover:text-foreground size-7 shrink-0"
                aria-label={tI18nComplete('text33da220b1a34', { value0: memberLabel })}
              >
                <MoreHorizontal className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {canUpdateRole && !isSelf ? (
                <DropdownMenuItem onSelect={() => setEditOpen(true)} className="gap-2">
                  <PencilSimple className="size-3.5" />
                  {tI18nComplete.raw('texta514a684676a')}
                </DropdownMenuItem>
              ) : null}
              {/* Reads the same `role.read` catalog as CapabilitiesCard —
                  without the leaf the simulator has nothing to simulate. */}
              {canReadRoles ? (
                <DropdownMenuItem onSelect={() => setViewAsOpen(true)} className="gap-2">
                  <Eye className="size-3.5" />
                  {tI18nComplete.raw('text42bcffb92597')}
                </DropdownMenuItem>
              ) : null}
              {canPromoteSuperAdmin ? (
                <>
                  <DropdownMenuSeparator />
                  {member.is_super_admin ? (
                    <DropdownMenuItem onSelect={() => setRevokeConfirmOpen(true)} className="gap-2">
                      <ShieldOff className="size-3.5" />
                      {tI18nComplete.raw('text79449a68e98d')}
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem onSelect={() => setGrantConfirmOpen(true)} className="gap-2">
                      <Shield className="size-3.5" />
                      {tI18nComplete.raw('textbd59cb991302')}
                    </DropdownMenuItem>
                  )}
                </>
              ) : null}
              {canRemove && !isSelf ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={isLastOwner}
                    onSelect={() => setRemoveOpen(true)}
                    className="gap-2"
                  >
                    <TrashIcon className="size-3.5" />
                    {tI18nComplete.raw('text6bfa319e3d20')}
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null
      }
    >
      {membersQuery.isError ? (
        <ErrorState
          size="sm"
          title={tI18nComplete.raw('textc88462000c01')}
          description={(membersQuery.error as Error).message}
          action={
            <Button variant="outline" size="sm" onClick={() => membersQuery.refetch()}>
              {tI18nComplete.raw('text942087cc2d41')}
            </Button>
          }
        />
      ) : null}

      {!membersQuery.isLoading && !member ? (
        <InfoBanner tone="neutral">{tI18nComplete.raw('textf75481058771')}</InfoBanner>
      ) : null}

      {member ? (
        <MemberProjectAccessSection
          accountId={accountId}
          memberUserId={member.user_id}
          memberLabel={memberLabel}
          accountRole={member.account_role}
          canEdit={!!canEditProjectAccess}
          query={projectAccessQuery}
        />
      ) : null}

      {member ? (
        <MemberGroupsSection
          memberGroups={memberGroupsQuery.data ?? []}
          isLoading={memberGroupsQuery.isLoading}
          onOpenGroup={onOpenGroup}
        />
      ) : null}

      {/* The catalog read behind this card asserts `role.read`. A viewer
          without it gets a 403 and an empty grid, so the card does not exist
          for them — the hub's rail rule ("a pane that can only fail to load is
          not a pane"), applied one level down. */}
      {member && canReadRoles ? (
        <CapabilitiesCard accountId={accountId} memberUserId={member.user_id} />
      ) : null}

      {member && accountRoleValue ? (
        <AccessDialog
          open={editOpen}
          onOpenChange={setEditOpen}
          accountId={accountId}
          accountName={accountName}
          scope={{ kind: 'account' }}
          mode={{
            kind: 'edit',
            principal: { type: 'member', id: member.user_id, label: memberLabel },
            current: { role: accountRoleValue },
          }}
          rbacEnabled={rbacEnabled}
          canManageRoles={canManageRoles}
          onDone={invalidateMember}
        />
      ) : null}

      <ConfirmDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        title={tI18nComplete.raw('text914d43beac26')}
        description={tI18nComplete('text0b628a266141', {
          value0: memberLabel,
          value1: accountName,
        })}
        confirmLabel={tI18nComplete.raw('textc3812fc4acb8')}
        confirmVariant="destructive"
        isPending={removeMutation.isPending}
        onConfirm={() => removeMutation.mutate()}
      />

      <ConfirmDialog
        open={grantConfirmOpen}
        onOpenChange={setGrantConfirmOpen}
        title={tI18nComplete.raw('textbd59cb991302')}
        description={
          <span>
            {tI18nComplete.raw('textde361b6ea9ec')} <strong>{memberLabel}</strong>{' '}
            {tI18nComplete.raw('textb4598b56508f')}
          </span>
        }
        confirmLabel={tI18nComplete.raw('textbd59cb991302')}
        isPending={setSuperAdminMutation.isPending}
        onConfirm={() => setSuperAdminMutation.mutate(true)}
      />

      <ConfirmDialog
        open={revokeConfirmOpen}
        onOpenChange={setRevokeConfirmOpen}
        title={tI18nComplete.raw('text79449a68e98d')}
        description={
          <span>
            <strong>{memberLabel}</strong> {tI18nComplete.raw('text8b728638c006')}
          </span>
        }
        confirmLabel={tI18nComplete.raw('text79449a68e98d')}
        confirmVariant="destructive"
        isPending={setSuperAdminMutation.isPending}
        onConfirm={() => setSuperAdminMutation.mutate(false)}
      />

      {member && canReadRoles ? (
        <ViewAsUserDialog
          open={viewAsOpen}
          onOpenChange={setViewAsOpen}
          accountId={accountId}
          memberUserId={member.user_id}
          memberLabel={memberLabel}
        />
      ) : null}
    </AccessDetailShell>
  );
}

// ─── Projects ─────────────────────────────────────────────────────────────

interface ProjectEditTarget {
  project: MemberProjectAccess;
  /** Seeded from the project's real resource grants so "Agents" opens on the
   *  truth, not on the "All agents" default. */
  agentIds: string[] | 'all';
}

function MemberProjectAccessSection({
  accountId,
  memberUserId,
  memberLabel,
  accountRole,
  canEdit,
  query,
}: {
  accountId: string;
  memberUserId: string;
  memberLabel: string;
  accountRole: string;
  canEdit: boolean;
  query: ReturnType<typeof useQuery<Awaited<ReturnType<typeof listMemberProjectAccess>>>>;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const queryClient = useQueryClient();
  const [editTarget, setEditTarget] = useState<ProjectEditTarget | null>(null);
  const [openingProjectId, setOpeningProjectId] = useState<string | null>(null);

  const items = useMemo(() => query.data?.projects ?? [], [query.data]);
  const isAdminLike = accountRole === 'owner' || accountRole === 'admin';

  const sorted = useMemo(
    () =>
      [...items].sort(
        (a, b) =>
          PROJECT_ROLE_RANK[b.role] - PROJECT_ROLE_RANK[a.role] ||
          a.project_name.localeCompare(b.project_name),
      ),
    [items],
  );

  // The dialog's Agents section is seeded from `current.agentIds`, so the
  // grants have to be in hand BEFORE it opens — otherwise a member limited to
  // 2 of 5 agents opens on "All agents" and a blind Save would look like a
  // widening. One fetch through the same query key `AccessDialog` reads, so
  // the dialog's own query is already warm.
  async function openEdit(project: MemberProjectAccess) {
    setOpeningProjectId(project.project_id);
    try {
      const data = await queryClient.fetchQuery({
        queryKey: qk.project.resourceGrants(project.project_id),
        queryFn: () => listProjectResourceGrants(project.project_id),
        staleTime: 30_000,
      });
      const agentIds = data.grants
        .filter(
          (g) =>
            g.resource_type === 'agent' &&
            g.principal_type === 'member' &&
            g.principal_id === memberUserId,
        )
        .map((g) => g.resource_id);
      setEditTarget({ project, agentIds: agentIds.length > 0 ? agentIds : 'all' });
    } catch {
      // A grants read the caller isn't allowed to make shouldn't block the
      // role edit — open on the default and let the save diff handle it.
      setEditTarget({ project, agentIds: 'all' });
    } finally {
      setOpeningProjectId(null);
    }
  }

  const editPolicy = editTarget ? directPolicy(editTarget.project.custom_role_policies) : undefined;
  const editRole: RoleValue | null = editTarget
    ? editPolicy
      ? customRole(editPolicy.role_id)
      : builtinRole(editTarget.project.role)
    : null;

  return (
    <>
      {query.isLoading ? (
        <Skeleton className="h-[58px] w-full rounded-md" />
      ) : query.isError ? (
        <ErrorState
          size="sm"
          title={tI18nComplete.raw('text19890c7ac88a')}
          description={(query.error as Error)?.message}
          action={
            <Button variant="outline" size="sm" onClick={() => query.refetch()}>
              {tI18nComplete.raw('text942087cc2d41')}
            </Button>
          }
        />
      ) : sorted.length === 0 ? (
        <EmptyState
          icon={FolderOpen}
          size="sm"
          title={tI18nComplete.raw('text5b9616df2058')}
          description={
            isAdminLike
              ? tI18nComplete('textdfad83e7eb69', {
                  value0: accountRole === 'owner' ? 'Owners' : 'Admins',
                })
              : tI18nComplete.raw('text25cc3dcfa2a5')
          }
        />
      ) : (
        <AccessList header={{ title: tI18nComplete.raw('text04e2a9728af7'), count: sorted.length }}>
          {sorted.map((project) => {
            const policy = directPolicy(project.custom_role_policies);
            const inheritedOnly = project.sources.length === 1 && project.sources[0] === 'implicit';
            const customNames = (project.custom_role_policies ?? []).map((p) => p.role_name);

            const kebab: KebabItem[] = [];
            if (canEdit && !inheritedOnly) {
              kebab.push({
                label: tI18nComplete.raw('texta514a684676a'),
                icon: <PencilSimple className="size-3.5" />,
                onSelect: () => void openEdit(project),
              });
            }
            kebab.push({
              label: tI18nComplete.raw('text5e5eba7f41ab'),
              icon: <OpenIcon className="size-3.5" />,
              href: `/projects/${project.project_id}`,
            });

            return (
              <AccessRow
                key={project.project_id}
                leading={<EntityAvatar label={project.project_name} icon={FolderOpen} size="md" />}
                title={project.project_name}
                meta={
                  <span className="text-muted-foreground text-xs">
                    <InlineMeta>
                      <span>
                        {tI18nComplete.raw('text4d327af41f96')}{' '}
                        {project.sources.map((s) => SOURCE_LABEL[s]).join(' + ')}
                      </span>
                      {customNames.length > 0 ? <span>{formatList(customNames)}</span> : null}
                    </InlineMeta>
                  </span>
                }
                trailing={
                  policy?.role_name ?? builtinRoleLabel('project', project.role, tI18nComplete)
                }
                href={`/projects/${project.project_id}`}
                pending={openingProjectId === project.project_id}
                kebab={kebab}
                kebabLabel={tI18nComplete('text33da220b1a34', { value0: project.project_name })}
                notEditable={
                  inheritedOnly && canEdit
                    ? {
                        hint: tI18nComplete.raw('text4e6c3453b25d'),
                      }
                    : undefined
                }
              />
            );
          })}
        </AccessList>
      )}

      {editTarget && editRole ? (
        <AccessDialog
          open
          onOpenChange={(open) => {
            if (!open) setEditTarget(null);
          }}
          accountId={accountId}
          scope={{
            kind: 'project',
            projectId: editTarget.project.project_id,
            projectName: editTarget.project.project_name,
          }}
          mode={{
            kind: 'edit',
            principal: { type: 'member', id: memberUserId, label: memberLabel },
            current: {
              role: editRole,
              agentIds: editTarget.agentIds,
              expiresAt: editPolicy?.expires_at ?? null,
            },
          }}
          inheritedFrom={(editTarget.project.custom_role_policies ?? [])
            .filter((p) => p.source === 'group' && p.group_name)
            .map((p) => p.group_name as string)}
          onDone={() => {
            void queryClient.invalidateQueries({
              queryKey: ['iam-member-project-access', accountId, memberUserId],
            });
          }}
        />
      ) : null}
    </>
  );
}

// ─── Groups ───────────────────────────────────────────────────────────────
// Which account groups this member belongs to. Same row as everywhere else,
// and clicking one stays in the hub — it opens the Groups pane's own panel.

function MemberGroupsSection({
  memberGroups,
  isLoading,
  onOpenGroup,
}: {
  memberGroups: MemberGroupSummary[];
  isLoading: boolean;
  onOpenGroup: (groupId: string) => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  if (isLoading) return <Skeleton className="h-[58px] w-full rounded-md" />;
  if (memberGroups.length === 0) {
    return (
      <EmptyState
        icon={Users}
        size="sm"
        title={tI18nComplete.raw('text9a70da1bb740')}
        description={tI18nComplete.raw('text5c101a14dc57')}
      />
    );
  }
  return (
    <AccessList
      header={{ title: tI18nComplete.raw('text39bbb719fa2b'), count: memberGroups.length }}
    >
      {memberGroups.map((group) => (
        <AccessRow
          key={group.group_id}
          leading={<EntityAvatar label={group.name} icon={Users} size="md" />}
          title={group.name}
          onClick={() => onOpenGroup(group.group_id)}
        />
      ))}
    </AccessList>
  );
}

// ─── Capabilities card ────────────────────────────────────────────────────
// "What this member can actually do" — a curated grid of common account-level
// capabilities, each probed via the IAM engine. Resolves the gap where an
// admin sees explicit policies + groups but can't easily tell which broad
// powers the union grants.

/**
 * The capability list, READ FROM THE CATALOG.
 *
 * This used to be two hand-curated arrays in this file — a 14-action grid and
 * an 11-action simulator — that disagreed with each other and with the server.
 * One of the simulator's rows named an action that is not a permission at all,
 * so it could never answer anything but "denied".
 *
 * Now both read `GET /accounts/:id/iam/permissions`: every account-scope
 * capability whose level is not `view` (a "power", not a read), grouped by the
 * catalog's own `area`.
 */
function useAccountCapabilities(accountId: string | undefined, enabled: boolean) {
  const query = useQuery({
    queryKey: ['iam-permissions', accountId, 'account'],
    queryFn: () => listPermissions(accountId as string, { scopeType: 'account' }),
    enabled: enabled && !!accountId,
    staleTime: 5 * 60_000,
  });

  const items = useMemo(
    () =>
      (query.data ?? [])
        .filter((permission) => permission.level !== 'view')
        .map((permission) => ({
          action: permission.action,
          label: permissionLabel(permission),
          area: permission.area,
        })),
    [query.data],
  );

  const probes = useMemo(() => items.map((item) => ({ action: item.action })), [items]);

  const groups = useMemo(() => {
    const order: string[] = [];
    const byArea = new Map<string, typeof items>();
    for (const item of items) {
      if (!byArea.has(item.area)) {
        byArea.set(item.area, []);
        order.push(item.area);
      }
      byArea.get(item.area)!.push(item);
    }
    return order.map((area) => ({ heading: areaLabel(area), items: byArea.get(area)! }));
  }, [items]);

  return { items, probes, groups, isLoading: query.isLoading };
}

function CapabilitiesCard({
  accountId,
  memberUserId,
}: {
  accountId: string;
  memberUserId: string;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  // One catalog read, then ONE batched probe over everything it named.
  const { items, probes, groups } = useAccountCapabilities(accountId, true);
  const results = usePermissionsFor(accountId, memberUserId, probes);
  const byAction = new Map(items.map((item, i) => [item.action, results[i]] as const));

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-3 px-1">
        <Label className="text-muted-foreground text-xs font-medium">
          {tI18nComplete.raw('text5161cce6217e')}
        </Label>
        <span className="text-muted-foreground text-xs">
          {tI18nComplete.raw('textd668b28cfe55')}
        </span>
      </div>
      <div className={cn(PANEL, 'divide-border divide-y')}>
        {groups.map((group) => (
          <div key={group.heading} className="px-4 py-4">
            <p className="text-muted-foreground mb-2 text-xs font-medium">{group.heading}</p>
            <div className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
              {group.items.map((item) => {
                const probe = byAction.get(item.action);
                return (
                  <CapabilityRow
                    key={item.action}
                    label={item.label}
                    allowed={probe?.allowed ?? false}
                    isLoading={probe?.isLoading ?? true}
                    reason={probe?.reason ?? null}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function CapabilityRow({
  label,
  allowed,
  isLoading,
  reason,
}: {
  label: string;
  allowed: boolean;
  isLoading: boolean;
  reason: string | null;
}) {
  return (
    <div
      className="flex items-center justify-between gap-3 text-sm"
      title={reason ? `Reason: ${reason}` : undefined}
    >
      <span className="text-foreground truncate">{label}</span>
      {isLoading ? (
        <span className="bg-muted-foreground/20 size-3.5 animate-pulse rounded-full" />
      ) : allowed ? (
        <span className="bg-kortix-green/15 text-kortix-green inline-flex size-5 items-center justify-center rounded-full">
          <Check className="size-3" />
        </span>
      ) : (
        <span className="bg-muted text-muted-foreground inline-flex size-5 items-center justify-center rounded-full">
          <X className="size-3" />
        </span>
      )}
    </div>
  );
}

// ─── View-as / permission simulator ───────────────────────────────────────
//
// Read-only "what would this user see?" — answers the question without
// requiring the admin to impersonate. Fans out usePermissionsFor against a
// curated set of common admin / project actions, and renders allowed / denied
// with the engine's reason text underneath denials.
//
// No backend changes — the /effective:batch endpoint already supports
// arbitrary user_id targets (gated by member.read on the caller).

function ViewAsUserDialog({
  open,
  onOpenChange,
  accountId,
  memberUserId,
  memberLabel,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  accountId: string;
  memberUserId: string;
  memberLabel: string;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  // Only probe when the dialog is open (saves the round-trip for
  // admins who never click View as). Probes intentionally exclude
  // resource-scoped actions like project.write on project X — the
  // engine answers "can they perform this action on the account",
  // which is the question this dialog should answer; the per-project
  // breakdown is the job of the Projects section above.
  // The SAME catalog-derived list the capabilities grid uses. Two curated
  // arrays used to answer this question two different ways in one file.
  const { items, probes, groups } = useAccountCapabilities(open ? accountId : undefined, open);
  const results = usePermissionsFor(
    open ? accountId : undefined,
    open ? memberUserId : undefined,
    probes,
  );
  const byAction = useMemo(
    () => new Map(items.map((item, i) => [item.action, results[i]] as const)),
    [items, results],
  );

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="lg:max-w-lg">
        <ModalHeader>
          <ModalTitle className="flex items-center gap-2">
            <Eye className="text-muted-foreground size-4" />
            {tI18nComplete.raw('textaaf36d769729')} {memberLabel}
          </ModalTitle>
          <ModalDescription>{tI18nComplete.raw('texta9e830d2e9c7')}</ModalDescription>
        </ModalHeader>

        <ModalBody className="max-h-[60vh] space-y-4 overflow-y-auto">
          {groups.map((group) => (
            <section key={group.heading} className="space-y-1.5">
              <p className="text-muted-foreground text-xs font-medium">{group.heading}</p>
              <ul className="divide-border bg-popover divide-y rounded-md border">
                {group.items.map((item) => {
                  const probe = byAction.get(item.action);
                  return (
                    <li key={item.action} className="flex items-start gap-3 px-3 py-2 text-sm">
                      <span className="mt-0.5 shrink-0">
                        {probe?.isLoading ? (
                          <span className="bg-muted block size-3.5 animate-pulse rounded-full" />
                        ) : probe?.allowed ? (
                          <Check className="text-kortix-green size-3.5" />
                        ) : (
                          <X className="text-kortix-red size-3.5" />
                        )}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-foreground">{item.label}</p>
                        {!probe?.allowed && probe?.reason && !probe.isLoading ? (
                          <p className="text-muted-foreground text-xs">{probe.reason}</p>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}

          <p className="text-muted-foreground text-xs">{tI18nComplete.raw('text9d53e28e9e39')}</p>
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}
