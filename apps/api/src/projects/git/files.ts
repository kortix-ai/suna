// File-tree reads over the bare mirror: listing, name/content search, single
// file reads, subtree archive streaming, and per-file/at-ref history.

import {
  parseLegacyToml,
  convertLegacyManifestAsync,
  type ManifestImportReader,
  type ResolvedManifest,
  MANIFEST_IMPORTS_KEY,
  MAX_IMPORT_FILES,
  hasManifestImports,
  normalizeImportPath,
  parseManifestText,
  resolveManifestImports,
  serializeManifestObject,
} from '@kortix/manifest-schema';
import { HTTPException } from 'hono/http-exception';
import { validateRef } from '../git-ref';
import { listCommits } from './commits';
import {
  type MirrorRefresh,
  ensureCommitTrees,
  ensurePathObjects,
  ensureRefTrees,
  ensureStoreObjects,
  ensureTreeContents,
  isGitOperationError,
  isGitPathNotFoundError,
  isGitRefNotFoundError,
  normalizeTreePath,
  refreshMirror,
  runGit,
  runGitBuffer,
  runGitCapture,
  spawn,
} from './mirror';
import { isObjectFetchTooLargeError, partialStoresEnabled } from './object-store';
import { cachedGitRead, resolveRefSha } from './read-cache';
import type {
  GetFileHistoryOptions,
  GitBackedProject,
  GitLogEntry,
  ProjectFileEntry,
  RepoGrepMatch,
} from './types';

/**
 * Byte limits for reads that fetch file contents into the project store
 * (`object-store.ts`). A store holds no file until a read names it, so each
 * limit bounds what one request can make the API download.
 */
/** One file opened in the file browser or read by a config loader. */
export const FILE_READ_MAX_BYTES = 64 * 1024 * 1024;
/** A file read as text (`readRepoFile`): the default git read buffer. */
const TEXT_READ_MAX_BYTES = 10 * 1024 * 1024;
/** Every file a content search reads at one commit. Over it, the search covers the files fetched so far. */
export const CONTENT_SEARCH_MAX_BYTES = 64 * 1024 * 1024;
/** Every file in one zip download. */
export const ARCHIVE_MAX_BYTES = 512 * 1024 * 1024;

/** The repository is too large for the operation: a request for less (a folder, one file) can still succeed. */
export class RepoContentTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`The repository content exceeds the ${maxBytes}-byte limit for this operation. Download a folder or a single file instead.`);
    this.name = 'RepoContentTooLargeError';
  }
}

