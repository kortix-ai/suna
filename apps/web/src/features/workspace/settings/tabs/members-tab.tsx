'use client';

/**
 * The Members tab — one unified table of every account member's project
 * standing, replacing `customize/sections/view/members-view.tsx`'s
 * `MembersView` at this mount (`settings-panel.tsx`'s `case 'members'`).
 *
 * **One list, not a compromise (task brief).** `GET /projects/:id/access`
 * (`listProjectAccess`, `packages/sdk/src/core/rest/projects-client/
 * access.ts:103`) already selects every ACCOUNT member and left-joins their
 * project + group grants server-side
 * (`apps/api/src/projects/routes/r6.ts:240`) — each `ProjectAccessMember`
 * already carries `account_role`, `project_role`, `effective_project_role`,
 * and `effective_source`. This tab renders that one response as one table:
 * an "Account role" column (`member.account_role`, read-only — account
 * roles are an account-settings concern, not a project one) and a
 * "Workspace access" column (`memberAccessLabel(member)`, see
 * `member-access-label.ts`). Unlike the old `ProjectAccessCard`
 * (`members-view.tsx`), which filtered to
 * `has_implicit_access || effective_project_role != null` and hid every
 * account member with zero project access, this table renders every row
 * the API returns — a no-access member reads as "—" via
 * `memberAccessLabel`, matching that function's own "no access reads as an
 * em dash" case instead of being silently dropped.
 *
 * **The write gate — verified against the routes, not the brief's literal
 * wording.** The brief describes "account writes gated on
 * `member.invite`/`member.update`/`member.remove` and workspace writes on
 * `project.member.write`". Checked directly against
 * `apps/api/src/projects/routes/r6.ts`: EVERY mutation this table (or the
 * sections below it) can trigger — invite (`:673`), list/revoke/resend a
 * pending invite (`:851`, `:941`, `:1012`), list/approve/reject an access
 * request (`:491`, `:533`), and update/revoke a member's own access
 * (`:1096`, `:1169`) — asserts the SAME single leaf:
 * `PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE` ('project.members.manage',
 * `lib/project-actions.ts:61`). `member.invite`/`member.update`/
 * `member.remove` are real leaves, but they gate the ACCOUNT-scoped routes
 * (`inviteAccountMember`/`updateAccountMemberRole`/`removeAccountMember`)
 * the legacy `accounts/[id]/page.tsx` members pane calls — a different data
 * source (`listAccountMembers`) this tab deliberately does not use (see
 * "one list" above). Gating THIS table's controls on those account leaves
 * would show a role-select/remove control to someone the server would
 * reject, or hide it from someone the server would allow — worse than
 * gating on the leaf the routes actually check. So every write control below
 * gates on ONE probe: `useProjectCan(projectId,
 * PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE)`.
 *
 * **This task's orphan — `ACCOUNT_ROLE_DESCRIPTORS`.** The brief frames this
 * as "referenced only by the legacy page's members pane" — checked, and
 * that premise is already stale: `components/iam/permissions-help-popover.tsx`
 * ALSO imports and renders it (`ACCOUNT_ROLE_DESCRIPTORS[role].label`/
 * `.blurb` for each of `ACCOUNT_ROLES_DESCENDING`), and `PermissionsHelpPopover`
 * is what `members-view.tsx`'s `MembersView` mounts as its section action
 * (`members-view.tsx:282-288`) — the exact mount this tab replaces. So the
 * "owner / admin / member role explainer copy" was already reachable through
 * TWO paths, not one, before this change. This tab keeps that reachable by
 * mounting the same `<PermissionsHelpPopover />` as its own header action
 * (reused, not reimplemented) — see `project-role-descriptors.ts`'s own
 * header comment; that file is NOT modified here, per the brief.
 *
 * **What this tab does NOT carry forward from `MembersView` — said loudly,
 * per the task's standing orphan-sweep rule, not silently.** `members-view.tsx`
 * is NOT in this task's Files list (Create `members-tab.tsx`,
 * `tabs/member-access-label.ts`; Modify `settings-panel.tsx` — no mention of
 * `members-view.tsx`), and the brief's own TDD steps scope this task to
 * exactly the unified table plus pending invites and access requests below
 * it — no invite-by-email composer, no project group-grant management, no
 * per-resource (agent/skill) grants, no custom-role assignment UI. Once
 * `settings-panel.tsx`'s `case 'members'` stops mounting `<MembersView
 * projectId={projectId} />` in favor of `<MembersTab projectId={projectId} />`,
 * `MembersView` (and every private helper inside it —
 * `ProjectGroupGrantsCard`, `ResourceAccessCard`, `ProjectRoleAssignmentsCard`,
 * `consumeMembersTabIntent`'s Invite deep-link target) has NO OTHER caller:
 * `grep -rln "MembersView\b" src` (excluding tests) matches only
 * `settings-panel.tsx` and `members-view.tsx` itself, and `grep -rln
 * "PermissionsHelpPopover" src` (excluding tests) matches only
 * `accounts/[id]/page.tsx`, `members-view.tsx`, and its own definition file
 * — so once this mount flips, `MembersView`'s OWN export becomes
 * unreachable (its `PermissionsHelpPopover` usage does not save it — this
 * tab's own new usage does that independently). The file still compiles
 * (tsc stays 17) and its tests still pass (nothing here touches them), so
 * this is the same "unreachable but green" shape the brief already accepts
 * for `ACCOUNT_ROLE_DESCRIPTORS` — reported here explicitly rather than
 * discovered later. `ProjectGroupGrantsCard`'s bulk group-access grants,
 * `ResourceAccessCard`'s per-agent/skill scoping, and
 * `ProjectRoleAssignmentsCard`'s custom-role bindings are real capabilities
 * with no replacement surface after this change — a real gap needing its
 * own follow-up task, not a silent regression this file hides.
 * `member-sort.ts`/`member-sort.test.ts` (the accessMembers list sorter) is
 * untouched and still used by `members-view.tsx` alone — also now only
 * reachable through the same dangling file.
 *
 * `MembersTabView` is the pure, props-only half — no hooks, no data
 * fetching. `MembersTab` is the container: every hook only runs while this
 * tab is actually mounted, which `SettingsTabPane` in `settings-panel.tsx`
 * guarantees (`if (!active) return null;` — see this file's task brief).
 *
 * **`InviteMemberDialog` and `PermissionsHelpPopover` are both slots.**
 * `InviteMemberDialog` owns its own `useMutation`, same reasoning as
 * `general-tab.tsx`'s `GeneralWorkspaceCard`/`service-accounts-card.tsx`'s
 * `CreateServiceAccountDialog` — it can't render under
 * `renderToStaticMarkup` with no `QueryClientProvider`. `PermissionsHelpPopover`
 * looked stateless but isn't: it calls `useTranslations('hardcodedUi')`
 * (`components/iam/permissions-help-popover.tsx:26`), which throws with no
 * `NextIntlClientProvider` ancestor — confirmed directly, not assumed: a
 * standalone `renderToStaticMarkup(<PermissionsHelpPopover />)` throws inside
 * `react-dom/server` with no provider mounted. Both slots are left
 * `undefined` by default so the bare `<MembersTabView />` the test file
 * renders still renders cleanly.
 *
 * **Untestable here, by design (see the task brief's hard constraint — no
 * `@testing-library/react`, no jsdom/happy-dom, none may be added):** every
 * mutation's actual network round trip, the invite dialog's form
 * interaction, and Select/dropdown open state all need a live network and a
 * real DOM. `members-tab.test.tsx` covers what the pure view can prove
 * statically: table shape, column presence, gated controls, and the pending
 * invites / access requests sections below it.
 */

