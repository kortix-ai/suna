/**
 * Admin Panel — self-contained admin dashboard served by kortix-api.
 *
 * Serves an embedded HTML admin UI at /v1/admin and exposes JSON API endpoints
 * for managing platform-level .env credentials and listing all sandbox instances.
 *
 * Auth: Supabase JWT (same as other authenticated routes).
 *
 * Routes:
 *   GET  /v1/admin                → Admin panel HTML (single-page app)
 *   GET  /v1/admin/api/env        → Read current env values (masked)
 *   POST /v1/admin/api/env        → Update env values
 *   GET  /v1/admin/api/schema     → Provider key schema
 *   GET  /v1/admin/api/instances  → List all sandbox instances
 *   GET  /v1/admin/api/health     → Service health checks
 *   GET  /v1/admin/api/status     → System status
 */

import { Hono } from 'hono';
import { eq, desc } from 'drizzle-orm';
import type { AppEnv } from '../types';
import { config } from '../config';
import { PROVIDER_REGISTRY, buildProviderKeySchema, LLM_PROVIDERS, TOOL_PROVIDERS } from '../providers/registry';
import { supabaseAuth } from '../middleware/auth';
import { requireAdmin } from '../middleware/require-admin';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { execSync } from 'child_process';

export const adminApp = new Hono<AppEnv>();

// ─── Auth ───────────────────────────────────────────────────────────────────
// All admin routes require a valid Supabase JWT AND admin/super_admin role.
adminApp.use('/*', supabaseAuth, requireAdmin);

// ─── Secret redaction ───────────────────────────────────────────────────────
// Redacts sensitive fields from sandbox metadata and provider details before
// returning them to the admin UI. Even admins shouldn't have credentials
// streaming through DevTools / browser extensions when the UI doesn't need them.
//
// Note: provider_detail.ssh.private_key / setup_command are intentionally NOT
// redacted — admins legitimately need to copy the SSH setup command from the
// Connect tab. The UI masks the key visually via SecretCodeBlock.
const ADMIN_REDACT_KEYS = new Set([
  'justavpsProxyToken', 'justavpsProxyTokenId',
  'machine_token', 'machineToken',
  'api_key', 'apiKey',
  'password', 'secret',
]);
function redactAdminSecrets<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redactAdminSecrets) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (ADMIN_REDACT_KEYS.has(k) && typeof v === 'string' && v.length > 0) {
      out[k] = `${v.slice(0, 4)}••••••${v.slice(-4)}`;
    } else {
      out[k] = redactAdminSecrets(v);
    }
  }
  return out as T;
}

// ─── Helpers (reused from setup module) ─────────────────────────────────────

function findRepoRoot(): string | null {
  const candidates = [
    process.cwd(),
    resolve(process.cwd(), '..'),
    resolve(process.cwd(), '../..'),
    resolve(__dirname, '../../../..'),
  ];
  for (const dir of candidates) {
    if (existsSync(resolve(dir, 'docker-compose.local.yml'))) {
      return dir;
    }
  }
  return null;
}

function getProjectRoot(): string {
  return findRepoRoot() ?? process.cwd();
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

function getMasterUrlCandidates(): string[] {
  const candidates: string[] = [];
  const explicit = process.env.KORTIX_MASTER_URL;
  if (explicit && explicit.trim()) candidates.push(explicit.trim());
  candidates.push('http://sandbox:8000');
  candidates.push(`http://localhost:${config.SANDBOX_PORT_BASE || 14000}`);
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
      if (!res.ok && res.status !== 503) { lastErr = new Error(`Master ${url} returned ${res.status}`); continue; }
      return (await res.json()) as T;
    } catch (e) { lastErr = e; continue; }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Failed to reach sandbox master');
}

async function getSandboxEnv(): Promise<Record<string, string>> {
  try { return await fetchMasterJson<Record<string, string>>('/env'); }
  catch { return {}; }
}

async function setSandboxEnv(keys: Record<string, string>): Promise<void> {
  await fetchMasterJson('/env', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keys }),
  }, 15000);
}

// ─── Extended key groups (beyond provider registry) ─────────────────────────
// These are platform-level keys not in the provider registry but configured
// during get-kortix.sh setup.

interface KeyGroup {
  title: string;
  description: string;
  keys: Array<{ key: string; label: string; helpUrl?: string; secret?: boolean }>;
}

function getAdminKeySchema(): Record<string, KeyGroup> {
  const schema = buildProviderKeySchema();

  // Add platform-level key groups not in the provider registry
  return {
    ...schema,
    billing: {
      title: 'Billing',
      description: 'Stripe and RevenueCat keys for subscription billing.',
      keys: [
        { key: 'STRIPE_SECRET_KEY', label: 'Stripe Secret Key', secret: true },
        { key: 'STRIPE_WEBHOOK_SECRET', label: 'Stripe Webhook Secret', secret: true },
        { key: 'REVENUECAT_API_KEY', label: 'RevenueCat API Key', secret: true },
        { key: 'REVENUECAT_WEBHOOK_SECRET', label: 'RevenueCat Webhook Secret', secret: true },
      ],
    },
    cloud: {
      title: 'Cloud Provider (Daytona)',
      description: 'Daytona cloud sandbox provisioning.',
      keys: [
        { key: 'DAYTONA_API_KEY', label: 'Daytona API Key', secret: true },
        { key: 'DAYTONA_SERVER_URL', label: 'Daytona Server URL' },
        { key: 'DAYTONA_TARGET', label: 'Daytona Target' },
      ],
    },
    justavps: {
      title: 'Cloud Provider (JustAVPS)',
      description: 'JustAVPS sandbox provisioning.',
      keys: [
        { key: 'JUSTAVPS_API_URL', label: 'JustAVPS API URL' },
        { key: 'JUSTAVPS_API_KEY', label: 'JustAVPS API Key', secret: true },
        { key: 'JUSTAVPS_IMAGE_ID', label: 'Image ID' },
        { key: 'JUSTAVPS_DEFAULT_LOCATION', label: 'Default Location' },
        { key: 'JUSTAVPS_DEFAULT_SERVER_TYPE', label: 'Default Server Type' },
        { key: 'JUSTAVPS_IMAGE_BUILD_LOCATION', label: 'Image Build Location' },
        { key: 'JUSTAVPS_IMAGE_BUILD_SERVER_TYPE', label: 'Image Build Server Type' },
        { key: 'JUSTAVPS_PROXY_DOMAIN', label: 'Proxy Domain' },
        { key: 'JUSTAVPS_WEBHOOK_URL', label: 'Webhook URL' },
        { key: 'JUSTAVPS_WEBHOOK_SECRET', label: 'Webhook Secret', secret: true },
      ],
    },
    sandbox: {
      title: 'Sandbox Configuration',
      description: 'Local sandbox provisioning settings.',
      keys: [
        { key: 'ALLOWED_SANDBOX_PROVIDERS', label: 'Allowed Providers' },
        { key: 'SANDBOX_PORT_BASE', label: 'Sandbox Port Base' },
        { key: 'DOCKER_HOST', label: 'Docker Host' },
        { key: 'INTERNAL_SERVICE_KEY', label: 'Internal Service Key', secret: true },
      ],
    },
    integrations: {
      title: 'Integrations',
      description: 'Pipedream and Slack OAuth integration keys.',
      keys: [
        { key: 'PIPEDREAM_CLIENT_ID', label: 'Pipedream Client ID' },
        { key: 'PIPEDREAM_CLIENT_SECRET', label: 'Pipedream Client Secret', secret: true },
        { key: 'PIPEDREAM_PROJECT_ID', label: 'Pipedream Project ID' },
        { key: 'SLACK_CLIENT_ID', label: 'Slack Client ID' },
        { key: 'SLACK_CLIENT_SECRET', label: 'Slack Client Secret', secret: true },
        { key: 'SLACK_SIGNING_SECRET', label: 'Slack Signing Secret', secret: true },
      ],
    },
    core: {
      title: 'Core Infrastructure',
      description: 'Database, Supabase, and API security keys.',
      keys: [
        { key: 'DATABASE_URL', label: 'Database URL', secret: true },
        { key: 'SUPABASE_URL', label: 'Supabase URL' },
        { key: 'SUPABASE_SERVICE_ROLE_KEY', label: 'Supabase Service Role Key', secret: true },
        { key: 'API_KEY_SECRET', label: 'API Key Hashing Secret', secret: true },
      ],
    },
  };
}

