import { spawnSync } from 'node:child_process';

// ─────────────────────────────────────────────────────────────────────────────
// How the CLI talks git to a project — ONE resolver, shared by every command
// that clones, pushes, or answers a git credential prompt (`kortix ship`,
// `kortix projects clone`, `kortix git-credential`).
//
// It used to be per-command, and they drifted: clone preferred the Kortix git
// proxy while ship insisted on minting a raw provider push token for managed
// repos. The proxy keeps upstream credentials server-side. Keeping the decision
// in one place prevents commands from bypassing that boundary.
// ─────────────────────────────────────────────────────────────────────────────

/** Which credential a git operation against this project should present. */
export type ProjectGitCredentialMode =
  /** Push/clone through the Kortix git proxy with our own Kortix token. */
  | 'kortix-token'
  /** The managed project came from an old host response without a proxy URL. */
  | 'proxy-required'
  /** BYO repo — the user's own git credentials (helper/keychain/ssh). */
  | 'none';

export interface ProjectGitTarget {
  repoUrl: string;
  credentialMode: ProjectGitCredentialMode;
}

/** Minimal shape the resolver needs — `ProjectSummary` and the provision
 *  response both satisfy it. */
export interface ProjectGitRef {
  repo_url: string;
  git_origin_url?: string;
  metadata?: Record<string, unknown> | null;
}

/** A Kortix git-proxy origin (`https://<host>/v1/git/<projectId>.git`). The
 *  server only advertises one when KORTIX_GIT_PROXY is on; otherwise
 *  `git_origin_url` mirrors the raw upstream and this is false. */
export function isGitProxyUrl(url: string | undefined | null): boolean {
  return Boolean(url && /\/v1\/git\//.test(url));
}

/** Canonical managed flag — `metadata.git.managed`. */
export function projectIsManaged(project: ProjectGitRef): boolean {
  const git = project.metadata?.git as { managed?: boolean } | undefined;
  return git?.managed === true;
}

/**
 * Resolve the URL + credential kind for any git operation on a project.
 *
 * The Kortix git proxy is the UNIVERSAL client-facing origin, so it wins for
 * EVERY project that advertises one — managed repos included. We authenticate
 * with our own Kortix token and the API resolves the real upstream and mints
 * the host credential server-side, which means:
 *   * no real provider credential ever reaches the client, and
 *   * it works with Nango-backed account and managed connections.
 *
 * A managed project without a proxy URL requires a host or CLI upgrade. A BYO
 * repository without a proxy uses the user's own git authentication.
 */
export function resolveProjectGitTarget(project: ProjectGitRef): ProjectGitTarget {
  const proxyUrl = project.git_origin_url;
  if (isGitProxyUrl(proxyUrl)) {
    return { repoUrl: proxyUrl as string, credentialMode: 'kortix-token' };
  }
  if (projectIsManaged(project)) {
    return { repoUrl: project.repo_url, credentialMode: 'proxy-required' };
  }
  return { repoUrl: project.repo_url, credentialMode: 'none' };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The installed binary can call itself by name. During source development,
 * preserve the exact Bun entrypoint so a clone made with `bun run ...` can be
 * exercised before the CLI is rebuilt and installed.
 */
export function currentGitCredentialHelperCommand(): string {
  const override = process.env.KORTIX_GIT_CREDENTIAL_HELPER?.trim();
  if (override) return override.startsWith('!') ? override : `!${override}`;

  const entrypoint = process.argv[1];
  if (entrypoint && /\.[cm]?[jt]sx?$/.test(entrypoint) && /bun/i.test(process.execPath)) {
    return `!${shellQuote(process.execPath)} ${shellQuote(entrypoint)} git-credential`;
  }
  return '!kortix git-credential';
}

/**
 * Install a URL-scoped helper for the Kortix proxy. The leading empty helper
 * resets inherited helpers for this credential context, preventing the user's
 * keychain from persisting the Kortix token returned on demand.
 */
export function configureProjectGitAuth(
  repoRoot: string,
  repoUrl: string,
  helperCommand = currentGitCredentialHelperCommand(),
): void {
  const context = repoUrl.replace(/\/+$/, '');
  const helperKey = `credential.${context}.helper`;
  const reset = spawnSync('git', ['config', '--local', '--replace-all', helperKey, ''], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (reset.status !== 0) {
    throw new Error(reset.stderr.trim() || 'Could not reset Git credential helpers');
  }
  const add = spawnSync('git', ['config', '--local', '--add', helperKey, helperCommand], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (add.status !== 0) {
    throw new Error(add.stderr.trim() || 'Could not configure the Kortix Git credential helper');
  }
  const pathMode = spawnSync('git', ['config', '--local', 'credential.useHttpPath', 'true'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (pathMode.status !== 0) {
    throw new Error(pathMode.stderr.trim() || 'Could not configure Git credential paths');
  }
}
