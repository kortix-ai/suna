import type { OAuth2ApplicationInput } from '@kortix/api-contract';
import {
  refreshOAuth2Token,
  type OAuth2LifecycleRuntime,
  type OAuth2TokenSet,
} from './oauth2-lifecycle';

export interface StoredDelegatedOAuth2Credential {
  kind: 'oauth2_delegated';
  version: 1;
  application: OAuth2ApplicationInput;
  token: OAuth2TokenSet;
}

export function createStoredDelegatedCredential(
  application: OAuth2ApplicationInput,
  token: OAuth2TokenSet,
): string {
  return JSON.stringify({
    kind: 'oauth2_delegated',
    version: 1,
    application,
    token,
  } satisfies StoredDelegatedOAuth2Credential);
}

export function parseDelegatedCredential(value: string): StoredDelegatedOAuth2Credential | null {
  try {
    const parsed = JSON.parse(value) as StoredDelegatedOAuth2Credential;
    if (
      parsed.kind !== 'oauth2_delegated' ||
      parsed.version !== 1 ||
      typeof parsed.application !== 'object' ||
      typeof parsed.token?.access_token !== 'string' ||
      typeof parsed.token?.expires_at !== 'number'
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function resolveStoredDelegatedCredential(
  value: string,
  runtime: OAuth2LifecycleRuntime = {},
): Promise<{ accessToken: string; updatedValue: string | null }> {
  const stored = parseDelegatedCredential(value);
  if (!stored) throw new Error('Invalid stored delegated OAuth2 credential');
  const now = runtime.now?.() ?? Date.now();
  if (stored.token.expires_at - now > 60_000) {
    return { accessToken: stored.token.access_token, updatedValue: null };
  }
  if (!stored.token.refresh_token) {
    throw new Error('Delegated OAuth2 credential requires reconnection');
  }
  const token = await refreshOAuth2Token(
    stored.application,
    stored.token.refresh_token,
    runtime,
  );
  return {
    accessToken: token.access_token,
    updatedValue: createStoredDelegatedCredential(stored.application, token),
  };
}
