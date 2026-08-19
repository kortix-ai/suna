'use client';

/**
 * `AccessProjectsTab` — the account-level "Projects" tab inside Account
 * Settings' Access section. The single place to see and manage every
 * project's access, for every project in the account, without opening each
 * project's own settings.
 *
 * **Direct replacement for the per-project Members page.** The old surface
 * (`features/workspace/settings/tabs/members-tab.tsx`) was PROJECT-scoped:
 * open one project, see its members. This tab flips that — open the account,
 * pick a project from a list, see (and edit) its access. Nothing users could
 * do there stops working here:
 *
 *   - member role edit / remove        → `AccessDialog` / `revokeProjectAccess`
 *   - invite a member                  → `AccessDialog` (`inviteProjectMember`)
 *   - pending (non-signed-up) invites  → `listPendingProjectInvites` +
 *                                         `resendPendingProjectInvite` / `revokePendingProjectInvite`
 *   - access requests                  → `listProjectAccessRequests` +
 *                                         `approveProjectAccessRequest` / `rejectProjectAccessRequest`
 *
 * **Everything visual comes from the shared access primitives**
 * (`features/workspace/shared/access`): `AccessDetailShell` for the panel
 * chrome, `AccessList`/`AccessRow` for every list, and `AccessDialog` for
 * every "give / edit access" interaction. This file owns NO picker, role
 * select, list row, modal, or destructive-confirm copy of its own — the
 * table, the two `DropdownMenuSub` role changers, the popover cells and the
 * local `GrantAccessDialog` all went away with the unification.
 *
 * **Groups sit in the SAME list as members.** Granting or editing a group's
 * project access runs through `AccessDialog`, which calls the exact same
 * mutations the group detail page uses (`attachGroupToProject`,
 * `updateProjectGroupGrant`, `detachGroupFromProject`) — no reimplementation.
 *
 * **The extended access contract these rows render.** `GET
 * /projects/:id/access` (`listProjectAccess`) carries, per member,
 * `custom_role_policies` (this member's custom IAM-role bindings, direct or
 * inherited via a group) and `resource_grants` (which agents/skills this
 * member is scoped to, same direct-or-via-group shape), plus a top-level
 * `group_access` array — one entry per group with SOME access to this
 * project. Field names are copied byte-for-byte from the live handler
 * (`apps/api/src/projects/routes/r6.ts`). The SDK's `ProjectAccessMember` /
 * `ProjectAccessResponse` types do not carry these fields yet, so this file
 * declares its own extension types below rather than editing the SDK's
 * published types out from under a separate change.
 *
 * **One gap in the live contract, worth flagging rather than papering over:**
 * `group_access` entries carry no `expires_at` for the group's own
 * `built_in_role` grant (`project_group_grants.expires_at` exists in the
 * database and on `attachGroupToProject`/`updateProjectGroupGrant`'s params,
 * but `r6.ts`'s `groupAccessById` builder does not select it onto the
 * response). A group row therefore shows an expiry ONLY when its custom-role
 * policy carries one, rather than fabricating "never" for a value it cannot
 * see.
 *
 * **Project picker avoids an N+1 stampede, on purpose.** Every project in the
 * account needs a member count and a "has pending requests" dot, but neither
 * is on `listProjectsForAccount`'s response — getting them means one
 * `listProjectAccess` (+ one `listProjectAccessRequests` for the dot) PER
 * PROJECT. Two guards: the list only renders a bounded page
 * (`PROJECT_LIST_PAGE_SIZE`, "Show more" to reveal further pages, reset on
 * search), and the per-row probe is best-effort — a 403 (viewer can't manage
 * that project's members) or any other failure just leaves the dot off
 * instead of erroring the row.
 *
 * `selectedProjectId` / `onSelectProject` are controlled props; the account
 * page owns the `?project=` query param.
 */

import Link from 'next/link';
import { useMemo, useState } from 'react';

