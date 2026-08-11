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
    };

export interface SecretCapabilityCatalog {
  version: 1;
  capabilities: SecretCapability[];
  truncated?: boolean;
  total?: number;
}

function isdoscoServiceConsumer(
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

    if (delivery.strategy === 'broker' && isdoscoServiceConsumer(consumer)) {
      capabilities.push({
        identifier: row.identifier,
        delivery: 'kortix_service',
        consumer,
      });
    }
  }

  capabilities.sort((a, b) => a.identifier.localeCompare(b.identifier));
  return { version: 1, capabilities };
}

export function serializeSecretCapabilities(catalog: SecretCapabilityCatalog): string {
  const maxBytes = 48 * 1024;
  const serialized = JSON.stringify(catalog);
  if (Buffer.byteLength(serialized, 'utf8') <= maxBytes) return serialized;

  const capabilities: SecretCapability[] = [];
  for (const capability of catalog.capabilities) {
    const candidate: SecretCapabilityCatalog = {
      version: 1,
      capabilities: [...capabilities, capability],
      truncated: true,
      total: catalog.capabilities.length,
    };
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > maxBytes) break;
    capabilities.push(capability);
  }
  return JSON.stringify({
    version: 1,
    capabilities,
    truncated: true,
    total: catalog.capabilities.length,
  } satisfies SecretCapabilityCatalog);
}
