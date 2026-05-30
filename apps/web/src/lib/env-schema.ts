import { z } from 'zod'

const RuntimeEnvSchema = z.object({
  SUPABASE_URL: z.string().url('SUPABASE_URL must be a valid URL'),
  SUPABASE_ANON_KEY: z.string().min(1, 'SUPABASE_ANON_KEY is required'),
  BACKEND_URL: z.string().url('BACKEND_URL must be a valid URL'),
  ENV_MODE: z.enum(['local', 'cloud']).default('local'),
  APP_URL: z.string().url('APP_URL must be a valid URL').default('http://localhost:3000'),
  /** Default sandbox container name — used as fallback before the store hydrates */
  SANDBOX_ID: z.string().optional().default('kortix-sandbox'),
  /** Comma-separated list of social auth providers to surface on the auth page (e.g. "google"). Empty = none. */
  AUTH_PROVIDERS: z.string().optional().default(''),
  /** Comma-separated list of email auth methods to surface on the auth page (e.g. "magic,password"). */
  AUTH_METHODS: z.string().optional().default('magic,password'),
})

export type RuntimeEnv = z.infer<typeof RuntimeEnvSchema>

export function parseRuntimeEnv(raw: Partial<RuntimeEnv>): RuntimeEnv {
  return RuntimeEnvSchema.parse({
    ENV_MODE: 'local',
    ...raw,
  })
}
