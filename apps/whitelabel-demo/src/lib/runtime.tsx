'use client';

/**
 * Session runtime wiring — the bridge between a started session sandbox and the
 * reactive chat hooks. Mount this ONCE around the chat, AFTER the active server
 * has been switched to the session's sandbox (`switchToSessionSandboxAsync`).
 *
 *   - `useSandboxConnection()` polls `/kortix/health` and flips the connection
 *     store to `healthy`, which gates message sync + the SSE subscription.
 *   - `<OpenCodeEventStreamProvider />` opens the live SSE stream and pipes
 *     agent events into the sync store (token-by-token streaming).
 *
 * Both come straight from `@kortix/sdk/react` — the host writes zero transport.
 */

import {
  OpenCodeEventStreamProvider,
  useSandboxConnection,
  useSandboxConnectionStore,
} from '@kortix/sdk/react';
import type { ReactNode } from 'react';

export function SessionRuntime({ children }: { children: ReactNode }) {
  useSandboxConnection();
  return (
    <>
      <OpenCodeEventStreamProvider />
      {children}
    </>
  );
}

/** Coarse, render-friendly connection phase for boot/reconnect UI. */
export function useRuntimePhase(): 'connecting' | 'booting' | 'ready' | 'unreachable' {
  const status = useSandboxConnectionStore((s) => s.status);
  const healthy = useSandboxConnectionStore((s) => s.healthy);
  if (status === 'unreachable') return 'unreachable';
  if (healthy === true) return 'ready';
  if (status === 'connected') return 'booting'; // reachable, OpenCode still warming
  return 'connecting';
}
