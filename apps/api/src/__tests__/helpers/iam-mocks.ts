// Shared IAM test mocks. The real IAM engine + membership-sync hit
// iam_roles/iam_policies/account_groups tables that the suites' lightweight db
// mocks don't model, so authz-agnostic suites bypass them here instead of
// re-declaring the same blocks in every file.
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

/** No-op the IAM policy-sync writes (project/member grant + revoke). */
export function mockIamMembershipSyncNoop(): void {
  mock.module('../../iam/membership-sync', () => ({
    syncMemberAccountPolicy: async () => {},
    removeMemberPolicies: async () => {},
    removeProjectPoliciesForMember: async () => {},
    syncProjectMemberPolicy: async () => {},
    removeProjectMemberPolicy: async () => {},
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
  }));
}
