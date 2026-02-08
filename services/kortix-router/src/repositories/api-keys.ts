import { getSupabase, isSupabaseConfigured } from '../lib/supabase';
import { hashSecretKey, isApiKeySecretConfigured } from '../lib/crypto';

export interface ApiKeyValidationResult {
  isValid: boolean;
  accountId?: string;
  keyId?: string;
  error?: string;
}

// Throttle cache for last_used_at updates (15 min)
const THROTTLE_MS = 15 * 60 * 1000;
const lastUsedCache = new Map<string, number>();

/**
 * Validate a secret API key (sk_xxx format).
 * Returns the account_id if valid.
 */
export async function validateSecretKey(secretKey: string): Promise<ApiKeyValidationResult> {
  // Check configuration
  if (!isSupabaseConfigured()) {
    return { isValid: false, error: 'Supabase not configured' };
  }

  if (!isApiKeySecretConfigured()) {
    return { isValid: false, error: 'API_KEY_SECRET not configured' };
  }

  // Validate format: sk_ + 32 chars = 35 total
  if (!secretKey.startsWith('sk_') || secretKey.length !== 35) {
    return { isValid: false, error: 'Invalid API key format' };
  }

  try {
    // Hash the secret key
    const secretKeyHash = hashSecretKey(secretKey);

    // Query database - single query to validate and get account_id
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('api_keys')
      .select('key_id, account_id, status, expires_at')
      .eq('secret_key_hash', secretKeyHash)
      .eq('status', 'active')
      .single();

    if (error || !data) {
      return { isValid: false, error: 'API key not found or invalid' };
    }

    // Check expiration
    if (data.expires_at) {
      const expiresAt = new Date(data.expires_at);
      if (expiresAt < new Date()) {
        return { isValid: false, error: 'API key expired' };
      }
    }

    // Fire-and-forget: update last_used_at (throttled)
    updateLastUsedThrottled(data.key_id).catch(() => {});

    return {
      isValid: true,
      accountId: data.account_id,
      keyId: data.key_id,
    };
  } catch (err) {
    console.error('API key validation error:', err);
    return { isValid: false, error: 'Validation error' };
  }
}

/**
 * Update last_used_at with throttling (max once per 15 min per key).
 */
async function updateLastUsedThrottled(keyId: string): Promise<void> {
  const now = Date.now();
  const lastUpdate = lastUsedCache.get(keyId) || 0;

  if (now - lastUpdate < THROTTLE_MS) {
    return; // Throttled
  }

  lastUsedCache.set(keyId, now);

  // Clean up old entries (keep cache bounded)
  if (lastUsedCache.size > 1000) {
    const cutoff = now - THROTTLE_MS * 2;
    for (const [k, v] of lastUsedCache.entries()) {
      if (v < cutoff) {
        lastUsedCache.delete(k);
      }
    }
  }

  try {
    const supabase = getSupabase();
    await supabase
      .from('api_keys')
      .update({ last_used_at: new Date().toISOString() })
      .eq('key_id', keyId);
  } catch (err) {
    console.warn('Failed to update last_used_at:', err);
  }
}
