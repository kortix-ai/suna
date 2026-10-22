import * as P from '../rest/projects-client';
export function bindIam() {
  return {
    /** The grant table. One row per (principal, role, scope, object). */
    assignments: {
      list: P.listAssignments,
      create: P.createAssignment,
      revoke: P.revokeAssignment,
    },
    /** The permission catalog as data — action, scope, delegability, implications. */
    permissions: {
      list: P.listPermissions,
      /** The leaves one role carries. */
      forRole: P.getRolePermissions,
    },
    roles: {
      list: P.listRoles,
      create: P.createRole,
      update: P.updateRole,
      setPermissions: P.updateRolePermissions,
      remove: P.deleteRole,
      usage: P.getRoleUsage,
    },
    groups: {
      list: P.listGroups,
      get: P.getGroup,
      create: P.createGroup,
      update: P.updateGroup,
      remove: P.deleteGroup,
      members: {
        list: P.listGroupMembers,
        add: P.addGroupMembers,
        remove: P.removeGroupMember,
      },
    },
    /** Auto-provisioned agent identities — the principal picker for binding a
     *  role to an agent. */
    agentIdentities: P.listAgentIdentities,
    /** "Sign in with Kortix" app registry — pair a client with `createKortixAuth`
     *  from `@kortix/sdk/server`. The secret is returned once, on create/rotate. */
    oauthClients: {
      list: P.listOAuthClients,
      get: P.getOAuthClient,
      create: P.createOAuthClient,
      update: P.updateOAuthClient,
      rotateSecret: P.rotateOAuthClientSecret,
      remove: P.deleteOAuthClient,
    },
    /** Ask the engine. This is the ONLY authorization read a client should make:
     *  probe the LEAF a route asserts, never a role label. */
    can: P.probeEffectivePermission,
    /** Batch probe — one roundtrip for N leaves. */
    canBatch: P.probeEffectivePermissions,
  };

  /**
   * Billing read surface — credits, subscription, tier, and transaction
   * history for entitlement-gating + a billing/usage UI. Checkout/portal/
   * credit-purchase/subscription MUTATIONS stay app-owned (Stripe flows) —
   * this is reads only.
   */
}
