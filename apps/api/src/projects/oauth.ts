/**
 * OAuth credential storage for opencode-style provider auth (ChatGPT
 * Pro/Plus headless + GitHub Copilot device-code).
 *
 * Tokens are stored encrypted per-project (same envelope as project secrets),
 * then injected into sandbox boot as `OPENCODE_AUTH_CONTENT` — opencode reads
 * that env var natively (see opencode/packages/opencode/src/auth/index.ts:57)
 * and skips its on-disk auth.json.
 *
 * Refresh-on-boot model: when a session sandbox launches, expiring access
 * tokens are refreshed in kortix-api against the upstream OAuth provider and
 * the new tokens persisted. Anything refreshed inside the sandbox itself
 * (e.g. mid-session) is lost when the sandbox dies — that's by design; the
 * refresh_token is long-lived so we just get a fresh access on the next boot.
 */

import { and, eq } from 'drizzle-orm';
import { projectOauthCredentials } from '@kortix/db';
import { db } from '../shared/db';
import { decryptProjectSecret, encryptProjectSecret } from './secrets';

/**
 * Provider IDs that map 1:1 to opencode's internal auth provider keys.
 * Keep this aligned with the `auth: { provider: ... }` field on each
 * opencode auth plugin.
 */
export const SUPPORTED_OAUTH_PROVIDERS = ['openai', 'github-copilot'] as const;
export type OauthProviderId = (typeof SUPPORTED_OAUTH_PROVIDERS)[number];

export function isSupportedOauthProvider(value: string): value is OauthProviderId {
  return (SUPPORTED_OAUTH_PROVIDERS as readonly string[]).includes(value);
}

/** Refresh access tokens this far before they actually expire. */
const REFRESH_LEAD_MS = 5 * 60 * 1000;

