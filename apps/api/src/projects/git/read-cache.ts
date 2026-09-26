/**
 * Commit-addressed cache for reads from a project's bare git mirror.
 *
 * Why (2026-09-27): on prod every project read re-ran the same `git show` /
 * `git ls-tree` processes. `Server-Timing` on a real project: `/detail` 48
 * git processes (1.1 s), `/files` 46, `/resource-grants` 48, the session
 * `/config` 21 (1.7 s), `/sandbox-health` (sidebar poll) 15, `/secrets` 14,
 * `/triggers` 13. Each spawn costs ~20 ms on the API containers, and the
 * answers never change between requests unless the branch moves.
 *
 * The content of `<commit>:<path>` is immutable, so reads are keyed by the
 * commit SHA, never by the branch name. The branch is resolved to its SHA on
 * EVERY read, from the mirror's ref files (no process), so a fetch, an
 * `update-ref` inside the mirror (merges, API writes) or a pruned branch is
 * seen on the very next read. There is no invalidation to forget.
 */
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const FULL_SHA = /^[0-9a-f]{40}$/;
/** Total cached bytes (strings are UTF-16, counted as 2 bytes per char). */
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
/** A single answer larger than this is served but not kept. */
const MAX_ENTRY_BYTES = 2 * 1024 * 1024;

interface Entry {
  value: Promise<unknown>;
  bytes: number;
}

const entries = new Map<string, Entry>();
let cachedBytes = 0;
const stats = { hits: 0, misses: 0, refFallbacks: 0 };

function sizeOf(value: unknown): number {
  if (typeof value === 'string') return value.length * 2;
  try {
    return JSON.stringify(value)?.length * 2 || 64;
  } catch {
    return MAX_ENTRY_BYTES + 1;
  }
}

function evictUntilUnderBudget() {
  // Map iteration is insertion order; `get` re-inserts on hit, so the first
  // key is the least recently used.
  for (const [key, entry] of entries) {
    if (cachedBytes <= MAX_CACHE_BYTES) break;
    entries.delete(key);
    cachedBytes -= entry.bytes;
  }
}

/**
 * Run `load` once per (mirror, commit, operation, argument) and keep the
 * answer. Concurrent callers share one run. A rejected read is dropped so the
 * next caller retries; `load` decides what counts as an answer (a "path not
 * found" sentinel is an answer, a network or timeout failure is not).
 */
export function cachedGitRead<T>(
  repoPath: string,
  sha: string,
  op: string,
  arg: string,
  load: () => Promise<T>,
): Promise<T> {
  const key = `${repoPath}\u0000${sha}\u0000${op}\u0000${arg}`;
  const hit = entries.get(key);
  if (hit) {
    stats.hits += 1;
    entries.delete(key);
    entries.set(key, hit);
    return hit.value as Promise<T>;
  }
  stats.misses += 1;
  const value = load();
  const entry: Entry = { value, bytes: 0 };
  entries.set(key, entry);
  value.then(
    (answer) => {
      if (entries.get(key) !== entry) return;
      const bytes = sizeOf(answer);
      if (bytes > MAX_ENTRY_BYTES) {
        entries.delete(key);
        return;
      }
      entry.bytes = bytes;
      cachedBytes += bytes;
      evictUntilUnderBudget();
    },
    () => {
      if (entries.get(key) === entry) entries.delete(key);
    },
  );
  return value;
}

/** A ref path inside the mirror, or null when it would leave it. */
function refFile(repoPath: string, ref: string): string | null {
  const root = resolve(repoPath);
  const file = resolve(join(root, ref));
  return file.startsWith(root + sep) ? file : null;
}

async function readLooseRef(repoPath: string, ref: string, depth: number): Promise<string | null> {
  const file = refFile(repoPath, ref);
  if (!file) return null;
  let text: string;
  try {
    text = (await readFile(file, 'utf8')).trim();
  } catch {
    return null;
  }
  if (FULL_SHA.test(text)) return text;
  const symbolic = text.match(/^ref:\s*(\S+)$/);
  if (symbolic && depth < 5) return resolveDiskRef(repoPath, symbolic[1]!, depth + 1);
  return null;
}

const packedRefs = new Map<string, { mtimeMs: number; size: number; refs: Map<string, string> }>();

async function readPackedRef(repoPath: string, ref: string): Promise<string | null> {
  const file = join(repoPath, 'packed-refs');
  let info;
  try {
    info = await stat(file);
  } catch {
    return null;
  }
  let cached = packedRefs.get(file);
  if (!cached || cached.mtimeMs !== info.mtimeMs || cached.size !== info.size) {
    const refs = new Map<string, string>();
    for (const line of (await readFile(file, 'utf8')).split('\n')) {
      const match = line.match(/^([0-9a-f]{40}) (\S+)$/);
      if (match) refs.set(match[2]!, match[1]!);
    }
    cached = { mtimeMs: info.mtimeMs, size: info.size, refs };
    packedRefs.set(file, cached);
  }
  return cached.refs.get(ref) ?? null;
}

async function resolveDiskRef(repoPath: string, ref: string, depth = 0): Promise<string | null> {
  // Loose refs win over packed-refs, exactly as git resolves them.
  return (await readLooseRef(repoPath, ref, depth)) ?? (await readPackedRef(repoPath, ref));
}

/**
 * The commit (or tag object) SHA `ref` points at in the mirror, or null when
 * it does not resolve. Reads the ref files directly; only an abbreviated SHA
 * or an unusual ref spelling pays a `git rev-parse`.
 */
export async function resolveRefSha(repoPath: string, ref: string): Promise<string | null> {
  if (FULL_SHA.test(ref)) return ref;
  const candidates = ref === 'HEAD' || ref.startsWith('refs/')
    ? [ref]
    : [`refs/heads/${ref}`, `refs/tags/${ref}`, `refs/remotes/${ref}`];
  for (const candidate of candidates) {
    const sha = await resolveDiskRef(repoPath, candidate);
    if (sha) return sha;
  }
  stats.refFallbacks += 1;
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{object}`], {
      cwd: repoPath,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      timeout: 10_000,
    });
    const sha = stdout.toString().trim();
    return FULL_SHA.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

export function gitReadCacheStats() {
  return { ...stats, entries: entries.size, bytes: cachedBytes };
}

export function clearGitReadCacheForTests() {
  entries.clear();
  packedRefs.clear();
  cachedBytes = 0;
  stats.hits = 0;
  stats.misses = 0;
  stats.refFallbacks = 0;
}
