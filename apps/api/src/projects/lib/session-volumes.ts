/**
 * `KORTIX_VOLUMES` — the volumes one agent's session mounts (kortix.yaml
 * `volumes:` + `agents.<name>.volumes`), resolved for the sandbox daemon.
 *
 * It carries NO credential value. Each credential is named by the env var the
 * session's ordinary secret delivery already put in the sandbox, and the
 * daemon reads the value from its own project env store. So volumes open no
 * second path for secrets into the box: the agent's `secrets` grant stays the
 * only gate. A credential that grant does not deliver as plaintext fails that
 * one volume with a reason the agent can read; the session still boots.
 */
import {
  type ResolvedAgentVolume,
  type VolumeBlockV2,
  type VolumeModeV2,
  VOLUME_CREDENTIAL_KEYS,
} from '@kortix/manifest-schema';
import type { SecretCapabilityCatalog } from '../secret-capabilities';

export const SESSION_VOLUMES_ENV_NAME = 'KORTIX_VOLUMES';

type MountableVolume = {
  name: string;
  mode: VolumeModeV2;
  type: 's3';
  bucket: string;
  prefix?: string;
  region?: string;
  endpoint?: string;
  /** Env var holding the access key id. Absent for a public bucket. */
  access_key_id_env?: string;
  /** Env var holding the secret access key. Absent for a public bucket. */
  secret_access_key_env?: string;
};

type FailedVolume = { name: string; mode: VolumeModeV2; error: string };

export type SessionVolumeSpec = MountableVolume | FailedVolume;

/** The env var a mount reads a credential from, or why it cannot. */
function resolveCredentialEnv(
  identifier: string,
  catalog: SecretCapabilityCatalog,
  agentName: string,
): { env: string } | { error: string } {
  const capability = catalog.capabilities.find(
    (entry) => entry.identifier.toUpperCase() === identifier.toUpperCase(),
  );
  if (!capability) {
    return {
      error: `credential secret "${identifier}" is not delivered to this session: it must exist in the project and be granted in agents.${agentName}.secrets`,
    };
  }
  if (capability.delivery !== 'sandbox' || !capability.environment_variable) {
    return {
      error: `credential secret "${identifier}" uses ${capability.delivery} delivery; a volume mount needs the value in the sandbox, so set the secret's exposure to Environment`,
    };
  }
  return { env: capability.environment_variable };
}

function specFor(
  name: string,
  mode: VolumeModeV2,
  volume: VolumeBlockV2,
  catalog: SecretCapabilityCatalog,
  agentName: string,
): SessionVolumeSpec {
  const spec: MountableVolume = { name, mode, type: 's3', bucket: volume.bucket };
  if (volume.prefix) spec.prefix = volume.prefix;
  if (volume.region) spec.region = volume.region;
  if (volume.endpoint) spec.endpoint = volume.endpoint;
  for (const key of VOLUME_CREDENTIAL_KEYS) {
    const identifier = volume[key];
    if (!identifier) continue;
    const resolved = resolveCredentialEnv(identifier, catalog, agentName);
    if ('error' in resolved) return { name, mode, error: resolved.error };
    spec[`${key}_env`] = resolved.env;
  }
  return spec;
}

/** The daemon-facing spec for every volume attached to `agentName`. */
export function buildSessionVolumes(
  attached: readonly ResolvedAgentVolume[],
  catalog: SecretCapabilityCatalog,
  agentName: string,
): SessionVolumeSpec[] {
  return attached.map(({ name, mode, volume }) =>
    volume
      ? specFor(name, mode, volume, catalog, agentName)
      : {
          name,
          mode,
          error: `volume "${name}" is not declared under volumes: in kortix.yaml, or its block is invalid (run \`kortix validate\`)`,
        },
  );
}

/** The `KORTIX_VOLUMES` value, or null when the agent attaches no volume. */
export function serializeSessionVolumes(specs: readonly SessionVolumeSpec[]): string | null {
  return specs.length > 0 ? JSON.stringify({ version: 1, volumes: specs }) : null;
}
