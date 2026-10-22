/**
 * The GitHub App USER access token: stored per (account, user), used only to
 * create a repository under a PERSONAL GitHub account.
 *
 * GitHub does not accept an App installation token on `POST /user/repos` — the
 * endpoint is absent from its "endpoints available for installation access
 * tokens" and present on the user-access-token list. An organization keeps
 * using the installation token, which is narrower and needs no human.
 *
 * The token is a credential:
 *  - encrypted at rest with the account-salted AES-256-GCM envelope, the same
 *    scheme as `project_git_credentials`;
 *  - never returned to a caller, logged, or put in an error;
 *  - deleted when the account's GitHub connection is removed.
 */

import { and, eq } from 'drizzle-orm';
import { accountGithubUserTokens } from '@kortix/db';

import { decryptAccountSecret, encryptAccountSecret } from '../../secrets/account-resource';
import { db } from '../../shared/db';

/** A token read back out of the store, already decrypted. */
export interface StoredGitHubUserToken {
  token: string;
  /** The GitHub login this token authorizes — GitHub's own `GET /user` answer. */
  githubLogin: string;
  /** Epoch ms, or null when the App does not expire user tokens. */
  expiresAt: number | null;
}

/**
 * One minute of skew. A token that expires inside the next minute is not
 * usable: creating the repository and committing the starter takes longer than
 * that, and a token that dies mid-create leaves a repository with no files.
 */
const EXPIRY_SKEW_MS = 60_000;

export function githubUserTokenIsUsable(token: StoredGitHubUserToken, nowMs: number): boolean {
  if (token.expiresAt === null) return true;
  return token.expiresAt - EXPIRY_SKEW_MS > nowMs;
}

export interface ResolveGitHubUserTokenInput {
  accountId: string;
  userId: string;
  /** The GitHub owner the repository would be created under. */
  ownerLogin: string;
}

export interface ResolveGitHubUserTokenDeps {
  load: (accountId: string, userId: string) => Promise<StoredGitHubUserToken | null>;
  now: () => number;
}

/**
 * The caller's usable token for this owner, or null — never a throw. Null means
 * "ask the user to authorize"; it must not be confused with a failure, because
 * the route answers the two differently.
 */
export async function resolveGitHubUserToken(
  input: ResolveGitHubUserTokenInput,
  deps: ResolveGitHubUserTokenDeps = { load: loadGitHubUserToken, now: Date.now },
): Promise<StoredGitHubUserToken | null> {
  let stored: StoredGitHubUserToken | null;
  try {
    stored = await deps.load(input.accountId, input.userId);
  } catch {
    // An unreadable row (a rotated API_KEY_SECRET, a truncated envelope) is a
    // token we do not have. The caller re-authorizes, which overwrites it.
    return null;
  }
  if (!stored) return null;
  if (!githubUserTokenIsUsable(stored, deps.now())) return null;
  if (stored.githubLogin.toLowerCase() !== input.ownerLogin.toLowerCase()) return null;
  return stored;
}

/** Read and decrypt one row. Throws if the envelope cannot be opened. */
export async function loadGitHubUserToken(
  accountId: string,
  userId: string,
): Promise<StoredGitHubUserToken | null> {
  const [row] = await db
    .select()
    .from(accountGithubUserTokens)
    .where(
      and(
        eq(accountGithubUserTokens.accountId, accountId),
        eq(accountGithubUserTokens.userId, userId),
      ),
    )
    .limit(1);
  if (!row) return null;
  return {
    token: decryptAccountSecret(accountId, row.valueEnc),
    githubLogin: row.githubLogin,
    expiresAt: row.expiresAt ? row.expiresAt.getTime() : null,
  };
}

export interface SaveGitHubUserTokenInput {
  accountId: string;
  userId: string;
  githubLogin: string;
  token: string;
  /** Present only when the App is configured to expire user tokens. */
  refreshToken?: string | null;
  expiresAt?: Date | null;
}

/** Store (or replace) this user's token for this account. */
export async function saveGitHubUserToken(input: SaveGitHubUserTokenInput): Promise<void> {
  const now = new Date();
  await db
    .insert(accountGithubUserTokens)
    .values({
      accountId: input.accountId,
      userId: input.userId,
      githubLogin: input.githubLogin,
      valueEnc: encryptAccountSecret(input.accountId, input.token),
      refreshValueEnc: input.refreshToken
        ? encryptAccountSecret(input.accountId, input.refreshToken)
        : null,
      expiresAt: input.expiresAt ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [accountGithubUserTokens.accountId, accountGithubUserTokens.userId],
      set: {
        githubLogin: input.githubLogin,
        valueEnc: encryptAccountSecret(input.accountId, input.token),
        refreshValueEnc: input.refreshToken
          ? encryptAccountSecret(input.accountId, input.refreshToken)
          : null,
        expiresAt: input.expiresAt ?? null,
        updatedAt: now,
      },
    });
}

/** Forget every token this account holds — used when its GitHub connection goes. */
export async function deleteGitHubUserTokens(accountId: string, userId?: string): Promise<void> {
  await db
    .delete(accountGithubUserTokens)
    .where(
      userId
        ? and(
            eq(accountGithubUserTokens.accountId, accountId),
            eq(accountGithubUserTokens.userId, userId),
          )
        : eq(accountGithubUserTokens.accountId, accountId),
    );
}
