export interface SessionTerminalState {
  phase: 'starting' | 'ready' | 'error';
  hasStartError: boolean;
  sandboxStatus?: string | null;
}

/**
 * Detect a terminal `/start` result that has no serialized sandbox row.
 *
 * This is the provisioning-failed-before-allocation case. The SDK reports
 * `phase: 'error'`, but the existing page error branches only inspect a typed
 * request error or a terminal sandbox row. Without this branch, the startup
 * loader remains visible forever.
 */
export function isUnmaterializedSessionFailure(state: SessionTerminalState): boolean {
  if (state.phase !== 'error' || state.hasStartError) return false;
  return state.sandboxStatus !== 'error' && state.sandboxStatus !== 'stopped';
}
