/**
 * Read pinned source files from a published snapshot instead of from Git.
 *
 * This is the API half of "no Git network on a prepared start". Session
 * creation reads the manifest, the agent declarations and the OpenCode config
 * directory through here, so `refreshMirror`, `ls-remote` and `git show` never
 * run for a revision that is already published.
 *
 * It is an I/O-SOURCE change and nothing else: `compileAgentConfig` and every
 * selection/validation rule keep their current semantics, and the bytes handed
 * to them are byte-identical to what `git show <sha>:<path>` returns.
 *
 * The local cache is keyed by immutable identity, so a hit needs no revalidation
 * and two revisions never share a directory.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';
import { logger } from '../lib/logger';
import { createDecompressor } from './codec';
import {
  REPO_SNAPSHOT_DEFAULT_LIMITS,
  type RepoSnapshotCompression,
  type RepoSnapshotIdentity,
  isRepoSnapshotCompression,
  payloadKey,
} from './format';
import { requireRepoSnapshotBucket, s3GetObjectStream } from './s3';
import type { RepoSnapshotRow } from './store';

export class RepoSnapshotReadError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'RepoSnapshotReadError';
  }
}

function cacheRoot(): string {
  return process.env.KORTIX_REPO_SNAPSHOT_CACHE_DIR || join(tmpdir(), 'kortix', 'repo-snapshots', 'cache');
}

/**
 * How long an unused extracted snapshot is kept, and how many are kept at all.
 *
 * The cache is content-addressed and therefore append-only: every new revision
 * of every project adds a tree and nothing ever removed one, so an API host
 * filled its disk in proportion to how many revisions it had served. Eviction
 * is by LAST USE — a hit touches the directory — and never touches an entry
 * younger than `CACHE_MIN_AGE_MS`, which is orders of magnitude longer than the
 * read that follows a materialization.
 */
function cacheTtlMs(): number {
  return Math.max(1, Number(process.env.KORTIX_REPO_SNAPSHOT_CACHE_TTL_MINUTES) || 360) * 60_000;
}
function cacheMaxEntries(): number {
  return Math.max(1, Number(process.env.KORTIX_REPO_SNAPSHOT_CACHE_MAX_ENTRIES) || 200);
}
/** No entry is evicted before this, whatever the size pressure. */
const CACHE_MIN_AGE_MS = 10 * 60_000;
/** At most one prune per process per this interval. */
const PRUNE_INTERVAL_MS = 5 * 60_000;
let lastPruneAt = 0;
let pruning: Promise<void> | null = null;

/**
 * Trees a reader is inside RIGHT NOW, by path.
 *
 * A timestamp is not a lease. However recently a directory was touched, a
 * prune that has already decided to remove it will still remove it, and the
 * reader then reads a tree that is being deleted underneath it. So reads take
 * an actual lease: they register here for as long as they are using the path,
 * eviction refuses to touch anything registered, and a read that arrives while
 * a prune is running waits for it rather than racing it.
 *
 * In-process, because the prune is in-process: it is scheduled by this module
 * after its own materializations. Two API processes sharing one cache directory
 * would not coordinate — they do not, the cache lives in each container's own
 * filesystem — and the TTL and minimum age remain the backstop if they ever did.
 */
const activeReaders = new Map<string, number>();
/**
 * Trees whose removal has already been DECIDED, until the removal finishes.
 *
 * Checking "is anyone reading this" and then awaiting a delete leaves a window:
 * a reader can arrive after the check and be inside the tree when the delete
 * lands. So the decision is published synchronously — no `await` between the
 * check and the mark — and a reader that sees it waits for the removal and
 * materializes again rather than reading a tree that is going away.
 *
 * Both sequences are synchronous up to their first await, and this runtime is
 * single-threaded, so exactly one of them wins: either the reader is registered
 * before eviction looks, or eviction is marked before the reader looks.
 */
const evicting = new Map<string, Promise<unknown>>();
/** Longest a read waits for an in-flight eviction before materializing again. */
const EVICTION_WAIT_MS = 10_000;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function acquireTree(path: string): void {
  activeReaders.set(path, (activeReaders.get(path) ?? 0) + 1);
}

function releaseTree(path: string): void {
  const count = (activeReaders.get(path) ?? 0) - 1;
  if (count > 0) activeReaders.set(path, count);
  else activeReaders.delete(path);
}

