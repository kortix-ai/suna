#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parseEnterpriseReleaseManifest } from '../../enterprise-updater/src/release-contract.ts';
import { KmsTufSigner } from './kms-signer.ts';
import { publishTargets, type TargetInput } from './repository.ts';

const flags = parseFlags(process.argv.slice(2));
const repositoryDir = resolve(required(flags, 'repository-dir'));
const manifestPath = resolve(required(flags, 'manifest'));
const manifestBytes = readFileSync(manifestPath);
const manifest = parseEnterpriseReleaseManifest(JSON.parse(manifestBytes.toString('utf8')) as unknown);
const artifacts = [
  { contract: manifest.artifacts.platform_bundle, path: resolve(required(flags, 'platform-bundle')) },
  { contract: manifest.artifacts.supabase_bundle, path: resolve(required(flags, 'supabase-bundle')) },
  { contract: manifest.artifacts.cosign_public_key, path: resolve(required(flags, 'cosign-public-key')) },
  { contract: manifest.artifacts.updater_binary, path: resolve(required(flags, 'updater-binary')) },
];
const targets: TargetInput[] = [
  {
    path: `releases/${manifest.version}.json`, bytes: manifestBytes,
    custom: { kind: 'kortix-enterprise-release', channel: 'stable', version: manifest.version },
  },
  {
    path: 'channels/stable.json', bytes: manifestBytes,
    custom: { kind: 'kortix-enterprise-channel', channel: 'stable', version: manifest.version },
  },
];
for (const artifact of artifacts) {
  const bytes = readFileSync(artifact.path);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== artifact.contract.sha256 || bytes.length !== artifact.contract.length) {
    throw new Error(`artifact ${artifact.contract.target} does not match the signed manifest contract`);
  }
  targets.push({
    path: artifact.contract.target,
    bytes,
    custom: { kind: 'kortix-enterprise-artifact', release: manifest.version },
  });
}
const region = requiredEnv('AWS_REGION', 'AWS_DEFAULT_REGION');
const versions = publishTargets(repositoryDir, {
  targets: KmsTufSigner.load(requiredEnv('KORTIX_TUF_TARGETS_KEY_ARN'), region),
  snapshot: KmsTufSigner.load(requiredEnv('KORTIX_TUF_SNAPSHOT_KEY_ARN'), region),
  timestamp: KmsTufSigner.load(requiredEnv('KORTIX_TUF_TIMESTAMP_KEY_ARN'), region),
}, targets, requiredEnv('KORTIX_TUF_ROOT_SHA256'));
process.stdout.write(`${JSON.stringify({ release: manifest.version, channel: 'stable', ...versions })}\n`);

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

function requiredEnv(...names: string[]): string {
  for (const name of names) {
    if (process.env[name]) return process.env[name]!;
  }
  throw new Error(`missing ${names.join(' or ')}`);
}
