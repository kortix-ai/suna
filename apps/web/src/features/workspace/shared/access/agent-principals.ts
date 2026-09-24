'use client';

// Agents as principals (spec `docs/specs/2026-09-22-agents-as-principals.md`).
//
// An agent session authorizes as the AGENT (its service account), not as the
// person who launched it:
//
//   effective(agent) = kortix_permissions(agent)   -- kortix.yaml, source of truth
//                    ∩ ceiling(agent)              -- IAM role(s) bound to its service account
//                    − HUMAN_ONLY                  -- never an agent's, whatever the role
//
// The launcher contributes "may run this agent" and their own personal
// resources, never their role. This module is the web's read of that model:
// the pure intersection (unit-tested beside it) and the one hook that loads
// the IAM half. Enforcement is server-side (`apps/api/src/iam/authorize.ts`);
// nothing here decides access.

import {
  getRolePermissions,
  listAgentIdentities,
  listAssignments,
  listRoles,
  type AgentIdentity,
  type IamRole,
  type RoleAssignment,
} from '@kortix/sdk';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { KORTIX_PERMISSIONS_CATALOG } from '@/features/workspace/customize/sections/view/agent-editor-catalog';

/** Never an agent's, whatever its role or its `kortix_permissions` say. Mirrors
 *  `HUMAN_ONLY` in the spec §2.1 (enforced in apps/api). */
export const HUMAN_ONLY_PERMISSIONS: readonly string[] = [
  'project.members.manage',
  'project.delete',
  'project.credentials.issue',
];

/** Every project permission `kortix_permissions` may name. */
export const GRANTABLE_PROJECT_PERMISSIONS: readonly string[] = KORTIX_PERMISSIONS_CATALOG.flatMap(
  (group) => group.actions,
);

/** Always granted to an agent inside its own project (spec §2.1). */
const ALWAYS_GRANTED = 'project.read';

export type PermissionGrant = string[] | 'all' | 'none' | undefined;

export interface AgentAuthority {
  /** The manifest grant, expanded: `all` → every grantable permission. */
  declared: string[];
  /** What the agent may do on shared project resources, sorted. */
  effective: string[];
  /** Declared, but outside the ceiling role(s). */
  outsideCeiling: string[];
  /** Declared, but human-only — dropped whatever the ceiling says. */
  humanOnly: string[];
}

export function expandPermissionGrant(grant: PermissionGrant): string[] {
  if (grant === 'all') return [...GRANTABLE_PROJECT_PERMISSIONS];
  if (!grant || grant === 'none') return [];
  return [...new Set(grant)];
}

/**
 * The intersection, as the server computes it. `ceiling === null` means no
 * role is bound to the agent's service account: the built-in default ceiling
 * applies, which is every grantable project permission minus HUMAN_ONLY.
 */
export function computeAgentAuthority(
  grant: PermissionGrant,
  ceiling: readonly string[] | null,
): AgentAuthority {
  const declared = expandPermissionGrant(grant);
  const humanOnlySet = new Set(HUMAN_ONLY_PERMISSIONS);
  const ceilingSet = ceiling ? new Set(ceiling) : null;
  const humanOnly = declared.filter((p) => humanOnlySet.has(p));
  const outsideCeiling = ceilingSet
    ? declared.filter((p) => !humanOnlySet.has(p) && !ceilingSet.has(p) && p !== ALWAYS_GRANTED)
    : [];
  const effective = new Set(
    declared.filter(
      (p) => !humanOnlySet.has(p) && (!ceilingSet || ceilingSet.has(p) || p === ALWAYS_GRANTED),
    ),
  );
  effective.add(ALWAYS_GRANTED);
  return {
    declared: declared.sort(),
    effective: [...effective].sort(),
    outsideCeiling: outsideCeiling.sort(),
    humanOnly: humanOnly.sort(),
  };
}

/** The service account an agent runs as in one project, or null. */
export function agentIdentityFor(
  identities: readonly AgentIdentity[] | undefined,
  projectId: string,
  agentName: string,
): AgentIdentity | null {
  return (
    identities?.find((i) => i.project_id === projectId && i.agent_name === agentName) ?? null
  );
}

/**
 * The ceiling-bearing assignments of one agent in one project: role rows (not
 * object grants) bound to its service account at the project, or at the
 * account (which covers every project).
 */
export function ceilingAssignments(
  assignments: readonly RoleAssignment[] | undefined,
  serviceAccountId: string,
  projectId: string,
): RoleAssignment[] {
  return (assignments ?? []).filter(
    (a) =>
      a.principal_type === 'service_account' &&
      a.principal_id === serviceAccountId &&
      !a.object_type &&
      (a.scope_type === 'account' || a.scope_id === projectId),
  );
}

/**
 * The id `GET /iam/roles/:roleId/permissions` answers for an assignment's role.
 * A custom role is addressed by its assignment `role_id`. A system role is
 * not: the assignment carries the seeded row's uuid, while the route knows
 * system roles by their wire id (`builtin:user` is the project `member`), so
 * it is looked up in the roles list by key and scope. Null when the roles list
 * does not name it.
 */
