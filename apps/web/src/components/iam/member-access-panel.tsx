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
 * breadcrumb pattern, the account tables (`member-table.tsx`) for its lists:
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
  InfoIcon as Info,
  ShieldIcon as Shield,
  ShieldSlashIcon as ShieldOff,
  TrashIcon,
  UsersIcon as Users,
  XIcon as X,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { Badge } from '@kortix/ui/badge';
import { Button } from '@kortix/ui/button';
import { ConfirmDialog } from '@kortix/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@kortix/ui/dropdown-menu';
import { EntityAvatar } from '@kortix/ui/entity-avatar';
import { InfoBanner } from '@kortix/ui/info-banner';
import { InlineMeta } from '@kortix/ui/inline-meta';
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalHeader,
  ModalTitle,
} from '@kortix/ui/modal';
import { Skeleton } from '@kortix/ui/skeleton';
import { errorToast, successToast } from '@kortix/ui/toast';
import { UserAvatar } from '@kortix/ui/user-avatar';
import { EmptyState } from '@kortix/ui/empty-state';
import { ErrorState } from '@kortix/ui/error-state';
import {
  AccessDetailShell,
  builtinRole,
  builtinRoleLabel,
  customRole,
  formatDate,
  formatList,
  principalLabel,
  type KebabItem,
  type RoleValue,
} from '@kortix/ui/access/access/index';
import { AccessDialog } from '@kortix/ui/access';
import {
  listMemberGroups,
  listMemberProjectAccess,
  listProjectsForAccount,
  listPermissions,
  listPolicies,
  setMemberSuperAdmin,
  type MemberGroupSummary,
  type MemberProjectAccess,
} from '@/lib/iam-client';
import { usePermission, usePermissionsFor } from '@kortix/ui/workspace';
import { cn } from '@kortix/ui';
import {
  listAccountMembers,
  listProjectResourceGrants,
  removeAccountMember,
  type IamPolicy,
} from '@kortix/sdk';
import { contract, invalidatePermissionProbes, qk } from '@kortix/sdk/react';
import { areaLabel, permissionLabel } from './role-capability-model';
import Hint from '@kortix/ui/hint';
import { ButtonGroup } from '@kortix/ui/button-group';
import { useAccountHubSheet } from '@kortix/ui/internal/account-hub/hub-sheet';
import { useRouter } from 'next/navigation';
import { MemberTableHead, MemberTableRow, ROLE_TONE } from '@/features/accounts/hub/member-table';

const TABLE_HEAD = 'text-muted-foreground truncate text-xs font-medium';
/** A permission and its answer: the label wraps, the answer column is fixed. */
const CAPABILITY_GRID = 'grid grid-cols-[minmax(0,1fr)_7rem] items-center gap-4';

