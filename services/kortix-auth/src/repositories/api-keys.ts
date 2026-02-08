import { getSupabase } from '../lib/supabase';
import { generateKeyPair, hashSecretKey } from '../lib/crypto';

export interface ApiKey {
  keyId: string;
  publicKey: string;
  accountId: string;
  title: string;
  description?: string;
  status: 'active' | 'revoked' | 'expired';
  expiresAt?: string;
  lastUsedAt?: string;
  createdAt: string;
}

export interface CreateApiKeyResult {
  keyId: string;
  publicKey: string;
  secretKey: string; // Only returned on creation
  title: string;
  createdAt: string;
}

/**
 * Create a new API key for an account.
 */
export async function createApiKey(
  accountId: string,
  title: string,
  description?: string,
  expiresInDays?: number
): Promise<CreateApiKeyResult> {
  const supabase = getSupabase();

  // Generate key pair
  const { publicKey, secretKey } = generateKeyPair();
  const secretKeyHash = hashSecretKey(secretKey);

  // Calculate expiration
  let expiresAt: string | null = null;
  if (expiresInDays && expiresInDays > 0) {
    const expDate = new Date();
    expDate.setDate(expDate.getDate() + expiresInDays);
    expiresAt = expDate.toISOString();
  }

  const { data, error } = await supabase
    .from('api_keys')
    .insert({
      public_key: publicKey,
      secret_key_hash: secretKeyHash,
      account_id: accountId,
      title,
      description,
      status: 'active',
      expires_at: expiresAt,
    })
    .select('key_id, public_key, title, created_at')
    .single();

  if (error || !data) {
    throw new Error(error?.message || 'Failed to create API key');
  }

  return {
    keyId: data.key_id,
    publicKey: data.public_key,
    secretKey, // Only returned once!
    title: data.title,
    createdAt: data.created_at,
  };
}

/**
 * List all API keys for an account.
 */
export async function listApiKeys(accountId: string): Promise<ApiKey[]> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('api_keys')
    .select('key_id, public_key, account_id, title, description, status, expires_at, last_used_at, created_at')
    .eq('account_id', accountId)
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(error.message);
  }

  return (data || []).map((row) => ({
    keyId: row.key_id,
    publicKey: row.public_key,
    accountId: row.account_id,
    title: row.title,
    description: row.description,
    status: row.status,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
  }));
}

/**
 * Revoke an API key.
 */
export async function revokeApiKey(accountId: string, keyId: string): Promise<boolean> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('api_keys')
    .update({ status: 'revoked' })
    .eq('key_id', keyId)
    .eq('account_id', accountId)
    .select('key_id')
    .single();

  if (error || !data) {
    return false;
  }

  return true;
}

/**
 * Delete an API key permanently.
 */
export async function deleteApiKey(accountId: string, keyId: string): Promise<boolean> {
  const supabase = getSupabase();

  const { error } = await supabase
    .from('api_keys')
    .delete()
    .eq('key_id', keyId)
    .eq('account_id', accountId);

  if (error) {
    return false;
  }

  return true;
}