// Collect all admin-managed keys
function getAllAdminKeys(): string[] {
  const schema = getAdminKeySchema();
  const keys: string[] = [];
  for (const group of Object.values(schema)) {
    for (const k of group.keys) {
      keys.push(k.key);
    }
  }
  return keys;
}

// ─── API Routes ─────────────────────────────────────────────────────────────

/** GET /v1/admin/api/schema — key schema for the UI */
adminApp.get('/api/schema', async (c) => {
  return c.json(getAdminKeySchema());
});

/** GET /v1/admin/api/env — read current env values (masked) */
adminApp.get('/api/env', async (c) => {
  const repoRoot = findRepoRoot();
  const allKeys = getAllAdminKeys();

  if (repoRoot) {
    const rootEnv = parseEnvFile(resolve(repoRoot, '.env'));
    const sandboxEnv = parseEnvFile(resolve(repoRoot, 'core/docker/.env'));
    const masked: Record<string, string> = {};
    const configured: Record<string, boolean> = {};

    for (const key of allKeys) {
      const val = rootEnv[key] || sandboxEnv[key] || '';
      masked[key] = maskKey(val);
      configured[key] = !!val;
    }
    return c.json({ masked, configured });
  }

  // Docker mode
  const env = await getSandboxEnv();
  const masked: Record<string, string> = {};
  const configured: Record<string, boolean> = {};
  for (const key of allKeys) {
    const val = env[key] || '';
    masked[key] = maskKey(val);
    configured[key] = !!val;
  }
  return c.json({ masked, configured });
});

/** POST /v1/admin/api/env — save/update env values */
adminApp.post('/api/env', async (c) => {
  const body = await c.req.json();
  const keys = body?.keys;
  if (!keys || typeof keys !== 'object') {
    return c.json({ error: 'Invalid keys' }, 400);
  }

  const repoRoot = findRepoRoot();

  if (!repoRoot) {
    // Docker mode
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
      return c.json({ ok: false, error: 'Failed to save', details: e?.message || String(e) }, 500);
    }
  }

  // Repo mode
  const rootData: Record<string, string> = {};
  const sandboxData: Record<string, string> = {};
  const { ALL_SANDBOX_ENV_KEYS } = await import('../providers/registry');

  for (const [key, val] of Object.entries(keys)) {
    if (typeof val !== 'string') continue;
    rootData[key] = val;
    if (ALL_SANDBOX_ENV_KEYS.has(key)) {
      sandboxData[key] = val;
    }
  }

  const rootEnvPath = resolve(repoRoot, '.env');
  if (!existsSync(rootEnvPath)) {
    const examplePath = resolve(repoRoot, '.env.example');
    if (existsSync(examplePath)) {
      writeFileSync(rootEnvPath, readFileSync(examplePath, 'utf-8'));
    } else {
      writeFileSync(rootEnvPath, '# Kortix Environment Configuration\nENV_MODE=local\n');
    }
  }

  writeEnvFile(rootEnvPath, rootData);

  if (Object.keys(sandboxData).length > 0) {
    const sandboxEnvPath = resolve(repoRoot, 'core/docker/.env');
    if (!existsSync(sandboxEnvPath)) {
      const examplePath = resolve(repoRoot, 'core/docker/.env.example');
      if (existsSync(examplePath)) {
        writeFileSync(sandboxEnvPath, readFileSync(examplePath, 'utf-8'));
      } else {
        writeFileSync(sandboxEnvPath, '# Kortix Sandbox Environment\nENV_MODE=local\n');
      }
    }
    writeEnvFile(sandboxEnvPath, sandboxData);
  }

  // Re-run setup-env.sh to propagate
  try {
    execSync('bash scripts/setup-env.sh', { cwd: repoRoot, stdio: 'pipe', timeout: 15000 });
  } catch (e: any) {
    console.error('[admin] setup-env.sh failed:', e.message);
  }

  return c.json({ ok: true });
});

/** GET /v1/admin/api/instances — list all sandbox instances from DB */
adminApp.get('/api/instances', async (c) => {
  try {
    const { db } = await import('../shared/db');
    const { sandboxes } = await import('@kortix/db');

    const rows = await db
      .select()
      .from(sandboxes)
      .orderBy(desc(sandboxes.createdAt));

    const instances = rows.map((row) => ({
      sandbox_id: row.sandboxId,
      external_id: row.externalId,
      name: row.name,
      provider: row.provider,
      base_url: row.baseUrl,
      status: row.status,
      metadata: row.metadata,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
    }));

    return c.json({ instances });
  } catch (e: any) {
    return c.json({ instances: [], error: e?.message || String(e) });
  }
});

