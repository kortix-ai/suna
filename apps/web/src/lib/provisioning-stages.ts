/**
 * Provisioning stage constants — single source of truth.
 *
 * Used by:
 *   - ProvisioningProgress component (instances/[id] page)
 *   - SelfHostedForm (self-hosted auth onboarding)
 *   - useSandboxPoller hook
 */

export interface ProvisioningStageInfo {
  id: string;
  progress: number;
  message: string;
}

/** Stage ID → { progress %, human-readable message } */
export const STAGE_PROGRESS: Record<string, { progress: number; message: string }> = {
  server_creating:   { progress: 5,   message: 'Creating server...' },
  server_created:    { progress: 15,  message: 'Server created, running cloud-init...' },
  cloud_init_running:{ progress: 35,  message: 'Configuring machine...' },
  cloud_init_done:   { progress: 60,  message: 'Configuration complete, starting services...' },
  services_starting: { progress: 80,  message: 'Services booting...' },
  services_ready:    { progress: 95,  message: 'Almost ready...' },
  connecting:        { progress: 98,  message: 'Connecting to workspace...' },
} as const;

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
