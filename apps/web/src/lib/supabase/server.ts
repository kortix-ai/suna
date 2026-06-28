'use server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { KORTIX_SUPABASE_AUTH_COOKIE } from './constants'

export async function createClient() {
  const cookieStore = await cookies()

  // IMPORTANT: NEXT_PUBLIC_ vars are inlined at build time by Next.js, so in
  // Docker containers they contain placeholder values from the build host.
  // We MUST use non-NEXT_PUBLIC_ runtime env vars (SUPABASE_URL, SUPABASE_ANON_KEY)
  // which are read at runtime from process.env, falling back to NEXT_PUBLIC_ only
  // for dev mode where they match the actual Supabase instance.
  //
  // SUPABASE_SERVER_URL is the internal Docker network URL (e.g. http://supabase-kong:8000)
  // used for server-side calls that run inside the Docker container.
  const supabaseUrl =
    process.env.SUPABASE_SERVER_URL ||
    process.env.SUPABASE_URL ||
    process.env.KORTIX_PUBLIC_SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const supabaseAnonKey =
    process.env.SUPABASE_ANON_KEY ||
    process.env.KORTIX_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

  return createServerClient(
    supabaseUrl,
    supabaseAnonKey,
    {
      cookieOptions: {
        name: KORTIX_SUPABASE_AUTH_COOKIE,
        path: '/',
        sameSite: 'lax',
      },
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {
            // The `setAll` method was called from a Server Component.
            // This can be ignored if you have middleware refreshing
            // user sessions.
          }
        },
      },
    }
  )
}
