'use client';

// AccessDialog — THE modal for every "give / edit access" interaction.
//
// Five modes (grant, edit, attach, bulk-role, bulk-group) over three scopes
// (account, project, group), one chrome, one footer, one copy pattern. It replaces
// `InviteMemberModal`, `BulkAddToGroupDialog`, `BulkSetRoleDialog`,
// `AddGroupMembersDialog`, `AttachToProjectDialog`, `GrantAccessDialog`,
// `GrantAgentAccessDialog` and `CreateAssignmentDialog`.
//
// Custom-role semantics: a custom role is ONE `role_assignments` row. It used to
// be "the scope's lowest built-in baseline PLUS an `iam_policies` row", written
// in that order from the browser and fanned out with `Promise.allSettled` — a
// two-store sequence that only this file enforced and that a partial failure
// could leave half-applied, with no server-side repair. Now `createAssignment`
// writes one row and the server owns the ceiling.
//
// Agent access is the same shape: an OBJECT assignment — the `agent-user` role,
// scoped to the project, naming one agent — not a separate grant table.
//
// Built-in ROLE changes still go through the legacy per-store routes while those
// dual-write into `role_assignments`. Every write path here, legacy or not, ends
// by calling `invalidatePermissionProbes`: verdicts are cached 5 minutes, and a
// stale verdict is a revoke that has not happened yet.

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EntityAvatar } from '@/components/ui/entity-avatar';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { InfoBanner } from '@/components/ui/info-banner';
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
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsListCompact, TabsTriggerCompact } from '@/components/ui/tabs';
import { errorToast, successToast, warningToast } from '@/components/ui/toast';
import { UserAvatar } from '@/components/ui/user-avatar';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { cn } from '@/lib/utils';
import {
  addGroupMembers,
  attachGroupToProject,
  createAssignment,
  detachGroupFromProject,
  listAssignments,
  revokeAssignment,
  inviteAccountMember,
  inviteProjectMember,
  isInviteSent,
  listProjectResourceGrants,
  removeAccountMember,
  revokeProjectAccess,
  updateAccountMemberRole,
  updateProjectAccess,
  updateProjectGroupGrant,
  type AccountRole,
  type ProjectAgentResourceItem,
  type ProjectRole,
} from '@kortix/sdk';
import { contract, invalidatePermissionProbes, qk } from '@kortix/sdk/react';
import { ArrowElbowDownRightIcon, KeyIcon, PlugIcon, PlusIcon, XIcon } from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type ReactNode } from 'react';

import { endOfLocalDayIso, isoToDateInputValue, removeAccessCopy } from './access-shared';
import {
  EMPTY_PRINCIPAL_SELECTION,
  PrincipalPicker,
  principalSelectionCount,
  type PrincipalSelection,
} from './principal-picker';
import { ProjectSelect } from './project-select';
import {
  RoleSelect,
  baselineBuiltinRole,
  builtinRole,
  roleValuesEqual,
  type RoleValue,
} from './role-select';

/** The system role an OBJECT assignment carries. It grants nothing on its own —
 *  it marks "this principal may reach this object", and the principal's real
 *  role decides what they may do with it (`apps/api/src/iam/authorize.ts`). */
const OBJECT_ASSIGNMENT_ROLE_KEY = 'agent-user';

// ─── Props ─────────────────────────────────────────────────────────────────

export type AccessDialogScope =
  | { kind: 'account' }
  | { kind: 'project'; projectId: string; projectName: string }
  | { kind: 'group'; groupId: string; groupName: string };

export interface AccessDialogPrincipal {
  type: 'member' | 'group';
  id: string;
  label: string;
  avatar?: ReactNode;
}

export interface AccessDialogCurrent {
  role: RoleValue;
  /** `'all'` (no resource grants) or the agent ids currently granted. */
  agentIds?: string[] | 'all';
  expiresAt?: string | null;
  /**
   * The principal's EXISTING custom-role assignment id at this scope. Supply it
   * to switch away from (or change) a custom role and the dialog revokes exactly
   * that row; without it the dialog reads the principal's assignments back and
   * revokes the non-system, non-object one — correct, but one extra request.
   */
  assignmentId?: string;
}

export type AccessDialogMode =
  | { kind: 'grant' }
  | { kind: 'edit'; principal: AccessDialogPrincipal; current: AccessDialogCurrent }
  | { kind: 'attach'; principal: AccessDialogPrincipal }
  | { kind: 'bulk-role'; principals: AccessDialogPrincipal[] }
  /** Account Members bulk action: put every selected person into one group.
   *  Membership carries no role, so the body is the fixed principal rows plus
   *  a single-selection group picker. */
  | { kind: 'bulk-group'; principals: AccessDialogPrincipal[] };

/** The principals a non-grant mode shows as fixed header rows. */
export function fixedPrincipalsOf(mode: AccessDialogMode): AccessDialogPrincipal[] {
  if (mode.kind === 'bulk-role' || mode.kind === 'bulk-group') return mode.principals;
  if (mode.kind === 'edit' || mode.kind === 'attach') return [mode.principal];
  return [];
}

export interface AccessDialogResult {
  /** Principal ids whose mutation rejected — bulk callers keep them selected. */
  failedPrincipalIds: string[];
}

export interface AccessDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string;
  scope: AccessDialogScope;
  mode: AccessDialogMode;
  /** Used in the copy for account-scoped modes. Defaults to "this account". */
  accountName?: string;
  /** Hides the custom-role group when the tier lacks the `rbac` entitlement. */
  rbacEnabled?: boolean;
  /** Shows the "Create a custom role →" footer link inside `RoleSelect`. */
  canManageRoles?: boolean;
  /** attach mode: projects this group is already attached to. */
  excludeProjectIds?: string[];
  /** group-scope grant: user ids already in the group. */
  excludeUserIds?: string[];
  /** Groups the removed principal still inherits access from — feeds the confirm copy. */
  inheritedFrom?: string[];
  onDone?: (result: AccessDialogResult) => void;
}

