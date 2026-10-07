// File-tree reads over the bare mirror: listing, name/content search, single
// file reads, subtree archive streaming, and per-file/at-ref history.

import {
  type ManifestImportReader,
  type ResolvedManifest,
  hasManifestImports,
  manifestFormatForPath,
  parseManifestText,
  resolveManifestImports,
  serializeManifestObject,
} from '@kortix/manifest-schema';
import { validateRef } from '../git-ref';
import { listCommits } from './commits';
import { type MirrorRefresh, isGitPathNotFoundError, isGitRefNotFoundError, normalizeTreePath, refreshMirror, runGit, runGitBuffer, runGitCapture, spawn } from './mirror';
import { cachedGitRead, resolveRefSha } from './read-cache';
import type {
  GetFileAtRefResult,
  GetFileHistoryOptions,
  GitBackedProject,
  GitLogEntry,
  ProjectFileEntry,
  RepoGrepMatch,
} from './types';

export async function listRepoFiles(
  project: GitBackedProject,
  ref?: string,
  path?: string | null,
  opts?: FreshOnMiss,
): Promise<ProjectFileEntry[]> {
  const treeRef = validateRef(ref || project.defaultBranch);
  const treePath = normalizeTreePath(path);
  const list = async (repoPath: string): Promise<ProjectFileEntry[]> => {
    // Keyed by the commit the ref points at now (see read-cache.ts).
    const sha = await resolveRefSha(repoPath, treeRef);
    const listTree = (at: string) => {
      // -z: NUL-separated, unquoted paths (a unicode name is not octal-escaped).
      const args = ['ls-tree', '-r', '-z', at, '--'];
      if (treePath) args.push(treePath);
      return runGit(args, repoPath, false).then((result) => result.stdout);
    };
    const stdout = sha
      ? await cachedGitRead(repoPath, sha, 'ls-tree-r', treePath ?? '', () => listTree(sha))
      : await listTree(treeRef);
    if (!stdout.trim()) return [];
    return stdout
      .split('\0')
      .map<ProjectFileEntry | null>((line) => {
        const match = line.match(/^\d+\s+(\w+)\s+[0-9a-f]+\t([\s\S]+)$/);
        if (!match || match[1] !== 'blob') return null;
        return { path: match[2] || '', type: 'file', size: null };
      })
      .filter((entry): entry is ProjectFileEntry => Boolean(entry));
  };
  const first = await list(await refreshMirror(project)).catch((err) => {
    if (isMissingAtRef(err) && isExplicitBranch(project, ref, opts)) return null;
    throw err;
  });
  if (first?.length || !isExplicitBranch(project, ref, opts)) return first ?? [];
  // Empty or unresolvable at an explicit branch: a push may not be fetched yet.
  return list(await refreshMirror(project, true, { freshRef: treeRef }));
}

/** One entry of a folder listing. */
export interface ProjectDirectoryEntry {
  path: string;
  type: 'file' | 'directory';
  /** Bytes of a file. A folder has none. */
  size?: number;
}

/** Default entry cap of one folder listing. */
export const DIRECTORY_LISTING_LIMIT = 5000;

/**
 * The immediate children of one folder (`path`, or the root), from a
 * non-recursive `git ls-tree`: every folder is complete up to `limit`
 * entries, however many files sort before it (KRTX-1723). A submodule is
 * skipped, as in `listRepoFiles`.
 */
