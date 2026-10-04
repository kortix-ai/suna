import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as tar from 'tar';
import { config } from '../lib/config';
import { validateSha } from '../services/git/git-ref';
import { refreshMirror, runGit } from '../services/git/mirror';
import type { GitBackedProject } from '../services/git/types';
import { sha256File } from '../lib/sha256-file';
import { normalizeSnapshotRef, PROJECT_SNAPSHOT_MARKER_PATH, type ProjectSnapshotMarker } from './project-snapshot';
import { PROJECT_SNAPSHOT_FORMAT, PROJECT_SNAPSHOT_ARCHIVE_CONTENT_TYPE, PROJECT_SNAPSHOT_BLOBS_CONTENT_TYPE, getObjectText, headObject, projectSnapshotBlobsKey, projectSnapshotManifestKey, projectSnapshotTreeKey, projectSnapshotObjectPrefix, putObjectIfAbsent, type ProjectSnapshotManifest, type ProjectSnapshotRepository } from './project-snapshot-store';

// ── Build ───────────────────────────────────────────────────────────────────

export class ProjectSnapshotTooLargeError extends Error {
  constructor(maxBytes: number, actualBytes: number) {
    super(`project snapshot exceeds ${maxBytes} bytes (${actualBytes})`);
    this.name = 'ProjectSnapshotTooLargeError';
  }
}

export class ProjectSnapshotSourceMissingError extends Error {
  constructor(sha: string) {
    super(`commit ${sha} is not present in the project mirror`);
    this.name = 'ProjectSnapshotSourceMissingError';
  }
}

function buildRoot(): string {
  return process.env.KORTIX_PROJECT_SNAPSHOT_BUILD_DIR || join(tmpdir(), 'kortix-project-snapshot');
}

async function mirrorHasCommit(mirror: string, sha: string): Promise<boolean> {
  try {
    await runGit(['cat-file', '-e', `${sha}^{commit}`], mirror, false);
    return true;
  } catch {
    return false;
  }
}

export interface BuiltProjectSnapshot {
  /** Boot object: working tree + blobless `.git`, tar.gz. */
  treePath: string;
  treeSha256: string;
  treeBytes: number;
  entries: number;
  /** Hydration object: the tip's blob pack. */
  blobsPath: string;
  blobsSha256: string;
  blobsBytes: number;
  /** Delete the build directory. */
  cleanup: () => Promise<void>;
}

/**
 * `git` with a stdin payload and/or stdout captured to a file — pack-objects
 * reads its revisions from stdin and writes the pack to stdout, which the
 * plain exec helper cannot do.
 */
function spawnGit(
  args: string[],
  cwd: string,
  io: { stdin?: string; stdinPath?: string; stdoutPath?: string },
  timeoutMs = 120_000,
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      reject(err);
    };
    const timer = setTimeout(() => fail(new Error(`git ${args[0]} timed out after ${timeoutMs}ms`)), timeoutMs);
    child.on('error', fail);
    child.stdin.on('error', () => {});
    child.stderr.on('data', (d) => {
      stderr += String(d);
    });
    let sinkDone: Promise<void> = Promise.resolve();
    if (io.stdoutPath) {
      const sink = createWriteStream(io.stdoutPath);
      sinkDone = new Promise((res, rej) => {
        sink.on('finish', res);
        sink.on('error', rej);
      });
      child.stdout.pipe(sink);
    } else {
      child.stdout.on('data', (d) => {
        stdout += String(d);
      });
    }
    if (io.stdinPath) createReadStream(io.stdinPath).on('error', fail).pipe(child.stdin);
    else child.stdin.end(io.stdin ?? '');
    child.on('close', (code) => {
      sinkDone.then(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) resolve({ stdout });
        else reject(new Error(`git ${args.join(' ')} exited ${code}: ${stderr.slice(0, 300)}`));
      }, fail);
    });
  });
}

