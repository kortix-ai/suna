/**
 * Setup routes — self-hosted instance management.
 *
 * Provides API endpoints for managing .env configuration and
 * system status after the initial wizard setup. Mounted at /v1/setup/*.
 *
 * Auth: All routes require Supabase JWT except /install-status (public).
 */

import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { execSync } from 'child_process';
import { config } from '../config';
import { ALL_SANDBOX_ENV_KEYS, buildProviderKeySchema } from '../providers/registry';
import { supabaseAuth } from '../middleware/auth';
import { eq, sql } from 'drizzle-orm';
import { accounts } from '@kortix/db';
import { db, hasDatabase } from '../shared/db';
import { resolveAccountId } from '../shared/resolve-account';
import { getSupabase } from '../shared/supabase';
import { checkLocalSandboxHealth, type LocalSandboxHealthCheck } from '../platform/services/local-sandbox-health';

export const setupApp = new Hono<AppEnv>();

// ─── Auth ───────────────────────────────────────────────────────────────────
// All setup routes require Supabase JWT auth EXCEPT /install-status which must
// remain public (the installer/login page calls it before any user exists).
setupApp.use('/*', async (c, next) => {
  // Allow public routes without auth
  if (
    c.req.path.endsWith('/install-status') ||
    c.req.path.endsWith('/sandbox-providers') ||
    c.req.path.endsWith('/bootstrap-owner') ||
    c.req.path.endsWith('/local-sandbox/warm') ||
    c.req.path.endsWith('/local-sandbox/warm/status')
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
    const hasSandboxCompose = existsSync(resolve(dir, 'core/docker/docker-compose.yml'));
    const hasComposeScripts = existsSync(resolve(dir, 'scripts/compose/docker-compose.yml'));

    if ((hasFrontend && hasApi) || hasSandboxCompose || hasComposeScripts) {
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

async function getSandboxEnv(): Promise<Record<string, string>> {
  try {
    return await fetchMasterJson<Record<string, string>>('/env');
  } catch {
    return {};
  }
}

async function setSandboxEnv(keys: Record<string, string>): Promise<void> {
  await fetchMasterJson('/env', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keys }),
  }, 15000);
}

async function getLocalSandboxWarmStatus() {
  const { getImagePullStatus, LocalDockerProvider } = await import('../platform/providers/local-docker');
  const provider = new LocalDockerProvider();
  const existing = await provider.find();
  const sandboxHealthUrl = config.SANDBOX_NETWORK
    ? `http://${config.SANDBOX_CONTAINER_NAME}:8000/kortix/health`
    : `http://localhost:${config.SANDBOX_PORT_BASE || 14000}/kortix/health`;

  if (existing && existing.status === 'running') {
    try {
      const health = await fetchWithTimeout(sandboxHealthUrl, {}, 3000);
      if (health.ok) {
        const payload = await health.json() as { status?: string; runtimeReady?: boolean };
        if (payload.status === 'ok' && payload.runtimeReady === true) {
          return { success: true, status: 'ready', data: existing };
        }
      }
    } catch {
      // still warming
    }

    return {
      success: true,
      status: 'creating',
      progress: 95,
      message: 'Sandbox container is running and finishing Kortix boot...',
    };
  }

  const pullStatus = getImagePullStatus();
  if (pullStatus.state === 'pulling') {
    return {
      success: true,
      status: 'pulling',
      progress: pullStatus.progress,
      message: pullStatus.message,
    };
  }

  if (pullStatus.state === 'error') {
    return {
      success: true,
      status: 'error',
      progress: pullStatus.progress,
      message: pullStatus.message,
      error: pullStatus.error,
    };
  }

  return { success: true, status: 'none', message: 'No local sandbox warmup in progress' };
}

function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const lines = readFileSync(path, 'utf-8').split('\n');
  const env: Record<string, string> = {};
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1);
    env[key] = val;
  }
  return env;
}

function maskKey(val: string): string {
  if (!val || val.length < 8) return val ? '****' : '';
  return val.slice(0, 4) + '...' + val.slice(-4);
}

