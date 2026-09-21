/**
 * The instance GIT BACKEND — the one owner plus credential this deployment
 * uses to create Kortix-managed repositories.
 *
 * It is NOT an account connection, and it is not the App identity. An account
 * connects its own installations (`kortix.account_github_installations`); the
 * identity is the App this deployment signs as (`./github-app-identity`).
 *
 * ONE source owns the whole backend. Either the env variables own it, or the
 * `managed_git_backend` platform setting owns it. A stored owner NEVER pairs
 * with an env token: that mix is exactly the 2026-09-16 production incident
 * (owner `kortix-ai` from the database, token from `MANAGED_GIT_GITHUB_TOKEN`
 * for `managed-kortix`, every repo create 403).
 */

import { createCachedPlatformSetting } from './platform-setting-cache';

export const MANAGED_GIT_BACKEND_KEY = 'managed_git_backend';

export type GitBackendSource = 'env' | 'db';

export interface AppGitBackend {
  source: GitBackendSource;
  kind: 'app';
  owner: string;
  /** GitHub's own `account.type`. Null when it was never recorded. */
  ownerType: 'User' | 'Organization' | null;
  installationId: string;
}

export interface PatGitBackend {
  source: GitBackendSource;
  kind: 'pat';
  owner: string;
  token: string;
}

export type GitBackend = AppGitBackend | PatGitBackend;

/** The stored shape. Only a complete row resolves. */
export interface StoredGitBackend {
  kind?: 'app' | 'pat';
  owner?: string;
  ownerType?: 'User' | 'Organization';
  installationId?: string;
  token?: string;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function ownerType(value: unknown): 'User' | 'Organization' | undefined {
  return value === 'User' || value === 'Organization' ? value : undefined;
}

function parse(value: unknown): StoredGitBackend {
  if (!value || typeof value !== 'object') return {};
  const v = value as Record<string, unknown>;
  return {
    kind: v.kind === 'app' || v.kind === 'pat' ? v.kind : undefined,
    owner: str(v.owner),
    ownerType: ownerType(v.ownerType),
    installationId: str(v.installationId),
    token: str(v.token),
  };
}

const setting = createCachedPlatformSetting<StoredGitBackend>(MANAGED_GIT_BACKEND_KEY, parse);

export const GIT_BACKEND_ENV_VARS = {
  owner: 'MANAGED_GIT_GITHUB_OWNER',
  token: 'MANAGED_GIT_GITHUB_TOKEN',
  installationId: 'MANAGED_GIT_GITHUB_INSTALL_ID',
} as const;

function env(name: string): string | null {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

let lastRefusal = '';
let ambiguityLogged = false;

/** Log a refusal once per distinct reason, so a standing misconfiguration
 *  states itself on arrival instead of becoming wallpaper. */
function refuse(reason: string): null {
  if (lastRefusal !== reason) {
    lastRefusal = reason;
    console.warn(`[managed-git-backend] refusing a partial configuration: ${reason}`);
  }
  return null;
}

/**
 * The whole backend, from ONE source.
 *
 * Env owns it whenever ANY of its three variables is set. A complete env pair
 * resolves; an incomplete env set resolves to null and is never completed from
 * the database. Only when env is entirely silent does a complete stored row
 * resolve.
 */
export function resolveGitBackend(): GitBackend | null {
  const envOwner = env(GIT_BACKEND_ENV_VARS.owner);
  const envToken = env(GIT_BACKEND_ENV_VARS.token);
  const envInstallationId = env(GIT_BACKEND_ENV_VARS.installationId);

  if (envOwner || envToken || envInstallationId) {
    if (envOwner && envToken) {
      lastRefusal = '';
      // A token beside an installation id is two backends. The token wins, as it
      // always has, so nothing changes under a running deployment — but it must
      // not win SILENTLY: production ran that way with a token that could not
      // create a repository while the App that could was never consulted. To
      // select the App, set the token to an empty value; keep the key present.
      if (envInstallationId && !ambiguityLogged) {
        ambiguityLogged = true;
        console.error(
          `[managed-git-backend] ${GIT_BACKEND_ENV_VARS.token} and ${GIT_BACKEND_ENV_VARS.installationId} ` +
            `are both set: the token is used and the App installation ${envInstallationId} is ignored. ` +
            `Set ${GIT_BACKEND_ENV_VARS.token} to an empty value to use the App.`,
        );
      }
      return { source: 'env', kind: 'pat', owner: envOwner, token: envToken };
    }
    if (envOwner && envInstallationId) {
      lastRefusal = '';
      return {
        source: 'env',
        kind: 'app',
        owner: envOwner,
        ownerType: null,
        installationId: envInstallationId,
      };
    }
    return refuse(
      `${GIT_BACKEND_ENV_VARS.owner}=${envOwner ? 'set' : 'unset'} needs ` +
        `${GIT_BACKEND_ENV_VARS.token} or ${GIT_BACKEND_ENV_VARS.installationId}; ` +
        'a stored owner is never paired with an env token',
    );
  }

  const stored = setting.read();
  if (!stored.kind && !stored.owner && !stored.token && !stored.installationId) return null;

  if (stored.kind === 'pat' && stored.owner && stored.token) {
    lastRefusal = '';
    return { source: 'db', kind: 'pat', owner: stored.owner, token: stored.token };
  }
  if (stored.kind === 'app' && stored.owner && stored.installationId) {
    lastRefusal = '';
    return {
      source: 'db',
      kind: 'app',
      owner: stored.owner,
      ownerType: stored.ownerType ?? null,
      installationId: stored.installationId,
    };
  }
  return refuse(
    `the stored ${MANAGED_GIT_BACKEND_KEY} row is incomplete for kind="${stored.kind ?? 'unset'}"`,
  );
}

/** The env variable names that own the backend, for the 409 message. */
export function gitBackendEnvOwners(): string[] {
  return Object.values(GIT_BACKEND_ENV_VARS).filter((name) => env(name) !== null);
}

export function refreshGitBackend(): Promise<void> {
  return setting.refresh();
}

export function invalidateGitBackend(): void {
  setting.invalidate();
}

/** Overwrite the stored backend whole. */
export async function writeGitBackend(backend: StoredGitBackend): Promise<void> {
  await setting.write(backend);
}

export async function clearGitBackend(): Promise<void> {
  await setting.clear();
}

/** Test-only: seed the cache without a database. */
export function __setStoredGitBackendForTests(value: unknown): void {
  setting.__setForTests(value);
}

/** Test-only: forget the last logged refusal. */
export function __resetGitBackendRefusalLogForTests(): void {
  lastRefusal = '';
  ambiguityLogged = false;
}