export async function listRepoDirectory(
  project: GitBackedProject,
  ref?: string,
  path?: string | null,
  opts?: FreshOnMiss & { limit?: number },
): Promise<{ entries: ProjectDirectoryEntry[]; truncated: boolean }> {
  const treeRef = validateRef(ref || project.defaultBranch);
  const treePath = normalizeTreePath(path);
  const limit = opts?.limit ?? DIRECTORY_LISTING_LIMIT;
  const list = async (repoPath: string): Promise<ProjectDirectoryEntry[]> => {
    const sha = await resolveRefSha(repoPath, treeRef);
    const listLevel = (at: string) => {
      // The trailing slash lists the folder's children, not the folder itself.
      // -l adds each blob's size.
      const args = ['ls-tree', '-z', '-l', at, '--'];
      if (treePath) args.push(`${treePath}/`);
      return runGit(args, repoPath, false).then((result) => result.stdout);
    };
    const stdout = sha
      ? await cachedGitRead(repoPath, sha, 'ls-tree-1l', treePath ?? '', () => listLevel(sha))
      : await listLevel(treeRef);
    return stdout
      .split('\0')
      .map<ProjectDirectoryEntry | null>((line) => {
        const match = line.match(/^\d+\s+(\w+)\s+[0-9a-f]+\s+(\d+|-)\t([\s\S]+)$/);
        if (!match) return null;
        if (match[1] === 'blob') return { path: match[3]!, type: 'file', size: Number(match[2]) };
        if (match[1] === 'tree') return { path: match[3]!, type: 'directory' };
        return null;
      })
      .filter((entry): entry is ProjectDirectoryEntry => Boolean(entry));
  };
  let entries = await list(await refreshMirror(project)).catch((err) => {
    if (isMissingAtRef(err) && isExplicitBranch(project, ref, opts)) return null;
    throw err;
  });
  if (!entries?.length && isExplicitBranch(project, ref, opts)) {
    // Empty or unresolvable at an explicit branch: a push may not be fetched yet.
    entries = await list(await refreshMirror(project, true, { freshRef: treeRef }));
  }
  const all = entries ?? [];
  return { entries: all.slice(0, limit), truncated: all.length > limit };
}

/**
 * Filename search over the repo tree. Lists files via `listRepoFiles` then
 * ranks by a case-insensitive match (basename prefix > basename substring >
 * path substring), shortest path first.
 */
export async function searchRepoFileNames(
  project: GitBackedProject,
  query: string,
  ref?: string,
  limit = 50,
): Promise<ProjectFileEntry[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const files = await listRepoFiles(project, ref);
  return files
    .map((f) => {
      const path = f.path.toLowerCase();
      const base = path.split('/').pop() || path;
      let score = -1;
      if (base.startsWith(q)) score = 0;
      else if (base.includes(q)) score = 1;
      else if (path.includes(q)) score = 2;
      return score >= 0 ? { f, score } : null;
    })
    .filter((x): x is { f: ProjectFileEntry; score: number } => Boolean(x))
    .sort((a, b) => a.score - b.score || a.f.path.length - b.f.path.length)
    .slice(0, limit)
    .map((x) => x.f);
}

/**
 * Content search via `git grep` over the tree at `ref`. Fixed-string,
 * case-insensitive, skips binaries. Returns flat path/line/text matches.
 * `git grep` exits non-zero when there are no matches, so we use the
 * non-throwing capture variant.
 */
export async function grepRepoFiles(
  project: GitBackedProject,
  pattern: string,
  ref?: string,
  limit = 50,
): Promise<RepoGrepMatch[]> {
  const q = pattern.trim();
  if (!q) return [];
  const treeRef = validateRef(ref || project.defaultBranch);
  const repoPath = await refreshMirror(project);
  const result = await runGitCapture(
    ['grep', '-n', '-I', '-i', '-F', '-m', '10', '-e', q, treeRef],
    repoPath,
  );
  if (!result.stdout.trim()) return [];
  const matches: RepoGrepMatch[] = [];
  const prefix = `${treeRef}:`;
  for (const line of result.stdout.split('\n')) {
    if (!line.trim()) continue;
    // With a tree ref, git grep prints "<ref>:<path>:<lineno>:<text>".
    const m = line.match(/^(.+?):(\d+):(.*)$/);
    if (!m) continue;
    let path = m[1];
    if (path.startsWith(prefix)) path = path.slice(prefix.length);
    matches.push({
      path,
      line_number: Number(m[2]),
      line_text: (m[3] || '').slice(0, 400),
    });
    if (matches.length >= limit) break;
  }
  return matches;
}

