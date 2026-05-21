import { getEnv } from '@/lib/env-config';

export interface SsoDomainPolicy {
  domain: string | null;
  sso_available: boolean;
  sso_required: boolean;
  provider_id: string | null;
  provider_name: string | null;
  protocol: 'saml' | 'oidc' | null;
  account_name: string | null;
}

export async function resolveSsoDomainPolicy(input: string): Promise<SsoDomainPolicy> {
  const query = input.includes('@') ? 'email' : 'domain';
  const url = new URL(`${getEnv().BACKEND_URL}/auth/sso/resolve-domain`);
  url.searchParams.set(query, input);

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error('Failed to resolve SSO domain');
  }
  return res.json();
}

export async function recordSsoLoginEvent(accessToken: string): Promise<void> {
  const res = await fetch(`${getEnv().BACKEND_URL}/auth/sso/login-event`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: '{}',
  });
  if (!res.ok) {
    throw new Error('Failed to record SSO login event');
  }
}
