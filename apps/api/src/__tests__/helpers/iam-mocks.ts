// Shared IAM test mocks. The real engine and the real write path read
// `role_assignments` / `roles` / `role_permissions` / `permissions`, which the
// suites' lightweight db shims do not model, so authz-agnostic suites bypass
// them here instead of re-declaring the same blocks in every file.
//
// Paths are relative to THIS file (src/__tests__/helpers/), so '../../iam/...'
// resolves to src/iam/... — the same module the suites import as '../iam/...'.
import { mock } from 'bun:test';

type CtxLike = { get(k: string): unknown };

/** The Actor a bypassed suite should see: the request's user, no credential to
 *  fold, no DB read. */
const jwtActor = async (c: CtxLike, accountId: string) => ({
  userId: (c.get('userId') as string | undefined) ?? '',
  accountId,
  credential: { kind: 'jwt' as const },
  ctx: {},
});

/**
 * Bypass the ONE write path (`iam/assignments`).
 *
 * Every grant goes through `assignRole` now, and it is no longer best-effort:
 * before the cutover a legacy INSERT made the grant and the canonical call only
 * added the audit event, so a suite could let it throw. It IS the grant now, so
 * a suite whose db shim does not model `role_assignments` has to bypass it or
 * every provision / invite-accept / member-add 500s.
 *
 * `onGrant` lets a suite that DOES care about the resulting role project it back
 * into its own in-memory rows — the same rows `mockIamReadModels` reads.
 */
export interface AssignmentMockHooks {
  onGrant?: (input: {
    accountId: string;
    principal: { type: string; id: string };
    roleKey?: string;
    roleId?: string;
    scope: { type: string; id?: string | null };
  }) => void;
  onRevoke?: (accountId: string, assignmentId: string) => void;
  /** `revokeProjectRole(writer, accountId, projectId, principal)`. */
  onRevokeProjectRole?: (
    accountId: string,
    projectId: string,
    principal: { type: string; id: string },
  ) => void;
}

export function mockIamAssignments(hooks: AssignmentMockHooks = {}): void {
  const SYSTEM_ACTOR = Symbol.for('kortix.iam.system-actor');
  let seq = 0;
  mock.module('../../iam/assignments', () => ({
    SYSTEM_ACTOR,
    assignRole: async (_writer: unknown, accountId: string, input: any) => {
      hooks.onGrant?.({ accountId, ...input });
      seq += 1;
      return {
        assignmentId: `assignment-${seq}`,
        accountId,
        principalType: input.principal?.type ?? 'user',
        principalId: input.principal?.id ?? '',
        roleId: input.roleId ?? `role-${input.roleKey ?? 'member'}`,
        roleKey: input.roleKey ?? 'member',
        roleIsSystem: !input.roleId,
        scopeType: input.scope?.type ?? 'account',
        scopeId: input.scope?.id ?? null,
        objectType: input.object?.type ?? null,
        objectId: input.object?.id ?? null,
        expiresAt: input.expiresAt ?? null,
        grantedBy: input.grantedBy ?? null,
        source: input.source ?? 'manual',
        createdAt: new Date(0),
        updatedAt: new Date(0),
      };
    },
    updateAssignment: async () => {
      throw new Error('updateAssignment is not modelled by mockIamAssignments');
    },
    revokeAssignment: async (_w: unknown, accountId: string, assignmentId: string) => {
      hooks.onRevoke?.(accountId, assignmentId);
      return null;
    },
    revokeProjectRole: async (
      _w: unknown,
      accountId: string,
      projectId: string,
      principal: { type: string; id: string },
    ) => {
      hooks.onRevokeProjectRole?.(accountId, projectId, principal);
      return 1;
    },
    listAssignments: async () => [],
    listAssignmentsByIds: async () => [],
    assignmentsForProject: async () => [],
    assignmentsForPrincipals: async () => [],
    assignmentsForRoles: async () => [],
    findExpiredAssignments: async () => [],
    auditAssignmentExpired: async () => {},
    auditAssignmentRevoked: async () => {},
    groupPrincipalIds: async () => [],
    deleteAccountScopeAssignments: async () => {},
    deleteProjectScopeAssignments: async () => {},
    assignPendingProjectRole: async () => {},
    revokePendingAssignments: async () => {},
    convertPendingAssignments: async () => {},
  }));
}