export async function readRepoFile(
  project: GitBackedProject,
  filePath: string,
  ref?: string,
  opts?: FreshOnMiss,
): Promise<string> {
  const normalized = normalizeTreePath(filePath);
  if (!normalized) throw new Error('File path is required');
  const treeRef = validateRef(ref || project.defaultBranch);
  const repoPath = await refreshMirror(project);
  try {
    return await readFileAt(repoPath, treeRef, normalized);
  } catch (err) {
    // A branch that a push created or moved since the last fetch reads as
    // "not found" until the 60 s refresh interval passes. One ref-scoped fetch
    // settles it. Default-branch reads and sha reads keep the cached answer.
    if (!(isMissingAtRef(err) && isExplicitBranch(project, ref, opts))) throw missingFileError(err, normalized, treeRef);
    const fresh = await refreshMirror(project, true, { freshRef: treeRef });
    try {
      return await readFileAt(fresh, treeRef, normalized);
    } catch (retryErr) {
      throw missingFileError(retryErr, normalized, treeRef);
    }
  }
}

const isMissingAtRef = (err: unknown) => isGitPathNotFoundError(err) || isGitRefNotFoundError(err);
/** User-facing reads opt in: internal probes for absent files must not pay a fetch per miss. */
type FreshOnMiss = { freshOnMiss?: boolean };
const isExplicitBranch = (project: GitBackedProject, ref?: string, opts?: FreshOnMiss) =>
  !!opts?.freshOnMiss && !!ref && ref !== project.defaultBranch && !/^[0-9a-f]{40}$/i.test(ref);

/** A "path does not exist" failure is an expected client condition, not a server bug. */
function missingFileError(err: unknown, normalized: string, treeRef: string): unknown {
  return isGitPathNotFoundError(err) ? new RepoFileNotFoundError(normalized, treeRef, err) : err;
}

/**
 * Read a file's exact bytes at a ref (`git cat-file blob`).
 *
 * `readRepoFile` captures `git show` stdout as a UTF-8 string, which mangles
 * every byte that is not valid UTF-8 — a PNG, PDF or DOCX read through it is
 * corrupted before it leaves the API. This is the byte-accurate read the raw
 * file route (`GET /files/raw`) serves, so previews and downloads of binary
 * project files carry the real bytes. Unlike the string read it does not go
 * through the read cache, whose sizing assumes strings.
 */
export async function readRepoFileBytes(
  project: GitBackedProject,
  filePath: string,
  ref?: string,
  opts?: FreshOnMiss,
): Promise<Buffer> {
  const normalized = normalizeTreePath(filePath);
  if (!normalized) throw new Error('File path is required');
  const treeRef = validateRef(ref || project.defaultBranch);
  const repoPath = await refreshMirror(project);
  const cat = (at: string) => runGitBuffer(['cat-file', 'blob', `${at}:${normalized}`], repoPath, false);
  try {
    const sha = await resolveRefSha(repoPath, treeRef);
    return sha ? (await cat(sha)).stdout : (await cat(treeRef)).stdout;
  } catch (err) {
    // Same fresh-on-miss retry as the string read: a branch that a push created
    // or moved since the last fetch reads as "not found" until the refresh
    // interval passes; one ref-scoped fetch settles it.
    if (!(isMissingAtRef(err) && isExplicitBranch(project, ref, opts))) throw missingFileError(err, normalized, treeRef);
    const fresh = await refreshMirror(project, true, { freshRef: treeRef });
    try {
      const sha = await resolveRefSha(fresh, treeRef);
      return sha ? (await cat(sha)).stdout : (await cat(treeRef)).stdout;
    } catch (retryErr) {
      throw missingFileError(retryErr, normalized, treeRef);
    }
  }
}