async function prepareSnapshotCheckout(mirror: string, checkout: string, ref: string, sha: string): Promise<void> {
  await mkdir(checkout);
  await runGit(['init', '-q', '-b', ref, checkout], undefined, false);
  await runGit(
    [
      '-c',
      'uploadpack.allowAnySHA1InWant=true',
      // Keep what arrives as ONE pack: below transfer.unpackLimit (100
      // objects) git would explode a small fetch into loose objects, and
      // the object-store split below must be able to remove all of it.
      '-c',
      'transfer.unpackLimit=1',
      'fetch',
      '-q',
      '--depth',
      '1',
      '--no-tags',
      pathToFileURL(mirror).href,
      sha,
    ],
    checkout,
    false,
    undefined,
    undefined,
    undefined,
    120_000,
  );
  await runGit(['checkout', '-q', '-B', ref, 'FETCH_HEAD'], checkout, false);
  const head = (await runGit(['rev-parse', '--verify', 'HEAD'], checkout, false)).stdout.trim();
  if (head !== sha) throw new Error(`project snapshot checkout mismatch: expected ${sha}, got ${head}`);
}

async function sanitizeSnapshotCheckout(checkout: string): Promise<void> {
  // Sanitize: nothing that names a remote, a credential, a hook, or this
  // machine's stat cache leaves with the archive.
  await rm(join(checkout, '.git', 'logs'), { recursive: true, force: true });
  await rm(join(checkout, '.git', 'hooks'), { recursive: true, force: true });
  await rm(join(checkout, '.git', 'FETCH_HEAD'), { force: true });
  await rm(join(checkout, '.git', 'index'), { force: true });
  await runGit(['read-tree', 'HEAD'], checkout, false);
}

async function splitSnapshotObjects(checkout: string, blobsPath: string, treePackPath: string, sha: string): Promise<void> {
  // Split the object store. The hydration pack is everything reachable from
  // the tip (commit, trees, blobs — the small non-blob part is duplicated on
  // purpose so the pack stands alone). The boot `.git` keeps only a pack of
  // the commit, the trees and the SYMLINK blobs: `git status` compares a
  // symlink against its blob's content (ce_compare_link), so those bytes-
  // sized blobs must be local for the tree to be refreshable without a
  // fetch; every regular file is hashed from the working tree. That pack is
  // imported through index-pack so it is named and indexed the way git
  // expects, the fetched pack is removed, and the boot pack is marked
  // promisor: git reads "missing" as "fetchable", never as corruption.
  const packDir = join(checkout, '.git', 'objects', 'pack');
  const fetchedPacks = (await readdir(packDir)).filter((n) => /\.(pack|idx|keep|promisor|rev|mtimes)$/.test(n));
  await spawnGit(['pack-objects', '--revs', '--stdout', '-q'], checkout, { stdin: 'HEAD\n', stdoutPath: blobsPath });
  const nonBlobs = (await spawnGit(['rev-list', '--objects', '--filter=blob:none', 'HEAD'], checkout, {})).stdout;
  const symlinkBlobs = (await spawnGit(['ls-tree', '-r', 'HEAD'], checkout, {})).stdout
    .split('\n')
    .filter((line) => line.startsWith('120000 blob '))
    .map((line) => line.split(/\s+/)[2] ?? '');
  const bootObjects = [...nonBlobs.split('\n').map((l) => l.slice(0, 40)), ...symlinkBlobs].filter((id) => /^[0-9a-f]{40}$/.test(id));
  await spawnGit(['pack-objects', '--stdout', '-q'], checkout, {
    stdin: `${bootObjects.join('\n')}\n`,
    stdoutPath: treePackPath,
  });
  const indexed = await spawnGit(['index-pack', '--stdin'], checkout, { stdinPath: treePackPath });
  const packSum = indexed.stdout.match(/^pack\t([0-9a-f]{40,64})/m)?.[1];
  if (!packSum) throw new Error(`git index-pack did not name the blobless pack: ${indexed.stdout.slice(0, 200)}`);
  // Only the boot pack may remain: the fetched pack(s) and any loose object
  // (a fetch below transfer.unpackLimit, a stray write) carry blobs.
  for (const name of fetchedPacks) await rm(join(packDir, name), { force: true });
  const objectsDir = join(checkout, '.git', 'objects');
  for (const entry of await readdir(objectsDir)) {
    if (/^[0-9a-f]{2}$/.test(entry)) await rm(join(objectsDir, entry), { recursive: true, force: true });
  }
  const leftover = (await readdir(packDir)).filter((n) => !n.startsWith(`pack-${packSum}.`));
  if (leftover.length > 0) throw new Error(`unexpected objects next to the boot pack: ${leftover.join(', ')}`);
  await writeFile(join(packDir, `pack-${packSum}.promisor`), '');
  await rm(treePackPath, { force: true });
  const shipped = (await runGit(['rev-parse', '--verify', 'HEAD'], checkout, false)).stdout.trim();
  if (shipped !== sha) throw new Error(`blobless checkout lost its commit: expected ${sha}, got ${shipped}`);
}