function writeEnvFile(path: string, data: Record<string, string>): void {
  const existing = existsSync(path) ? readFileSync(path, 'utf-8') : '';
  const lines = existing.split('\n');
  const written = new Set<string>();
  const out: string[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) {
      out.push(raw);
      continue;
    }
    const idx = line.indexOf('=');
    if (idx === -1) { out.push(raw); continue; }
    const key = line.slice(0, idx).trim();
    if (key in data) {
      out.push(`${key}=${data[key]}`);
      written.add(key);
    } else {
      out.push(raw);
    }
  }

  for (const [key, val] of Object.entries(data)) {
    if (!written.has(key)) {
      out.push(`${key}=${val}`);
    }
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, out.join('\n') + '\n');
}

// Use the shared provider registry instead of local constants.

// Keys to check for onboarding status (not part of the UI schema)
const SYSTEM_KEYS = ['ONBOARDING_COMPLETE'];

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
setupApp.get('/install-status', async (c) => {
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
});

/**
 * GET /v1/setup/sandbox-providers
 *
 * Public (no auth) — the installer wizard calls this to know which sandbox
 * providers are enabled so it can branch the setup flow accordingly.
 *
 * Response: { providers: string[], default: string }
 *   e.g. { providers: ["local_docker"], default: "local_docker" }
 *   e.g. { providers: ["daytona", "local_docker"], default: "daytona" }
 */
setupApp.get('/sandbox-providers', async (c) => {
  const available: string[] = [];
  if (config.isLocalDockerEnabled()) available.push('local_docker');
  if (config.isDaytonaEnabled()) available.push('daytona');
  if (config.isJustAVPSEnabled()) available.push('justavps');

  // Provider capabilities — tells the frontend how to handle provisioning UI
  const capabilities: Record<string, { async: boolean; events: boolean; polling: boolean }> = {
    local_docker: { async: false, events: false, polling: true },
    daytona: { async: false, events: false, polling: false },
    justavps: { async: true, events: true, polling: false },
  };

  return c.json({
    providers: available,
    default: available.includes(config.getDefaultProvider()) ? config.getDefaultProvider() : (available[0] || 'local_docker'),
    capabilities: Object.fromEntries(available.map((p) => [p, capabilities[p] || { async: false, events: false, polling: false }])),
  });
});

setupApp.post('/local-sandbox/warm', async (c) => {
  if (!config.isLocalDockerEnabled()) {
    return c.json({ success: false, error: 'Local Docker provider is not enabled' }, 403);
  }

  const current = await getLocalSandboxWarmStatus();
  if (current.status === 'ready' || current.status === 'pulling' || current.status === 'creating') {
    return c.json(current, current.status === 'ready' ? 200 : 202);
  }

  const { LocalDockerProvider } = await import('../platform/providers/local-docker');
  const provider = new LocalDockerProvider();

  void provider.ensure().catch((err) => {
    console.error('[setup] local sandbox warmup failed:', err);
  });

  return c.json({
    success: true,
    status: 'creating',
    progress: 1,
    message: 'Starting local sandbox warmup...',
  }, 202);
});

setupApp.get('/local-sandbox/warm/status', async (c) => {
  if (!config.isLocalDockerEnabled()) {
    return c.json({ success: false, error: 'Local Docker provider is not enabled' }, 403);
  }

  return c.json(await getLocalSandboxWarmStatus());
});

setupApp.post('/bootstrap-owner', async (c) => {
  if (!hasDatabase) {
    return c.json({ success: false, error: 'Database not configured' }, 503);
  }

  try {
    const body = await c.req.json<{ email?: string; password?: string }>();
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
      if ((firstUser.email || '').toLowerCase() === email) {
        const updateExisting = await supabase.auth.admin.updateUserById(firstUser.id, {
          password,
          email_confirm: true,
        });
        if (updateExisting.error) {
          return c.json({ success: false, error: updateExisting.error.message || 'Could not refresh owner credentials' }, 500);
        }
        try {
          const accountId = await resolveAccountId(firstUser.id);
          await db
            .update(accounts)
            .set({ setupCompleteAt: null, setupWizardStep: 2, updatedAt: new Date() })
            .where(eq(accounts.accountId, accountId));
          await setSandboxEnv({ ONBOARDING_COMPLETE: 'false', ONBOARDING_SESSION_ID: '', ONBOARDING_COMMAND_FIRED: 'false' }).catch(() => {});
        } catch {
          // best effort reset
        }
        return c.json({ success: true, created: false, message: 'Owner already exists for this email', credentials_reset: true });
      }
      return c.json({ success: false, error: `Owner already exists (${firstUser.email})` }, 409);
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
        await setSandboxEnv({ ONBOARDING_COMPLETE: 'false', ONBOARDING_SESSION_ID: '', ONBOARDING_COMMAND_FIRED: 'false' }).catch(() => {});
      } catch {
        // best effort
      }
    }

    return c.json({ success: true, created: true, email });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ success: false, error: message }, 500);
  }
});