import { isInheritedFromGroupOnly } from '@/components/iam/iam-display-helpers';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import Hint from '@/components/ui/hint';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import { Skeleton } from '@/components/ui/skeleton';
import { errorToast, successToast, warningToast } from '@/components/ui/toast';
import { UserAvatar } from '@/components/ui/user-avatar';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import {
  AccessDetailShell,
  AccessDialog,
  AccessList,
  AccessRow,
  ROLE_NONE,
  builtinRole,
  customRole,
  formatDate,
  formatExpiry,
  principalLabel,
  removeAccessCopy,
  roleValueLabel,
  type AccessDialogCurrent,
  type AccessDialogPrincipal,
  type KebabItem,
  type RoleValue,
} from '@/features/workspace/shared/access';
import { useCopy } from '@/hooks/use-copy';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { cn } from '@/lib/utils';
import {
  approveProjectAccessRequest,
  detachGroupFromProject,
  getProject,
  listPendingProjectInvites,
  listProjectAccess,
  listProjectAccessRequests,
  listProjectResourceGrants,
  listProjectsForAccount,
  rejectProjectAccessRequest,
  resendPendingProjectInvite,
  revokePendingProjectInvite,
  revokeProjectAccess,
  type KortixProject,
  type PendingProjectInvite,
  type ProjectAccessMember,
  type ProjectAccessResponse,
  type ProjectRole,
} from '@kortix/sdk';
import { contract, invalidatePermissionProbes, qk } from '@kortix/sdk/react';
import {
  ArrowClockwiseIcon,
  ArrowSquareOutIcon,
  CheckIcon,
  ClockIcon,
  EnvelopeIcon,
  FolderOpenIcon,
  MagnifyingGlassIcon,
  PencilSimpleIcon,
  PlusIcon,
  TrashIcon,
  UsersIcon,
  XIcon,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

// ─── The extended access contract (see header comment) ─────────────────────

/** One custom-role binding resolved server-side onto the member/group row.
 *  `source`/`group_id`/`group_name` are present on a MEMBER's entries (was
 *  this bound directly, or inherited via a group?) and absent on a GROUP's
 *  own entries in `group_access` — a group's policies have no further
 *  attribution chain. */
interface CustomRolePolicyEntry {
  policy_id: string;
  role_id: string;
  role_key: string;
  role_name: string;
  scope_type: 'project' | 'account';
  expires_at: string | null;
  source?: 'direct' | 'group';
  group_id?: string | null;
  group_name?: string | null;
}

/** One agent/skill-scoping grant resolved onto the row — the member/group
 *  counterpart of `ProjectResourceGrant` (`@kortix/sdk`). */
interface ResourceGrantEntry {
  grant_id: string;
  resource_type: 'agent' | 'skill';
  resource_id: string;
  expires_at: string | null;
  source?: 'direct' | 'group';
  group_id?: string | null;
  group_name?: string | null;
}

interface ExtendedProjectAccessMember extends ProjectAccessMember {
  custom_role_policies?: CustomRolePolicyEntry[];
  resource_grants?: ResourceGrantEntry[];
}

/** A group's access to this project — the group counterpart of
 *  `ExtendedProjectAccessMember`. No `expires_at` here — see this file's
 *  header comment, "One gap in the live contract". */
interface GroupAccessRow {
  group_id: string;
  group_name: string | null;
  built_in_role: ProjectRole | null;
  custom_role_policies?: CustomRolePolicyEntry[];
  resource_grants?: ResourceGrantEntry[];
}

interface ExtendedProjectAccessResponse extends ProjectAccessResponse {
  members: ExtendedProjectAccessMember[];
  group_access?: GroupAccessRow[];
}

/** Bounded page for the project picker — see header comment. */
const PROJECT_LIST_PAGE_SIZE = 20;

const IMPLICIT_HINT =
  'Owners and admins always have Manager on every project. To set this directly, change their account role to Member first.';
const GROUP_INHERITED_HINT =
  "Inherited from a group. Change the group's project access to update this.";

// ─── Row derivations (one shape for members and groups) ────────────────────

/** The project-scoped custom-role policy the principal holds DIRECTLY. A
 *  group-sourced policy on a member row is not that member's to edit. */
function directProjectPolicy(
  policies: CustomRolePolicyEntry[] | undefined,
): CustomRolePolicyEntry | undefined {
  return (policies ?? []).find((p) => p.scope_type === 'project' && p.source !== 'group');
}

function agentGrantsOf(grants: ResourceGrantEntry[] | undefined): ResourceGrantEntry[] {
  return (grants ?? []).filter((g) => g.resource_type === 'agent');
}

/**
 * The DISTINCT agents a principal reaches. One agent can arrive twice — a
 * direct grant plus the same agent through a group — and counting rows
 * instead of agents renders "Agents: 2 of 3" for a person who reaches one.
 * Direct rows win, so `directAgentIds` below still filters correctly.
 */
function distinctAgentGrants(grants: ResourceGrantEntry[]): ResourceGrantEntry[] {
  const byResource = new Map<string, ResourceGrantEntry>();
  for (const grant of grants) {
    const existing = byResource.get(grant.resource_id);
    if (!existing || (existing.source === 'group' && grant.source !== 'group')) {
      byResource.set(grant.resource_id, grant);
    }
  }
  return [...byResource.values()];
}

/** "via account admin" / "via Engineering +1 more" / "no access". `null` for
 *  a plain direct grant, which needs no attribution line. */
export function accessVia(
  member: Pick<
    ExtendedProjectAccessMember,
    'effective_project_role' | 'effective_source' | 'group_sources'
  >,
): string | null {
  if (!member.effective_project_role) return 'no access';
  if (member.effective_source === 'implicit') return 'via account admin';
  if (member.effective_source === 'group') {
    const groupName = member.group_sources?.[0]?.group_name;
    const extra = (member.group_sources?.length ?? 0) - 1;
    return groupName ? `via ${groupName}${extra > 0 ? ` +${extra} more` : ''}` : null;
  }
  return null;
}

/** "Agents: all" when nothing narrows them, else "Agents: 3 of 5" (or just
 *  "Agents: 3" when the project's agent roster is not readable here). */
export function agentsMetaPart(granted: number, projectAgentCount: number | undefined): string {
  if (granted === 0) return 'Agents: all';
  if (projectAgentCount == null) return `Agents: ${granted}`;
  return `Agents: ${granted} of ${projectAgentCount}`;
}

function ExpiryMeta({ expiresAt }: { expiresAt: string | null | undefined }) {
  const expiry = formatExpiry(expiresAt);
  if (!expiry.bounded) return <span className="tabular-nums">Expires never</span>;
  return (
    <span
      className={cn('tabular-nums', expiry.expired ? 'text-kortix-red' : 'text-kortix-yellow')}
    >
      Expires {expiry.label}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Public component
// ─────────────────────────────────────────────────────────────────────────

export interface AccessProjectsTabProps {
  accountId: string;
  /** null = show the project picker. A project id = show that project's
   *  access panel. Controlled by the account page's `?project=` param. */
  selectedProjectId: string | null;
  onSelectProject: (id: string | null) => void;
  /** Hides the custom-role group inside `RoleSelect` when the tier lacks the
   *  `rbac` entitlement. Defaults to true so an unresolved tier is never
   *  silently downgraded. */
  rbacEnabled?: boolean;
  /** Shows the "Create a custom role →" link inside `RoleSelect`. */
  canManageRoles?: boolean;
}

export function AccessProjectsTab({
  accountId,
  selectedProjectId,
  onSelectProject,
  rbacEnabled = true,
  canManageRoles = false,
}: AccessProjectsTabProps) {
  if (!selectedProjectId) {
    return <ProjectPicker accountId={accountId} onSelectProject={onSelectProject} />;
  }
  return (
    <ProjectAccessPanel
      key={selectedProjectId}
      accountId={accountId}
      projectId={selectedProjectId}
      rbacEnabled={rbacEnabled}
      canManageRoles={canManageRoles}
      onBack={() => onSelectProject(null)}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Project picker (selectedProjectId === null)
// ─────────────────────────────────────────────────────────────────────────

function ProjectPicker({
  accountId,
  onSelectProject,
}: {
  accountId: string;
  onSelectProject: (id: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [visibleCount, setVisibleCount] = useState(PROJECT_LIST_PAGE_SIZE);

  const projectsQuery = useQuery({
    queryKey: qk.projects.list(accountId),
    queryFn: () => listProjectsForAccount(accountId),
    ...contract('inventory'),
  });

  const filtered = useMemo(() => {
    const all = projectsQuery.data ?? [];
    const q = search.trim().toLowerCase();
    const list = q ? all.filter((p) => p.name.toLowerCase().includes(q)) : all;
    return [...list].sort((a, b) => a.name.localeCompare(b.name));
  }, [projectsQuery.data, search]);

  const visible = filtered.slice(0, visibleCount);
  const hasMore = filtered.length > visible.length;
  const total = projectsQuery.data?.length ?? 0;
  const settled = !projectsQuery.isLoading && !projectsQuery.isError;

  return (
    <div className="space-y-4">
      <div className="space-y-0.5">
        <p className="text-foreground text-sm font-medium">Projects{settled ? ` · ${total}` : ''}</p>
        <p className="text-muted-foreground text-xs">
          Every project&apos;s access, in one place. Pick one to see who&apos;s in and manage it.
        </p>
      </div>

      <InputGroupSearch>
        <InputGroupSearchIcon>
          <MagnifyingGlassIcon />
        </InputGroupSearchIcon>
        <InputGroupSearchInput
          placeholder="Search projects"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setVisibleCount(PROJECT_LIST_PAGE_SIZE);
          }}
          variant="popover"
        />
        {search ? <InputGroupSearchClear onClick={() => setSearch('')} /> : null}
      </InputGroupSearch>

      {projectsQuery.isError ? (
        <ErrorState
          size="sm"
          title="Failed to load projects"
          description={(projectsQuery.error as Error)?.message}
          action={
            <Button variant="outline" size="sm" onClick={() => projectsQuery.refetch()}>
              Retry
            </Button>
          }
        />
      ) : projectsQuery.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[58px] w-full rounded-md" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={FolderOpenIcon}
          size="sm"
          title={search ? 'No projects match your search' : 'No projects yet'}
        />
      ) : (
        <>
          <AccessList>
            {visible.map((project) => (
              <ProjectListRow
                key={project.project_id}
                project={project}
                onSelect={() => onSelectProject(project.project_id)}
              />
            ))}
          </AccessList>
          {hasMore ? (
            <div className="flex justify-center pt-1">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setVisibleCount((count) => count + PROJECT_LIST_PAGE_SIZE)}
              >
                Show more
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

/** One project row. Fetches its own member count + pending-request dot —
 *  best-effort, never blocks the row: a slow or failed probe just shows
 *  "—"/no dot instead of an error. See header comment. */
function ProjectListRow({ project, onSelect }: { project: KortixProject; onSelect: () => void }) {
  // `GET /projects/:id/access-requests` asserts `project.members.manage`, so ask
  // for exactly that. It used to re-derive the answer from the row's role label
  // to save a request per row — which made every custom role holding
  // `project.members.manage` invisible here, the precise failure this refactor
  // exists to remove. `project.account_id` is already on the row, so the probe
  // costs one request and no project lookup, and its verdict is cached 5 minutes
  // across every row and screen that asks the same question.
  const canSeePendingRequests =
    useProjectCan(project.project_id, PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE, {
      accountId: project.account_id,
    }).allowed === true;

  const accessQuery = useQuery({
    queryKey: qk.project.access(project.project_id),
    queryFn: () => listProjectAccess(project.project_id),
    staleTime: 30_000,
    retry: false,
  });
  const requestsQuery = useQuery({
    queryKey: qk.project.accessRequests(project.project_id),
    queryFn: () => listProjectAccessRequests(project.project_id),
    staleTime: 30_000,
    retry: false,
    enabled: canSeePendingRequests,
  });

  const memberCount = accessQuery.data?.members.length;
  const hasPendingRequests =
    (requestsQuery.data?.requests.filter((r) => r.status === 'pending').length ?? 0) > 0;

  return (
    <AccessRow
      leading={<EntityAvatar icon={FolderOpenIcon} size="md" />}
      title={project.name}
      badges={
        hasPendingRequests ? (
          <Hint label="Has pending access requests" side="top">
            <span
              className="bg-kortix-red inline-block size-1.5 shrink-0 rounded-full"
              aria-label="Pending access requests"
            />
          </Hint>
        ) : null
      }
      meta={
        <span className="text-muted-foreground text-xs">
          {accessQuery.isLoading
            ? 'Loading…'
            : memberCount != null
              ? `${memberCount} member${memberCount === 1 ? '' : 's'}`
              : '—'}
        </span>
      }
      onClick={onSelect}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Project access panel (selectedProjectId set)
// ─────────────────────────────────────────────────────────────────────────

/** An open "Edit access" dialog: which principal, and what it currently has. */
interface EditTarget {
  principal: AccessDialogPrincipal;
  current: AccessDialogCurrent;
  /** Groups that keep granting access after a direct grant is removed. */
  inheritedFrom?: string[];
}

function ProjectAccessPanel({
  accountId,
  projectId,
  rbacEnabled,
  canManageRoles,
  onBack,
}: {
  accountId: string;
  projectId: string;
  rbacEnabled: boolean;
  canManageRoles: boolean;
  onBack: () => void;
}) {
  const queryClient = useQueryClient();

  // The single leaf every write control below gates on.
  const { allowed: canManageMembers } = useProjectCan(
    projectId,
    PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE,
  );

  const projectQuery = useQuery({
    queryKey: qk.project.summary(projectId),
    queryFn: () => getProject(projectId),
    ...contract('config'),
  });
  const project = projectQuery.data;
  const projectName = project?.name ?? 'this project';

  const accessQuery = useQuery({
    queryKey: qk.project.access(projectId),
    queryFn: () => listProjectAccess(projectId) as Promise<ExtendedProjectAccessResponse>,
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

  // Denominator for the rows' "Agents: 3 of 5" meta. Best-effort: the same
  // query `AccessDialog` reads its agent checkbox list from, so opening the
  // dialog is a cache hit.
  const projectResourcesQuery = useQuery({
    queryKey: qk.project.resourceGrants(projectId),
    queryFn: () => listProjectResourceGrants(projectId),
    ...contract('inventory'),
    enabled: canManageMembers,
    retry: false,
  });
  const projectAgentCount = projectResourcesQuery.data?.resources.agents.length;

  function invalidateAccess() {
    // Every caller of this function has just changed who can do what on this
    // project. Probe verdicts are cached 5 minutes; without this a revoke keeps
    // rendering as access until the entry expires.
    void invalidatePermissionProbes(queryClient, { accountId });
    queryClient.invalidateQueries({ queryKey: qk.project.access(projectId) });
    queryClient.invalidateQueries({ queryKey: qk.projects.scope() });
    queryClient.invalidateQueries({ queryKey: qk.project.summary(projectId) });
    queryClient.invalidateQueries({ queryKey: ['account-groups', accountId] });
  }

  // ── Remove access / detach group ──────────────────────────────────────
  const [removeMemberTarget, setRemoveMemberTarget] = useState<ExtendedProjectAccessMember | null>(
    null,
  );
  const [pendingUserIds, setPendingUserIds] = useState<Set<string>>(() => new Set());
  const removeMemberMutation = useMutation({
    mutationFn: (userId: string) => revokeProjectAccess(projectId, userId),
    onMutate: (userId) => setPendingUserIds((prev) => new Set(prev).add(userId)),
    onSettled: (_data, _error, userId) =>
      setPendingUserIds((prev) => {
        const next = new Set(prev);
        next.delete(userId);
        return next;
      }),
    onSuccess: () => {
      successToast('Access removed');
      invalidateAccess();
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to remove access'),
  });

  const [removeGroupTarget, setRemoveGroupTarget] = useState<GroupAccessRow | null>(null);
  const [pendingGroupIds, setPendingGroupIds] = useState<Set<string>>(() => new Set());
  const detachGroupMutation = useMutation({
    mutationFn: (groupId: string) => detachGroupFromProject(projectId, groupId),
    onMutate: (groupId) => setPendingGroupIds((prev) => new Set(prev).add(groupId)),
    onSettled: (_data, _error, groupId) =>
      setPendingGroupIds((prev) => {
        const next = new Set(prev);
        next.delete(groupId);
        return next;
      }),
    onSuccess: () => {
      successToast('Group detached from project');
      invalidateAccess();
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to detach group'),
  });

  // ── Pending invites ───────────────────────────────────────────────────
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

  // ── Access requests ───────────────────────────────────────────────────
  const [accessRequestBusyIds, setAccessRequestBusyIds] = useState<Set<string>>(() => new Set());
  const markRequestBusy = (id: string) => setAccessRequestBusyIds((prev) => new Set(prev).add(id));
  const clearRequestBusy = (id: string) =>
    setAccessRequestBusyIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });

  const approveRequestMutation = useMutation({
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

  const rejectRequestMutation = useMutation({
    mutationFn: (requestId: string) => rejectProjectAccessRequest(projectId, requestId),
    onMutate: (requestId) => markRequestBusy(requestId),
    onSettled: (_data, _error, requestId) => clearRequestBusy(requestId),
    onSuccess: () => {
      successToast('Access request declined');
      queryClient.invalidateQueries({ queryKey: qk.project.accessRequests(projectId) });
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to decline request'),
  });

  // ── Grant / edit dialogs ──────────────────────────────────────────────
  const [grantOpen, setGrantOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  function openEdit(target: EditTarget) {
    setEditTarget(target);
    setEditOpen(true);
  }

  const members = accessQuery.data?.members ?? [];
  const groups = accessQuery.data?.group_access ?? [];
  const rowCount = members.length + groups.length;

  const pendingInvites = pendingInvitesQuery.data?.pending ?? [];
  const accessRequests = accessRequestsQuery.data?.requests ?? [];
  const showPendingInvites =
    canManageMembers && (pendingInvitesQuery.isLoading || pendingInvites.length > 0);
  const showAccessRequests =
    canManageMembers && (accessRequestsQuery.isLoading || accessRequests.length > 0);

  const settledRows = !accessQuery.isLoading && !accessQuery.isError;

  return (
    <AccessDetailShell
      back={{ label: 'All projects', onClick: onBack }}
      avatar={<EntityAvatar icon={FolderOpenIcon} size="lg" />}
      title={project?.name ?? '…'}
      loading={projectQuery.isLoading}
      actions={
        <Button asChild type="button" variant="ghost" size="sm" className="gap-1.5">
          <Link href={`/projects/${projectId}`}>
            Open project
            <ArrowSquareOutIcon className="size-3.5" />
          </Link>
        </Button>
      }
    >
      {/* ── Asked to join ─────────────────────────────────────────────── */}
      {showAccessRequests ? (
        accessRequestsQuery.isLoading ? (
          <Skeleton className="h-14 w-full rounded-md" />
        ) : (
          <AccessList header={{ title: 'Asked to join', count: accessRequests.length }}>
            {accessRequests.map((request) => {
              const busy = accessRequestBusyIds.has(request.request_id);
              return (
                <AccessRow
                  key={request.request_id}
                  leading={
                    <span className="bg-kortix-yellow/10 text-kortix-yellow inline-flex size-8 shrink-0 items-center justify-center rounded-sm border">
                      <EnvelopeIcon className="size-4" />
                    </span>
                  }
                  title={request.requester_email}
                  metaParts={[
                    <span key="requested" className="tabular-nums">
                      Requested {formatDate(request.created_at)}
                    </span>,
                    ...(request.message ? [<span key="message">&quot;{request.message}&quot;</span>] : []),
                  ]}
                  pending={busy}
                  actions={
                    busy ? undefined : (
                      <>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => approveRequestMutation.mutate(request.request_id)}
                          className="gap-1.5"
                        >
                          <CheckIcon className="size-3.5" />
                          Approve
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => rejectRequestMutation.mutate(request.request_id)}
                          className="gap-1.5"
                        >
                          <XIcon className="size-3.5" />
                          Decline
                        </Button>
                      </>
                    )
                  }
                />
              );
            })}
          </AccessList>
        )
      ) : null}

      {/* ── Invited to this project ───────────────────────────────────── */}
      {showPendingInvites ? (
        pendingInvitesQuery.isLoading ? (
          <Skeleton className="h-14 w-full rounded-md" />
        ) : (
          <AccessList header={{ title: 'Invited to this project', count: pendingInvites.length }}>
            {pendingInvites.map((invite) => {
              const busy = pendingInviteBusyIds.has(invite.invite_id);
              return (
                <AccessRow
                  key={invite.invite_id}
                  dashed
                  leading={
                    <span className="bg-kortix-orange/10 text-kortix-orange inline-flex size-8 shrink-0 items-center justify-center rounded-sm border">
                      <EnvelopeIcon className="size-4" />
                    </span>
                  }
                  title={invite.email}
                  badges={
                    <Badge variant="outline" size="sm" className="capitalize">
                      {invite.project_role}
                    </Badge>
                  }
                  metaParts={[
                    <span key="invited" className="tabular-nums">
                      Invited {formatDate(invite.created_at)}
                    </span>,
                    invite.invite_expired ? (
                      <span key="expiry" className="text-kortix-orange">
                        Link expired
                      </span>
                    ) : (
                      <span key="expiry" className="inline-flex items-center gap-1 tabular-nums">
                        <ClockIcon className="size-3" />
                        Expires {formatDate(invite.invite_expires_at)}
                      </span>
                    ),
                  ]}
                  pending={busy}
                  actions={
                    busy ? undefined : (
                      <>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => resendInviteMutation.mutate(invite.invite_id)}
                          className="gap-1.5"
                        >
                          <ArrowClockwiseIcon className="size-3.5" />
                          Resend
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => setRevokeInviteTarget(invite)}
                          className="gap-1.5"
                        >
                          <XIcon className="size-3.5" />
                          Revoke
                        </Button>
                      </>
                    )
                  }
                />
              );
            })}
          </AccessList>
        )
      ) : null}

      {/* ── Access ────────────────────────────────────────────────────── */}
      {accessQuery.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[58px] w-full rounded-md" />
          ))}
        </div>
      ) : accessQuery.isError ? (
        <ErrorState
          size="sm"
          title="Failed to load access"
          description={(accessQuery.error as Error)?.message}
          action={
            <Button variant="outline" size="sm" onClick={() => accessQuery.refetch()}>
              Retry
            </Button>
          }
        />
      ) : rowCount === 0 ? (
        <EmptyState
          icon={UsersIcon}
          size="sm"
          title="Nobody has access yet"
          description="Grant a member or group access to get started."
          action={
            canManageMembers ? (
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setGrantOpen(true)}>
                <PlusIcon className="size-3.5" />
                Grant access
              </Button>
            ) : undefined
          }
        />
      ) : (
        <AccessList
          header={{
            title: 'Access',
            count: settledRows ? rowCount : undefined,
            actions: canManageMembers ? (
              <Button type="button" size="sm" onClick={() => setGrantOpen(true)} className="gap-1.5">
                <PlusIcon className="size-3.5" />
                Grant access
              </Button>
            ) : undefined,
          }}
        >
          {members.map((member) => (
            <MemberAccessRow
              key={`member:${member.user_id}`}
              member={member}
              canManageMembers={canManageMembers}
              busy={pendingUserIds.has(member.user_id)}
              projectAgentCount={projectAgentCount}
              onEdit={openEdit}
              onRequestRemove={() => setRemoveMemberTarget(member)}
            />
          ))}
          {groups.map((group) => (
            <GroupAccessRowView
              key={`group:${group.group_id}`}
              group={group}
              canManageMembers={canManageMembers}
              busy={pendingGroupIds.has(group.group_id)}
              projectAgentCount={projectAgentCount}
              onEdit={openEdit}
              onRequestRemove={() => setRemoveGroupTarget(group)}
            />
          ))}
        </AccessList>
      )}

      {/* ── The one grant / edit modal ────────────────────────────────── */}
      <AccessDialog
        open={grantOpen}
        onOpenChange={setGrantOpen}
        accountId={accountId}
        scope={{ kind: 'project', projectId, projectName }}
        mode={{ kind: 'grant' }}
        rbacEnabled={rbacEnabled}
        canManageRoles={canManageRoles}
        onDone={invalidateAccess}
      />

      {editTarget ? (
        <AccessDialog
          key={`${editTarget.principal.type}:${editTarget.principal.id}`}
          open={editOpen}
          onOpenChange={setEditOpen}
          accountId={accountId}
          scope={{ kind: 'project', projectId, projectName }}
          mode={{ kind: 'edit', principal: editTarget.principal, current: editTarget.current }}
          rbacEnabled={rbacEnabled}
          canManageRoles={canManageRoles}
          inheritedFrom={editTarget.inheritedFrom}
          onDone={invalidateAccess}
        />
      ) : null}

      {/* ── Destructive confirms ──────────────────────────────────────── */}
      <ConfirmDialog
        open={removeMemberTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveMemberTarget(null);
        }}
        {...removeAccessCopy({
          principal: removeMemberTarget ? principalLabel(removeMemberTarget) : '',
          scopeName: projectName,
          inherited: (removeMemberTarget?.group_sources ?? []).map((g) => g.group_name),
        })}
        confirmLabel="Remove"
        confirmVariant="destructive"
        isPending={removeMemberMutation.isPending}
        onConfirm={() => {
          if (!removeMemberTarget) return;
          const target = removeMemberTarget;
          setRemoveMemberTarget(null);
          removeMemberMutation.mutate(target.user_id);
        }}
      />

      <ConfirmDialog
        open={removeGroupTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveGroupTarget(null);
        }}
        {...removeAccessCopy({
          principal: removeGroupTarget
            ? (removeGroupTarget.group_name ?? removeGroupTarget.group_id)
            : '',
          scopeName: projectName,
        })}
        confirmLabel="Detach"
        confirmVariant="destructive"
        isPending={detachGroupMutation.isPending}
        onConfirm={() => {
          if (!removeGroupTarget) return;
          const target = removeGroupTarget;
          setRemoveGroupTarget(null);
          detachGroupMutation.mutate(target.group_id);
        }}
      />

      <ConfirmDialog
        open={revokeInviteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeInviteTarget(null);
        }}
        title="Revoke invitation?"
        description={
          revokeInviteTarget
            ? `The invitation to ${revokeInviteTarget.email} will be cancelled.`
            : ''
        }
        confirmLabel="Revoke"
        confirmVariant="destructive"
        isPending={revokeInviteMutation.isPending}
        onConfirm={() => {
          if (!revokeInviteTarget) return;
          const target = revokeInviteTarget;
          setRevokeInviteTarget(null);
          revokeInviteMutation.mutate(target.invite_id);
        }}
      />
    </AccessDetailShell>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Access rows
// ─────────────────────────────────────────────────────────────────────────

function MemberAccessRow({
  member,
  canManageMembers,
  busy,
  projectAgentCount,
  onEdit,
  onRequestRemove,
}: {
  member: ExtendedProjectAccessMember;
  canManageMembers: boolean;
  busy: boolean;
  projectAgentCount: number | undefined;
  onEdit: (target: EditTarget) => void;
  onRequestRemove: () => void;
}) {
  const label = principalLabel(member) || member.user_id;
  const policy = directProjectPolicy(member.custom_role_policies);

  // Two different roles, on purpose. The row SHOWS what the person can
  // actually do here (`effective_project_role`, whatever path produced it),
  // annotated by the "via …" meta. The dialog EDITS the direct grant, which
  // is what `updateProjectAccess` writes — seeding it with an inherited role
  // would make Save look already-done and lock the admin out of promoting a
  // group-inherited Member to a direct Manager.
  const displayRole: RoleValue = policy
    ? customRole(policy.role_id)
    : member.effective_project_role
      ? builtinRole(member.effective_project_role)
      : ROLE_NONE;
  const editRole: RoleValue = policy
    ? customRole(policy.role_id)
    : member.project_role
      ? builtinRole(member.project_role)
      : ROLE_NONE;
  const roleLabel = policy ? policy.role_name : roleValueLabel('project', displayRole);

  const agentGrants = distinctAgentGrants(agentGrantsOf(member.resource_grants));
  const directAgentIds = agentGrants.filter((g) => g.source !== 'group').map((g) => g.resource_id);
  const expiresAt = policy ? policy.expires_at : (member.expires_at ?? null);
  const via = accessVia(member);
  const inheritedFrom = (member.group_sources ?? []).map((g) => g.group_name);

  const inheritedOnly = isInheritedFromGroupOnly(member);
  const editable = canManageMembers && !member.has_implicit_access && !inheritedOnly;

  const kebab: KebabItem[] = editable
    ? [
        {
          label: 'Edit access',
          icon: <PencilSimpleIcon className="size-3.5" />,
          onSelect: () =>
            onEdit({
              principal: {
                type: 'member',
                id: member.user_id,
                label,
                avatar: <UserAvatar email={member.email ?? ''} size="sm" />,
              },
              current: {
                role: editRole,
                agentIds: directAgentIds.length > 0 ? directAgentIds : 'all',
                expiresAt,
              },
              inheritedFrom,
            }),
        },
        ...(member.project_role
          ? [
              {
                label: 'Remove access',
                icon: <TrashIcon className="size-3.5" />,
                variant: 'destructive' as const,
                separated: true,
                onSelect: onRequestRemove,
              },
            ]
          : []),
      ]
    : [];

  return (
    <AccessRow
      leading={<UserAvatar email={member.email ?? ''} size="sm" />}
      title={label}
      metaParts={
        // A row with NO access has no grant to describe: "Agents: all ·
        // Expires never" reads as "they can reach every agent forever", the
        // exact opposite of the truth. Only "no access" belongs there.
        displayRole.kind === 'none'
          ? [...(via ? [via] : [])]
          : [
              ...(via ? [via] : []),
              agentsMetaPart(agentGrants.length, projectAgentCount),
              <ExpiryMeta key="expires" expiresAt={expiresAt} />,
            ]
      }
      trailing={roleLabel}
      kebab={kebab}
      kebabLabel={`Actions for ${label}`}
      pending={busy}
      notEditable={
        !editable && canManageMembers && (member.has_implicit_access || inheritedOnly)
          ? { hint: member.has_implicit_access ? IMPLICIT_HINT : GROUP_INHERITED_HINT }
          : undefined
      }
    />
  );
}

function GroupAccessRowView({
  group,
  canManageMembers,
  busy,
  projectAgentCount,
  onEdit,
  onRequestRemove,
}: {
  group: GroupAccessRow;
  canManageMembers: boolean;
  busy: boolean;
  projectAgentCount: number | undefined;
  onEdit: (target: EditTarget) => void;
  onRequestRemove: () => void;
}) {
  const label = group.group_name ?? group.group_id;
  const policy = directProjectPolicy(group.custom_role_policies);
  const role: RoleValue = policy
    ? customRole(policy.role_id)
    : group.built_in_role
      ? builtinRole(group.built_in_role)
      : ROLE_NONE;
  const roleLabel = policy ? policy.role_name : roleValueLabel('project', role);

  const agentGrants = distinctAgentGrants(agentGrantsOf(group.resource_grants));
  const agentIds = agentGrants.map((g) => g.resource_id);
  // `group_access` carries no expiry for the built-in grant itself — see the
  // header comment. A custom-role policy's expiry is the only one visible.
  const expiresAt = policy ? policy.expires_at : null;

  const kebab: KebabItem[] = canManageMembers
    ? [
        {
          label: 'Edit access',
          icon: <PencilSimpleIcon className="size-3.5" />,
          onSelect: () =>
            onEdit({
              principal: {
                type: 'group',
                id: group.group_id,
                label,
                avatar: <EntityAvatar icon={UsersIcon} size="sm" />,
              },
              current: {
                role,
                agentIds: agentIds.length > 0 ? agentIds : 'all',
                expiresAt,
              },
            }),
        },
        {
          label: 'Detach group',
          icon: <TrashIcon className="size-3.5" />,
          variant: 'destructive' as const,
          separated: true,
          onSelect: onRequestRemove,
        },
      ]
    : [];

  return (
    <AccessRow
      leading={<EntityAvatar icon={UsersIcon} size="sm" />}
      title={label}
      badges={
        <Badge variant="outline" size="sm">
          Group
        </Badge>
      }
      metaParts={[
        agentsMetaPart(agentGrants.length, projectAgentCount),
        ...(policy ? [<ExpiryMeta key="expires" expiresAt={expiresAt} />] : []),
      ]}
      trailing={roleLabel}
      kebab={kebab}
      kebabLabel={`Actions for ${label}`}
      pending={busy}
    />
  );
}
