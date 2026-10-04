import type { RepositoryListOptions, GitHubInstallationRepositories, GitHubRepositorySearchResponse } from "./github-repository-types";
import { createInstallationToken } from "./github-installations";
import { GitHubPersonalAccountCreateUnsupportedError } from "./github-create-errors";
import { GITHUB_API, GitHubApiError, ghFetch, ghFetchAllPages, headers } from "./github-http";
import type { GitHubAuthContext, GitHubRepo, GitHubBranch } from "./github-http";
export function parseGitHubRepoUrl(repoUrl: string): { owner: string; repo: string } | null {
  const m =
    repoUrl.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i) ??
    repoUrl.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (!m) return null;
  return { owner: m[1]!, repo: m[2]! };
}

export interface CreateRepoInput {
  name: string;
  isPrivate?: boolean;
  description?: string;
  autoInit?: boolean;
  owner?: string;
  auth?: GitHubAuthContext;
}

export async function listInstallationRepositories(
  installationId: string,
  options: RepositoryListOptions = {},
): Promise<GitHubRepo[]> {
  const token = await createInstallationToken(installationId);
  const limit = normalizeRepositoryLimit(options.limit);
  const search = options.search?.trim();
  if (search) {
    if (!options.owner) throw new Error('owner is required when searching repositories');
    return searchRepositories({
      owner: options.owner,
      ownerType: options.ownerType ?? 'Organization',
      search,
      limit,
      auth: { token: token.token },
    });
  }

  const body = await ghFetch<GitHubInstallationRepositories>(
    `/installation/repositories?per_page=${limit}&page=1`,
    { method: 'GET' },
    { token: token.token },
  );
  return body.repositories ?? [];
}

/**
 * List repositories for the managed-git PAT backend ("Use a token" self-host
 * setup) — the token equivalent of `listInstallationRepositories`, which only
 * works for a GitHub App installation id. A PAT has no "installation" to
 * enumerate repos from, so this hits the same org-vs-personal-account
 * endpoint `createRepo`/`resolveDefaultOwner` already branch on: an org owner
 * lists via `/orgs/{owner}/repos` (what a fine-grained token scoped to an
 * organization resource-owner can see), a personal owner via `/user/repos`.
 * Empty queries return one recently updated page. Search queries use GitHub's
 * repository search endpoint, scoped to the configured owner.
 * (filtered back down to that owner — a classic token can see collaborator
 * repos under other owners too, which don't belong in "repos for this
 * configured owner").
 */
export async function listOwnerRepositories(input: {
  owner: string;
  ownerType?: 'User' | 'Organization';
  auth: Pick<GitHubAuthContext, 'token'>;
  search?: string;
  limit?: number;
}): Promise<GitHubRepo[]> {
  const isOrg = input.ownerType
    ? input.ownerType !== 'User'
    : await isOrgAccount(input.owner, input.auth);
  const limit = normalizeRepositoryLimit(input.limit);
  const search = input.search?.trim();
  if (search) {
    return searchRepositories({
      owner: input.owner,
      ownerType: isOrg ? 'Organization' : 'User',
      search,
      limit,
      auth: input.auth,
    });
  }

  const params = new URLSearchParams(
    isOrg
      ? { type: 'all' }
      : { affiliation: 'owner,collaborator' },
  );
  params.set('sort', 'updated');
  params.set('direction', 'desc');
  params.set('per_page', String(limit));
  params.set('page', '1');
  const path = isOrg
    ? `/orgs/${encodeURIComponent(input.owner)}/repos?${params.toString()}`
    : `/user/repos?${params.toString()}`;
  const repositories = await ghFetch<GitHubRepo[]>(path, { method: 'GET' }, input.auth);
  return isOrg
    ? repositories
    : repositories.filter(
        (repo) => repo.full_name.split('/')[0]?.toLowerCase() === input.owner.toLowerCase(),
      );
}

function normalizeRepositoryLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 100;
  return Math.min(100, Math.max(1, Math.trunc(value)));
}

