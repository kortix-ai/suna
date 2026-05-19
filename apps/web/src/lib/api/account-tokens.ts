import { backendApi } from '../api-client';

export interface AccountToken {
  token_id: string;
  name: string;
  public_key: string;
  status: 'active' | 'revoked' | 'expired';
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

export interface CreatedAccountToken extends Omit<AccountToken, 'last_used_at' | 'revoked_at'> {
  /** Plaintext token — only returned at creation time. */
  secret_key: string;
}

export const accountTokensApi = {
  async list(): Promise<AccountToken[]> {
    const res = await backendApi.get<AccountToken[]>('/accounts/tokens');
    if (!res.success || !res.data) throw new Error(res.error?.message ?? 'Failed to load tokens');
    return res.data;
  },

  async create(input: { name: string; expires_at?: string }): Promise<CreatedAccountToken> {
    const res = await backendApi.post<CreatedAccountToken>('/accounts/tokens', input);
    if (!res.success || !res.data) throw new Error(res.error?.message ?? 'Failed to create token');
    return res.data;
  },

  async revoke(tokenId: string): Promise<void> {
    const res = await backendApi.delete<{ ok: true }>(`/accounts/tokens/${tokenId}`);
    if (!res.success) throw new Error(res.error?.message ?? 'Failed to revoke token');
  },
};
