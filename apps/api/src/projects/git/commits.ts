// Commit reads + shared git-log parsing primitives (FIELD/RECORD separators,
// LOG_FORMAT, parseLogStdout, decodeStatusChar) used by branches.ts and
// merge.ts as well.

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateRef, validateSha } from '../git-ref';
import { normalizeTreePath, refreshMirror, runGit } from './mirror';
import { resolveOpencodeConfigDirAtSha } from './opencode-config-dir';
import { scaffoldTreeSha } from './scaffold-identity';
import type {
  CommitDiff,
  GetCommitDiffOptions,
  GitBackedProject,
  GitCommitDetail,
  GitCommitFile,
  GitLogEntry,
  ListCommitsOptions,
} from './types';

export const FIELD_SEP = '';
export const RECORD_SEP = '';
export const MAX_FAST_BOOT_GIT_BUNDLE_BASE64_BYTES = 24 * 1024;
export const LOG_FORMAT = [
  '%H',
  '%h',
  '%P',
  '%an',
  '%ae',
  '%aI',
  '%cn',
  '%ce',
  '%cI',
  '%s',
  '%b',
].join(FIELD_SEP) + RECORD_SEP;

export function parseLogStdout(stdout: string): GitLogEntry[] {
  return stdout
    .split(RECORD_SEP)
    .map((chunk) => chunk.replace(/^\n+/, ''))
    .filter((chunk) => chunk.length > 0)
    .map<GitLogEntry | null>((chunk) => {
      const parts = chunk.split(FIELD_SEP);
      if (parts.length < 11) return null;
      const [
        hash,
        shortHash,
        parents,
        authorName,
        authorEmail,
        authoredAt,
        committerName,
        committerEmail,
        committedAt,
        subject,
        ...bodyParts
      ] = parts;
      return {
        hash,
        short_hash: shortHash,
        parents: parents ? parents.split(' ').filter(Boolean) : [],
        author_name: authorName,
        author_email: authorEmail,
        authored_at: authoredAt,
        committer_name: committerName,
        committer_email: committerEmail,
        committed_at: committedAt,
        subject,
        body: bodyParts.join(FIELD_SEP).replace(/\s+$/, ''),
      };
    })
    .filter((entry): entry is GitLogEntry => entry !== null);
}

export function decodeStatusChar(code: string): GitCommitFile['status'] {
  const head = code[0] || 'M';
  switch (head) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    case 'T':
      return 'typechange';
    default:
      return 'modified';
  }
}

/**
 * Resolve a ref (branch name, tag, "HEAD") to a full 40-char commit SHA.
 * Used by the snapshot builder to pin a build to a specific commit even
 * when the default branch moves underneath it.
 */
export async function resolveCommitSha(project: GitBackedProject, ref?: string): Promise<string> {
  const treeRef = validateRef(ref || project.defaultBranch);
  const repoPath = await refreshMirror(project);
  const result = await runGit(['rev-parse', '--verify', `${treeRef}^{commit}`], repoPath, false);
  const sha = result.stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`Unexpected git rev-parse output for ${treeRef}: ${sha}`);
  }
  return sha;
}

export interface FastBootGitHint {
  baseSha: string;
  gitDeltaBundleBase64?: string;
  gitDeltaParentSha?: string;
  gitDeltaParentCommitBase64?: string;
  /**
   * The delta exceeds the inline env cap. The daemon downloads it with ONE
   * authenticated GET (`/v1/git/<project>.git/fast-boot-bundle`) instead of a
   * negotiated `git fetch` through the proxy.
   */
  gitDeltaBundleRemote?: boolean;
  /**
   * OpenCode config dir at `baseSha`, relative to the repo root, or `null` when
   * the revision ships no `opencode.json[c]` (daemon uses its baked default).
   * Lets the daemon spawn OpenCode BEFORE the checkout exists.
   */
  opencodeConfigDir?: string | null;
}

/** Hard ceiling for a remote (downloaded) fast-boot bundle. */
export const MAX_FAST_BOOT_GIT_BUNDLE_BYTES = 64 * 1024 * 1024;
/** Refuse to bundle more history than this — a repo this deep is not a scaffold delta. */
export const MAX_FAST_BOOT_DELTA_COMMITS = 5_000;

