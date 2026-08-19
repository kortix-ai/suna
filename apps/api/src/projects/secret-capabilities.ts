import { networkBoundaryPolicyError } from '../secrets/network-boundary';
import type { SecretConsumer, SecretEgressPolicy, SecretStrategy } from '../secrets/strategy';
import { resolveSecretDelivery } from '../secrets/strategy';
import { isSandboxSecretEnvNameAllowed } from './lib/sandbox-env-names';

export const SECRET_CAPABILITIES_ENV_NAME = 'KORTIX_SECRET_CAPABILITIES';

type CapabilitySource = {
  identifier: string;
  key: string;
  strategy?: SecretStrategy;
  consumer?: SecretConsumer | null;
  egressPolicy?: SecretEgressPolicy | null;
};

export type SecretCapability =
  | {
      identifier: string;
      delivery: 'sandbox';
      environment_variable: string;
    }
  | {
      identifier: string;
      delivery: 'https_broker';
      command: string;
    }
  | {
      identifier: string;
      delivery: 'kortix_service';
      consumer: Exclude<SecretConsumer, 'sandbox' | 'network' | 'http_broker'>;
    }
  | {
      identifier: string;
      delivery: 'network';
      /** The exact hosts whose requests get the header, lowercased and sorted.
       *  Every other host leaves the sandbox untouched. */
      hosts: string[];
      /** The header the boundary sets on those hosts, lowercased. The VALUE is
       *  never here — it is added outside the sandbox. */
      header: string;
      /** The boundary terminates TLS to rewrite the header, so a listed host
       *  must be called over HTTPS. Plain HTTP is refused. */
      scheme: 'https';
      /** The value is not in the sandbox in any form. */
      readable_in_sandbox: false;
      /**
       * What happens when an upstream echoes the credential back.
       *
       *  - `block`   the provider edge CUTS the response mid-flight (Platinum)
       *  - `redact`  Kortix replaces the value with `[REDACTED]` and returns
       *              the rest (the in-guest shim, which relays through the
       *              broker)
       *
       * This is not cosmetic. The two produce OPPOSITE symptoms for the same
       * working request — an empty reply versus a 200 — so an agent told the
       * wrong one misreads success as failure, or the reverse.
       */
      on_echo: 'block' | 'redact';
    };

/**
 * What an agent must know to USE a network-boundary secret, and — the reason
 * this exists — how to read the boundary's one confusing symptom.
 *
 * A response that would carry the credential back into the guest is cut, so
 * `curl` reports `curl: (52) Empty reply from server`. Against an echo endpoint
 * a WORKING boundary is byte-identical to a dead host, and an agent with no
 * other information will confabulate a network explanation for it. These lines
 * are carried once per catalog rather than once per capability: they are the
 * same for every network secret, and repeating them would spend the 48 KB
 * budget that `serializeSecretCapabilities` divides between capabilities.
 */
const SHARED_BOUNDARY_NOTES: readonly string[] = [
  'Kortix adds these credentials outside the sandbox, at the network boundary.',
  'The value is not in this sandbox: no environment variable, no file, no alias, no placeholder.',
  'Do not search for the value, do not ask the user for it, and do not build the header yourself.',
  'Send an ordinary request with no credential. The boundary sets the header in flight.',
  'Each capability lists its own `hosts` and `header`. Only those hosts get that header.',
  'HTTPS is required. Plain HTTP to a listed host is refused before it leaves the sandbox.',
]

/** Provider edge (Platinum): the echoing response is CUT. */
export const NETWORK_BOUNDARY_NOTES_BLOCK: readonly string[] = [
  ...SHARED_BOUNDARY_NOTES,
  'A response that would echo the value back into the sandbox is cut mid-flight.',
  'So `curl: (52) Empty reply from server` on a listed host means the boundary worked. The host is not down.',
  'Verify with an endpoint that CONSUMES the credential and returns 200 or 401, never one that reflects request headers.',
  'A listed host that answers 401 means the header did not arrive. Report that; do not invent a credential.',
]

/**
 * In-guest shim: the echoing response comes back REDACTED, not cut.
 *
 * The opposite symptom from the edge, which is the whole reason these are two
 * lists. Telling a shim-backed agent that an empty reply means success would
 * have it read a genuinely dead host as a working boundary — and read the real
 * success (a 200 containing `[REDACTED]`) as a failure.
 */
export const NETWORK_BOUNDARY_NOTES_REDACT: readonly string[] = [
  ...SHARED_BOUNDARY_NOTES,
  'A response that would echo the value back into the sandbox comes back with `[REDACTED]` in its place.',
  'So seeing `[REDACTED]` on a listed host means the boundary worked — that is the credential, removed on the way in.',
  'An empty reply or a connection error on a listed host is a REAL failure here. Do not read it as the boundary working.',
  'Requests are relayed through Kortix, so responses are not streamed: no SSE, no websockets, and large bodies are capped.',
  'A listed host that answers 401 means the header did not arrive. Report that; do not invent a credential.',
]

/** @deprecated Ambiguous now that two mechanisms exist. Use the mode-specific
 *  lists above; kept so an out-of-tree importer keeps compiling. */
export const NETWORK_BOUNDARY_NOTES = NETWORK_BOUNDARY_NOTES_BLOCK

export interface SecretCapabilityCatalog {
  version: 1;
  capabilities: SecretCapability[];
  /** Usage rules for a whole delivery class, present only when the catalog
   *  lists a capability of that class. */
  notes?: { network: readonly string[] };
  truncated?: boolean;
  total?: number;
}

