/**
 * Platform API client — shared sandbox types and port constants.
 */

// ─── Sandbox Port Constants ──────────────────────────────────────────────────

/**
 * Well-known container ports exposed by the sandbox image.
 * These are the ports INSIDE the container — Docker maps them to random host ports.
 */
export const SANDBOX_PORTS = {
  DESKTOP: '6080',
  DESKTOP_HTTPS: '6081',
  PRESENTATION_VIEWER: '3210',
  STATIC_FILE_SERVER: '3211',
  KORTIX_MASTER: '8000',
  BROWSER_STREAM: '9223',
  BROWSER_VIEWER: '9224',
  SSH: '22',
} as const;

// ─── Types ───────────────────────────────────────────────────────────────────

export type SandboxProviderName = 'managed' | 'daytona' | 'justavps';
export type ServerTypeOption = string;

export interface SandboxCreateProgress {
  status: 'pulling';
  progress: number;
  message: string;
}

export interface SandboxInfo {
  sandbox_id: string;
  external_id: string;
  name: string;
  provider: SandboxProviderName;
  base_url: string;
  status: string;
  lifecycle_status?: string;
  init_status?: 'pending' | 'provisioning' | 'retrying' | 'ready' | 'failed';
  health_status?: 'healthy' | 'degraded' | 'offline' | 'unknown';
  init_attempts?: number;
  last_init_error?: string | null;
  version?: string | null;
  metadata?: Record<string, unknown>;
  is_included?: boolean;
  stripe_subscription_id?: string | null;
  stripe_subscription_item_id?: string | null;
  cancel_at_period_end?: boolean;
  cancel_at?: string | null;
  auto_update_enabled?: boolean;
  auto_update_channel?: 'stable' | 'dev';
  auto_update?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  /** True when the current viewer is the account owner (or a platform admin) — gates rename/manage UI. */
  can_manage?: boolean;
}

export interface ProvidersInfo {
  providers: SandboxProviderName[];
  default: SandboxProviderName;
}
