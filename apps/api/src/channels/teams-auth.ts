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

interface MintOpts {
  scope: string;
  tenantId?: string;
}

export async function mintTeamsToken({ scope, tenantId }: MintOpts): Promise<string> {
  if (!teamsConfigured()) {
    throw new Error('Microsoft Teams is not configured (MICROSOFT_APP_ID / MICROSOFT_APP_PASSWORD)');
  }
  const tenant = tenantId || config.MICROSOFT_APP_TENANT;
  const cacheKey = `${tenant}|${scope}`;

  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: config.MICROSOFT_APP_ID,
    client_secret: config.MICROSOFT_APP_PASSWORD,
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

export function botConnectorToken(): Promise<string> {
  return mintTeamsToken({ scope: BOT_CONNECTOR_SCOPE });
}

export function graphToken(tenantId: string): Promise<string> {
  return mintTeamsToken({ scope: GRAPH_SCOPE, tenantId });
}

export function clearTeamsTokenCache(): void {
  tokenCache.clear();
}
