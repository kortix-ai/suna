import { backendApi } from '../../http/api-client';
import { iamGet, iamUnwrap as unwrap } from './iam-shared';

// ─── SCIM tokens ──────────────────────────────────────────────────────────

export interface ScimToken {
  token_id: string;
  name: string;
  public_prefix: string;
  status: 'active' | 'expired' | 'revoked';
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

export interface CreatedScimToken
  extends Omit<ScimToken, 'last_used_at' | 'revoked_at' | 'status'> {
  /** Plaintext bearer — shown ONCE at creation. Never logged or returned again. */
  secret: string;
  /** Path the IdP should configure as its SCIM base URL. */
  scim_base_url: string;
}

export async function listScimTokens(accountId: string) {
  return unwrap(await iamGet<{ tokens: ScimToken[] }>(`/accounts/${accountId}/iam/scim/tokens`))
    .tokens;
}

export async function createScimToken(
  accountId: string,
  input: { name: string; expires_at?: string },
) {
  return unwrap(
    await backendApi.post<CreatedScimToken>(`/accounts/${accountId}/iam/scim/tokens`, input, {
      showErrors: false,
    }),
  );
}

export async function revokeScimToken(accountId: string, tokenId: string) {
  return unwrap(
    await backendApi.delete<{ revoked: boolean }>(
      `/accounts/${accountId}/iam/scim/tokens/${tokenId}`,
    ),
  );
}