async function readFileAt(repoPath: string, treeRef: string, normalized: string): Promise<string> {
  const sha = await resolveRefSha(repoPath, treeRef);
  if (!sha) return (await runGit(['show', `${treeRef}:${normalized}`], repoPath, false)).stdout;
  // "Not in this commit" is an answer too, so it is cached as one; any other
  // failure rejects and is retried by the next read.
  const shown = await cachedGitRead(repoPath, sha, 'show', normalized, async () => {
    try {
      return { found: true as const, content: (await runGit(['show', `${sha}:${normalized}`], repoPath, false)).stdout };
    } catch (err) {
      if (isGitPathNotFoundError(err)) return { found: false as const, error: err };
      throw err;
    }
  });
  if (!shown.found) throw shown.error;
  return shown.content;
}

/**
 * Typed error for the expected "file not in the repo at this ref" condition.
 * Distinct from `GitOperationError` so callers can branch on the expected case
 * (skip/empty/discover-no-auth) without swallowing genuine git failures
 * (auth, timeout, corrupt repo) that must still surface.
 */
export class RepoFileNotFoundError extends Error {
  readonly filePath: string;
  readonly ref: string;
  constructor(filePath: string, ref: string, cause?: unknown) {
    super(`file not found in repository at '${ref}:${filePath}'`);
    this.name = 'RepoFileNotFoundError';
    this.filePath = filePath;
    this.ref = ref;
    if (cause !== undefined) (this as any).cause = cause;
  }
}

export function isRepoFileNotFoundError(err: unknown): err is RepoFileNotFoundError {
  return err instanceof RepoFileNotFoundError;
}

/**
 * Resolve + read the project's manifest, preferring the first candidate path
 * that exists (the dual-format rule: kortix.yaml over kortix.toml). ONE ls-tree
 * finds which candidates exist at the ref, then a single `show` reads the
 * highest-priority present one — refreshing the mirror once, unlike probing each
 * path via readRepoFile (which would refresh + spawn a process per candidate).
 * Returns the matched path + content, or null when no candidate exists.
 *
 * IMPORTS: a YAML manifest that declares `imports:` is resolved HERE, at the one
 * read every consumer goes through, so none of them can forget to. `content`
 * is then the MERGED document (root + every imported file) re-serialized as
 * YAML — byte-identical consumers (agent grants, the CR-merge gate, the config
 * summary, the agent compiler) parse it exactly as they parse a single file.
 * `rootContent` keeps the root file's own text, and `imports` carries each
 * source file + the origin of every entry for the write path. A manifest
 * without `imports:` is returned untouched: same bytes, no extra git calls.
 *
 * A broken import (missing file, duplicate name, cycle, root-only key in an
 * imported file) THROWS `ManifestImportError`. It must never read as "absent":
 * callers answer an absent manifest with a synthesized permissive one.
 */
