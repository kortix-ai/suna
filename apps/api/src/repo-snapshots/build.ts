/**
 * Build one immutable, project-neutral repository snapshot at an exact commit.
 *
 * Derived from `git-proxy/compiled-checkout.ts`, with the three properties that
 * made that artifact unshareable removed:
 *   - it is pinned to a SHA, not to a branch that may have moved;
 *   - it carries NO project id, ref, origin URL or credential, so two projects
 *     on the same revision can share one object;
 *   - its Git metadata is an explicit allowlist, not whatever the producing
 *     machine happened to have configured.
 *
 * The archive is written to a temporary file and streamed on the way there:
 * tar -> codec -> digest -> disk. Nothing buffers the whole archive in memory.
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';
import { createCompressor } from './codec';
import { logger } from '../lib/logger';
import { validateSha } from '../projects/git-ref';
import { refreshMirror, runGit, runGitCapture } from '../projects/git/mirror';
import type { GitBackedProject } from '../projects/git/types';
import {
  archiveExtension,
  REPO_SNAPSHOT_DEFAULT_LIMITS,
  REPO_SNAPSHOT_EMBEDDED_MANIFEST,
  REPO_SNAPSHOT_FORMAT,
  REPO_SNAPSHOT_LAYOUT_VERSION,
  type RepoSnapshotCompression,
  type RepoSnapshotIdentity,
  type RepoSnapshotLimits,
  type RepoSnapshotManifest,
  payloadKey,
  serializeRepoSnapshotManifest,
} from './format';

/**
 * Bumped whenever the produced bytes change meaning: the sanitized Git config,
 * the entry set, or the layout. Recorded in every manifest so a future reader
 * can tell which producer wrote an object.
 */
export const REPO_SNAPSHOT_PRODUCER_VERSION = 'kortix-repo-snapshot/1.0.0';

const GIT_FETCH_TIMEOUT_MS = 180_000;
/** Lets `git fetch` ask the local mirror for a bare SHA instead of a ref. */
const UPLOAD_PACK_ANY_SHA = 'git -c uploadpack.allowAnySHA1InWant=true upload-pack';

/**
 * Check out WITHOUT running the repository's declared smudge filters.
 *
 * A `.gitattributes` entry is content the repository controls, and a filter is
 * a command. Letting `git checkout` run one during packaging would execute
 * repo-supplied code on the producer — the same thing the brief forbids for
 * hooks and config includes — and it is also what breaks LFS repositories
 * outright: without a `git-lfs` binary the checkout fails with
 * "git-lfs: command not found" and no snapshot can be produced at all.
 *
 * Disabling the LFS filter reproduces exactly what a checkout on a machine with
 * no `git-lfs` produces: the POINTER file, byte for byte. That is the current
 * behaviour this feature must preserve, not a degradation of it.
 *
 * A repository declaring some OTHER custom filter still fails the checkout when
 * that binary is absent. That failure is loud and reported, which is the right
 * outcome — silently packaging differently-transformed content would not be.
 */
const NO_SMUDGE_FILTERS = [
  '-c', 'filter.lfs.required=false',
  '-c', 'filter.lfs.smudge=cat',
  '-c', 'filter.lfs.clean=cat',
  '-c', 'filter.lfs.process=',
];
const NO_SMUDGE_ENV = { GIT_LFS_SKIP_SMUDGE: '1' };

/**
 * Everything Git needs to operate on the extracted tree, and nothing the
 * producing machine contributed. No origin (the session installs its own), no
 * credential helper, no hooks path, no alternates, no filters, no includes.
 *
 * `ignorecase`/`precomposeunicode` are pinned to the Linux sandbox's semantics
 * so an archive produced on a macOS developer machine behaves identically.
 */
const SANITIZED_GIT_CONFIG = `[core]
\trepositoryformatversion = 0
\tfilemode = true
\tbare = false
\tlogallrefupdates = true
\tignorecase = false
\tprecomposeunicode = false
`;

export class RepoSnapshotSourceMovedError extends Error {
  constructor(expectedSha: string, actual: string) {
    super(`snapshot source unavailable: ${expectedSha} not reachable (${actual})`);
    this.name = 'RepoSnapshotSourceMovedError';
  }
}

export class RepoSnapshotTooLargeError extends Error {
  constructor(what: string, limit: number, actual: number) {
    super(`snapshot ${what} exceeds ${limit} bytes (${actual})`);
    this.name = 'RepoSnapshotTooLargeError';
  }
}

