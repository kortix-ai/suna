// Client wrappers for /v1/accounts/:accountId/iam/* — groups, policies,
// roles, super-admin promotion, and effective-permissions probe.


export type ResourceType =
  | 'account'
  | 'project'
  | 'sandbox'
  | 'trigger'
  | 'channel'
  | 'member'
  | 'group';

/** Scope a policy can target. Superset of ResourceType — adds container
 *  scopes the engine resolves at match time (currently: project_group). */
export type PolicyScopeType = ResourceType | 'project_group';

export type PrincipalType = 'member' | 'group' | 'token';

export interface AccountGroup {
  group_id: string;
  name: string;
  description: string | null;
  source: 'manual' | 'scim';
  external_id?: string | null;
  member_count?: number;
  /** Number of project_group_grants for this group. */
  project_count?: number;
  created_at: string;
  updated_at: string;
}

export interface GroupMember {
  user_id: string;
  added_at: string;
  added_by: string | null;
}

export interface IamRole {
  role_id: string;
  key: string;
  name: string;
  description: string | null;
  resource_type: ResourceType;
  is_system: boolean;
  account_id: string | null;
}

export type IamPolicyEffect = 'allow' | 'deny';

/**
 * Optional gating conditions on a policy. The engine evaluates these at
 * request time — a policy whose conditions don't pass is silent (acts as
 * if it didn't exist). Keys compose with AND.
 *
 *   ip_cidrs:    request IP must fall in one of these CIDRs / bare IPs.
 *   require_mfa: session must be MFA-verified (Supabase aal2).
 *
 * Empty object means "no conditions" (always applies).
 */
export interface PolicyConditions {
  ip_cidrs?: string[];
  require_mfa?: boolean;
}

export interface IamPolicy {
  policy_id: string;
  principal_type: PrincipalType;
  principal_id: string;
  scope_type: PolicyScopeType;
  scope_id: string | null;
  role_id: string;
  effect: IamPolicyEffect;
  conditions: PolicyConditions;
  /** Optional hard expiry. ISO-8601 string. NULL = permanent. */
  expires_at?: string | null;
  created_by: string | null;
  created_at: string;
}

export interface EffectivePermissionProbe {
  allowed: boolean;
  reason: string | null;
  action: string;
  resource_type: ResourceType;
}