async function searchRepositories(input: {
  owner: string;
  ownerType: 'User' | 'Organization';
  search: string;
  limit: number;
  auth: Pick<GitHubAuthContext, 'token'>;
}): Promise<GitHubRepo[]> {
  const qualifier = input.ownerType === 'Organization' ? 'org' : 'user';
  const params = new URLSearchParams({
    q: `${qualifier}:${input.owner} ${input.search} in:name,description`,
    sort: 'updated',
    order: 'desc',
    per_page: String(input.limit),
    page: '1',
  });
  const result = await ghFetch<GitHubRepositorySearchResponse>(
    `/search/repositories?${params.toString()}`,
    { method: 'GET' },
    input.auth,
  );
  return result.items ?? [];
}

export async function listRepositoryBranches(input: {
  owner: string;
  repo: string;
  auth: Pick<GitHubAuthContext, 'token'>;
}): Promise<GitHubBranch[]> {
  return ghFetchAllPages<GitHubBranch>(
    `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/branches`,
    input.auth,
  );
}

export async function getRepositoryBranch(input: {
  owner: string;
  repo: string;
  branch: string;
  auth: Pick<GitHubAuthContext, 'token'>;
}): Promise<GitHubBranch> {
  return ghFetch<GitHubBranch>(
    `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}` +
      `/branches/${encodeURIComponent(input.branch)}`,
    { method: 'GET' },
    input.auth,
  );
}

export async function getRepo(opts: {
  owner: string;
  repo: string;
  auth?: Pick<GitHubAuthContext, 'token'>;
}): Promise<GitHubRepo> {
  return ghFetch<GitHubRepo>(
    `/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}`,
    { method: 'GET' },
    opts.auth,
  );
}

/**
 * Whether a GitHub login is an Organization (vs a personal User). Managed-git
 * was built assuming MANAGED_GIT_GITHUB_OWNER is an org, but a personal account
 * (e.g. a throwaway) needs `/user/repos` not `/orgs/{owner}/repos`. Cached —
 * an account's type doesn't change. Safe default 'org' (historical behavior).
 */
const accountTypeCache = new Map<string, boolean>();
export async function isOrgAccount(
  login: string,
  auth?: Pick<GitHubAuthContext, 'token'>,
): Promise<boolean> {
  const key = login.toLowerCase();
  const cached = accountTypeCache.get(key);
  if (cached !== undefined) return cached;
  try {
    const acc = await ghFetch<{ type?: string }>(`/users/${encodeURIComponent(login)}`, undefined, auth);
    const isOrg = (acc.type ?? 'Organization') === 'Organization';
    accountTypeCache.set(key, isOrg);
    return isOrg;
  } catch {
    return true;
  }
}

async function resolveDefaultOwner(auth?: GitHubAuthContext): Promise<{ owner: string; isOrg: boolean }> {
  if (auth?.owner) {
    return { owner: auth.owner, isOrg: auth.ownerType !== 'User' };
  }

  // App-only: the installation auth context carries the owner. Fall back to
  // the token's authenticated account only if it somehow wasn't provided.
  const me = await ghFetch<{ login: string }>(`/user`, undefined, auth);
  return { owner: me.login, isOrg: false };
}

export async function createRepo(input: CreateRepoInput): Promise<GitHubRepo> {
  const ownerInput = input.owner?.trim();
  if (input.auth?.owner && ownerInput && ownerInput.toLowerCase() !== input.auth.owner.toLowerCase()) {
    throw new Error('GitHub owner must match the account GitHub App installation');
  }

  const target = await resolveDefaultOwner(input.auth);

  const body = {
    name: input.name,
    description: input.description,
    private: input.isPrivate ?? true,
    auto_init: input.autoInit ?? true,
  };

  // `/user/repos` is the only endpoint that can create under a personal owner,
  // and an installation token is not allowed to call it. A PAT and a user
  // access token are, so the rule is about the credential, not the owner.
  if (!target.isOrg && input.auth?.source === 'app_installation') {
    throw new GitHubPersonalAccountCreateUnsupportedError(target.owner);
  }

  const path = target.isOrg ? `/orgs/${target.owner}/repos` : '/user/repos';
  return ghFetch<GitHubRepo>(path, {
    method: 'POST',
    body: JSON.stringify(body),
  }, input.auth);
}

