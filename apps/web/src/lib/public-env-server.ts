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
    BILLING_ENABLED: read('BILLING_ENABLED') === 'true',
    APP_URL: read('APP_URL') || process.env.NEXT_PUBLIC_URL || process.env.PUBLIC_URL,
    SANDBOX_ID: read('SANDBOX_ID') || undefined,
    AUTH_PROVIDERS: read('AUTH_PROVIDERS') || undefined,
    AUTH_METHODS: read('AUTH_METHODS') || undefined,
  })
}

/**
 * Build the inline runtime-config bootstrap script.
 *
 * The payload is JSON.stringify'd, then escaped so it is safe both when inlined
 * into a <script> tag (a value containing `</script>` can't break out) and when
 * served as a standalone JS file (the U+2028 / U+2029 line separators, which are
 * invalid in JS string literals on older engines, are neutralized). The escapes
 * only change character encoding — the JS parser decodes them back to the same
 * characters, so the resulting config object is identical to the unescaped form.
 */
export function serializeRuntimeConfigScript(): string {
  const LINE_SEPARATOR = String.fromCharCode(0x2028)
  const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029)
  const json = JSON.stringify(getServerPublicEnv())
    .replace(/[<>&]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
    .split(LINE_SEPARATOR)
    .join('\\u2028')
    .split(PARAGRAPH_SEPARATOR)
    .join('\\u2029')
  return `window.__KORTIX_RUNTIME_CONFIG=${json};window.__RUNTIME_ENV=window.__KORTIX_RUNTIME_CONFIG;`
}
