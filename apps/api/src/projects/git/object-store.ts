/**
 * The project object store: what the API keeps of a repository, and how it
 * gets exactly the objects a read needs.
 *
 * Why (2026-11-02): every API replica ran `git clone --bare` of every project
 * repository: every commit, every tree, every file version ever pushed. One
 * project held 6,388 MB of history (1,056 MB at the tip). Its clone never
 * finished inside the 90 s budget, so `/detail` failed with 503
 * `request_deadline`, every attempt was downloaded and thrown away, and a
 * finished clone would not have fit the 4 GiB cache either.
 *
 * What the API reads is small: the commit graph (merge bases, history), the
 * trees of the commits it looks at, and a handful of files (`kortix.yaml`, the
 * agents, the skills). So the store is a partial clone that holds only that,
 * and nothing arrives without an explicit request:
 *
 * - commits: `--filter=tree:0` on clone and refresh (that project: 217 KB);
 * - the trees of one commit: one `want <tree>` with `--filter=blob:none`
 *   (that project's tip: 164 KB);
 * - files: one `want <oid>…` request for exactly the blobs a read names.
 *
 * Every git process on the API runs with `GIT_NO_LAZY_FETCH=1`: git never
 * downloads a missing object on its own. A missing object fails the command,
 * and the store layer (`mirror.ts`) fetches that object and retries. Implicit
 * fetches would run without credentials, one object per round trip, with no
 * size bound.
 *
 * This module is a leaf: it imports nothing from the mirror. `mirror.ts`
 * passes in the credential environment.
 */