export interface OauthCredentialRecord {
  providerId: OauthProviderId;
  refresh: string;
  access: string;
  /** Unix ms; 0 means "never expires" (matches opencode's github-copilot shape). */
  expires: number;
  accountId: string | null;
  enterpriseUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface OauthCredentialSummary {
  provider_id: OauthProviderId;
  account_id: string | null;
  enterprise_url: string | null;
  expires: number;
  expires_in_ms: number | null;
  created_at: string;
  updated_at: string;
}

export function summarizeCredential(rec: OauthCredentialRecord): OauthCredentialSummary {
  const expiresIn = rec.expires === 0 ? null : rec.expires - Date.now();
  return {
    provider_id: rec.providerId,
    account_id: rec.accountId,
    enterprise_url: rec.enterpriseUrl,
    expires: rec.expires,
    expires_in_ms: expiresIn,
    created_at: rec.createdAt.toISOString(),
    updated_at: rec.updatedAt.toISOString(),
  };
}

export interface UpsertOauthCredentialInput {
  projectId: string;
  providerId: OauthProviderId;
  refresh: string;
  access: string;
  expires: number;
  accountId?: string | null;
  enterpriseUrl?: string | null;
  createdBy?: string | null;
}

export async function upsertOauthCredential(
  input: UpsertOauthCredentialInput,
): Promise<OauthCredentialRecord> {
  const now = new Date();
  const [row] = await db
    .insert(projectOauthCredentials)
    .values({
      projectId: input.projectId,
      providerId: input.providerId,
      refreshEnc: encryptProjectSecret(input.projectId, input.refresh),
      accessEnc: encryptProjectSecret(input.projectId, input.access),
      expires: input.expires,
      accountId: input.accountId ?? null,
      enterpriseUrl: input.enterpriseUrl ?? null,
      createdBy: input.createdBy ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [projectOauthCredentials.projectId, projectOauthCredentials.providerId],
      set: {
        refreshEnc: encryptProjectSecret(input.projectId, input.refresh),
        accessEnc: encryptProjectSecret(input.projectId, input.access),
        expires: input.expires,
        accountId: input.accountId ?? null,
        enterpriseUrl: input.enterpriseUrl ?? null,
        updatedAt: now,
      },
    })
    .returning();
  return toRecord(row);
}

export async function listOauthCredentials(projectId: string): Promise<OauthCredentialRecord[]> {
  const rows = await db
    .select()
    .from(projectOauthCredentials)
    .where(eq(projectOauthCredentials.projectId, projectId));
  return rows.map(toRecord);
}

export async function getOauthCredential(
  projectId: string,
  providerId: OauthProviderId,
): Promise<OauthCredentialRecord | null> {
  const [row] = await db
    .select()
    .from(projectOauthCredentials)
    .where(and(
      eq(projectOauthCredentials.projectId, projectId),
      eq(projectOauthCredentials.providerId, providerId),
    ))
    .limit(1);
  return row ? toRecord(row) : null;
}

export async function deleteOauthCredential(
  projectId: string,
  providerId: OauthProviderId,
): Promise<void> {
  await db
    .delete(projectOauthCredentials)
    .where(and(
      eq(projectOauthCredentials.projectId, projectId),
      eq(projectOauthCredentials.providerId, providerId),
    ));
}

function toRecord(row: typeof projectOauthCredentials.$inferSelect): OauthCredentialRecord {
  return {
    providerId: row.providerId as OauthProviderId,
    refresh: decryptProjectSecret(row.projectId, row.refreshEnc),
    access: decryptProjectSecret(row.projectId, row.accessEnc),
    expires: Number(row.expires),
    accountId: row.accountId,
    enterpriseUrl: row.enterpriseUrl,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Refresh the access token against the upstream provider if it's expiring
 * soon. Returns the (possibly updated) credential record. On refresh failure
 * we log + return the stale record — the sandbox will surface the actual
 * auth error to the user.
 *
 * github-copilot tokens store `expires: 0` (never expire from opencode's
 * POV) so they're returned as-is.
 */
export async function refreshIfExpiring(
  rec: OauthCredentialRecord,
  projectId: string,
): Promise<OauthCredentialRecord> {
  if (rec.providerId === 'github-copilot') return rec;
  if (rec.expires === 0) return rec;
  if (rec.expires > Date.now() + REFRESH_LEAD_MS) return rec;

  try {
    const refreshed = await refreshOpenAiToken(rec.refresh);
    return await upsertOauthCredential({
      projectId,
      providerId: rec.providerId,
      refresh: refreshed.refresh_token,
      access: refreshed.access_token,
      expires: Date.now() + (refreshed.expires_in ?? 3600) * 1000,
      accountId: rec.accountId,
      enterpriseUrl: rec.enterpriseUrl,
    });
  } catch (err) {
    console.warn('[oauth] failed to refresh access token', {
      providerId: rec.providerId,
      projectId,
      error: err instanceof Error ? err.message : String(err),
    });
    return rec;
  }
}

/**
 * Build the `OPENCODE_AUTH_CONTENT` env var value for a sandbox, refreshing
 * any expiring tokens as a side-effect. Returns `null` if the project has
 * no OAuth credentials — in which case the env var should be omitted.
 */
export async function buildOpencodeAuthContent(
  projectId: string,
): Promise<string | null> {
  const creds = await listOauthCredentials(projectId);
  if (creds.length === 0) return null;

  const refreshed = await Promise.all(creds.map((c) => refreshIfExpiring(c, projectId)));

  const payload: Record<string, unknown> = {};
  for (const rec of refreshed) {
    payload[rec.providerId] = toOpencodeAuthEntry(rec);
  }
  return JSON.stringify(payload);
}

/**
 * Shape matches opencode's auth/index.ts `Oauth` schema:
 * { type: 'oauth', refresh, access, expires, accountId?, enterpriseUrl? }
 *
 * Optional fields are only emitted when populated so the resulting JSON
 * round-trips cleanly through opencode's Effect Schema decoder (which
 * rejects unexpected nulls on optional fields).
 */
function toOpencodeAuthEntry(rec: OauthCredentialRecord): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    type: 'oauth',
    refresh: rec.refresh,
    access: rec.access,
    expires: rec.expires,
  };
  if (rec.accountId) entry.accountId = rec.accountId;
  if (rec.enterpriseUrl) entry.enterpriseUrl = rec.enterpriseUrl;
  return entry;
}

// ─── Refresh ─────────────────────────────────────────────────────────────────

const OPENAI_ISSUER = 'https://auth.openai.com';
const OPENAI_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

interface OpenAiTokenResponse {
  id_token?: string;
  access_token: string;
  refresh_token: string;
  expires_in?: number;
}

async function refreshOpenAiToken(refreshToken: string): Promise<OpenAiTokenResponse> {
  const response = await fetch(`${OPENAI_ISSUER}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: OPENAI_CLIENT_ID,
    }).toString(),
  });
  if (!response.ok) {
    throw new Error(`OpenAI token refresh failed: ${response.status}`);
  }
  return response.json() as Promise<OpenAiTokenResponse>;
}