export function isRepoContentTooLargeError(err: unknown): err is RepoContentTooLargeError {
  return err instanceof RepoContentTooLargeError;
}

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
  const first = await list(await refreshMirror(project, false, { freshRef: treeRef })).catch((err) => {
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

/** Entry cap of one folder listing that asks for no page. */
export const DIRECTORY_LISTING_LIMIT = 5000;
/** Default and ceiling of a paged folder listing (`limit` or `cursor` sent). */
export const DIRECTORY_PAGE_LIMIT = 500;
export const DIRECTORY_PAGE_MAX_LIMIT = 2000;

/** Where a paged folder listing resumes: the commit the first page read, and the last key it returned. */
export interface DirectoryPageStart {
  commit: string;
  key: string;
}

/**
 * The key of an entry: its path, a folder's with a trailing `/`. Git orders a
 * tree's entries by the bytes of this key. A cursor holds the key of the last
 * entry a page returned (`pageStart`).
 */
const entryKey = (entry: ProjectDirectoryEntry) => (entry.type === 'directory' ? `${entry.path}/` : entry.path);

/** An opaque `next_cursor`: base64url JSON of the commit, the folder and the last key. */
export function encodeDirectoryCursor(commit: string, path: string | null | undefined, key: string): string {
  return Buffer.from(JSON.stringify({ v: 1, c: commit, p: normalizeTreePath(path) ?? '', k: key })).toString('base64url');
}

/** The page start a cursor names, or null when it is malformed or belongs to another folder. */
export function decodeDirectoryCursor(cursor: string, path: string | null | undefined): DirectoryPageStart | null {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    // `c` reaches `git ls-tree` as an argument: only a full sha passes.
    if (value?.v !== 1 || !/^[0-9a-f]{40}$/.test(value.c) || typeof value.k !== 'string' || !value.k) return null;
    if (value.p !== (normalizeTreePath(path) ?? '')) return null;
    return { commit: value.c, key: value.k };
  } catch {
    return null;
  }
}

/** `git ls-tree` at a commit this mirror does not hold. */
const isUnknownCommit = (err: unknown) =>
  isGitRefNotFoundError(err) || (isGitOperationError(err) && /not a tree object/i.test(`${err.message}\n${err.stderr}`));

/**
 * The read cache keeps one folder's `ls-tree` output up to this size (UTF-16
 * bytes, ~146 per entry: about 110,000 entries). The default 2 MiB cap stops
 * at ~14,000, and every "Load more" on a larger folder re-ran `ls-tree` over
 * the whole folder.
 */
const DIRECTORY_CACHE_MAX_BYTES = 16 * 1024 * 1024;

/**
 * The index a page starts at: after the entry whose key is `key`. Found by
 * position, not by comparison: `runGit` decodes a name that is not UTF-8
 * lossily (U+FFFD), so a decoded key can sort out of git's byte order. Two
 * names that decode to one string resume after the first: the second repeats,
 * it is never skipped. Bytes are compared only when the key is gone (the
 * first page's commit left the mirror and the ref tip lacks the entry).
 */
function pageStart(entries: readonly ProjectDirectoryEntry[], key: string): number {
  const at = entries.findIndex((entry) => entryKey(entry) === key);
  if (at >= 0) return at + 1;
  const after = Buffer.from(key);
  const next = entries.findIndex((entry) => Buffer.compare(Buffer.from(entryKey(entry)), after) > 0);
  return next < 0 ? entries.length : next;
}

/**
 * The immediate children of one folder (`path`, or the root), from a
 * non-recursive `git ls-tree`: every folder is complete up to `limit`
 * entries, however many files sort before it (KRTX-1723). A submodule is
 * skipped, as in `listRepoFiles`.
 *
 * `visible` drops entries before the cut, so a page stays full and `nextKey`
 * is always a visible entry. `after` resumes a paged listing: it reads the
 * commit the first page read, so a push between pages skips or repeats
 * nothing, and returns the entries after the one whose key is `after.key`.
 *
 * Every page parses the whole folder from the cached `ls-tree` output: O(n)
 * per page, no git process while the output stays cached (up to
 * `DIRECTORY_CACHE_MAX_BYTES`).
 */
export async function listRepoDirectory(
  project: GitBackedProject,
  ref?: string,
  path?: string | null,
  opts?: FreshOnMiss & {
    limit?: number;
    after?: DirectoryPageStart;
    visible?: (path: string) => boolean;
  },
): Promise<{
  entries: ProjectDirectoryEntry[];
  truncated: boolean;
  /** The commit this listing read; null only when the ref did not resolve to one. */
  commit: string | null;
  /** The key the next page starts after, while entries remain. */
  nextKey: string | null;
}> {
  const treeRef = validateRef(ref || project.defaultBranch);
  const treePath = normalizeTreePath(path);
  const limit = opts?.limit ?? DIRECTORY_LISTING_LIMIT;
  const list = async (repoPath: string, pinned?: string) => {
    const sha = pinned ?? (await resolveRefSha(repoPath, treeRef));
    // A page can name a commit this store has not read yet (another replica served the first page).
    if (pinned) await ensureRefTrees(repoPath, pinned);
    const listLevel = (at: string) => {
      // The trailing slash lists the folder's children, not the folder itself.
      // -l adds each blob's size, read from the blob itself: a file the store
      // has not fetched prints `BAD`, and the listing omits its size rather
      // than download it.
      const args = ['ls-tree', '-z', '-l', at, '--'];
      if (treePath) args.push(`${treePath}/`);
      return runGit(args, repoPath, false).then((result) => result.stdout);
    };
    const stdout = sha
      ? await cachedGitRead(repoPath, sha, 'ls-tree-1l', treePath ?? '', () => listLevel(sha), {
          maxEntryBytes: DIRECTORY_CACHE_MAX_BYTES,
        })
      : await listLevel(treeRef);
    const entries = stdout
      .split('\0')
      .map<ProjectDirectoryEntry | null>((line) => {
        const match = line.match(/^\d+\s+(\w+)\s+[0-9a-f]+\s+(\d+|-|BAD)\t([\s\S]+)$/);
        if (!match) return null;
        if (match[1] === 'blob') {
          return /^\d+$/.test(match[2]!) ? { path: match[3]!, type: 'file', size: Number(match[2]) } : { path: match[3]!, type: 'file' };
        }
        if (match[1] === 'tree') return { path: match[3]!, type: 'directory' };
        return null;
      })
      .filter((entry): entry is ProjectDirectoryEntry => Boolean(entry));
    return { sha, entries };
  };
  const listAtRef = async () => {
    let read = await list(await refreshMirror(project, false, { freshRef: treeRef })).catch((err) => {
      if (isMissingAtRef(err) && isExplicitBranch(project, ref, opts)) return null;
      throw err;
    });
    if (!read?.entries.length && isExplicitBranch(project, ref, opts)) {
      // Empty or unresolvable at an explicit branch: a push may not be fetched yet.
      read = await list(await refreshMirror(project, true, { freshRef: treeRef }));
    }
    return read ?? { sha: null, entries: [] };
  };
  // Each API replica keeps its own mirror, so the next page can land on one
  // that has not fetched the first page's commit yet: fetch once (skipped when
  // the ref has not moved upstream). A commit the remote no longer has (a
  // force-push) falls back to the ref's tip, from the same key.
  const listAtCommit = async (commit: string) => {
    for (const force of [false, true]) {
      try {
        return await list(await refreshMirror(project, force, { freshRef: treeRef }), commit);
      } catch (err) {
        if (!isUnknownCommit(err)) throw err;
      }
    }
    return null;
  };
  const read = (opts?.after && (await listAtCommit(opts.after.commit))) || (await listAtRef());
  let all = read.entries;
  if (opts?.visible) all = all.filter((entry) => opts.visible!(entry.path));
  if (opts?.after) all = all.slice(pageStart(all, opts.after.key));
  const entries = all.slice(0, limit);
  const truncated = all.length > limit;
  return { entries, truncated, commit: read.sha, nextKey: truncated ? entryKey(entries.at(-1)!) : null };
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
  const repoPath = await refreshMirror(project, false, { freshRef: treeRef });
  await fetchSearchableFiles(repoPath, treeRef);
  // A file the store does not hold prints "unable to read" on stderr; git grep
  // still searches the rest and exits 0 or 1.
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

/**
 * Fetch the files a content search at `treeRef` reads, in batches, until
 * `CONTENT_SEARCH_MAX_BYTES`. A batch over the limit is dropped and the search
 * covers what arrived before it: a 6 GB repository answers from its first
 * files instead of downloading all of them.
 */
async function fetchSearchableFiles(repoPath: string, treeRef: string): Promise<void> {
  const listed = await runGitCapture(['ls-tree', '-r', '-z', treeRef], repoPath);
  if (listed.exitCode !== 0) return;
  const blobs = listed.stdout
    .split('\0')
    .map((record) => /^\d+ blob ([0-9a-f]{40})\t/.exec(record)?.[1])
    .filter((id): id is string => Boolean(id));
  let budget = CONTENT_SEARCH_MAX_BYTES;
  for (let start = 0; start < blobs.length && budget > 0; start += SEARCH_FETCH_BATCH) {
    try {
      budget -= await ensureStoreObjects(repoPath, blobs.slice(start, start + SEARCH_FETCH_BATCH), { maxBytes: budget });
    } catch (err) {
      if (isObjectFetchTooLargeError(err)) return;
      throw err;
    }
  }
}
const SEARCH_FETCH_BATCH = 500;

/**
 * Fetch the files at `paths` into the store in one request, before a caller
 * reads them one by one with `readRepoFile`.
 *
 * Why (2026-11-03): `loadProjectConfig` reads every skill's `SKILL.md`. On a
 * cold partial store each read was its own fetch from the host, and fetches
 * into one store run one at a time. A project with 45 skills paid 45 fetches
 * of ~0.5 s each, and `/detail` failed with 503 `request_deadline`.
 *
 * Best effort: on any failure (a set over the byte limit, a network error)
 * the reads that follow fetch their own file, as before.
 */
export async function prefetchRepoFiles(project: GitBackedProject, paths: readonly string[], ref?: string): Promise<void> {
  try {
    // A whole-history store holds every file already.
    if (!(await partialStoresEnabled())) return;
    const normalized = paths.map((path) => normalizeTreePath(path)).filter((path): path is string => Boolean(path));
    if (normalized.length === 0) return;
    const treeRef = validateRef(ref || project.defaultBranch);
    const repoPath = await refreshMirror(project, false, { freshRef: treeRef });
    const sha = await resolveRefSha(repoPath, treeRef);
    const fetch = () => ensurePathObjects(repoPath, sha ?? treeRef, normalized, { maxBytes: FILE_READ_MAX_BYTES }).then(() => true);
    // Once per commit and path set: a warm read spawns no git process.
    if (sha) await cachedGitRead(repoPath, sha, 'prefetch-files', normalized.join('\0'), fetch);
    else await fetch();
  } catch {
    // The per-file reads fetch what is missing.
  }
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
  const repoPath = await refreshMirror(project, false, { freshRef: treeRef });
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
  const repoPath = await refreshMirror(project, false, { freshRef: treeRef });
  const cat = async (at: string) => {
    const object = `${at}:${normalized}`;
    await fetchFileForRead(repoPath, at, normalized);
    try {
      return await runGitBuffer(
        ['cat-file', 'blob', object],
        repoPath,
        false,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        FILE_READ_MAX_BYTES,
      );
    } catch (err) {
      if (isGitOperationError(err) && err.outputTooLarge) throw new RepoContentTooLargeError(FILE_READ_MAX_BYTES);
      // cat-file reports a tree as "bad file", not "path does not exist".
      // Check the object type rather than hiding corruption with the same wording.
      if (isGitOperationError(err) && err.kind === 'failed') {
        const type = await runGitCapture(['cat-file', '-t', object], repoPath);
        if (type.exitCode === 0 && ['tree', 'commit'].includes(type.stdout.trim())) {
          throw new RepoFileNotFoundError(normalized, treeRef, err);
        }
      }
      throw err;
    }
  };
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
  if (!sha) {
    await fetchFileForRead(repoPath, treeRef, normalized);
    return (await runGit(['show', `${treeRef}:${normalized}`], repoPath, false)).stdout;
  }
  // "Not in this commit" is an answer too, so it is cached as one; any other
  // failure rejects and is retried by the next read. The fetch runs inside the
  // loader: a cached read spawns no git process.
  const shown = await cachedGitRead(repoPath, sha, 'show', normalized, async () => {
    await fetchFileForRead(repoPath, sha, normalized);
    try {
      return { found: true as const, content: (await runGit(['show', `${sha}:${normalized}`], repoPath, false)).stdout };
    } catch (err) {
      if (isGitPathNotFoundError(err)) return { found: false as const, error: err };
      if (isGitOperationError(err) && err.outputTooLarge) throw new RepoContentTooLargeError(TEXT_READ_MAX_BYTES);
      throw err;
    }
  });
  if (!shown.found) throw shown.error;
  return shown.content;
}

/**
 * Fetch the one file a read names, before `git show` / `cat-file` reads it. On
 * a partial store a missing file reads as "bad object <ref>:<path>", which no
 * caller can tell from a real failure. A path that is not in the tree fetches
 * nothing, and the read that follows answers "not found" from the tree.
 */
async function fetchFileForRead(repoPath: string, at: string, path: string): Promise<void> {
  try {
    await ensurePathObjects(repoPath, at, [path], { maxBytes: FILE_READ_MAX_BYTES });
  } catch (err) {
    if (isObjectFetchTooLargeError(err)) throw new RepoContentTooLargeError(FILE_READ_MAX_BYTES);
    throw err;
  }
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
 * that exists (kortix.yaml over kortix.yml). ONE ls-tree
 * finds which candidates exist at the ref, then a single `show` reads the
 * highest-priority present one — refreshing the mirror once, unlike probing each
 * path via readRepoFile (which would refresh + spawn a process per candidate).
 * Returns the matched path + content, or null when no candidate exists.
 *
 * IMPORTS: a manifest that declares `imports:` is resolved HERE, at the one
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
  /** Set when the file is a legacy format (`kortix_version` 1 or 2, or `kortix.toml`): `content` is its conversion. */
  legacy?: ManifestLegacy;
} | null> {
  const normalized = candidatePaths
    .map((p) => normalizeTreePath(p))
    .filter((p): p is string => !!p);
  if (normalized.length === 0) return null;
  // A legacy `kortix.toml` is read only when no YAML manifest exists.
  const tomlPath = /\.ya?ml$/i.test(normalized[0]!) ? normalized[0]!.replace(/\.ya?ml$/i, '.toml') : null;
  const lookup = tomlPath ? [...normalized, tomlPath] : normalized;
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
        const captured = await runGitCapture(['ls-tree', treeSha, '--', ...lookup], repoPath);
        if (captured.exitCode !== 0) throw new Error(captured.stderr || 'ls-tree failed');
        return captured;
      }).catch(() => runGitCapture(['ls-tree', treeRef, '--', ...lookup], repoPath))
    : await runGitCapture(['ls-tree', treeRef, '--', ...lookup], repoPath);
  if (listed.exitCode !== 0 && opts?.strictRef) {
    // A ref that does not resolve is NOT "the manifest is absent". Returning
    // null here made an unreadable mirror indistinguishable from a blank
    // project, which callers answer with a synthesized permissive manifest.
    if (/fatal: (?:not a valid|invalid) object name /i.test(listed.stderr)) {
      const message = `Repository ref '${treeRef}' does not exist. Push a commit to '${treeRef}' or update the project's default branch before starting a session.`;
      throw new HTTPException(409, {
        message,
        res: Response.json({ error: true, code: 'git_ref_not_found', message, status: 409 }, { status: 409 }),
      });
    }
    throw new Error(
      `git ls-tree ${treeRef} failed (exit ${listed.exitCode}): ${listed.stderr.trim() || 'no output'}`,
    );
  }
  const revisions = new Map<string, string>();
  for (const line of listed.stdout.split('\n')) {
    const match = line.match(/^\d+\s+blob\s+([0-9a-f]{40})\t(.+)$/);
    if (match?.[1] && match[2]) revisions.set(match[2], match[1]);
  }
  const winner = normalized.find((p) => revisions.has(p)) ?? (tomlPath && revisions.has(tomlPath) ? tomlPath : undefined);
  if (!winner) return null;
  const revision = revisions.get(winner);
  if (!revision) return null;
  // A blob is addressed by its own id: the same bytes at every commit.
  const shown = await cachedGitRead(repoPath, revision, 'blob', winner, async () => {
    await ensureStoreObjects(repoPath, [revision], { maxBytes: FILE_READ_MAX_BYTES });
    return runGit(['show', `${treeSha ?? treeRef}:${winner}`], repoPath, false);
  });
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
  const legacyFrom = winner === tomlPath ? 1 : legacyVersionLine(shown.stdout);
  // `imports` is a top-level key, so a manifest without that line cannot use
  // the feature — skip the extra YAML parse on the (hot) common path.
  if (
    opts?.resolveImports === false ||
    winner === tomlPath ||
    !/^imports\s*:/m.test(shown.stdout)
  ) {
    return legacyFrom ? convertLegacyRead(found, legacyFrom, repoPath, commit ?? treeRef) : found;
  }
  let rootRaw: Record<string, unknown>;
  try {
    rootRaw = parseManifestText(shown.stdout);
  } catch {
    // A root syntax error is the caller's to report, from the same text.
    return found;
  }
  if (!hasManifestImports(rootRaw)) return legacyFrom ? convertLegacyRead(found, legacyFrom, repoPath, commit ?? treeRef) : found;
  // Read imports at the commit the root was read at, not the branch name: a
  // push landing between the two reads would otherwise mix two revisions.
  await prefetchDeclaredImports(repoPath, commit ?? treeRef, rootRaw);
  const imports = await resolveManifestImports(
    { path: winner, raw: rootRaw, revision },
    gitManifestImportReader(repoPath, commit ?? treeRef),
  );
  const merged = { ...found, content: serializeManifestObject(imports.raw), imports };
  return legacyFrom ? convertLegacyRead(merged, legacyFrom, repoPath, commit ?? treeRef, imports.raw) : merged;
}

