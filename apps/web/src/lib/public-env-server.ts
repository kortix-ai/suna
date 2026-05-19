import 'server-only'

import { parseRuntimeEnv, type RuntimeEnv } from '@/lib/env-schema'

export type PublicRuntimeEnv = RuntimeEnv

function read(name: string): string | undefined {
  return process.env[`KORTIX_PUBLIC_${name}`] ?? process.env[`NEXT_PUBLIC_${name}`]
}

export function getServerPublicEnv(): PublicRuntimeEnv {
  return parseRuntimeEnv({
    SUPABASE_URL: read('SUPABASE_URL') || process.env.SUPABASE_PUBLIC_URL || process.env.SUPABASE_URL,
    SUPABASE_ANON_KEY: read('SUPABASE_ANON_KEY') || process.env.SUPABASE_ANON_KEY,
    BACKEND_URL: read('BACKEND_URL') || process.env.BACKEND_URL,
    ENV_MODE: (read('ENV_MODE') || 'local') as 'local' | 'cloud',
    APP_URL: read('APP_URL') || process.env.NEXT_PUBLIC_URL || process.env.PUBLIC_URL,
    SANDBOX_ID: read('SANDBOX_ID') || undefined,
    AUTH_PROVIDERS: read('AUTH_PROVIDERS') || undefined,
  })
}
