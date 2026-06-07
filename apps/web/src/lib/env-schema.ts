import { z } from 'zod'

/**
 * BACKEND_URL may be EITHER:
 *  - an absolute http(s) URL (e.g. "http://localhost:8008/v1") — used server-side
 *    where `new URL(...)` needs an absolute base, and in normal deployments; or
 *  - a root-relative path (e.g. "/v1") — used in the sandbox preview so the
 *    BROWSER hits the SAME origin it's served from and the preview proxy rewrites
 *    it to the in-sandbox API (single-origin proxy, no CORS, no exposed port).
 * Server-side callers that build a URL must resolve the absolute
 * `process.env.BACKEND_URL` rather than this (possibly relative) public value.
 */
const backendUrlSchema = z
  .string()
  .refine(
    (value) => {
      if (value.startsWith('/')) return true // root-relative (same-origin proxy)
      try {
        const parsed = new URL(value)
        return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      } catch {
        return false
      }
    },
    'BACKEND_URL must be an absolute http(s) URL or a root-relative path (e.g. "/v1")',
  )

/**
 * SUPABASE_URL may be EITHER:
 *  - an absolute http(s) URL (e.g. "http://127.0.0.1:54321") — used server-side
 *    where the runtime reaches Supabase directly, and in normal deployments; or
 *  - a root-relative path (e.g. "/supabase") — used in the sandbox preview so the
 *    BROWSER hits the SAME origin it's served from and the preview proxy rewrites
 *    it to the in-sandbox Supabase (single-origin proxy, no CORS, no exposed
 *    port). The browser client resolves the relative value against
 *    `window.location.origin` before handing it to supabase-js (which requires an
 *    absolute URL). Mirrors BACKEND_URL above.
 */
const supabaseUrlSchema = z
  .string()
  .refine(
    (value) => {
      if (value.startsWith('/')) return true // root-relative (same-origin proxy)
      try {
        const parsed = new URL(value)
        return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      } catch {
        return false
      }
    },
    'SUPABASE_URL must be an absolute http(s) URL or a root-relative path (e.g. "/supabase")',
  )

const RuntimeEnvSchema = z.object({
  SUPABASE_URL: supabaseUrlSchema,
  SUPABASE_ANON_KEY: z.string().min(1, 'SUPABASE_ANON_KEY is required'),
  BACKEND_URL: backendUrlSchema,
  /** Whether billing/paywall UI is enabled. Mirrors the backend's
   *  KORTIX_BILLING_INTERNAL_ENABLED. Set via NEXT_PUBLIC_BILLING_ENABLED. */
  BILLING_ENABLED: z.boolean().default(false),
  APP_URL: z.string().url('APP_URL must be a valid URL').default('http://localhost:3000'),
  /** Default sandbox container name — used as fallback before the store hydrates */
  SANDBOX_ID: z.string().optional().default('kortix-sandbox'),
  /** Comma-separated list of social auth providers to surface on the auth page (e.g. "google"). Empty = none. */
  AUTH_PROVIDERS: z.string().optional().default(''),
  /** Comma-separated list of email auth methods to surface on the auth page (e.g. "magic,password"). */
  AUTH_METHODS: z.string().optional().default('magic,password'),
  /** Unified platform version (root VERSION file) — surfaced for the UI footer / about. */
  VERSION: z.string().optional().default('dev'),
})

export type RuntimeEnv = z.infer<typeof RuntimeEnvSchema>

export function parseRuntimeEnv(raw: Partial<RuntimeEnv>): RuntimeEnv {
  return RuntimeEnvSchema.parse({ ...raw })
}