/** A table's title: the name and a neutral count. */
function TableTitle({ title, count }: { title: string; count?: number }) {
  return (
    <div className="flex min-h-8 items-center gap-2">
      <h3 className="text-foreground text-sm font-medium">{title}</h3>
      {count != null ? (
        <span className="text-muted-foreground text-sm tabular-nums">{count}</span>
      ) : null}
    </div>
  );
}

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
  const sheet = useAccountHubSheet();
  const queryClient = useQueryClient();
  const [grantConfirmOpen, setGrantConfirmOpen] = useState(false);
  const [revokeConfirmOpen, setRevokeConfirmOpen] = useState(false);
  const [viewAsOpen, setViewAsOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);

  const membersQuery = useQuery({
    queryKey: ['account-members', accountId],
    queryFn: () => listAccountMembers(accountId),
    ...contract('directory'),
  });

  // Server-side derivation of this member's group memberships. Drives the
  // "Groups" section so admins can see at a glance which policies the user
  // inherits via group attachments.
  const memberGroupsQuery = useQuery({
    queryKey: ['member-groups', accountId, memberUserId],
    queryFn: () => listMemberGroups(accountId, memberUserId),
    ...contract('directory'),
  });

  // Which projects this member reaches, at what role, and how. Lifted to the
  // panel because the header's role line needs the same answer's
  // `account_wide_policies` — an account-scoped custom role IS part of "what
  // role are they", not a separate panel.
  const projectAccessQuery = useQuery({
    queryKey: ['iam-member-project-access', accountId, memberUserId],
    queryFn: () => listMemberProjectAccess(accountId, memberUserId),
    ...contract('directory'),
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
    // "‹ Members" above the avatar, as the project page has "‹ Projects". The
    // breadcrumb (Settings / <account> / Members / <member>) stays the other way.
    <AccessDetailShell
      back={{ label: tI18nComplete.raw('text1044a4c056d0'), onClick: onBack }}
      loading={membersQuery.isLoading}
      avatar={
        <UserAvatar
          email={memberLabel}
          name={member?.email ?? undefined}
          size="lg"
          className="rounded-md after:rounded-md [&>*]:rounded-md"
        />
      }
      title={memberLabel}
      badges={
        member ? (
          <>
            {isSelf ? (
              <Badge variant="secondary" size="sm" className="rounded-sm ring-0">
                {tI18nComplete.raw('text08b041935798')}
              </Badge>
            ) : null}
            {/* Super admin is the top of the role ladder: the royal badge (R1). */}
            {member.is_super_admin ? (
              <Badge
                variant="royal"
                size="sm"
                className="rounded-sm ring-0"
                title={tI18nComplete.raw('text3cafa764c6f9')}
              >
                {tI18nComplete.raw('text8185c8ac4656')}
              </Badge>
            ) : null}
            {member.has_verified_mfa ? (
              <Badge
                variant="success"
                size="sm"
                className="rounded-sm normal-case ring-0"
                title={tI18nComplete.raw('textc56fc40bb882')}
              >
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
          <ButtonGroup>
          {/* What they can do opens beside the page in the hub's split sheet. */}
          {canReadRoles ? (
            <Hint label={tI18nComplete.raw('text5161cce6217e')}>
              <Button
                variant="ghost"
                size="icon"
                className="text-muted-foreground hover:text-foreground size-7 shrink-0"
                aria-label={tI18nComplete.raw('text5161cce6217e')}
                onClick={() =>
                  sheet.open({
                    title: tI18nComplete.raw('text5161cce6217e'),
                    description: `${memberLabel} · ${tI18nComplete.raw('textd668b28cfe55')}`,
                    body: <CapabilitiesCard accountId={accountId} memberUserId={member.user_id} />,
                  })
                }
              >
                <Info className="size-3.5" />
              </Button>
            </Hint>
          ) : null}
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
          </ButtonGroup>
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
  const router = useRouter();
  const [editTarget, setEditTarget] = useState<ProjectEditTarget | null>(null);
  const [openingProjectId, setOpeningProjectId] = useState<string | null>(null);

  const items = useMemo(() => query.data?.projects ?? [], [query.data]);
  // Each project's own tile (emoji or glyph), from the account's project list:
  // the member-access route carries names only. Same cache as the Projects pane.
  const projectsQuery = useQuery({
    queryKey: qk.projects.list(accountId),
    queryFn: () => listProjectsForAccount(accountId),
    ...contract('inventory'),
  });
  const projectById = useMemo(
    () => new Map((projectsQuery.data ?? []).map((project) => [project.project_id, project])),
    [projectsQuery.data],
  );
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
        <section className="space-y-1">
          <TableTitle title={tI18nComplete.raw('text04e2a9728af7')} count={sorted.length} />
          {/* `-ml-9`: the empty select gutter hangs outside the content edge. */}
          <div role="table" aria-label={tI18nComplete.raw('text04e2a9728af7')} className="-ml-2 sm:-ml-9">
            <MemberTableHead
              nameHeader={tI18nComplete.raw('text985959785319')}
              emailHeader={tI18nComplete.raw('textec5ba0abb717')}
            />
            <div role="rowgroup">
              {sorted.map((project) => {
                const policy = directPolicy(project.custom_role_policies);
                const inheritedOnly =
                  project.sources.length === 1 && project.sources[0] === 'implicit';
                const customNames = (project.custom_role_policies ?? []).map((p) => p.role_name);
                const tile = projectById.get(project.project_id);
                // An owner or admin reaches every project through the account:
                // their account role is the badge, as on the project's own page.
                const accountRank =
                  inheritedOnly && (accountRole === 'owner' || accountRole === 'admin')
                    ? accountRole
                    : null;

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
                  onSelect: () => router.push(`/projects/${project.project_id}`),
                });

                return (
                  <MemberTableRow
                    key={project.project_id}
                    onOpen={() => router.push(`/projects/${project.project_id}`)}
                    avatar={
                      <EntityAvatar
                        label={project.project_name}
                        glyph={tile?.icon_glyph}
                        emoji={tile?.icon}
                        size="sm"
                      />
                    }
                    name={project.project_name}
                    // How the access arrives: "Account admin + Direct".
                    email={[
                      project.sources.map((source) => SOURCE_LABEL[source]).join(' + '),
                      ...customNames,
                    ].join(' · ')}
                    role={
                      accountRank
                        ? builtinRoleLabel('account', accountRank, tI18nComplete)
                        : (policy?.role_name ??
                          builtinRoleLabel('project', project.role, tI18nComplete))
                    }
                    roleTone={
                      accountRank
                        ? ROLE_TONE[accountRank]
                        : policy
                          ? ROLE_TONE.custom
                          : project.role === 'member'
                            ? ROLE_TONE.member
                            : ROLE_TONE.manager
                    }
                    pending={openingProjectId === project.project_id}
                    kebab={kebab}
                    kebabLabel={tI18nComplete('text33da220b1a34', { value0: project.project_name })}
                  />
                );
              })}
            </div>
          </div>
        </section>
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
    <section className="space-y-1">
      <TableTitle title={tI18nComplete.raw('text39bbb719fa2b')} count={memberGroups.length} />
      <div role="table" aria-label={tI18nComplete.raw('text39bbb719fa2b')} className="-ml-2 sm:-ml-9">
        <MemberTableHead
          nameHeader={tI18nComplete.raw('text34ca0e766088')}
          emailHeader={tI18nComplete.raw('text6b02e0d363a4')}
          roleHeader={<span aria-hidden />}
        />
        <div role="rowgroup">
          {memberGroups.map((group) => (
            <MemberTableRow
              key={group.group_id}
              onOpen={() => onOpenGroup(group.group_id)}
              avatar={<EntityAvatar label={group.name} icon={Users} size="sm" />}
              name={group.name}
              email={formatDate(group.added_at)}
              role={null}
              roleCell={<span />}
              kebabLabel={group.name}
            />
          ))}
        </div>
      </div>
    </section>
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

  const settled = items.length > 0 && items.every((item) => !byAction.get(item.action)?.isLoading);
  const grantedCount = items.filter((item) => byAction.get(item.action)?.allowed).length;

  return (
    <section className="space-y-1">
      {/* The tally: how much of the catalog their access reaches. */}
      <p className="text-muted-foreground text-xs tabular-nums">
        {settled ? `${grantedCount}/${items.length} ${tI18nComplete.raw('text62026a42b239')}` : '\u00a0'}
      </p>
      {/* One column, one permission per row, its answer in words at the end:
          a table to read top-down, not a two-column grid of ticks. Each area
          is a quiet sub-heading with its own tally. */}
      {/* `-mx-2`: each row pads `2`, so text sits on the sheet's edge. */}
      <div role="table" aria-label={tI18nComplete.raw('text5161cce6217e')} className="-mx-2">
        <div role="row" className={cn(CAPABILITY_GRID, 'h-9 px-2')}>
          <span role="columnheader" className={TABLE_HEAD}>
            {tI18nComplete.raw('textabccc78cc93c')}
          </span>
          <span role="columnheader" className={TABLE_HEAD}>
            {tI18nComplete.raw('textec5ba0abb717')}
          </span>
        </div>
        {groups.map((group) => {
          const granted = group.items.filter((item) => byAction.get(item.action)?.allowed).length;
          return (
            <div key={group.heading} role="rowgroup" className="pt-3">
              <div
                role="row"
                className="text-muted-foreground flex h-8 items-center gap-2 px-2 text-xs font-medium"
              >
                <span role="rowheader">{group.heading}</span>
                <span className="tabular-nums">
                  {granted}/{group.items.length}
                </span>
              </div>
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
          );
        })}
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const answer = isLoading ? (
    <Skeleton className="h-4 w-16 rounded-sm" />
  ) : allowed ? (
    <span className="text-foreground inline-flex items-center gap-1.5">
      <Check className="text-kortix-green size-3.5 shrink-0" />
      {tI18nComplete.raw('text62026a42b239')}
    </span>
  ) : (
    <span className="text-muted-foreground inline-flex items-center gap-1.5">
      <X className="size-3.5 shrink-0" />
      {tI18nComplete.raw('textda404deb110f')}
    </span>
  );
  return (
    <div role="row" className={cn(CAPABILITY_GRID, 'min-h-10 px-2 py-2')}>
      <span
        role="cell"
        className={cn('text-sm text-pretty', allowed || isLoading ? 'text-foreground' : 'text-muted-foreground')}
      >
        {label}
      </span>
      <span role="cell" className="text-sm">
        {/* Why, on hover: the engine's reason for the answer. */}
        {reason && !isLoading ? <Hint label={reason}>{answer}</Hint> : answer}
      </span>
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
