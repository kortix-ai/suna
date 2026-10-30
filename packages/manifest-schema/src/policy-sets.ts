/**
 * Connector policy sets: named rule sets on one connector that an agent can
 * be given (`connectors[].policy_sets`, `agents.<name>.policy_sets`).
 *
 * Dependency-free (like `connector-headers.ts`) so the validator, the JSON
 * Schema and apps/api's parser share one ruleset without an import cycle.
 *
 * Manifest versions: kortix_version 2 and 3 only. A v1 manifest that declares
 * either key gets an error.
 */
import type { ManifestIssue } from './index';

/** A set name. `base` is reserved: it names the connector's base rules. */
export const POLICY_SET_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const RESERVED_POLICY_SET_NAME = 'base';
export const MAX_POLICY_SETS_PER_CONNECTOR = 32;
export const MAX_RULES_PER_POLICY_SET = 200;
/** Providers whose connectors have no manifest entry sync writes back. */
export const POLICY_SETS_UNSUPPORTED_PROVIDERS = ['channel', 'computer'] as const;

const ACTIONS = ['always_run', 'require_approval', 'block'];

function isTable(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The reason a set name is refused, or null when it is valid. */
export function policySetNameError(name: unknown): string | null {
  if (typeof name !== 'string' || !POLICY_SET_NAME_RE.test(name)) {
    return 'a policy set name is lowercase letters, digits, "_" or "-" (at most 64 characters).';
  }
  if (name === RESERVED_POLICY_SET_NAME) return '"base" is reserved: it names the connector\'s base rules.';
  return null;
}

/** Shape check of one rule list (`policies` or a set's `policies`). */
export function validatePolicyRuleList(policies: unknown, where: string, issues: ManifestIssue[]): void {
  if (policies === undefined) return;
  if (!Array.isArray(policies)) {
    issues.push({ path: where, message: 'must be an array of tables.', severity: 'error' });
    return;
  }
  policies.forEach((p, j) => {
    const pwhere = `${where}[${j}]`;
    if (!isTable(p)) {
      issues.push({ path: pwhere, message: 'must be a table.', severity: 'error' });
      return;
    }
    if (typeof p.match !== 'string' || !p.match.trim()) {
      issues.push({ path: `${pwhere}.match`, message: 'match glob is required.', severity: 'error' });
    }
    const action = typeof p.action === 'string' ? p.action.trim().toLowerCase() : '';
    if (!ACTIONS.includes(action)) {
      issues.push({
        path: `${pwhere}.action`,
        message: `action must be one of: ${ACTIONS.join(', ')} (got "${action || 'unset'}").`,
        severity: 'error',
      });
    }
  });
}

/** `connectors[i].policy_sets`: a map of set name → `{ description?, policies? }`. */
export function validateConnectorPolicySets(
  entry: Record<string, unknown>,
  where: string,
  issues: ManifestIssue[],
  version: number,
): void {
  const sets = entry.policy_sets;
  if (sets === undefined) return;
  const path = `${where}.policy_sets`;
  if (version < 2) {
    issues.push({ path, message: 'policy sets need kortix_version 2 or 3.', severity: 'error' });
    return;
  }
  const provider = typeof entry.provider === 'string' ? entry.provider.trim().toLowerCase() : '';
  if ((POLICY_SETS_UNSUPPORTED_PROVIDERS as readonly string[]).includes(provider)) {
    issues.push({ path, message: `${provider} connectors cannot carry policy sets.`, severity: 'error' });
    return;
  }
  if (!isTable(sets)) {
    issues.push({ path, message: 'must be a map of set name → { description, policies }.', severity: 'error' });
    return;
  }
  const names = Object.keys(sets);
  if (names.length > MAX_POLICY_SETS_PER_CONNECTOR) {
    issues.push({ path, message: `at most ${MAX_POLICY_SETS_PER_CONNECTOR} policy sets per connector.`, severity: 'error' });
  }
  for (const name of names) {
    const swhere = `${path}.${name}`;
    const nameError = policySetNameError(name);
    if (nameError) issues.push({ path: swhere, message: nameError, severity: 'error' });
    const set = sets[name];
    if (!isTable(set)) {
      issues.push({ path: swhere, message: 'must be a table with `description` and `policies`.', severity: 'error' });
      continue;
    }
    for (const key of Object.keys(set)) {
      if (key !== 'description' && key !== 'policies') {
        issues.push({ path: `${swhere}.${key}`, message: 'a policy set holds only `description` and `policies`.', severity: 'error' });
      }
    }
    if (set.description !== undefined && typeof set.description !== 'string') {
      issues.push({ path: `${swhere}.description`, message: 'must be a string.', severity: 'error' });
    }
    if (Array.isArray(set.policies) && set.policies.length > MAX_RULES_PER_POLICY_SET) {
      issues.push({ path: `${swhere}.policies`, message: `at most ${MAX_RULES_PER_POLICY_SET} rules per policy set.`, severity: 'error' });
    }
    validatePolicyRuleList(set.policies, `${swhere}.policies`, issues);
  }
}

/** The set names each connector declares, by slug. */
function declaredSets(connectors: unknown): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  if (!Array.isArray(connectors)) return out;
  for (const entry of connectors) {
    if (!isTable(entry) || typeof entry.slug !== 'string') continue;
    out.set(entry.slug.trim(), new Set(isTable(entry.policy_sets) ? Object.keys(entry.policy_sets) : []));
  }
  return out;
}

