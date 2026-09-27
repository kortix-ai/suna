/**
 * Maintenance configuration store.
 *
 * Production reads and writes use Vercel Edge Config. This keeps maintenance
 * control available when the Kortix API or production database is unavailable.
 * Local development uses an in-memory store.
 */

import {
  getMaintenanceConfig as sdkGetMaintenanceConfig,
  setMaintenanceConfig as sdkSetMaintenanceConfig,
} from '@kortix/sdk';
import { createClient, type EdgeConfigClient } from '@vercel/edge-config';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MaintenanceLevel = 'none' | 'info' | 'warning' | 'critical' | 'blocking';

export interface MaintenanceConfig {
  /** Current maintenance level */
  level: MaintenanceLevel;
  /** Short title shown in the banner / maintenance page */
  title: string;
  /** Longer description / message body */
  message: string;
  /** Optional: scheduled start time (ISO 8601) */
  startTime?: string | null;
  /** Optional: scheduled end time (ISO 8601) */
  endTime?: string | null;
  /** Optional: link to a status page */
  statusUrl?: string | null;
  /** Optional: list of affected service names */
  affectedServices?: string[];
  /** ISO 8601 timestamp of last update */
  updatedAt: string;
}

const DEFAULT_CONFIG: MaintenanceConfig = {
  level: 'none',
  title: '',
  message: '',
  updatedAt: new Date(0).toISOString(),
};

/**
 * The environment this deployment's maintenance state belongs to.
 *
 * dev, staging and prod share ONE Vercel Edge Config store (the same
 * `EDGE_CONFIG` / `EDGE_CONFIG_ID` sit in `apps/web/.env.dev`, `.env.staging`
 * and `.env.prod`). A single constant key therefore made the three
 * environments overwrite each other's state, and the prod api-router Worker
 * read whatever environment wrote last — a `blocking` set on staging could
 * lock production writes. Each environment now owns `maintenance_config_<env>`.
 */
export type MaintenanceEnvironment = 'prod' | 'staging' | 'dev';

/**
 * The environment is derived from the API host the deployment talks to. It
 * is set on every surface that has an Edge Config (Vercel prod + staging,
 * ECS dev/staging/prod — `infra/scripts/render-web-env.mjs` pins it per
 * environment) and it is the right owner by construction: the maintenance
 * state lives in that API's database. `VERCEL_ENV` cannot tell staging apart
 * from a preview (staging deploys with `--target preview`).
 */
const BACKEND_HOST_ENVIRONMENT: Readonly<Record<string, MaintenanceEnvironment>> = {
  'api.kortix.com': 'prod',
  'staging-api.kortix.com': 'staging',
  'dev-api.kortix.com': 'dev',
};

const EDGE_CONFIG_KEY_PREFIX = 'maintenance_config_';

