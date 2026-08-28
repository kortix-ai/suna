// OAuth client registry for "Sign in with Kortix".
//
// A client is a third-party app that signs users in through /v1/oauth. It is
// owned by ONE account (self-serve: /accounts/{id}/iam/oauth-clients) and its
// secret is stored hashed with the same scrypt path as every other Kortix
// credential. The plaintext secret is returned exactly once — at create and at
// rotate. Legacy rows inserted by hand before registration existed carry
// account_id = NULL and are invisible to every account.

import { and, asc, eq } from 'drizzle-orm';
import { oauthClients } from '@kortix/db';
import { db } from '../shared/db';
import { hashSecretKey, randomAlphanumeric } from '../shared/crypto';
import { isOAuthScope, OAUTH_SCOPES } from '../oauth/access-token';

export const OAUTH_CLIENT_SECRET_PREFIX = 'kortix_ocs_';
export const OAUTH_CLIENT_TYPES = ['confidential', 'public'] as const;
export type OAuthClientType = (typeof OAUTH_CLIENT_TYPES)[number];

export type OAuthClient = {
  clientId: string;
  accountId: string | null;
  name: string;
  description: string | null;
  clientType: OAuthClientType;
  redirectUris: string[];
  scopes: string[];
  active: boolean;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export interface CreatedOAuthClient extends OAuthClient {
  /** Plaintext client secret — shown ONCE. `null` for a public client. */
  clientSecret: string | null;
}

export class OAuthClientInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OAuthClientInputError';
  }
}

function mapRow(r: typeof oauthClients.$inferSelect): OAuthClient {
  return {
    clientId: r.clientId,
    accountId: r.accountId ?? null,
    name: r.name,
    description: r.description ?? null,
    clientType: (r.clientType as OAuthClientType) ?? 'confidential',
    redirectUris: (r.redirectUris as string[] | null) ?? [],
    scopes: (r.scopes as string[] | null) ?? [],
    active: r.active,
    createdBy: r.createdBy ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/**
 * A redirect URI is compared byte-for-byte at /authorize and /token, so it is
 * stored exactly as given — after proving it is an absolute http(s) URL with
 * no fragment. http is allowed only on loopback (RFC 8252 §7.3) so a local dev
 * server can register `http://localhost:3200/…` while every deployed app
 * must use https.
 */
export function normalizeRedirectUris(input: unknown): string[] {
  if (!Array.isArray(input)) throw new OAuthClientInputError('redirect_uris must be an array of absolute URLs');
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string' || !raw.trim()) throw new OAuthClientInputError('redirect_uris entries must be non-empty strings');
    const value = raw.trim();
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new OAuthClientInputError(`redirect_uri is not an absolute URL: ${value}`);
    }
    if (url.hash) throw new OAuthClientInputError(`redirect_uri must not carry a fragment: ${value}`);
    const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname.endsWith('.localhost');
    if (url.protocol === 'http:' && !loopback) throw new OAuthClientInputError(`redirect_uri must use https (http is allowed on localhost only): ${value}`);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new OAuthClientInputError(`redirect_uri must be http(s): ${value}`);
    if (!out.includes(value)) out.push(value);
  }
  if (out.length === 0) throw new OAuthClientInputError('at least one redirect_uri is required');
  if (out.length > 20) throw new OAuthClientInputError('at most 20 redirect_uris');
  return out;
}

export function normalizeScopes(input: unknown): string[] {
  const list = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? input.split(/\s+/)
      : null;
  if (!list) throw new OAuthClientInputError(`scopes must be an array of ${OAUTH_SCOPES.join(' | ')}`);
  const out: string[] = [];
  for (const raw of list) {
    if (typeof raw !== 'string') throw new OAuthClientInputError('scopes entries must be strings');
    const value = raw.trim();
    if (!value) continue;
    if (!isOAuthScope(value)) throw new OAuthClientInputError(`unknown scope "${value}" (known: ${OAUTH_SCOPES.join(', ')})`);
    if (!out.includes(value)) out.push(value);
  }
  if (out.length === 0) throw new OAuthClientInputError('at least one scope is required');
  return out;
}