async function writeSnapshotMarker(checkout: string, repository: ProjectSnapshotRepository, ref: string, sha: string): Promise<void> {
  const marker: ProjectSnapshotMarker = {
    format: PROJECT_SNAPSHOT_FORMAT,
    repository: {
      owner: repository.owner,
      name: repository.name,
      external_id: repository.externalId,
    },
    ref,
    commit_sha: sha,
  };
  await writeFile(join(checkout, PROJECT_SNAPSHOT_MARKER_PATH), `${JSON.stringify(marker)}\n`, {
    mode: 0o644,
  });
}

/**
 * Build the two objects for ONE exact commit from the API's bare mirror. The
 * checkout is a single-commit shallow fetch (`uploadpack.allowAnySHA1InWant`
 * lets a local mirror serve an arbitrary reachable SHA, so a ref that already
 * moved on does not change what this builds). The `.git` that ships is
 * sanitized: no remote, no hooks, no reflogs, a fresh index with no stat data
 * — and no blobs: its one pack holds the commit and trees and is marked
 * promisor, so the box is a valid partial clone the moment it is extracted.
 * The blobs travel separately (the hydration object) and are imported by the
 * daemon after activation, off the boot path.
 */
export async function buildProjectSnapshotArchive(
  project: GitBackedProject,
  repository: ProjectSnapshotRepository,
  refInput: string,
  shaInput: string,
): Promise<BuiltProjectSnapshot> {
  const ref = normalizeSnapshotRef(refInput);
  const sha = validateSha(shaInput);
  let mirror = await refreshMirror(project);
  if (!(await mirrorHasCommit(mirror, sha))) {
    mirror = await refreshMirror(project, true);
    if (!(await mirrorHasCommit(mirror, sha))) throw new ProjectSnapshotSourceMissingError(sha);
  }

  await mkdir(buildRoot(), { recursive: true });
  const root = await mkdtemp(join(buildRoot(), 'build-'));
  const cleanup = () => rm(root, { recursive: true, force: true });
  const checkout = join(root, 'checkout');
  const treePath = join(root, `${sha}.tree.tar.gz`);
  const blobsPath = join(root, `${sha}.blobs.pack`);
  const treePackPath = join(root, `${sha}.tree.pack`);
  try {
    await prepareSnapshotCheckout(mirror, checkout, ref, sha);
    await sanitizeSnapshotCheckout(checkout);
    await splitSnapshotObjects(checkout, blobsPath, treePackPath, sha);
    await writeSnapshotMarker(checkout, repository, ref, sha);

    let entries = 0;
    await tar.create(
      {
        cwd: checkout,
        file: treePath,
        gzip: { level: 6 },
        portable: true,
        noMtime: true,
        filter: () => {
          entries += 1;
          return true;
        },
      },
      ['.'],
    );
    const treeBytes = (await stat(treePath)).size;
    const blobsBytes = (await stat(blobsPath)).size;
    const maxBytes = config.KORTIX_PROJECT_SNAPSHOT_MAX_ARCHIVE_BYTES;
    if (treeBytes > maxBytes) throw new ProjectSnapshotTooLargeError(maxBytes, treeBytes);
    if (blobsBytes > maxBytes) throw new ProjectSnapshotTooLargeError(maxBytes, blobsBytes);
    const [treeSha256, blobsSha256] = await Promise.all([sha256File(treePath), sha256File(blobsPath)]);
    await rm(checkout, { recursive: true, force: true });
    return { treePath, treeSha256, treeBytes, entries, blobsPath, blobsSha256, blobsBytes, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export interface PublishedProjectSnapshot {
  objectPrefix: string;
  treeKey: string;
  sha256: string;
  bytes: number;
  entries: number;
  blobsKey: string;
  blobsSha256: string;
  blobsBytes: number;
  archive: 'created' | 'exists';
  manifest: 'created' | 'exists';
}

function fromManifest(objectPrefix: string, manifest: ProjectSnapshotManifest): PublishedProjectSnapshot {
  return {
    objectPrefix,
    treeKey: manifest.tree.key,
    sha256: manifest.tree.sha256,
    bytes: manifest.tree.bytes,
    entries: manifest.tree.entries,
    blobsKey: manifest.blobs.key,
    blobsSha256: manifest.blobs.sha256,
    blobsBytes: manifest.blobs.bytes,
    archive: 'exists',
    manifest: 'exists',
  };
}

/**
 * Publish tree object, then blob pack, then manifest. If a manifest already
 * exists (another producer won), ITS objects are the truth: verify they are
 * really there and report their digests, never overwrite.
 */
async function restorePublishedObjects(manifest: ProjectSnapshotManifest, built: BuiltProjectSnapshot, manifestKey: string): Promise<void> {
  let [tree, blobs] = await Promise.all([headObject(manifest.tree.key), headObject(manifest.blobs.key)]);
  if (!tree || !blobs) {
    if (manifest.tree.sha256 !== built.treeSha256 || manifest.blobs.sha256 !== built.blobsSha256) {
      throw new Error(
        `published manifest at ${manifestKey} names objects that are missing and this build's digests differ (tree ${manifest.tree.sha256} vs ${built.treeSha256}); remove the prefix to rebuild`,
      );
    }
    if (!tree) {
      await putObjectIfAbsent({
        key: manifest.tree.key,
        body: { path: built.treePath, bytes: built.treeBytes },
        contentType: PROJECT_SNAPSHOT_ARCHIVE_CONTENT_TYPE,
      });
    }
    if (!blobs) {
      await putObjectIfAbsent({
        key: manifest.blobs.key,
        body: { path: built.blobsPath, bytes: built.blobsBytes },
        contentType: PROJECT_SNAPSHOT_BLOBS_CONTENT_TYPE,
      });
    }
    [tree, blobs] = await Promise.all([headObject(manifest.tree.key), headObject(manifest.blobs.key)]);
  }
  if (!tree || tree.bytes !== manifest.tree.bytes || !blobs || blobs.bytes !== manifest.blobs.bytes) {
    throw new Error(`published manifest at ${manifestKey} names an object that is missing or truncated`);
  }
}

export async function publishProjectSnapshot(input: {
  repository: ProjectSnapshotRepository;
  ref: string;
  commitSha: string;
  built: BuiltProjectSnapshot;
}): Promise<PublishedProjectSnapshot> {
  const objectPrefix = projectSnapshotObjectPrefix(input.repository, input.commitSha);
  const manifestKey = projectSnapshotManifestKey(objectPrefix);
  const existingManifest = await getObjectText(manifestKey);
  if (existingManifest) {
    const manifest = parseManifest(existingManifest, input.commitSha);
    await restorePublishedObjects(manifest, input.built, manifestKey);
    return fromManifest(objectPrefix, manifest);
  }

  const treeKey = projectSnapshotTreeKey(objectPrefix, input.built.treeSha256);
  const blobsKey = projectSnapshotBlobsKey(objectPrefix, input.built.blobsSha256);
  const treeOutcome = await putObjectIfAbsent({ key: treeKey, body: { path: input.built.treePath, bytes: input.built.treeBytes }, contentType: PROJECT_SNAPSHOT_ARCHIVE_CONTENT_TYPE });
  const blobsOutcome = await putObjectIfAbsent({ key: blobsKey, body: { path: input.built.blobsPath, bytes: input.built.blobsBytes }, contentType: PROJECT_SNAPSHOT_BLOBS_CONTENT_TYPE });
  // Both objects must be fully there before the manifest advertises them.
  const [treeHead, blobsHead] = await Promise.all([headObject(treeKey), headObject(blobsKey)]);
  if (!treeHead || treeHead.bytes !== input.built.treeBytes) {
    throw new Error(`tree object upload verification failed for ${treeKey}`);
  }
  if (!blobsHead || blobsHead.bytes !== input.built.blobsBytes) {
    throw new Error(`blob pack upload verification failed for ${blobsKey}`);
  }
  const manifest: ProjectSnapshotManifest = {
    format: PROJECT_SNAPSHOT_FORMAT,
    repository: {
      owner: input.repository.owner,
      name: input.repository.name,
      external_id: input.repository.externalId,
    },
    ref: normalizeSnapshotRef(input.ref),
    commit_sha: input.commitSha,
    tree: {
      key: treeKey,
      sha256: input.built.treeSha256,
      bytes: input.built.treeBytes,
      entries: input.built.entries,
      container: 'tar',
      compression: 'gzip',
      content_type: PROJECT_SNAPSHOT_ARCHIVE_CONTENT_TYPE,
    },
    blobs: {
      key: blobsKey,
      sha256: input.built.blobsSha256,
      bytes: input.built.blobsBytes,
      container: 'git-pack',
      content_type: PROJECT_SNAPSHOT_BLOBS_CONTENT_TYPE,
    },
    limits: { max_archive_bytes: config.KORTIX_PROJECT_SNAPSHOT_MAX_ARCHIVE_BYTES },
    produced_at: new Date().toISOString(),
  };
  const manifestOutcome = await putObjectIfAbsent({
    key: manifestKey,
    body: `${JSON.stringify(manifest)}\n`,
    contentType: 'application/json',
  });
  if (manifestOutcome === 'exists') {
    // Lost the race between our manifest read and write: re-read the winner.
    const winner = parseManifest((await getObjectText(manifestKey)) ?? '', input.commitSha);
    return fromManifest(objectPrefix, winner);
  }
  return {
    objectPrefix,
    treeKey,
    sha256: input.built.treeSha256,
    bytes: input.built.treeBytes,
    entries: input.built.entries,
    blobsKey,
    blobsSha256: input.built.blobsSha256,
    blobsBytes: input.built.blobsBytes,
    archive: treeOutcome === 'created' && blobsOutcome === 'created' ? 'created' : 'exists',
    manifest: 'created',
  };
}

const DIGEST_RE = /^[0-9a-f]{64}$/;

export function parseManifest(text: string, expectedSha: string): ProjectSnapshotManifest {
  let parsed: ProjectSnapshotManifest;
  try {
    parsed = JSON.parse(text) as ProjectSnapshotManifest;
  } catch {
    throw new Error('published manifest is not valid JSON');
  }
  const objectOk = (o: { key?: unknown; sha256?: unknown; bytes?: unknown } | undefined) =>
    typeof o?.key === 'string' &&
    DIGEST_RE.test(typeof o.sha256 === 'string' ? o.sha256 : '') &&
    Number.isInteger(o.bytes) &&
    (o.bytes as number) > 0;
  if (
    parsed?.format !== PROJECT_SNAPSHOT_FORMAT ||
    parsed.commit_sha !== expectedSha ||
    !objectOk(parsed.tree) ||
    !objectOk(parsed.blobs)
  ) {
    throw new Error(`published manifest does not describe commit ${expectedSha}`);
  }
  return parsed;
}