import { useState, type ReactNode } from 'react';

import { PermissionsHelpPopover } from '@/components/iam/permissions-help-popover';
import { ProjectRoleSelectItem } from '@/components/iam/role-select-item';
import { isInheritedFromGroupOnly } from '@/components/iam/iam-display-helpers';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { ErrorState } from '@/features/layout/section/error-state';
import { EmptyState } from '@/features/layout/section/empty-state';
import { Field, FieldLabel } from '@/components/ui/field';
import { InlineMeta } from '@/components/ui/inline-meta';
import { Input } from '@/components/ui/input';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { SettingsSectionHeader } from '@/components/ui/settings-section-header';
import { UserAvatar } from '@/components/ui/user-avatar';
import { errorToast, successToast, warningToast } from '@/components/ui/toast';
import { useCopy } from '@/hooks/use-copy';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import {
  approveProjectAccessRequest,
  inviteProjectMember,
  isInviteSent,
  listPendingProjectInvites,
  listProjectAccess,
  listProjectAccessRequests,
  rejectProjectAccessRequest,
  resendPendingProjectInvite,
  revokePendingProjectInvite,
  revokeProjectAccess,
  updateProjectAccess,
  type PendingProjectInvite,
  type ProjectAccessRequest,
  type ProjectAccessMember,
  type ProjectRole,
} from '@kortix/sdk';
import { contract, qk } from '@kortix/sdk/react';
import { EnvelopeIcon as Mail, PlusIcon as Plus, XIcon as X, CheckIcon as Check, ClockIcon as Clock, ArrowClockwiseIcon as RefreshCw, UsersIcon as Users } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { memberAccessLabel } from './member-access-label';