/** GET /v1/admin/api/sandboxes — list sandboxes with search, filters, pagination */
adminApp.get('/api/sandboxes', async (c) => {
  try {
    const { db } = await import('../shared/db');
    const { sandboxes, accounts } = await import('@kortix/db');
    const { desc, eq, sql, and, ilike, or } = await import('drizzle-orm');

    const q       = c.req.query('search')   || '';
    const status  = c.req.query('status')   || '';
    const provider = c.req.query('provider') || '';
    const page    = Math.max(1, parseInt(c.req.query('page')  || '1', 10));
    const limit   = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '50', 10)));
    const offset  = (page - 1) * limit;
    const validStatuses = ['provisioning', 'active', 'stopped', 'archived', 'pooled', 'error'] as const;
    const validProviders = ['daytona', 'local_docker', 'justavps'] as const;

    // Build WHERE conditions
    const conditions = [];

    if (validStatuses.includes(status as typeof validStatuses[number])) {
      conditions.push(eq(sandboxes.status, status as typeof validStatuses[number]));
    }
    if (validProviders.includes(provider as typeof validProviders[number])) {
      conditions.push(eq(sandboxes.provider, provider as typeof validProviders[number]));
    }
    if (q) {
      conditions.push(or(
        sql`cast(${sandboxes.sandboxId} as text) ilike ${'%' + q + '%'}`,
        sql`cast(${sandboxes.accountId} as text) ilike ${'%' + q + '%'}`,
        sql`cast(${sandboxes.externalId} as text) ilike ${'%' + q + '%'}`,
        ilike(sandboxes.name, `%${q}%`),
        ilike(accounts.name, `%${q}%`),
        sql`EXISTS (
          SELECT 1 FROM auth.users au
          INNER JOIN kortix.account_members am ON am.user_id = au.id
          WHERE am.account_id = ${sandboxes.accountId}
          AND au.email ILIKE ${'%' + q + '%'}
          LIMIT 1
        )`,
      )!);
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const ownerEmailSub = sql<string>`(
      SELECT au.email FROM auth.users au
      INNER JOIN kortix.account_members am ON am.user_id = au.id
      WHERE am.account_id = ${sandboxes.accountId}
      LIMIT 1
    )`;

    const [rows, [{ total }]] = await Promise.all([
      db
        .select({
          sandboxId: sandboxes.sandboxId,
          accountId: sandboxes.accountId,
          name: sandboxes.name,
          provider: sandboxes.provider,
          externalId: sandboxes.externalId,
          status: sandboxes.status,
          baseUrl: sandboxes.baseUrl,
          metadata: sandboxes.metadata,
          createdAt: sandboxes.createdAt,
          updatedAt: sandboxes.updatedAt,
          lastUsedAt: sandboxes.lastUsedAt,
          accountName: accounts.name,
          ownerEmail: ownerEmailSub,
        })
        .from(sandboxes)
        .leftJoin(accounts, eq(sandboxes.accountId, accounts.accountId))
        .where(where)
        .orderBy(desc(sandboxes.createdAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ total: sql<number>`count(*)::int` })
        .from(sandboxes)
        .leftJoin(accounts, eq(sandboxes.accountId, accounts.accountId))
        .where(where),
    ]);

    return c.json({ sandboxes: redactAdminSecrets(rows), total, page, limit });
  } catch (e: any) {
    return c.json({ sandboxes: [], total: 0, page: 1, limit: 50, error: e?.message || String(e) }, 500);
  }
});

/** DELETE /v1/admin/api/sandboxes/:id — delete a sandbox from DB and provider */
adminApp.delete('/api/sandboxes/:id', async (c) => {
  try {
    const sandboxId = c.req.param('id');
    const { db } = await import('../shared/db');
    const { sandboxes } = await import('@kortix/db');
    const { eq } = await import('drizzle-orm');

    const [row] = await db.select().from(sandboxes).where(eq(sandboxes.sandboxId, sandboxId)).limit(1);
    if (!row) return c.json({ error: 'Sandbox not found' }, 404);

    // Try to delete from provider
    if (row.provider === 'justavps' && row.externalId) {
      try {
        const { config: cfg } = await import('../config');
        await fetch(`${cfg.JUSTAVPS_API_URL.replace(/\/$/, '')}/machines/${row.externalId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${cfg.JUSTAVPS_API_KEY}` },
        });
      } catch (e: any) {
        console.warn(`[ADMIN] Failed to delete JustAVPS machine ${row.externalId}: ${e?.message}`);
      }
    }

    await db.delete(sandboxes).where(eq(sandboxes.sandboxId, sandboxId));
    return c.json({ success: true, sandboxId });
  } catch (e: any) {
    return c.json({ error: e?.message || String(e) }, 500);
  }
});

/** GET /v1/admin/api/sandboxes/:id — full sandbox detail merged with provider data */
adminApp.get('/api/sandboxes/:id', async (c) => {
  try {
    const sandboxId = c.req.param('id');
    const { db } = await import('../shared/db');
    const { sandboxes, accounts } = await import('@kortix/db');
    const { eq, sql } = await import('drizzle-orm');

    const ownerEmailSub = sql<string>`(
      SELECT au.email FROM auth.users au
      INNER JOIN kortix.account_members am ON am.user_id = au.id
      WHERE am.account_id = ${sandboxes.accountId}
      LIMIT 1
    )`;

    const [row] = await db
      .select({
        sandboxId: sandboxes.sandboxId,
        accountId: sandboxes.accountId,
        name: sandboxes.name,
        provider: sandboxes.provider,
        externalId: sandboxes.externalId,
        status: sandboxes.status,
        baseUrl: sandboxes.baseUrl,
        config: sandboxes.config,
        metadata: sandboxes.metadata,
        createdAt: sandboxes.createdAt,
        updatedAt: sandboxes.updatedAt,
        lastUsedAt: sandboxes.lastUsedAt,
        accountName: accounts.name,
        ownerEmail: ownerEmailSub,
      })
      .from(sandboxes)
      .leftJoin(accounts, eq(sandboxes.accountId, accounts.accountId))
      .where(eq(sandboxes.sandboxId, sandboxId))
      .limit(1);

    if (!row) return c.json({ error: 'Sandbox not found' }, 404);

    let providerDetail: unknown = null;
    let providerError: string | null = null;
    if (row.provider === 'justavps' && row.externalId) {
      try {
        const { justavpsFetch } = await import('../platform/providers/justavps');
        providerDetail = await justavpsFetch(`/machines/${row.externalId}`);
      } catch (e: any) {
        providerError = e?.message || String(e);
      }
    }

    return c.json({
      sandbox: redactAdminSecrets(row),
      provider_detail: providerDetail, // ssh.private_key / setup_command left intact — admin needs them
      provider_error: providerError,
    });
  } catch (e: any) {
    return c.json({ error: e?.message || String(e) }, 500);
  }
});