/** How far back the last-good manifest walk looks: first-parent commits, and distinct file versions. */
const LAST_GOOD_MANIFEST_COMMITS = 200;
const LAST_GOOD_MANIFEST_VERSIONS = 20;

/**
 * The newest commit on `headCommit`'s first-parent line whose file at `path`
 * passes `isGood`, or null. The walk stops where the file did not exist: an
 * older commit without it is not a version of it.
 *
 * Cheap on the partial store: one request for the root trees of every commit,
 * then only the distinct file versions, newest first. A run of commits that
 * keep the same broken file costs one check.
 */
export async function findLastGoodManifestCommit(
  project: GitBackedProject,
  path: string,
  headCommit: string,
  isGood: (content: string) => boolean,
): Promise<string | null> {
  const normalized = normalizeTreePath(path);
  if (!normalized) return null;
  const repoPath = await refreshMirror(project);
  const listed = await runGitCapture(
    ['rev-list', '--first-parent', `--max-count=${LAST_GOOD_MANIFEST_COMMITS}`, headCommit],
    repoPath,
  );
  if (listed.exitCode !== 0) throw new Error(listed.stderr.trim() || `git rev-list ${headCommit} failed`);
  const commits = listed.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  await ensureCommitTrees(repoPath, commits);
  const checked = new Set<string>();
  for (const commit of commits) {
    // A nested manifest path needs the trees that lead to it.
    if (normalized.includes('/')) await ensurePathObjects(repoPath, commit, [normalized]);
    const tree = await runGitCapture(['ls-tree', commit, '--', normalized], repoPath);
    if (tree.exitCode !== 0) throw new Error(tree.stderr.trim() || `git ls-tree ${commit} failed`);
    const blob = /^\d+ blob ([0-9a-f]{40})\t/m.exec(tree.stdout)?.[1];
    if (!blob) return null;
    if (checked.has(blob)) continue;
    if (checked.size >= LAST_GOOD_MANIFEST_VERSIONS) return null;
    checked.add(blob);
    await ensureStoreObjects(repoPath, [blob], { maxBytes: FILE_READ_MAX_BYTES });
    const shown = await runGitCapture(['cat-file', 'blob', blob], repoPath);
    if (shown.exitCode !== 0) throw new Error(shown.stderr.trim() || `git cat-file ${blob} failed`);
    if (isGood(shown.stdout)) return commit;
  }
  return null;
}

