/**
 * The GitHub App IDENTITY of this deployment — appId, private key, OAuth
 * client, webhook secret, state secret, and a configured slug fallback.
 *
 * ONE source owns the whole identity. Either the deployment's env variables
 * own it, or the `github_app_identity` platform setting owns it. The two are
 * never mixed field by field.
 *
 * That mixing is what took production down on 2026-09-16: a stored row held a
 * new appId while the auth token stayed the env PAT, so every installation
 * 404ed. See `.claude/skills/learnings/SKILL.md`, "Never render an
 * instance-global config surface inside an account-scoped page".
 *
 * The identity is one of three separate concepts. The other two are the
 * instance git backend (`./managed-git-backend`, the owner plus credential
 * used for managed repositories) and an account connection
 * (`kortix.account_github_installations`, one account's own installations).
 */

import { createCachedPlatformSetting } from './platform-setting-cache';

export const GITHUB_APP_IDENTITY_KEY = 'github_app_identity';

export interface AppIdentity {
  /** Which source owns this identity, whole. */
  source: 'env' | 'db';
  appId: string;
  /** PEM. Real newlines or `\n`-escaped; both are normalized at signing time. */
  privateKey: string;
  /** The App's own OAuth client — the account-linking identity proof needs it. */
  clientId: string | null;
  clientSecret: string | null;
  webhookSecret: string | null;
  /** HMAC key for the install-state token. */
  stateSecret: string | null;
  /**
   * A slug an operator configured. It is a FALLBACK only: the live slug is
   * derived from `GET /app` with this identity's own JWT
   * (`resolveGitHubAppSlug` in projects/github.ts).
   */
  configuredSlug: string | null;
}

/** The stored shape. Every field is optional; only a complete row resolves. */
export interface StoredAppIdentity {
  appId?: string;
  privateKey?: string;
  clientId?: string;
  clientSecret?: string;
  webhookSecret?: string;
  stateSecret?: string;
  slug?: string;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parse(value: unknown): StoredAppIdentity {
  if (!value || typeof value !== 'object') return {};
  const v = value as Record<string, unknown>;
  return {
    appId: str(v.appId),
    privateKey: typeof v.privateKey === 'string' && v.privateKey.trim() ? v.privateKey : undefined,
    clientId: str(v.clientId),
    clientSecret: str(v.clientSecret),
    webhookSecret: str(v.webhookSecret),
    stateSecret: str(v.stateSecret),
    slug: str(v.slug),
  };
}

const setting = createCachedPlatformSetting<StoredAppIdentity>(GITHUB_APP_IDENTITY_KEY, parse);

function env(...names: string[]): string | null {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/** The env variable names that carry an App identity, in precedence order. */
export const APP_IDENTITY_ENV_VARS = {
  appId: ['KORTIX_GITHUB_APP_ID', 'GITHUB_APP_ID'],
  privateKey: ['KORTIX_GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_PRIVATE_KEY'],
  clientId: ['KORTIX_GITHUB_APP_CLIENT_ID', 'GITHUB_APP_CLIENT_ID'],
  clientSecret: ['KORTIX_GITHUB_APP_CLIENT_SECRET', 'GITHUB_APP_CLIENT_SECRET'],
  webhookSecret: ['KORTIX_GITHUB_APP_WEBHOOK_SECRET', 'GITHUB_APP_WEBHOOK_SECRET'],
  stateSecret: ['KORTIX_GITHUB_APP_STATE_SECRET'],
  slug: ['KORTIX_GITHUB_APP_SLUG', 'GITHUB_APP_SLUG'],
} as const;

/**
 * The whole identity, from ONE source.
 *
 * Env wins entirely when it carries BOTH an appId and a private key — the two
 * fields without which nothing can be signed. Otherwise a COMPLETE stored row
 * (the same two fields) is used entirely. Otherwise null.
 */
export function resolveAppIdentity(): AppIdentity | null {
  const envAppId = env(...APP_IDENTITY_ENV_VARS.appId);
  const envPrivateKey = env(...APP_IDENTITY_ENV_VARS.privateKey);
  if (envAppId && envPrivateKey) {
    return {
      source: 'env',
      appId: envAppId,
      privateKey: envPrivateKey,
      clientId: env(...APP_IDENTITY_ENV_VARS.clientId),
      clientSecret: env(...APP_IDENTITY_ENV_VARS.clientSecret),
      webhookSecret: env(...APP_IDENTITY_ENV_VARS.webhookSecret),
      stateSecret: env(...APP_IDENTITY_ENV_VARS.stateSecret),
      configuredSlug: env(...APP_IDENTITY_ENV_VARS.slug),
    };
  }

  const stored = setting.read();
  if (stored.appId && stored.privateKey) {
    return {
      source: 'db',
      appId: stored.appId,
      privateKey: stored.privateKey,
      clientId: stored.clientId ?? null,
      clientSecret: stored.clientSecret ?? null,
      webhookSecret: stored.webhookSecret ?? null,
      stateSecret: stored.stateSecret ?? null,
      configuredSlug: stored.slug ?? null,
    };
  }

  if (stored.appId || stored.privateKey) {
    console.warn(
      '[github-app-identity] ignoring an incomplete stored identity: a row needs BOTH appId and privateKey',
    );
  }
  return null;
}

/** The env variable names that own the identity, for the 409 message. */
export function appIdentityEnvOwners(): string[] {
  const owners: string[] = [];
  for (const names of [APP_IDENTITY_ENV_VARS.appId, APP_IDENTITY_ENV_VARS.privateKey]) {
    const name = names.find((candidate) => {
      const value = process.env[candidate];
      return typeof value === 'string' && value.trim().length > 0;
    });
    if (name) owners.push(name);
  }
  return owners;
}

/** The stored identity as-is. Only the setup routes need this. */
export function storedAppIdentity(): StoredAppIdentity {
  return setting.read();
}

export function refreshAppIdentity(): Promise<void> {
  return setting.refresh();
}

export function invalidateAppIdentity(): void {
  setting.invalidate();
}

/** Overwrite the stored identity whole. Partial writes are not a thing here. */
export async function writeAppIdentity(identity: StoredAppIdentity): Promise<void> {
  await setting.write(identity);
}

export async function clearAppIdentity(): Promise<void> {
  await setting.clear();
}

/** Test-only: seed the cache without a database. */
export function __setStoredAppIdentityForTests(value: unknown): void {
  setting.__setForTests(value);
}