/** POST /v1/admin/api/sandboxes/:id/exec — run a shell command on the sandbox via JustAVPS daemon */
adminApp.post('/api/sandboxes/:id/exec', async (c) => {
  try {
    const sandboxId = c.req.param('id');
    const body = await c.req.json().catch(() => ({})) as { command?: unknown; timeout?: unknown };
    const command = typeof body.command === 'string' ? body.command : '';
    const timeout = typeof body.timeout === 'number' && body.timeout > 0 && body.timeout <= 600 ? body.timeout : 60;
    if (!command || command.length > 8192) {
      return c.json({ error: 'command (string, 1-8192 chars) required' }, 400);
    }

    const { db } = await import('../shared/db');
    const { sandboxes } = await import('@kortix/db');
    const { eq } = await import('drizzle-orm');

    const [row] = await db.select().from(sandboxes).where(eq(sandboxes.sandboxId, sandboxId)).limit(1);
    if (!row) return c.json({ error: 'Sandbox not found' }, 404);
    if (row.provider !== 'justavps' || !row.externalId) {
      return c.json({ error: `Exec not supported for provider: ${row.provider}` }, 400);
    }

    const { justavpsFetch } = await import('../platform/providers/justavps');
    const result = await justavpsFetch(`/machines/${row.externalId}/exec`, {
      method: 'POST',
      body: { command, timeout },
    });
    return c.json(result);
  } catch (e: any) {
    return c.json({ error: e?.message || String(e) }, 502);
  }
});

/** POST /v1/admin/api/sandboxes/:id/action — reboot/stop/start the sandbox machine */
adminApp.post('/api/sandboxes/:id/action', async (c) => {
  try {
    const sandboxId = c.req.param('id');
    const body = await c.req.json().catch(() => ({})) as { action?: unknown };
    const action = body.action;
    if (action !== 'reboot' && action !== 'stop' && action !== 'start') {
      return c.json({ error: 'action must be one of: reboot, stop, start' }, 400);
    }

    const { db } = await import('../shared/db');
    const { sandboxes } = await import('@kortix/db');
    const { eq } = await import('drizzle-orm');

    const [row] = await db.select().from(sandboxes).where(eq(sandboxes.sandboxId, sandboxId)).limit(1);
    if (!row) return c.json({ error: 'Sandbox not found' }, 404);
    if (row.provider !== 'justavps' || !row.externalId) {
      return c.json({ error: `Action not supported for provider: ${row.provider}` }, 400);
    }

    const { justavpsFetch } = await import('../platform/providers/justavps');
    const result = await justavpsFetch(`/machines/${row.externalId}/${action}`, { method: 'POST' });

    // Mirror status locally for stop/start so the admin list reflects state immediately.
    if (action === 'stop') {
      await db.update(sandboxes).set({ status: 'stopped' }).where(eq(sandboxes.sandboxId, sandboxId));
    } else if (action === 'start') {
      await db.update(sandboxes).set({ status: 'active' }).where(eq(sandboxes.sandboxId, sandboxId));
    }

    return c.json({ action, ...result });
  } catch (e: any) {
    return c.json({ error: e?.message || String(e) }, 502);
  }
});

/** POST /v1/admin/api/sandboxes/:id/proxy-token — mint a fresh JustAVPS proxy JWT for browser use */
adminApp.post('/api/sandboxes/:id/proxy-token', async (c) => {
  try {
    const sandboxId = c.req.param('id');
    const { db } = await import('../shared/db');
    const { sandboxes } = await import('@kortix/db');
    const { eq } = await import('drizzle-orm');

    const [row] = await db.select().from(sandboxes).where(eq(sandboxes.sandboxId, sandboxId)).limit(1);
    if (!row) return c.json({ error: 'Sandbox not found' }, 404);
    if (row.provider !== 'justavps' || !row.externalId) {
      return c.json({ error: `Proxy token not supported for provider: ${row.provider}` }, 400);
    }

    const { mintProxyTokenOnJustAvps, justavpsFetch } = await import('../platform/providers/justavps');
    const minted = await mintProxyTokenOnJustAvps(row.externalId);
    if (!minted) return c.json({ error: 'Failed to mint proxy token' }, 502);

    // Try to discover the live terminal URL from JustAVPS.
    let terminalUrl: string | null = null;
    let proxyUrl: string | null = null;
    try {
      const detail = await justavpsFetch<{ urls?: { terminal?: string | null; proxy?: string | null } | null }>(
        `/machines/${row.externalId}`,
      );
      terminalUrl = detail?.urls?.terminal ?? null;
      proxyUrl = detail?.urls?.proxy ?? null;
    } catch {
      /* ignore — caller can construct URL itself */
    }

    return c.json({
      token: minted.token,
      token_id: minted.id,
      expires_at: minted.expiresAt,
      terminal_url: terminalUrl,
      proxy_url: proxyUrl,
    });
  } catch (e: any) {
    return c.json({ error: e?.message || String(e) }, 500);
  }
});

/** GET /v1/admin/api/health — service health checks */
adminApp.get('/api/health', async (c) => {
  const repoRoot = findRepoRoot();
  const checks: Record<string, { ok: boolean; error?: string }> = {};

  checks.api = { ok: true };

  if (!repoRoot) {
    try {
      const health = await fetchMasterJson<{ status: string; runtimeReady?: boolean }>('/kortix/health', {}, 5000);
      checks.sandbox = { ok: true };
      checks.docker = { ok: true };
      // If runtime isn't ready, sandbox is reachable but not fully operational
      if (health.status === 'starting' || health.runtimeReady === false) {
        checks.sandbox = { ok: false, error: 'Sandbox reachable but runtime is still starting' };
      }
    } catch (e: any) {
      checks.sandbox = { ok: false, error: e?.message || String(e) };
      checks.docker = { ok: false, error: e?.message || String(e) };
    }
    return c.json(checks);
  }

  try {
    execSync('docker info', { stdio: 'pipe', timeout: 5000 });
    checks.docker = { ok: true };
  } catch {
    checks.docker = { ok: false, error: 'Docker not running' };
  }

  try {
    const out = execSync(`docker inspect ${config.SANDBOX_CONTAINER_NAME} --format "{{.State.Status}}"`, {
      stdio: 'pipe', timeout: 5000,
    }).toString().trim();
    checks.sandbox = { ok: out === 'running', error: out !== 'running' ? `Status: ${out}` : undefined };
  } catch {
    checks.sandbox = { ok: false, error: 'Container not found' };
  }

  return c.json(checks);
});

