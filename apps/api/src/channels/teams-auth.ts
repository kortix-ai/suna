import { config } from '../config';

export const BOT_CONNECTOR_SCOPE = 'https://api.botframework.com/.default';
export const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';

const EXPIRY_MARGIN_MS = 60_000;

interface CachedToken {
  token: string;
  expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();

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

export function clearTeamsTokenCache(): void {
  tokenCache.clear();
}