// ─── Pure helpers (unit-tested in access-dialog.test.ts) ────────────────────

export interface AgentSelection {
  mode: 'all' | 'subset';
  ids: string[];
}

export const ALL_AGENTS: AgentSelection = { mode: 'all', ids: [] };

export function agentSelectionFromCurrent(current: string[] | 'all' | undefined): AgentSelection {
  if (!current || current === 'all' || current.length === 0) return ALL_AGENTS;
  return { mode: 'subset', ids: [...current] };
}

/**
 * Which resource grants to create and which to delete. `'all'` means "no
 * grants exist", so switching to a subset only ever adds; switching back to
 * `all` removes every one.
 */
export function diffAgentGrants(
  current: string[] | 'all' | undefined,
  next: AgentSelection,
): { add: string[]; remove: string[] } {
  const currentIds = !current || current === 'all' ? [] : current;
  if (next.mode === 'all') return { add: [], remove: [...currentIds] };
  const nextIds = next.ids;
  return {
    add: nextIds.filter((id) => !currentIds.includes(id)),
    remove: currentIds.filter((id) => !nextIds.includes(id)),
  };
}

export interface AccessDraft {
  role: RoleValue;
  agents: AgentSelection;
  /** `<input type="date">` value, `''` for never. */
  expiresAt: string;
}

export interface AccessDraftDiff {
  roleChanged: boolean;
  expiryChanged: boolean;
  agentsAdded: string[];
  agentsRemoved: string[];
  agentsChanged: boolean;
  /** false when nothing at all changed — Save is a no-op. */
  dirty: boolean;
}

/**
 * Save fires ONLY changed fields. This is that diff, isolated from React so
 * it can be asserted directly.
 */
export function diffAccessDraft(current: AccessDialogCurrent, next: AccessDraft): AccessDraftDiff {
  const roleChanged = !roleValuesEqual(current.role, next.role);
  const expiryChanged = isoToDateInputValue(current.expiresAt) !== next.expiresAt;
  const { add, remove } = diffAgentGrants(current.agentIds, next.agents);
  const agentsChanged = add.length > 0 || remove.length > 0;
  return {
    roleChanged,
    expiryChanged,
    agentsAdded: add,
    agentsRemoved: remove,
    agentsChanged,
    dirty: roleChanged || expiryChanged || agentsChanged,
  };
}

export interface AccessDialogCopy {
  title: string;
  description: string;
  submitLabel: string;
}

/** The prop-driven chrome copy. Identical shape for every mode. */
export function accessDialogCopy(
  scope: AccessDialogScope,
  mode: AccessDialogMode,
  opts: { accountName?: string; selectedCount?: number } = {},
): AccessDialogCopy {
  const scopeName =
    scope.kind === 'project'
      ? scope.projectName
      : scope.kind === 'group'
        ? scope.groupName
        : (opts.accountName ?? 'this account');
  const count = opts.selectedCount ?? 0;

  if (mode.kind === 'grant') {
    const description =
      scope.kind === 'account'
        ? 'Pick people, or type an email to invite someone new — everyone selected gets the same role on this account.'
        : scope.kind === 'project'
          ? 'Pick people or groups, or type an email to invite someone new — everyone selected gets the same role on this project.'
          : 'Pick account members to add to this group.';
    return {
      title: 'Grant access',
      description,
      submitLabel: count > 0 ? `Grant access (${count})` : 'Grant access',
    };
  }
  if (mode.kind === 'attach') {
    return {
      title: 'Grant access',
      description: `Attach ${mode.principal.label} to a project — every member inherits the role.`,
      submitLabel: 'Attach',
    };
  }
  if (mode.kind === 'edit') {
    return {
      title: 'Edit access',
      description: `Change what ${mode.principal.label} can do in ${scopeName}.`,
      submitLabel: 'Save',
    };
  }
  if (mode.kind === 'bulk-group') {
    const n = mode.principals.length;
    return {
      title: 'Add to group',
      description:
        n === 1
          ? 'Pick the group this person joins.'
          : `Pick the group these ${n} people join.`,
      submitLabel: 'Add to group',
    };
  }
  return {
    title: 'Edit access',
    description: `Change what ${mode.principals.length} ${
      mode.principals.length === 1 ? 'person' : 'people'
    } can do in ${scopeName}.`,
    submitLabel: 'Save',
  };
}

/**
 * The ONE `addGroupMembers(accountId, groupId, userIds)` call bulk-group
 * submits. The endpoint takes a user-id array, so a fan-out would be N
 * requests for no gain. `null` when there is nothing to write.
 */
export function bulkGroupPlan(
  mode: AccessDialogMode,
  groupId: string,
): { groupId: string; userIds: string[] } | null {
  if (mode.kind !== 'bulk-group' || !groupId) return null;
  const userIds = mode.principals.map((principal) => principal.id);
  return userIds.length > 0 ? { groupId, userIds } : null;
}

/** The role scope a `RoleSelect` runs in for a dialog scope. */
export function roleScopeFor(scope: AccessDialogScope): 'account' | 'project' | null {
  if (scope.kind === 'account') return 'account';
  if (scope.kind === 'project') return 'project';
  return null; // group membership carries no role
}

interface ProjectGrantRow {
  project_id: string;
  role: ProjectRole;
}

/** Everything the dialog body edits, in one value so it re-seeds atomically. */
interface AccessDraftState {
  principals: PrincipalSelection;
  role: RoleValue;
  agents: AgentSelection;
  /** `<input type="date">` value. */
  expires: string;
  attachProjectId: string;
  projectGrants: ProjectGrantRow[];
  projectAccessOpen: boolean;
  removeOpen: boolean;
}