/** GET /v1/admin/api/status — system status */
adminApp.get('/api/status', async (c) => {
  const root = getProjectRoot();
  return c.json({
    envMode: config.ENV_MODE,
    internalEnv: config.INTERNAL_KORTIX_ENV,
    port: config.PORT,
    sandboxVersion: (await import('../config')).SANDBOX_VERSION,
    allowedProviders: config.ALLOWED_SANDBOX_PROVIDERS,
    billingEnabled: config.KORTIX_BILLING_INTERNAL_ENABLED,
    daytonaEnabled: config.isDaytonaEnabled(),
    localDockerEnabled: config.isLocalDockerEnabled(),
    databaseConfigured: !!config.DATABASE_URL,
    supabaseConfigured: !!config.SUPABASE_URL,
    stripeConfigured: !!config.STRIPE_SECRET_KEY,
  });
});

// ─── Admin HTML UI ──────────────────────────────────────────────────────────

adminApp.get('/', async (c) => {
  return c.html(getAdminHTML());
});

function getAdminHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Kortix Admin</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg: #0a0a0b;
      --bg-card: #111113;
      --bg-input: #1a1a1d;
      --bg-hover: #1e1e21;
      --border: #2a2a2d;
      --border-focus: #4a4a4d;
      --text: #e4e4e7;
      --text-dim: #71717a;
      --text-muted: #52525b;
      --accent: #3b82f6;
      --accent-hover: #2563eb;
      --green: #22c55e;
      --green-dim: #15803d;
      --red: #ef4444;
      --red-dim: #991b1b;
      --yellow: #eab308;
      --yellow-dim: #854d0e;
      --radius: 8px;
      --font: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      --mono: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
    }

    body {
      font-family: var(--font);
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
      min-height: 100vh;
    }

    .app {
      max-width: 960px;
      margin: 0 auto;
      padding: 32px 24px;
    }

    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 32px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border);
    }

    header h1 {
      font-size: 20px;
      font-weight: 600;
      letter-spacing: -0.02em;
    }

    header .status-bar {
      display: flex;
      gap: 12px;
      font-size: 12px;
      color: var(--text-dim);
    }

    .status-dot {
      display: inline-block;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      margin-right: 4px;
      vertical-align: middle;
    }

    .status-dot.ok { background: var(--green); }
    .status-dot.err { background: var(--red); }
    .status-dot.warn { background: var(--yellow); }
    .status-dot.loading { background: var(--text-muted); animation: pulse 1s infinite; }

    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

    /* Tabs */
    .tabs {
      display: flex;
      gap: 2px;
      margin-bottom: 24px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 3px;
    }

    .tab {
      flex: 1;
      padding: 8px 16px;
      background: none;
      border: none;
      color: var(--text-dim);
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      border-radius: 6px;
      transition: all 0.15s;
    }

    .tab:hover { color: var(--text); background: var(--bg-hover); }
    .tab.active { color: var(--text); background: var(--bg-input); }

    /* Sections */
    .section {
      display: none;
    }

    .section.active {
      display: block;
    }

    /* Cards */
    .card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      margin-bottom: 16px;
      overflow: hidden;
    }

    .card-header {
      padding: 14px 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      cursor: pointer;
      user-select: none;
      transition: background 0.1s;
    }

    .card-header:hover { background: var(--bg-hover); }

    .card-header h3 {
      font-size: 14px;
      font-weight: 600;
    }

    .card-header .badge {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 10px;
      background: var(--bg-input);
      color: var(--text-dim);
      border: 1px solid var(--border);
    }

    .card-header .badge.configured {
      background: rgba(34, 197, 94, 0.1);
      color: var(--green);
      border-color: var(--green-dim);
    }

    .card-header .chevron {
      transition: transform 0.2s;
      color: var(--text-muted);
      font-size: 12px;
    }

    .card.open .card-header .chevron { transform: rotate(180deg); }

    .card-body {
      display: none;
      padding: 0 16px 16px;
    }

    .card.open .card-body { display: block; }

    .card-desc {
      font-size: 12px;
      color: var(--text-dim);
      margin-bottom: 12px;
    }

    /* Key rows */
    .key-row {
      display: grid;
      grid-template-columns: 180px 1fr auto;
      gap: 8px;
      align-items: center;
      margin-bottom: 8px;
    }

    .key-row label {
      font-size: 12px;
      color: var(--text-dim);
      font-family: var(--mono);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .key-row input {
      width: 100%;
      padding: 6px 10px;
      background: var(--bg-input);
      border: 1px solid var(--border);
      border-radius: 6px;
      color: var(--text);
      font-size: 13px;
      font-family: var(--mono);
      outline: none;
      transition: border-color 0.15s;
    }

    .key-row input:focus { border-color: var(--border-focus); }

    .key-row input::placeholder { color: var(--text-muted); }

    .key-status {
      width: 20px;
      height: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
    }

    .key-status.set { color: var(--green); }
    .key-status.unset { color: var(--text-muted); }

    .key-help {
      font-size: 11px;
      color: var(--accent);
      text-decoration: none;
      margin-left: 4px;
    }

    .key-help:hover { text-decoration: underline; }

    /* Buttons */
    .btn {
      padding: 8px 16px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--bg-input);
      color: var(--text);
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s;
    }

    .btn:hover { background: var(--bg-hover); border-color: var(--border-focus); }

    .btn-primary {
      background: var(--accent);
      border-color: var(--accent);
      color: white;
    }

    .btn-primary:hover { background: var(--accent-hover); }

    .btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .btn-small {
      padding: 6px 10px;
      font-size: 12px;
      line-height: 1;
    }

    .btn-row {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .section-hint {
      font-size: 12px;
      color: var(--text-dim);
      margin-bottom: 12px;
    }

    .save-bar {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-top: 16px;
    }

    .save-msg {
      font-size: 12px;
      color: var(--green);
    }

    .save-msg.error {
      color: var(--red);
    }

    /* Instances table */
    .instances-table {
      width: 100%;
      border-collapse: separate;
      border-spacing: 0;
      font-size: 13px;
    }

    .instances-table th {
      text-align: left;
      padding: 10px 12px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-dim);
      border-bottom: 1px solid var(--border);
    }

    .instances-table td {
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      font-family: var(--mono);
      font-size: 12px;
    }

    .instances-table tr:last-child td { border-bottom: none; }

    .instances-table tr:hover td { background: var(--bg-hover); }

    .status-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 10px;
      font-size: 11px;
      font-weight: 500;
    }

    .status-badge.active { background: rgba(34, 197, 94, 0.1); color: var(--green); }
    .status-badge.stopped { background: rgba(234, 179, 8, 0.1); color: var(--yellow); }
    .status-badge.archived { background: rgba(113, 113, 122, 0.1); color: var(--text-dim); }
    .status-badge.error { background: rgba(239, 68, 68, 0.1); color: var(--red); }

    .empty-state {
      text-align: center;
      padding: 48px 24px;
      color: var(--text-dim);
      font-size: 13px;
    }

    /* Status grid */
    .status-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: 12px;
    }

    .status-item {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 14px 16px;
    }

    .status-item .label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-dim);
      margin-bottom: 4px;
    }

    .status-item .value {
      font-size: 14px;
      font-weight: 500;
      font-family: var(--mono);
    }

    /* Toast */
    .toast {
      position: fixed;
      bottom: 24px;
      right: 24px;
      padding: 10px 16px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      font-size: 13px;
      color: var(--text);
      opacity: 0;
      transform: translateY(10px);
      transition: all 0.2s;
      z-index: 100;
    }

    .toast.show { opacity: 1; transform: translateY(0); }
    .toast.success { border-color: var(--green-dim); }
    .toast.error { border-color: var(--red-dim); color: var(--red); }

    /* Loading */
    .loading-spinner {
      display: inline-block;
      width: 14px;
      height: 14px;
      border: 2px solid var(--border);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.6s linear infinite;
    }

    @keyframes spin { to { transform: rotate(360deg); } }

    /* Auth overlay */
    .auth-overlay {
      position: fixed;
      inset: 0;
      background: var(--bg);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }

    .auth-box {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 32px;
      width: 100%;
      max-width: 380px;
      text-align: center;
    }

    .auth-box h2 {
      font-size: 18px;
      margin-bottom: 8px;
    }

    .auth-box p {
      font-size: 13px;
      color: var(--text-dim);
      margin-bottom: 20px;
    }

    .auth-box input {
      width: 100%;
      padding: 10px 12px;
      background: var(--bg-input);
      border: 1px solid var(--border);
      border-radius: 6px;
      color: var(--text);
      font-size: 13px;
      margin-bottom: 12px;
      outline: none;
    }

    .auth-box input:focus { border-color: var(--border-focus); }

    .auth-error {
      font-size: 12px;
      color: var(--red);
      margin-bottom: 8px;
    }

    @media (max-width: 640px) {
      .key-row {
        grid-template-columns: 1fr;
        gap: 4px;
      }
      .status-grid {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <!-- Auth overlay -->
  <div id="auth-overlay" class="auth-overlay" style="display: none;">
    <div class="auth-box">
      <h2>Kortix Admin</h2>
      <p>Enter your Supabase JWT or sign in to access the admin panel.</p>
      <input type="password" id="auth-token" placeholder="Bearer token" />
      <div id="auth-error" class="auth-error" style="display: none;"></div>
      <button class="btn btn-primary" style="width: 100%;" onclick="authenticate()">Sign In</button>
    </div>
  </div>

  <!-- Main app -->
  <div class="app" id="main-app">
    <header>
      <h1>Kortix Admin</h1>
      <div class="status-bar" id="status-bar">
        <span><span class="status-dot loading" id="dot-api"></span>API</span>
        <span><span class="status-dot loading" id="dot-docker"></span>Docker</span>
        <span><span class="status-dot loading" id="dot-sandbox"></span>Sandbox</span>
      </div>
    </header>

    <div class="tabs">
      <button class="tab active" onclick="switchTab('credentials')">Credentials</button>
      <button class="tab" onclick="switchTab('instances')">Machines</button>
      <button class="tab" onclick="switchTab('status')">System Status</button>
    </div>

    <div id="section-credentials" class="section active">
      <div id="credentials-container">
        <div class="empty-state"><span class="loading-spinner"></span> Loading credentials...</div>
      </div>
      <div class="save-bar">
        <button class="btn btn-primary" id="save-btn" onclick="saveCredentials()" disabled>Save Changes</button>
        <span class="save-msg" id="save-msg"></span>
      </div>
    </div>

    <div id="section-instances" class="section">
      <div class="card">
        <div class="card-body" style="display:block;padding-top:16px;">
          <div class="section-hint">Admins can open any machine directly from here using the same terminal/proxy path regular users use.</div>
        </div>
        <div id="instances-container">
          <div class="empty-state"><span class="loading-spinner"></span> Loading machines...</div>
        </div>
      </div>
    </div>

    <div id="section-status" class="section">
      <div id="status-container">
        <div class="empty-state"><span class="loading-spinner"></span> Loading status...</div>
      </div>
    </div>
  </div>

  <div class="toast" id="toast"></div>

  <script>
    // ─── State ──────────────────────────────────────────────────
    let token = '';
    let schema = {};
    let envData = { masked: {}, configured: {} };
    let dirtyKeys = {};
    let activeTab = 'credentials';
    let machineActionState = {};

    function escapeHtml(value) {
      return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    const API_BASE = '/v1/admin/api';

    // ─── Auth ───────────────────────────────────────────────────
    function getStoredToken() {
      return localStorage.getItem('kortix_admin_token') || '';
    }

    function setStoredToken(t) {
      localStorage.setItem('kortix_admin_token', t);
    }

    async function authenticate() {
      const input = document.getElementById('auth-token');
      const t = input.value.trim();
      if (!t) return;

      try {
        const res = await fetch(API_BASE + '/status', {
          headers: { 'Authorization': 'Bearer ' + t }
        });
        if (!res.ok) throw new Error('Invalid token');

        token = t;
        setStoredToken(t);
        document.getElementById('auth-overlay').style.display = 'none';
        loadAll();
      } catch (e) {
        document.getElementById('auth-error').textContent = 'Authentication failed. Check your token.';
        document.getElementById('auth-error').style.display = 'block';
      }
    }

    async function checkAuth() {
      const stored = getStoredToken();
      if (!stored) {
        document.getElementById('auth-overlay').style.display = 'flex';
        return;
      }

      try {
        const res = await fetch(API_BASE + '/status', {
          headers: { 'Authorization': 'Bearer ' + stored }
        });
        if (!res.ok) throw new Error();
        token = stored;
        loadAll();
      } catch {
        document.getElementById('auth-overlay').style.display = 'flex';
      }
    }

    // ─── API Helpers ────────────────────────────────────────────
    async function apiFetch(path, opts = {}) {
      const res = await fetch(API_BASE + path, {
        ...opts,
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/json',
          ...(opts.headers || {}),
        },
      });
      if (res.status === 401) {
        token = '';
        setStoredToken('');
        document.getElementById('auth-overlay').style.display = 'flex';
        throw new Error('Unauthorized');
      }
      return res.json();
    }

    function setMachineActionState(key, value) {
      machineActionState[key] = value;
      renderMachineActionState();
    }

    function renderMachineActionState() {
      for (const [key, value] of Object.entries(machineActionState)) {
        document.querySelectorAll('[data-machine-action="' + key + '"]').forEach((el) => {
          el.disabled = !!value;
          if (value) {
            el.dataset.originalLabel = el.dataset.originalLabel || el.textContent;
            el.textContent = value;
          } else if (el.dataset.originalLabel) {
            el.textContent = el.dataset.originalLabel;
          }
        });
      }
    }

    async function fetchMachineLaunchData(sandboxId) {
      const result = await apiFetch('/sandboxes/' + encodeURIComponent(sandboxId) + '/proxy-token', { method: 'POST' });
      if (result.error) throw new Error(result.error);
      return result;
    }

    async function openMachineTarget(sandboxId, kind) {
      const actionKey = kind + ':' + sandboxId;
      try {
        setMachineActionState(actionKey, 'Opening...');
        const data = await fetchMachineLaunchData(sandboxId);
        const baseUrl = kind === 'terminal' ? data.terminal_url : data.proxy_url;
        if (!baseUrl || !data.token) throw new Error('Machine URL not available yet');
        const url = new URL(baseUrl);
        url.searchParams.set('__proxy_token', data.token);
        window.open(url.toString(), '_blank', 'noopener,noreferrer');
        showToast((kind === 'terminal' ? 'Terminal' : 'Proxy') + ' opened', 'success');
      } catch (e) {
        showToast('Failed to open machine: ' + (e.message || e), 'error');
      } finally {
        setMachineActionState(actionKey, '');
      }
    }

    async function copyMachineSshCommand(sandboxId) {
      const actionKey = 'ssh:' + sandboxId;
      try {
        setMachineActionState(actionKey, 'Copying...');
        const data = await apiFetch('/sandboxes/' + encodeURIComponent(sandboxId));
        if (data.error) throw new Error(data.error);
        const detail = data.provider_detail || {};
        const sshCommand =
          detail?.connect?.ssh_command ||
          detail?.ssh?.command ||
          detail?.connect?.setup_command ||
          detail?.ssh?.setup_command ||
          detail?.ssh_key?.setup_command ||
          null;
        if (!sshCommand) throw new Error('SSH command not available for this machine');
        await navigator.clipboard.writeText(sshCommand);
        showToast('SSH command copied', 'success');
      } catch (e) {
        showToast('Failed to copy SSH command: ' + (e.message || e), 'error');
      } finally {
        setMachineActionState(actionKey, '');
      }
    }

    // ─── Data Loading ───────────────────────────────────────────
    async function loadAll() {
      await Promise.all([loadSchema(), loadEnv(), loadHealth()]);
      renderCredentials();
      loadInstances();
      loadStatus();
    }

    async function loadSchema() {
      schema = await apiFetch('/schema');
    }

    async function loadEnv() {
      envData = await apiFetch('/env');
    }

    async function loadHealth() {
      try {
        const health = await apiFetch('/health');
        updateDot('dot-api', health.api?.ok);
        updateDot('dot-docker', health.docker?.ok);
        updateDot('dot-sandbox', health.sandbox?.ok);
      } catch {
        updateDot('dot-api', false);
        updateDot('dot-docker', null);
        updateDot('dot-sandbox', null);
      }
    }

    function updateDot(id, ok) {
      const dot = document.getElementById(id);
      dot.className = 'status-dot ' + (ok === true ? 'ok' : ok === false ? 'err' : 'warn');
    }

    // ─── Credentials Rendering ──────────────────────────────────
    function renderCredentials() {
      const container = document.getElementById('credentials-container');
      let html = '';

      for (const [groupId, group] of Object.entries(schema)) {
        const configuredCount = group.keys.filter(k => envData.configured[k.key]).length;
        const totalCount = group.keys.length;
        const allConfigured = configuredCount === totalCount;

        html += '<div class="card" id="card-' + escapeHtml(groupId) + '">';
        html += '<div class="card-header" onclick="toggleCard(\\'' + escapeHtml(groupId) + '\\')">';
        html += '<div><h3>' + escapeHtml(group.title) + '</h3></div>';
        html += '<div style="display:flex;align-items:center;gap:8px;">';
        html += '<span class="badge ' + (allConfigured ? 'configured' : '') + '">' + configuredCount + '/' + totalCount + '</span>';
        html += '<span class="chevron">&#9660;</span>';
        html += '</div></div>';
        html += '<div class="card-body">';
        html += '<div class="card-desc">' + escapeHtml(group.description || '') + '</div>';

        for (const k of group.keys) {
          const isSet = envData.configured[k.key];
          const masked = envData.masked[k.key] || '';
          html += '<div class="key-row">';
          html += '<label title="' + escapeHtml(k.key) + '">' + escapeHtml(k.key);
          if (k.helpUrl) {
            html += ' <a href="' + escapeHtml(k.helpUrl) + '" target="_blank" rel="noopener noreferrer" class="key-help">?</a>';
          }
          html += '</label>';
          html += '<input type="text" id="key-' + escapeHtml(k.key) + '" placeholder="' + escapeHtml(isSet ? masked : 'Not set') + '" oninput="markDirty(\\'' + escapeHtml(k.key) + '\\')" />';
          html += '<span class="key-status ' + (isSet ? 'set' : 'unset') + '">' + (isSet ? '&#10003;' : '&#8212;') + '</span>';
          html += '</div>';
        }

        html += '</div></div>';
      }

      container.innerHTML = html;
    }

    function toggleCard(id) {
      const card = document.getElementById('card-' + id);
      card.classList.toggle('open');
    }

    function markDirty(key) {
      const input = document.getElementById('key-' + key);
      const val = input.value.trim();
      if (val) {
        dirtyKeys[key] = val;
      } else {
        delete dirtyKeys[key];
      }
      document.getElementById('save-btn').disabled = Object.keys(dirtyKeys).length === 0;
    }

    async function saveCredentials() {
      if (Object.keys(dirtyKeys).length === 0) return;

      const btn = document.getElementById('save-btn');
      const msg = document.getElementById('save-msg');
      btn.disabled = true;
      btn.textContent = 'Saving...';
      msg.textContent = '';

      try {
        const result = await apiFetch('/env', {
          method: 'POST',
          body: JSON.stringify({ keys: { ...dirtyKeys } }),
        });

        if (result.ok) {
          dirtyKeys = {};
          msg.textContent = 'Saved successfully';
          msg.className = 'save-msg';
          showToast('Credentials saved', 'success');
          // Reload env data to reflect changes
          await loadEnv();
          renderCredentials();
        } else {
          throw new Error(result.error || 'Save failed');
        }
      } catch (e) {
        msg.textContent = e.message;
        msg.className = 'save-msg error';
        showToast('Save failed: ' + e.message, 'error');
      }

      btn.textContent = 'Save Changes';
      btn.disabled = Object.keys(dirtyKeys).length === 0;
    }

    // ─── Instances Rendering ────────────────────────────────────
    async function loadInstances() {
      const container = document.getElementById('instances-container');
      try {
        const data = await apiFetch('/sandboxes?limit=100');
        if (!data.sandboxes || data.sandboxes.length === 0) {
          container.innerHTML = '<div class="empty-state">No machines found.</div>';
          return;
        }

        let html = '<table class="instances-table"><thead><tr>';
        html += '<th>Name</th><th>Owner</th><th>Provider</th><th>Status</th><th>Access</th><th>Created</th>';
        html += '</tr></thead><tbody>';

        for (const inst of data.sandboxes) {
          const statusClass = inst.status === 'active' || inst.status === 'ready' ? 'active' :
                              inst.status === 'stopped' ? 'stopped' :
                              inst.status === 'archived' ? 'archived' : 'error';
          const ownerLabel = inst.ownerEmail || inst.accountName || inst.accountId || '-';
          const canLaunch = inst.provider === 'justavps';
          html += '<tr>';
          html += '<td title="' + escapeHtml(inst.sandboxId || '') + '"><div style="font-weight:600;font-family:var(--font);">' + escapeHtml(inst.name || (inst.sandboxId || '').slice(0, 8)) + '</div><div style="color:var(--text-dim);font-size:11px;">' + escapeHtml(inst.externalId || inst.sandboxId || '-') + '</div></td>';
          html += '<td title="' + escapeHtml(ownerLabel) + '">' + escapeHtml(ownerLabel) + '</td>';
          html += '<td>' + escapeHtml(inst.provider || '-') + '</td>';
          html += '<td><span class="status-badge ' + statusClass + '">' + escapeHtml(inst.status || 'unknown') + '</span></td>';
          html += '<td><div class="btn-row">';
          html += '<button class="btn btn-small" data-machine-action="terminal:' + escapeHtml(inst.sandboxId) + '" onclick="openMachineTarget(\'' + escapeHtml(inst.sandboxId) + '\', \'terminal\')"' + (canLaunch ? '' : ' disabled') + '>Open Terminal</button>';
          html += '<button class="btn btn-small" data-machine-action="proxy:' + escapeHtml(inst.sandboxId) + '" onclick="openMachineTarget(\'' + escapeHtml(inst.sandboxId) + '\', \'proxy\')"' + (canLaunch ? '' : ' disabled') + '>Open Proxy</button>';
          html += '<button class="btn btn-small" data-machine-action="ssh:' + escapeHtml(inst.sandboxId) + '" onclick="copyMachineSshCommand(\'' + escapeHtml(inst.sandboxId) + '\')">Copy SSH</button>';
          html += '</div></td>';
          html += '<td>' + new Date(inst.createdAt).toLocaleDateString() + '</td>';
          html += '</tr>';
        }

        html += '</tbody></table>';
        container.innerHTML = html;
        renderMachineActionState();
      } catch (e) {
        container.innerHTML = '<div class="empty-state">Failed to load machines: ' + escapeHtml(e.message || e) + '</div>';
      }
    }

    // ─── Status Rendering ───────────────────────────────────────
    async function loadStatus() {
      const container = document.getElementById('status-container');
      try {
        const data = await apiFetch('/status');
        let html = '<div class="status-grid">';

        const items = [
          ['Mode', data.envMode],
          ['Environment', data.internalEnv],
          ['Port', data.port],
          ['Sandbox Version', data.sandboxVersion],
          ['Providers', (data.allowedProviders || []).join(', ')],
          ['Scheduler', data.schedulerEnabled ? 'Enabled' : 'Disabled'],
          ['Channels', data.channelsEnabled ? 'Enabled' : 'Disabled'],
          ['Billing', data.billingEnabled ? 'Enabled' : 'Disabled'],
          ['Daytona', data.daytonaEnabled ? 'Enabled' : 'Disabled'],
          ['Local Docker', data.localDockerEnabled ? 'Enabled' : 'Disabled'],
          ['Database', data.databaseConfigured ? 'Configured' : 'Not Set'],
          ['Supabase', data.supabaseConfigured ? 'Configured' : 'Not Set'],
          ['Stripe', data.stripeConfigured ? 'Configured' : 'Not Set'],
        ];

        for (const [label, value] of items) {
          html += '<div class="status-item"><div class="label">' + escapeHtml(label) + '</div><div class="value">' + escapeHtml(value) + '</div></div>';
        }

        html += '</div>';
        container.innerHTML = html;
      } catch (e) {
        container.innerHTML = '<div class="empty-state">Failed to load status: ' + e.message + '</div>';
      }
    }

    // ─── Tab Switching ──────────────────────────────────────────
    function switchTab(tab) {
      activeTab = tab;
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
      document.querySelector('.tab[onclick*="' + tab + '"]').classList.add('active');
      document.getElementById('section-' + tab).classList.add('active');
    }

    // ─── Toast ──────────────────────────────────────────────────
    function showToast(msg, type) {
      const toast = document.getElementById('toast');
      toast.textContent = msg;
      toast.className = 'toast show ' + (type || '');
      setTimeout(() => { toast.className = 'toast'; }, 3000);
    }

    // ─── Init ───────────────────────────────────────────────────
    checkAuth();
  </script>
</body>
</html>`;
}