/**
 * The (hosts, header) pair the provider edge will hold for this policy.
 *
 * An exact mirror of `boundaryDestinations` in ../secrets/network-boundary.ts,
 * which is module-private and computes the same pair for the binding that is
 * actually armed. Both lowercase, because the edge matches case-insensitively.
 * A capability that spells the destination differently from the binding tells
 * the agent to call a host the boundary is not watching — the test
 * `describes the same destination the provider edge arms` pins them together.
 */
function networkDestination(
  policy: SecretEgressPolicy,
): { header: string; hosts: string[] } | null {
  if (policy.inject.kind !== 'header') return null;
  return {
    header: policy.inject.name.toLowerCase(),
    hosts: [...new Set(policy.rules.map((rule) => rule.host.toLowerCase()))].sort(),
  };
}

function hasNetworkCapability(capabilities: readonly SecretCapability[]): boolean {
  return capabilities.some((capability) => capability.delivery === 'network');
}

function isKortixServiceConsumer(
  value: SecretConsumer | null | undefined,
): value is Exclude<SecretConsumer, 'sandbox' | 'network' | 'http_broker'> {
  return (
    value === 'llm_gateway' ||
    value === 'connector' ||
    value === 'git_proxy'
  );
}

export function buildSecretCapabilities(
  rows: CapabilitySource[],
  input: {
    grantEnv?: string[] | 'all';
    sessionAllowlist?: string[] | null;
    sessionId?: string | null;
    /**
     * Which mechanism actually serves this session's boundary secrets.
     *
     * Defaults to the provider edge. That is the conservative default for a
     * caller that has not been updated: `block` is what Platinum has always
     * done, so an un-passed mode keeps the pre-shim wording rather than
     * inventing a claim about a mechanism the caller never named.
     */
    boundaryMode?: 'provider-edge' | 'in-guest-shim' | null;
  },
): SecretCapabilityCatalog {
  const echo = input.boundaryMode === 'in-guest-shim' ? 'redact' : 'block';
  const capabilities: SecretCapability[] = [];

  for (const row of rows) {
    const delivery = resolveSecretDelivery({
      identifier: row.identifier,
      strategy: row.strategy,
      agentGrantEnv: input.grantEnv ?? null,
      sessionAllowlist: input.sessionAllowlist ?? null,
      sessionId: input.sessionId ?? null,
    });
    if (delivery.emit === 'nothing') continue;

    const consumer =
      row.consumer ??
      (delivery.strategy === 'runtime'
        ? 'sandbox'
        : row.egressPolicy?.backend === 'kortix_fetch'
          ? 'http_broker'
          : (row.egressPolicy?.backend ?? null));

    if (
      delivery.emit === 'plaintext' &&
      consumer === 'sandbox' &&
      isSandboxSecretEnvNameAllowed(row.key)
    ) {
      capabilities.push({
        identifier: row.identifier,
        delivery: 'sandbox',
        environment_variable: row.key,
      });
      continue;
    }

    // Network boundary. The identifier, its hosts and its header are policy,
    // not secret material, so they are safe to name; the value and the header
    // TEMPLATE stay out, because an agent that can read the shape of the header
    // starts trying to assemble one.
    //
    // Only a policy the boundary can actually enforce is advertised:
    // `resolveNetworkBoundaryBindings` throws on anything else, so a session
    // carrying one never reaches the agent at all.
    if (
      delivery.emit === 'handle' &&
      delivery.strategy === 'egress' &&
      consumer === 'network' &&
      row.egressPolicy &&
      !networkBoundaryPolicyError(row.egressPolicy)
    ) {
      const destination = networkDestination(row.egressPolicy);
      if (destination) {
        capabilities.push({
          identifier: row.identifier,
          delivery: 'network',
          hosts: destination.hosts,
          header: destination.header,
          scheme: 'https',
          readable_in_sandbox: false,
          on_echo: echo,
        });
      }
      continue;
    }

    if (
      delivery.emit === 'handle' &&
      delivery.strategy === 'broker' &&
      consumer === 'http_broker' &&
      row.egressPolicy?.backend === 'kortix_fetch'
    ) {
      capabilities.push({
        identifier: row.identifier,
        delivery: 'https_broker',
        command: `kortix secrets call ${row.identifier} <https-url> [options]`,
      });
      continue;
    }

    if (delivery.strategy === 'broker' && isKortixServiceConsumer(consumer)) {
      capabilities.push({
        identifier: row.identifier,
        delivery: 'kortix_service',
        consumer,
      });
    }
  }

  capabilities.sort((a, b) => a.identifier.localeCompare(b.identifier));
  return {
    version: 1,
    capabilities,
    ...(hasNetworkCapability(capabilities)
      ? {
          notes: {
            network: echo === 'redact' ? NETWORK_BOUNDARY_NOTES_REDACT : NETWORK_BOUNDARY_NOTES_BLOCK,
          },
        }
      : {}),
  };
}

export function serializeSecretCapabilities(catalog: SecretCapabilityCatalog): string {
  const maxBytes = 48 * 1024;
  const serialized = JSON.stringify(catalog);
  if (Buffer.byteLength(serialized, 'utf8') <= maxBytes) return serialized;

  // The notes travel with the capabilities they explain: dropped when
  // truncation leaves no network capability, and counted against the budget
  // when it does, so the payload cannot exceed the cap by adding them last.
  const notes = catalog.notes ?? { network: NETWORK_BOUNDARY_NOTES_BLOCK };
  const build = (kept: SecretCapability[]): SecretCapabilityCatalog => ({
    version: 1,
    capabilities: kept,
    ...(hasNetworkCapability(kept) ? { notes } : {}),
    truncated: true,
    total: catalog.capabilities.length,
  });

  const capabilities: SecretCapability[] = [];
  for (const capability of catalog.capabilities) {
    const candidate = build([...capabilities, capability]);
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > maxBytes) break;
    capabilities.push(capability);
  }
  return JSON.stringify(build(capabilities));
}
