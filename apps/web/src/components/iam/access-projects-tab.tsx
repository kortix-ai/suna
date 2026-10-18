'use client';

import { useTranslations } from '@/i18n/use-translations';
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
 * (`features/workspace/shared/access`): `AccessRow` for every list row (flattened
 * to a Linear list row by `FLAT_ROW_CLASS`), and `AccessDialog` for
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
import { useAccountHubSheet } from '@/features/accounts/hub/hub-sheet';
import { ProjectAgentAccessList } from '@/components/iam/project-agent-access-list';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import Hint from '@/components/ui/hint';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
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
  AccessDialog,
  AccessRow,
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
} from '@/features/workspace/shared/access';
import { useCopy } from '@/hooks/use-copy';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { cn } from '@/lib/utils';
import {
  agentIdentitiesQueryKey,
  agentRolesQueryKey,
  fetchProjectAgentAssignments,
  projectAgentAssignmentsQueryKey,
} from '@/features/workspace/shared/access/agent-principals';
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
import {
  ArrowClockwiseIcon,
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

// ─── Linear list chrome ────────────────────────────────────────────────────

/** A Linear list row: flat on the page, a hover fill, no border or card.
 *  Overrides `AccessRow`'s card dialect through its `className`. */
const FLAT_ROW_CLASS =
  'hover:bg-hover min-h-11 gap-2.5 rounded-md border-0 bg-transparent px-3 py-1';

/** The role column: one fixed width, right-aligned, so every row's role and
 *  the kebab slot after it sit on the same two lanes. */
function RoleLabel({ children, hint }: { children: ReactNode; hint?: string }) {
  const label = <span className="inline-block w-28 truncate text-right">{children}</span>;
  if (!hint) return label;
  // A sentence of explanation, not a label: a hover card, not a tooltip.
  return (
    <HoverCard openDelay={200} closeDelay={100}>
      <HoverCardTrigger asChild>
        <span>{label}</span>
      </HoverCardTrigger>
      <HoverCardContent side="top" align="end" className="w-72 p-3 text-sm text-pretty">
        {hint}
      </HoverCardContent>
    </HoverCard>
  );
}

/** The rows' list. `-mx-2` lines each row's content up with the text above,
 *  while its hover fill bleeds into the gutter. */
function FlatList({ children }: { children: ReactNode }) {
  return <ul className="-mx-2 flex flex-col gap-px">{children}</ul>;
}

/** A labelled group of flat rows: a muted label, then the list. No count,
 *  no second description: the label says it. */
function FlatSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      {/* `px-1`: the list's `-mx-2` plus each row's `px-3` puts the avatar one
          step in from this edge; the label sits on that same line. */}
      <h3 className="text-muted-foreground px-1 text-xs font-medium">{title}</h3>
      <FlatList>{children}</FlatList>
    </section>
  );
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
    return [...list].sort((a, b) => a.name.localeCompare(b.name));
  }, [projectsQuery.data, search]);

  const visible = filtered.slice(0, visibleCount);
  const hasMore = filtered.length > visible.length;
  const total = projectsQuery.data?.length ?? 0;
  const settled = !projectsQuery.isLoading && !projectsQuery.isError;

  return (
    <div className="space-y-4">
      <div className="space-y-0.5">
        <p className="text-foreground text-sm font-medium">{tI18nComplete.raw('text04e2a9728af7')}</p>
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
          <FlatList>
            {visible.map((project) => (
              <ProjectListRow
                key={project.project_id}
                project={project}
                onSelect={() => onSelectProject(project.project_id)}
              />
            ))}
          </FlatList>
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
  const hasPendingRequests =
    (requestsQuery.data?.requests.filter((r) => r.status === 'pending').length ?? 0) > 0;

  return (
    <AccessRow
      className={FLAT_ROW_CLASS}
      // The project's own identity tile, as the project switcher draws it.
      leading={
        <EntityAvatar
          label={project.name}
          glyph={project.icon_glyph}
          emoji={project.icon}
          size="sm"
        />
      }
      title={project.name}
      badges={
        hasPendingRequests ? (
          <Hint label={tI18nComplete.raw('text5363a9cf88d5')} side="top">
            <span
              className="bg-kortix-red inline-block size-1.5 shrink-0 rounded-full"
              aria-label={tI18nComplete.raw('text91de1d3518d8')}
            />
          </Hint>
        ) : null
      }
      // The member count is a quiet trailing fact. Unknown (loading, or a
      // project this viewer cannot read) shows nothing, not "—".
      trailing={
        memberCount != null ? (
          <span className="tabular-nums">{pluralize(memberCount, 'member')}</span>
        ) : undefined
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
}: {
  accountId: string;
  projectId: string;
  rbacEnabled: boolean;
  canManageRoles: boolean;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
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
  const [removeMemberTarget, setRemoveMemberTarget] = useState<ProjectAccessMember | null>(
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
            { label: tI18nComplete.raw('text9adff6870471'), onClick: () => copy(result.invite_url) },
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
          presentation="split-sheet"
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
          presentation="split-sheet"
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
  const showPendingInvites =
    canManageMembers && (pendingInvitesQuery.isLoading || pendingInvites.length > 0);
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
  const roleSections: { key: RoleSection; title: string }[] = [
    { key: 'admins', title: tI18nComplete.raw('text926597a39cb3') },
    { key: 'members', title: tI18nComplete.raw('text1044a4c056d0') },
    { key: 'custom', title: tI18nComplete.raw('textc703c7f9cbe6') },
  ];
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
      {/* No back button: the hub's breadcrumb (Settings / account / Projects /
          this project) is the way back. */}
      <div className="space-y-4">
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
              <h2 className="text-foreground truncate text-xl font-medium">{project?.name ?? '…'}</h2>
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

      {/* ── Asked to join ─────────────────────────────────────────────── */}
      {showAccessRequests ? (
        accessRequestsQuery.isLoading ? (
          <Skeleton className="h-11 w-full rounded-md" />
        ) : (
          <FlatSection title={tI18nComplete.raw('textf810ceed99d6')}>
            {accessRequests.map((request) => {
              const busy = accessRequestBusyIds.has(request.request_id);
              return (
                <AccessRow
                  key={request.request_id}
                  className={FLAT_ROW_CLASS}
                  leading={<UserAvatar email={request.requester_email} size="sm" />}
                  title={request.requester_email}
                  metaParts={[
                    <span key="requested" className="tabular-nums">
                      {tI18nComplete.raw('text2d9e28289fac')} {formatDate(request.created_at)}
                    </span>,
                    ...(request.message
                      ? [
                          <span key="message">
                            {tI18nComplete.raw('text497558230027')}
                            {request.message}
                            {tI18nComplete.raw('text497558230027')}
                          </span>,
                        ]
                      : []),
                  ]}
                  pending={busy}
                  actions={
                    busy ? undefined : (
                      <>
                        <Button
                          type="button"
                          size="xs"
                          variant="secondary"
                          onClick={() => approveRequestMutation.mutate(request.request_id)}
                          className="gap-1"
                        >
                          <CheckIcon className="size-3.5" />
                          {tI18nComplete.raw('text6007acbe30b2')}
                        </Button>
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          onClick={() => rejectRequestMutation.mutate(request.request_id)}
                          className="gap-1"
                        >
                          <XIcon className="size-3.5" />
                          {tI18nComplete.raw('texta2d285b35287')}
                        </Button>
                      </>
                    )
                  }
                />
              );
            })}
          </FlatSection>
        )
      ) : null}

      {/* ── Access ────────────────────────────────────────────────────── */}
      {accessQuery.isLoading ? (
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
      ) : !hasAnyAccess ? (
        <EmptyState
          size="sm"
          title={tI18nComplete.raw('text6a50fe407b62')}
          description={tI18nComplete.raw('text14d959607774')}
        />
      ) : (
        roleSections.map(({ key, title }) => {
          const rows = sectionRows(key);
          if (rows.members.length + rows.groups.length === 0) return null;
          return (
            <FlatSection key={key} title={title}>
              {rows.members.map((member) => (
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
              {rows.groups.map((group) => (
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
            </FlatSection>
          );
        })
      )}

      {/* ── Invited to this project ───────────────────────────────────── */}
      {showPendingInvites ? (
        pendingInvitesQuery.isLoading ? (
          <Skeleton className="h-11 w-full rounded-md" />
        ) : (
          <FlatSection title={tI18nComplete.raw('texteaca91e7a784')}>
            {pendingInvites.map((invite) => {
              const busy = pendingInviteBusyIds.has(invite.invite_id);
              return (
                <AccessRow
                  key={invite.invite_id}
                  className={FLAT_ROW_CLASS}
                  // Avatar v2's invited state: a dashed empty circle.
                  leading={
                    <span className="text-muted-foreground inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-dashed">
                      <EnvelopeIcon className="size-3" />
                    </span>
                  }
                  title={invite.email}
                  metaParts={[
                    <span key="invited" className="tabular-nums">
                      {tI18nComplete.raw('text63b17becd812')} {formatDate(invite.created_at)}
                    </span>,
                    invite.invite_expired ? (
                      <span key="expiry" className="text-kortix-orange">
                        {tI18nComplete.raw('texte61180e0dd8a')}
                      </span>
                    ) : (
                      <span key="expiry" className="inline-flex items-center gap-1 tabular-nums">
                        <ClockIcon className="size-3" />
                        {tI18nComplete.raw('textf6725f3af08a')}{' '}
                        {formatDate(invite.invite_expires_at)}
                      </span>
                    ),
                  ]}
                  trailing={
                    <RoleLabel>
                      <span className="capitalize">{invite.project_role}</span>
                    </RoleLabel>
                  }
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
            })}
          </FlatSection>
        )
      ) : null}

      {/* ── Account members with no access here ───────────────────────── */}
      {settledRows && withoutAccess.length > 0 ? (
        <FlatSection title={tI18nComplete.raw('text9b1f0823459d')}>
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
        </FlatSection>
      ) : null}

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

  return (
    <AccessRow
      className={FLAT_ROW_CLASS}
      leading={<UserAvatar email={member.email ?? ''} size="sm" />}
      title={label}
      // At most one short fact. A row with no access has none: "Agents: all ·
      // Expires never" would read as "every agent, forever", the opposite of
      // the truth, and it already sits under the "No access" heading.
      metaParts={
        displayRole.kind === 'none'
          ? []
          : oneFact(via, agentGrants.length, projectAgentCount, expiresAt)
      }
      // The role sits in a fixed column, and the kebab slot after it is always
      // drawn (empty when not editable), so every row shares the same lanes.
      // An implicit or group-inherited role says why on hover instead of a
      // shield where the kebab would be.
      trailing={
        <RoleLabel
          hint={
            !editable && canManageMembers && (member.has_implicit_access || inheritedOnly)
              ? member.has_implicit_access
                ? IMPLICIT_HINT
                : GROUP_INHERITED_HINT
              : undefined
          }
        >
          {displayRole.kind === 'none' ? null : roleLabel}
        </RoleLabel>
      }
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

  return (
    // Kind reads from the avatar (the group glyph), so no "Group" badge.
    <AccessRow
      className={FLAT_ROW_CLASS}
      leading={<EntityAvatar icon={UsersIcon} size="sm" />}
      title={label}
      metaParts={oneFact(null, agentGrants.length, projectAgentCount, expiresAt)}
      trailing={<RoleLabel>{roleLabel}</RoleLabel>}
      kebab={kebab}
      kebabLabel={tI18nComplete('text33da220b1a34', { value0: label })}
      pending={busy}
    />
  );
}
