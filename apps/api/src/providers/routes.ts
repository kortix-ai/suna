/**
 * Provider routes — local mode only.
 *
 * Unified API for managing provider API keys. Replaces the flat
 * key-value approach from /v1/setup/env with a per-provider model
 * inspired by OpenCode's provider system.
 *
 * Mounted at /v1/providers/*
 */

import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { execSync } from 'child_process';
import { config } from '../config';
import { checkLocalSandboxHealth, type LocalSandboxHealthCheck } from '../platform/services/local-sandbox-health';
import {
  PROVIDER_REGISTRY,
  PROVIDER_BY_ID,
  ALL_SANDBOX_ENV_KEYS,
  type ProviderCategory,
} from './registry';

export const providersApp = new Hono<AppEnv>();

// ─── Helpers (shared with setup) ────────────────────────────────────────────

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

async function deleteSandboxEnv(keys: string[]): Promise<void> {
  for (const key of keys) {
    try {
      await fetchMasterJson(`/env/${key}`, {
        method: 'DELETE',
      }, 5000);
    } catch {
      // best-effort delete
    }
  }
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

function removeFromEnvFile(path: string, keysToRemove: string[]): void {
  if (!existsSync(path)) return;
  const content = readFileSync(path, 'utf-8');
  const lines = content.split('\n');
  const removeSet = new Set(keysToRemove);
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
    if (removeSet.has(key)) continue; // skip removed keys
    out.push(raw);
  }

  writeFileSync(path, out.join('\n') + '\n');
}

// ─── Provider Status Types ──────────────────────────────────────────────────

export interface ProviderStatus {
  id: string;
  name: string;
  category: ProviderCategory;
  description?: string;
  helpUrl?: string;
  connected: boolean;
  source: 'secretstore' | 'env' | 'none';
  maskedKeys: Record<string, string>;
}

// ─── Routes ─────────────────────────────────────────────────────────────────

/**
 * GET /v1/providers
 * List all providers with their connection status.
 */
providersApp.get('/', async (c) => {
  const repoRoot = findRepoRoot();

  // Build env map from the appropriate source
  let envMap: Record<string, string>;
  let sourceType: 'env' | 'secretstore';

  if (repoRoot) {
    // Dev/repo mode: merge root .env + core/docker/.env
    const rootEnv = parseEnvFile(resolve(repoRoot, '.env'));
    const sandboxEnv = parseEnvFile(resolve(repoRoot, 'core/docker/.env'));
    envMap = { ...rootEnv, ...sandboxEnv };
    sourceType = 'env';
  } else {
    // Docker/installed mode: read from sandbox secret store
    envMap = await getSandboxEnv();
    sourceType = 'secretstore';
  }

  const providers: ProviderStatus[] = PROVIDER_REGISTRY.map((def) => {
    const maskedKeys: Record<string, string> = {};
    let connected = false;

    for (const envKey of def.envKeys) {
      const val = envMap[envKey] || '';
      maskedKeys[envKey] = maskKey(val);
      if (val) connected = true;
    }

    return {
      id: def.id,
      name: def.name,
      category: def.category,
      description: def.description,
      helpUrl: def.helpUrl,
      connected,
      source: connected ? sourceType : 'none',
      maskedKeys,
    };
  });

  return c.json({ providers });
});

/**
 * GET /v1/providers/schema
 * Full provider registry for the frontend.
 */
providersApp.get('/schema', async (c) => {
  return c.json(PROVIDER_REGISTRY);
});

/**
 * PUT /v1/providers/:id/connect
 * Store API key(s) for a specific provider.
 */