import { execFile, spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { childProcessEnv, config } from '../../config';

const execFileAsync = promisify(execFile);

/** Every git process on a store gets this: a missing object is an error, never a download. */
export const NO_LAZY_FETCH_ENV = { GIT_NO_LAZY_FETCH: '1' } as const;

/** The filter a partial store is cloned and refreshed with: commits only. */
export const COMMITS_ONLY_FILTER = 'tree:0';

/** `GIT_NO_LAZY_FETCH` exists from git 2.45. Older git would download every missing object on its own. */
const MIN_PARTIAL_GIT = [2, 45] as const;

let partialSupport: Promise<boolean> | null = null;

/**
 * Whether new stores are partial. `KORTIX_GIT_OBJECT_STORE=full` keeps the old
 * whole-history clone (the kill switch). Git older than 2.45 (Apple git on a
 * Mac) cannot refuse an implicit fetch, so it keeps whole clones too.
 */
export function partialStoresEnabled(): Promise<boolean> {
  if (config.KORTIX_GIT_OBJECT_STORE === 'full') return Promise.resolve(false);
  partialSupport ??= execFileAsync('git', ['--version'], { timeout: 10_000 })
    .then(({ stdout }) => gitVersionSupportsPartialStores(String(stdout)))
    .catch(() => false);
  return partialSupport;
}

/** `git version 2.47.3` → true. Exported for the unit test. */
export function gitVersionSupportsPartialStores(versionLine: string): boolean {
  const match = /git version (\d+)\.(\d+)/.exec(versionLine);
  if (!match) return false;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major > MIN_PARTIAL_GIT[0] || (major === MIN_PARTIAL_GIT[0] && minor >= MIN_PARTIAL_GIT[1]);
}

/** A fetch would transfer more than its caller allows. Nothing it received is kept. */
export class ObjectFetchTooLargeError extends Error {
  constructor(
    readonly maxBytes: number,
    readonly receivedBytes: number,
  ) {
    super(`git objects exceed the ${maxBytes}-byte fetch limit (received ${receivedBytes} bytes before stopping)`);
    this.name = 'ObjectFetchTooLargeError';
  }
}

export function isObjectFetchTooLargeError(err: unknown): err is ObjectFetchTooLargeError {
  return err instanceof ObjectFetchTooLargeError;
}

const OID = /^[0-9a-f]{40}$/;

/** The ids among `oids` the store does not hold. Never fetches. */
export async function missingObjects(repoPath: string, oids: readonly string[]): Promise<string[]> {
  const wanted = [...new Set(oids.filter((oid) => OID.test(oid)))];
  if (wanted.length === 0) return [];
  const { stdout } = await runWithInput(
    'git',
    ['cat-file', '--batch-check=%(objectname)'],
    repoPath,
    `${wanted.join('\n')}\n`,
    childProcessEnv({ GIT_TERMINAL_PROMPT: '0', ...NO_LAZY_FETCH_ENV }),
    60_000,
  );
  const missing: string[] = [];
  for (const line of stdout.split('\n')) {
    const [oid, state] = line.trim().split(' ');
    if (oid && state === 'missing') missing.push(oid);
  }
  return missing;
}

/**
 * The object ids a failed git command could not read on a partial store.
 * Git names them in several ways, depending on the command.
 */
export function missingObjectIdsFromGitError(text: string): string[] {
  const ids = new Set<string>();
  const patterns = [
    /could not fetch ([0-9a-f]{40}) from promisor remote/g,
    /unable to read ([0-9a-f]{40})/g,
    /unable to read tree \(?([0-9a-f]{40})/g,
    /missing (?:blob|tree|commit) object '?([0-9a-f]{40})/g,
    /invalid object \d+ ([0-9a-f]{40})/g,
    /bad object ([0-9a-f]{40})\b/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) ids.add(match[1]!);
  }
  return [...ids];
}

export interface FetchObjectsOptions {
  /** Credentials and other variables for the fetch (`gitAuthEnv`). */
  env: Record<string, string>;
  /** The fetch is stopped once the received pack passes this many bytes. */
  maxBytes: number;
  timeoutMs?: number;
}

/**
 * Fetch exactly `oids` from `origin` in one request.
 *
 * - A wanted tree arrives with all of its subtrees and none of its blobs
 *   (`--filter=blob:none`). A wanted blob arrives itself: a filter never
 *   drops an object that is asked for by id.
 * - No negotiation (`noop`): the request names objects, not history.
 * - Everything arrives as one pack (`unpackLimit=1`), so its size is what the
 *   byte limit watches while it is written. Over the limit the fetch is
 *   killed and its partial pack deleted: `ObjectFetchTooLargeError`.
 *
 * Fetches into one store run one at a time (`withStoreLock`), so the watcher
 * only ever sees its own pack.
 */
export async function fetchObjects(
  repoPath: string,
  oids: readonly string[],
  options: FetchObjectsOptions,
): Promise<{ receivedBytes: number }> {
  const wanted = [...new Set(oids.filter((oid) => OID.test(oid)))];
  if (wanted.length === 0) return { receivedBytes: 0 };
  return withStoreLock(repoPath, async () => {
    const missing = await missingObjects(repoPath, wanted);
    if (missing.length === 0) return { receivedBytes: 0 };
    return fetchMissing(repoPath, missing, options);
  });
}

async function fetchMissing(
  repoPath: string,
  oids: string[],
  { env, maxBytes, timeoutMs = 120_000 }: FetchObjectsOptions,
): Promise<{ receivedBytes: number }> {
  const packDir = join(repoPath, 'objects', 'pack');
  const before = new Set(await readdir(packDir).catch(() => [] as string[]));
  const args = [
    '-c', 'fetch.negotiationAlgorithm=noop',
    '-c', 'fetch.unpackLimit=1',
    '-c', 'transfer.unpackLimit=1',
    'fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--filter=blob:none', '--stdin', 'origin',
  ];
  const child = spawn('git', args, {
    cwd: repoPath,
    env: childProcessEnv({ GIT_TERMINAL_PROMPT: '0', ...env, ...NO_LAZY_FETCH_ENV }),
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    if (stderr.length < 8_192) stderr += chunk.toString();
  });
  child.stdin.on('error', () => {});
  child.stdin.end(`${oids.join('\n')}\n`);

  let received = 0;
  let stopped: 'size' | 'time' | null = null;
  const watch = setInterval(() => {
    void newPackBytes(packDir, before).then((bytes) => {
      received = Math.max(received, bytes);
      if (bytes > maxBytes && !stopped) {
        stopped = 'size';
        child.kill('SIGKILL');
      }
    });
  }, 50);
  const timer = setTimeout(() => {
    stopped ??= 'time';
    child.kill('SIGKILL');
  }, timeoutMs);
  const code = await new Promise<number | null>((resolve) => {
    child.once('error', () => resolve(null));
    child.once('close', (exitCode) => resolve(exitCode));
  });
  clearInterval(watch);
  clearTimeout(timer);
  received = Math.max(received, await newPackBytes(packDir, before));

  if (stopped === 'size' || (code === 0 && received > maxBytes)) {
    // A killed index-pack can leave its temporary pack behind. A pack that
    // completed just before the watcher saw it is over the limit too: drop
    // both, so an over-limit fetch never fills the store.
    await removeNewPacks(packDir, before);
    throw new ObjectFetchTooLargeError(maxBytes, received);
  }
  if (stopped === 'time') {
    await removeNewPacks(packDir, before, /^tmp_/);
    throw new Error(`git fetch of ${oids.length} objects timed out after ${timeoutMs}ms`);
  }
  if (code !== 0) {
    await removeNewPacks(packDir, before, /^tmp_/);
    throw new Error(`git fetch of ${oids.length} objects failed (exit ${code}): ${stderr.trim().slice(0, 500)}`);
  }
  return { receivedBytes: received };
}

async function newPackBytes(packDir: string, before: Set<string>): Promise<number> {
  let total = 0;
  for (const name of await readdir(packDir).catch(() => [] as string[])) {
    if (before.has(name) || !(name.endsWith('.pack') || name.startsWith('tmp_pack_'))) continue;
    total += (await stat(join(packDir, name)).catch(() => null))?.size ?? 0;
  }
  return total;
}

async function removeNewPacks(packDir: string, before: Set<string>, only?: RegExp): Promise<void> {
  const { rm } = await import('node:fs/promises');
  for (const name of await readdir(packDir).catch(() => [] as string[])) {
    if (before.has(name) || (only && !only.test(name))) continue;
    await rm(join(packDir, name), { force: true }).catch(() => {});
  }
}

// replica-local: serialises object fetches into one store on this replica's disk.
const storeLocks = new Map<string, Promise<unknown>>();

/** Run `fn` after every earlier fetch into the same store has settled. */
export function withStoreLock<T>(repoPath: string, fn: () => Promise<T>): Promise<T> {
  const previous = storeLocks.get(repoPath) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(fn);
  const settled = next.catch(() => {});
  storeLocks.set(repoPath, settled);
  void settled.then(() => {
    if (storeLocks.get(repoPath) === settled) storeLocks.delete(repoPath);
  });
  return next;
}

function runWithInput(
  command: string,
  args: string[],
  cwd: string,
  input: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      if (err.length < 4_096) err += chunk.toString();
    });
    child.stdin.on('error', () => {});
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout: Buffer.concat(out).toString('utf8') });
      else reject(new Error(`${command} ${args[0]} exited ${code}: ${err.trim().slice(0, 300)}`));
    });
    child.stdin.end(input);
  });
}