/** A legacy manifest as the latest shape, and what the conversion read (`legacy`). */
export interface ManifestLegacy {
  /** The format the file is in: 1 (`kortix.toml`) or 2. */
  from: 1 | 2;
  /** Repo path → the text a reader uses for it (prompts without their frontmatter). */
  overlay: Record<string, string>;
  /** What the latest shape has no place for. */
  dropped: string[];
  /** The files the conversion replaces (`kortix.toml`, the OpenCode config and agent files): the first write deletes them. */
  deletes: string[];
  /** Set when the legacy file could not be read at all (a TOML syntax error). */
  error?: string;
}

/** `kortix_version: 1` or `2` on its own line, or null. */
function legacyVersionLine(text: string): 1 | 2 | null {
  const match = /^kortix_version[ \t]*:[ \t]*['"]?([12])['"]?[ \t]*(?:#.*)?$/m.exec(text);
  return match ? (Number(match[1]) as 1 | 2) : null;
}

/**
 * Convert a legacy manifest read: `content` becomes the latest shape, built from
 * the root (or the merged `imports` document) and the files it points at, all
 * read at `ref`. A TOML syntax error leaves an empty manifest and says why.
 */
async function convertLegacyRead<T extends { path: string; content: string; rootContent: string }>(
  found: T,
  from: 1 | 2,
  repoPath: string,
  ref: string,
  merged?: Record<string, unknown>,
): Promise<T & { legacy: ManifestLegacy }> {
  let raw: Record<string, unknown>;
  try {
    raw = merged ?? (found.path.endsWith('.toml') ? parseLegacyToml(found.rootContent) : parseManifestText(found.rootContent));
  } catch (err) {
    const error = `${found.path}: ${err instanceof Error ? err.message : String(err)}`;
    return { ...found, content: '', legacy: { from, overlay: {}, dropped: [], deletes: [], error } };
  }
  const cache = <V>(op: string, arg: string, load: () => Promise<V>) =>
    /^[0-9a-f]{40}$/.test(ref) ? cachedGitRead(repoPath, ref, op, arg, load) : load();
  const listed = await cache('legacy-ls-tree', '', () => runGitCapture(['ls-tree', '-r', '--name-only', '-z', ref], repoPath));
  const paths = listed.exitCode === 0 ? listed.stdout.split('\0').filter(Boolean) : [];
  const conversion = await convertLegacyManifestAsync(raw, from, found.path, paths, async (path) => {
    if (!paths.includes(path)) return null;
    const shown = await cache('legacy-show', path, async () => {
      await ensurePathObjects(repoPath, ref, [path], { maxBytes: FILE_READ_MAX_BYTES });
      return runGitCapture(['show', `${ref}:${path}`], repoPath);
    });
    return shown.exitCode === 0 ? shown.stdout : null;
  });
  return {
    ...found,
    content: serializeManifestObject(conversion.raw),
    legacy: {
      from,
      overlay: conversion.overlay,
      dropped: conversion.dropped,
      deletes: conversion.changes.filter((change) => change.action === 'delete').map((change) => change.path),
    },
  };
}

/**
 * Fetch every file the root manifest imports in one request. The resolver
 * lists one import at a time, and on a cold partial store each list was one
 * fetch from the host: 8 imports cost ~4 s (2026-11-03). Best effort: a list
 * fetches what is still missing. Nested imports still fetch per list.
 */
async function prefetchDeclaredImports(repoPath: string, ref: string, rootRaw: Record<string, unknown>): Promise<void> {
  const declared = rootRaw[MANIFEST_IMPORTS_KEY];
  if (!Array.isArray(declared)) return;
  const paths = declared.map((entry) => normalizeImportPath(entry)).filter((path): path is string => path !== null);
  if (paths.length === 0) return;
  try {
    // A whole-history store holds every file already.
    if (!(await partialStoresEnabled())) return;
    // Once per commit: a warm read spawns no git process.
    if (/^[0-9a-f]{40}$/.test(ref)) {
      await cachedGitRead(repoPath, ref, 'prefetch-imports', paths.join('\0'), () => fetchDeclaredImports(repoPath, ref, paths).then(() => true));
    } else {
      await fetchDeclaredImports(repoPath, ref, paths);
    }
  } catch {
    // The resolver's own reads fetch what is missing.
  }
}

async function fetchDeclaredImports(repoPath: string, ref: string, paths: string[]): Promise<void> {
  await ensureCommitTrees(repoPath, [ref]);
  // `-r`: a directory import reads every YAML file under it.
  const listed = await runGitCapture(['--literal-pathspecs', 'ls-tree', '-r', '-z', ref, '--', ...paths], repoPath);
  if (listed.exitCode !== 0) return;
  const blobs = listed.stdout
    .split('\0')
    .map((record) => /^\d+ blob ([0-9a-f]{40})\t.+\.ya?ml$/i.exec(record)?.[1])
    .filter((id): id is string => Boolean(id))
    // The resolver reads at most this many files; past it the import fails anyway.
    .slice(0, MAX_IMPORT_FILES);
  await ensureStoreObjects(repoPath, blobs, { maxBytes: FILE_READ_MAX_BYTES });
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
      // The resolver reads every file it lists: fetch them in one request.
      await ensureStoreObjects(repoPath, entries.map((entry) => entry.revision), { maxBytes: FILE_READ_MAX_BYTES });
      return entries;
    },
    async read(path) {
      return cache('import-show', path, async () => {
        await ensurePathObjects(repoPath, ref, [path], { maxBytes: FILE_READ_MAX_BYTES });
        return (await runGit(['show', `${ref}:${path}`], repoPath, false)).stdout;
      });
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
  const repoPath = await refreshMirror(project, false, { freshRef: treeRef });
  const normalized = path ? normalizeTreePath(path) : null;
  const treeish = normalized ? `${treeRef}:${normalized}` : treeRef;
  // `git archive` reads every file under `treeish`: fetch them first, bounded.
  try {
    await ensureTreeContents(repoPath, treeish, { maxBytes: ARCHIVE_MAX_BYTES, timeoutMs: 600_000 });
  } catch (err) {
    if (isObjectFetchTooLargeError(err)) throw new RepoContentTooLargeError(ARCHIVE_MAX_BYTES);
    throw err;
  }

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
