import type { SecretEgressPolicy } from '@kortix/db';

import type { ResolvedProjectSecret } from '../projects/secrets';
import { resolveSecretDelivery } from './strategy';

export interface NetworkBoundarySecretBinding {
  secretId: string;
  identifier: string;
  alias: string;
  hosts: string[];
  header: string;
  value: string;
  onEcho: 'block';
}

type BoundaryPolicy = Pick<SecretEgressPolicy, 'rules' | 'inject' | 'backend' | 'on_no_match' | 'tls'>;

function effectiveInjection(policy: SecretEgressPolicy, rule: SecretEgressPolicy['rules'][number]) {
  return rule.inject ?? policy.inject;
}

function sameHeaderInjection(
  left: ReturnType<typeof effectiveInjection>,
  right: ReturnType<typeof effectiveInjection>,
): boolean {
  if (left.kind !== 'header' || right.kind !== 'header') return false;
  return left.name.toLowerCase() === right.name.toLowerCase() &&
    (left.template ?? '{{secret}}') === (right.template ?? '{{secret}}');
}

/**
 * Validate only the controls the network provider can enforce.
 * Rejecting unsupported restrictions prevents a stored policy from appearing
 * narrower than the data path that applies it.
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
  if (policy.inject.kind !== 'header') {
    return 'Network-boundary delivery supports header injection only';
  }

  for (const rule of policy.rules) {
    if (rule.host.startsWith('*.')) {
      return 'Network-boundary delivery requires exact hosts';
    }
    if (rule.methods && rule.methods.length > 0) {
      return 'Network-boundary delivery cannot enforce HTTP method restrictions';
    }
    if (rule.path) {
      return 'Network-boundary delivery cannot enforce path restrictions';
    }
    if (!sameHeaderInjection(policy.inject, effectiveInjection(policy as SecretEgressPolicy, rule))) {
      return 'Every network-boundary rule must use the same header and template';
    }
  }
  return null;
}

/**
 * The (host, header) pairs a policy claims at the provider edge, lowercased —
 * the provider matches both case-insensitively. Null when the policy injects
 * somewhere other than a header, which claims no boundary destination at all.
 *
 * Save-time validation and provision-time assembly both read the pair from
 * here. A destination the save check spells differently from the provision
 * check is a destination the save check cannot protect.
 */
function boundaryDestinations(
  policy: Pick<SecretEgressPolicy, 'rules' | 'inject'>,
): { header: string; hosts: string[] } | null {
  if (policy.inject.kind !== 'header') return null;
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
 * The provider edge maps one (host, header) pair to one credential, so a second
 * claim has no defined winner. `resolveNetworkBoundaryBindings` refuses it, but
 * that happens at session provision: the project keeps its stored secrets and
 * every NEW session dies with a generic provider error that no retry can clear.
 * Callers run this at SAVE time so the author sees the collision while they can
 * still pick another header or host.
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

function renderSecret(template: string | undefined, value: string): string {
  return (template ?? '{{secret}}').split('{{secret}}').join(value);
}

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
    const inject = row.egressPolicy.inject;
    if (!destination || inject.kind !== 'header') {
      throw new Error(`${row.identifier}: invalid header injection`);
    }
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

    bindings.push({
      secretId: row.secretId,
      identifier: row.identifier,
      alias: bindingAlias(row.secretId),
      hosts: destination.hosts,
      header: destination.header,
      value: renderSecret(inject.template, row.value),
      onEcho: 'block',
    });
  }

  return bindings.sort((a, b) => a.identifier.localeCompare(b.identifier));
}
