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
      /** The env var that holds this secret's HANDLE — a self-describing
       *  placeholder, safe to log, worth nothing off an approved host. */
      environment_variable: string;
      /** The exact hosts whose requests get the real value substituted for the
       *  handle, lowercased and sorted. Every other host receives the handle
       *  itself and fails. */
      hosts: string[];
      /** Kortix terminates TLS to substitute, so a listed host must be called
       *  over HTTPS. Plain HTTP is refused. */
      scheme: 'https';
      /** The value is not in the sandbox in any form. */
      readable_in_sandbox: false;
      /** An upstream that echoes the credential back gets it replaced with
       *  `[REDACTED]` on the way in. One mechanism, one symptom. */
      on_echo: 'redact';
    };

/**
 * What an agent must know to USE an egress-enforced secret.
 *
 * ONE list, because there is now ONE mechanism on every provider (docs/specs/
 * 2026-08-19-secrets-exposure-usage-model.md §4). The env var holds a handle,
 * Kortix substitutes the real value outside the sandbox on an approved host,
 * and an echoed credential comes back as `[REDACTED]`.
 *
 * The last line matters as much as the first: without it, an agent whose
 * request could not be intercepted has no next move and starts asking a human
 * for the raw value. These lines are carried once per catalog rather than once
 * per capability — they are the same for every such secret, and repeating them
 * would spend the 48 KB budget `serializeSecretCapabilities` divides between
 * capabilities.
 */
export const NETWORK_BOUNDARY_NOTES: readonly string[] = [
  'Use the environment variable exactly as you would use the real credential: put it in the header, query string or body your client already builds. `Authorization: Bearer $VAR`, `Cookie: session=$VAR`, an `X-Api-Key` header, a query parameter and a JSON/form body field all work — Kortix substitutes the handle wherever it appears.',
  'The variable holds a HANDLE, not the value. Kortix swaps the handle for the real credential outside the sandbox.',
  'The value is not in this sandbox: no environment variable, no file, no alias. Do not search for it and do not ask the user for it.',
  'Send the handle as-is. Do NOT base64-encode it yourself first — for example HTTP Basic auth (`curl -u $VAR:` / `Authorization: Basic <base64>`) hides the handle inside a base64 blob Kortix cannot find, so the swap does not happen. Put the handle in a Bearer/token header, a query parameter or a body field instead.',
  'The swap happens only on the `hosts` this capability lists, over HTTPS. Sent anywhere else the handle arrives as a literal string and the request fails.',
  'If a response reflects the credential straight back, Kortix scrubs the obvious copies to `[REDACTED]`. This is best-effort reflection-scrubbing, not proof of success: a `[REDACTED]` is a hint the substitution ran, not a guarantee, and a host can still transform the value past the scrub.',
  'An empty reply or a connection error on a listed host is a REAL failure. Do not read it as the substitution working.',
  'Requests to a listed host are relayed through Kortix, so responses are not streamed: no SSE, no websockets, and large bodies are capped (1 MiB request, 5 MiB response).',
  'A listed host that answers 401 means the swap did not happen. Report that; do not invent a credential.',
  'If a request cannot be relayed, run `kortix secrets call <identifier> <https-url> [options]` — the explicit door to the same hosts and the same policy.',
]

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
 * The hosts this policy admits, lowercased and sorted.
 *
 * An exact mirror of the host set `resolveNetworkBoundaryBindings` computes for
 * the same row. A capability that spells a host differently from the binding
 * tells the agent to call a host the substitution does not cover — the test
 * `describes the same hosts the session binding carries` pins them together.
 */
function networkHosts(policy: SecretEgressPolicy): string[] {
  return [...new Set(policy.rules.map((rule) => rule.host.toLowerCase()))].sort();
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
  },
): SecretCapabilityCatalog {
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

    // Egress-enforced. The identifier, the env var and the hosts are policy,
    // not secret material, so they are safe to name; nothing about the shape of
    // the credential is here, because an agent that can read that starts trying
    // to assemble one.
    //
    // Only a policy this path can actually enforce is advertised:
    // `resolveNetworkBoundaryBindings` throws on anything else, so a session
    // carrying one never reaches the agent at all.
    if (
      delivery.emit === 'handle' &&
      delivery.strategy === 'egress' &&
      consumer === 'network' &&
      row.egressPolicy &&
      !networkBoundaryPolicyError(row.egressPolicy) &&
      isSandboxSecretEnvNameAllowed(row.key)
    ) {
      capabilities.push({
        identifier: row.identifier,
        delivery: 'network',
        environment_variable: row.key,
        hosts: networkHosts(row.egressPolicy),
        scheme: 'https',
        readable_in_sandbox: false,
        on_echo: 'redact',
      });
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
    ...(hasNetworkCapability(capabilities) ? { notes: { network: NETWORK_BOUNDARY_NOTES } } : {}),
  };
}

export function serializeSecretCapabilities(catalog: SecretCapabilityCatalog): string {
  const maxBytes = 48 * 1024;
  const serialized = JSON.stringify(catalog);
  if (Buffer.byteLength(serialized, 'utf8') <= maxBytes) return serialized;

  // The notes travel with the capabilities they explain: dropped when
  // truncation leaves no network capability, and counted against the budget
  // when it does, so the payload cannot exceed the cap by adding them last.
  const notes = catalog.notes ?? { network: NETWORK_BOUNDARY_NOTES };
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
