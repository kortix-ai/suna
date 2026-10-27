'use client';

import { useLocale, useTranslations } from '@/i18n/use-translations';
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
 * (`packages/ui/src/access/access`) and the account Members table
 * (`features/accounts/hub/member-table.tsx`) for every row, and `AccessDialog` for
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
 * (`apps/api/src/projects/routes/project-access.ts`). The SDK's `ProjectAccessMember` /
 * `ProjectAccessResponse` types do not carry these fields yet, so this file
 * declares its own extension types below rather than editing the SDK's
 * published types out from under a separate change.
 *
 * **One gap in the live contract, worth flagging rather than papering over:**
 * `group_access` entries carry no `expires_at` for the group's own
 * `built_in_role` grant (`project_group_grants.expires_at` exists in the
 * database and on `attachGroupToProject`/`updateProjectGroupGrant`'s params,
 * but `project-access.ts`'s `groupAccessById` builder does not select it onto the
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
import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { isInheritedFromGroupOnly } from '@/components/iam/iam-display-helpers';
import { ProjectAgentAccessList } from '@/components/iam/project-agent-access-list';
import {
  MemberTableHead,
  MemberTableRow,
  ROLE_TONE,
  memberHandle,
  type RoleTone,
} from '@/features/accounts/hub/member-table';
import {
  approveProjectAccessRequest,
  detachGroupFromProject,
  getProject,
  listAgentIdentities,
  listPendingProjectInvites,
  listProjectAccess,
  listProjectAccessRequests,
  listProjectResourceGrants,
  listProjectsForAccount,
  listRoles,
  rejectProjectAccessRequest,
  resendPendingProjectInvite,
  revokePendingProjectInvite,
  revokeProjectAccess,
  type KortixProject,
  type PendingProjectInvite,
  type ProjectAccessMember,
  type ProjectAccessResponse,
} from '@kortix/sdk';
import { contract, invalidatePermissionProbes, qk } from '@kortix/sdk/react';
import { cn } from '@kortix/ui';
import { AccessDialog } from '@kortix/ui/access';
import {
  agentIdentitiesQueryKey,
  agentRolesQueryKey,
  fetchProjectAgentAssignments,
  projectAgentAssignmentsQueryKey,
} from '@kortix/ui/access/access/agent-principals';
import {
  ROLE_NONE,
  builtinRole,
  customRole,
  formatDate,
  formatExpiry,
  pluralize,
  principalLabel,
  removeAccessCopy,
  roleValueLabel,
  type AccessDialogCurrent,
  type AccessDialogPrincipal,
  type KebabItem,
  type RoleValue,
} from '@kortix/ui/access/access/index';
import { Badge } from '@kortix/ui/badge';
import { Button } from '@kortix/ui/button';
import { ConfirmDialog } from '@kortix/ui/confirm-dialog';
import { CountBadge } from '@kortix/ui/count-badge';
import { EmptyState } from '@kortix/ui/empty-state';
import { EntityAvatar } from '@kortix/ui/entity-avatar';
import { ErrorState } from '@kortix/ui/error-state';
import Hint from '@kortix/ui/hint';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@kortix/ui/hover-card';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@kortix/ui/input-group';
import {
  AccountHubSelectionBar,
  useAccountHubSheet,
} from '@kortix/ui/internal/account-hub/hub-sheet';
import { useCopy } from '@kortix/ui/internal/hooks/use-copy';
import { relativeTime } from '@kortix/ui/internal/lib/relative-time';
import { Skeleton } from '@kortix/ui/skeleton';
import { errorToast, successToast, warningToast } from '@kortix/ui/toast';
import { UserAvatar } from '@kortix/ui/user-avatar';
import { PROJECT_ACTIONS, useProjectCan } from '@kortix/ui/workspace';
import {
  ArrowClockwiseIcon,
  CaretLeftIcon,
  CaretRightIcon,
  CheckIcon,
  ClockIcon,
  EnvelopeIcon,
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
/** The shared reader shape for a custom-role policy row. The SDK models
 *  member rows (which carry a `source` attribution) and group rows (whose
 *  policies are the group's own binding, no `source`) separately; these
 *  derivations read both through one relaxed shape. */
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
  /** `project` = granted to everyone in the project, not to this row. */
  source?: 'direct' | 'group' | 'project';
  group_id?: string | null;
  group_name?: string | null;
}

/** A group's access row, as `@kortix/sdk` models it in
 *  `ProjectAccessResponse.group_access`. No `expires_at` here — see this
 *  file's header comment, "One gap in the live contract". */
type GroupAccessRow = NonNullable<ProjectAccessResponse['group_access']>[number];

/** Bounded page for the project picker — see header comment. */
const PROJECT_LIST_PAGE_SIZE = 20;

const IMPLICIT_HINT =
  'Owners and admins always have Manager on every project. To set this directly, change their account role to Member first.';
const GROUP_INHERITED_HINT =
  "Inherited from a group. Change the group's project access to update this.";

// ─── Table chrome ──────────────────────────────────────────────────────────

/** The project list's grid: project · members · updated · caret. The members
 *  column drops below `sm`, as the Members pane drops its email column. */
const PROJECT_GRID =
  'grid grid-cols-[minmax(0,1fr)_6rem_1rem] items-center gap-3 sm:grid-cols-[minmax(0,1fr)_7rem_6rem_1rem]';
const TABLE_HEAD = 'text-muted-foreground truncate text-xs font-medium';

/** Why a role cannot be edited here. A sentence, not a label: a hover card. */
function RoleHint({ children, hint }: { children: ReactNode; hint: string }) {
  return (
    <HoverCard openDelay={200} closeDelay={100}>
      <HoverCardTrigger asChild>
        <span className="flex min-w-0">{children}</span>
      </HoverCardTrigger>
      <HoverCardContent side="top" align="start" className="w-72 p-3 text-sm text-pretty">
        {hint}
      </HoverCardContent>
    </HoverCard>
  );
}

/** Badge tone by rank (`ROLE_TONE`): manager above member, custom neutral. */
function toneOf(role: RoleValue): RoleTone {
  if (role.kind === 'custom') return ROLE_TONE.custom;
  if (role.kind === 'none') return ROLE_TONE.none;
  return role.role === 'member' ? ROLE_TONE.member : ROLE_TONE.manager;
}

/** Which role section a row sits under. A custom role is its own section:
 *  its capabilities are not the admin or member tier's. */
type RoleSection = 'admins' | 'members' | 'custom' | 'none';

/** Display grouping only: which heading a row reads under. No control gates
 *  on it; every write gates on `PROJECT_MEMBERS_MANAGE`. */
function memberSection(member: ProjectAccessMember): RoleSection {
  if (directProjectPolicy(member.custom_role_policies)) return 'custom';
  return sectionOfRole(member.effective_project_role);
}

function groupSection(group: GroupAccessRow): RoleSection {
  if (directProjectPolicy(group.custom_role_policies)) return 'custom';
  return sectionOfRole(group.built_in_role);
}

function sectionOfRole(role: string | null | undefined): RoleSection {
  if (!role) return 'none';
  return role === 'manager' ? 'admins' : 'members';
}

/** The server's `buildGroupAccess` writes the raw role key, not the SDK's
 *  narrower `ProjectRole` union. Narrow honestly: a key this surface does not
 *  know is no role value — it renders as none rather than being coerced. */
function groupBuiltInRole(role: string | null | undefined): RoleValue {
  return role === 'owner' || role === 'admin' || role === 'member' || role === 'manager'
    ? builtinRole(role)
    : ROLE_NONE;
}

// ─── Row derivations (one shape for members and groups) ────────────────────

/** The project-scoped custom-role policy the principal holds DIRECTLY. A
 *  group-sourced policy on a member row is not that member's to edit. */
/** The direct custom-role binding on a row: project-scoped, and not one the
 *  row inherits through a group. Group rows carry their own policies with no
 *  `source` — those are the group's own binding and count as direct there.
 *  Exported for the response pass-through test beside its sibling derivations. */
export function directProjectPolicy(
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
export function distinctAgentGrants(grants: ResourceGrantEntry[]): ResourceGrantEntry[] {
  const byResource = new Map<string, ResourceGrantEntry>();
  for (const grant of grants) {
    const existing = byResource.get(grant.resource_id);
    if (!existing || (!isDirectGrant(existing) && isDirectGrant(grant))) {
      byResource.set(grant.resource_id, grant);
    }
  }
  return [...byResource.values()];
}

/** A grant that names this row itself — not one inherited through a group or
 *  given to everyone in the project. Only these are this row's to edit. */
export function isDirectGrant(grant: Pick<ResourceGrantEntry, 'source'>): boolean {
  return grant.source !== 'group' && grant.source !== 'project';
}

/** "via account admin" / "via Engineering +1 more" / "no access". `null` for
 *  a plain direct grant, which needs no attribution line. */
export function accessVia(
  member: Pick<
    ProjectAccessMember,
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
export function agentsMetaPart(
  granted: number,
  projectAgentCount: number | undefined,
  /** Whether the row holds the manager tier (project admin, or an account
   *  owner/admin). Agents are closed by default: zero grants means "every
   *  agent" for that tier and "no agent" for a member. */
  managerTier = true,
): string {
  if (granted === 0) return managerTier ? 'Agents: all' : 'Agents: none';
  if (projectAgentCount == null) return `Agents: ${granted}`;
  return `Agents: ${granted} of ${projectAgentCount}`;
}

function ExpiryMeta({ expiresAt }: { expiresAt: string | null | undefined }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const expiry = formatExpiry(expiresAt, tI18nComplete);
  if (!expiry.bounded)
    return <span className="tabular-nums">{tI18nComplete.raw('text1342ec89ae42')}</span>;
  return (
    <span className={cn('tabular-nums', expiry.expired ? 'text-kortix-red' : 'text-kortix-yellow')}>
      {tI18nComplete.raw('textf6725f3af08a')} {expiry.label}
    </span>
  );
}

/**
 * The one muted fact under a row's name, or none. In order: how the access
 * arrives when it is inherited ("via account admin", "via Engineering"),
 * then agents when they are narrowed ("Agents: 2 of 5"), then an expiry when
 * there is one. "Agents: all" and "Expires never" are the defaults and say
 * nothing.
 */
function oneFact(
  via: string | null,
  agentCount: number,
  projectAgentCount: number | undefined,
  expiresAt: string | null | undefined,
): ReactNode[] {
  if (via) return [via];
  if (agentCount > 0) return [agentsMetaPart(agentCount, projectAgentCount)];
  if (expiresAt) return [<ExpiryMeta key="expires" expiresAt={expiresAt} />];
  return [];
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
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
    // Latest update first: the project someone just touched leads.
    return [...list].sort((a, b) => +new Date(b.updated_at) - +new Date(a.updated_at));
  }, [projectsQuery.data, search]);

  const visible = filtered.slice(0, visibleCount);
  const hasMore = filtered.length > visible.length;
  const total = projectsQuery.data?.length ?? 0;
  const settled = !projectsQuery.isLoading && !projectsQuery.isError;

  return (
    <div className="space-y-4">
      <div className="space-y-0.5">
        <h1 className="text-foreground text-2xl font-medium tracking-tight text-balance">
          {tI18nComplete.raw('text04e2a9728af7')}
        </h1>
        <p className="text-muted-foreground text-xs">{tI18nComplete.raw('text9949095feb15')}</p>
      </div>

      {/* Search narrows a list. With no projects there is nothing to narrow. */}
      {settled && total > 0 ? (
        <InputGroupSearch>
          <InputGroupSearchIcon>
            <MagnifyingGlassIcon />
          </InputGroupSearchIcon>
          <InputGroupSearchInput
            placeholder={tI18nComplete.raw('text9e079c7df9f1')}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setVisibleCount(PROJECT_LIST_PAGE_SIZE);
            }}
          />
          {search ? <InputGroupSearchClear onClick={() => setSearch('')} /> : null}
        </InputGroupSearch>
      ) : null}

      {projectsQuery.isError ? (
        <ErrorState
          size="sm"
          title={tI18nComplete.raw('text99528001baf3')}
          description={(projectsQuery.error as Error)?.message}
          action={
            <Button variant="outline" size="sm" onClick={() => projectsQuery.refetch()}>
              {tI18nComplete.raw('text942087cc2d41')}
            </Button>
          }
        />
      ) : projectsQuery.isLoading ? (
        <div className="space-y-1">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-11 w-full rounded-md" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          size="sm"
          title={
            search ? tI18nComplete.raw('text2302a8311ddf') : tI18nComplete.raw('textf83c80652286')
          }
        />
      ) : (
        <>
          {/* `-mx-2`: each row pads `2`, so names sit on the search field's edge. */}
          <div role="table" aria-label={tI18nComplete.raw('text04e2a9728af7')} className="-mx-2">
            <div role="row" className={cn(PROJECT_GRID, 'h-9 px-2')}>
              <span role="columnheader" className={TABLE_HEAD}>
                {tI18nComplete.raw('text985959785319')}
              </span>
              <span role="columnheader" className={cn(TABLE_HEAD, 'max-sm:hidden')}>
                {tI18nComplete.raw('text1044a4c056d0')}
              </span>
              <span role="columnheader" aria-sort="descending" className={TABLE_HEAD}>
                {tI18nComplete.raw('text3a5ecca188c0')}
              </span>
            </div>
            <div role="rowgroup">
              {visible.map((project) => (
                <ProjectListRow
                  key={project.project_id}
                  project={project}
                  onSelect={() => onSelectProject(project.project_id)}
                />
              ))}
            </div>
          </div>
          {hasMore ? (
            <div className="flex justify-center pt-1">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setVisibleCount((count) => count + PROJECT_LIST_PAGE_SIZE)}
              >
                {tI18nComplete.raw('textf5c9bd131486')}
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
 *  no count and no dot instead of an error. See header comment. */
function ProjectListRow({ project, onSelect }: { project: KortixProject; onSelect: () => void }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
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
  const locale = useLocale();

  const pendingCount =
    requestsQuery.data?.requests.filter((r) => r.status === 'pending').length ?? 0;

  return (
    <div
      role="row"
      className={cn(PROJECT_GRID, 'group/project hover:bg-hover relative h-11 rounded-lg px-2')}
    >
      {/* The whole row opens the project's access. */}
      <button
        type="button"
        aria-label={project.name}
        onClick={onSelect}
        className="focus-visible:ring-ring absolute inset-0 rounded-[inherit] outline-none focus-visible:ring-1"
      />
      <span role="cell" className="flex min-w-0 items-center gap-3">
        {/* The project's own identity tile, as the project switcher draws it. */}
        <EntityAvatar
          label={project.name}
          glyph={project.icon_glyph}
          emoji={project.icon}
          size="sm"
        />
        <span className="text-foreground min-w-0 truncate text-sm">{project.name}</span>
        {/* Someone waits on a manager here: the one action this pane asks for. */}
        {pendingCount > 0 ? (
          <Badge variant="warning" className="shrink-0 normal-case tabular-nums ring-0">
            {tI18nComplete.raw('textdb0e960b68b5')} · {pendingCount}
          </Badge>
        ) : null}
      </span>
      {/* Unknown (loading, or a project this viewer cannot read) shows nothing. */}
      <span
        role="cell"
        className="text-muted-foreground truncate text-sm tabular-nums max-sm:hidden"
      >
        {memberCount != null ? pluralize(memberCount, 'member') : null}
      </span>
      <span role="cell" className="text-muted-foreground truncate text-sm tabular-nums">
        {relativeTime(project.updated_at, locale)}
      </span>
      <CaretRightIcon aria-hidden className="text-muted-foreground size-3.5 justify-self-end" />
    </div>
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
  /** Back to the project list. */
  onBack: () => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const locale = useLocale();
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

  // `ProjectAgentAccessList` (the "Agents that hold a role here" block below)
  // mounts only once `accessQuery` settles (`settledRows`) AND `canManageRoles`
  // is true — a render gate that is correct (it must not flash the block before
  // its own permission verdict is known) but happens to sit well behind
  // `accessQuery`. Its three reads (agent identities, the account's role list,
  // this project's + the account's service-account assignments) have no data
  // dependency on `accessQuery` at all: they only need `accountId`/`projectId`,
  // both already props here. Firing them now — the instant `canManageRoles`
  // is known, in parallel with `accessQuery` instead of after it — means
  // `ProjectAgentAccessList` finds warm cache the moment it mounts instead of
  // starting three more requests from zero. Same query keys and staleTime as
  // `useAgentIdentities` / `agentRolesQueryKey` / `fetchProjectAgentAssignments`
  // (`agent-principals.ts`), so this is a pure accelerator, never a second
  // fetch under a different slot. Gated on `canManageRoles` (already resolved
  // by the account hub's one batched `:effective:batch` probe) so a non-admin
  // viewer — who will never see this block — never pays for the 403 these
  // routes would otherwise answer.
  useEffect(() => {
    if (!canManageRoles || !accountId || !projectId) return;
    void queryClient.prefetchQuery({
      queryKey: agentIdentitiesQueryKey(accountId),
      queryFn: () => listAgentIdentities(accountId),
      staleTime: 60_000,
    });
    void queryClient.prefetchQuery({
      queryKey: agentRolesQueryKey(accountId),
      queryFn: () => listRoles(accountId),
      staleTime: 30_000,
    });
    void queryClient.prefetchQuery({
      queryKey: projectAgentAssignmentsQueryKey(accountId, projectId),
      queryFn: () => fetchProjectAgentAssignments(accountId, projectId),
      staleTime: 30_000,
    });
  }, [canManageRoles, accountId, projectId, queryClient]);

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
  const [removeMemberTarget, setRemoveMemberTarget] = useState<ProjectAccessMember | null>(null);
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
      successToast(tI18nComplete.raw('textabb84f9edc9e'));
      invalidateAccess();
    },
    onError: (error: Error) => errorToast(error.message || tI18nComplete.raw('textd3237eaf77bb')),
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
      successToast(tI18nComplete.raw('text5fceeb638441'));
      invalidateAccess();
    },
    onError: (error: Error) => errorToast(error.message || tI18nComplete.raw('texteabb0261292e')),
  });

  // ── Pending invites ───────────────────────────────────────────────────
  const [pendingInviteBusyIds, setPendingInviteBusyIds] = useState<Set<string>>(() => new Set());
  const markInvitePending = (id: string) =>
    setPendingInviteBusyIds((prev) => new Set(prev).add(id));
  const clearInvitePending = (id: string) =>
    setPendingInviteBusyIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  const [revokeInviteTarget, setRevokeInviteTarget] = useState<PendingProjectInvite | null>(null);

  const { copy } = useCopy({
    successMessage: tI18nComplete.raw('textbd769dab6c4d'),
    errorMessage: tI18nComplete.raw('textfa46ef7689ff'),
  });

  const resendInviteMutation = useMutation({
    mutationFn: (inviteId: string) => resendPendingProjectInvite(projectId, inviteId),
    onMutate: (inviteId) => markInvitePending(inviteId),
    onSettled: (_data, _error, inviteId) => clearInvitePending(inviteId),
    onSuccess: (result) => {
      if (result.email_sent) {
        successToast(tI18nComplete.raw('text7e4f3f8089ab'));
      } else {
        warningToast(tI18nComplete.raw('text370145ffb7ba'), {
          duration: 8_000,
          actions: [
            {
              label: tI18nComplete.raw('text9adff6870471'),
              onClick: () => copy(result.invite_url),
            },
          ],
        });
      }
      queryClient.invalidateQueries({ queryKey: qk.project.pendingInvites(projectId) });
    },
    onError: (error: Error) => errorToast(error.message || tI18nComplete.raw('text82750487a958')),
  });

  const revokeInviteMutation = useMutation({
    mutationFn: (inviteId: string) => revokePendingProjectInvite(projectId, inviteId),
    onMutate: (inviteId) => markInvitePending(inviteId),
    onSettled: (_data, _error, inviteId) => clearInvitePending(inviteId),
    onSuccess: (result) => {
      successToast(
        result.invitation_cancelled
          ? tI18nComplete.raw('text134517d2e8c8')
          : tI18nComplete.raw('textf05cb00433b9'),
      );
      queryClient.invalidateQueries({ queryKey: qk.project.pendingInvites(projectId) });
    },
    onError: (error: Error) => errorToast(error.message || tI18nComplete.raw('text9dbd2a60139d')),
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
      successToast(
        tI18nComplete('text975f39d61b4d', {
          value0: result.member.email ?? tI18nComplete.raw('textb5687cf04af3'),
        }),
      );
      queryClient.invalidateQueries({ queryKey: qk.project.accessRequests(projectId) });
      invalidateAccess();
    },
    onError: (error: Error) => errorToast(error.message || tI18nComplete.raw('textc97583fe9025')),
  });

  const rejectRequestMutation = useMutation({
    mutationFn: (requestId: string) => rejectProjectAccessRequest(projectId, requestId),
    onMutate: (requestId) => markRequestBusy(requestId),
    onSettled: (_data, _error, requestId) => clearRequestBusy(requestId),
    onSuccess: () => {
      successToast(tI18nComplete.raw('text64e855d33cce'));
      queryClient.invalidateQueries({ queryKey: qk.project.accessRequests(projectId) });
    },
    onError: (error: Error) => errorToast(error.message || tI18nComplete.raw('text48010f4355d7')),
  });

  // Bulk decisions: tick rows, then Approve or Decline them all at once.
  const [selectedRequestIds, setSelectedRequestIds] = useState<Set<string>>(() => new Set());
  const [bulkDeciding, setBulkDeciding] = useState(false);

  async function decideSelected(approve: boolean) {
    // Only rows still listed: a request decided elsewhere drops out.
    const chosen = accessRequests.filter((request) => selectedRequestIds.has(request.request_id));
    const ids = chosen.map((request) => request.request_id);
    if (ids.length === 0) return;
    setBulkDeciding(true);
    ids.forEach(markRequestBusy);
    const results = await Promise.allSettled(
      ids.map((id) =>
        approve
          ? approveProjectAccessRequest(projectId, id, 'member')
          : rejectProjectAccessRequest(projectId, id),
      ),
    );
    ids.forEach(clearRequestBusy);
    setBulkDeciding(false);
    setSelectedRequestIds(new Set());
    queryClient.invalidateQueries({ queryKey: qk.project.accessRequests(projectId) });
    if (approve) invalidateAccess();

    const failed = results.filter((result) => result.status === 'rejected').length;
    if (failed < ids.length) {
      if (approve) {
        const emails = chosen
          .filter((_request, index) => results[index]?.status === 'fulfilled')
          .map((request) => request.requester_email);
        successToast(tI18nComplete('text975f39d61b4d', { value0: emails.join(', ') }));
      } else {
        successToast(tI18nComplete.raw('text64e855d33cce'));
      }
    }
    if (failed > 0) {
      errorToast(tI18nComplete.raw(approve ? 'textc97583fe9025' : 'text48010f4355d7'));
    }
  }

  // ── Grant / edit dialogs ──────────────────────────────────────────────
  // Grant access opens beside the list in the hub's split sheet: the pane
  // narrows instead of a modal covering it. The sheet draws the title; the
  // form draws its fields and a sticky footer.
  const sheet = useAccountHubSheet();
  function openGrant() {
    sheet.open({
      title: tI18nComplete.raw('text8693768c7e08'),
      description: projectName,
      body: (
        <AccessDialog
          open
          onOpenChange={(next) => {
            if (!next) sheet.close();
          }}
          accountId={accountId}
          scope={{ kind: 'project', projectId, projectName }}
          mode={{ kind: 'grant' }}
          rbacEnabled={rbacEnabled}
          canManageRoles={canManageRoles}
          onDone={invalidateAccess}
        />
      ),
    });
  }

  // Edit access opens in the same split sheet as Grant access, keyed by the
  // principal so a second row's edit replaces the first instead of reusing it.
  function openEdit(target: EditTarget) {
    sheet.open({
      title: tI18nComplete.raw('texta514a684676a'),
      description: target.principal.label,
      body: (
        <AccessDialog
          key={`${target.principal.type}:${target.principal.id}`}
          open
          onOpenChange={(next) => {
            if (!next) sheet.close();
          }}
          accountId={accountId}
          scope={{ kind: 'project', projectId, projectName }}
          mode={{ kind: 'edit', principal: target.principal, current: target.current }}
          rbacEnabled={rbacEnabled}
          canManageRoles={canManageRoles}
          inheritedFrom={target.inheritedFrom}
          onDone={invalidateAccess}
        />
      ),
    });
  }

  const members = accessQuery.data?.members ?? [];
  const groups = accessQuery.data?.group_access ?? [];

  const pendingInvites = pendingInvitesQuery.data?.pending ?? [];
  const accessRequests = accessRequestsQuery.data?.requests ?? [];
  const selectedRequests = accessRequests.filter((request) =>
    selectedRequestIds.has(request.request_id),
  );
  const allRequestsSelected =
    accessRequests.length > 0 && selectedRequests.length === accessRequests.length;
  const showAccessRequests =
    canManageMembers && (accessRequestsQuery.isLoading || accessRequests.length > 0);

  const settledRows = !accessQuery.isLoading && !accessQuery.isError;

  // People without project access are account members the access route lists
  // with no role. They are not "access": they get their own quiet group below,
  // with no "—" and no "no access" meta on every row.
  // Rows grouped by role (Paper variant 08): admins, members, custom roles,
  // then account members with no access here. People first, then groups,
  // inside each section.
  const sectionRows = (section: RoleSection) => ({
    members: members.filter((member) => memberSection(member) === section),
    groups: groups.filter((group) => groupSection(group) === section),
  });
  const roleSections: RoleSection[] = ['admins', 'members', 'custom'];
  const withoutAccess = sectionRows('none').members;
  const hasAnyAccess = members.length - withoutAccess.length + groups.length > 0;

  const grantButton = canManageMembers ? (
    <Button type="button" size="sm" onClick={openGrant} className="gap-1.5">
      <PlusIcon className="size-3.5" />
      {tI18nComplete.raw('text8693768c7e08')}
    </Button>
  ) : null;

  return (
    <div className="space-y-6 pb-10">
      {/* "‹ Projects" above the project's tile: the same link the member and
          group pages draw (`AccessDetailShell`). The breadcrumb stays too. */}
      <div className="space-y-4">
        <button
          type="button"
          onClick={onBack}
          className="text-muted-foreground hover:text-foreground flex w-fit items-center gap-1 text-sm transition-colors"
        >
          <CaretLeftIcon className="size-4" />
          {tI18nComplete.raw('text04e2a9728af7')}
        </button>
        <div className="flex min-w-0 items-center gap-3">
          {projectQuery.isLoading ? (
            <Skeleton className="size-8 rounded-md" />
          ) : (
            <EntityAvatar
              label={project?.name}
              glyph={project?.icon_glyph}
              emoji={project?.icon}
              size="md"
            />
          )}
          <div className="min-w-0 flex-1">
            {projectQuery.isLoading ? (
              <Skeleton className="h-6 w-44" />
            ) : (
              <h2 className="text-foreground truncate text-xl font-medium">
                {project?.name ?? '…'}
              </h2>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button asChild type="button" variant="ghost" size="sm">
              <Link href={`/projects/${projectId}`}>{tI18nComplete.raw('text5e5eba7f41ab')}</Link>
            </Button>
            {grantButton}
          </div>
        </div>
      </div>

      {/* ── People: one table, the account Members table's rows ──────────
          Order: who asked to join, then managers, members, custom roles,
          invites, and last the account members with no access here. */}
      {accessQuery.isLoading || (showAccessRequests && accessRequestsQuery.isLoading) ? (
        <div className="space-y-1">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-11 w-full rounded-md" />
          ))}
        </div>
      ) : accessQuery.isError ? (
        <ErrorState
          size="sm"
          title={tI18nComplete.raw('textff42d4eadd12')}
          description={(accessQuery.error as Error)?.message}
          action={
            <Button variant="outline" size="sm" onClick={() => accessQuery.refetch()}>
              {tI18nComplete.raw('text942087cc2d41')}
            </Button>
          }
        />
      ) : !hasAnyAccess && accessRequests.length === 0 && pendingInvites.length === 0 ? (
        <EmptyState
          size="sm"
          title={tI18nComplete.raw('text6a50fe407b62')}
          description={tI18nComplete.raw('text14d959607774')}
        />
      ) : (
        <>
          {/* ── Asked to join: its own table, above everyone else ──────────
              The Members table's rows, so name and email read the same. Each
              row waits on a manager: a "waiting" count, green Approve and red
              Decline per row, and both again for every ticked row. */}
          {accessRequests.length > 0 ? (
            <section className="space-y-1">
              <div className="flex min-h-8 items-center gap-2">
                <h3 className="text-foreground text-sm font-medium">
                  {tI18nComplete.raw('textf810ceed99d6')}
                </h3>
                <CountBadge count={accessRequests.length} tone="waiting" />
              </div>
              {/* `-ml-9`: the select gutter hangs outside the content edge. */}
              <div
                role="table"
                aria-label={tI18nComplete.raw('textf810ceed99d6')}
                className="-ml-2 sm:-ml-9"
              >
                <MemberTableHead
                  roleHeader={<span aria-hidden />}
                  select={{
                    visible: selectedRequests.length > 0,
                    checked: allRequestsSelected
                      ? true
                      : selectedRequests.length > 0
                        ? 'indeterminate'
                        : false,
                    onCheckedChange: () =>
                      setSelectedRequestIds(
                        allRequestsSelected
                          ? new Set()
                          : new Set(accessRequests.map((request) => request.request_id)),
                      ),
                    label: allRequestsSelected
                      ? tI18nComplete.raw('text967549497036')
                      : tI18nComplete.raw('text1fc9a387654d'),
                  }}
                />
                <div role="rowgroup">
                  {accessRequests.map((request) => {
                    const busy = accessRequestBusyIds.has(request.request_id);
                    const checked = selectedRequestIds.has(request.request_id);
                    const age = (
                      <span className="text-muted-foreground text-xs tabular-nums">
                        {relativeTime(request.created_at, locale)}
                      </span>
                    );
                    return (
                      <MemberTableRow
                        key={request.request_id}
                        selected={checked}
                        select={{
                          visible: selectedRequests.length > 0,
                          checked,
                          onCheckedChange: () =>
                            setSelectedRequestIds((prev) => {
                              const next = new Set(prev);
                              if (next.has(request.request_id)) next.delete(request.request_id);
                              else next.add(request.request_id);
                              return next;
                            }),
                          label: request.requester_email,
                        }}
                        avatar={<UserAvatar email={request.requester_email} size="sm" />}
                        name={memberHandle(request.requester_email, request.requester_email)}
                        email={request.requester_email}
                        // When they asked; their note, if any, on hover.
                        tags={
                          request.message ? <Hint label={`“${request.message}”`}>{age}</Hint> : age
                        }
                        role={null}
                        roleCell={
                          <span className="flex items-center gap-1.5">
                            <Button
                              type="button"
                              size="xs"
                              variant="success"
                              disabled={busy}
                              onClick={() => approveRequestMutation.mutate(request.request_id)}
                              className="gap-1"
                            >
                              <CheckIcon className="size-3.5" />
                              {tI18nComplete.raw('text6007acbe30b2')}
                            </Button>
                            <Button
                              type="button"
                              size="xs"
                              variant="error"
                              disabled={busy}
                              onClick={() => rejectRequestMutation.mutate(request.request_id)}
                              className="gap-1"
                            >
                              <XIcon className="size-3.5" />
                              {tI18nComplete.raw('texta2d285b35287')}
                            </Button>
                          </span>
                        }
                        pending={busy}
                        kebabLabel={request.requester_email}
                      />
                    );
                  })}
                </div>
              </div>
            </section>
          ) : null}

          {/* Bulk decisions: the shared selection bar, pinned to the bottom. */}
          {selectedRequests.length > 0 ? (
            <AccountHubSelectionBar
              selectedCount={selectedRequests.length}
              allSelected={allRequestsSelected}
              onSelectAll={() =>
                setSelectedRequestIds(new Set(accessRequests.map((request) => request.request_id)))
              }
              onClear={() => setSelectedRequestIds(new Set())}
              onExit={() => setSelectedRequestIds(new Set())}
              actions={[
                {
                  id: 'approve',
                  label: tI18nComplete.raw('text6007acbe30b2'),
                  tone: 'success',
                  disabled: bulkDeciding,
                  onSelect: () => void decideSelected(true),
                },
                {
                  id: 'decline',
                  label: tI18nComplete.raw('texta2d285b35287'),
                  tone: 'destructive',
                  disabled: bulkDeciding,
                  onSelect: () => void decideSelected(false),
                },
              ]}
            />
          ) : null}

          {/* `-ml-9`: the empty select gutter hangs outside the content edge, as
            on the Members pane, so avatars line up with the header above. */}
          <div role="table" aria-label={projectName} className="-ml-2 sm:-ml-9">
            <MemberTableHead />
            <div role="rowgroup">
              {roleSections.flatMap((key) => {
                const rows = sectionRows(key);
                return [
                  ...rows.members.map((member) => (
                    <MemberAccessRow
                      key={`member:${member.user_id}`}
                      member={member}
                      canManageMembers={canManageMembers}
                      busy={pendingUserIds.has(member.user_id)}
                      projectAgentCount={projectAgentCount}
                      onEdit={openEdit}
                      onRequestRemove={() => setRemoveMemberTarget(member)}
                    />
                  )),
                  ...rows.groups.map((group) => (
                    <GroupAccessRowView
                      key={`group:${group.group_id}`}
                      group={group}
                      canManageMembers={canManageMembers}
                      busy={pendingGroupIds.has(group.group_id)}
                      projectAgentCount={projectAgentCount}
                      onEdit={openEdit}
                      onRequestRemove={() => setRemoveGroupTarget(group)}
                    />
                  )),
                ];
              })}
              {canManageMembers
                ? pendingInvites.map((invite) => {
                    const busy = pendingInviteBusyIds.has(invite.invite_id);
                    return (
                      <MemberTableRow
                        key={`invite:${invite.invite_id}`}
                        invited
                        // Avatar v2's invited state: a dashed empty circle.
                        avatar={
                          <span
                            aria-hidden
                            className="text-muted-foreground flex size-6 shrink-0 items-center justify-center rounded-full border border-dashed"
                          >
                            <EnvelopeIcon className="size-3" />
                          </span>
                        }
                        name={memberHandle(invite.email, invite.email)}
                        email={invite.email}
                        tags={
                          <Hint
                            label={
                              invite.invite_expired
                                ? tI18nComplete.raw('texte61180e0dd8a')
                                : `${tI18nComplete.raw('textf6725f3af08a')} ${formatDate(invite.invite_expires_at)}`
                            }
                          >
                            <ClockIcon
                              aria-hidden
                              className={cn(
                                'size-3.5',
                                invite.invite_expired
                                  ? 'text-kortix-orange'
                                  : 'text-muted-foreground',
                              )}
                            />
                          </Hint>
                        }
                        role={`${roleValueLabel('project', builtinRole(invite.project_role), undefined, tI18nComplete)} (${tI18nComplete.raw('text63b17becd812')})`}
                        pending={busy}
                        kebabLabel={tI18nComplete('text33da220b1a34', { value0: invite.email })}
                        kebab={
                          busy
                            ? []
                            : [
                                {
                                  label: tI18nComplete.raw('text1f94843777ae'),
                                  icon: <ArrowClockwiseIcon className="size-3.5" />,
                                  onSelect: () => resendInviteMutation.mutate(invite.invite_id),
                                },
                                {
                                  label: tI18nComplete.raw('text87e6d00bbf53'),
                                  icon: <XIcon className="size-3.5" />,
                                  variant: 'destructive' as const,
                                  separated: true,
                                  onSelect: () => setRevokeInviteTarget(invite),
                                },
                              ]
                        }
                      />
                    );
                  })
                : null}
              {withoutAccess.map((member) => (
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
            </div>
          </div>
        </>
      )}

      {/* ── Agents that hold a role here (their ceiling) ─────────────────── */}
      {canManageRoles && settledRows ? (
        <ProjectAgentAccessList
          accountId={accountId}
          projectId={projectId}
          projectName={projectName}
          rbacEnabled={rbacEnabled}
        />
      ) : null}

      {/* ── Destructive confirms ──────────────────────────────────────── */}
      <ConfirmDialog
        open={removeMemberTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveMemberTarget(null);
        }}
        {...removeAccessCopy(
          {
            principal: removeMemberTarget ? principalLabel(removeMemberTarget) : '',
            scopeName: projectName,
            inherited: (removeMemberTarget?.group_sources ?? []).map((g) => g.group_name),
          },
          tI18nComplete,
        )}
        confirmLabel={tI18nComplete.raw('textc3812fc4acb8')}
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
        {...removeAccessCopy(
          {
            principal: removeGroupTarget
              ? (removeGroupTarget.group_name ?? removeGroupTarget.group_id)
              : '',
            scopeName: projectName,
          },
          tI18nComplete,
        )}
        confirmLabel={tI18nComplete.raw('text74bc11743543')}
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
        title={tI18nComplete.raw('text25f372c4eb6c')}
        description={
          revokeInviteTarget
            ? tI18nComplete('text4535911857d7', { value0: revokeInviteTarget.email })
            : ''
        }
        confirmLabel={tI18nComplete.raw('text87e6d00bbf53')}
        confirmVariant="destructive"
        isPending={revokeInviteMutation.isPending}
        onConfirm={() => {
          if (!revokeInviteTarget) return;
          const target = revokeInviteTarget;
          setRevokeInviteTarget(null);
          revokeInviteMutation.mutate(target.invite_id);
        }}
      />
    </div>
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
  member: ProjectAccessMember;
  canManageMembers: boolean;
  busy: boolean;
  projectAgentCount: number | undefined;
  onEdit: (target: EditTarget) => void;
  onRequestRemove: () => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
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
  const roleLabel = policy
    ? policy.role_name
    : roleValueLabel('project', displayRole, undefined, tI18nComplete);
  // An account owner or admin manages every project: their account role is
  // the badge, in its own colour, above every project role.
  const accountRank =
    member.has_implicit_access &&
    (member.account_role === 'owner' || member.account_role === 'admin')
      ? member.account_role
      : null;
  const badgeLabel = accountRank
    ? tI18nComplete.raw(accountRank === 'owner' ? 'text4b1b8aa3608a' : 'textc1c224b03cd9')
    : roleLabel;
  const tone = accountRank ? ROLE_TONE[accountRank] : toneOf(displayRole);

  const agentGrants = distinctAgentGrants(agentGrantsOf(member.resource_grants));
  const directAgentIds = agentGrants.filter(isDirectGrant).map((g) => g.resource_id);
  const expiresAt = policy ? policy.expires_at : (member.expires_at ?? null);
  const via = accessVia(member);
  const inheritedFrom = (member.group_sources ?? []).map((g) => g.group_name);

  const inheritedOnly = isInheritedFromGroupOnly(member);
  const editable = canManageMembers && !member.has_implicit_access && !inheritedOnly;

  const kebab: KebabItem[] = editable
    ? [
        {
          // Someone with no access has nothing to edit: the same dialog grants.
          label:
            displayRole.kind === 'none'
              ? tI18nComplete.raw('text8693768c7e08')
              : tI18nComplete.raw('texta514a684676a'),
          icon:
            displayRole.kind === 'none' ? (
              <PlusIcon className="size-3.5" />
            ) : (
              <PencilSimpleIcon className="size-3.5" />
            ),
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
                label: tI18nComplete.raw('textbb349bfe6750'),
                icon: <TrashIcon className="size-3.5" />,
                variant: 'destructive' as const,
                separated: true,
                onSelect: onRequestRemove,
              },
            ]
          : []),
      ]
    : [];

  const fact =
    displayRole.kind === 'none'
      ? []
      : oneFact(via, agentGrants.length, projectAgentCount, expiresAt);
  const hint =
    !editable && canManageMembers && (member.has_implicit_access || inheritedOnly)
      ? member.has_implicit_access
        ? IMPLICIT_HINT
        : GROUP_INHERITED_HINT
      : undefined;

  return (
    <MemberTableRow
      avatar={<UserAvatar email={member.email ?? ''} size="sm" />}
      name={memberHandle(member.email, label)}
      email={member.email ?? label}
      // At most one short fact beside the name. A row with no access has
      // none: its "No access" badge already says it.
      tags={
        fact.length > 0 ? <span className="text-muted-foreground text-xs">{fact[0]}</span> : null
      }
      role={displayRole.kind === 'none' ? tI18nComplete.raw('text9b1f0823459d') : badgeLabel}
      roleCell={
        hint ? (
          <RoleHint hint={hint}>
            <Badge variant={tone} className="max-w-full truncate normal-case ring-0">
              {badgeLabel}
            </Badge>
          </RoleHint>
        ) : undefined
      }
      roleTone={tone}
      kebab={kebab}
      kebabLabel={tI18nComplete('text33da220b1a34', { value0: label })}
      pending={busy}
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const label = group.group_name ?? group.group_id;
  const policy = directProjectPolicy(group.custom_role_policies);
  const role: RoleValue = policy
    ? customRole(policy.role_id)
    : group.built_in_role
      ? groupBuiltInRole(group.built_in_role)
      : ROLE_NONE;
  const roleLabel = policy
    ? policy.role_name
    : roleValueLabel('project', role, undefined, tI18nComplete);

  const agentGrants = distinctAgentGrants(agentGrantsOf(group.resource_grants));
  const agentIds = agentGrants.map((g) => g.resource_id);
  // `group_access` carries no expiry for the built-in grant itself — see the
  // header comment. A custom-role policy's expiry is the only one visible.
  const expiresAt = policy ? policy.expires_at : null;

  const kebab: KebabItem[] = canManageMembers
    ? [
        {
          label: tI18nComplete.raw('texta514a684676a'),
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
          label: tI18nComplete.raw('text623b0cedf094'),
          icon: <TrashIcon className="size-3.5" />,
          variant: 'destructive' as const,
          separated: true,
          onSelect: onRequestRemove,
        },
      ]
    : [];

  const fact = oneFact(null, agentGrants.length, projectAgentCount, expiresAt);

  return (
    // Kind reads from the avatar (the group glyph) and the email column.
    <MemberTableRow
      avatar={<EntityAvatar icon={UsersIcon} size="sm" />}
      name={label}
      email={tI18nComplete.raw('text34ca0e766088')}
      tags={
        fact.length > 0 ? <span className="text-muted-foreground text-xs">{fact[0]}</span> : null
      }
      role={roleLabel}
      roleTone={toneOf(role)}
      kebab={kebab}
      kebabLabel={tI18nComplete('text33da220b1a34', { value0: label })}
      pending={busy}
    />
  );
}
