import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GitBackedProject {
  projectId: string;
  repoUrl: string;
  defaultBranch: string;
  manifestPath: string;
  gitAuthToken?: string | null;
}

export interface ProjectFileEntry {
  path: string;
  type: 'file';
  size: number | null;
}

export interface ProjectConfigSummary {
  is_kortix_repo: boolean;
  signals: Record<string, boolean>;
  manifest_raw: string | null;
  manifest: Record<string, unknown>;
  env: { required: string[]; optional: string[] };
  open_code_raw: string | null;
  open_code_default_agent: string | null;
  agents: Array<{ name: string; path: string; description: string | null; mode: string | null }>;
  skills: Array<{ name: string; path: string; description: string | null }>;
  commands: Array<{ name: string; path: string; description: string | null }>;
}

const refreshLocks = new Map<string, Promise<string>>();
const lastRefreshAt = new Map<string, number>();

function cacheRoot() {
  return process.env.KORTIX_GIT_CACHE_DIR || '/tmp/kortix/git-cache';
}

function repoCachePath(project: GitBackedProject) {
  const id = createHash('sha256').update(project.projectId).digest('hex').slice(0, 32);
  return join(cacheRoot(), `${id}.git`);
}

function gitAuthArgs(tokenOverride?: string | null) {
  const token = tokenOverride || process.env.KORTIX_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) return [];
  const encoded = Buffer.from(`x-access-token:${token}`).toString('base64');
  return ['-c', `http.https://github.com/.extraheader=AUTHORIZATION: basic ${encoded}`];
}

async function runGit(args: string[], cwd?: string, auth = true, authToken?: string | null) {
  const fullArgs = auth ? [...gitAuthArgs(authToken), ...args] : args;
  try {
    const result = await execFileAsync('git', fullArgs, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      maxBuffer: 10 * 1024 * 1024,
      timeout: 20_000,
    });
    return {
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  } catch (error) {
    const err = error as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
    const stderr = err.stderr?.toString() || '';
    const stdout = err.stdout?.toString() || '';
    throw new Error((stderr || stdout || err.message || 'git failed').trim());
  }
}

function refreshIntervalMs() {
  const value = Number(process.env.KORTIX_GIT_REFRESH_INTERVAL_MS || 60_000);
  return Number.isFinite(value) && value >= 0 ? value : 60_000;
}

async function doRefreshMirror(project: GitBackedProject, force = false) {
  const repoPath = repoCachePath(project);
  await mkdir(dirname(repoPath), { recursive: true });
  if (existsSync(join(repoPath, 'shallow'))) {
    await rm(repoPath, { recursive: true, force: true });
  }
  if (!existsSync(repoPath)) {
    // Bare clone with ALL branches — required for the version/checkpoint
    // viewer. Older callers cloned --single-branch; we self-heal those on
    // refresh below by rewriting the fetch refspec.
    await runGit([
      'clone',
      '--bare',
      project.repoUrl,
      repoPath,
    ], undefined, true, project.gitAuthToken);
    lastRefreshAt.set(project.projectId, Date.now());
    return repoPath;
  }

  const lastRefresh = lastRefreshAt.get(project.projectId) || 0;
  if (!force && Date.now() - lastRefresh < refreshIntervalMs()) return repoPath;

  await runGit(['remote', 'set-url', 'origin', project.repoUrl], repoPath);
  // Heal any legacy single-branch clones by widening the refspec.
  await runGit(['config', 'remote.origin.fetch', '+refs/heads/*:refs/heads/*'], repoPath, false);
  await runGit(['fetch', '--prune', 'origin'], repoPath, true, project.gitAuthToken);
  lastRefreshAt.set(project.projectId, Date.now());
  return repoPath;
}

async function refreshMirror(project: GitBackedProject, force = false) {
  const current = refreshLocks.get(project.projectId);
  if (current) return current;
  const next = doRefreshMirror(project, force).finally(() => refreshLocks.delete(project.projectId));
  refreshLocks.set(project.projectId, next);
  return next;
}

/**
 * Drop the "recently refreshed" marker for this project so the next mirror
 * read forces a fresh `git fetch`. Call this after committing/deleting a
 * file via the GitHub Contents API so the local cache lines up with the
 * upstream change.
 */
