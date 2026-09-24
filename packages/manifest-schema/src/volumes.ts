/**
 * `volumes:` (kortix_version 2) — storage the user already owns, mounted into
 * an agent's sandbox as an ordinary directory at `/volumes/<name>`.
 *
 * Kortix hosts none of it. A volume is a pointer (bucket, prefix, endpoint)
 * plus the IDENTIFIERS of the project secrets that hold its credentials — never
 * a credential value, because kortix.yaml is committed.
 *
 * Credentials ride the agent's existing `secrets` grant (the sole gate on
 * secret access, see AgentBlockV2.secrets): an agent that attaches a volume
 * must also be granted that volume's credential secrets. The mount runs inside
 * the agent's own sandbox, where the agent has sudo, so attaching a volume IS
 * handing its credentials to that agent — the grant says so out loud.
 *
 * One module for the imperative validator, the JSON Schema and apps/api's
 * session resolver, so the three cannot disagree about what a volume is.
 * Dependency-free at runtime (type-only import below) for the same cycle
 * reason as `constants.ts`.
 */
import type { ManifestIssue } from './index';
import { SLUG_RE } from './constants';

export const VOLUME_TYPES = ['s3'] as const;
export type VolumeTypeV2 = (typeof VOLUME_TYPES)[number];

export const VOLUME_MODES = ['read-only', 'read-write'] as const;
export type VolumeModeV2 = (typeof VOLUME_MODES)[number];

/** Every volume mounts at `${VOLUME_MOUNT_ROOT}/<name>` inside the sandbox. */
export const VOLUME_MOUNT_ROOT = '/volumes';

/** S3 and S3-compatible bucket names (AWS, R2, GCS interop, MinIO, Tigris). */
export const VOLUME_BUCKET_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
/** A project secret identifier — same shape the sandbox capability catalog accepts. */
export const VOLUME_SECRET_IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export const VOLUME_KEYS = [
  'type',
  'bucket',
  'prefix',
  'region',
  'endpoint',
  'access_key_id',
  'secret_access_key',
] as const;

export const VOLUME_CREDENTIAL_KEYS = ['access_key_id', 'secret_access_key'] as const;

/** One entry of the top-level `volumes:` map. */
export interface VolumeBlockV2 {
  type: VolumeTypeV2;
  bucket: string;
  /** Path inside the bucket; the mount shows only this subtree. */
  prefix?: string;
  region?: string;
  /** S3-compatible endpoint URL. Omit for AWS S3. */
  endpoint?: string;
  /** Secret identifier holding the access key id. Omit both for a public bucket. */
  access_key_id?: string;
  /** Secret identifier holding the secret access key. */
  secret_access_key?: string;
}

/** `agents.<name>.volumes`: a list (all read-only) or a name → mode map. */
export type AgentVolumesV2 = string[] | Record<string, VolumeModeV2>;

export interface AgentVolumeAttachment {
  name: string;
  mode: VolumeModeV2;
}

/** A volume attached to one agent, joined to its declaration. */
export interface ResolvedAgentVolume extends AgentVolumeAttachment {
  /** Null when the name is not declared under `volumes:` or the block is invalid. */
  volume: VolumeBlockV2 | null;
}

