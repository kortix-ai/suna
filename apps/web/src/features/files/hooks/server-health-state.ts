import type { ServerHealth } from '@/features/file-browser/types';
import type { SandboxConnectionStatus } from '@kortix/sdk/sandbox-connection-store';

export function fileServerHealthState(
  status: SandboxConnectionStatus,
  runtimeHealthy: boolean | null,
  version: string | null,
): ServerHealth | undefined {
  if (status === 'connecting' && runtimeHealthy === null) return undefined;
  return { healthy: status === 'connected', version: version ?? '' };
}
