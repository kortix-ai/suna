const ENTERPRISE_RELEASE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-e([1-9]\d*)$/;
const PROD_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const HEX_SHA256 = /^[a-f0-9]{64}$/;
const SOURCE_SHA = /^[a-f0-9]{40}$/;
const TARGET_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[a-zA-Z0-9][a-zA-Z0-9._/-]*$/;

export const REQUIRED_IMAGE_ROLES = ['api', 'frontend', 'gateway'] as const;
export type EnterpriseImageRole = (typeof REQUIRED_IMAGE_ROLES)[number];

export interface EnterpriseImage {
  source: string;
  digest: string;
  customer_repository: EnterpriseImageRole;
}

export interface EnterpriseArtifact {
  target: string;
  sha256: string;
  length: number;
}

export interface EnterpriseMigration {
  id: string;
  sha256: string;
  reversible: boolean;
  backward_compatible: boolean;
}

export interface EnterpriseReleaseManifest {
  schema_version: 1;
  version: string;
  channel: 'stable';
  published_at: string;
  prod: {
    version: string;
    source_sha: string;
  };
  enterprise: {
    source_sha: string;
  };
  compatibility: {
    architectures: ['amd64'];
    kubernetes_minor: string[];
    rollback_from: string[];
  };
  images: Record<EnterpriseImageRole, EnterpriseImage>;
  artifacts: {
    platform_bundle: EnterpriseArtifact;
    supabase_bundle: EnterpriseArtifact;
    cosign_public_key: EnterpriseArtifact;
    updater_binary: EnterpriseArtifact;
  };
  migrations: EnterpriseMigration[];
  health: {
    api_path: string;
    frontend_path: string;
    expected_version: string;
  };
}

export function parseEnterpriseReleaseManifest(value: unknown): EnterpriseReleaseManifest {
  const root = record(value, 'release manifest');
  exactKeys(root, [
    'schema_version', 'version', 'channel', 'published_at', 'prod', 'enterprise', 'compatibility',
    'images', 'artifacts', 'migrations', 'health',
  ], 'release manifest');
  if (root.schema_version !== 1) throw new Error('release manifest schema_version must be 1');

  const version = enterpriseVersion(root.version, 'release version');
  if (root.channel !== 'stable') throw new Error('enterprise releases must use the stable channel');
  const publishedAt = requiredString(root.published_at, 'published_at');
  if (!Number.isFinite(Date.parse(publishedAt))) throw new Error('published_at must be an RFC3339 timestamp');

  const prod = record(root.prod, 'prod');
  exactKeys(prod, ['version', 'source_sha'], 'prod');
  const prodVersion = requiredString(prod.version, 'prod.version');
  if (!PROD_VERSION.test(prodVersion)) throw new Error('prod.version must be X.Y.Z');
  if (!version.startsWith(`${prodVersion}-e`)) {
    throw new Error('enterprise version must extend the exact prod.version');
  }
  const sourceSha = requiredString(prod.source_sha, 'prod.source_sha');
  if (!SOURCE_SHA.test(sourceSha)) throw new Error('prod.source_sha must be a lowercase 40-character Git SHA');

  const enterprise = record(root.enterprise, 'enterprise');
  exactKeys(enterprise, ['source_sha'], 'enterprise');
  const enterpriseSourceSha = requiredString(enterprise.source_sha, 'enterprise.source_sha');
  if (!SOURCE_SHA.test(enterpriseSourceSha)) throw new Error('enterprise.source_sha must be a lowercase 40-character Git SHA');

  const compatibility = record(root.compatibility, 'compatibility');
  exactKeys(compatibility, ['architectures', 'kubernetes_minor', 'rollback_from'], 'compatibility');
  const architectures = stringArray(compatibility.architectures, 'compatibility.architectures');
  if (architectures.length !== 1 || architectures[0] !== 'amd64') {
    throw new Error('enterprise releases must currently target exactly amd64');
  }
  const kubernetesMinor = stringArray(compatibility.kubernetes_minor, 'compatibility.kubernetes_minor');
  if (kubernetesMinor.length === 0 || kubernetesMinor.some((entry) => !/^1\.\d{2}$/.test(entry))) {
    throw new Error('compatibility.kubernetes_minor must contain Kubernetes minor versions such as 1.32');
  }
  const rollbackFrom = stringArray(compatibility.rollback_from, 'compatibility.rollback_from');
  for (const candidate of rollbackFrom) enterpriseVersion(candidate, 'compatibility.rollback_from entry');

  const imagesValue = record(root.images, 'images');
  exactKeys(imagesValue, [...REQUIRED_IMAGE_ROLES], 'images');
  const images = Object.fromEntries(REQUIRED_IMAGE_ROLES.map((role) => {
    const image = record(imagesValue[role], `images.${role}`);
    exactKeys(image, ['source', 'digest', 'customer_repository'], `images.${role}`);
    const source = requiredString(image.source, `images.${role}.source`);
    const digest = requiredString(image.digest, `images.${role}.digest`);
    if (!SHA256.test(digest)) throw new Error(`images.${role}.digest must be sha256:<64 lowercase hex>`);
    if (!source.endsWith(`@${digest}`) || source.includes(':latest')) {
      throw new Error(`images.${role}.source must be an immutable ref ending in @${digest}`);
    }
    if (image.customer_repository !== role) {
      throw new Error(`images.${role}.customer_repository must be ${role}`);
    }
    return [role, { source, digest, customer_repository: role } satisfies EnterpriseImage];
  })) as Record<EnterpriseImageRole, EnterpriseImage>;

  const artifactsValue = record(root.artifacts, 'artifacts');
  exactKeys(artifactsValue, ['platform_bundle', 'supabase_bundle', 'cosign_public_key', 'updater_binary'], 'artifacts');
  const artifacts = {
    platform_bundle: artifact(artifactsValue.platform_bundle, 'artifacts.platform_bundle'),
    supabase_bundle: artifact(artifactsValue.supabase_bundle, 'artifacts.supabase_bundle'),
    cosign_public_key: artifact(artifactsValue.cosign_public_key, 'artifacts.cosign_public_key'),
    updater_binary: artifact(artifactsValue.updater_binary, 'artifacts.updater_binary'),
  };

  if (!Array.isArray(root.migrations)) throw new Error('migrations must be an array');
  const migrations = root.migrations.map((entry, index) => migration(entry, index));
  if (new Set(migrations.map((entry) => entry.id)).size !== migrations.length) {
    throw new Error('migration ids must be unique');
  }

  const healthValue = record(root.health, 'health');
  exactKeys(healthValue, ['api_path', 'frontend_path', 'expected_version'], 'health');
  const health = {
    api_path: safeHealthPath(healthValue.api_path, 'health.api_path'),
    frontend_path: safeHealthPath(healthValue.frontend_path, 'health.frontend_path'),
    expected_version: requiredString(healthValue.expected_version, 'health.expected_version'),
  };
  if (health.expected_version !== prodVersion) throw new Error('health.expected_version must equal the immutable prod.version');

  return {
    schema_version: 1,
    version,
    channel: 'stable',
    published_at: publishedAt,
    prod: { version: prodVersion, source_sha: sourceSha },
    enterprise: { source_sha: enterpriseSourceSha },
    compatibility: {
      architectures: ['amd64'],
      kubernetes_minor: kubernetesMinor,
      rollback_from: rollbackFrom,
    },
    images,
    artifacts,
    migrations,
    health,
  };
}

