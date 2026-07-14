import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import type { EnterpriseArtifact } from './release-contract.ts';
import { TrustedRepository } from './tuf-repository.ts';

export interface LauncherOptions {
  repositoryUrl: string;
  trustedRootSha256: string;
  workDir: string;
  argv: string[];
}

export async function launchSignedUpdaterIfNeeded(options: LauncherOptions): Promise<number | null> {
  if (process.env.KORTIX_UPDATER_PAYLOAD === '1') return null;
  const root = join(options.workDir, 'launcher');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const repository = await TrustedRepository.open({
    repositoryUrl: options.repositoryUrl,
    trustedRootSha256: options.trustedRootSha256,
    metadataDir: join(root, 'metadata'),
    targetDir: join(root, 'targets'),
  });
  const signed = await repository.readJsonTarget<unknown>('channels/stable.json');
  const artifact = parseUpdaterArtifact(signed.value);
  const payload = await repository.downloadArtifact(artifact);
  chmodSync(payload, 0o700);
  const result = spawnSync(payload, options.argv, {
    stdio: 'inherit',
    env: { ...process.env, KORTIX_UPDATER_PAYLOAD: '1' },
  });
  if (result.error) throw new Error(`unable to launch TUF-verified updater payload: ${result.error.message}`);
  if (result.signal) throw new Error(`TUF-verified updater payload terminated by ${result.signal}`);
  return result.status ?? 1;
}

export function parseUpdaterArtifact(value: unknown): EnterpriseArtifact {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('stable release target must be an object');
  const artifacts = (value as Record<string, unknown>).artifacts;
  if (typeof artifacts !== 'object' || artifacts === null || Array.isArray(artifacts)) {
    throw new Error('stable release target is missing artifacts');
  }
  const updater = (artifacts as Record<string, unknown>).updater_binary;
  if (typeof updater !== 'object' || updater === null || Array.isArray(updater)) {
    throw new Error('stable release target is missing updater_binary');
  }
  const record = updater as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'length,sha256,target'
    || typeof record.target !== 'string'
    || !/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(record.target)
    || typeof record.sha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(record.sha256)
    || !Number.isSafeInteger(record.length)
    || (record.length as number) <= 0) {
    throw new Error('stable release updater_binary contract is invalid');
  }
  return { target: record.target, sha256: record.sha256, length: record.length as number };
}
