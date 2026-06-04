// File-tree reads over the bare mirror: listing, name/content search, single
// file reads, subtree archive streaming, and per-file/at-ref history.

import { validateRef } from '../git-ref';
import {
  normalizeTreePath,
  refreshMirror,
  runGit,
  runGitCapture,
  spawn,
} from './mirror';
import { listCommits } from './commits';
import type {
  GetFileAtRefResult,
  GetFileHistoryOptions,
  GitBackedProject,
  GitLogEntry,
  ProjectFileEntry,
  RepoGrepMatch,
} from './types';

export async function listRepoFiles(project: GitBackedProject, ref?: string, path?: string | null): Promise<ProjectFileEntry[]> {
  const treeRef = validateRef(ref || project.defaultBranch);
  const repoPath = await refreshMirror(project);
  const treePath = normalizeTreePath(path);
  const args = ['ls-tree', '-r', treeRef, '--'];
  if (treePath) args.push(treePath);
  const result = await runGit(args, repoPath, false);
  if (!result.stdout.trim()) return [];
  return result.stdout
    .split('\n')
    .map<ProjectFileEntry | null>((line) => {
      const match = line.match(/^\d+\s+(\w+)\s+[0-9a-f]+\t(.+)$/);
      if (!match || match[1] !== 'blob') return null;
      return { path: match[2] || '', type: 'file', size: null };
    })
    .filter((entry): entry is ProjectFileEntry => Boolean(entry));
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

export async function readRepoFile(project: GitBackedProject, filePath: string, ref?: string) {
  const normalized = normalizeTreePath(filePath);
  if (!normalized) throw new Error('File path is required');
  const treeRef = validateRef(ref || project.defaultBranch);
  const repoPath = await refreshMirror(project);
  const result = await runGit(['show', `${treeRef}:${normalized}`], repoPath, false);
  return result.stdout;
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
  proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

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
      try { proc.kill(); } catch { /* ignore */ }
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
  try {
    const result = await runGit(['show', `${ref}:${normalized}`], repoPath, false);
    return { content: result.stdout, found: true };
  } catch {
    return { content: '', found: false };
  }
}