/**
 * GET /v1/setup/status
 * System status — Docker, .env files, services
 */
setupApp.get('/status', async (c) => {
  const root = getProjectRoot();
  const envExists = existsSync(resolve(root, '.env'));
  const sandboxEnvExists = existsSync(resolve(root, 'core/docker/.env'));

  let dockerRunning = false;
  try {
    execSync('docker info', { stdio: 'pipe', timeout: 10000 });
    dockerRunning = true;
  } catch {}

  return c.json({
    envMode: config.ENV_MODE,
    dockerRunning,
    envExists,
    sandboxEnvExists,
    projectRoot: root,
  });
});

/**
 * GET /v1/setup/env
 * Read current .env values (masked)
 */
setupApp.get('/env', async (c) => {
  const repoRoot = findRepoRoot();

  // Repo/dev mode: reads and writes actual .env files in the repo.
  if (repoRoot) {
    const rootEnv = parseEnvFile(resolve(repoRoot, '.env'));
    const sandboxEnv = parseEnvFile(resolve(repoRoot, 'core/docker/.env'));

    const masked: Record<string, string> = {};
    const configured: Record<string, boolean> = {};

    const providerSchema = buildProviderKeySchema();
    for (const group of Object.values(providerSchema)) {
      for (const k of group.keys) {
        const val = rootEnv[k.key] || sandboxEnv[k.key] || '';
        masked[k.key] = maskKey(val);
        configured[k.key] = !!val;
      }
    }

    for (const key of SYSTEM_KEYS) {
      const val = rootEnv[key] || sandboxEnv[key] || '';
      configured[key] = val === 'true';
    }

    return c.json({ masked, configured });
  }

  // Installed/local Docker mode: proxy to sandbox secret store.
  const env = await getSandboxEnv();
  const masked: Record<string, string> = {};
  const configured: Record<string, boolean> = {};

    const providerSchema = buildProviderKeySchema();
    for (const group of Object.values(providerSchema)) {
    for (const k of group.keys) {
      const val = env[k.key] || '';
      masked[k.key] = maskKey(val);
      configured[k.key] = !!val;
    }
  }

  for (const key of SYSTEM_KEYS) {
    const val = env[key] || '';
    configured[key] = val === 'true';
  }

  return c.json({ masked, configured });
});

/**
 * POST /v1/setup/env
 * Save/update API keys
 */
