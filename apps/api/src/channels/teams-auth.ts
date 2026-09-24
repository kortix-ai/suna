import { config } from '../config';
import { resolveFeatureFlag } from '../feature-flags/registry';

export const BOT_CONNECTOR_SCOPE = 'https://api.botframework.com/.default';
export const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';

const EXPIRY_MARGIN_MS = 60_000;

interface CachedToken {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();

/**
 * Is the Teams channel offered for THIS project? One gate, one source: the
 * per-project `teams` feature flag. There is no operator env var — a
 * project turns Teams on in Settings → Feature flags, exactly like
 * `agentmail_email` and `voice`.
 */
export function teamsChannelEnabled(metadata: unknown): boolean {
  return resolveFeatureFlag(metadata, 'teams');
}

export function teamsConfigured(): boolean {
  return Boolean(config.MICROSOFT_APP_ID && config.MICROSOFT_APP_PASSWORD);
}

export interface TeamsBotCreds {
  appId: string;
  appPassword: string;
}

interface MintOpts {
  scope: string;
  tenantId?: string;
  creds?: TeamsBotCreds | null;
}

function resolveCreds(creds?: TeamsBotCreds | null): TeamsBotCreds {
  if (creds?.appId && creds.appPassword) return creds;
  if (!teamsConfigured()) {
    throw new Error('Microsoft Teams is not configured (MICROSOFT_APP_ID / MICROSOFT_APP_PASSWORD)');
  }
  return { appId: config.MICROSOFT_APP_ID, appPassword: config.MICROSOFT_APP_PASSWORD };
}

export async function mintTeamsToken({ scope, tenantId, creds }: MintOpts): Promise<string> {
  const resolved = resolveCreds(creds);
  const tenant = tenantId || config.MICROSOFT_APP_TENANT;
  const cacheKey = `${resolved.appId}|${tenant}|${scope}`;

  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: resolved.appId,
    client_secret: resolved.appPassword,
    scope,
  });

  const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Teams token request failed (${res.status}): ${text.slice(0, 300)}`);
  }

  let parsed: { access_token?: string; expires_in?: number };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Teams token response was not JSON');
  }
  if (!parsed.access_token) {
    throw new Error('Teams token response had no access_token');
  }

  const ttlMs = (parsed.expires_in ?? 3600) * 1000;
  tokenCache.set(cacheKey, {
    token: parsed.access_token,
    expiresAt: Date.now() + Math.max(0, ttlMs - EXPIRY_MARGIN_MS),
  });
  return parsed.access_token;
}

export function botConnectorToken(creds?: TeamsBotCreds | null): Promise<string> {
  return mintTeamsToken({ scope: BOT_CONNECTOR_SCOPE, creds });
}

export function graphToken(tenantId: string, creds?: TeamsBotCreds | null): Promise<string> {
  return mintTeamsToken({ scope: GRAPH_SCOPE, tenantId, creds });
}

/**
 * Prove that a bring-your-own bot's app registration exists in `tenant`.
 *
 * A tenant id or domain typed into the connect form proves nothing on its own:
 * both are public. Microsoft issues an app-only token for a tenant only when
 * the app has a service principal there (it was registered or consented in
 * that tenant), and the token's `tid` claim names the tenant as a GUID — so a
 * domain resolves to the id inbound activities carry.
 */
export async function proveTeamsTenant(input: {
  tenantId: string;
  creds: TeamsBotCreds;
}): Promise<{ ok: true; tenantId: string } | { ok: false; error: string }> {
  let token: string;
  try {
    token = await mintTeamsToken({ scope: GRAPH_SCOPE, tenantId: input.tenantId, creds: input.creds });
  } catch {
    return {
      ok: false,
      error:
        'Microsoft did not issue a token for this app in that tenant. Check the tenant id, the app id and the ' +
        'client secret, and that the app is registered in (or consented to by) the tenant.',
    };
  }
  const tid = tenantClaim(token);
  if (!tid) return { ok: false, error: 'Microsoft returned a token without a tenant id.' };
  return { ok: true, tenantId: tid };
}

function tenantClaim(jwt: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')) as { tid?: unknown };
    return typeof payload.tid === 'string' && payload.tid ? payload.tid : null;
  } catch {
    return null;
  }
}

export function clearTeamsTokenCache(): void {
  tokenCache.clear();
}

/**
 * Mint the shared bot-connector token ahead of the first inbound message.
 * The token is cached for its lifetime (minus a margin), so without this the
 * first message after a deploy — or after an hour of silence — paid the
 * login.microsoftonline.com round trip before "Working on it…" could be
 * posted. No-op when the managed bot is not configured; never throws.
 */
export async function prewarmTeamsBotToken(): Promise<boolean> {
  if (!teamsConfigured()) return false;
  try {
    await botConnectorToken();
    return true;
  } catch (err) {
    console.warn('[teams-auth] bot token prewarm failed', (err as Error)?.message);
    return false;
  }
}

/** Keep the bot-connector token warm for the life of the process. */
export const TEAMS_TOKEN_REFRESH_MS = 50 * 60 * 1000;

export function startTeamsBotTokenRefresh(): ReturnType<typeof setInterval> | null {
  if (!teamsConfigured()) return null;
  void prewarmTeamsBotToken();
  const timer = setInterval(() => {
    tokenCache.delete(`${config.MICROSOFT_APP_ID}|${config.MICROSOFT_APP_TENANT}|${BOT_CONNECTOR_SCOPE}`);
    void prewarmTeamsBotToken();
  }, TEAMS_TOKEN_REFRESH_MS);
  timer.unref();
  return timer;
}