export function rolePermissionsId(
  assignment: Pick<RoleAssignment, 'role_id' | 'role_key' | 'role_is_system' | 'scope_type'>,
  roles: readonly Pick<IamRole, 'role_id' | 'key' | 'is_system' | 'resource_type'>[] | undefined,
): string | null {
  if (!assignment.role_is_system) return assignment.role_id;
  const resource = assignment.scope_type === 'project' ? 'project' : 'account';
  return (
    roles?.find((r) => r.is_system && r.key === assignment.role_key && r.resource_type === resource)
      ?.role_id ?? null
  );
}

export const agentIdentitiesQueryKey = (accountId: string | undefined) =>
  ['iam-agent-identities', accountId] as const;

/**
 * The account's agent identities. Admin-only: the route asserts `policy.read`,
 * and a 403 is an answer ("you cannot see the ceiling"), not an error to toast.
 */
export function useAgentIdentities(accountId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: agentIdentitiesQueryKey(accountId),
    queryFn: () => listAgentIdentities(accountId as string),
    enabled: enabled && !!accountId,
    staleTime: 60_000,
    retry: false,
  });
}

/** Every service-account role assignment in one project. Admin-only. */
export function useProjectAgentAssignments(
  accountId: string | undefined,
  projectId: string,
  enabled = true,
) {
  return useQuery({
    queryKey: ['iam-assignments', accountId, 'service_account', projectId],
    queryFn: async () => {
      const [project, account] = await Promise.all([
        listAssignments(accountId as string, { scopeType: 'project', scopeId: projectId }),
        listAssignments(accountId as string, { scopeType: 'account' }),
      ]);
      return [...project, ...account].filter(
        (a) => a.principal_type === 'service_account' && !a.object_type,
      );
    },
    enabled: enabled && !!accountId,
    staleTime: 30_000,
    retry: false,
  });
}

export type AgentCeilingState =
  | { kind: 'loading' }
  /** The viewer may not read IAM. The ceiling exists; it is not theirs to see. */
  | { kind: 'hidden' }
  | { kind: 'default' }
  | { kind: 'roles'; roleKeys: string[]; actions: string[] };

export interface AgentAuthorityState {
  ceiling: AgentCeilingState;
  identity: AgentIdentity | null;
  authority: AgentAuthority;
}

/** The whole agent-authority read for one agent: ceiling and intersection.
 *
 *  It does NOT read the `agent_principal` project flag. That flag is no longer
 *  a choice the product presents — it is the default behavior, and its one
 *  remaining off-switch is a support lever, not a UI state. Enforcement stays
 *  server-side (`apps/api/src/iam/agent-principal.ts`). */
export function useAgentAuthority({
  projectId,
  accountId,
  agentName,
  grant,
}: {
  projectId: string;
  accountId: string | undefined;
  agentName: string;
  grant: PermissionGrant;
}): AgentAuthorityState {
  const identities = useAgentIdentities(accountId);
  const identity = agentIdentityFor(identities.data, projectId, agentName);
  const assignmentsQuery = useProjectAgentAssignments(accountId, projectId, !!identity);
  const rows = useMemo(
    () =>
      identity
        ? ceilingAssignments(assignmentsQuery.data, identity.service_account_id, projectId)
        : [],
    [assignmentsQuery.data, identity, projectId],
  );
  const rolesQuery = useQuery({
    queryKey: ['iam-roles', accountId],
    queryFn: () => listRoles(accountId as string),
    enabled: !!accountId && rows.length > 0,
    staleTime: 30_000,
    retry: false,
  });
  const roleIds = [
    ...new Set(
      rows
        .map((r) => rolePermissionsId(r, rolesQuery.data))
        .filter((id): id is string => id !== null),
    ),
  ];
  const permissionQueries = useQueries({
    queries: roleIds.map((roleId) => ({
      queryKey: ['iam-role-permissions', accountId, roleId],
      queryFn: () => getRolePermissions(accountId as string, roleId),
      staleTime: 30_000,
      enabled: !!accountId,
    })),
  });

  let ceiling: AgentCeilingState;
  if (identities.isError || assignmentsQuery.isError) ceiling = { kind: 'hidden' };
  else if (identities.isLoading || (identity && assignmentsQuery.isLoading)) {
    ceiling = { kind: 'loading' };
  } else if (!identity || rows.length === 0) ceiling = { kind: 'default' };
  else if (rolesQuery.isLoading || permissionQueries.some((q) => q.isLoading)) {
    ceiling = { kind: 'loading' };
  } else if (
    rolesQuery.isError ||
    roleIds.length === 0 ||
    permissionQueries.some((q) => q.isError)
  ) {
    ceiling = { kind: 'hidden' };
  }
  else {
    ceiling = {
      kind: 'roles',
      roleKeys: [...new Set(rows.map((r) => r.role_key))].sort(),
      actions: [...new Set(permissionQueries.flatMap((q) => q.data?.actions ?? []))],
    };
  }

  const ceilingActions = ceiling.kind === 'roles' ? ceiling.actions : null;
  const authority = useMemo(
    () => computeAgentAuthority(grant, ceilingActions),
    // `ceilingActions` is rebuilt every render; key on its content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [grant, ceilingActions?.join(',')],
  );

  return {
    ceiling,
    identity,
    authority,
  };
}