export function normalizeClientType(input: unknown): OAuthClientType {
  if (input === undefined || input === null || input === '') return 'confidential';
  if (input === 'confidential' || input === 'public') return input;
  throw new OAuthClientInputError('client_type must be "confidential" or "public"');
}

function generateClientSecret(): string {
  return `${OAUTH_CLIENT_SECRET_PREFIX}${randomAlphanumeric(48)}`;
}

export async function listOAuthClients(accountId: string): Promise<OAuthClient[]> {
  const rows = await db
    .select()
    .from(oauthClients)
    .where(eq(oauthClients.accountId, accountId))
    .orderBy(asc(oauthClients.createdAt));
  return rows.map(mapRow);
}

export async function getOAuthClient(accountId: string, clientId: string): Promise<OAuthClient | null> {
  const [row] = await db
    .select()
    .from(oauthClients)
    .where(and(eq(oauthClients.accountId, accountId), eq(oauthClients.clientId, clientId)))
    .limit(1);
  return row ? mapRow(row) : null;
}

export async function createOAuthClient(input: {
  accountId: string;
  createdBy: string;
  name: string;
  description?: string | null;
  clientType: OAuthClientType;
  redirectUris: string[];
  scopes: string[];
}): Promise<CreatedOAuthClient> {
  // A public client cannot keep a secret; it authenticates with PKCE alone.
  // A hash of a random value is stored anyway so the column contract holds and
  // a leaked-secret check can never match.
  const clientSecret = input.clientType === 'confidential' ? generateClientSecret() : null;
  const [row] = await db
    .insert(oauthClients)
    .values({
      accountId: input.accountId,
      createdBy: input.createdBy,
      name: input.name,
      description: input.description ?? null,
      clientType: input.clientType,
      redirectUris: input.redirectUris,
      scopes: input.scopes,
      clientSecretHash: hashSecretKey(clientSecret ?? generateClientSecret()),
      active: true,
    })
    .returning();
  return { ...mapRow(row), clientSecret };
}

export async function updateOAuthClient(
  accountId: string,
  clientId: string,
  patch: {
    name?: string;
    description?: string | null;
    redirectUris?: string[];
    scopes?: string[];
    active?: boolean;
  },
): Promise<OAuthClient | null> {
  const [row] = await db
    .update(oauthClients)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.redirectUris !== undefined ? { redirectUris: patch.redirectUris } : {}),
      ...(patch.scopes !== undefined ? { scopes: patch.scopes } : {}),
      ...(patch.active !== undefined ? { active: patch.active } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(oauthClients.accountId, accountId), eq(oauthClients.clientId, clientId)))
    .returning();
  return row ? mapRow(row) : null;
}

/** New secret for a confidential client. Every token minted before stays valid. */
export async function rotateOAuthClientSecret(
  accountId: string,
  clientId: string,
): Promise<CreatedOAuthClient | null> {
  const existing = await getOAuthClient(accountId, clientId);
  if (!existing) return null;
  if (existing.clientType !== 'confidential') {
    throw new OAuthClientInputError('a public client has no secret to rotate');
  }
  const clientSecret = generateClientSecret();
  const [row] = await db
    .update(oauthClients)
    .set({ clientSecretHash: hashSecretKey(clientSecret), updatedAt: new Date() })
    .where(and(eq(oauthClients.accountId, accountId), eq(oauthClients.clientId, clientId)))
    .returning();
  return row ? { ...mapRow(row), clientSecret } : null;
}

/** Deleting a client cascades its codes, tokens, pending requests and consents. */
export async function deleteOAuthClient(accountId: string, clientId: string): Promise<boolean> {
  const rows = await db
    .delete(oauthClients)
    .where(and(eq(oauthClients.accountId, accountId), eq(oauthClients.clientId, clientId)))
    .returning({ clientId: oauthClients.clientId });
  return rows.length > 0;
}
