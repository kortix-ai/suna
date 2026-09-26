import type { ServerHealth } from '@/features/file-browser/types';
import type { SandboxConnectionStatus } from '@kortix/sdk/react';

/**
 * `status` is about the socket, `parked` is about the box.
 *
 * A `connected` status with `runtimeHealthy: false` stays HEALTHY on purpose:
 * the file daemon answers while OpenCode is merely not ready yet, and gating
 * Files on OpenCode readiness would blank the panel through every boot.
 *
 * `parked` is the opposite situation and needs the opposite answer. Nothing is
 * running, so nothing can serve a listing — and `status` will not tell you,
 * because nothing clears it when the control plane parks a box (`use-session`
 * pins it to `connected` on switch with no poller; `use-runtime-reconnect`'s
 * parked branch deliberately leaves it alone). Reading `status` alone is what
 * opened this gate over a parked box and started the refused-request loop the
 * user saw as a Files panel that loaded forever.
 */
export function fileServerHealthState(
  status: SandboxConnectionStatus,
  runtimeHealthy: boolean | null,
  version: string | null,
  parked = false,
): ServerHealth | undefined {
  if (status === 'connecting' && runtimeHealthy === null) return undefined;
  return { healthy: status === 'connected' && !parked, version: version ?? '' };
}
