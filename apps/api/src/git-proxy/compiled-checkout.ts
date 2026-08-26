import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as tar from 'tar';
import { validateRef, validateSha } from '../projects/git-ref';
import { refreshMirror, runGit } from '../projects/git/mirror';
import type { GitBackedProject } from '../projects/git/types';

export const COMPILED_CHECKOUT_FORMAT = 'kortix.compiled-checkout.v1';
export const COMPILED_CHECKOUT_CONTENT_TYPE =
  'application/vnd.kortix.compiled-checkout.v1+gzip';

export interface CompiledCheckoutManifest {
  format: typeof COMPILED_CHECKOUT_FORMAT;
  project_id: string;
  ref: string;
  source_sha: string;
  shallow: true;
}

export interface CompiledCheckoutArtifact {
  path: string;
  sha256: string;
  size: number;
  sourceSha: string;
  cacheHit: boolean;
}

interface CachedArtifactMetadata {
  format: typeof COMPILED_CHECKOUT_FORMAT;
  projectId: string;
  ref: string;
  sourceSha: string;
  sha256: string;
  size: number;
}

const builds = new Map<string, Promise<CompiledCheckoutArtifact>>();

export class CompiledCheckoutSourceMovedError extends Error {
  constructor(expectedSha: string, actualSha: string) {
    super(`compiled checkout source moved: expected ${expectedSha}, got ${actualSha}`);
    this.name = 'CompiledCheckoutSourceMovedError';
  }
}

export class CompiledCheckoutTooLargeError extends Error {
  constructor(maxBytes: number, actualBytes: number) {
    super(`compiled checkout exceeds ${maxBytes} bytes (${actualBytes})`);
    this.name = 'CompiledCheckoutTooLargeError';
  }
}

function cacheRoot(): string {
  return process.env.KORTIX_COMPILED_BOOT_CACHE_DIR || '/tmp/kortix/compiled-boot';
}

function maxArtifactBytes(): number {
  const configured = Number(process.env.KORTIX_COMPILED_BOOT_MAX_ARTIFACT_BYTES);
  return Number.isFinite(configured) && configured > 0 ? configured : 512 * 1024 * 1024;
}

function artifactKey(projectId: string, ref: string, sourceSha: string): string {
  return createHash('sha256')
    .update(`${COMPILED_CHECKOUT_FORMAT}\0${projectId}\0${ref}\0${sourceSha}`)
    .digest('hex');
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function readCachedArtifact(
  archivePath: string,
  metadataPath: string,
  projectId: string,
  ref: string,
  sourceSha: string,
): Promise<CompiledCheckoutArtifact | null> {
  try {
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as CachedArtifactMetadata;
    const archive = await stat(archivePath);
    if (
      metadata.format !== COMPILED_CHECKOUT_FORMAT ||
      metadata.projectId !== projectId ||
      metadata.ref !== ref ||
      metadata.sourceSha !== sourceSha ||
      metadata.size !== archive.size ||
      archive.size <= 0
    ) {
      return null;
    }
    return {
      path: archivePath,
      sha256: metadata.sha256,
      size: metadata.size,
      sourceSha,
      cacheHit: true,
    };
  } catch {
    return null;
  }
}

async function resolveExactMirror(
  project: GitBackedProject,
  ref: string,
  expectedSha: string,
): Promise<string> {
  let mirror = await refreshMirror(project);
  let actualSha = (
    await runGit(['rev-parse', '--verify', `${ref}^{commit}`], mirror, false)
  ).stdout.trim();
  if (actualSha !== expectedSha) {
    mirror = await refreshMirror(project, true);
    actualSha = (
      await runGit(['rev-parse', '--verify', `${ref}^{commit}`], mirror, false)
    ).stdout.trim();
  }
  if (actualSha !== expectedSha) {
    throw new CompiledCheckoutSourceMovedError(expectedSha, actualSha);
  }
  return mirror;
}

async function compileArtifact(
  project: GitBackedProject,
  ref: string,
  sourceSha: string,
  runtimeRepoUrl: string,
  archivePath: string,
  metadataPath: string,
): Promise<CompiledCheckoutArtifact> {
  const mirror = await resolveExactMirror(project, ref, sourceSha);
  const root = await mkdtemp(join(cacheRoot(), '.compile-'));
  const checkout = join(root, 'checkout');
  const stagedArchive = join(root, 'checkout.tar.gz');
  try {
    await runGit(
      [
        'clone',
        '--depth',
        '1',
        '--branch',
        ref,
        '--single-branch',
        '--no-tags',
        pathToFileURL(mirror).href,
        checkout,
      ],
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      120_000,
    );
    const checkoutSha = (
      await runGit(['rev-parse', '--verify', 'HEAD'], checkout, false)
    ).stdout.trim();
    if (checkoutSha !== sourceSha) {
      throw new Error(`compiled checkout mismatch: expected ${sourceSha}, got ${checkoutSha}`);
    }
    await runGit(['remote', 'set-url', 'origin', runtimeRepoUrl], checkout, false);
    await rm(join(checkout, '.git', 'logs'), { recursive: true, force: true });
    await rm(join(checkout, '.git', 'index'), { force: true });
    await runGit(['read-tree', 'HEAD'], checkout, false);

    const manifest: CompiledCheckoutManifest = {
      format: COMPILED_CHECKOUT_FORMAT,
      project_id: project.projectId,
      ref,
      source_sha: sourceSha,
      shallow: true,
    };
    await writeFile(
      join(checkout, '.git', 'kortix-compiled-checkout.json'),
      `${JSON.stringify(manifest)}\n`,
      { mode: 0o600 },
    );
    await tar.create(
      {
        cwd: checkout,
        file: stagedArchive,
        gzip: true,
        portable: true,
        noMtime: true,
      },
      ['.'],
    );
    const archive = await stat(stagedArchive);
    const maxBytes = maxArtifactBytes();
    if (archive.size > maxBytes) {
      throw new CompiledCheckoutTooLargeError(maxBytes, archive.size);
    }
    const sha256 = await sha256File(stagedArchive);
    const metadata: CachedArtifactMetadata = {
      format: COMPILED_CHECKOUT_FORMAT,
      projectId: project.projectId,
      ref,
      sourceSha,
      sha256,
      size: archive.size,
    };
    await rename(stagedArchive, archivePath);
    await writeFile(metadataPath, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
    return {
      path: archivePath,
      sha256,
      size: archive.size,
      sourceSha,
      cacheHit: false,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function buildCompiledCheckoutArtifact(
  project: GitBackedProject,
  refInput: string,
  sourceShaInput: string,
  runtimeRepoUrl: string,
): Promise<CompiledCheckoutArtifact> {
  const ref = validateRef(refInput);
  const sourceSha = validateSha(sourceShaInput);
  const key = artifactKey(project.projectId, ref, sourceSha);
  await mkdir(cacheRoot(), { recursive: true });
  const archivePath = join(cacheRoot(), `${key}.tar.gz`);
  const metadataPath = join(cacheRoot(), `${key}.json`);
  const cached = await readCachedArtifact(
    archivePath,
    metadataPath,
    project.projectId,
    ref,
    sourceSha,
  );
  if (cached) return cached;

  const active = builds.get(key);
  if (active) return active;
  const build = compileArtifact(
    project,
    ref,
    sourceSha,
    runtimeRepoUrl,
    archivePath,
    metadataPath,
  ).finally(() => {
    builds.delete(key);
  });
  builds.set(key, build);
  return build;
}

export function __clearCompiledCheckoutBuildsForTests(): void {
  builds.clear();
}
