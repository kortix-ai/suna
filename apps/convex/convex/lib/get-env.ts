import { createEnv } from 'kitcn/server';
import * as z from 'zod';

/**
 * Convex-side environment. Set with `pnpm --filter kortix-convex exec kitcn env set KEY value`
 * (writes `convex/.env` locally and pushes to the deployment). Never commit secrets here;
 * `convex/.env` is gitignored.
 */
const envSchema = z.object({
  DEPLOY_ENV: z.string().default('local'),
  /** Public origin of the web app. Better Auth `baseURL` + trusted origin. */
  SITE_URL: z.string().default('http://localhost:3000'),
  /** Public origin of the Kortix API. Added to trusted origins for CLI/device flows. */
  KORTIX_API_URL: z.string().default('http://localhost:8008'),
  BETTER_AUTH_SECRET: z.string().optional(),
  JWKS: z.string().optional(),
  CONVEX_SITE_URL: z.string().optional(),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  TURNSTILE_SECRET_KEY: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
});

export const getEnv = createEnv({ schema: envSchema });