/** The connector slugs an agent block grants: `'all'`, or a list. */
function grantedConnectors(block: Record<string, unknown>): 'all' | Set<string> {
  const value = block.connectors;
  if (value === 'all' || value === '*') return 'all';
  if (Array.isArray(value)) {
    if (value.includes('*')) return 'all';
    return new Set(value.filter((v): v is string => typeof v === 'string').map((v) => v.trim()));
  }
  return new Set();
}

/**
 * `agents.<name>.policy_sets` cross-check (v2 and v3 map-shaped agents).
 *
 * - The value must be a map of connector slug → set name.
 * - A set that the connector does not declare, or the reserved `base`, is an
 *   ERROR. The runtime keeps the entry and blocks the connector for that
 *   agent (`policy_set_missing`), so the agent itself stays declared.
 * - A slug that is not a declared connector, or not granted to the agent, is a
 *   WARNING: the agent cannot call that connector, so the entry does nothing.
 *   Channel connectors are reachable through the channel allowance, so only
 *   an undeclared slug warns for them.
 */
export function validateAgentPolicySetRefs(
  agents: unknown,
  connectors: unknown,
  path: string,
  issues: ManifestIssue[],
): void {
  if (!isTable(agents)) return;
  const sets = declaredSets(connectors);
  for (const [agent, block] of Object.entries(agents)) {
    if (!isTable(block) || block.policy_sets === undefined) continue;
    const where = `${path}.${agent}.policy_sets`;
    const map = block.policy_sets;
    if (!isTable(map)) {
      issues.push({ path: where, message: 'must be a map of connector slug → policy set name.', severity: 'error' });
      continue;
    }
    const granted = grantedConnectors(block);
    for (const [slug, setName] of Object.entries(map)) {
      const ewhere = `${where}.${slug}`;
      if (typeof setName !== 'string' || !setName.trim()) {
        issues.push({ path: ewhere, message: 'must be a policy set name.', severity: 'error' });
        continue;
      }
      const declared = sets.get(slug);
      if (!declared) {
        issues.push({ path: ewhere, message: `"${slug}" is not a declared connector with policy sets; the entry does nothing.`, severity: 'warning' });
        continue;
      }
      if (granted !== 'all' && !granted.has(slug)) {
        issues.push({ path: ewhere, message: `agent "${agent}" is not granted connector "${slug}"; the entry does nothing.`, severity: 'warning' });
      }
      if (setName === RESERVED_POLICY_SET_NAME) {
        issues.push({ path: ewhere, message: 'remove the entry to use the base rules; "base" is not a set name.', severity: 'error' });
      } else if (!declared.has(setName)) {
        issues.push({
          path: ewhere,
          message: `connector "${slug}" has no policy set "${setName}"${declared.size ? ` (sets: ${[...declared].join(', ')})` : ''}. Calls on it by this agent are blocked until it exists.`,
          severity: 'error',
        });
      }
    }
  }
}
