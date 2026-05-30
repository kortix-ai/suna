/**
 * Freestyle Git (https://docs.freestyle.sh/v2/git) client for Kortix-managed
 * project repos.
 *
 * This is the "default Kortix git": when a user runs `kortix ship` in a repo
 * with no `origin` remote, the backend provisions a repo here, on Kortix's
 * own Freestyle account (server `FREESTYLE_API_KEY`), and hands the CLI a
 * scoped, write-only token to push their first commit. Non-technical users
 * never touch GitHub.
 *
 * We deliberately reuse `callFreestyle` from the deployments adapter rather
 * than pull in the freestyle-sandboxes SDK — the rest of the codebase talks
 * to Freestyle over hand-rolled fetch (and stubs it in tests), so git stays
 * consistent with that.
 *
 * REST surface (from the Freestyle OpenAPI):
 *   POST   /git/v1/repo                                  create repo
 *   GET    /git/v1/repo/{repo}                           repo info
 *   POST   /git/v1/identity                              create identity
 *   POST   /git/v1/identity/{identity}/permissions/{repo}  grant permission
 *   POST   /git/v1/identity/{identity}/tokens            mint access token
 *
 * Clone/push:  https://git.freestyle.sh/{repoId} with `x-access-token:{token}`
 * basic auth — the same scheme `projects/git.ts` already uses for GitHub.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { callFreestyle, getFreestyleApiKey } from '../deployments/providers/freestyle';

const execFileAsync = promisify(execFile);

/** Host that serves the actual git protocol (distinct from the api host). */
const GIT_HOST = 'https://git.freestyle.sh';

export interface ManagedRepo {
  repoId: string;
  /** Clone/push URL (no embedded credentials). */
  gitUrl: string;
  defaultBranch: string;
}

export type GitPermission = 'read' | 'write' | 'merge';

/** True when the server has a Freestyle key to provision managed repos. */
export async function isFreestyleGitConfigured(): Promise<boolean> {
  return Boolean(await getFreestyleApiKey());
}

/** Build the credential-free git URL for a Freestyle repo id. */
export function freestyleGitUrl(repoId: string): string {
  return `${GIT_HOST}/${repoId}`;
}

/**
 * Build a push/clone URL with the token embedded as basic-auth, e.g.
 * `https://x-access-token:TOKEN@git.freestyle.sh/REPO`. Handy when the caller
 * wants a one-shot authenticated URL; the CLI prefers injecting the token via
 * an http.extraHeader so it never lands in `.git/config`.
 */
export function freestyleAuthedGitUrl(repoId: string, token: string): string {
  return `https://x-access-token:${encodeURIComponent(token)}@git.freestyle.sh/${repoId}`;
}

async function freestyleJson<T>(
  path: string,
  options: { method: string; body?: unknown; timeoutMs?: number },
  action: string,
): Promise<T> {
  let res: Response;
  try {
    res = await callFreestyle(path, options);
  } catch (err) {
    throw new Error(
      `Freestyle git: ${action} failed — ${err instanceof Error ? err.message : 'unreachable'}`,
    );
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    let message = text || `HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(text);
      message = parsed.message || parsed.description || parsed.error || message;
    } catch {
      /* keep raw text */
    }
    throw new Error(`Freestyle git: ${action} failed (${res.status}) — ${message}`);
  }
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Freestyle git: ${action} returned non-JSON response`);
  }
}

/**
 * Create an empty managed repo. The CLI pushes the user's local working tree
 * as the first commit, so we don't seed any files here.
 */
export async function createManagedRepo(input: {
  name: string;
  defaultBranch?: string;
  /** Defaults to private — managed agent repos shouldn't be world-readable. */
  isPublic?: boolean;
}): Promise<ManagedRepo> {
  const defaultBranch = input.defaultBranch || 'main';
  const data = await freestyleJson<Record<string, unknown>>(
    '/git/v1/repo',
    {
      method: 'POST',
      body: {
        name: input.name,
        public: input.isPublic ?? false,
        defaultBranch,
      },
      timeoutMs: 30_000,
    },
    'create repo',
  );

  const repoId = String(data.repoId ?? data.id ?? data.repo ?? '');
  if (!repoId) {
    throw new Error('Freestyle git: create repo response missing repo id');
  }
  return { repoId, gitUrl: freestyleGitUrl(repoId), defaultBranch };
}