function initialDraftState(
  mode: AccessDialogMode,
  roleScope: 'account' | 'project' | null,
): AccessDraftState {
  const role: RoleValue =
    mode.kind === 'edit'
      ? mode.current.role
      : builtinRole(roleScope === 'account' ? ('member' as AccountRole) : ('member' as ProjectRole));
  return {
    principals: EMPTY_PRINCIPAL_SELECTION,
    role,
    agents: mode.kind === 'edit' ? agentSelectionFromCurrent(mode.current.agentIds) : ALL_AGENTS,
    expires: mode.kind === 'edit' ? isoToDateInputValue(mode.current.expiresAt) : '',
    attachProjectId: '',
    projectGrants: [],
    projectAccessOpen: false,
    removeOpen: false,
  };
}

// ─── Component ─────────────────────────────────────────────────────────────

export function AccessDialog({
  open,
  onOpenChange,
  accountId,
  scope,
  mode,
  accountName,
  rbacEnabled = true,
  canManageRoles = false,
  excludeProjectIds,
  excludeUserIds,
  inheritedFrom,
  onDone,
}: AccessDialogProps) {
  const queryClient = useQueryClient();
  const roleScope = roleScopeFor(scope);
  const projectId = scope.kind === 'project' ? scope.projectId : undefined;

  // One draft object, re-seeded from props on every closed → open
  // transition. Adjusting state during render (React's documented
  // "props changed" pattern) rather than in an effect: no cascading
  // render, and no stale draft from a previous principal can survive a
  // reopen. Closing never re-seeds, so the exit animation plays over the
  // content the person was looking at.
  const [draft, setDraft] = useState<AccessDraftState>(() => initialDraftState(mode, roleScope));
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setDraft(initialDraftState(mode, roleScope));
  }

  const { principals, role, agents, expires, attachProjectId, projectGrants, projectAccessOpen, removeOpen } =
    draft;
  const setPrincipals = (next: PrincipalSelection) =>
    setDraft((d) => ({ ...d, principals: next }));
  const setRole = (next: RoleValue) => setDraft((d) => ({ ...d, role: next }));
  const setAgents = (next: AgentSelection | ((prev: AgentSelection) => AgentSelection)) =>
    setDraft((d) => ({ ...d, agents: typeof next === 'function' ? next(d.agents) : next }));
  const setExpires = (next: string) => setDraft((d) => ({ ...d, expires: next }));
  const setAttachProjectId = (next: string) => setDraft((d) => ({ ...d, attachProjectId: next }));
  const setProjectGrants = (next: ProjectGrantRow[]) =>
    setDraft((d) => ({ ...d, projectGrants: next }));
  const setProjectAccessOpen = (next: boolean) =>
    setDraft((d) => ({ ...d, projectAccessOpen: next }));
  const setRemoveOpen = (next: boolean) => setDraft((d) => ({ ...d, removeOpen: next }));

  const selectedCount =
    mode.kind === 'grant'
      ? principalSelectionCount(principals)
      : mode.kind === 'bulk-role' || mode.kind === 'bulk-group'
        ? mode.principals.length
        : 1;
  // The one group the bulk-group mode adds everyone to.
  const bulkGroupId = mode.kind === 'bulk-group' ? (principals.groupIds[0] ?? '') : '';
  const copy = accessDialogCopy(scope, mode, { accountName, selectedCount });

  const isCustom = role.kind === 'custom';
  const builtin = baselineBuiltinRole(roleScope ?? 'project', role);

  // ── Agents (project scope only) ───────────────────────────────────────
  const showAgents =
    scope.kind === 'project' && (mode.kind === 'grant' || mode.kind === 'edit');
  const resourceGrantsQuery = useQuery({
    queryKey: qk.project.resourceGrants(projectId ?? ''),
    queryFn: () => listProjectResourceGrants(projectId as string),
    enabled: open && showAgents && !!projectId,
    ...contract('inventory'),
  });
  const projectAgents = useMemo<ProjectAgentResourceItem[]>(
    () => resourceGrantsQuery.data?.resources.agents ?? [],
    [resourceGrantsQuery.data],
  );

  const selectedAgentDeclares = useMemo(() => {
    if (agents.mode !== 'subset' || agents.ids.length === 0) return null;
    const picked = projectAgents.filter((a) => agents.ids.includes(a.id));
    if (picked.length === 0) return null;
    const union = (key: 'secrets' | 'connectors'): string[] | 'all' => {
      if (picked.some((a) => a.declares?.[key] === 'all')) return 'all';
      return [...new Set(picked.flatMap((a) => (a.declares?.[key] as string[] | undefined) ?? []))];
    };
    return { secrets: union('secrets'), connectors: union('connectors') };
  }, [agents, projectAgents]);

  // ── Expiry ────────────────────────────────────────────────────────────
  // `expires_at` is a column on every assignment, so every grant this dialog
  // writes can carry one. It used to be offered only where the underlying store
  // happened to have the column — a UI capability derived from an SDK gap.
  // Group membership is the one exception: it is not an assignment.
  const expirySupported = scope.kind !== 'group' && mode.kind !== 'bulk-group';

  // ── Invalidation ──────────────────────────────────────────────────────
  function invalidate(touchedProjectIds: string[]) {
    // The probe cache FIRST. Every verdict this dialog can move is cached for 5
    // minutes; without this a revoke keeps rendering as access until the entry
    // expires. Account-wide, not per-user: a group or custom-role change moves
    // verdicts for principals this dialog cannot enumerate.
    void invalidatePermissionProbes(queryClient, { accountId });
    queryClient.invalidateQueries({ queryKey: ['account-members', accountId] });
    queryClient.invalidateQueries({ queryKey: ['account-groups', accountId] });
    queryClient.invalidateQueries({ queryKey: ['account-invites', accountId] });
    queryClient.invalidateQueries({ queryKey: ['iam-policies', accountId] });
    queryClient.invalidateQueries({ queryKey: ['iam-assignments', accountId] });
    queryClient.invalidateQueries({ queryKey: ['account-resource-grants', accountId, 'agent'] });
    if (scope.kind === 'group') {
      queryClient.invalidateQueries({ queryKey: ['group-members', accountId, scope.groupId] });
      queryClient.invalidateQueries({ queryKey: ['group', accountId, scope.groupId] });
    }
    // bulk-group writes into a group the SCOPE doesn't name — invalidate the
    // one that was picked, plus each person's group list.
    if (bulkGroupId) {
      queryClient.invalidateQueries({ queryKey: ['group-members', accountId, bulkGroupId] });
      queryClient.invalidateQueries({ queryKey: ['member-groups', accountId] });
    }
    for (const id of new Set(touchedProjectIds.filter(Boolean))) {
      // `qk.project.scope` is an invalidation PREFIX — access, summary,
      // pending invites and resource grants all sit under it.
      queryClient.invalidateQueries({ queryKey: qk.project.scope(id) });
    }
  }

  // ── Save ──────────────────────────────────────────────────────────────
  interface Task {
    principalId: string;
    /** Set when ONE request covers many principals (group membership writes
     *  take a user-id array). A rejection then reports every id it covered,
     *  so a bulk caller keeps the whole selection instead of a joined string
     *  that matches no row. */
    principalIds?: string[];
    run: () => Promise<unknown>;
    kind: 'invite' | 'other';
  }

  // ── Assignment writers ────────────────────────────────────────────────
  //
  // ONE row per grant. `principalKind` maps this dialog's principal vocabulary
  // (`member`/`group`) onto the canonical one (`user`/`group`) — the last place
  // the two differ.
  const principalKind = (type: 'member' | 'group') => (type === 'member' ? 'user' : 'group');

  /** Bind a custom role. One row, at one scope, with the draft's expiry. */
  function assignCustomRole(
    principalType: 'member' | 'group',
    principalId: string,
    roleId: string,
    projectScopeId: string | null,
    expiresIso: string | undefined,
  ) {
    return createAssignment(accountId, {
      principal: { type: principalKind(principalType), id: principalId },
      roleId,
      scope: projectScopeId
        ? { type: 'project', id: projectScopeId }
        : { type: 'account' },
      ...(expiresIso ? { expiresAt: expiresIso } : {}),
    });
  }

  /** Give one principal access to ONE agent: an object assignment carrying the
   *  system `agent-user` role. Idempotent server-side — re-granting returns the
   *  same assignment_id rather than a second row. */
  function assignAgent(
    principalType: 'member' | 'group',
    principalId: string,
    pid: string,
    agentId: string,
    expiresIso: string | undefined,
  ) {
    return createAssignment(accountId, {
      principal: { type: principalKind(principalType), id: principalId },
      roleKey: OBJECT_ASSIGNMENT_ROLE_KEY,
      scope: { type: 'project', id: pid },
      object: { type: 'agent', id: agentId },
      ...(expiresIso ? { expiresAt: expiresIso } : {}),
    });
  }

  /** Take one agent away. The assignment id is read back from the canonical
   *  store rather than from the legacy grant row, so this stays correct once
   *  the compatibility views are dropped. */
  async function unassignAgent(
    principalType: 'member' | 'group',
    principalId: string,
    pid: string,
    agentId: string,
  ) {
    const rows = await listAssignments(accountId, {
      principalType: principalKind(principalType),
      principalId,
      scopeType: 'project',
      scopeId: pid,
      objectType: 'agent',
      objectId: agentId,
    });
    for (const row of rows) await revokeAssignment(accountId, row.assignment_id);
  }

  /** Drop the principal's existing custom-role assignment at this scope.
   *  `current.assignmentId` is the row the roster handed us; without it, fall
   *  back to a filtered read so an older cached row cannot strand a grant. */
  async function revokeCustomRole(
    principalType: 'member' | 'group',
    principalId: string,
    projectScopeId: string | null,
    knownAssignmentId: string | undefined,
  ) {
    if (knownAssignmentId) {
      await revokeAssignment(accountId, knownAssignmentId);
      return;
    }
    const rows = await listAssignments(accountId, {
      principalType: principalKind(principalType),
      principalId,
      scopeType: projectScopeId ? 'project' : 'account',
      ...(projectScopeId ? { scopeId: projectScopeId } : {}),
    });
    for (const row of rows.filter((r) => !r.role_is_system && !r.object_type)) {
      await revokeAssignment(accountId, row.assignment_id);
    }
  }

  function buildGrantTasks(): Task[] {
    const tasks: Task[] = [];
    const roleId = role.kind === 'custom' ? role.roleId : null;
    const expiresIso = expirySupported ? endOfLocalDayIso(expires) : undefined;

    if (scope.kind === 'group') {
      if (principals.memberIds.length > 0) {
        const ids = [...principals.memberIds];
        tasks.push({
          principalId: ids.join(','),
          principalIds: ids,
          kind: 'other',
          run: () => addGroupMembers(accountId, scope.groupId, ids),
        });
      }
      return tasks;
    }

    if (scope.kind === 'account') {
      const accountBuiltin = (builtin ?? 'member') as AccountRole;
      for (const userId of principals.memberIds) {
        tasks.push({
          principalId: userId,
          kind: 'other',
          run: async () => {
            await updateAccountMemberRole(accountId, userId, accountBuiltin);
            if (roleId) await assignCustomRole('member', userId, roleId, null, expiresIso);
            // Optional per-project grants, member role only.
            if (accountBuiltin === 'member') {
              for (const grant of projectGrants.filter((g) => g.project_id)) {
                await updateProjectAccess(grant.project_id, userId, grant.role);
              }
            }
          },
        });
      }
      for (const email of principals.inviteEmails) {
        tasks.push({
          principalId: email,
          kind: 'invite',
          run: () =>
            inviteAccountMember(accountId, {
              email,
              role: accountBuiltin,
              ...(accountBuiltin === 'member' && projectGrants.some((g) => g.project_id)
                ? { project_grants: projectGrants.filter((g) => g.project_id) }
                : {}),
            }),
        });
      }
      return tasks;
    }

    // project scope
    const projectBuiltin = (builtin ?? 'member') as ProjectRole;
    const pid = scope.projectId;
    const agentIdsToGrant = agents.mode === 'subset' ? agents.ids : [];

    for (const userId of principals.memberIds) {
      tasks.push({
        principalId: userId,
        kind: 'other',
        run: async () => {
          await updateProjectAccess(pid, userId, projectBuiltin);
          if (roleId) await assignCustomRole('member', userId, roleId, pid, expiresIso);
          for (const resourceId of agentIdsToGrant) {
            await assignAgent('member', userId, pid, resourceId, expiresIso);
          }
        },
      });
    }
    for (const groupId of principals.groupIds) {
      tasks.push({
        principalId: groupId,
        kind: 'other',
        run: async () => {
          await attachGroupToProject(pid, groupId, projectBuiltin, expiresIso);
          if (roleId) await assignCustomRole('group', groupId, roleId, pid, expiresIso);
          for (const resourceId of agentIdsToGrant) {
            await assignAgent('group', groupId, pid, resourceId, expiresIso);
          }
        },
      });
    }
    for (const email of principals.inviteEmails) {
      tasks.push({
        principalId: email,
        kind: 'invite',
        run: () => inviteProjectMember(pid, email, projectBuiltin, expiresIso ?? null),
      });
    }
    return tasks;
  }

  function buildEditTasks(): Task[] {
    if (mode.kind !== 'edit') return [];
    const { principal, current } = mode;
    const diff = diffAccessDraft(current, { role, agents, expiresAt: expires });
    if (!diff.dirty) return [];
    const roleId = role.kind === 'custom' ? role.roleId : null;
    const expiresIso = expirySupported ? endOfLocalDayIso(expires) : undefined;

    if (scope.kind === 'account') {
      return [
        {
          principalId: principal.id,
          kind: 'other',
          run: async () => {
            if (!diff.roleChanged) return;
            if (current.role.kind === 'custom') {
              await revokeCustomRole('member', principal.id, null, current.assignmentId);
            }
            const next = (baselineBuiltinRole('account', role) ?? 'member') as AccountRole;
            await updateAccountMemberRole(accountId, principal.id, next);
            if (roleId) {
              await assignCustomRole('member', principal.id, roleId, null, expiresIso);
            }
          },
        },
      ];
    }

    if (scope.kind !== 'project') return [];
    const pid = scope.projectId;
    const nextBuiltin = (baselineBuiltinRole('project', role) ?? 'member') as ProjectRole;

    return [
      {
        principalId: principal.id,
        kind: 'other',
        run: async () => {
          if (diff.roleChanged || (diff.expiryChanged && principal.type === 'group')) {
            if (principal.type === 'group') {
              await updateProjectGroupGrant(pid, principal.id, nextBuiltin, expiresIso ?? null);
            } else if (diff.roleChanged) {
              await updateProjectAccess(pid, principal.id, nextBuiltin);
            }
          }
          // Custom-role policy diff. A changed roleId (or a changed expiry
          // on a custom role) is delete-then-create so the row always
          // matches the draft exactly.
          const assignmentDirty = diff.roleChanged || (diff.expiryChanged && isCustom);
          if (assignmentDirty) {
            if (current.role.kind === 'custom') {
              await revokeCustomRole('member', principal.id, pid, current.assignmentId);
            }
            if (roleId) {
              await assignCustomRole(principal.type, principal.id, roleId, pid, expiresIso);
            }
          }
          // Object-assignment diff — one row per (principal, project, agent).
          for (const resourceId of diff.agentsAdded) {
            await assignAgent(principal.type, principal.id, pid, resourceId, expiresIso);
          }
          for (const resourceId of diff.agentsRemoved) {
            await unassignAgent(principal.type, principal.id, pid, resourceId);
          }
        },
      },
    ];
  }

  function buildAttachTasks(): Task[] {
    if (mode.kind !== 'attach' || !attachProjectId) return [];
    const nextBuiltin = (baselineBuiltinRole('project', role) ?? 'member') as ProjectRole;
    const roleId = role.kind === 'custom' ? role.roleId : null;
    const expiresIso = endOfLocalDayIso(expires);
    return [
      {
        principalId: mode.principal.id,
        kind: 'other',
        run: async () => {
          await attachGroupToProject(attachProjectId, mode.principal.id, nextBuiltin, expiresIso);
          if (roleId) {
            await assignCustomRole('group', mode.principal.id, roleId, attachProjectId, expiresIso);
          }
        },
      },
    ];
  }

  function buildBulkRoleTasks(): Task[] {
    if (mode.kind !== 'bulk-role') return [];
    const next = (baselineBuiltinRole('account', role) ?? 'member') as AccountRole;
    return mode.principals.map((principal) => ({
      principalId: principal.id,
      kind: 'other' as const,
      run: () => updateAccountMemberRole(accountId, principal.id, next),
    }));
  }

  /**
   * ONE `addGroupMembers` call for the whole selection — the endpoint takes a
   * user-id array, so fanning out per person would be N requests for no gain
   * and would report partial failure the API never produces. The single task
   * carries every principal id so a rejection keeps the whole selection.
   */
  function buildBulkGroupTasks(): Task[] {
    const plan = bulkGroupPlan(mode, bulkGroupId);
    if (!plan) return [];
    return [
      {
        principalId: plan.userIds.join(','),
        principalIds: plan.userIds,
        kind: 'other',
        run: () => addGroupMembers(accountId, plan.groupId, plan.userIds),
      },
    ];
  }

  function buildTasks(): Task[] {
    switch (mode.kind) {
      case 'grant':
        return buildGrantTasks();
      case 'edit':
        return buildEditTasks();
      case 'attach':
        return buildAttachTasks();
      case 'bulk-role':
        return buildBulkRoleTasks();
      case 'bulk-group':
        return buildBulkGroupTasks();
    }
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      const tasks = buildTasks();
      const settled = await Promise.allSettled(tasks.map((task) => task.run()));
      return { tasks, settled };
    },
    onSuccess: ({ tasks, settled }) => {
      const failedIndexes = settled
        .map((result, index) => (result.status === 'rejected' ? index : -1))
        .filter((index) => index >= 0);
      const failedPrincipalIds = failedIndexes.flatMap(
        (index) => tasks[index]!.principalIds ?? [tasks[index]!.principalId],
      );
      const total = tasks.length;
      const ok = total - failedIndexes.length;

      // Invite created but no email delivered — hand the admin the link.
      const undeliveredInvite = settled.find((result, index) => {
        if (result.status !== 'fulfilled' || tasks[index]!.kind !== 'invite') return false;
        const value = result.value as { invite_url?: string; email_sent?: boolean };
        if (isInviteSent(value as never)) return !value.email_sent;
        return value?.invite_url != null && value.email_sent === false;
      });

      if (total === 0) {
        onOpenChange(false);
        onDone?.({ failedPrincipalIds: [] });
        return;
      }

      if (undeliveredInvite && undeliveredInvite.status === 'fulfilled') {
        const url = (undeliveredInvite.value as { invite_url?: string }).invite_url ?? '';
        warningToast('Some invites were created without email delivery — share links manually.', {
          duration: 10_000,
          button: (
            <Button size="sm" onClick={() => void navigator.clipboard.writeText(url)}>
              Copy a link
            </Button>
          ),
        });
      } else if (failedIndexes.length > 0 && ok > 0) {
        errorToast(`Granted ${ok} of ${total} — some failed.`);
      } else if (failedIndexes.length > 0) {
        const first = settled.find((r) => r.status === 'rejected') as
          | PromiseRejectedResult
          | undefined;
        errorToast(
          first?.reason instanceof Error ? first.reason.message : 'Failed to save access',
        );
      } else if (mode.kind === 'grant') {
        successToast(total === 1 ? 'Access granted' : `Access granted to ${total}`);
      } else if (mode.kind === 'attach') {
        successToast('Attached to project');
      } else if (mode.kind === 'bulk-group') {
        successToast(
          selectedCount === 1 ? 'Added to group' : `Added ${selectedCount} people to the group`,
        );
      } else {
        successToast('Access updated');
      }

      const touched = [
        ...(projectId ? [projectId] : []),
        ...(attachProjectId ? [attachProjectId] : []),
        ...projectGrants.map((g) => g.project_id),
      ];
      invalidate(touched);
      onDone?.({ failedPrincipalIds });
      if (failedIndexes.length === 0) onOpenChange(false);
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to save access'),
  });

  const removeMutation = useMutation({
    mutationFn: async () => {
      if (mode.kind !== 'edit') return;
      const { principal } = mode;
      if (scope.kind === 'account') return removeAccountMember(accountId, principal.id);
      if (scope.kind === 'project') {
        return principal.type === 'group'
          ? detachGroupFromProject(scope.projectId, principal.id)
          : revokeProjectAccess(scope.projectId, principal.id);
      }
    },
    onSuccess: () => {
      successToast('Access removed');
      invalidate(projectId ? [projectId] : []);
      setRemoveOpen(false);
      onOpenChange(false);
      onDone?.({ failedPrincipalIds: [] });
    },
    onError: (error: Error) => errorToast(error.message || 'Failed to remove access'),
  });

  const pending = saveMutation.isPending || removeMutation.isPending;

  // ── Submit gate ───────────────────────────────────────────────────────
  const editDiff =
    mode.kind === 'edit'
      ? diffAccessDraft(mode.current, { role, agents, expiresAt: expires })
      : null;
  const canSubmit =
    !pending &&
    (mode.kind === 'grant'
      ? selectedCount > 0
      : mode.kind === 'attach'
        ? !!attachProjectId
        : mode.kind === 'bulk-role'
          ? mode.principals.length > 0
          : mode.kind === 'bulk-group'
            ? mode.principals.length > 0 && !!bulkGroupId
            : !!editDiff?.dirty);

  const showAccountAdminBanner =
    scope.kind === 'account' && role.kind === 'builtin' && role.role !== 'member';
  const showProjectAccessSection =
    mode.kind === 'grant' && scope.kind === 'account' && !showAccountAdminBanner;

  return (
    <>
      <Modal
        open={open}
        onOpenChange={(next) => {
          // Closing while a mutation is in flight is a no-op.
          if (pending) return;
          onOpenChange(next);
        }}
      >
        <ModalContent className="sm:max-w-md">
          <ModalHeader>
            <ModalTitle>{copy.title}</ModalTitle>
            <ModalDescription>{copy.description}</ModalDescription>
          </ModalHeader>

          <ModalBody className="max-h-[60vh] space-y-4 overflow-y-auto">
            {/* 1. Who */}
            {mode.kind === 'grant' ? (
              <Field className="gap-1.5">
                <FieldLabel>{scope.kind === 'group' ? 'Add' : 'Grant to'}</FieldLabel>
                <PrincipalPicker
                  scope={
                    scope.kind === 'project'
                      ? { kind: 'project', projectId: scope.projectId }
                      : { kind: 'account', accountId }
                  }
                  selection="multi"
                  kinds={scope.kind === 'project' ? ['member', 'group'] : ['member']}
                  allowInvite={scope.kind !== 'group'}
                  excludeUserIds={excludeUserIds}
                  value={principals}
                  onChange={setPrincipals}
                  disabled={pending}
                  emptyLabel={
                    scope.kind === 'group'
                      ? 'No other members in this account yet.'
                      : 'No members or groups here yet.'
                  }
                  allExcludedLabel={
                    scope.kind === 'group'
                      ? 'Every account member is already in this group.'
                      : 'Everyone is already added.'
                  }
                />
              </Field>
            ) : (
              <FixedPrincipals principals={fixedPrincipalsOf(mode)} />
            )}

            {/* 1b. Group (bulk-group only) — membership carries no role, so
                this replaces the Role section rather than joining it. */}
            {mode.kind === 'bulk-group' ? (
              <Field className="gap-1.5">
                <FieldLabel>Group</FieldLabel>
                <PrincipalPicker
                  scope={{ kind: 'account', accountId }}
                  selection="single"
                  kinds={['group']}
                  value={principals}
                  onChange={setPrincipals}
                  disabled={pending}
                  emptyLabel="No groups in this account yet."
                />
              </Field>
            ) : null}

            {/* 2. Project (attach only) */}
            {mode.kind === 'attach' ? (
              <Field className="gap-1.5">
                <FieldLabel htmlFor="access-attach-project">Project</FieldLabel>
                <ProjectSelect
                  id="access-attach-project"
                  accountId={accountId}
                  value={attachProjectId}
                  onChange={setAttachProjectId}
                  requireAction={PROJECT_ACTIONS.PROJECT_MEMBERS_MANAGE}
                  excludeIds={excludeProjectIds}
                  disabled={pending}
                  enabled={open}
                  emptyText={{
                    allExcluded: 'This group is already attached to every project you can manage.',
                    noneEligible: 'You need Manager access on a project to attach a group to it.',
                  }}
                />
              </Field>
            ) : null}

            {/* 3. Role — group membership has no role, so bulk-group skips it. */}
            {roleScope && mode.kind !== 'bulk-group' ? (
              <Field className="gap-1.5">
                <FieldLabel htmlFor="access-role">Role</FieldLabel>
                <RoleSelect
                  id="access-role"
                  scope={roleScope}
                  accountId={accountId}
                  value={role}
                  onChange={setRole}
                  disabled={pending}
                  rbacEnabled={rbacEnabled}
                  canManageRoles={canManageRoles}
                  // Ownership transfer is its own flow — never a grant.
                  builtinRoles={
                    roleScope === 'account' && mode.kind === 'grant'
                      ? ['member', 'admin']
                      : undefined
                  }
                />
                {scope.kind === 'project' && principals.groupIds.length > 0 ? (
                  <FieldDescription>
                    Every member of a selected group gets this role on this project too.
                  </FieldDescription>
                ) : null}
              </Field>
            ) : null}

            {/* 4. Agents (project scope) */}
            {showAgents ? (
              <Field className="gap-1.5">
                <FieldLabel>Agents</FieldLabel>
                <Tabs
                  value={agents.mode}
                  onValueChange={(next) =>
                    setAgents(next === 'all' ? ALL_AGENTS : { mode: 'subset', ids: agents.ids })
                  }
                >
                  <TabsListCompact>
                    <TabsTriggerCompact value="all">All agents</TabsTriggerCompact>
                    <TabsTriggerCompact value="subset">Only these…</TabsTriggerCompact>
                  </TabsListCompact>
                </Tabs>
                {agents.mode === 'subset' ? (
                  resourceGrantsQuery.isLoading ? (
                    <Skeleton className="h-24 w-full rounded-md" />
                  ) : projectAgents.length === 0 ? (
                    <p className="text-muted-foreground text-xs">This project has no agents yet.</p>
                  ) : (
                    <div className="border-border max-h-40 overflow-y-auto rounded-md border p-1">
                      {projectAgents.map((agent) => (
                        <Checkbox
                          key={agent.id}
                          label={agent.name}
                          checked={agents.ids.includes(agent.id)}
                          disabled={pending}
                          onCheckedChange={() =>
                            setAgents((prev) => ({
                              mode: 'subset',
                              ids: prev.ids.includes(agent.id)
                                ? prev.ids.filter((x) => x !== agent.id)
                                : [...prev.ids, agent.id],
                            }))
                          }
                        />
                      ))}
                    </div>
                  )
                ) : null}
                {selectedAgentDeclares ? (
                  <BlastRadiusPreview declares={selectedAgentDeclares} />
                ) : null}
              </Field>
            ) : null}

            {/* 5. Project access (account grant only) */}
            {showAccountAdminBanner ? (
              <InfoBanner tone="neutral">
                Admins already have access to every project in this account — nothing to grant here.
              </InfoBanner>
            ) : showProjectAccessSection ? (
              <ProjectAccessRows
                accountId={accountId}
                rows={projectGrants}
                onChange={setProjectGrants}
                expanded={projectAccessOpen}
                onExpand={() => {
                  setProjectAccessOpen(true);
                  if (projectGrants.length === 0) {
                    setProjectGrants([{ project_id: '', role: 'member' }]);
                  }
                }}
                disabled={pending}
                rbacEnabled={rbacEnabled}
                canManageRoles={canManageRoles}
              />
            ) : null}

            {/* 6. Expires */}
            {expirySupported ? (
              <Field className="gap-1.5">
                <FieldLabel htmlFor="access-expires">
                  Expires
                  <span className="text-muted-foreground ml-2 text-xs font-normal">optional</span>
                </FieldLabel>
                <Input
                  id="access-expires"
                  type="date"
                  value={expires}
                  onChange={(event) => setExpires(event.target.value)}
                  disabled={pending}
                  className="max-w-xs"
                />
                <FieldDescription>The grant is removed automatically at this time.</FieldDescription>
              </Field>
            ) : null}
          </ModalBody>

          <ModalFooter className="sm:justify-between">
            <div className="flex items-center gap-2">
              {mode.kind === 'edit' ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  disabled={pending}
                  onClick={() => setRemoveOpen(true)}
                >
                  Remove access
                </Button>
              ) : null}
              <Button
                type="button"
                variant="outline-ghost"
                size="sm"
                disabled={pending}
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
            </div>
            <Button
              type="button"
              size="sm"
              className="gap-1.5"
              disabled={!canSubmit}
              onClick={() => saveMutation.mutate()}
            >
              {saveMutation.isPending ? <Loading className="size-3.5 shrink-0" /> : null}
              {copy.submitLabel}
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>

      {mode.kind === 'edit' ? (
        <ConfirmDialog
          open={removeOpen}
          onOpenChange={setRemoveOpen}
          confirmVariant="destructive"
          confirmLabel={
            scope.kind === 'project' && mode.principal.type === 'group'
              ? 'Detach group'
              : 'Remove access'
          }
          isPending={removeMutation.isPending}
          onConfirm={() => removeMutation.mutate()}
          {...removeAccessCopy({
            principal: mode.principal.label,
            scopeName:
              scope.kind === 'project'
                ? scope.projectName
                : scope.kind === 'group'
                  ? scope.groupName
                  : (accountName ?? 'this account'),
            inherited: inheritedFrom,
          })}
        />
      ) : null}
    </>
  );
}

