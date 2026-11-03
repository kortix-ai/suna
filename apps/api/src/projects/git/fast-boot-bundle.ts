// Fast-boot session provisioning: the git delta bundle a sandbox applies at
// boot. Resolves the scaffold-delta boundary against the starter scaffold,
// builds the inline-or-remote bundle payload, and resolves the session-create
// fast-boot hint. Commit reads and git-log parsing primitives live in
// commits.ts.

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateRef, validateSha } from '../git-ref';
import { UnexpectedRevParseOutputError, resolveCommitShaAt } from './commits';
import { isObjectFetchTooLarge, noteOverLimit, recentOverLimit } from '../../shared/over-limit-memo';
import { ensureCommitTrees, ensureRangeObjects, ensureRangeTrees, refreshMirror, runGit } from './mirror';
import { scaffoldTreeSha } from './scaffold-identity';
import type { GitBackedProject } from './types';

/** Inline env cap for the delta bundle + parent commit, base64-encoded. */
export const MAX_FAST_BOOT_GIT_BUNDLE_BASE64_BYTES = 24 * 1024;

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
  // An unresolvable ref is no boundary; a real git failure still propagates.
  let baseSha: string;
  try {
    baseSha = await resolveCommitShaAt(repoPath, treeRef);
  } catch (error) {
    if (!(error instanceof UnexpectedRevParseOutputError)) throw error;
    return null;
  }
  const root = (
    await runGit(
      ['rev-list', '--first-parent', '--max-parents=0', '-n', '1', baseSha],
      repoPath,
      false,
    )
  ).stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(root) || root === baseSha) return null;
  if (opts.scaffoldTreeSha) {
    // From the commit object: `rev-parse <root>^{tree}` needs the tree itself,
    // which a partial mirror may not hold.
    const rootTree = (
      await runGit(['log', '--no-walk', '--format=%T', root, '--'], repoPath, false)
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
 * Make every object of the bundle `refs/heads/<ref> ^parent` present in the
 * mirror: `git bundle create` packs them, and a partial mirror never fetches
 * on its own. The parent's trees come first. Without them git cannot tell
 * which files the parent already has, and the bundle would carry (and
 * download) every file of the tip. The download is bounded like the bundle.
 * Returns the bytes received when it passed the bound; nothing is kept then.
 */
async function ensureBundleObjects(
  repoPath: string,
  treeRef: string,
  parentSha: string,
  maxBytes = MAX_FAST_BOOT_GIT_BUNDLE_BYTES,
): Promise<number | null> {
  try {
    const range = [`refs/heads/${treeRef}`, `^${parentSha}`];
    await ensureCommitTrees(repoPath, [parentSha]);
    // Trees in their own request: one `want` request that names a tree and a
    // file inside it gets the tree without that file (`--filter=blob:none`).
    await ensureRangeTrees(repoPath, range);
    await ensureRangeObjects(repoPath, range, { maxBytes });
    return null;
  } catch (error) {
    if (isObjectFetchTooLarge(error)) return error.receivedBytes;
    throw error;
  }
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
  opts: {
    scaffoldTreeSha?: string | null;
    inlineCapBytes?: number;
    /** Remember a delta over the cap for this project (`over-limit-memo.ts`). */
    projectId?: string;
    /** Tests only: a smaller bundle cap, so the over-limit case needs no 64 MiB fixture. */
    maxBytes?: number;
  } = {},
): Promise<ScaffoldDeltaBundle | null> {
  const treeRef = validateRef(ref);
  const boundary = await resolveScaffoldDeltaBoundary(repoPath, treeRef, opts);
  if (!boundary) return null;
  const { baseSha, parentSha } = boundary;
  // A project over the cap in the last 6 h is taken to be over it still: the
  // box clones, and no tip move pays a download that is thrown away.
  if (opts.projectId && recentOverLimit(opts.projectId, 'fast-boot-bundle')) return null;
  const overLimit = (bytes: number) => {
    if (opts.projectId) noteOverLimit(opts.projectId, 'fast-boot-bundle', bytes);
    return null;
  };
  const maxBytes = opts.maxBytes ?? MAX_FAST_BOOT_GIT_BUNDLE_BYTES;
  const received = await ensureBundleObjects(repoPath, treeRef, parentSha, maxBytes);
  if (received !== null) return overLimit(received);
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
    if (bytes.byteLength > maxBytes) return overLimit(bytes.byteLength);
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
  const actual = await resolveCommitShaAt(repoPath, treeRef);
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
  const received = await ensureBundleObjects(repoPath, treeRef, parentSha);
  if (received !== null) {
    // The route answers 413 on "exceeds".
    throw new Error(`fast-boot bundle exceeds ${MAX_FAST_BOOT_GIT_BUNDLE_BYTES} bytes (download stopped at ${received})`);
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
  const baseSha = await resolveCommitShaAt(repoPath, treeRef);
  const delta = await scaffoldTreeSha()
    .then((tree) => buildScaffoldDeltaBundle(repoPath, treeRef, { scaffoldTreeSha: tree, projectId: project.projectId }))
    .catch((error) => {
      console.warn('[git] fast-boot delta bundle unavailable', {
        projectId: project.projectId,
        ref: treeRef,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
  const hint: FastBootGitHint = { baseSha };
  if (delta?.baseSha === baseSha) {
    hint.gitDeltaParentSha = delta.parentSha;
    hint.gitDeltaParentCommitBase64 = delta.parentCommitBase64;
    if (delta.bundleBase64) hint.gitDeltaBundleBase64 = delta.bundleBase64;
    else hint.gitDeltaBundleRemote = true;
  }
  return hint;
}
