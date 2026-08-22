import type { SecretEgressPolicy } from '@kortix/db';

import type { ResolvedProjectSecret } from '../projects/secrets';
import { resolveSecretDelivery } from './strategy';

/**
 * One egress-enforced secret, as a session carries it.
 *
 * There is no provider credential edge any more: every provider serves this
 * class the same way (docs/specs/2026-08-19-secrets-exposure-usage-model.md §4)
 * — the sandbox env holds a HANDLE and the broker route substitutes the real
 * value server-side, only for an approved host. So this record carries policy,
 * never credential material: no value, no rendered header value, nothing that
 * would be a secret if it were logged.
 */
export interface NetworkBoundarySecretBinding {
  secretId: string;
  identifier: string;
  alias: string;
  hosts: string[];
  /** LEGACY injection rows only — the header the broker still writes. Absent on
   *  a substitution-only row, which claims no header at all. */
  header?: string;
}

type BoundaryPolicy = Pick<SecretEgressPolicy, 'rules' | 'inject' | 'backend' | 'on_no_match' | 'tls'>;

function sameHeaderInjection(
  left: SecretEgressPolicy['inject'],
  right: SecretEgressPolicy['inject'],
): boolean {
  if (left?.kind !== 'header' || right?.kind !== 'header') return false;
  return left.name.toLowerCase() === right.name.toLowerCase() &&
    (left.template ?? '{{secret}}') === (right.template ?? '{{secret}}');
}

/** Does this policy still name an injection slot anywhere? */
function carriesInjection(policy: BoundaryPolicy): boolean {
  return policy.inject !== undefined || policy.rules.some((rule) => rule.inject !== undefined);
}

/**
 * Validate only the controls this delivery path can actually enforce.
 * Rejecting unsupported restrictions prevents a stored policy from appearing
 * narrower than the data path that applies it.
 *
 * Two shapes are valid, and the difference is `inject`:
 *
 *  - **Substitution row** (no `inject`, the default since the exposure/usage
 *    model §6). The policy is a HOST LIST. The credential goes wherever the
 *    agent's own client put the handle, so there is no header, template, method
 *    or path for this function to have an opinion about — only the host gate,
 *    HTTPS, and "no match denies" are enforceable, and only those are checked.
 *  - **Legacy injection row** (`inject` present). Served exactly as before, so
 *    it keeps every prohibition it had: header slot only, one shared header and
 *    template across rules, no method filter, no path filter.
 */
export function networkBoundaryPolicyError(policy: BoundaryPolicy): string | null {
  if (policy.backend !== undefined) {
    return 'Network-boundary delivery does not accept a broker backend';
  }
  if (policy.on_no_match !== undefined && policy.on_no_match !== 'deny') {
    return 'Network-boundary delivery must deny unmatched requests';
  }
  if (policy.tls !== undefined && policy.tls !== 'terminate') {
    return 'Network-boundary delivery requires TLS termination';
  }
  // A wildcard host applies to BOTH shapes: the agent must never choose the
  // destination, so the allow-list is exact hosts or nothing.
  for (const rule of policy.rules) {
    if (rule.host.startsWith('*.')) {
      return 'Network-boundary delivery requires exact hosts';
    }
  }

  if (!carriesInjection(policy)) return null;

  if (policy.inject === undefined) {
    return 'Network-boundary delivery cannot inject without a policy-level slot';
  }
  if (policy.inject.kind !== 'header') {
    return 'Network-boundary delivery supports header injection only';
  }
  for (const rule of policy.rules) {
    if (rule.methods && rule.methods.length > 0) {
      return 'Network-boundary delivery cannot enforce HTTP method restrictions';
    }
    if (rule.path) {
      return 'Network-boundary delivery cannot enforce path restrictions';
    }
    if (!sameHeaderInjection(policy.inject, rule.inject ?? policy.inject)) {
      return 'Every network-boundary rule must use the same header and template';
    }
  }
  return null;
}

/**
 * The (host, header) pairs a LEGACY injection policy claims, lowercased.
 *
 * Null for a substitution-only row: it writes to no fixed header, so it claims
 * no destination and cannot collide with anything.
 *
 * Save-time validation and provision-time assembly both read the pair from
 * here. A destination the save check spells differently from the provision
 * check is a destination the save check cannot protect.
 */
function boundaryDestinations(
  policy: Pick<SecretEgressPolicy, 'rules' | 'inject'>,
): { header: string; hosts: string[] } | null {
  if (policy.inject?.kind !== 'header') return null;
  return {
    header: policy.inject.name.toLowerCase(),
    hosts: [...new Set(policy.rules.map((rule) => rule.host.toLowerCase()))].sort(),
  };
}