export interface ScaffoldDeltaBundle {
  baseSha: string;
  /** Boundary commit the sandbox already owns (or can reconstruct from its tree). */
  parentSha: string;
  parentCommitBase64: string;
  /** Inline payload when it fits the env cap; otherwise null → remote download. */
  bundleBase64: string | null;
  bundleBytes: number;
}

/**
 * Locate the bundle boundary for `tip`: the first-parent ROOT commit. Every
 * project seeded from the Kortix starter starts life as the deterministic
 * scaffold commit, so the root is the one commit the sandbox image can supply
 * from `/opt/kortix/scaffold.git` — either byte-for-byte (same SHA) or by tree
 * (a provider rewrote commit metadata; the daemon re-creates the commit object
 * from `parentCommitBase64` on top of the baked tree).
 *
 * `scaffoldTreeSha`, when known, gates the bundle on the root's tree matching
 * the CURRENT starter: an imported repo (unrelated root) would otherwise bundle
 * its entire history for a payload the daemon then rejects.
 */
export async function resolveScaffoldDeltaBoundary(
  repoPath: string,
  ref: string,
  opts: { scaffoldTreeSha?: string | null } = {},
): Promise<{ baseSha: string; parentSha: string; commitCount: number } | null> {
  const treeRef = validateRef(ref);
  const baseSha = (
    await runGit(['rev-parse', '--verify', `${treeRef}^{commit}`], repoPath, false)
  ).stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(baseSha)) return null;
  const root = (
    await runGit(
      ['rev-list', '--first-parent', '--max-parents=0', '-n', '1', baseSha],
      repoPath,
      false,
    )
  ).stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(root) || root === baseSha) return null;
  if (opts.scaffoldTreeSha) {
    const rootTree = (
      await runGit(['rev-parse', '--verify', `${root}^{tree}`], repoPath, false)
    ).stdout.trim();
    if (rootTree !== opts.scaffoldTreeSha) return null;
  }
  const commitCount = Number(
    (await runGit(['rev-list', '--count', `${root}..${baseSha}`], repoPath, false)).stdout.trim(),
  );
  if (!Number.isFinite(commitCount) || commitCount <= 0 || commitCount > MAX_FAST_BOOT_DELTA_COMMITS) {
    return null;
  }
  return { baseSha, parentSha: root, commitCount };
}

/**
 * Build the bundle `tip ^root`: every commit the project accumulated above
 * its scaffold root. The sandbox image already owns the root (see
 * `resolveScaffoldDeltaBoundary`), so this payload supplies the exact base
 * tip without an in-sandbox fetch. Small deltas ride the session env inline;
 * larger ones stay on the API for a single authenticated download.
 */
