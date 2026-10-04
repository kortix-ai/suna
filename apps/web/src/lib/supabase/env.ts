/**
 * The Supabase URL and anon key for every server-side client
 * (`lib/supabase/server.ts`, `middleware.ts`).
 *
 * IMPORTANT: NEXT_PUBLIC_ vars are inlined at build time by Next.js, so in
 * Docker containers they contain placeholder values from the build host. We
 * MUST use runtime env vars (SUPABASE_URL, SUPABASE_ANON_KEY) which are read
 * at runtime from process.env, falling back to NEXT_PUBLIC_ only for dev mode
 * where they match the actual Supabase instance.
 *
 * SUPABASE_SERVER_URL is the internal Docker network URL (e.g.
 * http://supabase-kong:8000) used for server-side auth calls.
 * SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL is the public-facing URL that the
 * browser uses. Server-side code runs inside the Docker container, so it
 * needs the internal URL to reach Supabase.
 */
export function supabaseEnv(): { url: string; anonKey: string } {
  return {
    url:
      process.env.SUPABASE_SERVER_URL ||
      process.env.SUPABASE_URL ||
      process.env.KORTIX_PUBLIC_SUPABASE_URL ||
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
    anonKey:
      process.env.SUPABASE_ANON_KEY ||
      process.env.KORTIX_PUBLIC_SUPABASE_ANON_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  };
}