/**
 * Materialize, then hold the tree for as long as `fn` is reading it.
 *
 * Lock-free on purpose: a reader never waits for eviction, because a prune that
 * stalls would then stall every session boot behind it. The ordering is made
 * safe by CONFIRMING the tree after taking the lease — the one window eviction
 * could still slip through is between materialization and registration, and a
 * tree deleted in that window no longer has its marker, which is detectable.
 * The read then materializes again, from the object store, and succeeds.
 */
async function withCachedTree<T>(row: RepoSnapshotRow, fn: (root: string) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const root = await materializeSnapshotLocally(row);
    // Register FIRST, then look — synchronously, with no await in between, so
    // this either happens entirely before eviction's own check or entirely
    // after its mark.
    acquireTree(root);
    const removal = evicting.get(root);
    if (removal) {
      releaseTree(root);
      // Wait for the removal, but never forever: a read is on a session's boot
      // path, and a delete that does not finish must degrade into another
      // materialization rather than into a hung boot. Extraction stages into a
      // temporary directory and renames, so racing a slow delete costs a
      // re-extract, not a corrupt tree.
      await Promise.race([removal.catch(() => {}), sleep(EVICTION_WAIT_MS)]);
      continue;
    }
    try {
      // And confirm the tree is still there. The `evicting` check above covers a
      // removal still in flight; this covers one that STARTED AND FINISHED
      // while this read was inside `materializeSnapshotLocally`, which then
      // returned a path to a directory that no longer exists. Together the two
      // cover every ordering: in-flight removals are waited for, completed ones
      // are detected, and a removal cannot begin while the lease is held.
      const marker = join(root, '.git', 'kortix-project-snapshot.json');
      if (await stat(marker).then(() => true).catch(() => false)) return await fn(root);
    } finally {
      releaseTree(root);
    }
  }
  throw new RepoSnapshotReadError(
    'the extracted snapshot kept being evicted while it was being read',
    'read_failed',
  );
}

/**
 * Drop extracted snapshots nobody has used recently.
 *
 * Best-effort and bounded: it walks the two-level cache layout once, never
 * removes an entry that is in flight or younger than `CACHE_MIN_AGE_MS`, and
 * swallows its own errors — a cache it cannot prune is a disk-space problem,
 * not a reason to fail the read that triggered it.
 */
export async function pruneSnapshotCache(now = Date.now()): Promise<number> {
  const root = cacheRoot();
  const entries: Array<{ path: string; usedAt: number }> = [];
  for (const repositoryId of await readdir(root).catch(() => [])) {
    for (const commitSha of await readdir(join(root, repositoryId)).catch(() => [])) {
      const commitDir = join(root, repositoryId, commitSha);
      for (const digest of await readdir(commitDir).catch(() => [])) {
        const path = join(commitDir, digest);
        // A staging directory belongs to a materialization in progress.
        if (digest.includes('.staging-')) continue;
        const info = await stat(path).catch(() => null);
        if (!info?.isDirectory()) continue;
        entries.push({ path, usedAt: Math.max(info.mtimeMs, info.atimeMs) });
      }
    }
  }

  const evictable = entries
    .filter((entry) => now - entry.usedAt > CACHE_MIN_AGE_MS && !inFlight.has(entry.path))
    .sort((a, b) => a.usedAt - b.usedAt);
  const overflow = Math.max(0, entries.length - cacheMaxEntries());
  const ttl = cacheTtlMs();
  let removed = 0;
  for (const [index, entry] of evictable.entries()) {
    const tooOld = now - entry.usedAt > ttl;
    if (!tooOld && index >= overflow) continue;
    // Re-read the timestamp immediately before removing. The scan above can be
    // several seconds old by now, and every read of a cached snapshot touches
    // its directory first (`materializeSnapshotLocally`) — so a hit that landed
    // since the scan means a reader is working inside this tree right now, and
    // the entry is no longer evictable. The touch IS the lease; its term is
    // `CACHE_MIN_AGE_MS`, renewed by every read.
    const current = await stat(entry.path).catch(() => null);
    if (!current) continue;
    const usedAt = Math.max(current.mtimeMs, current.atimeMs);
    if (usedAt !== entry.usedAt || Date.now() - usedAt <= CACHE_MIN_AGE_MS) continue;
    // The lease is the authority; the timestamps above are only a heuristic for
    // trees no reader in this process is holding. This check and the mark below
    // are one synchronous step — a reader arriving between them would otherwise
    // be inside the tree when it is removed.
    if (inFlight.has(entry.path) || activeReaders.has(entry.path) || evicting.has(entry.path)) continue;
    const removal = rm(entry.path, { recursive: true, force: true }).catch(() => {});
    evicting.set(entry.path, removal);
    try {
      await removal;
    } finally {
      evicting.delete(entry.path);
    }
    removed += 1;
  }
  if (removed > 0) {
    logger.info('[repo-snapshot] pruned the local snapshot cache', {
      removed,
      kept: entries.length - removed,
    });
  }
  return removed;
}

