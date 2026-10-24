import {
  POLICY_SETS_UNSUPPORTED_PROVIDERS,
  policySetNameError,
} from '@kortix/manifest-schema';

/**
 * Connector policy sets: named rule lists on one connector that an agent is
 * given with `agents.<a>.policy_sets.<slug>` in kortix.yaml. The connector's
 * own `policies:` are the base rules. The API owns the shape; these helpers
 * are what the Tools tab and the agent editor need on top of it.
 */

/**
 * Channel and computer connectors have no kortix.yaml entry, so they cannot
 * carry sets (the API answers 400 `policy_sets_unsupported`). The switcher is
 * hidden there.
 */
export function supportsPolicySets(provider: string | null | undefined): boolean {
  return !(POLICY_SETS_UNSUPPORTED_PROVIDERS as readonly string[]).includes(
    (provider ?? '').trim().toLowerCase(),
  );
}

export type PolicySetNameProblem = 'invalid' | 'taken';

/**
 * Why a name cannot be used for a new or renamed set, or null. `current` is
 * the set being renamed: keeping its own name is not a clash.
 */
export function policySetNameProblem(
  name: string,
  existing: readonly string[],
  current: string | null = null,
): PolicySetNameProblem | null {
  if (policySetNameError(name)) return 'invalid';
  if (name !== current && existing.includes(name)) return 'taken';
  return null;
}

/** The react-query key of one connector's set list. */
export function connectorPolicySetsKey(projectId: string, slug: string) {
  return ['connector-policy-sets', projectId, slug] as const;
}

/** The react-query key of one rule list: the base rules (`null`) or one set. */
export function connectorPoliciesKey(projectId: string, slug: string, policySet: string | null) {
  return ['connector-policies', projectId, slug, policySet] as const;
}