providersApp.put('/:id/connect', async (c) => {
  const id = c.req.param('id');
  const provider = PROVIDER_BY_ID.get(id);
  if (!provider) {
    return c.json({ error: `Unknown provider: ${id}` }, 404);
  }

  const body = await c.req.json();
  const keys = body?.keys;
  if (!keys || typeof keys !== 'object') {
    return c.json({ error: 'Request body must contain a "keys" object' }, 400);
  }

  // Validate that all provided keys belong to this provider
  const validKeys = new Set(provider.envKeys);
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(keys)) {
    if (!validKeys.has(k)) {
      return c.json({ error: `Key "${k}" does not belong to provider "${id}"` }, 400);
    }
    if (typeof v !== 'string') continue;
    const trimmed = v.trim();
    if (!trimmed) continue;
    clean[k] = trimmed;
  }

  if (Object.keys(clean).length === 0) {
    return c.json({ error: 'No valid keys provided' }, 400);
  }

  const repoRoot = findRepoRoot();

  if (!repoRoot) {
    // Docker/installed mode: save to sandbox secret store
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

  // Dev/repo mode: write to .env files
  const rootEnvPath = resolve(repoRoot, '.env');
  if (!existsSync(rootEnvPath)) {
    const examplePath = resolve(repoRoot, '.env.example');
    if (existsSync(examplePath)) {
      writeFileSync(rootEnvPath, readFileSync(examplePath, 'utf-8'));
    } else {
      writeFileSync(rootEnvPath, '# Kortix Environment Configuration\nENV_MODE=local\n');
    }
  }

  const rootData: Record<string, string> = { ...clean, ENV_MODE: 'local', ALLOWED_SANDBOX_PROVIDERS: 'local_docker' };
  writeEnvFile(rootEnvPath, rootData);

  // Also write to core/docker/.env for keys that should be in the sandbox
  const sandboxData: Record<string, string> = {};
  for (const [key, val] of Object.entries(clean)) {
    if (ALL_SANDBOX_ENV_KEYS.has(key)) {
      sandboxData[key] = val;
    }
  }

  if (Object.keys(sandboxData).length > 0) {
    const sandboxEnvPath = resolve(repoRoot, 'core/docker/.env');
    mkdirSync(dirname(sandboxEnvPath), { recursive: true });
    if (!existsSync(sandboxEnvPath)) {
      const examplePath = resolve(repoRoot, 'core/docker/.env.example');
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
  }

  // Run setup-env.sh to distribute to per-service .env files
  try {
    execSync('bash scripts/setup-env.sh', { cwd: repoRoot, stdio: 'pipe', timeout: 15000 });
  } catch (e: any) {
    console.error('[providers] setup-env.sh failed:', e.message);
  }

  return c.json({ ok: true });
});

/**
 * DELETE /v1/providers/:id/disconnect
 * Remove stored API key(s) for a specific provider.
 */
providersApp.delete('/:id/disconnect', async (c) => {
  const id = c.req.param('id');
  const provider = PROVIDER_BY_ID.get(id);
  if (!provider) {
    return c.json({ error: `Unknown provider: ${id}` }, 404);
  }

  const repoRoot = findRepoRoot();

  if (!repoRoot) {
    // Docker/installed mode: delete from sandbox secret store
    try {
      await deleteSandboxEnv(provider.envKeys);
      return c.json({ ok: true });
    } catch (e: any) {
      return c.json(
        { ok: false, error: 'Failed to remove configuration', details: e?.message || String(e) },
        500,
      );
    }
  }

  // Dev/repo mode: remove from .env files
  const rootEnvPath = resolve(repoRoot, '.env');
  removeFromEnvFile(rootEnvPath, provider.envKeys);

  const sandboxEnvPath = resolve(repoRoot, 'core/docker/.env');
  removeFromEnvFile(sandboxEnvPath, provider.envKeys);

  // Re-run setup-env.sh
  try {
    execSync('bash scripts/setup-env.sh', { cwd: repoRoot, stdio: 'pipe', timeout: 15000 });
  } catch (e: any) {
    console.error('[providers] setup-env.sh failed:', e.message);
  }

  return c.json({ ok: true });
});

/**
 * GET /v1/providers/health
 * Health check of local services.
 */
providersApp.get('/health', async (c) => {
  const repoRoot = findRepoRoot();
  const checks: Record<string, LocalSandboxHealthCheck> = {};

  checks.api = { ok: true };

  if (!repoRoot) {
    // Docker mode: check sandbox via HTTP
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