export function enterpriseVersion(value: unknown, label = 'enterprise version'): string {
  const version = requiredString(value, label);
  if (!ENTERPRISE_RELEASE.test(version)) {
    throw new Error(`${label} must use <prod-version>-e<revision>, for example 0.9.84-e1`);
  }
  return version;
}

function artifact(value: unknown, label: string): EnterpriseArtifact {
  const item = record(value, label);
  exactKeys(item, ['target', 'sha256', 'length'], label);
  const target = requiredString(item.target, `${label}.target`);
  if (!TARGET_PATH.test(target)) throw new Error(`${label}.target must be a relative TUF target path`);
  const sha256 = requiredString(item.sha256, `${label}.sha256`);
  if (!HEX_SHA256.test(sha256)) throw new Error(`${label}.sha256 must be 64 lowercase hex characters`);
  if (!Number.isSafeInteger(item.length) || (item.length as number) <= 0) {
    throw new Error(`${label}.length must be a positive integer`);
  }
  return { target, sha256, length: item.length as number };
}

function migration(value: unknown, index: number): EnterpriseMigration {
  const label = `migrations[${index}]`;
  const item = record(value, label);
  exactKeys(item, ['id', 'sha256', 'reversible', 'backward_compatible'], label);
  const id = requiredString(item.id, `${label}.id`);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id)) throw new Error(`${label}.id is invalid`);
  const sha256 = requiredString(item.sha256, `${label}.sha256`);
  if (!HEX_SHA256.test(sha256)) throw new Error(`${label}.sha256 must be 64 lowercase hex characters`);
  if (typeof item.reversible !== 'boolean') throw new Error(`${label}.reversible must be boolean`);
  if (typeof item.backward_compatible !== 'boolean') throw new Error(`${label}.backward_compatible must be boolean`);
  return { id, sha256, reversible: item.reversible, backward_compatible: item.backward_compatible };
}

function safeHealthPath(value: unknown, label: string): string {
  const path = requiredString(value, label);
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('://')) {
    throw new Error(`${label} must be an origin-relative path`);
  }
  return path;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value as string[];
}

function exactKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedSet.has(key));
  const missing = allowed.filter((key) => !(key in value));
  if (unexpected.length > 0) throw new Error(`${label} contains unknown fields: ${unexpected.join(', ')}`);
  if (missing.length > 0) throw new Error(`${label} is missing fields: ${missing.join(', ')}`);
}
