/**
 * Classify the two PTY WebSocket contracts that can traverse sandbox ingress.
 *
 * - OpenCode PTY lives on its internal runtime port (`/pty/:id/connect`).
 * - Kortix-native PTY lives on the sandbox agent (`/kortix/pty/:id/connect`).
 *
 * Keeping this path knowledge in one pure helper prevents provider routing and
 * the API WebSocket proxy from drifting when a terminal backend changes.
 */
export type PtyWebSocketKind = 'opencode' | 'kortix';

export function classifyPtyWebSocketPath(path?: string): PtyWebSocketKind | null {
  if (!path) return null;
  if (path.startsWith('/kortix/pty/')) return 'kortix';
  if (path.startsWith('/pty/')) return 'opencode';
  return null;
}