function schedulePrune(): void {
  const now = Date.now();
  if (pruning || now - lastPruneAt < PRUNE_INTERVAL_MS) return;
  lastPruneAt = now;
  pruning = pruneSnapshotCache()
    .then(() => undefined)
    .catch(() => undefined)
    .finally(() => {
      pruning = null;
    });
}

/** Immutable identity is the cache key; a hit needs no revalidation. */
function cacheDir(identity: Pick<RepoSnapshotIdentity, 'repositoryId' | 'commitSha'>, sha256: string): string {
  return join(cacheRoot(), identity.repositoryId, identity.commitSha, sha256);
}

/**
 * Same guard set as the sandbox extractor: reject rather than sanitize, so a
 * malformed or hostile archive fails instead of silently becoming a different
 * tree on the API's own filesystem.
 */
function unsafeEntry(path: string, type: string, mode: number | undefined, linkpath: string | null): string | null {
  if (!path || path === '.' || path === './') return null;
  if (path.startsWith('/') || path.includes('\0')) return `unsafe path: ${path}`;
  if (path.split('/').some((segment) => segment === '..')) return `path escapes the archive root: ${path}`;
  if (type === 'Link') return `hard links are not allowed: ${path}`;
  if (!['File', 'Directory', 'SymbolicLink'].includes(type)) return `unsupported entry type ${type}: ${path}`;
  if (typeof mode === 'number' && (mode & 0o7000) !== 0) return `privileged mode: ${path}`;
  if (type === 'SymbolicLink') {
    const target = linkpath ?? '';
    if (!target || target.startsWith('/')) return `symlink escapes staging: ${path}`;
    const resolved = path.split('/').slice(0, -1);
    for (const part of target.split('/')) {
      if (part === '' || part === '.') continue;
      if (part === '..') {
        if (resolved.length === 0) return `symlink escapes staging: ${path}`;
        resolved.pop();
        continue;
      }
      resolved.push(part);
    }
  }
  return null;
}

const inFlight = new Map<string, Promise<string>>();

/**
 * Materialize the snapshot into the local cache and return its directory.
 *
 * Streams S3 -> digest -> decompressor -> bounded extractor into a private
 * temporary directory, verifies the whole-object digest, and only then renames
 * the directory into the cache. A partially extracted tree is therefore never
 * visible under a cache key.
 */
