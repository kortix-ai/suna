import { isRuntimeReady, type SessionHealthResult } from '@kortix/sdk';

/**
 * Probe a session sandbox's runtime health THROUGH the backend proxy — the same
 * `${sandboxUrl}/kortix/health` the web's useSandboxConnection polls. Beyond
 * reporting readiness, hitting the proxy keeps the sandbox routed/warm; the
 * backend's ensure-opencode probe alone doesn't, so without this a freshly-woken
 * sandbox can stay unreachable. Returns 'ready' once OpenCode reports up.
 */

export type SandboxHealth = {
  status: 'ready' | 'starting' | 'unreachable';
  /**
   * Fatal runtime boot failure (e.g. repo materialization / git clone failed),
   * verbatim from /kortix/health `boot_error`. Null while healthy or still
   * booting — the sandbox only populates it on an actual failure, so it's a
   * safe "stop waiting" signal (see sandbox routes/health.ts).
   */
  bootError?: string | null;
};

export function mapSandboxHealth({ status, ok, health }: SessionHealthResult): SandboxHealth {
  if (status === 503) return { status: 'starting' }; // sandbox up, OpenCode still booting
  if (!ok) return { status: 'unreachable' };
  const bootError = typeof health?.boot_error === 'string' && health.boot_error ? health.boot_error : null;
  if (health?.runtimeReady === true || health?.opencode === 'ok' || health?.opencode === true ||
      (health?.status && isRuntimeReady(health))) return { status: 'ready' };
  return { status: 'starting', bootError };
}
