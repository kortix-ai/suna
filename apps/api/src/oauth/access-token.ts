/**
 * OAuth access tokens (`kortix_oat_…`) as a first-class API credential.
 *
 * "Sign in with Kortix" hands a third-party app a token minted by
 * `POST /v1/oauth/token`. Before this module that token opened exactly one
 * route (`/v1/oauth/userinfo`); every other middleware saw the `kortix_`
 * prefix, ran it through the API-key table and 401'd. Now both auth
 * middlewares resolve it here and the token acts as the user who granted it —
 * no agent grant, no project binding — provided the client was granted the
 * `kortix` scope. Without that scope the token stays an identity credential
 * and reaches only the two identity probes.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { oauthAccessTokens, oauthClients } from '@kortix/db';
import { db } from '../shared/db';
import { oauthTokenHashCandidates } from './token-hash';

export const OAUTH_ACCESS_TOKEN_PREFIX = 'kortix_oat_';
export const OAUTH_REFRESH_TOKEN_PREFIX = 'kortix_ort_';

/** Identity only: user id, primary account id, email. */
export const OAUTH_SCOPE_PROFILE = 'profile';
/** Email address (OIDC-shaped clients ask for it by this name; same data as `profile`). */
export const OAUTH_SCOPE_EMAIL = 'email';
/** Act as the user on the whole Kortix API. The scope that makes the token a credential. */
export const OAUTH_SCOPE_KORTIX = 'kortix';

export const OAUTH_SCOPES = [OAUTH_SCOPE_PROFILE, OAUTH_SCOPE_EMAIL, OAUTH_SCOPE_KORTIX] as const;
export type OAuthScope = (typeof OAUTH_SCOPES)[number];

export function isOAuthScope(value: string): value is OAuthScope {
  return (OAUTH_SCOPES as readonly string[]).includes(value);
}

export function isOAuthAccessToken(token: string): boolean {
  return token.startsWith(OAUTH_ACCESS_TOKEN_PREFIX);
}

export function isOAuthRefreshToken(token: string): boolean {
  return token.startsWith(OAUTH_REFRESH_TOKEN_PREFIX);
}

/** Routes an identity-only token (no `kortix` scope) may still reach. */
const IDENTITY_PROBE_PATHS = new Set(['/v1/accounts/me', '/v1/oauth/userinfo', '/v1/oauth/revoke']);

export function oauthScopeAllowsPath(scopes: readonly string[], path: string): boolean {
  if (scopes.includes(OAUTH_SCOPE_KORTIX)) return true;
  return IDENTITY_PROBE_PATHS.has(path.replace(/\/+$/, ''));
}

export interface OAuthAccessTokenValidation {
  isValid: boolean;
  tokenId?: string;
  userId?: string;
  accountId?: string;
  clientId?: string;
  scopes?: string[];
  error?: string;
}

export async function validateOAuthAccessToken(token: string): Promise<OAuthAccessTokenValidation> {
  if (!isOAuthAccessToken(token)) return { isValid: false, error: 'Invalid OAuth access token' };
  const [row] = await db
    .select({
      id: oauthAccessTokens.id,
      userId: oauthAccessTokens.userId,
      accountId: oauthAccessTokens.accountId,
      clientId: oauthAccessTokens.clientId,
      scopes: oauthAccessTokens.scopes,
      expiresAt: oauthAccessTokens.expiresAt,
      clientActive: oauthClients.active,
    })
    .from(oauthAccessTokens)
    .innerJoin(oauthClients, eq(oauthClients.clientId, oauthAccessTokens.clientId))
    .where(
      and(
        inArray(oauthAccessTokens.tokenHash, oauthTokenHashCandidates(token)),
        isNull(oauthAccessTokens.revokedAt),
      ),
    )
    .limit(1);
  if (!row) return { isValid: false, error: 'Invalid OAuth access token' };
  if (row.expiresAt < new Date()) return { isValid: false, error: 'OAuth access token expired' };
  if (!row.clientActive) return { isValid: false, error: 'OAuth client is inactive' };
  return {
    isValid: true,
    tokenId: row.id,
    userId: row.userId,
    accountId: row.accountId,
    clientId: row.clientId,
    scopes: (row.scopes as string[] | null) ?? [],
  };
}
