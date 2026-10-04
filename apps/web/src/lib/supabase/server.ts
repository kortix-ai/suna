'use server';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { KORTIX_SUPABASE_AUTH_COOKIE } from './constants';
import { supabaseEnv } from './env';

export async function createClient() {
  const cookieStore = await cookies();

  const { url: supabaseUrl, anonKey: supabaseAnonKey } = supabaseEnv();

  return createServerClient(supabaseUrl, supabaseAnonKey, {
    cookieOptions: {
      name: KORTIX_SUPABASE_AUTH_COOKIE,
      path: '/',
      sameSite: 'lax',
      // `@supabase/ssr` never sets this itself — see the doc comment in
      // `lib/supabase/client.ts`. Server-side, `NODE_ENV` is the reliable
      // signal (mirrors `MAINTENANCE_BYPASS_COOKIE`'s route handler).
      secure: process.env.NODE_ENV === 'production',
    },
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // The `setAll` method was called from a Server Component.
          // This can be ignored if you have middleware refreshing
          // user sessions.
        }
      },
    },
  });
}
