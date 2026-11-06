/**
 * The PTY WebSocket path that traverses sandbox ingress: the daemon's own
 * terminal, `/kortix/pty/:id/connect` on the sandbox agent.
 *
 * Keeping this path knowledge in one pure helper prevents provider routing and
 * the API WebSocket proxy from drifting when the terminal backend changes.
 */
export function isPtyWebSocketPath(path?: string): boolean {
  return typeof path === 'string' && path.startsWith('/kortix/pty/');
}