function destinationKey(host: string, header: string): string {
  return `${host.toLowerCase()}\n${header.toLowerCase()}`;
}

export interface BoundaryDestinationConflict {
  /** The OTHER secret that already claims the destination. */
  identifier: string;
  host: string;
  header: string;
}

/**
 * The first destination the candidate shares with another secret in the project.
 *
 * ONE (host, header) pair maps to ONE credential, so a second claim on the same
 * header has no defined winner. `resolveNetworkBoundaryBindings` refuses it, but
 * that happens at session provision: the project keeps its stored secrets and
 * every NEW session dies with a generic provider error that no retry can clear.
 * Callers run this at SAVE time so the author sees the collision while they can
 * still pick another header or host.
 *
 * SUBSTITUTION rows are exempt, and that is the point of the exposure/usage
 * model §6: two of them on one host are legal, because each handle names its own
 * value and the agent's own client decides where it goes. Only inject-carrying
 * rows claim a destination, so only they can collide.
 *
 * Identifiers are compared exactly, matching the provision-time check — two rows
 * that differ only in case are two secrets to both paths, not one.
 */
export function findBoundaryDestinationConflict(
  candidate: { identifier: string; policy: Pick<SecretEgressPolicy, 'rules' | 'inject'> },
  others: Array<{ identifier: string; policy: Pick<SecretEgressPolicy, 'rules' | 'inject'> | null }>,
): BoundaryDestinationConflict | null {
  const target = boundaryDestinations(candidate.policy);
  if (!target) return null;
  const claimed = new Set(target.hosts.map((host) => destinationKey(host, target.header)));

  for (const other of others) {
    if (!other.policy || other.identifier === candidate.identifier) continue;
    const destination = boundaryDestinations(other.policy);
    if (!destination) continue;
    for (const host of destination.hosts) {
      if (claimed.has(destinationKey(host, destination.header))) {
        return { identifier: other.identifier, host, header: destination.header };
      }
    }
  }
  return null;
}

function bindingAlias(secretId: string): string {
  const compact = secretId.replace(/[^A-Za-z0-9]/g, '').slice(0, 56);
  if (!compact) throw new Error('Network-boundary secret has no stable id');
  return `KORTIX_${compact}`;
}

/**
 * Every egress-enforced secret this session may spend, validated.
 *
 * Nothing registers these anywhere any more; the value is fetched per request by
 * the broker route. What the call still buys is FAIL-CLOSED validation at
 * session provision: a policy no request path could honor throws here, and
 * `classifySandboxProvisioningFailure` turns that into
 * `invalid-secret-boundary-policy` instead of a generic "try again".
 */
export function resolveNetworkBoundaryBindings(
  rows: ResolvedProjectSecret[],
  input: {
    sessionId: string;
    agentGrantEnv: string[] | 'all' | null | undefined;
    sessionAllowlist: string[] | null | undefined;
  },
): NetworkBoundarySecretBinding[] {
  const bindings: NetworkBoundarySecretBinding[] = [];
  const destinations = new Map<string, string>();

  for (const row of rows) {
    const delivery = resolveSecretDelivery({
      identifier: row.identifier,
      strategy: row.strategy,
      agentGrantEnv: input.agentGrantEnv,
      sessionAllowlist: input.sessionAllowlist,
      sessionId: input.sessionId,
    });
    if (delivery.emit !== 'handle' || delivery.strategy !== 'egress') continue;
    if (row.consumer !== 'network') {
      throw new Error(`Network-boundary secret ${row.identifier} has an invalid consumer`);
    }
    if (!row.egressPolicy) {
      throw new Error(`Network-boundary secret ${row.identifier} has no outbound policy`);
    }
    const policyError = networkBoundaryPolicyError(row.egressPolicy);
    if (policyError) throw new Error(`${row.identifier}: ${policyError}`);

    const destination = boundaryDestinations(row.egressPolicy);
    const hosts = destination
      ? destination.hosts
      : [...new Set(row.egressPolicy.rules.map((rule) => rule.host.toLowerCase()))].sort();

    if (destination) {
      for (const host of destination.hosts) {
        const key = destinationKey(host, destination.header);
        const existing = destinations.get(key);
        if (existing && existing !== row.identifier) {
          throw new Error(
            `Network-boundary secrets ${existing} and ${row.identifier} both target ${host} header ${destination.header}`,
          );
        }
        destinations.set(key, row.identifier);
      }
    }

    bindings.push({
      secretId: row.secretId,
      identifier: row.identifier,
      alias: bindingAlias(row.secretId),
      hosts,
      ...(destination ? { header: destination.header } : {}),
    });
  }

  return bindings.sort((a, b) => a.identifier.localeCompare(b.identifier));
}
