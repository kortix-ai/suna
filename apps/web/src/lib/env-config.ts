import { parseRuntimeEnv, type RuntimeEnv } from '@/lib/env-schema'

declare global {
  interface Window {
    __KORTIX_RUNTIME_CONFIG?: Partial<RuntimeEnv>
    __RUNTIME_ENV?: Partial<RuntimeEnv>
    __ENV_LOGGED__?: boolean
  }
}

function readRawEnv(): Partial<RuntimeEnv> {
  if (typeof window !== 'undefined') {
    if (window.__KORTIX_RUNTIME_CONFIG) {
      return window.__KORTIX_RUNTIME_CONFIG
    }
    if (window.__RUNTIME_ENV) {
      return window.__RUNTIME_ENV
    }
  }

  // SERVER branch (the browser returns from the window.__*_CONFIG block above):
  // prefer the ABSOLUTE `SUPABASE_URL` over the public values, which may be
  // root-relative (e.g. "/supabase") in the sandbox preview. Server-side the
  // runtime reaches Supabase directly and needs an absolute base; the relative
  // value is only correct for the BROWSER (same-origin proxy). Mirrors how the
  // server-side Supabase clients (supabase/server.ts, middleware.ts) prefer the
  // absolute process.env.SUPABASE_URL.
  return {
    SUPABASE_URL: process.env.SUPABASE_URL || process.env.SUPABASE_PUBLIC_URL || process.env.KORTIX_PUBLIC_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL,
    SUPABASE_ANON_KEY: process.env.KORTIX_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY,
    BACKEND_URL: process.env.KORTIX_PUBLIC_BACKEND_URL || process.env.NEXT_PUBLIC_BACKEND_URL || process.env.BACKEND_URL,
    WEBHOOK_BASE_URL: process.env.KORTIX_PUBLIC_WEBHOOK_BASE_URL || process.env.NEXT_PUBLIC_WEBHOOK_BASE_URL || process.env.KORTIX_URL,
    BILLING_ENABLED: (process.env.KORTIX_PUBLIC_BILLING_ENABLED || process.env.NEXT_PUBLIC_BILLING_ENABLED) === 'true',
    APP_URL: process.env.KORTIX_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_URL || process.env.PUBLIC_URL,
    AUTH_PROVIDERS: process.env.KORTIX_PUBLIC_AUTH_PROVIDERS || process.env.NEXT_PUBLIC_AUTH_PROVIDERS || undefined,
    AUTH_METHODS: process.env.KORTIX_PUBLIC_AUTH_METHODS || process.env.NEXT_PUBLIC_AUTH_METHODS || undefined,
  }
}

function logRuntimeEnv(env: RuntimeEnv) {
  if (typeof window === 'undefined' || window.__ENV_LOGGED__) return
  window.__ENV_LOGGED__ = true
  console.info('[runtime-env]', {
    source: window.__KORTIX_RUNTIME_CONFIG || window.__RUNTIME_ENV ? 'runtime-script' : 'fallback',
    supabaseUrl: env.SUPABASE_URL,
    backendUrl: env.BACKEND_URL,
    billingEnabled: env.BILLING_ENABLED,
    appUrl: env.APP_URL,
    anonKeyLength: env.SUPABASE_ANON_KEY.length,
  })
}

export function getEnv(): RuntimeEnv {
  const runtimeEnv = parseRuntimeEnv(readRawEnv())
  logRuntimeEnv(runtimeEnv)
  return runtimeEnv
}