function runtimeEnv(key: string): string | undefined {
  // Dynamic read: the standalone container must see ECS runtime values, not a
  // build-time replacement (same reason as WEB_PROTECTION_* in middleware.ts).
  const value = Reflect.get(process.env, key);
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Returns null when the API host is unknown or missing. Callers treat null as
 * "this deployment owns no maintenance key": never read or write another
 * environment's key, and report normal operation (fail open).
 */
export function resolveMaintenanceEnvironment(): MaintenanceEnvironment | null {
  const candidates = [
    runtimeEnv('BACKEND_URL'),
    runtimeEnv('KORTIX_PUBLIC_BACKEND_URL'),
    process.env.NEXT_PUBLIC_BACKEND_URL,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    let host: string;
    try {
      host = new URL(candidate).hostname.toLowerCase();
    } catch {
      continue;
    }
    return BACKEND_HOST_ENVIRONMENT[host] ?? null;
  }
  return null;
}

export function maintenanceEdgeConfigKey(
  environment: MaintenanceEnvironment | null = resolveMaintenanceEnvironment(),
): string | null {
  return environment ? `${EDGE_CONFIG_KEY_PREFIX}${environment}` : null;
}

let edgeClient: EdgeConfigClient | null = null;
let memoryStore: MaintenanceConfig = { ...DEFAULT_CONFIG };
/**
 * The last value `getEdgeMaintenanceConfig` actually read out of Edge Config,
 * per key. It exists so a transient read failure can serve the state an admin
 * really set instead of inventing one. Per runtime instance; a cold instance
 * has none and falls back to normal operation.
 */
const lastKnownEdgeConfig = new Map<string, MaintenanceConfig>();

function getEdgeClient(): EdgeConfigClient | null {
  if (edgeClient) return edgeClient;
  const connectionString = process.env.EDGE_CONFIG;
  if (!connectionString) return null;
  edgeClient = createClient(connectionString);
  return edgeClient;
}

function backendUrl(): string {
  return (
    process.env.BACKEND_URL ||
    process.env.NEXT_PUBLIC_BACKEND_URL ||
    'http://localhost:8008/v1'
  ).replace(/\/$/, '');
}

async function readEdgeConfig(key: string): Promise<MaintenanceConfig | null> {
  const client = getEdgeClient();
  if (!client) return null;
  return (await client.get<MaintenanceConfig>(key)) ?? null;
}

async function writeEdgeConfig(key: string, config: MaintenanceConfig): Promise<MaintenanceConfig> {
  const edgeConfigId = process.env.EDGE_CONFIG_ID;
  const vercelToken = process.env.VERCEL_API_TOKEN;
  if (!edgeConfigId || !vercelToken) {
    throw new Error('Edge Config writes require EDGE_CONFIG_ID and VERCEL_API_TOKEN');
  }

  const response = await fetch(`https://api.vercel.com/v1/edge-config/${edgeConfigId}/items`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${vercelToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      items: [
        {
          operation: 'upsert',
          key,
          value: config,
        },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Edge Config write failed (${response.status}): ${body}`);
  }

  const persisted = await getEdgeClient()?.get<MaintenanceConfig>(key, {
    consistentRead: true,
  });
  if (!persisted || persisted.updatedAt !== config.updatedAt) {
    throw new Error('Edge Config write verification failed');
  }

  return persisted;
}

/** Two configs describe the same admin state when level and updatedAt agree. */
export function sameMaintenanceState(
  a: Pick<MaintenanceConfig, 'level' | 'updatedAt'> | null | undefined,
  b: Pick<MaintenanceConfig, 'level' | 'updatedAt'> | null | undefined,
): boolean {
  if (!a || !b) return false;
  return a.level === b.level && a.updatedAt === b.updatedAt;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const CONFIG_TTL_MS = 5_000;
let cachedConfig: { key: string; value: MaintenanceConfig; expiresAt: number } | null = null;
let inFlight: { key: string; promise: Promise<MaintenanceConfig> } | null = null;

function invalidateMaintenanceCache(): void {
  cachedConfig = null;
  inFlight = null;
}

function normalOperation(): MaintenanceConfig {
  return { ...DEFAULT_CONFIG, updatedAt: new Date().toISOString() };
}

/** Test-only. Clears the last-known Edge Config values. */
export function __resetEdgeMaintenanceMemoryForTests(): void {
  lastKnownEdgeConfig.clear();
}

/** Test-only. Clears the TTL cache and the reconcile throttle. */
export function __resetMaintenanceCacheForTests(): void {
  invalidateMaintenanceCache();
  lastReconcileAt = 0;
  reconcileInFlight = null;
}

/**
 * The maintenance state for the request path (middleware, `GET
 * /api/maintenance`). Reads THIS environment's Edge Config key and nothing
 * else: no API/database read and no Vercel API write ever happen here.
 *
 * It used to read the database first (2 s timeout) and PATCH Edge Config
 * through the Vercel API whenever the two differed. With one key shared by
 * three environments they always differed, so every refresh in every
 * environment wrote — `Edge Config write failed (429) rate_limited` and
 * `database read failed: TimeoutError` inside middleware, on user navigations.
 * The database → Edge Config sync now runs only on the admin write path
 * (`setMaintenanceConfig`) and in `reconcileMaintenanceEdgeConfig`, which the
 * `/api/maintenance` route schedules after its response.
 *
 * The 5 s TTL still bounds reads per runtime instance (middleware runs on
 * every RSC navigation). `inFlight` coalesces a cold-cache burst into one read.
 */
export async function getMaintenanceConfig(): Promise<MaintenanceConfig> {
  // The memory-store path does no I/O, so caching it would only add staleness.
  if (!process.env.EDGE_CONFIG) return { ...memoryStore };

  const key = maintenanceEdgeConfigKey();
  if (!key) return normalOperation();

  if (cachedConfig && cachedConfig.key === key && cachedConfig.expiresAt > Date.now()) {
    return cachedConfig.value;
  }
  if (inFlight && inFlight.key === key) return inFlight.promise;

  const promise = getEdgeMaintenanceConfig()
    .then((config) => {
      cachedConfig = { key, value: config, expiresAt: Date.now() + CONFIG_TTL_MS };
      return config;
    })
    .finally(() => {
      if (inFlight?.promise === promise) inFlight = null;
    });
  inFlight = { key, promise };
  return promise;
}

/**
 * Return only the independent Edge Config state for the Cloudflare write gate
 * (`infra/cloudflare/workers/api-router`, `MAINTENANCE_STATE_URL`).
 *
 * FAILS OPEN. This function used to return a synthetic `blocking` config
 * whenever the Edge Config read returned nothing or threw. The api-router
 * worker reads this route, sees `level: 'blocking'`, and answers EVERY
 * non-read-only request to `api.kortix.com` with a 503 carrying that config's
 * `message`. So a missing key — or one failed network call from a Vercel
 * instance to Edge Config — locked production writes (Better Stack, Kortix
 * Frontend prod: 1,000+ occurrences). Nothing an admin did produced it.
 *
 * - No environment (unknown API host): this deployment owns no key -> `none`.
 *   It never falls back to another environment's key or the legacy shared one.
 * - Key ABSENT (`readEdgeConfig()` resolves null): no admin state -> `none`.
 *   A fresh deploy starts here until the first admin write or reconcile.
 * - Read THREW: the state is unknown. Serve the last value this instance
 *   actually read for this key, so a genuine admin `blocking` survives a blip;
 *   with no such value (cold instance), fall back to normal operation.
 *
 * A lockdown that must hold even while Vercel is unreachable does not depend on
 * this path: the cutover workflow sets `MAINTENANCE_LEVEL_OVERRIDE=blocking`
 * directly on the worker (`.github/workflows/cutover-prod-us-east-2.yml`),
 * which is evaluated before the state URL is ever fetched.
 */
export async function getEdgeMaintenanceConfig(): Promise<MaintenanceConfig> {
  if (!process.env.EDGE_CONFIG) return { ...memoryStore };

  const key = maintenanceEdgeConfigKey();
  if (!key) return normalOperation();

  try {
    const config = await readEdgeConfig(key);
    if (config) {
      lastKnownEdgeConfig.set(key, config);
      return config;
    }
    return normalOperation();
  } catch (error) {
    console.error('[maintenance-store] independent Edge Config read failed:', error);
    return lastKnownEdgeConfig.get(key) ?? normalOperation();
  }
}

/**
 * The database state (the source of truth). Admin path only: the PUT route
 * merges partial updates onto it. Never called from middleware.
 */
export async function readDatabaseMaintenanceConfig(): Promise<MaintenanceConfig> {
  return sdkGetMaintenanceConfig<MaintenanceConfig>({
    backendUrl: backendUrl(),
    cache: 'no-store',
    signal: AbortSignal.timeout(2_000),
  });
}

const RECONCILE_INTERVAL_MS = 60_000;
let lastReconcileAt = 0;
let reconcileInFlight: Promise<void> | null = null;

/**
 * Converge this environment's Edge Config key on the database, off the
 * request path. Covers writes that bypass the web admin route (a direct
 * `PUT /v1/system/maintenance` against the API) and seeds an empty key after a
 * deploy. At most one pass per runtime instance per minute; writes only when
 * `level` or `updatedAt` differ, and only to this environment's key.
 * Never throws.
 */
export function reconcileMaintenanceEdgeConfig(): Promise<void> {
  if (!process.env.EDGE_CONFIG) return Promise.resolve();
  if (!process.env.EDGE_CONFIG_ID || !process.env.VERCEL_API_TOKEN) return Promise.resolve();
  const key = maintenanceEdgeConfigKey();
  if (!key) return Promise.resolve();
  if (reconcileInFlight) return reconcileInFlight;
  if (Date.now() - lastReconcileAt < RECONCILE_INTERVAL_MS) return Promise.resolve();
  lastReconcileAt = Date.now();

  reconcileInFlight = (async () => {
    try {
      const database = await readDatabaseMaintenanceConfig();
      const edge = await readEdgeConfig(key);
      if (sameMaintenanceState(edge, database)) return;
      await writeEdgeConfig(key, database);
      lastKnownEdgeConfig.set(key, database);
      invalidateMaintenanceCache();
    } catch (error) {
      console.warn('[maintenance-store] Edge Config reconcile skipped:', error);
    } finally {
      reconcileInFlight = null;
    }
  })();
  return reconcileInFlight;
}

/**
 * Write the database first. Then write the exact saved value to this
 * environment's Edge Config key.
 */
export async function setMaintenanceConfig(
  config: MaintenanceConfig,
  accessToken: string,
): Promise<MaintenanceConfig> {
  if (!process.env.EDGE_CONFIG) {
    memoryStore = { ...config };
    invalidateMaintenanceCache();
    return { ...memoryStore };
  }

  const saved = await sdkSetMaintenanceConfig<MaintenanceConfig>(config, {
    backendUrl: backendUrl(),
    accessToken,
  });
  const key = maintenanceEdgeConfigKey();
  if (key) {
    const persisted = await writeEdgeConfig(key, saved);
    lastKnownEdgeConfig.set(key, persisted);
  } else {
    console.warn(
      '[maintenance-store] no maintenance environment for this API host; Edge Config not written',
    );
  }
  invalidateMaintenanceCache();
  return saved;
}