export function invalidateProjectMirror(projectId: string): void {
  lastRefreshAt.delete(projectId);
}

function normalizeTreePath(input?: string | null) {
  if (!input || input === '.' || input === '/') return null;
  if (input.startsWith('/') || input.includes('..')) throw new Error('Invalid path');
  return input.replace(/^\.\/+/, '').replace(/\/+$/, '');
}

export async function listRepoFiles(project: GitBackedProject, ref?: string, path?: string | null): Promise<ProjectFileEntry[]> {
  const repoPath = await refreshMirror(project);
  const treeRef = ref || project.defaultBranch;
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

export async function readRepoFile(project: GitBackedProject, filePath: string, ref?: string) {
  const normalized = normalizeTreePath(filePath);
  if (!normalized) throw new Error('File path is required');
  const repoPath = await refreshMirror(project);
  const treeRef = ref || project.defaultBranch;
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
  const repoPath = await refreshMirror(project);
  const treeRef = ref || project.defaultBranch;
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

export async function createRemoteSessionBranch(
  project: GitBackedProject,
  branchName: string,
  baseRef?: string,
) {
  const base = baseRef || project.defaultBranch;
  const repoPath = await refreshMirror(project, true);
  await runGit(['fetch', 'origin', `+refs/heads/${base}:refs/heads/${base}`], repoPath, true, project.gitAuthToken);
  await runGit(['update-ref', `refs/heads/${branchName}`, `refs/heads/${base}`], repoPath, false);
  await runGit(['push', 'origin', `refs/heads/${branchName}:refs/heads/${branchName}`], repoPath, true, project.gitAuthToken);
}

export async function deleteRemoteSessionBranch(
  project: GitBackedProject,
  branchName: string,
): Promise<boolean> {
  if (!branchName || branchName === project.defaultBranch) {
    throw new Error('Refusing to delete the project default branch');
  }

  const repoPath = await refreshMirror(project, true);
  const remote = await runGit(['ls-remote', '--heads', 'origin', branchName], repoPath, true, project.gitAuthToken)
    .catch(() => ({ stdout: '', stderr: '' }));
  if (!remote.stdout.trim()) return false;

  await runGit(['push', 'origin', `:${branchName}`], repoPath, true, project.gitAuthToken);
  await runGit(['update-ref', '-d', `refs/heads/${branchName}`], repoPath, false)
    .catch(() => undefined);
  return true;
}

export async function diffStat(project: GitBackedProject, branchName: string, baseRef?: string) {
  const repoPath = await refreshMirror(project);
  const base = baseRef || project.defaultBranch;
  const result = await runGit(['diff', '--stat', `refs/heads/${base}...refs/heads/${branchName}`], repoPath, false)
    .catch(() => ({ stdout: '', stderr: '' }));
  return { text: result.stdout };
}

async function optionalFile(project: GitBackedProject, filePath: string) {
  try {
    return await readRepoFile(project, filePath, project.defaultBranch);
  } catch {
    return null;
  }
}

function stripTomlComment(line: string) {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if ((ch === '"' || ch === "'") && line[i - 1] !== '\\') {
      quote = quote === ch ? null : quote || ch;
      continue;
    }
    if (ch === '#' && !quote) return line.slice(0, i);
  }
  return line;
}

function parseTomlValue(rawValue: string): unknown {
  const value = rawValue.trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return Array.from(inner.matchAll(/"([^"]*)"|'([^']*)'|([^,\s][^,]*)/g))
      .map((match) => (match[1] ?? match[2] ?? match[3] ?? '').trim())
      .filter(Boolean);
  }
  if (value === 'true' || value === 'false') return value === 'true';
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function parseManifest(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  const out: Record<string, unknown> = {};
  let section: Record<string, unknown> = out;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = stripTomlComment(line).trim();
    if (!trimmed) continue;
    const sectionMatch = trimmed.match(/^\[([a-zA-Z0-9_.-]+)]$/);
    if (sectionMatch) {
      const next: Record<string, unknown> = {};
      out[sectionMatch[1]] = next;
      section = next;
      continue;
    }
    const kv = trimmed.match(/^([a-zA-Z0-9_.-]+)\s*=\s*(.+)$/);
    if (!kv) continue;
    section[kv[1]] = parseTomlValue(kv[2].trim());
  }
  return out;
}

function asStringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const key = item.trim().toUpperCase();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function envRequirements(manifest: Record<string, unknown>) {
  const env = typeof manifest.env === 'object' && manifest.env ? manifest.env as Record<string, unknown> : {};
  return {
    required: asStringArray(env.required),
    optional: asStringArray(env.optional),
  };
}

function parseJsonCString(raw: string | null, key: string) {
  if (!raw) return null;
  const match = raw.match(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`));
  return match?.[1] || null;
}

function parseFrontmatter(raw: string | null) {
  if (!raw?.startsWith('---')) return {};
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return {};
  const meta: Record<string, string> = {};
  for (const line of raw.slice(3, end).split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.+)$/);
    if (!match) continue;
    meta[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }
  return meta;
}

function agentNameFromPath(path: string) {
  return path.split('/').pop()?.replace(/\.md$/, '') || path;
}

export async function loadProjectConfig(project: GitBackedProject, files?: ProjectFileEntry[]): Promise<ProjectConfigSummary> {
  const repoFiles = files ?? await listRepoFiles(project, project.defaultBranch);
  const [manifestRaw, openCodeRaw] = await Promise.all([
    optionalFile(project, project.manifestPath),
    optionalFile(project, '.opencode/opencode.jsonc'),
  ]);

  const agentPaths = repoFiles
    .map((file) => file.path)
    .filter((path) => /^\.opencode\/agents?\/[^/]+\.md$/.test(path))
    .sort();
  const agents = await Promise.all(agentPaths.map(async (path) => {
    const raw = await optionalFile(project, path);
    const meta = parseFrontmatter(raw);
    return {
      name: meta.name || meta.slug || agentNameFromPath(path),
      path,
      description: meta.description || null,
      mode: meta.mode || null,
    };
  }));

  const seenSkills = new Set<string>();
  const skillPaths = repoFiles
    .map((file) => file.path.match(/^\.opencode\/skills\/(.+)\/SKILL\.md$/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .filter((match) => {
      if (seenSkills.has(match[1])) return false;
      seenSkills.add(match[1]);
      return true;
    })
    .map((match) => ({ slug: match[1], path: `.opencode/skills/${match[1]}/SKILL.md` }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
  const skills = await Promise.all(skillPaths.map(async ({ slug, path }) => {
    const raw = await optionalFile(project, path);
    const meta = parseFrontmatter(raw);
    return {
      name: meta.name || slug,
      path,
      description: meta.description || null,
    };
  }));

  // OpenCode slash commands — `.opencode/command/<slug>.md` or
  // `.opencode/commands/<slug>.md` (both forms accepted by the runtime; we
  // include either if present). Frontmatter `description:` is what gets
  // surfaced in the command picker.
  const commandPaths = repoFiles
    .map((file) => file.path.match(/^\.opencode\/commands?\/([^/]+)\.md$/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => ({ slug: match[1], path: match.input as string }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
  const commands = await Promise.all(commandPaths.map(async ({ slug, path }) => {
    const raw = await optionalFile(project, path);
    const meta = parseFrontmatter(raw);
    return {
      name: meta.name || slug,
      path,
      description: meta.description || null,
    };
  }));

  const manifest = parseManifest(manifestRaw);
  const signals = {
    manifest: Boolean(manifestRaw),
    openCodeConfig: Boolean(openCodeRaw),
    openCodeAgent: agents.length > 0,
  };

  return {
    is_kortix_repo: Object.values(signals).some(Boolean),
    signals,
    manifest_raw: manifestRaw,
    manifest,
    env: envRequirements(manifest),
    open_code_raw: openCodeRaw,
    open_code_default_agent: parseJsonCString(openCodeRaw, 'default_agent'),
    agents,
    skills,
    commands,
  };
}

// ---------------------------------------------------------------------------
// Branches / commits / diffs — drives the Versions (branches) and Checkpoints
// (commits) panels in the project file viewer. Internal types still use Git
// vocabulary; user-facing strings are translated in the web layer.
// ---------------------------------------------------------------------------

export interface GitBranchInfo {
  name: string;
  is_default: boolean;
  tip: string;
  tip_short: string;
  subject: string;
  committer_name: string;
  committer_email: string;
  committed_at: string;
  ahead: number | null;
  behind: number | null;
}

export interface GitLogEntry {
  hash: string;
  short_hash: string;
  parents: string[];
  author_name: string;
  author_email: string;
  authored_at: string;
  committer_name: string;
  committer_email: string;
  committed_at: string;
  subject: string;
  body: string;
}

export interface GitCommitFile {
  path: string;
  old_path: string | null;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'typechange';
  additions: number;
  deletions: number;
}

export interface GitCommitDetail extends GitLogEntry {
  files: GitCommitFile[];
}

const FIELD_SEP = '';
const RECORD_SEP = '';
const LOG_FORMAT = [
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

function parseLogStdout(stdout: string): GitLogEntry[] {
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

function decodeStatusChar(code: string): GitCommitFile['status'] {
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

function validateRef(ref: string): string {
  if (!ref) throw new Error('Ref is required');
  // git refs forbid: spaces, "..", "@{", "\\", control chars. Be conservative.
  if (!/^[A-Za-z0-9._\-\/]+$/.test(ref) || ref.includes('..') || ref.startsWith('-')) {
    throw new Error('Invalid ref');
  }
  return ref;
}

function validateSha(sha: string): string {
  if (!sha || !/^[0-9a-fA-F]{4,64}$/.test(sha)) throw new Error('Invalid commit hash');
  return sha;
}

export async function listBranches(project: GitBackedProject): Promise<GitBranchInfo[]> {
  const repoPath = await refreshMirror(project);
  const format = [
    '%(refname:short)',
    '%(objectname)',
    '%(objectname:short)',
    '%(subject)',
    '%(committername)',
    '%(committeremail)',
    '%(committerdate:iso-strict)',
  ].join(FIELD_SEP);
  const result = await runGit(
    ['for-each-ref', `--format=${format}`, '--sort=-committerdate', 'refs/heads/'],
    repoPath,
    false,
  );
  const lines = result.stdout.split('\n').filter(Boolean);
  const baseRef = project.defaultBranch;

  const branches = lines
    .map<GitBranchInfo | null>((line) => {
      const parts = line.split(FIELD_SEP);
      if (parts.length < 7) return null;
      const [name, tip, tipShort, subject, committerName, committerEmail, committedAt] = parts;
      return {
        name,
        is_default: name === baseRef,
        tip,
        tip_short: tipShort,
        subject,
        committer_name: committerName,
        committer_email: committerEmail
          .replace(/^</, '')
          .replace(/>$/, ''),
        committed_at: committedAt,
        ahead: null,
        behind: null,
      };
    })
    .filter((b): b is GitBranchInfo => b !== null);

  // Compute ahead/behind vs default in parallel (skip the default itself).
  await Promise.all(
    branches.map(async (b) => {
      if (b.is_default) {
        b.ahead = 0;
        b.behind = 0;
        return;
      }
      try {
        const rl = await runGit(
          ['rev-list', '--left-right', '--count', `${baseRef}...${b.name}`],
          repoPath,
          false,
        );
        const match = rl.stdout.trim().match(/^(\d+)\s+(\d+)/);
        if (match) {
          b.behind = Number(match[1]);
          b.ahead = Number(match[2]);
        }
      } catch {
        // Default branch missing or unreachable — leave ahead/behind null.
      }
    }),
  );

  return branches;
}

export interface ListCommitsOptions {
  ref?: string;
  path?: string | null;
  limit?: number;
  skip?: number;
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

export interface GetCommitDiffOptions {
  /** When set, only emit the diff for this single path. */
  path?: string | null;
}

export interface CommitDiff {
  hash: string;
  parent: string | null;
  patch: string;
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

export interface GetFileHistoryOptions {
  ref?: string;
  limit?: number;
  skip?: number;
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

export interface GetFileAtRefResult {
  content: string;
  found: boolean;
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
