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

const AUTOMATIC_MAINTENANCE: MaintenanceConfig = {
  ...DEFAULT_CONFIG,
  level: 'blocking',
  title: 'Service maintenance',
  message: 'Kortix is temporarily unavailable. Service will resume automatically.',
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

/**
 * Read the database first. Reconcile Edge Config after every successful
 * database read. Use blocking Edge Config only when the API is unavailable.
 */
export async function getMaintenanceConfig(): Promise<MaintenanceConfig> {
  if (!process.env.EDGE_CONFIG) return { ...memoryStore };

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
    return { ...AUTOMATIC_MAINTENANCE, updatedAt: new Date().toISOString() };
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
    return { ...memoryStore };
  }

  const saved = await sdkSetMaintenanceConfig<MaintenanceConfig>(config, {
    backendUrl: backendUrl(),
    accessToken,
  });
  await writeEdgeConfig(saved);
  return saved;
}
