'use client';

/**
 * useGlobalSandboxUpdate — globally available sandbox update state.
 *
 * Unlike `useSandboxUpdate` which requires the caller to provide currentVersion,
 * this hook reads it from the sandbox connection store (populated by the
 * health check in use-sandbox-connection.ts).
 *
 * Use this in components that need update awareness without being inside
 * the server-selector dialog (e.g., update banner, sidebar indicator).
 */

import { useSandboxConnectionStore } from '@/stores/sandbox-connection-store';
import { useSandboxUpdate, PHASE_LABELS, PHASE_PROGRESS, detectChannel } from './use-sandbox-update';

export { PHASE_LABELS, PHASE_PROGRESS, detectChannel };

export function useGlobalSandboxUpdate() {
  const sandboxVersion = useSandboxConnectionStore((s) => s.sandboxVersion);
  return useSandboxUpdate(sandboxVersion);
}