const NO_ACCESS = '__none__';

function userLabel(member: Pick<ProjectAccessMember, 'email' | 'user_id'>) {
  return member.email || member.user_id;
}

function formatDate(input: string | null | undefined) {
  if (!input) return 'Never';
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return 'Never';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export interface MembersTabViewProps {
  isLoading?: boolean;
  isError?: boolean;
  errorMessage?: string;
  onRetry?: () => void;

  members?: ProjectAccessMember[];
  /** `project.members.manage` — the single leaf every write control below
   *  gates on. See this file's header comment. */
  canManageMembers?: boolean;
  /** user_id set — rows currently mid-mutation (role change or remove). */
  pendingUserIds?: Set<string>;
  onRoleChange?: (member: ProjectAccessMember, role: ProjectRole | typeof NO_ACCESS) => void;
  onRequestRemove?: (member: ProjectAccessMember) => void;

  removeTarget?: ProjectAccessMember | null;
  onCancelRemove?: () => void;
  onConfirmRemove?: () => void;
  isRemovePending?: boolean;

  onOpenInvite?: () => void;
  /** `InviteMemberDialog` — see this file's header comment for why it's a
   *  slot. */
  inviteDialogSlot?: ReactNode;
  /** `<PermissionsHelpPopover />` — see this file's header comment for why
   *  it's a slot (it calls `useTranslations`, which throws with no
   *  `NextIntlClientProvider`). Carries `ACCOUNT_ROLE_DESCRIPTORS`'
   *  owner/admin/member explainer copy — see this file's header comment,
   *  "This task's orphan". */
  permissionsHelpSlot?: ReactNode;

  pendingInvites?: PendingProjectInvite[];
  isPendingInvitesLoading?: boolean;
  pendingInviteBusyIds?: Set<string>;
  onResendInvite?: (invite: PendingProjectInvite) => void;
  onRequestRevokeInvite?: (invite: PendingProjectInvite) => void;
  revokeInviteTarget?: PendingProjectInvite | null;
  onCancelRevokeInvite?: () => void;
  onConfirmRevokeInvite?: () => void;
  isRevokeInvitePending?: boolean;

  accessRequests?: ProjectAccessRequest[];
  isAccessRequestsLoading?: boolean;
  accessRequestBusyIds?: Set<string>;
  onApproveRequest?: (request: ProjectAccessRequest) => void;
  onRejectRequest?: (request: ProjectAccessRequest) => void;
}

/** Presentational only — no hooks, no data fetching, no store or Supabase
 *  read. Kept separate from `MembersTab` so this renders under
 *  `renderToStaticMarkup` with no `QueryClientProvider` — see
 *  `GeneralTabView`/`ApiKeysTabView` for the same split. */
export function MembersTabView({
  isLoading = false,
  isError = false,
  errorMessage = '',
  onRetry = () => {},
  members = [],
  canManageMembers = false,
  pendingUserIds = new Set(),
  onRoleChange = () => {},
  onRequestRemove = () => {},
  removeTarget = null,
  onCancelRemove = () => {},
  onConfirmRemove = () => {},
  isRemovePending = false,
  onOpenInvite = () => {},
  inviteDialogSlot,
  permissionsHelpSlot,
  pendingInvites = [],
  isPendingInvitesLoading = false,
  pendingInviteBusyIds = new Set(),
  onResendInvite = () => {},
  onRequestRevokeInvite = () => {},
  revokeInviteTarget = null,
  onCancelRevokeInvite = () => {},
  onConfirmRevokeInvite = () => {},
  isRevokeInvitePending = false,
  accessRequests = [],
  isAccessRequestsLoading = false,
  accessRequestBusyIds = new Set(),
  onApproveRequest = () => {},
  onRejectRequest = () => {},
}: MembersTabViewProps) {
  const showPendingInvites = isPendingInvitesLoading || pendingInvites.length > 0;
  const showAccessRequests = isAccessRequestsLoading || accessRequests.length > 0;

  return (
    <div className="mx-auto w-full max-w-4xl space-y-10 px-6 py-10">
      <SettingsSectionHeader
        title="Members"
        description="Every account member's project standing, in one table."
        action={
          <div className="flex items-center gap-2">
            {permissionsHelpSlot}
            {canManageMembers ? (
              <Button type="button" size="sm" onClick={onOpenInvite} className="gap-1.5">
                <Plus className="size-3.5" />
                Invite
              </Button>
            ) : null}
          </div>
        }
      />

      {isLoading ? (
        <Skeleton className="h-64 w-full rounded-md" />
      ) : isError ? (
        <ErrorState
          size="sm"
          title="Failed to load members"
          description={errorMessage}
          action={
            <Button variant="outline" size="sm" onClick={onRetry}>
              Retry
            </Button>
          }
        />
      ) : members.length === 0 ? (
        <EmptyState icon={Users} title="No members yet" description="Invite someone to get started." />
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Member</TableHead>
              <TableHead>Account role</TableHead>
              <TableHead>Workspace access</TableHead>
              <TableHead className="w-[1%]">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((member) => {
              const { role, via } = memberAccessLabel(member);
              const busy = pendingUserIds.has(member.user_id);
              const editable =
                canManageMembers && !member.has_implicit_access && !isInheritedFromGroupOnly(member);

              return (
                <TableRow key={member.user_id}>
                  <TableCell className="align-top whitespace-normal">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <UserAvatar email={member.email ?? ''} size="sm" />
                      <div className="min-w-0">
                        <p className="text-foreground truncate text-sm font-medium">
                          {userLabel(member)}
                        </p>
                        <InlineMeta>
                          <span className="tabular-nums">Joined {formatDate(member.joined_at)}</span>
                        </InlineMeta>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="align-top">
                    <Badge
                      variant="outline"
                      size="sm"
                      className={
                        member.account_role === 'owner'
                          ? 'border-foreground/30 text-foreground capitalize'
                          : 'capitalize'
                      }
                    >
                      {member.account_role}
                    </Badge>
                  </TableCell>
                  <TableCell className="align-top">
                    <div className="flex flex-col gap-0.5">
                      <span className="text-foreground text-sm">{role}</span>
                      {via ? <span className="text-muted-foreground text-xs">{via}</span> : null}
                    </div>
                  </TableCell>
                  <TableCell className="align-top">
                    {busy ? (
                      <Loading className="text-muted-foreground shrink-0" />
                    ) : editable ? (
                      <div className="flex shrink-0 items-center gap-1">
                        <Select
                          value={member.project_role ?? NO_ACCESS}
                          onValueChange={(next) =>
                            onRoleChange(member, next as ProjectRole | typeof NO_ACCESS)
                          }
                        >
                          <SelectTrigger className="h-8 w-32 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={NO_ACCESS}>No access</SelectItem>
                            <ProjectRoleSelectItem role="member" compact />
                            <ProjectRoleSelectItem role="editor" compact />
                            <ProjectRoleSelectItem role="manager" compact />
                          </SelectContent>
                        </Select>
                        {member.project_role ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => onRequestRemove(member)}
                            title="Remove"
                          >
                            <X className="size-3.5" />
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      {showPendingInvites ? (
        <section className="space-y-4">
          <SettingsSectionHeader
            title="Pending invites"
            description="Invitations sent, awaiting sign-up."
          />
          {isPendingInvitesLoading ? (
            <Skeleton className="h-14 w-full rounded-md" />
          ) : (
            <ul className="space-y-2">
              {pendingInvites.map((invite) => {
                const busy = pendingInviteBusyIds.has(invite.invite_id);
                return (
                  <li
                    key={invite.invite_id}
                    className="bg-popover flex items-center gap-3 rounded-md border px-4 py-2.5"
                  >
                    <span className="bg-kortix-orange/10 text-kortix-orange inline-flex size-8 shrink-0 items-center justify-center rounded-sm border">
                      <Mail className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-foreground truncate text-sm font-medium">
                          {invite.email}
                        </span>
                        <Badge variant="outline" size="sm" className="capitalize">
                          {invite.project_role}
                        </Badge>
                      </div>
                      <InlineMeta>
                        <span className="tabular-nums">Invited {formatDate(invite.created_at)}</span>
                        {invite.invite_expired ? (
                          <span className="text-kortix-orange">Link expired</span>
                        ) : (
                          <span className="inline-flex items-center gap-1 tabular-nums">
                            <Clock className="size-3" />
                            Expires {formatDate(invite.invite_expires_at)}
                          </span>
                        )}
                      </InlineMeta>
                    </div>
                    {busy ? (
                      <Loading className="text-muted-foreground shrink-0" />
                    ) : canManageMembers ? (
                      <div className="flex shrink-0 items-center gap-1.5">
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => onResendInvite(invite)}
                          className="gap-1.5"
                        >
                          <RefreshCw className="size-3.5" />
                          Resend
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => onRequestRevokeInvite(invite)}
                          className="gap-1.5"
                        >
                          <X className="size-3.5" />
                          Revoke
                        </Button>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ) : null}

      {showAccessRequests ? (
        <section className="space-y-4">
          <SettingsSectionHeader
            title="Access requests"
            description="People who asked to join this project."
          />
          {isAccessRequestsLoading ? (
            <Skeleton className="h-14 w-full rounded-md" />
          ) : (
            <ul className="space-y-2">
              {accessRequests.map((request) => {
                const busy = accessRequestBusyIds.has(request.request_id);
                return (
                  <li
                    key={request.request_id}
                    className="bg-popover flex items-center gap-3 rounded-md border px-4 py-2.5"
                  >
                    <span className="bg-kortix-yellow/10 text-kortix-yellow inline-flex size-8 shrink-0 items-center justify-center rounded-sm border">
                      <Mail className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <span className="text-foreground truncate text-sm font-medium">
                        {request.requester_email}
                      </span>
                      <InlineMeta>
                        <span className="tabular-nums">Requested {formatDate(request.created_at)}</span>
                        {request.message ? <span>"{request.message}"</span> : null}
                      </InlineMeta>
                    </div>
                    {busy ? (
                      <Loading className="text-muted-foreground shrink-0" />
                    ) : (
                      <div className="flex shrink-0 items-center gap-1.5">
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => onApproveRequest(request)}
                          className="gap-1.5"
                        >
                          <Check className="size-3.5" />
                          Approve
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => onRejectRequest(request)}
                          className="gap-1.5"
                        >
                          <X className="size-3.5" />
                          Decline
                        </Button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ) : null}

      <ConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) onCancelRemove();
        }}
        title="Remove member?"
        description={
          removeTarget ? (
            <span>
              <strong>{userLabel(removeTarget)}</strong> will lose access to this project.
            </span>
          ) : null
        }
        confirmLabel="Remove"
        confirmVariant="destructive"
        isPending={isRemovePending}
        onConfirm={onConfirmRemove}
      />

      <ConfirmDialog
        open={revokeInviteTarget !== null}
        onOpenChange={(open) => {
          if (!open) onCancelRevokeInvite();
        }}
        title="Revoke invitation?"
        description={
          revokeInviteTarget ? (
            <span>
              The invitation to <strong>{revokeInviteTarget.email}</strong> will be cancelled.
            </span>
          ) : null
        }
        confirmLabel="Revoke"
        confirmVariant="destructive"
        isPending={isRevokeInvitePending}
        onConfirm={onConfirmRevokeInvite}
      />

      {inviteDialogSlot}
    </div>
  );
}

/** Container entry point. Every hook below only runs while this tab is
 *  actually mounted — `SettingsTabPane` in `settings-panel.tsx` guarantees
 *  that only happens while this tab is the active one. */
export function MembersTab({ projectId }: { projectId: string }) {
  return <MembersTabInner projectId={projectId} />;
}

function MembersTabInner({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();

  // project.members.manage — the single leaf every write control on this
  // page gates on. See this file's header comment.
  const { allowed: canManageMembers } = useProjectCan(
    projectId,
    PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE,
  );

  const accessQuery = useQuery({
    queryKey: qk.project.access(projectId),
    queryFn: () => listProjectAccess(projectId),
    ...contract('inventory'),
  });

  const pendingInvitesQuery = useQuery({
    queryKey: qk.project.pendingInvites(projectId),
    queryFn: () => listPendingProjectInvites(projectId),
    ...contract('inventory'),
    enabled: canManageMembers,
  });

  const accessRequestsQuery = useQuery({
    queryKey: qk.project.accessRequests(projectId),
    queryFn: () => listProjectAccessRequests(projectId),
    ...contract('inventory'),
    enabled: canManageMembers,
  });

  function invalidateAccess() {
    queryClient.invalidateQueries({ queryKey: qk.project.access(projectId) });
    queryClient.invalidateQueries({ queryKey: qk.projects.scope() });
    queryClient.invalidateQueries({ queryKey: qk.project.summary(projectId) });
  }

  const [pendingUserIds, setPendingUserIds] = useState<Set<string>>(() => new Set());
  const markUserPending = (id: string) => setPendingUserIds((prev) => new Set(prev).add(id));
  const clearUserPending = (id: string) =>
    setPendingUserIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });

  const updateMutation = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: ProjectRole }) =>
      updateProjectAccess(projectId, userId, role),
    onMutate: ({ userId }) => markUserPending(userId),
    onSettled: (_data, _error, vars) => clearUserPending(vars.userId),
    onSuccess: () => {
      successToast('Access updated');
      invalidateAccess();
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to update access'),
  });

  const [removeTarget, setRemoveTarget] = useState<ProjectAccessMember | null>(null);
  const removeMutation = useMutation({
    mutationFn: (userId: string) => revokeProjectAccess(projectId, userId),
    onMutate: (userId) => markUserPending(userId),
    onSettled: (_data, _error, userId) => clearUserPending(userId),
    onSuccess: () => {
      successToast('Access removed');
      invalidateAccess();
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to remove access'),
  });

  function handleRoleChange(member: ProjectAccessMember, role: ProjectRole | typeof NO_ACCESS) {
    if (!canManageMembers || member.has_implicit_access) return;
    if (role === NO_ACCESS) {
      setRemoveTarget(member);
      return;
    }
    updateMutation.mutate({ userId: member.user_id, role });
  }

  const [inviteOpen, setInviteOpen] = useState(false);

  const [pendingInviteBusyIds, setPendingInviteBusyIds] = useState<Set<string>>(() => new Set());
  const markInvitePending = (id: string) => setPendingInviteBusyIds((prev) => new Set(prev).add(id));
  const clearInvitePending = (id: string) =>
    setPendingInviteBusyIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  const [revokeInviteTarget, setRevokeInviteTarget] = useState<PendingProjectInvite | null>(null);

  const { copy } = useCopy({
    successMessage: 'Invite link copied',
    errorMessage: 'Could not copy link',
  });

  const resendInviteMutation = useMutation({
    mutationFn: (inviteId: string) => resendPendingProjectInvite(projectId, inviteId),
    onMutate: (inviteId) => markInvitePending(inviteId),
    onSettled: (_data, _error, inviteId) => clearInvitePending(inviteId),
    onSuccess: (result) => {
      if (result.email_sent) {
        successToast('Invite email sent');
      } else {
        warningToast('Email skipped — copy the invite link to share manually', {
          duration: 8_000,
          button: (
            <Button size="sm" onClick={() => copy(result.invite_url)}>
              Copy link
            </Button>
          ),
        });
      }
      queryClient.invalidateQueries({ queryKey: qk.project.pendingInvites(projectId) });
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to resend invitation'),
  });

  const revokeInviteMutation = useMutation({
    mutationFn: (inviteId: string) => revokePendingProjectInvite(projectId, inviteId),
    onMutate: (inviteId) => markInvitePending(inviteId),
    onSettled: (_data, _error, inviteId) => clearInvitePending(inviteId),
    onSuccess: (result) => {
      successToast(
        result.invitation_cancelled
          ? 'Invitation cancelled.'
          : 'Project access removed from invitation.',
      );
      queryClient.invalidateQueries({ queryKey: qk.project.pendingInvites(projectId) });
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to revoke invitation'),
  });

  const [accessRequestBusyIds, setAccessRequestBusyIds] = useState<Set<string>>(() => new Set());
  const markRequestBusy = (id: string) => setAccessRequestBusyIds((prev) => new Set(prev).add(id));
  const clearRequestBusy = (id: string) =>
    setAccessRequestBusyIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });

  const approveMutation = useMutation({
    mutationFn: (requestId: string) => approveProjectAccessRequest(projectId, requestId, 'member'),
    onMutate: (requestId) => markRequestBusy(requestId),
    onSettled: (_data, _error, requestId) => clearRequestBusy(requestId),
    onSuccess: (result) => {
      successToast(`${result.member.email ?? 'Requester'} can now view this project`);
      queryClient.invalidateQueries({ queryKey: qk.project.accessRequests(projectId) });
      invalidateAccess();
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to approve request'),
  });

  const rejectMutation = useMutation({
    mutationFn: (requestId: string) => rejectProjectAccessRequest(projectId, requestId),
    onMutate: (requestId) => markRequestBusy(requestId),
    onSettled: (_data, _error, requestId) => clearRequestBusy(requestId),
    onSuccess: () => {
      successToast('Access request declined');
      queryClient.invalidateQueries({ queryKey: qk.project.accessRequests(projectId) });
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to decline request'),
  });

  return (
    <MembersTabView
      isLoading={accessQuery.isLoading}
      isError={accessQuery.isError}
      errorMessage={(accessQuery.error as Error)?.message ?? ''}
      onRetry={() => accessQuery.refetch()}
      members={accessQuery.data?.members ?? []}
      canManageMembers={canManageMembers}
      pendingUserIds={pendingUserIds}
      onRoleChange={handleRoleChange}
      onRequestRemove={(member) => setRemoveTarget(member)}
      removeTarget={removeTarget}
      onCancelRemove={() => setRemoveTarget(null)}
      onConfirmRemove={() => {
        if (!removeTarget) return;
        const target = removeTarget;
        setRemoveTarget(null);
        removeMutation.mutate(target.user_id);
      }}
      isRemovePending={removeMutation.isPending}
      onOpenInvite={() => setInviteOpen(true)}
      permissionsHelpSlot={<PermissionsHelpPopover align="end" />}
      pendingInvites={pendingInvitesQuery.data?.pending ?? []}
      isPendingInvitesLoading={canManageMembers && pendingInvitesQuery.isLoading}
      pendingInviteBusyIds={pendingInviteBusyIds}
      onResendInvite={(invite) => resendInviteMutation.mutate(invite.invite_id)}
      onRequestRevokeInvite={(invite) => setRevokeInviteTarget(invite)}
      revokeInviteTarget={revokeInviteTarget}
      onCancelRevokeInvite={() => setRevokeInviteTarget(null)}
      onConfirmRevokeInvite={() => {
        if (!revokeInviteTarget) return;
        const target = revokeInviteTarget;
        setRevokeInviteTarget(null);
        revokeInviteMutation.mutate(target.invite_id);
      }}
      isRevokeInvitePending={revokeInviteMutation.isPending}
      accessRequests={accessRequestsQuery.data?.requests ?? []}
      isAccessRequestsLoading={canManageMembers && accessRequestsQuery.isLoading}
      accessRequestBusyIds={accessRequestBusyIds}
      onApproveRequest={(request) => approveMutation.mutate(request.request_id)}
      onRejectRequest={(request) => rejectMutation.mutate(request.request_id)}
      inviteDialogSlot={
        <InviteMemberDialog
          projectId={projectId}
          open={inviteOpen}
          onOpenChange={setInviteOpen}
          onInvited={invalidateAccess}
        />
      }
    />
  );
}

/** New-invite composer — a single email + role, not `members-view.tsx`'s
 *  `InviteMemberCard` (bulk multi-email chip input) ported verbatim. That
 *  component is not exported and this task's Files list does not include
 *  `members-view.tsx`, so it is rebuilt smaller rather than reused — see
 *  this file's header comment for the capabilities this deliberately does
 *  NOT carry forward. Owns its own `useMutation`/`useState`, so it's a slot
 *  on `MembersTabView` — see that prop's doc comment. */
function InviteMemberDialog({
  projectId,
  open,
  onOpenChange,
  onInvited,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInvited: () => void;
}) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<ProjectRole>('member');
  const { copy } = useCopy({
    successMessage: 'Invite link copied',
    errorMessage: 'Could not copy link',
  });

  const mutation = useMutation({
    mutationFn: () => inviteProjectMember(projectId, email.trim(), role, null),
    onSuccess: (result) => {
      if (isInviteSent(result)) {
        if (result.email_sent) {
          successToast(
            `Invitation sent to ${result.email}. They'll land on this project as ${result.project_role} when they sign up.`,
          );
        } else {
          const inviteUrl = result.invite_url;
          warningToast(
            `Invitation created for ${result.email} — email skipped. Share the invite link manually.`,
            {
              duration: 10_000,
              button: (
                <Button size="sm" onClick={() => copy(inviteUrl)}>
                  Copy link
                </Button>
              ),
            },
          );
        }
        queryClient.invalidateQueries({ queryKey: qk.project.pendingInvites(projectId) });
      } else {
        successToast('Member added');
        onInvited();
      }
      setEmail('');
      setRole('member');
      onOpenChange(false);
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to invite member'),
  });

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const canSubmit = EMAIL_RE.test(email.trim()) && !mutation.isPending;

  return (
    <Modal open={open} onOpenChange={(o) => !mutation.isPending && onOpenChange(o)}>
      <ModalContent className="lg:max-w-md">
        <ModalHeader>
          <ModalTitle>Invite a member</ModalTitle>
          <ModalDescription>They'll get project access at the role you pick.</ModalDescription>
        </ModalHeader>
        <ModalBody className="space-y-4">
          <Field className="gap-1.5">
            <FieldLabel htmlFor="invite-member-email">Email</FieldLabel>
            <Input
              id="invite-member-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="teammate@example.com"
              disabled={mutation.isPending}
              autoFocus
              variant="popover"
            />
          </Field>
          <Field className="gap-1.5">
            <FieldLabel htmlFor="invite-member-role">Role</FieldLabel>
            <Select
              value={role}
              onValueChange={(next) => setRole(next as ProjectRole)}
              disabled={mutation.isPending}
            >
              <SelectTrigger id="invite-member-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <ProjectRoleSelectItem role="member" />
                <ProjectRoleSelectItem role="editor" />
                <ProjectRoleSelectItem role="manager" />
              </SelectContent>
            </Select>
          </Field>
        </ModalBody>
        <ModalFooter className="sm:justify-between">
          <Button
            type="button"
            variant="outline-ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={mutation.isPending}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => mutation.mutate()}
            disabled={!canSubmit}
            className="gap-1.5"
          >
            {mutation.isPending && <Loading className="size-3.5 shrink-0" />}
            Invite
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
