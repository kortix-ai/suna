import type { SecretEgressPolicy } from '@kortix/db';

import type { ResolvedWorkspaceSecret } from '../workspaces/secrets';
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

function bindingAlias(secretId: string): string {
  const compact = secretId.replace(/[^A-Za-z0-9]/g, '').slice(0, 56);
  if (!compact) throw new Error('Network-boundary secret has no stable id');
  return `KORTIX_${compact}`;
}

function renderSecret(template: string | undefined, value: string): string {
  return (template ?? '{{secret}}').split('{{secret}}').join(value);
}

export function resolveNetworkBoundaryBindings(
  rows: ResolvedWorkspaceSecret[],
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

    const inject = row.egressPolicy.inject;
    if (inject.kind !== 'header') throw new Error(`${row.identifier}: invalid header injection`);
    const header = inject.name.toLowerCase();
    const hosts = [...new Set(row.egressPolicy.rules.map((rule) => rule.host.toLowerCase()))].sort();
    for (const host of hosts) {
      const destination = `${host}\n${header}`;
      const existing = destinations.get(destination);
      if (existing && existing !== row.identifier) {
        throw new Error(
          `Network-boundary secrets ${existing} and ${row.identifier} both target ${host} header ${header}`,
        );
      }
      destinations.set(destination, row.identifier);
    }

    bindings.push({
      secretId: row.secretId,
      identifier: row.identifier,
      alias: bindingAlias(row.secretId),
      hosts,
      header,
      value: renderSecret(inject.template, row.value),
      onEcho: 'block',
    });
  }

  return bindings.sort((a, b) => a.identifier.localeCompare(b.identifier));
}
