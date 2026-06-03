/**
 * Provisioning stage constants — single source of truth.
 *
 * Used by:
 *   - ProvisioningProgress component (instances/[id] page)
 *   - SelfHostedForm (self-hosted auth onboarding)
 */

export interface ProvisioningStageInfo {
  id: string;
  progress: number;
  message: string;
}

/** Shorter labels for the circular progress UI (instances/[id] page) */
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