export interface BuiltRepoSnapshot {
  /** Temporary archive path. The caller uploads it and then removes `root`. */
  archivePath: string;
  /** Temporary working root that owns `archivePath`. */
  root: string;
  manifest: RepoSnapshotManifest;
  /** Facts a coverage report needs but the shared manifest must not carry. */
  notes: {
    submoduleCount: number;
    lfsPointerCount: number;
    symlinkCount: number;
    executableCount: number;
  };
}

interface SnapshotEntry {
  /** Repository-relative POSIX path, sorted for deterministic archive order. */
  path: string;
  size: number;
  mode: number;
  symlink: boolean;
  directory: boolean;
}

/** Recursive, deterministic listing of everything under `root`, `.git` included. */
async function listEntries(root: string, limits: RepoSnapshotLimits): Promise<SnapshotEntry[]> {
  const out: SnapshotEntry[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    const dirents = await readdir(dir, { withFileTypes: true });
    for (const dirent of dirents) {
      const absolute = join(dir, dirent.name);
      const rel = relative(root, absolute).split(sep).join('/');
      if (dirent.isDirectory()) {
        stack.push(absolute);
        out.push({ path: rel, size: 0, mode: 0o755, symlink: false, directory: true });
        continue;
      }
      if (dirent.isSymbolicLink()) {
        out.push({ path: rel, size: 0, mode: 0o777, symlink: true, directory: false });
        continue;
      }
      if (!dirent.isFile()) {
        // Sockets, FIFOs and devices cannot appear in a Git checkout and must
        // never reach the archive.
        throw new Error(`snapshot source contains an unsupported entry: ${rel}`);
      }
      const info = await stat(absolute);
      if (info.size > limits.maxEntryBytes) {
        throw new RepoSnapshotTooLargeError(`entry ${rel}`, limits.maxEntryBytes, info.size);
      }
      out.push({ path: rel, size: info.size, mode: info.mode & 0o777, symlink: false, directory: false });
      if (out.length > limits.maxEntryCount) {
        throw new RepoSnapshotTooLargeError('entry count', limits.maxEntryCount, out.length);
      }
    }
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

/**
 * Fetch exactly `commitSha` into a fresh repository and check it out detached.
 *
 * `git clone --branch <ref>` is deliberately NOT used: the branch may already
 * point somewhere else by the time a queued build runs, and an archive that
 * silently packaged a different commit is the failure this whole feature exists
 * to prevent.
 */
async function checkoutExactCommit(
  project: GitBackedProject,
  commitSha: string,
  checkout: string,
): Promise<void> {
  let mirror = await refreshMirror(project);
  let present = await runGitCapture(['cat-file', '-e', `${commitSha}^{commit}`], mirror);
  if (present.exitCode !== 0) {
    mirror = await refreshMirror(project, true);
    present = await runGitCapture(['cat-file', '-e', `${commitSha}^{commit}`], mirror);
  }
  if (present.exitCode !== 0) {
    throw new RepoSnapshotSourceMovedError(commitSha, present.stderr.trim() || 'absent from mirror');
  }

  await mkdir(checkout, { recursive: true });
  await runGit(['init', '--quiet', checkout], undefined, false);
  await runGit(
    [
      '-C',
      checkout,
      ...NO_SMUDGE_FILTERS,
      'fetch',
      '--quiet',
      '--depth',
      '1',
      '--no-tags',
      '--no-recurse-submodules',
      '--upload-pack',
      UPLOAD_PACK_ANY_SHA,
      mirror,
      commitSha,
    ],
    undefined,
    false,
    undefined,
    NO_SMUDGE_ENV,
    undefined,
    GIT_FETCH_TIMEOUT_MS,
  );
  await runGit(
    ['-C', checkout, ...NO_SMUDGE_FILTERS, 'checkout', '--quiet', '--detach', commitSha],
    undefined,
    false,
    undefined,
    NO_SMUDGE_ENV,
  );
  const head = (await runGit(['-C', checkout, 'rev-parse', '--verify', 'HEAD'], undefined, false)).stdout.trim();
  if (head !== commitSha) throw new RepoSnapshotSourceMovedError(commitSha, head);
}

/**
 * Strip every machine-specific and project-specific trace from `.git`.
 *
 * Verification must never execute archive-supplied code, so hooks, filters,
 * credential helpers and config includes are removed rather than inspected.
 */
async function sanitizeGitMetadata(checkout: string): Promise<void> {
  const gitDir = join(checkout, '.git');
  await rm(join(gitDir, 'logs'), { recursive: true, force: true });
  await rm(join(gitDir, 'hooks'), { recursive: true, force: true });
  await rm(join(gitDir, 'objects', 'info', 'alternates'), { force: true });
  for (const file of ['FETCH_HEAD', 'ORIG_HEAD', 'COMMIT_EDITMSG', 'index', 'config']) {
    await rm(join(gitDir, file), { force: true });
  }
  await writeFile(join(gitDir, 'config'), SANITIZED_GIT_CONFIG, { mode: 0o644 });
  // A fresh index with zeroed stat data: deterministic across producers, and
  // `git status` still answers "clean" because it falls back to content
  // comparison for entries whose stat cache is empty. Filters stay disabled
  // here too — `read-tree` must not re-run one the checkout just bypassed.
  await runGit(
    ['-C', checkout, ...NO_SMUDGE_FILTERS, 'read-tree', 'HEAD'],
    undefined,
    false,
    undefined,
    NO_SMUDGE_ENV,
  );
  // `git fetch` records the local mirror path here; it is a producer detail.
  await rm(join(gitDir, 'refs', 'remotes'), { recursive: true, force: true });
  await writeFile(join(gitDir, 'packed-refs.lock'), '', { flag: 'w' }).catch(() => {});
  await rm(join(gitDir, 'packed-refs.lock'), { force: true });
}

async function countNotes(
  checkout: string,
  entries: SnapshotEntry[],
): Promise<BuiltRepoSnapshot['notes']> {
  const gitmodules = entries.some((e) => e.path === '.gitmodules');
  let submoduleCount = 0;
  if (gitmodules) {
    const listed = await runGitCapture(['-C', checkout, 'ls-files', '--stage'], undefined);
    submoduleCount = listed.stdout.split('\n').filter((l) => l.startsWith('160000 ')).length;
  }
  let lfsPointerCount = 0;
  const attributes = entries.some((e) => e.path.endsWith('.gitattributes'));
  if (attributes) {
    const grep = await runGitCapture(
      ['-C', checkout, 'grep', '-l', '--fixed-strings', 'version https://git-lfs.github.com/spec', 'HEAD'],
      undefined,
    );
    lfsPointerCount = grep.exitCode === 0 ? grep.stdout.split('\n').filter(Boolean).length : 0;
  }
  // Working-tree facts only: `.git` internals are producer detail, not content.
  const tracked = entries.filter((e) => !e.path.startsWith('.git/') && e.path !== '.git');
  return {
    submoduleCount,
    lfsPointerCount,
    symlinkCount: tracked.filter((e) => e.symlink).length,
    executableCount: tracked.filter((e) => !e.symlink && !e.directory && (e.mode & 0o111) !== 0).length,
  };
}

/**
 * Produce the archive plus its manifest. The caller publishes them; this
 * function performs no network I/O beyond the mirror it already needs.
 */
export async function buildRepoSnapshot(
  project: GitBackedProject,
  identity: RepoSnapshotIdentity,
  options: {
    compression: RepoSnapshotCompression;
    limits?: RepoSnapshotLimits;
    workRoot?: string;
  },
): Promise<BuiltRepoSnapshot> {
  const commitSha = validateSha(identity.commitSha);
  const limits = options.limits ?? REPO_SNAPSHOT_DEFAULT_LIMITS;
  const base = options.workRoot ?? join(tmpdir(), 'kortix', 'repo-snapshots');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'build-'));
  const checkout = join(root, 'checkout');
  const archivePath = join(root, `snapshot.${archiveExtension(options.compression)}`);

  try {
    await checkoutExactCommit(project, commitSha, checkout);
    const treeSha = (
      await runGit(['-C', checkout, 'rev-parse', '--verify', 'HEAD^{tree}'], undefined, false)
    ).stdout.trim();
    await sanitizeGitMetadata(checkout);

    const entries = await listEntries(checkout, limits);
    const notes = await countNotes(checkout, entries);
    const contentBytes = entries.reduce((sum, e) => sum + e.size, 0);
    if (contentBytes > limits.maxExpandedBytes) {
      throw new RepoSnapshotTooLargeError('content size', limits.maxExpandedBytes, contentBytes);
    }

    // Written last so it is inside the archive but outside the Git index — the
    // extracted tree stays clean while remaining self-describing.
    const embeddedPath = join(checkout, REPO_SNAPSHOT_EMBEDDED_MANIFEST);
    // Files and symlinks only, plus EMPTY directories.
    //
    // Handing node-tar a non-empty directory makes it recurse into that
    // directory AND emit the children that are also listed explicitly, so the
    // archive gains duplicate entries for every nested path (measured: a
    // 55-path tree produced 153 entries, `src/deep/c.txt` three times).
    // Duplicate entries are exactly what the consumer's guards treat as
    // hostile, and the parent directories tar creates implicitly are all a Git
    // checkout needs. An empty directory has no children to duplicate and is
    // kept so `.git/refs/tags` and friends survive the round trip.
    const nonEmptyDirectories = new Set(
      entries
        .filter((entry) => entry.path.includes('/'))
        .map((entry) => entry.path.slice(0, entry.path.lastIndexOf('/'))),
    );
    const archiveEntries = [
      ...entries
        .filter((entry) => !entry.directory || !nonEmptyDirectories.has(entry.path))
        .map((entry) => entry.path),
      REPO_SNAPSHOT_EMBEDDED_MANIFEST,
    ];

    // Counted on the UNCOMPRESSED side so `expanded_bytes` is exactly what a
    // consumer's decompressor will emit — the number an expansion guard can
    // enforce, unlike a sum of file sizes which ignores TAR framing.
    let expandedBytes = 0;
    const expansion = new Transform({
      transform(chunk: Buffer, _enc, callback) {
        expandedBytes += chunk.length;
        if (expandedBytes > limits.maxExpandedBytes) {
          callback(new RepoSnapshotTooLargeError('expanded size', limits.maxExpandedBytes, expandedBytes));
          return;
        }
        callback(null, chunk);
      },
    });
    const hash = createHash('sha256');
    let compressedBytes = 0;
    const digest = new Transform({
      transform(chunk: Buffer, _enc, callback) {
        compressedBytes += chunk.length;
        if (compressedBytes > limits.maxCompressedBytes) {
          callback(new RepoSnapshotTooLargeError('archive', limits.maxCompressedBytes, compressedBytes));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });

    // Two passes: the manifest names the archive digest, and the digest covers
    // the manifest, so the embedded copy carries identity without the payload
    // block. The S3 manifest object holds the full record.
    await writeFile(
      embeddedPath,
      `${JSON.stringify({
        format: REPO_SNAPSHOT_FORMAT,
        source: {
          provider: identity.provider,
          repository_id: identity.repositoryId,
          owner: identity.owner,
          repo: identity.repo,
          commit_sha: commitSha,
          tree_sha: treeSha,
        },
        checkout: { git_metadata: 'sanitized-shallow', layout_version: REPO_SNAPSHOT_LAYOUT_VERSION },
        producer_version: REPO_SNAPSHOT_PRODUCER_VERSION,
      })}\n`,
      { mode: 0o644 },
    );

    // Counted from the archive itself, not from the path list handed to tar:
    // the writer decides how many entries a path set becomes, and a consumer
    // enforces this number exactly.
    let writtenEntries = 0;
    await pipeline(
      tar.create(
        {
          cwd: checkout,
          portable: true,
          noMtime: true,
          preservePaths: false,
          follow: false,
          onWriteEntry: () => {
            writtenEntries += 1;
          },
        },
        archiveEntries,
      ),
      expansion,
      createCompressor(options.compression),
      digest,
      createWriteStream(archivePath, { mode: 0o600 }),
    );

    const archiveSha256 = hash.digest('hex');
    const manifest: RepoSnapshotManifest = {
      format: REPO_SNAPSHOT_FORMAT,
      source: {
        provider: identity.provider,
        repository_id: identity.repositoryId,
        owner: identity.owner,
        repo: identity.repo,
        commit_sha: commitSha,
        tree_sha: treeSha,
      },
      payload: {
        key: payloadKey(identity, archiveSha256, options.compression),
        compression: options.compression,
        sha256: archiveSha256,
        compressed_bytes: compressedBytes,
        expanded_bytes: expandedBytes,
        entry_count: writtenEntries,
      },
      checkout: { git_metadata: 'sanitized-shallow', layout_version: REPO_SNAPSHOT_LAYOUT_VERSION },
      producer_version: REPO_SNAPSHOT_PRODUCER_VERSION,
    };
    // Parse-check our own output before anyone can publish it.
    serializeRepoSnapshotManifest(manifest);
    logger.info('[repo-snapshot] built', {
      repositoryId: identity.repositoryId,
      commitSha,
      compression: options.compression,
      compressedBytes,
      expandedBytes,
      contentBytes,
      entryCount: manifest.payload.entry_count,
      ...notes,
    });
    return { archivePath, root, manifest, notes };
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function discardBuiltRepoSnapshot(built: Pick<BuiltRepoSnapshot, 'root'>): Promise<void> {
  await rm(built.root, { recursive: true, force: true }).catch(() => {});
}
