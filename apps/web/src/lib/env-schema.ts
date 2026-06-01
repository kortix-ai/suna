import { z } from 'zod'

const RuntimeEnvSchema = z.object({
  SUPABASE_URL: z.string().url('SUPABASE_URL must be a valid URL'),
  SUPABASE_ANON_KEY: z.string().min(1, 'SUPABASE_ANON_KEY is required'),
  BACKEND_URL: z.string().url('BACKEND_URL must be a valid URL'),
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