/** Delete a repo. Best-effort teardown for managed-repo rollback / removal. */
/**
 * Give an installation access to one repository.
 *
 * An installation with `repository_selection: 'selected'` sees only what it was
 * granted, and a repository created a moment ago is not on that list — so the
 * starter commits and the runtime push token, which both run on the
 * installation token, would fail against a repository that exists. The endpoint
 * takes a USER access token (it is on GitHub's user-token list), which is the
 * same credential a personal create already holds.
 */
export async function addRepositoryToInstallation(opts: {
  installationId: string;
  repositoryId: number;
  auth: Pick<GitHubAuthContext, 'token'>;
}): Promise<void> {
  await ghFetch<unknown>(
    `/user/installations/${encodeURIComponent(opts.installationId)}/repositories/${opts.repositoryId}`,
    { method: 'PUT' },
    opts.auth,
  );
}

export async function deleteRepo(opts: {
  owner: string;
  repo: string;
  auth?: Pick<GitHubAuthContext, 'token'>;
}): Promise<void> {
  await ghFetch<unknown>(
    `/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}`,
    { method: 'DELETE' },
    opts.auth,
  );
}

export interface GitHubInvitation {
  /** Present when GitHub created a pending invitation (user not yet a member). */
  id?: number;
  html_url?: string;
  permissions?: string;
  invitee?: { login?: string };
}

/**
 * Add a collaborator to a repo (or update their permission). On a repo the user
 * isn't already on, GitHub creates a pending invitation they accept on
 * github.com; returns the invitation (204/no body when already a collaborator).
 * Requires an Administration:write-capable credential on the repo.
 */
export async function addCollaborator(opts: {
  owner: string;
  repo: string;
  username: string;
  /** GitHub permission: pull | triage | push | maintain | admin. */
  permission?: string;
  auth?: Pick<GitHubAuthContext, 'token'>;
}): Promise<GitHubInvitation | null> {
  const res = await fetch(
    `${GITHUB_API}/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}/collaborators/${encodeURIComponent(opts.username)}`,
    {
      method: 'PUT',
      headers: headers(opts.auth),
      body: JSON.stringify({ permission: opts.permission ?? 'push' }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (res.status === 204) return null; // already a collaborator
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`GitHub add collaborator failed (${res.status}): ${detail || res.statusText}`);
  }
  return res.json().catch(() => null) as Promise<GitHubInvitation | null>;
}

export async function getBranchCommitSha(opts: {
  owner: string;
  repo: string;
  branch: string;
  auth?: Pick<GitHubAuthContext, 'token'>;
}): Promise<string> {
  const ref = encodeURIComponent(`heads/${opts.branch}`);
  const body = await ghFetch<{ object?: { sha?: string; type?: string } }>(
    `/repos/${opts.owner}/${opts.repo}/git/ref/${ref}`,
    undefined,
    opts.auth,
  );
  const sha = body.object?.sha;
  if (!sha || !/^[0-9a-f]{40}$/i.test(sha)) {
    throw new Error(`GitHub branch ${opts.branch} did not resolve to a commit SHA`);
  }
  return sha;
}

export async function createBranchRef(opts: {
  owner: string;
  repo: string;
  branch: string;
  sha: string;
  auth?: Pick<GitHubAuthContext, 'token'>;
}): Promise<void> {
  await ghFetch(`/repos/${opts.owner}/${opts.repo}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({
      ref: `refs/heads/${opts.branch}`,
      sha: opts.sha,
    }),
  }, opts.auth);
}

/**
 * Write a single file to a repo via the GitHub Contents API.
 * Used by the starter scaffold — one commit per file under the default
 * branch. If the file already exists (e.g. `README.md` from `auto_init`),
 * pass `existingSha` and the call upserts instead of failing.
 */
/**
 * Write many text files to a branch as ONE commit, through the Git Data API:
 * read the branch tip, create one tree on top of its tree with every file
 * inline, create one commit, move the branch.
 *
 * The starter is ~180 files. One Contents-API PUT per file is ~180 sequential
 * round trips — it ran past the API's 25 s request deadline, so the repository
 * was created and the user saw `503 request_deadline`. This is five requests
 * whatever the file count, and the branch moves only after the commit exists:
 * a failure leaves the branch where it was, never half-scaffolded.
 *
 * `force: false` on the ref update: if something else moved the branch in the
 * meantime, GitHub refuses rather than discarding that commit.
 */
export async function commitFiles(opts: {
  owner: string;
  repo: string;
  branch: string;
  files: Array<{ path: string; content: string }>;
  message: string;
  authorName?: string;
  authorEmail?: string;
  auth?: GitHubAuthContext;
}): Promise<void> {
  const base = `/repos/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.repo)}`;
  const ident = {
    name: opts.authorName || 'Kortix',
    email: opts.authorEmail || 'noreply@kortix.ai',
  };

  const ref = await ghFetch<{ object?: { sha?: string } }>(
    `${base}/git/ref/heads/${encodeURIComponent(opts.branch)}`,
    undefined,
    opts.auth,
  );
  const parentSha = ref.object?.sha;
  if (!parentSha) throw new Error(`GitHub branch ${opts.branch} did not resolve to a commit`);

  const parent = await ghFetch<{ tree?: { sha?: string } }>(
    `${base}/git/commits/${parentSha}`,
    undefined,
    opts.auth,
  );
  const baseTree = parent.tree?.sha;
  if (!baseTree) throw new Error(`GitHub commit ${parentSha} has no tree`);

  const tree = await ghFetch<{ sha: string }>(`${base}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({
      base_tree: baseTree,
      tree: opts.files.map((file) => ({
        path: file.path,
        mode: '100644',
        type: 'blob',
        content: file.content,
      })),
    }),
  }, opts.auth);

  const commit = await ghFetch<{ sha: string }>(`${base}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({
      message: opts.message,
      tree: tree.sha,
      parents: [parentSha],
      author: ident,
      committer: ident,
    }),
  }, opts.auth);

  await ghFetch(`${base}/git/refs/heads/${encodeURIComponent(opts.branch)}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.sha, force: false }),
  }, opts.auth);
}

