/**
 * Setup routes — self-hosted instance management.
 *
 * Provides API endpoints for managing .env configuration and
 * system status after the initial wizard setup. Mounted at /v1/setup/*.
 *
 * Auth: All routes require Supabase JWT except /install-status (public).
 */

import { createRoute, z } from '@hono/zod-openapi';
import { makeOpenApiApp, json, errors, auth, ErrorSchema } from '../openapi';
import type { AppEnv } from '../types';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { execSync } from 'child_process';
import { config } from '../config';
import { supabaseAuth } from '../middleware/auth';
import { eq, sql } from 'drizzle-orm';
import { accounts } from '@kortix/db';
import { db, hasDatabase } from '../shared/db';
import { resolveAccountId } from '../shared/resolve-account';
import { getSupabase } from '../shared/supabase';
/** Shape mirrors the legacy LocalSandboxHealthCheck (now removed) so the
 *  frontend health UI keeps reading the same `{ok, error?}` per check. */
type HealthCheck = { ok: boolean; error?: string };

export const setupApp = makeOpenApiApp<AppEnv>();

// ─── Auth ───────────────────────────────────────────────────────────────────
// All setup routes require Supabase JWT auth EXCEPT /install-status which must
// remain public (the installer/login page calls it before any user exists).
setupApp.use('/*', async (c, next) => {
  // Allow public routes without auth
  if (
    c.req.path.endsWith('/install-status') ||
    c.req.path.endsWith('/sandbox-providers') ||
    c.req.path.endsWith('/bootstrap-owner')
  ) {
    return next();
  }
  // Everything else requires a valid Supabase JWT
  return supabaseAuth(c, next);
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function findRepoRoot(): string | null {
  // Walk up from likely working dirs looking for the actual Computer repo root.
  // Local dev runs from several different cwd values, and the old
  // docker-compose.local.yml sentinel no longer exists, which made the repo
  // fallback dead code and left onboarding state dependent on sandbox secrets.
  const candidates = [
    process.cwd(),
    resolve(process.cwd(), '..'),
    resolve(process.cwd(), '../..'),
    resolve(__dirname, '../../../..'),
  ];

  for (const dir of candidates) {
    const hasFrontend = existsSync(resolve(dir, 'apps/web'));
    const hasApi = existsSync(resolve(dir, 'apps/api'));
    const hasComposeScripts = existsSync(resolve(dir, 'scripts/compose/docker-compose.yml'));

    if ((hasFrontend && hasApi) || hasComposeScripts) {
      return dir;
    }
  }

  return null;
}

function getProjectRoot(): string {
  return findRepoRoot() ?? process.cwd();
}

function getMasterUrlCandidates(): string[] {
  const candidates: string[] = [];
  const explicit = process.env.KORTIX_MASTER_URL;
  if (explicit && explicit.trim()) candidates.push(explicit.trim());

  // Inside docker-compose network, the sandbox service is reachable by name.
  candidates.push('http://sandbox:8000');

  // When running the API on the host (dev), sandbox is exposed on this port.
  candidates.push(`http://localhost:${config.SANDBOX_PORT_BASE || 14000}`);

  // De-dupe
  return Array.from(new Set(candidates));
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 5000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchMasterJson<T>(path: string, init: RequestInit = {}, timeoutMs = 5000): Promise<T> {
  const candidates = getMasterUrlCandidates();
  let lastErr: unknown = null;

  // Inject INTERNAL_SERVICE_KEY for sandbox auth (VPS mode)
  const serviceKey = process.env.INTERNAL_SERVICE_KEY;
  if (serviceKey) {
    const existingHeaders = init.headers ? Object.fromEntries(new Headers(init.headers as HeadersInit).entries()) : {};
    init = { ...init, headers: { ...existingHeaders, 'Authorization': `Bearer ${serviceKey}` } };
  }

  for (const base of candidates) {
    const url = `${base}${path}`;
    try {
      const res = await fetchWithTimeout(url, init, timeoutMs);
      // 503 from /kortix/health means "starting" — still return the JSON body
      // so callers can inspect the status/opencode fields.
      if (!res.ok && res.status !== 503) {
        lastErr = new Error(`Master ${url} returned ${res.status}`);
        continue;
      }
      return (await res.json()) as T;
    } catch (e) {
      lastErr = e;
      continue;
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error('Failed to reach sandbox master');
}

// ─── Routes ─────────────────────────────────────────────────────────────────

/**
 * GET /v1/setup/install-status
 *
 * Public (no auth) — the installer/login page calls this before any user exists.
 * Returns whether the instance has been set up (i.e. an owner user exists).
 *
 * Response: { installed: boolean }
 *   installed=false → show "Create Owner Account" installer form
 *   installed=true  → show "Sign In" form
 */
setupApp.openapi(
  createRoute({
    method: 'get',
    path: '/install-status',
    tags: ['setup'],
    summary: 'Whether the instance has been set up (an owner user exists)',
    responses: {
      200: json(z.object({ installed: z.boolean().nullable() }), 'Install status'),
      503: json(z.object({ installed: z.null(), error: z.string() }), 'Database not configured'),
    },
  }),
  async (c: any) => {
  try {
    if (!hasDatabase) {
      console.warn('[setup] install-status: DATABASE_URL not configured — returning 503');
      return c.json({ installed: null, error: 'Database not configured' }, 503);
    }

    // Query auth.users directly via the existing postgres connection.
    // This is reliable regardless of Supabase version / service role key format.
    const result = await db.execute(
      sql`SELECT EXISTS(SELECT 1 FROM auth.users LIMIT 1) AS has_users`
    );
    const queryResult = result as { rows?: Array<{ has_users?: boolean | 't' | 'f' }> } | Array<{ has_users?: boolean | 't' | 'f' }>;
    const row = Array.isArray(queryResult) ? queryResult[0] : queryResult.rows?.[0];
    const hasUsers = row?.has_users === true || row?.has_users === 't';

    return c.json({ installed: hasUsers });
  } catch (err) {
    console.error('[setup] install-status error:', err);
    return c.json({ installed: null, error: 'Internal error' }, 503);
  }
  },
);

/**
 * GET /v1/setup/sandbox-providers
 *
 * Public (no auth) — the installer wizard calls this to know which sandbox
 * providers are enabled so it can branch the setup flow accordingly.
 *
 * Response: { providers: string[], default: string, capabilities: ... }
 *   e.g. { providers: ["daytona"], default: "daytona", capabilities: {...} }
 */
setupApp.openapi(
  createRoute({
    method: 'get',
    path: '/sandbox-providers',
    tags: ['setup'],
    summary: 'Enabled sandbox providers and their capabilities',
    responses: {
      200: json(
        z.object({
          providers: z.array(z.string()),
          default: z.string(),
          capabilities: z.record(z.string(), z.object({ async: z.boolean(), events: z.boolean(), polling: z.boolean() })),
        }),
        'Sandbox providers',
      ),
    },
  }),
  async (c: any) => {
  const available = config.ALLOWED_SANDBOX_PROVIDERS.filter((name) =>
    config.isProviderEnabled(name),
  );

  // Provider capabilities — tells the frontend how to handle provisioning UI
  const capabilities: Record<string, { async: boolean; events: boolean; polling: boolean }> = {
    daytona: { async: false, events: false, polling: false },
  };

  return c.json({
    providers: available,
    default: available.includes(config.getDefaultProvider()) ? config.getDefaultProvider() : (available[0] || 'daytona'),
    capabilities: Object.fromEntries(available.map((p) => [p, capabilities[p] || { async: false, events: false, polling: false }])),
  });
  },
);

setupApp.openapi(
  createRoute({
    method: 'post',
    path: '/bootstrap-owner',
    tags: ['setup'],
    summary: 'Create the initial owner account (only when none exists)',
    request: {
      body: { content: { 'application/json': { schema: z.object({ email: z.string().optional(), password: z.string().optional() }) } } },
    },
    responses: {
      200: json(z.object({ success: z.boolean(), created: z.boolean(), email: z.string() }), 'Owner created'),
      400: json(z.object({ success: z.boolean(), error: z.string() }), 'Bad request'),
      409: json(z.object({ success: z.boolean(), error: z.string() }), 'Owner already exists'),
      500: json(z.object({ success: z.boolean(), error: z.string() }), 'Server error'),
      503: json(z.object({ success: z.boolean(), error: z.string() }), 'Database not configured'),
    },
  }),
  async (c: any) => {
  if (!hasDatabase) {
    return c.json({ success: false, error: 'Database not configured' }, 503);
  }

  try {
    const body = await c.req.json();
    const email = body.email?.trim().toLowerCase() || '';
    const password = body.password || '';

    if (!email || !email.includes('@')) {
      return c.json({ success: false, error: 'Valid email is required' }, 400);
    }

    if (password.length < 6) {
      return c.json({ success: false, error: 'Password must be at least 6 characters' }, 400);
    }

    const supabase = getSupabase();
    const listed = await supabase.auth.admin.listUsers({ page: 1, perPage: 1 });
    if (listed.error) {
      return c.json({ success: false, error: listed.error.message || 'Could not inspect existing users' }, 500);
    }
    const firstUser = listed.data?.users?.[0];
    if (firstUser) {
      return c.json({ success: false, error: 'Owner already exists' }, 409);
    }

    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { is_owner: true },
    });

    if (error) {
      return c.json({ success: false, error: error.message || 'Could not create owner' }, 500);
    }

    const userId = data.user?.id;
    if (userId) {
      try {
        const accountId = await resolveAccountId(userId);
        await db
          .update(accounts)
          .set({ setupCompleteAt: null, setupWizardStep: 2, updatedAt: new Date() })
          .where(eq(accounts.accountId, accountId));
      } catch {
        // best effort
      }
    }

    return c.json({ success: true, created: true, email });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ success: false, error: message }, 500);
  }
  },
);

/**
 * GET /v1/setup/status
 * System status — Docker, .env files, services
 */
setupApp.openapi(
  createRoute({
    method: 'get',
    path: '/status',
    tags: ['setup'],
    summary: 'System status — Docker, .env files, services',
    ...auth,
    responses: {
      200: json(
        z.object({
          billingEnabled: z.boolean(),
          dockerRunning: z.boolean(),
          envExists: z.boolean(),
          sandboxEnvExists: z.boolean(),
          projectRoot: z.string(),
        }),
        'System status',
      ),
      ...errors(401),
    },
  }),
  async (c: any) => {
  const root = getProjectRoot();
  const envExists = existsSync(resolve(root, '.env'));

  let dockerRunning = false;
  try {
    execSync('docker info', { stdio: 'pipe', timeout: 10000 });
    dockerRunning = true;
  } catch {}

  return c.json({
    billingEnabled: config.KORTIX_BILLING_INTERNAL_ENABLED,
    dockerRunning,
    envExists,
    // The old sandbox-secrets file is gone.
    sandboxEnvExists: false,
    projectRoot: root,
  });
  },
);

/**
 * GET /v1/setup/health
 * Health check of all local services
 */
setupApp.openapi(
  createRoute({
    method: 'get',
    path: '/health',
    tags: ['setup'],
    summary: 'Health check of all local services',
    ...auth,
    responses: {
      200: json(
        z.record(z.string(), z.object({ ok: z.boolean(), error: z.string().optional() })),
        'Per-service health checks',
      ),
      ...errors(401),
    },
  }),
  async (c: any) => {
  const checks: Record<string, HealthCheck> = {};
  // The API itself answered — by definition this check passes.
  checks.api = { ok: true };
  // Daytona is the only provider — surface its config status so the
  // setup wizard / health page can tell the operator they need to set
  // DAYTONA_API_KEY. We don't ping Daytona here on purpose: that's a
  // latency-sensitive UI call and Daytona's auth-check endpoint is
  // their billing concern, not ours.
  checks.daytona = config.DAYTONA_API_KEY
    ? { ok: true }
    : { ok: false, error: 'DAYTONA_API_KEY not configured' };
  return c.json(checks);
  },
);



// ─── Setup Wizard Completion ────────────────────────────────────────────────
// Tracks whether the user has completed the setup wizard (provider + tool keys).
// Stored in the DB on accounts.setup_complete_at so it persists across
// browsers/tabs/devices and cannot be accidentally cleared by the sandbox agent.

/**
 * GET /v1/setup/setup-status
 * Returns { complete: boolean, completedAt: string | null }
 */
setupApp.openapi(
  createRoute({
    method: 'get',
    path: '/setup-status',
    tags: ['setup'],
    summary: 'Whether the setup wizard has been completed',
    ...auth,
    responses: {
      200: json(z.object({ complete: z.boolean(), completedAt: z.string().nullable() }), 'Setup completion status'),
      500: json(z.object({ complete: z.boolean(), completedAt: z.string().nullable(), error: z.string() }), 'Server error'),
      ...errors(401),
    },
  }),
  async (c: any) => {
  if (!hasDatabase) {
    return c.json({ complete: false, completedAt: null });
  }
  try {
    const userId = c.get('userId') as string;
    const accountId = await resolveAccountId(userId);
    const [account] = await db
      .select({ setupCompleteAt: accounts.setupCompleteAt })
      .from(accounts)
      .where(eq(accounts.accountId, accountId))
      .limit(1);
    const complete = !!account?.setupCompleteAt;
    return c.json({ complete, completedAt: account?.setupCompleteAt?.toISOString() ?? null });
  } catch (e) {
    console.error('[setup] setup-complete-status failed:', e);
    return c.json({ complete: false, completedAt: null, error: e instanceof Error ? e.message : String(e) }, 500);
  }
  },
);

/**
 * POST /v1/setup/setup-complete
 * Mark the setup wizard as complete.
 */
setupApp.openapi(
  createRoute({
    method: 'post',
    path: '/setup-complete',
    tags: ['setup'],
    summary: 'Mark the setup wizard as complete',
    ...auth,
    responses: {
      200: json(z.object({ ok: z.boolean() }), 'Marked complete'),
      500: json(z.object({ ok: z.boolean(), error: z.string() }), 'Server error'),
      ...errors(401),
    },
  }),
  async (c: any) => {
  if (!hasDatabase) {
    return c.json({ ok: false, error: 'Database not configured' }, 500);
  }
  try {
    const userId = c.get('userId') as string;
    const accountId = await resolveAccountId(userId);
    await db
      .update(accounts)
      .set({ setupCompleteAt: new Date(), setupWizardStep: 0, updatedAt: new Date() })
      .where(eq(accounts.accountId, accountId));
    return c.json({ ok: true });
  } catch (e) {
    console.error('[setup] setup-complete failed:', e);
    return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
  },
);

/**
 * GET /v1/setup/setup-wizard-step
 * Returns the current setup wizard step from the database.
 * { step: number } — 0 = not started / complete, 2 = provider setup, 3 = tool keys
 */
setupApp.openapi(
  createRoute({
    method: 'get',
    path: '/setup-wizard-step',
    tags: ['setup'],
    summary: 'Get the current setup wizard step',
    ...auth,
    responses: {
      200: json(z.object({ step: z.number() }), 'Current wizard step'),
      500: json(z.object({ step: z.number(), error: z.string() }), 'Server error'),
      ...errors(401),
    },
  }),
  async (c: any) => {
  if (!hasDatabase) {
    return c.json({ step: 0 });
  }
  try {
    const userId = c.get('userId') as string;
    const accountId = await resolveAccountId(userId);
    const [account] = await db
      .select({ setupWizardStep: accounts.setupWizardStep, setupCompleteAt: accounts.setupCompleteAt })
      .from(accounts)
      .where(eq(accounts.accountId, accountId))
      .limit(1);
    // If setup is already complete, step is 0 regardless of stored value
    if (account?.setupCompleteAt) {
      return c.json({ step: 0 });
    }
    return c.json({ step: account?.setupWizardStep ?? 0 });
  } catch (e) {
    console.error('[setup] setup-wizard-step (get) failed:', e);
    return c.json({ step: 0, error: e instanceof Error ? e.message : String(e) }, 500);
  }
  },
);

/**
 * POST /v1/setup/setup-wizard-step
 * Update the current setup wizard step in the database.
 * Body: { step: number }
 */
setupApp.openapi(
  createRoute({
    method: 'post',
    path: '/setup-wizard-step',
    tags: ['setup'],
    summary: 'Update the current setup wizard step',
    ...auth,
    request: {
      body: { content: { 'application/json': { schema: z.object({ step: z.number() }) } } },
    },
    responses: {
      200: json(z.object({ ok: z.boolean() }), 'Updated'),
      500: json(z.object({ ok: z.boolean(), error: z.string() }), 'Server error'),
      ...errors(401),
    },
  }),
  async (c: any) => {
  if (!hasDatabase) {
    return c.json({ ok: false, error: 'Database not configured' }, 500);
  }
  try {
    const userId = c.get('userId') as string;
    const accountId = await resolveAccountId(userId);
    const body = await c.req.json();
    const step = typeof body.step === 'number' ? body.step : 0;
    await db
      .update(accounts)
      .set({ setupWizardStep: step, updatedAt: new Date() })
      .where(eq(accounts.accountId, accountId));
    return c.json({ ok: true });
  } catch (e) {
    console.error('[setup] setup-wizard-step (set) failed:', e);
    return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
  },
);
