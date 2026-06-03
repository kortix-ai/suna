/**
 * Provisioning stage constants for mobile — mirrors the frontend's definitions.
 *
 * Source of truth: apps/frontend/src/lib/provisioning-stages.ts
 */

export interface ProvisioningStageInfo {
  id: string;
  progress: number;
  message: string;
}

/** Shorter labels for the progress UI */
export const STAGE_LABELS: Record<string, string> = {
  server_creating:    'Spinning up your machine',
  server_created:     'Machine ready, configuring',
  cloud_init_running: 'Installing dependencies',
  cloud_init_done:    'Environment configured',
  services_starting:  'Starting workspace services',
  services_ready:     'Waiting for services to come online',
  connecting:         'Connecting to workspace',
  verifying_opencode: 'Verifying workspace is ready',
} as const;

/** Numeric progress lookup (stage → percentage) */
export const STAGE_PROGRESS_MAP: Record<string, number> = {
  server_creating:    5,
  server_created:     15,
  cloud_init_running: 35,
  cloud_init_done:    60,
  services_starting:  80,
  services_ready:     95,
  verifying_opencode: 98,
  connecting:         99,
};

/** Expected ms each stage lasts — used for time-based interpolation */
export const STAGE_DURATION_MS: Record<string, number> = {
  server_creating:    20_000,
  server_created:     30_000,
  cloud_init_running: 60_000,
  cloud_init_done:    30_000,
  services_starting:  20_000,
  services_ready:     180_000,
  verifying_opencode: 180_000,
  connecting:         15_000,
};