export async function buildScaffoldDeltaBundle(
  repoPath: string,
  ref: string,
  opts: { scaffoldTreeSha?: string | null; inlineCapBytes?: number } = {},
): Promise<ScaffoldDeltaBundle | null> {
  const treeRef = validateRef(ref);
  const boundary = await resolveScaffoldDeltaBoundary(repoPath, treeRef, opts);
  if (!boundary) return null;
  const { baseSha, parentSha } = boundary;
  const parentCommitBase64 = Buffer.from(
    (await runGit(['cat-file', 'commit', parentSha], repoPath, false)).stdout,
  ).toString('base64');
  const temp = await mkdtemp(join(tmpdir(), 'kortix-fast-boot-bundle-'));
  const bundlePath = join(temp, 'delta.bundle');
  try {
    await runGit(
      ['bundle', 'create', bundlePath, `refs/heads/${treeRef}`, `^${parentSha}`],
      repoPath,
      false,
    );
    const bytes = await readFile(bundlePath);
    if (bytes.byteLength > MAX_FAST_BOOT_GIT_BUNDLE_BYTES) return null;
    const bundleBase64 = bytes.toString('base64');
    const inlineCap = opts.inlineCapBytes ?? MAX_FAST_BOOT_GIT_BUNDLE_BASE64_BYTES;
    const fitsInline =
      Buffer.byteLength(bundleBase64 + parentCommitBase64, 'utf8') <= inlineCap;
    return {
      baseSha,
      parentSha,
      parentCommitBase64,
      bundleBase64: fitsInline ? bundleBase64 : null,
      bundleBytes: bytes.byteLength,
    };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

/**
 * Legacy shape kept for callers/tests that expect an inline-only payload:
 * `null` when the delta does not fit the env cap.
 */
export async function buildSingleParentDeltaBundle(
  repoPath: string,
  ref: string,
): Promise<{
  baseSha: string;
  parentSha: string;
  parentCommitBase64: string;
  bundleBase64: string;
} | null> {
  const delta = await buildScaffoldDeltaBundle(repoPath, ref);
  if (!delta || !delta.bundleBase64) return null;
  return {
    baseSha: delta.baseSha,
    parentSha: delta.parentSha,
    parentCommitBase64: delta.parentCommitBase64,
    bundleBase64: delta.bundleBase64,
  };
}

/**
 * Write the bundle `tip ^parent` to `outPath` for the remote download route.
 * Fails when `tip` is not a descendant of `parent` in this mirror.
 */
export async function writeScaffoldDeltaBundle(
  repoPath: string,
  ref: string,
  tipSha: string,
  parentSha: string,
  outPath: string,
): Promise<number> {
  const treeRef = validateRef(ref);
  validateSha(tipSha);
  validateSha(parentSha);
  const actual = (
    await runGit(['rev-parse', '--verify', `${treeRef}^{commit}`], repoPath, false)
  ).stdout.trim();
  if (actual !== tipSha) {
    throw new Error(`fast-boot bundle: ${treeRef} is at ${actual}, not ${tipSha}`);
  }
  const ancestor = await runGit(
    ['merge-base', '--is-ancestor', parentSha, tipSha],
    repoPath,
    false,
  ).then(() => true, () => false);
  if (!ancestor) {
    throw new Error(`fast-boot bundle: ${parentSha} is not an ancestor of ${tipSha}`);
  }
  await runGit(
    ['bundle', 'create', outPath, `refs/heads/${treeRef}`, `^${parentSha}`],
    repoPath,
    false,
  );
  const size = (await stat(outPath)).size;
  if (size > MAX_FAST_BOOT_GIT_BUNDLE_BYTES) {
    await rm(outPath, { force: true });
    throw new Error(`fast-boot bundle exceeds ${MAX_FAST_BOOT_GIT_BUNDLE_BYTES} bytes (${size})`);
  }
  return size;
}

/** Resolve the base tip and attach a bounded local-mirror delta when possible. */
export async function resolveFastBootGitHint(
  project: GitBackedProject,
  ref?: string,
  forceRefresh = false,
): Promise<FastBootGitHint> {
  const treeRef = validateRef(ref || project.defaultBranch);
  const repoPath = await refreshMirror(project, forceRefresh);
  const baseSha = (
    await runGit(['rev-parse', '--verify', `${treeRef}^{commit}`], repoPath, false)
  ).stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(baseSha)) {
    throw new Error(`Unexpected git rev-parse output for ${treeRef}: ${baseSha}`);
  }
  // Both look-ups read the same mirror and are independent; the config dir is
  // what lets the daemon spawn OpenCode before the checkout lands.
  const [delta, opencodeConfigDir] = await Promise.all([
    scaffoldTreeSha()
      .then((tree) => buildScaffoldDeltaBundle(repoPath, treeRef, { scaffoldTreeSha: tree }))
      .catch((error) => {
        console.warn('[git] fast-boot delta bundle unavailable', {
          projectId: project.projectId,
          ref: treeRef,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }),
    resolveOpencodeConfigDirAtSha(repoPath, project, baseSha).catch(() => undefined),
  ]);
  const hint: FastBootGitHint = { baseSha };
  if (opencodeConfigDir !== undefined) hint.opencodeConfigDir = opencodeConfigDir;
  if (delta?.baseSha === baseSha) {
    hint.gitDeltaParentSha = delta.parentSha;
    hint.gitDeltaParentCommitBase64 = delta.parentCommitBase64;
    if (delta.bundleBase64) hint.gitDeltaBundleBase64 = delta.bundleBase64;
    else hint.gitDeltaBundleRemote = true;
  }
  return hint;
}

export async function listCommits(
  project: GitBackedProject,
  options: ListCommitsOptions = {},
): Promise<{ commits: GitLogEntry[]; hasMore: boolean }> {
  const repoPath = await refreshMirror(project);
  const ref = validateRef(options.ref || project.defaultBranch);
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const skip = Math.max(options.skip ?? 0, 0);
  const treePath = normalizeTreePath(options.path ?? null);

  const args = [
    'log',
    ref,
    `--pretty=format:${LOG_FORMAT}`,
    `-n`, String(limit + 1),
    `--skip`, String(skip),
  ];
  if (treePath) {
    args.push('--follow', '--', treePath);
  }

  const result = await runGit(args, repoPath, false);
  const entries = parseLogStdout(result.stdout);
  const hasMore = entries.length > limit;
  return {
    commits: hasMore ? entries.slice(0, limit) : entries,
    hasMore,
  };
}

export async function getCommit(
  project: GitBackedProject,
  sha: string,
): Promise<GitCommitDetail | null> {
  const repoPath = await refreshMirror(project);
  validateSha(sha);

  const log = await runGit(
    ['log', `--pretty=format:${LOG_FORMAT}`, '-n', '1', sha],
    repoPath,
    false,
  );
  const entries = parseLogStdout(log.stdout);
  if (entries.length === 0) return null;
  const entry = entries[0];

  // diff-tree gives us the file change list for a single commit; -m makes
  // merge commits emit per-parent diffs (we just take the first parent for
  // listing).
  const [nameStatus, numstat] = await Promise.all([
    runGit(
      ['diff-tree', '-r', '--no-commit-id', '--name-status', '-z', '--root', '-M', sha],
      repoPath,
      false,
    ).catch(() => ({ stdout: '', stderr: '' })),
    runGit(
      ['diff-tree', '-r', '--no-commit-id', '--numstat', '--root', '-M', sha],
      repoPath,
      false,
    ).catch(() => ({ stdout: '', stderr: '' })),
  ]);

  // name-status is NUL-separated; rename/copy entries take two extra NULs.
  const files = new Map<string, GitCommitFile>();
  const tokens = nameStatus.stdout.split('\0');
  for (let i = 0; i < tokens.length; i += 1) {
    const code = tokens[i];
    if (!code) continue;
    if (code.startsWith('R') || code.startsWith('C')) {
      const oldPath = tokens[i + 1];
      const newPath = tokens[i + 2];
      if (!oldPath || !newPath) break;
      files.set(newPath, {
        path: newPath,
        old_path: oldPath,
        status: decodeStatusChar(code),
        additions: 0,
        deletions: 0,
      });
      i += 2;
    } else {
      const path = tokens[i + 1];
      if (!path) break;
      files.set(path, {
        path,
        old_path: null,
        status: decodeStatusChar(code),
        additions: 0,
        deletions: 0,
      });
      i += 1;
    }
  }

  for (const line of numstat.stdout.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const [addStr, delStr, rawPath] = parts;
    // For renamed entries numstat emits `old{ => new}` syntax; we'll match
    // by the destination if present, else fall back to the raw path.
    const destMatch = rawPath.match(/\{[^}]*=>\s*([^}]+)\}/);
    const path = destMatch
      ? rawPath.replace(/\{[^}]*=>\s*([^}]+)\}/, '$1')
      : rawPath;
    const existing = files.get(path);
    if (existing) {
      existing.additions = addStr === '-' ? 0 : Number(addStr) || 0;
      existing.deletions = delStr === '-' ? 0 : Number(delStr) || 0;
    }
  }

  return { ...entry, files: Array.from(files.values()) };
}

export async function getCommitDiff(
  project: GitBackedProject,
  sha: string,
  options: GetCommitDiffOptions = {},
): Promise<CommitDiff> {
  const repoPath = await refreshMirror(project);
  validateSha(sha);

  const args = ['diff-tree', '-p', '--root', '-M', '--no-color', sha];
  const treePath = normalizeTreePath(options.path ?? null);
  if (treePath) args.push('--', treePath);

  const result = await runGit(args, repoPath, false);

  let parent: string | null = null;
  try {
    const parentRes = await runGit(
      ['rev-list', '--parents', '-n', '1', sha],
      repoPath,
      false,
    );
    const parts = parentRes.stdout.trim().split(/\s+/);
    if (parts.length >= 2) parent = parts[1];
  } catch {
    parent = null;
  }

  return { hash: sha, parent, patch: result.stdout };
}

/** Resolves a branch name to its tip commit SHA (full 40-char hex). */
export async function resolveBranchTip(
  project: GitBackedProject,
  ref: string,
): Promise<string> {
  validateRef(ref);
  const repoPath = await refreshMirror(project);
  const result = await runGit(['rev-parse', `refs/heads/${ref}`], repoPath, false);
  return result.stdout.trim();
}
