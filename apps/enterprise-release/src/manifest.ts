import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  parseEnterpriseReleaseManifest,
  type EnterpriseImageRole,
  type EnterpriseMigration,
  type EnterpriseReleaseManifest,
} from '../../enterprise-updater/src/release-contract.ts';

export interface PromotionInput {
  enterpriseVersion: string;
  prodVersion: string;
  sourceSha: string;
  enterpriseSourceSha: string;
  publishedAt: string;
  kubernetesMinor: string[];
  rollbackFrom: string[];
  migrations: EnterpriseMigration[];
  images: Record<EnterpriseImageRole, { source: string; digest: string }>;
  platformBundle: string;
  supabaseBundle: string;
  cosignPublicKey: string;
  updaterBinary: string;
}

export function buildEnterpriseManifest(input: PromotionInput): EnterpriseReleaseManifest {
  const manifest: EnterpriseReleaseManifest = {
    schema_version: 1,
    version: input.enterpriseVersion,
    channel: 'stable',
    published_at: input.publishedAt,
    prod: { version: input.prodVersion, source_sha: input.sourceSha },
    enterprise: { source_sha: input.enterpriseSourceSha },
    compatibility: {
      architectures: ['amd64'],
      kubernetes_minor: input.kubernetesMinor,
      rollback_from: input.rollbackFrom,
    },
    images: Object.fromEntries((['api', 'frontend', 'gateway'] as const).map((role) => [role, {
      source: input.images[role].source,
      digest: input.images[role].digest,
      customer_repository: role,
    }])) as EnterpriseReleaseManifest['images'],
    artifacts: {
      platform_bundle: artifact(input.platformBundle, `releases/${input.enterpriseVersion}/platform.tar.gz`),
      supabase_bundle: artifact(input.supabaseBundle, `releases/${input.enterpriseVersion}/supabase.tar.gz`),
      cosign_public_key: artifact(input.cosignPublicKey, `releases/${input.enterpriseVersion}/cosign.pub`),
      updater_binary: artifact(input.updaterBinary, `releases/${input.enterpriseVersion}/updater-linux-amd64`),
    },
    migrations: input.migrations,
    health: {
      api_path: '/v1/health',
      frontend_path: '/',
      expected_version: input.prodVersion,
    },
  };
  return parseEnterpriseReleaseManifest(manifest);
}

function artifact(path: string, target: string): { target: string; sha256: string; length: number } {
  const bytes = readFileSync(path);
  return {
    target,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    length: bytes.length,
  };
}
