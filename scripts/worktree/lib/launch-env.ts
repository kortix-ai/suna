import { type Ports } from './ports';
import type { SlotCreds } from './supabase';

export interface ApiLaunchOpts {
  /** Public origin cloud sandboxes call back to (the cloudflared tunnel URL). */
  kortixUrl?: string;
  /** `whsec_…` from `stripe listen`. When set, billing is turned ON for this
   *  worktree (STRIPE_SECRET_KEY must come from the decrypted local .env). */
  stripeWebhookSecret?: string;
}

export function apiLaunchEnv(ports: Ports, c: SlotCreds, opts: ApiLaunchOpts = {}): Record<string, string> {
  const billing = !!opts.stripeWebhookSecret;
  return {
    ENV_MODE: 'local', KORTIX_LOCAL_DEV: '1',
    PORT: String(ports.api),
    KORTIX_URL: opts.kortixUrl || `http://localhost:${ports.api}`,
    NEXT_PUBLIC_BACKEND_URL: `http://localhost:${ports.api}/v1`,
    KORTIX_PUBLIC_BACKEND_URL: `http://localhost:${ports.api}/v1`,
    BACKEND_URL: `http://localhost:${ports.api}/v1`,
    ALLOWED_SANDBOX_PROVIDERS: 'daytona',
    KORTIX_SKIP_ENSURE_SCHEMA: '1',
    DATABASE_URL: c.dbUrl,
    SUPABASE_URL: c.supabaseUrl,
    ...(c.serviceRoleKey ? { SUPABASE_SERVICE_ROLE_KEY: c.serviceRoleKey } : {}),
    SCHEDULER_ENABLED: 'false',
    // Billing off by default; --stripe flips it on and injects the webhook
    // secret. STRIPE_SECRET_KEY (test mode) is inherited from the local .env.
    KORTIX_BILLING_INTERNAL_ENABLED: billing ? 'true' : 'false',
    ...(billing ? { STRIPE_WEBHOOK_SECRET: opts.stripeWebhookSecret! } : {}),
    CORS_ALLOWED_ORIGINS: `http://localhost:${ports.web}`,
    // Managed ("kortix/*") models are served by the API's own slim endpoint
    // (/v1/router/llm) — managed Claude → AWS Bedrock, the rest → OpenRouter.
    // Region always set; the API key passes through from the parent shell when
    // present (else it comes from the dotenvx-decrypted apps/api/.env).
    AWS_BEDROCK_REGION: process.env.AWS_BEDROCK_REGION || 'us-west-2',
    ...(process.env.AWS_BEDROCK_API_KEY ? { AWS_BEDROCK_API_KEY: process.env.AWS_BEDROCK_API_KEY } : {}),
  };
}

export function webLaunchEnv(ports: Ports, c: SlotCreds, opts: { billing?: boolean } = {}): Record<string, string> {
  return {
    WEB_PORT: String(ports.web),
    KORTIX_API_PROXY_TARGET: `http://localhost:${ports.api}`,
    NEXT_PUBLIC_BACKEND_URL: `http://localhost:${ports.api}/v1`,
    KORTIX_PUBLIC_BACKEND_URL: `http://localhost:${ports.api}/v1`,
    BACKEND_URL: `http://localhost:${ports.api}/v1`,
    NEXT_PUBLIC_SUPABASE_URL: c.supabaseUrl,
    ...(c.anonKey ? { NEXT_PUBLIC_SUPABASE_ANON_KEY: c.anonKey } : {}),
    NEXT_PUBLIC_APP_URL: `http://localhost:${ports.web}`,
    NEXT_PUBLIC_URL: `http://localhost:${ports.web}`,
    NEXT_PUBLIC_BILLING_ENABLED: opts.billing ? 'true' : 'false',
  };
}