setupApp.post('/env', async (c) => {
  const body = await c.req.json();
  const keys = body?.keys;
  if (!keys || typeof keys !== 'object') {
    return c.json({ error: 'Invalid keys' }, 400);
  }

  const repoRoot = findRepoRoot();

  // Installed/local Docker mode: persist keys in the sandbox secret store.
    // Tools pick up new values instantly via s6 env dir (no restart needed).
  if (!repoRoot) {
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(keys)) {
      if (typeof v !== 'string') continue;
      const trimmed = v.trim();
      if (!trimmed) continue;
      clean[k] = trimmed;
    }

    try {
      await setSandboxEnv(clean);
      return c.json({ ok: true });
    } catch (e: any) {
      return c.json(
        { ok: false, error: 'Failed to save configuration', details: e?.message || String(e) },
        500,
      );
    }
  }

  // Repo/dev mode: write keys into repo .env + core/docker/.env and generate per-service env files.
  const root = repoRoot;
  const rootData: Record<string, string> = {};
  const sandboxData: Record<string, string> = {};

  for (const [key, val] of Object.entries(keys)) {
    if (typeof val !== 'string') continue;
    rootData[key] = val;
    if (ALL_SANDBOX_ENV_KEYS.has(key)) {
      sandboxData[key] = val;
    }
  }

  // Ensure root .env exists
  const rootEnvPath = resolve(root, '.env');
  if (!existsSync(rootEnvPath)) {
    const examplePath = resolve(root, '.env.example');
    if (existsSync(examplePath)) {
      writeFileSync(rootEnvPath, readFileSync(examplePath, 'utf-8'));
    } else {
      writeFileSync(rootEnvPath, '# Kortix Environment Configuration\nENV_MODE=local\n');
    }
  }

  rootData.ENV_MODE = 'local';
  rootData.ALLOWED_SANDBOX_PROVIDERS = 'local_docker';
  writeEnvFile(rootEnvPath, rootData);

  // Sandbox .env
  const sandboxEnvPath = resolve(root, 'core/docker/.env');
  mkdirSync(dirname(sandboxEnvPath), { recursive: true });
  if (!existsSync(sandboxEnvPath)) {
    const examplePath = resolve(root, 'core/docker/.env.example');
    if (existsSync(examplePath)) {
      writeFileSync(sandboxEnvPath, readFileSync(examplePath, 'utf-8'));
    } else {
      writeFileSync(sandboxEnvPath, '# Kortix Sandbox Environment\nENV_MODE=local\n');
    }
  }
  sandboxData.ENV_MODE = 'local';
  sandboxData.SANDBOX_ID = config.SANDBOX_CONTAINER_NAME;
  sandboxData.PROJECT_ID = 'local';
  sandboxData.KORTIX_API_URL = 'http://kortix-api:8008';
  writeEnvFile(sandboxEnvPath, sandboxData);

  // Run setup-env.sh
  try {
    execSync('bash scripts/setup-env.sh', { cwd: root, stdio: 'pipe', timeout: 15000 });
  } catch (e: any) {
    console.error('[setup] setup-env.sh failed:', e.message);
  }

  return c.json({ ok: true });
});

/**
 * GET /v1/setup/health
 * Health check of all local services
 */
setupApp.get('/health', async (c) => {
  const repoRoot = findRepoRoot();
  const checks: Record<string, LocalSandboxHealthCheck> = {};

  // Check API (self)
  checks.api = { ok: true };

  // Installed/local Docker mode: check sandbox by HTTP (no docker CLI in image)
  if (!repoRoot) {
    try {
      const health = await fetchMasterJson<{ status: string; runtimeReady?: boolean }>('/kortix/health', {}, 5000);
      checks.sandbox = { ok: true };
      checks.docker = { ok: true };
      if (health.status === 'starting' || health.runtimeReady === false) {
        checks.sandbox = { ok: false, error: 'Sandbox reachable but runtime is still starting' };
      }
    } catch (e: any) {
      const msg = e?.message || String(e);
      checks.sandbox = { ok: false, error: msg };
      checks.docker = { ok: false, error: msg };
    }
    return c.json(checks);
  }

  const localChecks = checkLocalSandboxHealth();
  checks.docker = localChecks.docker;
  checks.sandbox = localChecks.sandbox;

  return c.json(checks);
});



// ─── Setup Wizard Completion ────────────────────────────────────────────────
// Tracks whether the user has completed the setup wizard (provider + tool keys).
// Stored in the DB on accounts.setup_complete_at so it persists across
// browsers/tabs/devices and cannot be accidentally cleared by the sandbox agent.

/**
 * GET /v1/setup/setup-status
 * Returns { complete: boolean, completedAt: string | null }
 */
setupApp.get('/setup-status', async (c) => {
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
  } catch (e: any) {
    return c.json({ complete: false, completedAt: null, error: e?.message || String(e) }, 500);
  }
});

/**
 * POST /v1/setup/setup-complete
 * Mark the setup wizard as complete.
 */
setupApp.post('/setup-complete', async (c) => {
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
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || String(e) }, 500);
  }
});

/**
 * GET /v1/setup/setup-wizard-step
 * Returns the current setup wizard step from the database.
 * { step: number } — 0 = not started / complete, 2 = provider setup, 3 = tool keys
 */
setupApp.get('/setup-wizard-step', async (c) => {
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
  } catch (e: any) {
    return c.json({ step: 0, error: e?.message || String(e) }, 500);
  }
});

/**
 * POST /v1/setup/setup-wizard-step
 * Update the current setup wizard step in the database.
 * Body: { step: number }
 */
setupApp.post('/setup-wizard-step', async (c) => {
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
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || String(e) }, 500);
  }
});