export async function commitFile(opts: {
  owner: string;
  repo: string;
  path: string;
  content: string;
  message: string;
  branch?: string;
  existingSha?: string;
  authorName?: string;
  authorEmail?: string;
  auth?: GitHubAuthContext;
}): Promise<void> {
  // Pin the commit identity explicitly. Without an `author`/`committer` the
  // Contents API attributes the commit to whoever owns the token — which, on a
  // server-side PAT, surfaces a personal GitHub user (e.g. "markokraemer
  // committed") instead of Kortix. Defaulting here mirrors the identity used by
  // every git-CLI commit path (branches.ts / merge.ts / seed.ts).
  const ident = {
    name: opts.authorName || 'Kortix',
    email: opts.authorEmail || 'noreply@kortix.ai',
  };
  const body: Record<string, unknown> = {
    message: opts.message,
    content: Buffer.from(opts.content, 'utf8').toString('base64'),
    author: ident,
    committer: ident,
  };
  if (opts.branch) body.branch = opts.branch;
  if (opts.existingSha) body.sha = opts.existingSha;

  await ghFetch(`/repos/${opts.owner}/${opts.repo}/contents/${encodeURI(opts.path)}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  }, opts.auth);
}

/** GET an existing file's blob sha so `commitFile` can upsert. Returns null
 * if the file doesn't exist. */
export async function getFileSha(opts: {
  owner: string;
  repo: string;
  path: string;
  branch?: string;
  auth?: GitHubAuthContext;
}): Promise<string | null> {
  try {
    const qs = opts.branch ? `?ref=${encodeURIComponent(opts.branch)}` : '';
    const res = await ghFetch<{ sha: string }>(
      `/repos/${opts.owner}/${opts.repo}/contents/${encodeURI(opts.path)}${qs}`,
      undefined,
      opts.auth,
    );
    return res.sha ?? null;
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) return null;
    throw error;
  }
}