/** Create a fresh Freestyle identity; returns its id. */
export async function createIdentity(): Promise<string> {
  const data = await freestyleJson<Record<string, unknown>>(
    '/git/v1/identity',
    { method: 'POST', timeoutMs: 15_000 },
    'create identity',
  );
  const identityId = String(data.identityId ?? data.id ?? data.identity ?? '');
  if (!identityId) {
    throw new Error('Freestyle git: create identity response missing identity id');
  }
  return identityId;
}

/** Grant an identity a permission level on a repo. */
export async function grantRepoPermission(
  identityId: string,
  repoId: string,
  permission: GitPermission = 'write',
): Promise<void> {
  await freestyleJson<unknown>(
    `/git/v1/identity/${identityId}/permissions/${repoId}`,
    { method: 'POST', body: { permission }, timeoutMs: 15_000 },
    'grant permission',
  );
}

/** Mint a git access token for an identity. */
export async function mintIdentityToken(identityId: string): Promise<string> {
  const data = await freestyleJson<Record<string, unknown>>(
    `/git/v1/identity/${identityId}/tokens`,
    { method: 'POST', timeoutMs: 15_000 },
    'mint token',
  );
  const token = String(data.token ?? data.accessToken ?? data.value ?? '');
  if (!token) {
    throw new Error('Freestyle git: token response missing token value');
  }
  return token;
}

/**
 * One-shot: ensure there is an identity with write access to `repoId`, then
 * mint a token for it. Reuses an existing identity when one is supplied
 * (stored per-project in `metadata.freestyle.identityId`).
 */
export async function mintRepoPushToken(input: {
  repoId: string;
  identityId?: string | null;
}): Promise<{ identityId: string; token: string }> {
  let identityId = input.identityId ?? null;
  if (!identityId) {
    identityId = await createIdentity();
    await grantRepoPermission(identityId, input.repoId, 'write');
  }
  const token = await mintIdentityToken(identityId);
  return { identityId, token };
}

/** Delete a managed repo (used when a project is removed). Best-effort. */
export async function deleteManagedRepo(repoId: string): Promise<void> {
  await freestyleJson<unknown>(
    `/git/v1/repo/${repoId}`,
    { method: 'DELETE', timeoutMs: 15_000 },
    'delete repo',
  );
}

/**
 * Seed a freshly-created (empty) managed repo with an initial commit by pushing
 * a set of files from a throwaway temp clone. Used by the web "Create project"
 * flow — there's no local working tree to push (unlike `kortix ship`), so the
 * server has to lay down the starter or sessions can't boot from an empty repo.
 *
 * Auth uses the same `x-access-token` basic scheme as everywhere else, injected
 * per-invocation via http.extraHeader so the token never lands in a config file.
 */
export async function seedRepoWithFiles(input: {
  repoId: string;
  token: string;
  files: Array<{ path: string; content: string }>;
  branch?: string;
  commitMessage?: string;
  authorName?: string;
  authorEmail?: string;
}): Promise<void> {
  const branch = input.branch || 'main';
  const gitUrl = freestyleGitUrl(input.repoId);
  const name = input.authorName || 'Kortix';
  const email = input.authorEmail || 'noreply@kortix.ai';
  const dir = await mkdtemp(join(tmpdir(), 'kortix-seed-'));

  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  const run = (args: string[], extra: string[] = []) =>
    execFileAsync('git', [...extra, ...args], { cwd: dir, env, timeout: 60_000 });

  try {
    await run(['init', '-b', branch]);
    await run(['config', 'user.name', name]);
    await run(['config', 'user.email', email]);
    for (const file of input.files) {
      const full = join(dir, file.path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, file.content, 'utf8');
    }
    await run(['add', '-A']);
    await run(['commit', '-m', input.commitMessage || 'chore: scaffold Kortix project']);

    const host = new URL(gitUrl).host;
    const encoded = Buffer.from(`x-access-token:${input.token}`).toString('base64');
    await run(
      ['push', gitUrl, `${branch}:refs/heads/${branch}`],
      ['-c', `http.https://${host}/.extraheader=AUTHORIZATION: basic ${encoded}`],
    );
  } catch (error) {
    const err = error as { stderr?: Buffer | string; message?: string };
    const detail = (err.stderr?.toString() || err.message || 'git failed').trim();
    throw new Error(`Freestyle git: seed repo failed — ${detail}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
