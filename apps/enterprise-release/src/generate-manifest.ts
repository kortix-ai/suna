#!/usr/bin/env bun

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { EnterpriseMigration } from '../../enterprise-updater/src/release-contract.ts';
import { buildEnterpriseManifest } from './manifest.ts';

const flags = parseFlags(process.argv.slice(2));
const contract = readContract(resolve(required(flags, 'compatibility-contract')));
const prodVersion = required(flags, 'prod-version');
const enterpriseVersion = required(flags, 'enterprise-version');
const images = Object.fromEntries((['api', 'frontend', 'gateway'] as const).map((role) => {
  const source = required(flags, `${role}-image`);
  const digest = source.match(/@(sha256:[a-f0-9]{64})$/)?.[1];
  if (!digest) throw new Error(`--${role}-image must be digest-pinned`);
  return [role, { source, digest }];
})) as Parameters<typeof buildEnterpriseManifest>[0]['images'];
const manifest = buildEnterpriseManifest({
  enterpriseVersion,
  prodVersion,
  sourceSha: required(flags, 'source-sha'),
  enterpriseSourceSha: required(flags, 'enterprise-source-sha'),
  publishedAt: new Date().toISOString(),
  kubernetesMinor: contract.kubernetes_minor,
  rollbackFrom: contract.rollback_from,
  migrations: contract.migrations,
  images,
  platformBundle: resolve(required(flags, 'platform-bundle')),
  supabaseBundle: resolve(required(flags, 'supabase-bundle')),
  cosignPublicKey: resolve(required(flags, 'cosign-public-key')),
  updaterBinary: resolve(required(flags, 'updater-binary')),
});
const output = resolve(required(flags, 'output'));
writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ release: enterpriseVersion, manifest: output })}\n`);

interface CompatibilityContract {
  schema_version: 1;
  kubernetes_minor: string[];
  rollback_from: string[];
  migrations: EnterpriseMigration[];
}

function readContract(path: string): CompatibilityContract {
  const value = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('compatibility contract must be an object');
  const record = value as Record<string, unknown>;
  const keys = ['schema_version', 'kubernetes_minor', 'rollback_from', 'migrations'];
  if (record.schema_version !== 1 || Object.keys(record).sort().join(',') !== [...keys].sort().join(',')) {
    throw new Error('compatibility contract fields are invalid');
  }
  if (!Array.isArray(record.kubernetes_minor) || !Array.isArray(record.rollback_from) || !Array.isArray(record.migrations)) {
    throw new Error('compatibility contract arrays are invalid');
  }
  return record as unknown as CompatibilityContract;
}

function parseFlags(args: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith('--') || !value || value.startsWith('--')) throw new Error(`invalid argument near ${name ?? '<end>'}`);
    if (result.has(name.slice(2))) throw new Error(`duplicate option ${name}`);
    result.set(name.slice(2), value);
  }
  return result;
}

function required(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (!value) throw new Error(`missing --${name}`);
  return value;
}
