import { createBrowserClient } from '@supabase/ssr'
import { KORTIX_SUPABASE_AUTH_COOKIE } from './constants'
import { getEnv } from '@/lib/env-config'

/**
 * Resolve the browser-facing Supabase URL as an ABSOLUTE URL.
 *
 * `getEnv().SUPABASE_URL` may be root-relative (e.g. "/supabase") in the sandbox
 * preview, where the browser deliberately hits the same origin it was served
 * from and the preview proxy (next.config.ts: /supabase/* -> in-sandbox
 * Supabase) forwards the request. supabase-js requires an ABSOLUTE URL, so
 * resolve the relative value against the current origin. Mirrors
 * getAbsoluteBackendUrl() in opencode-sdk.ts.
 */
function resolveBrowserSupabaseUrl(url: string): string {
  if (url.startsWith('/') && typeof window !== 'undefined') {
    return new URL(url, window.location.origin).toString().replace(/\/$/, '')
  }
  return url
}

export function createClient() {
  const runtimeEnv = getEnv()
  const url = resolveBrowserSupabaseUrl(runtimeEnv.SUPABASE_URL)
  const key = runtimeEnv.SUPABASE_ANON_KEY

  if (!url || !key) {
    if (typeof window !== 'undefined') {
      throw new Error('Missing Supabase browser environment variables');
    }

    return createBrowserClient('https://placeholder.invalid', 'placeholder-anon-key', {
      cookieOptions: {
        name: KORTIX_SUPABASE_AUTH_COOKIE,
        path: '/',
        sameSite: 'lax',
      },
    })
  }

  return createBrowserClient(url, key, {
    cookieOptions: {
      name: KORTIX_SUPABASE_AUTH_COOKIE,
      path: '/',
      sameSite: 'lax',
    },
  })
}
