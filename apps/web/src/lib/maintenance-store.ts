/**
 * Maintenance configuration store.
 *
 * Backed by the Kortix API + database (kortix.platform_settings), NOT Vercel
 * Edge Config. Reads hit the public `GET /v1/system/maintenance`; writes hit the
 * admin-only `PUT /v1/system/maintenance` (the API enforces the admin role).
 * Set it from the admin panel at /admin/utils.
 */

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

function backendUrl(): string {
  return (
    process.env.BACKEND_URL ||
    process.env.NEXT_PUBLIC_BACKEND_URL ||
    'http://localhost:8008/v1'
  ).replace(/\/$/, '');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Read the current maintenance configuration (public). */
export async function getMaintenanceConfig(): Promise<MaintenanceConfig> {
  try {
    const res = await fetch(`${backendUrl()}/system/maintenance`, { cache: 'no-store' });
    if (!res.ok) return { ...DEFAULT_CONFIG };
    const config = (await res.json()) as MaintenanceConfig | null;
    return config ?? { ...DEFAULT_CONFIG };
  } catch (err) {
    console.warn('[maintenance-store] read failed, using defaults:', err);
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Write maintenance configuration. Requires the caller's Supabase access token —
 * the API enforces the admin role on `PUT /v1/system/maintenance`.
 */
export async function setMaintenanceConfig(
  config: MaintenanceConfig,
  accessToken: string,
): Promise<MaintenanceConfig> {
  const res = await fetch(`${backendUrl()}/system/maintenance`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(config),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`maintenance write failed (${res.status}): ${body}`);
  }
  return (await res.json()) as MaintenanceConfig;
}
