'use client';

import { useSandboxConnectionStore } from '../browser/stores/sandbox-connection-store';

export type RuntimePhase = 'connecting' | 'booting' | 'ready' | 'unreachable';

/**
 * Coarse, render-friendly runtime connection phase for boot/reconnect UI. Reads
 * the SDK's connection store — the host never touches it directly. `useSession`
 * also returns this as `runtimePhase`; use this standalone hook when you want the
 * phase without a full session (e.g. a lightweight status pill).
 */
export function useRuntimePhase(): RuntimePhase {
  const status = useSandboxConnectionStore((s) => s.status);
  const healthy = useSandboxConnectionStore((s) => s.healthy);
  if (status === 'unreachable') return 'unreachable';
  if (healthy === true) return 'ready';
  if (status === 'connected') return 'booting'; // reachable, OpenCode still warming
  return 'connecting';
}
