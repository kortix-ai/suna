import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { Updater, type TargetFile } from 'tuf-js';

import type { EnterpriseArtifact } from './release-contract.ts';

const MAX_ROOT_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;

export interface TrustedRepositoryOptions {
  repositoryUrl: string;
  trustedRootSha256: string;
  metadataDir: string;
  targetDir: string;
}

export class TrustedRepository {
  private readonly updater: Updater;
  private readonly targetDir: string;

  private constructor(updater: Updater, targetDir: string) {
    this.updater = updater;
    this.targetDir = targetDir;
  }

  static async open(options: TrustedRepositoryOptions): Promise<TrustedRepository> {
    const base = repositoryBase(options.repositoryUrl);
    mkdirSync(options.metadataDir, { recursive: true, mode: 0o700 });
    mkdirSync(options.targetDir, { recursive: true, mode: 0o700 });
    const root = await downloadPinnedRoot(new URL('metadata/1.root.json', base), options.trustedRootSha256);
    const rootPath = join(options.metadataDir, 'root.json');
    writeFileSync(rootPath, root, { mode: 0o600 });
    chmodSync(rootPath, 0o600);

    const updater = new Updater({
      metadataDir: options.metadataDir,
      metadataBaseUrl: new URL('metadata/', base).toString(),
      targetDir: options.targetDir,
      targetBaseUrl: new URL('targets/', base).toString(),
      config: {
        prefixTargetsWithHash: true,
        maxRootRotations: 64,
        maxDelegations: 16,
        rootMaxLength: MAX_ROOT_BYTES,
        timestampMaxLength: MAX_MANIFEST_BYTES,
        snapshotMaxLength: MAX_MANIFEST_BYTES,
        targetsMaxLength: 4 * MAX_MANIFEST_BYTES,
        fetchTimeout: 30_000,
        fetchRetries: 2,
        userAgent: 'kortix-enterprise-updater',
      },
    });
    await updater.refresh();
    return new TrustedRepository(updater, options.targetDir);
  }

  async readJsonTarget<T>(targetPath: string): Promise<{ value: T; sha256: string; length: number }> {
    const info = await this.requiredTargetInfo(targetPath);
    if (info.length > MAX_MANIFEST_BYTES) throw new Error(`signed JSON target ${targetPath} exceeds 1 MiB`);
    const path = await this.updater.downloadTarget(info);
    const bytes = readFileSync(path);
    let value: T;
    try {
      value = JSON.parse(bytes.toString('utf8')) as T;
    } catch (error) {
      throw new Error(`signed target ${targetPath} is not valid JSON: ${(error as Error).message}`);
    }
    return { value, sha256: requiredSha256(info), length: info.length };
  }

  async downloadArtifact(artifact: EnterpriseArtifact): Promise<string> {
    const info = await this.requiredTargetInfo(artifact.target);
    const tufSha256 = requiredSha256(info);
    if (info.length !== artifact.length || tufSha256 !== artifact.sha256) {
      throw new Error(`manifest and TUF metadata disagree for ${artifact.target}`);
    }
    const output = join(this.targetDir, `${artifact.sha256}.${safeBasename(artifact.target)}`);
    return this.updater.downloadTarget(info, output);
  }

  private async requiredTargetInfo(path: string): Promise<TargetFile> {
    const info = await this.updater.getTargetInfo(path);
    if (!info) throw new Error(`signed TUF target not found: ${path}`);
    return info;
  }
}

export async function downloadPinnedRoot(url: URL, expectedSha256: string): Promise<Buffer> {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) throw new Error('trusted root SHA-256 is invalid');
  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    headers: { 'user-agent': 'kortix-enterprise-updater/bootstrap' },
  });
  if (!response.ok) throw new Error(`unable to download pinned TUF root: HTTP ${response.status}`);
  const declaredLength = Number(response.headers.get('content-length') ?? '0');
  if (declaredLength > MAX_ROOT_BYTES) throw new Error('pinned TUF root exceeds 1 MiB');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_ROOT_BYTES) throw new Error('pinned TUF root has an invalid size');
  const actual = sha256Hex(bytes);
  if (actual !== expectedSha256) {
    throw new Error(`pinned TUF root digest mismatch: expected ${expectedSha256}, received ${actual}`);
  }
  return bytes;
}

export function sha256Hex(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function stableTargetPath(requestedRelease?: string, rollbackTo?: string): string {
  const version = rollbackTo ?? requestedRelease;
  return version ? `releases/${version}.json` : 'channels/stable.json';
}

function repositoryBase(value: string): URL {
  const url = new URL(value.endsWith('/') ? value : `${value}/`);
  const localHttp = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !localHttp) throw new Error('release repository must use HTTPS');
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('release repository URL must not contain credentials, a query, or a fragment');
  }
  return url;
}

function requiredSha256(info: TargetFile): string {
  const value = info.hashes.sha256;
  if (!value || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`TUF target ${info.path} lacks a valid SHA-256`);
  return value;
}

function safeBasename(path: string): string {
  const value = basename(path);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) throw new Error(`unsafe TUF target filename: ${path}`);
  return value;
}
