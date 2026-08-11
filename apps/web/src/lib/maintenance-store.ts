/**
 * Maintenance configuration store.
 *
 * Production reads and writes use Vercel Edge Config. This keeps maintenance
 * control available when the dosco API or production database is unavailable.
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

const AUTOMATIC_MAINTENANCE: MaintenanceConfig = {
  ...DEFAULT_CONFIG,
  level: 'blocking',
  title: 'Service maintenance',
  message: 'dosco is temporarily unavailable. Service will resume automatically.',
};

const EDGE_CONFIG_KEY = 'maintenance_config';

let edgeClient: EdgeConfigClient | null = null;
let memoryStore: MaintenanceConfig = { ...DEFAULT_CONFIG };

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

async function readEdgeConfig(): Promise<MaintenanceConfig | null> {
  const client = getEdgeClient();
  if (!client) return null;
  return (await client.get<MaintenanceConfig>(EDGE_CONFIG_KEY)) ?? null;
}

async function writeEdgeConfig(config: MaintenanceConfig): Promise<MaintenanceConfig> {
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
          key: EDGE_CONFIG_KEY,
          value: config,
        },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Edge Config write failed (${response.status}): ${body}`);
  }

  const persisted = await getEdgeClient()?.get<MaintenanceConfig>(EDGE_CONFIG_KEY, {
    consistentRead: true,
  });
  if (!persisted || persisted.updatedAt !== config.updatedAt) {
    throw new Error('Edge Config write verification failed');
  }

  return persisted;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const CONFIG_TTL_MS = 5_000;
let cachedConfig: { value: MaintenanceConfig; expiresAt: number } | null = null;
let inFlight: Promise<MaintenanceConfig> | null = null;

function invalidateMaintenanceCache(): void {
  cachedConfig = null;
  inFlight = null;
}

/** Test-only. Clears the TTL cache so each test starts from a cold cache. */
export function __resetMaintenanceCacheForTests(): void {
  invalidateMaintenanceCache();
}

/**
 * Middleware calls getMaintenanceConfig() on every non-public request, and in
 * the App Router every client-side navigation is an RSC request that runs
 * middleware. Uncached, that put a `no-store` fetch (2s timeout ceiling) plus an
 * Edge Config read on the critical path of EVERY page-to-page transition.
 *
 * A 5s TTL takes that off the critical path without making the flag unusable:
 * staleness is bounded to <=5s per runtime instance, everywhere — including
 * immediately after an admin toggle. setMaintenanceConfig() does call
 * invalidateMaintenanceCache(), but that only clears the cache in the process
 * that handled the write: the Node runtime, via
 * app/(system)/api/maintenance/route.ts. It cannot reach the cache that
 * matters for navigation, which lives in middleware.ts — a separate bundle
 * Next.js compiles for the Edge runtime, replicated per POP. The 5s TTL, not
 * the invalidation, is the real bound on admin-toggle latency.
 *
 * `inFlight` coalesces: a burst of concurrent navigations on a cold cache shares
 * one upstream read instead of issuing one each.
 */
export async function getMaintenanceConfig(): Promise<MaintenanceConfig> {
  // The memory-store path does no I/O, so caching it would only add staleness.
  if (!process.env.EDGE_CONFIG) return { ...memoryStore };

  if (cachedConfig && cachedConfig.expiresAt > Date.now()) return cachedConfig.value;
  if (inFlight) return inFlight;

  inFlight = readMaintenanceConfig()
    .then((config) => {
      cachedConfig = { value: config, expiresAt: Date.now() + CONFIG_TTL_MS };
      return config;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

/**
 * Read the database first. Reconcile Edge Config after every successful
 * database read. Use blocking Edge Config only when the API is unavailable.
 */
async function readMaintenanceConfig(): Promise<MaintenanceConfig> {
  try {
    const databaseConfig = await sdkGetMaintenanceConfig<MaintenanceConfig>({
      backendUrl: backendUrl(),
      cache: 'no-store',
      signal: AbortSignal.timeout(2_000),
    });
    const edgeConfig = await readEdgeConfig().catch(() => null);
    if (JSON.stringify(edgeConfig) !== JSON.stringify(databaseConfig)) {
      await writeEdgeConfig(databaseConfig).catch((error) => {
        console.error('[maintenance-store] Edge Config reconciliation failed:', error);
      });
    }
    return databaseConfig;
  } catch (databaseError) {
    console.warn('[maintenance-store] database read failed:', databaseError);
    const edgeConfig = await readEdgeConfig().catch((edgeError) => {
      console.error('[maintenance-store] Edge Config fallback failed:', edgeError);
      return null;
    });
    if (edgeConfig?.level === 'blocking') return edgeConfig;
    // Fail open: when the API is temporarily unavailable (deploy, blip, GC
    // pause) and Edge Config doesn't have a blocking level, return normal
    // operation instead of activating automatic maintenance. A blocking
    // lockdown should only be triggerable by an explicit admin action,
    // not by a transient API/network failure.
    return { ...DEFAULT_CONFIG, updatedAt: new Date().toISOString() };
  }
}

/**
 * Return only the independent Edge Config state for the Cloudflare write gate.
 */
export async function getEdgeMaintenanceConfig(): Promise<MaintenanceConfig> {
  if (!process.env.EDGE_CONFIG) return { ...memoryStore };

  try {
    return (
      (await readEdgeConfig()) ?? {
        ...AUTOMATIC_MAINTENANCE,
        updatedAt: new Date().toISOString(),
      }
    );
  } catch (error) {
    console.error('[maintenance-store] independent Edge Config read failed:', error);
    return { ...AUTOMATIC_MAINTENANCE, updatedAt: new Date().toISOString() };
  }
}

/**
 * Write the database first. Then write the exact saved value to Edge Config.
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
  await writeEdgeConfig(saved);
  invalidateMaintenanceCache();
  return saved;
}