/** Bypass the IAM engine, allowing every action. Use only in suites that are
 *  NOT testing authz denial — those keep a role-aware engine mock.
 *
 *  `authorize` / `assertAuthorized` / `listAccessible` are re-exported from
 *  `../iam` but LIVE in `./authorize`, so the mock MUST target that module —
 *  mocking the barrel alone leaves the direct importers (projects/lib/access.ts,
 *  billing, git) on the real engine, which then hits unmocked tables. */
export function mockIamEngineAllowAll(
  onAssertAuthorized?: (action: string) => void | Promise<void>,
): void {
  // The gate now resolves an `Actor` BEFORE it asks the engine, and building one
  // for a PAT reads `account_tokens`. Suites that bypass the engine are exactly
  // the suites whose db mock does not model that table, so bypassing the engine
  // has to mean bypassing the whole IAM read path — otherwise the actor build
  // throws and the route 500s before the allow-all engine is ever consulted.
  // Every export of `iam/actor` is redeclared, not spread: `mock.module`
  // replaces the module WHOLESALE, so a missing name is a SyntaxError in every
  // other importer — and a top-level `await import` of the real module races the
  // suites that call this at module scope (TDZ on the awaited binding).
  mock.module('../../iam/actor', () => ({
    KORTIX_PENDING_PRINCIPAL_NAMESPACE: 'b8d1f9c6-0a7e-4a2f-9d3b-5e6c7a8b9c01',
    pendingPrincipalId: (email: string) => email,
    actingPrincipal: (a: { userId: string }) => ({ type: 'user', id: a.userId }),
    actingTokenId: () => undefined,
    credentialProjectId: () => null,
    credentialAgentGrant: () => null,
    loadTokenBinding: async () => null,
    loadServiceAccountActivation: async () => false,
    actorOf: jwtActor,
    actorFor: jwtActor,
    buildActor: async (c: CtxLike, accountId?: string) =>
      jwtActor(c, accountId ?? ((c.get('accountId') as string | undefined) ?? '')),
    actorForUser: (userId: string, accountId: string) => ({
      userId,
      accountId,
      credential: { kind: 'jwt' as const },
      ctx: {},
    }),
    actorForToken: async (userId: string, accountId: string) => ({
      userId,
      accountId,
      credential: { kind: 'jwt' as const },
      ctx: {},
    }),
    actorForServiceAccount: (serviceAccountId: string, accountId: string) => ({
      userId: serviceAccountId,
      accountId,
      credential: { kind: 'service_account' as const, serviceAccountId },
      ctx: {},
    }),
  }));
  mock.module('../../iam/authorize', () => ({
    authorize: async () => ({ allowed: true, reason: 'role' }),
    assertAuthorized: async (_actor: unknown, action: string) => {
      await onAssertAuthorized?.(action);
    },
    listAccessible: async () => ({ mode: 'all' }),
    // Per-object (agent/skill) list filter. Allow-all → no filtering: every
    // object id passes through.
    filterAccessibleObjects: async (
      _actor: unknown,
      _projectId: string,
      _type: string,
      ids: readonly string[],
    ) => [...ids],
    // The object-grant memo. `projects/lib/agent-access` reads it to build the
    // AGENT CANDIDATE list, so it has to be declared here — `mock.module`
    // replaces the module wholesale, and a missing name is a SyntaxError in
    // every other importer. Empty map = this project scopes no agent, which is
    // the allow-all posture.
    loadObjectGrants: Object.assign(async () => new Map(), { clear: () => {} }),
    isImplicitManager: (key: string | null) => key === 'owner' || key === 'admin',
    objectUsable: async () => true,
    tokenScopeAllows: () => true,
    customRoleAllows: () => false,
    resolvePrincipal: async () => null,
    clearAuthorizeCaches: () => {},
  }));
}

/**
 * Project the canonical read models from a suite's OWN in-memory rows.
 *
 * The hermetic contract suites model the legacy shapes (`account_members`,
 * `project_members`, …) in a hand-rolled db shim keyed on drizzle table objects.
 * `iam/read-models` reads `role_assignments` with a join those shims answer with
 * `[]`, so a route asking "what role does this person hold" would get `member`
 * for an owner. Rather than teach seven shims a sixth table, the module is
 * mocked to project from the rows the suite already maintains.
 *
 * The canonical path itself is proved against a real database by
 * `integration-iam-assignments.test.ts` and `integration-resource-grants.test.ts`.
 */
