import { createBrowserClient } from '@supabase/ssr'

const SSR_FALLBACK_SUPABASE_URL = 'https://placeholder.supabase.co';
const SSR_FALLBACK_SUPABASE_ANON_KEY = 'placeholder-anon-key';

function resolveSupabasePublicConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (url && anonKey) {
    return { url, anonKey };
  }

  // Next.js prerendering can execute client components on the server.
  // Allow builds to complete without exposing preview secrets.
  if (typeof window === 'undefined') {
    return {
      url: url || SSR_FALLBACK_SUPABASE_URL,
      anonKey: anonKey || SSR_FALLBACK_SUPABASE_ANON_KEY,
    };
  }

  throw new Error(
    'Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY.'
  );
}

export function createClient() {
  const { url, anonKey } = resolveSupabasePublicConfig();
  return createBrowserClient(
    url,
    anonKey
  )
}
