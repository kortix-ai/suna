import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config';

let client: SupabaseClient | null = null;

/**
 * Get singleton Supabase client with service role key.
 * Used for JWT auth verification (supabase.auth.getUser) and RPC calls
 * (atomic_use_credits, atomic_add_credits).
 */
export function getSupabase(): SupabaseClient {
  if (!client) {
    if (!config.SUPABASE_URL || !config.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    }

    client = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  return client;
}

/**
 * Check if Supabase is configured (needed for JWT auth).
 */
export function isSupabaseConfigured(): boolean {
  return !!(config.SUPABASE_URL && config.SUPABASE_SERVICE_ROLE_KEY);
}