export interface ReadModelRows {
  /** `account_members` equivalents: who is in which account, at what role. */
  members?: () => Array<{ userId: string; accountId: string; accountRole: string }>;
  /** `project_members` equivalents. */
  projectMembers?: () => Array<{
    userId: string;
    accountId: string;
    projectId: string;
    projectRole: string;
    grantedBy?: string | null;
    expiresAt?: Date | null;
    createdAt?: Date;
    updatedAt?: Date;
  }>;
}

export function mockIamReadModels(rows: ReadModelRows = {}): void {
  // No member rows supplied = the suite is not testing membership at all (the
  // sibling of mockIamEngineAllowAll). Answer `owner` for whoever asks, so the
  // membership hard-gate in loadProjectForUser / resolveProjectAccount does not
  // 403 a suite that never modelled `account_members` in the first place.
  const openMembership = rows.members === undefined;
  const members = () => rows.members?.() ?? [];
  const projectMembers = () => rows.projectMembers?.() ?? [];
  const rank: Record<string, number> = { owner: 3, admin: 2, member: 1 };
  const strongest = (values: string[]): string | null =>
    values.reduce<string | null>((best, v) => (!best || (rank[v] ?? 0) > (rank[best] ?? 0) ? v : best), null);

  mock.module('../../iam/read-models', () => ({
    isAccountManagerRole: (role: string | null | undefined) => role === 'owner' || role === 'admin',
    legacyToCanonicalPrincipal: (t: string) =>
      t === 'member' ? 'user' : t === 'token' ? 'service_account' : t === 'group' ? 'group' : null,
    accountRoleMap: async (accountId: string) =>
      new Map(
        members()
          .filter((m) => m.accountId === accountId)
          .map((m) => [m.userId, m.accountRole] as const),
      ),
    accountRolesForUser: async (userId: string) =>
      new Map(
        members()
          .filter((m) => m.userId === userId)
          .map((m) => [m.accountId, m.accountRole] as const),
      ),
    accountRoleFor: async (accountId: string, userId: string) =>
      openMembership
        ? 'owner'
        : strongest(
            members()
              .filter((m) => m.accountId === accountId && m.userId === userId)
              .map((m) => m.accountRole),
          ),
    countAccountOwners: async (accountId: string) =>
      openMembership
        ? 2
        : members().filter((m) => m.accountId === accountId && m.accountRole === 'owner').length,
    projectRoleGrants: async (filter: { accountId: string; projectId?: string; userId?: string }) =>
      projectMembers()
        .filter(
          (g) =>
            g.accountId === filter.accountId &&
            (!filter.projectId || g.projectId === filter.projectId) &&
            (!filter.userId || g.userId === filter.userId),
        )
        .map((g) => ({
          assignmentId: `${g.projectId}:${g.userId}`,
          accountId: g.accountId,
          projectId: g.projectId,
          userId: g.userId,
          projectRole: g.projectRole,
          grantedBy: g.grantedBy ?? null,
          expiresAt: g.expiresAt ?? null,
          createdAt: g.createdAt ?? new Date(0),
          updatedAt: g.updatedAt ?? new Date(0),
        })),
    projectRoleForUser: async (projectId: string, userId: string) => {
      if (rows.projectMembers === undefined) return openMembership ? 'manager' : null;
      const held = projectMembers()
        .filter((g) => g.projectId === projectId && g.userId === userId)
        .map((g) => g.projectRole);
      return held.includes('manager') ? 'manager' : (held[0] ?? null);
    },
    groupProjectGrants: async () => [],
    customRoleBindings: async () => [],
    countRoleBindings: async () => 0,
    objectGrantRows: async () => [],
    foldProjectAccess: (input: {
      accountRole: string | null;
      directRole: string | null;
      groupSources: Array<{ group_id: string; group_name: string; role: string }>;
    }) => {
      const prank: Record<string, number> = { manager: 2, member: 1 };
      let effective: string | null = null;
      let source: string | null = null;
      if (input.accountRole === 'owner' || input.accountRole === 'admin') {
        effective = 'manager';
        source = 'implicit';
      }
      if (input.directRole && (!effective || prank[input.directRole] > prank[effective])) {
        effective = input.directRole;
        source = 'direct';
      }
      for (const g of input.groupSources) {
        if (!effective || prank[g.role] > prank[effective]) {
          effective = g.role;
          source = 'group';
        }
      }
      return {
        effective_project_role: effective,
        effective_source: source,
        group_sources: [...input.groupSources].sort((a, b) => prank[b.role] - prank[a.role]),
      };
    },
  }));
}
