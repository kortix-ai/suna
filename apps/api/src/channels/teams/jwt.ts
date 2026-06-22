import { createRemoteJWKSet, jwtVerify } from 'jose';
import { config } from '../../config';

const BOT_FRAMEWORK_ISSUERS = [
  'https://api.botframework.com',
  'https://api.botframework.us',
];

let jwksCache: ReturnType<typeof createRemoteJWKSet> | null = null;

async function resolveJwks(): Promise<ReturnType<typeof createRemoteJWKSet>> {
  if (jwksCache) return jwksCache;
  const res = await fetch(config.MICROSOFT_BOT_OPENID_METADATA);
  if (!res.ok) throw new Error(`bot openid metadata fetch failed (${res.status})`);
  const meta = (await res.json()) as { jwks_uri?: string };
  if (!meta.jwks_uri) throw new Error('bot openid metadata missing jwks_uri');
  jwksCache = createRemoteJWKSet(new URL(meta.jwks_uri));
  return jwksCache;
}

export async function validateInboundActivityJwt(
  authHeader: string | undefined,
  serviceUrl?: string,
): Promise<boolean> {
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token || !config.MICROSOFT_APP_ID) return false;
  try {
    const jwks = await resolveJwks();
    const { payload } = await jwtVerify(token, jwks, {
      issuer: BOT_FRAMEWORK_ISSUERS,
      audience: config.MICROSOFT_APP_ID,
    });
    const claimedServiceUrl = typeof payload.serviceurl === 'string' ? payload.serviceurl : null;
    if (serviceUrl && claimedServiceUrl && claimedServiceUrl.replace(/\/+$/, '') !== serviceUrl.replace(/\/+$/, '')) {
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[teams-jwt] inbound activity token rejected', (err as Error)?.message);
    return false;
  }
}

export function resetTeamsJwksCacheForTest(): void {
  jwksCache = null;
}
