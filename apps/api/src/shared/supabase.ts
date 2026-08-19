import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config';
import { rewriteStorageOrigin } from './storage-url';

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
 * Rewrite a Supabase Storage signed/public URL so an EXTERNAL consumer (a
 * browser, the App CLI/uploader, or a cloud sandbox fetching an attachment or
 * image) can reach it.
 *
 * On a self-host box `SUPABASE_URL` is the INTERNAL Docker hostname
 * (`http://supabase-kong:8000`) so server->Supabase calls stay on the fast
 * internal network. But supabase-js bakes that same base URL into every signed
 * URL it returns — and no external client (nor a remote E2B sandbox) can
 * resolve `supabase-kong`, so uploads and attachment/image fetches silently
 * fail. `SUPABASE_PUBLIC_URL` is the box's public origin
 * (e.g. `https://essentia.kortix.cloud`, which Caddy proxies `/storage/v1*` ->
 * Kong), so we swap the internal base for the public one on the way out.
 *
 * No-op (returns the URL unchanged) when `SUPABASE_PUBLIC_URL` is unset or equal
 * to `SUPABASE_URL` — i.e. on managed cloud, where `SUPABASE_URL` is already
 * public — so this only ever rewrites on a split internal/public self-host.
 */
export function toPublicStorageUrl(url: string): string {
  return rewriteStorageOrigin(url, config.SUPABASE_URL, config.SUPABASE_PUBLIC_URL);
}