function isTable(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isVolumeMode(value: unknown): value is VolumeModeV2 {
  return typeof value === 'string' && (VOLUME_MODES as readonly string[]).includes(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Lenient read of `agents.<name>.volumes` for runtime callers. Invalid entries
 * are dropped (the validator reports them at commit time); a list entry is
 * read-only, and a duplicate name keeps its first occurrence.
 */
export function parseAgentVolumes(value: unknown): AgentVolumeAttachment[] {
  const out: AgentVolumeAttachment[] = [];
  const seen = new Set<string>();
  const add = (name: unknown, mode: VolumeModeV2) => {
    if (typeof name !== 'string' || !SLUG_RE.test(name.trim()) || seen.has(name.trim())) return;
    seen.add(name.trim());
    out.push({ name: name.trim(), mode });
  };
  if (Array.isArray(value)) {
    for (const name of value) add(name, 'read-only');
  } else if (isTable(value)) {
    for (const [name, mode] of Object.entries(value)) if (isVolumeMode(mode)) add(name, mode);
  }
  return out;
}

/** Lenient read of one `volumes.<name>` block; null when it cannot be mounted. */
export function parseVolumeBlock(value: unknown): VolumeBlockV2 | null {
  if (!isTable(value) || value.type !== 's3') return null;
  const bucket = optionalString(value.bucket);
  if (!bucket || !VOLUME_BUCKET_RE.test(bucket)) return null;
  const block: VolumeBlockV2 = { type: 's3', bucket };
  const prefix = optionalString(value.prefix);
  if (prefix !== undefined) {
    if (!isSafePrefix(prefix)) return null;
    block.prefix = prefix;
  }
  const region = optionalString(value.region);
  if (region !== undefined) block.region = region;
  const endpoint = optionalString(value.endpoint);
  if (endpoint !== undefined) {
    if (!isHttpUrl(endpoint)) return null;
    block.endpoint = endpoint;
  }
  const accessKeyId = optionalString(value.access_key_id);
  const secretAccessKey = optionalString(value.secret_access_key);
  if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) return null;
  if (accessKeyId && secretAccessKey) {
    block.access_key_id = accessKeyId;
    block.secret_access_key = secretAccessKey;
  }
  return block;
}

/**
 * The volumes one agent receives, joined to their declarations. Pure: takes
 * the parsed (import-merged) manifest. Empty for a non-v2 manifest, an unknown
 * agent, or an agent with no `volumes`.
 */
export function resolveAgentVolumes(
  manifest: Record<string, unknown>,
  agentName: string,
): ResolvedAgentVolume[] {
  if (manifest.kortix_version !== 2 || !isTable(manifest.agents)) return [];
  const agent = manifest.agents[agentName];
  if (!isTable(agent)) return [];
  const declared = isTable(manifest.volumes) ? manifest.volumes : {};
  return parseAgentVolumes(agent.volumes).map((attachment) => ({
    ...attachment,
    volume: parseVolumeBlock(declared[attachment.name]),
  }));
}

/** The secret identifiers a volume needs, in `access_key_id`, `secret_access_key` order. */
export function volumeCredentialIdentifiers(volume: VolumeBlockV2): string[] {
  return VOLUME_CREDENTIAL_KEYS.flatMap((key) => (volume[key] ? [volume[key]!] : []));
}

function isSafePrefix(prefix: string): boolean {
  return !prefix.startsWith('/') && !prefix.split('/').some((segment) => segment === '..' || segment === '.');
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Top-level `volumes:`. Dispatch: called from `index.ts`'s `validateManifestBodyV2`. */
export function validateVolumesV2(node: unknown, path: string, issues: ManifestIssue[]): void {
  if (node === undefined) return;
  if (!isTable(node)) {
    issues.push({ path, message: 'must be a map of volume name → volume block.', severity: 'error' });
    return;
  }
  for (const [name, value] of Object.entries(node)) {
    const where = `${path}.${name}`;
    if (!SLUG_RE.test(name)) {
      issues.push({
        path: where,
        message: `"${name}" is not a valid volume name (lowercase letters, digits, dashes, underscores).`,
        severity: 'error',
      });
    }
    if (!isTable(value)) {
      issues.push({ path: where, message: 'must be a volume block.', severity: 'error' });
      continue;
    }
    for (const key of Object.keys(value)) {
      if (!(VOLUME_KEYS as readonly string[]).includes(key)) {
        issues.push({ path: `${where}.${key}`, message: 'is not a supported volume field.', severity: 'error' });
      }
    }
    if (value.type !== 's3') {
      issues.push({
        path: `${where}.type`,
        message: `type must be one of: ${VOLUME_TYPES.join(', ')} (got ${JSON.stringify(value.type ?? null)}).`,
        severity: 'error',
      });
    }
    if (typeof value.bucket !== 'string' || !VOLUME_BUCKET_RE.test(value.bucket)) {
      issues.push({
        path: `${where}.bucket`,
        message: 'is required: a bucket name (letters, digits, dots, dashes, underscores; no "/").',
        severity: 'error',
      });
    }
    if (value.prefix !== undefined && (typeof value.prefix !== 'string' || !value.prefix.trim() || !isSafePrefix(value.prefix.trim()))) {
      issues.push({
        path: `${where}.prefix`,
        message: 'must be a path inside the bucket: no leading "/", no "." or ".." segments.',
        severity: 'error',
      });
    }
    if (value.region !== undefined && (typeof value.region !== 'string' || !value.region.trim())) {
      issues.push({ path: `${where}.region`, message: 'must be a non-empty string.', severity: 'error' });
    }
    if (value.endpoint !== undefined && (typeof value.endpoint !== 'string' || !isHttpUrl(value.endpoint.trim()))) {
      issues.push({
        path: `${where}.endpoint`,
        message: 'must be an http(s) URL without credentials, e.g. https://<account>.r2.cloudflarestorage.com.',
        severity: 'error',
      });
    }
    for (const key of VOLUME_CREDENTIAL_KEYS) {
      const ref = value[key];
      if (ref !== undefined && (typeof ref !== 'string' || !VOLUME_SECRET_IDENTIFIER_RE.test(ref.trim()))) {
        issues.push({
          path: `${where}.${key}`,
          message: 'must name a project secret identifier, never the credential value.',
          severity: 'error',
        });
      }
    }
    if ((value.access_key_id === undefined) !== (value.secret_access_key === undefined)) {
      issues.push({
        path: where,
        message: 'set both access_key_id and secret_access_key, or neither for a public bucket.',
        severity: 'error',
      });
    }
  }
}

/** `agents.<name>.volumes` shape. Dispatch: called from `validateAgentBlockV2`. */
export function validateAgentVolumesV2(value: unknown, where: string, issues: ManifestIssue[]): void {
  if (value === undefined) return;
  const names: unknown[] = [];
  if (Array.isArray(value)) {
    names.push(...value);
  } else if (isTable(value)) {
    for (const [name, mode] of Object.entries(value)) {
      names.push(name);
      if (!isVolumeMode(mode)) {
        issues.push({
          path: `${where}.${name}`,
          message: `mode must be one of: ${VOLUME_MODES.join(', ')}.`,
          severity: 'error',
        });
      }
    }
  } else {
    issues.push({
      path: where,
      message: 'must be a list of volume names (read-only) or a map of volume name → read-only | read-write.',
      severity: 'error',
    });
    return;
  }
  const seen = new Set<string>();
  names.forEach((name, k) => {
    if (typeof name !== 'string' || !SLUG_RE.test(name)) {
      issues.push({ path: `${where}[${k}]`, message: 'must be a volume name.', severity: 'error' });
      return;
    }
    if (seen.has(name)) {
      issues.push({ path: `${where}[${k}]`, message: `volume "${name}" is listed twice.`, severity: 'error' });
    }
    seen.add(name);
  });
}

/**
 * Cross-validation: every attached volume is declared, and its credential
 * secrets are inside the agent's own `secrets` grant (v2 default `none`).
 * Dispatch: called from `index.ts`'s `validateManifestBodyV2`.
 */
export function validateAgentVolumeRefsV2(
  agentsNode: unknown,
  volumesNode: unknown,
  path: string,
  issues: ManifestIssue[],
): void {
  if (!isTable(agentsNode)) return;
  const declared = isTable(volumesNode) ? volumesNode : {};
  for (const [agentName, agent] of Object.entries(agentsNode)) {
    if (!isTable(agent)) continue;
    const secrets = agent.secrets;
    const grantAll = typeof secrets === 'string' && secrets.trim().toLowerCase() === 'all';
    const granted = new Set(
      Array.isArray(secrets)
        ? secrets.filter((s): s is string => typeof s === 'string').map((s) => s.trim().toUpperCase())
        : [],
    );
    for (const { name } of parseAgentVolumes(agent.volumes)) {
      const where = `${path}.${agentName}.volumes.${name}`;
      if (!(name in declared)) {
        issues.push({
          path: where,
          message: `volume "${name}" is not declared under the top-level \`volumes\`.`,
          severity: 'error',
        });
        continue;
      }
      const block = declared[name];
      if (!isTable(block) || grantAll) continue;
      for (const key of VOLUME_CREDENTIAL_KEYS) {
        const ref = block[key];
        if (typeof ref !== 'string' || !ref.trim() || granted.has(ref.trim().toUpperCase())) continue;
        issues.push({
          path: where,
          message: `credential secret "${ref.trim()}" (volumes.${name}.${key}) must also be granted in agents.${agentName}.secrets — attaching a volume gives the agent its credentials.`,
          severity: 'error',
        });
      }
    }
  }
}