export async function readManifestFromRepo(
  project: GitBackedProject,
  candidatePaths: string[],
  ref?: string,
  opts?: {
    forceRefresh?: MirrorRefresh;
    /** Throw when `ref` does not resolve instead of answering "absent".
     *  Authorization reads set this: an unreadable ref must not be laundered
     *  into the synthesized permissive manifest a blank project gets. */
    strictRef?: boolean;
    /** Default true. False returns the root file alone, unresolved — for a
     *  caller degrading after a `ManifestImportError`, never as a first read. */
    resolveImports?: boolean;
  },
): Promise<{
  path: string;
  content: string;
  sha: string;
  candidatePaths: string[];
  /** The commit `ref` resolved to when the manifest was read, or null when
   *  git could not resolve it. Authorization stamps this onto the grant it
   *  derives (see `AgentGrant.manifestCommit`) so a later read at an OLDER
   *  commit — a stale mirror, a mid-fetch ref — is recognisable as stale
   *  instead of being applied as if the manifest had changed. */
  commit: string | null;
  /** The root manifest file's own text. Equals `content` without imports. */
  rootContent: string;
  /** Set only when the manifest declares `imports:`. */
  imports?: ResolvedManifest;
} | null> {
  const normalized = candidatePaths
    .map((p) => normalizeTreePath(p))
    .filter((p): p is string => !!p);
  if (normalized.length === 0) return null;
  const treeRef = validateRef(ref || project.defaultBranch);
  // A forced refresh here exists to make THIS ref's manifest current (the
  // per-prompt grant read is the hot caller), so the mirror only has to prove
  // that one branch is at the remote's tip. When it is, the fetch is skipped;
  // when it moved, or the ref is a sha, the full fetch runs as before.
  const repoPath = await refreshMirror(project, opts?.forceRefresh, { freshRef: treeRef });
  // A pathspec-scoped ls-tree prints only the candidates present at this ref
  // (order-agnostic), so we pick the highest-priority one ourselves.
  const treeSha = await resolveRefSha(repoPath, treeRef);
  const listed = treeSha
    ? await cachedGitRead(repoPath, treeSha, 'ls-tree-candidates', normalized.join('\u0000'), async () => {
        const captured = await runGitCapture(['ls-tree', treeSha, '--', ...normalized], repoPath);
        if (captured.exitCode !== 0) throw new Error(captured.stderr || 'ls-tree failed');
        return captured;
      }).catch(() => runGitCapture(['ls-tree', treeRef, '--', ...normalized], repoPath))
    : await runGitCapture(['ls-tree', treeRef, '--', ...normalized], repoPath);
  if (listed.exitCode !== 0 && opts?.strictRef) {
    // A ref that does not resolve is NOT "the manifest is absent". Returning
    // null here made an unreadable mirror indistinguishable from a blank
    // project, which callers answer with a synthesized permissive manifest.
    throw new Error(
      `git ls-tree ${treeRef} failed (exit ${listed.exitCode}): ${listed.stderr.trim() || 'no output'}`,
    );
  }
  const revisions = new Map<string, string>();
  for (const line of listed.stdout.split('\n')) {
    const match = line.match(/^\d+\s+blob\s+([0-9a-f]{40})\t(.+)$/);
    if (match?.[1] && match[2]) revisions.set(match[2], match[1]);
  }
  const winner = normalized.find((p) => revisions.has(p));
  if (!winner) return null;
  const revision = revisions.get(winner);
  if (!revision) return null;
  // A blob is addressed by its own id: the same bytes at every commit.
  const shown = await cachedGitRead(repoPath, revision, 'blob', winner, () =>
    runGit(['show', `${treeSha ?? treeRef}:${winner}`], repoPath, false),
  );
  const resolveCommit = () =>
    runGitCapture(['rev-parse', '--verify', '--quiet', `${treeSha ?? treeRef}^{commit}`], repoPath);
  const resolved = treeSha
    ? await cachedGitRead(repoPath, treeSha, 'commit', '', resolveCommit)
    : await resolveCommit();
  const commit = resolved.exitCode === 0 ? resolved.stdout.trim() || null : null;
  const found = {
    path: winner,
    content: shown.stdout,
    sha: revision,
    candidatePaths: normalized,
    commit,
    rootContent: shown.stdout,
  };
  // `imports` is a top-level key, so a manifest without that line cannot use
  // the feature — skip the extra YAML parse on the (hot) common path.
  if (
    opts?.resolveImports === false ||
    manifestFormatForPath(winner) !== 'yaml' ||
    !/^imports\s*:/m.test(shown.stdout)
  ) {
    return found;
  }
  let rootRaw: Record<string, unknown>;
  try {
    rootRaw = parseManifestText(shown.stdout, 'yaml');
  } catch {
    // A root syntax error is the caller's to report, from the same text.
    return found;
  }
  if (!hasManifestImports(rootRaw)) return found;
  // Read imports at the commit the root was read at, not the branch name: a
  // push landing between the two reads would otherwise mix two revisions.
  const imports = await resolveManifestImports(
    { path: winner, raw: rootRaw, revision },
    gitManifestImportReader(repoPath, commit ?? treeRef),
  );
  return { ...found, content: serializeManifestObject(imports.raw, 'yaml'), imports };
}