export async function materializeSnapshotLocally(row: RepoSnapshotRow): Promise<string> {
  if (row.status !== 'ready' || !row.archiveSha256 || !isRepoSnapshotCompression(row.compression)) {
    throw new RepoSnapshotReadError('snapshot is not ready', 'not_ready');
  }
  const identity: RepoSnapshotIdentity = {
    provider: 'github',
    repositoryId: row.repositoryId,
    owner: row.owner,
    repo: row.repo,
    commitSha: row.commitSha,
  };
  const target = cacheDir(identity, row.archiveSha256);
  const marker = join(target, '.git', 'kortix-project-snapshot.json');
  if (await stat(marker).then(() => true).catch(() => false)) {
    // Renew the lease BEFORE handing the path back. Every read of a cached
    // snapshot comes through here, so a reader that is about to spend seconds
    // in this tree has just marked it as in use, and `pruneSnapshotCache`
    // re-checks that mark immediately before it removes anything.
    const now = new Date();
    await utimes(target, now, now).catch(() => {});
    return target;
  }

  const existing = inFlight.get(target);
  if (existing) return existing;
  const work = (async () => {
    const key = row.payloadKey ?? payloadKey(identity, row.archiveSha256!, row.compression as RepoSnapshotCompression);
    await mkdir(dirname(target), { recursive: true });
    const staging = await mkdtemp(`${target}.staging-`);
    try {
      const object = await s3GetObjectStream(requireRepoSnapshotBucket(), key);
      const hash = createHash('sha256');
      let compressedBytes = 0;
      let expandedBytes = 0;
      const limits = REPO_SNAPSHOT_DEFAULT_LIMITS;
      let rejection: RepoSnapshotReadError | null = null;

      await pipeline(
        Readable.fromWeb(object.body as never),
        new Transform({
          transform(chunk: Buffer, _enc, callback) {
            compressedBytes += chunk.length;
            if (compressedBytes > limits.maxCompressedBytes) {
              callback(new RepoSnapshotReadError('snapshot exceeds the compressed limit', 'too_large'));
              return;
            }
            hash.update(chunk);
            callback(null, chunk);
          },
        }),
        createDecompressor(row.compression as RepoSnapshotCompression),
        new Transform({
          transform(chunk: Buffer, _enc, callback) {
            expandedBytes += chunk.length;
            if (expandedBytes > limits.maxExpandedBytes) {
              callback(new RepoSnapshotReadError('snapshot exceeds the expansion limit', 'too_large'));
              return;
            }
            callback(null, chunk);
          },
        }),
        tar.x({
          cwd: staging,
          preservePaths: false,
          strip: 0,
          filter: (path, entry) => {
            const reason = unsafeEntry(
              path,
              String((entry as { type?: unknown }).type ?? 'File'),
              (entry as { mode?: number }).mode,
              (entry as { linkpath?: string | null }).linkpath ?? null,
            );
            if (reason && !rejection) rejection = new RepoSnapshotReadError(reason, 'unsafe_entry');
            return !reason;
          },
        }),
      );
      if (rejection) throw rejection;
      const digest = hash.digest('hex');
      if (digest !== row.archiveSha256) {
        throw new RepoSnapshotReadError(
          `snapshot digest mismatch: expected ${row.archiveSha256}, got ${digest}`,
          'digest_mismatch',
        );
      }
      try {
        await rename(staging, target);
      } catch {
        // Another materializer won the race. Its tree passed the same checks.
        await rm(staging, { recursive: true, force: true }).catch(() => {});
      }
      logger.info('[repo-snapshot] materialized locally', {
        repositoryId: row.repositoryId,
        commitSha: row.commitSha,
        compressedBytes,
        expandedBytes,
      });
      // The only moment the cache grows is the only moment worth pruning it.
      schedulePrune();
      return target;
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  })().finally(() => inFlight.delete(target));
  inFlight.set(target, work);
  return work;
}

function assertInsideSnapshot(root: string, relative: string): string {
  if (relative.startsWith('/') || relative.split('/').some((segment) => segment === '..')) {
    throw new RepoSnapshotReadError(`path escapes the snapshot: ${relative}`, 'unsafe_path');
  }
  return join(root, relative);
}

/**
 * Read one file at the pinned revision. Returns null when the file is absent,
 * exactly like `readManifestFromRepo` distinguishes "absent" from "unreadable".
 */
export async function readSnapshotFile(
  row: RepoSnapshotRow,
  relativePath: string,
): Promise<{ content: string; bytes: number } | null> {
  return withCachedTree(row, async (root) => {
    const absolute = assertInsideSnapshot(root, relativePath);
    try {
      const content = await readFile(absolute, 'utf8');
      return { content, bytes: Buffer.byteLength(content) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      throw new RepoSnapshotReadError(
        `snapshot read failed for ${relativePath}: ${(error as Error).message}`,
        'read_failed',
      );
    }
  });
}

export async function snapshotDirectoryExists(row: RepoSnapshotRow, relativePath: string): Promise<boolean> {
  return withCachedTree(row, async (root) => {
    const absolute = assertInsideSnapshot(root, relativePath);
    return stat(absolute).then((info) => info.isDirectory()).catch(() => false);
  });
}

export async function listSnapshotDirectory(row: RepoSnapshotRow, relativePath: string): Promise<string[]> {
  return withCachedTree(row, async (root) => {
    const absolute = assertInsideSnapshot(root, relativePath);
    return readdir(absolute).catch(() => []);
  });
}

/**
 * Hold a materialized tree for a caller that will read it directly.
 *
 * For anything that takes the PATH out of this module — the benchmark harness,
 * a caller that hands the directory to a child process — and must not have it
 * deleted underneath while it works.
 */
export async function withSnapshotTree<T>(
  row: RepoSnapshotRow,
  fn: (root: string) => Promise<T>,
): Promise<T> {
  return withCachedTree(row, fn);
}