// ─── Body pieces ───────────────────────────────────────────────────────────

function FixedPrincipals({ principals }: { principals: AccessDialogPrincipal[] }) {
  return (
    <ul className="space-y-2">
      {principals.map((principal) => (
        <li
          key={principal.id}
          className="bg-popover flex items-center gap-2.5 rounded-md border px-3 py-2"
        >
          {principal.avatar ??
            (principal.type === 'group' ? (
              <EntityAvatar label={principal.label} size="sm" />
            ) : (
              <UserAvatar email={principal.label} size="sm" />
            ))}
          <span className="text-foreground min-w-0 flex-1 truncate text-sm font-medium">
            {principal.label}
          </span>
          {/* Only a GROUP is badged. "Member" here read as the person's ROLE —
              directly above a Role select that also says "Member" — so a
              person carries no badge and a group is the thing that stands out. */}
          {principal.type === 'group' ? (
            <Badge variant="outline" size="sm">
              Group
            </Badge>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function ScopeLine({
  icon: Icon,
  label,
  items,
}: {
  icon: typeof KeyIcon;
  label: string;
  items: string[];
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Icon className="text-muted-foreground/70 size-3.5 shrink-0" />
      <span className="text-muted-foreground text-[11px] font-medium">{label}</span>
      {items.map((name) => (
        <Badge key={name} variant="outline" size="xs" className="font-mono">
          {name}
        </Badge>
      ))}
    </div>
  );
}

/**
 * The concrete secrets + connectors an assignee INHERITS from the picked
 * agents — ported from `access-agents-tab.tsx:263-295`. `'all'` inherits
 * nothing SPECIFIC (it already means "everything they can see"), so only
 * explicit lists show.
 */
export function BlastRadiusPreview({
  declares,
}: {
  declares: { secrets: string[] | 'all'; connectors: string[] | 'all' };
}) {
  const secrets = declares.secrets === 'all' ? [] : declares.secrets;
  const connectors = declares.connectors === 'all' ? [] : declares.connectors;
  const nothingExtra = secrets.length === 0 && connectors.length === 0;
  return (
    <div className="border-border/60 bg-muted/30 space-y-2 rounded-md border p-3">
      <div className="flex items-center gap-1.5">
        <ArrowElbowDownRightIcon className="text-muted-foreground/70 size-3.5 shrink-0" />
        <span className="text-foreground/80 text-xs font-medium">Assigning this also grants</span>
      </div>
      {nothingExtra ? (
        <p className="text-muted-foreground text-[11px] leading-relaxed">
          Nothing extra — this agent declares no specific secrets or connectors to inherit.
        </p>
      ) : (
        <>
          <div className="space-y-1.5">
            {secrets.length > 0 ? <ScopeLine icon={KeyIcon} label="Secrets" items={secrets} /> : null}
            {connectors.length > 0 ? (
              <ScopeLine icon={PlugIcon} label="Connectors" items={connectors} />
            ) : null}
          </div>
          <p className="text-muted-foreground/60 text-[11px] leading-relaxed">
            They also get the agent&apos;s secrets and connectors to USE, not edit.
          </p>
        </>
      )}
    </div>
  );
}

function ProjectAccessRows({
  accountId,
  rows,
  onChange,
  expanded,
  onExpand,
  disabled,
  rbacEnabled,
  canManageRoles,
}: {
  accountId: string;
  rows: ProjectGrantRow[];
  onChange: (next: ProjectGrantRow[]) => void;
  expanded: boolean;
  onExpand: () => void;
  disabled?: boolean;
  rbacEnabled?: boolean;
  canManageRoles?: boolean;
}) {
  if (!expanded && rows.length === 0) {
    return (
      <button
        type="button"
        onClick={onExpand}
        disabled={disabled}
        className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
      >
        <PlusIcon className="size-3.5" />
        Add project access
      </button>
    );
  }

  return (
    <Field className="gap-1.5">
      <div className="flex items-center justify-between">
        <FieldLabel>Project access</FieldLabel>
        <span className="text-muted-foreground text-xs">Optional</span>
      </div>
      <div className="border-border divide-border divide-y overflow-hidden rounded-md border">
        {rows.map((row, index) => (
          <div key={index} className="bg-popover flex items-center gap-2 p-2">
            <ProjectSelect
              accountId={accountId}
              value={row.project_id}
              onChange={(projectId) =>
                onChange(rows.map((r, i) => (i === index ? { ...r, project_id: projectId } : r)))
              }
              excludeIds={rows.filter((_, i) => i !== index).map((r) => r.project_id)}
              disabled={disabled}
              className="flex-1 border-none bg-transparent shadow-none"
            />
            <RoleSelect
              scope="project"
              accountId={accountId}
              value={{ kind: 'builtin', role: row.role }}
              onChange={(next) =>
                onChange(
                  rows.map((r, i) =>
                    i === index && next.kind === 'builtin'
                      ? { ...r, role: next.role as ProjectRole }
                      : r,
                  ),
                )
              }
              disabled={disabled}
              rbacEnabled={false}
              canManageRoles={canManageRoles && rbacEnabled}
              className="w-32 shrink-0 border-none bg-transparent shadow-none"
            />
            <button
              type="button"
              onClick={() => onChange(rows.filter((_, i) => i !== index))}
              disabled={disabled}
              aria-label="Remove project"
              className="text-muted-foreground hover:text-foreground shrink-0 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            >
              <XIcon className="size-3.5" />
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => onChange([...rows, { project_id: '', role: 'member' }])}
        disabled={disabled}
        className={cn(
          'text-muted-foreground hover:text-foreground flex items-center gap-1.5 text-xs font-medium transition-colors',
          'disabled:cursor-not-allowed disabled:opacity-50',
        )}
      >
        <PlusIcon className="size-3.5" />
        Add another project
      </button>
    </Field>
  );
}