/** `ManifestImportReader` over a bare mirror at one fixed ref. */
function gitManifestImportReader(repoPath: string, ref: string): ManifestImportReader {
  // `ref` is the commit the root manifest was read at, so reads are cacheable
  // under it whenever it is a full SHA.
  const cache = <T>(op: string, arg: string, load: () => Promise<T>) =>
    /^[0-9a-f]{40}$/.test(ref) ? cachedGitRead(repoPath, ref, op, arg, load) : load();
  return {
    async list(path) {
      const listed = await cache('import-ls-tree', path, () => runGitCapture(['ls-tree', '-r', ref, '--', path], repoPath));
      if (listed.exitCode !== 0) {
        throw new Error(
          `git ls-tree ${ref} -- ${path} failed (exit ${listed.exitCode}): ${listed.stderr.trim() || 'no output'}`,
        );
      }
      const entries: Array<{ path: string; revision: string }> = [];
      for (const line of listed.stdout.split('\n')) {
        const match = line.match(/^\d+\s+blob\s+([0-9a-f]{40})\t(.+)$/);
        if (match?.[1] && match[2]) entries.push({ path: match[2], revision: match[1] });
      }
      return entries;
    },
    async read(path) {
      return cache('import-show', path, async () => (await runGit(['show', `${ref}:${path}`], repoPath, false)).stdout);
    },
  };
}

/**
 * Stream a zip archive of the repo (or a subtree) at the given ref.
 *
 * Uses `git archive --format=zip` so the work happens server-side and the
 * client just downloads the bytes — no client-side zipping required.
 * When `path` is null, archives the whole tree; otherwise archives the
 * subtree at that path with the subtree as the zip root.
 */
export async function archiveRepoSubtree(
  project: GitBackedProject,
  ref: string | undefined,
  path?: string | null,
): Promise<ReadableStream<Uint8Array>> {
  const treeRef = validateRef(ref || project.defaultBranch);
  const repoPath = await refreshMirror(project);
  const normalized = path ? normalizeTreePath(path) : null;
  const treeish = normalized ? `${treeRef}:${normalized}` : treeRef;

  const proc = spawn('git', ['archive', '--format=zip', treeish], {
    cwd: repoPath,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });

  let stderr = '';
  proc.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  return new ReadableStream<Uint8Array>({
    start(controller) {
      proc.stdout.on('data', (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk));
      });
      proc.stdout.on('end', () => {
        // Wait for process exit before closing so we can surface non-zero exits.
        if (proc.exitCode === null) {
          proc.once('close', (code) => {
            if (code !== 0) {
              controller.error(new Error(stderr.trim() || `git archive exited ${code}`));
            } else {
              controller.close();
            }
          });
        } else if (proc.exitCode !== 0) {
          controller.error(new Error(stderr.trim() || `git archive exited ${proc.exitCode}`));
        } else {
          controller.close();
        }
      });
      proc.stdout.on('error', (err) => controller.error(err));
      proc.on('error', (err) => controller.error(err));
    },
    cancel() {
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    },
  });
}

export async function getFileHistory(
  project: GitBackedProject,
  filePath: string,
  options: GetFileHistoryOptions = {},
): Promise<{ commits: GitLogEntry[]; hasMore: boolean }> {
  const normalized = normalizeTreePath(filePath);
  if (!normalized) throw new Error('File path is required');
  return listCommits(project, {
    ref: options.ref,
    path: normalized,
    limit: options.limit,
    skip: options.skip,
  });
}

export async function getFileAtRef(
  project: GitBackedProject,
  filePath: string,
  ref: string,
): Promise<GetFileAtRefResult> {
  const normalized = normalizeTreePath(filePath);
  if (!normalized) return { content: '', found: false };
  validateRef(ref);
  const repoPath = await refreshMirror(project);
  const read = async (at: string): Promise<GetFileAtRefResult> => {
    try {
      const result = await runGit(['show', `${at}:${normalized}`], repoPath, false);
      return { content: result.stdout, found: true };
    } catch (err) {
      if (isGitPathNotFoundError(err)) return { content: '', found: false };
      throw err;
    }
  };
  try {
    const sha = await resolveRefSha(repoPath, ref);
    return sha ? await cachedGitRead(repoPath, sha, 'show-at', normalized, () => read(sha)) : await read(ref);
  } catch {
    return { content: '', found: false };
  }
}
