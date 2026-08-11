import type { ResolvedWorkspaceSecret } from '../workspaces/secrets';
import { isReservedSandboxEnvName } from '../workspaces/lib/sandbox-env-names';

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const SECRET_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const NEVER_DELIVER = new Set(['SLACK_SIGNING_SECRET', 'SLACK_BOT_TOKEN']);

export interface AppRuntimeEnvironmentInput {
  environment?: Record<string, string>;
  /** Runtime environment key -> workspace secret identifier. */
  secrets?: Record<string, string>;
  availableSecrets: ResolvedWorkspaceSecret[];
}

function assertDestination(name: string): void {
  if (!ENV_NAME.test(name)) {
    throw new Error(`App environment key "${name}" is invalid`);
  }
  if (isReservedSandboxEnvName(name) || NEVER_DELIVER.has(name)) {
    throw new Error(`App environment key "${name}" is reserved`);
  }
}

/**
 * Resolve an immutable App deployment's environment at runtime creation.
 * Only identifiers are persisted in the deployment. Plaintext secret values
 * exist in memory for the provider create call and never enter the build image.
 */
export function resolveAppRuntimeEnvironment(input: AppRuntimeEnvironmentInput): {
  env: Record<string, string>;
  secretIdentifiers: string[];
} {
  const environment = input.environment ?? {};
  const mappings = input.secrets ?? {};
  if (Object.keys(environment).length > 128 || Object.keys(mappings).length > 128) {
    throw new Error('An App deployment supports at most 128 environment values and 128 secrets');
  }

  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(environment)) {
    assertDestination(name);
    if (typeof value !== 'string' || Buffer.byteLength(value) > 32_768) {
      throw new Error(`App environment value "${name}" must contain at most 32768 bytes`);
    }
    env[name] = value;
  }

  const available = new Map(
    input.availableSecrets.map((row) => [row.identifier.toUpperCase(), row]),
  );
  const identifiers = new Set<string>();
  for (const [name, identifier] of Object.entries(mappings)) {
    assertDestination(name);
    if (Object.hasOwn(environment, name)) {
      throw new Error(`App environment key "${name}" appears in both environment and secrets`);
    }
    if (!SECRET_IDENTIFIER.test(identifier)) {
      throw new Error(`App secret identifier "${identifier}" is invalid`);
    }
    const resolved = available.get(identifier.toUpperCase());
    if (!resolved) {
      throw new Error(`App secret identifier "${identifier}" does not exist`);
    }
    if (resolved.strategy && resolved.strategy !== 'runtime') {
      throw new Error(`App secret identifier "${identifier}" cannot be delivered to an App runtime`);
    }
    env[name] = resolved.value;
    identifiers.add(resolved.identifier);
  }

  return { env, secretIdentifiers: [...identifiers].sort() };
}
