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

import { useMemo, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import { cn } from '@/lib/utils';

import { PermissionsHelpPopover } from '@/components/iam/permissions-help-popover';
import { ProjectRoleSelectItem } from '@/components/iam/role-select-item';
import { isInheritedFromGroupOnly } from '@/components/iam/iam-display-helpers';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EntityAvatar } from '@/components/ui/entity-avatar';
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
  createPolicy,
  deletePolicy,
  listAgentIdentities,
  listGroups,
  listPolicies,
  listRoles,
  type AccountGroup,
  type IamPolicy,
  type PrincipalType,
} from '@/lib/iam-client';
import {
  approveProjectAccessRequest,
  attachGroupToProject,
  createProjectResourceGrant,
  deleteProjectResourceGrant,
  detachGroupFromProject,
  getProject,
  inviteProjectMember,
  isInviteSent,
  listPendingProjectInvites,
  listProjectAccess,
  listProjectAccessRequests,
  listProjectGroupGrants,
  listProjectResourceGrants,
  rejectProjectAccessRequest,
  resendPendingProjectInvite,
  revokePendingProjectInvite,
  revokeProjectAccess,
  updateProjectAccess,
  updateProjectGroupGrant,
  type PendingProjectInvite,
  type ProjectAccessRequest,
  type ProjectAccessMember,
  type ProjectGroupGrant,
  type ProjectResourceGrant,
  type ProjectRole,
  type ResourceGrantType,
} from '@kortix/sdk';
import { contract, invalidateProject, qk } from '@kortix/sdk/react';
import {
  RobotIcon as Bot,
  UsersIcon as UsersSolid,
  EnvelopeIcon as Mail,
  PlusIcon as Plus,
  XIcon as X,
  CheckIcon as Check,
  ClockIcon as Clock,
  ArrowElbowDownRightIcon as CornerDownRight,
  KeyIcon as KeyRound,
  PlugIcon as Plug,
  ArrowClockwiseIcon as RefreshCw,
  ShieldIcon as Shield,
  SparkleIcon as Sparkles,
  UserIcon as User,
  UsersIcon as Users,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { memberAccessLabel } from './member-access-label';
import { toArray } from '@/features/workspace/customize/shared/utils';

const NO_ACCESS = '__none__';
const MEMBER_ROW = 'bg-popover flex items-center gap-3 rounded-md border px-4 py-2.5';

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
  /** `ProjectGroupGrantsCard`, moved (cut, not copied) from
   *  `members-view.tsx` — see this file's header comment, "Rehomed from
   *  MembersView". Owns its own `useQuery`/`useMutation` (and
   *  `useTranslations`), so it's a slot. The container renders it only when
   *  `project?.account_id` is known — same gate `members-view.tsx` used at
   *  its own mount site, preserved exactly, not re-derived. */
  groupGrantsSlot?: ReactNode;
  /** `ResourceAccessCard`, moved from `members-view.tsx`. The container
   *  renders it only when `project?.account_id && canManage` — same gate
   *  `members-view.tsx` used, preserved exactly (manager-only DATA: the
   *  grants list route denies non-managers). */
  resourceAccessSlot?: ReactNode;
  /** `ProjectRoleAssignmentsCard`, moved from `members-view.tsx`. Same gate
   *  as `resourceAccessSlot` (manager-only DATA). */
  roleAssignmentsSlot?: ReactNode;
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
  groupGrantsSlot,
  resourceAccessSlot,
  roleAssignmentsSlot,
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

      {/* Rehomed from `members-view.tsx`, in their existing order — see
          this file's header comment, "Rehomed from MembersView". Each gate
          is preserved exactly as that file passed it, not re-derived here. */}
      {groupGrantsSlot}
      {resourceAccessSlot}
      {roleAssignmentsSlot}

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

  // Feeds `canManage` below, and the three rehomed cards' own gate — see
  // this file's header comment, "Rehomed from MembersView". Same query
  // `members-view.tsx`'s `MembersView` ran for the identical purpose
  // (`qk.project.summary(projectId)` / `getProject`).
  const projectQuery = useQuery({
    queryKey: qk.project.summary(projectId),
    queryFn: () => getProject(projectId),
    ...contract('config'),
  });
  const project = projectQuery.data;
  // Mined verbatim from `members-view.tsx`'s `MembersView` — NOT re-derived
  // from `canManageMembers` above. Deliberately a SEPARATE boolean:
  // `canManageMembers` (this file's own accepted deviation, `project.members.manage`
  // via `useProjectCan`) gates this tab's OWN table/invite/pending-invite/
  // access-request controls; `canManage` here is preserved EXACTLY as the
  // three rehomed cards received it before this move, so their access gate
  // cannot silently drift from what they shipped with.
  const canManage = project?.effective_project_role === 'manager' || accessQuery.data?.can_manage;

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
      // Rehomed from `members-view.tsx` — gates preserved EXACTLY as that
      // file passed them at its own mount site (see this file's header
      // comment). `ProjectGroupGrantsCard` gates on `project?.account_id`
      // alone; the other two additionally require `canManage`.
      groupGrantsSlot={
        project?.account_id ? (
          <ProjectGroupGrantsCard
            projectId={projectId}
            accountId={project.account_id}
            canManage={!!canManage}
          />
        ) : undefined
      }
      resourceAccessSlot={
        project?.account_id && canManage ? (
          <ResourceAccessCard
            projectId={projectId}
            accountId={project.account_id}
            canManage={!!canManage}
            members={accessQuery.data?.members ?? []}
          />
        ) : undefined
      }
      roleAssignmentsSlot={
        project?.account_id && canManage ? (
          <ProjectRoleAssignmentsCard
            projectId={projectId}
            accountId={project.account_id}
            canManage={!!canManage}
            members={accessQuery.data?.members ?? []}
          />
        ) : undefined
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

// ─────────────────────────────────────────────────────────────────────────
// Rehomed from `members-view.tsx` (moved, not copied — a copy leaves two
// implementations to drift). `ProjectGroupGrantsCard`, `FilterChips`,
// `ScopeLine`, `BlastRadiusPreview`, `ResourceAccessCard`, and
// `ProjectRoleAssignmentsCard` are UNMODIFIED below apart from using this
// file's own `MEMBER_ROW`/`formatDate`/`userLabel` (byte-identical
// definitions already declared above) instead of re-declaring them. Each
// card is mounted as a slot from `MembersTabInner` with its gate preserved
// EXACTLY as `members-view.tsx` passed it at its own mount site — see
// `MembersTabViewProps.groupGrantsSlot`/`resourceAccessSlot`/
// `roleAssignmentsSlot`'s doc comments and `MembersTabInner`'s own comment
// next to `canManage`.
// ─────────────────────────────────────────────────────────────────────────

function ProjectGroupGrantsCard({
  projectId,
  accountId,
  canManage,
}: {
  projectId: string;
  accountId: string;
  canManage: boolean;
}) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const queryClient = useQueryClient();
  const grantsKey = qk.project.groupGrants(projectId);

  const grantsQuery = useQuery({
    queryKey: grantsKey,
    queryFn: () => listProjectGroupGrants(projectId),
    ...contract('inventory'),
  });
  const groupsQuery = useQuery({
    queryKey: ['account-groups', accountId],
    queryFn: () => listGroups(accountId),
    enabled: canManage,
    staleTime: 60_000,
  });
  // Custom-role policies bound to a GROUP on this project. A group that has BOTH
  // a built-in grant (this list) AND a custom-role policy hits the union trap:
  // allow-only/highest-wins means the built-in role WINS and silently overrides
  // the custom role's restrictions. We flag those rows so it isn't a silent gotcha.
  // qk.project.policies — the IAM role-policy family, NOT
  // qk.project.executorPolicies (the unrelated sandbox tool-rule family
  // PoliciesPanel reads). Both used to share the literal ['project-policies',
  // id] pre-migration, which meant whichever fetch resolved last clobbered
  // the other's cache entry with an incompatible shape.
  const policiesQuery = useQuery({
    queryKey: qk.project.policies(projectId),
    queryFn: () => listPolicies(accountId, { scopeId: projectId }),
    enabled: canManage,
    ...contract('config'),
  });
  const groupsWithCustomRole = useMemo(
    () =>
      new Set(
        toArray(policiesQuery.data)
          .filter(
            (p) =>
              p.principal_type === 'group' &&
              p.scope_type === 'project' &&
              p.scope_id === projectId,
          )
          .map((p) => p.principal_id),
      ),
    [policiesQuery.data, projectId],
  );

  const grants = useMemo(() => {
    const raw = toArray(grantsQuery.data?.grants);
    return [...raw].sort((a, b) => {
      const t = a.created_at.localeCompare(b.created_at);
      return t !== 0 ? t : a.group_id.localeCompare(b.group_id);
    });
  }, [grantsQuery.data]);
  const groups: AccountGroup[] = useMemo(() => toArray(groupsQuery.data), [groupsQuery.data]);
  const attachedIds = useMemo(() => new Set(grants.map((g) => g.group_id)), [grants]);
  const available = useMemo(
    () => groups.filter((g) => !attachedIds.has(g.group_id)),
    [groups, attachedIds],
  );

  const [pickerGroupId, setPickerGroupId] = useState<string>('');
  const [pickerRole, setPickerRole] = useState<ProjectRole>('member');
  const [pendingGroupIds, setPendingGroupIds] = useState<Set<string>>(() => new Set());
  const markPending = (id: string) => setPendingGroupIds((prev) => new Set(prev).add(id));
  const clearPending = (id: string) =>
    setPendingGroupIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  const [detachTarget, setDetachTarget] = useState<ProjectGroupGrant | null>(null);

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: grantsKey });
    queryClient.invalidateQueries({ queryKey: qk.project.access(projectId) });
    queryClient.invalidateQueries({ queryKey: qk.project.summary(projectId) });
  }

  const attachMutation = useMutation({
    mutationFn: () => attachGroupToProject(projectId, pickerGroupId, pickerRole),
    onMutate: () => {
      markPending(pickerGroupId);
      return { groupId: pickerGroupId };
    },
    onSettled: (_data, _error, _vars, ctx) => clearPending(ctx!.groupId),
    onSuccess: () => {
      successToast('Group attached');
      setPickerGroupId('');
      setPickerRole('editor');
      invalidate();
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to attach group'),
  });

  const updateMutation = useMutation({
    mutationFn: (input: { groupId: string; role: ProjectRole }) =>
      updateProjectGroupGrant(projectId, input.groupId, input.role),
    onMutate: (input) => markPending(input.groupId),
    onSettled: (_data, _error, input) => clearPending(input.groupId),
    onSuccess: () => {
      successToast('Role updated');
      invalidate();
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to update role'),
  });

  const detachMutation = useMutation({
    mutationFn: (groupId: string) => detachGroupFromProject(projectId, groupId),
    onMutate: (groupId) => markPending(groupId),
    onSettled: (_data, _error, groupId) => clearPending(groupId),
    onSuccess: () => {
      successToast('Group detached');
      invalidate();
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to detach group'),
  });

  return (
    <>
      <section className="space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-medium">
              {tHardcodedUi.raw(
                'autoComponentsProjectsCustomizeSectionsMembersViewJsxAttrTitleGroupfbf9c01c',
              )}
              {grants.length > 0 ? (
                <span className="text-muted-foreground ml-1.5 font-normal">({grants.length})</span>
              ) : null}
            </h3>
            <p className="text-muted-foreground mt-1 text-xs">
              {tHardcodedUi.raw(
                'autoComponentsProjectsCustomizeSectionsMembersViewJsxAttrDescriptionAttach372d6d3a',
              )}
            </p>
          </div>

          {canManage && available.length > 0 ? (
            <form
              className="flex shrink-0 items-center gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                if (!pickerGroupId || attachMutation.isPending) return;
                attachMutation.mutate();
              }}
            >
              <Select
                value={pickerGroupId}
                onValueChange={setPickerGroupId}
                disabled={attachMutation.isPending}
              >
                <SelectTrigger className="h-8 w-44 text-xs">
                  <SelectValue
                    placeholder={tHardcodedUi.raw(
                      'autoComponentsProjectsCustomizeSectionsMembersViewJsxAttrPlaceholderPickf0432525',
                    )}
                  />
                </SelectTrigger>
                <SelectContent>
                  {available.map((g) => (
                    <SelectItem key={g.group_id} value={g.group_id}>
                      {g.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={pickerRole}
                onValueChange={(v) => setPickerRole(v as ProjectRole)}
                disabled={attachMutation.isPending}
              >
                <SelectTrigger className="h-8 w-28 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <ProjectRoleSelectItem role="member" />
                  <ProjectRoleSelectItem role="editor" />
                  <ProjectRoleSelectItem role="manager" />
                </SelectContent>
              </Select>
              <Button
                type="submit"
                size="sm"
                variant="outline"
                disabled={!pickerGroupId || attachMutation.isPending}
              >
                Attach
              </Button>
            </form>
          ) : null}
        </div>

        {grantsQuery.isLoading && (
          <div className="space-y-2">
            {Array.from({ length: 2 }).map((_, index) => (
              <Skeleton key={index} className="h-14 w-full rounded-md" />
            ))}
          </div>
        )}

        {!grantsQuery.isLoading && grants.length === 0 && (
          <EmptyState
            icon={Users}
            title="No groups attached"
            description={
              canManage && groups.length === 0 ? (
                <>
                  {tHardcodedUi.raw(
                    'autoComponentsProjectsCustomizeSectionsMembersViewJsxTextCreateOne549d8748',
                  )}{' '}
                  <a href={`/accounts/${accountId}`} className="hover:text-foreground underline">
                    {tHardcodedUi.raw(
                      'autoComponentsProjectsCustomizeSectionsMembersViewJsxTextAccountPage432b8a72',
                    )}
                  </a>
                  .
                </>
              ) : canManage && available.length === 0 && groups.length > 0 ? (
                tHardcodedUi.raw(
                  'autoComponentsProjectsCustomizeSectionsMembersViewJsxTextAllYour31c4dcb5',
                )
              ) : (
                tHardcodedUi.raw(
                  'autoComponentsProjectsCustomizeSectionsMembersViewJsxTextNoGroups09e82ebd',
                )
              )
            }
          />
        )}

        {!grantsQuery.isLoading && grants.length > 0 && (
          <ul className="space-y-2">
            {grants.map((g: ProjectGroupGrant) => {
              const busy = pendingGroupIds.has(g.group_id);
              return (
                <li key={g.group_id} className={MEMBER_ROW}>
                  <EntityAvatar icon={UsersSolid} size="md" />
                  <div className="min-w-0 flex-1">
                    <span className="text-foreground truncate text-sm font-medium">
                      {g.group_name}
                    </span>
                    <span className="text-muted-foreground text-xs">
                      <InlineMeta>
                        <span>Attached {formatDate(g.created_at)}</span>
                        {typeof g.member_count === 'number' && (
                          <span>
                            {g.member_count} {g.member_count === 1 ? 'member' : 'members'}
                          </span>
                        )}
                        {typeof g.override_count === 'number' && g.override_count > 0 && (
                          <span
                            className="text-kortix-orange"
                            title={tHardcodedUi.raw(
                              'autoComponentsProjectsCustomizeSectionsMembersViewJsxAttrTitleAccount2914778b',
                            )}
                          >
                            {g.override_count} of {g.member_count}{' '}
                            {tHardcodedUi.raw(
                              'autoComponentsProjectsCustomizeSectionsMembersViewJsxTextGetManagera88e6fc4',
                            )}
                          </span>
                        )}
                        {groupsWithCustomRole.has(g.group_id) && (
                          <span
                            className="text-kortix-orange font-medium"
                            title="This group also has a custom role assigned on this project. Built-in role grants WIN over custom roles (allow-only / highest-wins), so this grant overrides the custom role's limits. Detach it to let the custom role apply."
                          >
                            ⚠ overrides an assigned custom role
                          </span>
                        )}
                      </InlineMeta>
                    </span>
                  </div>
                  {busy ? (
                    <Loading className="text-muted-foreground shrink-0" />
                  ) : canManage ? (
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Select
                        value={g.role}
                        onValueChange={(v) =>
                          updateMutation.mutate({ groupId: g.group_id, role: v as ProjectRole })
                        }
                      >
                        <SelectTrigger className="h-8 w-28 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <ProjectRoleSelectItem role="member" />
                          <ProjectRoleSelectItem role="editor" />
                          <ProjectRoleSelectItem role="manager" />
                        </SelectContent>
                      </Select>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setDetachTarget(g)}
                      >
                        Detach
                      </Button>
                    </div>
                  ) : (
                    <Badge variant="outline" size="sm" className="capitalize">
                      {g.role}
                    </Badge>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <ConfirmDialog
        open={detachTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDetachTarget(null);
        }}
        title={tHardcodedUi.raw(
          'autoComponentsProjectsCustomizeSectionsMembersViewJsxAttrTitleDetach8e4cbc87',
        )}
        description={
          detachTarget ? (
            <span>
              <strong>{detachTarget.group_name}</strong>{' '}
              {tHardcodedUi.raw(
                'autoComponentsProjectsCustomizeSectionsMembersViewJsxTextWillNob7c4fd05',
              )}
              <strong>{detachTarget.role}</strong>{' '}
              {tHardcodedUi.raw(
                'autoComponentsProjectsCustomizeSectionsMembersViewJsxTextAccessUnless520e90ca',
              )}
            </span>
          ) : null
        }
        confirmLabel={tHardcodedUi.raw(
          'autoComponentsProjectsCustomizeSectionsMembersViewJsxAttrConfirmLabelDetache64492d2',
        )}
        confirmVariant="destructive"
        isPending={detachMutation.isPending}
        onConfirm={() => {
          if (!detachTarget) return;
          const target = detachTarget;
          setDetachTarget(null);
          detachMutation.mutate(target.group_id);
        }}
      />
    </>
  );
}

// ─── Per-resource scoping (agents/skills → member/group) ──────────────

/**
 * A row of filter pills shown above a long list (resource grants, role
 * bindings). Each pill carries its own count; the active one is solid. Render
 * only when there's more than one category to switch between — a single-category
 * list needs no filter chrome.
 */
function FilterChips<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; count: number }[];
}) {
  return (
    <div className="border-border/60 flex flex-wrap items-center gap-1.5 border-b px-6 py-2.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            'flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors',
            value === o.value
              ? 'bg-foreground text-background'
              : 'bg-muted/50 text-muted-foreground hover:bg-muted',
          )}
        >
          {o.label}
          <span className={cn('tabular-nums', value === o.value ? 'opacity-70' : 'opacity-50')}>
            {o.count}
          </span>
        </button>
      ))}
    </div>
  );
}

/** One dimension (secrets / connectors) of an agent's declared scope. */
function ScopeLine({
  icon: Icon,
  label,
  items,
}: {
  icon: typeof KeyRound;
  label: string;
  items: string[];
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Icon className="text-muted-foreground/70 size-3.5 shrink-0" />
      <span className="text-muted-foreground text-[11px] font-medium">{label}</span>
      {items.map((n) => (
        <Badge key={n} variant="outline" size="xs" className="font-mono">
          {n}
        </Badge>
      ))}
    </div>
  );
}

/**
 * Blast-radius preview for an agent assignment: the concrete secrets + connectors
 * the assignee will INHERIT (the pyramid). `'all'` inherits nothing SPECIFIC (it
 * already means "everything they can see"), so only explicit lists show — mirrors
 * the backend's unionDeclaredResources.
 */
function BlastRadiusPreview({
  declares,
}: {
  declares: { secrets: string[] | 'all'; connectors: string[] | 'all' };
}) {
  const secrets = declares.secrets === 'all' ? [] : declares.secrets;
  const conns = declares.connectors === 'all' ? [] : declares.connectors;
  const nothingExtra = secrets.length === 0 && conns.length === 0;
  return (
    <div className="border-border/60 bg-muted/30 space-y-2 rounded-lg border p-3">
      <div className="flex items-center gap-1.5">
        <CornerDownRight className="text-muted-foreground/70 size-3.5 shrink-0" />
        <span className="text-foreground/80 text-xs font-medium">Assigning this also grants</span>
      </div>
      {nothingExtra ? (
        <p className="text-muted-foreground text-[11px] leading-relaxed">
          Nothing extra — this agent declares no specific secrets or connectors to inherit.
        </p>
      ) : (
        <>
          <div className="space-y-1.5">
            {secrets.length > 0 && <ScopeLine icon={KeyRound} label="Secrets" items={secrets} />}
            {conns.length > 0 && <ScopeLine icon={Plug} label="Connectors" items={conns} />}
          </div>
          <p className="text-muted-foreground/60 text-[11px] leading-relaxed">
            The member inherits these as their own — usable in Secrets, sessions, and connector
            calls.
          </p>
        </>
      )}
    </div>
  );
}

function ResourceAccessCard({
  projectId,
  accountId,
  canManage,
  members,
}: {
  projectId: string;
  accountId: string;
  canManage: boolean;
  members: ProjectAccessMember[];
}) {
  const queryClient = useQueryClient();
  const grantsKey = qk.project.resourceGrants(projectId);

  const grantsQuery = useQuery({
    queryKey: grantsKey,
    queryFn: () => listProjectResourceGrants(projectId),
    // Manager-only endpoint (403s otherwise) — don't fire it for non-managers.
    enabled: canManage,
    ...contract('inventory'),
  });
  const groupsQuery = useQuery({
    queryKey: ['account-groups', accountId],
    queryFn: () => listGroups(accountId),
    enabled: canManage,
    staleTime: 60_000,
  });

  const resources = grantsQuery.data?.resources ?? { agents: [], skills: [], secrets: [] };
  const grants = useMemo(() => {
    const raw = toArray(grantsQuery.data?.grants);
    return [...raw].sort((a, b) => {
      const t = a.resource_type.localeCompare(b.resource_type);
      if (t !== 0) return t;
      const r = a.resource_id.localeCompare(b.resource_id);
      return r !== 0 ? r : a.principal_label.localeCompare(b.principal_label);
    });
  }, [grantsQuery.data]);
  const groups: AccountGroup[] = useMemo(() => toArray(groupsQuery.data), [groupsQuery.data]);

  // Display name for a resource id (falls back to the id itself).
  const resourceName = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of resources.agents) m.set(`agent:${a.id}`, a.name);
    for (const s of resources.skills) m.set(`skill:${s.id}`, s.name);
    for (const s of resources.secrets ?? []) m.set(`secret:${s.id}`, s.name);
    return m;
  }, [resources]);

  const hasResources =
    resources.agents.length > 0 ||
    resources.skills.length > 0 ||
    (resources.secrets?.length ?? 0) > 0;

  const [dialogOpen, setDialogOpen] = useState(false);
  const [pickerType] = useState<ResourceGrantType>('agent'); // agent-only grant flow
  const [pickerResourceId, setPickerResourceId] = useState<string>(''); // the agent
  const [principalValue, setPrincipalValue] = useState<string>(''); // "member:id" | "group:id"
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());
  const markPending = (id: string) => setPendingIds((prev) => new Set(prev).add(id));
  const clearPending = (id: string) =>
    setPendingIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });

  // The grant flow is AGENT-ONLY: the pyramid routes ALL resources — secrets,
  // connectors, AND skills — to people through the AGENTS they're assigned to,
  // never by a direct resource→member grant. Declare the resource on an agent
  // (its scope / skills), then assign the agent here. (Pre-existing skill/secret
  // grants still render in the list below so they can be revoked.)
  const activeItems = resources.agents;

  // Blast-radius preview: when an AGENT is picked, what the assignee inherits
  // (the agent's declared secrets + connectors). Null for skills/secrets or until
  // an agent is chosen. Reads the `declares` the resource-grants API attaches.
  const selectedAgentDeclares = useMemo(() => {
    if (pickerType !== 'agent' || !pickerResourceId) return null;
    return resources.agents.find((a) => a.id === pickerResourceId)?.declares ?? null;
  }, [pickerType, pickerResourceId, resources.agents]);

  function resetGrantForm() {
    setPickerResourceId('');
    setPrincipalValue('');
  }

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: grantsKey });
    // The agent/skill lists the rest of the UI renders are now filtered, so
    // the project detail must refetch to reflect what this user can see.
    // invalidateProject() reaches qk.project.scope(projectId), which
    // qk.project.summary(projectId) nests under — no separate summary
    // invalidation needed alongside it.
    void invalidateProject(queryClient, projectId);
  }

  function splitOnce(v: string): [string, string] {
    const i = v.indexOf(':');
    return i < 0 ? [v, ''] : [v.slice(0, i), v.slice(i + 1)];
  }

  const createMutation = useMutation({
    mutationFn: () => {
      const [principalType, principalId] = splitOnce(principalValue);
      return createProjectResourceGrant(projectId, {
        resourceType: pickerType as ResourceGrantType,
        resourceId: pickerResourceId,
        principalType: principalType as 'member' | 'group',
        principalId,
      });
    },
    onSuccess: () => {
      successToast('Resource scoped');
      resetGrantForm();
      setDialogOpen(false);
      invalidate();
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to scope resource'),
  });

  function onDialogOpenChange(next: boolean) {
    if (createMutation.isPending) return;
    if (next) resetGrantForm(); // agent-only flow; the agent list is live immediately
    setDialogOpen(next);
  }

  const removeMutation = useMutation({
    mutationFn: (grantId: string) => deleteProjectResourceGrant(projectId, grantId),
    onMutate: (grantId) => markPending(grantId),
    onSettled: (_d, _e, grantId) => clearPending(grantId),
    onSuccess: () => {
      successToast('Scope removed');
      invalidate();
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to remove scope'),
  });

  // List filter (below): keep a long, mixed grant list scannable by type.
  const [resourceFilter, setResourceFilter] = useState<'all' | ResourceGrantType>('all');
  const grantCounts = useMemo(() => {
    const c: Record<ResourceGrantType, number> = { agent: 0, skill: 0, secret: 0 };
    for (const g of grants) c[g.resource_type] += 1;
    return c;
  }, [grants]);
  const grantFilterOptions = useMemo(() => {
    const opts: { value: 'all' | ResourceGrantType; label: string; count: number }[] = [
      { value: 'all', label: 'All', count: grants.length },
    ];
    if (grantCounts.agent) opts.push({ value: 'agent', label: 'Agents', count: grantCounts.agent });
    if (grantCounts.skill) opts.push({ value: 'skill', label: 'Skills', count: grantCounts.skill });
    if (grantCounts.secret)
      opts.push({ value: 'secret', label: 'Secrets', count: grantCounts.secret });
    return opts;
  }, [grants.length, grantCounts]);
  const visibleGrants = useMemo(
    () =>
      resourceFilter === 'all' ? grants : grants.filter((g) => g.resource_type === resourceFilter),
    [grants, resourceFilter],
  );

  const canSubmit =
    !!pickerType && !!pickerResourceId && !!principalValue && !createMutation.isPending;

  return (
    <>
      <section className="space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-medium">
              Resource access
              {grants.length > 0 ? (
                <span className="text-muted-foreground ml-1.5 font-normal">({grants.length})</span>
              ) : null}
            </h3>
            <p className="text-muted-foreground mt-1 text-xs">
              Assign agents to a member or group to control who can USE them. An agent with no
              assignment is open to everyone with project access; assigning one restricts it to the
              people or groups you choose — they inherit that agent's declared skills, connectors,
              and secrets to use in its sessions. This only ever grants USE, never edit: changing
              the agent, a skill, a connector, or a secret still requires the editor role.
            </p>
          </div>

          {canManage && hasResources ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="shrink-0 gap-1.5"
              onClick={() => onDialogOpenChange(true)}
            >
              <Plus className="size-3.5 shrink-0" />
              Grant access
            </Button>
          ) : null}
        </div>

        {grantsQuery.isLoading && (
          <div className="space-y-2">
            <Skeleton className="h-14 w-full rounded-md" />
          </div>
        )}

        {!grantsQuery.isLoading && grants.length === 0 && (
          <p className="text-muted-foreground text-xs">
            {hasResources
              ? 'Nothing is scoped yet — every agent is open to everyone with project access to use. Grant one above to restrict who can use it. Skills, connectors, and secrets aren’t assigned directly here — they’re governed by the editor role (to edit) and inherited through the agents you assign (to use).'
              : 'This project has no agents to scope yet. Add one first, then come back here to limit who can use it.'}
          </p>
        )}

        {!grantsQuery.isLoading && grants.length > 0 && (
          <div className="space-y-3">
            {grantFilterOptions.length > 2 && (
              <FilterChips
                value={resourceFilter}
                onChange={setResourceFilter}
                options={grantFilterOptions}
              />
            )}
            <ul className="space-y-2">
              {visibleGrants.map((g: ProjectResourceGrant) => {
                const busy = pendingIds.has(g.grant_id);
                const displayName =
                  resourceName.get(`${g.resource_type}:${g.resource_id}`) ?? g.resource_id;
                const ResourceIcon =
                  g.resource_type === 'agent'
                    ? Bot
                    : g.resource_type === 'secret'
                      ? KeyRound
                      : Sparkles;
                return (
                  <li key={g.grant_id} className={MEMBER_ROW}>
                    <span className="bg-muted/60 flex size-8 shrink-0 items-center justify-center rounded-full">
                      <ResourceIcon className="text-muted-foreground size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-foreground truncate text-sm font-medium">
                          {displayName}
                        </span>
                        <Badge variant="outline" size="sm" className="capitalize">
                          {g.resource_type}
                        </Badge>
                        {g.orphaned && (
                          <Badge
                            variant="outline"
                            size="sm"
                            className="border-kortix-orange/30 text-kortix-orange"
                            title={`This ${g.resource_type} no longer exists (renamed or deleted). The grant is inert — the restriction has lapsed. Remove it or re-grant the current ${g.resource_type}.`}
                          >
                            renamed / removed
                          </Badge>
                        )}
                      </div>
                      <span className="text-muted-foreground text-xs">
                        <InlineMeta>
                          <span>
                            {g.principal_type === 'group' ? 'Group' : 'Member'}: {g.principal_label}
                          </span>
                          <span>Granted {formatDate(g.created_at)}</span>
                        </InlineMeta>
                      </span>
                    </div>
                    {busy ? (
                      <Loading className="text-muted-foreground shrink-0" />
                    ) : canManage ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => removeMutation.mutate(g.grant_id)}
                      >
                        Remove
                      </Button>
                    ) : (
                      <Badge variant="outline" size="sm" className="capitalize">
                        {g.principal_type}
                      </Badge>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </section>

      <Modal open={dialogOpen} onOpenChange={onDialogOpenChange}>
        <ModalContent className="sm:max-w-md">
          <ModalHeader>
            <ModalTitle>Assign an agent</ModalTitle>
            <ModalDescription>
              Assign an agent to a member or group — they inherit everything that agent uses (its
              secrets, connectors, and skills) to USE, not edit. Resources reach people through
              agents, not by a direct grant; agents you don't assign stay open to everyone with
              project access. Editing the agent or any resource it uses still requires the editor
              role.
            </ModalDescription>
          </ModalHeader>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!canSubmit) return;
              createMutation.mutate();
            }}
          >
            <ModalBody className="space-y-4">
              <div className="space-y-1.5">
                <span className="text-muted-foreground text-xs font-medium">1. Agent</span>
                <Select
                  value={pickerResourceId}
                  onValueChange={setPickerResourceId}
                  disabled={createMutation.isPending}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select an agent" />
                  </SelectTrigger>
                  <SelectContent>
                    {activeItems.map((r) => (
                      <SelectItem key={r.id} value={r.id}>
                        {r.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {selectedAgentDeclares && <BlastRadiusPreview declares={selectedAgentDeclares} />}

              <div className="space-y-1.5">
                <span className="text-muted-foreground text-xs font-medium">2. Grant to</span>
                <Select
                  value={principalValue}
                  onValueChange={setPrincipalValue}
                  disabled={createMutation.isPending}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Member or group" />
                  </SelectTrigger>
                  <SelectContent>
                    {members.map((m) => (
                      <SelectItem key={`member:${m.user_id}`} value={`member:${m.user_id}`}>
                        {userLabel(m)}
                      </SelectItem>
                    ))}
                    {groups.map((g) => (
                      <SelectItem key={`group:${g.group_id}`} value={`group:${g.group_id}`}>
                        {g.name} · group
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </ModalBody>

            <ModalFooter className="sm:justify-between">
              <Button
                type="button"
                variant="outline-ghost"
                size="sm"
                onClick={() => onDialogOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={!canSubmit}>
                {createMutation.isPending ? <Loading className="size-4 shrink-0" /> : null}
                Grant access
              </Button>
            </ModalFooter>
          </form>
        </ModalContent>
      </Modal>
    </>
  );
}

/**
 * Custom-role assignments for THIS project — the project-level view of the
 * account Roles page's bindings. Custom roles are DEFINED on the account Roles
 * page; here a manager grants one (to a member / group / agent) scoped to
 * this project, so a project's full access picture lives in one place.
 */
function ProjectRoleAssignmentsCard({
  projectId,
  accountId,
  canManage,
  members,
}: {
  projectId: string;
  accountId: string;
  canManage: boolean;
  members: ProjectAccessMember[];
}) {
  const queryClient = useQueryClient();
  // qk.project.policies — the IAM role-policy family. See
  // ProjectGroupGrantsCard's policiesQuery above for why this is NOT
  // qk.project.executorPolicies (a different endpoint/shape both used to
  // share the literal ['project-policies', id] with, pre-migration).
  const policiesKey = qk.project.policies(projectId);

  const policiesQuery = useQuery({
    queryKey: policiesKey,
    // Gated like every sibling below: the account-IAM policies route asserts
    // policy.read, which a non-manager doesn't hold — firing it anyway just
    // 403s for data this card can never show them.
    enabled: canManage,
    queryFn: () => listPolicies(accountId, { scopeId: projectId }),
    ...contract('config'),
  });
  const rolesQuery = useQuery({
    queryKey: ['iam-roles', accountId],
    queryFn: () => listRoles(accountId),
    enabled: canManage,
    staleTime: 60_000,
  });
  const groupsQuery = useQuery({
    queryKey: ['account-groups', accountId],
    queryFn: () => listGroups(accountId),
    enabled: canManage,
    staleTime: 60_000,
  });
  const agentsQuery = useQuery({
    queryKey: ['iam-agent-identities', accountId],
    queryFn: () => listAgentIdentities(accountId),
    enabled: canManage,
    staleTime: 60_000,
  });

  // Only project-scoped bindings for THIS project (account-wide custom roles
  // apply too, but they're managed on the account page, not per-project).
  const policies = useMemo(
    () =>
      toArray(policiesQuery.data).filter(
        (p) => p.scope_type === 'project' && p.scope_id === projectId,
      ),
    [policiesQuery.data, projectId],
  );
  const customRoles = useMemo(
    () => toArray(rolesQuery.data).filter((r) => !r.is_system),
    [rolesQuery.data],
  );
  const groups = useMemo(() => toArray(groupsQuery.data), [groupsQuery.data]);
  const projectAgents = useMemo(
    () => toArray(agentsQuery.data).filter((a) => a.project_id === projectId),
    [agentsQuery.data, projectId],
  );

  const roleNameById = useMemo(
    () => new Map(toArray(rolesQuery.data).map((r) => [r.role_id, r.name])),
    [rolesQuery.data],
  );
  const memberLabelById = useMemo(
    () => new Map(members.map((m) => [m.user_id, userLabel(m)])),
    [members],
  );
  const groupNameById = useMemo(() => new Map(groups.map((g) => [g.group_id, g.name])), [groups]);
  const agentLabelById = useMemo(
    () =>
      new Map(toArray(agentsQuery.data).map((a) => [a.service_account_id, a.agent_name ?? a.name])),
    [agentsQuery.data],
  );

  function principalLabel(p: IamPolicy): { kind: string; label: string; missing: boolean } {
    if (p.principal_type === 'group') {
      return {
        kind: 'Group',
        label: groupNameById.get(p.principal_id) ?? p.principal_id,
        missing: false,
      };
    }
    if (p.principal_type === 'token') {
      // Agent SAs resolve from the account-wide identity list; a miss means the
      // agent was deleted/renamed, so the binding is stale. Show a short id and
      // flag it rather than a bare 36-char UUID.
      const name = agentLabelById.get(p.principal_id);
      return { kind: 'Agent', label: name ?? `${p.principal_id.slice(0, 8)}…`, missing: !name };
    }
    return {
      kind: 'Member',
      label: memberLabelById.get(p.principal_id) ?? p.principal_id,
      missing: false,
    };
  }

  const [dialogOpen, setDialogOpen] = useState(false);
  const [subjectType, setSubjectType] = useState<PrincipalType | ''>(''); // step 1
  const [subjectId, setSubjectId] = useState(''); // step 2
  const [roleId, setRoleId] = useState('');
  const [policyFilter, setPolicyFilter] = useState<'all' | PrincipalType>('all');
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());
  const markPending = (id: string) => setPendingIds((prev) => new Set(prev).add(id));
  const clearPending = (id: string) =>
    setPendingIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: policiesKey });
  }

  // Step 1 of the assign flow: pick the SUBJECT type. Only offer types that
  // have someone to assign (no empty "Agent" list when the project has none).
  const subjectOptions = useMemo(
    () =>
      (
        [
          {
            type: 'member',
            label: 'Member',
            Icon: User,
            items: members.map((m) => ({ id: m.user_id, name: userLabel(m) })),
          },
          {
            type: 'group',
            label: 'Group',
            Icon: Users,
            items: groups.map((g) => ({ id: g.group_id, name: g.name })),
          },
          {
            type: 'token',
            label: 'Agent',
            Icon: Bot,
            items: projectAgents.map((a) => ({
              id: a.service_account_id,
              name: a.agent_name ?? a.name,
            })),
          },
        ] as const
      ).filter((o) => o.items.length > 0),
    [members, groups, projectAgents],
  );
  // Step 2 options: only the subjects of the chosen type.
  const activeSubjects = subjectOptions.find((o) => o.type === subjectType)?.items ?? [];

  function resetAssignForm() {
    setSubjectType('');
    setSubjectId('');
    setRoleId('');
  }
  function onSubjectTypeChange(t: PrincipalType) {
    setSubjectType(t);
    setSubjectId(''); // the previous pick belongs to a different subject type
  }

  const createMutation = useMutation({
    mutationFn: () =>
      createPolicy(accountId, {
        principalType: subjectType as PrincipalType,
        principalId: subjectId,
        scopeType: 'project',
        scopeId: projectId,
        roleId,
      }),
    onSuccess: () => {
      successToast('Role assigned');
      resetAssignForm();
      setDialogOpen(false);
      invalidate();
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to assign role'),
  });

  function onDialogOpenChange(next: boolean) {
    if (createMutation.isPending) return;
    if (next) {
      resetAssignForm();
      setSubjectType(subjectOptions[0]?.type ?? '');
    }
    setDialogOpen(next);
  }

  const removeMutation = useMutation({
    mutationFn: (policyId: string) => deletePolicy(accountId, policyId),
    onMutate: (policyId) => markPending(policyId),
    onSettled: (_d, _e, policyId) => clearPending(policyId),
    onSuccess: () => {
      successToast('Assignment removed');
      invalidate();
    },
    onError: (err: Error) => errorToast(err.message || 'Failed to remove assignment'),
  });

  // List filter (below): segment a long mixed binding list by subject type.
  const policyCounts = useMemo(() => {
    const c: Record<string, number> = { member: 0, group: 0, token: 0 };
    for (const p of policies) c[p.principal_type] = (c[p.principal_type] ?? 0) + 1;
    return c;
  }, [policies]);
  const policyFilterOptions = useMemo(() => {
    const opts: { value: 'all' | PrincipalType; label: string; count: number }[] = [
      { value: 'all', label: 'All', count: policies.length },
    ];
    if (policyCounts.member)
      opts.push({ value: 'member', label: 'Members', count: policyCounts.member });
    if (policyCounts.group)
      opts.push({ value: 'group', label: 'Groups', count: policyCounts.group });
    if (policyCounts.token)
      opts.push({ value: 'token', label: 'Agents', count: policyCounts.token });
    return opts;
  }, [policies.length, policyCounts]);
  const visiblePolicies = useMemo(
    () =>
      policyFilter === 'all' ? policies : policies.filter((p) => p.principal_type === policyFilter),
    [policies, policyFilter],
  );

  const canSubmit = !!subjectType && !!subjectId && !!roleId && !createMutation.isPending;

  return (
    <>
      <section className="space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-sm font-medium">
              Custom roles
              {policies.length > 0 ? (
                <span className="text-muted-foreground ml-1.5 font-normal">
                  ({policies.length})
                </span>
              ) : null}
            </h3>
            <p className="text-muted-foreground mt-1 text-xs">
              Grant a custom role to a member, group, or agent on this project. Custom roles are
              defined on the account Roles page; here you bind them for this project only.
            </p>
          </div>

          {canManage && customRoles.length > 0 ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="shrink-0 gap-1.5"
              onClick={() => onDialogOpenChange(true)}
            >
              <Plus className="size-3.5 shrink-0" />
              Assign role
            </Button>
          ) : null}
        </div>

        {policiesQuery.isLoading && (
          <div className="space-y-2">
            <Skeleton className="h-14 w-full rounded-md" />
          </div>
        )}

        {!policiesQuery.isLoading && policies.length === 0 && (
          <p className="text-muted-foreground text-xs">
            {customRoles.length === 0 ? (
              <>
                No custom roles exist yet. Create one on the{' '}
                <a href={`/accounts/${accountId}?tab=roles`} className="underline">
                  account Roles page
                </a>
                , then bind it here for this project.
              </>
            ) : (
              'No custom-role assignments on this project yet. Bind one above to grant a member, group, or agent a custom role here.'
            )}
          </p>
        )}

        {!policiesQuery.isLoading && policies.length > 0 && (
          <div className="space-y-3">
            {policyFilterOptions.length > 2 && (
              <FilterChips
                value={policyFilter}
                onChange={setPolicyFilter}
                options={policyFilterOptions}
              />
            )}
            <ul className="space-y-2">
              {visiblePolicies.map((p) => {
                const busy = pendingIds.has(p.policy_id);
                const { kind, label, missing } = principalLabel(p);
                return (
                  <li key={p.policy_id} className={MEMBER_ROW}>
                    <span className="bg-muted/60 flex size-8 shrink-0 items-center justify-center rounded-full">
                      <Shield className="text-muted-foreground size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-foreground truncate text-sm font-medium">
                          {roleNameById.get(p.role_id) ?? p.role_id}
                        </span>
                        <Badge variant="outline" size="sm">
                          Custom
                        </Badge>
                      </div>
                      <span className="text-muted-foreground text-xs">
                        <InlineMeta>
                          <span className="flex items-center gap-1.5">
                            {kind}: {label}
                            {missing && (
                              <Badge
                                variant="outline"
                                size="sm"
                                className="border-kortix-orange/30 text-kortix-orange"
                                title="This agent no longer exists (deleted or renamed). The binding is stale — remove it or re-assign the current agent."
                              >
                                removed
                              </Badge>
                            )}
                          </span>
                          {p.expires_at ? <span>Expires {formatDate(p.expires_at)}</span> : null}
                        </InlineMeta>
                      </span>
                    </div>
                    {busy ? (
                      <Loading className="text-muted-foreground shrink-0" />
                    ) : canManage ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => removeMutation.mutate(p.policy_id)}
                      >
                        Remove
                      </Button>
                    ) : (
                      <Badge variant="outline" size="sm" className="capitalize">
                        {kind}
                      </Badge>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </section>

      <Modal open={dialogOpen} onOpenChange={onDialogOpenChange}>
        <ModalContent className="sm:max-w-md">
          <ModalHeader>
            <ModalTitle>Assign a custom role</ModalTitle>
            <ModalDescription>
              Bind a custom role to a member, group, or agent on this project only.
            </ModalDescription>
          </ModalHeader>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!canSubmit) return;
              createMutation.mutate();
            }}
          >
            <ModalBody className="space-y-4">
              <div className="space-y-1.5">
                <span className="text-muted-foreground text-xs font-medium">1. Assign to</span>
                <div className="flex gap-1.5">
                  {subjectOptions.map(({ type, label, Icon }) => (
                    <Button
                      key={type}
                      type="button"
                      size="sm"
                      variant={subjectType === type ? 'default' : 'outline'}
                      className="flex-1 gap-1.5"
                      onClick={() => onSubjectTypeChange(type)}
                    >
                      <Icon className="size-3.5 shrink-0" />
                      {label}
                    </Button>
                  ))}
                </div>
              </div>

              <div className="space-y-1.5">
                <span className="text-muted-foreground text-xs font-medium">
                  2.{' '}
                  {subjectType === 'group' ? 'Group' : subjectType === 'token' ? 'Agent' : 'Member'}
                </span>
                <Select
                  value={subjectId}
                  onValueChange={setSubjectId}
                  disabled={!subjectType || createMutation.isPending}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={subjectType ? 'Select one' : 'Pick a type first'} />
                  </SelectTrigger>
                  <SelectContent>
                    {activeSubjects.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <span className="text-muted-foreground text-xs font-medium">3. Custom role</span>
                <Select
                  value={roleId}
                  onValueChange={setRoleId}
                  disabled={createMutation.isPending}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select a role" />
                  </SelectTrigger>
                  <SelectContent>
                    {customRoles.map((r) => (
                      <SelectItem key={r.role_id} value={r.role_id}>
                        {r.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </ModalBody>

            <ModalFooter className="sm:justify-between">
              <Button
                type="button"
                variant="outline-ghost"
                size="sm"
                onClick={() => onDialogOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={!canSubmit}>
                {createMutation.isPending ? <Loading className="size-4 shrink-0" /> : null}
                Assign role
              </Button>
            </ModalFooter>
          </form>
        </ModalContent>
      </Modal>
    </>
  );
}
